//! Dynamic MCP server manager and tool registry.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::mcp::client::McpClient;
use crate::mcp::types::McpTool;
use crate::turn_loop::types::ExecutableToolResult;

pub struct McpManager {
    clients: Arc<RwLock<HashMap<String, Arc<McpClient>>>>,
    cached_tools: Arc<RwLock<HashMap<String, (String, McpTool)>>>,
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            cached_tools: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register an initialized MCP client.
    pub async fn add_client(&self, client: McpClient) {
        let name = client.server_name().to_string();
        let client_arc = Arc::new(client);

        if let Ok(tools) = client_arc.list_tools().await {
            let mut cached = self.cached_tools.write().await;
            for t in tools {
                let qualified_name = format!("mcp__{}__{}", name, t.name);
                cached.insert(qualified_name.clone(), (name.clone(), t.clone()));
                // Also index by plain tool name if not conflicting
                cached.insert(t.name.clone(), (name.clone(), t));
            }
        }

        let mut clients = self.clients.write().await;
        clients.insert(name, client_arc);
    }

    /// Check if a tool name belongs to any registered MCP server.
    pub async fn handles(&self, tool_name: &str) -> bool {
        let cached = self.cached_tools.read().await;
        cached.contains_key(tool_name)
    }

    /// Call an MCP tool dynamically.
    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: &Value,
    ) -> Option<ExecutableToolResult> {
        let (server_name, mcp_tool) = {
            let cached = self.cached_tools.read().await;
            cached.get(tool_name).cloned()?
        };

        let client = {
            let clients = self.clients.read().await;
            clients.get(&server_name)?.clone()
        };

        match client.call_tool(&mcp_tool.name, arguments).await {
            Ok(res) => {
                let mut text_parts = Vec::new();
                for c in res.content {
                    if let Some(t) = c.text {
                        text_parts.push(t);
                    }
                }
                Some(ExecutableToolResult {
                    content: text_parts.join("\n"),
                    is_error: res.is_error,
                    note: Some(format!("mcp:{}", server_name)),
                })
            }
            Err(e) => Some(ExecutableToolResult {
                content: format!("MCP execution error: {e}"),
                is_error: true,
                note: Some(format!("mcp:{}", server_name)),
            }),
        }
    }

    /// Automatically connect/spawn MCP servers defined in configuration.
    pub async fn spawn_from_config(
        &self,
        servers: &HashMap<String, crate::config::McpServerConfig>,
    ) {
        for (name, conf) in servers {
            if let Some(url) = &conf.url {
                if let Ok(client) = McpClient::connect_sse(name, url, HashMap::new()).await {
                    self.add_client(client).await;
                }
            } else if let Some(cmd) = &conf.command {
                let args_vec: Vec<&str> = conf
                    .args
                    .as_ref()
                    .map(|a| a.iter().map(|s| s.as_str()).collect())
                    .unwrap_or_default();
                let env_map = conf.env.clone().unwrap_or_default();
                if let Ok(client) = McpClient::spawn_stdio(name, cmd, &args_vec, &env_map).await {
                    self.add_client(client).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_mcp_manager_discovery_and_call() {
        let manager = McpManager::new();
        let client = McpClient::mock("github");
        manager.add_client(client).await;

        assert!(manager.handles("github_sample_tool").await);
        assert!(manager.handles("mcp__github__github_sample_tool").await);

        let res = manager
            .call_tool(
                "github_sample_tool",
                &serde_json::json!({ "query": "kimi" }),
            )
            .await
            .unwrap();

        assert!(!res.is_error);
        assert!(res.content.contains("Mock execution"));
        assert_eq!(res.note.as_deref(), Some("mcp:github"));
    }
}
