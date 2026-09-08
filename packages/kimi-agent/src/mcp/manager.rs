//! Dynamic MCP server manager and tool registry.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::mcp::client::McpClient;
use crate::mcp::types::McpTool;
use crate::turn_loop::types::ExecutableToolResult;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpToolSummary {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpServerEntry {
    pub name: String,
    pub transport: String,
    pub status: String,
    pub tool_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub tools: Vec<McpToolSummary>,
}

/// The spawn recipe for a configured server, kept so `reconnect` can
/// re-derive the client (the TS connection-manager keeps `entry.config` for
/// the same reason, connection-manager.ts:33-41).
#[derive(Debug, Clone)]
pub enum McpServerRecipe {
    Sse {
        url: String,
        headers: HashMap<String, String>,
    },
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
}

struct ServerState {
    recipe: McpServerRecipe,
    /// "connected" | "failed" | "pending" (v2 `McpServerStatus` subset).
    status: String,
    error: Option<String>,
}

pub struct McpManager {
    clients: Arc<RwLock<HashMap<String, Arc<McpClient>>>>,
    cached_tools: Arc<RwLock<HashMap<String, (String, McpTool)>>>,
    servers: Arc<RwLock<HashMap<String, ServerState>>>,
    /// In-flight reconnects (v2 `inFlightReconnects`): late callers join the
    /// running one via its Notify instead of double-spawning.
    in_flight: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
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
            servers: Arc::new(RwLock::new(HashMap::new())),
            in_flight: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
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

    /// All discovered MCP tools as engine tool definitions (for the model).
    pub async fn list_tool_infos(&self) -> Vec<crate::turn_loop::types::ToolInfo> {
        let cached = self.cached_tools.read().await;
        let mut seen = std::collections::HashSet::new();
        let mut infos = Vec::new();
        for (name, (_, tool)) in cached.iter() {
            // Prefer the namespaced `mcp__<server>__<tool>` form; skip the
            // plain-name alias when it duplicates a namespaced entry.
            if !name.starts_with("mcp__") || !seen.insert(name.clone()) {
                continue;
            }
            infos.push(crate::turn_loop::types::ToolInfo {
                name: name.clone(),
                description: tool.description.clone().unwrap_or_default(),
                input_schema: tool.input_schema.clone(),
            });
        }
        infos
    }

    /// Return the list of connected MCP servers, their transport types and discovered tools.
    pub async fn server_entries(&self) -> Vec<McpServerEntry> {
        let clients = self.clients.read().await;
        let cached = self.cached_tools.read().await;

        let mut entries = Vec::new();
        for (name, client) in clients.iter() {
            let mut tools = Vec::new();
            for (qual_name, (srv, tool)) in cached.iter() {
                if srv == name && qual_name.starts_with("mcp__") {
                    tools.push(McpToolSummary {
                        name: tool.name.clone(),
                        description: tool.description.clone().unwrap_or_default(),
                    });
                }
            }
            tools.sort_by(|a, b| a.name.cmp(&b.name));
            let tool_count = tools.len();
            // A client whose process died mid-session must not advertise
            // itself as connected (v2 watchForUnexpectedClose marks the
            // entry failed and drops its tools, connection-manager.ts:360-378).
            let (status, error) = if client.is_closed() {
                ("failed".to_string(), Some("server closed unexpectedly".to_string()))
            } else {
                ("connected".to_string(), None)
            };
            entries.push(McpServerEntry {
                name: name.clone(),
                transport: client.transport_type().to_string(),
                status,
                tool_count,
                error,
                tools,
            });
        }
        // Failed-to-spawn servers have no client but must still surface —
        // they carry their recipe and the spawn error.
        let clients = self.clients.read().await;
        let servers = self.servers.read().await;
        for (name, state) in servers.iter() {
            if clients.contains_key(name) {
                continue;
            }
            entries.push(McpServerEntry {
                name: name.clone(),
                transport: match &state.recipe {
                    McpServerRecipe::Sse { .. } => "sse".into(),
                    McpServerRecipe::Stdio { .. } => "stdio".into(),
                },
                status: state.status.clone(),
                tool_count: 0,
                error: state.error.clone(),
                tools: Vec::new(),
            });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        entries
    }

    /// Remove a registered or connected MCP server.
    pub async fn remove_server(&self, name: &str) -> bool {
        let mut servers = self.servers.write().await;
        let mut clients = self.clients.write().await;
        let mut cached = self.cached_tools.write().await;

        let removed_server = servers.remove(name).is_some();
        let removed_client = if let Some(client) = clients.remove(name) {
            client.close().await;
            true
        } else {
            false
        };
        cached.retain(|_, (s, _)| s != name);
        removed_server || removed_client
    }

    /// Inspect tools provided by a specific MCP server.
    pub async fn inspect_server(&self, name: &str) -> Option<Vec<Value>> {
        let clients = self.clients.read().await;
        let client = clients.get(name)?;
        if let Ok(tools) = client.list_tools().await {
            Some(tools.into_iter().map(|t| serde_json::json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
            })).collect())
        } else {
            Some(Vec::new())
        }
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
                    stop_turn: false,
                    content: text_parts.join("\n"),
                    is_error: res.is_error,
                    note: Some(format!("mcp:{}", server_name)),
                })
            }
            Err(e) => Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("MCP execution error: {e}"),
                is_error: true,
                note: Some(format!("mcp:{}", server_name)),
            }),
        }
    }

    /// Automatically connect/spawn MCP servers defined in configuration.
    /// Servers that fail to spawn are remembered with a `failed` status and
    /// their error so `/mcp` views stay truthful (v2 marks failed entries,
    /// connection-manager.ts:366-372).
    pub async fn spawn_from_config(
        &self,
        servers: &HashMap<String, crate::config::McpServerConfig>,
    ) {
        for (name, conf) in servers {
            let recipe = if let Some(url) = &conf.url {
                McpServerRecipe::Sse {
                    url: url.clone(),
                    headers: conf.headers.clone().unwrap_or_default(),
                }
            } else if let Some(cmd) = &conf.command {
                McpServerRecipe::Stdio {
                    command: cmd.clone(),
                    args: conf.args.clone().unwrap_or_default(),
                    env: conf.env.clone().unwrap_or_default(),
                }
            } else {
                continue;
            };
            self.servers.write().await.insert(
                name.clone(),
                ServerState {
                    recipe,
                    status: "pending".into(),
                    error: None,
                },
            );
            if let Err(e) = self.connect_one(name).await {
                let mut state = self.servers.write().await;
                if let Some(state) = state.get_mut(name) {
                    state.status = "failed".into();
                    state.error = Some(e);
                }
            }
        }
    }

    /// Connect one configured server, marking the outcome on its entry.
    async fn connect_one(&self, name: &str) -> Result<(), String> {
        let recipe = {
            let servers = self.servers.read().await;
            let Some(state) = servers.get(name) else {
                return Err(format!("MCP server '{name}' is not configured"));
            };
            state.recipe.clone()
        };
        let client = match &recipe {
            McpServerRecipe::Sse { url, headers } => {
                McpClient::connect_sse(name, url, headers.clone()).await?
            }
            McpServerRecipe::Stdio { command, args, env } => {
                McpClient::spawn_stdio(
                    name,
                    command,
                    &args.iter().map(String::as_str).collect::<Vec<_>>(),
                    env,
                )
                .await?
            }
        };
        self.add_client(client).await;
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = "connected".into();
            state.error = None;
        }
        Ok(())
    }

    /// Reconnect a configured server on demand (v2 `reconnect`,
    /// connection-manager.ts:146-164): close the live client, drop its
    /// cached tools, re-derive from the stored recipe, and mark the entry
    /// pending while connecting. Concurrent reconnects for the same server
    /// join the in-flight one (v2 `inFlightReconnects`).
    pub async fn reconnect(&self, name: &str) -> Result<(), String> {
        let _notify = {
            let mut in_flight = self.in_flight.lock().await;
            if let Some(existing) = in_flight.get(name) {
                let notify = existing.clone();
                drop(in_flight);
                notify.notified().await;
                return Ok(());
            }
            let notify = Arc::new(tokio::sync::Notify::new());
            in_flight.insert(name.to_string(), notify.clone());
            notify
        };
        let result = self.reconnect_inner(name).await;
        let in_flight = self.in_flight.lock().await;
        if let Some(notify) = in_flight.get(name) {
            notify.notify_waiters();
        }
        drop(in_flight);
        result
    }

    async fn reconnect_inner(&self, name: &str) -> Result<(), String> {
        let Some(_recipe) = self.servers.read().await.get(name).map(|s| s.recipe.clone()) else {
            return Err(format!("MCP server '{name}' is not configured"));
        };
        // Close the live client (dropping it kills the stdio child) and
        // clear its cached tools, mirroring the v2 close-then-pending order.
        if let Some(dead) = self.clients.write().await.remove(name) {
            dead.close().await;
        }
        let mut cached = self.cached_tools.write().await;
        cached.retain(|_, (srv, _)| srv != name);
        drop(cached);
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = "pending".into();
            state.error = None;
        }
        match self.connect_one(name).await {
            Ok(()) => Ok(()),
            Err(e) => {
                if let Some(state) = self.servers.write().await.get_mut(name) {
                    state.status = "failed".into();
                    state.error = Some(e.clone());
                }
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sse::test_helpers::spawn_mock_mcp_sse_server;
    use serde_json::json;

    #[tokio::test]
    async fn test_mcp_manager_discovery_and_call() {
        let manager = McpManager::new();
        let client = McpClient::mock("github");
        manager.add_client(client).await;

        // Verify discovery both by plain alias and qualified name
        assert!(manager.handles("github_sample_tool").await);
        assert!(manager.handles("mcp__github__github_sample_tool").await);
        assert!(!manager.handles("nonexistent_tool").await);

        // 1. Call via plain alias
        let res_plain = manager
            .call_tool(
                "github_sample_tool",
                &json!({ "query": "kimi" }),
            )
            .await
            .expect("call_tool via plain alias failed");

        assert!(!res_plain.is_error);
        assert_eq!(
            res_plain.content,
            "Mock execution of github_sample_tool with {\"query\":\"kimi\"}"
        );
        assert_eq!(res_plain.note.as_deref(), Some("mcp:github"));

        // 2. Call via namespaced name
        let res_namespaced = manager
            .call_tool(
                "mcp__github__github_sample_tool",
                &json!({ "query": "kimi_namespaced" }),
            )
            .await
            .expect("call_tool via qualified name failed");

        assert!(!res_namespaced.is_error);
        assert_eq!(
            res_namespaced.content,
            "Mock execution of github_sample_tool with {\"query\":\"kimi_namespaced\"}"
        );
        assert_eq!(res_namespaced.note.as_deref(), Some("mcp:github"));

        // 3. Call unknown tool returns None
        let res_missing = manager
            .call_tool("unknown_tool", &json!({}))
            .await;
        assert!(res_missing.is_none());
    }

    #[tokio::test]
    async fn test_mcp_manager_list_tool_infos() {
        let manager = McpManager::new();
        let client_a = McpClient::mock("github");
        let client_b = McpClient::mock("slack");
        manager.add_client(client_a).await;
        manager.add_client(client_b).await;

        let mut infos = manager.list_tool_infos().await;
        infos.sort_by(|a, b| a.name.cmp(&b.name));

        // Only the namespaced form is exposed to the model, aliases are not leaked
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].name, "mcp__github__github_sample_tool");
        assert_eq!(infos[0].description, "Sample mock MCP tool");
        assert_eq!(
            infos[0].input_schema,
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                }
            })
        );

        assert_eq!(infos[1].name, "mcp__slack__slack_sample_tool");
        assert_eq!(infos[1].description, "Sample mock MCP tool");
    }

    #[tokio::test]
    async fn test_mcp_manager_server_entries() {
        let manager = McpManager::new();
        // Add in reverse alphabetical order to verify alphabetical sorting
        manager.add_client(McpClient::mock("zeta")).await;
        manager.add_client(McpClient::mock("alpha")).await;

        let entries = manager.server_entries().await;
        assert_eq!(entries.len(), 2);

        // Verify sorted by server name
        assert_eq!(entries[0].name, "alpha");
        assert_eq!(entries[0].transport, "mock");
        assert_eq!(entries[0].status, "connected");
        assert_eq!(entries[0].tool_count, 1);
        assert_eq!(entries[0].error, None);
        assert_eq!(entries[0].tools.len(), 1);
        assert_eq!(entries[0].tools[0].name, "alpha_sample_tool");
        assert_eq!(entries[0].tools[0].description, "Sample mock MCP tool");

        assert_eq!(entries[1].name, "zeta");
        assert_eq!(entries[1].transport, "mock");
        assert_eq!(entries[1].status, "connected");
        assert_eq!(entries[1].tool_count, 1);
        assert_eq!(entries[1].tools[0].name, "zeta_sample_tool");
    }

    #[tokio::test]
    async fn test_mcp_manager_with_sse_client_and_call_tool() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;

        let client = McpClient::connect_sse("calc_server", &sse_url, HashMap::new())
            .await
            .expect("SSE client connect failed");

        let manager = McpManager::new();
        manager.add_client(client).await;

        // Discovered tools are indexed
        assert!(manager.handles("calculate").await);
        assert!(manager.handles("mcp__calc_server__calculate").await);
        assert!(manager.handles("echo").await);
        assert!(manager.handles("mcp__calc_server__echo").await);

        // Call tool over SSE
        let res = manager
            .call_tool("mcp__calc_server__calculate", &json!({ "expression": "10+32" }))
            .await
            .expect("tool call failed");

        assert!(!res.is_error);
        assert_eq!(res.content, "result: 42");
        assert_eq!(res.note.as_deref(), Some("mcp:calc_server"));

        // Application-level error tool call
        let err_res = manager
            .call_tool("mcp__calc_server__trigger_tool_error", &json!({}))
            .await
            .expect("tool call failed");
        assert!(err_res.is_error);
        assert_eq!(err_res.content, "custom tool failure");
        assert_eq!(err_res.note.as_deref(), Some("mcp:calc_server"));
    }

    #[tokio::test]
    async fn test_mcp_manager_spawn_from_config() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;

        let mut configs = HashMap::new();
        configs.insert(
            "valid_sse".to_string(),
            crate::config::McpServerConfig {
                command: None,
                args: None,
                env: None,
                url: Some(sse_url),
                headers: None,
            },
        );
        // Invalid/unreachable SSE endpoint
        configs.insert(
            "invalid_sse".to_string(),
            crate::config::McpServerConfig {
                command: None,
                args: None,
                env: None,
                url: Some("http://127.0.0.1:1/nonexistent_sse".into()),
                headers: None,
            },
        );
        // Invalid stdio command
        configs.insert(
            "invalid_stdio".to_string(),
            crate::config::McpServerConfig {
                command: Some("definitely_missing_binary_404".into()),
                args: None,
                env: None,
                url: None,
                headers: None,
            },
        );

        let manager = McpManager::new();
        manager.spawn_from_config(&configs).await;

        // The valid server connects and registers tools; invalid ones are gracefully skipped
        assert!(manager.handles("mcp__valid_sse__calculate").await);
        assert!(!manager.handles("mcp__invalid_sse__calculate").await);
        assert!(!manager.handles("mcp__invalid_stdio__calculate").await);

        // Failed servers surface as failed entries with their spawn error
        // instead of being silently skipped (v2 marks failed entries).
        let entries = manager.server_entries().await;
        assert_eq!(entries.len(), 3, "all configured servers must be visible");
        let by_name = |name: &str| entries.iter().find(|e| e.name == name).unwrap();
        assert_eq!(by_name("valid_sse").status, "connected");
        assert_eq!(by_name("invalid_sse").status, "failed");
        assert!(by_name("invalid_sse").error.is_some());
        assert_eq!(by_name("invalid_stdio").status, "failed");
        assert!(by_name("invalid_stdio").error.is_some());
    }

    /// Reconnecting a server whose endpoint died must surface `failed` with
    /// the error instead of pretending to be connected (v2 marks failed
    /// entries, connection-manager.ts:366-372).
    #[tokio::test]
    async fn test_reconnect_marks_failed_when_endpoint_dies() {
        let (sse_url, shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;

        let mut configs = HashMap::new();
        configs.insert(
            "srv".to_string(),
            crate::config::McpServerConfig {
                command: None,
                args: None,
                env: None,
                url: Some(sse_url),
                headers: None,
            },
        );
        let manager = McpManager::new();
        manager.spawn_from_config(&configs).await;
        assert_eq!(manager.server_entries().await[0].status, "connected");

        // Kill the mock server, then reconnect against the stored recipe.
        let _ = shutdown.send(());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(manager.reconnect("srv").await.is_err());
        let entry = &manager.server_entries().await[0];
        assert_eq!(entry.status, "failed");
        assert!(entry.error.is_some());
    }

    /// Reconnecting an unconfigured server is an error, matching the TS
    /// manager's unknown-name behavior.
    #[tokio::test]
    async fn test_reconnect_unknown_server_errors() {
        let manager = McpManager::new();
        assert!(manager.reconnect("nope").await.is_err());
    }
}
