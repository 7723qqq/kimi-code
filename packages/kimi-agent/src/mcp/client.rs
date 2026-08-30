//! MCP client implementation supporting stdio and HTTP/SSE transports.

use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::mcp::sse::McpSseTransport;
use crate::mcp::types::*;

enum McpTransport {
    Stdio {
        _process: Arc<Mutex<Child>>,
        stdin: Arc<Mutex<tokio::process::ChildStdin>>,
        stdout: Arc<Mutex<tokio::io::Lines<BufReader<tokio::process::ChildStdout>>>>,
    },
    Sse(McpSseTransport),
    Mock,
}

pub struct McpClient {
    server_name: String,
    transport: McpTransport,
    next_id: AtomicU64,
}

impl McpClient {
    /// Create a mock MCP client for testing without spawning subprocesses.
    pub fn mock(server_name: &str) -> Self {
        Self {
            server_name: server_name.to_string(),
            transport: McpTransport::Mock,
            next_id: AtomicU64::new(1),
        }
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
        };

        // Handshake
        client.initialize().await?;

        Ok(client)
    }

    /// Spawn an external MCP server via stdio.
    pub async fn spawn_stdio(
        server_name: &str,
        command: &str,
        args: &[&str],
        env: &HashMap<String, String>,
    ) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

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

        let stdout_lines = BufReader::new(stdout).lines();

        let client = Self {
            server_name: server_name.to_string(),
            transport: McpTransport::Stdio {
                _process: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(stdin)),
                stdout: Arc::new(Mutex::new(stdout_lines)),
            },
            next_id: AtomicU64::new(1),
        };

        // Initialize handshake
        client.initialize().await?;

        Ok(client)
    }

    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        match &self.transport {
            McpTransport::Mock => Ok(serde_json::json!({})),
            McpTransport::Sse(sse) => sse.send_request(method, params).await,
            McpTransport::Stdio { stdin, stdout, .. } => {
                let id = self.next_id.fetch_add(1, Ordering::SeqCst);
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

                let mut stdout_lock = stdout.lock().await;
                match stdout_lock.next_line().await {
                    Ok(Some(resp_line)) => {
                        let parsed: Value = serde_json::from_str(&resp_line)
                            .map_err(|e| format!("Invalid JSON response from MCP: {e}"))?;

                        if let Some(err) = parsed.get("error") {
                            return Err(format!("MCP error: {err}"));
                        }

                        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
                    }
                    Ok(None) => Err("MCP server closed stdout unexpectedly".into()),
                    Err(e) => Err(format!("Error reading MCP response: {e}")),
                }
            }
        }
    }

    /// Perform MCP `initialize` handshake.
    pub async fn initialize(&self) -> Result<(), String> {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
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

    #[tokio::test]
    async fn test_mock_mcp_client() {
        let client = McpClient::mock("github");
        assert_eq!(client.server_name(), "github");

        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "github_sample_tool");

        let call_res = client
            .call_tool(
                "github_sample_tool",
                &serde_json::json!({ "query": "rust" }),
            )
            .await
            .unwrap();
        assert!(!call_res.is_error);
        assert_eq!(call_res.content.len(), 1);
        assert!(
            call_res.content[0]
                .text
                .as_deref()
                .unwrap()
                .contains("Mock execution")
        );
    }
}
