//! MCP HTTP/SSE transport implementation.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::{Mutex, RwLock, oneshot};

pub struct McpSseTransport {
    post_url: Arc<RwLock<Option<String>>>,
    http_client: reqwest::Client,
    headers: HashMap<String, String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
    /// Per-request timeout resolved from `toolTimeoutMs` (v2
    /// `toolCallTimeoutMs`); `None` keeps the 30s built-in.
    request_timeout: Option<Duration>,
    /// Listener fired when the SSE stream dies on its own after the handshake
    /// (v2 `unexpectedCloseListener`, client-sse.ts:54). At most one listener;
    /// later registrations replace earlier ones.
    unexpected_close: Arc<Mutex<Option<Box<dyn Fn(String) + Send + Sync>>>>,
    /// Close reason buffered when the stream dies before a listener is
    /// installed; replayed on registration (v2 `pendingUnexpectedClose`).
    pending_close_reason: Arc<Mutex<Option<String>>>,
}

/// Built-in per-request timeout when no `toolTimeoutMs` is configured.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

impl McpSseTransport {
    /// Connect to an MCP server via SSE and spawn the background event listener loop.
    pub async fn connect(sse_url: &str, headers: HashMap<String, String>) -> Result<Self, String> {
        let mut req_builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?
            .get(sse_url)
            .header("Accept", "text/event-stream");

        for (k, v) in &headers {
            req_builder = req_builder.header(k, v);
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| format!("Failed to connect to MCP SSE endpoint '{sse_url}': {e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP SSE connection failed with status HTTP {}",
                resp.status()
            ));
        }

        let post_url = Arc::new(RwLock::new(None));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Unexpected-close callback slots, shared with the stream reader task
        // below (v2 `unexpectedCloseListener` / `pendingUnexpectedClose`).
        let unexpected_close: Arc<Mutex<Option<Box<dyn Fn(String) + Send + Sync>>>> =
            Arc::new(Mutex::new(None));
        let pending_close_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let stream_post_url = post_url.clone();
        let stream_pending = pending.clone();
        let base_url = sse_url.to_string();
        let close_listener = unexpected_close.clone();
        let close_pending = pending_close_reason.clone();

        // Spawn background SSE stream reader
        tokio::spawn(async move {
            let mut event_stream = resp.bytes_stream().eventsource();
            let mut last_error: Option<String> = None;

            while let Some(item) = event_stream.next().await {
                match item {
                    Ok(event) => {
                        if event.event == "endpoint" {
                            // Server tells client where to POST messages
                            let endpoint_str = event.data.trim();
                            let resolved = if endpoint_str.starts_with("http://")
                                || endpoint_str.starts_with("https://")
                            {
                                endpoint_str.to_string()
                            } else if let Ok(base) = url::Url::parse(&base_url) {
                                base.join(endpoint_str)
                                    .map(|u| u.to_string())
                                    .unwrap_or_else(|_| endpoint_str.to_string())
                            } else {
                                endpoint_str.to_string()
                            };
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
                    Err(e) => {
                        last_error = Some(e.to_string());
                        break;
                    }
                }
            }

            // The stream ended (EOF or error) — fire or buffer the
            // unexpected-close reason (v2 `onerror` terminal path,
            // client-sse.ts:175-190).
            let reason = match last_error {
                Some(e) => format!(
                    "MCP SSE connection to \"{base_url}\" closed unexpectedly: {e}"
                ),
                None => format!("MCP SSE connection to \"{base_url}\" closed unexpectedly"),
            };
            crate::mcp::client::fire_or_buffer_unexpected_close(
                &close_listener,
                &close_pending,
                reason,
            )
            .await;
        });

        // Wait up to 5 seconds for initial 'endpoint' event or fallback to base URL
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let lock = post_url.read().await;
            if lock.is_some() {
                break;
            }
        }

        // If no explicit endpoint was received, default to sse_url
        {
            let mut lock = post_url.write().await;
            if lock.is_none() {
                *lock = Some(sse_url.to_string());
            }
        }

        Ok(Self {
            post_url,
            http_client: reqwest::Client::new(),
            headers,
            pending,
            next_id: AtomicU64::new(1),
            request_timeout: None,
            unexpected_close,
            pending_close_reason,
        })
    }

    /// Register a listener that fires when the SSE stream dies on its own —
    /// i.e. the caller has not invoked `close()` (v2 `onUnexpectedClose`,
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

    /// Send a JSON-RPC request over HTTP POST and await the matching response from SSE.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let target_url = {
            let lock = self.post_url.read().await;
            lock.clone()
                .ok_or_else(|| "No target post URL configured for MCP SSE".to_string())?
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut pend = self.pending.lock().await;
            pend.insert(id, tx);
        }

        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let mut req = self.http_client.post(&target_url);
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }

        let resp =
            req.json(&payload).send().await.map_err(|e| {
                format!("Failed to post to MCP message endpoint '{target_url}': {e}")
            })?;

        if !resp.status().is_success() {
            let mut pend = self.pending.lock().await;
            pend.remove(&id);
            return Err(format!(
                "MCP POST failed with status HTTP {}",
                resp.status()
            ));
        }

        // Await matching response from SSE event stream.
        let wait = self.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT);
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(val)) => {
                if let Some(err) = val.get("error") {
                    return Err(format!("MCP Server Error: {err}"));
                }
                Ok(val.get("result").cloned().unwrap_or(Value::Null))
            }
            Ok(Err(_)) => Err("MCP response channel closed prematurely".into()),
            Err(_) => {
                let mut pend = self.pending.lock().await;
                pend.remove(&id);
                Err(format!(
                    "MCP request timed out after {}ms",
                    wait.as_millis()
                ))
            }
        }
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
                                            if let Some((k, v)) = line.split_once(':') {
                                                if k.trim().eq_ignore_ascii_case("content-length") {
                                                    content_len = v.trim().parse::<usize>().unwrap_or(0);
                                                }
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
            err,
            "MCP Server Error: {\"code\":-32600,\"message\":\"Invalid request method\"}"
        );
    }

    #[tokio::test]
    async fn test_sse_transport_connect_http_error() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, Some(500), None).await;

        let err = McpSseTransport::connect(&sse_url, HashMap::new())
            .await
            .err()
            .expect("expected connection failure");

        assert!(
            err.contains("MCP SSE connection failed with status HTTP 500"),
            "unexpected error message: {err}"
        );
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

        assert!(
            err.contains("MCP POST failed with status HTTP 503"),
            "unexpected error message: {err}"
        );
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
}
