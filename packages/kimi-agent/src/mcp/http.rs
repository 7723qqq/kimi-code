//! MCP Streamable HTTP transport (`transport = "http"`).
//!
//! Mirrors the v2 `HttpMcpClient` / `StreamableHTTPClientTransport` wire
//! behavior (`mcpCore/client-http.ts`): every JSON-RPC message is POSTed to
//! the server URL, the reply may be a single JSON body or an SSE stream, and
//! a `Mcp-Session-Id` handed back by the server is echoed on later requests.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::Mutex;

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
}

impl McpHttpTransport {
    pub async fn connect(url: &str, headers: HashMap<String, String>) -> Result<Self, String> {
        // Fail at connect time on an unusable URL instead of at first call.
        url::Url::parse(url).map_err(|e| format!("Invalid MCP HTTP url '{url}': {e}"))?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
        Ok(Self {
            url: url.to_string(),
            headers,
            client,
            session_id: Mutex::new(None),
            next_id: AtomicU64::new(1),
            request_timeout: None,
        })
    }

    /// Apply a per-request timeout (v2 `buildRequestOptions(toolCallTimeoutMs)`).
    pub fn set_request_timeout(&mut self, timeout: Option<Duration>) {
        self.request_timeout = timeout;
    }

    /// POST one JSON-RPC message and return its `result`.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

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

        let wait = self.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT);
        let resp = tokio::time::timeout(wait, req.json(&payload).send())
            .await
            .map_err(|_| timeout_message(wait))?
            .map_err(|e| format!("Failed to post to MCP HTTP endpoint '{}': {e}", self.url))?;

        if let Some(session) = resp
            .headers()
            .get(SESSION_ID_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().await = Some(session.to_string());
        }

        let status = resp.status();
        if !status.is_success() {
            return Err(format!("MCP HTTP request failed with status HTTP {status}"));
        }

        let is_event_stream = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("text/event-stream"));
        if is_event_stream {
            read_sse_response(resp, id, wait).await
        } else {
            let body = tokio::time::timeout(wait, resp.json::<Value>())
                .await
                .map_err(|_| timeout_message(wait))?
                .map_err(|e| format!("Failed to parse MCP HTTP response: {e}"))?;
            unwrap_json_rpc(body)
        }
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
    wait: Duration,
) -> Result<Value, String> {
    let mut stream = resp.bytes_stream().eventsource();
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let item = tokio::time::timeout_at(deadline, stream.next())
            .await
            .map_err(|_| timeout_message(wait))?;
        let Some(item) = item else {
            return Err("MCP HTTP SSE stream closed before a response arrived".into());
        };
        let event = item.map_err(|e| format!("MCP HTTP SSE error: {e}"))?;
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

fn unwrap_json_rpc(value: Value) -> Result<Value, String> {
    if let Some(err) = value.get("error") {
        return Err(format!("MCP Server Error: {err}"));
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

    /// Spawn a mock Streamable HTTP server.
    ///
    /// `mode` selects the response framing: `"json"` replies with a JSON body,
    /// `"sse"` replies with an SSE stream, `"status"` fails every request with
    /// HTTP 500, `"hang"` accepts the connection without ever replying, and
    /// `"bad-schema"` advertises a tool whose inputSchema is not an object.
    ///
    /// The returned vector records the `Mcp-Session-Id` of every request in
    /// arrival order, so tests can assert the header is echoed.
    pub async fn spawn_mock_http_server(
        mode: &'static str,
    ) -> (String, Arc<Mutex<Vec<Option<String>>>>, oneshot::Sender<()>) {
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
                            for line in head.lines() {
                                if let Some((k, v)) = line.split_once(':') {
                                    let key = k.trim().to_ascii_lowercase();
                                    if key == "content-length" {
                                        content_len = v.trim().parse().unwrap_or(0);
                                    }
                                    if key == SESSION_ID_HEADER {
                                        session = Some(v.trim().to_string());
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
                            seen.lock().await.push(session);

                            if mode == "status" {
                                let _ = socket
                                    .write_all(b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n")
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
                                "tools/call" => json!({
                                    "content": [{ "type": "text", "text": "ok" }],
                                    "isError": false
                                }),
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

        // initialize carried no session id; every later request echoes the one
        // the server handed back.
        let sessions = seen.lock().await.clone();
        assert_eq!(sessions.len(), 3, "initialize + tools/list + tools/call");
        assert_eq!(sessions[0], None);
        assert_eq!(sessions[1].as_deref(), Some("sess-1"));
        assert_eq!(sessions[2].as_deref(), Some("sess-1"));
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
        assert!(
            err.contains("MCP HTTP request failed with status HTTP 500"),
            "unexpected error: {err}"
        );
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
        assert_eq!(err, "MCP request timed out after 150ms");
    }

    /// A malformed URL fails at connect time.
    #[tokio::test]
    async fn test_http_transport_rejects_invalid_url() {
        let err = match McpHttpTransport::connect("not-a-url", HashMap::new()).await {
            Ok(_) => panic!("invalid url must fail"),
            Err(e) => e,
        };
        assert!(err.starts_with("Invalid MCP HTTP url 'not-a-url'"), "{err}");
    }
}
