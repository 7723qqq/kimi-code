//! MCP client implementation supporting stdio and HTTP/SSE transports.

use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, oneshot};

use crate::mcp::http::McpHttpTransport;
use crate::mcp::sse::McpSseTransport;
use crate::mcp::types::*;

enum McpTransport {
    Stdio {
        _process: Arc<Mutex<Child>>,
        stdin: Arc<Mutex<tokio::process::ChildStdin>>,
        pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
        /// Bounded tail of the child's stderr (v2 `BoundedTail`,
        /// client-stdio.ts:STDERR_BUFFER_CAPACITY).
        stderr: Arc<Mutex<Vec<u8>>>,
    },
    Sse(McpSseTransport),
    Http(McpHttpTransport),
    /// In-process stub used by the napi binding path and tests. Carries the
    /// advertised tools so tests can exercise discovery edge cases (e.g. tool
    /// name collisions) without spawning a real server.
    Mock { tools: Vec<McpTool> },
}

/// v2 `STDERR_BUFFER_CAPACITY` (client-stdio.ts:20): the last 4 KiB of the
/// child's stderr are kept for error reporting.
const STDERR_BUFFER_CAPACITY: usize = 4 * 1024;

/// Unexpected-close listener slot (v2 `unexpectedCloseListener`): at most one
/// `Fn(String)` listener, later registrations replace earlier ones.
pub(crate) type UnexpectedCloseListener = Arc<Mutex<Option<Box<dyn Fn(String) + Send + Sync>>>>;

pub struct McpClient {
    server_name: String,
    transport: McpTransport,
    next_id: AtomicU64,
    closed: Arc<std::sync::atomic::AtomicBool>,
    /// Per-request timeout resolved from `toolTimeoutMs` (v2
    /// `toolCallTimeoutMs`); `None` keeps the transport built-in.
    tool_timeout: Option<Duration>,
    /// Listener fired when the transport closes on its own after the
    /// handshake (v2 `unexpectedCloseListener`, client-stdio.ts:46). At most
    /// one listener; later registrations replace earlier ones.
    unexpected_close: UnexpectedCloseListener,
    /// Close reason buffered when the transport dies before a listener is
    /// installed; replayed on registration so the close is never dropped
    /// (v2 `pendingUnexpectedClose`, client-stdio.ts:51).
    pending_close_reason: Arc<Mutex<Option<String>>>,
}

/// Built-in request timeout when no `toolTimeoutMs` is configured.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Fire the unexpected-close listener with `reason`, or buffer it for replay
/// when a listener registers later (v2 `fireUnexpectedClose`,
/// client-sse.ts:175-184). Shared by the stdio drain task, the SSE bridge and
/// the SSE transport's stream reader.
pub(crate) async fn fire_or_buffer_unexpected_close(
    unexpected_close: &UnexpectedCloseListener,
    pending_close_reason: &Arc<Mutex<Option<String>>>,
    reason: String,
) {
    let listener = unexpected_close.lock().await;
    if let Some(f) = listener.as_ref() {
        f(reason);
    } else {
        *pending_close_reason.lock().await = Some(reason);
    }
}

impl McpClient {
    /// Create a mock MCP client for testing without spawning subprocesses.
    pub fn mock(server_name: &str) -> Self {
        Self::mock_with_tools(
            server_name,
            vec![McpTool {
                name: format!("{}_sample_tool", server_name),
                description: Some("Sample mock MCP tool".into()),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    }
                }),
            }],
        )
    }

    /// Create a mock MCP client advertising a custom tool list (tests).
    pub fn mock_with_tools(server_name: &str, tools: Vec<McpTool>) -> Self {
        Self {
            server_name: server_name.to_string(),
            transport: McpTransport::Mock { tools },
            next_id: AtomicU64::new(1),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_timeout: None,
            unexpected_close: Arc::new(Mutex::new(None)),
            pending_close_reason: Arc::new(Mutex::new(None)),
        }
    }

    /// Apply the resolved per-server tool-call timeout (v2
    /// `buildRequestOptions(toolCallTimeoutMs)`).
    pub fn set_tool_timeout(&mut self, timeout: Option<Duration>) {
        self.tool_timeout = timeout;
        match &mut self.transport {
            McpTransport::Sse(sse) => sse.set_request_timeout(timeout),
            McpTransport::Http(http) => http.set_request_timeout(timeout),
            _ => {}
        }
    }

    /// Connect to a remote MCP server via Streamable HTTP (`transport = "http"`).
    pub async fn connect_http(
        server_name: &str,
        url: &str,
        headers: HashMap<String, String>,
    ) -> Result<Self, String> {
        let transport = McpHttpTransport::connect(url, headers).await?;
        let client = Self {
            server_name: server_name.to_string(),
            transport: McpTransport::Http(transport),
            next_id: AtomicU64::new(1),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_timeout: None,
            unexpected_close: Arc::new(Mutex::new(None)),
            pending_close_reason: Arc::new(Mutex::new(None)),
        };
        client.initialize().await?;
        Ok(client)
    }

    /// Connect to a remote MCP server via HTTP/SSE.
    pub async fn connect_sse(
        server_name: &str,
        sse_url: &str,
        headers: HashMap<String, String>,
    ) -> Result<Self, String> {
        let sse_transport = McpSseTransport::connect(sse_url, headers).await?;

        // Bridge the transport's unexpected-close signal into the client-level
        // slots so the manager's watch listener works uniformly across
        // transports (v2 `SseMcpClient.onUnexpectedClose`).
        let unexpected_close: UnexpectedCloseListener =
            Arc::new(Mutex::new(None));
        let pending_close_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let client_unexpected = unexpected_close.clone();
        let client_pending = pending_close_reason.clone();
        sse_transport
            .on_unexpected_close(Box::new(move |reason| {
                let client_unexpected = client_unexpected.clone();
                let client_pending = client_pending.clone();
                tokio::spawn(async move {
                    fire_or_buffer_unexpected_close(
                        &client_unexpected,
                        &client_pending,
                        reason,
                    )
                    .await;
                });
            }))
            .await;

        let client = Self {
            server_name: server_name.to_string(),
            transport: McpTransport::Sse(sse_transport),
            next_id: AtomicU64::new(1),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_timeout: None,
            unexpected_close,
            pending_close_reason,
        };

        // Handshake
        client.initialize().await?;

        Ok(client)
    }

    /// Spawn an external MCP server via stdio. `cwd` overrides the child's
    /// working directory (v2 `McpServerStdioConfig.cwd`).
    pub async fn spawn_stdio(
        server_name: &str,
        command: &str,
        args: &[&str],
        env: &HashMap<String, String>,
        cwd: Option<&str>,
    ) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Capture stderr into a bounded tail so startup failures can report
            // the child's diagnostics (v2 `stderrSnapshot`,
            // client-stdio.ts:STDERR_BUFFER_CAPACITY).
            .stderr(Stdio::piped())
            // A startup timeout or a dropped client must not leave the child
            // process running (v2 closes the client on both paths).
            .kill_on_drop(true);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server '{command}': {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture MCP child stdin".to_string())?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture MCP child stdout".to_string())?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture MCP child stderr".to_string())?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let stream_pending = pending.clone();
        let closed_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let client_flag = closed_flag.clone();

        // Unexpected-close callback slots, shared with the stdout task below
        // (v2 `unexpectedCloseListener` / `pendingUnexpectedClose`).
        let unexpected_close: UnexpectedCloseListener =
            Arc::new(Mutex::new(None));
        let pending_close_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Drain the child's stderr into a bounded tail (v2 `BoundedTail`).
        let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let stderr_sink = stderr_buf.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = stderr;
            let mut chunk = [0u8; 1024];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut buf = stderr_sink.lock().await;
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > STDERR_BUFFER_CAPACITY {
                            let excess = buf.len() - STDERR_BUFFER_CAPACITY;
                            buf.drain(..excess);
                        }
                    }
                }
            }
        });

        let close_listener = unexpected_close.clone();
        let close_pending = pending_close_reason.clone();
        let stderr_for_reason = stderr_buf.clone();
        let name_for_reason = server_name.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
                    && let Some(id) = parsed.get("id").and_then(|v| v.as_u64())
                {
                    let mut lock = stream_pending.lock().await;
                    if let Some(tx) = lock.remove(&id) {
                        let _ = tx.send(parsed);
                    }
                }
            }
            // Stdout closed — the server process is gone. Mark the client
            // closed so status views stop advertising it as connected, then
            // drain and drop all pending oneshot senders immediately.
            closed_flag.store(true, std::sync::atomic::Ordering::SeqCst);
            // Fire or buffer the unexpected-close reason (v2 `onclose` hook,
            // client-stdio.ts:175-190): the manager's watch listener marks the
            // entry failed, or the reason is replayed when it registers.
            let stderr_tail = {
                let buf = stderr_for_reason.lock().await;
                String::from_utf8_lossy(&buf).into_owned()
            };
            let mut parts = vec![format!("MCP server \"{name_for_reason}\" closed unexpectedly")];
            if !stderr_tail.trim().is_empty() {
                parts.push(format!("stderr: {}", stderr_tail.trim_end()));
            }
            let reason = parts.join("\n");
            fire_or_buffer_unexpected_close(&close_listener, &close_pending, reason).await;
            let mut lock = stream_pending.lock().await;
            lock.clear();
        });

        let client = Self {
            server_name: server_name.to_string(),
            closed: client_flag,
            transport: McpTransport::Stdio {
                _process: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(stdin)),
                pending,
                stderr: stderr_buf,
            },
            next_id: AtomicU64::new(1),
            tool_timeout: None,
            unexpected_close,
            pending_close_reason,
        };

        // Initialize handshake. On failure, capture the child's stderr so the
        // error carries its diagnostics before the client (and its buffer) is
        // dropped (v2 `formatStartupError`, connection-manager.ts:545-574).
        if let Err(e) = client.initialize().await {
            let tail = client.stderr_snapshot();
            if tail.is_empty() {
                return Err(e);
            }
            return Err(format!("{e}\nstderr: {}", tail.trim_end()));
        }

        Ok(client)
    }

    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    /// Whether the server connection has died (stdio stdout EOF). Status
    /// views use this to stop advertising the entry as connected.
    pub fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Register a listener that fires when the transport closes on its own —
    /// i.e. the caller has not invoked `close()` (v2 `onUnexpectedClose`,
    /// client-stdio.ts:120-132). At most one listener; later registrations
    /// replace earlier ones. If the transport already closed, the buffered
    /// reason is replayed synchronously so the close is never dropped.
    pub async fn on_unexpected_close(&self, listener: Box<dyn Fn(String) + Send + Sync>) {
        let pending = self.pending_close_reason.lock().await.take();
        if let Some(reason) = pending {
            listener(reason);
            return;
        }
        *self.unexpected_close.lock().await = Some(listener);
    }

    /// The captured tail of the child's stderr (v2 `stderrSnapshot`,
    /// client-stdio.ts). Empty for non-stdio transports. Non-blocking: the
    /// drain task may hold the buffer mid-write, and `blocking_lock` would
    /// panic inside a tokio runtime.
    pub fn stderr_snapshot(&self) -> String {
        if let McpTransport::Stdio { stderr, .. } = &self.transport {
            match stderr.try_lock() {
                Ok(buf) => String::from_utf8_lossy(&buf).into_owned(),
                Err(_) => String::new(),
            }
        } else {
            String::new()
        }
    }

    /// The resolved per-request timeout (`toolTimeoutMs`), for tests.
    #[cfg(test)]
    pub fn tool_timeout(&self) -> Option<Duration> {
        self.tool_timeout
    }

    /// Close the client: kill the stdio child process. Dropping the client
    /// would achieve the same eventually; an explicit close makes reconnect
    /// bookkeeping deterministic.
    pub async fn close(&self) {
        if let McpTransport::Stdio { _process, .. } = &self.transport {
            let mut child = _process.lock().await;
            let _ = child.kill().await;
        }
        self.closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn transport_type(&self) -> &'static str {
        match &self.transport {
            McpTransport::Stdio { .. } => "stdio",
            McpTransport::Sse(_) => "sse",
            McpTransport::Http(_) => "http",
            McpTransport::Mock { .. } => "mock",
        }
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        match &self.transport {
            McpTransport::Mock { .. } => Ok(serde_json::json!({})),
            McpTransport::Sse(sse) => sse.send_request(method, params).await,
            McpTransport::Http(http) => http.send_request(method, params).await,
            McpTransport::Stdio { stdin, pending, .. } => {
                let id = self.next_id.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = oneshot::channel();
                {
                    let mut pend = pending.lock().await;
                    pend.insert(id, tx);
                }

                let req = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                });

                let line = req.to_string();

                let mut stdin_lock = stdin.lock().await;
                stdin_lock
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write to MCP stdin: {e}"))?;
                stdin_lock
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush MCP stdin: {e}"))?;
                drop(stdin_lock);

                let wait = self.tool_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT);
                match tokio::time::timeout(wait, rx).await {
                    Ok(Ok(val)) => {
                        if let Some(err) = val.get("error") {
                            return Err(format!("MCP error: {err}"));
                        }
                        Ok(val.get("result").cloned().unwrap_or(Value::Null))
                    }
                    Ok(Err(_)) => Err("MCP child closed stdout prematurely".into()),
                    Err(_) => {
                        let mut pend = pending.lock().await;
                        pend.remove(&id);
                        Err(format!(
                            "MCP request timed out after {}ms",
                            wait.as_millis()
                        ))
                    }
                }
            }
        }
    }

    /// Perform MCP `initialize` handshake.
    pub async fn initialize(&self) -> Result<(), String> {
        // Streamable HTTP only exists from 2025-03-26 on; the legacy stdio and
        // HTTP+SSE transports keep advertising 2024-11-05.
        let protocol_version = match &self.transport {
            McpTransport::Http(_) => crate::mcp::http::STREAMABLE_HTTP_PROTOCOL_VERSION,
            _ => "2024-11-05",
        };
        let params = serde_json::json!({
            "protocolVersion": protocol_version,
            "capabilities": {
                "tools": {}
            },
            "clientInfo": {
                "name": "kimi-agent-native",
                "version": "0.1.0"
            }
        });

        self.send_request("initialize", params).await?;
        Ok(())
    }

    /// List available tools exposed by the MCP server (`tools/list`).
    pub async fn list_tools(&self) -> Result<Vec<McpTool>, String> {
        if let McpTransport::Mock { tools } = &self.transport {
            return Ok(tools.clone());
        }

        let res = self
            .send_request("tools/list", serde_json::json!({}))
            .await?;
        let tools_val = res
            .get("tools")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        serde_json::from_value(tools_val).map_err(|e| format!("Failed to parse tools list: {e}"))
    }

    /// Call an MCP tool (`tools/call`).
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: &Value,
    ) -> Result<McpToolCallResult, String> {
        if matches!(self.transport, McpTransport::Mock { .. }) {
            return Ok(McpToolCallResult {
                content: vec![McpContent {
                    content_type: "text".into(),
                    text: Some(format!("Mock execution of {name} with {arguments}")),
                    ..Default::default()
                }],
                is_error: false,
            });
        }

        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });

        let res = self.send_request("tools/call", params).await?;
        serde_json::from_value(res).map_err(|e| format!("Failed to parse tool call result: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sse::test_helpers::spawn_mock_mcp_sse_server;
    use serde_json::json;

    #[tokio::test]
    async fn test_mock_mcp_client() {
        let client = McpClient::mock("github");
        assert_eq!(client.server_name(), "github");
        assert_eq!(client.transport_type(), "mock");

        let tools = client.list_tools().await.expect("list_tools failed");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "github_sample_tool");
        assert_eq!(tools[0].description.as_deref(), Some("Sample mock MCP tool"));
        assert_eq!(
            tools[0].input_schema,
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                }
            })
        );

        let call_res = client
            .call_tool(
                "github_sample_tool",
                &json!({ "query": "rust" }),
            )
            .await
            .expect("call_tool failed");
        assert!(!call_res.is_error);
        assert_eq!(call_res.content.len(), 1);
        assert_eq!(call_res.content[0].content_type, "text");
        assert_eq!(
            call_res.content[0].text.as_deref(),
            Some("Mock execution of github_sample_tool with {\"query\":\"rust\"}")
        );
    }

    #[tokio::test]
    async fn test_sse_mcp_client_handshake_tools_and_call() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;

        let client = McpClient::connect_sse("remote-server", &sse_url, HashMap::new())
            .await
            .expect("connect_sse failed");

        assert_eq!(client.server_name(), "remote-server");
        assert_eq!(client.transport_type(), "sse");

        // 1. Discover tools over real SSE transport
        let tools = client.list_tools().await.expect("list_tools failed");
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0].name, "calculate");
        assert_eq!(tools[0].description.as_deref(), Some("Perform calculation"));
        assert_eq!(tools[0].input_schema["type"], "object");
        assert_eq!(tools[0].input_schema["required"][0], "expression");

        assert_eq!(tools[1].name, "echo");
        assert_eq!(tools[1].description.as_deref(), Some("Echo input message"));

        assert_eq!(tools[2].name, "trigger_tool_error");

        // 2. Call tool successfully
        let call_res = client
            .call_tool("calculate", &json!({ "expression": "21*2" }))
            .await
            .expect("call_tool failed");
        assert!(!call_res.is_error);
        assert_eq!(call_res.content.len(), 1);
        assert_eq!(call_res.content[0].text.as_deref(), Some("result: 42"));

        // 3. Call tool that signals application-level error
        let err_call_res = client
            .call_tool("trigger_tool_error", &json!({}))
            .await
            .expect("call_tool failed");
        assert!(err_call_res.is_error);
        assert_eq!(err_call_res.content[0].text.as_deref(), Some("custom tool failure"));

        // 4. Call unknown tool triggering protocol-level JSON-RPC error
        let rpc_err = client
            .call_tool("nonexistent_tool", &json!({}))
            .await
            .expect_err("expected JSON-RPC error");
        assert_eq!(
            rpc_err,
            "MCP Server Error: {\"code\":-32601,\"message\":\"Tool 'nonexistent_tool' not found\"}"
        );
    }

    #[tokio::test]
    async fn test_stdio_spawn_nonexistent_command() {
        let res = McpClient::spawn_stdio(
            "test_missing",
            "definitely_nonexistent_command_9999",
            &[],
            &HashMap::new(),
            None,
        )
        .await;

        assert!(res.is_err());
        let err = res.err().unwrap();
        assert!(
            err.contains("Failed to spawn MCP server 'definitely_nonexistent_command_9999'"),
            "unexpected error message: {err}"
        );
    }

    #[tokio::test]
    async fn test_stdio_spawn_premature_exit() {
        let (cmd, args) = if cfg!(windows) {
            ("cmd", vec!["/c", "exit 0"])
        } else {
            ("sh", vec!["-c", "exit 0"])
        };

        let res = McpClient::spawn_stdio("exit_early", cmd, &args, &HashMap::new(), None).await;
        assert!(res.is_err());
        assert_eq!(res.err().unwrap(), "MCP child closed stdout prematurely");
    }

    #[tokio::test]
    async fn test_stdio_spawn_invalid_json_premature_exit() {
        let (cmd, args) = if cfg!(windows) {
            ("cmd", vec!["/c", "echo invalid_raw_line && exit 0"])
        } else {
            ("sh", vec!["-c", "echo 'invalid_raw_line'; exit 0"])
        };

        let res = McpClient::spawn_stdio("junk_stdout", cmd, &args, &HashMap::new(), None).await;
        assert!(res.is_err());
        assert_eq!(res.err().unwrap(), "MCP child closed stdout prematurely");
    }

    /// A tool call that never gets a reply must fail with the resolved
    /// `toolTimeoutMs` instead of waiting for the 60s built-in. The child
    /// answers `initialize` and then stays alive without answering anything
    /// else.
    #[tokio::test]
    async fn test_tool_timeout_fails_the_call() {        let reply = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let dir = std::env::temp_dir();
        let (cmd, args, script) = if cfg!(windows) {
            let path = dir.join(format!("kimi_mcp_slow_{}.bat", std::process::id()));
            std::fs::write(
                &path,
                format!("@echo {reply}\r\n@ping -n 3 127.0.0.1 >nul\r\n"),
            )
            .expect("write slow server script");
            (
                "cmd",
                vec!["/c".to_string(), path.to_string_lossy().into_owned()],
                path,
            )
        } else {
            let path = dir.join(format!("kimi_mcp_slow_{}.sh", std::process::id()));
            std::fs::write(&path, format!("echo '{reply}'\nsleep 3\n"))
                .expect("write slow server script");
            ("sh", vec![path.to_string_lossy().into_owned()], path)
        };
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

        let mut client = McpClient::spawn_stdio("slow", cmd, &arg_refs, &HashMap::new(), None)
            .await
            .expect("initialize handshake should succeed");
        client.set_tool_timeout(Some(Duration::from_millis(150)));

        let err = client
            .call_tool("anything", &json!({}))
            .await
            .expect_err("tool call must time out");
        assert_eq!(err, "MCP request timed out after 150ms");

        let _ = std::fs::remove_file(script);
    }

    /// A child that answers the handshake and then exits must fire the
    /// unexpected-close listener (v2 `onUnexpectedClose`,
    /// client-stdio.ts:120-132). The reason carries the server name and any
    /// captured stderr.
    #[tokio::test]
    async fn test_on_unexpected_close_fires_when_child_exits() {
        let reply = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let dir = std::env::temp_dir();
        let (cmd, args, script) = if cfg!(windows) {
            let path = dir.join(format!("kimi_mcp_die_{}.bat", std::process::id()));
            std::fs::write(&path, format!("@echo {reply}\r\n@exit /b 0\r\n"))
                .expect("write die script");
            (
                "cmd",
                vec!["/c".to_string(), path.to_string_lossy().into_owned()],
                path,
            )
        } else {
            let path = dir.join(format!("kimi_mcp_die_{}.sh", std::process::id()));
            std::fs::write(&path, format!("echo '{reply}'\nexit 0\n")).expect("write die script");
            ("sh", vec![path.to_string_lossy().into_owned()], path)
        };
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

        let client = McpClient::spawn_stdio(
            "die_after_handshake",
            cmd,
            &arg_refs,
            &HashMap::new(),
            None,
        )
        .await
        .expect("initialize handshake should succeed");

        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));
        client
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

        let _ = std::fs::remove_file(script);
    }

    /// A `cwd` is applied to the child, so a script resolved by name from that
    /// directory starts (v2 `McpServerStdioConfig.cwd`).
    #[tokio::test]
    async fn test_stdio_cwd_is_applied() {
        let dir = std::env::temp_dir().join(format!("kimi_mcp_cwd_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let reply = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let (cmd, args, script) = if cfg!(windows) {
            let script = dir.join("probe.bat");
            std::fs::write(&script, format!("@echo {reply}\r\n@ping -n 3 127.0.0.1 >nul\r\n"))
                .expect("write probe script");
            (
                "cmd",
                vec!["/c".to_string(), "probe.bat".to_string()],
                script,
            )
        } else {
            let script = dir.join("probe.sh");
            std::fs::write(&script, format!("echo '{reply}'\nsleep 3\n"))
                .expect("write probe script");
            ("sh", vec!["probe.sh".to_string()], script)
        };
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

        let client = McpClient::spawn_stdio(
            "cwd-srv",
            cmd,
            &arg_refs,
            &HashMap::new(),
            Some(dir.to_string_lossy().as_ref()),
        )
        .await
        .expect("a script resolved from the configured cwd must start");
        assert_eq!(client.transport_type(), "stdio");

        let _ = std::fs::remove_file(script);
        let _ = std::fs::remove_dir(dir);
    }
}
