//! MCP HTTP/SSE transport implementation.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::{Mutex, RwLock, oneshot, watch};

use super::client::UnexpectedCloseListener;
use super::client_shared;
use super::client_shared::Budget;
use super::errors::McpError;

pub struct McpSseTransport {
    post_url: Arc<RwLock<Option<String>>>,
    /// The GET stream URL; absolute `endpoint` events are checked against this
    /// origin before any `Authorization` header is sent to them.
    base_url: String,
    /// POST client (tight per-read backstop; the per-request oneshot timeout
    /// bounds each round trip).
    post_client: reqwest::Client,
    headers: HashMap<String, String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
    /// Per-request timeout resolved from `toolTimeoutMs` (v2
    /// `toolCallTimeoutMs`); `None` keeps the 30s built-in.
    request_timeout: Option<Duration>,
    /// Listener fired when the SSE stream dies on its own after the handshake
    /// (v2 `unexpectedCloseListener`, client-sse.ts:54). At most one listener;
    /// later registrations replace earlier ones.
    unexpected_close: UnexpectedCloseListener,
    /// Close reason buffered when the stream dies before a listener is
    /// installed; replayed on registration (v2 `pendingUnexpectedClose`).
    pending_close_reason: Arc<Mutex<Option<String>>>,
    /// Intentional-close signal: the reader task exits quietly (no
    /// unexpected-close event) and fails every pending caller.
    close_tx: watch::Sender<()>,
    /// Set by `shutdown` before the reader is signalled. The reader stops
    /// clearing `pending` once it exits, so a request registered afterwards
    /// would never be answered and would sit out its full timeout; every entry
    /// point checks this flag instead.
    closed: Arc<AtomicBool>,
}

/// Built-in per-request timeout when no `toolTimeoutMs` is configured.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

impl McpSseTransport {
    /// Connect to an MCP server via SSE and spawn the background event listener loop.
    pub async fn connect(
        sse_url: &str,
        headers: HashMap<String, String>,
    ) -> Result<Self, McpError> {
        client_shared::validate_http_url(sse_url).map_err(McpError::transport)?;
        let stream_client = client_shared::build_http_client(true).map_err(McpError::transport)?;
        let post_client = client_shared::build_http_client(false).map_err(McpError::transport)?;

        let mut req_builder = stream_client
            .get(sse_url)
            .header("Accept", "text/event-stream");

        for (k, v) in &headers {
            req_builder = req_builder.header(k, v);
        }

        let resp = req_builder.send().await.map_err(|e| {
            McpError::transport(format!(
                "Failed to connect to MCP SSE endpoint '{sse_url}': {e}"
            ))
        })?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            return Err(McpError::http_status(
                status,
                format!(
                    "MCP SSE connection failed with status HTTP {}",
                    resp.status()
                ),
            ));
        }

        let post_url = Arc::new(RwLock::new(None));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Unexpected-close callback slots, shared with the stream reader task
        // below (v2 `unexpectedCloseListener` / `pendingUnexpectedClose`).
        let unexpected_close: UnexpectedCloseListener = Arc::new(Mutex::new(None));
        let pending_close_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Intentional close + reader-liveness signals.
        let (close_tx, mut close_rx) = watch::channel(());
        let (ended_tx, ended_rx) = watch::channel(());
        let closed = Arc::new(AtomicBool::new(false));

        let stream_post_url = post_url.clone();
        let stream_pending = pending.clone();
        let stream_closed = closed.clone();
        let base_url = sse_url.to_string();
        let stream_base_url = base_url.clone();
        let close_listener = unexpected_close.clone();
        let close_pending = pending_close_reason.clone();

        // Spawn background SSE stream reader
        tokio::spawn(async move {
            let mut event_stream = resp.bytes_stream().eventsource();
            let mut last_error: Option<String> = None;

            let ended = loop {
                tokio::select! {
                    _ = close_rx.changed() => break false,
                    item = event_stream.next() => match item {
                        Some(Ok(event)) => {
                            if event.event == "endpoint" {
                                // Server tells client where to POST messages
                                let endpoint_str = event.data.trim();
                                let resolved = resolve_endpoint(&stream_base_url, endpoint_str);
                                let mut lock = stream_post_url.write().await;
                                *lock = Some(resolved);
                            } else if (event.event == "message" || event.event.is_empty())
                                && let Ok(parsed) = serde_json::from_str::<Value>(&event.data)
                                && let Some(id) = parsed.get("id").and_then(|v| v.as_u64())
                            {
                                let mut pend_lock = stream_pending.lock().await;
                                if let Some(sender) = pend_lock.remove(&id) {
                                    let _ = sender.send(parsed);
                                }
                            }
                        }
                        Some(Err(e)) => {
                            last_error = Some(e.to_string());
                            break true;
                        }
                        None => break true,
                    },
                }
            };

            // No reader is left to deliver a response: fail the in-flight
            // callers and refuse the ones that arrive afterwards. Both happen
            // in one critical section with the insert-and-recheck in
            // `send_request`, so a request can neither slip in unmarked nor
            // register against a table nobody will ever drain again.
            {
                let mut pend = stream_pending.lock().await;
                stream_closed.store(true, Ordering::SeqCst);
                pend.clear();
            }

            // An intentional shutdown exits without firing the close listener —
            // the caller closed on purpose (v2 only fires on unexpected close).
            if ended {
                let reason = match last_error {
                    Some(e) => {
                        format!(
                            "MCP SSE connection to \"{stream_base_url}\" closed unexpectedly: {e}"
                        )
                    }
                    None => {
                        format!("MCP SSE connection to \"{stream_base_url}\" closed unexpectedly")
                    }
                };
                crate::mcp::client::fire_or_buffer_unexpected_close(
                    &close_listener,
                    &close_pending,
                    reason,
                )
                .await;
            }
            let _ = ended_tx.send(());
        });

        // Wait up to 5 seconds for the initial 'endpoint' event. A stream that
        // dies first is an immediate failure (its reason was buffered for
        // replay), and no endpoint at all is a protocol failure rather than a
        // silent fallback to POSTing at the SSE URL itself.
        let mut endpoint: Option<String> = None;
        for _ in 0..50 {
            if let Some(url) = post_url.read().await.clone() {
                endpoint = Some(url);
                break;
            }
            if ended_rx.has_changed().unwrap_or(false) {
                let reason = pending_close_reason
                    .lock()
                    .await
                    .clone()
                    .unwrap_or_else(|| "MCP SSE stream closed before the endpoint event".into());
                return Err(McpError::closed(reason));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if endpoint.is_none() {
            let _ = close_tx.send(());
            return Err(McpError::transport(
                "MCP SSE server did not send an 'endpoint' event within 5s",
            ));
        }

        Ok(Self {
            post_url,
            base_url,
            post_client,
            headers,
            pending,
            next_id: AtomicU64::new(1),
            request_timeout: None,
            unexpected_close,
            pending_close_reason,
            close_tx,
            closed,
        })
    }

    /// Register a listener that fires when the SSE stream dies on its own —
    /// i.e. the caller has not invoked `shutdown` (v2 `onUnexpectedClose`,
    /// client-sse.ts:106-115). At most one listener; later registrations
    /// replace earlier ones. If the stream already died, the buffered reason
    /// is replayed synchronously so the close is never dropped.
    pub async fn on_unexpected_close(&self, listener: Box<dyn Fn(String) + Send + Sync>) {
        let pending = self.pending_close_reason.lock().await.take();
        if let Some(reason) = pending {
            listener(reason);
            return;
        }
        *self.unexpected_close.lock().await = Some(listener);
    }

    /// Apply a per-request timeout (v2 `buildRequestOptions(toolCallTimeoutMs)`).
    pub fn set_request_timeout(&mut self, timeout: Option<Duration>) {
        self.request_timeout = timeout;
    }

    /// Signal the reader task to stop without firing the unexpected-close
    /// listener. In-flight callers fail immediately.
    pub async fn shutdown(&self) {
        // Mark before signalling so a caller that races the reader's exit
        // cannot register against the table the reader is about to drain.
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.close_tx.send(());
    }

    fn ensure_open(&self) -> Result<(), McpError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(McpError::closed("MCP SSE transport is closed"))
        } else {
            Ok(())
        }
    }

    /// Headers for a POST to `target_url`: an absolute endpoint on another
    /// origin must not receive the configured bearer token.
    fn post_headers(&self, target_url: &str) -> Vec<(&str, &str)> {
        let same_origin = client_shared::is_same_origin(&self.base_url, target_url);
        self.headers
            .iter()
            .filter(|(key, _)| same_origin || !key.eq_ignore_ascii_case("authorization"))
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    /// POST one JSON-RPC envelope with the caller's deadline bounding the round
    /// trip. `send()` resolves once the response headers arrive; the JSON-RPC
    /// reply itself never comes back on this connection (it arrives on the
    /// event stream), so there is no body to read here.
    async fn post(
        &self,
        target_url: &str,
        payload: &Value,
        budget: Budget,
    ) -> Result<reqwest::Response, McpError> {
        let mut req = self.post_client.post(target_url);
        for (k, v) in self.post_headers(target_url) {
            req = req.header(k, v);
        }
        match tokio::time::timeout_at(budget.deadline, req.json(payload).send()).await {
            Ok(send_result) => send_result.map_err(|e| {
                McpError::transport(format!(
                    "Failed to post to MCP message endpoint '{target_url}': {e}"
                ))
            }),
            Err(_) => Err(McpError::timeout(format!(
                "MCP request timed out after {}ms",
                budget.wait.as_millis()
            ))),
        }
    }

    /// Send a JSON-RPC request over HTTP POST and await the matching response from SSE.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, McpError> {
        self.ensure_open()?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let target_url = {
            let lock = self.post_url.read().await;
            lock.clone()
                .ok_or_else(|| McpError::closed("No target post URL configured for MCP SSE"))?
        };

        let budget = Budget::new(self.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT));

        let (tx, rx) = oneshot::channel();
        // Register and re-check the closed flag as one step: the reader that
        // drains the table sets the flag inside the same critical section, so
        // either this request is visible to that drain or it sees the dead
        // stream and fails now instead of waiting out the budget.
        {
            let mut pend = self.pending.lock().await;
            if self.closed.load(Ordering::SeqCst) {
                return Err(McpError::closed("MCP SSE transport is closed"));
            }
            pend.insert(id, tx);
        }

        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let post_result = self.post(&target_url, &payload, budget).await;
        let resp = match post_result {
            Ok(resp) => resp,
            Err(e) => {
                self.pending.lock().await.remove(&id);
                return Err(e);
            }
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            self.pending.lock().await.remove(&id);
            return Err(McpError::http_status(
                status,
                format!("MCP POST failed with status HTTP {}", resp.status()),
            ));
        }

        // Await matching response from SSE event stream, on the remaining
        // budget: one per-request deadline covers POST + reply, not each leg.
        match tokio::time::timeout_at(budget.deadline, rx).await {
            Ok(Ok(val)) => {
                if let Some(err) = val.get("error") {
                    return Err(McpError::json_rpc(format!("MCP Server Error: {err}")));
                }
                Ok(val.get("result").cloned().unwrap_or(Value::Null))
            }
            Ok(Err(_)) => Err(McpError::closed("MCP response channel closed prematurely")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(McpError::timeout(format!(
                    "MCP request timed out after {}ms",
                    budget.wait.as_millis()
                )))
            }
        }
    }

    /// Send a JSON-RPC notification (no id, no SSE reply). The server answers
    /// the POST with 2xx (typically 202 Accepted with an empty body).
    pub async fn send_notification(&self, method: &str, params: Value) -> Result<(), McpError> {
        self.ensure_open()?;
        let target_url = {
            let lock = self.post_url.read().await;
            lock.clone()
                .ok_or_else(|| McpError::closed("No target post URL configured for MCP SSE"))?
        };
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let resp = self
            .post(
                &target_url,
                &payload,
                Budget::new(self.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT)),
            )
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(McpError::http_status(
                status.as_u16(),
                format!("MCP notification POST failed with status HTTP {status}"),
            ));
        }
        Ok(())
    }
}

/// Resolve a relative `endpoint` event payload against the SSE URL; absolute
/// `http(s)` URLs are kept verbatim (same-origin enforcement happens when the
/// Authorization headers for the POST are built).
fn resolve_endpoint(base_url: &str, endpoint_str: &str) -> String {
    if endpoint_str.starts_with("http://") || endpoint_str.starts_with("https://") {
        endpoint_str.to_string()
    } else if let Ok(base) = url::Url::parse(base_url) {
        base.join(endpoint_str)
            .map(|u| u.to_string())
            .unwrap_or_else(|_| endpoint_str.to_string())
    } else {
        endpoint_str.to_string()
    }
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub async fn spawn_mock_mcp_sse_server(
        custom_endpoint: Option<String>,
        fail_connect_status: Option<u16>,
        fail_post_status: Option<u16>,
    ) -> (String, tokio::sync::oneshot::Sender<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let (sse_tx, sse_rx) = tokio::sync::mpsc::channel::<String>(32);
        let sse_rx = Arc::new(Mutex::new(sse_rx));

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    res = listener.accept() => {
                        let Ok((mut socket, _)) = res else { break };
                        let sse_tx = sse_tx.clone();
                        let sse_rx = sse_rx.clone();
                        let custom_endpoint = custom_endpoint.clone();

                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 8192];
                            let mut total = 0;
                            while total < buf.len() {
                                let n = match socket.read(&mut buf[total..]).await {
                                    Ok(0) | Err(_) => return,
                                    Ok(n) => n,
                                };
                                total += n;
                                if let Some(pos) = buf[..total].windows(4).position(|w| w == b"\r\n\r\n") {
                                    let headers_str = String::from_utf8_lossy(&buf[..pos]);
                                    let first_line = headers_str.lines().next().unwrap_or("");
                                    let mut parts = first_line.split_whitespace();
                                    let method = parts.next().unwrap_or("");
                                    let path = parts.next().unwrap_or("");

                                    if method == "GET" && path == "/sse" {
                                        if let Some(status) = fail_connect_status {
                                            let resp = format!("HTTP/1.1 {status} Error\r\nContent-Length: 0\r\n\r\n");
                                            let _ = socket.write_all(resp.as_bytes()).await;
                                            return;
                                        }

                                        let endpoint_val = custom_endpoint.unwrap_or_else(|| "/messages".to_string());
                                        let resp = format!(
                                            "HTTP/1.1 200 OK\r\n\
                                             Content-Type: text/event-stream\r\n\
                                             Cache-Control: no-cache\r\n\
                                             Connection: keep-alive\r\n\r\n\
                                             event: endpoint\r\n\
                                             data: {endpoint_val}\r\n\r\n"
                                        );
                                        if socket.write_all(resp.as_bytes()).await.is_err() {
                                            return;
                                        }
                                        let _ = socket.flush().await;

                                        loop {
                                            let msg_opt = {
                                                let mut rx_lock = sse_rx.lock().await;
                                                rx_lock.recv().await
                                            };
                                            match msg_opt {
                                                Some(msg) => {
                                                    let event_payload = format!("event: message\ndata: {msg}\n\n");
                                                    if socket.write_all(event_payload.as_bytes()).await.is_err() {
                                                        break;
                                                    }
                                                    let _ = socket.flush().await;
                                                }
                                                None => break,
                                            }
                                        }
                                        return;
                                    } else if method == "POST" {
                                        if let Some(status) = fail_post_status {
                                            let resp = format!("HTTP/1.1 {status} Error\r\nContent-Length: 0\r\n\r\n");
                                            let _ = socket.write_all(resp.as_bytes()).await;
                                            return;
                                        }

                                        let mut content_len = 0;
                                        for line in headers_str.lines() {
                                            if let Some((k, v)) = line.split_once(':')
                                                && k.trim().eq_ignore_ascii_case("content-length")
                                            {
                                                content_len = v.trim().parse::<usize>().unwrap_or(0);
                                            }
                                        }
                                        let body_start = pos + 4;
                                        let mut body = buf[body_start..total].to_vec();
                                        while body.len() < content_len {
                                            let mut chunk = vec![0u8; content_len - body.len()];
                                            match socket.read(&mut chunk).await {
                                                Ok(0) | Err(_) => break,
                                                Ok(n) => body.extend_from_slice(&chunk[..n]),
                                            }
                                        }

                                        let body_json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                                        let id = body_json.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                                        let req_method = body_json.get("method").and_then(|v| v.as_str()).unwrap_or("");

                                        let http_resp = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
                                        let _ = socket.write_all(http_resp.as_bytes()).await;
                                        let _ = socket.flush().await;

                                        // Notifications carry no id and get no
                                        // SSE reply (the 202 above is enough).
                                        if body_json.get("id").is_none() {
                                            return;
                                        }

                                        let sse_reply = match req_method {
                                            "initialize" => json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": {
                                                    "protocolVersion": "2024-11-05",
                                                    "capabilities": { "tools": {} },
                                                    "serverInfo": { "name": "mock-mcp-server", "version": "1.0.0" }
                                                }
                                            }),
                                            "tools/list" => json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": {
                                                    "tools": [
                                                        {
                                                            "name": "calculate",
                                                            "description": "Perform calculation",
                                                            "inputSchema": {
                                                                "type": "object",
                                                                "properties": {
                                                                    "expression": { "type": "string" }
                                                                },
                                                                "required": ["expression"]
                                                            }
                                                        },
                                                        {
                                                            "name": "echo",
                                                            "description": "Echo input message",
                                                            "inputSchema": {
                                                                "type": "object",
                                                                "properties": {
                                                                    "text": { "type": "string" }
                                                                }
                                                            }
                                                        },
                                                        {
                                                            "name": "trigger_tool_error",
                                                            "description": "Tool that triggers an error",
                                                            "inputSchema": {
                                                                "type": "object"
                                                            }
                                                        }
                                                    ]
                                                }
                                            }),
                                            "tools/call" => {
                                                let params = body_json.get("params").cloned().unwrap_or(Value::Null);
                                                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                                if name == "calculate" {
                                                    json!({
                                                        "jsonrpc": "2.0",
                                                        "id": id,
                                                        "result": {
                                                            "content": [
                                                                { "type": "text", "text": "result: 42" }
                                                            ],
                                                            "isError": false
                                                        }
                                                    })
                                                } else if name == "trigger_tool_error" {
                                                    json!({
                                                        "jsonrpc": "2.0",
                                                        "id": id,
                                                        "result": {
                                                            "content": [
                                                                { "type": "text", "text": "custom tool failure" }
                                                            ],
                                                            "isError": true
                                                        }
                                                    })
                                                } else {
                                                    json!({
                                                        "jsonrpc": "2.0",
                                                        "id": id,
                                                        "error": {
                                                            "code": -32601,
                                                            "message": format!("Tool '{name}' not found")
                                                        }
                                                    })
                                                }
                                            },
                                            "error_method" => json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "error": {
                                                    "code": -32600,
                                                    "message": "Invalid request method"
                                                }
                                            }),
                                            _ => json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": { "status": "acknowledged", "method": req_method }
                                            }),
                                        };

                                        let _ = sse_tx.send(sse_reply.to_string()).await;
                                        return;
                                    } else {
                                        let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                                        let _ = socket.write_all(not_found.as_bytes()).await;
                                        return;
                                    }
                                }
                            }
                        });
                    }
                }
            }
        });

        (format!("{base_url}/sse"), shutdown_tx)
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::spawn_mock_mcp_sse_server;
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_sse_transport_connect_and_request_success() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;
        let mut headers = HashMap::new();
        headers.insert("X-Custom-Header".into(), "test-val".into());

        let transport = McpSseTransport::connect(&sse_url, headers)
            .await
            .expect("SSE connect failed");

        let res = transport
            .send_request("test_ping", json!({ "key": "val" }))
            .await
            .expect("request failed");

        assert_eq!(res["status"], "acknowledged");
        assert_eq!(res["method"], "test_ping");
    }

    #[tokio::test]
    async fn test_sse_transport_relative_endpoint_resolution() {
        let (sse_url, _shutdown) =
            spawn_mock_mcp_sse_server(Some("/custom/relative/messages".into()), None, None).await;

        let transport = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .expect("SSE connect failed");

        let res = transport
            .send_request("custom_method", json!({}))
            .await
            .expect("send_request failed");

        assert_eq!(res["status"], "acknowledged");
        assert_eq!(res["method"], "custom_method");
    }

    #[tokio::test]
    async fn test_sse_transport_server_error_response() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;

        let transport = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .expect("SSE connect failed");

        let err = transport
            .send_request("error_method", json!({}))
            .await
            .expect_err("expected JSON-RPC error");

        assert_eq!(
            err.to_string(),
            "MCP Server Error: {\"code\":-32600,\"message\":\"Invalid request method\"}"
        );
        assert!(matches!(err, McpError::JsonRpc { .. }));
    }

    #[tokio::test]
    async fn test_sse_transport_connect_http_error() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, Some(500), None).await;

        let err = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .err()
            .expect("expected connection failure");

        let message = err.to_string();
        assert!(
            message.contains("MCP SSE connection failed with status HTTP 500"),
            "unexpected error message: {message}"
        );
        assert!(matches!(err, McpError::HttpStatus { status: 500, .. }));
    }

    #[tokio::test]
    async fn test_sse_transport_post_http_error() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, Some(503)).await;

        let transport = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .expect("SSE connect failed");

        let err = transport
            .send_request("test_ping", json!({}))
            .await
            .expect_err("expected POST failure");

        let message = err.to_string();
        assert!(
            message.contains("MCP POST failed with status HTTP 503"),
            "unexpected error message: {message}"
        );
        assert!(matches!(err, McpError::HttpStatus { status: 503, .. }));
    }

    /// A server that answers the SSE handshake and then closes the stream
    /// must fire the unexpected-close listener (v2 `onUnexpectedClose`,
    /// client-sse.ts:106-115). The reason carries the endpoint URL.
    #[tokio::test]
    async fn test_sse_transport_unexpected_close_fires_on_stream_end() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 8192];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let headers_str = String::from_utf8_lossy(&buf[..n]);
            let first_line = headers_str.lines().next().unwrap_or("");
            let mut parts = first_line.split_whitespace();
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");
            if method == "GET" && path == "/sse" {
                // Send the endpoint event, then drop the socket to close the
                // stream.
                let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\nevent: endpoint\r\ndata: /messages\r\n\r\n";
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });

        let url = format!("http://{addr}/sse");
        let transport = McpSseTransport::connect(&url, HashMap::new())
            .await
            .expect("SSE connect failed");

        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));
        transport
            .on_unexpected_close(Box::new(move |reason| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(reason);
                }
            }))
            .await;

        let reason = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .expect("unexpected close must fire")
            .expect("reason must be sent");
        assert!(
            reason.contains("closed unexpectedly"),
            "unexpected reason: {reason}"
        );
    }

    /// A stream that never sends an endpoint event fails connect instead of
    /// silently POSTing at the SSE URL itself.
    #[tokio::test]
    async fn test_sse_transport_without_endpoint_event_fails() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 8192];
            let _ = socket.read(&mut buf).await.unwrap_or(0);
            // Keep the stream open but send only SSE comments, no endpoint.
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n: keepalive\r\n\r\n";
            let _ = socket.write_all(resp.as_bytes()).await;
            let _ = socket.flush().await;
            // Hold the socket until the test ends by reading until EOF.
            let mut sink = vec![0u8; 64];
            while socket.read(&mut sink).await.unwrap_or(0) > 0 {}
        });

        let url = format!("http://{addr}/sse");
        let err = McpSseTransport::connect(&url, HashMap::new())
            .await
            .err()
            .expect("missing endpoint must fail connect");
        let message = err.to_string();
        assert!(
            message.contains("did not send an 'endpoint' event"),
            "unexpected error: {message}"
        );
    }

    /// An SSE server that completes the handshake and withholds every JSON-RPC
    /// reply, so a call over it can only end by its own deadline or by the
    /// transport closing. `ack_post` chooses which leg it parks on: `true`
    /// ACKs the POST with 202 and the call waits for the SSE reply, `false`
    /// stops accepting so the call never gets past the POST.
    async fn spawn_sse_server_without_replies(ack_post: bool) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // The handshake GET: serve the endpoint event, then hold the stream
            // open so the reader stays parked and the transport looks live.
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 8192];
            let Ok(n) = socket.read(&mut buf).await else {
                return;
            };
            let _ = n;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n",
                )
                .await;
            let _ = socket
                .write_all(b"event: endpoint\r\ndata: /messages\r\n\r\n")
                .await;
            let _ = socket.flush().await;

            if !ack_post {
                // Stop accepting: the POST connection sits in the TCP backlog.
                tokio::time::sleep(Duration::from_secs(60)).await;
                return;
            }
            while let Ok((mut post, _)) = listener.accept().await {
                let mut request = vec![0u8; 8192];
                let _ = post.read(&mut request).await;
                let _ = post
                    .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                    .await;
                let _ = post.flush().await;
            }
        });
        format!("http://{addr}/sse")
    }

    /// An explicit shutdown must not fire the unexpected-close listener and
    /// must fail an in-flight caller instead of letting it wait for timeout.
    #[tokio::test]
    async fn test_sse_transport_shutdown_is_silent_and_fails_pending() {
        let sse_url = spawn_sse_server_without_replies(true).await;
        let transport = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .expect("SSE connect failed");
        transport
            .on_unexpected_close(Box::new(|_| {
                panic!("shutdown must not fire close listener")
            }))
            .await;

        // Park the call on the reply wait: the POST is ACKed at once and no SSE
        // message ever follows, so it can only sit in the pending table. A
        // request that had not started yet would instead be refused outright,
        // which is the other test's job.
        let mut call = std::pin::pin!(transport.send_request("tools/list", json!({})));
        for _ in 0..3 {
            if tokio::time::timeout(Duration::from_millis(50), call.as_mut())
                .await
                .is_ok()
            {
                panic!("request must stay pending until the transport closes");
            }
        }
        assert!(
            !transport.pending.lock().await.is_empty(),
            "request must be registered before the shutdown"
        );

        transport.shutdown().await;
        let err = tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .expect("in-flight call must settle after shutdown")
            .expect_err("in-flight call must fail after shutdown");
        let message = err.to_string();
        assert!(
            message.contains("closed prematurely"),
            "unexpected error: {message}"
        );
    }

    /// A request that starts *after* the stream is gone must be refused at
    /// once. Before the closed flag existed, the reader had already stopped
    /// draining the pending table, so this caller waited out the full 30s
    /// request timeout for a response that could never arrive.
    #[tokio::test]
    async fn test_sse_transport_refuses_calls_after_shutdown() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;
        let transport = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .expect("SSE connect failed");
        transport.shutdown().await;

        let started = std::time::Instant::now();
        let err = transport
            .send_request("tools/list", json!({}))
            .await
            .expect_err("call after shutdown must be refused");
        let elapsed = started.elapsed();
        assert!(
            err.to_string().contains("transport is closed"),
            "unexpected error: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "refusal must be immediate, took {elapsed:?}"
        );
    }

    /// A POST to an endpoint that never answers must fail on the resolved
    /// per-request timeout. The deadline used to wrap only the wait for the
    /// SSE reply, so a stalled POST ran unbounded.
    #[tokio::test]
    async fn test_sse_transport_post_is_bounded_by_request_timeout() {
        let sse_url = spawn_sse_server_without_replies(false).await;
        let mut transport = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .expect("SSE connect failed");
        transport.set_request_timeout(Some(Duration::from_millis(150)));
        let err = transport
            .send_request("tools/list", json!({}))
            .await
            .expect_err("stalled POST must time out");
        assert_eq!(err.to_string(), "MCP request timed out after 150ms");
        assert!(matches!(err, McpError::Timeout(_)));
    }

    /// Notifications POST without an id and succeed on the 2xx empty-body
    /// reply without waiting for an SSE message.
    #[tokio::test]
    async fn test_sse_transport_send_notification() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;
        let transport = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .expect("SSE connect failed");
        transport
            .send_notification("notifications/initialized", json!({}))
            .await
            .expect("notification POST must succeed");
    }

    /// Non-http(s) URLs fail at connect time.
    #[tokio::test]
    async fn test_sse_transport_rejects_non_http_url() {
        let err = McpSseTransport::connect("file:///etc/passwd", HashMap::new())
            .await
            .err()
            .expect("non-http url must fail");
        let message = err.to_string();
        assert!(
            message.contains("unsupported scheme"),
            "unexpected error: {message}"
        );
    }
}
