//! Dynamic MCP server manager and tool registry.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::RwLock;

use crate::mcp::client::McpClient;
use crate::mcp::errors::McpError;
use crate::mcp::types::McpTool;
use crate::native::tool_naming::qualify_mcp_tool_name;
use crate::server::files::FileStore;
use crate::turn_loop::types::{ExecutableToolResult, ToolDelivery};

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

/// One thing a session should tell the user at startup. The wire shape the
/// host renders (`{ code, message, severity }`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpSessionWarning {
    pub code: String,
    pub message: String,
    /// `"warning"` — a degraded session, not a failed one. The host maps
    /// anything that is not `"error"` to a warning.
    pub severity: String,
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
    /// Whether this server's tools are disclosed on demand rather than in the
    /// top-level tool list (v2 `disclosure: 'deferred'`).
    deferred: bool,
    /// When the live connection was established (v2 `entry.connectedAt`,
    /// connection-manager.ts:37). Compared against a stored grant's obtain
    /// time to tell a concurrent login from the credential a 401 rejected.
    connected_at_ms: Option<i64>,
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
    /// Keep this server's tools out of the top-level tool list and load them on
    /// demand through `select_tools` (v2 per-server `deferred`). The caller
    /// applies the gate — the `tool_select` flag plus the model's
    /// `dynamically_loaded_tools` capability — before setting it; the manager
    /// only records the disclosure this server was registered with.
    pub deferred: bool,
}

impl Default for McpServerOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            enabled_tools: None,
            disabled_tools: None,
            startup_timeout_ms: None,
            tool_timeout_ms: None,
            deferred: false,
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
    /// Where media an MCP server returns is preserved (v2
    /// `McpConnectionManagerOptions.attachmentStore`, upstream #3688). The
    /// default store is the daemon's own blob store, which is what the request
    /// media resolver reads a `kimi-file://` reference back from.
    attachments: Arc<RwLock<FileStore>>,
    /// Status-change listeners (v2 `listeners`, connection-manager.ts:360-378).
    status_listeners: Arc<Mutex<Vec<(McpStatusSubscription, McpStatusListener)>>>,
    next_status_id: std::sync::atomic::AtomicU64,
    /// Initial-load readiness (v2 `connectAll` / `waitForInitialLoad`,
    /// connection-manager.ts:170-181, :235-241). Starts `true` — "nothing to
    /// wait for" — because a manager built by the server/REPL path connects
    /// through [`Self::spawn_from_config`], which awaits its own connects, and
    /// one built by `add_client`/`configure` has no initial load at all.
    /// [`Self::connect_all`] clears it, then sets it once the connects settle.
    ///
    /// `watch` rather than `Notify`: a notify that lands before the wait would
    /// be lost, and the wait is usually entered after the load already ended.
    ready_tx: tokio::sync::watch::Sender<bool>,
    ready_rx: tokio::sync::watch::Receiver<bool>,
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl McpManager {
    pub fn new() -> Self {
        let (ready_tx, ready_rx) = tokio::sync::watch::channel(true);
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            cached_tools: Arc::new(RwLock::new(HashMap::new())),
            servers: Arc::new(RwLock::new(HashMap::new())),
            filters: Arc::new(RwLock::new(HashMap::new())),
            timeouts: Arc::new(RwLock::new(HashMap::new())),
            defaults: Arc::new(RwLock::new(crate::config::McpTimeoutConfig::default())),
            in_flight: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            oauth: Arc::new(RwLock::new(None)),
            attachments: Arc::new(RwLock::new(FileStore::new())),
            status_listeners: Arc::new(Mutex::new(Vec::new())),
            next_status_id: std::sync::atomic::AtomicU64::new(1),
            ready_tx,
            ready_rx,
        }
    }

    /// Start connecting every server and return immediately (v2 `connectAll`,
    /// connection-manager.ts:170-181). The returned handle settles when every
    /// connect has, and flips [`Self::wait_for_initial_load`] back to ready.
    ///
    /// Session creation uses this instead of awaiting each `configure`: the
    /// tool table reads the manager live (`callbacks.rs::list_tools`), so a
    /// server that connects later still contributes its tools.
    pub fn connect_all(
        self: &Arc<Self>,
        servers: Vec<(String, McpServerRecipe, McpServerOptions)>,
    ) -> tokio::task::JoinHandle<()> {
        // Cleared before the spawn so a consumer that reads readiness between
        // the two cannot observe "ready" while the connects are still running.
        self.ready_tx.send_replace(false);
        let manager = self.clone();
        tokio::spawn(async move {
            let tasks = servers.into_iter().map(|(name, recipe, options)| {
                let manager = manager.clone();
                async move {
                    let _ = manager.configure(&name, recipe, options).await;
                }
            });
            futures_util::future::join_all(tasks).await;
            manager.ready_tx.send_replace(true);
        })
    }

    /// Await the initial load started by [`Self::connect_all`] (v2
    /// `waitForInitialLoad`, connection-manager.ts:235-241). Returns at once
    /// when the load already finished, and when none was ever started.
    pub async fn wait_for_initial_load(&self) {
        if *self.ready_rx.borrow() {
            return;
        }
        let mut rx = self.ready_rx.clone();
        let _ = rx.wait_for(|ready| *ready).await;
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
        let listeners = self
            .status_listeners
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        fan_out_status(&listeners, &entry);
    }

    /// Install the OAuth credential service used for remote servers
    /// (v2 `McpConnectionManagerOptions.oauthService`).
    pub async fn set_oauth_service(&self, service: Arc<crate::mcp::oauth::McpOAuthService>) {
        *self.oauth.write().await = Some(service);
    }

    /// Point attachment preservation at an explicit store (tests, or a host
    /// that keeps session blobs somewhere else).
    pub async fn set_attachment_store(&self, store: FileStore) {
        *self.attachments.write().await = store;
    }

    async fn oauth_service(&self) -> Option<Arc<crate::mcp::oauth::McpOAuthService>> {
        self.oauth.read().await.clone()
    }

    /// The clock status transitions compare against: the OAuth service's when
    /// one is installed, system time otherwise (v2
    /// `this.oauthService?.now() ?? Date.now()`, connection-manager.ts:382).
    async fn oauth_clock(&self) -> i64 {
        match self.oauth_service().await {
            Some(service) => service.now(),
            None => chrono::Utc::now().timestamp_millis(),
        }
    }

    /// Flip a server to `needs-auth` after a *call* was rejected with 401 and
    /// report whether the entry moved (v2 `markNeedsAuth`,
    /// connection-manager.ts:307-347). A live entry only reaches this from
    /// `connected` — a call cannot be made against anything else — but
    /// `needs-auth` is accepted so a second rejected call is idempotent.
    ///
    /// `client` binds the report to the connection it came from: a call that
    /// failed on a client that has since been replaced must not flip the live
    /// entry (v2 `entry.client !== client`). A grant obtained within the
    /// concurrency window is treated as a login that landed alongside this
    /// connection, so it neither flips the entry nor gets invalidated.
    pub async fn mark_needs_auth(
        &self,
        name: &str,
        error: &McpError,
        client: Option<&Arc<McpClient>>,
    ) -> bool {
        let oauth = self.oauth_service().await;
        let (recipe, status, connected_at_ms) = {
            let servers = self.servers.read().await;
            let Some(state) = servers.get(name) else {
                return false;
            };
            (
                state.recipe.clone(),
                state.status.clone(),
                state.connected_at_ms,
            )
        };
        if status != "connected" && status != "needs-auth" {
            return false;
        }
        if !should_mark_needs_auth(&recipe, oauth.is_some(), error.is_unauthorized()) {
            return false;
        }
        if status == "needs-auth" {
            return true;
        }
        if let Some(client) = client {
            let live = self.clients.read().await.get(name).cloned();
            if !live.is_some_and(|live| Arc::ptr_eq(&live, client)) {
                return false;
            }
        }
        let key = match &recipe {
            McpServerRecipe::Sse { url, .. } | McpServerRecipe::Http { url, .. } => {
                crate::mcp::oauth::mcp_oauth_store_key(name, url).ok()
            }
            _ => None,
        };
        let rejected = match (&key, oauth.as_ref()) {
            (Some(key), Some(service)) => service.peek_rejected_grant(key, connected_at_ms),
            _ => None,
        };
        if rejected.as_ref().is_some_and(|(_, concurrent)| *concurrent) {
            return false;
        }
        // Close the live client and drop its tools before flipping, so the
        // entry cannot keep serving a tool list the model can no longer call.
        if let Some(dead) = self.clients.write().await.remove(name) {
            dead.close().await;
        }
        {
            let mut cached = self.cached_tools.write().await;
            cached.retain(|_, (srv, _)| srv != name);
        }
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = "needs-auth".into();
            state.error = Some(format!(
                "{name} requires OAuth — run /mcp-config login {name}"
            ));
            state.raw_tools.clear();
        }
        // The rejected credential must not be replayed on the next connect,
        // but only while it is still the one that failed: a login that landed
        // in between owns the store now. Cleanup failures are non-fatal — the
        // entry is already needs-auth either way.
        if let (Some((tokens, _)), Some(service), Some(key)) = (rejected, oauth.as_ref(), key)
            && let Err(e) = service.clear_tokens_if_current(&key, &tokens)
        {
            tracing::warn!(
                server = %name,
                reason = %e,
                "mcp oauth token invalidation failed"
            );
        }
        self.emit_status(name).await;
        true
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
    async fn register_client(&self, mut client: McpClient) -> Result<usize, McpError> {
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
                return Err(McpError::transport(format!(
                    "Invalid inputSchema for MCP tool \"{}\": schema must be a JSON object",
                    tool.name
                )));
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
                // Only the qualified name is indexed: v2 registers the
                // `mcp__<server>__<tool>` form exclusively, and a plain-name
                // alias across servers was last-writer-wins — the model could
                // have its call routed to the wrong server. The model tool
                // table only ever advertises qualified names.
                cached.insert(qualified_name, (name.clone(), tool.clone()));
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
            // The index holds qualified names only; the prefix test is the
            // invariant that keeps a plain name from ever reaching the model.
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

    /// The names of the tools whose server was registered as deferred (v2
    /// `disclosure: 'deferred'`). The top-level tool table drops these and
    /// `select_tools` offers them instead, so a deferred server's schemas stop
    /// occupying context until the model asks for them.
    pub async fn deferred_tool_names(&self) -> HashSet<String> {
        let servers = self.servers.read().await;
        let cached = self.cached_tools.read().await;
        cached
            .iter()
            .filter(|(name, (server, _))| {
                name.starts_with("mcp__") && servers.get(server).is_some_and(|state| state.deferred)
            })
            .map(|(name, _)| name.clone())
            .collect()
    }

    /// Blocking variant of [`Self::deferred_tool_names`] for the tool-table
    /// shaping path, which runs both on and off the async runtime (tests,
    /// the sync `shape_tool_table` builder). `try_read` on a read-only
    /// cache snapshot: contended writes are rare and a miss degrades to
    /// "no deferred tools", the pre-disclosure behaviour.
    pub fn deferred_tool_names_blocking(&self) -> HashSet<String> {
        let servers = self.servers.try_read();
        let cached = self.cached_tools.try_read();
        if let (Ok(servers), Ok(cached)) = (servers, cached) {
            cached
                .iter()
                .filter(|(name, (server, _))| {
                    name.starts_with("mcp__") && servers.get(server).is_some_and(|s| s.deferred)
                })
                .map(|(name, _)| name.clone())
                .collect()
        } else {
            HashSet::new()
        }
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

    /// The startup warnings this roster implies: a server the engine could not
    /// connect, or one waiting on the user's authorization. A healthy roster
    /// produces none, and a disabled server is not a warning — the user turned
    /// it off on purpose.
    ///
    /// This is what a session surfaces once at startup, so a user whose MCP
    /// tools are missing learns why instead of finding an empty tool list.
    pub async fn session_warnings(&self) -> Vec<McpSessionWarning> {
        self.server_entries()
            .await
            .into_iter()
            .filter_map(|entry| match entry.status.as_str() {
                "failed" => Some(McpSessionWarning {
                    code: "mcp.server_failed".into(),
                    message: match entry.error {
                        Some(error) => format!("MCP server \"{}\" failed: {error}", entry.name),
                        None => format!("MCP server \"{}\" failed to connect", entry.name),
                    },
                    severity: "warning".into(),
                }),
                "needs-auth" => Some(McpSessionWarning {
                    code: "mcp.server_needs_auth".into(),
                    message: format!(
                        "MCP server \"{}\" needs authorization before its tools are available",
                        entry.name
                    ),
                    severity: "warning".into(),
                }),
                _ => None,
            })
            .collect()
    }

    /// Remove a registered or connected MCP server.
    pub async fn remove_server(&self, name: &str) -> bool {
        // Take everything out under the locks first, then close the client
        // without holding them: a kill must not freeze the whole manager while
        // other tasks wait on the client/server maps.
        let removed_server = self.servers.write().await.remove(name).is_some();
        let removed_client = self.clients.write().await.remove(name);
        self.cached_tools
            .write()
            .await
            .retain(|_, (s, _)| s != name);
        self.filters.write().await.remove(name);
        self.timeouts.write().await.remove(name);
        let had_client = removed_client.is_some();
        if let Some(client) = removed_client {
            client.close().await;
        }
        removed_server || had_client
    }

    /// Close a server but keep its entry as `removed` (v2 `markRemoved`,
    /// connection-manager.ts:221-232): the tools disappear while the name
    /// stays visible so callers can report that the server was removed.
    pub async fn mark_removed(&self, name: &str) -> bool {
        let client = self.clients.write().await.remove(name);
        let known = client.is_some() || self.servers.read().await.contains_key(name);
        if !known {
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
        // Close after the state flip and without holding any map lock.
        if let Some(client) = client {
            client.close().await;
        }
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

    /// Call an MCP tool dynamically.
    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: &Value,
        cancelled: Option<&(dyn Fn() -> bool + Sync)>,
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
                // Media is preserved and handed to the model as a reference the
                // request resolver turns into whatever the active model can
                // take; an original the model never sees is still retrievable
                // (v2 `mcpResultToExecutableOutput`, upstream #3688).
                let attachments = self.attachments.read().await.clone();
                let converted = crate::mcp::output::mcp_result_to_output(
                    &res,
                    Some(&attachments),
                    None,
                    cancelled,
                );
                let mut text_parts = vec![converted.content];
                if res.structured_content.is_some() || res.meta.is_some() {
                    let mut extras = serde_json::Map::new();
                    if let Some(sc) = res.structured_content {
                        extras.insert("structuredContent".to_string(), sc);
                    }
                    if let Some(m) = res.meta {
                        extras.insert("_meta".to_string(), m);
                    }
                    let extras_json =
                        serde_json::to_string_pretty(&Value::Object(extras)).unwrap_or_default();
                    text_parts.push(format!(
                        "<mcp-result-extras>\n{}\n</mcp-result-extras>",
                        extras_json
                    ));
                }
                Some(ExecutableToolResult {
                    delivery: (!converted.delivery.is_empty()).then_some(ToolDelivery {
                        blocks: converted.delivery,
                    }),
                    stop_turn: false,
                    content: text_parts.join("\n"),
                    is_error: res.is_error,
                    note: Some(format!("mcp:{}", server_name)),
                })
            }
            Err(e) => {
                // A 401 on a *call* means the stored credential was rejected,
                // not that the arguments were wrong: flip the server to
                // `needs-auth` and hand back an actionable message instead of
                // a bare execution error (v2 `throwIfUnauthorized`,
                // agent/mcp/tools/mcp.ts:78-91). Application-level tool
                // failures never reach this branch — the transport reports
                // them as `Ok` with `is_error` set — so v2's "ignore McpError"
                // sniff filter has no work to do here.
                let unauthorized = self.mark_needs_auth(&server_name, &e, Some(&client)).await;
                let content = if unauthorized {
                    format!(
                        "MCP server \"{server_name}\" rejected the call with 401 Unauthorized and \
                         is now marked needs-auth. Run /mcp-config login {server_name} to complete \
                         the OAuth login, then retry the original call."
                    )
                } else {
                    format!("MCP execution error: {e}")
                };
                Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content,
                    is_error: true,
                    note: Some(format!("mcp:{}", server_name)),
                })
            }
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
                    // The CLI config path has no model in hand, so the
                    // `tool_select` + `dynamically_loaded_tools` gate cannot be
                    // applied here — every server is disclosed inline, which is
                    // also what `Default` records. The napi path, which does
                    // know the gate, passes the host's verdict instead.
                    deferred: false,
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
                deferred: options.deferred,
                connected_at_ms: None,
            },
        );
        self.emit_status(name).await;
        if !options.enabled {
            return Ok(());
        }
        // connect_one marks the entry failed/needs-auth itself; its returned
        // error already carries any captured child stderr.
        self.connect_one(name).await
    }

    /// Mark a failed connect on the entry: `needs-auth` when the failure is a
    /// 401 on a server without a static credential, otherwise `failed`
    /// (v2 `connectOne` catch branch + `shouldMarkNeedsAuth`). `display` is
    /// the (possibly stderr-augmented) text stored on the entry.
    async fn mark_connect_failure(&self, name: &str, error: &McpError, display: &str) {
        let oauth_installed = self.oauth_service().await.is_some();
        let recipe = self
            .servers
            .read()
            .await
            .get(name)
            .map(|s| s.recipe.clone());
        let status = match recipe {
            Some(recipe)
                if should_mark_needs_auth(&recipe, oauth_installed, error.is_unauthorized()) =>
            {
                "needs-auth"
            }
            _ => "failed",
        };
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = status.into();
            state.error = Some(display.to_string());
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
        // Captured before the client moves into `register_client`, so a
        // discovery failure can still carry the child's diagnostics
        // (v2 `formatStartupError`, connection-manager.ts:545-574).
        let mut stderr_tail = String::new();
        let connect = async {
            let client = match &recipe {
                McpServerRecipe::Sse {
                    url,
                    headers,
                    bearer_token_env_var,
                } => {
                    let mut headers =
                        resolve_bearer_headers("SSE", headers, bearer_token_env_var.as_deref())
                            .map_err(McpError::transport)?;
                    self.apply_oauth_header(name, url, &mut headers).await;
                    McpClient::connect_sse(name, url, headers).await?
                }
                McpServerRecipe::Http {
                    url,
                    headers,
                    bearer_token_env_var,
                } => {
                    let mut headers =
                        resolve_bearer_headers("HTTP", headers, bearer_token_env_var.as_deref())
                            .map_err(McpError::transport)?;
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
            stderr_tail = client.stderr_snapshot();
            let count = self.register_client(client).await?;
            // Watch for the transport dying after the handshake (v2
            // `watchForUnexpectedClose`, connection-manager.ts:321-341).
            if let Some(client_arc) = self.clients.read().await.get(name).cloned() {
                self.watch_unexpected_close(name, client_arc).await;
            }
            Ok::<usize, McpError>(count)
        };
        // v2 wraps connect + tool discovery in `withTimeout` and reports
        // `Timed out after <ms>ms` (connection-manager.ts:594-611).
        match tokio::time::timeout(startup, connect).await {
            Ok(Ok(_)) => {
                // The transport may have died in the gap between discovery
                // finishing and this status write; never overwrite that
                // failure with `connected`.
                let closed = self
                    .clients
                    .read()
                    .await
                    .get(name)
                    .is_some_and(|client| client.is_closed());
                if closed {
                    let error = McpError::closed("MCP server closed during the handshake");
                    let display = error.to_string();
                    self.mark_connect_failure(name, &error, &display).await;
                    return Err(display);
                }
            }
            Ok(Err(error)) => {
                let display = if stderr_tail.is_empty() {
                    error.to_string()
                } else {
                    format!("{error}\nstderr: {}", stderr_tail.trim_end())
                };
                self.mark_connect_failure(name, &error, &display).await;
                return Err(display);
            }
            Err(_) => {
                let display = format!("Timed out after {}ms", startup.as_millis());
                let error = McpError::timeout(display.clone());
                self.mark_connect_failure(name, &error, &display).await;
                return Err(display);
            }
        }
        let connected_at_ms = self.oauth_clock().await;
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = "connected".into();
            state.error = None;
            state.connected_at_ms = Some(connected_at_ms);
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
                    fan_out_status(&listeners, &entry);
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
        // The close happens outside the map locks so it cannot block the
        // manager while the child is being killed.
        let dead = self.clients.write().await.remove(name);
        self.cached_tools
            .write()
            .await
            .retain(|_, (srv, _)| srv != name);
        if let Some(state) = self.servers.write().await.get_mut(name) {
            state.status = "pending".into();
            state.error = None;
            state.raw_tools.clear();
        }
        if let Some(dead) = dead {
            dead.close().await;
        }
        self.emit_status(name).await;
        // connect_one marks the failure state itself.
        self.connect_one(name).await
    }
}

fn tool_to_json(tool: &McpTool) -> Value {
    serde_json::json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": tool.input_schema,
    })
}

/// Fan one public entry out to every status listener. Failed / needs-auth
/// transitions are logged first, and a panicking listener must not break the
/// connection manager (v2 wraps listener calls in try/catch). The single
/// shared fan-out keeps `emit_status` and the unexpected-close watcher
/// identical (logging + panic isolation included).
fn fan_out_status(
    listeners: &[(McpStatusSubscription, McpStatusListener)],
    entry: &McpServerEntry,
) {
    if entry.status == "failed" || entry.status == "needs-auth" {
        tracing::error!(
            server = %entry.name,
            transport = %entry.transport,
            status = %entry.status,
            reason = ?entry.error,
            "mcp server unavailable"
        );
    }
    for (_, listener) in listeners {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            listener(entry.clone());
        }));
    }
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

/// Whether a failure should flip the entry into `needs-auth` instead of
/// `failed` (v2 `shouldMarkNeedsAuth`, connection-manager.ts:383-393):
/// only remote servers without a static credential participate in the OAuth
/// flow, and only when the transport classified the failure as HTTP 401.
fn should_mark_needs_auth(
    recipe: &McpServerRecipe,
    oauth_installed: bool,
    unauthorized: bool,
) -> bool {
    if !oauth_installed || !unauthorized {
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
    true
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

        // Only the qualified name exists: plain aliases were removed
        // (last-writer-wins across servers could misroute a model call).
        assert!(manager.handles("mcp__github__github_sample_tool").await);
        assert!(!manager.handles("github_sample_tool").await);
        assert!(!manager.handles("nonexistent_tool").await);

        // 1. Call via the qualified name
        let res_qualified = manager
            .call_tool(
                "mcp__github__github_sample_tool",
                &json!({ "query": "kimi" }),
                None,
            )
            .await
            .expect("call_tool via qualified name failed");

        assert!(!res_qualified.is_error);
        assert_eq!(
            res_qualified.content,
            "Mock execution of github_sample_tool with {\"query\":\"kimi\"}"
        );
        assert_eq!(res_qualified.note.as_deref(), Some("mcp:github"));

        // 2. A bare tool name is not routable to an MCP server
        let res_plain = manager
            .call_tool("github_sample_tool", &json!({ "query": "kimi" }), None)
            .await;
        assert!(res_plain.is_none(), "plain tool names must not be routed");

        // 3. Call unknown tool returns None
        let res_missing = manager.call_tool("unknown_tool", &json!({}), None).await;
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

        // Discovered tools are indexed by qualified name only (no plain alias)
        assert!(!manager.handles("calculate").await);
        assert!(manager.handles("mcp__calc_server__calculate").await);
        assert!(!manager.handles("echo").await);
        assert!(manager.handles("mcp__calc_server__echo").await);

        // Call tool over SSE
        let res = manager
            .call_tool(
                "mcp__calc_server__calculate",
                &json!({ "expression": "10+32" }),
                None,
            )
            .await
            .expect("tool call failed");

        assert!(!res.is_error);
        assert_eq!(res.content, "result: 42");
        assert_eq!(res.note.as_deref(), Some("mcp:calc_server"));

        // Application-level error tool call
        let err_res = manager
            .call_tool("mcp__calc_server__trigger_tool_error", &json!({}), None)
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

    /// `connect_all` starts the connects and returns without waiting for them
    /// (v2 `connectAll`, connection-manager.ts:170-181). Session creation uses
    /// it so a slow server no longer blocks the session; the readiness it
    /// flips is what the tool table awaits instead.
    #[tokio::test]
    async fn test_connect_all_returns_before_the_connects_settle() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Accept and hold every connection open without ever responding, so
        // the connect can only end through its startup timeout.
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });

        let manager = Arc::new(McpManager::new());
        let start = std::time::Instant::now();
        manager.connect_all(vec![(
            "slow".to_string(),
            McpServerRecipe::Sse {
                url: format!("http://{addr}/sse"),
                headers: HashMap::new(),
                bearer_token_env_var: None,
            },
            McpServerOptions {
                startup_timeout_ms: Some(300),
                ..Default::default()
            },
        )]);
        assert!(
            start.elapsed() < Duration::from_millis(150),
            "connect_all blocked for {:?}; it must only start the connects",
            start.elapsed()
        );

        manager.wait_for_initial_load().await;
        assert!(
            start.elapsed() >= Duration::from_millis(250),
            "readiness settled before the connect could time out"
        );

        // Once settled, waiting again is free.
        let after = std::time::Instant::now();
        manager.wait_for_initial_load().await;
        assert!(after.elapsed() < Duration::from_millis(50));
    }

    /// A manager that never started an initial load must not block a consumer
    /// awaiting readiness. The server/REPL path connects through
    /// `spawn_from_config` (which awaits its own connects) and the napi path
    /// can register clients directly, so readiness has to start as "nothing to
    /// wait for" — otherwise `list_tools` would hang forever on those managers.
    #[tokio::test]
    async fn test_wait_for_initial_load_returns_without_a_load() {
        let manager = McpManager::new();
        let start = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(1), manager.wait_for_initial_load())
            .await
            .expect("a manager with no initial load must not block");
        assert!(start.elapsed() < Duration::from_millis(100));
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

    /// A session surfaces the roster's degradations at startup: a server that
    /// failed to connect, and one waiting on authorization. A healthy roster
    /// and a deliberately disabled server produce nothing.
    #[tokio::test]
    async fn test_session_warnings_report_failed_and_needs_auth_servers() {
        let manager = McpManager::new();
        assert!(manager.session_warnings().await.is_empty());

        // A stdio command that cannot spawn: the connect fails outright.
        manager
            .configure(
                "broken",
                McpServerRecipe::Stdio {
                    command: "definitely-not-a-real-binary-xyz".into(),
                    args: Vec::new(),
                    env: HashMap::new(),
                    cwd: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect_err("the spawn must fail");

        let warnings = manager.session_warnings().await;
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert_eq!(warnings[0].code, "mcp.server_failed");
        assert_eq!(warnings[0].severity, "warning");
        assert!(warnings[0].message.contains("broken"), "{warnings:?}");

        // A disabled server is the user's own choice, not a warning.
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
            .expect("a disabled server never connects");
        let warnings = manager.session_warnings().await;
        assert_eq!(
            warnings.len(),
            1,
            "the disabled server adds nothing: {warnings:?}"
        );
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

    /// Two servers exposing a tool with the same plain name both keep their
    /// distinct qualified names, and each qualified call routes to its own
    /// server (regression for the last-writer-wins plain alias).
    #[tokio::test]
    async fn test_same_tool_name_on_two_servers_routes_by_qualified_name() {
        let manager = McpManager::new();
        manager
            .add_client(McpClient::mock_with_tools(
                "alpha",
                vec![McpTool {
                    name: "ping".into(),
                    description: Some("alpha ping".into()),
                    input_schema: json!({ "type": "object" }),
                }],
            ))
            .await;
        manager
            .add_client(McpClient::mock_with_tools(
                "beta",
                vec![McpTool {
                    name: "ping".into(),
                    description: Some("beta ping".into()),
                    input_schema: json!({ "type": "object" }),
                }],
            ))
            .await;

        assert!(manager.handles("mcp__alpha__ping").await);
        assert!(manager.handles("mcp__beta__ping").await);
        let infos = manager.list_tool_infos().await;
        assert_eq!(infos.len(), 2, "both qualified tools are advertised");

        let alpha = manager
            .call_tool("mcp__alpha__ping", &json!({}), None)
            .await
            .expect("alpha call must resolve");
        assert_eq!(alpha.note.as_deref(), Some("mcp:alpha"));
        let beta = manager
            .call_tool("mcp__beta__ping", &json!({}), None)
            .await
            .expect("beta call must resolve");
        assert_eq!(beta.note.as_deref(), Some("mcp:beta"));
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
            // Only the first `set /p` is safe as a barrier: the client writes
            // `initialize` and then waits for its reply, so exactly one line
            // is in flight. After that reply it writes
            // `notifications/initialized` and `tools/list` back to back, and a
            // later `set /p` can swallow both — the third read then blocked
            // forever and the connect hit the 30s startup timeout (flaky under
            // a loaded suite). Waiting instead is deterministic: the wait
            // outlasts the client's own write, so `tools/list` is registered
            // before its reply is echoed and the reply can never be dropped.
            std::fs::write(
                &path,
                format!(
                    "@echo off\r\nset /p _=\r\n@echo {init}\r\n@ping -n 3 127.0.0.1 >nul\r\n@echo {list}\r\n@ping -n 2 127.0.0.1 >nul\r\n@exit /b 0\r\n"
                ),
            )
            .expect("write die script");
            (
                "cmd",
                vec!["/c".to_string(), path.to_string_lossy().into_owned()],
                path,
            )
        } else {
            let path = dir.join(format!("kimi_mcp_die_mgr_{}.sh", std::process::id()));
            // Answer each request as it arrives, then die: a script that echoes
            // both responses up front races the client's second write, and the
            // unmatched response is dropped, so the handshake never completes.
            std::fs::write(
                &path,
                format!(
                    "read -r _; echo '{init}'\nread -r _\nread -r _; echo '{list}'\nsleep 1\nexit 0\n"
                ),
            )
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
            .call_tool("mcp__http-srv__echo", &json!({}), None)
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
                    obtained_at_ms: None,
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

    /// A 401 on a *tool call* — the handshake already succeeded — flips the
    /// server to `needs-auth`, drops its tools, clears the rejected grant and
    /// hands the caller an actionable message (v2 `markNeedsAuth` from the
    /// tool wrapper, connection-manager.ts:307-347 + tools/mcp.ts:78-91, #3846).
    #[tokio::test]
    async fn test_tool_call_401_flips_server_to_needs_auth() {
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("401-on-call").await;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::mcp::oauth::McpOAuthFileStore::new(dir.path()));
        let key = crate::mcp::oauth::mcp_oauth_store_key("stale-srv", &url).unwrap();
        // Obtained well before this connection, so it is the credential the
        // 401 rejects rather than a login landing alongside the connect.
        store
            .write(
                &key,
                &crate::mcp::oauth::McpOAuthTokens {
                    access_token: "stale-token".into(),
                    refresh_token: None,
                    expires_at_ms: None,
                    token_endpoint: None,
                    client_id: None,
                    obtained_at_ms: Some(chrono::Utc::now().timestamp_millis() - 60_000),
                },
            )
            .unwrap();
        let manager = McpManager::new();
        manager
            .set_oauth_service(Arc::new(crate::mcp::oauth::McpOAuthService::new(
                store.clone(),
            )))
            .await;
        manager
            .configure(
                "stale-srv",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect("the handshake succeeds even though every call is rejected");
        assert!(manager.handles("mcp__stale-srv__echo").await);

        let result = manager
            .call_tool("mcp__stale-srv__echo", &json!({}), None)
            .await
            .expect("a failed call still returns a tool result");

        assert!(result.is_error);
        assert!(
            result.content.contains("401 Unauthorized"),
            "unexpected content: {}",
            result.content
        );
        assert!(
            result.content.contains("/mcp-config login stale-srv"),
            "the message must name the remedy: {}",
            result.content
        );

        let entries = manager.server_entries().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "needs-auth");
        assert_eq!(entries[0].tool_count, 0);
        assert!(
            !manager.handles("mcp__stale-srv__echo").await,
            "a needs-auth server must stop advertising tools"
        );
        assert!(
            store
                .read::<crate::mcp::oauth::McpOAuthTokens>(&key)
                .is_none(),
            "the rejected grant must not be replayed on the next connect"
        );

        // A second call finds no tool at all: the flip dropped both the client
        // and the cached tool, so the model cannot retry into the dead server.
        assert!(
            manager
                .call_tool("mcp__stale-srv__echo", &json!({}), None)
                .await
                .is_none()
        );
        assert_eq!(manager.server_entries().await[0].status, "needs-auth");
    }

    /// A grant obtained moments ago — at or after this connection — is a login
    /// landing concurrently, so the old connection's 401 must neither flip the
    /// entry nor invalidate that credential (v2 `isConcurrentGrant`).
    #[tokio::test]
    async fn test_concurrent_grant_survives_a_call_401() {
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("401-on-call").await;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::mcp::oauth::McpOAuthFileStore::new(dir.path()));
        let key = crate::mcp::oauth::mcp_oauth_store_key("racing-srv", &url).unwrap();
        let manager = McpManager::new();
        manager
            .set_oauth_service(Arc::new(crate::mcp::oauth::McpOAuthService::new(
                store.clone(),
            )))
            .await;
        manager
            .configure(
                "racing-srv",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect("an unauthenticated handshake still succeeds");
        assert!(manager.handles("mcp__racing-srv__echo").await);

        // The user completes the OAuth login while this connection is live.
        store
            .write(
                &key,
                &crate::mcp::oauth::McpOAuthTokens {
                    access_token: "fresh-token".into(),
                    refresh_token: None,
                    expires_at_ms: None,
                    token_endpoint: None,
                    client_id: None,
                    obtained_at_ms: Some(chrono::Utc::now().timestamp_millis()),
                },
            )
            .unwrap();

        let result = manager
            .call_tool("mcp__racing-srv__echo", &json!({}), None)
            .await
            .expect("a failed call still returns a tool result");

        assert!(result.is_error);
        assert!(
            result.content.starts_with("MCP execution error:"),
            "a concurrent login must not be reported as needs-auth: {}",
            result.content
        );
        let entries = manager.server_entries().await;
        assert_eq!(entries[0].status, "connected");
        assert!(
            manager.handles("mcp__racing-srv__echo").await,
            "the tool list must survive a rejected call"
        );
        assert_eq!(
            store
                .read::<crate::mcp::oauth::McpOAuthTokens>(&key)
                .map(|t| t.access_token),
            Some("fresh-token".to_string()),
            "a concurrent grant must not be invalidated"
        );
    }

    /// An image an MCP server returns is preserved into the attachment store
    /// and handed to the model as a reference the resolver can inline, instead
    /// of being flattened into a text preview (v2 #3688).
    #[tokio::test]
    async fn test_mcp_media_is_preserved_and_delivered_as_a_reference() {
        let (url, _seen, _shutdown) =
            crate::mcp::http::test_helpers::spawn_mock_http_server("image").await;
        let dir = tempfile::tempdir().unwrap();
        let store = crate::server::files::FileStore::with_root(dir.path().to_path_buf());
        let manager = McpManager::new();
        manager.set_attachment_store(store.clone()).await;
        manager
            .configure(
                "media-srv",
                McpServerRecipe::Http {
                    url,
                    headers: HashMap::new(),
                    bearer_token_env_var: None,
                },
                McpServerOptions::default(),
            )
            .await
            .expect("connect succeeds");

        let result = manager
            .call_tool("mcp__media-srv__echo", &json!({}), None)
            .await
            .expect("the call returns a result");

        assert!(
            result.content.contains("Original attachment saved at:"),
            "the notice must name the preserved original: {}",
            result.content
        );
        let delivery = result
            .delivery
            .expect("the image must be delivered to the model");
        assert!(
            matches!(
                delivery.blocks.first(),
                Some(crate::rpc::types::ContentBlock::MediaRef { .. })
            ),
            "the image must ride as a reference: {:?}",
            delivery.blocks
        );
        assert_eq!(
            store.list().unwrap().len(),
            1,
            "the original must be on disk"
        );
    }

    /// v2 `shouldMarkNeedsAuth` decision matrix (connection-manager.ts:383-393):
    /// only remote servers without a static credential flip to `needs-auth`,
    /// and only on a classified HTTP 401 (never on message text sniffing).
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
        assert!(!should_mark_needs_auth(&http, false, true));
        // stdio servers never participate in the OAuth flow.
        assert!(!should_mark_needs_auth(&stdio, true, true));
        // A pinned static credential means the 401 is a bad header.
        assert!(!should_mark_needs_auth(&with_headers, true, true));
        assert!(!should_mark_needs_auth(&with_bearer, true, true));
        // Remote without credentials + a classified 401 → needs-auth.
        assert!(should_mark_needs_auth(&http, true, true));
        // Non-401 failures (500, connection refused, timeout, …) stay failed,
        // even if their text happens to contain "401" or "Unauthorized".
        assert!(!should_mark_needs_auth(&http, true, false));
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
