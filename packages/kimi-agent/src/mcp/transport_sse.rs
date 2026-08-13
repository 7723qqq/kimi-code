/// MCP legacy HTTP+SSE transport client.
///
/// Mirrors the TS `packages/agent-core/src/mcp/client-sse.ts` (which wraps
/// the SDK's deprecated `SSEClientTransport`). Exists for compatibility with
/// older MCP servers; new remote servers should prefer streamable HTTP.
///
/// Protocol: a GET to the server URL opens a long-lived `text/event-stream`.
/// The server's first `endpoint` event names the POST endpoint; JSON-RPC
/// requests are POSTed there (the server answers 202), and responses arrive
/// as `message` events over the open SSE stream, matched by id. The SDK's
/// same-origin check on the endpoint is ported — a server cannot redirect
/// POSTs (carrying the bearer token) to another origin.
///
/// Unlike the TS client (which surfaced a dropped stream as an unexpected
/// close and removed the server's tools), this transport keeps the SSE stream
/// alive on its own: a supervisor task re-opens the stream with exponential
/// backoff whenever it drops, and requests wait for a live stream before
/// posting (a POST's response is only ever delivered over the stream). The
/// endpoint is re-resolved on each reconnect because the server's session id
/// may rotate. A request already in flight when the stream drops fails fast
/// rather than being silently re-posted — re-posting a `tools/call` could
/// double-execute a side-effecting tool.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::mcp::transport_stdio::DEFAULT_REQUEST_TIMEOUT_MS;
use crate::mcp::types::*;

/// Options for connecting an MCP SSE server.
#[derive(Debug, Clone, Default)]
pub struct SseConnectOptions {
    /// Static bearer token for the `Authorization` header.
    pub api_key: Option<String>,
    /// Client version reported in `initialize`.
    pub client_version: Option<String>,
    /// Timeout for the endpoint event, `initialize`, and `tools/list`.
    pub startup_timeout_ms: Option<u64>,
    /// Timeout for `tools/call`.
    pub tool_call_timeout_ms: Option<u64>,
    /// Initial delay for the auto-reconnect loop (exponential backoff base),
    /// in milliseconds. Default 500.
    pub reconnect_initial_delay_ms: Option<u64>,
    /// Cap for the auto-reconnect backoff, in milliseconds. Default 30_000.
    pub reconnect_max_delay_ms: Option<u64>,
}

/// An MCP legacy HTTP+SSE transport client.
pub struct MCPSseTransport {
    client: reqwest::Client,
    /// POST endpoint announced by the server's `endpoint` event, re-resolved
    /// on each (re)connect since the session id may rotate.
    endpoint: Arc<Mutex<String>>,
    api_key: Option<String>,
    /// Messages parsed off the SSE stream by the supervisor task.
    messages: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    /// The supervisor task; aborted on drop so the stream closes with us.
    supervisor: tokio::task::JoinHandle<()>,
    /// `true` while the SSE stream is established. Requests wait on it before
    /// posting, so a POST never goes out while the response-carrying stream
    /// is down.
    stream_up: tokio::sync::watch::Receiver<bool>,
    next_id: AtomicU64,
    startup_timeout_ms: u64,
    tool_call_timeout_ms: u64,
    server_protocol_version: Option<String>,
}

impl MCPSseTransport {
    /// Open the SSE stream, resolve the POST endpoint, and perform the MCP
    /// `initialize` → `notifications/initialized` handshake. On success a
    /// supervisor task keeps the stream alive, reconnecting with exponential
    /// backoff if it drops.
    pub async fn connect(url: &str, options: SseConnectOptions) -> Result<Self, String> {
        let startup_timeout_ms = options
            .startup_timeout_ms
            .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
        let reconnect_initial_delay_ms = options.reconnect_initial_delay_ms.unwrap_or(500);
        let reconnect_max_delay_ms = options.reconnect_max_delay_ms.unwrap_or(30_000);
        let client = reqwest::Client::new();

        // The supervisor owns the whole stream lifetime: it does the first
        // open (so `connect` keeps the fail-fast error messages), then the
        // reconnect loop. `initial_result` reports the first open's outcome.
        let (message_tx, message_rx) = tokio::sync::mpsc::unbounded_channel();
        let (stream_up_tx, stream_up_rx) = tokio::sync::watch::channel(false);
        let endpoint = Arc::new(Mutex::new(String::new()));
        let (initial_tx, initial_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let supervisor = tokio::spawn(supervisor_loop(
            client.clone(),
            url.to_string(),
            options.api_key.clone(),
            endpoint.clone(),
            message_tx,
            stream_up_tx,
            initial_tx,
            startup_timeout_ms,
            reconnect_initial_delay_ms,
            reconnect_max_delay_ms,
        ));

        // Wait for the first stream to come up (or a hard error to surface).
        match tokio::time::timeout(Duration::from_millis(startup_timeout_ms), initial_rx).await {
            Err(_) => {
                supervisor.abort();
                return Err(format!("MCP SSE connect timed out after {startup_timeout_ms}ms"));
            }
            Ok(Err(_)) => {
                supervisor.abort();
                return Err("MCP SSE connect failed: transport stopped during startup".to_string());
            }
            Ok(Ok(Err(message))) => {
                supervisor.abort();
                return Err(message);
            }
            Ok(Ok(Ok(()))) => {}
        }

        let mut transport = Self {
            client,
            endpoint,
            api_key: options.api_key,
            messages: message_rx,
            supervisor,
            stream_up: stream_up_rx,
            next_id: AtomicU64::new(1),
            startup_timeout_ms,
            tool_call_timeout_ms: options
                .tool_call_timeout_ms
                .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS),
            server_protocol_version: None,
        };

        let params = serde_json::json!({
            "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": MCP_CLIENT_NAME,
                "version": options.client_version.unwrap_or_else(|| "0.0.0".to_string()),
            },
        });
        let result = transport
            .request("initialize", params, startup_timeout_ms)
            .await?;
        let protocol_version = result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "MCP initialize response has no protocolVersion".to_string())?
            .to_string();
        transport
            .notify("notifications/initialized", serde_json::json!({}))
            .await?;
        transport.server_protocol_version = Some(protocol_version);
        Ok(transport)
    }

    /// The protocol revision the server answered `initialize` with.
    pub fn server_protocol_version(&self) -> Option<&str> {
        self.server_protocol_version.as_deref()
    }

    /// Call the MCP `tools/list` endpoint.
    pub async fn list_tools(&mut self) -> Result<MCPToolsListResult, String> {
        let timeout = self.startup_timeout_ms;
        let response = self
            .request("tools/list", serde_json::json!({}), timeout)
            .await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/list response: {e}"))
    }

    /// Call the MCP `tools/call` endpoint.
    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        let timeout = self.tool_call_timeout_ms;
        let response = self.request("tools/call", params, timeout).await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// POST a request, then await the id-matching message off the SSE stream.
    /// A live stream is required before the POST: the endpoint only answers
    /// 202 and the actual response arrives over the stream. If the stream
    /// drops while awaiting the response, the request fails fast instead of
    /// being re-posted (re-posting a `tools/call` could double-execute it).
    async fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: method.into(),
            params: Some(params),
        };
        let body = serde_json::to_value(&request).map_err(|e| e.to_string())?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

        self.wait_stream_up(deadline).await?;
        self.post(&body).await?;

        let mut stream_up = self.stream_up.clone();
        loop {
            let message = tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(format!("MCP request '{method}' timed out after {timeout_ms}ms"));
                }
                changed = stream_up.changed() => match changed {
                    // A reconnect happened; the response to this POST is lost,
                    // so fail fast rather than re-posting a side-effecting call.
                    Ok(()) if *stream_up.borrow() => continue,
                    Ok(()) => {
                        return Err(format!(
                            "MCP SSE stream closed during '{method}'; reconnecting"
                        ));
                    }
                    Err(_) => {
                        return Err(format!("MCP SSE transport stopped during '{method}'"));
                    }
                },
                message = self.messages.recv() => match message {
                    None => return Err(format!("MCP SSE transport closed during '{method}'")),
                    Some(message) => message,
                },
            };
            // Server requests/notifications are not handled at this layer.
            if message.get("method").is_some() {
                continue;
            }
            if message.get("id").map(|v| v == &serde_json::json!(id)) != Some(true) {
                continue;
            }
            let rpc_response: MCPJsonRpcResponse = serde_json::from_value(message)
                .map_err(|e| format!("Failed to parse JSON-RPC response: {e}"))?;
            if let Some(error) = rpc_response.error {
                return Err(format!("MCP error [{}]: {}", error.code, error.message));
            }
            return rpc_response
                .result
                .ok_or_else(|| "MCP response has no result".into());
        }
    }

    /// Wait until the SSE stream is established (or `deadline` passes). The
    /// supervisor marks the stream up only after the endpoint is resolved, so
    /// a post-reconnect POST targets a valid session.
    async fn wait_stream_up(&mut self, deadline: tokio::time::Instant) -> Result<(), String> {
        let mut stream_up = self.stream_up.clone();
        if *stream_up.borrow() {
            return Ok(());
        }
        loop {
            let changed = tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    return Err("MCP SSE stream is not connected; reconnecting".to_string());
                }
                changed = stream_up.changed() => changed,
            };
            match changed {
                Ok(()) if *stream_up.borrow() => return Ok(()),
                Ok(()) => {} // still reconnecting; keep waiting
                Err(_) => return Err("MCP SSE transport stopped".to_string()),
            }
        }
    }

    /// POST a notification; any 2xx (typically 202) is success.
    async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.post(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn post(&self, body: &serde_json::Value) -> Result<(), String> {
        let endpoint = self.endpoint.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut request = self
            .client
            .post(&endpoint)
            .timeout(Duration::from_millis(self.startup_timeout_ms))
            .json(body);
        if let Some(ref api_key) = self.api_key
            && !api_key.is_empty()
        {
            request = request.header("Authorization", format!("Bearer {api_key}"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let brief: String = body.chars().take(500).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), brief));
        }
        Ok(())
    }
}

impl Drop for MCPSseTransport {
    fn drop(&mut self) {
        self.supervisor.abort();
    }
}

/// Open the SSE stream: GET with `Accept: text/event-stream`, apply the
/// startup timeout, and check the status. No body timeout — the stream is
/// endless by design.
async fn open_stream(
    client: &reqwest::Client,
    url: &str,
    api_key: &Option<String>,
    startup_timeout_ms: u64,
) -> Result<reqwest::Response, String> {
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    if let Some(api_key) = api_key
        && !api_key.is_empty()
    {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }
    let response = tokio::time::timeout(Duration::from_millis(startup_timeout_ms), request.send())
        .await
        .map_err(|_| format!("MCP SSE connect timed out after {startup_timeout_ms}ms"))?
        .map_err(|e| format!("MCP SSE connect failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let brief: String = body.chars().take(500).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), brief));
    }
    Ok(response)
}

/// Double the backoff delay, capped at `max_delay_ms` (never below 1).
fn grow_backoff(current: u64, max_delay_ms: u64) -> u64 {
    current.saturating_mul(2).clamp(1, max_delay_ms.max(1))
}

/// Stream supervisor: open the SSE stream, resolve the `endpoint` event, feed
/// `message` events into the response channel, and — when the stream drops —
/// reconnect with exponential backoff. The first open's outcome is reported
/// through `initial_result` so `connect` keeps fail-fast startup errors.
#[allow(clippy::too_many_arguments)]
async fn supervisor_loop(
    client: reqwest::Client,
    url: String,
    api_key: Option<String>,
    endpoint: Arc<Mutex<String>>,
    message_tx: tokio::sync::mpsc::UnboundedSender<serde_json::Value>,
    stream_up: tokio::sync::watch::Sender<bool>,
    initial_result: tokio::sync::oneshot::Sender<Result<(), String>>,
    startup_timeout_ms: u64,
    reconnect_initial_delay_ms: u64,
    reconnect_max_delay_ms: u64,
) {
    let mut first_open = true;
    let mut backoff = reconnect_initial_delay_ms.max(1);
    // Only the first open reports through the oneshot; `take` frees the
    // sender so the reconnect loop never touches a moved value.
    let mut initial_result = Some(initial_result);
    loop {
        let response = match open_stream(&client, &url, &api_key, startup_timeout_ms).await {
            Ok(response) => response,
            Err(error) => {
                if first_open {
                    if let Some(tx) = initial_result.take() {
                        let _ = tx.send(Err(error));
                    }
                    return;
                }
                if message_tx.is_closed() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(backoff)).await;
                backoff = grow_backoff(backoff, reconnect_max_delay_ms);
                continue;
            }
        };

        // The endpoint event names the POST target; re-resolve it on every
        // connect because the server's session id may rotate.
        let mut stream = response.bytes_stream().eventsource();
        let endpoint_result = match tokio::time::timeout(
            Duration::from_millis(startup_timeout_ms),
            stream.next(),
        )
        .await
        {
            Err(_) => Err(format!(
                "MCP SSE endpoint event timed out after {startup_timeout_ms}ms"
            )),
            Ok(None) => Err("MCP SSE stream closed before the endpoint event".to_string()),
            Ok(Some(Err(_))) => Err("MCP SSE stream error while reading the endpoint event"
                .to_string()),
            Ok(Some(Ok(event))) if event.event == "endpoint" => {
                match resolve_endpoint(&url, &event.data) {
                    Ok(resolved) => {
                        *endpoint.lock().unwrap_or_else(|e| e.into_inner()) = resolved;
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            }
            Ok(Some(Ok(_))) => Err("MCP SSE endpoint event not received".to_string()),
        };
        if let Err(error) = endpoint_result {
            if first_open {
                if let Some(tx) = initial_result.take() {
                    let _ = tx.send(Err(error));
                }
                return;
            }
            if message_tx.is_closed() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(backoff)).await;
            backoff = grow_backoff(backoff, reconnect_max_delay_ms);
            continue;
        }

        if first_open {
            first_open = false;
            if let Some(tx) = initial_result.take() {
                let _ = tx.send(Ok(()));
            }
        }
        backoff = reconnect_initial_delay_ms.max(1);
        let _ = stream_up.send(true);

        // Consume message events until the stream drops.
        while let Some(event) = stream.next().await {
            let Ok(event) = event else { break };
            if event.event == "endpoint" {
                // The session id may rotate mid-stream too; keep the endpoint
                // current so a stale POST target never outlives its session.
                if let Ok(resolved) = resolve_endpoint(&url, &event.data) {
                    *endpoint.lock().unwrap_or_else(|e| e.into_inner()) = resolved;
                }
                continue;
            }
            // Default SSE event type is "message"; tolerate both.
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&event.data)
                && message_tx.send(value).is_err()
            {
                return; // receiver dropped; the transport is gone
            }
        }

        // Stream dropped: mark it down and reconnect with exponential backoff.
        let _ = stream_up.send(false);
        if message_tx.is_closed() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(backoff)).await;
        backoff = grow_backoff(backoff, reconnect_max_delay_ms);
    }
}

/// `scheme://host[:port]` of a URL, lowercased scheme/host.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    Some(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    ))
}

/// Resolve the `endpoint` event's URI against the SSE URL, enforcing the
/// SDK's same-origin check: the endpoint must share the SSE URL's origin so
/// a compromised server cannot bounce authenticated POSTs elsewhere.
fn resolve_endpoint(base: &str, data: &str) -> Result<String, String> {
    let base_origin = origin_of(base).ok_or_else(|| format!("Invalid MCP SSE base URL: {base}"))?;
    let resolved = if data.contains("://") {
        data.to_string()
    } else if let Some(path) = data.strip_prefix('/') {
        format!("{base_origin}/{path}")
    } else {
        // Relative: resolve against the base URL's directory.
        let without_query = base.split(['?', '#']).next().unwrap_or(base);
        let directory = match without_query[base_origin.len()..].rfind('/') {
            Some(last_slash) => &without_query[..base_origin.len() + last_slash],
            None => &without_query[..base_origin.len()],
        };
        format!("{directory}/{data}")
    };
    let resolved_origin =
        origin_of(&resolved).ok_or_else(|| format!("Invalid MCP SSE endpoint: {data}"))?;
    if resolved_origin != base_origin {
        return Err(format!(
            "MCP SSE endpoint origin {resolved_origin} does not match the server origin {base_origin}"
        ));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Child, ChildStdout};

    use super::*;

    #[test]
    fn origin_extraction() {
        assert_eq!(
            origin_of("https://Example.com:8443/a/b?c").as_deref(),
            Some("https://example.com:8443")
        );
        assert_eq!(origin_of("http://h/x").as_deref(), Some("http://h"));
        assert!(origin_of("not-a-url").is_none());
    }

    #[test]
    fn endpoint_resolution_and_same_origin_check() {
        let base = "https://mcp.example.com/v1/sse?key=1";
        assert_eq!(
            resolve_endpoint(base, "/messages?session=abc").unwrap(),
            "https://mcp.example.com/messages?session=abc"
        );
        assert_eq!(
            resolve_endpoint(base, "messages").unwrap(),
            "https://mcp.example.com/v1/messages"
        );
        assert_eq!(
            resolve_endpoint(base, "https://mcp.example.com/direct").unwrap(),
            "https://mcp.example.com/direct"
        );
        let cross = resolve_endpoint(base, "https://evil.example.net/messages");
        assert!(cross.is_err(), "cross-origin endpoint must be rejected");
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        let cap = 250;
        assert_eq!(grow_backoff(1, cap), 2);
        assert_eq!(grow_backoff(50, cap), 100);
        assert_eq!(grow_backoff(100, cap), 200);
        assert_eq!(grow_backoff(200, cap), cap);
        assert_eq!(grow_backoff(cap, cap), cap);
        assert_eq!(grow_backoff(10_000, cap), cap, "never exceeds the cap");
    }

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok()
    }

    fn spawn_node(script: &str) -> (Child, BufReader<ChildStdout>) {
        let mut child = std::process::Command::new("node")
            .args(["-e", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node server");
        let stdout = child.stdout.take().expect("stdout");
        (child, BufReader::new(stdout))
    }

    /// Read lines until one starts with `prefix`, returning it. Errors if the
    /// server's stdout closes first.
    fn await_line(reader: &mut BufReader<ChildStdout>, prefix: &str) -> Result<String, String> {
        let mut line = String::new();
        loop {
            line.clear();
            reader
                .read_line(&mut line)
                .map_err(|e| format!("read server stdout: {e}"))?;
            if line.is_empty() {
                return Err(format!("server stdout closed before '{prefix}'"));
            }
            let trimmed = line.trim_end();
            if trimmed.starts_with(prefix) {
                return Ok(trimmed.to_string());
            }
        }
    }

    /// End-to-end legacy HTTP+SSE flow against a scripted Node server:
    /// endpoint event, 202-answered POSTs, responses over the SSE stream.
    /// Skipped when `node` is unavailable.
    #[tokio::test(flavor = "multi_thread")]
    async fn handshake_and_tool_calls_against_scripted_sse_server() {
        if !node_available() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const http = require('node:http');
let sse = null;
const send = (msg) => sse.write('event: message\ndata: ' + JSON.stringify(msg) + '\n\n');
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    sse = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: endpoint\ndata: /messages?session=abc\n\n');
    return;
  }
  if (!req.url.startsWith('/messages')) { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(202); res.end();
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: {}, serverInfo: { name: 'scripted-sse', version: '1.0.0' },
      } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
      send({ jsonrpc: '2.0', id: msg.id, result: {
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      } });
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
      } });
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
"#;
        let (mut child, mut reader) = spawn_node(script);
        let port = await_line(&mut reader, "PORT=")
            .expect("port line")
            .trim_start_matches("PORT=")
            .to_string();

        let outcome = async {
            let mut transport = MCPSseTransport::connect(
                &format!("http://127.0.0.1:{port}/v1/sse"),
                SseConnectOptions {
                    startup_timeout_ms: Some(15_000),
                    tool_call_timeout_ms: Some(15_000),
                    ..Default::default()
                },
            )
            .await?;
            if transport.server_protocol_version() != Some(MCP_LEGACY_PROTOCOL_VERSION) {
                return Err("unexpected protocol version".to_string());
            }
            let tools = transport.list_tools().await?;
            if tools.tools.len() != 1 || tools.tools[0].name != "echo" {
                return Err("unexpected tools".to_string());
            }
            let result = transport
                .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
                .await?;
            let text = mcp_content_to_text(&result.content);
            if text != "echo:hi" {
                return Err(format!("unexpected call result: {text}"));
            }
            Ok(())
        }
        .await;
        let _ = child.kill();
        let _ = child.wait();
        outcome.expect("scripted sse flow");
    }

    /// Auto-reconnect: the server drops the first SSE stream right after
    /// answering its first call; the supervisor reopens the stream (exponential
    /// backoff) and a second call succeeds over the new stream. The server
    /// prints `DROPPED` when it closes stream #1 and `STREAM:2` when the client
    /// reconnects, so the test deterministically waits for the recovery.
    #[tokio::test(flavor = "multi_thread")]
    async fn auto_reconnects_dropped_sse_stream() {
        if !node_available() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const http = require('node:http');
let sse = null;
let streamCount = 0;
const send = (msg) => { if (sse) { try {
  sse.write('event: message\ndata: ' + JSON.stringify(msg) + '\n\n');
} catch {} } };
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    sse = res;
    streamCount += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: endpoint\ndata: /messages?session=abc\n\n');
    process.stdout.write('STREAM:' + streamCount + '\n');
    return;
  }
  if (!req.url.startsWith('/messages')) { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(202); res.end();
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: {}, serverInfo: { name: 'flaky-sse', version: '1.0.0' },
      } });
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
      } });
      if (streamCount === 1) {
        sse.end();
        sse = null;
        process.stdout.write('DROPPED\n');
      }
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
"#;
        let (mut child, mut reader) = spawn_node(script);
        let port = await_line(&mut reader, "PORT=")
            .expect("port line")
            .trim_start_matches("PORT=")
            .to_string();

        let outcome = async {
            let mut transport = MCPSseTransport::connect(
                &format!("http://127.0.0.1:{port}/v1/sse"),
                SseConnectOptions {
                    startup_timeout_ms: Some(10_000),
                    tool_call_timeout_ms: Some(10_000),
                    reconnect_initial_delay_ms: Some(50),
                    reconnect_max_delay_ms: Some(250),
                    ..Default::default()
                },
            )
            .await?;

            // First call over stream #1; the server drops it right after.
            let first = transport
                .call_tool("echo", Some(serde_json::json!({ "value": "one" })))
                .await?;
            if mcp_content_to_text(&first.content) != "echo:one" {
                return Err("first call failed".to_string());
            }

            // Server closed stream #1, then the client reopened stream #2.
            await_line(&mut reader, "DROPPED")?;
            await_line(&mut reader, "STREAM:2")?;

            // The second call must succeed over the reconnected stream.
            let second = transport
                .call_tool("echo", Some(serde_json::json!({ "value": "two" })))
                .await?;
            if mcp_content_to_text(&second.content) != "echo:two" {
                return Err("second call failed".to_string());
            }
            Ok(())
        }
        .await;
        let _ = child.kill();
        let _ = child.wait();
        outcome.expect("auto-reconnect sse flow");
    }
}
