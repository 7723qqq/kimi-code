//! MCP Streamable HTTP transport (`transport = "http"`).
//!
//! Mirrors the v2 `HttpMcpClient` / `StreamableHTTPClientTransport` wire
//! behavior (`mcpCore/client-http.ts`): every JSON-RPC message is POSTed to
//! the server URL, the reply may be a single JSON body or an SSE stream, and
//! a `Mcp-Session-Id` handed back by the server is echoed on later requests.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::Mutex;

use super::client_shared;
use super::client_shared::Budget;
use super::errors::McpError;

/// Protocol version that introduced the Streamable HTTP transport.
pub const STREAMABLE_HTTP_PROTOCOL_VERSION: &str = "2025-03-26";
const SESSION_ID_HEADER: &str = "mcp-session-id";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct McpHttpTransport {
    url: String,
    headers: HashMap<String, String>,
    client: reqwest::Client,
    /// `Mcp-Session-Id` returned by the server, echoed on every later request.
    session_id: Mutex<Option<String>>,
    next_id: AtomicU64,
    /// Per-request timeout resolved from `toolTimeoutMs`; `None` keeps the
    /// 30s built-in.
    request_timeout: Option<Duration>,
    /// Set by an explicit `shutdown`; the stateless POST transport has no
    /// stream to abort, but callers after close must fail fast.
    closed: Arc<AtomicBool>,
}

impl McpHttpTransport {
    pub async fn connect(url: &str, headers: HashMap<String, String>) -> Result<Self, McpError> {
        // Fail at connect time on a non-http(s) or unparseable URL instead of
        // at first call.
        client_shared::validate_http_url(url).map_err(McpError::transport)?;
        let client = client_shared::build_http_client(false).map_err(McpError::transport)?;
        Ok(Self {
            url: url.to_string(),
            headers,
            client,
            session_id: Mutex::new(None),
            next_id: AtomicU64::new(1),
            request_timeout: None,
            closed: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Apply a per-request timeout (v2 `buildRequestOptions(toolCallTimeoutMs)`).
    pub fn set_request_timeout(&mut self, timeout: Option<Duration>) {
        self.request_timeout = timeout;
    }

    /// Mark the transport closed. In-flight POSTs finish their own round trip;
    /// no new request may start afterwards.
    pub async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn ensure_open(&self) -> Result<(), McpError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(McpError::closed("MCP HTTP transport is closed"))
        } else {
            Ok(())
        }
    }

    /// POST one JSON-RPC envelope, recording the session id and bounding the
    /// round trip with the caller's deadline.
    async fn post(&self, payload: &Value, budget: Budget) -> Result<reqwest::Response, McpError> {
        let mut req = self
            .client
            .post(&self.url)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json");
        for (k, v) in &self.headers {
            req = req.header(k, v);
        }
        if let Some(session) = self.session_id.lock().await.clone() {
            req = req.header(SESSION_ID_HEADER, session);
        }

        let resp = match tokio::time::timeout_at(budget.deadline, req.json(payload).send()).await {
            Ok(send_result) => send_result.map_err(|e| {
                McpError::transport(format!(
                    "Failed to post to MCP HTTP endpoint '{}': {e}",
                    self.url
                ))
            })?,
            Err(_) => return Err(McpError::timeout(timeout_message(budget.wait))),
        };

        if let Some(session) = resp
            .headers()
            .get(SESSION_ID_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().await = Some(session.to_string());
        }
        Ok(resp)
    }

    /// POST one JSON-RPC message and return its `result`.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, McpError> {
        self.ensure_open()?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let budget = Budget::new(self.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT));
        let resp = self.post(&payload, budget).await?;

        let status = resp.status();
        if !status.is_success() {
            return Err(McpError::http_status(
                status.as_u16(),
                format!("MCP HTTP request failed with status HTTP {status}"),
            ));
        }

        let is_event_stream = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("text/event-stream"));
        if is_event_stream {
            read_sse_response(resp, id, budget).await
        } else {
            let body = match tokio::time::timeout_at(budget.deadline, resp.json::<Value>()).await {
                Ok(parse_result) => parse_result.map_err(|e| {
                    McpError::transport(format!("Failed to parse MCP HTTP response: {e}"))
                })?,
                Err(_) => return Err(McpError::timeout(timeout_message(budget.wait))),
            };
            unwrap_json_rpc(body)
        }
    }

    /// POST a JSON-RPC notification (no id). Streamable HTTP servers answer
    /// these with 2xx (often 202 Accepted with an empty body); the body is
    /// intentionally not read as a JSON-RPC response.
    pub async fn send_notification(&self, method: &str, params: Value) -> Result<(), McpError> {
        self.ensure_open()?;
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let budget = Budget::new(self.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT));
        let resp = self.post(&payload, budget).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(McpError::http_status(
                status.as_u16(),
                format!("MCP notification failed with status HTTP {status}"),
            ));
        }
        Ok(())
    }
}

fn timeout_message(wait: Duration) -> String {
    format!("MCP request timed out after {}ms", wait.as_millis())
}

/// Read the SSE stream until the message answering `id` arrives; unrelated
/// notifications are ignored, mirroring the SDK transport.
async fn read_sse_response(
    resp: reqwest::Response,
    id: u64,
    budget: Budget,
) -> Result<Value, McpError> {
    let mut stream = resp.bytes_stream().eventsource();
    loop {
        let item = tokio::time::timeout_at(budget.deadline, stream.next())
            .await
            .map_err(|_| McpError::timeout(timeout_message(budget.wait)))?;
        let Some(item) = item else {
            return Err(McpError::closed(
                "MCP HTTP SSE stream closed before a response arrived",
            ));
        };
        let event = item.map_err(|e| McpError::transport(format!("MCP HTTP SSE error: {e}")))?;
        if !event.event.is_empty() && event.event != "message" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
            continue;
        };
        if value.get("id").and_then(|v| v.as_u64()) == Some(id) {
            return unwrap_json_rpc(value);
        }
    }
}

fn unwrap_json_rpc(value: Value) -> Result<Value, McpError> {
    if let Some(err) = value.get("error") {
        return Err(McpError::json_rpc(format!("MCP Server Error: {err}")));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    /// One recorded request, so tests can assert header propagation and the
    /// initialize/initialized request sequence.
    #[derive(Debug, Clone)]
    pub struct RecordedRequest {
        pub method: String,
        pub has_id: bool,
        pub session: Option<String>,
        pub authorization: Option<String>,
    }

    /// Spawn a mock Streamable HTTP server.
    ///
    /// `mode` selects the response framing: `"json"` replies with a JSON body,
    /// `"sse"` replies with an SSE stream, `"status"` fails every request with
    /// HTTP 500, `"hang"` accepts the connection without ever replying,
    /// `"bad-schema"` advertises a tool whose inputSchema is not an object,
    /// `"401-on-call"` completes the handshake normally but rejects every
    /// `tools/call` with HTTP 401, and `"image"` answers `tools/call` with an
    /// image content block instead of text.
    ///
    /// The returned vector records every request in arrival order.
    pub async fn spawn_mock_http_server(
        mode: &'static str,
    ) -> (
        String,
        Arc<Mutex<Vec<RecordedRequest>>>,
        oneshot::Sender<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/mcp");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_task = seen.clone();
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    res = listener.accept() => {
                        let Ok((mut socket, _)) = res else { break };
                        let seen = seen_task.clone();
                        tokio::spawn(async move {
                            if mode == "hang" {
                                tokio::time::sleep(Duration::from_secs(30)).await;
                                return;
                            }
                            let mut buf = vec![0u8; 8192];
                            let mut total = 0;
                            let pos = loop {
                                let n = match socket.read(&mut buf[total..]).await {
                                    Ok(0) | Err(_) => return,
                                    Ok(n) => n,
                                };
                                total += n;
                                if let Some(pos) =
                                    buf[..total].windows(4).position(|w| w == b"\r\n\r\n")
                                {
                                    break pos;
                                }
                                if total == buf.len() {
                                    return;
                                }
                            };

                            let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                            let mut content_len = 0usize;
                            let mut session: Option<String> = None;
                            let mut authorization: Option<String> = None;
                            for line in head.lines() {
                                if let Some((k, v)) = line.split_once(':') {
                                    let key = k.trim().to_ascii_lowercase();
                                    if key == "content-length" {
                                        content_len = v.trim().parse().unwrap_or(0);
                                    }
                                    if key == SESSION_ID_HEADER {
                                        session = Some(v.trim().to_string());
                                    }
                                    if key == "authorization" {
                                        authorization = Some(v.trim().to_string());
                                    }
                                }
                            }
                            let mut body = buf[pos + 4..total].to_vec();
                            while body.len() < content_len {
                                let mut chunk = vec![0u8; content_len - body.len()];
                                match socket.read(&mut chunk).await {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) => body.extend_from_slice(&chunk[..n]),
                                }
                            }
                            if mode == "status" {
                                let _ = socket
                                    .write_all(b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n")
                                    .await;
                                return;
                            }
                            if mode == "401" {
                                let _ = socket
                                    .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                                    .await;
                                return;
                            }

                            let json: Value =
                                serde_json::from_slice(&body).unwrap_or(Value::Null);
                            let id = json.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                            let method = json
                                .get("method")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            seen.lock().await.push(RecordedRequest {
                                method: method.to_string(),
                                has_id: json.get("id").is_some(),
                                session,
                                authorization,
                            });

                            // Notifications (e.g. notifications/initialized)
                            // get a 202 with no body.
                            if json.get("id").is_none() {
                                let _ = socket
                                    .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                                    .await;
                                return;
                            }
                            if mode == "401-on-call" && method == "tools/call" {
                                let _ = socket
                                    .write_all(
                                        b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n",
                                    )
                                    .await;
                                return;
                            }
                            let result = match method {
                                "initialize" => json!({
                                    "protocolVersion": STREAMABLE_HTTP_PROTOCOL_VERSION,
                                    "capabilities": { "tools": {} },
                                    "serverInfo": { "name": "mock-http-server", "version": "1.0.0" }
                                }),
                                "tools/list" => {
                                    if mode == "bad-schema" {
                                        json!({
                                            "tools": [
                                                {
                                                    "name": "echo",
                                                    "description": "Echo input message",
                                                    "inputSchema": "not-an-object"
                                                }
                                            ]
                                        })
                                    } else {
                                        json!({
                                            "tools": [
                                                {
                                                    "name": "echo",
                                                    "description": "Echo input message",
                                                    "inputSchema": {
                                                        "type": "object",
                                                        "properties": { "message": { "type": "string" } }
                                                    }
                                                }
                                            ]
                                        })
                                    }
                                }
                                "tools/call" => {
                                    if mode == "image" {
                                        json!({
                                            "content": [{
                                                "type": "image",
                                                "mimeType": "image/png",
                                                "data": "iVBORw0KGgo="
                                            }],
                                            "isError": false
                                        })
                                    } else {
                                        json!({
                                            "content": [{ "type": "text", "text": "ok" }],
                                            "isError": false
                                        })
                                    }
                                }
                                _ => json!({}),
                            };
                            let payload =
                                json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
                            let session_header = if method == "initialize" {
                                "Mcp-Session-Id: sess-1\r\n"
                            } else {
                                ""
                            };
                            let resp = if mode == "sse" {
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                                     {session_header}Connection: close\r\n\r\n\
                                     event: message\ndata: {payload}\n\n"
                                )
                            } else {
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                                     {session_header}Connection: close\r\n\
                                     Content-Length: {}\r\n\r\n{payload}",
                                    payload.len()
                                )
                            };
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.flush().await;
                        });
                    }
                }
            }
        });

        (url, seen, shutdown_tx)
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::spawn_mock_http_server;
    use super::*;
    use crate::mcp::client::McpClient;
    use serde_json::json;

    /// A JSON-framed reply is unwrapped and the session id is echoed.
    #[tokio::test]
    async fn test_http_transport_json_roundtrip() {
        let (url, seen, _shutdown) = spawn_mock_http_server("json").await;
        let client = McpClient::connect_http("http-srv", &url, HashMap::new())
            .await
            .expect("HTTP connect failed");
        assert_eq!(client.transport_type(), "http");

        let tools = client.list_tools().await.expect("list_tools failed");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");

        let res = client
            .call_tool("echo", &json!({ "message": "hi" }))
            .await
            .expect("call_tool failed");
        assert!(!res.is_error);
        assert_eq!(res.content[0].text.as_deref(), Some("ok"));

        // initialize carried no session id; the initialized notification and
        // every later request echo the one the server handed back.
        let requests = seen.lock().await.clone();
        assert!(requests.iter().any(|r| r.method == "initialize"));
        assert!(
            requests
                .iter()
                .any(|r| r.method == "notifications/initialized")
        );
        assert!(requests.iter().any(|r| r.method == "tools/list"));
        assert!(requests.iter().any(|r| r.method == "tools/call"));
        let initialize = requests
            .iter()
            .position(|r| r.method == "initialize")
            .unwrap();
        let initialized = requests
            .iter()
            .position(|r| r.method == "notifications/initialized")
            .unwrap();
        assert!(initialize < initialized);
        assert_eq!(requests[initialize].session, None);
        assert_eq!(requests[initialized].session.as_deref(), Some("sess-1"));
        assert_eq!(
            requests
                .iter()
                .find(|r| r.method == "tools/list")
                .unwrap()
                .session
                .as_deref(),
            Some("sess-1")
        );
    }

    /// An SSE-framed reply is read until the matching message arrives.
    #[tokio::test]
    async fn test_http_transport_sse_roundtrip() {
        let (url, _seen, _shutdown) = spawn_mock_http_server("sse").await;
        let client = McpClient::connect_http("http-sse", &url, HashMap::new())
            .await
            .expect("HTTP connect failed");

        let tools = client.list_tools().await.expect("list_tools failed");
        assert_eq!(tools[0].name, "echo");
        let res = client
            .call_tool("echo", &json!({}))
            .await
            .expect("call_tool failed");
        assert_eq!(res.content[0].text.as_deref(), Some("ok"));
    }

    /// A non-2xx reply surfaces the status instead of a parse error.
    #[tokio::test]
    async fn test_http_transport_status_error() {
        let (url, _seen, _shutdown) = spawn_mock_http_server("status").await;
        let err = match McpClient::connect_http("http-fail", &url, HashMap::new()).await {
            Ok(_) => panic!("500 must fail the handshake"),
            Err(e) => e,
        };
        let message = err.to_string();
        assert!(
            message.contains("MCP HTTP request failed with status HTTP 500"),
            "unexpected error: {message}"
        );
        assert!(matches!(err, McpError::HttpStatus { status: 500, .. }));
    }

    /// A server that accepts the connection but never replies must fail with
    /// the resolved per-request timeout.
    #[tokio::test]
    async fn test_http_transport_timeout() {
        let (url, _seen, _shutdown) = spawn_mock_http_server("hang").await;
        let mut transport = McpHttpTransport::connect(&url, HashMap::new())
            .await
            .expect("transport build failed");
        transport.set_request_timeout(Some(Duration::from_millis(150)));
        let err = transport
            .send_request("initialize", json!({}))
            .await
            .expect_err("request must time out");
        assert_eq!(err.to_string(), "MCP request timed out after 150ms");
        assert!(matches!(err, McpError::Timeout(_)));
    }

    /// A malformed URL fails at connect time.
    #[tokio::test]
    async fn test_http_transport_rejects_invalid_url() {
        let err = match McpHttpTransport::connect("not-a-url", HashMap::new()).await {
            Ok(_) => panic!("invalid url must fail"),
            Err(e) => e,
        };
        assert!(
            err.to_string().starts_with("Invalid MCP url 'not-a-url'"),
            "{err}"
        );

        let err = match McpHttpTransport::connect("file:///etc/passwd", HashMap::new()).await {
            Ok(_) => panic!("file url must fail"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("unsupported scheme"), "{err}");
    }

    /// The handshake is `initialize` (request, with id) immediately followed
    /// by `notifications/initialized` (notification, no id).
    #[tokio::test]
    async fn test_http_handshake_sends_initialized_notification() {
        let (url, seen, _shutdown) = spawn_mock_http_server("json").await;
        let _client = McpClient::connect_http("http-srv", &url, HashMap::new())
            .await
            .expect("HTTP connect failed");

        let requests = seen.lock().await.clone();
        let init = requests
            .iter()
            .find(|r| r.method == "initialize")
            .expect("initialize request recorded");
        assert!(init.has_id, "initialize must carry an id");
        let notification = requests
            .iter()
            .find(|r| r.method == "notifications/initialized")
            .expect("initialized notification recorded");
        assert!(
            !notification.has_id,
            "notifications/initialized must not carry an id"
        );
        assert!(
            requests.iter().position(|r| r.method == "initialize")
                < requests
                    .iter()
                    .position(|r| r.method == "notifications/initialized"),
            "initialize must precede the initialized notification"
        );
    }
}
