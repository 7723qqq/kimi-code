//! Dynamic MCP server manager and tool registry.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::RwLock;

use crate::mcp::client::McpClient;
use crate::mcp::types::{McpContent, McpTool};
use crate::native::tool_naming::qualify_mcp_tool_name;
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
        bearer_token_env_var: Option<String>,
    },
    /// Streamable HTTP (`transport = "http"`), the v2 default for a bare url.
    Http {
        url: String,
        headers: HashMap<String, String>,
        bearer_token_env_var: Option<String>,
    },
    Stdio {
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        cwd: Option<String>,
    },
    /// In-process stub used by the napi binding path and tests.
    Mock,
}

impl McpServerRecipe {
    /// The wire transport label surfaced on `McpServerEntry.transport`
    /// (v2 `McpServerConfig['transport']`).
    fn transport_label(&self) -> String {
        match self {
            McpServerRecipe::Sse { .. } => "sse".into(),
            McpServerRecipe::Http { .. } => "http".into(),
            McpServerRecipe::Stdio { .. } => "stdio".into(),
            McpServerRecipe::Mock => "mock".into(),
        }
    }
}

struct ServerState {
    recipe: McpServerRecipe,
    /// "connected" | "failed" | "pending" | "disabled" (v2 `McpServerStatus`
    /// subset; `disabled` covers `config.enabled === false`).
    status: String,
    error: Option<String>,
    /// Every tool the server advertised (v2 `rawTools`), including the ones
    /// the filter hides from the model; `/mcp inspect` reads this.
    raw_tools: Vec<McpTool>,
}

/// Per-server tool visibility (v2 `computeEnabledNames` plus `config.enabled`).
#[derive(Debug, Clone)]
struct ToolFilter {
    enabled: bool,
    enabled_tools: Option<HashSet<String>>,
    disabled_tools: HashSet<String>,
}

impl ToolFilter {
    fn all() -> Self {
        Self {
            enabled: true,
            enabled_tools: None,
            disabled_tools: HashSet::new(),
        }
    }

    fn allows(&self, tool_name: &str) -> bool {
        if !self.enabled {
            return false;
        }
        if let Some(enabled) = &self.enabled_tools
            && !enabled.contains(tool_name)
        {
            return false;
        }
        !self.disabled_tools.contains(tool_name)
    }
}

/// v2 `DEFAULT_STARTUP_TIMEOUT_MS` (connection-manager.ts:65).
pub const DEFAULT_MCP_STARTUP_TIMEOUT_MS: u64 = 30_000;
/// v2 env bindings (configSection.ts:16-17).
const MCP_STARTUP_TIMEOUT_ENV: &str = "KIMI_MCP_STARTUP_TIMEOUT_MS";
const MCP_TOOL_TIMEOUT_ENV: &str = "KIMI_MCP_TOOL_TIMEOUT_MS";
/// v2 `MAX_MCP_TIMEOUT_MS` (config-schema.ts:5).
const MAX_MCP_TIMEOUT_MS: u64 = 2_147_483_647;

/// A status-change subscription token (v2 `onStatusChange`'s unsubscribe
/// closure, connection-manager.ts:360-378).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct McpStatusSubscription(u64);

/// Listener invoked with the public entry whenever a server's status changes.
pub type McpStatusListener = Box<dyn Fn(McpServerEntry) + Send + Sync>;

/// Per-server registration options: visibility, enabled flag and timeouts.
#[derive(Debug, Clone)]
pub struct McpServerOptions {
    pub enabled: bool,
    pub enabled_tools: Option<Vec<String>>,
    pub disabled_tools: Option<Vec<String>>,
    pub startup_timeout_ms: Option<u64>,
    pub tool_timeout_ms: Option<u64>,
}

impl Default for McpServerOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            enabled_tools: None,
            disabled_tools: None,
            startup_timeout_ms: None,
            tool_timeout_ms: None,
        }
    }
}

/// Resolved timeouts for one server (v2 `startupTimeoutMs` wrapping
/// connect + discovery, `toolCallTimeoutMs` for a single request).
#[derive(Debug, Clone)]
struct McpTimeouts {
    startup: Duration,
    tool: Option<Duration>,
}

/// v2 parses the env value as an integer in `[1, MAX_MCP_TIMEOUT_MS]` and
/// ignores anything else (configSection.ts:19-24).
fn parse_timeout_env(name: &str) -> Option<u64> {
    let raw = std::env::var(name).ok()?;
    let parsed: u64 = raw.trim().parse().ok()?;
    (1..=MAX_MCP_TIMEOUT_MS).contains(&parsed).then_some(parsed)
}

/// v2 precedence: per-server config → env → `[mcp]` section → 30s default
/// (connection-manager.ts:310-314). The env value is passed in so resolution
/// stays testable without mutating process state.
fn resolve_startup_timeout(per_server: Option<u64>, env: Option<u64>, global: Option<u64>) -> u64 {
    per_server
        .or(env)
        .or(global)
        .unwrap_or(DEFAULT_MCP_STARTUP_TIMEOUT_MS)
}

/// v2 precedence for tool calls; `None` keeps the client built-in default
/// (connection-manager.ts:389-390).
fn resolve_tool_timeout(
    per_server: Option<u64>,
    env: Option<u64>,
    global: Option<u64>,
) -> Option<u64> {
    per_server.or(env).or(global)
}

pub struct McpManager {
    clients: Arc<RwLock<HashMap<String, Arc<McpClient>>>>,
    cached_tools: Arc<RwLock<HashMap<String, (String, McpTool)>>>,
    servers: Arc<RwLock<HashMap<String, ServerState>>>,
    filters: Arc<RwLock<HashMap<String, ToolFilter>>>,
    timeouts: Arc<RwLock<HashMap<String, McpTimeouts>>>,
    /// Global defaults from the `[mcp]` config section (v2
    /// `resolveDefaultTimeouts`).
    defaults: Arc<RwLock<crate::config::McpTimeoutConfig>>,
    /// In-flight reconnects (v2 `inFlightReconnects`): late callers join the
    /// running one via its Notify instead of double-spawning.
    in_flight: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>,
    /// OAuth credentials for remote servers (v2 `McpOAuthService`).
    oauth: Arc<RwLock<Option<Arc<crate::mcp::oauth::McpOAuthService>>>>,
    /// Status-change listeners (v2 `listeners`, connection-manager.ts:360-378).
    status_listeners: Arc<Mutex<Vec<(McpStatusSubscription, McpStatusListener)>>>,
    next_status_id: std::sync::atomic::AtomicU64,
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
            filters: Arc::new(RwLock::new(HashMap::new())),
            timeouts: Arc::new(RwLock::new(HashMap::new())),
            defaults: Arc::new(RwLock::new(crate::config::McpTimeoutConfig::default())),
            in_flight: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            oauth: Arc::new(RwLock::new(None)),
            status_listeners: Arc::new(Mutex::new(Vec::new())),
            next_status_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Register a status-change listener (v2 `onStatusChange`,
    /// connection-manager.ts:360-378). The listener is invoked with the public
    /// entry whenever a server's status changes; drop the returned token to
    /// unsubscribe.
    pub fn on_status_change(&self, listener: McpStatusListener) -> McpStatusSubscription {
        let id = McpStatusSubscription(
            self.next_status_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        );
        self.status_listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((id, listener));
        id
    }

    /// Remove a status-change listener by token.
    pub fn unsubscribe_status(&self, sub: McpStatusSubscription) -> bool {
        let mut listeners = self
            .status_listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = listeners.iter().position(|(id, _)| *id == sub) {
            let _ = listeners.swap_remove(pos);
            true
        } else {
            false
        }
    }

    /// Fan the current public entry for `name` out to every status listener
    /// (v2 `emit`, connection-manager.ts:360-378). No-op when the server is
    /// unknown. Failed / needs-auth transitions are logged, and a panicking
    /// listener must not break the connection manager (v2 wraps listener
    /// calls in try/catch).
    async fn emit_status(&self, name: &str) {
        let entry = {
            let servers = self.servers.read().await;
            let Some(state) = servers.get(name) else {
                return;
            };
            to_public_entry(name, state)
        };
        if entry.status == "failed" || entry.status == "needs-auth" {
            tracing::error!(
                server = %entry.name,
                transport = %entry.transport,
                status = %entry.status,
                reason = ?entry.error,
                "mcp server unavailable"
            );
        }
        let listeners = self
            .status_listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (_, listener) in listeners.iter() {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                listener(entry.clone());
            }));
        }
    }

    /// Install the OAuth credential service used for remote servers
    /// (v2 `McpConnectionManagerOptions.oauthService`).
    pub async fn set_oauth_service(&self, service: Arc<crate::mcp::oauth::McpOAuthService>) {
        *self.oauth.write().await = Some(service);
    }

    async fn oauth_service(&self) -> Option<Arc<crate::mcp::oauth::McpOAuthService>> {
        self.oauth.read().await.clone()
    }

    /// Inject `Authorization: Bearer <token>` from the OAuth store when the
    /// server carries no static token (v2 `resolveOAuthProvider`).
    async fn apply_oauth_header(
        &self,
        name: &str,
        url: &str,
        headers: &mut HashMap<String, String>,
    ) {
        if headers
            .keys()
            .any(|key| key.eq_ignore_ascii_case("authorization"))
        {
            return;
        }
        let Some(service) = self.oauth_service().await else {
            return;
        };
        let Ok(key) = crate::mcp::oauth::mcp_oauth_store_key(name, url) else {
            return;
        };
        if let Some(token) = service.access_token(&key).await {
            headers.insert("Authorization".into(), format!("Bearer {token}"));
        }
    }

    /// Register (or replace) the tool-visibility filter of a server. The
    /// config path calls this from `spawn_from_config`; the napi binding path
    /// calls it directly before `add_client`.
    pub async fn set_tool_filter(
        &self,
        name: &str,
        enabled: bool,
        enabled_tools: Option<Vec<String>>,
        disabled_tools: Option<Vec<String>>,
    ) {
        self.filters.write().await.insert(
            name.to_string(),
            ToolFilter {
                enabled,
                enabled_tools: enabled_tools.map(|names| names.into_iter().collect()),
                disabled_tools: disabled_tools.unwrap_or_default().into_iter().collect(),
            },
        );
    }

    /// Set the global `[mcp]` defaults that per-server timeouts fall back to.
    pub async fn set_default_timeouts(&self, defaults: crate::config::McpTimeoutConfig) {
        *self.defaults.write().await = defaults;
    }

    /// Register an initialized MCP client, indexing only the tools its filter
    /// allows (v2 `computeEnabledNames` → `resolved().tools`) while keeping
    /// the full advertised list for inspection (v2 `rawTools`). Discovery
    /// failures surface to the caller so the connect path can mark the entry
    /// `failed` instead of `connected` with zero tools.
    async fn register_client(&self, mut client: McpClient) -> Result<usize, String> {
        let name = client.server_name().to_string();
        if let Some(timeouts) = self.timeouts.read().await.get(&name).cloned() {
            client.set_tool_timeout(timeouts.tool);
        }
        let client_arc = Arc::new(client);
        let tools = client_arc.list_tools().await?;
        // A tool whose inputSchema is not a JSON object fails the whole
        // server (v2 `assertMcpInputSchema`, mcpCore/types.ts:44-55).
        for tool in &tools {
            if !tool.input_schema.is_object() {
                return Err(format!(
                    "Invalid inputSchema for MCP tool \"{}\": schema must be a JSON object",
                    tool.name
                ));
            }
        }
        let filter = {
            let filters = self.filters.read().await;
            filters.get(&name).cloned().unwrap_or_else(ToolFilter::all)
        };

        let enabled_count = {
            let mut cached = self.cached_tools.write().await;
            // Re-registering a server replaces its previous tool set.
            cached.retain(|_, (server, _)| *server != name);
            let mut count = 0;
            let mut seen_in_this_call = HashSet::new();
            let mut collisions: Vec<String> = Vec::new();
            for tool in &tools {
                if !filter.allows(&tool.name) {
                    continue;
                }
                let qualified_name = qualify_mcp_tool_name(&name, &tool.name);
                // v2 `registerMcpServer` collision detection
                // (mcpService.ts:186-215): a qualified name that duplicates
                // another tool of this server, or one already registered by
                // another server, is dropped and reported.
                if !seen_in_this_call.insert(qualified_name.clone()) {
                    collisions.push(format!(
                        "\"{}\" -> {} (collides with a same-server tool)",
                        tool.name, qualified_name
                    ));
                    continue;
                }
                if let Some((other_server, _)) = cached.get(&qualified_name)
                    && other_server != &name
                {
                    collisions.push(format!(
                        "\"{}\" -> {} (collides with server \"{other_server}\")",
                        tool.name, qualified_name
                    ));
                    continue;
                }
                count += 1;
                cached.insert(qualified_name, (name.clone(), tool.clone()));
                // Also index by plain tool name if not conflicting
                cached.insert(tool.name.clone(), (name.clone(), tool.clone()));
            }
            if !collisions.is_empty() {
                tracing::warn!(
                    server = %name,
                    collisions = %collisions.join("; "),
                    "MCP tool name collisions; the losing tools were dropped"
                );
            }
            count
        };

        if let Some(state) = self.servers.write().await.get_mut(&name) {
            state.raw_tools = tools;
        }
        self.clients.write().await.insert(name, client_arc);
        Ok(enabled_count)
    }

    /// Register an initialized MCP client without failing the caller on a
    /// discovery error (direct callers: REST probes and tests).
    pub async fn add_client(&self, client: McpClient) {
        let _ = self.register_client(client).await;
    }

    /// Check if a tool name belongs to any registered MCP server.
    pub async fn handles(&self, tool_name: &str) -> bool {
        let cached = self.cached_tools.read().await;
        cached.contains_key(tool_name)
    }

    /// All discovered MCP tools as engine tool definitions (for the model).
    /// Tools of a server whose connection died are withheld (v2 `resolved()`
    /// returns `undefined` unless the entry is `connected`,
    /// connection-manager.ts:142-167).
    pub async fn list_tool_infos(&self) -> Vec<crate::turn_loop::types::ToolInfo> {
        let clients = self.clients.read().await;
        let cached = self.cached_tools.read().await;
        let mut seen = HashSet::new();
        let mut infos = Vec::new();
        for (name, (server, tool)) in cached.iter() {
            // Prefer the namespaced `mcp__<server>__<tool>` form; skip the
            // plain-name alias when it duplicates a namespaced entry.
            if !name.starts_with("mcp__") || !seen.insert(name.clone()) {
                continue;
            }
            match clients.get(server) {
                Some(client) if !client.is_closed() => {}
                _ => continue,
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
            // A client whose process died mid-session must not advertise
            // itself as connected, and its tools must disappear from the
            // entry (v2 watchForUnexpectedClose marks the entry failed and
            // drops its tools, connection-manager.ts:360-378; `toolCount` is
            // 0 unless the entry is connected, connection-manager.ts:507-518).
            let (status, error, tools) = if client.is_closed() {
                (
                    "failed".to_string(),
                    Some("server closed unexpectedly".to_string()),
                    Vec::new(),
                )
            } else {
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
                ("connected".to_string(), None, tools)
            };
            let tool_count = tools.len();
            entries.push(McpServerEntry {
                name: name.clone(),
                transport: client.transport_type().to_string(),
                status,
                tool_count,
                error,
                tools,
            });
        }
        // Failed-to-spawn and disabled servers have no client but must still
        // surface — they carry their recipe and, for failures, the spawn error.
        let servers = self.servers.read().await;
        for (name, state) in servers.iter() {
            if clients.contains_key(name) {
                continue;
            }
            entries.push(McpServerEntry {
                name: name.clone(),
                transport: match &state.recipe {
                    McpServerRecipe::Sse { .. } => "sse".into(),
                    McpServerRecipe::Http { .. } => "http".into(),
                    McpServerRecipe::Stdio { .. } => "stdio".into(),
                    McpServerRecipe::Mock => "mock".into(),
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
        drop(cached);
        drop(clients);
        drop(servers);
        self.filters.write().await.remove(name);
        self.timeouts.write().await.remove(name);
        removed_server || removed_client
    }

    /// Close a server but keep its entry as `removed` (v2 `markRemoved`,
    /// connection-manager.ts:221-232): the tools disappear while the name
    /// stays visible so callers can report that the server was removed.
    pub async fn mark_removed(&self, name: &str) -> bool {
        let client = { self.clients.write().await.remove(name) };
        if let Some(client) = client {
            client.close().await;
        } else if !self.servers.read().await.contains_key(name) {
            return false;
        }
        self.cached_tools
            .write()
            .await
            .retain(|_, (server, _)| server != name);
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = "removed".into();
            state.error = None;
            state.raw_tools.clear();
        }
        self.emit_status(name).await;
        true
    }

    /// Close every client and forget all entries (v2 `shutdown`).
    pub async fn shutdown(&self) {
        let clients: Vec<Arc<McpClient>> = {
            let mut guard = self.clients.write().await;
            guard.drain().map(|(_, client)| client).collect()
        };
        for client in clients {
            client.close().await;
        }
        self.cached_tools.write().await.clear();
        self.servers.write().await.clear();
        self.filters.write().await.clear();
        self.timeouts.write().await.clear();
    }

    /// Inspect tools provided by a specific MCP server. Prefers a live
    /// `tools/list` round-trip and falls back to the tools discovered at
    /// registration time, so a failed server still reports what it advertised.
    pub async fn inspect_server(&self, name: &str) -> Option<Vec<Value>> {
        let client = { self.clients.read().await.get(name).cloned() };
        if let Some(client) = client
            && let Ok(tools) = client.list_tools().await
        {
            return Some(tools.iter().map(tool_to_json).collect());
        }
        let servers = self.servers.read().await;
        let state = servers.get(name)?;
        Some(state.raw_tools.iter().map(tool_to_json).collect())
    }

    /// Render an MCP content block to a text representation. Text blocks
    /// pass through verbatim; image / audio / video blocks become a notice
    /// with the mime type and a base64 preview (truncated); resource blocks
    /// include the uri and text. Used because the tool-result wire type
    /// (`ExecutableToolResult.content: String`) cannot yet carry
    /// `ContentPart` — non-text blocks must not be silently dropped.
    fn render_mcp_content(c: &McpContent, preview_bytes: usize) -> String {
        match c.content_type.as_str() {
            "text" | "string" => c.text.clone().unwrap_or_default(),
            "image" | "audio" | "video" => {
                let mime = c.mime_type.as_deref().unwrap_or("<unknown>");
                let data = c.data.as_deref().unwrap_or("");
                let preview: String = data.chars().take(preview_bytes).collect();
                let total = data.len();
                if preview_bytes >= total {
                    format!(
                        "[MCP {kind} (mime={mime}, {total} bytes base64) data:<{data}>]",
                        kind = c.content_type
                    )
                } else {
                    format!(
                        "[MCP {kind} (mime={mime}, {total} bytes base64, preview first {preview_bytes}) data:<{preview}…>]",
                        kind = c.content_type
                    )
                }
            }
            "resource" => match &c.resource {
                Some(value) => {
                    let uri = value
                        .get("uri")
                        .and_then(Value::as_str)
                        .unwrap_or("<missing uri>");
                    let text = value
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("<no text>");
                    format!("[MCP resource uri={uri} text=<{text}>]")
                }
                None => "[MCP resource with empty payload]".to_string(),
            },
            unknown => {
                let mime = c.mime_type.as_deref().unwrap_or("");
                format!(
                    "[MCP unknown content type={unknown} mime={mime} text=<{}>]",
                    c.text.as_deref().unwrap_or("")
                )
            }
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
                // Render every content block to text so non-text variants
                // (image/audio/resource) are never silently dropped — the
                // full `ExecutableToolResult.content: String` wire type
                // can't carry `ContentPart`s yet, so non-text blocks fall
                // back to a descriptive notice with a data preview.
                const NON_TEXT_PREVIEW_BYTES: usize = 120;
                let mut text_parts = Vec::new();
                for c in &res.content {
                    text_parts.push(Self::render_mcp_content(c, NON_TEXT_PREVIEW_BYTES));
                }
                if res.structured_content.is_some() || res.meta.is_some() {
                    let mut extras = serde_json::Map::new();
                    if let Some(sc) = res.structured_content {
                        extras.insert("structuredContent".to_string(), sc);
                    }
                    if let Some(m) = res.meta {
                        extras.insert("_meta".to_string(), m);
                    }
                    let extras_json = serde_json::to_string_pretty(&Value::Object(extras))
                        .unwrap_or_default();
                    text_parts.push(format!(
                        "<mcp-result-extras>\n{}\n</mcp-result-extras>",
                        extras_json
                    ));
                }
                Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: text_parts.join("\n"),
                    is_error: res.is_error,
                    note: Some(format!("mcp:{}", server_name)),
                })
            }
            Err(e) => Some(ExecutableToolResult {
                delivery: None,
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
    /// Connect every server in `config.mcp_servers` in parallel, using
    /// `config.mcp` as the global timeout defaults (v2 `connectAll` +
    /// `resolveDefaultTimeouts`; per-server failures are isolated so one
    /// crashed entry never blocks the others).
    pub async fn spawn_from_config(&self, config: &crate::config::KimiConfig) {
        self.set_default_timeouts(config.mcp.clone()).await;
        let tasks = config
            .mcp_servers
            .iter()
            .filter_map(|(name, conf)| {
                let recipe = recipe_from_config(conf)?;
                let options = McpServerOptions {
                    enabled: conf.enabled.unwrap_or(true),
                    enabled_tools: conf.enabled_tools.clone(),
                    disabled_tools: conf.disabled_tools.clone(),
                    startup_timeout_ms: conf.startup_timeout_ms,
                    tool_timeout_ms: conf.tool_timeout_ms,
                };
                Some(self.configure(name, recipe, options))
            })
            .collect::<Vec<_>>();
        futures_util::future::join_all(tasks).await;
    }

    /// Register a server from a host-supplied recipe and connect it unless it
    /// is disabled (v2 `connect`, connection-manager.ts:182-205). The napi
    /// binding path calls this directly; `spawn_from_config` wraps it.
    pub async fn configure(
        &self,
        name: &str,
        recipe: McpServerRecipe,
        options: McpServerOptions,
    ) -> Result<(), String> {
        self.set_tool_filter(
            name,
            options.enabled,
            options.enabled_tools,
            options.disabled_tools,
        )
        .await;
        let defaults = self.defaults.read().await.clone();
        self.timeouts.write().await.insert(
            name.to_string(),
            McpTimeouts {
                startup: Duration::from_millis(resolve_startup_timeout(
                    options.startup_timeout_ms,
                    parse_timeout_env(MCP_STARTUP_TIMEOUT_ENV),
                    defaults.startup_timeout_ms,
                )),
                tool: resolve_tool_timeout(
                    options.tool_timeout_ms,
                    parse_timeout_env(MCP_TOOL_TIMEOUT_ENV),
                    defaults.tool_timeout_ms,
                )
                .map(Duration::from_millis),
            },
        );
        self.servers.write().await.insert(
            name.to_string(),
            ServerState {
                recipe,
                // v2 lists a disabled entry as `disabled` without ever
                // connecting it (connection-manager.ts:193-204).
                status: if options.enabled {
                    "pending".into()
                } else {
                    "disabled".into()
                },
                error: None,
                raw_tools: Vec::new(),
            },
        );
        self.emit_status(name).await;
        if !options.enabled {
            return Ok(());
        }
        match self.connect_one(name).await {
            Ok(()) => Ok(()),
            Err(e) => {
                self.mark_connect_failure(name, &e).await;
                Err(e)
            }
        }
    }

    /// Mark a failed connect on the entry: `needs-auth` when the failure
    /// looks like a 401 on a server without a static credential, otherwise
    /// `failed` (v2 `connectOne` catch branch + `shouldMarkNeedsAuth`).
    async fn mark_connect_failure(&self, name: &str, error: &str) {
        let oauth_installed = self.oauth_service().await.is_some();
        let recipe = self
            .servers
            .read()
            .await
            .get(name)
            .map(|s| s.recipe.clone());
        let status = match recipe {
            Some(recipe) if should_mark_needs_auth(&recipe, oauth_installed, error) => "needs-auth",
            _ => "failed",
        };
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = status.into();
            state.error = Some(error.to_string());
        }
        self.emit_status(name).await;
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
        let startup = {
            let timeouts = self.timeouts.read().await;
            timeouts
                .get(name)
                .map(|t| t.startup)
                .unwrap_or_else(|| Duration::from_millis(DEFAULT_MCP_STARTUP_TIMEOUT_MS))
        };
        let connect = async {
            let client = match &recipe {
                McpServerRecipe::Sse {
                    url,
                    headers,
                    bearer_token_env_var,
                } => {
                    let mut headers =
                        resolve_bearer_headers("SSE", headers, bearer_token_env_var.as_deref())?;
                    self.apply_oauth_header(name, url, &mut headers).await;
                    McpClient::connect_sse(name, url, headers).await?
                }
                McpServerRecipe::Http {
                    url,
                    headers,
                    bearer_token_env_var,
                } => {
                    let mut headers =
                        resolve_bearer_headers("HTTP", headers, bearer_token_env_var.as_deref())?;
                    self.apply_oauth_header(name, url, &mut headers).await;
                    McpClient::connect_http(name, url, headers).await?
                }
                McpServerRecipe::Stdio {
                    command,
                    args,
                    env,
                    cwd,
                } => {
                    McpClient::spawn_stdio(
                        name,
                        command,
                        &args.iter().map(String::as_str).collect::<Vec<_>>(),
                        env,
                        cwd.as_deref(),
                    )
                    .await?
                }
                McpServerRecipe::Mock => McpClient::mock(name),
            };
            // A discovery failure must mark the entry `failed`, not
            // `connected` with zero tools (v2 `connectOne` catch branch). A
            // stdio child's captured stderr is appended to the error so the
            // failure text carries the server's diagnostics (v2
            // `formatStartupError`, connection-manager.ts:545-574). The
            // snapshot is taken before `register_client` moves the client.
            let stderr_tail = client.stderr_snapshot();
            match self.register_client(client).await {
                Ok(count) => {
                    // Watch for the transport dying after the handshake (v2
                    // `watchForUnexpectedClose`, connection-manager.ts:321-341).
                    if let Some(client_arc) = self.clients.read().await.get(name).cloned() {
                        self.watch_unexpected_close(name, client_arc).await;
                    }
                    Ok(count)
                }
                Err(e) => {
                    if stderr_tail.is_empty() {
                        Err(e)
                    } else {
                        Err(format!("{e}\nstderr: {}", stderr_tail.trim_end()))
                    }
                }
            }
        };
        // v2 wraps connect + tool discovery in `withTimeout` and reports
        // `Timed out after <ms>ms` (connection-manager.ts:594-611).
        match tokio::time::timeout(startup, connect).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(format!("Timed out after {}ms", startup.as_millis())),
        }
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = "connected".into();
            state.error = None;
        }
        self.emit_status(name).await;
        Ok(())
    }

    /// Register the unexpected-close watch on a live client (v2
    /// `watchForUnexpectedClose`, connection-manager.ts:321-341): when the
    /// transport dies on its own, mark the entry `failed`, drop its tools and
    /// notify status listeners. The callback checks the client is still the
    /// registered one before touching state, so a shutdown / reconnect that
    /// already moved on is never overwritten (v2 `isCurrent` + `entry.client
    /// !== client`).
    async fn watch_unexpected_close(&self, name: &str, client: Arc<McpClient>) {
        let clients = self.clients.clone();
        let servers = self.servers.clone();
        let cached = self.cached_tools.clone();
        let listeners = self.status_listeners.clone();
        let name_owned = name.to_string();
        let client_for_cb = client.clone();
        client
            .on_unexpected_close(Box::new(move |reason| {
                let clients = clients.clone();
                let servers = servers.clone();
                let cached = cached.clone();
                let listeners = listeners.clone();
                let client = client_for_cb.clone();
                let name = name_owned.clone();
                tokio::spawn(async move {
                    let is_current = {
                        let clients = clients.read().await;
                        matches!(clients.get(&name), Some(c) if Arc::ptr_eq(c, &client))
                    };
                    if !is_current {
                        return;
                    }
                    {
                        let mut servers = servers.write().await;
                        if let Some(state) = servers.get_mut(&name) {
                            state.status = "failed".into();
                            state.error = Some(reason);
                            state.raw_tools.clear();
                        }
                    }
                    cached.write().await.retain(|_, (srv, _)| *srv != name);
                    let entry = {
                        let servers = servers.read().await;
                        let Some(state) = servers.get(&name) else {
                            return;
                        };
                        to_public_entry(&name, state)
                    };
                    let listeners = listeners.lock().unwrap_or_else(|e| e.into_inner());
                    for (_, listener) in listeners.iter() {
                        listener(entry.clone());
                    }
                });
            }))
            .await;
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
        // Remove the in-flight marker and wake any joiners (v2
        // `reconnectAndJoin` deletes the entry in a `finally`,
        // connection-manager.ts:297-301). Without the removal a later
        // `reconnect` would find the already-notified marker and return
        // without reconnecting.
        let mut in_flight = self.in_flight.lock().await;
        if let Some(notify) = in_flight.remove(name) {
            notify.notify_waiters();
        }
        drop(in_flight);
        result
    }

    /// Reconnect after any in-flight reconnect for the same server has
    /// settled (v2 `reconnectAfterCurrent`, connection-manager.ts:297-301):
    /// wait for the current one, then start a fresh reconnect.
    pub async fn reconnect_after_current(&self, name: &str) -> Result<(), String> {
        let notify = {
            let in_flight = self.in_flight.lock().await;
            in_flight.get(name).cloned()
        };
        if let Some(notify) = notify {
            notify.notified().await;
        }
        self.reconnect(name).await
    }

    async fn reconnect_inner(&self, name: &str) -> Result<(), String> {
        let Some(_recipe) = self
            .servers
            .read()
            .await
            .get(name)
            .map(|s| s.recipe.clone())
        else {
            return Err(format!("MCP server '{name}' is not configured"));
        };
        // A disabled server must not be reconnected (v2 throws
        // `MCP_SERVER_DISABLED`, connection-manager.ts:146-164).
        let enabled = {
            let filters = self.filters.read().await;
            filters.get(name).map(|f| f.enabled).unwrap_or(true)
        };
        if !enabled {
            return Err(format!("MCP server is disabled: {name}"));
        }
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
            state.raw_tools.clear();
        }
        self.emit_status(name).await;
        match self.connect_one(name).await {
            Ok(()) => Ok(()),
            Err(e) => {
                self.mark_connect_failure(name, &e).await;
                Err(e)
            }
        }
    }
}

fn tool_to_json(tool: &McpTool) -> Value {
    serde_json::json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": tool.input_schema,
    })
}

/// The public view of a server entry (v2 `toPublicEntry`,
/// connection-manager.ts:445-456): `toolCount` is the raw advertised count,
/// which is 0 unless the entry is `connected` (the caller zeroes `raw_tools`
/// on failure / removal).
fn to_public_entry(name: &str, state: &ServerState) -> McpServerEntry {
    McpServerEntry {
        name: name.to_string(),
        transport: state.recipe.transport_label(),
        status: state.status.clone(),
        tool_count: state.raw_tools.len(),
        error: state.error.clone(),
        tools: state
            .raw_tools
            .iter()
            .map(|tool| McpToolSummary {
                name: tool.name.clone(),
                description: tool.description.clone().unwrap_or_default(),
            })
            .collect(),
    }
}

/// Whether a connect failure should flip the entry into `needs-auth` instead
/// of `failed` (v2 `shouldMarkNeedsAuth`, connection-manager.ts:383-393):
/// only remote servers without a static credential participate in the OAuth
/// flow, and only when the failure looks like a 401 / Unauthorized.
fn should_mark_needs_auth(recipe: &McpServerRecipe, oauth_installed: bool, error: &str) -> bool {
    if !oauth_installed {
        return false;
    }
    let (headers, bearer_token_env_var) = match recipe {
        McpServerRecipe::Sse {
            headers,
            bearer_token_env_var,
            ..
        }
        | McpServerRecipe::Http {
            headers,
            bearer_token_env_var,
            ..
        } => (headers, bearer_token_env_var),
        _ => return false,
    };
    // A pinned static credential means the 401 is a bad header, not a missing
    // OAuth token — the real error is more actionable than "run /mcp-config
    // login" for a server that doesn't speak OAuth.
    if bearer_token_env_var.is_some() {
        return false;
    }
    if !headers.is_empty() {
        return false;
    }
    is_unauthorized_like_error(error)
}

/// v2 `isUnauthorizedLikeError` (connection-manager.ts:473-483): Rust errors
/// are plain strings, so the name/code checks collapse into message sniffing.
fn is_unauthorized_like_error(error: &str) -> bool {
    error.contains("401") || error.to_ascii_lowercase().contains("unauthorized")
}

/// A configured server is remote when it has a URL, otherwise stdio when it
/// has a command; entries with neither are not MCP servers at all. An explicit
/// `transport` wins, and a bare `url` defaults to Streamable HTTP exactly like
/// the v2 config preprocess (`config-schema.ts:58-65`); legacy HTTP+SSE needs
/// `transport = "sse"`.
fn recipe_from_config(conf: &crate::config::McpServerConfig) -> Option<McpServerRecipe> {
    let transport = conf.transport.as_deref().map(str::to_ascii_lowercase);
    let stdio = || {
        conf.command.as_ref().map(|cmd| McpServerRecipe::Stdio {
            command: cmd.clone(),
            args: conf.args.clone().unwrap_or_default(),
            env: conf.env.clone().unwrap_or_default(),
            cwd: conf.cwd.clone(),
        })
    };
    let remote = |build: fn(String, HashMap<String, String>, Option<String>) -> McpServerRecipe| {
        conf.url.as_ref().map(|url| {
            build(
                url.clone(),
                conf.headers.clone().unwrap_or_default(),
                conf.bearer_token_env_var.clone(),
            )
        })
    };
    match transport.as_deref() {
        Some("stdio") => stdio(),
        Some("sse") => remote(|url, headers, bearer_token_env_var| McpServerRecipe::Sse {
            url,
            headers,
            bearer_token_env_var,
        }),
        Some("http") => remote(|url, headers, bearer_token_env_var| McpServerRecipe::Http {
            url,
            headers,
            bearer_token_env_var,
        }),
        Some(_) => None,
        None => {
            if conf.url.is_some() {
                remote(|url, headers, bearer_token_env_var| McpServerRecipe::Http {
                    url,
                    headers,
                    bearer_token_env_var,
                })
            } else {
                stdio()
            }
        }
    }
}

/// Merge `headers` with a bearer token read from `env_var`, mirroring v2
/// `buildMcpRemoteHeaders` (client-remote.ts:4-25): a missing or empty
/// variable is a configuration error, and any pre-existing Authorization
/// header is replaced by the resolved token.
fn resolve_bearer_headers(
    transport: &str,
    headers: &HashMap<String, String>,
    env_var: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    let mut headers = headers.clone();
    let Some(var) = env_var else {
        return Ok(headers);
    };
    let token = std::env::var(var).ok().filter(|token| !token.is_empty());
    let Some(token) = token else {
        return Err(format!(
            "MCP {transport} bearer token env var \"{var}\" is not set or is empty"
        ));
    };
    headers.retain(|key, _| !key.eq_ignore_ascii_case("authorization"));
    headers.insert("Authorization".into(), format!("Bearer {token}"));
    Ok(headers)
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
            .call_tool("github_sample_tool", &json!({ "query": "kimi" }))
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
        let res_missing = manager.call_tool("unknown_tool", &json!({})).await;
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
            .call_tool(
                "mcp__calc_server__calculate",
                &json!({ "expression": "10+32" }),
            )
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
                // The mock speaks legacy HTTP+SSE, which is opt-in now that a
                // bare url defaults to Streamable HTTP.
                transport: Some("sse".into()),
                ..Default::default()
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
                transport: Some("sse".into()),
                ..Default::default()
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
                ..Default::default()
            },
        );

        let manager = McpManager::new();
        let config = crate::config::KimiConfig {
            mcp_servers: configs,
            ..Default::default()
        };
        manager.spawn_from_config(&config).await;

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

    /// `spawn_from_config` connects servers in parallel (v2 `connectAllNow` +
    /// `Promise.allSettled`): two servers that each time out after 300ms must
    /// finish in ~300ms total, not the ~600ms a serial loop would take.
    #[tokio::test]
    async fn test_spawn_from_config_parallel() {
        let spawn_hanging = || async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            // Accept and hold every connection open without ever responding.
            tokio::spawn(async move {
                let mut held = Vec::new();
                while let Ok((socket, _)) = listener.accept().await {
                    held.push(socket);
                }
            });
            addr
        };
        let addr1 = spawn_hanging().await;
        let addr2 = spawn_hanging().await;

        let mut configs = HashMap::new();
        configs.insert(
            "slow1".to_string(),
            crate::config::McpServerConfig {
                url: Some(format!("http://{addr1}/sse")),
                transport: Some("sse".into()),
                startup_timeout_ms: Some(300),
                ..Default::default()
            },
        );
        configs.insert(
            "slow2".to_string(),
            crate::config::McpServerConfig {
                url: Some(format!("http://{addr2}/sse")),
                transport: Some("sse".into()),
                startup_timeout_ms: Some(300),
                ..Default::default()
            },
        );

        let manager = McpManager::new();
        let config = crate::config::KimiConfig {
            mcp_servers: configs,
            ..Default::default()
        };
        let start = std::time::Instant::now();
        manager.spawn_from_config(&config).await;
        let elapsed = start.elapsed();

        // Parallel: ~300ms (the slowest server). Serial would be ~600ms.
        assert!(
            elapsed < Duration::from_millis(550),
            "parallel connect took {elapsed:?}, expected ~300ms"
        );
        let entries = manager.server_entries().await;
        assert_eq!(entries.len(), 2);
        for entry in &entries {
            assert_eq!(entry.status, "failed", "both hanging servers time out");
        }
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
                // The mock speaks legacy HTTP+SSE, which is opt-in now that a
                // bare url defaults to Streamable HTTP.
                transport: Some("sse".into()),
                ..Default::default()
            },
        );
        let manager = McpManager::new();
        let config = crate::config::KimiConfig {
            mcp_servers: configs,
            ..Default::default()
        };
        manager.spawn_from_config(&config).await;
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

    /// Reconnecting a disabled server is an error (v2 throws
    /// `MCP_SERVER_DISABLED`, connection-manager.ts:146-164).
    #[tokio::test]
    async fn test_reconnect_disabled_server_errors() {
        let manager = McpManager::new();
        manager
            .configure(
                "off",
                McpServerRecipe::Mock,
                McpServerOptions {
                    enabled: false,
                    ..Default::default()
                },
            )
            .await
            .expect("disabled server registers without connecting");
        assert_eq!(manager.server_entries().await[0].status, "disabled");

        let err = manager
            .reconnect("off")
            .await
            .expect_err("disabled server must not reconnect");
        assert_eq!(err, "MCP server is disabled: off");
    }

    /// A panicking status listener must not break the connection manager or
    /// prevent other listeners from receiving the entry (v2 wraps listener
    /// calls in try/catch, connection-manager.ts:435-441).
    #[tokio::test]
    async fn test_panicking_listener_does_not_break_emit() {
        let manager = McpManager::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let recorder = seen.clone();
        manager.on_status_change(Box::new(move |_| {
            panic!("listener fault");
        }));
        manager.on_status_change(Box::new(move |entry| {
            recorder.lock().unwrap().push(entry.status);
        }));

        manager
            .configure("mock", McpServerRecipe::Mock, McpServerOptions::default())
            .await
            .expect("mock server connects");

        let statuses = seen.lock().unwrap();
        assert_eq!(
            statuses.len(),
            2,
            "the healthy listener still receives both transitions"
        );
        assert_eq!(statuses[0], "pending");
        assert_eq!(statuses[1], "connected");
    }

    /// `reconnect_after_current` waits for any in-flight reconnect, then
    /// starts a fresh one (v2 `reconnectAfterCurrent`,
    /// connection-manager.ts:297-301). A completed reconnect clears its
    /// in-flight marker, so a later `reconnect` reconnects instead of
    /// returning on a stale notify.
    #[tokio::test]
    async fn test_reconnect_after_current_reconnects() {
        let manager = McpManager::new();
        manager
            .configure("mock", McpServerRecipe::Mock, McpServerOptions::default())
            .await
            .expect("mock server connects");
        assert_eq!(manager.server_entries().await[0].status, "connected");

        // No in-flight reconnect: reconnect_after_current just reconnects.
        manager
            .reconnect_after_current("mock")
            .await
            .expect("reconnect succeeds");
        assert_eq!(manager.server_entries().await[0].status, "connected");

        // The in-flight marker was cleared, so a plain reconnect also works.
        manager
            .reconnect("mock")
            .await
            .expect("second reconnect succeeds");
        assert_eq!(manager.server_entries().await[0].status, "connected");
    }

    /// Qualified names are sanitized before they reach the model
    /// (v2 `tool-naming.ts` `qualifyMcpToolName`).
    #[tokio::test]
    async fn test_qualified_tool_names_are_sanitized() {
        let manager = McpManager::new();
        manager.add_client(McpClient::mock("My Search")).await;

        assert!(
            manager
                .handles("mcp__My_Search__My_Search_sample_tool")
                .await
        );
        let infos = manager.list_tool_infos().await;
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].name, "mcp__My_Search__My_Search_sample_tool");
    }

    /// `enabledTools` / `disabledTools` filter what the model sees, while
    /// inspection still reports every advertised tool (v2
    /// `computeEnabledNames` / `rawTools`).
    #[tokio::test]
    async fn test_tool_filter_limits_model_visibility() {
        let (sse_url, _shutdown) = spawn_mock_mcp_sse_server(None, None, None).await;
        let manager = McpManager::new();
        manager
            .set_tool_filter(
                "filtered",
                true,
                Some(vec!["calculate".to_string(), "echo".to_string()]),
                Some(vec!["echo".to_string()]),
            )
            .await;

        let client = McpClient::connect_sse("filtered", &sse_url, HashMap::new())
            .await
            .expect("SSE client connect failed");
        manager.add_client(client).await;

        let infos = manager.list_tool_infos().await;
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].name, "mcp__filtered__calculate");
        assert!(manager.handles("mcp__filtered__calculate").await);
        assert!(!manager.handles("mcp__filtered__echo").await);

        let entries = manager.server_entries().await;
        assert_eq!(entries[0].tool_count, 1);
        assert_eq!(entries[0].tools.len(), 1);
        assert_eq!(entries[0].tools[0].name, "calculate");

        let inspected = manager
            .inspect_server("filtered")
            .await
            .expect("inspect failed");
        assert_eq!(
            inspected.len(),
            3,
            "inspection reports every advertised tool"
        );
    }

    /// A qualified tool name that duplicates another tool of the same server
    /// is dropped (v2 `registerMcpServer` same-server collision,
    /// mcpService.ts:186-215). "My Tool" and "My_Tool" both sanitize to
    /// `mcp__srv__My_Tool`.
    #[tokio::test]
    async fn test_same_server_tool_collision_drops_losing_tool() {
        let manager = McpManager::new();
        let tools = vec![
            McpTool {
                name: "My Tool".into(),
                description: Some("first".into()),
                input_schema: json!({ "type": "object" }),
            },
            McpTool {
                name: "My_Tool".into(),
                description: Some("second".into()),
                input_schema: json!({ "type": "object" }),
            },
        ];
        manager
            .add_client(McpClient::mock_with_tools("srv", tools))
            .await;

        assert!(manager.handles("mcp__srv__My_Tool").await);
        let infos = manager.list_tool_infos().await;
        assert_eq!(infos.len(), 1, "the losing tool is dropped");
        assert_eq!(infos[0].description, "first", "the first registration wins");
    }

    /// A qualified tool name already registered by another server is dropped
    /// (v2 `registerMcpServer` other-server collision). Server names that
    /// sanitize identically ("My Server" vs "My_Server") collide on the same
    /// qualified prefix.
    #[tokio::test]
    async fn test_cross_server_tool_collision_drops_losing_tool() {
        let manager = McpManager::new();
        let tools = vec![McpTool {
            name: "calculate".into(),
            description: Some("calc".into()),
            input_schema: json!({ "type": "object" }),
        }];
        manager
            .add_client(McpClient::mock_with_tools("My Server", tools.clone()))
            .await;
        manager
            .add_client(McpClient::mock_with_tools("My_Server", tools))
            .await;

        assert!(manager.handles("mcp__My_Server__calculate").await);
        let infos = manager.list_tool_infos().await;
        assert_eq!(infos.len(), 1, "the second server's duplicate is dropped");
        assert_eq!(infos[0].description, "calc");
    }

    /// `enabled: false` keeps the server listed as `disabled` and never
    /// connects it (v2 connection-manager.ts:193-204).
    #[tokio::test]
    async fn test_disabled_server_is_listed_without_connecting() {
        let mut configs = HashMap::new();
        configs.insert(
            "off".to_string(),
            crate::config::McpServerConfig {
                command: Some("definitely_missing_binary_404".into()),
                args: None,
                env: None,
                url: None,
                headers: None,
                enabled: Some(false),
                ..Default::default()
            },
        );

        let manager = McpManager::new();
        let config = crate::config::KimiConfig {
            mcp_servers: configs,
            ..Default::default()
        };
        manager.spawn_from_config(&config).await;

        let entries = manager.server_entries().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "disabled");
        assert_eq!(entries[0].tool_count, 0);
        assert!(entries[0].error.is_none());
        assert!(!manager.handles("mcp__off__anything").await);
    }

    /// A dead client hides its tools and zeroes `toolCount` (v2
    /// `watchForUnexpectedClose` + `toPublicEntry`).
    #[tokio::test]
    async fn test_closed_client_hides_tools_and_zeroes_count() {
        let manager = McpManager::new();
        manager.add_client(McpClient::mock("github")).await;
        assert_eq!(manager.list_tool_infos().await.len(), 1);

        let client = {
            let clients = manager.clients.read().await;
            clients.get("github").cloned().expect("client missing")
        };
        client.close().await;

        assert!(manager.list_tool_infos().await.is_empty());
        let entries = manager.server_entries().await;
        assert_eq!(entries[0].status, "failed");
        assert_eq!(entries[0].tool_count, 0);
        assert!(entries[0].tools.is_empty());
        assert_eq!(
            entries[0].error.as_deref(),
            Some("server closed unexpectedly")
        );
    }

    /// A stdio child that dies after the handshake must flip the entry to
    /// `failed` and notify status listeners (v2 `watchForUnexpectedClose`,
    /// connection-manager.ts:321-341).
    #[tokio::test]
    async fn test_unexpected_close_marks_failed_and_emits() {
        let init = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let list = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#;
        let dir = std::env::temp_dir();
        let (cmd, args, script) = if cfg!(windows) {
            let path = dir.join(format!("kimi_mcp_die_mgr_{}.bat", std::process::id()));
            std::fs::write(
                &path,
                format!("@echo {init}\r\n@echo {list}\r\n@exit /b 0\r\n"),
            )
            .expect("write die script");
            (
                "cmd",
                vec!["/c".to_string(), path.to_string_lossy().into_owned()],
                path,
            )
        } else {
            let path = dir.join(format!("kimi_mcp_die_mgr_{}.sh", std::process::id()));
            std::fs::write(&path, format!("echo '{init}'\necho '{list}'\nexit 0\n"))
                .expect("write die script");
            ("sh", vec![path.to_string_lossy().into_owned()], path)
        };

        let manager = McpManager::new();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let recorder = std::sync::Mutex::new(Some(tx));
        manager.on_status_change(Box::new(move |entry| {
            if entry.status == "failed"
                && let Some(tx) = recorder.lock().unwrap().take()
            {
                let _ = tx.send(entry);
            }
        }));

        manager
            .configure(
                "die",
                McpServerRecipe::Stdio {
                    command: cmd.to_string(),
                    args: args.clone(),
                    env: HashMap::new(),
                    cwd: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect("server connects");

        let entry = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .expect("unexpected close must notify listeners")
            .expect("failed entry must be sent");
        assert_eq!(entry.status, "failed");
        assert!(
            entry
                .error
                .as_deref()
                .unwrap_or("")
                .contains("closed unexpectedly"),
            "unexpected error: {:?}",
            entry.error
        );
        assert_eq!(entry.tool_count, 0);

        let _ = std::fs::remove_file(script);
    }

    /// v2 precedence: per-server → env → `[mcp]` section → 30s default
    /// (connection-manager.ts:310-314, 389-390).
    #[test]
    fn test_timeout_resolution_precedence() {
        assert_eq!(resolve_startup_timeout(Some(5), Some(6), Some(7)), 5);
        assert_eq!(resolve_startup_timeout(None, Some(6), Some(7)), 6);
        assert_eq!(resolve_startup_timeout(None, None, Some(7)), 7);
        assert_eq!(
            resolve_startup_timeout(None, None, None),
            DEFAULT_MCP_STARTUP_TIMEOUT_MS
        );

        assert_eq!(resolve_tool_timeout(Some(5), Some(6), Some(7)), Some(5));
        assert_eq!(resolve_tool_timeout(None, Some(6), Some(7)), Some(6));
        assert_eq!(resolve_tool_timeout(None, None, Some(7)), Some(7));
        assert_eq!(resolve_tool_timeout(None, None, None), None);
    }

    /// `[mcp]` defaults apply when the server declares no timeout of its own.
    #[tokio::test]
    async fn test_global_defaults_apply_to_servers_without_timeouts() {
        let manager = McpManager::new();
        manager
            .set_default_timeouts(crate::config::McpTimeoutConfig {
                startup_timeout_ms: Some(2_000),
                tool_timeout_ms: Some(3_000),
            })
            .await;
        manager
            .configure("mock", McpServerRecipe::Mock, McpServerOptions::default())
            .await
            .expect("mock server connects");

        let timeouts = manager.timeouts.read().await;
        let resolved = timeouts.get("mock").expect("timeouts recorded");
        assert_eq!(resolved.startup, Duration::from_millis(2_000));
        assert_eq!(resolved.tool, Some(Duration::from_millis(3_000)));
    }

    /// `on_status_change` fans the public entry out on every status transition
    /// (v2 `onStatusChange` + `emit`, connection-manager.ts:360-378): a mock
    /// server goes `pending` on configure then `connected` after discovery.
    #[tokio::test]
    async fn test_on_status_change_fires_on_transitions() {
        let manager = McpManager::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<McpServerEntry>::new()));
        let recorder = seen.clone();
        let sub = manager.on_status_change(Box::new(move |entry| {
            recorder.lock().unwrap().push(entry);
        }));

        manager
            .configure("mock", McpServerRecipe::Mock, McpServerOptions::default())
            .await
            .expect("mock server connects");

        {
            let entries = seen.lock().unwrap();
            assert_eq!(entries.len(), 2, "pending then connected");
            assert_eq!(entries[0].name, "mock");
            assert_eq!(entries[0].status, "pending");
            assert_eq!(entries[1].name, "mock");
            assert_eq!(entries[1].status, "connected");
            assert_eq!(entries[1].tool_count, 1);
        }

        // Unsubscribing stops further notifications.
        assert!(manager.unsubscribe_status(sub));
        manager.mark_removed("mock").await;
        assert_eq!(seen.lock().unwrap().len(), 2, "no emit after unsubscribe");
    }

    /// The resolved tool timeout reaches the client (v2 passes
    /// `toolCallTimeoutMs` into every client).
    #[tokio::test]
    async fn test_tool_timeout_reaches_client() {
        let manager = McpManager::new();
        manager
            .configure(
                "mock",
                McpServerRecipe::Mock,
                McpServerOptions {
                    tool_timeout_ms: Some(1_500),
                    ..Default::default()
                },
            )
            .await
            .expect("mock server connects");

        let client = {
            let clients = manager.clients.read().await;
            clients.get("mock").cloned().expect("client registered")
        };
        assert_eq!(client.tool_timeout(), Some(Duration::from_millis(1_500)));
    }

    /// A server that accepts the connection but never answers the handshake
    /// must fail with the v2 timeout text instead of hanging the caller
    /// (connection-manager.ts:594-611).
    #[tokio::test]
    async fn test_startup_timeout_marks_failed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Accept and hold every connection open without ever responding.
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });

        let manager = McpManager::new();
        let err = manager
            .configure(
                "hanging",
                McpServerRecipe::Sse {
                    url: format!("http://{addr}/sse"),
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions {
                    startup_timeout_ms: Some(150),
                    ..Default::default()
                },
            )
            .await
            .expect_err("handshake must time out");
        assert_eq!(err, "Timed out after 150ms");

        let entries = manager.server_entries().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "failed");
        assert_eq!(entries[0].error.as_deref(), Some("Timed out after 150ms"));
        assert_eq!(entries[0].tool_count, 0);
    }

    /// A Streamable HTTP server is discovered through the `http` recipe
    /// (v2 `HttpMcpClient`).
    #[tokio::test]
    async fn test_http_recipe_discovers_tools() {
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("json").await;
        let manager = McpManager::new();
        manager
            .configure(
                "http-srv",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect("HTTP server connects");

        assert!(manager.handles("mcp__http-srv__echo").await);
        let entries = manager.server_entries().await;
        assert_eq!(entries[0].transport, "http");
        assert_eq!(entries[0].status, "connected");
        assert_eq!(entries[0].tool_count, 1);

        let res = manager
            .call_tool("mcp__http-srv__echo", &json!({}))
            .await
            .expect("tool call failed");
        assert!(!res.is_error);
        assert_eq!(res.content, "ok");
    }

    /// A bare `url` defaults to Streamable HTTP; legacy SSE needs an explicit
    /// transport (v2 config preprocess, config-schema.ts:58-65).
    #[test]
    fn test_recipe_from_config_transport_defaults() {
        let url_only = crate::config::McpServerConfig {
            url: Some("http://example.test/mcp".into()),
            ..Default::default()
        };
        assert!(matches!(
            recipe_from_config(&url_only),
            Some(McpServerRecipe::Http { .. })
        ));

        let explicit_sse = crate::config::McpServerConfig {
            url: Some("http://example.test/sse".into()),
            transport: Some("sse".into()),
            ..Default::default()
        };
        assert!(matches!(
            recipe_from_config(&explicit_sse),
            Some(McpServerRecipe::Sse { .. })
        ));

        let command_only = crate::config::McpServerConfig {
            command: Some("mcp-server".into()),
            ..Default::default()
        };
        assert!(matches!(
            recipe_from_config(&command_only),
            Some(McpServerRecipe::Stdio { .. })
        ));

        let unknown = crate::config::McpServerConfig {
            url: Some("http://example.test/mcp".into()),
            transport: Some("carrier-pigeon".into()),
            ..Default::default()
        };
        assert!(recipe_from_config(&unknown).is_none());
    }

    /// `shutdown` closes every client and forgets all entries
    /// (v2 `shutdown`, connection-manager.ts:303-308).
    #[tokio::test]
    async fn test_shutdown_closes_every_server() {
        let manager = McpManager::new();
        manager.add_client(McpClient::mock("alpha")).await;
        manager.add_client(McpClient::mock("beta")).await;
        let clients: Vec<Arc<McpClient>> = {
            let guard = manager.clients.read().await;
            guard.values().cloned().collect()
        };
        assert_eq!(clients.len(), 2);
        assert_eq!(manager.server_entries().await.len(), 2);

        manager.shutdown().await;

        assert!(manager.server_entries().await.is_empty());
        assert!(manager.list_tool_infos().await.is_empty());
        for client in clients {
            assert!(client.is_closed(), "shutdown must close every client");
        }
    }

    /// `mark_removed` keeps the entry visible with status `removed` and drops
    /// its tools (v2 `markRemoved`, connection-manager.ts:221-232).
    #[tokio::test]
    async fn test_mark_removed_keeps_entry_without_tools() {
        let manager = McpManager::new();
        manager
            .configure("gone", McpServerRecipe::Mock, McpServerOptions::default())
            .await
            .expect("mock server connects");
        assert!(manager.handles("mcp__gone__gone_sample_tool").await);
        assert!(manager.mark_removed("gone").await);

        let entries = manager.server_entries().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "removed");
        assert_eq!(entries[0].tool_count, 0);
        assert!(entries[0].tools.is_empty());
        assert!(!manager.handles("mcp__gone__gone_sample_tool").await);
        assert!(!manager.mark_removed("never-configured").await);
    }

    /// A tool whose inputSchema is not a JSON object fails the whole server
    /// (v2 `assertMcpInputSchema`, mcpCore/types.ts:44-55).
    #[tokio::test]
    async fn test_invalid_input_schema_fails_the_server() {
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("bad-schema").await;
        let manager = McpManager::new();
        let err = manager
            .configure(
                "bad-schema",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect_err("a non-object inputSchema must fail the server");
        assert_eq!(
            err,
            "Invalid inputSchema for MCP tool \"echo\": schema must be a JSON object"
        );

        let entries = manager.server_entries().await;
        assert_eq!(entries[0].status, "failed");
        assert_eq!(entries[0].error.as_deref(), Some(err.as_str()));
        assert!(!manager.handles("mcp__bad-schema__echo").await);
    }

    /// `bearerTokenEnvVar` resolves to an `Authorization: Bearer …` header at
    /// connect time, replacing any static Authorization header
    /// (v2 `buildMcpRemoteHeaders`, client-remote.ts:9-23).
    #[tokio::test]
    async fn test_bearer_token_env_var_is_sent() {
        let var = format!("KIMI_TEST_MCP_BEARER_{}", std::process::id());
        // SAFETY: the variable name is unique to this test process and no
        // other test reads it.
        unsafe { std::env::set_var(&var, "s3cret") };

        let (url, seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("json").await;
        let manager = McpManager::new();
        manager
            .configure(
                "auth",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::from([(
                        "Authorization".to_string(),
                        "Bearer stale".to_string(),
                    )]),
                    bearer_token_env_var: Some(var.clone()),
                },
                McpServerOptions::default(),
            )
            .await
            .expect("bearer-token server connects");

        let requests = seen.lock().await.clone();
        assert!(!requests.is_empty());
        for request in &requests {
            assert_eq!(
                request.authorization.as_deref(),
                Some("Bearer s3cret"),
                "the resolved token replaces the static Authorization header"
            );
        }

        // SAFETY: see above.
        unsafe { std::env::remove_var(&var) };
    }

    /// A missing or empty bearer token variable fails the server with the v2
    /// message (client-remote.ts:12-16).
    #[tokio::test]
    async fn test_missing_bearer_token_env_var_fails_the_server() {
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("json").await;
        let manager = McpManager::new();
        let err = manager
            .configure(
                "auth",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: Some("KIMI_TEST_MCP_MISSING_BEARER".into()),
                },
                McpServerOptions::default(),
            )
            .await
            .expect_err("a missing token must fail the server");
        assert_eq!(
            err,
            "MCP HTTP bearer token env var \"KIMI_TEST_MCP_MISSING_BEARER\" is not set or is empty"
        );
        let entries = manager.server_entries().await;
        assert_eq!(entries[0].status, "failed");
        assert_eq!(entries[0].error.as_deref(), Some(err.as_str()));
    }

    /// A 401 marks the server `needs-auth` instead of `failed`, and an OAuth
    /// credential from the store is injected as a bearer token
    /// (v2 `shouldMarkNeedsAuth` + `resolveOAuthProvider`).
    #[tokio::test]
    async fn test_oauth_token_injection_and_needs_auth_status() {
        // 1. No credentials + 401 → needs-auth. The OAuth service must be
        // installed for the flip (v2 `shouldMarkNeedsAuth` returns false when
        // `oauthService === undefined`).
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("401").await;
        let manager = McpManager::new();
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::mcp::oauth::McpOAuthFileStore::new(dir.path()));
        manager
            .set_oauth_service(Arc::new(crate::mcp::oauth::McpOAuthService::new(store)))
            .await;
        manager
            .configure(
                "auth-srv",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect_err("401 must fail the connect");
        let entries = manager.server_entries().await;
        assert_eq!(entries[0].status, "needs-auth");

        // 2. With stored credentials the token is sent.
        let (url, seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("json").await;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::mcp::oauth::McpOAuthFileStore::new(dir.path()));
        let key = crate::mcp::oauth::mcp_oauth_store_key("oauth-srv", &url).unwrap();
        store
            .write(
                &key,
                &crate::mcp::oauth::McpOAuthTokens {
                    access_token: "oauth-token".into(),
                    refresh_token: None,
                    expires_at_ms: None,
                    token_endpoint: None,
                    client_id: None,
                },
            )
            .unwrap();
        manager
            .set_oauth_service(Arc::new(crate::mcp::oauth::McpOAuthService::new(store)))
            .await;
        manager
            .configure(
                "oauth-srv",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect("token-authenticated server connects");

        let requests = seen.lock().await.clone();
        assert!(!requests.is_empty());
        assert_eq!(
            requests[0].authorization.as_deref(),
            Some("Bearer oauth-token")
        );
    }

    /// v2 `shouldMarkNeedsAuth` decision matrix (connection-manager.ts:383-393):
    /// only remote servers without a static credential flip to `needs-auth`,
    /// and only on 401 / Unauthorized-like failures.
    #[test]
    fn test_should_mark_needs_auth_matrix() {
        let http = McpServerRecipe::Http {
            url: "http://example.test/mcp".into(),
            headers: HashMap::new(),
            bearer_token_env_var: None,
        };
        let stdio = McpServerRecipe::Stdio {
            command: "mcp-server".into(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: None,
        };
        let with_headers = McpServerRecipe::Http {
            url: "http://example.test/mcp".into(),
            headers: HashMap::from([("X-Api-Key".to_string(), "k".to_string())]),
            bearer_token_env_var: None,
        };
        let with_bearer = McpServerRecipe::Http {
            url: "http://example.test/mcp".into(),
            headers: HashMap::new(),
            bearer_token_env_var: Some("KIMI_MCP_TOKEN".into()),
        };

        // No OAuth service installed → never needs-auth.
        assert!(!should_mark_needs_auth(&http, false, "401"));
        // stdio servers never participate in the OAuth flow.
        assert!(!should_mark_needs_auth(&stdio, true, "401"));
        // A pinned static credential means the 401 is a bad header.
        assert!(!should_mark_needs_auth(&with_headers, true, "401"));
        assert!(!should_mark_needs_auth(&with_bearer, true, "401"));
        // Remote without credentials + 401 / Unauthorized → needs-auth.
        assert!(should_mark_needs_auth(&http, true, "401"));
        assert!(should_mark_needs_auth(
            &http,
            true,
            "UnauthorizedError: token expired"
        ));
        assert!(should_mark_needs_auth(&http, true, "HTTP 401 Unauthorized"));
        // Other failures stay failed.
        assert!(!should_mark_needs_auth(&http, true, "connection refused"));
    }

    /// A static `headers` block on a 401 server must surface `failed`, not
    /// `needs-auth` — the real error is a bad header, not a missing OAuth
    /// token (v2 `shouldMarkNeedsAuth` headers exemption).
    #[tokio::test]
    async fn test_static_headers_401_is_failed_not_needs_auth() {
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("401").await;
        let manager = McpManager::new();
        manager
            .configure(
                "static-headers",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::from([("X-Api-Key".to_string(), "k".to_string())]),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect_err("401 must fail the connect");
        let entries = manager.server_entries().await;
        assert_eq!(
            entries[0].status, "failed",
            "static headers must not flip the entry to needs-auth"
        );
    }

    /// A pinned `bearerTokenEnvVar` on a 401 server must surface `failed`, not
    /// `needs-auth` (v2 `shouldMarkNeedsAuth` bearer exemption).
    #[tokio::test]
    async fn test_bearer_env_var_401_is_failed_not_needs_auth() {
        let var = format!("KIMI_TEST_MCP_BEARER_401_{}", std::process::id());
        // SAFETY: the variable name is unique to this test process and no
        // other test reads it.
        unsafe { std::env::set_var(&var, "bad-token") };

        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("401").await;
        let manager = McpManager::new();
        manager
            .configure(
                "bearer-401",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: Some(var.clone()),
                },
                McpServerOptions::default(),
            )
            .await
            .expect_err("401 must fail the connect");
        let entries = manager.server_entries().await;
        assert_eq!(
            entries[0].status, "failed",
            "a pinned bearer token must not flip the entry to needs-auth"
        );

        // SAFETY: see above.
        unsafe { std::env::remove_var(&var) };
    }
}
