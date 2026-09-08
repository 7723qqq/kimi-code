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
    },
    Sse(McpSseTransport),
    Http(McpHttpTransport),
    Mock,
}

pub struct McpClient {
    server_name: String,
    transport: McpTransport,
    next_id: AtomicU64,
    closed: Arc<std::sync::atomic::AtomicBool>,
    /// Per-request timeout resolved from `toolTimeoutMs` (v2
    /// `toolCallTimeoutMs`); `None` keeps the transport built-in.
    tool_timeout: Option<Duration>,
}

/// Built-in request timeout when no `toolTimeoutMs` is configured.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

impl McpClient {
    /// Create a mock MCP client for testing without spawning subprocesses.
    pub fn mock(server_name: &str) -> Self {
        Self {
            server_name: server_name.to_string(),
            transport: McpTransport::Mock,
            next_id: AtomicU64::new(1),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_timeout: None,
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

        let client = Self {
            server_name: server_name.to_string(),
            transport: McpTransport::Sse(sse_transport),
            next_id: AtomicU64::new(1),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_timeout: None,
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
            .stderr(Stdio::inherit())
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

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let stream_pending = pending.clone();
        let closed_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let client_flag = closed_flag.clone();

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
            },
            next_id: AtomicU64::new(1),
            tool_timeout: None,
        };

        // Initialize handshake
        client.initialize().await?;

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
            McpTransport::Mock => "mock",
        }
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        match &self.transport {
            McpTransport::Mock => Ok(serde_json::json!({})),
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
        if matches!(self.transport, McpTransport::Mock) {
            return Ok(vec![McpTool {
                name: format!("{}_sample_tool", self.server_name),
                description: Some("Sample mock MCP tool".into()),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    }
                }),
            }]);
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
        if matches!(self.transport, McpTransport::Mock) {
            return Ok(McpToolCallResult {
                content: vec![McpContent {
                    content_type: "text".into(),
                    text: Some(format!("Mock execution of {name} with {arguments}")),
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
    async fn test_tool_timeout_fails_the_call() {
        let reply = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
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
