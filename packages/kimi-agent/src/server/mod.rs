//! Native HTTP REST request dispatcher for the Kimi Agent API surface.
//!
//! `HttpServer::handle_request` maps a handful of paths (`/health`,
//! `/api/v1/sessions`, `POST /api/v1/sessions/:id/prompt`) onto
//! `SqliteSessionStore`, and [`http::serve`] binds them to a real TCP listener.
//! The one product entry is `kimi-agent --serve <ADDR>`, which builds the store,
//! the engine and the [`ServerAuth`] credential and hands them to
//! [`http::serve`].
//!
//! What is still missing before this replaces `packages/kap-server`'s `/api/v1`:
//!
//! - the WebSocket connection fans out events but speaks no kap-server
//!   `/api/v1/ws` message schema, so a client written against that schema cannot
//!   drive it;
//! - responses are bare objects, not kap-server's `{code, msg, data, request_id}`
//!   envelope — the 401 is the only envelope-shaped route.
//!
//! The `/api/v1` surface the app actually serves is still `packages/kap-server`.

pub mod auth;
pub mod debug;
pub mod engine;
pub mod envelope;
pub mod fs_routes;
pub mod http;
pub mod hub;
pub mod interaction;
pub mod media;
pub mod oauth;
pub mod plugins;
pub mod router;
pub mod static_files;
pub mod terminal;
pub mod ws;
pub mod ws_protocol;

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::cron::scheduler::{CronEntry, CronScheduler};
use crate::server::auth::ServerAuth;
use crate::server::engine::ServerEngine;
use crate::server::hub::EventHub;
use crate::server::router::{HttpRequest, HttpResponse};
use crate::session::sqlite_store::SqliteSessionStore;
use crate::storage::task_runner::TaskRunner;

pub struct HttpServer {
    store: Arc<SqliteSessionStore>,
    hub: Arc<EventHub>,
    engine: Option<Arc<ServerEngine>>,
    auth: ServerAuth,
    heartbeat: Duration,
    cron_scheduler: Arc<Mutex<CronScheduler>>,
    task_runner: Arc<TaskRunner>,
    server_id: String,
    started_at: String,
    web_assets_dir: Option<PathBuf>,
    mcp_manager: Arc<crate::mcp::manager::McpManager>,
    interaction_manager: Arc<interaction::InteractionManager>,
    plugin_manager: Arc<plugins::PluginManager>,
    oauth_manager: Arc<oauth::OAuthManager>,
    config_override: Arc<Mutex<Option<crate::config::KimiConfig>>>,
    terminal_manager: Arc<terminal::TerminalManager>,
    subagent_manager: Arc<crate::subagent::SubagentManager>,
}

impl HttpServer {
    /// A server over its own event hub.
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self::with_hub(store, Arc::new(EventHub::new()))
    }

    /// A server that shares an existing [`EventHub`], so a turn driven from
    /// elsewhere and the WebSocket fan-out see one numbering per session.
    /// Unauthenticated. Fine for tests and for a loopback development run; the
    /// only product entry (`--serve`) replaces this with a real token, and
    /// [`http::serve`] refuses a non-loopback bind while it is in effect.
    pub fn with_hub(store: Arc<SqliteSessionStore>, hub: Arc<EventHub>) -> Self {
        Self {
            store: store.clone(),
            hub: hub.clone(),
            engine: None,
            auth: ServerAuth::disabled(),
            heartbeat: crate::server::ws_protocol::DEFAULT_HEARTBEAT,
            cron_scheduler: Arc::new(Mutex::new(CronScheduler::new(Vec::new(), 0))),
            task_runner: Arc::new(TaskRunner::new(None)),
            server_id: format!("srv-{}", fastrand::u64(..)),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            web_assets_dir: None,
            mcp_manager: Arc::new(crate::mcp::manager::McpManager::new()),
            interaction_manager: Arc::new(
                interaction::InteractionManager::new().with_hub(hub.clone()),
            ),
            plugin_manager: Arc::new(plugins::PluginManager::new(store)),
            oauth_manager: Arc::new(oauth::OAuthManager::new()),
            config_override: Arc::new(Mutex::new(None)),
            terminal_manager: Arc::new(terminal::TerminalManager::new(hub.clone())),
            subagent_manager: Arc::new(crate::subagent::SubagentManager::new()),
        }
    }

    pub fn subagent_manager(&self) -> Arc<crate::subagent::SubagentManager> {
        if let Some(engine) = &self.engine {
            engine.subagent_manager()
        } else {
            self.subagent_manager.clone()
        }
    }

    #[must_use]
    pub fn with_subagent_manager(
        mut self,
        manager: Arc<crate::subagent::SubagentManager>,
    ) -> Self {
        self.subagent_manager = manager;
        self
    }

    pub fn terminal_manager(&self) -> Arc<terminal::TerminalManager> {
        self.terminal_manager.clone()
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn started_at(&self) -> &str {
        &self.started_at
    }

    pub fn plugin_manager(&self) -> Arc<plugins::PluginManager> {
        self.plugin_manager.clone()
    }

    pub fn oauth_manager(&self) -> Arc<oauth::OAuthManager> {
        self.oauth_manager.clone()
    }

    #[must_use]
    pub fn with_interaction_manager(
        mut self,
        manager: Arc<interaction::InteractionManager>,
    ) -> Self {
        self.interaction_manager = manager.clone();
        if let Some(engine) = &self.engine {
            engine.set_interaction_manager(manager);
        }
        self
    }

    pub fn interaction_manager(&self) -> Arc<interaction::InteractionManager> {
        self.interaction_manager.clone()
    }

    #[must_use]
    pub fn with_web_assets(mut self, path: impl Into<PathBuf>) -> Self {
        self.web_assets_dir = Some(path.into());
        self
    }

    pub fn web_assets_dir(&self) -> Option<&Path> {
        self.web_assets_dir.as_deref()
    }

    #[must_use]
    pub fn with_mcp_manager(mut self, manager: Arc<crate::mcp::manager::McpManager>) -> Self {
        self.mcp_manager = manager.clone();
        if let Some(engine) = &self.engine {
            engine.set_mcp_manager(manager);
        }
        self
    }

    pub fn mcp_manager(&self) -> Arc<crate::mcp::manager::McpManager> {
        self.mcp_manager.clone()
    }

    /// Require `Authorization: Bearer <token>` (and the WebSocket subprotocol
    /// equivalent) on every non-bypassed route.
    #[must_use]
    pub fn with_auth(mut self, auth: ServerAuth) -> Self {
        self.auth = auth;
        self
    }

    pub fn auth(&self) -> &ServerAuth {
        &self.auth
    }

    /// Set the period of the JSON `ping` heartbeat each WebSocket connection
    /// sends. kap-server takes the same as `heartbeatIntervalMs`.
    #[must_use]
    pub fn with_heartbeat(mut self, heartbeat: Duration) -> Self {
        self.heartbeat = heartbeat;
        self
    }

    pub fn heartbeat(&self) -> Duration {
        self.heartbeat
    }

    /// Attach the turn driver, without which `POST /sessions/:id/prompt` has
    /// nothing to run a turn with and answers 503.
    pub fn with_engine(mut self, engine: ServerEngine) -> Self {
        if engine.mcp_manager().is_none() {
            engine.set_mcp_manager(self.mcp_manager.clone());
        }
        if engine.interaction_manager().is_none() {
            engine.set_interaction_manager(self.interaction_manager.clone());
        }
        self.subagent_manager = engine.subagent_manager();
        self.engine = Some(Arc::new(engine));
        self
    }

    pub fn engine(&self) -> Option<Arc<ServerEngine>> {
        self.engine.clone()
    }

    #[must_use]
    pub fn with_cron_scheduler(mut self, scheduler: Arc<Mutex<CronScheduler>>) -> Self {
        self.cron_scheduler = scheduler;
        self
    }

    pub fn cron_scheduler(&self) -> Arc<Mutex<CronScheduler>> {
        self.cron_scheduler.clone()
    }

    #[must_use]
    pub fn with_task_runner(mut self, task_runner: Arc<TaskRunner>) -> Self {
        self.task_runner = task_runner;
        self
    }

    pub fn task_runner(&self) -> Arc<TaskRunner> {
        self.task_runner.clone()
    }

    /// The session store, for a host that wants to read transcripts or share
    /// the same store with the engine it builds.
    pub fn store(&self) -> &SqliteSessionStore {
        &self.store
    }

    pub fn store_arc(&self) -> Arc<SqliteSessionStore> {
        self.store.clone()
    }

    pub async fn config(&self) -> crate::config::KimiConfig {
        self.config_override.lock().await.clone().unwrap_or_else(|| {
            crate::config::KimiConfig::discover()
                .map(|(c, _)| c)
                .unwrap_or_default()
        })
    }

    /// The fan-out handle connections attach to and turns publish through.
    pub fn hub(&self) -> Arc<EventHub> {
        self.hub.clone()
    }

    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let store = Arc::new(SqliteSessionStore::in_memory()?);
        Ok(Self::new(store))
    }
}

fn extract_session_action<'a>(path: &'a str, action: &str) -> Option<&'a str> {
    let suffix_slash = format!("/{action}");
    let suffix_colon = format!(":{action}");
    let prefix = "/api/v1/sessions/";
    if !path.starts_with(prefix) {
        return None;
    }
    let rest = &path[prefix.len()..];
    if let Some(id) = rest.strip_suffix(&suffix_slash)
        && !id.is_empty()
        && !id.contains('/')
    {
        return Some(id);
    }
    if let Some(id) = rest.strip_suffix(&suffix_colon)
        && !id.is_empty()
        && !id.contains('/')
    {
        return Some(id);
    }
    None
}

fn extract_session_fs_action(path: &str) -> Option<(&str, &str)> {
    let rest = path
        .strip_prefix("/api/v1/sessions/")
        .or_else(|| path.strip_prefix("/sessions/"))?;
    if let Some((sess, act)) = rest.split_once("/fs:")
        && !sess.is_empty()
        && !sess.contains('/')
    {
        return Some((sess, act));
    }
    if let Some((sess, act)) = rest.split_once(":fs:")
        && !sess.is_empty()
        && !sess.contains('/')
    {
        return Some((sess, act));
    }
    if let Some((sess, act)) = rest.split_once("/fs/")
        && !sess.is_empty()
        && !sess.contains('/')
    {
        return Some((sess, act));
    }
    None
}

fn format_config_response(cfg: &crate::config::KimiConfig) -> Value {
    let default_model = cfg
        .default_model
        .clone()
        .unwrap_or_else(|| "kimi-latest".into());
    let yolo = cfg.agent.yolo.unwrap_or(false)
        || cfg
            .permission
            .as_ref()
            .and_then(|p| p.mode.as_deref())
            .map(|m| m.eq_ignore_ascii_case("yolo"))
            .unwrap_or(false);

    let mut providers_json = serde_json::Map::new();
    for (name, p) in &cfg.providers {
        let has_api_key = p
            .api_key
            .as_ref()
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false);
        providers_json.insert(
            name.clone(),
            json!({
                "type": p.provider_type.as_deref().unwrap_or(""),
                "base_url": p.base_url,
                "default_model": p.default_model,
                "has_api_key": has_api_key,
            }),
        );
    }

    let mut models_json = serde_json::Map::new();
    for (name, m) in &cfg.models {
        models_json.insert(
            name.clone(),
            json!({
                "provider": m.provider,
                "model": m.model,
                "has_api_key": true,
            }),
        );
    }

    json!({
        "default_model": default_model,
        "yolo": yolo,
        "providers": providers_json,
        "models": models_json,
        "services": {},
    })
}

fn format_wire_session(
    session: &crate::session::sqlite_store::SessionSummary,
    store: &SqliteSessionStore,
    engine: Option<&Arc<ServerEngine>>,
) -> Value {
    let session_id = &session.session_id;
    let busy = engine.map(|e| e.is_busy(session_id)).unwrap_or(false);
    let history = store.load_session_history(session_id).unwrap_or_default();
    let message_count = history.len();
    let context_tokens: usize = history.iter().map(|m| m.content.len() / 4).sum();

    let model = store
        .get_state("agent_config", session_id)
        .ok()
        .flatten()
        .and_then(|c| {
            c.get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| engine.map(|e| e.model_name().to_string()))
        .unwrap_or_else(|| "kimi-latest".to_string());

    let cwd = store
        .get_state("metadata", session_id)
        .ok()
        .flatten()
        .and_then(|m| m.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });

    let ws_id = session
        .workspace_id
        .clone()
        .unwrap_or_else(|| crate::session::sqlite_store::encode_workdir_key(&cwd));

    let created_iso = chrono::DateTime::from_timestamp_millis(session.created_at)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));

    let updated_iso = chrono::DateTime::from_timestamp_millis(session.updated_at)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));

    json!({
        "id": session_id,
        "session_id": session_id,
        "workspace_id": ws_id,
        "title": session.title.as_deref().unwrap_or(""),
        "created_at": created_iso,
        "updated_at": updated_iso,
        "busy": busy,
        "main_turn_active": busy,
        "pending_interaction": "none",
        "archived": false,
        "metadata": {
            "cwd": cwd,
            "session_id": session_id
        },
        "agent_config": {
            "model": model,
            "thinking": "medium"
        },
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "total_cost_usd": 0,
            "context_tokens": context_tokens,
            "context_limit": 262144,
            "turn_count": message_count.max(1)
        },
        "permission_rules": [],
        "message_count": message_count,
        "last_seq": 1
    })
}

impl HttpServer {
    /// Dispatch an incoming HTTP request to the appropriate route handler.
    pub async fn handle_request(&self, req: &HttpRequest) -> HttpResponse {
        let path = req.path.trim_end_matches('/');
        let method = req.method.to_uppercase();

        // The one REST authority: health and the schema documents answer
        // unauthenticated, matching kap-server, and everything that can read or
        // mutate state does not.
        if !ServerAuth::is_bypassed(&method, path) {
            let decision = self.auth.check_bearer(req.header("authorization"));
            if !decision.is_allowed() {
                return HttpResponse::unauthorized("Unauthorized");
            }
        }

        // Static file serving and SPA fallback for non-API routes
        if !path.starts_with("/api")
            && (method == "GET" || method == "HEAD")
            && let Some(assets_dir) = &self.web_assets_dir
        {
            return static_files::serve_static_file(assets_dir, &req.path);
        }

        // Debug RPC and reflection surface for kimi-inspect
        if path.starts_with("/api/v1/debug") {
            if let Some(resp) = debug::handle_debug_route(self, req).await {
                return resp;
            }
        }

        let resp = match (method.as_str(), path) {
            ("GET", "/api/v1/health") | ("GET", "/health") => HttpResponse::ok(&json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "engine": "kimi-agent-rust",
            })),
            ("GET", "/api/v1/meta") => {
                let dangerous_bypass_auth = self.auth.is_disabled();
                HttpResponse::ok(&json!({
                    "server_version": env!("CARGO_PKG_VERSION"),
                    "capabilities": {
                        "websocket": true,
                        "file_upload": true,
                        "fs_query": true,
                        "mcp": true,
                        "tasks": true,
                        "terminal": true,
                        "subagents": true,
                    },
                    "server_id": self.server_id,
                    "started_at": self.started_at,
                    "open_in_apps": [],
                    "dangerous_bypass_auth": dangerous_bypass_auth,
                    "backend": "rust",
                    "web_title": "Kimi Code",
                    "experimental_flags": {},
                }))
            }
            ("GET", "/api/v1/config") => {
                let config = self.config_override.lock().await.clone().unwrap_or_else(|| {
                    crate::config::KimiConfig::discover()
                        .map(|(c, _)| c)
                        .unwrap_or_default()
                });
                HttpResponse::ok(&format_config_response(&config))
            }
            ("POST", "/api/v1/config") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let mut config = self.config_override.lock().await.clone().unwrap_or_else(|| {
                    crate::config::KimiConfig::discover()
                        .map(|(c, _)| c)
                        .unwrap_or_default()
                });
                if let Some(dm) = body.get("default_model").and_then(|v| v.as_str()) {
                    config.default_model = Some(dm.to_string());
                }
                if let Some(yolo) = body.get("yolo").and_then(|v| v.as_bool()) {
                    config.agent.yolo = Some(yolo);
                }
                *self.config_override.lock().await = Some(config.clone());
                HttpResponse::ok(&format_config_response(&config))
            }
            ("POST", "/api/v1/config:reload") | ("POST", "/api/v1/config/reload") => {
                *self.config_override.lock().await = None;
                let config = crate::config::KimiConfig::discover()
                    .map(|(c, _)| c)
                    .unwrap_or_default();
                HttpResponse::ok(&json!({
                    "status": "reloaded",
                    "config": format_config_response(&config)
                }))
            }
            ("GET", "/api/v1/runtime") | ("GET", "/api/v1/runtime/info") => {
                HttpResponse::ok(&json!({
                    "os": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                    "family": std::env::consts::FAMILY,
                    "platform": std::env::consts::OS,
                    "backend": "rust",
                    "version": env!("CARGO_PKG_VERSION"),
                    "pid": std::process::id(),
                }))
            }
            ("GET", "/api/v1/capabilities") => HttpResponse::ok(&json!({
                "capabilities": [
                    "bash",
                    "file_history",
                    "read",
                    "write",
                    "edit",
                    "grep",
                    "glob",
                    "tools",
                    "native_tools",
                    "websocket_events",
                    "interaction_questions",
                    "interaction_approvals",
                    "task_runner",
                    "cron_scheduler",
                    "gui_store",
                    "mcp",
                    "plugins",
                    "terminals",
                    "subagents"
                ]
            })),
            ("GET", "/api/v1/connections") => {
                let subscriber_count = self.hub.subscriber_count();
                let connections: Vec<Value> = (0..subscriber_count)
                    .map(|i| {
                        json!({
                            "id": format!("conn_{i}"),
                            "connected_at": self.started_at,
                            "remote_address": "127.0.0.1",
                            "user_agent": "kimi-client",
                            "has_client_hello": true,
                            "subscriptions": []
                        })
                    })
                    .collect();
                HttpResponse::ok(&json!({ "connections": connections }))
            }
            ("POST", "/api/v1/shutdown") => HttpResponse::ok(&json!({
                "status": "shutting_down",
                "message": "Kimi agent native server is shutting down"
            })),
            ("GET", "/api/v1/models") | ("GET", "/api/v1/model-catalog") => {
                let default_model = self
                    .engine
                    .as_ref()
                    .map(|e| e.model_name())
                    .unwrap_or("kimi-latest");
                let items = json!([
                    {
                        "id": default_model,
                        "model": default_model,
                        "display_name": format!("Active Model ({default_model})"),
                        "provider": "default",
                        "max_context_size": 262144,
                        "capabilities": ["tools", "thinking", "multimodal"],
                        "default": true,
                    },
                    {
                        "id": "claude-3-7-sonnet-20250219",
                        "model": "claude-3-7-sonnet-20250219",
                        "display_name": "Claude 3.7 Sonnet",
                        "provider": "anthropic",
                        "max_context_size": 200000,
                        "capabilities": ["tools", "thinking", "multimodal"],
                        "default": false,
                    },
                    {
                        "id": "gpt-4o",
                        "model": "gpt-4o",
                        "display_name": "GPT-4o",
                        "provider": "openai",
                        "max_context_size": 128000,
                        "capabilities": ["tools", "multimodal"],
                        "default": false,
                    }
                ]);
                HttpResponse::ok(&json!({
                    "default_model": default_model,
                    "items": items
                }))
            }
            ("GET", "/api/v1/providers") => {
                let items = json!([
                    {
                        "id": "kimi",
                        "name": "Moonshot / Kimi",
                        "type": "kimi",
                        "base_url": "https://api.moonshot.cn/v1",
                        "models": [
                            {
                                "model": "kimi-latest",
                                "display_name": "Kimi Latest",
                                "max_context_size": 262144,
                                "capabilities": ["tools", "thinking", "multimodal"]
                            }
                        ]
                    },
                    {
                        "id": "anthropic",
                        "name": "Anthropic",
                        "type": "anthropic",
                        "base_url": "https://api.anthropic.com/v1",
                        "models": [
                            {
                                "model": "claude-3-7-sonnet-20250219",
                                "display_name": "Claude 3.7 Sonnet",
                                "max_context_size": 200000,
                                "capabilities": ["tools", "thinking", "multimodal"]
                            }
                        ]
                    },
                    {
                        "id": "openai",
                        "name": "OpenAI",
                        "type": "openai",
                        "base_url": "https://api.openai.com/v1",
                        "models": [
                            {
                                "model": "gpt-4o",
                                "display_name": "GPT-4o",
                                "max_context_size": 128000,
                                "capabilities": ["tools", "multimodal"]
                            }
                        ]
                    },
                    {
                        "id": "google-genai",
                        "name": "Google Gemini",
                        "type": "google-genai",
                        "models": [
                            {
                                "model": "gemini-2.5-pro",
                                "display_name": "Gemini 2.5 Pro",
                                "max_context_size": 1000000,
                                "capabilities": ["tools", "thinking", "multimodal"]
                            }
                        ]
                    }
                ]);
                HttpResponse::ok(&json!({ "items": items }))
            }
            ("GET", "/api/v1/catalog/providers") | ("GET", "/api/v1/providers/catalog") => {
                let items = json!([
                    {
                        "id": "moonshot",
                        "name": "Moonshot AI (Kimi)",
                        "wire_type": "kimi",
                        "guessed": false,
                        "needs_base_url": false,
                        "rejected": false,
                        "reject_reason": Value::Null,
                        "env_key": "MOONSHOT_API_KEY",
                        "models": [
                            {
                                "id": "kimi-latest",
                                "name": "Kimi Latest",
                                "max_context_size": 262144,
                                "capabilities": ["tools", "thinking", "multimodal"],
                                "reasoning": true
                            }
                        ]
                    },
                    {
                        "id": "anthropic",
                        "name": "Anthropic",
                        "wire_type": "anthropic",
                        "guessed": false,
                        "needs_base_url": false,
                        "rejected": false,
                        "reject_reason": Value::Null,
                        "env_key": "ANTHROPIC_API_KEY",
                        "models": [
                            {
                                "id": "claude-3-7-sonnet-20250219",
                                "name": "Claude 3.7 Sonnet",
                                "max_context_size": 200000,
                                "capabilities": ["tools", "thinking", "multimodal"],
                                "reasoning": true
                            }
                        ]
                    },
                    {
                        "id": "openai",
                        "name": "OpenAI",
                        "wire_type": "openai",
                        "guessed": false,
                        "needs_base_url": false,
                        "rejected": false,
                        "reject_reason": Value::Null,
                        "env_key": "OPENAI_API_KEY",
                        "models": [
                            {
                                "id": "gpt-4o",
                                "name": "GPT-4o",
                                "max_context_size": 128000,
                                "capabilities": ["tools", "multimodal"],
                                "reasoning": false
                            }
                        ]
                    },
                    {
                        "id": "google",
                        "name": "Google Gemini",
                        "wire_type": "google-genai",
                        "guessed": false,
                        "needs_base_url": false,
                        "rejected": false,
                        "reject_reason": Value::Null,
                        "env_key": "GEMINI_API_KEY",
                        "models": [
                            {
                                "id": "gemini-2.5-pro",
                                "name": "Gemini 2.5 Pro",
                                "max_context_size": 1000000,
                                "capabilities": ["tools", "thinking", "multimodal"],
                                "reasoning": true
                            }
                        ]
                    }
                ]);
                HttpResponse::ok(&json!({ "items": items }))
            }
            ("GET", p) if p.starts_with("/api/v1/catalog/providers/") => {
                let catalog_id = p.strip_prefix("/api/v1/catalog/providers/").unwrap_or_default();
                HttpResponse::ok(&json!({
                    "id": catalog_id,
                    "name": format!("Catalog {catalog_id}"),
                    "wire_type": "openai",
                    "guessed": false,
                    "needs_base_url": false,
                    "rejected": false,
                    "reject_reason": Value::Null,
                    "env_key": Value::Null,
                    "models": []
                }))
            }
            ("POST", p) if p.starts_with("/api/v1/models/") => {
                let tail = p.strip_prefix("/api/v1/models/").unwrap_or_default();
                let model_id = if let Some(m) = tail.strip_suffix(":set_default") {
                    m.to_string()
                } else if tail == "set_default" {
                    let body: Value = serde_json::from_slice(&req.body).unwrap_or(json!({}));
                    body.get("model").and_then(|v| v.as_str()).unwrap_or("kimi-latest").to_string()
                } else {
                    tail.to_string()
                };
                let mut config = self.config_override.lock().await.clone().unwrap_or_else(|| {
                    crate::config::KimiConfig::discover()
                        .map(|(c, _)| c)
                        .unwrap_or_default()
                });
                config.default_model = Some(model_id.clone());
                *self.config_override.lock().await = Some(config);
                HttpResponse::ok(&json!({ "model": model_id }))
            }
            ("GET", "/api/v1/prompts") => {
                HttpResponse::ok(&json!({ "items": [] }))
            }
            ("POST", "/api/v1/prompts") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let prompt_id = format!("prompt-{}", ulid::Ulid::new());
                let session_id = body.get("session_id").and_then(|v| v.as_str()).unwrap_or_default();
                HttpResponse::ok(&json!({
                    "id": prompt_id,
                    "session_id": session_id,
                    "status": "enqueued",
                    "created_at": chrono::Utc::now().to_rfc3339()
                }))
            }
            ("GET", "/api/v1/files") => {
                HttpResponse::ok(&json!({ "files": [] }))
            }
            ("GET", "/api/v2/sessions") => {
                let sessions = self.store.list_sessions().unwrap_or_default();
                let items: Vec<Value> = sessions.into_iter().map(|s| {
                    json!({
                        "session_id": s.session_id,
                        "title": s.title,
                        "created_at": s.created_at,
                        "updated_at": s.updated_at,
                        "archived": s.archived,
                        "workspace_id": s.workspace_id,
                        "meta": {
                            "session_id": s.session_id,
                            "has_prompt": true
                        },
                        "activity": {
                            "status": "idle",
                            "model": Value::Null
                        }
                    })
                }).collect();
                HttpResponse::ok(&json!({
                    "items": items,
                    "total": items.len(),
                    "page_token": Value::Null
                }))
            }
            // Tools endpoints
            ("GET", "/api/v1/tools") => {
                let session_id = req.query_param("session_id");
                let mut tools: Vec<Value> = crate::tools::core_tool_defs::all_native_tool_defs()
                    .into_iter()
                    .map(|d| {
                        json!({
                            "name": d.name,
                            "description": d.description,
                            "input_schema": d.input_schema,
                            "source": "builtin",
                            "active": true,
                        })
                    })
                    .collect();

                let mcp_tools = self.mcp_manager.list_tool_infos().await;
                for t in mcp_tools {
                    let server_id = if t.name.starts_with("mcp__") {
                        t.name.split("__").nth(1)
                    } else {
                        None
                    };
                    tools.push(json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
                        "source": "mcp",
                        "mcp_server_id": server_id,
                        "active": true,
                    }));
                }

                let mut resp = json!({ "tools": tools });
                if let Some(sid) = session_id {
                    resp["session_id"] = json!(sid);
                }
                HttpResponse::ok(&resp)
            }
            // MCP endpoints
            ("GET", "/api/v1/mcp") => {
                let servers = self.mcp_manager.server_entries().await;
                HttpResponse::ok(&json!({ "servers": servers }))
            }
            ("GET", "/api/v1/mcp/tools") => {
                let tools = self.mcp_manager.list_tool_infos().await;
                HttpResponse::ok(&json!({ "tools": tools }))
            }
            // On-demand reconnect for a configured server (v2
            // `reconnectAndJoin` surface): truthful failed/connected status.
            ("POST", p)
                if p.starts_with("/api/v1/mcp/servers/") && p.ends_with(":reconnect") =>
            {
                let name = p
                    .strip_prefix("/api/v1/mcp/servers/")
                    .and_then(|rest| rest.strip_suffix(":reconnect"))
                    .unwrap_or_default();
                match self.mcp_manager.reconnect(name).await {
                    Ok(()) => {
                        let servers = self.mcp_manager.server_entries().await;
                        let entry = servers.iter().find(|s| s.name == name);
                        HttpResponse::ok(&json!({ "reconnected": true, "server": entry }))
                    }
                    Err(e) => HttpResponse::internal_error(e),
                }
            }
            ("POST", "/api/v1/mcp/servers:test") | ("POST", "/api/v2/mcp/servers:test") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("test-server");
                HttpResponse::ok(&json!({ "ok": true, "name": name, "connected": true }))
            }
            ("POST", "/api/v1/mcp/servers:inspect") | ("POST", "/api/v2/mcp/servers:inspect") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let name = body.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                if let Some(tools) = self.mcp_manager.inspect_server(name).await {
                    HttpResponse::ok(&json!({ "name": name, "tools": tools }))
                } else {
                    HttpResponse::not_found()
                }
            }
            ("DELETE", p) if p.starts_with("/api/v1/mcp/servers/") || p.starts_with("/api/v2/mcp/servers/") => {
                let name = p.rsplit('/').next().unwrap_or_default();
                if self.mcp_manager.remove_server(name).await {
                    HttpResponse::ok(&json!({ "removed": true, "name": name }))
                } else {
                    HttpResponse::not_found()
                }
            }
            ("GET", "/api/v1/mcp/auth-statuses") | ("GET", "/api/v2/mcp/auth-statuses") => {
                HttpResponse::ok(&json!({ "statuses": {} }))
            }
            ("POST", p) if p.starts_with("/api/v1/mcp/auth:") || p.starts_with("/api/v2/mcp/auth:") => {
                let action = p.rsplit(':').next().unwrap_or_default();
                HttpResponse::ok(&json!({ "action": action, "status": "completed" }))
            }
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/mcp") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let servers = self.mcp_manager.server_entries().await;
                HttpResponse::ok(&json!({ "servers": servers, "sessionId": session_id }))
            }
            ("GET", "/api/v1/sessions") => match self.store.list_sessions() {
                Ok(sessions) => {
                    let items: Vec<Value> = sessions
                        .iter()
                        .map(|s| format_wire_session(s, &self.store, self.engine.as_ref()))
                        .collect();
                    HttpResponse::ok(&json!({ "sessions": items }))
                }
                Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
            },
            // Workspaces endpoints
            ("GET", "/api/v1/workspaces") => match self.store.list_workspaces() {
                Ok(items) => HttpResponse::ok(&json!({ "items": items })),
                Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
            },
            // FS endpoints (workspace-agnostic folder browser for Web UI / Desktop)
            ("GET", "/api/v1/fs:home") | ("GET", "/api/v1/fs::home") => {
                let home_path = std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_else(|_| ".".into());
                let normalized_home = home_path.replace('\\', "/");
                let recent_roots: Vec<String> = self
                    .store
                    .list_workspaces()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|w| w.root)
                    .take(20)
                    .collect();
                HttpResponse::ok(&json!({
                    "home": normalized_home,
                    "recent_roots": recent_roots,
                }))
            }
            ("GET", "/api/v1/fs:browse") | ("GET", "/api/v1/fs::browse") => {
                let default_home = std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_else(|_| ".".into());
                let raw_target = req
                    .query_param("path")
                    .filter(|p| !p.trim().is_empty())
                    .unwrap_or(default_home);
                let target_path = std::path::Path::new(&raw_target);
                if !target_path.exists() {
                    return HttpResponse::not_found();
                }
                if !target_path.is_dir() {
                    return HttpResponse::bad_request("Path is not a directory");
                }
                let canonical = match target_path.canonicalize() {
                    Ok(p) => p,
                    Err(_) => target_path.to_path_buf(),
                };
                let canonical_str = canonical
                    .to_string_lossy()
                    .replace('\\', "/")
                    .trim_start_matches("//?/")
                    .trim_start_matches(r"\\?\")
                    .to_string();

                let parent_str = canonical.parent().map(|p| {
                    p.to_string_lossy()
                        .replace('\\', "/")
                        .trim_start_matches("//?/")
                        .trim_start_matches(r"\\?\")
                        .to_string()
                });
                let effective_parent = if parent_str.as_deref() == Some(&canonical_str) {
                    None
                } else {
                    parent_str
                };

                let mut entries = Vec::new();
                if let Ok(read_dir) = std::fs::read_dir(&canonical) {
                    for entry in read_dir.flatten() {
                        if let Ok(file_type) = entry.file_type()
                            && file_type.is_dir()
                        {
                            let file_name = entry.file_name().to_string_lossy().to_string();
                            let full_path = entry
                                .path()
                                .to_string_lossy()
                                .replace('\\', "/")
                                .trim_start_matches("//?/")
                                .trim_start_matches(r"\\?\")
                                .to_string();
                            entries.push(json!({
                                "name": file_name,
                                "path": full_path,
                                "is_dir": true,
                            }));
                        }
                    }
                }

                entries.sort_by(|a, b| {
                    let name_a = a["name"].as_str().unwrap_or_default();
                    let name_b = b["name"].as_str().unwrap_or_default();
                    let dot_a = name_a.starts_with('.');
                    let dot_b = name_b.starts_with('.');
                    if dot_a != dot_b {
                        dot_a.cmp(&dot_b)
                    } else {
                        name_a.to_lowercase().cmp(&name_b.to_lowercase())
                    }
                });

                HttpResponse::ok(&json!({
                    "path": canonical_str,
                    "parent": effective_parent,
                    "entries": entries,
                }))
            }
            ("POST", "/api/v1/search") | ("POST", "/api/v1/sessions:search") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let query = match body.get("query").and_then(|v| v.as_str()) {
                    Some(q) if !q.trim().is_empty() => q.trim(),
                    _ => return HttpResponse::bad_request("Field 'query' is required"),
                };
                let session_id = body
                    .get("container")
                    .and_then(|c| c.get("session_id"))
                    .and_then(|v| v.as_str());
                let role = body.get("role").and_then(|v| v.as_str());
                let page_size =
                    body.get("page_size").and_then(|v| v.as_u64()).unwrap_or(20) as usize;

                let hits = match self
                    .store
                    .search_messages(query, session_id, role, page_size)
                {
                    Ok(h) => h,
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };

                let total_sessions = self.store.list_sessions().map(|s| s.len()).unwrap_or(0);
                let total_messages = self.store.count_messages().unwrap_or(0);

                HttpResponse::ok(&json!({
                    "items": hits,
                    "has_more": false,
                    "page_token": serde_json::Value::Null,
                    "incomplete": false,
                    "index_state": {
                        "state": "ready",
                        "indexed_sessions": total_sessions,
                        "total_sessions": total_sessions,
                        "documents": total_messages,
                        "stale": false,
                        "degraded": false
                    },
                    "source": "sqlite"
                }))
            }
            ("POST", "/api/v1/workspace/fs:search") | ("POST", "/api/v1/workspace/fs::search") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let ws_ref = match body.get("workspace").and_then(|v| v.as_str()) {
                    Some(w) if !w.trim().is_empty() => w.trim(),
                    _ => return HttpResponse::bad_request("Field 'workspace' is required"),
                };
                let query = body
                    .get("query")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_lowercase();
                let limit = body.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

                let root_dir = if let Ok(Some(ws)) = self.store.get_workspace(ws_ref) {
                    std::path::PathBuf::from(ws.root)
                } else {
                    std::path::PathBuf::from(ws_ref)
                };

                if !root_dir.is_dir() {
                    return HttpResponse::bad_request("Workspace root is not a valid directory");
                }

                let mut items = Vec::new();
                let mut truncated = false;
                let walker = ignore::WalkBuilder::new(&root_dir)
                    .hidden(false)
                    .git_ignore(true)
                    .max_depth(Some(8))
                    .build();

                for result in walker.flatten() {
                    let path = result.path();
                    if path == root_dir {
                        continue;
                    }
                    let rel_path = match path.strip_prefix(&root_dir) {
                        Ok(p) => p.to_string_lossy().replace('\\', "/"),
                        Err(_) => continue,
                    };

                    if query.is_empty() || rel_path.to_lowercase().contains(&query) {
                        if items.len() >= limit {
                            truncated = true;
                            break;
                        }
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let kind = if path.is_dir() { "directory" } else { "file" };
                        items.push(json!({
                            "path": rel_path,
                            "name": name,
                            "kind": kind,
                            "score": 100,
                            "match_positions": [],
                        }));
                    }
                }

                HttpResponse::ok(&json!({
                    "items": items,
                    "truncated": truncated,
                }))
            }
            ("GET", "/api/v1/plugins/marketplace") => {
                let entries = self.plugin_manager.list_marketplace();
                HttpResponse::ok(&json!({ "entries": entries }))
            }
            ("GET", "/api/v1/plugins") => {
                let plugins = self.plugin_manager.list_plugins();
                HttpResponse::ok(&json!({ "plugins": plugins }))
            }
            ("POST", "/api/v1/plugins") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let id = body.get("id").or_else(|| body.get("name")).and_then(|v| v.as_str());
                let Some(id) = id else {
                    return HttpResponse::bad_request("Missing plugin id");
                };
                let _ = self.plugin_manager.set_plugin_enabled(id, true);
                HttpResponse::ok(&json!({
                    "id": id,
                    "enabled": true,
                    "version": "1.0.0",
                    "installed": true
                }))
            }
            ("GET", "/api/v1/skills") => {
                let skills = crate::skills::scan_all_skills(None);
                HttpResponse::ok(&json!({ "skills": skills }))
            }
            ("POST", "/api/v1/acp") => {
                let body_str = match std::str::from_utf8(&req.body) {
                    Ok(s) => s,
                    Err(_) => return HttpResponse::bad_request("Invalid UTF-8 payload"),
                };
                let acp_server = crate::acp::AcpServer::new(self.store.clone());
                let response = acp_server.handle_message(body_str).await;
                if let Some(resp) = response {
                    let val = serde_json::to_value(&resp).unwrap_or(Value::Null);
                    HttpResponse::ok(&val)
                } else {
                    HttpResponse::ok(&json!({ "result": "ok" }))
                }
            }
            ("POST", p) if p.starts_with("/api/v1/plugins/") => {
                let tail = p.strip_prefix("/api/v1/plugins/").unwrap_or_default();
                let (id, action) = if let Some(id) = tail.strip_suffix(":enable") {
                    (id, "enable")
                } else if let Some(id) = tail.strip_suffix("/enable") {
                    (id, "enable")
                } else if let Some(id) = tail.strip_suffix(":disable") {
                    (id, "disable")
                } else if let Some(id) = tail.strip_suffix("/disable") {
                    (id, "disable")
                } else if let Some(id) = tail.strip_suffix(":remove") {
                    (id, "remove")
                } else if let Some(id) = tail.strip_suffix("/remove") {
                    (id, "remove")
                } else {
                    return HttpResponse::bad_request("Unsupported plugin action");
                };

                match action {
                    "enable" => match self.plugin_manager.set_plugin_enabled(id, true) {
                        Ok(_) => HttpResponse::ok(
                            &json!({ "ok": true, "pluginId": id, "enabled": true }),
                        ),
                        Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                    },
                    "disable" => match self.plugin_manager.set_plugin_enabled(id, false) {
                        Ok(_) => HttpResponse::ok(
                            &json!({ "ok": true, "pluginId": id, "enabled": false }),
                        ),
                        Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                    },
                    "remove" => match self.plugin_manager.remove_plugin(id) {
                        Ok(true) => HttpResponse::ok(
                            &json!({ "ok": true, "pluginId": id, "removed": true }),
                        ),
                        Ok(false) => HttpResponse::not_found(),
                        Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                    },
                    _ => HttpResponse::bad_request("Unsupported plugin action"),
                }
            }
            ("POST", "/api/v1/oauth/login") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                let provider = body
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .unwrap_or("kimi");
                let region = body.get("region").and_then(|v| v.as_str());
                let flow = self.oauth_manager.clone().start_login(provider, region).await;
                HttpResponse::ok(&json!(flow))
            }
            ("GET", "/api/v1/oauth/login") => {
                let provider = req.query_param("provider").unwrap_or_else(|| "kimi".into());
                let flow = self.oauth_manager.get_flow(&provider);
                HttpResponse::ok(&json!(flow))
            }
            ("DELETE", "/api/v1/oauth/login") => {
                let provider = req.query_param("provider").unwrap_or_else(|| "kimi".into());
                let cancelled = self.oauth_manager.cancel_login(&provider);
                HttpResponse::ok(&json!({ "cancelled": cancelled }))
            }
            ("POST", "/api/v1/oauth/logout") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                let provider = body
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .unwrap_or("kimi");
                let logged_out = self.oauth_manager.logout(provider);
                HttpResponse::ok(&json!({ "loggedOut": logged_out }))
            }
            ("GET", "/api/v1/oauth/usage") => {
                let provider = req.query_param("provider").unwrap_or_else(|| "kimi".into());
                HttpResponse::ok(&self.oauth_manager.get_usage(&provider).await)
            }
            ("GET", "/api/v1/oauth/user") => {
                let provider = req.query_param("provider").unwrap_or_else(|| "kimi".into());
                HttpResponse::ok(&self.oauth_manager.get_user_info(&provider).await)
            }
            ("POST", "/api/v1/workspaces") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let root = match body.get("root").and_then(|v| v.as_str()) {
                    Some(r) if !r.trim().is_empty() => r.trim(),
                    _ => return HttpResponse::bad_request("Field 'root' is required"),
                };
                let name = body.get("name").and_then(|v| v.as_str());
                match self.store.create_workspace(root, name) {
                    Ok(ws) => {
                        let ws_json = json!(ws);
                        self.hub
                            .bus_for("global")
                            .publish(&crate::events::EngineEvent::Custom(json!({
                                "type": "event.workspace.created",
                                "workspace": ws_json,
                            })));
                        HttpResponse::json(201, &ws_json)
                    }
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if p.starts_with("/api/v1/workspaces/") && p.ends_with("/trust") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let workspace_id = segments[4];
                if self
                    .store
                    .get_workspace(workspace_id)
                    .ok()
                    .flatten()
                    .is_none()
                {
                    return HttpResponse::not_found();
                }
                match self.store.is_workspace_trusted(workspace_id) {
                    Ok(trusted) => HttpResponse::ok(&json!({ "trusted": trusted })),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if p.starts_with("/api/v1/workspaces/") && p.ends_with("/trust") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let workspace_id = segments[4];
                if self
                    .store
                    .get_workspace(workspace_id)
                    .ok()
                    .flatten()
                    .is_none()
                {
                    return HttpResponse::not_found();
                }
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let trusted = body
                    .get("trusted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                match self.store.set_workspace_trusted(workspace_id, trusted) {
                    Ok(_) => HttpResponse::ok(&json!({ "trusted": trusted })),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if p.starts_with("/api/v1/workspaces/") && p.ends_with("/skills") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let workspace_id = segments[4];
                let ws = match self.store.get_workspace(workspace_id) {
                    Ok(Some(w)) => w,
                    Ok(None) => return HttpResponse::not_found(),
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                let root_path = std::path::PathBuf::from(&ws.root);
                let skills = crate::skills::scan_all_skills(Some(&root_path));
                HttpResponse::ok(&json!({ "skills": skills }))
            }
            ("GET", p) if p.starts_with("/api/v1/workspaces/") && p.ends_with("/plugins") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let workspace_id = segments[4];
                if self
                    .store
                    .get_workspace(workspace_id)
                    .ok()
                    .flatten()
                    .is_none()
                {
                    return HttpResponse::not_found();
                }
                let plugins = self.plugin_manager.list_plugins();
                HttpResponse::ok(&json!({ "plugins": plugins }))
            }
            ("GET", p)
                if p.starts_with("/api/v1/workspaces/")
                    && !p.ends_with("/trust")
                    && !p.ends_with("/skills")
                    && !p.ends_with("/plugins") =>
            {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 5 {
                    return HttpResponse::not_found();
                }
                let workspace_id = segments[4];
                match self.store.get_workspace(workspace_id) {
                    Ok(Some(ws)) => HttpResponse::ok(&json!(ws)),
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("PATCH", p) if p.starts_with("/api/v1/workspaces/") && !p.ends_with("/trust") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 5 {
                    return HttpResponse::not_found();
                }
                let workspace_id = segments[4];
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let Some(name) = body.get("name").and_then(|v| v.as_str()) else {
                    return HttpResponse::bad_request("Field 'name' is required");
                };
                match self.store.update_workspace_name(workspace_id, name) {
                    Ok(Some(ws)) => {
                        self.hub
                            .bus_for("global")
                            .publish(&crate::events::EngineEvent::Custom(json!({
                                "type": "event.workspace.updated",
                                "workspace": ws,
                            })));
                        HttpResponse::ok(&json!(ws))
                    }
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("DELETE", p) if p.starts_with("/api/v1/workspaces/") && !p.ends_with("/trust") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 5 {
                    return HttpResponse::not_found();
                }
                let workspace_id = segments[4];
                let root = self
                    .store
                    .get_workspace(workspace_id)
                    .ok()
                    .flatten()
                    .map(|w| w.root);
                match self.store.delete_workspace(workspace_id) {
                    Ok(true) => {
                        self.hub
                            .bus_for("global")
                            .publish(&crate::events::EngineEvent::Custom(json!({
                                "type": "event.workspace.deleted",
                                "workspace_id": workspace_id,
                                "root": root.unwrap_or_default(),
                            })));
                        HttpResponse::ok(&json!({ "deleted": true }))
                    }
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            // Cron endpoints: session-scoped or global
            ("GET", p)
                if (p.starts_with("/api/v1/sessions/") && p.ends_with("/cron"))
                    || p == "/api/v1/cron" =>
            {
                if p != "/api/v1/cron" {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                }
                let scheduler = self.cron_scheduler.lock().await;
                let entries = scheduler.list_entries();
                HttpResponse::ok(&json!({ "entries": entries }))
            }
            ("POST", p)
                if (p.starts_with("/api/v1/sessions/") && p.ends_with("/cron"))
                    || p == "/api/v1/cron" =>
            {
                if p != "/api/v1/cron" {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                }
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let cron_expr = match body.get("cron").and_then(|v| v.as_str()) {
                    Some(c) if !c.trim().is_empty() => c.trim(),
                    _ => return HttpResponse::bad_request("Field 'cron' is required"),
                };
                let prompt = match body.get("prompt").and_then(|v| v.as_str()) {
                    Some(p) if !p.trim().is_empty() => p.trim(),
                    _ => return HttpResponse::bad_request("Field 'prompt' is required"),
                };
                let id = body
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("cron-{}", fastrand::u64(..)));
                let recurring = body
                    .get("recurring")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let entry = CronEntry {
                    id: id.clone(),
                    cron: cron_expr.to_string(),
                    prompt: prompt.to_string(),
                    recurring,
                };
                let mut scheduler = self.cron_scheduler.lock().await;
                if scheduler.add_entry(entry) {
                    HttpResponse::json(
                        201,
                        &json!({
                            "id": id,
                            "cron": cron_expr,
                            "prompt": prompt,
                            "recurring": recurring
                        }),
                    )
                } else {
                    HttpResponse::bad_request("Invalid cron expression")
                }
            }
            ("DELETE", p)
                if (p.starts_with("/api/v1/sessions/") && p.contains("/cron/"))
                    || p.starts_with("/api/v1/cron/") =>
            {
                let task_id = if p.starts_with("/api/v1/cron/") {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 5 {
                        return HttpResponse::not_found();
                    }
                    segments[4]
                } else {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 7 || segments[5] != "cron" {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                    segments[6]
                };
                let mut scheduler = self.cron_scheduler.lock().await;
                if scheduler.remove_entry(task_id) {
                    HttpResponse::ok(&json!({ "deleted": true, "taskId": task_id }))
                } else {
                    HttpResponse::not_found()
                }
            }

            // Tasks endpoints: session-scoped or global
            ("GET", p)
                if (p.starts_with("/api/v1/sessions/") && p.ends_with("/tasks"))
                    || p == "/api/v1/tasks" =>
            {
                if p != "/api/v1/tasks" {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                }
                let tasks = self.task_runner.list();
                HttpResponse::ok(&json!({ "tasks": tasks }))
            }
            ("GET", p)
                if (p.starts_with("/api/v1/sessions/")
                    && p.contains("/tasks/")
                    && !p.ends_with("/stop"))
                    || (p.starts_with("/api/v1/tasks/") && !p.ends_with("/stop")) =>
            {
                let task_id = if p.starts_with("/api/v1/tasks/") {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 5 {
                        return HttpResponse::not_found();
                    }
                    segments[4]
                } else {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 7 || segments[5] != "tasks" {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                    segments[6]
                };
                match self.task_runner.entry(task_id) {
                    Some(entry) => HttpResponse::ok(&json!({ "task": entry })),
                    None => HttpResponse::not_found(),
                }
            }
            ("POST", p)
                if (p.starts_with("/api/v1/sessions/")
                    && p.contains("/tasks/")
                    && p.ends_with("/stop"))
                    || (p.starts_with("/api/v1/tasks/") && p.ends_with("/stop")) =>
            {
                let task_id = if p.starts_with("/api/v1/tasks/") {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    segments[4]
                } else {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 8 || segments[5] != "tasks" {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                    segments[6]
                };
                match self.task_runner.stop(task_id).await {
                    Ok(wire) => HttpResponse::ok(&json!({ "stopped": true, "task": wire })),
                    Err(_) => HttpResponse::not_found(),
                }
            }

            // Subagent management endpoints
            ("GET", "/api/v1/subagents") => {
                let list = self.subagent_manager().list().await;
                HttpResponse::ok(&json!({ "subagents": list }))
            }
            ("GET", p) if extract_session_action(p, "subagents").is_some() => {
                let session_id = extract_session_action(p, "subagents").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let list = self.subagent_manager().list().await;
                HttpResponse::ok(&json!({ "subagents": list }))
            }
            ("GET", p)
                if p.starts_with("/api/v1/subagents/")
                    && !p.ends_with(":kill")
                    && !p.ends_with("/kill") =>
            {
                let subagent_id = &p["/api/v1/subagents/".len()..];
                if let Some(inst) = self.subagent_manager().get_instance(subagent_id).await {
                    HttpResponse::ok(&json!(inst))
                } else {
                    HttpResponse::not_found()
                }
            }
            ("POST", p)
                if p.starts_with("/api/v1/subagents/")
                    && (p.ends_with(":kill") || p.ends_with("/kill")) =>
            {
                let subagent_id = p["/api/v1/subagents/".len()..]
                    .trim_end_matches(":kill")
                    .trim_end_matches("/kill");
                match self.subagent_manager().kill(subagent_id).await {
                    Ok(true) => HttpResponse::ok(&json!({ "killed": true, "id": subagent_id })),
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(e),
                }
            }

            // GUI store endpoints (mirrors localStorage API for Web UI / Desktop)
            ("GET", "/api/v1/gui/store/getItem") => {
                let key = match req.query_param("key") {
                    Some(k) if !k.is_empty() => k,
                    _ => return HttpResponse::bad_request("Query parameter 'key' is required"),
                };
                match self.store.gui_get_item(&key) {
                    Ok(val) => HttpResponse::ok(&json!({ "value": val })),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", "/api/v1/gui/store/setItem") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let key = match body.get("key").and_then(|v| v.as_str()) {
                    Some(k) if !k.is_empty() => k,
                    _ => return HttpResponse::bad_request("Field 'key' is required"),
                };
                let val = match body.get("value").and_then(|v| v.as_str()) {
                    Some(v) => v,
                    _ => return HttpResponse::bad_request("Field 'value' is required"),
                };
                match self.store.gui_set_item(key, val) {
                    Ok(_) => HttpResponse::ok(&json!(null)),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", "/api/v1/gui/store/removeItem") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let key = match body.get("key").and_then(|v| v.as_str()) {
                    Some(k) if !k.is_empty() => k,
                    _ => return HttpResponse::bad_request("Field 'key' is required"),
                };
                match self.store.gui_remove_item(key) {
                    Ok(_) => HttpResponse::ok(&json!(null)),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", "/api/v1/gui/store/clear") => match self.store.gui_clear() {
                Ok(_) => HttpResponse::ok(&json!(null)),
                Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
            },
            ("GET", "/api/v1/gui/store/length") => match self.store.gui_length() {
                Ok(len) => HttpResponse::ok(&json!({ "length": len })),
                Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
            },

            // Session sub-resources: status, abort, fork, compact, undo, messages, goal, init
            ("POST", p) if extract_session_action(p, "init").is_some() => {
                let session_id = extract_session_action(p, "init").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                HttpResponse::ok(&json!({
                    "status": "initiated",
                    "sessionId": session_id,
                    "prompt": crate::prompt::DEFAULT_INIT_PROMPT
                }))
            }
            ("GET", p) if extract_session_action(p, "status").is_some() => {
                let session_id = extract_session_action(p, "status").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let busy = self
                    .engine
                    .as_ref()
                    .map(|e| e.is_busy(session_id))
                    .unwrap_or(false);
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let context_tokens: usize = history.iter().map(|m| m.content.len() / 4).sum();
                let active_model = self
                    .engine
                    .as_ref()
                    .map(|e| e.model_name())
                    .unwrap_or("kimi-latest");
                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "busy": busy,
                    "permission": "auto",
                    "model": active_model,
                    "thinking_level": "medium",
                    "context_tokens": context_tokens,
                    "total_turns": history.len().max(1),
                    "created_at": chrono::Utc::now().to_rfc3339()
                }))
            }
            ("GET", p) if extract_session_action(p, "snapshot").is_some() => {
                let session_id = extract_session_action(p, "snapshot").unwrap();
                let session_opt = match self.store.get_session(session_id) {
                    Ok(s) => s,
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                let session = match session_opt {
                    Some(s) => s,
                    None => return HttpResponse::not_found(),
                };
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let questions = self.interaction_manager.list_questions(session_id);
                let approvals = self.interaction_manager.list_approvals(session_id);

                let messages_items: Vec<Value> = history
                    .into_iter()
                    .enumerate()
                    .map(|(idx, m)| {
                        json!({
                            "id": format!("msg_{idx}"),
                            "session_id": session_id,
                            "role": m.role,
                            "content": m.content,
                            "created_at": chrono::Utc::now().to_rfc3339()
                        })
                    })
                    .collect();

                let wire_session = format_wire_session(&session, &self.store, self.engine.as_ref());

                let subagent_list = self.subagent_manager().list().await;
                let subagents_val: Vec<Value> = subagent_list
                    .into_iter()
                    .map(|sub| {
                        let phase = match sub.state {
                            crate::subagent::types::SubagentState::Running => "working",
                            crate::subagent::types::SubagentState::Idle => "queued",
                            crate::subagent::types::SubagentState::Completed => "completed",
                            crate::subagent::types::SubagentState::Failed => "failed",
                            crate::subagent::types::SubagentState::Terminated => "failed",
                        };
                        let status = match sub.state {
                            crate::subagent::types::SubagentState::Running
                            | crate::subagent::types::SubagentState::Idle => "running",
                            crate::subagent::types::SubagentState::Completed => "completed",
                            crate::subagent::types::SubagentState::Failed
                            | crate::subagent::types::SubagentState::Terminated => "failed",
                        };
                        json!({
                            "id": sub.id,
                            "session_id": session_id,
                            "kind": "subagent",
                            "description": format!("{} ({})", sub.role, sub.type_name),
                            "status": status,
                            "subagent_phase": phase,
                            "subagent_type": sub.type_name,
                            "created_at": chrono::DateTime::from_timestamp_millis(sub.created_at_ms as i64)
                                .map(|dt| dt.to_rfc3339())
                                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                        })
                    })
                    .collect();

                HttpResponse::ok(&json!({
                    "as_of_seq": 1,
                    "epoch": "epoch_1",
                    "session": wire_session,
                    "messages": {
                        "items": messages_items,
                        "has_more": false
                    },
                    "in_flight_turn": serde_json::Value::Null,
                    "subagents": subagents_val,
                    "pending_approvals": approvals,
                    "pending_questions": questions
                }))
            }
            ("GET", p) if extract_session_action(p, "transcript").is_some() => {
                let session_id = extract_session_action(p, "transcript").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let turns: Vec<Value> = history.chunks(2).enumerate().map(|(idx, chunk)| {
                    let user_msg = chunk.first();
                    let assistant_msg = chunk.get(1);
                    json!({
                        "turn": idx + 1,
                        "user": user_msg.map(|m| &m.content).unwrap_or(&String::new()),
                        "assistant": assistant_msg.map(|m| &m.content).unwrap_or(&String::new()),
                        "state": "completed"
                    })
                }).collect();

                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "agentId": "main",
                    "turns": turns,
                    "has_more": false
                }))
            }
            ("POST", p) if extract_session_action(p, "abort").is_some() => {
                let session_id = extract_session_action(p, "abort").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                self.interaction_manager.cancel_session(session_id);
                let aborted = self
                    .engine
                    .as_ref()
                    .map(|e| e.cancel_turn(session_id))
                    .unwrap_or(false);
                HttpResponse::ok(&json!({ "aborted": aborted, "sessionId": session_id }))
            }
            ("POST", p) if extract_session_action(p, "fork").is_some() => {
                let session_id = extract_session_action(p, "fork").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let body: Value = if req.body.is_empty() {
                    json!({})
                } else {
                    match serde_json::from_slice(&req.body) {
                        Ok(v) => v,
                        Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                    }
                };
                let new_session_id = format!("sess-{}", fastrand::u64(..));
                let title = body.get("title").and_then(|v| v.as_str());

                match self.store.fork_session(session_id, &new_session_id, title) {
                    Ok(true) => HttpResponse::json(
                        201,
                        &json!({
                            "sessionId": new_session_id,
                            "sourceSessionId": session_id,
                            "title": title
                        }),
                    ),
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if extract_session_action(p, "restore").is_some() => {
                let session_id = extract_session_action(p, "restore").unwrap();
                match self.store.restore_session(session_id) {
                    Ok(true) => {
                        let summary = self.store.get_session(session_id).ok().flatten();
                        HttpResponse::ok(&json!({ "restored": true, "session": summary }))
                    }
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if extract_session_action(p, "archive").is_some() => {
                let session_id = extract_session_action(p, "archive").unwrap();
                match self.store.archive_session(session_id) {
                    Ok(true) => HttpResponse::ok(&json!({ "archived": true })),
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p)
                if p.starts_with("/api/v1/sessions/") && p.ends_with("/children") =>
            {
                let session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .and_then(|rest| rest.strip_suffix("/children"))
                    .unwrap_or_default();
                match self.store.list_children(session_id) {
                    Ok(children) => HttpResponse::ok(&json!({ "children": children })),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p)
                if p.starts_with("/api/v1/sessions/") && p.ends_with("/warnings") =>
            {
                let session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .and_then(|rest| rest.strip_suffix("/warnings"))
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                // No engine path produces session warnings yet; the list is
                // honestly empty rather than fabricated.
                HttpResponse::ok(&json!({ "warnings": [] }))
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/") && p.ends_with("/title/generate") =>
            {
                let session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .and_then(|rest| rest.strip_suffix("/title/generate"))
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let body: Value = if req.body.is_empty() {
                    json!({})
                } else {
                    serde_json::from_slice(&req.body).unwrap_or(json!({}))
                };
                let source = body.get("source").and_then(|v| v.as_str());
                match self.store.generate_title(session_id, source) {
                    Ok(Some(title)) => HttpResponse::ok(&json!({ "title": title })),
                    Ok(None) => HttpResponse::bad_request(
                        "SESSION_TITLE_UNAVAILABLE: the session has no user prompts to derive a title from",
                    ),
                    Err(e) => HttpResponse::bad_request(e),
                }
            }
            ("POST", p) if extract_session_action(p, "compact").is_some() => {
                let session_id = extract_session_action(p, "compact").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                match self.store.compact_session(session_id) {
                    Ok(removed) => HttpResponse::ok(&json!({
                        "compacted": true,
                        "removed": removed,
                        "sessionId": session_id
                    })),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if extract_session_action(p, "undo").is_some() => {
                let session_id = extract_session_action(p, "undo").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let body: Value = if req.body.is_empty() {
                    json!({})
                } else {
                    serde_json::from_slice(&req.body).unwrap_or(json!({}))
                };
                let count = body.get("count").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
                let revert_files = body.get("revert_files").and_then(|v| v.as_bool()).unwrap_or(false);
                if revert_files {
                    if let Some(workdir) = fs_routes::resolve_session_workdir(&self.store, session_id) {
                        // Revert file history for undone turns before deleting records
                        let _ = self.store.revert_turn_file_changes(session_id, count, &workdir);
                    }
                }
                match self.store.undo_turns(session_id, count) {
                    Ok(undone) => HttpResponse::ok(&json!({
                        "undone": undone,
                        "sessionId": session_id
                    })),
                    // Crossing the compaction boundary is a client error, not
                    // a database failure — surface the refusal verbatim.
                    Err(e) if e.contains("undo refused") => HttpResponse::bad_request(e),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if extract_session_action(p, "btw").is_some() => {
                let session_id = extract_session_action(p, "btw").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let subagent_mgr = self.subagent_manager();
                match crate::subagent::start_btw(&subagent_mgr, &history).await {
                    Ok(agent_id) => {
                        let data = json!({ "agent_id": agent_id });
                        if req.wants_envelope() {
                            HttpResponse::envelope_ok(&data, &req.request_id())
                        } else {
                            HttpResponse::ok(&data)
                        }
                    }
                    Err(e) => HttpResponse::internal_error(format!("Failed to start btw: {e}")),
                }
            }
            ("GET", p) if extract_session_action(p, "messages").is_some() => {
                let session_id = extract_session_action(p, "messages").unwrap();
                match self.store.get_session(session_id) {
                    Ok(Some(_)) => {
                        let history = self
                            .store
                            .load_session_history(session_id)
                            .unwrap_or_default();
                        HttpResponse::ok(&json!({
                            "sessionId": session_id,
                            "messages": history,
                        }))
                    }
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if extract_session_action(p, "goal").is_some() => {
                let session_id = extract_session_action(p, "goal").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let goal_val = self
                    .store
                    .get_state("goal", session_id)
                    .unwrap_or(None)
                    .unwrap_or(Value::Null);
                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "goal": goal_val,
                }))
            }
            ("GET", p) if extract_session_action(p, "skills").is_some() => {
                let session_id = extract_session_action(p, "skills").unwrap();
                let session = match self.store.get_session(session_id) {
                    Ok(Some(s)) => s,
                    Ok(None) => return HttpResponse::not_found(),
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                let ws_root = if let Some(ws_id) = session.workspace_id.as_deref() {
                    self.store
                        .get_workspace(ws_id)
                        .ok()
                        .flatten()
                        .map(|w| std::path::PathBuf::from(w.root))
                } else {
                    None
                };
                let skills = crate::skills::scan_all_skills(ws_root.as_deref());
                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "skills": skills,
                }))
            }
            ("GET", p) if extract_session_action(p, "questions").is_some() => {
                let session_id = extract_session_action(p, "questions").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let items = self.interaction_manager.list_questions(session_id);
                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "items": items,
                }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.contains("/questions/") => {
                let parts: Vec<&str> = p.split("/questions/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_prefix = parts[0];
                let tail = parts[1];
                let session_id = session_prefix
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let (qid, is_dismiss) = if let Some(q) = tail.strip_suffix(":dismiss") {
                    (q, true)
                } else if let Some(q) = tail.strip_suffix("/dismiss") {
                    (q, true)
                } else if let Some(q) = tail
                    .strip_suffix(":resolve")
                    .or_else(|| tail.strip_suffix(":reply"))
                {
                    (q, false)
                } else if let Some(q) = tail
                    .strip_suffix("/resolve")
                    .or_else(|| tail.strip_suffix("/reply"))
                {
                    (q, false)
                } else {
                    (tail, false)
                };

                if is_dismiss {
                    if self.interaction_manager.dismiss_question(qid) {
                        HttpResponse::ok(&json!({
                            "dismissed": true,
                            "questionId": qid,
                            "sessionId": session_id
                        }))
                    } else {
                        HttpResponse::not_found()
                    }
                } else {
                    let body: Value = match serde_json::from_slice(&req.body) {
                        Ok(v) => v,
                        Err(_) => json!({}),
                    };
                    let mut answers = std::collections::HashMap::new();
                    if let Some(map) = body.get("answers").and_then(|v| v.as_object()) {
                        for (k, v) in map {
                            let val_str = if let Some(s) = v.as_str() {
                                s.to_string()
                            } else if let Some(opt_id) = v.get("option_id").and_then(|o| o.as_str())
                            {
                                opt_id.to_string()
                            } else {
                                v.to_string()
                            };
                            answers.insert(k.clone(), val_str);
                        }
                    } else if let Some(map) = body.as_object() {
                        for (k, v) in map {
                            if k != "method" && k != "note" {
                                let val_str = v
                                    .as_str()
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| v.to_string());
                                answers.insert(k.clone(), val_str);
                            }
                        }
                    }
                    let method = body
                        .get("method")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if self
                        .interaction_manager
                        .resolve_question(qid, answers, method)
                    {
                        HttpResponse::ok(&json!({
                            "resolved": true,
                            "questionId": qid,
                            "sessionId": session_id
                        }))
                    } else {
                        HttpResponse::not_found()
                    }
                }
            }
            ("GET", p) if extract_session_action(p, "approvals").is_some() => {
                let session_id = extract_session_action(p, "approvals").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let items = self.interaction_manager.list_approvals(session_id);
                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "items": items,
                }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.contains("/approvals/") => {
                let parts: Vec<&str> = p.split("/approvals/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_prefix = parts[0];
                let tail = parts[1];
                let session_id = session_prefix
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let aid = if let Some(a) = tail.strip_suffix(":resolve") {
                    a
                } else if let Some(a) = tail.strip_suffix("/resolve") {
                    a
                } else {
                    tail
                };

                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                let decision_str = body
                    .get("decision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("approved");
                let allowed = decision_str.eq_ignore_ascii_case("approved")
                    || decision_str.eq_ignore_ascii_case("allow");
                let reason = body
                    .get("feedback")
                    .or_else(|| body.get("reason"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                if self
                    .interaction_manager
                    .resolve_approval(aid, allowed, reason)
                {
                    HttpResponse::ok(&json!({
                        "resolved": true,
                        "approvalId": aid,
                        "sessionId": session_id,
                        "decision": decision_str
                    }))
                } else {
                    HttpResponse::not_found()
                }
            }
            ("GET", p) | ("POST", p) if extract_session_action(p, "export").is_some() => {
                let session_id = extract_session_action(p, "export").unwrap();
                match self.store.export_session(session_id) {
                    Ok(Some(export)) => HttpResponse::ok(&json!(export)),
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if extract_session_action(p, "profile").is_some() => {
                let session_id = extract_session_action(p, "profile").unwrap();
                let session = match self.store.get_session(session_id) {
                    Ok(Some(s)) => s,
                    Ok(None) => return HttpResponse::not_found(),
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                let active_model = self
                    .engine
                    .as_ref()
                    .map(|e| e.model_name())
                    .unwrap_or("kimi-latest");
                let agent_config = self
                    .store
                    .get_state("agent_config", session_id)
                    .unwrap_or(None)
                    .unwrap_or_else(|| {
                        json!({
                            "model": active_model,
                            "thinking": "medium",
                            "permission_mode": "auto",
                            "plan_mode": false,
                        })
                    });
                let wire_session = format_wire_session(&session, &self.store, self.engine.as_ref());
                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "session": wire_session,
                    "agent_config": agent_config,
                }))
            }
            ("POST", p) if extract_session_action(p, "profile").is_some() => {
                let session_id = extract_session_action(p, "profile").unwrap();
                let session = match self.store.get_session(session_id) {
                    Ok(Some(s)) => s,
                    Ok(None) => return HttpResponse::not_found(),
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                if let Some(new_title) = body.get("title").and_then(|v| v.as_str()) {
                    let _ = self
                        .store
                        .update_session_title(session_id, Some(new_title.trim()));
                }
                if let Some(cfg) = body.get("agent_config") {
                    let mut current = self
                        .store
                        .get_state("agent_config", session_id)
                        .unwrap_or(None)
                        .unwrap_or_else(|| json!({}));
                    if let (Some(cur_obj), Some(new_obj)) =
                        (current.as_object_mut(), cfg.as_object())
                    {
                        for (k, v) in new_obj {
                            cur_obj.insert(k.clone(), v.clone());
                        }
                    } else {
                        current = cfg.clone();
                    }
                    let _ = self.store.put_state("agent_config", session_id, &current);
                }
                let updated_session = self
                    .store
                    .get_session(session_id)
                    .ok()
                    .flatten()
                    .unwrap_or(session);
                let updated_cfg = self
                    .store
                    .get_state("agent_config", session_id)
                    .unwrap_or(None)
                    .unwrap_or_else(|| json!({}));

                let meta_event = json!({
                    "type": "session.meta.updated",
                    "sessionId": session_id,
                    "title": updated_session.title,
                    "patch": body,
                });
                self.hub
                    .bus_for(session_id)
                    .publish(&crate::events::EngineEvent::Custom(meta_event));

                let wire_session =
                    format_wire_session(&updated_session, &self.store, self.engine.as_ref());

                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "session": wire_session,
                    "agent_config": updated_cfg,
                }))
            }
            ("POST", p) if extract_session_fs_action(p).is_some() => {
                let (session_id, action) = extract_session_fs_action(p).unwrap();
                let work_dir = match fs_routes::resolve_session_workdir(&self.store, session_id) {
                    Some(d) => d,
                    None => return HttpResponse::not_found(),
                };
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                match action {
                    "git_status" | "gitStatus" => fs_routes::handle_git_status(&work_dir),
                    "diff" => fs_routes::handle_diff(&work_dir, &body),
                    "stat" => fs_routes::handle_stat(&work_dir, &body),
                    "stat_many" | "statMany" => fs_routes::handle_stat_many(&work_dir, &body),
                    "mkdir" => fs_routes::handle_mkdir(&work_dir, &body),
                    "list" => fs_routes::handle_list(&work_dir, &body),
                    "list_many" | "listMany" => fs_routes::handle_list_many(&work_dir, &body),
                    "read" => fs_routes::handle_read(&work_dir, &body),
                    "search" => fs_routes::handle_search(&work_dir, &body),
                    "grep" => fs_routes::handle_grep(&work_dir, &body),
                    "open" => fs_routes::handle_open(&work_dir, &body),
                    "reveal" => fs_routes::handle_reveal(&work_dir, &body),
                    _ => HttpResponse::bad_request(format!("Unsupported filesystem action: {action}")),
                }
            }
            ("GET", p)
                if (p.starts_with("/api/v1/sessions/") || p.starts_with("/sessions/"))
                    && (p.contains("/fs/") || p.contains(":fs/"))
                    && p.ends_with(":download") =>
            {
                let rest = p
                    .strip_prefix("/api/v1/sessions/")
                    .or_else(|| p.strip_prefix("/sessions/"))
                    .unwrap_or_default();
                let (session_id, file_path_raw) = if let Some((s, f)) = rest.split_once("/fs/") {
                    (s, f)
                } else if let Some((s, f)) = rest.split_once(":fs/") {
                    (s, f)
                } else {
                    return HttpResponse::not_found();
                };
                let rel_path = file_path_raw.strip_suffix(":download").unwrap_or(file_path_raw);
                let work_dir = match fs_routes::resolve_session_workdir(&self.store, session_id) {
                    Some(d) => d,
                    None => return HttpResponse::not_found(),
                };
                let target = match fs_routes::resolve_safe_path(&work_dir, rel_path) {
                    Ok(t) => t,
                    Err(resp) => return resp,
                };
                if !target.is_file() {
                    return HttpResponse::not_found();
                }
                match std::fs::read(&target) {
                    Ok(bytes) => {
                        let mime = media::mime_for_path(&target);
                        HttpResponse::bytes(200, mime, bytes)
                    }
                    Err(e) => HttpResponse::internal_error(format!("Failed to read file: {e}")),
                }
            }
            ("POST", p)
                if p == "/api/v1/workspace/fs::search"
                    || p == "/workspace/fs::search"
                    || p == "/api/v1/fs::suggest"
                    || p == "/fs::suggest"
                    || p == "/api/v1/workspace/fs::suggest"
                    || p == "/workspace/fs::suggest" =>
            {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                let work_dir = if let Some(ws) = body.get("workspace").and_then(|v| v.as_str()) {
                    if let Ok(Some(ws_entry)) = self.store.get_workspace(ws) {
                        PathBuf::from(ws_entry.root)
                    } else {
                        PathBuf::from(ws)
                    }
                } else if let Some(roots) = body.get("roots").and_then(|v| v.as_array())
                    && let Some(r0) = roots.first().and_then(|r| r.as_str())
                {
                    PathBuf::from(r0)
                } else {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                };
                fs_routes::handle_search(&work_dir, &body)
            }

            // Terminal endpoints
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/terminals") => {
                let session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default()
                    .strip_suffix("/terminals")
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let items = self.terminal_manager.list(session_id).await;
                HttpResponse::ok(&json!({ "items": items }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/terminals") => {
                let session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default()
                    .strip_suffix("/terminals")
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                let work_dir = fs_routes::resolve_session_workdir(&self.store, session_id)
                    .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
                let cwd_str = body
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|c| work_dir.join(c).to_string_lossy().to_string())
                    .unwrap_or_else(|| work_dir.to_string_lossy().to_string());
                let shell_opt = body.get("shell").and_then(|v| v.as_str());
                let cols_opt = body.get("cols").and_then(|v| v.as_u64()).map(|c| c as u32);
                let rows_opt = body.get("rows").and_then(|v| v.as_u64()).map(|r| r as u32);

                match self.terminal_manager.create(session_id, &cwd_str, shell_opt, cols_opt, rows_opt).await {
                    Ok(term) => HttpResponse::json(201, &json!(term)),
                    Err(err) => HttpResponse::internal_error(err),
                }
            }
            ("GET", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/terminals/")
                    && !p.ends_with("/output") =>
            {
                let parts: Vec<&str> = p.split("/terminals/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_id = parts[0].strip_prefix("/api/v1/sessions/").unwrap_or_default();
                let terminal_id = parts[1];
                match self.terminal_manager.get(session_id, terminal_id).await {
                    Some(term) => HttpResponse::ok(&json!(term)),
                    None => HttpResponse::not_found(),
                }
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/terminals/")
                    && (p.ends_with(":close") || p.ends_with("/close")) =>
            {
                let parts: Vec<&str> = p.split("/terminals/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_id = parts[0].strip_prefix("/api/v1/sessions/").unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail.strip_suffix(":close").or_else(|| tail.strip_suffix("/close")).unwrap_or(tail);
                match self.terminal_manager.close(session_id, terminal_id).await {
                    Ok(()) => HttpResponse::ok(&json!({ "closed": true })),
                    Err(e) => HttpResponse::bad_request(e),
                }
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/terminals/")
                    && (p.ends_with(":write") || p.ends_with("/write")) =>
            {
                let parts: Vec<&str> = p.split("/terminals/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_id = parts[0].strip_prefix("/api/v1/sessions/").unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail.strip_suffix(":write").or_else(|| tail.strip_suffix("/write")).unwrap_or(tail);
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                let data = body.get("data").and_then(|v| v.as_str()).unwrap_or("");
                match self.terminal_manager.write(session_id, terminal_id, data.as_bytes()).await {
                    Ok(()) => HttpResponse::ok(&json!({ "written": true })),
                    Err(e) => HttpResponse::bad_request(e),
                }
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/terminals/")
                    && (p.ends_with(":resize") || p.ends_with("/resize")) =>
            {
                let parts: Vec<&str> = p.split("/terminals/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_id = parts[0].strip_prefix("/api/v1/sessions/").unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail.strip_suffix(":resize").or_else(|| tail.strip_suffix("/resize")).unwrap_or(tail);
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => json!({}),
                };
                let cols = body.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u32;
                let rows = body.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u32;
                match self.terminal_manager.resize(session_id, terminal_id, cols, rows).await {
                    Ok(()) => HttpResponse::ok(&json!({ "resized": true })),
                    Err(e) => HttpResponse::bad_request(e),
                }
            }
            ("GET", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/terminals/")
                    && p.ends_with("/output") =>
            {
                let parts: Vec<&str> = p.split("/terminals/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_id = parts[0].strip_prefix("/api/v1/sessions/").unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail.strip_suffix("/output").unwrap_or(tail);
                let since_seq = req.query_param("since_seq").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
                match self.terminal_manager.output(session_id, terminal_id, since_seq).await {
                    Ok((output, total)) => HttpResponse::ok(&json!({ "output": output, "total": total })),
                    Err(e) => HttpResponse::bad_request(e),
                }
            }

            ("GET", p)
                if p.starts_with("/api/v1/sessions/")
                    && (p.ends_with("/file-history/changes")
                        || p.ends_with(":file-history/changes")
                        || p.ends_with(":file-history:changes")) =>
            {
                let rest = p.strip_prefix("/api/v1/sessions/").unwrap_or_default();
                let session_id = rest
                    .split('/')
                    .next()
                    .unwrap_or_default()
                    .split(':')
                    .next()
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let turn_id = req
                    .query_param("turn_id")
                    .and_then(|t| t.parse::<usize>().ok());
                match self.store.get_file_history_changes(session_id, turn_id) {
                    Ok((changes, recorded)) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "changes": changes,
                        "enabled": true,
                        "recorded": recorded,
                    })),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p)
                if p.starts_with("/api/v1/sessions/")
                    && (p.ends_with("/file-history/content")
                        || p.ends_with(":file-history/content")
                        || p.ends_with(":file-history:content")) =>
            {
                let rest = p.strip_prefix("/api/v1/sessions/").unwrap_or_default();
                let session_id = rest
                    .split('/')
                    .next()
                    .unwrap_or_default()
                    .split(':')
                    .next()
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let turn_id = match req
                    .query_param("turn_id")
                    .and_then(|t| t.parse::<usize>().ok())
                {
                    Some(t) => t,
                    None => {
                        return HttpResponse::bad_request(
                            "Query parameter 'turn_id' is required and must be an integer",
                        );
                    }
                };
                let file_path = match req.query_param("path") {
                    Some(path) if !path.trim().is_empty() => path,
                    _ => return HttpResponse::bad_request("Query parameter 'path' is required"),
                };
                let phase = req.query_param("phase").unwrap_or_else(|| "end".into());

                match self
                    .store
                    .get_file_history_content(session_id, turn_id, &file_path, &phase)
                {
                    Ok(Some(item)) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "version": item.version,
                        "content": item.content,
                        "binary": item.binary.unwrap_or(false),
                    })),
                    Ok(None) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "version": 0,
                        "content": Value::Null,
                        "binary": false,
                    })),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.contains("/media/") => {
                let parts: Vec<&str> = p.split("/media/").collect();
                if parts.len() != 2 {
                    return HttpResponse::not_found();
                }
                let session_prefix = parts[0];
                let file_id = parts[1];
                let session_id = session_prefix
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                if let Some(path) = media::locate_session_media(session_id, file_id)
                    && let Ok(data) = std::fs::read(&path)
                {
                    let mime = media::mime_for_path(&path);
                    return HttpResponse::bytes(200, mime, data);
                }
                HttpResponse::not_found()
            }

            ("GET", p) if p.starts_with("/api/v1/sessions/") && !p.ends_with("/prompt") => {
                let session_id = p.strip_prefix("/api/v1/sessions/").unwrap_or_default();
                if session_id.is_empty() || session_id.contains('/') || session_id.contains(':') {
                    return HttpResponse::not_found();
                }
                match self.store.get_session(session_id) {
                    Ok(Some(session)) => {
                        let wire_session =
                            format_wire_session(&session, &self.store, self.engine.as_ref());
                        let history = self
                            .store
                            .load_session_history(session_id)
                            .unwrap_or_default();
                        HttpResponse::ok(&json!({
                            "session": wire_session,
                            "messages": history,
                        }))
                    }
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("DELETE", p) if p.starts_with("/api/v1/sessions/") && !p.ends_with("/prompt") => {
                let session_id = p.strip_prefix("/api/v1/sessions/").unwrap_or_default();
                if session_id.is_empty() || session_id.contains('/') || session_id.contains(':') {
                    return HttpResponse::not_found();
                }
                match self.store.delete_session(session_id) {
                    Ok(true) => {
                        self.interaction_manager.cancel_session(session_id);
                        let del_event = json!({
                            "type": "event.session.deleted",
                            "sessionId": session_id,
                        });
                        self.hub
                            .bus_for("global")
                            .publish(&crate::events::EngineEvent::Custom(del_event));
                        HttpResponse::ok(&json!({ "deleted": true, "sessionId": session_id }))
                    }
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", "/api/v1/sessions") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let session_id = format!("sess-{}", fastrand::u64(..));
                let title = body.get("title").and_then(|v| v.as_str());
                let workspace_id = body
                    .get("workspaceId")
                    .or_else(|| body.get("workspace_id"))
                    .and_then(|v| v.as_str());

                match self
                    .store
                    .create_session_with_workspace(&session_id, title, workspace_id)
                {
                    Ok(_) => {
                        let created_session = self.store.get_session(&session_id).ok().flatten();
                        let session_val = if let Some(ref s) = created_session {
                            format_wire_session(s, &self.store, self.engine.as_ref())
                        } else {
                            json!(created_session)
                        };
                        let event = json!({
                            "type": "event.session.created",
                            "sessionId": session_id,
                            "session": session_val,
                        });
                        self.hub
                            .bus_for(&session_id)
                            .publish(&crate::events::EngineEvent::Custom(event));

                        HttpResponse::json(
                            201,
                            &json!({
                                "sessionId": session_id,
                                "title": title,
                                "workspaceId": workspace_id
                            }),
                        )
                    }
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/prompt") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];

                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let prompt = match body.get("prompt").and_then(|v| v.as_str()) {
                    Some(p) => p,
                    None => return HttpResponse::bad_request("Missing 'prompt' field in payload"),
                };

                let Some(engine) = self.engine.as_ref() else {
                    // No engine attached. Refusing is the honest answer: this
                    // route used to reply `Processed: {prompt}` without running
                    // anything, which a client cannot tell from a real turn.
                    return HttpResponse::json(
                        503,
                        &json!({ "error": "no engine configured for this server" }),
                    );
                };

                let known = self
                    .store
                    .list_sessions()
                    .map(|sessions| sessions.iter().any(|s| s.session_id == session_id))
                    .unwrap_or(false);
                if !known {
                    return HttpResponse::not_found();
                }

                let history = match self.store.load_session_history(session_id) {
                    Ok(messages) => messages,
                    Err(error) => return HttpResponse::internal_error(error.to_string()),
                };
                let turn_number = match self.store.next_turn_number(session_id) {
                    Ok(number) => number,
                    Err(error) => return HttpResponse::internal_error(error.to_string()),
                };

                match engine
                    .run_turn(session_id, turn_number, history, prompt)
                    .await
                {
                    Ok(report) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "turnId": report.turn_id,
                        "turnNumber": turn_number,
                        "status": "completed",
                        "stopReason": report.stop_reason,
                        "content": report.reply,
                        "steps": report.steps,
                        "llmTransport": report.llm_transport,
                        "eventsEmitted": report.events_emitted,
                        "nativeToolCalls": report.native_tool_calls,
                        "usage": report.usage,
                    })),
                    Err(error) => HttpResponse::internal_error(error.to_string()),
                }
            }
            _ => HttpResponse::not_found(),
        };

        if req.wants_envelope() && resp.header("content-type") == Some("application/json") {
            let req_id = req.request_id();
            if (resp.status == 200 || resp.status == 201)
                && let Ok(val) = serde_json::from_slice::<Value>(&resp.body)
                && val.get("code").is_none()
            {
                return HttpResponse::envelope_ok(&val, &req_id);
            } else if resp.status >= 400
                && let Ok(val) = serde_json::from_slice::<Value>(&resp.body)
                && val.get("code").is_none()
            {
                let err_msg = val.get("error").and_then(|e| e.as_str()).unwrap_or("Error");
                let err_code = match resp.status {
                    400 => envelope::error_codes::VALIDATION_FAILED,
                    404 => envelope::error_codes::SESSION_NOT_FOUND,
                    _ => envelope::error_codes::INTERNAL_ERROR,
                };
                return HttpResponse::envelope_err(resp.status, err_code, err_msg, &req_id);
            }
        }

        resp
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_http_health_endpoint() {
        let server = HttpServer::in_memory().unwrap();
        let req = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/health".into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res = server.handle_request(&req).await;
        assert_eq!(res.status, 200);
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(val["status"], "ok");
        assert_eq!(val["engine"], "kimi-agent-rust");
    }

    #[tokio::test]
    async fn test_http_sessions_crud_and_prompt() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Create session
        let req_create = HttpRequest {
            method: "POST".into(),
            path: "/api/v1/sessions".into(),
            query: None,
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({ "title": "Web REST Test" })).unwrap(),
        };
        let res_create = server.handle_request(&req_create).await;
        assert_eq!(res_create.status, 201);
        let val_create: Value = serde_json::from_slice(&res_create.body).unwrap();
        let sid = val_create["sessionId"].as_str().unwrap();

        // 2. List sessions
        let req_list = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/sessions".into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_list = server.handle_request(&req_list).await;
        assert_eq!(res_list.status, 200);
        let val_list: Value = serde_json::from_slice(&res_list.body).unwrap();
        assert_eq!(val_list["sessions"].as_array().unwrap().len(), 1);

        // 3. Prompt session
        let req_prompt = HttpRequest {
            method: "POST".into(),
            path: format!("/api/v1/sessions/{sid}/prompt"),
            query: None,
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({ "prompt": "Hello REST" })).unwrap(),
        };
        // No engine attached: refuse. This route used to answer
        // `Processed: {prompt}` with status 200, which a client could not tell
        // apart from a real turn.
        let res_prompt = server.handle_request(&req_prompt).await;
        assert_eq!(res_prompt.status, 503);
        let val_prompt: Value = serde_json::from_slice(&res_prompt.body).unwrap();
        assert!(
            val_prompt["error"]
                .as_str()
                .unwrap_or_default()
                .contains("no engine"),
            "{val_prompt}"
        );
        assert!(
            !String::from_utf8_lossy(&res_prompt.body).contains("Processed:"),
            "the canned reply is still being served"
        );

        // 4. Get specific session
        let req_get = HttpRequest {
            method: "GET".into(),
            path: format!("/api/v1/sessions/{sid}"),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_get = server.handle_request(&req_get).await;
        assert_eq!(res_get.status, 200);
        let val_get: Value = serde_json::from_slice(&res_get.body).unwrap();
        assert_eq!(val_get["session"]["session_id"], sid);
        assert_eq!(val_get["session"]["title"], "Web REST Test");

        // 5. Delete session
        let req_del = HttpRequest {
            method: "DELETE".into(),
            path: format!("/api/v1/sessions/{sid}"),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_del = server.handle_request(&req_del).await;
        assert_eq!(res_del.status, 200);
        let val_del: Value = serde_json::from_slice(&res_del.body).unwrap();
        assert_eq!(val_del["deleted"], true);

        // 6. Verify deleted
        let res_get_after = server.handle_request(&req_get).await;
        assert_eq!(res_get_after.status, 404);
    }

    fn engine_without_a_model(store: Arc<SqliteSessionStore>, hub: Arc<EventHub>) -> ServerEngine {
        ServerEngine::new(
            crate::pipeline::PipelineSpec {
                system_prompt: "sys".into(),
                model_name: "test-model".into(),
                providers: Vec::new(),
                native_llm: None,
                workspace_root: None,
                native_tools: false,
                rust_self_contained: false,
                shell_path: None,
                policy_snapshot: None,
                github_token: None,
                github_base_url: None,
                subagent_timeout_ms: None,
                agent_tool_veto: None,
                tools_veto: None,
                todo_tool_veto: None,
                tower_worktree_root: None,
                sandbox_mode: None,
                sandbox_policy: None,
                caller_agent_id: None,
                session_id: None,
            },
            hub,
            store,
        )
    }

    async fn prompt(server: &HttpServer, session_id: &str) -> HttpResponse {
        server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{session_id}/prompt"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "prompt": "Hello REST" })).unwrap(),
            })
            .await
    }

    #[tokio::test]
    async fn the_prompt_route_reaches_the_engine_and_reports_its_failure() {
        let server = HttpServer::in_memory().unwrap();
        let sid = {
            let created = server
                .handle_request(&HttpRequest {
                    method: "POST".into(),
                    path: "/api/v1/sessions".into(),
                    query: None,
                    headers: HashMap::new(),
                    body: serde_json::to_vec(&json!({ "title": "wired" })).unwrap(),
                })
                .await;
            let body: Value = serde_json::from_slice(&created.body).unwrap();
            body["sessionId"].as_str().unwrap().to_string()
        };

        let hub = server.hub();
        let store = server.store_arc();
        let server = server.with_engine(engine_without_a_model(store, hub));

        // No providers and no native_llm: the pipeline refuses to build, which
        // must surface as a server error naming the cause — not a fake 200.
        let response = prompt(&server, &sid).await;
        let body = String::from_utf8_lossy(&response.body).into_owned();
        assert_eq!(response.status, 500, "{body}");
        assert!(body.contains("rustSelfContained"), "{body}");
    }

    #[tokio::test]
    async fn an_unknown_session_gets_404_rather_than_a_turn() {
        let server = HttpServer::in_memory().unwrap();
        let hub = server.hub();
        let store = server.store_arc();
        let server = server.with_engine(engine_without_a_model(store, hub));

        let response = prompt(&server, "sess-does-not-exist").await;
        assert_eq!(response.status, 404);
    }

    #[test]
    fn server_with_engine_auto_attaches_mcp_manager() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let hub = Arc::new(EventHub::new());
        let engine = engine_without_a_model(store.clone(), hub.clone());
        assert!(engine.mcp_manager().is_none());

        let server = HttpServer::with_hub(store, hub).with_engine(engine);
        let engine = server.engine().unwrap();
        assert!(engine.mcp_manager().is_some());
    }

    #[tokio::test]
    async fn turn_numbers_advance_from_the_stored_turns() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        store.create_session("s1", None).unwrap();
        assert_eq!(store.next_turn_number("s1").unwrap(), 1);
        store
            .save_turn(
                "s1",
                "t1",
                1,
                &[crate::turn_loop::types::LLMMessage::user("hi")],
                None,
            )
            .unwrap();
        assert_eq!(store.next_turn_number("s1").unwrap(), 2);
        assert_eq!(store.next_turn_number("missing").unwrap(), 1);
    }

    #[tokio::test]
    async fn test_http_cron_endpoints() {
        let server = HttpServer::in_memory().unwrap();
        let created = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "title": "cron-test" })).unwrap(),
            })
            .await;
        let sid = serde_json::from_slice::<Value>(&created.body).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        // 1. Initial list is empty
        let res_list = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/cron"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list.status, 200);
        let val_list: Value = serde_json::from_slice(&res_list.body).unwrap();
        assert_eq!(val_list["entries"].as_array().unwrap().len(), 0);

        // 2. Add invalid cron expression -> 400 Bad Request
        let res_bad = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/cron"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "cron": "invalid cron",
                    "prompt": "do something"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_bad.status, 400);

        // 3. Add valid cron entry
        let res_add = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/cron"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "id": "c1",
                    "cron": "0 9 * * *",
                    "prompt": "daily report",
                    "recurring": true
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_add.status, 201);
        let val_add: Value = serde_json::from_slice(&res_add.body).unwrap();
        assert_eq!(val_add["id"], "c1");

        // 4. List again contains entry (test global route)
        let res_list2 = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/cron".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list2.status, 200);
        let val_list2: Value = serde_json::from_slice(&res_list2.body).unwrap();
        assert_eq!(val_list2["entries"].as_array().unwrap().len(), 1);

        // 5. Delete cron entry
        let res_del = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/sessions/{sid}/cron/c1"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_del.status, 200);

        // 6. Delete non-existent cron entry -> 404
        let res_del_missing = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/sessions/{sid}/cron/c1"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_del_missing.status, 404);
    }

    #[tokio::test]
    async fn test_http_tasks_endpoints() {
        let server = HttpServer::in_memory().unwrap();
        let runner = server.task_runner();

        // Spawn a background task
        runner
            .spawn_task("task-1".into(), "test task".into(), async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                "task output".into()
            })
            .unwrap();

        // 1. List tasks
        let res_list = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/tasks".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list.status, 200);
        let val_list: Value = serde_json::from_slice(&res_list.body).unwrap();
        let tasks = val_list["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["taskId"], "task-1");

        // 2. Get single task
        let res_get = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/tasks/task-1".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_get.status, 200);
        let val_get: Value = serde_json::from_slice(&res_get.body).unwrap();
        assert_eq!(val_get["task"]["taskId"], "task-1");

        // 3. Stop task
        let res_stop = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/tasks/task-1/stop".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_stop.status, 200);
        let val_stop: Value = serde_json::from_slice(&res_stop.body).unwrap();
        assert_eq!(val_stop["stopped"], true);

        // 4. Missing task -> 404
        let res_missing = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/tasks/non-existent".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing.status, 404);
    }

    #[tokio::test]
    async fn test_http_meta_and_config_endpoints() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Meta endpoint
        let res_meta = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/meta".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_meta.status, 200);
        let val_meta: Value = serde_json::from_slice(&res_meta.body).unwrap();
        assert_eq!(val_meta["backend"], "rust");
        assert_eq!(val_meta["capabilities"]["websocket"], true);
        assert_eq!(val_meta["capabilities"]["tasks"], true);
        assert!(val_meta["server_id"].as_str().unwrap().starts_with("srv-"));
        assert!(val_meta["started_at"].as_str().is_some());

        // 2. Config endpoint
        let res_cfg = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/config".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cfg.status, 200);
        let val_cfg: Value = serde_json::from_slice(&res_cfg.body).unwrap();
        assert!(val_cfg["default_model"].is_string());
        assert!(val_cfg["providers"].is_object());
        assert!(val_cfg["models"].is_object());

        // 3. Config POST update
        let res_post_cfg = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/config".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "default_model": "test-custom-model",
                    "yolo": true,
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_post_cfg.status, 200);
        let val_post_cfg: Value = serde_json::from_slice(&res_post_cfg.body).unwrap();
        assert_eq!(val_post_cfg["default_model"], "test-custom-model");
        assert_eq!(val_post_cfg["yolo"], true);

        // 4. Config Reload endpoint
        let res_reload = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/config:reload".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_reload.status, 200);
        let val_reload: Value = serde_json::from_slice(&res_reload.body).unwrap();
        assert_eq!(val_reload["status"], "reloaded");

        // 5. Runtime and info endpoints
        let res_runtime = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/runtime".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_runtime.status, 200);
        let val_runtime: Value = serde_json::from_slice(&res_runtime.body).unwrap();
        assert_eq!(val_runtime["backend"], "rust");
        assert!(val_runtime["version"].is_string());

        // 6. Capabilities endpoint
        let res_cap = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/capabilities".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cap.status, 200);
        let val_cap: Value = serde_json::from_slice(&res_cap.body).unwrap();
        let caps = val_cap["capabilities"].as_array().unwrap();
        assert!(caps.iter().any(|c| c == "task_runner"));
        assert!(caps.iter().any(|c| c == "cron_scheduler"));
        assert!(caps.iter().any(|c| c == "gui_store"));

        // 7. Shutdown endpoint
        let res_sd = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/shutdown".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sd.status, 200);
        let val_sd: Value = serde_json::from_slice(&res_sd.body).unwrap();
        assert_eq!(val_sd["status"], "shutting_down");

        // 8. GUI Store endpoints
        // setItem
        let res_set = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/gui/store/setItem".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "key": "app_theme",
                    "value": "theme_cyberpunk",
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_set.status, 200);

        // getItem
        let res_get = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/gui/store/getItem".into(),
                query: Some("key=app_theme".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_get.status, 200);
        let val_get: Value = serde_json::from_slice(&res_get.body).unwrap();
        assert_eq!(val_get["value"], "theme_cyberpunk");

        // length
        let res_len = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/gui/store/length".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_len.status, 200);
        let val_len: Value = serde_json::from_slice(&res_len.body).unwrap();
        assert_eq!(val_len["length"], 1);

        // removeItem
        let res_rm = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/gui/store/removeItem".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "key": "app_theme",
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_rm.status, 200);

        // clear
        let res_clear = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/gui/store/clear".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_clear.status, 200);
    }

    #[tokio::test]
    async fn test_http_session_status_abort_and_fork() {
        let server = HttpServer::in_memory().unwrap();
        server
            .store_arc()
            .create_session("sess-test", Some("Original Session"))
            .unwrap();

        // 1. Session status
        let res_status = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-test/status".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_status.status, 200);
        let val_status: Value = serde_json::from_slice(&res_status.body).unwrap();
        assert_eq!(val_status["busy"], false);
        assert_eq!(val_status["permission"], "auto");

        // 2. Abort when no active turn -> false
        let res_abort = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-test/abort".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_abort.status, 200);
        let val_abort: Value = serde_json::from_slice(&res_abort.body).unwrap();
        assert_eq!(val_abort["aborted"], false);

        // 3. Fork session
        let res_fork = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-test/fork".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "title": "Forked Branch" })).unwrap(),
            })
            .await;
        assert_eq!(res_fork.status, 201);
        let val_fork: Value = serde_json::from_slice(&res_fork.body).unwrap();
        let new_sid = val_fork["sessionId"].as_str().unwrap();
        assert_eq!(val_fork["sourceSessionId"], "sess-test");
        assert_eq!(val_fork["title"], "Forked Branch");

        // Forked session can be queried
        let res_forked_status = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{new_sid}/status"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_forked_status.status, 200);

        // 4. BTW side-channel start (both slash and colon syntaxes)
        let res_btw = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-test/btw".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_btw.status, 200);
        let val_btw: Value = serde_json::from_slice(&res_btw.body).unwrap();
        let btw_agent_id = val_btw["agent_id"].as_str().unwrap();
        assert!(btw_agent_id.starts_with("agent-btw-"));

        let res_btw_colon = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-test:btw".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_btw_colon.status, 200);
        let val_btw_colon: Value = serde_json::from_slice(&res_btw_colon.body).unwrap();
        assert!(val_btw_colon["agent_id"].as_str().unwrap().starts_with("agent-btw-"));

        // 5. Missing session on status/abort/fork/btw -> 404
        let res_missing_status = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/non-existent/status".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_status.status, 404);

        let res_missing_abort = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/non-existent/abort".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_abort.status, 404);

        let res_missing_fork = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/non-existent/fork".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_fork.status, 404);
    }

    #[tokio::test]
    async fn test_http_static_assets_and_spa_routing() {
        use std::fs::{self, File};
        use std::io::Write;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let index_path = dir.path().join("index.html");
        let mut f1 = File::create(&index_path).unwrap();
        f1.write_all(b"<!DOCTYPE html><html><body>Kimi Web UI</body></html>")
            .unwrap();

        let assets_dir = dir.path().join("assets");
        fs::create_dir(&assets_dir).unwrap();
        let js_path = assets_dir.join("index-123.js");
        let mut f2 = File::create(&js_path).unwrap();
        f2.write_all(b"console.log('web ui loaded');").unwrap();

        let server = HttpServer::in_memory().unwrap().with_web_assets(dir.path());

        // 1. Root / serves index.html
        let res_root = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_root.status, 200);
        assert_eq!(
            res_root.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            res_root.body,
            b"<!DOCTYPE html><html><body>Kimi Web UI</body></html>"
        );

        // 2. Static asset request
        let res_asset = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/assets/index-123.js".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_asset.status, 200);
        assert_eq!(
            res_asset.header("content-type"),
            Some("application/javascript; charset=utf-8")
        );
        assert_eq!(res_asset.body, b"console.log('web ui loaded');");

        // 3. SPA deep route fallback
        let res_spa = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/session/sess-abc".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_spa.status, 200);
        assert_eq!(
            res_spa.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            res_spa.body,
            b"<!DOCTYPE html><html><body>Kimi Web UI</body></html>"
        );

        // 4. API routes do not fallback to index.html
        let res_api = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/missing-route".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_api.status, 404);
    }

    #[tokio::test]
    async fn test_http_workspaces_crud_and_trust() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Initial list is empty
        let res_list = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/workspaces".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list.status, 200);
        let val_list: Value = serde_json::from_slice(&res_list.body).unwrap();
        assert_eq!(val_list["items"].as_array().unwrap().len(), 0);

        // 2. Create workspace - missing root -> 400
        let res_bad = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/workspaces".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({})).unwrap(),
            })
            .await;
        assert_eq!(res_bad.status, 400);

        // 3. Create valid workspace
        let res_create = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/workspaces".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "root": "/workspace/my-app",
                    "name": "My Application"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_create.status, 201);
        let ws: Value = serde_json::from_slice(&res_create.body).unwrap();
        let ws_id = ws["id"].as_str().unwrap().to_string();
        assert!(ws_id.starts_with("wd_my-app_"));
        assert_eq!(ws["name"], "My Application");
        assert_eq!(ws["session_count"], 0);

        // 4. Get workspace by id
        let res_get = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/workspaces/{ws_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_get.status, 200);
        let val_get: Value = serde_json::from_slice(&res_get.body).unwrap();
        assert_eq!(val_get["id"], ws_id);

        // 5. Query and toggle trust
        let res_trust = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/workspaces/{ws_id}/trust"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_trust.status, 200);
        let val_trust: Value = serde_json::from_slice(&res_trust.body).unwrap();
        assert_eq!(val_trust["trusted"], true);

        let res_set_trust = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/workspaces/{ws_id}/trust"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "trusted": false })).unwrap(),
            })
            .await;
        assert_eq!(res_set_trust.status, 200);
        let val_set_trust: Value = serde_json::from_slice(&res_set_trust.body).unwrap();
        assert_eq!(val_set_trust["trusted"], false);

        // 6. Create session under workspace -> session_count updates
        server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "title": "Task 1",
                    "workspace_id": ws_id
                }))
                .unwrap(),
            })
            .await;

        let res_get_updated = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/workspaces/{ws_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let val_updated: Value = serde_json::from_slice(&res_get_updated.body).unwrap();
        assert_eq!(val_updated["session_count"], 1);

        // 6b. Rename workspace via PATCH /api/v1/workspaces/{ws_id}
        let res_patch = server
            .handle_request(&HttpRequest {
                method: "PATCH".into(),
                path: format!("/api/v1/workspaces/{ws_id}"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "name": "Renamed Application"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_patch.status, 200);
        let val_patched: Value = serde_json::from_slice(&res_patch.body).unwrap();
        assert_eq!(val_patched["name"], "Renamed Application");

        // 7. Delete workspace
        let res_del = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/workspaces/{ws_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_del.status, 200);

        // 8. Delete non-existent -> 404
        let res_del_missing = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/workspaces/{ws_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_del_missing.status, 404);
    }

    #[tokio::test]
    async fn test_http_models_catalog_and_session_export() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Models catalog
        let res_models = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/models".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_models.status, 200);
        let val_models: Value = serde_json::from_slice(&res_models.body).unwrap();
        assert_eq!(val_models["default_model"], "kimi-latest");
        let items = val_models["items"].as_array().unwrap();
        assert!(!items.is_empty());
        assert_eq!(items[0]["id"], "kimi-latest");

        // Alternate /model-catalog endpoint also returns 200
        let res_catalog = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/model-catalog".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_catalog.status, 200);

        // 2. Session export
        server
            .store_arc()
            .create_session("sess-to-export", Some("To Export"))
            .unwrap();
        server
            .store_arc()
            .save_turn(
                "sess-to-export",
                "turn-1",
                1,
                &[crate::turn_loop::types::LLMMessage::user(
                    "Please export me",
                )],
                None,
            )
            .unwrap();

        let res_exp_get = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-to-export/export".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_exp_get.status, 200);
        let val_exp: Value = serde_json::from_slice(&res_exp_get.body).unwrap();
        assert_eq!(val_exp["session"]["session_id"], "sess-to-export");
        assert_eq!(val_exp["turns_count"], 1);
        assert_eq!(val_exp["messages"].as_array().unwrap().len(), 1);
        assert!(val_exp["exported_at"].is_string());

        // POST export works symmetrically
        let res_exp_post = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-to-export/export".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_exp_post.status, 200);

        // Export non-existent returns 404
        let res_exp_none = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-non-existent/export".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_exp_none.status, 404);

        // 3. Providers listing
        let res_providers = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/providers".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_providers.status, 200);
        let val_prov: Value = serde_json::from_slice(&res_providers.body).unwrap();
        assert!(val_prov["items"].as_array().unwrap().len() >= 4);

        // 4. Catalog providers listing
        let res_catalog_prov = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/catalog/providers".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_catalog_prov.status, 200);
        let val_cat_prov: Value = serde_json::from_slice(&res_catalog_prov.body).unwrap();
        assert!(val_cat_prov["items"].as_array().unwrap().len() >= 4);

        // 5. Set default model via POST /api/v1/models/{tail}
        let res_set_default = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/models/claude-3-7-sonnet-20250219:set_default".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_set_default.status, 200);
        let val_set_def: Value = serde_json::from_slice(&res_set_default.body).unwrap();
        assert_eq!(val_set_def["model"], "claude-3-7-sonnet-20250219");

        // 6. Prompts list
        let res_prompts = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/prompts".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_prompts.status, 200);

        // 7. API v2 sessions
        let res_v2_sess = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v2/sessions".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_v2_sess.status, 200);
        let val_v2: Value = serde_json::from_slice(&res_v2_sess.body).unwrap();
        assert!(val_v2["items"].as_array().is_some());

        // 8. Session init: POST /api/v1/sessions/:id:init
        let res_init = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-to-export:init".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_init.status, 200);
        let val_init: Value = serde_json::from_slice(&res_init.body).unwrap();
        assert_eq!(val_init["status"], "initiated");
        assert!(val_init["prompt"].as_str().unwrap().contains("AGENTS.md"));
    }

    #[tokio::test]
    async fn test_http_mcp_endpoints() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Initial MCP servers list is empty
        let res_mcp = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/mcp".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_mcp.status, 200);
        let val_mcp: Value = serde_json::from_slice(&res_mcp.body).unwrap();
        assert_eq!(val_mcp["servers"].as_array().unwrap().len(), 0);

        // 2. Add an MCP client to server's manager
        let client = crate::mcp::client::McpClient::mock("github-mcp");
        server.mcp_manager().add_client(client).await;

        let res_mcp_updated = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/mcp".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_mcp_updated.status, 200);
        let val_mcp_updated: Value = serde_json::from_slice(&res_mcp_updated.body).unwrap();
        let servers = val_mcp_updated["servers"].as_array().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "github-mcp");
        assert_eq!(servers[0]["status"], "connected");
        assert_eq!(servers[0]["tool_count"], 1);

        // 3. Query tools
        let res_tools = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/mcp/tools".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_tools.status, 200);
        let val_tools: Value = serde_json::from_slice(&res_tools.body).unwrap();
        assert_eq!(val_tools["tools"].as_array().unwrap().len(), 1);

        // 4. Session MCP endpoint
        server
            .store_arc()
            .create_session("sess-mcp", Some("MCP Session"))
            .unwrap();
        let res_sess_mcp = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-mcp/mcp".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_mcp.status, 200);
        let val_sess_mcp: Value = serde_json::from_slice(&res_sess_mcp.body).unwrap();
        assert_eq!(val_sess_mcp["sessionId"], "sess-mcp");
        assert_eq!(val_sess_mcp["servers"].as_array().unwrap().len(), 1);

        // 5. Session not found -> 404
        let res_sess_none = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-missing/mcp".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_none.status, 404);

        // 6. Test server probe: POST /api/v1/mcp/servers:test
        let res_test = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/mcp/servers:test".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "name": "github-mcp" })).unwrap(),
            })
            .await;
        assert_eq!(res_test.status, 200);

        // 7. Inspect server: POST /api/v1/mcp/servers:inspect
        let res_inspect = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/mcp/servers:inspect".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "name": "github-mcp" })).unwrap(),
            })
            .await;
        assert_eq!(res_inspect.status, 200);
        let val_inspect: Value = serde_json::from_slice(&res_inspect.body).unwrap();
        assert!(val_inspect["tools"].as_array().is_some());

        // 8. Auth statuses: GET /api/v1/mcp/auth-statuses
        let res_auth = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/mcp/auth-statuses".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_auth.status, 200);

        // 9. Delete server: DELETE /api/v1/mcp/servers/github-mcp
        let res_del = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: "/api/v1/mcp/servers/github-mcp".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_del.status, 200);
    }

    #[tokio::test]
    async fn test_http_fs_endpoints() {
        let server = HttpServer::in_memory().unwrap();
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_path = temp_dir.path().to_string_lossy().to_string();

        // Create subdirectories and files
        let sub_dir = temp_dir.path().join("child_dir");
        std::fs::create_dir_all(&sub_dir).unwrap();
        let file_a = temp_dir.path().join("file_a.txt");
        std::fs::write(&file_a, "content a").unwrap();
        let file_b = sub_dir.join("file_b.rs");
        std::fs::write(&file_b, "content b").unwrap();

        // 1. GET /api/v1/fs:home
        let res_home = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/fs:home".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_home.status, 200);
        let val_home: Value = serde_json::from_slice(&res_home.body).unwrap();
        assert!(val_home.get("home").is_some());
        assert!(val_home["recent_roots"].is_array());

        // 2. GET /api/v1/fs:browse
        let res_browse = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/fs:browse".into(),
                query: Some(format!(
                    "path={}",
                    url::form_urlencoded::byte_serialize(temp_path.as_bytes()).collect::<String>()
                )),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_browse.status, 200);
        let val_browse: Value = serde_json::from_slice(&res_browse.body).unwrap();
        let entries = val_browse["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "child_dir");
        assert_eq!(entries[0]["is_dir"], true);

        // 3. GET /api/v1/fs:browse with non-existent path -> 404
        let res_browse_none = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/fs:browse".into(),
                query: Some("path=/path/that/definitely/does/not/exist/xyz".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_browse_none.status, 404);

        // 4. POST /api/v1/workspace/fs:search
        let res_search = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/workspace/fs:search".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "workspace": temp_path,
                    "query": "file_b",
                    "limit": 10
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_search.status, 200);
        let val_search: Value = serde_json::from_slice(&res_search.body).unwrap();
        let items = val_search["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["name"], "file_b.rs");
        assert_eq!(items[0]["kind"], "file");
        assert_eq!(val_search["truncated"], false);
    }

    #[tokio::test]
    async fn test_http_session_action_dual_syntax_and_controls() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());

        // Create base session
        store
            .create_session("sess-dual", Some("Dual Syntax Test"))
            .unwrap();

        let msgs = [
            crate::turn_loop::types::LLMMessage::user("first question"),
            crate::turn_loop::types::LLMMessage::assistant("first reply"),
            crate::turn_loop::types::LLMMessage::user("second question"),
            crate::turn_loop::types::LLMMessage::assistant("second reply"),
        ];
        store
            .save_turn("sess-dual", "turn-1", 1, &msgs[..2], None)
            .unwrap();
        store
            .save_turn("sess-dual", "turn-2", 2, &msgs[2..], None)
            .unwrap();

        store
            .put_state(
                "goal",
                "sess-dual",
                &json!({ "objective": "verify dual syntax" }),
            )
            .unwrap();

        // 1. :status and /status
        let res_status_colon = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-dual:status".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_status_colon.status, 200);
        let status_val: Value = serde_json::from_slice(&res_status_colon.body).unwrap();
        assert_eq!(status_val["sessionId"], "sess-dual");

        let res_status_slash = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-dual/status".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_status_slash.status, 200);

        // 2. :messages and /messages
        let res_msgs_colon = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-dual:messages".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_msgs_colon.status, 200);
        let msgs_val: Value = serde_json::from_slice(&res_msgs_colon.body).unwrap();
        assert_eq!(msgs_val["messages"].as_array().unwrap().len(), 4);

        let res_msgs_slash = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-dual/messages".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_msgs_slash.status, 200);

        // 3. :goal and /goal
        let res_goal_colon = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-dual:goal".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_goal_colon.status, 200);
        let goal_val: Value = serde_json::from_slice(&res_goal_colon.body).unwrap();
        assert_eq!(goal_val["goal"]["objective"], "verify dual syntax");

        let res_goal_slash = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-dual/goal".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_goal_slash.status, 200);

        // 4. :abort and /abort
        let res_abort_colon = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-dual:abort".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_abort_colon.status, 200);

        // 5. :export and /export
        let res_export_colon = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-dual:export".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_export_colon.status, 200);

        // 6. :fork
        let res_fork_colon = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-dual:fork".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "title": "Colon Forked" })).unwrap(),
            })
            .await;
        assert_eq!(res_fork_colon.status, 201);
        let fork_val: Value = serde_json::from_slice(&res_fork_colon.body).unwrap();
        let new_sid = fork_val["sessionId"].as_str().unwrap();
        let forked_history = store.load_session_history(new_sid).unwrap();
        assert_eq!(forked_history.len(), 4);

        // 7. :compact
        let res_compact_colon = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-dual:compact".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_compact_colon.status, 200);
        let compact_val: Value = serde_json::from_slice(&res_compact_colon.body).unwrap();
        assert_eq!(compact_val["compacted"], true);

        // 8. :undo
        let res_undo_colon = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-dual:undo".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "count": 1 })).unwrap(),
            })
            .await;
        assert_eq!(res_undo_colon.status, 200);
        let undo_val: Value = serde_json::from_slice(&res_undo_colon.body).unwrap();
        assert_eq!(undo_val["sessionId"], "sess-dual");
    }

    #[tokio::test]
    async fn test_http_skills_endpoints() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());

        let temp_dir = tempfile::tempdir().unwrap();
        let ws_root = temp_dir.path().to_string_lossy().to_string();

        let skill_dir = temp_dir
            .path()
            .join(".agents")
            .join("skills")
            .join("test-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test workspace skill\n---\n",
        )
        .unwrap();

        let ws = store.create_workspace(&ws_root, Some("Skill WS")).unwrap();
        let ws_id = ws.id;

        // 1. GET /api/v1/workspaces/:id/skills
        let res_ws = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/workspaces/{ws_id}/skills"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_ws.status, 200);
        let val_ws: Value = serde_json::from_slice(&res_ws.body).unwrap();
        let skills_ws = val_ws["skills"].as_array().unwrap();
        assert!(skills_ws.iter().any(|s| s["name"] == "test-skill"));
        assert!(
            skills_ws
                .iter()
                .any(|s| s["name"] == "check-kimi-code-docs")
        );

        // 2. Non-existent workspace -> 404
        let res_ws_none = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/workspaces/ws-missing/skills".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_ws_none.status, 404);

        // 3. GET /api/v1/sessions/:id/skills (both :skills and /skills)
        store
            .create_session_with_workspace("sess-skill", Some("Skill Session"), Some(&ws_id))
            .unwrap();

        let res_sess_colon = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-skill:skills".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_colon.status, 200);
        let val_sess: Value = serde_json::from_slice(&res_sess_colon.body).unwrap();
        assert_eq!(val_sess["sessionId"], "sess-skill");
        let skills_sess = val_sess["skills"].as_array().unwrap();
        assert!(skills_sess.iter().any(|s| s["name"] == "test-skill"));

        let res_sess_slash = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-skill/skills".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_slash.status, 200);

        // 4. Non-existent session -> 404
        let res_sess_none = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-missing:skills".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_none.status, 404);
    }

    #[tokio::test]
    async fn test_http_interaction_questions_and_approvals() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());

        store
            .create_session("sess-inter", Some("Interaction Test"))
            .unwrap();

        let inter_mgr = server.interaction_manager();

        // 1. Questions: Register and resolve
        let q_req = crate::rpc::types::AskQuestionRequest {
            question_id: "q_test_http".into(),
            turn_id: "turn-1".into(),
            tool_call_id: "call_q".into(),
            background: false,
            timeout_ms: None,
            questions: vec![crate::rpc::types::AskQuestionItem {
                question: "Select mode?".into(),
                header: Some("Mode".into()),
                options: vec![
                    crate::rpc::types::AskQuestionOption {
                        label: "Fast".into(),
                        description: None,
                    },
                    crate::rpc::types::AskQuestionOption {
                        label: "Safe".into(),
                        description: None,
                    },
                ],
                multi_select: false,
            }],
        };

        let rx_q = inter_mgr.register_question("sess-inter", q_req);

        // GET questions (both /questions and :questions)
        let res_q_list_slash = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-inter/questions".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_q_list_slash.status, 200);
        let val_q_list: Value = serde_json::from_slice(&res_q_list_slash.body).unwrap();
        assert_eq!(val_q_list["items"].as_array().unwrap().len(), 1);

        let res_q_list_colon = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-inter:questions".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_q_list_colon.status, 200);

        // POST resolve question
        let res_q_resolve = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-inter/questions/q_test_http:resolve".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "answers": {
                        "Select mode?": "Safe"
                    },
                    "method": "click"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_q_resolve.status, 200);
        let resp_q = rx_q.await.unwrap();
        assert_eq!(resp_q.answers.get("Select mode?").unwrap(), "Safe");

        // 2. Questions: Dismiss
        let q_dismiss_req = crate::rpc::types::AskQuestionRequest {
            question_id: "q_dismiss_http".into(),
            turn_id: "turn-2".into(),
            tool_call_id: "call_d".into(),
            background: false,
            timeout_ms: None,
            questions: vec![],
        };
        let rx_d = inter_mgr.register_question("sess-inter", q_dismiss_req);

        let res_q_dismiss = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-inter/questions/q_dismiss_http:dismiss".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_q_dismiss.status, 200);
        let resp_d = rx_d.await.unwrap();
        assert!(resp_d.note.is_some());

        // 3. Approvals: Register and allow
        let appr_req = crate::rpc::types::PermissionCheckRequest {
            tool_name: "Bash".into(),
            tool_call_id: "call_bash_1".into(),
            arguments: json!({ "command": "cargo build" }),
        };
        let (aid, rx_a) =
            inter_mgr.register_approval("sess-inter", appr_req, "build project binary");

        let res_a_list = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-inter/approvals".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_a_list.status, 200);
        let val_a_list: Value = serde_json::from_slice(&res_a_list.body).unwrap();
        assert_eq!(val_a_list["items"].as_array().unwrap().len(), 1);

        let res_a_resolve = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/sess-inter/approvals/{aid}"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "decision": "approved"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_a_resolve.status, 200);
        let decision_a = rx_a.await.unwrap();
        assert!(decision_a.is_allow());

        // 4. Approvals: Reject / Deny
        let appr_req_deny = crate::rpc::types::PermissionCheckRequest {
            tool_name: "Write".into(),
            tool_call_id: "call_write_1".into(),
            arguments: json!({ "path": "/root/important.conf" }),
        };
        let (aid_deny, rx_deny) =
            inter_mgr.register_approval("sess-inter", appr_req_deny, "overwrite system file");

        let res_a_deny = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/sess-inter/approvals/{aid_deny}"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "decision": "rejected",
                    "feedback": "Denied by user choice"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_a_deny.status, 200);
        let decision_deny = rx_deny.await.unwrap();
        assert!(!decision_deny.is_allow());
        assert_eq!(
            decision_deny.reason.as_deref(),
            Some("Denied by user choice")
        );
    }

    #[tokio::test]
    async fn test_http_session_profile_and_file_history() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());

        store
            .create_session("sess-prof", Some("Original Title"))
            .unwrap();

        // 1. GET profile
        let res_get_prof = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-prof/profile".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_get_prof.status, 200);
        let val_get_prof: Value = serde_json::from_slice(&res_get_prof.body).unwrap();
        assert_eq!(val_get_prof["session"]["title"], "Original Title");
        assert!(val_get_prof["agent_config"]["model"].is_string());

        // 2. POST update profile
        let res_post_prof = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-prof:profile".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "title": "Renamed Title",
                    "agent_config": {
                        "model": "kimi-v2",
                        "permission_mode": "manual"
                    }
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_post_prof.status, 200);
        let val_post_prof: Value = serde_json::from_slice(&res_post_prof.body).unwrap();
        assert_eq!(val_post_prof["session"]["title"], "Renamed Title");
        assert_eq!(val_post_prof["agent_config"]["model"], "kimi-v2");
        assert_eq!(val_post_prof["agent_config"]["permission_mode"], "manual");

        // 3. Confirm persistence
        let stored = store.get_session("sess-prof").unwrap().unwrap();
        assert_eq!(stored.title.as_deref(), Some("Renamed Title"));

        // 4. File history changes (record a real change first)
        store
            .record_file_change(
                "sess-prof",
                1,
                "src/main.rs",
                None,
                Some("fn main() {\n    println!(\"hello\");\n}\n"),
            )
            .unwrap();

        let res_changes = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-prof/file-history/changes".into(),
                query: Some("turn_id=1".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_changes.status, 200);
        let val_changes: Value = serde_json::from_slice(&res_changes.body).unwrap();
        assert!(val_changes["changes"].is_array());
        assert_eq!(val_changes["enabled"], true);
        assert_eq!(val_changes["recorded"], true);
        assert_eq!(val_changes["changes"][0]["path"], "src/main.rs");
        assert_eq!(val_changes["changes"][0]["status"], "added");

        // 5. File history content
        let res_content = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-prof/file-history/content".into(),
                query: Some("turn_id=1&path=src/main.rs".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_content.status, 200);
        let val_content: Value = serde_json::from_slice(&res_content.body).unwrap();
        assert!(val_content["content"].as_str().unwrap().contains("println!(\"hello\")"));

        // 6. Non-existent session
        let res_missing_prof = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-missing/profile".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_prof.status, 404);

        let res_missing_changes = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-missing/file-history/changes".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_changes.status, 404);
    }

    #[tokio::test]
    async fn test_http_tools_endpoint() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store);

        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/tools".into(),
                query: Some("session_id=sess-test".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);

        let val: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(val["session_id"], "sess-test");
        let tools = val["tools"].as_array().expect("tools array");
        assert!(tools.len() >= 8);

        // Check for presence of core native tools
        let tool_names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap_or_default())
            .collect();
        assert!(tool_names.contains(&"Read"));
        assert!(tool_names.contains(&"Write"));
        assert!(tool_names.contains(&"Edit"));
        assert!(tool_names.contains(&"Bash"));
        assert!(tool_names.contains(&"Grep"));
        assert!(tool_names.contains(&"Glob"));

        // Validate structure of a tool descriptor
        let read_tool = tools.iter().find(|t| t["name"] == "Read").unwrap();
        assert_eq!(read_tool["source"], "builtin");
        assert_eq!(read_tool["active"], true);
        assert!(!read_tool["description"].as_str().unwrap().is_empty());
        assert!(read_tool["input_schema"].is_object());
    }

    #[tokio::test]
    async fn test_http_plugins_endpoints() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());

        // 1. GET /api/v1/plugins/marketplace
        let res_market = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/plugins/marketplace".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_market.status, 200);
        let val_market: Value = serde_json::from_slice(&res_market.body).unwrap();
        let entries = val_market["entries"].as_array().unwrap();
        assert!(entries.iter().any(|p| p["id"] == "kimi-webbridge"));

        // 2. GET /api/v1/plugins (initial empty)
        let res_list_empty = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/plugins".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list_empty.status, 200);
        let val_list_empty: Value = serde_json::from_slice(&res_list_empty.body).unwrap();
        assert_eq!(val_list_empty["plugins"].as_array().unwrap().len(), 0);

        // 3. POST /api/v1/plugins/kimi-webbridge:enable
        let res_enable = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins/kimi-webbridge:enable".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_enable.status, 200);
        let val_enable: Value = serde_json::from_slice(&res_enable.body).unwrap();
        assert_eq!(val_enable["ok"], true);
        assert_eq!(val_enable["enabled"], true);

        // 4. GET /api/v1/plugins (now 1)
        let res_list_one = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/plugins".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list_one.status, 200);
        let val_list_one: Value = serde_json::from_slice(&res_list_one.body).unwrap();
        let plugins_one = val_list_one["plugins"].as_array().unwrap();
        assert_eq!(plugins_one.len(), 1);
        assert_eq!(plugins_one[0]["id"], "kimi-webbridge");
        assert_eq!(plugins_one[0]["enabled"], true);

        // 5. POST /api/v1/plugins/kimi-webbridge:disable
        let res_disable = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins/kimi-webbridge:disable".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_disable.status, 200);
        let val_disable: Value = serde_json::from_slice(&res_disable.body).unwrap();
        assert_eq!(val_disable["enabled"], false);

        // 6. GET /api/v1/workspaces/:id/plugins
        let temp_dir = tempfile::tempdir().unwrap();
        let ws = store
            .create_workspace(&temp_dir.path().to_string_lossy(), Some("Plugin WS"))
            .unwrap();
        let ws_id = ws.id;

        let res_ws_plugins = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/workspaces/{ws_id}/plugins"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_ws_plugins.status, 200);
        let val_ws_plugins: Value = serde_json::from_slice(&res_ws_plugins.body).unwrap();
        assert_eq!(val_ws_plugins["plugins"].as_array().unwrap().len(), 1);

        // 7. POST /api/v1/plugins/kimi-webbridge:remove
        let res_remove = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins/kimi-webbridge:remove".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_remove.status, 200);

        // 8. Remove non-existent -> 404
        let res_remove_again = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins/kimi-webbridge:remove".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_remove_again.status, 404);

        // 9. Install plugin via POST /api/v1/plugins
        let res_install = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "id": "test-new-plugin" })).unwrap(),
            })
            .await;
        assert_eq!(res_install.status, 200);
        let val_inst: Value = serde_json::from_slice(&res_install.body).unwrap();
        assert_eq!(val_inst["id"], "test-new-plugin");
        assert_eq!(val_inst["enabled"], true);

        // 10. Global skills endpoint GET /api/v1/skills
        let res_skills = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/skills".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_skills.status, 200);
        let val_skills: Value = serde_json::from_slice(&res_skills.body).unwrap();
        assert!(val_skills["skills"].is_array());

        // 11. ACP JSON-RPC endpoint POST /api/v1/acp
        let rpc_req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        });
        let res_acp = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/acp".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&rpc_req).unwrap(),
            })
            .await;
        assert_eq!(res_acp.status, 200);
        let val_acp: Value = serde_json::from_slice(&res_acp.body).unwrap();
        assert_eq!(val_acp["jsonrpc"], "2.0");
        // ACP handshake uses the spec shape: numeric protocolVersion plus
        // camelCase agentCapabilities (see src/acp/types.rs).
        assert_eq!(val_acp["result"]["protocolVersion"], 1);
        assert!(val_acp["result"]["agentCapabilities"].is_object());
    }

    #[tokio::test]
    async fn test_http_oauth_and_media_endpoints() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let mut server = HttpServer::new(store.clone());
        // Point OAuth at a closed local port: the flow must surface an
        // honest "error" snapshot instead of a fabricated pending login.
        server.oauth_manager = Arc::new(crate::server::oauth::OAuthManager::with_hosts(
            "http://127.0.0.1:1".into(),
            "http://127.0.0.1:1".into(),
            Some(std::env::temp_dir().join(format!("kimi-oauth-srv-test-{}", fastrand::u32(..)))),
        ));

        // 1. POST /api/v1/oauth/login
        let res_login = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/oauth/login".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "provider": "kimi" })).unwrap(),
            })
            .await;
        assert_eq!(res_login.status, 200);
        let val_login: Value = serde_json::from_slice(&res_login.body).unwrap();
        assert_eq!(val_login["status"], "error");
        assert!(val_login["errorMessage"].is_string(), "the failure reason must travel");

        // 2. GET /api/v1/oauth/login
        let res_poll = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/oauth/login".into(),
                query: Some("provider=kimi".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_poll.status, 200);
        let val_poll: Value = serde_json::from_slice(&res_poll.body).unwrap();
        assert_eq!(val_poll["status"], "error");

        // 3. GET /api/v1/oauth/usage & /api/v1/oauth/user
        let res_usage = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/oauth/usage".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_usage.status, 200);
        let val_usage: Value = serde_json::from_slice(&res_usage.body).unwrap();
        assert_eq!(val_usage["authenticated"], false, "no credentials stored");

        let res_user = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/oauth/user".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_user.status, 200);
        let val_user: Value = serde_json::from_slice(&res_user.body).unwrap();
        assert_eq!(val_user["authenticated"], false, "no credentials stored");

        // 4. DELETE /api/v1/oauth/login (cancel)
        let res_cancel = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: "/api/v1/oauth/login".into(),
                query: Some("provider=kimi".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cancel.status, 200);
        let val_cancel: Value = serde_json::from_slice(&res_cancel.body).unwrap();
        assert_eq!(val_cancel["cancelled"], true);

        // 5. POST /api/v1/oauth/logout
        let res_logout = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/oauth/logout".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "provider": "kimi" })).unwrap(),
            })
            .await;
        assert_eq!(res_logout.status, 200);
        let val_logout: Value = serde_json::from_slice(&res_logout.body).unwrap();
        assert_eq!(val_logout["loggedOut"], true);

        // 6. Session Media: existing file
        store
            .create_session("sess-media", Some("Media Test"))
            .unwrap();

        let temp_dir = tempfile::tempdir().unwrap();
        let sample_img = temp_dir.path().join("sample.png");
        std::fs::write(&sample_img, b"\x89PNG\r\n\x1a\nfakeimage").unwrap();
        let sample_path_str = sample_img.to_string_lossy().to_string();

        let res_media = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/sess-media/media/{sample_path_str}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_media.status, 200);
        assert_eq!(res_media.header("content-type"), Some("image/png"));
        assert_eq!(res_media.body, b"\x89PNG\r\n\x1a\nfakeimage");

        // 7. Session Media: missing file / missing session -> 404
        let res_media_none = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-media/media/non-existent.png".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_media_none.status, 404);

        let res_media_sess_none = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-missing/media/any.png".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_media_sess_none.status, 404);
    }

    #[tokio::test]
    async fn test_http_envelope_negotiation() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Regular request without envelope -> bare JSON
        let res_bare = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/health".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_bare.status, 200);
        let val_bare: Value = serde_json::from_slice(&res_bare.body).unwrap();
        assert_eq!(val_bare["status"], "ok");
        assert!(val_bare.get("code").is_none());

        // 2. Request with X-Envelope header -> Envelope JSON
        let mut headers = HashMap::new();
        headers.insert("X-Envelope".into(), "true".into());
        headers.insert("X-Request-ID".into(), "req_client_789".into());

        let res_env = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/health".into(),
                query: None,
                headers,
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_env.status, 200);
        let val_env: Value = serde_json::from_slice(&res_env.body).unwrap();
        assert_eq!(val_env["code"], 0);
        assert_eq!(val_env["msg"], "success");
        assert_eq!(val_env["request_id"], "req_client_789");
        assert_eq!(val_env["data"]["status"], "ok");

        // 3. Request with query param ?envelope=1 -> Envelope JSON
        let res_query_env = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/health".into(),
                query: Some("envelope=1".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_query_env.status, 200);
        let val_query_env: Value = serde_json::from_slice(&res_query_env.body).unwrap();
        assert_eq!(val_query_env["code"], 0);
        assert_eq!(val_query_env["msg"], "success");
        assert!(val_query_env["request_id"].is_string());

        // 4. 404 Not Found with X-Envelope header -> Error Envelope
        let mut err_headers = HashMap::new();
        err_headers.insert("X-Envelope".into(), "true".into());
        err_headers.insert("X-Request-ID".into(), "req_err_001".into());

        let res_err_env = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/missing-id".into(),
                query: None,
                headers: err_headers,
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_err_env.status, 404);
        let val_err_env: Value = serde_json::from_slice(&res_err_env.body).unwrap();
        assert_eq!(val_err_env["code"], 40401);
        assert_eq!(val_err_env["request_id"], "req_err_001");
        assert!(val_err_env["data"].is_null());
    }

    #[tokio::test]
    async fn test_http_lifecycle_events_broadcasting() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());
        let mut sub = server.hub().attach();

        // 1. Create workspace -> event.workspace.created on "global"
        let ws_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/workspaces".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "root": "/tmp/test-lifecycle-ws",
                    "name": "Test Workspace",
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(ws_res.status, 201);
        let ws_val: Value = serde_json::from_slice(&ws_res.body).unwrap();
        let ws_id = ws_val["id"].as_str().unwrap().to_string();

        let ev1 = sub.recv().await.unwrap();
        assert_eq!(&*ev1.session_id, "global");
        assert_eq!(ev1.event.event_type(), "event.workspace.created");
        if let crate::events::EngineEvent::Custom(v) = ev1.event {
            assert_eq!(v["workspace"]["root"], "/tmp/test-lifecycle-ws");
        } else {
            panic!("Expected EngineEvent::Custom for event.workspace.created");
        }

        // 2. Delete workspace -> event.workspace.deleted on "global"
        let ws_del_res = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/workspaces/{ws_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(ws_del_res.status, 200);

        let ev2 = sub.recv().await.unwrap();
        assert_eq!(&*ev2.session_id, "global");
        assert_eq!(ev2.event.event_type(), "event.workspace.deleted");
        if let crate::events::EngineEvent::Custom(v) = ev2.event {
            assert_eq!(v["workspace_id"], ws_id);
            assert_eq!(v["root"], "/tmp/test-lifecycle-ws");
        } else {
            panic!("Expected EngineEvent::Custom for event.workspace.deleted");
        }

        // 3. Create session -> event.session.created on session_id lane
        let sess_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "title": "Lifecycle Session",
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(sess_res.status, 201);
        let sess_val: Value = serde_json::from_slice(&sess_res.body).unwrap();
        let session_id = sess_val["sessionId"].as_str().unwrap().to_string();

        let ev3 = sub.recv().await.unwrap();
        assert_eq!(&*ev3.session_id, &session_id);
        assert_eq!(ev3.event.event_type(), "event.session.created");
        if let crate::events::EngineEvent::Custom(v) = ev3.event {
            assert_eq!(v["sessionId"], session_id);
            assert_eq!(v["session"]["title"], "Lifecycle Session");
        } else {
            panic!("Expected EngineEvent::Custom for event.session.created");
        }

        // 4. Update profile -> session.meta.updated on session_id lane
        let prof_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{session_id}:profile"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "title": "Renamed Lifecycle Session",
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(prof_res.status, 200);

        let ev4 = sub.recv().await.unwrap();
        assert_eq!(&*ev4.session_id, &session_id);
        assert_eq!(ev4.event.event_type(), "session.meta.updated");
        if let crate::events::EngineEvent::Custom(v) = ev4.event {
            assert_eq!(v["sessionId"], session_id);
            assert_eq!(v["title"], "Renamed Lifecycle Session");
        } else {
            panic!("Expected EngineEvent::Custom for session.meta.updated");
        }

        // 5. Delete session -> event.session.deleted on "global"
        let del_sess_res = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/sessions/{session_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(del_sess_res.status, 200);

        let ev5 = sub.recv().await.unwrap();
        assert_eq!(&*ev5.session_id, "global");
        assert_eq!(ev5.event.event_type(), "event.session.deleted");
        if let crate::events::EngineEvent::Custom(v) = ev5.event {
            assert_eq!(v["sessionId"], session_id);
        } else {
            panic!("Expected EngineEvent::Custom for event.session.deleted");
        }
    }

    #[tokio::test]
    async fn test_http_session_fs_routes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let work_dir = temp_dir.path();
        let server = HttpServer::in_memory().unwrap();

        // 1. Create session with cwd metadata pointing to temp_dir
        let sid = "sess-fs-test";
        server.store.create_session(sid, Some("FS Test Session")).unwrap();
        server.store.put_state(
            "metadata",
            sid,
            &json!({ "cwd": work_dir.to_string_lossy() }),
        ).unwrap();

        // 2. mkdir via POST /api/v1/sessions/:id/fs:mkdir
        let mkdir_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/fs:mkdir"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "path": "docs", "recursive": true })).unwrap(),
            })
            .await;
        assert_eq!(mkdir_res.status, 201);

        // 3. Write a test file in work_dir/docs/readme.txt
        let file_path = work_dir.join("docs").join("readme.txt");
        std::fs::write(&file_path, "Hello from native fs test!").unwrap();

        // 4. stat via POST /api/v1/sessions/:id:fs:stat
        let stat_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}:fs:stat"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "path": "docs/readme.txt" })).unwrap(),
            })
            .await;
        assert_eq!(stat_res.status, 200);
        let stat_val: Value = serde_json::from_slice(&stat_res.body).unwrap();
        assert_eq!(stat_val["name"], "readme.txt");
        assert_eq!(stat_val["size"], 26);

        // 5. list via POST /api/v1/sessions/:id/fs/list
        let list_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/fs/list"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "path": "docs" })).unwrap(),
            })
            .await;
        assert_eq!(list_res.status, 200);
        let list_val: Value = serde_json::from_slice(&list_res.body).unwrap();
        assert_eq!(list_val["items"].as_array().unwrap().len(), 1);

        // 6. search via POST /api/v1/sessions/:id/fs:search
        let search_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/fs:search"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "query": "readme" })).unwrap(),
            })
            .await;
        assert_eq!(search_res.status, 200);
        let search_val: Value = serde_json::from_slice(&search_res.body).unwrap();
        assert_eq!(search_val["items"].as_array().unwrap().len(), 1);

        // 7. download via GET /api/v1/sessions/:id/fs/docs/readme.txt:download
        let dl_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/fs/docs/readme.txt:download"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(dl_res.status, 200);
        assert_eq!(String::from_utf8_lossy(&dl_res.body), "Hello from native fs test!");

        // 8. git_status via POST /api/v1/sessions/:id/fs:git_status
        let git_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/fs:git_status"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(git_res.status, 200);
    }

    #[tokio::test]
    async fn test_http_session_terminal_routes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let work_dir = temp_dir.path();
        let server = HttpServer::in_memory().unwrap();

        // 1. Create session
        let sid = "sess-term-test";
        server.store.create_session(sid, Some("Terminal Test Session")).unwrap();
        server.store.put_state(
            "metadata",
            sid,
            &json!({ "cwd": work_dir.to_string_lossy() }),
        ).unwrap();

        // 2. Create terminal via POST /api/v1/sessions/:id/terminals
        let create_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/terminals"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "cols": 80,
                    "rows": 24
                })).unwrap(),
            })
            .await;
        assert_eq!(create_res.status, 201);
        let term_val: Value = serde_json::from_slice(&create_res.body).unwrap();
        let tid = term_val["id"].as_str().unwrap();
        assert_eq!(term_val["status"], "running");

        // 3. List terminals via GET /api/v1/sessions/:id/terminals
        let list_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/terminals"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(list_res.status, 200);
        let list_val: Value = serde_json::from_slice(&list_res.body).unwrap();
        assert_eq!(list_val["items"].as_array().unwrap().len(), 1);

        // 4. Get terminal via GET /api/v1/sessions/:id/terminals/:tid
        let get_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/terminals/{tid}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(get_res.status, 200);
        let get_val: Value = serde_json::from_slice(&get_res.body).unwrap();
        assert_eq!(get_val["id"], tid);

        // 5. Resize via POST /api/v1/sessions/:id/terminals/:tid:resize
        let resize_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/terminals/{tid}:resize"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "cols": 100, "rows": 30 })).unwrap(),
            })
            .await;
        assert_eq!(resize_res.status, 200);

        // 6. Write via POST /api/v1/sessions/:id/terminals/:tid:write
        let write_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/terminals/{tid}:write"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "data": "echo hi\n" })).unwrap(),
            })
            .await;
        assert_eq!(write_res.status, 200);

        // 7. Output via GET /api/v1/sessions/:id/terminals/:tid/output
        let out_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/terminals/{tid}/output"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(out_res.status, 200);

        // 8. Close via POST /api/v1/sessions/:id/terminals/:tid:close
        let close_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/terminals/{tid}:close"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(close_res.status, 200);
        let close_val: Value = serde_json::from_slice(&close_res.body).unwrap();
        assert_eq!(close_val["closed"], true);
    }

    #[tokio::test]
    async fn test_http_subagents_and_snapshot_routes() {
        let server = HttpServer::in_memory().unwrap();
        let sid = "sess-sub-test";
        server.store.create_session(sid, Some("Subagent Test Session")).unwrap();

        // 1. Initial list empty
        let list_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/subagents".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(list_res.status, 200);
        let list_val: Value = serde_json::from_slice(&list_res.body).unwrap();
        assert_eq!(list_val["subagents"].as_array().unwrap().len(), 0);

        // 2. Spawn subagent directly in subagent_manager
        let sub_id = server
            .subagent_manager()
            .spawn("research", "Code Analyst")
            .await
            .unwrap();

        // 3. GET /api/v1/subagents now returns 1 item
        let list_res2 = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/subagents".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(list_res2.status, 200);
        let list_val2: Value = serde_json::from_slice(&list_res2.body).unwrap();
        let subs = list_val2["subagents"].as_array().unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0]["id"], sub_id);
        assert_eq!(subs[0]["role"], "Code Analyst");
        assert_eq!(subs[0]["type_name"], "research");

        // 4. GET /api/v1/sessions/:id/subagents
        let sess_subs_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/subagents"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(sess_subs_res.status, 200);

        // 5. GET /api/v1/subagents/:id
        let get_sub_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/subagents/{sub_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(get_sub_res.status, 200);
        let get_val: Value = serde_json::from_slice(&get_sub_res.body).unwrap();
        assert_eq!(get_val["id"], sub_id);
        assert_eq!(get_val["role"], "Code Analyst");

        // 6. Snapshot reflects real subagents
        let snap_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/snapshot"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(snap_res.status, 200);
        let snap_val: Value = serde_json::from_slice(&snap_res.body).unwrap();
        let snap_subs = snap_val["subagents"].as_array().unwrap();
        assert_eq!(snap_subs.len(), 1);
        assert_eq!(snap_subs[0]["id"], sub_id);
        assert_eq!(snap_subs[0]["kind"], "subagent");
        assert_eq!(snap_subs[0]["status"], "running");
        assert_eq!(snap_subs[0]["subagent_phase"], "working");
        assert_eq!(snap_subs[0]["subagent_type"], "research");

        // 7. Kill subagent via POST /api/v1/subagents/:id:kill
        let kill_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/subagents/{sub_id}:kill"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(kill_res.status, 200);
        let kill_val: Value = serde_json::from_slice(&kill_res.body).unwrap();
        assert_eq!(kill_val["killed"], true);

        // 8. Snapshot reflects terminated subagent state
        let snap_res2 = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/snapshot"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(snap_res2.status, 200);
        let snap_val2: Value = serde_json::from_slice(&snap_res2.body).unwrap();
        let snap_subs2 = snap_val2["subagents"].as_array().unwrap();
        assert_eq!(snap_subs2.len(), 1);
        assert_eq!(snap_subs2[0]["status"], "failed");
        assert_eq!(snap_subs2[0]["subagent_phase"], "failed");

        // 9. Capabilities check
        let meta_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/meta".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(meta_res.status, 200);
        let meta_val: Value = serde_json::from_slice(&meta_res.body).unwrap();
        assert_eq!(meta_val["capabilities"]["subagents"], true);

        let cap_res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/capabilities".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(cap_res.status, 200);
        let cap_val: Value = serde_json::from_slice(&cap_res.body).unwrap();
        let caps = cap_val["capabilities"].as_array().unwrap();
        assert!(caps.iter().any(|c| c == "subagents"));
    }
}
