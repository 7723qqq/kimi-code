//! Native HTTP REST request dispatcher for the Kimi Agent API surface.
//!
//! ## Locking convention
//!
//! The server's registries (event hub lanes, the active-turn table, pending
//! questions and approvals, activity state) are shared by every session and
//! connection. A `std::sync::Mutex` stays poisoned for the rest of the process
//! once a thread panics while holding it, and every later `.lock().unwrap()`
//! panics too — so one panic in one session's callback would take the whole
//! server down. Those locks are therefore taken with
//! `.lock().unwrap_or_else(|poisoned| poisoned.into_inner())`, which recovers
//! the guard instead of propagating the panic.
//!
//! `HttpServer::handle_request` maps a handful of paths (`/health`,
//! `/api/v1/sessions`, `POST /api/v1/sessions/:id/prompt`) onto
//! `SqliteSessionStore`, and [`http::serve`] binds them to a real TCP listener.
//! The one product entry is `kimi-agent --serve <ADDR>`, which builds the store,
//! the engine and the [`ServerAuth`] credential and hands them to
//! [`http::serve`].
//!
//! What is still missing before this fully replaces `packages/kap-server`'s
//! `/api/v1`:
//!
//! - the `subscribe_v2` transcript stream carries the baseline reset plus live
//!   ops projected from engine events and filtered by the subscribed grade
//!   (`off`/`turn`/`block`/`delta`); the REST catch-up
//!   (`GET .../transcript/ops`) serves an authoritative `reset` batch;
//! - the prompt-queue surface is real: `/sessions/{id}/prompts` admits one
//!   active prompt per session with the rest queued FIFO, `:steer` moves queued
//!   prompts into the running turn, and `:abort` settles the active prompt;
//! - the `/api/v1/debug/*` reflection surface (`channels`, `tree`, `graph`,
//!   `subscriptions`, `cascade`) is backed by the live store / hub / engine —
//!   the scope and DI shapes are mapped from those, not a v2 DI ledger.
//!
//! `kimi-agent --serve` is the only `/api/v1` surface: `packages/kap-server`
//! has been retired and removed, and `--legacy-server` / `KIMI_LEGACY_SERVER=1`
//! now fail loudly instead of falling back.

pub mod activity;
pub mod auth;
pub mod custom_registry;
pub mod debug;
pub mod engine;
pub mod envelope;
pub mod file_launch;
pub mod files;
pub mod fs_routes;
pub mod host_guard;
pub mod http;
pub mod hub;
pub mod interaction;
pub mod media;
pub mod message_events;
pub mod model_catalog;
pub mod models_dev;
pub mod oauth;
pub mod plugin_archive;
pub mod plugins;
pub mod prompt_queue;
pub mod provider_refresh;
pub mod provider_write;
pub mod remote_control;
pub mod router;
pub mod static_files;
pub mod terminal;
pub mod transcript;
pub mod web_events;
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
use crate::server::host_guard::HostGuard;
use crate::server::hub::EventHub;
use crate::server::router::{HttpRequest, HttpResponse};
use crate::session::sqlite_store::SqliteSessionStore;
use crate::storage::task_runner::TaskRunner;

/// True when `host` names this machine only.
///
/// `--serve` uses it to decide whether the loopback-only routes are mounted at
/// all, and [`http::serve`] uses it to refuse an unauthenticated non-loopback
/// bind. A wildcard bind (`0.0.0.0`, `::`) is deliberately *not* loopback: it
/// is reachable from the network, which is the whole point of the distinction.
pub fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]") || host.starts_with("127.")
}

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
    /// MCP OAuth credentials (device-code login surface).
    mcp_oauth: Arc<tokio::sync::Mutex<Option<Arc<crate::mcp::oauth::McpOAuthService>>>>,
    interaction_manager: Arc<interaction::InteractionManager>,
    plugin_manager: Arc<plugins::PluginManager>,
    oauth_manager: Arc<oauth::OAuthManager>,
    /// The per-session active/queued prompt state machine behind
    /// `/sessions/{id}/prompts`.
    prompt_queue: Arc<prompt_queue::PromptQueue>,
    config_override: Arc<Mutex<Option<crate::config::KimiConfig>>>,
    /// The models.dev catalog proxy cache (v2 `getModelsDevCatalog`): TTL,
    /// in-flight dedup, stale fallback; the built-in list ends the chain.
    models_dev_cache: Arc<models_dev::CatalogCache>,
    /// The `config.toml` the write routes mutate: the file the server loaded,
    /// or discovery when unset (unset in tests via
    /// [`HttpServer::with_config_write_path`]).
    config_write_path: std::sync::Mutex<Option<PathBuf>>,
    /// The `/api/v1/files` upload store.
    file_store: files::FileStore,
    terminal_manager: Arc<terminal::TerminalManager>,
    subagent_manager: Arc<crate::subagent::SubagentManager>,
    /// Remote Control status state (#3594).
    remote_control_state: Arc<Mutex<RemoteControlStatusWire>>,
    /// The live remote-control runtime (#3594), started by
    /// `POST /api/v1/remote-control`. `None` until then; the status routes
    /// read whichever of the two is live.
    remote_control_runtime:
        Arc<tokio::sync::Mutex<Option<crate::server::remote_control::RemoteControlHandle>>>,
    /// Cancelled by `POST /api/v1/shutdown`; the `http::serve` accept loop
    /// selects on it so the request actually stops the server.
    shutdown: tokio_util::sync::CancellationToken,
    /// Whether the listener is on a loopback address. An in-process server
    /// (`HttpServer::new`, tests) is loopback by definition; `--serve` sets
    /// this from the address it was given.
    loopback_bind: bool,
    /// `--debug-endpoints`: mount the `/api/v1/debug/*` reflection surface.
    /// Off unless asked for — it is a test-introspection tool, not a product
    /// route.
    debug_endpoints: bool,
    /// `--allow-remote-shutdown`: keep `POST /api/v1/shutdown` registered on a
    /// non-loopback bind.
    allow_remote_shutdown: bool,
    /// The DNS-rebinding guard. `None` disables the check: an in-process server
    /// has no bind address to compare against and no browser to rebind, and the
    /// product entry (`--serve`) always installs one.
    host_guard: Option<HostGuard>,
    /// Server-side usage telemetry (v2 #3897): the sink v2 injects as
    /// `ITelemetryService` into its route hosts. `None` on every current entry
    /// point — the transitions are recorded where they happen, and wiring a
    /// real sink lands with the next host integration.
    telemetry_sink: Option<crate::tools::external_hooks::TelemetrySink>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct RemoteControlStatusWire {
    pub enabled: bool,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RemoteControlStatusWire {
    pub fn off() -> Self {
        Self {
            enabled: false,
            state: "off".to_string(),
            url: None,
            device_id: None,
            device_name: None,
            error: None,
        }
    }
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
        let task_runner = Arc::new(TaskRunner::new(None));
        // Background task lifecycle fans out to the task's session lane (or
        // `global` for tasks without a session), both vocabularies.
        let task_event_hub = hub.clone();
        task_runner.set_event_sink(Arc::new(move |session, event| {
            let lane = session.unwrap_or("global").to_string();
            task_event_hub
                .bus_for(&lane)
                .publish(&crate::events::EngineEvent::Custom(event));
        }));
        // #3717 late-settle silence: server-side tasks settle while their
        // session may already be gone (a closed web client left a run
        // behind). The session row is the liveness source — the same check
        // the prompt route's 404 gate uses — so an archived/deleted
        // session's late settle neither announces nor queues anything.
        // `with_task_runner` installs the same predicate on replacements.
        Self::install_task_liveness(&store, &task_runner);
        let store_persister = store.clone();
        hub.set_persister(Arc::new(
            move |seq_ev: &crate::server::hub::SequencedEvent| {
                let now = chrono::Utc::now().timestamp_millis();
                let event_type = seq_ev.event.event_type().to_string();
                let is_checkpoint = event_type == "turn.ended" || event_type == "checkpoint";
                let is_compaction = event_type == "context.compaction";
                let payload_json =
                    serde_json::to_string(&seq_ev.event).unwrap_or_else(|_| "null".to_string());
                if let Err(err) = store_persister.append_wire_event_json(
                    &format!("wevt-{}", fastrand::u64(..)),
                    &seq_ev.session_id,
                    &event_type,
                    &payload_json,
                    is_checkpoint,
                    is_compaction,
                    now,
                ) {
                    tracing::warn!(
                        session_id = %seq_ev.session_id,
                        event_type = %event_type,
                        error = %err,
                        "Failed to persist wire event to sqlite store"
                    );
                }
            },
        ));

        Self {
            store: store.clone(),
            hub: hub.clone(),
            engine: None,
            auth: ServerAuth::disabled(),
            heartbeat: crate::server::ws_protocol::DEFAULT_HEARTBEAT,
            // Reload the persisted server-scoped schedules here, in the one
            // place every entry point constructs a server through — a caller
            // that forgets a separate "reload" step must not silently drop
            // every REST-created schedule on restart.
            cron_scheduler: Arc::new(Mutex::new(CronScheduler::new(
                Self::read_persisted_cron_entries(&store),
                chrono::Local::now().offset().local_minus_utc(),
            ))),
            task_runner: task_runner.clone(),
            server_id: format!("srv-{}", fastrand::u64(..)),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            web_assets_dir: None,
            mcp_manager: Arc::new(crate::mcp::manager::McpManager::new()),
            mcp_oauth: Arc::new(tokio::sync::Mutex::new(None)),
            interaction_manager: Arc::new(
                interaction::InteractionManager::new().with_hub(hub.clone()),
            ),
            plugin_manager: Arc::new(plugins::PluginManager::new(store)),
            oauth_manager: Arc::new(oauth::OAuthManager::new()),
            prompt_queue: Arc::new(prompt_queue::PromptQueue::new()),
            config_override: Arc::new(Mutex::new(None)),
            models_dev_cache: Arc::new(models_dev::CatalogCache::new()),
            config_write_path: std::sync::Mutex::new(None),
            file_store: files::FileStore::new(),
            terminal_manager: Arc::new(terminal::TerminalManager::new(hub.clone())),
            subagent_manager: Arc::new(
                crate::subagent::SubagentManager::new().with_task_runner(task_runner),
            ),
            remote_control_state: Arc::new(Mutex::new(RemoteControlStatusWire::off())),
            remote_control_runtime: Arc::new(tokio::sync::Mutex::new(None)),
            shutdown: tokio_util::sync::CancellationToken::new(),
            loopback_bind: true,
            debug_endpoints: false,
            allow_remote_shutdown: false,
            host_guard: None,
            telemetry_sink: None,
        }
    }

    /// Record the address the listener is bound to. It decides whether the
    /// loopback-only routes (`/api/v1/debug/*`, `POST /api/v1/shutdown`) are
    /// mounted at all.
    #[must_use]
    pub fn with_bind_host(mut self, host: &str) -> Self {
        self.loopback_bind = is_loopback_host(host);
        self
    }

    /// Mount the `/api/v1/debug/*` reflection surface. Still gated on a
    /// loopback bind, so this alone does not expose it on a network bind.
    #[must_use]
    pub fn with_debug_endpoints(mut self, enabled: bool) -> Self {
        self.debug_endpoints = enabled;
        self
    }

    /// Install the server-side telemetry sink (v2 #3897). `event` is the
    /// telemetry name (`swarm_mode_entered`, `remote_control_toggle`, …),
    /// `payload` the properties v2's `track2` call carries.
    #[must_use]
    pub fn with_telemetry_sink(
        mut self,
        sink: crate::tools::external_hooks::TelemetrySink,
    ) -> Self {
        self.telemetry_sink = Some(sink);
        self
    }

    /// Emit one server-side usage event through the sink when one is
    /// installed; otherwise log it. v2 #3897 injects an `ITelemetryService`
    /// into its route hosts; the standalone server has no upstream telemetry
    /// service to report into, so the log line is the always-observable
    /// fallback and `with_telemetry_sink` is where a host integration plugs
    /// in. Fire-and-forget: telemetry must never block or fail a route.
    pub fn emit_session_telemetry(&self, event: &str, payload: serde_json::Value) {
        match &self.telemetry_sink {
            Some(sink) => sink(event, payload),
            None => tracing::info!(event, ?payload, "server usage telemetry"),
        }
    }

    /// Emit one property-less usage event.
    pub fn emit_session_telemetry_named(&self, event: &str) {
        self.emit_session_telemetry(event, serde_json::Value::Null);
    }

    /// Keep `POST /api/v1/shutdown` registered on a non-loopback bind.
    #[must_use]
    pub fn with_allow_remote_shutdown(mut self, enabled: bool) -> Self {
        self.allow_remote_shutdown = enabled;
        self
    }

    /// Install the DNS-rebinding guard. `--serve` always does; an in-process
    /// server leaves it off, since it has no bind address to compare against.
    #[must_use]
    pub fn with_host_guard(mut self, guard: HostGuard) -> Self {
        self.host_guard = Some(guard);
        self
    }

    /// Whether a request's `Host` passes the DNS-rebinding guard. Always true
    /// when no guard is installed.
    pub fn host_allowed(&self, host: Option<&str>) -> bool {
        self.host_guard
            .as_ref()
            .is_none_or(|guard| guard.allows(host))
    }

    /// `/api/v1/debug/*` is a test-introspection surface: mounted only when
    /// asked for *and* only where the caller is already on this machine.
    fn debug_endpoints_enabled(&self) -> bool {
        self.debug_endpoints && self.loopback_bind
    }

    /// `POST /api/v1/shutdown` stops the accept loop, so a non-loopback bind
    /// registers it only behind an explicit opt-in.
    fn shutdown_enabled(&self) -> bool {
        self.loopback_bind || self.allow_remote_shutdown
    }

    /// Signal the accept loop (and `--serve`) to stop. In-flight connections
    /// finish on their own; only new accepts stop.
    pub fn request_shutdown(&self) {
        self.shutdown.cancel();
    }

    /// A token that resolves when the server has been asked to shut down.
    pub fn shutdown_token(&self) -> tokio_util::sync::CancellationToken {
        self.shutdown.clone()
    }

    pub fn subagent_manager(&self) -> Arc<crate::subagent::SubagentManager> {
        if let Some(engine) = &self.engine {
            engine.subagent_manager()
        } else {
            self.subagent_manager.clone()
        }
    }

    /// Point the provider write routes at an explicit `config.toml`; unset
    /// keeps discovery (the `--serve` path passes the file it loaded).
    #[must_use]
    pub fn with_config_write_path(mut self, path: PathBuf) -> Self {
        self.config_write_path = std::sync::Mutex::new(Some(path));
        self
    }

    /// Seed the server's config view with the file it loaded, so reads and
    /// provider writes agree with the engine (the `--serve` path).
    #[must_use]
    pub fn with_config(mut self, config: crate::config::KimiConfig) -> Self {
        // `[background]` knobs apply to the daemon's own task runner too, so
        // the same file behaves the same on every entry point.
        self.task_runner.apply_background_limits(
            config.background.kill_grace_period_ms,
            config.resolve_background_max_running_tasks(),
        );
        let warnings = config.config_warnings.clone();
        self.config_override = Arc::new(Mutex::new(Some(config)));
        // Seeded from the file the server was started with, before any
        // subscriber exists: the global lane's replay ring hands the entity to
        // whoever attaches first, which is the only ordering available here —
        // config load happens before there is a hub to broadcast on.
        self.publish_startup_config_warnings(&warnings);
        self
    }

    /// Use a specific OAuth manager (tests point it at a mock credential
    /// store and hosts).
    #[must_use]
    pub fn with_oauth_manager(mut self, manager: Arc<oauth::OAuthManager>) -> Self {
        self.oauth_manager = manager;
        self
    }

    /// Use a specific upload store (tests point it at a temp directory).
    #[must_use]
    pub fn with_file_store(mut self, store: files::FileStore) -> Self {
        self.file_store = store;
        self
    }

    fn config_write_path(&self) -> Option<PathBuf> {
        self.config_write_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Whether a provider carries a usable cached credential: its own token,
    /// or any managed-token alias when it is the managed provider.
    fn has_cached_token(&self, provider: &str) -> bool {
        self.oauth_manager.has_cached_token(provider)
            || (provider == crate::server::model_catalog::MANAGED_PROVIDER_NAME
                && self.oauth_manager.has_managed_token())
    }

    #[must_use]
    pub fn with_subagent_manager(mut self, manager: Arc<crate::subagent::SubagentManager>) -> Self {
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

    /// Point the plugin registry at the Kimi home, so a remote plugin has
    /// somewhere to be installed (`<home>/plugins/<id>`).
    #[must_use]
    pub fn with_plugin_home(mut self, home: PathBuf) -> Self {
        self.plugin_manager = Arc::new(
            plugins::PluginManager::new(self.store.clone())
                .with_marketplace_dir(plugins::default_marketplace_dir())
                .with_home_dir(Some(home)),
        );
        self
    }

    /// Install the MCP OAuth credential service; it also backs the manager's
    /// bearer-token injection.
    pub async fn with_mcp_oauth_service(
        self,
        service: Arc<crate::mcp::oauth::McpOAuthService>,
    ) -> Self {
        self.mcp_manager.set_oauth_service(service.clone()).await;
        *self.mcp_oauth.lock().await = Some(service);
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
        // Let the engine's OAuth-bound providers fetch tokens from the same
        // store the login/usage routes drive.
        engine.set_oauth_manager(self.oauth_manager.clone());
        engine.set_config_source(self.config_override.clone());
        self.subagent_manager = engine.subagent_manager();
        self.subagent_manager
            .set_task_runner_sync(self.task_runner.clone());
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

    /// Server-scoped cron persistence: entries live under state key
    /// `("cron", "entries")` in the session store, so REST-created schedules
    /// survive a restart and are reloaded by `run_serve`. (The model-facing
    /// Cron* tools use the workspace file state store's `cron` domain instead —
    /// a separate surface, unchanged here.)
    pub fn load_cron_entries(&self) -> Vec<CronEntry> {
        Self::read_persisted_cron_entries(&self.store)
    }

    fn read_persisted_cron_entries(store: &SqliteSessionStore) -> Vec<CronEntry> {
        store
            .get_state("cron", "entries")
            .unwrap_or(None)
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }

    pub fn persist_cron_entries(&self, entries: &[CronEntry]) {
        if let Ok(value) = serde_json::to_value(entries)
            && let Err(e) = self.store.put_state("cron", "entries", &value)
        {
            tracing::warn!(error = %e, "persisting cron entries failed");
        }
    }

    #[must_use]
    pub fn with_task_runner(mut self, task_runner: Arc<TaskRunner>) -> Self {
        Self::install_task_liveness(&self.store, &task_runner);
        self.subagent_manager
            .set_task_runner_sync(task_runner.clone());
        if let Some(engine) = &self.engine {
            engine
                .subagent_manager()
                .set_task_runner_sync(task_runner.clone());
        }
        self.task_runner = task_runner;
        self
    }

    /// The #3717 liveness predicate on a server task runner: a session row's
    /// existence is "alive" (the same check the prompt route's 404 gate
    /// uses), so a deleted/archived session's late task settles stay silent.
    /// Idempotent — it only overwrites the predicate field on the runner.
    fn install_task_liveness(store: &Arc<SqliteSessionStore>, runner: &Arc<TaskRunner>) {
        let liveness_store = store.clone();
        runner.set_liveness_check(Arc::new(move |session: Option<&str>| match session {
            None => true,
            Some(session_id) => liveness_store
                .get_session(session_id)
                .map(|found| found.is_some())
                .unwrap_or(false),
        }));
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

    /// Enqueue one prompt for a session: validate, resolve attachments, admit
    /// into the queue (`running` when it starts a turn, `queued` behind an
    /// active one), publish `prompt.submitted`, and spawn the turn loop.
    ///
    /// Shared by `POST /sessions/{id}/prompts` (the protocol route) and
    /// `POST /prompts` (the collection route). The collection route used to
    /// answer `{"status":"enqueued"}` after minting an id without touching the
    /// queue, so a client got a receipt for a prompt that never ran.
    async fn submit_session_prompt(&self, session_id: &str, body: Value) -> HttpResponse {
        let content = body
            .get("content")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        let (mut prompt, blocks) = match prompt_content_to_blocks(&content, &self.file_store) {
            Ok(parsed) => parsed,
            Err(error) => return HttpResponse::bad_request(error),
        };
        if prompt.is_empty() {
            prompt = body
                .get("prompt")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
        }
        if prompt.is_empty() && blocks.is_empty() {
            return HttpResponse::bad_request("prompt content is empty");
        }
        if self.store.get_session(session_id).ok().flatten().is_none() {
            return HttpResponse::not_found();
        }
        if let Err(error) = apply_prompt_submission_options(self, session_id, &body) {
            return HttpResponse::bad_request(error);
        }
        let Some(engine) = self.engine.clone() else {
            return HttpResponse::json(
                503,
                &json!({ "error": "no engine configured for this server" }),
            );
        };
        let prompt_id = body
            .get("prompt_id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("prompt-{}", fastrand::u64(..)));
        if self.prompt_queue.contains(session_id, &prompt_id) {
            return HttpResponse::json(
                409,
                &json!({
                    "code": crate::server::envelope::error_codes::PROMPT_ID_CONFLICT,
                    "msg": "prompt_id already exists",
                }),
            );
        }
        let wire_content = if content.is_empty() {
            json!([{ "type": "text", "text": prompt }])
        } else {
            Value::Array(content)
        };
        // The item carries no status; `admit` stamps it (`running` when it
        // starts a turn, `queued` behind the active prompt).
        // Client metadata rides the request as an opaque object; the route
        // wraps it in the one-element array v2's `clientMetadata` is, echoes it
        // on the prompt item, and persists it as the turn's origin payload
        // (#3764). It never reaches the model content.
        let client_metadata = match body.get("metadata") {
            None | Some(Value::Null) => None,
            Some(value) if !value.is_object() => {
                return HttpResponse::bad_request("Field 'metadata' must be an object");
            }
            Some(value) => Some(json!([value])),
        };
        let origin = prompt_origin_from_metadata(client_metadata.as_ref());
        let mut item = json!({
            "prompt_id": prompt_id.clone(),
            "user_message_id": format!("msg-{prompt_id}"),
            "content": wire_content,
            "created_at": chrono::Utc::now().to_rfc3339(),
        });
        if let Some(metadata) = &client_metadata {
            item["metadata"] = metadata[0].clone();
        }
        let (item, run) = self
            .prompt_queue
            .admit(session_id, item, prompt, blocks, origin.clone());
        crate::server::prompt_queue::publish_prompt_event(
            &self.hub,
            session_id,
            json!({
                "type": "prompt.submitted",
                "promptId": item.get("prompt_id").cloned().unwrap_or(Value::Null),
                "userMessageId": item
                    .get("user_message_id")
                    .cloned()
                    .unwrap_or(Value::Null),
                "status": item.get("status").cloned().unwrap_or(Value::Null),
                "content": item.get("content").cloned().unwrap_or_else(|| json!([])),
                "createdAt": item.get("created_at").cloned().unwrap_or(Value::Null),
                "metadata": item.get("metadata").cloned().unwrap_or(Value::Null),
            }),
        );
        if let Some(run) = run {
            let queue = self.prompt_queue.clone();
            let store = self.store_arc();
            let hub = self.hub.clone();
            let session_id = session_id.to_string();
            tokio::spawn(async move {
                crate::server::prompt_queue::run_prompt_loop(
                    Some(engine),
                    store,
                    queue,
                    hub,
                    session_id,
                    run,
                )
                .await;
            });
        }
        HttpResponse::ok(&item)
    }

    pub async fn config(&self) -> crate::config::KimiConfig {
        self.config_override
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| {
                crate::config::KimiConfig::discover()
                    .map(|(c, _)| c)
                    .unwrap_or_default()
            })
    }

    /// Publish `event.config.changed` after a config mutation the route layer
    /// applied (provider CRUD / refresh): the Web client folds the payload's
    /// config instead of re-fetching. Best-effort —the mutation already
    /// landed, so this only costs the push when the payload build fails.
    /// Refresh provider models and publish the config/catalog change events.
    /// Shared by the manual `providers:refresh*` routes and the
    /// `[model_catalog]` auto-refresh (`refresh_on_start` / interval).
    pub async fn refresh_models(&self, scope: &str, provider_id: Option<&str>) -> Value {
        let result = crate::server::provider_refresh::refresh(
            &self.config_override,
            self.config_write_path().as_deref(),
            &self.oauth_manager,
            scope,
            provider_id,
        )
        .await;
        self.publish_config_changed(&["providers", "models"]).await;
        self.publish_model_catalog_changed(&result);
        result
    }

    async fn publish_config_changed(&self, changed_fields: &[&str]) {
        let config = self.config().await;
        self.hub
            .bus_for("global")
            .publish(&crate::events::EngineEvent::ConfigChanged {
                changed_fields: changed_fields.iter().map(|s| (*s).to_string()).collect(),
                config: format_config_response(&config),
            });
    }

    /// Publish `event.model_catalog.changed` after a provider refresh: the Web
    /// client refreshes its provider/model caches from the per-provider diff
    /// (`{changed, unchanged, failed}` —the refresh result's own shape).
    fn publish_model_catalog_changed(&self, result: &Value) {
        self.hub
            .bus_for("global")
            .publish(&crate::events::EngineEvent::Custom(json!({
                "type": "event.model_catalog.changed",
                "changed": result.get("changed").cloned().unwrap_or_else(|| json!([])),
                "unchanged": result.get("unchanged").cloned().unwrap_or_else(|| json!([])),
                "failed": result.get("failed").cloned().unwrap_or_else(|| json!([])),
            })));
    }

    /// Publish `event.plugin.changed` after a plugin mutation (install /
    /// remove / enable / disable): the payload is a bare bump — v3 clients
    /// re-fetch the plugin list, the same contract as upstream's
    /// `PluginMessage` global entity.
    pub(crate) fn publish_plugin_changed(&self) {
        self.hub
            .bus_for("global")
            .publish(&crate::events::EngineEvent::Custom(json!({
                "type": "event.plugin.changed",
            })));
    }

    /// Publish `event.config.warning` on the global lane for the `[models]`
    /// entries the loaded `config.toml` could not resolve (v2 #3681).
    ///
    /// The event carries `warnings[].message` on the global lane; the v1
    /// broadcaster passes it through as-is. `domain` is left off — the fork's
    /// only warning source is the config file itself, and upstream treats the
    /// field as optional.
    ///
    /// Always publishes, `warnings: []` included, because an empty list means
    /// "no warnings now" and is what clears a client's stale advisory after
    /// the file is fixed. Upstream's `publishConfigWarnings`
    /// (`kap-server/src/start.ts`) does the same — it is wired to the
    /// diagnostics-change event with no empty check, and only the startup
    /// call filters.
    fn publish_config_warnings(&self, warnings: &[String]) {
        self.hub
            .bus_for("global")
            .publish(&crate::events::EngineEvent::Custom(json!({
                "type": "event.config.warning",
                "warnings": warnings
                    .iter()
                    .map(|message| json!({ "message": message }))
                    .collect::<Vec<Value>>(),
            })));
    }

    /// The startup call: publish the loaded file's warnings, if it has any.
    ///
    /// A clean load stays silent rather than publishing `[]`. Upstream guards
    /// the same way at startup (`start.ts`: the `ready` handler publishes only
    /// when some diagnostic is a warning), because a fresh daemon has no stale
    /// advisory to clear — and the global lane's replay ring would otherwise
    /// hand every future attacher an empty entity that says nothing.
    fn publish_startup_config_warnings(&self, warnings: &[String]) {
        if warnings.is_empty() {
            return;
        }
        self.publish_config_warnings(warnings);
    }

    /// The fan-out handle connections attach to and turns publish through.
    pub fn hub(&self) -> Arc<EventHub> {
        self.hub.clone()
    }

    /// Admit a prompt and, when it becomes active, drive its turn in the
    /// background. Used by the steer path to run prompts that could not attach
    /// to a running turn instead of dropping them.
    fn run_or_queue_prompt(
        &self,
        engine: &Arc<ServerEngine>,
        session_id: &str,
        item: Value,
        prompt: String,
        blocks: Vec<crate::rpc::types::ContentBlock>,
        origin: Option<Value>,
    ) {
        let (_item, run) = self
            .prompt_queue
            .admit(session_id, item, prompt, blocks, origin);
        let Some(run) = run else {
            return;
        };
        let queue = self.prompt_queue.clone();
        let store = self.store_arc();
        let hub = self.hub.clone();
        let session_id = session_id.to_string();
        let engine = engine.clone();
        tokio::spawn(async move {
            crate::server::prompt_queue::run_prompt_loop(
                Some(engine),
                store,
                queue,
                hub,
                session_id,
                run,
            )
            .await;
        });
    }

    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let store = Arc::new(SqliteSessionStore::in_memory()?);
        Ok(Self::new(store))
    }
}

/// A kap-server validation error for malformed provider payloads.
fn provider_validation_error(message: String) -> HttpResponse {
    HttpResponse::json(
        400,
        &json!({
            "code": crate::server::envelope::error_codes::VALIDATION_FAILED,
            "msg": message,
        }),
    )
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
        && !id.contains(':')
    {
        return Some(id);
    }
    if let Some(id) = rest.strip_suffix(&suffix_colon)
        && !id.is_empty()
        && !id.contains('/')
        && !id.contains(':')
    {
        return Some(id);
    }
    None
}

fn extract_session_subaction<'a>(path: &'a str, action: &str, sub: &str) -> Option<&'a str> {
    let suffix = format!("/{action}/{sub}");
    let rest = path.strip_prefix("/api/v1/sessions/")?;
    let id = rest.strip_suffix(&suffix)?;
    if id.is_empty() || id.contains('/') || id.contains(':') {
        return None;
    }
    Some(id)
}

pub(crate) fn infer_media_type(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// The turn origin a prompt submission's `metadata` builds (v2 #3764 /
/// #3832). The request wraps the client's object as the one-element array
/// v2's `clientMetadata` is. A `origin` field inside it is a prompt origin
/// in the transcript contract's shape — the `skill_activation` variant a
/// user-slash activation carries, which the shipped web client nests there
/// (`metadata.origin`, bundle `activateSkill`) — and is used as-is, so the
/// v3 history projection can read the activation off the turn origin.
/// Everything else keeps the opaque-client-metadata wrapping.
fn prompt_origin_from_metadata(client_metadata: Option<&Value>) -> Option<Value> {
    let metadata = client_metadata?;
    let inner = &metadata[0];
    inner
        .get("origin")
        .filter(|origin| origin.get("kind").and_then(Value::as_str).is_some())
        .cloned()
        .or_else(|| Some(json!({ "kind": "user", "clientMetadata": metadata })))
}

/// The media family a part's `type` names. Anything that is not video or
/// audio is treated as an image, matching the intake's historical default.
fn media_kind_of(kind: &str) -> crate::rpc::types::MediaKind {
    match kind {
        "video" => crate::rpc::types::MediaKind::Video,
        "audio" => crate::rpc::types::MediaKind::Audio,
        _ => crate::rpc::types::MediaKind::Image,
    }
}

/// The media family a MIME type names, or `None` for a type the engine has no
/// media block for (the caller keeps its text placeholder).
fn media_kind_for_type(media_type: &str) -> Option<crate::rpc::types::MediaKind> {
    use crate::rpc::types::MediaKind;
    if media_type.starts_with("image/") {
        Some(MediaKind::Image)
    } else if media_type.starts_with("video/") {
        Some(MediaKind::Video)
    } else if media_type.starts_with("audio/") {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

/// A reference to a file already in the store. The bytes stay where they are:
/// the engine's resolver reads them at request time, once it knows which model
/// the turn runs on.
fn file_ref_from_store(
    store: &crate::server::files::FileStore,
    file_id: &str,
    kind_hint: &str,
) -> Result<crate::rpc::types::ContentBlock, String> {
    let (meta, path) = store.get(file_id).map_err(|error| error.2.to_string())?;
    let media_type = if meta.media_type.is_empty() {
        infer_media_type(&path)
    } else {
        meta.media_type.clone()
    };
    let kind = match media_kind_for_type(&media_type) {
        Some(kind) => kind,
        // A part that names its own family still gets a reference: the store
        // may hold a type the MIME prefix cannot place.
        None if !kind_hint.is_empty() => media_kind_of(kind_hint),
        // A plain attachment has no media block; the model reads it by name.
        None => {
            return Ok(crate::rpc::types::ContentBlock::Text {
                text: format!(
                    "[Attached file: {} ({media_type}, {} bytes)]",
                    meta.name, meta.size
                ),
            });
        }
    };
    Ok(crate::rpc::types::ContentBlock::MediaRef {
        file_id: file_id.to_string(),
        kind,
    })
}

/// Convert a protocol `MessageContent[]` prompt submission into the engine's
/// `(text, media blocks)` pair. Media parts are resolved from the local file
/// store (uploaded `f_` blobs) or read in place from a server-local path.
/// Persist a prompt submission's profile options into the session's
/// `agent_config` and `metadata` — the state the turn loop reads (`metadata`
/// for permission mode, `agent_config` for model / thinking / disabled tools).
/// Rejects an unknown `permission_mode`.
fn apply_prompt_submission_options(
    server: &HttpServer,
    session_id: &str,
    body: &Value,
) -> Result<(), String> {
    let mut agent_config = server
        .store()
        .get_state("agent_config", session_id)
        .ok()
        .flatten()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    // Transition baselines are read before the mutable borrow below overwrites
    // them (v2 #3897 emits on the transition, not on every write).
    let swarm_was_on = agent_config
        .get("swarm_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    {
        let config = agent_config.as_object_mut().unwrap();
        for key in [
            "model",
            "thinking",
            "profile",
            "goal_objective",
            "goal_control",
        ] {
            if let Some(value) = body
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|value| !value.is_empty())
            {
                config.insert(key.to_string(), json!(value));
            }
        }
        if let Some(plan_mode) = body.get("plan_mode").and_then(|v| v.as_bool()) {
            config.insert("plan_mode".to_string(), json!(plan_mode));
        }
        if let Some(swarm_mode) = body.get("swarm_mode").and_then(|v| v.as_bool()) {
            if swarm_was_on != swarm_mode {
                server.emit_session_telemetry_named(if swarm_mode {
                    "swarm_mode_entered"
                } else {
                    "swarm_mode_exited"
                });
            }
            config.insert("swarm_mode".to_string(), json!(swarm_mode));
        }
        if let Some(disabled) = body.get("disabled_tools").and_then(|v| v.as_array()) {
            config.insert("disabled_tools".to_string(), Value::Array(disabled.clone()));
        }
    }
    // A dropped write here means the turn runs with the previous
    // model/thinking/profile/permission settings while the client believes the
    // submission was accepted. Surface it instead.
    if let Err(e) =
        server
            .store()
            .put_session_state("agent_config", session_id, session_id, &agent_config)
    {
        return Err(format!("failed to persist the agent config: {e}"));
    }

    let mut metadata = server
        .store()
        .get_state("metadata", session_id)
        .ok()
        .flatten()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    {
        let meta = metadata.as_object_mut().unwrap();
        if let Some(extra) = body.get("metadata").and_then(|v| v.as_object()) {
            for (key, value) in extra {
                meta.insert(key.clone(), value.clone());
            }
        }
        if let Some(mode) = body.get("permission_mode").and_then(|v| v.as_str()) {
            if !matches!(mode, "manual" | "yolo" | "auto") {
                return Err(format!("invalid permission_mode: {mode}"));
            }
            meta.insert("permission_mode".to_string(), json!(mode));
        }
    }
    if let Err(e) = server
        .store()
        .put_session_state("metadata", session_id, session_id, &metadata)
    {
        return Err(format!("failed to persist session metadata: {e}"));
    }

    // Plan mode is workspace-scoped state the plan guard reads; activate or
    // clear it so the submitted `plan_mode` takes effect on the turn. A caller
    // that asked for a plan-mode change must not have it silently dropped.
    if let Some(plan_mode) = body.get("plan_mode").and_then(|v| v.as_bool()) {
        let work_dir =
            fs_routes::resolve_session_workdir(server.store(), session_id).ok_or_else(|| {
                "plan_mode was submitted but this session has no resolvable working directory"
                    .to_string()
            })?;
        let state = crate::storage::StateStore::for_workspace(&work_dir)
            .map_err(|e| format!("failed to open the workspace state store for plan mode: {e}"))?;
        state
            .write_domain("plan", &json!({ "active": plan_mode }))
            .map_err(|e| format!("failed to persist plan mode: {e}"))?;
    }
    Ok(())
}

/// Explains why `/api/v1/remote-control` cannot enable anything.
///
/// Kept as a shared constant so GET and POST cannot drift into telling different
/// stories about the same missing capability.
const REMOTE_CONTROL_UNAVAILABLE: &str = "remote-control is not running: the runtime exists (device registration, relay channel, heartbeat) but no session started it — POST /api/v1/remote-control with enabled=true and the Kimi login refresh_token to start one";

/// Generate a stable device id for remote control (TS `createKimiDeviceId`
/// shape: a ULID).
fn new_device_id() -> String {
    ulid::Ulid::new().to_string()
}

/// The engine's built-in capabilities, served by `GET /api/v1/capabilities` and
/// `GET /api/v1/capabilities/{id}`. A single source so the list route and the
/// detail route cannot drift apart.
const NATIVE_CAPABILITY_IDS: &[&str] = &[
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
    "subagents",
];

/// Parses a terminal dimension from a JSON body.
///
/// `as u32` silently wrapped values above `u32::MAX`, and a missing field was
/// accepted as a valid size, so `{"cols": 4294967297}` and `{"cols": 0}` both
/// produced a nonsensical pty. `Ok(None)` means "not supplied".
fn terminal_dimension(value: Option<&Value>, label: &str) -> Result<Option<u32>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let Some(number) = raw.as_u64() else {
        return Err(format!("Field '{label}' must be a non-negative integer"));
    };
    let dimension = u32::try_from(number)
        .map_err(|_| format!("Field '{label}' must be at most {}", u32::MAX))?;
    if dimension == 0 {
        return Err(format!("Field '{label}' must be greater than 0"));
    }
    Ok(Some(dimension))
}

fn prompt_content_to_blocks(
    content: &[Value],
    files: &crate::server::files::FileStore,
) -> Result<(String, Vec<crate::rpc::types::ContentBlock>), String> {
    use crate::rpc::types::ContentBlock;
    let mut texts: Vec<String> = Vec::new();
    let mut blocks: Vec<ContentBlock> = Vec::new();
    for part in content {
        match part
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("")
        {
            "text" => {
                if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                    texts.push(text.to_string());
                }
            }
            "image" | "video" | "audio" => {
                let kind = part
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("image");
                let Some(source) = part.get("source") else {
                    continue;
                };
                let source_kind = source
                    .get("kind")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let name = part
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|s| s.to_string());
                match source_kind {
                    "url" => {
                        if let Some(url) = source.get("url").and_then(|value| value.as_str()) {
                            // A `kimi-file://` URL is a daemon reference, not a
                            // URL a provider could fetch.
                            if let Some(file_id) =
                                crate::llm::media_resolver::parse_daemon_file_url(url)
                            {
                                blocks.push(ContentBlock::MediaRef {
                                    file_id: file_id.to_string(),
                                    kind: media_kind_of(kind),
                                });
                            } else {
                                blocks.push(match kind {
                                    "image" => ContentBlock::ImageUrl {
                                        url: url.to_string(),
                                        id: None,
                                        name,
                                    },
                                    "audio" => ContentBlock::AudioUrl {
                                        url: url.to_string(),
                                        id: None,
                                        name,
                                    },
                                    _ => ContentBlock::VideoUrl {
                                        url: url.to_string(),
                                        id: None,
                                        name,
                                    },
                                });
                            }
                        }
                    }
                    "base64" => {
                        let media_type = source
                            .get("media_type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("application/octet-stream");
                        let data = source
                            .get("data")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        if kind == "image" {
                            // v2 `resolvePromptMediaFiles`: an inline image
                            // over the model's pixel/byte budget is compressed
                            // at intake, the original is persisted, and a
                            // caption naming both precedes the image (ROADMAP
                            // #3747b — the TUI path does this host-side; this
                            // is the HTTP path's half).
                            let (caption, block) = crate::llm::prompt_media::prepare_inline_image(
                                files,
                                media_type,
                                data,
                                name.as_deref(),
                            );
                            if let Some(caption) = caption {
                                blocks.push(ContentBlock::Text { text: caption });
                            }
                            blocks.push(block);
                        } else {
                            let url = format!("data:{media_type};base64,{data}");
                            blocks.push(if kind == "audio" {
                                ContentBlock::AudioUrl {
                                    url,
                                    id: None,
                                    name,
                                }
                            } else {
                                ContentBlock::VideoUrl {
                                    url,
                                    id: None,
                                    name,
                                }
                            });
                        }
                    }
                    "file" | "session_media" => {
                        let file_id = source
                            .get("file_id")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        blocks.push(file_ref_from_store(files, file_id, kind)?);
                    }
                    "path" => {
                        let path = source
                            .get("path")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        let path = Path::new(path);
                        // Materialize the file into the store so the reference
                        // has an identity the resolver and the budget can key
                        // on (v2's prompt intake does the same).
                        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
                        let name = path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("attachment");
                        let media_type = infer_media_type(path);
                        let meta = files
                            .save(name, &media_type, None, &bytes)
                            .map_err(|error| error.2)?;
                        blocks.push(ContentBlock::MediaRef {
                            file_id: meta.id,
                            kind: media_kind_of(kind),
                        });
                    }
                    _ => {}
                }
            }
            "file" => {
                let name = part.get("name").and_then(|value| value.as_str());
                let media_type = part
                    .get("media_type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if let Some(file_id) = part.get("file_id").and_then(|value| value.as_str()) {
                    match file_ref_from_store(files, file_id, "") {
                        Ok(block) => blocks.push(block),
                        Err(error) => {
                            if let Some(name) = name {
                                blocks.push(ContentBlock::Text {
                                    text: format!("[Attached file: {name} ({media_type})]"),
                                });
                            } else {
                                return Err(error);
                            }
                        }
                    }
                } else if let Some(path) = part.get("path").and_then(|value| value.as_str()) {
                    let path = Path::new(path);
                    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
                    let file_name = name.unwrap_or_else(|| {
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("attachment")
                    });
                    let resolved_type = if media_type.is_empty() {
                        infer_media_type(path)
                    } else {
                        media_type.to_string()
                    };
                    match media_kind_for_type(&resolved_type) {
                        Some(kind) => {
                            let meta = files
                                .save(file_name, &resolved_type, None, &bytes)
                                .map_err(|error| error.2)?;
                            blocks.push(ContentBlock::MediaRef {
                                file_id: meta.id,
                                kind,
                            });
                        }
                        None => blocks.push(ContentBlock::Text {
                            text: format!(
                                "[Attached file: {file_name} ({resolved_type}, {} bytes)]",
                                bytes.len()
                            ),
                        }),
                    }
                }
            }
            _ => {}
        }
    }
    Ok((texts.join(""), blocks))
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
        || cfg.yolo.unwrap_or(false)
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
        "default_provider": cfg.default_provider,
        "secondary_model": cfg.secondary_model,
        "thinking": cfg.thinking,
        "yolo": yolo,
        "plan_mode": cfg.plan_mode.or(cfg.agent.plan_mode).unwrap_or(false),
        "default_plan_mode": cfg.default_plan_mode.unwrap_or(false),
        "default_permission_mode": cfg.default_permission_mode,
        "permission": cfg.permission,
        "hooks": cfg.hooks,
        "services": cfg.services,
        "merge_all_available_skills": cfg.merge_all_available_skills,
        "extra_skill_dirs": cfg.extra_skill_dirs,
        "extra_agent_dirs": cfg.extra_agent_dirs,
        "loop_control": cfg.loop_control,
        "background": cfg.background,
        "experimental": cfg.experimental,
        "telemetry": cfg.telemetry.unwrap_or(false),
        "model_catalog": {
            "refresh_interval_ms": cfg
                .model_catalog
                .as_ref()
                .and_then(|m| m.refresh_interval_ms)
                .unwrap_or(0),
            "refresh_on_start": cfg
                .model_catalog
                .as_ref()
                .and_then(|m| m.refresh_on_start)
                .unwrap_or(false),
        },
        "providers": providers_json,
        "models": models_json,
        // v2's `toConfigResponse` walks every resolved domain and emits it
        // snake_cased (kap-server/src/routes/config.ts:88-103), so `subagent`
        // belongs here too; `raw` is the fork's round-trip convenience.
        "subagent": cfg.subagent,
        "raw": serde_json::to_value(cfg).unwrap_or(Value::Null),
    })
}

/// Project one stored `LLMMessage` onto v2's `messageSchema`
/// (kap-server/src/protocol/message.ts:108-117): `id` / `session_id` / `role` /
/// `content[]` blocks / `created_at`, with `prompt_id` and `parent_message_id`
/// optional.
///
/// The fork stores flat messages (`role` + text `content`, plus structural
/// `blocks` / `tool_calls`), so this restores the block array v2 clients read.
/// `created_at` is not persisted per message — the schema requires a string, so
/// an empty one is a visible marker rather than a fabricated timestamp.
fn project_wire_message(
    session_id: &str,
    index: usize,
    message: &crate::turn_loop::types::LLMMessage,
) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    if !message.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": message.content }));
    }
    for block in &message.blocks {
        blocks.push(serde_json::to_value(block).unwrap_or(Value::Null));
    }
    for call in &message.tool_calls {
        blocks.push(json!({
            "type": "tool_use",
            "tool_call_id": call.id,
            "tool_name": call.name,
            "input": call.arguments,
        }));
    }
    if message.role == "tool"
        && let Some(call_id) = message.tool_call_id.as_deref()
    {
        blocks.push(json!({
            "type": "tool_result",
            "tool_call_id": call_id,
            "output": message.content,
        }));
    }
    json!({
        "id": format!("{session_id}-{index}"),
        "session_id": session_id,
        "role": message.role,
        "content": blocks,
        "created_at": "",
    })
}

/// Pack a session export into the ZIP the Web client's `exportSession` asks for.
///
/// The bundle posts to `…/export` through a bespoke transport that hard-fails
/// unless the response is `application/zip`; answering JSON made the whole
/// action report a parse error. Two members: `session.json` (the full export
/// document) and `transcript.md` (a readable rendering), so the archive is
/// useful to a human as well as to an importer.
fn build_session_export_zip(
    export: &crate::session::sqlite_store::SessionExport,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let document = serde_json::to_vec_pretty(export).map_err(|e| e.to_string())?;
    let mut markdown = String::new();
    let title = export.session.title.as_deref().unwrap_or("Session");
    markdown.push_str(&format!("# {title}\n\n"));
    markdown.push_str(&format!(
        "- Session: `{}`\n- Turns: {}\n- Exported: {}\n\n",
        export.session.session_id, export.turns_count, export.exported_at
    ));
    for message in &export.messages {
        let (heading, content) = match message.role.as_str() {
            "user" => ("User", &message.content),
            "assistant" => ("Assistant", &message.content),
            "system" => ("System", &message.content),
            other => (other, &message.content),
        };
        markdown.push_str(&format!("## {heading}\n\n{content}\n\n"));
    }

    let mut buffer = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file("session.json", options)
            .map_err(|e| e.to_string())?;
        writer.write_all(&document).map_err(|e| e.to_string())?;
        writer
            .start_file("transcript.md", options)
            .map_err(|e| e.to_string())?;
        writer
            .write_all(markdown.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(buffer)
}

/// One built-in capability in the shape the Web client reads. Shared by the
/// list and detail routes so the two cannot drift into serving different
/// element types again.
fn native_capability_wire(id: &str) -> Value {
    json!({
        "id": id,
        "displayName": id,
        "description": format!("Built-in {id} capability of the native engine."),
        "supported": true,
        "state": "ready",
        "version": env!("CARGO_PKG_VERSION"),
        "steps": [],
        "install": { "progress": 100 }
    })
}

/// One OAuth flow, shaped after v2's `oauthFlowSnapshotSchema` /
/// `oauthFlowStartSchema` (`agent-core-v2/src/app/auth/oauthProtocol.ts:5-53`):
/// snake_case throughout, `status` from
/// `pending | authenticated | denied | expired | cancelled`, and `resolved_at`
/// present only once the flow has resolved.
///
/// The Rust `OAuthFlowSnapshot` is camelCase and names the terminal success
/// `"success"`, so answering it verbatim left `flow_id` undefined and the
/// completion branch (`status === "authenticated"`) unreachable — a finished
/// sign-in never registered. `provider` is the flow's key in the manager, which
/// is the handle callers poll and cancel with.
fn oauth_flow_wire(
    flow: Option<&crate::server::oauth::OAuthFlowSnapshot>,
    provider: &str,
) -> Value {
    let Some(flow) = flow else {
        // v2's GET answers `oauthFlowSnapshotOrNullSchema`; "nothing running"
        // is `null`, which is how the client reads it.
        return Value::Null;
    };
    let status = if flow.status == "success" {
        "authenticated"
    } else if flow.status == "error" {
        // v2's `oauthFlowStatusEnum` has no `error` member
        // (agent-core-v2/src/app/auth/oauthProtocol.ts:5-11): a failed exchange
        // surfaces as `denied` with `error_message` carrying the reason, which
        // is what the client's terminal-state branch matches on.
        "denied"
    } else {
        flow.status.as_str()
    };
    let expires_at = flow.expires_in.map(|secs| {
        chrono::DateTime::from_timestamp_millis(
            chrono::Utc::now().timestamp_millis() + secs as i64 * 1000,
        )
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
    });
    let mut body = json!({
        "flow_id": provider,
        "provider": flow.provider,
        "status": status,
        "user_code": flow.user_code,
        "verification_uri": flow.verification_uri,
        "verification_uri_complete": flow.verification_uri_complete,
        "expires_in": flow.expires_in,
        "expires_at": expires_at,
    });
    // v2's successful *start* is a two-field variant (`flow_id` + `provider` +
    // `authenticated`); the pending variant and the snapshot both carry the
    // device-code details, and only the snapshot carries `resolved_at`.
    match body.as_object_mut() {
        Some(object) if status == "authenticated" => {
            object.retain(|key, _| matches!(key.as_str(), "flow_id" | "provider" | "status"));
        }
        Some(object) => {
            if matches!(status, "denied" | "expired" | "cancelled") {
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                object.insert("resolved_at".into(), json!(now));
            }
            if let Some(error) = &flow.error_message {
                object.insert("error_message".into(), json!(error));
            }
        }
        None => {}
    }
    body
}

/// The static directory the catalog routes advertise when the models.dev
/// fetch fails: the built-in snapshot (v2 `BUILT_IN_MODELS_DEV_JSON`), mapped
/// through the same item projection a fetched catalog rides, so an entry
/// cannot exist in one and be missing (or fabricated) in the other.
fn catalog_provider_items() -> Value {
    models_dev::builtin_items()
}

impl HttpServer {
    /// The catalog payload the routes read (v2 `getModelsDevCatalog`): the
    /// TTL-cached upstream fetch, with the built-in snapshot ending the
    /// fallback chain when the fetch fails with no cache to serve.
    async fn catalog_payload(&self) -> Value {
        match self.models_dev_cache.catalog().await {
            Ok(payload) => payload,
            Err(_) => models_dev::builtin_catalog(),
        }
    }

    /// `GET /api/v1/catalog/providers` (v2 `listModelsDevProviders`): every
    /// catalog entry mapped to its item.
    async fn catalog_providers(&self) -> Value {
        let payload = self.catalog_payload().await;
        match models_dev::parse_catalog(&payload) {
            Ok(catalog) => models_dev::provider_items(&catalog),
            Err(_) => catalog_provider_items(),
        }
    }

    /// `GET /api/v1/catalog/providers/{id}` (v2 `getModelsDevProvider`): the
    /// same entry the list route advertises — including the resolved
    /// `base_url` — or `None` for an unknown id (the route answers 404).
    async fn catalog_provider(&self, id: &str) -> Option<Value> {
        let payload = self.catalog_payload().await;
        let catalog = models_dev::parse_catalog(&payload).ok()?;
        let entry = catalog.get(id)?;
        Some(models_dev::provider_item(id, entry))
    }

    /// `POST /api/v1/providers:import_catalog` (v2 `importModelsDevProvider`):
    /// write the chosen catalog entry into the config's `[providers.*]` /
    /// `[models.*]` sections. Re-importing an id rewrites the provider entry
    /// and its aliases from the catalog; an OAuth-managed provider is
    /// rejected instead.
    async fn import_catalog_provider(&self, body: &Value) -> HttpResponse {
        let invalid = |msg: String| {
            HttpResponse::json(
                400,
                &json!({ "code": crate::server::envelope::error_codes::CATALOG_IMPORT_INVALID, "msg": msg }),
            )
        };
        let Some(catalog_id) = body
            .get("catalog_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return HttpResponse::json(
                400,
                &json!({ "code": crate::server::envelope::error_codes::VALIDATION_FAILED, "msg": "catalog_id is required for :import_catalog" }),
            );
        };

        let payload = self.catalog_payload().await;
        let Ok(catalog) = models_dev::parse_catalog(&payload) else {
            return HttpResponse::json(
                503,
                &json!({ "code": crate::server::envelope::error_codes::VALIDATION_FAILED, "msg": "catalog unavailable" }),
            );
        };
        let Some(entry) = catalog.get(catalog_id) else {
            return HttpResponse::json(
                404,
                &json!({
                    "code": crate::server::envelope::error_codes::CATALOG_ENTRY_NOT_FOUND,
                    "msg": format!("catalog entry {catalog_id} does not exist"),
                }),
            );
        };

        let user_base_url = body.get("base_url").and_then(Value::as_str);
        let (wire, base_url) = match models_dev::resolve_import(entry, user_base_url) {
            models_dev::ImportResolution::Ok { wire, base_url, .. } => (wire, base_url),
            models_dev::ImportResolution::NeedsBaseUrl { .. } => {
                return invalid(format!("catalog entry {catalog_id} requires a base_url"));
            }
            models_dev::ImportResolution::Invalid { reason } => {
                return invalid(format!(
                    "catalog entry {catalog_id} cannot be imported: {reason}"
                ));
            }
        };

        let models = models_dev::provider_models(entry);
        if models.is_empty() {
            return invalid(format!(
                "catalog entry {catalog_id} has no importable models"
            ));
        }

        let target_id = body
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or(catalog_id);
        if !models_dev::is_provider_id(target_id) {
            return invalid(format!(
                "catalog entry id {target_id} cannot be used as a provider id"
            ));
        }

        // The credential rides on the request (v2's body carries `api_key`;
        // the fork also accepts `api_key_env`). A re-import keeps the stored
        // credential when the request supplies none — v2's
        // `reconcileProviderCredentialUpdate`, without its eager env-existence
        // check (the fork resolves `api_key_env` at request time).
        // The pre-import config reads the same source the write builds on
        // (`provider_write.rs`): the staged override, else the pinned file,
        // else discovery.
        let before = self
            .config_override
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| match self.config_write_path() {
                Some(path) => crate::config::KimiConfig::from_file(&path).unwrap_or_default(),
                None => crate::config::KimiConfig::discover()
                    .map(|(config, _)| config)
                    .unwrap_or_default(),
            });
        let existing = before.providers.get(target_id);
        if existing.is_some_and(|provider| provider.oauth.is_some()) {
            return HttpResponse::json(
                400,
                &json!({
                    "code": crate::server::envelope::error_codes::PROVIDER_OAUTH_MANAGED,
                    "msg": format!("provider {target_id} is managed by OAuth login; use POST /oauth/logout instead"),
                }),
            );
        }
        let api_key = body
            .get("api_key")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| existing.and_then(|provider| provider.api_key.clone()));
        let api_key_env = body
            .get("api_key_env")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| existing.and_then(|provider| provider.api_key_env.clone()));

        let first_alias = format!("{target_id}/{}", models[0].id);
        let updated =
            crate::config::write::update_config(self.config_write_path().as_deref(), |document| {
                crate::config::write::write_provider(
                    document,
                    target_id,
                    &crate::config::write::ProviderWrite {
                        provider_type: wire.clone(),
                        api_key: api_key.clone(),
                        api_key_env: api_key_env.clone(),
                        base_url: base_url.clone(),
                        default_model: None,
                        source: None,
                    },
                )?;
                crate::config::write::remove_model_aliases_of(document, target_id);
                for model in &models {
                    crate::config::write::write_model_alias(
                        document,
                        &models_dev::model_write(target_id, model),
                    )?;
                }
                // v2 seeds the global default from the first imported model
                // only when nothing is configured at all (fresh setup).
                let seeded = document
                    .get("default_model")
                    .and_then(|item| item.as_str())
                    .is_none_or(|model| model.trim().is_empty());
                if seeded {
                    crate::config::write::set_default_model(document, Some(&first_alias));
                }
                Ok(())
            });
        let updated = match updated {
            Ok(config) => config,
            Err(error) => {
                return HttpResponse::json(
                    500,
                    &json!({ "code": crate::server::envelope::error_codes::INTERNAL_ERROR, "msg": error }),
                );
            }
        };
        *self.config_override.lock().await = Some(updated.clone());
        self.publish_config_changed(&["providers", "models"]).await;

        let has_cached_token = |provider: &str| self.has_cached_token(provider);
        let provider =
            crate::server::model_catalog::provider_item(&updated, target_id, &has_cached_token)
                .unwrap_or(Value::Null);
        HttpResponse::json(
            201,
            &json!({ "provider": provider, "models_imported": models.len() }),
        )
    }

    /// `POST /api/v1/providers:import_registry` (v2 `importCustomRegistry`):
    /// import a models.dev-shaped private registry (an `api.json` URL plus an
    /// optional Bearer key) as configured providers. Every listed provider is
    /// written with a `source` record so refreshes rediscover it, and
    /// re-importing the same URL removes providers that disappeared upstream
    /// — the URL is the registry's stable identity.
    async fn import_registry_provider(&self, body: &Value) -> HttpResponse {
        let invalid = |msg: String| {
            HttpResponse::json(
                400,
                &json!({ "code": crate::server::envelope::error_codes::VALIDATION_FAILED, "msg": msg }),
            )
        };
        let Some(url) = body
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| !url.is_empty())
        else {
            return invalid("url is required for :import_registry".to_string());
        };

        // The pre-import config reads the same source the write builds on
        // (`provider_write.rs`): the staged override, else the pinned file,
        // else discovery.
        let before = self
            .config_override
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| match self.config_write_path() {
                Some(path) => crate::config::KimiConfig::from_file(&path).unwrap_or_default(),
                None => crate::config::KimiConfig::discover()
                    .map(|(config, _)| config)
                    .unwrap_or_default(),
            });
        // The key: the request's, else the one stored for the same URL (key
        // rotation keeps the URL as the identity), else none.
        let stored_key = before.providers.values().find_map(|provider| {
            custom_registry::RegistrySource::from_provider(provider)
                .filter(|source| source.url == url)
                .map(|source| source.api_key)
        });
        let source = custom_registry::RegistrySource {
            url: url.to_string(),
            api_key: body
                .get("api_key")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(stored_key)
                .unwrap_or_default(),
        };

        let client = match reqwest::Client::builder().build() {
            Ok(client) => client,
            Err(error) => {
                return HttpResponse::json(
                    500,
                    &json!({ "code": crate::server::envelope::error_codes::INTERNAL_ERROR, "msg": error.to_string() }),
                );
            }
        };
        let registry_invalid = |msg: String| {
            HttpResponse::json(
                400,
                &json!({ "code": crate::server::envelope::error_codes::REGISTRY_IMPORT_INVALID, "msg": msg }),
            )
        };
        let entries = match custom_registry::fetch_registry(&client, &source).await {
            Ok(entries) => entries,
            Err(error) => {
                return registry_invalid(format!(
                    "custom registry at {url} cannot be imported: {error}"
                ));
            }
        };
        if entries.is_empty() {
            return registry_invalid(format!(
                "custom registry at {url} has no importable providers"
            ));
        }
        for entry in entries.values() {
            if before
                .providers
                .get(&entry.id)
                .is_some_and(|provider| provider.oauth.is_some())
            {
                return HttpResponse::json(
                    400,
                    &json!({
                        "code": crate::server::envelope::error_codes::PROVIDER_OAUTH_MANAGED,
                        "msg": format!("provider {} is managed by OAuth login; use POST /oauth/logout instead", entry.id),
                    }),
                );
            }
        }

        let had_default = before
            .default_model
            .as_deref()
            .is_some_and(|model| !model.trim().is_empty());
        let updated =
            crate::config::write::update_config(self.config_write_path().as_deref(), |document| {
                custom_registry::apply_entries(document, &entries, &source)?;
                custom_registry::seed_default_when_unset(document, &entries, had_default);
                Ok(())
            });
        let updated = match updated {
            Ok(config) => config,
            Err(error) => {
                return HttpResponse::json(
                    500,
                    &json!({ "code": crate::server::envelope::error_codes::INTERNAL_ERROR, "msg": error }),
                );
            }
        };
        *self.config_override.lock().await = Some(updated.clone());
        self.publish_config_changed(&["providers", "models"]).await;

        let has_cached_token = |provider: &str| self.has_cached_token(provider);
        let providers: Vec<Value> = entries
            .values()
            .filter_map(|entry| {
                crate::server::model_catalog::provider_item(&updated, &entry.id, &has_cached_token)
            })
            .collect();
        HttpResponse::json(
            201,
            &json!({
                "providers": providers,
                "models_imported": custom_registry::model_count(&entries),
                "credential_env": custom_registry::credential_env_hints(&entries),
            }),
        )
    }
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

    // Derive `pending_interaction` from the engine's InteractionManager
    // when an engine is attached: v2 surfaced a real value here instead of
    // the "none" stub the engine previously hardcoded, and the TUI status
    // panel relies on it to render the question / approval state.
    let pending_interaction = engine
        .and_then(|e| e.interaction_manager())
        .map(|mgr| {
            if !mgr.list_questions(session_id).is_empty() {
                "question"
            } else if !mgr.list_approvals(session_id).is_empty() {
                "approval"
            } else {
                "none"
            }
        })
        .unwrap_or("none");

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

    let mut metadata_obj = store
        .get_state("metadata", session_id)
        .ok()
        .flatten()
        .and_then(|m| m.as_object().cloned())
        .unwrap_or_default();

    let cwd = metadata_obj
        .get("cwd")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });

    metadata_obj
        .entry("cwd".to_string())
        .or_insert_with(|| json!(cwd));
    metadata_obj
        .entry("session_id".to_string())
        .or_insert_with(|| json!(session_id));

    let mut config_obj = store
        .get_state("agent_config", session_id)
        .ok()
        .flatten()
        .and_then(|c| c.as_object().cloned())
        .unwrap_or_default();
    config_obj
        .entry("model".to_string())
        .or_insert_with(|| json!(model));
    config_obj
        .entry("thinking".to_string())
        .or_insert_with(|| json!("medium"));

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
        "pending_interaction": pending_interaction,
        "archived": session.archived,
        "parent_session_id": session.parent_session_id,
        "metadata": Value::Object(metadata_obj),
        "agent_config": Value::Object(config_obj),
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
        "last_seq": store.latest_wire_event_seq(session_id).unwrap_or(0)
    })
}

impl HttpServer {
    /// Dispatch an incoming HTTP request to the appropriate route handler.
    pub async fn handle_request(&self, req: &HttpRequest) -> HttpResponse {
        let path = req.path.trim_end_matches('/');
        let method = req.method.to_uppercase();

        // Before the credential: the guard is about *where* the request came
        // from, not who sent it. A rebinding page carries no token of its own,
        // so answering 401 first would only tell it the port is live.
        if !self.host_allowed(req.header("host")) {
            return HttpResponse::forbidden(host_guard::rejection_message(req.header("host")));
        }

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

        // Debug RPC and reflection surface for kimi-inspect. Not mounted by
        // default: it reflects the server's internals, so it is a test tool
        // that has to be asked for, and only on a loopback bind.
        if self.debug_endpoints_enabled()
            && path.starts_with("/api/v1/debug")
            && let Some(resp) = debug::handle_debug_route(self, req).await
        {
            return resp;
        }

        let resp = match (method.as_str(), path) {
            ("GET", "/api/v1/health")
            | ("GET", "/health")
            | ("GET", "/healthz")
            | ("GET", "/api/v1/healthz") => HttpResponse::ok(&json!({
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
                    // The user's `[experimental]` flags, not a constant:
                    // clients probe these to gate UI features.
                    "experimental_flags": self.config().await.experimental,
                }))
            }
            ("GET", "/api/v1/config") => {
                let config = self
                    .config_override
                    .lock()
                    .await
                    .clone()
                    .unwrap_or_else(|| {
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
                let mut config = self
                    .config_override
                    .lock()
                    .await
                    .clone()
                    .unwrap_or_else(|| {
                        crate::config::KimiConfig::discover()
                            .map(|(c, _)| c)
                            .unwrap_or_default()
                    });
                if let Some(dm) = body.get("default_model").and_then(|v| v.as_str()) {
                    config.default_model = Some(dm.to_string());
                }
                // v2 folds `yolo` into the permission mode rather than keeping a
                // separate flag: `patchConfigRequestSchema` carries both
                // `yolo` and `default_permission_mode`, and the handler does
                // `if (yolo === true) defaultPermissionMode = 'yolo'` then drops
                // the key (kap-server/src/routes/config.ts:63-68). Read
                // `default_permission_mode` first so an explicit mode wins.
                let default_permission_mode =
                    body.get("default_permission_mode").and_then(|v| v.as_str());
                let yolo_flag = body.get("yolo").and_then(|v| v.as_bool());
                if let Some(mode) = default_permission_mode {
                    config.default_permission_mode = Some(mode.to_string());
                } else if yolo_flag == Some(true) {
                    config.default_permission_mode = Some("yolo".to_string());
                }
                if yolo_flag == Some(true) {
                    config.agent.yolo = Some(true);
                } else if yolo_flag == Some(false) {
                    config.agent.yolo = Some(false);
                }
                if let Some(plan_mode) = body.get("plan_mode").and_then(|v| v.as_bool()) {
                    config.plan_mode = Some(plan_mode);
                }
                if let Some(default_plan_mode) =
                    body.get("default_plan_mode").and_then(|v| v.as_bool())
                {
                    config.default_plan_mode = Some(default_plan_mode);
                }
                // The Web settings panel posts the whole `patchConfigRequestSchema`
                // and used to have all but four keys accepted with a 200 and
                // dropped — so an experimental-feature toggle could never be
                // persisted. Apply every section the schema declares.
                if let Some(provider) = body.get("default_provider").and_then(|v| v.as_str()) {
                    config.default_provider = Some(provider.to_string());
                }
                if let Some(permission) = body.get("permission") {
                    match serde_json::from_value::<crate::config::PermissionConfig>(
                        permission.clone(),
                    ) {
                        Ok(parsed) => config.permission = Some(parsed),
                        Err(error) => {
                            // Never silently drop a section the user just
                            // edited: report it so the UI can surface a form
                            // error instead of pretending it saved.
                            return HttpResponse::bad_request(format!(
                                "Invalid [permission] section: {error}"
                            ));
                        }
                    }
                }
                if let Some(mode) = body.get("default_permission_mode").and_then(|v| v.as_str()) {
                    config.default_permission_mode = Some(mode.to_string());
                }
                if let Some(thinking) = body.get("thinking") {
                    match serde_json::from_value::<crate::config::ThinkingConfig>(thinking.clone())
                    {
                        Ok(parsed) => config.thinking = parsed,
                        Err(error) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid [thinking] section: {error}"
                            ));
                        }
                    }
                }
                if let Some(loop_control) = body.get("loop_control") {
                    match serde_json::from_value::<crate::config::LoopControlConfig>(
                        loop_control.clone(),
                    ) {
                        Ok(parsed) => config.loop_control = parsed,
                        Err(error) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid [loop_control] section: {error}"
                            ));
                        }
                    }
                }
                if let Some(background) = body.get("background") {
                    match serde_json::from_value::<crate::config::BackgroundConfig>(
                        background.clone(),
                    ) {
                        Ok(parsed) => config.background = parsed,
                        Err(error) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid [background] section: {error}"
                            ));
                        }
                    }
                }
                if let Some(hooks) = body.get("hooks") {
                    match serde_json::from_value::<Vec<crate::permission::HookDef>>(hooks.clone()) {
                        Ok(parsed) => config.hooks = parsed,
                        Err(error) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid [hooks] section: {error}"
                            ));
                        }
                    }
                }
                if let Some(services) = body.get("services") {
                    match serde_json::from_value::<crate::config::ServicesConfig>(services.clone())
                    {
                        Ok(parsed) => config.services = parsed,
                        Err(error) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid [services] section: {error}"
                            ));
                        }
                    }
                }
                if let Some(experimental) = body.get("experimental") {
                    match serde_json::from_value::<
                        std::collections::HashMap<String, crate::config::ExperimentalValue>,
                    >(experimental.clone())
                    {
                        Ok(parsed) => config.experimental = parsed,
                        Err(error) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid [experimental] section: {error}"
                            ));
                        }
                    }
                }
                if let Some(merge) = body
                    .get("merge_all_available_skills")
                    .and_then(|v| v.as_bool())
                {
                    config.merge_all_available_skills = Some(merge);
                }
                if let Some(dirs) = body.get("extra_skill_dirs") {
                    match serde_json::from_value::<Vec<String>>(dirs.clone()) {
                        Ok(parsed) => config.extra_skill_dirs = parsed,
                        Err(error) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid extra_skill_dirs: {error}"
                            ));
                        }
                    }
                }
                if let Some(telemetry) = body.get("telemetry").and_then(|v| v.as_bool()) {
                    config.telemetry = Some(telemetry);
                }
                *self.config_override.lock().await = Some(config.clone());
                HttpResponse::ok(&format_config_response(&config))
            }
            ("POST", "/api/v1/config:reload") | ("POST", "/api/v1/config/reload") => {
                *self.config_override.lock().await = None;
                // Re-read the file the server pinned when it has one — the same
                // precedence the provider routes use (`provider_write.rs`
                // `effective_config`, `provider_refresh.rs`) — so a reload picks
                // up the file this server is actually using rather than a
                // re-discovery that could land on a different one.
                let config = match self.config_write_path() {
                    Some(path) => crate::config::KimiConfig::from_file(&path).unwrap_or_default(),
                    None => crate::config::KimiConfig::discover()
                        .map(|(c, _)| c)
                        .unwrap_or_default(),
                };
                // Published even when the list is empty: the entity is an upsert,
                // so `warnings: []` is what clears the advisory a previously
                // broken `config.toml` left on the client.
                self.publish_config_warnings(&config.config_warnings);
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
            // Static advertisement, not a probe: the list is a compile-time
            // constant, so it does not reflect per-process availability (e.g. a
            // build without the workflow engine still reports the same set).
            // The detail route below answers from the same list.
            // The bundle's `listCapabilities` feeds these straight into
            // `capabilities.filter(c => c.supported)`, so the elements have to be
            // the same objects the detail route serves — a bare string array made
            // `supported` undefined and the plugin panel's capability rows
            // rendered empty.
            ("GET", "/api/v1/capabilities") => {
                let capabilities: Vec<Value> = NATIVE_CAPABILITY_IDS
                    .iter()
                    .map(|id| native_capability_wire(id))
                    .collect();
                HttpResponse::ok(&json!({ "capabilities": capabilities }))
            }
            // One capability's readiness. Native built-ins are compiled in, so
            // a known id is genuinely `ready`; an unknown id is a 404
            // (kap-server's `CAPABILITY_NOT_FOUND`), not a fabricated record.
            ("GET", p) if p.starts_with("/api/v1/capabilities/") => {
                let id = p.trim_start_matches("/api/v1/capabilities/");
                if NATIVE_CAPABILITY_IDS.contains(&id) {
                    HttpResponse::ok(&native_capability_wire(id))
                } else {
                    HttpResponse::not_found()
                }
            }
            // kap-server's install action: the native engine has nothing to
            // install (every capability ships compiled in), so the honest
            // answer is "unsupported", not a fake install that claims to run.
            ("POST", p) if p.starts_with("/api/v1/capabilities/") => HttpResponse::bad_request(
                "CAPABILITY_UNSUPPORTED: this standalone engine ships every capability built in; there is no installer to run",
            ),
            ("GET", "/api/v1/connections") => {
                let connections: Vec<Value> = self
                    .hub
                    .connections()
                    .into_iter()
                    .map(|conn| {
                        let connected_at =
                            chrono::DateTime::from_timestamp_millis(conn.connected_at as i64)
                                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                                .unwrap_or_else(|| self.started_at.clone());
                        json!({
                            "id": format!("conn_{}", conn.id),
                            "connected_at": connected_at,
                            "remote_address": conn.remote_address,
                            "user_agent": conn.user_agent,
                            "has_client_hello": conn.has_client_hello,
                            "subscriptions": conn.subscriptions,
                        })
                    })
                    .collect();
                HttpResponse::ok(&json!({ "connections": connections }))
            }
            // Unregistered (so a 404) on a non-loopback bind unless the server
            // was started with `--allow-remote-shutdown`.
            ("POST", "/api/v1/shutdown") if self.shutdown_enabled() => {
                self.request_shutdown();
                HttpResponse::ok(&json!({
                    "status": "shutting_down",
                    "message": "Kimi agent native server is shutting down"
                }))
            }
            ("GET", "/api/v1/models") | ("GET", "/api/v1/model-catalog") => {
                let config = self.config().await;
                HttpResponse::ok(&crate::server::model_catalog::models(&config))
            }
            ("GET", "/api/v1/providers") => {
                let config = self.config().await;
                let has_cached_token = |provider: &str| self.has_cached_token(provider);
                HttpResponse::ok(&crate::server::model_catalog::providers(
                    &config,
                    &has_cached_token,
                ))
            }
            ("POST", "/api/v1/providers") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(value) => value,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let form = match serde_json::from_value::<
                    crate::server::provider_write::CreateProviderForm,
                >(body)
                {
                    Ok(form) => form,
                    Err(error) => return provider_validation_error(error.to_string()),
                };
                let has_cached_token = |provider: &str| self.has_cached_token(provider);
                match crate::server::provider_write::create(
                    &self.config_override,
                    self.config_write_path().as_deref(),
                    &has_cached_token,
                    form,
                )
                .await
                {
                    Ok(item) => {
                        self.publish_config_changed(&["providers"]).await;
                        HttpResponse::json(201, &item)
                    }
                    Err((status, code, message)) => {
                        HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                    }
                }
            }
            ("POST", "/api/v1/providers:refresh") => {
                let result = self.refresh_models("all", None).await;
                HttpResponse::ok(&result)
            }
            ("POST", "/api/v1/providers:refresh_oauth") => {
                let result = self.refresh_models("oauth", None).await;
                HttpResponse::ok(&result)
            }
            ("POST", p) if p.starts_with("/api/v1/providers/") && p.ends_with(":refresh") => {
                let provider_id = crate::server::router::decode_path_segment(
                    p.trim_start_matches("/api/v1/providers/")
                        .trim_end_matches(":refresh"),
                );
                let result = self.refresh_models("all", Some(&provider_id)).await;
                HttpResponse::ok(&result)
            }
            ("GET", p)
                if p.starts_with("/api/v1/providers/")
                    && !p.starts_with("/api/v1/providers/catalog") =>
            {
                let provider_id = crate::server::router::decode_path_segment(
                    p.trim_start_matches("/api/v1/providers/"),
                );
                let has_cached_token = |provider: &str| self.has_cached_token(provider);
                match crate::server::provider_write::get(
                    &self.config_override,
                    self.config_write_path().as_deref(),
                    &has_cached_token,
                    &provider_id,
                )
                .await
                {
                    Ok(item) => HttpResponse::ok(&item),
                    Err((status, code, message)) => {
                        HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                    }
                }
            }
            ("PUT", p) if p.starts_with("/api/v1/providers/") => {
                let provider_id = crate::server::router::decode_path_segment(
                    p.trim_start_matches("/api/v1/providers/"),
                );
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(value) => value,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let form = match serde_json::from_value::<
                    crate::server::provider_write::ReplaceProviderForm,
                >(body)
                {
                    Ok(form) => form,
                    Err(error) => return provider_validation_error(error.to_string()),
                };
                let has_cached_token = |provider: &str| self.has_cached_token(provider);
                match crate::server::provider_write::replace(
                    &self.config_override,
                    self.config_write_path().as_deref(),
                    &has_cached_token,
                    &provider_id,
                    form,
                )
                .await
                {
                    Ok(item) => {
                        self.publish_config_changed(&["providers"]).await;
                        HttpResponse::ok(&item)
                    }
                    Err((status, code, message)) => {
                        HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                    }
                }
            }
            ("DELETE", p) if p.starts_with("/api/v1/providers/") => {
                let provider_id = crate::server::router::decode_path_segment(
                    p.trim_start_matches("/api/v1/providers/"),
                );
                match crate::server::provider_write::delete(
                    &self.config_override,
                    self.config_write_path().as_deref(),
                    &provider_id,
                )
                .await
                {
                    Ok(item) => {
                        self.publish_config_changed(&["providers"]).await;
                        HttpResponse::ok(&item)
                    }
                    Err((status, code, message)) => {
                        HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                    }
                }
            }
            ("GET", "/api/v1/catalog/providers") | ("GET", "/api/v1/providers/catalog") => {
                HttpResponse::ok(&self.catalog_providers().await)
            }
            ("GET", p) if p.starts_with("/api/v1/catalog/providers/") => {
                let catalog_id = p
                    .strip_prefix("/api/v1/catalog/providers/")
                    .unwrap_or_default();
                // Serve the same entry the list route advertises — including the
                // resolved `base_url` — instead of fabricating a placeholder
                // with no endpoint and no models (v2 #3909 exposes `base_url` on
                // both routes). An unknown id is a 404 rather than a fake entry.
                match self.catalog_provider(catalog_id).await {
                    Some(item) => HttpResponse::ok(&item),
                    None => HttpResponse::not_found(),
                }
            }
            // v2 `importModelsDevProvider`: write the chosen catalog entry
            // into the config's providers / models sections.
            ("POST", "/api/v1/providers:import_catalog") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(value) => value,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                self.import_catalog_provider(&body).await
            }
            // v2 `importCustomRegistry`: import a models.dev-shaped private
            // registry as configured providers.
            ("POST", "/api/v1/providers:import_registry") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(value) => value,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                self.import_registry_provider(&body).await
            }
            ("POST", p) if p.starts_with("/api/v1/models/") => {
                let tail = p.strip_prefix("/api/v1/models/").unwrap_or_default();
                let model_id = if let Some(m) = tail.strip_suffix(":set_default") {
                    m.to_string()
                } else if tail == "set_default" {
                    let body: Value = serde_json::from_slice(&req.body).unwrap_or(json!({}));
                    body.get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("kimi-latest")
                        .to_string()
                } else {
                    tail.to_string()
                };
                let mut config = self
                    .config_override
                    .lock()
                    .await
                    .clone()
                    .unwrap_or_else(|| {
                        crate::config::KimiConfig::discover()
                            .map(|(c, _)| c)
                            .unwrap_or_default()
                    });
                config.default_model = Some(model_id.clone());
                *self.config_override.lock().await = Some(config);
                HttpResponse::ok(&json!({ "model": model_id }))
            }
            ("GET", "/api/v1/prompts") => {
                // The live prompt queue is per session; the collection route
                // reports every session's active + queued prompts with the
                // owning session id attached.
                let mut items: Vec<Value> = Vec::new();
                for session in self.store.list_sessions().unwrap_or_default() {
                    let (active, queued) = self.prompt_queue.snapshot(&session.session_id);
                    if let Some(mut active) = active {
                        active["session_id"] = json!(session.session_id);
                        items.push(active);
                    }
                    for mut queued in queued {
                        queued["session_id"] = json!(session.session_id);
                        items.push(queued);
                    }
                }
                HttpResponse::ok(&json!({ "items": items }))
            }
            ("POST", "/api/v1/prompts") => {
                // Collection-level submit: the session path carries the
                // enqueue contract, so this route delegates to it instead of
                // minting an id. Previously it answered `{"status":"enqueued"}`
                // without touching the queue — a prompt that never ran.
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let session_id = match body.get("session_id").and_then(|v| v.as_str()) {
                    Some(id) if !id.trim().is_empty() => id.trim().to_string(),
                    _ => return HttpResponse::bad_request("Field 'session_id' is required"),
                };
                self.submit_session_prompt(&session_id, body).await
            }
            ("GET", "/api/v1/files") => match self.file_store.list() {
                Ok(metas) => {
                    let items: Vec<Value> = metas
                        .iter()
                        .filter_map(|meta| serde_json::to_value(meta).ok())
                        .collect();
                    HttpResponse::ok(&json!({ "files": items }))
                }
                Err((status, code, message)) => {
                    HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                }
            },
            ("POST", "/api/v1/files") => {
                let content_type = req.header("content-type").unwrap_or_default().to_string();
                match crate::server::files::upload(&self.file_store, &content_type, &req.body) {
                    Ok(meta) => HttpResponse::json(200, &meta),
                    Err((status, code, message)) => {
                        HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                    }
                }
            }
            ("GET", p) if p.starts_with("/api/v1/files/") => {
                let file_id = crate::server::router::decode_path_segment(
                    p.trim_start_matches("/api/v1/files/"),
                );
                match self.file_store.get(&file_id) {
                    Ok((meta, path)) => {
                        let bytes = match std::fs::read(&path) {
                            Ok(bytes) => bytes,
                            Err(error) => {
                                return HttpResponse::internal_error(format!(
                                    "cannot read {}: {error}",
                                    path.display()
                                ));
                            }
                        };
                        let total = bytes.len() as u64;
                        let response = match req
                            .header("range")
                            .and_then(|header| crate::server::files::parse_range(header, total))
                        {
                            Some((start, end)) => {
                                let slice = bytes[start as usize..=end as usize].to_vec();
                                HttpResponse::bytes(206, meta.media_type.clone(), slice)
                                    .with_header(
                                        "content-range",
                                        format!("bytes {start}-{end}/{total}"),
                                    )
                            }
                            None => HttpResponse::bytes(200, meta.media_type.clone(), bytes),
                        };
                        response
                            .with_header(
                                "content-disposition",
                                crate::server::files::content_disposition(
                                    &meta.name,
                                    &meta.media_type,
                                ),
                            )
                            .with_header("accept-ranges", "bytes")
                            .with_header("etag", format!("\"{}-{total}\"", meta.id))
                    }
                    Err((status, code, message)) => {
                        HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                    }
                }
            }
            ("DELETE", p) if p.starts_with("/api/v1/files/") => {
                let file_id = crate::server::router::decode_path_segment(
                    p.trim_start_matches("/api/v1/files/"),
                );
                match self.file_store.delete(&file_id) {
                    Ok(()) => HttpResponse::ok(&json!({ "deleted": true })),
                    Err((status, code, message)) => {
                        HttpResponse::json(status, &json!({ "code": code, "msg": message }))
                    }
                }
            }
            ("GET", "/api/v2/sessions") => {
                // The official Web bundle's `listSessionsV2` contract
                // (upstream `routes/v2/sessions.ts` `v2SessionPageSchema`):
                // domain-grouped items plus total/has_more/next_page_token.
                // Page-token pagination is accepted for compatibility and
                // answered as a single complete page (the fork's session
                // count is small); `page_token` stays null. `view=by_workspace`
                // groups the matching set per workspace instead
                // (`v2SessionGroupPageSchema`), which is what the sessions
                // sidebar loads first.
                let sessions = self.store.list_sessions().unwrap_or_default();
                let engine = self.engine.as_ref();
                let query_archived = req.query_param("meta.archived").map(|v| v == "true");
                let query_has_prompt = req.query_param("meta.has_prompt").map(|v| v == "true");
                let view_by_workspace =
                    req.query_param("view").is_some_and(|v| v == "by_workspace");
                let group_page_size = req
                    .query_param("group.page_size")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(5);

                let mut items: Vec<Value> = Vec::new();
                for s in sessions {
                    if query_archived.is_some_and(|want| s.archived != want) {
                        continue;
                    }
                    let busy = engine.map(|e| e.is_busy(&s.session_id)).unwrap_or(false);
                    let has_prompt = self
                        .store
                        .load_session_history(&s.session_id)
                        .map(|history| !history.is_empty())
                        .unwrap_or(false);
                    if query_has_prompt.is_some_and(|want| has_prompt != want) {
                        continue;
                    }
                    let model = self
                        .store
                        .get_state("agent_config", &s.session_id)
                        .ok()
                        .flatten()
                        .and_then(|c| c.get("model").and_then(|m| m.as_str()).map(str::to_string))
                        .or_else(|| engine.map(|e| e.model_name().to_string()));
                    let workspace_cwd = s
                        .workspace_id
                        .as_deref()
                        .and_then(|wid| self.store.get_workspace(wid).ok().flatten())
                        .map(|w| w.root);
                    items.push(json!({
                        "id": s.session_id,
                        "workspace": {
                            "id": s.workspace_id,
                            "cwd": workspace_cwd,
                        },
                        "meta": {
                            "title": s.title,
                            "last_prompt": Value::Null,
                            "created_at": s.created_at,
                            "updated_at": s.updated_at,
                            "archived": s.archived,
                            "archived_at": Value::Null,
                            "has_prompt": has_prompt,
                        },
                        "activity": {
                            // v2ActivityStatusSchema vocabulary
                            // (running/approval/question/failed/idle):
                            // the bundle's mapper maps `running` → busy
                            // and `approval`/`question` → pending
                            // interactions.
                            "status": if busy { "running" } else { "idle" },
                            "model": model
                        }
                    }));
                }
                let total = items.len();
                if view_by_workspace {
                    // Group every session under its workspace: each group
                    // carries the workspace object and the first
                    // `group.page_size` sessions of that workspace.
                    let workspaces = self.store.list_workspaces().unwrap_or_default();
                    let mut groups: Vec<Value> = workspaces
                        .iter()
                        .map(|w| {
                            let members: Vec<&Value> = items
                                .iter()
                                .filter(|i| i["workspace"]["id"] == json!(w.id))
                                .collect();
                            let group_total = members.len();
                            let sessions: Vec<Value> =
                                members.into_iter().take(group_page_size).cloned().collect();
                            json!({
                                "workspace": {
                                    "id": w.id,
                                    "cwd": w.root,
                                },
                                "sessions": sessions,
                                "total": group_total,
                            })
                        })
                        .collect();
                    // Sessions whose workspace row is missing (deleted row or
                    // ad-hoc cwd sessions) land in a synthetic group keyed by
                    // the session's own workspace id so they stay reachable.
                    let orphan_workspaces: Vec<Value> = items
                        .iter()
                        .filter(|i| {
                            workspaces
                                .iter()
                                .all(|w| json!(w.id) != i["workspace"]["id"])
                        })
                        .map(|i| i["workspace"].clone())
                        .collect();
                    for ws_value in orphan_workspaces {
                        let members: Vec<&Value> = items
                            .iter()
                            .filter(|i| i["workspace"]["id"] == ws_value["id"])
                            .collect();
                        let group_total = members.len();
                        let group_sessions: Vec<Value> =
                            members.into_iter().take(group_page_size).cloned().collect();
                        groups.push(json!({
                            "workspace": ws_value,
                            "sessions": group_sessions,
                            "total": group_total,
                        }));
                    }
                    HttpResponse::ok(&json!({
                        "groups": groups,
                        "total": total,
                        "has_more": false,
                        "next_page_token": Value::Null
                    }))
                } else {
                    HttpResponse::ok(&json!({
                        "items": items,
                        "total": total,
                        "has_more": false,
                        "next_page_token": Value::Null
                    }))
                }
            }
            // Batch archive/restore (upstream `routes/v2/sessions.ts`): the
            // official Web bundle posts `{ ids: [...] }` and folds per-item
            // results; a missing session folds into its own item instead of
            // failing the whole batch.
            ("POST", "/api/v2/sessions:archive") | ("POST", "/api/v2/sessions:restore") => {
                let restore = req.path.ends_with(":restore");
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let Some(ids) = body.get("ids").and_then(Value::as_array) else {
                    return HttpResponse::bad_request("Missing ids");
                };
                if ids.len() > 5000 {
                    return HttpResponse::json(
                        422,
                        &json!({ "code": crate::server::envelope::error_codes::VALIDATION_FAILED, "msg": "ids exceeds 5000" }),
                    );
                }
                let results: Vec<Value> = ids
                    .iter()
                    .filter_map(|id| id.as_str())
                    .map(|id| {
                        let outcome = if restore {
                            self.store.restore_session(id)
                        } else {
                            self.store.archive_session(id)
                        };
                        match outcome {
                            Ok(true) => json!({ "id": id, "ok": true }),
                            Ok(false) => json!({
                                "id": id,
                                "ok": false,
                                "error": "session not found"
                            }),
                            Err(e) => json!({ "id": id, "ok": false, "error": e.to_string() }),
                        }
                    })
                    .collect();
                let succeeded = results.iter().filter(|r| r["ok"] == json!(true)).count();
                HttpResponse::ok(&json!({
                    "results": results,
                    "succeeded": succeeded,
                    "failed": results.len() - succeeded
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
            // Remote-control runtime (#3594).
            //
            // Remote Control (#3594): the runtime behind this endpoint is now
            // real (`server/remote_control.rs` — device registration, a relay
            // WebSocket channel, reverse HTTP proxy and heartbeats). POST
            // starts it (the caller must supply the Kimi login refresh token —
            // the standalone server holds none of its own), GET reports the
            // live status. The old `501 + available:false` responses existed
            // because there was genuinely nothing listening behind them.
            ("GET", "/api/v1/remote-control") => {
                let runtime = self.remote_control_runtime.lock().await;
                match runtime.as_ref() {
                    Some(handle) => {
                        let st = handle.status();
                        HttpResponse::ok(&json!({
                            "enabled": st.enabled,
                            "state": st.state,
                            "url": st.url,
                            "device_id": st.device_id,
                            "device_name": st.device_name,
                            "available": true,
                            "error": st.error,
                        }))
                    }
                    None => {
                        let st = self.remote_control_state.lock().await.clone();
                        HttpResponse::ok(&json!({
                            "enabled": false,
                            "state": st.state,
                            "url": Value::Null,
                            "device_id": st.device_id,
                            "device_name": st.device_name,
                            "available": false,
                            "reason": REMOTE_CONTROL_UNAVAILABLE,
                            "error": st.error,
                        }))
                    }
                }
            }
            ("POST", "/api/v1/remote-control") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                if body.get("enabled").and_then(|v| v.as_bool()).is_none() {
                    return HttpResponse::bad_request("Missing 'enabled' field");
                }
                let enabled = body["enabled"].as_bool().unwrap_or(false);
                if !enabled {
                    // Stop the runtime if one is live and report the off state.
                    if let Some(handle) = self.remote_control_runtime.lock().await.take() {
                        handle.close().await;
                    }
                    {
                        let mut st = self.remote_control_state.lock().await;
                        *st = RemoteControlStatusWire::off();
                    }
                    // v2 #3897 `remote_control_toggle`
                    // (kap-server/src/routes/remoteControl.ts:84).
                    self.emit_session_telemetry(
                        "remote_control_toggle",
                        serde_json::json!({ "enabled": false, "outcome": "ok" }),
                    );
                    return HttpResponse::ok(&json!({
                        "enabled": false,
                        "state": "off",
                        "url": Value::Null,
                        "available": false,
                    }));
                }
                // Start (or report the already-running) runtime.
                let mut slot = self.remote_control_runtime.lock().await;
                if let Some(handle) = slot.as_ref() {
                    let st = handle.status();
                    self.emit_session_telemetry(
                        "remote_control_toggle",
                        serde_json::json!({ "enabled": true, "outcome": "already_running" }),
                    );
                    return HttpResponse::ok(&json!({
                        "enabled": st.enabled,
                        "state": st.state,
                        "url": st.url,
                        "device_id": st.device_id,
                        "device_name": st.device_name,
                        "available": true,
                        "already_running": true,
                        "error": st.error,
                    }));
                }
                // The Kimi login refresh token is the WS-upgrade credential at
                // the relay; the standalone server holds none of its own, so
                // the caller (the web UI, which owns the user session) passes
                // it in. Refusing without it is honest: an empty token would
                // fail the upgrade mid-handshake anyway.
                let refresh_token = body
                    .get("refresh_token")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if refresh_token.trim().is_empty() {
                    return HttpResponse::bad_request(
                        "Field 'refresh_token' is required: remote control authenticates to the relay with the Kimi login credential",
                    );
                }
                // Stable device id, persisted in the session store (TS:
                // `createKimiDeviceId(homeDir)`).
                let device_id = match self.store.get_state("remote-control", "device_id") {
                    Ok(Some(value)) => value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(new_device_id),
                    _ => {
                        let id = new_device_id();
                        let _ = self
                            .store
                            .put_state("remote-control", "device_id", &json!(id));
                        id
                    }
                };
                // Forward target: this server itself, as addressed by the
                // caller (the Host header carries the loopback host:port).
                let local_base_url =
                    format!("http://{}", req.header("host").unwrap_or("127.0.0.1"));
                let local_server_token = self.auth.token().unwrap_or_default().to_string();
                let options = crate::server::remote_control::RemoteControlOptions {
                    device_id: device_id.clone(),
                    local_base_url,
                    local_server_token,
                    refresh_token,
                    ..Default::default()
                };
                let handle = crate::server::remote_control::RemoteControlRuntime::start(options);
                let st = handle.status();
                *slot = Some(handle);
                // v2 reports `error` for a failed start (routes/remoteControl.ts:105);
                // the runtime encodes a failed start in its status.
                let outcome = if st.error.is_some() { "error" } else { "ok" };
                self.emit_session_telemetry(
                    "remote_control_toggle",
                    serde_json::json!({ "enabled": true, "outcome": outcome }),
                );
                HttpResponse::ok(&json!({
                    "enabled": st.enabled,
                    "state": st.state,
                    "url": st.url,
                    "device_id": st.device_id,
                    "device_name": st.device_name,
                    "available": true,
                    "error": st.error,
                }))
            }
            // MCP endpoints
            ("GET", "/api/v1/mcp")
            | ("GET", "/api/v1/mcp/servers")
            | ("GET", "/api/v2/mcp/servers") => {
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
                if p.starts_with("/api/v1/mcp/servers/")
                    && (p.ends_with(":reconnect") || p.ends_with(":restart")) =>
            {
                let name = p
                    .strip_prefix("/api/v1/mcp/servers/")
                    .and_then(|rest| {
                        rest.strip_suffix(":reconnect")
                            .or_else(|| rest.strip_suffix(":restart"))
                    })
                    .unwrap_or_default();
                match self.mcp_manager.reconnect(name).await {
                    Ok(()) => {
                        let servers = self.mcp_manager.server_entries().await;
                        let entry = servers.iter().find(|s| s.name == name);
                        HttpResponse::ok(
                            &json!({ "reconnected": true, "restarting": true, "server": entry }),
                        )
                    }
                    Err(e) => HttpResponse::internal_error(e),
                }
            }
            ("POST", "/api/v1/mcp/servers:test") | ("POST", "/api/v2/mcp/servers:test") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let name = body
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("test-server");
                // Report the real status of the named configured server rather
                // than a fabricated success.
                let entries = self.mcp_manager.server_entries().await;
                match entries.iter().find(|entry| entry.name == name) {
                    Some(entry) => HttpResponse::ok(&json!({
                        "ok": entry.status == "connected",
                        "name": name,
                        "connected": entry.status == "connected",
                        "transport": entry.transport,
                        "status": entry.status,
                        "tool_count": entry.tool_count,
                        "error": entry.error,
                    })),
                    None => HttpResponse::ok(&json!({
                        "ok": false,
                        "name": name,
                        "connected": false,
                        "status": "not_found",
                    })),
                }
            }
            ("POST", "/api/v1/mcp/servers:inspect") | ("POST", "/api/v2/mcp/servers:inspect") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let name = body
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if let Some(tools) = self.mcp_manager.inspect_server(name).await {
                    HttpResponse::ok(&json!({ "name": name, "tools": tools }))
                } else {
                    HttpResponse::not_found()
                }
            }
            ("DELETE", p)
                if p.starts_with("/api/v1/mcp/servers/")
                    || p.starts_with("/api/v2/mcp/servers/") =>
            {
                let name = p.rsplit('/').next().unwrap_or_default();
                if self.mcp_manager.remove_server(name).await {
                    HttpResponse::ok(&json!({ "removed": true, "name": name }))
                } else {
                    HttpResponse::not_found()
                }
            }
            ("GET", "/api/v1/mcp/auth-statuses") | ("GET", "/api/v2/mcp/auth-statuses") => {
                // `authenticated` is a real probe, not key presence: the token
                // is fetched through the OAuth service, which refreshes an
                // expired one and returns `None` when the credential cannot be
                // used. A stored-but-unusable key therefore reports
                // `needs-auth` (v2 `McpServerStatus`) instead of a fabricated
                // `true`. Shape note: v2 returned `data: McpServerAuthStatus[]`;
                // this server keeps its own `{statuses:{<key>:{...}}}` object,
                // which its clients and tests already consume.
                let service = self.mcp_oauth.lock().await.clone();
                let mut statuses = serde_json::Map::new();
                if let Some(service) = service {
                    for key in service.list_keys() {
                        let authenticated = service.access_token(&key).await.is_some();
                        statuses.insert(
                            key,
                            json!({
                                "authenticated": authenticated,
                                "status": if authenticated { "authenticated" } else { "needs-auth" },
                            }),
                        );
                    }
                }
                HttpResponse::ok(&json!({ "statuses": statuses }))
            }
            ("POST", p)
                if p.starts_with("/api/v1/mcp/auth:") || p.starts_with("/api/v2/mcp/auth:") =>
            {
                let action = p.rsplit(':').next().unwrap_or_default();
                let body: Value = if req.body.is_empty() {
                    json!({})
                } else {
                    serde_json::from_slice(&req.body).unwrap_or(json!({}))
                };
                let name = body
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let url = body.get("url").and_then(|v| v.as_str()).unwrap_or_default();
                let Some(service) = self.mcp_oauth.lock().await.clone() else {
                    return HttpResponse::json(
                        503,
                        &json!({ "error": "MCP OAuth is not configured" }),
                    );
                };
                match action {
                    // RFC 8628 §3.1: start a device authorization.
                    "begin" => {
                        let endpoint = body
                            .get("device_authorization_endpoint")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let client_id = body
                            .get("client_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if name.is_empty() || endpoint.is_empty() || client_id.is_empty() {
                            return HttpResponse::bad_request(
                                "name, device_authorization_endpoint and client_id are required",
                            );
                        }
                        match crate::mcp::oauth::begin_device_login(
                            &reqwest::Client::new(),
                            endpoint,
                            client_id,
                        )
                        .await
                        {
                            Ok(start) => HttpResponse::ok(&json!(start)),
                            Err(e) => HttpResponse::bad_request(e),
                        }
                    }
                    // RFC 8628 §3.4: poll until approved, then persist.
                    "complete" => {
                        let device_code = body
                            .get("device_code")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let token_endpoint = body
                            .get("token_endpoint")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let client_id = body
                            .get("client_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if name.is_empty()
                            || url.is_empty()
                            || device_code.is_empty()
                            || token_endpoint.is_empty()
                            || client_id.is_empty()
                        {
                            return HttpResponse::bad_request(
                                "name, url, device_code, token_endpoint and client_id are required",
                            );
                        }
                        let start = crate::mcp::oauth::DeviceCodeStart {
                            device_code: device_code.to_string(),
                            user_code: body
                                .get("user_code")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            verification_uri: body
                                .get("verification_uri")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            verification_uri_complete: None,
                            expires_in: body
                                .get("expires_in")
                                .and_then(|v| v.as_i64())
                                .unwrap_or(300),
                            interval: body.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
                        };
                        match crate::mcp::oauth::poll_device_login(
                            &reqwest::Client::new(),
                            token_endpoint,
                            client_id,
                            &start,
                        )
                        .await
                        {
                            Ok(tokens) => {
                                let key = match crate::mcp::oauth::mcp_oauth_store_key(name, url) {
                                    Ok(key) => key,
                                    Err(e) => return HttpResponse::bad_request(e),
                                };
                                match service.store_tokens(&key, &tokens) {
                                    Ok(()) => HttpResponse::ok(&json!({
                                        "authenticated": true,
                                        "key": key,
                                    })),
                                    Err(e) => HttpResponse::internal_error(e),
                                }
                            }
                            Err(e) => HttpResponse::bad_request(e),
                        }
                    }
                    // Drop the stored credentials.
                    "cancel" | "reset" => {
                        let key = match crate::mcp::oauth::mcp_oauth_store_key(name, url) {
                            Ok(key) => key,
                            Err(e) => return HttpResponse::bad_request(e),
                        };
                        match service.remove(&key) {
                            Ok(removed) => HttpResponse::ok(&json!({
                                "authenticated": false,
                                "removed": removed,
                            })),
                            Err(e) => HttpResponse::internal_error(e),
                        }
                    }
                    other => HttpResponse::bad_request(format!("Unknown MCP auth action: {other}")),
                }
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
                // The roster is engine-global: there is no per-workspace MCP
                // config, so every session sees the same servers. The session
                // is validated so a client cannot probe arbitrary ids, and the
                // payload names the scope rather than implying it is per-session.
                let servers = self.mcp_manager.server_entries().await;
                HttpResponse::ok(&json!({
                    "servers": servers,
                    "sessionId": session_id,
                    "scope": "engine-global",
                }))
            }
            // The session-scoped MCP views the web UI calls. Same engine-global
            // roster as above; the paths differ because the client asks per
            // session, and the session is validated the same way.
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/mcp/servers") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 7 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let servers = self.mcp_manager.server_entries().await;
                HttpResponse::ok(&json!({ "servers": servers, "sessionId": session_id }))
            }
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.contains("/mcp/servers/") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 8 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let name = segments[7];
                let servers = self.mcp_manager.server_entries().await;
                match servers.into_iter().find(|entry| entry.name == name) {
                    Some(entry) => {
                        HttpResponse::ok(&serde_json::to_value(&entry).unwrap_or(Value::Null))
                    }
                    None => HttpResponse::not_found(),
                }
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/mcp/servers/")
                    && (p.ends_with(":reconnect") || p.ends_with(":restart")) =>
            {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 8 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let name = segments[7]
                    .strip_suffix(":reconnect")
                    .or_else(|| segments[7].strip_suffix(":restart"))
                    .unwrap_or_default();
                match self.mcp_manager.reconnect(name).await {
                    Ok(()) => HttpResponse::ok(&json!({ "reconnected": true })),
                    Err(e) => HttpResponse::internal_error(e),
                }
            }
            ("GET", "/api/v1/sessions") => match self.store.list_sessions() {
                Ok(sessions) => {
                    // v2 `sessionsListQueryCoercion`
                    // (kap-server/src/routes/sessions.ts:101-136) is the contract:
                    // page_size (default 20, max 100), busy, include_archive,
                    // exclude_empty, archived_only, workspace_id. The response is
                    // `pageResponseSchema(sessionSchema)` — `{items, has_more}`.
                    let flag = |name: &str| -> Option<bool> {
                        req.query_param(name).map(|v| v == "true" || v == "1")
                    };
                    let exclude_empty = flag("exclude_empty").unwrap_or(false);
                    let archived_only = flag("archived_only").unwrap_or(false);
                    let include_archive = flag("include_archive").unwrap_or(false);
                    let busy_filter = flag("busy");
                    let page_size = req
                        .query_param("page_size")
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(20)
                        .clamp(1, 100);
                    let workspace_filter = req.query_param("workspace_id");
                    let items: Vec<Value> = sessions
                        .iter()
                        .filter(|s| {
                            // `archived_only` and `include_archive` are mutually
                            // exclusive upstream; the default hides archived
                            // sessions.
                            if archived_only {
                                if !s.archived {
                                    return false;
                                }
                            } else if !include_archive && s.archived {
                                return false;
                            }
                            if let Some(want) = workspace_filter.as_deref()
                                && s.workspace_id.as_deref() != Some(want)
                            {
                                return false;
                            }
                            if let Some(want_busy) = busy_filter
                                && self
                                    .engine
                                    .as_ref()
                                    .map(|e| e.is_busy(&s.session_id))
                                    .unwrap_or(false)
                                    != want_busy
                            {
                                return false;
                            }
                            !exclude_empty
                                || !self
                                    .store
                                    .load_session_history(&s.session_id)
                                    .map(|h| h.is_empty())
                                    .unwrap_or(true)
                        })
                        .map(|s| format_wire_session(s, &self.store, self.engine.as_ref()))
                        .collect();
                    let total = items.len();
                    let page: Vec<Value> = items.into_iter().take(page_size).collect();
                    // `sessions` stays for the in-tree clients that predate the
                    // paged contract.
                    HttpResponse::ok(&json!({
                        "items": page,
                        "has_more": total > page_size,
                        "sessions": page,
                    }))
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
            // Raw file content by absolute path (kap-server `fsContent`): ETag
            // revalidation and a single `Range` slice, everything else served
            // in full. Auth is the bearer check at the HTTP layer — same trust
            // level as `fs:browse`, which also walks the whole host.
            ("GET", "/api/v1/fs::content") | ("GET", "/api/v1/fs:content") => {
                crate::server::fs_routes::handle_fs_content(
                    req.query_param("path").as_deref(),
                    req.header("if-none-match"),
                    req.header("range"),
                )
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
                // Opaque cursor: the message offset encoded as a decimal
                // string. Absent/null means the first page.
                let offset = match body.get("page_token") {
                    None | Some(Value::Null) => 0usize,
                    Some(Value::String(s)) if s.trim().is_empty() => 0usize,
                    Some(Value::String(s)) => match s.trim().parse::<usize>() {
                        Ok(n) => n,
                        Err(_) => {
                            return HttpResponse::bad_request(
                                "Field 'page_token' must be an opaque cursor from a previous response",
                            );
                        }
                    },
                    Some(_) => {
                        return HttpResponse::bad_request(
                            "Field 'page_token' must be an opaque cursor from a previous response",
                        );
                    }
                };

                // Fetch one past the page to know whether a next page exists.
                let mut hits = match self.store.search_messages(
                    query,
                    session_id,
                    role,
                    page_size.saturating_add(1),
                    offset,
                ) {
                    Ok(h) => h,
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };

                let has_more = hits.len() > page_size;
                hits.truncate(page_size);
                let next_page_token = if has_more {
                    Value::String((offset + page_size).to_string())
                } else {
                    Value::Null
                };

                let total_sessions = self.store.list_sessions().map(|s| s.len()).unwrap_or(0);
                let total_messages = self.store.count_messages().unwrap_or(0);

                HttpResponse::ok(&json!({
                    "items": hits,
                    "has_more": has_more,
                    "page_token": next_page_token,
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
                let id = body
                    .get("id")
                    .or_else(|| body.get("name"))
                    // The official Web bundle's `installPlugin` posts the
                    // catalog entry's `source` under a `source` key;
                    // `install_plugin_from` already matches a catalog `source`
                    // as well as an id, so reading it here is all that was
                    // missing — the request used to 400 as "Missing plugin id".
                    .or_else(|| body.get("source"))
                    .and_then(|v| v.as_str());
                let Some(id) = id else {
                    return HttpResponse::bad_request("Missing plugin id");
                };
                // Install from a catalog id, a catalog `source`, a local root,
                // or a remote archive URL. A remote source is downloaded here,
                // so the recorded install has content behind it; an unknown id
                // is a 404, and the recorded version comes from the catalog or
                // the archive's own manifest, never from a hardcoded literal.
                // Install from a catalog id, a catalog `source`, a local root,
                // or a remote archive URL. A remote source is downloaded here,
                // so the recorded install has content behind it; an unknown id
                // is a 404, and the recorded version comes from the catalog or
                // the archive's own manifest, never from a hardcoded literal.
                match self.plugin_manager.install_plugin_from(id) {
                    Ok(Some((id, info))) => {
                        self.publish_plugin_changed();
                        HttpResponse::ok(&json!({
                            "id": id,
                            "enabled": info.enabled,
                            "version": info.version,
                            "installed": true
                        }))
                    }
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::bad_request(e),
                }
            }
            ("GET", "/api/v1/skills") => {
                let config = self.config().await;
                let merge = config.resolve_merge_all_available_skills();
                let mut extra = config.extra_skill_dirs_paths();
                extra.extend(self.plugin_manager.plugin_skill_dirs());
                let skills =
                    crate::skills::scan_all_skills_with_extra_and_merge(None, &extra, merge);
                HttpResponse::ok(&json!({ "skills": skills }))
            }
            ("POST", "/api/v1/acp") => {
                let body_str = match std::str::from_utf8(&req.body) {
                    Ok(s) => s,
                    Err(_) => return HttpResponse::bad_request("Invalid UTF-8 payload"),
                };
                // Attach the server engine when one is configured: a bare
                // per-request AcpServer has no model and no auth state, so
                // every session method but `initialize` used to fail with
                // -32000 and every notification was dropped. Uses the shared
                // (factory-preserving) constructor: the host-factory slot is
                // engine-global and must keep pointing at the dedicated stdio
                // ACP server. No notification sink is set on purpose — plain
                // HTTP request/response has no channel for server-push
                // `session/update`s; the final result still travels in the
                // JSON-RPC response.
                let acp_server = match &self.engine {
                    Some(engine) => crate::acp::AcpServer::with_shared_engine(
                        self.store.clone(),
                        engine.clone(),
                    ),
                    None => crate::acp::AcpServer::new(self.store.clone()),
                };
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
                    // `Ok(false)` = unknown plugin id: neither installed nor in
                    // the catalog. Answer 404 rather than recording a fake entry.
                    "enable" => match self.plugin_manager.set_plugin_enabled(id, true) {
                        Ok(true) => {
                            self.publish_plugin_changed();
                            // v2 #3963: the toggle reports the resulting
                            // enabled set, so telemetry can attribute later
                            // turns to the plugins that were loaded.
                            self.emit_session_telemetry(
                                "plugin_toggle",
                                json!({
                                    "plugin_id": id,
                                    "enabled": true,
                                    "enabled_plugins": self.plugin_manager.enabled_plugin_ids(),
                                }),
                            );
                            HttpResponse::ok(
                                &json!({ "ok": true, "pluginId": id, "enabled": true }),
                            )
                        }
                        Ok(false) => HttpResponse::not_found(),
                        Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                    },
                    "disable" => match self.plugin_manager.set_plugin_enabled(id, false) {
                        Ok(true) => {
                            self.publish_plugin_changed();
                            self.emit_session_telemetry(
                                "plugin_toggle",
                                json!({
                                    "plugin_id": id,
                                    "enabled": false,
                                    "enabled_plugins": self.plugin_manager.enabled_plugin_ids(),
                                }),
                            );
                            HttpResponse::ok(
                                &json!({ "ok": true, "pluginId": id, "enabled": false }),
                            )
                        }
                        Ok(false) => HttpResponse::not_found(),
                        Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                    },
                    "remove" => match self.plugin_manager.remove_plugin(id) {
                        Ok(true) => {
                            self.publish_plugin_changed();
                            HttpResponse::ok(
                                &json!({ "ok": true, "pluginId": id, "removed": true }),
                            )
                        }
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
                let flow = self
                    .oauth_manager
                    .clone()
                    .start_login(provider, region)
                    .await;
                HttpResponse::ok(&oauth_flow_wire(Some(&flow), provider))
            }
            ("GET", "/api/v1/oauth/login") => {
                let provider = req.query_param("provider").unwrap_or_else(|| "kimi".into());
                let flow = self.oauth_manager.get_flow(&provider);
                HttpResponse::ok(&oauth_flow_wire(flow.as_ref(), &provider))
            }
            ("DELETE", "/api/v1/oauth/login") => {
                let provider = req.query_param("provider").unwrap_or_else(|| "kimi".into());
                let cancelled = self.oauth_manager.cancel_login(&provider);
                // The bundle's `cancelOAuthLogin` reads `status` alongside
                // `cancelled`; the terminal status of a cancelled flow is
                // `cancelled` when it really was, and the flow's own status
                // otherwise (nothing to cancel).
                let status = if cancelled {
                    "cancelled".to_string()
                } else {
                    self.oauth_manager
                        .get_flow(&provider)
                        .map(|flow| flow.status)
                        .unwrap_or_else(|| "cancelled".to_string())
                };
                HttpResponse::ok(&json!({ "cancelled": cancelled, "status": status }))
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
            // Resolve the client region (mainland-cn/global), mirroring v2
            // `resolveKimiRegion`'s precedence: env host > configured host/key >
            // install-channel marker > default. The standalone server does not
            // persist an oauth ref of its own, so the configured pair is `None`
            // here — env and the marker still decide.
            ("GET", "/api/v1/oauth/region") => {
                let env_host = std::env::var("KIMI_CODE_OAUTH_HOST")
                    .ok()
                    .or_else(|| std::env::var("KIMI_OAUTH_HOST").ok())
                    .filter(|v| !v.trim().is_empty());
                let home = crate::workflow::kimi_home().unwrap_or_else(|| PathBuf::from("."));
                let region = crate::server::oauth::resolve_kimi_region(
                    env_host.as_deref(),
                    None,
                    None,
                    &home,
                );
                HttpResponse::ok(&json!({ "region": region }))
            }
            ("GET", "/api/v1/oauth/user") | ("GET", "/api/v1/oauth/userinfo") => {
                let provider = req.query_param("provider").unwrap_or_else(|| "kimi".into());
                HttpResponse::ok(&self.oauth_manager.get_user_info(&provider).await)
            }
            ("GET", "/api/v1/auth") => {
                let config = self.config().await;
                let has_cached_token = |provider: &str| self.has_cached_token(provider);
                HttpResponse::ok(&crate::server::model_catalog::auth_summary(
                    &config,
                    &has_cached_token,
                ))
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
                let config = self.config().await;
                let merge = config.resolve_merge_all_available_skills();
                let mut extra = config.extra_skill_dirs_paths();
                extra.extend(self.plugin_manager.plugin_skill_dirs());
                let skills = crate::skills::scan_all_skills_with_extra_and_merge(
                    Some(&root_path),
                    &extra,
                    merge,
                );
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
                let mut owning_session: Option<String> = None;
                if p != "/api/v1/cron" {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                    owning_session = Some(session_id.to_string());
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
                    session_id: owning_session.clone(),
                    created_at: Some(chrono::Utc::now().timestamp_millis()),
                };
                let mut scheduler = self.cron_scheduler.lock().await;
                if scheduler.add_entry(entry) {
                    // Persist so the schedule survives a restart and is
                    // reloaded by `run_serve`.
                    self.persist_cron_entries(&scheduler.list_entries());
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
                    // Keep the persisted set in sync with the in-memory one.
                    self.persist_cron_entries(&scheduler.list_entries());
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
                // v2 answers `{items}` only, with an optional `status` filter
                // (kap-server/src/routes/tasks.ts:82-87).
                let items: Vec<Value> = match req.query_param("status") {
                    Some(wanted) => tasks
                        .into_iter()
                        .filter(|task| task.get("status").and_then(|v| v.as_str()) == Some(&wanted))
                        .collect(),
                    None => tasks,
                };
                HttpResponse::ok(&json!({ "items": items }))
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
                    // v2's `getTask` answers the bare wire task
                    // (`okEnvelope(toWireTask(...))`, kap-server/src/routes/tasks.ts:134).
                    Some(entry) => HttpResponse::ok(&entry),
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
                match self
                    .task_runner
                    .stop(
                        task_id,
                        serde_json::from_slice::<Value>(&req.body)
                            .ok()
                            .as_ref()
                            .and_then(|body| body.get("reason"))
                            .and_then(|reason| reason.as_str()),
                    )
                    .await
                {
                    Ok(wire) => HttpResponse::ok(&json!({ "stopped": true, "task": wire })),
                    Err(_) => HttpResponse::not_found(),
                }
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/tasks/")
                    && p.ends_with(":cancel") =>
            {
                let remainder = &p["/api/v1/sessions/".len()..];
                let (session_id, rest) = match remainder.split_once("/tasks/") {
                    Some(pair) => pair,
                    None => return HttpResponse::not_found(),
                };
                let task_id = match rest.strip_suffix(":cancel") {
                    Some(tid) if !tid.is_empty() => tid,
                    _ => return HttpResponse::not_found(),
                };
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                if let Some(entry) = self.task_runner.entry(task_id) {
                    let status = entry.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    if status != "running" && status != "pending" {
                        return HttpResponse::json(
                            409,
                            &json!({ "error": "task.already_finished", "code": 40904 }),
                        );
                    }
                    let _ = self
                        .task_runner
                        .stop(task_id, Some("Cancelled by client"))
                        .await;
                    HttpResponse::ok(&json!({ "cancelled": true }))
                } else {
                    HttpResponse::json(404, &json!({ "error": "task.not_found", "code": 40406 }))
                }
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/tasks/")
                    && p.ends_with(":detach") =>
            {
                let remainder = &p["/api/v1/sessions/".len()..];
                let (session_id, rest) = match remainder.split_once("/tasks/") {
                    Some(pair) => pair,
                    None => return HttpResponse::not_found(),
                };
                let task_id = match rest.strip_suffix(":detach") {
                    Some(tid) if !tid.is_empty() => tid,
                    _ => return HttpResponse::not_found(),
                };
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                if let Some(entry) = self.task_runner.entry(task_id) {
                    let status = entry.get("status").cloned().unwrap_or(json!("completed"));
                    HttpResponse::ok(&json!({ "detached": false, "status": status }))
                } else {
                    HttpResponse::json(404, &json!({ "error": "task.not_found", "code": 40406 }))
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
                let prompt = crate::prompt::DEFAULT_INIT_PROMPT;
                let Some(engine) = self.engine.as_ref() else {
                    // No engine attached: still hand back the analyzed prompt so
                    // a caller can run it elsewhere.
                    return HttpResponse::ok(&json!({
                        "status": "initiated",
                        "sessionId": session_id,
                        "prompt": prompt,
                    }));
                };
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
                        "status": "completed",
                        "sessionId": session_id,
                        "turnId": report.turn_id,
                        "turnNumber": turn_number,
                        "stopReason": report.stop_reason,
                        "content": report.reply,
                        "steps": report.steps,
                        "llmTransport": report.llm_transport,
                        "eventsEmitted": report.events_emitted,
                        "nativeToolCalls": report.native_tool_calls,
                        "usage": report.usage,
                        "prompt": prompt,
                    })),
                    Err(error) => HttpResponse::internal_error(error.to_string()),
                }
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
                // Read the session's own profile. `permission` / `thinking_level`
                // used to be string literals ("auto" / "medium"), so a client that
                // read the REST status once saw the defaults no matter what the
                // user had configured — and disagreed with the same engine's
                // `agent.status.updated` event, which reads `agent_config`.
                let agent_config = self
                    .store
                    .get_state("agent_config", session_id)
                    .ok()
                    .flatten()
                    .unwrap_or(Value::Null);
                let metadata = self
                    .store
                    .get_state("metadata", session_id)
                    .ok()
                    .flatten()
                    .unwrap_or(Value::Null);
                let active_model = agent_config
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| self.engine.as_ref().map(|e| e.model_name().to_string()))
                    .unwrap_or_else(|| "kimi-latest".to_string());
                // Same two homes as `ServerEngine::status_payload`: the profile
                // route writes `agent_config`, the engine's per-turn resolution
                // reads `metadata`.
                let permission = agent_config
                    .get("permission_mode")
                    .and_then(|v| v.as_str())
                    .or_else(|| metadata.get("permission_mode").and_then(|v| v.as_str()))
                    .unwrap_or("auto");
                let thinking_level = agent_config
                    .get("thinking")
                    .and_then(|v| v.as_str())
                    .unwrap_or("medium");
                let plan_mode = agent_config
                    .get("plan_mode")
                    .and_then(|v| v.as_bool())
                    .or_else(|| metadata.get("plan_mode").and_then(|v| v.as_bool()))
                    .unwrap_or(false);
                let max_context_tokens = metadata
                    .get("max_context_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(262_144);
                let context_usage = if max_context_tokens == 0 {
                    0.0
                } else {
                    context_tokens as f64 / max_context_tokens as f64
                };
                // Swarm / tower ride the session profile (`agent_config`), which
                // the profile route writes; tower additionally follows the
                // engine-wide experimental gate.
                let swarm_mode = agent_config
                    .get("swarm_mode")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let tower_mode = crate::tools::tower::paths::tower_enabled(
                    crate::tools::tower::paths::tower_env_switch(),
                    None,
                );
                HttpResponse::ok(&json!({
                    // v2 `sessionStatusResponseSchema`
                    // (agent-core-v2/src/app/sessionLegacy/sessionProtocol.ts:74):
                    // exactly these keys, answered bare. `sessionId` /
                    // `total_turns` / `created_at` were fork additions.
                    "busy": busy,
                    "model": active_model,
                    "thinking_level": thinking_level,
                    "permission": permission,
                    "plan_mode": plan_mode,
                    "swarm_mode": swarm_mode,
                    "tower_mode": tower_mode,
                    "context_tokens": context_tokens,
                    "max_context_tokens": max_context_tokens,
                    "context_usage": context_usage,
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
            ("GET", p) if extract_session_subaction(p, "transcript", "ops").is_some() => {
                let session_id = extract_session_subaction(p, "transcript", "ops").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let agent_id = req
                    .query_param("agent_id")
                    .unwrap_or_else(|| "main".to_string());
                let since_seq = req
                    .query_param("since_seq")
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0);
                let latest_seq = self.store.latest_wire_event_seq(session_id).unwrap_or(0);
                // `complete` mirrors the transcript contract: the persisted
                // journal covers the cursor only once it holds events; an empty
                // journal signals the caller to do a full refresh instead.
                let complete = latest_seq > 0 && since_seq <= latest_seq;
                let batches: Vec<Value> = if latest_seq > since_seq {
                    let history = self
                        .store
                        .load_session_history(session_id)
                        .unwrap_or_default();
                    let items = crate::server::transcript::build_items(&history);
                    let snapshot = json!({
                        "items": items,
                        "tasks": [],
                        "interactions": [],
                        "attachments": [],
                        "todos": [],
                        "prompts": crate::server::transcript::cold_prompts(
                            &self.store,
                            session_id
                        ),
                        "meta": {},
                    });
                    // A single idempotent `reset` op rebuilds the client from the
                    // authoritative snapshot —correct for any lag, at the cost
                    // of not being a minimal delta.
                    vec![json!({
                        "seq": latest_seq,
                        "ops": [{
                            "op": "reset",
                            "agentId": agent_id,
                            "snapshot": snapshot,
                        }],
                    })]
                } else {
                    Vec::new()
                };
                HttpResponse::ok(&json!({
                    "agent_id": agent_id,
                    "batches": batches,
                    "latest_seq": latest_seq,
                    "complete": complete,
                }))
            }
            ("GET", p) if extract_session_subaction(p, "transcript", "user-messages").is_some() => {
                let session_id =
                    extract_session_subaction(p, "transcript", "user-messages").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let agent_id = req
                    .query_param("agent_id")
                    .unwrap_or_else(|| "main".to_string());
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let items = crate::server::transcript::build_items(&history);
                let messages = crate::server::transcript::project_user_messages(&items);
                HttpResponse::ok(&json!({
                    "agents": [{
                        "agent_id": agent_id,
                        "messages": messages,
                        "attachments": [],
                    }],
                }))
            }
            ("GET", p) if extract_session_subaction(p, "transcript", "plan").is_some() => {
                let session_id = extract_session_subaction(p, "transcript", "plan").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let agent_id = req
                    .query_param("agent_id")
                    .unwrap_or_else(|| "main".to_string());
                let tool_call_id = req.query_param("tool_call_id");
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let items = crate::server::transcript::build_items(&history);
                let plans =
                    crate::server::transcript::project_plans(&items, tool_call_id.as_deref());
                if tool_call_id.is_some() && plans.is_empty() {
                    let requested = tool_call_id.unwrap_or_default();
                    return HttpResponse::json(
                        404,
                        &json!({
                            "code": crate::server::envelope::error_codes::SESSION_NOT_FOUND,
                            "msg": format!("no ExitPlanMode tool call found for tool_call_id: {requested}"),
                        }),
                    );
                }
                HttpResponse::ok(&json!({ "agent_id": agent_id, "plans": plans }))
            }
            ("GET", p) if extract_session_action(p, "transcript").is_some() => {
                let session_id = extract_session_action(p, "transcript").unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let agent_id = req
                    .query_param("agent_id")
                    .unwrap_or_else(|| "main".to_string());
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let items = crate::server::transcript::build_items(&history);
                let page = crate::server::transcript::TurnPageQuery {
                    before_turn: req.query_param("before_turn"),
                    after_turn: req.query_param("after_turn"),
                    page_size: req
                        .query_param("page_size")
                        .and_then(|value| value.parse::<usize>().ok())
                        .unwrap_or(crate::server::transcript::DEFAULT_PAGE_SIZE),
                };
                let (page_items, has_more) =
                    crate::server::transcript::paginate_turns(&items, &page);
                HttpResponse::ok(&json!({
                    "agent_id": agent_id,
                    "items": page_items,
                    "has_more": has_more,
                    "tasks": [],
                    "interactions": [],
                    "attachments": [],
                    "todos": [],
                    "prompts": crate::server::transcript::cold_prompts(
                        &self.store,
                        session_id
                    ),
                    "meta": {},
                    "agents": [{
                        "agentId": agent_id,
                        "type": if agent_id == "main" { "main" } else { "sub" },
                    }],
                    "pending_interactions": [],
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
                    Ok(true) => {
                        // v2 `forkSessionResponseSchema = sessionSchema`
                        // (kap-server/src/protocol/rest-session.ts:103) answered as
                        // the bare wire session via `okEnvelope` — the new
                        // session's document, nothing wrapped around it.
                        let created = self.store.get_session(&new_session_id).ok().flatten();
                        let wire = match created {
                            Some(ref session) => {
                                format_wire_session(session, &self.store, self.engine.as_ref())
                            }
                            None => json!({}),
                        };
                        HttpResponse::ok(&wire)
                    }
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if extract_session_action(p, "restore").is_some() => {
                let session_id = extract_session_action(p, "restore").unwrap();
                match self.store.restore_session(session_id) {
                    Ok(true) => {
                        // v2 `restoreSessionAction` answers the restored session
                        // via `okEnvelope(session, …)`
                        // (kap-server/src/routes/sessions.ts:976).
                        let summary = self.store.get_session(session_id).ok().flatten();
                        let wire = match summary {
                            Some(ref session) => {
                                format_wire_session(session, &self.store, self.engine.as_ref())
                            }
                            None => json!({}),
                        };
                        HttpResponse::ok(&wire)
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
            ("POST", p) if extract_session_action(p, "delete").is_some() => {
                let session_id = extract_session_action(p, "delete").unwrap();
                let workspace_id = self
                    .store
                    .get_session(session_id)
                    .ok()
                    .flatten()
                    .map(|s| s.workspace_id);
                match self.store.delete_session(session_id) {
                    Ok(true) => {
                        self.interaction_manager.cancel_session(session_id);
                        let guard = crate::tools::external_hooks::HookGuard::new(
                            self.config().await.hooks.clone(),
                        );
                        guard
                            .notify_session_lifecycle(
                                "SessionEnd",
                                "archive",
                                json!({ "reason": "archive", "session_title": "" }),
                            )
                            .await;
                        let del_event = json!({
                            "type": "event.session.deleted",
                            "sessionId": session_id,
                            "workspaceId": workspace_id,
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
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/children") => {
                let session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .and_then(|rest| rest.strip_suffix("/children"))
                    .unwrap_or_default();
                match self.store.list_children(session_id) {
                    Ok(children) => {
                        let items: Vec<Value> = children
                            .into_iter()
                            .map(|s| format_wire_session(&s, &self.store, self.engine.as_ref()))
                            .collect();
                        // v2 answers the paged `{items, has_more}` contract
                        // (kap-server routes/sessions.ts:694,
                        // pageResponseSchema(sessionSchema)); the web client
                        // reads `.items`, so a `children` key leaves it
                        // mapping over undefined.
                        HttpResponse::ok(&json!({ "items": items, "has_more": false }))
                    }
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/children") => {
                let parent_session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .and_then(|rest| rest.strip_suffix("/children"))
                    .unwrap_or_default();
                let parent = match self.store.get_session(parent_session_id) {
                    Ok(Some(s)) => s,
                    Ok(None) => return HttpResponse::not_found(),
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let child_session_id = format!("sess-{}", fastrand::u64(..));
                let title = body.get("title").and_then(|v| v.as_str());
                let workspace_id = parent.workspace_id.as_deref();
                if let Err(e) =
                    self.store
                        .create_session_with_workspace(&child_session_id, title, workspace_id)
                {
                    return HttpResponse::internal_error(format!("Database error: {e}"));
                }
                if let Err(e) = self
                    .store
                    .set_parent_session_id(&child_session_id, parent_session_id)
                {
                    return HttpResponse::internal_error(format!("Database error: {e}"));
                }
                if let Some(metadata) = body.get("metadata") {
                    let _ = self.store.put_session_state(
                        "metadata",
                        &child_session_id,
                        &child_session_id,
                        metadata,
                    );
                }
                let created_session = self.store.get_session(&child_session_id).ok().flatten();
                let session_val = if let Some(ref s) = created_session {
                    format_wire_session(s, &self.store, self.engine.as_ref())
                } else {
                    json!(created_session)
                };
                // v2 has no `statusCode` on create routes, so the envelope ships
                // as HTTP 200 (`success: { data: sessionSchema }`,
                // kap-server/src/routes/sessions.ts:181-184 for the parent,
                // :707-710 for the child) — not 201.
                HttpResponse::ok(&session_val)
            }
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/warnings") => {
                let session_id = p
                    .strip_prefix("/api/v1/sessions/")
                    .and_then(|rest| rest.strip_suffix("/warnings"))
                    .unwrap_or_default();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                // The engine's own degradations: MCP servers it could not
                // connect, and servers waiting on the user's authorization.
                // A healthy roster produces an empty list.
                let warnings = self.mcp_manager.session_warnings().await;
                HttpResponse::ok(&json!({ "warnings": warnings }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/title/generate") => {
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
                // Never rewrite history under a running turn (v2 raises
                // SESSION_BUSY before beginning a compaction).
                if let Some(engine) = self.engine.as_ref()
                    && engine.is_busy(session_id)
                {
                    return HttpResponse::json(
                        409,
                        &json!({
                            "code": "SESSION_BUSY",
                            "error": "compaction refused: a turn is in flight",
                        }),
                    );
                }
                let body: Value = if req.body.is_empty() {
                    json!({})
                } else {
                    serde_json::from_slice(&req.body).unwrap_or(json!({}))
                };
                // v2 `rest-session.ts:131-137`: the caller may pass a
                // summarization hint with the request.
                let instruction = body
                    .get("instruction")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty());
                self.hub
                    .bus_for(session_id)
                    .publish(&crate::events::EngineEvent::Custom(json!({
                        "type": "compaction.started",
                        "sessionId": session_id,
                        "instruction": instruction,
                    })));
                // Summarize the prefix this compaction is about to fold away, so
                // the compacted history carries a written summary instead of the
                // fixed placeholder. The NAPI path has always summarized; this
                // endpoint did not, so the same "compact" action produced
                // different history depending on which client asked for it.
                //
                // A summary is mandatory once the split is non-trivial (the
                // store rejects blank ones), so the prerequisites are resolved
                // BEFORE the history is touched and each failure carries its
                // own status: no engine or no bound model is a server
                // configuration problem (503, matching the steer route), while
                // a summarizer that ran and failed is a request failure (500).
                let engine = match self.engine.as_ref() {
                    Some(engine) => engine,
                    None => {
                        return HttpResponse::json(
                            503,
                            &json!({ "error": "no engine configured for this server" }),
                        );
                    }
                };
                let llm = match engine.session_llm(session_id).await {
                    Some(llm) => llm,
                    None => {
                        return HttpResponse::json(
                            503,
                            &json!({
                                "error": "no model is bound to this session; compact requires a model to write the summary",
                            }),
                        );
                    }
                };
                let history = match self.store.load_session_history(session_id) {
                    Ok(history) => history,
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                let config = crate::compaction::CompactionConfig {
                    max_attempts: engine.compaction_max_attempts(),
                    ..crate::compaction::CompactionConfig::default()
                };
                let count = crate::compaction::compute_compact_count_manual(&history, &config);
                let summary = if count == 0 {
                    // Nothing to fold: the store's own no-op path reports it.
                    None
                } else {
                    match crate::compaction::summarize_with_llm(
                        &history[1..count as usize],
                        llm.as_ref(),
                        instruction,
                        None,
                        config.max_attempts,
                    )
                    .await
                    {
                        Ok(summary) => Some(summary),
                        Err(error) => return HttpResponse::internal_error(error.to_string()),
                    }
                };
                match self
                    .store
                    .compact_session_with_summary(session_id, instruction, summary)
                {
                    Ok(report) => {
                        self.hub
                            .bus_for(session_id)
                            .publish(&crate::events::EngineEvent::Custom(json!({
                                "type": "compaction.completed",
                                "sessionId": session_id,
                                "compactedCount": report.messages_before,
                                "removed": report.removed,
                                "tokensBefore": report.tokens_before,
                                "tokensAfter": report.tokens_after,
                                "keptUserMessageCount": report.kept_user_message_count,
                            })));
                        // Web-vocabulary alias (`event.session.history_compacted`):
                        // the journal seq and summary message id are not tracked
                        // on this path, so the cut is reported without them.
                        self.hub
                            .bus_for(session_id)
                            .publish(&crate::events::EngineEvent::Custom(json!({
                                "type": "event.session.history_compacted",
                                "before_seq": Value::Null,
                                "reason": "manual",
                                "summary_message_id": Value::Null,
                            })));
                        HttpResponse::ok(&json!({
                            "compacted": true,
                            "removed": report.removed,
                            "sessionId": session_id,
                            "compactedCount": report.messages_before,
                            "tokensBefore": report.tokens_before,
                            "tokensAfter": report.tokens_after,
                        }))
                    }
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
                let revert_files = body
                    .get("revert_files")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                // Never delete rows under a running turn (v2 raises
                // SESSION_BUSY before undoing).
                if let Some(engine) = self.engine.as_ref()
                    && engine.is_busy(session_id)
                {
                    return HttpResponse::json(
                        409,
                        &json!({
                            "code": "SESSION_BUSY",
                            "error": "undo refused: a turn is in flight",
                        }),
                    );
                }
                // Resolve the turns first: a compaction-boundary refusal must
                // happen before any workspace file is touched, and file
                // history is keyed by turn *number*, not by the undo count.
                let turn_numbers = match self.store.plan_undo_turns(session_id, count) {
                    Ok(numbers) => numbers,
                    Err(e) if e.contains("undo refused") => return HttpResponse::bad_request(e),
                    Err(e) => return HttpResponse::internal_error(format!("Database error: {e}")),
                };
                // Revert the workspace files *before* the turn rows are deleted:
                // if a file cannot be restored we must not report a successful
                // undo, and the history must stay intact so the operation can be
                // retried instead of silently diverging from the workspace.
                if revert_files {
                    let Some(workdir) = fs_routes::resolve_session_workdir(&self.store, session_id)
                    else {
                        return HttpResponse::bad_request(
                            "undo requested `revert_files` but this session has no resolvable working directory, so its files cannot be restored. Retry without `revert_files` to undo history only.",
                        );
                    };
                    let mut revert_failures: Vec<String> = Vec::new();
                    for turn_number in &turn_numbers {
                        if let Err(e) = self.store.revert_turn_file_changes(
                            session_id,
                            *turn_number as usize,
                            &workdir,
                        ) {
                            revert_failures.push(format!("turn {turn_number}: {e}"));
                        }
                    }
                    if !revert_failures.is_empty() {
                        return HttpResponse::internal_error(format!(
                            "undo refused: the workspace files of {} could not be restored ({}). No history was removed.",
                            turn_numbers
                                .iter()
                                .map(|n| n.to_string())
                                .collect::<Vec<_>>()
                                .join(", "),
                            revert_failures.join("; ")
                        ));
                    }
                }
                match self.store.undo_turns(session_id, count) {
                    Ok(undone) => {
                        // Online transcripts must learn about the cut, exactly
                        // like delete/patch publish their own events.
                        self.hub
                            .bus_for(session_id)
                            .publish(&crate::events::EngineEvent::Custom(json!({
                                "type": "context.undone",
                                "sessionId": session_id,
                                "undone": undone,
                                "turnNumbers": turn_numbers,
                            })));
                        HttpResponse::ok(&json!({
                            "undone": undone,
                            "sessionId": session_id
                        }))
                    }
                    // Crossing the compaction boundary is a client error, not
                    // a database failure —surface the refusal verbatim.
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
                        // v2 `listMessagesResponseSchema` is
                        // `{ items: messageSchema[], has_more }`
                        // (kap-server/src/protocol/rest-message.ts:14). The fork
                        // answered `{sessionId, messages}` with raw `LLMMessage`
                        // rows, so `items` was missing and each element lacked
                        // the `id`/`session_id`/`content[]` block projection the
                        // schema requires. `messages` stays for the in-tree
                        // consumers that predate the paged contract.
                        let items: Vec<Value> = history
                            .iter()
                            .enumerate()
                            .map(|(index, message)| {
                                project_wire_message(session_id, index, message)
                            })
                            .collect();
                        HttpResponse::ok(&json!({
                            "items": items,
                            "has_more": false,
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
                // v2 answers the bare `goalSnapshotSchema` or `null`
                // (kap-server/src/routes/sessions.ts:798 →
                // `getSessionGoalResponseSchema = goalSnapshotSchema.nullable()`);
                // the fork's `{sessionId, goal}` wrapper made every client read
                // `status` off a level that never had it.
                HttpResponse::ok(&goal_val)
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
                let config = self.config().await;
                let merge = config.resolve_merge_all_available_skills();
                let mut extra = config.extra_skill_dirs_paths();
                extra.extend(self.plugin_manager.plugin_skill_dirs());
                let skills = crate::skills::scan_all_skills_with_extra_and_merge(
                    ws_root.as_deref(),
                    &extra,
                    merge,
                );
                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "skills": skills,
                }))
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/skills/")
                    && p.ends_with(":activate") =>
            {
                let remainder = &p["/api/v1/sessions/".len()..];
                let (session_id, rest) = match remainder.split_once("/skills/") {
                    Some(pair) => pair,
                    None => return HttpResponse::not_found(),
                };
                let skill_name = match rest.strip_suffix(":activate") {
                    Some(name) if !name.is_empty() => name,
                    _ => return HttpResponse::not_found(),
                };
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
                let config = self.config().await;
                let merge = config.resolve_merge_all_available_skills();
                let mut extra = config.extra_skill_dirs_paths();
                extra.extend(self.plugin_manager.plugin_skill_dirs());
                let skills = crate::skills::scan_all_skills_with_extra_and_merge(
                    ws_root.as_deref(),
                    &extra,
                    merge,
                );
                if !skills.iter().any(|s| s.name == skill_name) {
                    return HttpResponse::json(
                        404,
                        &json!({ "error": "skill.not_found", "code": 40415 }),
                    );
                }
                HttpResponse::ok(&json!({ "activated": true, "skill_name": skill_name }))
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
                        Err(e) => {
                            return HttpResponse::bad_request(format!(
                                "Invalid JSON payload for question resolution: {e}"
                            ));
                        }
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

                // Fail closed: an approval resolution must name its decision
                // explicitly. Defaulting a missing/!parsable body to "approved"
                // let any client that could reach this route grant a dangerous
                // tool by POSTing an empty body.
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(e) => {
                        return HttpResponse::bad_request(format!(
                            "Invalid JSON payload for approval resolution: {e}"
                        ));
                    }
                };
                let decision_str = match body.get("decision").and_then(|v| v.as_str()) {
                    Some(v) => v,
                    None => {
                        return HttpResponse::bad_request(
                            "Missing required 'decision' field (expected \"approved\" or \"denied\")",
                        );
                    }
                };
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
            // Two verbs, two contracts. The official Web bundle posts through a
            // bespoke transport that hard-fails unless the response is
            // `application/zip`; the in-tree REST clients read the export
            // document as JSON over GET.
            ("POST", p) if extract_session_action(p, "export").is_some() => {
                let session_id = extract_session_action(p, "export").unwrap();
                match self.store.export_session(session_id) {
                    Ok(Some(export)) => match build_session_export_zip(&export) {
                        Ok(archive) => HttpResponse::bytes(200, "application/zip", archive)
                            .with_header(
                                "Content-Disposition",
                                format!("attachment; filename=\"{session_id}.zip\""),
                            ),
                        Err(e) => HttpResponse::internal_error(format!(
                            "Failed to build the export archive: {e}"
                        )),
                    },
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if extract_session_action(p, "export").is_some() => {
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
                // v2 `GET /sessions/{session_id}/profile` answers the bare
                // session (`success: { data: sessionSchema }`,
                // kap-server/src/routes/sessions.ts:455). `agent_config` is part
                // of that document — `format_wire_session` fills it, including
                // the model / thinking fallbacks — so the fork's separate
                // `agent_config` / `sessionId` / `session` keys were answering a
                // shape nothing asked for.
                let wire_session = format_wire_session(&session, &self.store, self.engine.as_ref());
                HttpResponse::ok(&wire_session)
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
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                if let Some(new_title) = body.get("title").and_then(|v| v.as_str())
                    && let Err(e) = self
                        .store
                        .update_session_title(session_id, Some(new_title.trim()))
                {
                    return HttpResponse::internal_error(format!(
                        "Failed to persist the session title: {e}"
                    ));
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
                    if let Err(e) = self.store.put_session_state(
                        "agent_config",
                        session_id,
                        session_id,
                        &current,
                    ) {
                        return HttpResponse::internal_error(format!(
                            "Failed to persist the agent config: {e}"
                        ));
                    }
                }
                let updated_session = self
                    .store
                    .get_session(session_id)
                    .ok()
                    .flatten()
                    .unwrap_or(session);

                let meta_event = json!({
                    "type": "session.meta.updated",
                    "sessionId": session_id,
                    "title": updated_session.title,
                    "patch": body,
                });
                self.hub
                    .bus_for(session_id)
                    .publish(&crate::events::EngineEvent::Custom(meta_event));

                // The profile write may have changed model / thinking /
                // permission mode / plan mode; refresh the status fact the
                // Web client's status bar folds. The dedup inside the engine
                // keeps an unchanged payload silent.
                if let Some(engine) = self.engine.as_ref() {
                    engine.publish_status_updated(session_id).await;
                }

                let wire_session =
                    format_wire_session(&updated_session, &self.store, self.engine.as_ref());

                // v2 `POST /sessions/{session_id}/profile` answers the bare
                // updated session (`success: { data: sessionSchema }`, and the
                // handler does `reply.send(okEnvelope(session, …))`,
                // kap-server/src/routes/sessions.ts:497-529) — the same document
                // the GET variant serves, taken from the wire session so
                // `agent_config.model` is always populated.
                HttpResponse::ok(&wire_session)
            }
            ("POST", p) if extract_session_fs_action(p).is_some() => {
                let (session_id, action) = extract_session_fs_action(p).unwrap();
                let work_dir = match fs_routes::resolve_session_workdir(&self.store, session_id) {
                    Some(d) => d,
                    None => return HttpResponse::not_found(),
                };
                // An empty body is legitimate (`git_status` takes no arguments);
                // only an unparsable one is a client error.
                let body: Value = if req.body.iter().all(|b| b.is_ascii_whitespace()) {
                    json!({})
                } else {
                    match serde_json::from_slice(&req.body) {
                        Ok(v) => v,
                        Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                    }
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
                    "open-in" | "openIn" => fs_routes::handle_open_in(&work_dir, &body),
                    "open-in-apps" | "openInApps" => fs_routes::handle_open_in_apps(&body),
                    _ => HttpResponse::bad_request(format!(
                        "Unsupported filesystem action: {action}"
                    )),
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
                let rel_path = file_path_raw
                    .strip_suffix(":download")
                    .unwrap_or(file_path_raw);
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
                    || p == "/api/v1/workspace/fs:search"
                    || p == "/workspace/fs:search"
                    || p == "/api/v1/fs::suggest"
                    || p == "/fs::suggest"
                    || p == "/api/v1/fs:suggest"
                    || p == "/fs:suggest"
                    // v2 spells these `/workspace/fs::search` and
                    // `/workspace/fs::suggest` (double colon,
                    // kap-server/src/routes/fs.ts:414,460); the official Web
                    // bundle calls both with a *single* colon. The `::search`
                    // sibling already accepted both spellings here, so `suggest`
                    // now matches it — otherwise every file-mention request paid
                    // a 404 round-trip before the client's fallback to search.
                    || p == "/api/v1/workspace/fs::suggest"
                    || p == "/workspace/fs::suggest"
                    || p == "/api/v1/workspace/fs:suggest"
                    || p == "/workspace/fs:suggest" =>
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
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let work_dir = fs_routes::resolve_session_workdir(&self.store, session_id)
                    .unwrap_or_else(|| {
                        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                    });
                let cwd_str = body
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|c| work_dir.join(c).to_string_lossy().to_string())
                    .unwrap_or_else(|| work_dir.to_string_lossy().to_string());
                let shell_opt = body.get("shell").and_then(|v| v.as_str());
                let cols_opt = match terminal_dimension(body.get("cols"), "cols") {
                    Ok(value) => value,
                    Err(e) => return HttpResponse::bad_request(e),
                };
                let rows_opt = match terminal_dimension(body.get("rows"), "rows") {
                    Ok(value) => value,
                    Err(e) => return HttpResponse::bad_request(e),
                };

                match self
                    .terminal_manager
                    .create(session_id, &cwd_str, shell_opt, cols_opt, rows_opt)
                    .await
                {
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
                let session_id = parts[0]
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
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
                let session_id = parts[0]
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail
                    .strip_suffix(":close")
                    .or_else(|| tail.strip_suffix("/close"))
                    .unwrap_or(tail);
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
                let session_id = parts[0]
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail
                    .strip_suffix(":write")
                    .or_else(|| tail.strip_suffix("/write"))
                    .unwrap_or(tail);
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let data = match body.get("data").and_then(|v| v.as_str()) {
                    Some(data) => data,
                    None => {
                        return HttpResponse::bad_request("Field 'data' must be a string");
                    }
                };
                match self
                    .terminal_manager
                    .write(session_id, terminal_id, data.as_bytes())
                    .await
                {
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
                let session_id = parts[0]
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail
                    .strip_suffix(":resize")
                    .or_else(|| tail.strip_suffix("/resize"))
                    .unwrap_or(tail);
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let cols = match terminal_dimension(body.get("cols"), "cols") {
                    Ok(Some(cols)) => cols,
                    Ok(None) => 80,
                    Err(e) => return HttpResponse::bad_request(e),
                };
                let rows = match terminal_dimension(body.get("rows"), "rows") {
                    Ok(Some(rows)) => rows,
                    Ok(None) => 24,
                    Err(e) => return HttpResponse::bad_request(e),
                };
                match self
                    .terminal_manager
                    .resize(session_id, terminal_id, cols, rows)
                    .await
                {
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
                let session_id = parts[0]
                    .strip_prefix("/api/v1/sessions/")
                    .unwrap_or_default();
                let tail = parts[1];
                let terminal_id = tail.strip_suffix("/output").unwrap_or(tail);
                let since_seq = req
                    .query_param("since_seq")
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0);
                match self
                    .terminal_manager
                    .output(session_id, terminal_id, since_seq)
                    .await
                {
                    Ok((output, last_seq)) => {
                        // `last_seq` is the absolute sequence of the newest
                        // buffered frame (`total` is the same value: the total
                        // number of frames the terminal has produced). It used to
                        // report the buffer length, which stops matching the
                        // sequence numbers as soon as frames are evicted.
                        let count = output.len();
                        HttpResponse::ok(&json!({
                            "output": output,
                            "count": count,
                            "last_seq": last_seq,
                            "total": last_seq,
                        }))
                    }
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
            ("GET", p) if extract_session_action(p, "events").is_some() => {
                let session_id = extract_session_action(p, "events").unwrap();
                let exists = self.store.get_session(session_id).ok().flatten().is_some()
                    || self.hub.lane_exists(session_id);
                if !exists {
                    return HttpResponse::not_found();
                }
                let since = req
                    .query_param("since")
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let limit = req
                    .query_param("limit")
                    .and_then(|l| l.parse::<usize>().ok())
                    .unwrap_or(100)
                    .min(1000);

                match self.store.get_wire_events(session_id, since, limit) {
                    Ok(events) => {
                        let total = self
                            .store
                            .count_wire_events(session_id)
                            .unwrap_or(events.len());
                        let latest_seq = self.store.latest_wire_event_seq(session_id).unwrap_or(0);
                        HttpResponse::ok(&json!({
                            "sessionId": session_id,
                            "events": events,
                            "total": total,
                            "latestSeq": latest_seq,
                        }))
                    }
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if extract_session_action(p, "projection").is_some() => {
                let session_id = extract_session_action(p, "projection").unwrap();
                let exists = self.store.get_session(session_id).ok().flatten().is_some()
                    || self.hub.lane_exists(session_id);
                if !exists {
                    return HttpResponse::not_found();
                }
                match self.store.fold_projection(session_id) {
                    Ok(messages) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "messages": messages,
                    })),
                    Err(e) => HttpResponse::internal_error(format!("Projection error: {e}")),
                }
            }

            ("GET", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.strip_prefix("/api/v1/sessions/")
                        .is_some_and(|rest| !rest.contains('/'))
                    && !p.ends_with("/prompt") =>
            {
                let session_id = p.strip_prefix("/api/v1/sessions/").unwrap_or_default();
                if session_id.is_empty() || session_id.contains('/') || session_id.contains(':') {
                    return HttpResponse::not_found();
                }
                match self.store.get_session(session_id) {
                    Ok(Some(session)) => {
                        // v2 `GET /sessions/{session_id}` answers the session
                        // document itself (`toWireSession` → `sessionSchema`,
                        // kap-server/src/routes/sessions.ts:1024), wrapped only
                        // in the standard envelope — messages live on their own
                        // `/messages` route. Serving the document bare is what
                        // lets a client map the response directly.
                        let wire_session =
                            format_wire_session(&session, &self.store, self.engine.as_ref());
                        HttpResponse::ok(&wire_session)
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
                let workspace_id = self
                    .store
                    .get_session(session_id)
                    .ok()
                    .flatten()
                    .map(|s| s.workspace_id);
                match self.store.delete_session(session_id) {
                    Ok(true) => {
                        self.interaction_manager.cancel_session(session_id);
                        // v2 `sessionExternalHooksService.triggerSessionEnd`:
                        // deleting the session archives it —the close
                        // reason is `archive` (REPL exit is `exit`).
                        // Observational: the deletion proceeds regardless.
                        let guard = crate::tools::external_hooks::HookGuard::new(
                            self.config().await.hooks.clone(),
                        );
                        guard
                            .notify_session_lifecycle(
                                "SessionEnd",
                                "archive",
                                json!({ "reason": "archive", "session_title": "" }),
                            )
                            .await;
                        let del_event = json!({
                            "type": "event.session.deleted",
                            "sessionId": session_id,
                            "workspaceId": workspace_id,
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
            ("POST", p)
                if extract_session_action(p, "events:compact").is_some()
                    || extract_session_action(p, "events/compact").is_some() =>
            {
                let session_id = extract_session_action(p, "events:compact")
                    .or_else(|| extract_session_action(p, "events/compact"))
                    .unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let body: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
                let summary = body
                    .get("summary")
                    .and_then(|s| s.as_str())
                    .unwrap_or("Context compaction boundary");
                match self.store.checkpoint_compress(session_id, summary) {
                    Ok(()) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "compacted": true,
                        "summary": summary
                    })),
                    Err(e) => HttpResponse::internal_error(format!("Compaction error: {e}")),
                }
            }
            ("POST", p)
                if extract_session_action(p, "events:undo").is_some()
                    || extract_session_action(p, "events/undo").is_some() =>
            {
                let session_id = extract_session_action(p, "events:undo")
                    .or_else(|| extract_session_action(p, "events/undo"))
                    .unwrap();
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                match self.store.undo_to_last_checkpoint(session_id) {
                    Ok(count) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "undone": true,
                        "deletedEvents": count
                    })),
                    Err(crate::native::event_store::EventStoreError::UndoCompactionBoundary) => {
                        HttpResponse::bad_request("Cannot undo across compaction boundary")
                    }
                    Err(crate::native::event_store::EventStoreError::CheckpointNotFound) => {
                        HttpResponse::bad_request("No checkpoint found to undo to")
                    }
                    Err(e) => HttpResponse::internal_error(format!("Undo error: {e}")),
                }
            }
            ("PATCH", p) if p.starts_with("/api/v1/sessions/") && !p.ends_with("/prompt") => {
                let session_id = p.strip_prefix("/api/v1/sessions/").unwrap_or_default();
                if session_id.is_empty() || session_id.contains('/') || session_id.contains(':') {
                    return HttpResponse::not_found();
                }
                self.handle_session_patch(session_id, &req.body)
            }
            ("POST", p) if extract_session_action(p, "patch").is_some() => {
                let session_id = extract_session_action(p, "patch").unwrap();
                self.handle_session_patch(session_id, &req.body)
            }
            ("POST", p)
                if extract_session_action(p, "patch:undo").is_some()
                    || extract_session_action(p, "undo_patch").is_some() =>
            {
                let session_id = extract_session_action(p, "patch:undo")
                    .or_else(|| extract_session_action(p, "undo_patch"))
                    .unwrap();
                self.handle_session_patch_undo(session_id)
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

                        // v2 `sessionExternalHooksService.triggerSessionStart`:
                        // SessionStart hooks fire on creation (source
                        // `startup`; the fork route never triggers one
                        // upstream). Observational only.
                        let guard = crate::tools::external_hooks::HookGuard::new(
                            self.config().await.hooks.clone(),
                        );
                        guard
                            .notify_session_lifecycle(
                                "SessionStart",
                                "startup",
                                json!({
                                    "source": "startup",
                                    "session_title": title.unwrap_or(""),
                                }),
                            )
                            .await;

                        // v2 answers the created session as the bare
                        // `sessionSchema` with no `statusCode` override
                        // (kap-server/src/routes/sessions.ts:181-184), so this is
                        // HTTP 200 and the document itself — not 201, and not a
                        // `{sessionId}` stub.
                        HttpResponse::ok(&session_val)
                    }
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/prompts") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let (active, queued) = self.prompt_queue.snapshot(session_id);
                HttpResponse::ok(&json!({ "active": active, "queued": queued }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/prompts:steer") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(value) => value,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                // Contract shape: `{ prompt_ids: [...] }`. A legacy `{ prompt }`
                // string steers one fresh message without a queued record.
                let ids: Vec<String> = body
                    .get("prompt_ids")
                    .and_then(|value| value.as_array())
                    .map(|ids| {
                        ids.iter()
                            .filter_map(|id| id.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                if ids.is_empty() {
                    let prompt = body
                        .get("prompt")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if prompt.is_empty() {
                        return HttpResponse::bad_request("prompt_ids must not be empty");
                    }
                    let Some(engine) = self.engine.as_ref() else {
                        return HttpResponse::json(
                            503,
                            &json!({ "error": "no engine configured for this server" }),
                        );
                    };
                    let steered_id = format!("prompt-{}", fastrand::u64(..));
                    let accepted = engine.enqueue_steer(
                        session_id,
                        crate::turn_loop::types::LLMMessage::user(prompt),
                    );
                    return if accepted {
                        HttpResponse::ok(&json!({ "steered": true, "prompt_ids": [steered_id] }))
                    } else {
                        HttpResponse::json(
                            404,
                            &json!({
                                "code": crate::server::envelope::error_codes::PROMPT_NOT_FOUND,
                                "msg": "no active turn to steer",
                            }),
                        )
                    };
                }
                if !ids
                    .iter()
                    .all(|id| self.prompt_queue.contains(session_id, id))
                {
                    return HttpResponse::json(
                        404,
                        &json!({
                            "code": crate::server::envelope::error_codes::PROMPT_NOT_FOUND,
                            "msg": "no queued prompt with the requested id",
                        }),
                    );
                }
                let Some(engine) = self.engine.as_ref() else {
                    return HttpResponse::json(
                        503,
                        &json!({ "error": "no engine configured for this server" }),
                    );
                };
                let mut steered_items: Vec<Value> = Vec::new();
                let mut unsteered = Vec::new();
                for (item, prompt, blocks, origin) in
                    self.prompt_queue.take_queued(session_id, &ids)
                {
                    // v2 #3906: the steered message reuses the queued prompt's
                    // id (`children[0].waiter.id`), so the projection keeps it
                    // inside the host turn and undo targets the host prompt.
                    let prompt_id = item["prompt_id"].as_str().map(str::to_string);
                    let message = crate::turn_loop::types::LLMMessage {
                        role: "user".to_string(),
                        content: prompt.clone(),
                        blocks: blocks.clone(),
                        tool_calls: Vec::new(),
                        tool_call_id: None,
                        prompt_id,
                        origin: None,
                    };
                    if engine.enqueue_steer(session_id, message) {
                        // v2 `turnSteerSchema` (turnOps.ts:51): the fold
                        // pairs the steer to its turn and prompt ids; the
                        // payload keeps the envelope fields the Rust hub
                        // adds, which the interface does not declare.
                        let steer_prompt_id =
                            item["prompt_id"].as_str().unwrap_or_default().to_string();
                        let mut steer = json!({
                            "type": "turn.steer",
                            "agentId": "main",
                            "sessionId": session_id,
                            "input": item.get("content").cloned().unwrap_or_else(|| json!([])),
                            "origin": origin.clone()
                                .unwrap_or_else(|| json!({ "kind": "user" })),
                            "promptIds": [steer_prompt_id],
                            "messageId": steer_prompt_id,
                        });
                        if let Some(turn) = self.prompt_queue.active_turn_number(session_id) {
                            steer["turnId"] = json!(turn);
                        }
                        crate::server::prompt_queue::publish_prompt_event(
                            &self.hub, session_id, steer,
                        );
                        steered_items.push(item);
                    } else {
                        unsteered.push((item, prompt, blocks, origin));
                    }
                }
                if !steered_items.is_empty() {
                    let active_prompt_id = self
                        .prompt_queue
                        .active_item(session_id)
                        .and_then(|item| item["prompt_id"].as_str().map(str::to_string))
                        .unwrap_or_default();
                    let prompt_ids: Vec<String> = steered_items
                        .iter()
                        .map(|item| item["prompt_id"].as_str().unwrap_or_default().to_string())
                        .collect();
                    // Each item's `content` is itself a part array; flat-map
                    // so the steered event carries one flat part list.
                    let content: Vec<Value> = steered_items
                        .iter()
                        .flat_map(|item| {
                            item.get("content")
                                .and_then(|value| value.as_array())
                                .cloned()
                                .unwrap_or_default()
                        })
                        .collect();
                    crate::server::prompt_queue::publish_prompt_event(
                        &self.hub,
                        session_id,
                        json!({
                            "type": "prompt.steered",
                            "agentId": "main",
                            "sessionId": session_id,
                            "activePromptId": active_prompt_id,
                            "promptIds": prompt_ids,
                            "content": content,
                            "steeredAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                }
                // A steer that found no running turn must not drop the prompt:
                // run it (or queue behind whatever is actually active).
                for (item, prompt, blocks, origin) in unsteered {
                    self.run_or_queue_prompt(engine, session_id, item, prompt, blocks, origin);
                }
                HttpResponse::ok(&json!({ "steered": true, "prompt_ids": ids }))
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/prompts/")
                    && p.ends_with(":steer") =>
            {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 7 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let prompt_id = segments[6].trim_end_matches(":steer").to_string();
                let Some(engine) = self.engine.as_ref() else {
                    return HttpResponse::json(
                        503,
                        &json!({ "error": "no engine configured for this server" }),
                    );
                };
                if !self.prompt_queue.contains(session_id, &prompt_id) {
                    return HttpResponse::json(
                        404,
                        &json!({
                            "code": crate::server::envelope::error_codes::PROMPT_NOT_FOUND,
                            "msg": "no prompt with the requested id",
                        }),
                    );
                }
                let active_prompt_id = self
                    .prompt_queue
                    .active_item(session_id)
                    .and_then(|item| item["prompt_id"].as_str().map(str::to_string))
                    .unwrap_or_default();
                let mut unsteered = Vec::new();
                for (item, prompt, blocks, origin) in self
                    .prompt_queue
                    .take_queued(session_id, std::slice::from_ref(&prompt_id))
                {
                    let message = crate::turn_loop::types::LLMMessage {
                        role: "user".to_string(),
                        content: prompt.clone(),
                        blocks: blocks.clone(),
                        tool_calls: Vec::new(),
                        tool_call_id: None,

                        prompt_id: Some(prompt_id.clone()),
                        origin: None,
                    };
                    if engine.enqueue_steer(session_id, message) {
                        // v2 `turnSteerSchema` (turnOps.ts:51); see the
                        // `prompt_ids` route's emission above.
                        let mut steer = json!({
                            "type": "turn.steer",
                            "agentId": "main",
                            "sessionId": session_id,
                            "input": item.get("content").cloned().unwrap_or_else(|| json!([])),
                            "origin": origin.clone()
                                .unwrap_or_else(|| json!({ "kind": "user" })),
                            "promptIds": [prompt_id],
                            "messageId": prompt_id,
                        });
                        if let Some(turn) = self.prompt_queue.active_turn_number(session_id) {
                            steer["turnId"] = json!(turn);
                        }
                        crate::server::prompt_queue::publish_prompt_event(
                            &self.hub, session_id, steer,
                        );
                        crate::server::prompt_queue::publish_prompt_event(
                            &self.hub,
                            session_id,
                            json!({
                                "type": "prompt.steered",
                                "agentId": "main",
                                "sessionId": session_id,
                                "activePromptId": active_prompt_id,
                                "promptIds": [prompt_id],
                                "content": item.get("content").cloned()
                                    .unwrap_or_else(|| json!([])),
                                "steeredAt": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                    } else {
                        unsteered.push((item, prompt, blocks, origin));
                    }
                }
                for (item, prompt, blocks, origin) in unsteered {
                    self.run_or_queue_prompt(engine, session_id, item, prompt, blocks, origin);
                }
                HttpResponse::ok(&json!({ "steered": true, "prompt_ids": [prompt_id] }))
            }
            ("POST", p)
                if p.starts_with("/api/v1/sessions/")
                    && p.contains("/prompts/")
                    && p.ends_with(":abort") =>
            {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 7 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let prompt_id = segments[6].trim_end_matches(":abort");
                // v2's `cancelWaiter` (loopService.ts:735-750): a queued prompt
                // is removed from the queue so the driver never promotes it,
                // and the active prompt's turn is cancelled. Either way the
                // item is settled exactly once — the `prompt.aborted` below is
                // its only terminal event, so the driver publishes no
                // `prompt.completed` on top of it.
                //
                // The web UI's abort button sends the live
                // `event.message.created` id (`msg-u{turn}`), which names the
                // turn's user message rather than the prompt; resolving it
                // here is what keeps the button working (ROADMAP §7.6).
                let Some((prompt_id, outcome)) = self
                    .prompt_queue
                    .cancel(session_id, prompt_id)
                    .map(|outcome| (prompt_id.to_string(), outcome))
                    .or_else(|| {
                        self.prompt_queue
                            .cancel_by_user_message_id(session_id, prompt_id)
                    })
                else {
                    // An unknown / already-settled prompt is not in the queue,
                    // so the abort has no target: report it as a missing
                    // prompt rather than a false success.
                    return HttpResponse::json(
                        404,
                        &json!({
                            "code": crate::server::envelope::error_codes::PROMPT_NOT_FOUND,
                            "msg": "no prompt with the requested id",
                        }),
                    );
                };
                if matches!(outcome, crate::server::prompt_queue::CancelOutcome::Active)
                    && let Some(engine) = self.engine.as_ref()
                {
                    engine.cancel_turn(session_id);
                }
                crate::server::prompt_queue::publish_prompt_event(
                    &self.hub,
                    session_id,
                    json!({
                        "type": "prompt.aborted",
                        "agentId": "main",
                        "sessionId": session_id,
                        "promptId": prompt_id,
                        "abortedAt": chrono::Utc::now().to_rfc3339(),
                    }),
                );
                HttpResponse::ok(&json!({ "aborted": true }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/prompts") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(value) => value,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                self.submit_session_prompt(segments[4], body).await
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

                // The synchronous single-prompt route refuses to start a second
                // concurrent turn; queued prompts go through `/prompts`.
                if self.prompt_queue.active_item(session_id).is_some() || engine.is_busy(session_id)
                {
                    return HttpResponse::json(
                        409,
                        &json!({
                            "code": crate::server::envelope::error_codes::SESSION_BUSY,
                            "msg": "session is already running a turn",
                        }),
                    );
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

    fn handle_session_patch(&self, session_id: &str, body_bytes: &[u8]) -> HttpResponse {
        let Some(session) = self.store.get_session(session_id).ok().flatten() else {
            return HttpResponse::not_found();
        };
        let body: Value = match serde_json::from_slice(body_bytes) {
            Ok(v) => v,
            Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
        };

        let mut current_wire = format_wire_session(&session, &self.store, self.engine.as_ref());

        let patch_set = if let Ok(ps) =
            serde_json::from_value::<crate::session::patch::JsonPatchSet>(body.clone())
        {
            ps
        } else if let Some(arr) = body.as_array() {
            match serde_json::from_value::<Vec<crate::session::patch::PatchOp>>(Value::Array(
                arr.clone(),
            )) {
                Ok(ops) => crate::session::patch::JsonPatchSet::new(ops),
                Err(e) => {
                    return HttpResponse::bad_request(format!(
                        "Invalid RFC 6902 patch operations: {e}"
                    ));
                }
            }
        } else if let Some(ops_val) = body.get("ops").or_else(|| body.get("patch")) {
            match serde_json::from_value::<Vec<crate::session::patch::PatchOp>>(ops_val.clone()) {
                Ok(ops) => crate::session::patch::JsonPatchSet::new(ops),
                Err(e) => {
                    return HttpResponse::bad_request(format!(
                        "Invalid patch operations in ops field: {e}"
                    ));
                }
            }
        } else if body.is_object() {
            let mut target = current_wire.clone();
            if let Some(target_obj) = target.as_object_mut() {
                for (k, v) in body.as_object().unwrap() {
                    if k == "metadata" && v.is_object() {
                        if let Some(meta_obj) = target_obj
                            .get_mut("metadata")
                            .and_then(|m| m.as_object_mut())
                        {
                            for (mk, mv) in v.as_object().unwrap() {
                                meta_obj.insert(mk.clone(), mv.clone());
                            }
                        } else {
                            target_obj.insert(k.clone(), v.clone());
                        }
                    } else {
                        target_obj.insert(k.clone(), v.clone());
                    }
                }
            }
            crate::session::patch::diff_values(&current_wire, &target)
        } else {
            return HttpResponse::bad_request(
                "Invalid patch payload: expected RFC 6902 array or object",
            );
        };

        let inverse_patch = match crate::session::patch::apply_patch(&mut current_wire, &patch_set)
        {
            Ok(inv) => inv,
            Err(e) => return HttpResponse::bad_request(format!("Failed to apply patch: {e}")),
        };

        // Persist the patched fields. A dropped write must not be reported as a
        // successful patch: the client would keep a state the store never took,
        // and the inverse patch (the only way back) would be gone with it.
        let mut persist_failures: Vec<String> = Vec::new();
        if let Some(new_title) = current_wire.get("title").and_then(|t| t.as_str())
            && session.title.as_deref() != Some(new_title)
            && let Err(e) = self.store.update_session_title(session_id, Some(new_title))
        {
            persist_failures.push(format!("session title: {e}"));
        }
        if let Some(new_meta) = current_wire.get("metadata")
            && let Err(e) = self
                .store
                .put_session_state("metadata", session_id, session_id, new_meta)
        {
            persist_failures.push(format!("session metadata: {e}"));
        }
        if let Some(new_cfg) = current_wire.get("agent_config")
            && let Err(e) =
                self.store
                    .put_session_state("agent_config", session_id, session_id, new_cfg)
        {
            persist_failures.push(format!("agent config: {e}"));
        }

        let checkpoint_id = format!("patch-{}", fastrand::u64(..));
        if let Err(e) = self.store.save_checkpoint(
            session_id,
            &checkpoint_id,
            "session_patch",
            &json!({
                "patch": patch_set,
                "inverse": inverse_patch,
            }),
        ) {
            persist_failures.push(format!("patch checkpoint: {e}"));
        }

        if !persist_failures.is_empty() {
            // Nothing is published: no client should observe a state that the
            // store does not hold.
            return HttpResponse::internal_error(format!(
                "Session patch could not be persisted ({}). The stored session does not match the requested patch.",
                persist_failures.join("; ")
            ));
        }

        let updated_event = json!({
            "type": "event.session.updated",
            "sessionId": session_id,
            "patch": patch_set,
            "inverse": inverse_patch,
        });
        self.hub
            .bus_for("global")
            .publish(&crate::events::EngineEvent::Custom(updated_event));

        HttpResponse::ok(&json!({
            "session": current_wire,
            "applied_patch": patch_set,
            "undo_patch": inverse_patch,
        }))
    }

    fn handle_session_patch_undo(&self, session_id: &str) -> HttpResponse {
        let Some(session) = self.store.get_session(session_id).ok().flatten() else {
            return HttpResponse::not_found();
        };
        let Some(checkpoint_data) = self
            .store
            .get_latest_checkpoint(session_id, "session_patch")
            .ok()
            .flatten()
        else {
            return HttpResponse::bad_request("No patch checkpoint available to undo");
        };
        let Some(inverse_val) = checkpoint_data.get("inverse") else {
            return HttpResponse::bad_request("Invalid checkpoint: missing inverse patch");
        };
        let inverse_set: crate::session::patch::JsonPatchSet =
            match serde_json::from_value(inverse_val.clone()) {
                Ok(s) => s,
                Err(e) => {
                    return HttpResponse::internal_error(format!(
                        "Failed to parse inverse patch: {e}"
                    ));
                }
            };

        let mut current_wire = format_wire_session(&session, &self.store, self.engine.as_ref());
        let redo_patch = match crate::session::patch::apply_patch(&mut current_wire, &inverse_set) {
            Ok(p) => p,
            Err(e) => return HttpResponse::bad_request(format!("Failed to revert patch: {e}")),
        };

        // Same contract as the forward patch: never report an undo whose
        // restored state was not actually stored.
        let mut persist_failures: Vec<String> = Vec::new();
        if let Some(new_title) = current_wire.get("title").and_then(|t| t.as_str())
            && let Err(e) = self.store.update_session_title(session_id, Some(new_title))
        {
            persist_failures.push(format!("session title: {e}"));
        }
        if let Some(new_meta) = current_wire.get("metadata")
            && let Err(e) = self
                .store
                .put_session_state("metadata", session_id, session_id, new_meta)
        {
            persist_failures.push(format!("session metadata: {e}"));
        }
        if let Some(new_cfg) = current_wire.get("agent_config")
            && let Err(e) =
                self.store
                    .put_session_state("agent_config", session_id, session_id, new_cfg)
        {
            persist_failures.push(format!("agent config: {e}"));
        }
        if !persist_failures.is_empty() {
            return HttpResponse::internal_error(format!(
                "The patch undo could not be persisted ({}). The stored session does not match the returned state.",
                persist_failures.join("; ")
            ));
        }

        let updated_event = json!({
            "type": "event.session.updated",
            "sessionId": session_id,
            "patch": inverse_set,
            "inverse": redo_patch,
        });
        self.hub
            .bus_for("global")
            .publish(&crate::events::EngineEvent::Custom(updated_event));

        HttpResponse::ok(&json!({
            "session": current_wire,
            "applied_patch": inverse_set,
            "redo_patch": redo_patch,
        }))
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

    /// v2 #3832: a metadata object that names its own variant is a prompt
    /// origin (the transcript contract's shape), not opaque client metadata —
    /// the v3 projection reads the `skill_activation` variant off the turn
    /// origin for the opening user message's `skill_activations`.
    #[test]
    fn prompt_origin_from_metadata_distinguishes_origin_variants() {
        let opaque = prompt_origin_from_metadata(Some(&json!([{ "surface": "web" }]))).unwrap();
        assert_eq!(opaque["kind"], "user");
        assert_eq!(opaque["clientMetadata"][0]["surface"], "web");

        let activation = prompt_origin_from_metadata(Some(&json!([{
            "origin": {
                "kind": "skill_activation",
                "trigger": "user-slash",
                "skillName": "review",
                "skillArgs": "src/main.rs",
            },
        }])))
        .unwrap();
        assert_eq!(activation["kind"], "skill_activation");
        assert_eq!(activation["skillName"], "review");
        assert_eq!(activation["skillArgs"], "src/main.rs");
        assert!(
            activation.get("clientMetadata").is_none(),
            "an origin variant is not re-wrapped as client metadata"
        );

        assert!(prompt_origin_from_metadata(None).is_none());
    }

    #[tokio::test]
    async fn test_turn_origin_persists_and_projects() {
        // #3764: the origin the route builds from the request's `metadata`
        // lands in the turns table and comes back through list_turns, so the
        // v3 projection can carry it instead of assuming `user`.
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-origin", Some("origin")).unwrap();
        let origin = json!({
            "kind": "user",
            "clientMetadata": [{ "surface": "web", "threadId": "abc" }],
        });
        store
            .save_turn(
                "sess-origin",
                "turn-1",
                1,
                &[crate::turn_loop::types::LLMMessage::user("hello")],
                None,
                Some(&origin),
            )
            .unwrap();
        let turns = store.list_turns("sess-origin").unwrap();
        assert_eq!(turns.len(), 1);
        let saved = turns[0].origin.as_ref().unwrap();
        assert_eq!(saved["kind"], "user");
        assert_eq!(saved["clientMetadata"][0]["threadId"], "abc");

        // A turn saved without an origin reads back as None (pre-#3764 rows).
        store
            .save_turn(
                "sess-origin",
                "turn-2",
                2,
                &[crate::turn_loop::types::LLMMessage::user("second")],
                None,
                None,
            )
            .unwrap();
        let turns = store.list_turns("sess-origin").unwrap();
        assert_eq!(turns.len(), 2);
        assert!(turns[1].origin.is_none());
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
        // v2 answers the bare `sessionSchema` (no `statusCode` override).
        assert_eq!(res_create.status, 200);
        let val_create: Value = serde_json::from_slice(&res_create.body).unwrap();
        let sid = val_create["id"].as_str().unwrap();

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
        // v2 answers the bare `sessionSchema` (`toWireSession`), not a wrapper.
        assert_eq!(val_get["session_id"], sid);
        assert_eq!(val_get["title"], "Web REST Test");

        // 4b. Create child session
        let req_child = HttpRequest {
            method: "POST".into(),
            path: format!("/api/v1/sessions/{sid}/children"),
            query: None,
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({ "title": "Child Session" })).unwrap(),
        };
        let res_child = server.handle_request(&req_child).await;
        assert_eq!(res_child.status, 200);
        let val_child: Value = serde_json::from_slice(&res_child.body).unwrap();
        assert_eq!(val_child["parent_session_id"], sid);
        assert_eq!(val_child["title"], "Child Session");

        // Verify child listed
        let req_children = HttpRequest {
            method: "GET".into(),
            path: format!("/api/v1/sessions/{sid}/children"),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_children = server.handle_request(&req_children).await;
        assert_eq!(res_children.status, 200);
        let val_children: Value = serde_json::from_slice(&res_children.body).unwrap();
        // v2 answers the paged `{items, has_more}` contract; the web client
        // reads `.items`.
        assert_eq!(val_children["items"].as_array().unwrap().len(), 1);
        assert_eq!(val_children["has_more"], false);

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

    /// The REST surface for remote control (#3594) is backed by a real runtime
    /// (`server/remote_control.rs`): enabling without the Kimi login credential
    /// is refused honestly (the relay WS upgrade would fail anyway), and the
    /// off state is reported as such — with a reason that says the runtime is
    /// not started, not that it does not exist. The `501` era is over — a start
    /// request with a credential would actually arm the runtime.
    #[tokio::test]
    async fn test_remote_control_reports_the_not_started_runtime() {
        let server = HttpServer::in_memory().unwrap();

        let req_get = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/remote-control".into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_get = server.handle_request(&req_get).await;
        assert_eq!(res_get.status, 200);
        let val_get: Value = serde_json::from_slice(&res_get.body).unwrap();
        assert_eq!(val_get["enabled"], false);
        assert_eq!(val_get["state"], "off");
        assert_eq!(val_get["available"], false);
        assert!(val_get["url"].is_null(), "no device URL may be advertised");
        assert!(
            val_get["reason"]
                .as_str()
                .unwrap()
                .contains("remote-control is not running"),
            "the response must explain that the runtime simply is not started: {val_get}"
        );

        // Enabling requires the Kimi login credential: without it the relay
        // WS upgrade would fail mid-handshake, so the honest answer is a 400
        // naming the missing field — not a fabricated `state: "on"`.
        let req_enable = HttpRequest {
            method: "POST".into(),
            path: "/api/v1/remote-control".into(),
            query: None,
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({ "enabled": true })).unwrap(),
        };
        let res_enable = server.handle_request(&req_enable).await;
        assert_eq!(res_enable.status, 400);
        let val_enable: Value = serde_json::from_slice(&res_enable.body).unwrap();
        assert!(
            val_enable["error"]
                .as_str()
                .unwrap_or_default()
                .contains("refresh_token"),
            "{val_enable}"
        );

        // A missing `enabled` field is still a client error.
        let req_missing = HttpRequest {
            method: "POST".into(),
            path: "/api/v1/remote-control".into(),
            query: None,
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({})).unwrap(),
        };
        assert_eq!(server.handle_request(&req_missing).await.status, 400);

        // GET is unchanged by the refused enable.
        let res_get2 = server.handle_request(&req_get).await;
        let val_get2: Value = serde_json::from_slice(&res_get2.body).unwrap();
        assert_eq!(val_get2["state"], "off");
        assert_eq!(val_get2["enabled"], false);

        // Disabling when nothing runs is an honest idempotent off.
        let req_disable = HttpRequest {
            method: "POST".into(),
            path: "/api/v1/remote-control".into(),
            query: None,
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({ "enabled": false })).unwrap(),
        };
        let res_disable = server.handle_request(&req_disable).await;
        assert_eq!(res_disable.status, 200);
        let val_disable: Value = serde_json::from_slice(&res_disable.body).unwrap();
        assert_eq!(val_disable["enabled"], false);
        assert_eq!(val_disable["state"], "off");
    }

    #[tokio::test]
    async fn test_session_delete_action_endpoint() {
        let server = HttpServer::in_memory().unwrap();
        let sid = "sess_del_action_test";
        server
            .store
            .create_session(sid, Some("Delete Action Test"))
            .unwrap();

        let req_del = HttpRequest {
            method: "POST".into(),
            path: format!("/api/v1/sessions/{sid}:delete"),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_del = server.handle_request(&req_del).await;
        assert_eq!(res_del.status, 200);
        let val_del: Value = serde_json::from_slice(&res_del.body).unwrap();
        assert_eq!(val_del["deleted"], true);

        let req_get = HttpRequest {
            method: "GET".into(),
            path: format!("/api/v1/sessions/{sid}"),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_get = server.handle_request(&req_get).await;
        assert_eq!(res_get.status, 404);
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
                extra_roots: Vec::new(),
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
                tower_enabled: false,
                tool_select: false,
                sandbox_mode: None,
                sandbox_policy: None,
                caller_agent_id: None,
                session_id: None,
                secondary_model: None,
                image_read_byte_budget: None,
                image_max_edge_px: None,
                model_capabilities: None,
                skill_dirs: Vec::new(),
                background: crate::storage::BackgroundLimits::default(),
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
            body["id"].as_str().unwrap().to_string()
        };

        let hub = server.hub();
        let store = server.store_arc();
        let server = server.with_engine(engine_without_a_model(store, hub));

        // No providers and no native_llm: the pipeline refuses to build, which
        // must surface as a server error naming the cause —not a fake 200.
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
        let sid = serde_json::from_slice::<Value>(&created.body).unwrap()["id"]
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
        // v2 `pageResponseSchema(taskSchema)`: `{items}` with protocol-named
        // elements (`id`), not the legacy camelCase `taskId`.
        let tasks = val_list["items"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["id"], "task-1");
        assert_eq!(tasks[0]["taskId"], "task-1", "the legacy key survives too");

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
        assert_eq!(val_get["id"], "task-1");

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

        // 5. Create a session for session-scoped task routes
        server.store.create_session("sess-task", None).unwrap();
        runner
            .spawn_task("task-cancel".into(), "cancel task".into(), async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                "ok".into()
            })
            .unwrap();

        // 6. Cancel task: POST /api/v1/sessions/sess-task/tasks/task-cancel:cancel
        let res_cancel = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-task/tasks/task-cancel:cancel".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cancel.status, 200);
        let val_cancel: Value = serde_json::from_slice(&res_cancel.body).unwrap();
        assert_eq!(val_cancel["cancelled"], true);

        // 7. Detach task: POST /api/v1/sessions/sess-task/tasks/task-cancel:detach
        let res_detach = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-task/tasks/task-cancel:detach".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_detach.status, 200);
        let val_detach: Value = serde_json::from_slice(&res_detach.body).unwrap();
        assert_eq!(val_detach["detached"], false);
    }

    /// #3717 late-settle silence, server wiring: the session row is the
    /// liveness source, so a task attributed to a deleted session settles
    /// without firing either terminal vocabulary, while a live session's
    /// task still announces on its lane and queues its notification.
    #[tokio::test]
    async fn late_settle_for_a_deleted_session_stays_silent() {
        let server = HttpServer::in_memory().unwrap();
        server.store.create_session("sess-live", None).unwrap();
        let runner = server.task_runner();

        let (created_live, terminated_live) = {
            let events: Arc<std::sync::Mutex<Vec<Value>>> =
                Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = events.clone();
            runner.set_event_sink(Arc::new(move |_session, event| {
                sink.lock().unwrap().push(event);
            }));
            runner
                .spawn_task_with_meta(
                    crate::storage::TaskSpawnMeta {
                        session_id: Some("sess-live"),
                        kind: "bash",
                        subagent_type: None,
                        agent_id: None,
                    },
                    "task-live".into(),
                    "job".into(),
                    async { "done".to_string() },
                )
                .unwrap();
            assert!(matches!(
                runner.wait("task-live", 2000).await,
                crate::storage::task_runner::TaskWaitResult::Completed(_)
            ));

            // The live session's completion went out and its notification
            // queued for the drain.
            let fired = |ty: &str| events.lock().unwrap().iter().any(|e| e["type"] == ty);
            (fired("event.task.completed"), {
                assert_eq!(runner.pending_notification_count(Some("sess-live")), 1);
                fired("background.task.terminated")
            })
        };
        assert!(created_live && terminated_live);

        // A session that no longer exists (row gone): settle stays silent.
        runner
            .spawn_task_with_meta(
                crate::storage::TaskSpawnMeta {
                    session_id: Some("sess-gone"),
                    kind: "bash",
                    subagent_type: None,
                    agent_id: None,
                },
                "task-gone".into(),
                "job".into(),
                async { "done".to_string() },
            )
            .unwrap();
        assert!(matches!(
            runner.wait("task-gone", 2000).await,
            crate::storage::task_runner::TaskWaitResult::Completed(_)
        ));
        // The entry still settled and stays queryable on the tasks surface.
        assert_eq!(runner.entry("task-gone").unwrap()["status"], "completed");
        assert_eq!(runner.pending_notification_count(Some("sess-gone")), 0);
        assert!(
            runner
                .take_pending_notifications(Some("sess-gone"))
                .is_empty()
        );
    }

    #[tokio::test]
    async fn shutdown_route_cancels_the_serve_token() {
        let server = HttpServer::in_memory().unwrap();
        let token = server.shutdown_token();
        assert!(!token.is_cancelled());

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/shutdown".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        assert!(
            token.is_cancelled(),
            "POST /shutdown must stop the accept loop"
        );
    }

    #[test]
    fn loopback_hosts_are_recognized_and_wildcards_are_not() {
        for host in ["127.0.0.1", "127.0.0.53", "localhost", "::1", "[::1]"] {
            assert!(is_loopback_host(host), "{host} is loopback");
        }
        for host in ["0.0.0.0", "::", "192.168.1.5", "kimi.internal", ""] {
            assert!(!is_loopback_host(host), "{host} is not loopback");
        }
    }

    #[tokio::test]
    async fn debug_routes_need_the_flag_and_a_loopback_bind() {
        let request = || HttpRequest {
            method: "GET".into(),
            path: "/api/v1/debug/channels".into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };

        // Off by default: the reflection surface is not a product route.
        let off = HttpServer::in_memory().unwrap();
        assert_eq!(off.handle_request(&request()).await.status, 404);

        // Asked for, on loopback: mounted.
        let on = HttpServer::in_memory().unwrap().with_debug_endpoints(true);
        assert_eq!(on.handle_request(&request()).await.status, 200);

        // Asked for, but reachable from the network: still not mounted.
        let remote = HttpServer::in_memory()
            .unwrap()
            .with_debug_endpoints(true)
            .with_bind_host("0.0.0.0");
        assert_eq!(remote.handle_request(&request()).await.status, 404);
    }

    #[tokio::test]
    async fn shutdown_is_unregistered_on_a_non_loopback_bind() {
        let request = || HttpRequest {
            method: "POST".into(),
            path: "/api/v1/shutdown".into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };

        let remote = HttpServer::in_memory().unwrap().with_bind_host("0.0.0.0");
        let token = remote.shutdown_token();
        assert_eq!(remote.handle_request(&request()).await.status, 404);
        assert!(!token.is_cancelled(), "a 404 must not stop the server");

        let opted_in = HttpServer::in_memory()
            .unwrap()
            .with_bind_host("0.0.0.0")
            .with_allow_remote_shutdown(true);
        let token = opted_in.shutdown_token();
        assert_eq!(opted_in.handle_request(&request()).await.status, 200);
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn a_host_outside_the_allowlist_is_refused_before_the_credential() {
        let server = HttpServer::in_memory()
            .unwrap()
            .with_host_guard(HostGuard::new(
                "127.0.0.1",
                vec!["kimi.example".to_string()],
            ));

        let with_host = |host: Option<&str>| {
            let mut headers = HashMap::new();
            if let Some(host) = host {
                headers.insert("host".to_string(), host.to_string());
            }
            HttpRequest {
                method: "GET".into(),
                path: "/api/v1/health".into(),
                query: None,
                headers,
                body: Vec::new(),
            }
        };

        // `/health` answers unauthenticated, so a 403 here can only come from
        // the host guard.
        assert_eq!(
            server
                .handle_request(&with_host(Some("127.0.0.1:58627")))
                .await
                .status,
            200
        );
        assert_eq!(
            server
                .handle_request(&with_host(Some("kimi.example")))
                .await
                .status,
            200
        );

        let refused = server
            .handle_request(&with_host(Some("evil.example")))
            .await;
        assert_eq!(refused.status, 403);
        let body = String::from_utf8_lossy(&refused.body);
        assert!(body.contains("--allowed-host"), "{body}");
        assert!(body.contains("KIMI_CODE_ALLOWED_HOSTS"), "{body}");

        // A missing `Host` is refused too: HTTP/1.1 requires it.
        assert_eq!(server.handle_request(&with_host(None)).await.status, 403);
    }

    #[tokio::test]
    async fn an_in_process_server_without_a_guard_ignores_the_host_header() {
        let server = HttpServer::in_memory().unwrap();
        let mut headers = HashMap::new();
        headers.insert("host".to_string(), "evil.example".to_string());
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/health".into(),
                query: None,
                headers,
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
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
        assert!(val_cfg["yolo"].is_boolean());
        assert!(val_cfg["plan_mode"].is_boolean());
        assert!(val_cfg["default_plan_mode"].is_boolean());
        assert!(val_cfg["telemetry"].is_boolean());
        assert!(val_cfg["model_catalog"].is_object());

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
        // Objects, not bare ids: the Web client filters on `supported`, so the
        // list has to carry the same element shape as the detail route.
        assert!(caps.iter().any(|c| c["id"] == "task_runner"));
        assert!(caps.iter().any(|c| c["id"] == "cron_scheduler"));
        assert!(caps.iter().any(|c| c["id"] == "gui_store"));
        assert!(
            caps.iter().all(|c| c["supported"] == true),
            "every built-in capability is compiled in"
        );

        // 6b. Capability detail route: a known id is `ready`, an unknown one is
        // a 404, and the install action honestly refuses (nothing to install).
        let res_cap_get = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/capabilities/bash".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cap_get.status, 200);
        let val_cap_get: Value = serde_json::from_slice(&res_cap_get.body).unwrap();
        assert_eq!(val_cap_get["id"], "bash");
        assert_eq!(val_cap_get["state"], "ready");
        assert_eq!(val_cap_get["supported"], true);

        let res_cap_missing = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/capabilities/no-such-capability".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cap_missing.status, 404);

        let res_cap_install = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/capabilities/bash:install".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cap_install.status, 400);

        // 6c. Region endpoint: resolves from env / marker / default.
        let res_region = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/oauth/region".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_region.status, 200);
        let val_region: Value = serde_json::from_slice(&res_region.body).unwrap();
        assert!(
            val_region["region"] == "mainland-cn" || val_region["region"] == "global",
            "{}",
            val_region["region"]
        );

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
        // v2 `forkSessionResponseSchema = sessionSchema`, answered 200 with the
        // new session's own document.
        assert_eq!(res_fork.status, 200);
        let val_fork: Value = serde_json::from_slice(&res_fork.body).unwrap();
        let new_sid = val_fork["id"].as_str().unwrap();
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
        assert!(
            val_btw_colon["agent_id"]
                .as_str()
                .unwrap()
                .starts_with("agent-btw-")
        );

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
        // The catalog routes project `config.toml`, so inject a deterministic
        // one instead of discovering the developer's config.
        let config: crate::config::KimiConfig = r#"
default_model = "kimi-latest"

[providers.kimi]
type = "openai"
api_key = "sk-test"
base_url = "https://example.test/v1"

[models.kimi-latest]
provider = "kimi"
model = "kimi-latest"
max_context_size = 262144

[models.fast]
provider = "kimi"
model = "k3-fast"
max_context_size = 128000
"#
        .parse()
        .unwrap();
        *server.config_override.lock().await = Some(config);

        // 1. Models catalog (config-driven, v2 `IModelCatalog.listModels`)
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
        let items = val_models["items"].as_array().unwrap();
        let model = items
            .iter()
            .find(|item| item["model"] == "kimi-latest")
            .unwrap();
        assert_eq!(model["provider"], "kimi");
        assert_eq!(model["display_name"], "kimi-latest");
        assert_eq!(model["max_context_size"], 262144);

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

        // 3. Providers listing (config-driven, credential state included)
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
        let providers = val_prov["items"].as_array().unwrap();
        let kimi = providers.iter().find(|item| item["id"] == "kimi").unwrap();
        assert_eq!(kimi["type"], "openai");
        assert_eq!(kimi["has_api_key"], true);
        assert_eq!(kimi["status"], "connected");
        assert_eq!(kimi["default_model"], "kimi-latest");
        let kimi_models = kimi["models"].as_array().unwrap();
        assert_eq!(kimi_models.len(), 2);
        assert!(kimi_models.contains(&json!("kimi-latest")));
        assert!(kimi_models.contains(&json!("fast")));

        // 3b. Auth readiness reflects the injected config.
        let res_auth = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/auth".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_auth.status, 200);
        let val_auth: Value = serde_json::from_slice(&res_auth.body).unwrap();
        assert_eq!(val_auth["models_ready"], true);
        assert_eq!(val_auth["providers_count"], 1);
        assert_eq!(val_auth["managed_provider"], Value::Null);

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
                path: "/api/v1/models/fast:set_default".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_set_default.status, 200);
        let val_set_def: Value = serde_json::from_slice(&res_set_default.body).unwrap();
        assert_eq!(val_set_def["model"], "fast");

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

    /// The full server path for an unconsumed steer (v2's semantics; the
    /// session path's session-scoped queue behaves the same): a prompt runs
    /// against a model endpoint that hangs mid-stream, a queued prompt is
    /// steered into the running turn, the turn is aborted before the steer is
    /// drained — the cancel check runs at the step top, ahead of
    /// `drain_steers` — and the next prompt's turn must carry the steered text
    /// exactly once. Before `release_turn_steer_state`, the steer died with the
    /// aborted turn and the text appeared nowhere.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_steer_survives_a_cancel_and_joins_the_next_turn_over_rest() {
        // A local OpenAI-compatible endpoint: the first request streams one
        // delta and then holds the connection (only a cancellation ends that
        // turn); every later request answers a complete turn.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let first_request = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mock = {
            let first_request = first_request.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        break;
                    };
                    let first_request = first_request.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 8192];
                        let _ = sock.read(&mut buf).await;
                        let hanging =
                            first_request.swap(false, std::sync::atomic::Ordering::SeqCst);
                        let body = if hanging {
                            "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n"
                                .to_string()
                        } else {
                            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
                             data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
                             data: [DONE]\n\n"
                                .to_string()
                        };
                        let head = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}"
                        );
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.flush().await;
                        if hanging {
                            // Hold the connection open: the turn only ends through cancellation.
                            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        }
                    });
                }
            })
        };

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let hub = Arc::new(EventHub::new());
        let engine = ServerEngine::new(
            crate::pipeline::PipelineSpec {
                system_prompt: "sys".into(),
                model_name: "mock-model".into(),
                providers: Vec::new(),
                native_llm: Some(crate::rpc::types::NativeLlmConfig {
                    protocol: "openai".into(),
                    base_url: format!("http://{addr}/v1"),
                    api_key: "test-key".into(),
                    model: "mock-model".into(),
                    ..Default::default()
                }),
                workspace_root: None,
                native_tools: false,
                extra_roots: Vec::new(),
                rust_self_contained: true,
                shell_path: None,
                policy_snapshot: None,
                github_token: None,
                github_base_url: None,
                subagent_timeout_ms: None,
                agent_tool_veto: None,
                tools_veto: None,
                todo_tool_veto: None,
                tower_worktree_root: None,
                tower_enabled: false,
                tool_select: false,
                sandbox_mode: None,
                sandbox_policy: None,
                caller_agent_id: None,
                session_id: None,
                secondary_model: None,
                image_read_byte_budget: None,
                image_max_edge_px: None,
                model_capabilities: None,
                skill_dirs: Vec::new(),
                background: crate::storage::BackgroundLimits::default(),
            },
            hub.clone(),
            store.clone(),
        );
        let server = HttpServer::with_hub(store.clone(), hub).with_engine(engine);
        let engine = server.engine().expect("the server holds its engine");
        store.create_session("sess-steer-cancel", None).unwrap();

        let post = |path: &str, body: Value| HttpRequest {
            method: "POST".into(),
            path: path.into(),
            query: None,
            headers: HashMap::new(),
            body: serde_json::to_vec(&body).unwrap(),
        };
        async fn wait_until(deadline_secs: u64, mut condition: impl FnMut() -> bool) {
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_secs(deadline_secs);
            while !condition() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "condition not met within {deadline_secs}s"
                );
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }

        // 1. The first prompt runs against the hanging endpoint.
        let first = server
            .handle_request(&post(
                "/api/v1/sessions/sess-steer-cancel/prompts",
                json!({ "prompt": "first" }),
            ))
            .await;
        assert_eq!(first.status, 200);
        let first_item: Value = serde_json::from_slice(&first.body).unwrap();
        let first_id = first_item["prompt_id"].as_str().unwrap().to_string();
        assert_eq!(first_item["status"], "running");
        wait_until(10, || engine.is_turn_active("sess-steer-cancel")).await;

        // 2. A second prompt queues behind it and is steered into the running turn.
        let second = server
            .handle_request(&post(
                "/api/v1/sessions/sess-steer-cancel/prompts",
                json!({ "prompt": "steered-text" }),
            ))
            .await;
        let second_item: Value = serde_json::from_slice(&second.body).unwrap();
        let second_id = second_item["prompt_id"].as_str().unwrap().to_string();
        assert_eq!(second_item["status"], "queued");

        let steer = server
            .handle_request(&post(
                "/api/v1/sessions/sess-steer-cancel/prompts:steer",
                json!({ "prompt_ids": [second_id] }),
            ))
            .await;
        assert_eq!(steer.status, 200);

        // 3. Abort the running turn before its next step head drains the steer.
        let abort = server
            .handle_request(&post(
                &format!("/api/v1/sessions/sess-steer-cancel/prompts/{first_id}:abort"),
                json!({}),
            ))
            .await;
        assert_eq!(abort.status, 200);
        wait_until(10, || !engine.is_turn_active("sess-steer-cancel")).await;
        assert_eq!(
            engine.queued_steer_count("sess-steer-cancel"),
            1,
            "the undrained steer survives the cancelled turn"
        );

        // 4. The next prompt's turn drains the survivor at its first step head.
        let third = server
            .handle_request(&post(
                "/api/v1/sessions/sess-steer-cancel/prompts",
                json!({ "prompt": "third" }),
            ))
            .await;
        assert_eq!(third.status, 200);

        // 5. The steered text is persisted exactly once, inside the new turn.
        let steered_turn = std::sync::Mutex::new(None);
        wait_until(10, || {
            let messages = store.load_session_messages("sess-steer-cancel").unwrap();
            let hits: Vec<&crate::session::sqlite_store::StoredMessage> = messages
                .iter()
                .filter(|m| m.message.content.contains("steered-text"))
                .collect();
            if hits.len() > 1 {
                panic!(
                    "the steered text must appear exactly once, saw {}",
                    hits.len()
                );
            }
            if let Some(hit) = hits.first() {
                *steered_turn.lock().unwrap() = Some(hit.turn_id.clone());
            }
            !hits.is_empty()
        })
        .await;
        let steered_turn = steered_turn.into_inner().unwrap();
        let messages = store.load_session_messages("sess-steer-cancel").unwrap();
        let third_turn = messages
            .iter()
            .find(|m| m.message.content == "third")
            .map(|m| m.turn_id.clone())
            .expect("the third prompt is persisted");
        assert_eq!(
            steered_turn.as_deref(),
            Some(third_turn.as_str()),
            "the rescued steer belongs to the turn that ran after the cancel"
        );
        mock.abort();
    }

    #[tokio::test]
    async fn prompt_queue_routes_reflect_state() {
        let server = HttpServer::in_memory().unwrap();
        server.store().create_session("sess-pq", None).unwrap();

        // Idle session: no active prompt and an empty queue.
        let list = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-pq/prompts".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(list.status, 200);
        let list_body: Value = serde_json::from_slice(&list.body).unwrap();
        assert!(list_body["active"].is_null());
        assert_eq!(list_body["queued"], json!([]));

        // Steering an unknown prompt id is PROMPT_NOT_FOUND, not a fake success.
        let steer = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-pq/prompts:steer".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "prompt_ids": ["nope"] })).unwrap(),
            })
            .await;
        assert_eq!(steer.status, 404);

        // Aborting an unknown prompt is PROMPT_NOT_FOUND, not a fake success.
        let abort = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-pq/prompts/nope:abort".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(abort.status, 404);
        let abort_body: Value = serde_json::from_slice(&abort.body).unwrap();
        assert_eq!(abort_body["code"], 40402);
    }

    /// ROADMAP §7.6: the web UI's abort button sends the live
    /// `event.message.created` id (`msg-u{turn}`). Before the message-id
    /// resolution landed, the route answered 404 for exactly the id the
    /// button holds.
    #[tokio::test]
    async fn abort_resolves_the_live_user_message_id_at_the_route() {
        let server = HttpServer::in_memory().unwrap();
        server.store().create_session("sess-abort", None).unwrap();

        let (item, run) = server.prompt_queue.admit(
            "sess-abort",
            json!({
                "prompt_id": "prompt-1",
                "user_message_id": "msg-prompt-1",
                "content": [{ "type": "text", "text": "hi" }],
                "created_at": "2026-01-01T00:00:00Z",
            }),
            "hi".into(),
            Vec::new(),
            None,
        );
        assert!(run.is_some(), "the first prompt is active");
        assert_eq!(item["status"], "running");
        // The driver stamps the turn the live event names.
        server.prompt_queue.stamp_active_turn("sess-abort", 2);

        let abort = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-abort/prompts/msg-u2:abort".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(abort.status, 200);
        let abort_body: Value = serde_json::from_slice(&abort.body).unwrap();
        assert_eq!(abort_body["aborted"], true);
        assert!(server.prompt_queue.active_is_cancelled("sess-abort"));
    }

    #[tokio::test]
    async fn prompt_submission_options_persist_to_session_profile() {
        let server = HttpServer::in_memory().unwrap();
        server.store().create_session("sess-opt", None).unwrap();
        let body = json!({
            "content": [{ "type": "text", "text": "hi" }],
            "model": "alias-2",
            "thinking": "high",
            "permission_mode": "yolo",
            "plan_mode": true,
            "disabled_tools": ["Bash"],
            "profile": "coder",
            "metadata": { "title": "T" },
        });
        apply_prompt_submission_options(&server, "sess-opt", &body).unwrap();

        let config = server
            .store()
            .get_state("agent_config", "sess-opt")
            .unwrap()
            .unwrap();
        assert_eq!(config["model"], "alias-2");
        assert_eq!(config["thinking"], "high");
        assert_eq!(config["plan_mode"], true);
        assert_eq!(config["disabled_tools"], json!(["Bash"]));
        assert_eq!(config["profile"], "coder");

        let metadata = server
            .store()
            .get_state("metadata", "sess-opt")
            .unwrap()
            .unwrap();
        assert_eq!(metadata["permission_mode"], "yolo");
        assert_eq!(metadata["title"], "T");

        // An unknown permission mode is rejected before any turn runs.
        let bad = json!({
            "content": [{ "type": "text", "text": "x" }],
            "permission_mode": "nope",
        });
        assert!(apply_prompt_submission_options(&server, "sess-opt", &bad).is_err());
    }

    #[tokio::test]
    async fn prompt_plan_mode_activates_workspace_plan_state() {
        let dir = std::env::temp_dir().join(format!("kimi-plan-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let server = HttpServer::in_memory().unwrap();
        server.store().create_session("sess-plan", None).unwrap();
        let body = json!({
            "content": [{ "type": "text", "text": "plan it" }],
            "plan_mode": true,
            "metadata": { "cwd": dir.to_string_lossy() },
        });
        apply_prompt_submission_options(&server, "sess-plan", &body).unwrap();

        let state = crate::storage::StateStore::for_workspace(&dir).unwrap();
        assert_eq!(state.read_domain("plan").unwrap()["active"], true);
    }

    #[tokio::test]
    async fn test_http_provider_crud_writes_config() {
        let dir = std::env::temp_dir().join(format!("kimi-provider-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("config.toml");
        std::fs::write(
            &config_path,
            "default_model = \"\"\n\n[providers.openai]\ntype = \"openai\"\napi_key = \"sk-old\"\n",
        )
        .unwrap();
        let server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(config_path.clone());

        fn request(method: &str, path: &str, body: Option<&Value>) -> HttpRequest {
            HttpRequest {
                method: method.into(),
                path: path.into(),
                query: None,
                headers: HashMap::new(),
                body: body
                    .map(|value| serde_json::to_vec(value).unwrap())
                    .unwrap_or_default(),
            }
        }

        // 1. Create writes the provider + aliases and seeds the unset default.
        let create_body = json!({
            "id": "kimi-code",
            "type": "openai",
            "api_key": "sk-test",
            "base_url": "https://example.test/v1",
            "default_model": "k3",
            "models": [
                { "model": "k3", "max_context_size": 200000, "display_name": "K3" },
                { "model": "fast", "max_context_size": 128000 }
            ]
        });
        let res = server
            .handle_request(&request("POST", "/api/v1/providers", Some(&create_body)))
            .await;
        assert_eq!(res.status, 201);
        let created: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(created["id"], "kimi-code");
        assert_eq!(created["has_api_key"], true);
        assert_eq!(created["status"], "connected");
        assert_eq!(created["default_model"], "kimi-code/k3");

        // 2. A duplicate id is a PROVIDER_ALREADY_EXISTS conflict.
        let res = server
            .handle_request(&request("POST", "/api/v1/providers", Some(&create_body)))
            .await;
        assert_eq!(res.status, 409);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40921);

        // 3. The single-provider read reveals the stored key.
        let res = server
            .handle_request(&request("GET", "/api/v1/providers/kimi-code", None))
            .await;
        assert_eq!(res.status, 200);
        let fetched: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(fetched["api_key"], "sk-test");

        // 4. The write is format-preserving and the read side sees it.
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[providers.kimi-code]"), "{text}");
        assert!(text.contains("[models.\"kimi-code/k3\"]"), "{text}");
        assert!(text.contains("default_model = \"kimi-code/k3\""), "{text}");
        assert!(text.contains("[providers.openai]"), "{text}");
        let res = server
            .handle_request(&request("GET", "/api/v1/models", None))
            .await;
        let models: Value = serde_json::from_slice(&res.body).unwrap();
        assert!(
            models["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["model"] == "kimi-code/k3")
        );

        // 5. Replace with a rename migrates default_model, drops stale aliases.
        let res = server
            .handle_request(&request(
                "PUT",
                "/api/v1/providers/kimi-code",
                Some(&json!({
                    "new_id": "kimi-code-2",
                    "type": "anthropic",
                    "api_key": "sk-new",
                    "base_url": "https://example.test/v2",
                    "default_model": "k3",
                    "models": [{ "model": "k3", "max_context_size": 200000 }]
                })),
            ))
            .await;
        assert_eq!(res.status, 200);
        let replaced: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(replaced["provider"]["id"], "kimi-code-2");
        assert_eq!(replaced["provider"]["type"], "anthropic");
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[providers.kimi-code-2]"), "{text}");
        assert!(!text.contains("[providers.kimi-code]"), "{text}");
        assert!(
            text.contains("default_model = \"kimi-code-2/k3\""),
            "{text}"
        );
        assert!(!text.contains("kimi-code/fast"), "{text}");

        // 6. OAuth-managed providers refuse writes; delete cleans aliases.
        let mut text = std::fs::read_to_string(&config_path).unwrap();
        text.push_str(
            "\n[providers.\"managed:kimi-code\"]\ntype = \"kimi\"\noauth = { provider = \"managed:kimi-code\" }\n",
        );
        std::fs::write(&config_path, text).unwrap();
        *server.config_override.lock().await = None;

        let res = server
            .handle_request(&request(
                "DELETE",
                "/api/v1/providers/managed%3Akimi-code",
                None,
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40003);

        let res = server
            .handle_request(&request("DELETE", "/api/v1/providers/kimi-code-2", None))
            .await;
        assert_eq!(res.status, 200);
        let deleted: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(deleted["deleted"], true);
        let text = std::fs::read_to_string(&config_path).unwrap();
        // The provider and its aliases are gone; the (now dangling) default
        // pointer is the user's setting and stays, matching kap-server.
        assert!(!text.contains("[providers.kimi-code-2]"), "{text}");
        assert!(!text.contains("[models.\"kimi-code-2/k3\"]"), "{text}");
        assert!(
            text.contains("default_model = \"kimi-code-2/k3\""),
            "{text}"
        );
        assert!(text.contains("[providers.openai]"), "{text}");

        // 7. Validation failures carry the kap-server validation code.
        let res = server
            .handle_request(&request(
                "POST",
                "/api/v1/providers",
                Some(&json!({ "id": "bad id!", "type": "openai", "models": [] })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40001);

        std::fs::remove_dir_all(&dir).ok();
    }

    fn catalog_request(method: &str, path: &str, body: Option<&Value>) -> HttpRequest {
        HttpRequest {
            method: method.into(),
            path: path.into(),
            query: None,
            headers: HashMap::new(),
            body: body
                .map(|value| serde_json::to_vec(value).unwrap())
                .unwrap_or_default(),
        }
    }

    /// A one-connection-at-a-time registry server: the response (status line
    /// and JSON body) can be swapped between requests, and every request head
    /// is captured so the auth header can be asserted.
    struct RegistryServer {
        url: String,
        response: Arc<std::sync::Mutex<(String, String)>>,
        requests: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl RegistryServer {
        async fn spawn(status: &str, body: &str) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let response = Arc::new(std::sync::Mutex::new((
                status.to_string(),
                body.to_string(),
            )));
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let shared_response = response.clone();
            let shared_requests = requests.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                while let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        continue;
                    }
                    shared_requests
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&buf[..n]).to_string());
                    let (status, body) = shared_response.lock().unwrap().clone();
                    let head = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.flush().await;
                }
            });
            Self {
                url: format!("http://{addr}/api.json"),
                response,
                requests,
            }
        }

        fn set_response(&self, status: &str, body: &str) {
            *self.response.lock().unwrap() = (status.to_string(), body.to_string());
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[tokio::test]
    async fn catalog_routes_fall_back_to_the_builtin_when_the_fetch_fails() {
        let mut server = HttpServer::in_memory().unwrap();
        server.models_dev_cache =
            Arc::new(models_dev::CatalogCache::new().with_fetcher(Arc::new(|| {
                Box::pin(async { Err("upstream down".to_string()) })
                    as crate::rpc::types::BoxFuture<'static, Result<Value, String>>
            })));

        let res = server
            .handle_request(&catalog_request("GET", "/api/v1/catalog/providers", None))
            .await;
        assert_eq!(res.status, 200);
        let list: Value = serde_json::from_slice(&res.body).unwrap();
        let items = list["items"].as_array().unwrap();
        assert_eq!(items.len(), 4, "the built-in snapshot ends the chain");
        assert!(items.iter().any(|item| item["id"] == "moonshot"));

        // The per-id route serves the same entry the list advertises.
        let res = server
            .handle_request(&catalog_request(
                "GET",
                "/api/v1/catalog/providers/anthropic",
                None,
            ))
            .await;
        assert_eq!(res.status, 200);
        let item: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(item["id"], "anthropic");
        assert_eq!(item["wire_type"], "anthropic");
        assert_eq!(item["base_url"], "https://api.anthropic.com");

        // An unknown id is a 404, not a fabricated entry.
        let res = server
            .handle_request(&catalog_request(
                "GET",
                "/api/v1/catalog/providers/nope",
                None,
            ))
            .await;
        assert_eq!(res.status, 404);
    }

    #[tokio::test]
    async fn import_registry_writes_providers_with_their_source() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "default_model = \"\"\n").unwrap();
        let server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(config_path.clone());
        let registry = json!({
            "acme": {
                "id": "acme",
                "name": "Acme",
                "api": "https://registry.example.test/v1",
                "type": "openai",
                "env": ["ACME_API_KEY"],
                "models": { "big": { "id": "big-1", "limit": { "context": 128000 } } },
            },
            "beta": {
                "id": "beta",
                "name": "Beta",
                "api": "https://beta.example.test/v1",
                "type": "anthropic",
                "models": {
                    "sonnet": {
                        "id": "sonnet-1",
                        "limit": { "context": 200000 },
                        "tool_call": true,
                        "reasoning": true,
                    },
                },
            },
            "broken": { "id": "broken", "name": "Broken" },
        });
        let upstream = RegistryServer::spawn("200 OK", &registry.to_string()).await;

        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_registry",
                Some(&json!({ "url": upstream.url, "api_key": "sk-reg" })),
            ))
            .await;
        assert_eq!(res.status, 201);
        let imported: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(imported["models_imported"], 2);
        let providers = imported["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 2, "the invalid entry is skipped");
        assert_eq!(imported["credential_env"]["acme"], "ACME_API_KEY");
        // The Bearer key reached the registry.
        let requests = upstream.requests();
        assert!(
            requests
                .iter()
                .any(|request| request.contains("authorization: Bearer sk-reg")),
            "{requests:?}"
        );

        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[providers.acme]"), "{text}");
        assert!(text.contains("[providers.acme.source]"), "{text}");
        assert!(text.contains("kind = \"apiJson\""), "{text}");
        assert!(text.contains("apiKey = \"sk-reg\""), "{text}");
        assert!(text.contains("[models.\"acme/big\"]"), "{text}");
        assert!(text.contains("[models.\"beta/sonnet\"]"), "{text}");
        // The unset default is seeded from the first entry's first model.
        assert!(text.contains("default_model = \"acme/big\""), "{text}");

        // A re-import of the same URL with one provider gone removes the
        // vanished provider and its aliases; the URL is the identity, so the
        // stored key is reused when the request omits it.
        upstream.set_response(
            "200 OK",
            &json!({
                "acme": {
                    "id": "acme",
                    "name": "Acme",
                    "api": "https://registry.example.test/v1",
                    "type": "openai",
                    "models": { "big": { "id": "big-1", "limit": { "context": 128000 } } },
                },
            })
            .to_string(),
        );
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_registry",
                Some(&json!({ "url": upstream.url })),
            ))
            .await;
        assert_eq!(res.status, 201);
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(!text.contains("[providers.beta]"), "{text}");
        assert!(!text.contains("beta/sonnet"), "{text}");
        assert!(text.contains("[providers.acme]"), "{text}");
        // v2's remove-then-apply clears a default that pointed into the
        // re-imported provider, and its `hadDefault` reads the pre-apply
        // value, so it is not reseeded — the port mirrors that.
        assert!(!text.contains("default_model"), "{text}");
    }

    #[tokio::test]
    async fn import_registry_rejects_the_unimportable() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "default_model = \"acme/big\"\n").unwrap();
        let server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(config_path.clone());
        let upstream = RegistryServer::spawn("200 OK", "{}").await;

        // A missing url is a validation failure.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_registry",
                Some(&json!({})),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40001);

        // An empty registry has no importable providers.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_registry",
                Some(&json!({ "url": upstream.url })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40005);
        assert!(
            body["msg"]
                .as_str()
                .unwrap()
                .contains("no importable providers")
        );

        // An upstream failure carries the status in the reason.
        upstream.set_response("401 Unauthorized", r#"{"message":"bad key"}"#);
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_registry",
                Some(&json!({ "url": upstream.url, "api_key": "sk-bad" })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40005);
        let msg = body["msg"].as_str().unwrap();
        assert!(msg.contains("cannot be imported"), "{msg}");
        assert!(msg.contains("401"), "{msg}");
        assert!(msg.contains("bad key"), "{msg}");

        // An OAuth-managed provider refuses the import.
        upstream.set_response(
            "200 OK",
            &json!({
                "acme": {
                    "id": "acme",
                    "name": "Acme",
                    "api": "https://registry.example.test/v1",
                    "type": "openai",
                    "models": { "big": { "id": "big-1", "limit": { "context": 128000 } } },
                },
            })
            .to_string(),
        );
        let mut text = std::fs::read_to_string(&config_path).unwrap();
        text.push_str("\n[providers.acme]\ntype = \"openai\"\noauth = { provider = \"acme\" }\n");
        std::fs::write(&config_path, text).unwrap();
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_registry",
                Some(&json!({ "url": upstream.url })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40003);
    }

    #[tokio::test]
    async fn import_catalog_falls_back_to_the_builtin_when_the_fetch_fails() {
        // The offline path a blocked-network user takes: the upstream fetch
        // fails, so the import resolves against the built-in snapshot.
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "default_model = \"\"\n").unwrap();
        let mut server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(config_path.clone());
        server.models_dev_cache =
            Arc::new(models_dev::CatalogCache::new().with_fetcher(Arc::new(|| {
                Box::pin(async { Err("upstream down".to_string()) })
                    as crate::rpc::types::BoxFuture<'static, Result<Value, String>>
            })));

        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "anthropic", "api_key": "sk-offline" })),
            ))
            .await;
        assert_eq!(res.status, 201);
        let imported: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(imported["models_imported"], 1);
        assert_eq!(imported["provider"]["id"], "anthropic");
        assert_eq!(imported["provider"]["type"], "anthropic");
        assert_eq!(imported["provider"]["status"], "connected");

        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[providers.anthropic]"), "{text}");
        assert!(
            text.contains("base_url = \"https://api.anthropic.com\""),
            "{text}"
        );
        assert!(
            text.contains("[models.\"anthropic/claude-3-7-sonnet-20250219\"]"),
            "{text}"
        );
        assert!(
            text.contains("default_model = \"anthropic/claude-3-7-sonnet-20250219\""),
            "{text}"
        );
    }

    #[tokio::test]
    async fn import_catalog_writes_the_provider_and_its_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "default_model = \"\"\n").unwrap();
        let mut server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(config_path.clone());
        let catalog = json!({
            "acme": {
                "id": "acme",
                "name": "Acme",
                "type": "openai",
                "api": "https://api.example.test/v1",
                "env": ["ACME_API_KEY"],
                "models": {
                    "big": {
                        "id": "big",
                        "name": "Big",
                        "limit": { "context": 128000, "input": 64000 },
                        "reasoning_options": [{ "type": "effort", "values": ["low", "high"] }],
                    },
                    "small": { "id": "small", "limit": { "context": 8192 } },
                },
            },
        });
        server.models_dev_cache = Arc::new(models_dev::CatalogCache::new().with_fetcher(Arc::new(
            move || {
                let catalog = catalog.clone();
                Box::pin(async move { Ok(catalog) })
                    as crate::rpc::types::BoxFuture<'static, Result<Value, String>>
            },
        )));

        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "acme", "api_key": "sk-acme" })),
            ))
            .await;
        assert_eq!(res.status, 201);
        let imported: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(imported["models_imported"], 2);
        assert_eq!(imported["provider"]["id"], "acme");
        assert_eq!(imported["provider"]["type"], "openai");
        assert_eq!(imported["provider"]["status"], "connected");

        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[providers.acme]"), "{text}");
        assert!(text.contains("type = \"openai\""), "{text}");
        assert!(text.contains("api_key = \"sk-acme\""), "{text}");
        assert!(
            text.contains("base_url = \"https://api.example.test/v1\""),
            "{text}"
        );
        assert!(text.contains("[models.\"acme/big\"]"), "{text}");
        assert!(text.contains("[models.\"acme/small\"]"), "{text}");
        // The unset default is seeded from the first imported model.
        assert!(text.contains("default_model = \"acme/big\""), "{text}");
        // The always-thinking rename and the capped input size ride along.
        assert!(text.contains("always_thinking"), "{text}");
        assert!(text.contains("max_input_size = 64000"), "{text}");

        // A re-import under a new id rewrites that entry; the old provider's
        // aliases survive (v2 filters by the target id) and the credential
        // carries over when the request supplies none.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "acme", "id": "acme-2" })),
            ))
            .await;
        assert_eq!(res.status, 201);
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[providers.acme-2]"), "{text}");
        assert!(text.contains("[models.\"acme-2/big\"]"), "{text}");
        assert!(text.contains("[models.\"acme/big\"]"), "{text}");
        assert!(text.contains("api_key = \"sk-acme\""), "{text}");
        // The seeded default is not rewritten by the re-import.
        assert!(text.contains("default_model = \"acme/big\""), "{text}");
    }

    #[tokio::test]
    async fn import_catalog_rejects_the_unimportable() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "default_model = \"acme/big\"\n").unwrap();
        let mut server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(config_path.clone());
        let catalog = json!({
            "acme": {
                "id": "acme",
                "name": "Acme",
                "api": "https://api.example.test/v1",
                "models": { "big": { "id": "big", "limit": { "context": 128000 } } },
            },
            "gateway": { "id": "gateway", "name": "Gateway", "npm": "@acme/gateway" },
            "bedrock": { "id": "bedrock", "name": "Bedrock", "type": "bedrock" },
            "empty": { "id": "empty", "name": "Empty", "api": "https://api.example.test" },
        });
        server.models_dev_cache = Arc::new(models_dev::CatalogCache::new().with_fetcher(Arc::new(
            move || {
                let catalog = catalog.clone();
                Box::pin(async move { Ok(catalog) })
                    as crate::rpc::types::BoxFuture<'static, Result<Value, String>>
            },
        )));

        // An unknown catalog entry is CATALOG_ENTRY_NOT_FOUND.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "nope" })),
            ))
            .await;
        assert_eq!(res.status, 404);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40417);

        // A missing catalog_id is a validation failure.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({})),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40001);

        // Every unimportable-entry branch carries CATALOG_IMPORT_INVALID.
        for catalog_id in ["gateway", "bedrock", "empty"] {
            let res = server
                .handle_request(&catalog_request(
                    "POST",
                    "/api/v1/providers:import_catalog",
                    Some(&json!({ "catalog_id": catalog_id })),
                ))
                .await;
            assert_eq!(res.status, 400, "{catalog_id}");
            let body: Value = serde_json::from_slice(&res.body).unwrap();
            assert_eq!(body["code"], 40004, "{catalog_id}");
        }

        // An entry that needs an endpoint is a validation failure.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "gateway" })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40004);
        assert!(
            body["msg"]
                .as_str()
                .unwrap()
                .contains("requires a base_url")
        );

        // A proprietary-SDK entry is a validation failure.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "bedrock" })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40004);

        // An entry with no importable models is a validation failure.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "empty" })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40004);
        assert!(
            body["msg"]
                .as_str()
                .unwrap()
                .contains("no importable models")
        );

        // An unusable target id is a validation failure.
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "acme", "id": "bad id!" })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40004);

        // An OAuth-managed provider refuses the import.
        let mut text = std::fs::read_to_string(&config_path).unwrap();
        text.push_str("\n[providers.acme]\ntype = \"openai\"\noauth = { provider = \"acme\" }\n");
        std::fs::write(&config_path, text).unwrap();
        let res = server
            .handle_request(&catalog_request(
                "POST",
                "/api/v1/providers:import_catalog",
                Some(&json!({ "catalog_id": "acme" })),
            ))
            .await;
        assert_eq!(res.status, 400);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["code"], 40003);
    }

    #[tokio::test]
    async fn provider_create_publishes_config_changed_on_the_global_lane() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "default_model = \"\"\n").unwrap();
        let server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(config_path.clone());
        let mut sub = server.hub().attach();

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/providers".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "id": "kimi-code",
                    "type": "openai",
                    "api_key": "sk-test",
                    "base_url": "https://example.test/v1",
                    "default_model": "k3",
                    "models": [{ "model": "k3", "max_context_size": 200000 }]
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res.status, 201);

        let ev = sub.recv().await.unwrap();
        assert_eq!(&*ev.session_id, "global");
        assert_eq!(ev.event.event_type(), "event.config.changed");
        let crate::events::EngineEvent::ConfigChanged {
            changed_fields,
            config,
        } = &ev.event
        else {
            panic!("expected ConfigChanged, got {:?}", ev.event);
        };
        assert_eq!(changed_fields, &vec!["providers".to_string()]);
        // The payload carries the post-write config, so the client can fold
        // it instead of re-fetching.
        assert_eq!(config["providers"]["kimi-code"]["type"], "openai");
        assert_eq!(config["default_model"], "kimi-code/k3");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn model_catalog_changed_publishes_on_the_global_lane() {
        let server = HttpServer::in_memory().unwrap();
        let mut sub = server.hub().attach();
        server.publish_model_catalog_changed(&json!({
            "changed": [{ "provider_id": "kimi-code", "provider_name": "Kimi Code", "added": 2, "removed": 1 }],
            "unchanged": ["other"],
            "failed": [],
        }));

        let ev = sub.recv().await.unwrap();
        assert_eq!(&*ev.session_id, "global");
        assert_eq!(ev.event.event_type(), "event.model_catalog.changed");
        let crate::events::EngineEvent::Custom(value) = &ev.event else {
            panic!("expected Custom event");
        };
        assert_eq!(value["changed"][0]["added"], 2);
        assert_eq!(value["unchanged"][0], "other");
        assert!(value["failed"].as_array().unwrap().is_empty());
    }

    /// The v3 `config.warning` entity's producer: a `config.toml` with a
    /// malformed `[models]` entry reaches the global lane as
    /// `event.config.warning`, the event the global translator turns into the
    /// entity. The warning is captured at config load, which happens before
    /// the server exists, so this exercises the staging seam too.
    #[tokio::test]
    async fn a_malformed_model_entry_reaches_the_global_lane_as_a_config_warning() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
default_model = "typo"

[models.typo]
provider = "kimi"
max_context_size = 1000
"#,
        )
        .unwrap();
        let config = crate::config::KimiConfig::from_file(&path).unwrap();
        assert_eq!(config.config_warnings.len(), 1);

        let server = HttpServer::in_memory().unwrap();
        let mut sub = server.hub().attach();
        let server = server.with_config(config);
        // The seeded config is what `config()` reads back, so the warning list
        // and the config view come from one load rather than two that could
        // differ.
        assert_eq!(server.config().await.config_warnings.len(), 1);

        let ev = sub.recv().await.unwrap();
        assert_eq!(&*ev.session_id, "global");
        assert_eq!(ev.event.event_type(), "event.config.warning");
        let crate::events::EngineEvent::Custom(value) = &ev.event else {
            panic!("expected Custom event, got {:?}", ev.event);
        };
        // The shape the global translator reads: `warnings[].message`.
        let warnings = value["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1, "{value}");
        assert!(
            warnings[0]["message"]
                .as_str()
                .unwrap()
                .contains("[models] entry 'typo' is missing"),
            "{value}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A config that loaded cleanly must not publish an empty warning entity
    /// *at startup*: a fresh daemon has no stale advisory to clear, and the
    /// entity would sit in the global lane's replay ring saying nothing.
    /// (The reload path is the opposite — see the test below.)
    #[tokio::test]
    async fn a_clean_config_publishes_no_config_warning_at_startup() {
        let server = HttpServer::in_memory()
            .unwrap()
            .with_config(Default::default());

        // Nothing is on the global lane, so the subscription's replay is empty
        // and `recv` only returns on a publish. Any event would prove the
        // publish happened; a timeout proves none did.
        let mut sub = server.hub().attach();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), sub.recv())
                .await
                .is_err(),
            "a clean config must not broadcast a config.warning"
        );
    }

    /// The clear-the-stale-advisory path the reload route exists for: a server
    /// started on a broken `config.toml` warns, and reloading a repaired file
    /// publishes `warnings: []` so the client drops the advisory it is holding.
    /// Upstream has the same asymmetry — `publishConfigWarnings`
    /// (`kap-server/src/start.ts`) publishes on every
    /// diagnostics change with no empty check, and only its startup call
    /// filters.
    #[tokio::test]
    async fn reloading_a_repaired_config_publishes_an_empty_warning_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let broken = r#"
default_model = "typo"

[models.typo]
provider = "kimi"
max_context_size = 1000
"#;
        std::fs::write(&path, broken).unwrap();

        let server = HttpServer::in_memory()
            .unwrap()
            .with_config_write_path(path.clone());
        let mut sub = server.hub().attach();
        let server = server.with_config(crate::config::KimiConfig::from_file(&path).unwrap());

        // Startup: the broken entry is announced.
        let ev = sub.recv().await.unwrap();
        assert_eq!(ev.event.event_type(), "event.config.warning");
        let crate::events::EngineEvent::Custom(value) = &ev.event else {
            panic!("expected Custom event, got {:?}", ev.event);
        };
        assert_eq!(value["warnings"].as_array().unwrap().len(), 1, "{value}");

        // The user fixes the file and reloads.
        std::fs::write(
            &path,
            "[models.good]\nprovider = \"kimi\"\nmodel = \"kimi-k2\"\n",
        )
        .unwrap();
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/config:reload".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);

        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), sub.recv())
            .await
            .expect("a reload of a repaired config must publish, not go silent")
            .unwrap();
        assert_eq!(&*ev.session_id, "global");
        assert_eq!(ev.event.event_type(), "event.config.warning");
        let crate::events::EngineEvent::Custom(value) = &ev.event else {
            panic!("expected Custom event, got {:?}", ev.event);
        };
        assert!(
            value["warnings"].as_array().unwrap().is_empty(),
            "a repaired config must clear the client's advisory: {value}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn test_http_provider_refresh_discovers_managed_models() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // A mock `GET /models` whose payload the test can swap between calls.
        let payload = Arc::new(std::sync::Mutex::new(json!({
            "data": [
                { "id": "k3", "context_length": 200000, "display_name": "K3", "supports_thinking_type": "both" },
                { "id": "k3-fast", "context_length": 128000 }
            ]
        })));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let payload_for_server = payload.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let payload = payload_for_server
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let _ = sock.read(&mut buffer).await;
                    let body = payload.to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(response.as_bytes()).await;
                    let _ = sock.flush().await;
                });
            }
        });

        // Cached OAuth credential the refresh authenticates with.
        let credentials =
            std::env::temp_dir().join(format!("kimi-refresh-creds-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&credentials).unwrap();
        std::fs::write(
            credentials.join("kimi.json"),
            json!({
                "access_token": "token-1",
                "refresh_token": "refresh-1",
                "expires_at": chrono::Utc::now().timestamp() + 3600,
                "scope": "kimi",
                "token_type": "Bearer",
                "expires_in": 3600,
            })
            .to_string(),
        )
        .unwrap();

        let dir = std::env::temp_dir().join(format!("kimi-refresh-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("config.toml");
        std::fs::write(
            &config_path,
            format!(
                "default_model = \"kimi-code/k3\"\n\n[providers.\"managed:kimi-code\"]\ntype = \"kimi\"\nbase_url = \"http://{addr}/v1\"\noauth = {{ provider = \"managed:kimi-code\" }}\n"
            ),
        )
        .unwrap();

        let oauth = crate::server::oauth::OAuthManager::with_hosts(
            format!("http://{addr}"),
            format!("http://{addr}/v1"),
            Some(credentials.clone()),
        );
        let server = HttpServer::in_memory()
            .unwrap()
            .with_oauth_manager(Arc::new(oauth))
            .with_config_write_path(config_path.clone());

        fn request(path: &str) -> HttpRequest {
            HttpRequest {
                method: "POST".into(),
                path: path.into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            }
        }

        // 1. A targeted refresh discovers both models and writes the aliases.
        let res = server
            .handle_request(&request("/api/v1/providers/managed%3Akimi-code:refresh"))
            .await;
        assert_eq!(res.status, 200);
        let result: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(result["changed"][0]["provider_id"], "managed:kimi-code");
        assert_eq!(result["changed"][0]["provider_name"], "Kimi Code");
        assert_eq!(result["changed"][0]["added"], 2);
        assert_eq!(result["changed"][0]["removed"], 0);
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("[models.\"kimi-code/k3\"]"), "{text}");
        assert!(text.contains("[models.\"kimi-code/k3-fast\"]"), "{text}");
        assert!(text.contains("provider = \"managed:kimi-code\""), "{text}");

        // 2. The same payload again is a no-op.
        let res = server
            .handle_request(&request("/api/v1/providers/managed%3Akimi-code:refresh"))
            .await;
        let result: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(result["unchanged"], json!(["managed:kimi-code"]));
        assert!(result["changed"].as_array().unwrap().is_empty());

        // 3. A model the endpoint stops listing is reported and removed.
        *payload
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = json!({
            "data": [{ "id": "k3", "context_length": 200000 }]
        });
        let res = server
            .handle_request(&request("/api/v1/providers:refresh"))
            .await;
        let result: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(result["changed"][0]["removed"], 1);
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(!text.contains("kimi-code/k3-fast"), "{text}");
        assert!(text.contains("default_model = \"kimi-code/k3\""), "{text}");

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&credentials).ok();
    }

    #[tokio::test]
    async fn test_http_files_upload_download_delete() {
        let dir = std::env::temp_dir().join(format!("kimi-files-route-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let server = HttpServer::in_memory()
            .unwrap()
            .with_file_store(crate::server::files::FileStore::with_root(dir.clone()));

        let boundary = "route-boundary";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"note.txt\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
        body.extend_from_slice(b"hello files");
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/files".into(),
                query: None,
                headers: HashMap::from([(
                    "content-type".to_string(),
                    format!("multipart/form-data; boundary={boundary}"),
                )]),
                body,
            })
            .await;
        assert_eq!(res.status, 200);
        let meta: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(meta["name"], "note.txt");
        assert_eq!(meta["media_type"], "text/plain");
        assert_eq!(meta["size"], 11);
        let file_id = meta["id"].as_str().unwrap().to_string();

        // Download the whole file.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/files/{file_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        assert_eq!(res.body, b"hello files");
        assert_eq!(res.header("accept-ranges"), Some("bytes"));
        assert_eq!(
            res.header("content-disposition"),
            Some("attachment; filename=\"note.txt\"")
        );

        // A range answers 206 with the slice.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/files/{file_id}"),
                query: None,
                headers: HashMap::from([("range".to_string(), "bytes=0-4".to_string())]),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 206);
        assert_eq!(res.body, b"hello");
        assert_eq!(res.header("content-range"), Some("bytes 0-4/11"));

        // Unknown ids answer FILE_NOT_FOUND.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/files/f_missing".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 404);
        let missing: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(missing["code"], 40407);

        // Delete drops the blob; the listing is empty afterwards.
        let res = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/files/{file_id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        let deleted: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(deleted["deleted"], true);

        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/files".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let list: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(list["files"].as_array().unwrap().len(), 0);

        std::fs::remove_dir_all(&dir).ok();
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

        let res_mcp_servers = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/mcp/servers".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_mcp_servers.status, 200);
        let val_mcp_servers: Value = serde_json::from_slice(&res_mcp_servers.body).unwrap();
        assert_eq!(val_mcp_servers["servers"].as_array().unwrap().len(), 0);

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
        // The roster is engine-global and the payload says so, rather than
        // leaving a client to assume the servers are session-scoped.
        assert_eq!(val_sess_mcp["scope"], "engine-global");

        // 4b. The session-scoped MCP views the web UI calls. Same roster, the
        // paths the client actually requests.
        let res_sess_servers = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-mcp/mcp/servers".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_servers.status, 200);
        let val_sess_servers: Value = serde_json::from_slice(&res_sess_servers.body).unwrap();
        assert_eq!(val_sess_servers["servers"].as_array().unwrap().len(), 1);

        let res_sess_detail = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-mcp/mcp/servers/github-mcp".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_detail.status, 200);
        let val_sess_detail: Value = serde_json::from_slice(&res_sess_detail.body).unwrap();
        assert_eq!(val_sess_detail["name"], "github-mcp");
        assert_eq!(val_sess_detail["tools"].as_array().unwrap().len(), 1);

        let res_sess_unknown = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-mcp/mcp/servers/nope".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_sess_unknown.status, 404);

        let res_sess_reconnect = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-mcp/mcp/servers/github-mcp:reconnect".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        // The route reaches the manager, which refuses: the fixture added the
        // client directly, so there is no spawn recipe to reconnect from. A
        // 404 here would mean the path never matched.
        assert_eq!(res_sess_reconnect.status, 500);
        let val_sess_reconnect: Value = serde_json::from_slice(&res_sess_reconnect.body).unwrap();
        assert!(
            val_sess_reconnect["error"]
                .as_str()
                .unwrap_or_default()
                .contains("is not configured"),
            "{val_sess_reconnect}"
        );

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

        // The session-scoped views validate the session the same way.
        for path in [
            "/api/v1/sessions/sess-missing/mcp/servers",
            "/api/v1/sessions/sess-missing/mcp/servers/github-mcp",
        ] {
            let res = server
                .handle_request(&HttpRequest {
                    method: "GET".into(),
                    path: path.into(),
                    query: None,
                    headers: HashMap::new(),
                    body: Vec::new(),
                })
                .await;
            assert_eq!(res.status, 404, "{path}");
        }

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
            .save_turn("sess-dual", "turn-1", 1, &msgs[..2], None, None)
            .unwrap();
        store
            .save_turn("sess-dual", "turn-2", 2, &msgs[2..], None, None)
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
        // v2 `sessionStatusResponseSchema`: a bare status object keyed by field
        // name, with no `sessionId`.
        assert!(status_val["busy"].is_boolean());
        assert!(status_val["permission"].is_string());

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
        // v2 answers the bare `goalSnapshotSchema`.
        assert_eq!(goal_val["objective"], "verify dual syntax");

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
        assert_eq!(res_fork_colon.status, 200);
        let fork_val: Value = serde_json::from_slice(&res_fork_colon.body).unwrap();
        let new_sid = fork_val["id"].as_str().unwrap();
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
        // 7. :compact — a summary is mandatory now, so a server with no
        // engine refuses before touching history. Both syntaxes must carry
        // the same refusal (the dedicated 503 contract is covered by
        // test_http_compact_without_summarizer_preserves_history).
        assert_eq!(res_compact_colon.status, 503);
        let compact_val: Value = serde_json::from_slice(&res_compact_colon.body).unwrap();
        assert_eq!(compact_val["error"], "no engine configured for this server");

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

        // 5. POST activate skill -> 200
        let res_act = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-skill/skills/test-skill:activate".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "args": "foo" })).unwrap(),
            })
            .await;
        assert_eq!(res_act.status, 200);
        let val_act: Value = serde_json::from_slice(&res_act.body).unwrap();
        assert_eq!(val_act["activated"], true);
        assert_eq!(val_act["skill_name"], "test-skill");
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
            turn_id: "turn-inter".into(),
            arguments: json!({ "command": "cargo build" }),
            reason: None,
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
            turn_id: "turn-inter".into(),
            arguments: json!({ "path": "/root/important.conf" }),
            reason: None,
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

    /// An approval resolution must be explicit. A missing or unparsable body
    /// must never resolve to "approved" — that would let any client able to
    /// reach the route grant a dangerous tool call with an empty POST.
    #[tokio::test]
    async fn test_approval_resolve_is_fail_closed() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());
        store
            .create_session("sess-fc", Some("Fail Closed"))
            .unwrap();

        let inter_mgr = server.interaction_manager();
        let appr_req = crate::rpc::types::PermissionCheckRequest {
            tool_name: "Bash".into(),
            tool_call_id: "call_fc".into(),
            turn_id: "turn-fc".into(),
            arguments: json!({ "command": "rm -rf /" }),
            reason: None,
        };

        // Empty body must not approve.
        let (aid, mut rx) = inter_mgr.register_approval("sess-fc", appr_req.clone(), "dangerous");
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/sess-fc/approvals/{aid}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 400, "empty body must be rejected");
        assert!(
            rx.try_recv().is_err(),
            "no decision must reach the waiter on a rejected body"
        );

        // Malformed JSON must not approve.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/sess-fc/approvals/{aid}"),
                query: None,
                headers: HashMap::new(),
                body: b"{not json".to_vec(),
            })
            .await;
        assert_eq!(res.status, 400, "malformed body must be rejected");

        // A well-formed body without `decision` must not approve either.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/sess-fc/approvals/{aid}"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "feedback": "looks fine" })).unwrap(),
            })
            .await;
        assert_eq!(res.status, 400, "missing decision must be rejected");
        assert!(
            rx.try_recv().is_err(),
            "missing decision must not resolve the approval"
        );

        // An explicit decision still works.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/sess-fc/approvals/{aid}"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "decision": "approved" })).unwrap(),
            })
            .await;
        assert_eq!(res.status, 200);
        assert!(rx.try_recv().unwrap().is_allow());

        // Unparsable question resolution is rejected the same way.
        let q_req = crate::rpc::types::AskQuestionRequest {
            question_id: "q_fc".into(),
            turn_id: "turn-1".into(),
            tool_call_id: "call_q_fc".into(),
            background: false,
            timeout_ms: None,
            questions: vec![crate::rpc::types::AskQuestionItem {
                question: "Proceed?".into(),
                header: None,
                options: vec![crate::rpc::types::AskQuestionOption {
                    label: "Yes".into(),
                    description: None,
                }],
                multi_select: false,
            }],
        };
        let _rx_q = inter_mgr.register_question("sess-fc", q_req);
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-fc/questions/q_fc".into(),
                query: None,
                headers: HashMap::new(),
                body: b"{not json".to_vec(),
            })
            .await;
        assert_eq!(res.status, 400, "malformed question body must be rejected");
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
        // v2 answers the bare session document; `agent_config` rides inside it.
        assert_eq!(val_get_prof["title"], "Original Title");
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
        assert_eq!(val_post_prof["title"], "Renamed Title");
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
        assert!(
            val_content["content"]
                .as_str()
                .unwrap()
                .contains("println!(\"hello\")")
        );

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
    /// `fs::content` serves raw bytes by absolute path, honours a single
    /// `Range` slice, and revalidates with `If-None-Match` → 304. This route
    /// used to be missing entirely, so the web UI had no way to read a file
    /// it had browsed to.
    async fn test_http_fs_content_raw_range_and_revalidate() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.txt");
        std::fs::write(&file, "0123456789").unwrap();
        let path = file.to_string_lossy().to_string();

        let get = |query: Option<String>, extra: Vec<(&str, &str)>| {
            let mut headers = HashMap::new();
            for (k, v) in extra {
                headers.insert(k.to_string(), v.to_string());
            }
            HttpRequest {
                method: "GET".into(),
                path: "/api/v1/fs::content".into(),
                query,
                headers,
                body: Vec::new(),
            }
        };

        // Full content + ETag.
        let full = server
            .handle_request(&get(Some(format!("path={path}")), vec![]))
            .await;
        assert_eq!(full.status, 200);
        assert_eq!(full.body, b"0123456789".to_vec());
        let etag = full
            .headers
            .get("ETag")
            .cloned()
            .expect("response carries an ETag");

        // A single byte range is sliced with Content-Range.
        let ranged = server
            .handle_request(&get(
                Some(format!("path={path}")),
                vec![("Range", "bytes=2-4")],
            ))
            .await;
        assert_eq!(ranged.status, 206);
        assert_eq!(ranged.body, b"234".to_vec());
        assert_eq!(
            ranged.headers.get("Content-Range").map(String::as_str),
            Some("bytes 2-4/10")
        );

        // Unchanged content revalidates to 304.
        let revalidated = server
            .handle_request(&get(
                Some(format!("path={path}")),
                vec![("If-None-Match", etag.as_str())],
            ))
            .await;
        assert_eq!(revalidated.status, 304);

        // Relative paths are rejected, directories are not served.
        let relative = server
            .handle_request(&get(Some("path=relative/file.txt".into()), vec![]))
            .await;
        assert_eq!(relative.status, 400);
        let is_dir = server
            .handle_request(&get(
                Some(format!("path={}", dir.path().to_string_lossy())),
                vec![],
            ))
            .await;
        assert_eq!(is_dir.status, 400);
    }

    /// Cron entries created through the REST surface survive a restart: they
    /// are persisted under `("cron", "entries")` and reloaded by `run_serve`.
    /// Before this, the scheduler was built empty and never ticked, so
    /// schedules were lost on restart and never fired.
    #[tokio::test]
    async fn test_cron_entries_persist_across_restart() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());

        let created = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/cron".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "cron": "*/5 * * * *",
                    "prompt": "standup notes",
                    "recurring": true
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(created.status, 201);
        let val: Value = serde_json::from_slice(&created.body).unwrap();
        let id = val["id"].as_str().unwrap().to_string();

        // Simulate a restart: a fresh server over the same store reloads the
        // persisted entry into its scheduler.
        let restarted = HttpServer::new(store.clone());
        let entries = restarted.load_cron_entries();
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].prompt, "standup notes");
        assert_eq!(entries[0].cron, "*/5 * * * *");
        assert!(entries[0].recurring);

        // Deleting through the REST surface also drops the persisted entry.
        let deleted = restarted
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/cron/{id}"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(deleted.status, 200);
        assert!(restarted.load_cron_entries().is_empty());
    }

    /// A schedule created through a session-scoped route records the session
    /// it belongs to, so the daemon's tick loop has somewhere to run the fired
    /// prompt. A global `/api/v1/cron` entry has none and only publishes
    /// `cron.fired`.
    #[tokio::test]
    async fn test_session_scoped_cron_records_its_session() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());
        store
            .create_session("sess-cron", Some("Cron Session"))
            .unwrap();

        let scoped = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-cron/cron".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "cron": "*/5 * * * *",
                    "prompt": "check the deploy"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(scoped.status, 201);

        let global = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/cron".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "cron": "0 9 * * *",
                    "prompt": "morning"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(global.status, 201);

        let entries = server.load_cron_entries();
        let scoped_entry = entries
            .iter()
            .find(|e| e.prompt == "check the deploy")
            .expect("the session-scoped entry");
        assert_eq!(scoped_entry.session_id.as_deref(), Some("sess-cron"));
        let global_entry = entries
            .iter()
            .find(|e| e.prompt == "morning")
            .expect("the global entry");
        assert_eq!(global_entry.session_id, None);

        // An unknown session is still refused before anything is created.
        let missing = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-missing/cron".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "cron": "*/5 * * * *",
                    "prompt": "nope"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(missing.status, 404);
    }

    /// The session warnings route reports the engine's own degradations — an
    /// MCP server it could not connect — instead of the unconditional `[]` it
    /// used to answer, which left a user with missing MCP tools no reason.
    #[tokio::test]
    async fn test_session_warnings_route_reports_mcp_failures() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());
        store
            .create_session("sess-warn", Some("Warn Session"))
            .unwrap();

        // A healthy (empty) roster produces nothing.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-warn/warnings".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(val["warnings"].as_array().unwrap().len(), 0);

        server
            .mcp_manager()
            .configure(
                "broken",
                crate::mcp::manager::McpServerRecipe::Stdio {
                    command: "definitely-not-a-real-binary-xyz".into(),
                    args: Vec::new(),
                    env: HashMap::new(),
                    cwd: None,
                },
                crate::mcp::manager::McpServerOptions::default(),
            )
            .await
            .expect_err("the spawn must fail");

        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-warn/warnings".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        let list = val["warnings"].as_array().unwrap();
        assert_eq!(list.len(), 1, "{val}");
        assert_eq!(list[0]["code"], "mcp.server_failed");
        assert_eq!(list[0]["severity"], "warning");
        assert!(
            list[0]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("broken"),
            "{val}"
        );

        // An unknown session is still refused.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-missing/warnings".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 404);
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
        //
        // The id must resolve against the catalog (or already be installed):
        // an unknown id is a 404, not a fabricated `installed: true` with a
        // hardcoded version.
        let res_install_unknown = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "id": "test-new-plugin" })).unwrap(),
            })
            .await;
        assert_eq!(res_install_unknown.status, 404);

        let res_install = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "id": "kimi-webbridge" })).unwrap(),
            })
            .await;
        assert_eq!(res_install.status, 200);
        let val_inst: Value = serde_json::from_slice(&res_install.body).unwrap();
        assert_eq!(val_inst["id"], "kimi-webbridge");
        assert_eq!(val_inst["enabled"], true);
        // The version comes from the catalog entry, never from a literal.
        assert_eq!(val_inst["version"], "1.11.3");

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

        // 12. The bridge attaches the server engine when one is configured:
        // `session/new` must create a session, not fail with -32000.
        let hub = Arc::new(EventHub::new());
        let engine = engine_without_a_model(store.clone(), hub.clone());
        let eng_server = HttpServer::with_hub(store.clone(), hub).with_engine(engine);
        let res_new = eng_server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/acp".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "session/new",
                    "params": {}
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_new.status, 200);
        let val_new: Value = serde_json::from_slice(&res_new.body).unwrap();
        assert!(
            val_new.get("error").is_none(),
            "engine-attached bridge must not auth-fail: {val_new}"
        );
        assert!(
            val_new["result"]["sessionId"].is_string(),
            "session/new must create a session: {val_new}"
        );
    }

    /// v2 #3963: a plugin toggle reports `plugin_toggle` with the resulting
    /// enabled set, so telemetry can attribute later turns to the plugins
    /// that were loaded.
    #[tokio::test]
    async fn test_http_plugin_toggle_emits_telemetry() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let seen: Arc<std::sync::Mutex<Vec<(String, Value)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let server = HttpServer::new(store.clone()).with_telemetry_sink(Arc::new(
            move |event: &str, payload: Value| {
                sink_seen.lock().unwrap().push((event.to_string(), payload));
            },
        ));

        let post = |path: &str| HttpRequest {
            method: "POST".into(),
            path: path.into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };

        assert_eq!(
            server
                .handle_request(&post("/api/v1/plugins/kimi-webbridge:enable"))
                .await
                .status,
            200
        );
        assert_eq!(
            server
                .handle_request(&post("/api/v1/plugins/kimi-webbridge:disable"))
                .await
                .status,
            200
        );

        let events = seen.lock().unwrap();
        let toggles: Vec<&Value> = events
            .iter()
            .filter(|(event, _)| event == "plugin_toggle")
            .map(|(_, payload)| payload)
            .collect();
        assert_eq!(toggles.len(), 2, "one event per committed toggle");
        assert_eq!(toggles[0]["plugin_id"], "kimi-webbridge");
        assert_eq!(toggles[0]["enabled"], true);
        assert_eq!(toggles[0]["enabled_plugins"], "kimi-webbridge");
        assert_eq!(toggles[1]["plugin_id"], "kimi-webbridge");
        assert_eq!(toggles[1]["enabled"], false);
        assert_eq!(
            toggles[1]["enabled_plugins"], "",
            "a known empty set serializes as the empty string"
        );
    }

    /// `POST /api/v1/plugins` must reach the download path for a remote source,
    /// not merely record a catalog row: a URL install that cannot be fetched has
    /// to fail loudly instead of reporting `installed: true` with nothing behind
    /// it. The loopback URL is refused by the SSRF guard before any connection.
    #[tokio::test]
    async fn test_http_plugin_install_from_a_url_downloads() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let home = tempfile::tempdir().unwrap();
        let server = HttpServer::new(store.clone()).with_plugin_home(home.path().to_path_buf());

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "id": "http://127.0.0.1:9/plugin.zip" }))
                    .unwrap(),
            })
            .await;
        assert_eq!(
            res.status, 400,
            "a refused download is not a successful install"
        );
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        assert!(
            val["error"]
                .as_str()
                .unwrap_or_default()
                .contains("private"),
            "the SSRF guard must be the refusal: {val}"
        );
        assert!(
            !home.path().join("plugins").exists(),
            "a refused download must leave no managed copy"
        );
    }

    #[tokio::test]
    async fn test_http_search_pagination_is_real() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        store.create_session("sess-p", Some("Paging")).unwrap();
        for i in 0..3 {
            let msgs = vec![crate::turn_loop::types::LLMMessage::user(format!(
                "pagination probe message {i}"
            ))];
            store
                .save_turn("sess-p", &format!("t{i}"), i + 1, &msgs, None, None)
                .unwrap();
        }
        let server = HttpServer::new(store.clone());
        let post_search = |body: Vec<u8>| HttpRequest {
            method: "POST".into(),
            path: "/api/v1/search".into(),
            query: None,
            headers: HashMap::new(),
            body,
        };

        // Page 1 of 3 with page_size 2: two items, more available, cursor set.
        let res1 = server
            .handle_request(&post_search(
                serde_json::to_vec(&json!({ "query": "pagination probe", "page_size": 2 }))
                    .unwrap(),
            ))
            .await;
        assert_eq!(res1.status, 200);
        let page1: Value = serde_json::from_slice(&res1.body).unwrap();
        assert_eq!(page1["items"].as_array().unwrap().len(), 2);
        assert_eq!(page1["has_more"], true);
        let cursor = page1["page_token"].as_str().expect("cursor must be set");

        // Page 2 follows the cursor: the remaining item, no more pages.
        let res2 = server
            .handle_request(&post_search(
                serde_json::to_vec(
                    &json!({ "query": "pagination probe", "page_size": 2, "page_token": cursor }),
                )
                .unwrap(),
            ))
            .await;
        assert_eq!(res2.status, 200);
        let page2: Value = serde_json::from_slice(&res2.body).unwrap();
        assert_eq!(page2["items"].as_array().unwrap().len(), 1);
        assert_eq!(page2["has_more"], false);
        assert!(page2["page_token"].is_null());

        // A garbage cursor is a client error, not silently page one.
        let res_bad = server
            .handle_request(&post_search(
                serde_json::to_vec(&json!({ "query": "pagination probe", "page_token": "nope" }))
                    .unwrap(),
            ))
            .await;
        assert_eq!(res_bad.status, 400);
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
        // v2 has no `error` status: a failed flow is `denied`/`expired`, and the
        // reason travels in `error_message`.
        assert!(
            matches!(
                val_login["status"].as_str(),
                Some("denied" | "expired" | "cancelled")
            ),
            "a failed start reports a terminal v2 status, got {}",
            val_login["status"]
        );
        assert!(
            val_login["error_message"].is_string(),
            "the failure reason must travel"
        );

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
        // Same vocabulary as the start route: a failed flow is a terminal v2
        // status carrying `error_message`, never `"error"`.
        assert!(
            matches!(
                val_poll["status"].as_str(),
                Some("denied" | "expired" | "cancelled")
            ),
            "got {}",
            val_poll["status"]
        );

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
        if let crate::events::EngineEvent::Custom(v) = &ev1.event {
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
        if let crate::events::EngineEvent::Custom(v) = &ev2.event {
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
        assert_eq!(sess_res.status, 200);
        let sess_val: Value = serde_json::from_slice(&sess_res.body).unwrap();
        let session_id = sess_val["id"].as_str().unwrap().to_string();

        let ev3 = sub.recv().await.unwrap();
        assert_eq!(&*ev3.session_id, &session_id);
        assert_eq!(ev3.event.event_type(), "event.session.created");
        if let crate::events::EngineEvent::Custom(v) = &ev3.event {
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
        if let crate::events::EngineEvent::Custom(v) = &ev4.event {
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
        if let crate::events::EngineEvent::Custom(v) = &ev5.event {
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
        server
            .store
            .create_session(sid, Some("FS Test Session"))
            .unwrap();
        server
            .store
            .put_state(
                "metadata",
                sid,
                &json!({ "cwd": work_dir.to_string_lossy() }),
            )
            .unwrap();

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
        assert_eq!(
            String::from_utf8_lossy(&dl_res.body),
            "Hello from native fs test!"
        );

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
        server
            .store
            .create_session(sid, Some("Terminal Test Session"))
            .unwrap();
        server
            .store
            .put_state(
                "metadata",
                sid,
                &json!({ "cwd": work_dir.to_string_lossy() }),
            )
            .unwrap();

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
                }))
                .unwrap(),
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
        server
            .store
            .create_session(sid, Some("Subagent Test Session"))
            .unwrap();

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
        assert!(caps.iter().any(|c| c["id"] == "subagents"));
    }

    #[tokio::test]
    async fn test_http_session_patch_and_undo() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());

        // 1. Create a session
        let create_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "title": "Initial Title" })).unwrap(),
            })
            .await;
        assert_eq!(create_res.status, 200);
        let create_val: Value = serde_json::from_slice(&create_res.body).unwrap();
        let sid = create_val["id"].as_str().unwrap();

        // 2. Patch session title and custom metadata using RFC 6902 JSON patch
        let patch_ops = json!([
            { "op": "replace", "path": "/title", "value": "Updated Title" },
            { "op": "add", "path": "/metadata/custom_tag", "value": "production" }
        ]);

        let patch_res = server
            .handle_request(&HttpRequest {
                method: "PATCH".into(),
                path: format!("/api/v1/sessions/{sid}"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&patch_ops).unwrap(),
            })
            .await;
        assert_eq!(patch_res.status, 200);
        let patch_val: Value = serde_json::from_slice(&patch_res.body).unwrap();
        assert_eq!(patch_val["session"]["title"], "Updated Title");
        assert_eq!(patch_val["session"]["metadata"]["custom_tag"], "production");
        assert!(patch_val["applied_patch"].is_object() || patch_val["applied_patch"].is_array());
        assert!(patch_val["undo_patch"].is_object() || patch_val["undo_patch"].is_array());

        // 3. Partial object patch via POST :patch
        let partial_update = json!({
            "title": "Object Patched Title",
            "metadata": { "client_version": "1.2.3" }
        });
        let post_patch_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}:patch"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&partial_update).unwrap(),
            })
            .await;
        assert_eq!(post_patch_res.status, 200);
        let post_patch_val: Value = serde_json::from_slice(&post_patch_res.body).unwrap();
        assert_eq!(post_patch_val["session"]["title"], "Object Patched Title");
        assert_eq!(
            post_patch_val["session"]["metadata"]["client_version"],
            "1.2.3"
        );
        assert_eq!(
            post_patch_val["session"]["metadata"]["custom_tag"],
            "production"
        );

        // 4. Undo the last patch
        let undo_res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}:undo_patch"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(undo_res.status, 200);
        let undo_val: Value = serde_json::from_slice(&undo_res.body).unwrap();
        assert_eq!(undo_val["session"]["title"], "Updated Title");
    }

    /// `POST :undo` with `revert_files` reverts the workspace files of the
    /// turns it actually removed —the file history is keyed by turn *number*,
    /// so passing the undo *count* used to restore the wrong turn.
    #[tokio::test]
    async fn test_http_undo_reverts_files_of_the_undone_turn() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = HttpServer::new(store.clone());
        let sid = "sess-undo-files";
        store.create_session(sid, None).unwrap();
        store
            .put_state(
                "metadata",
                sid,
                &json!({ "cwd": temp.path().display().to_string() }),
            )
            .unwrap();

        let msgs = vec![crate::turn_loop::types::LLMMessage::user("hi")];
        store.save_turn(sid, "t1", 1, &msgs, None, None).unwrap();
        store.save_turn(sid, "t2", 2, &msgs, None, None).unwrap();
        std::fs::write(temp.path().join("a.txt"), "after-1").unwrap();
        std::fs::write(temp.path().join("b.txt"), "after-2").unwrap();
        store
            .record_file_change(sid, 1, "a.txt", Some("before-1"), Some("after-1"))
            .unwrap();
        store
            .record_file_change(sid, 2, "b.txt", Some("before-2"), Some("after-2"))
            .unwrap();

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}:undo"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "count": 1, "revert_files": true })).unwrap(),
            })
            .await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["undone"], 1);

        // Only the removed turn's file is restored.
        assert_eq!(
            std::fs::read_to_string(temp.path().join("b.txt")).unwrap(),
            "before-2"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("a.txt")).unwrap(),
            "after-1"
        );
    }

    #[tokio::test]
    async fn test_http_compact_without_summarizer_preserves_history() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let hub = Arc::new(EventHub::new());
        let server = HttpServer::with_hub(store.clone(), hub.clone());
        let sid = "sess-compact-http";
        store.create_session(sid, None).unwrap();
        for i in 1..=12 {
            let filler = "x".repeat(400);
            store
                .save_turn(
                    sid,
                    &format!("t{i}"),
                    i,
                    &[
                        crate::turn_loop::types::LLMMessage::user(format!("u{i} {filler}")),
                        crate::turn_loop::types::LLMMessage::assistant(format!("a{i} {filler}")),
                    ],
                    None,
                    None,
                )
                .unwrap();
        }

        let original_history =
            serde_json::to_value(store.load_session_history(sid).unwrap()).unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let collector = seen.clone();
        hub.bus_for(sid).subscribe(move |event| {
            if let crate::events::types::EngineEvent::Custom(value) = event {
                collector
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(value.clone());
            }
        });

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}:compact"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "instruction": "keep decisions" })).unwrap(),
            })
            .await;
        // No engine is bound, so the mandatory-summary prerequisites fail
        // before any history is touched: a 503 naming the configuration
        // problem, not a mid-request 500. History is untouched and no
        // completion event is published.
        assert_eq!(res.status, 503);
        assert!(
            serde_json::from_slice::<Value>(&res.body).unwrap()["error"]
                .as_str()
                .unwrap()
                .contains("no engine"),
        );
        assert_eq!(
            serde_json::to_value(store.load_session_history(sid).unwrap()).unwrap(),
            original_history,
        );
        let events = seen.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert!(
            !events
                .iter()
                .any(|event| event["type"] == "compaction.completed")
        );
    }

    /// A host whose `llm_chat` answers with a fixed summary, so the `:compact`
    /// route's summarizer call can be observed end to end.
    struct SummarizingHost {
        summary: String,
    }

    impl crate::callbacks::HostCallbacks for SummarizingHost {
        fn llm_chat(
            &self,
            _: crate::rpc::types::LlmChatRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
        {
            let summary = self.summary.clone();
            Box::pin(async move {
                Ok(crate::rpc::types::LlmChatResponse {
                    content: summary,
                    tool_calls: vec![],
                    thinking: vec![],
                    finish_reason: Some("stop".to_string()),
                    usage: crate::rpc::types::TokenUsage::default(),
                })
            })
        }

        fn execute_tool(
            &self,
            _: crate::rpc::types::ToolExecuteRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: crate::rpc::types::PermissionCheckRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async { Ok(crate::rpc::types::PermissionDecision::allow()) })
        }
    }

    /// `POST :compact` folds the omitted prefix into the session model's
    /// written summary. The endpoint used to write the fixed placeholder even
    /// with an engine attached, so the same action produced different history
    /// depending on whether the client went through REST or NAPI.
    #[tokio::test]
    async fn the_compact_route_writes_the_llm_summary_not_the_placeholder() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let hub = Arc::new(EventHub::new());
        let sid = "sess-compact-summary";
        store.create_session(sid, None).unwrap();
        for i in 1..=12 {
            let filler = "x".repeat(400);
            store
                .save_turn(
                    sid,
                    &format!("t{i}"),
                    i,
                    &[
                        crate::turn_loop::types::LLMMessage::user(format!("u{i} {filler}")),
                        crate::turn_loop::types::LLMMessage::assistant(format!("a{i} {filler}")),
                    ],
                    None,
                    None,
                )
                .unwrap();
        }

        // A provider-backed spec: `build_llm_for_spec` resolves it to a
        // host-proxy LLM, which is the seam the factory below answers.
        let engine = ServerEngine::new(
            crate::pipeline::PipelineSpec {
                system_prompt: "sys".into(),
                model_name: "test-model".into(),
                providers: vec![crate::pipeline::PipelineProvider {
                    name: "test".into(),
                    system_prompt: "sys".into(),
                    model: "test-model".into(),
                    native: None,
                }],
                native_llm: None,
                workspace_root: None,
                native_tools: false,
                extra_roots: Vec::new(),
                rust_self_contained: true,
                shell_path: None,
                policy_snapshot: None,
                github_token: None,
                github_base_url: None,
                subagent_timeout_ms: None,
                agent_tool_veto: None,
                tools_veto: None,
                todo_tool_veto: None,
                tower_worktree_root: None,
                tower_enabled: false,
                tool_select: false,
                sandbox_mode: None,
                sandbox_policy: None,
                caller_agent_id: None,
                session_id: None,
                secondary_model: None,
                image_read_byte_budget: None,
                image_max_edge_px: None,
                model_capabilities: None,
                skill_dirs: Vec::new(),
                background: crate::storage::BackgroundLimits::default(),
            },
            hub.clone(),
            store.clone(),
        );
        engine.set_host_factory(Arc::new(|_session_id| {
            Arc::new(SummarizingHost {
                summary: "The user sent twelve filler messages.".to_string(),
            })
        }));
        let server = HttpServer::with_hub(store.clone(), hub).with_engine(engine);

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}:compact"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({})).unwrap(),
            })
            .await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["compacted"], true);

        let history = store.load_session_history(sid).unwrap();
        assert_eq!(
            history[1].content, "The user sent twelve filler messages.",
            "the endpoint must store the model's summary, not the placeholder"
        );
    }

    /// `mcp/auth:begin` + `:complete` drive the RFC 8628 flow and persist the
    /// credentials; `auth-statuses` reports them and `:reset` clears them.
    #[tokio::test]
    async fn test_http_mcp_auth_device_flow() {
        let (url, _hits, _shutdown) =
            crate::mcp::oauth::device::test_helpers::spawn_mock_oauth_server(vec![
                (
                    200,
                    r#"{"device_code":"dev-1","user_code":"ABCD","verification_uri":"https://example.test/device","expires_in":60,"interval":0}"#,
                ),
                (400, r#"{"error":"authorization_pending"}"#),
                (
                    200,
                    r#"{"access_token":"mcp-token","refresh_token":"r1","expires_in":3600}"#,
                ),
            ])
            .await;

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(crate::mcp::oauth::McpOAuthService::new(Arc::new(
            crate::mcp::oauth::McpOAuthFileStore::new(dir.path()),
        )));
        let server = HttpServer::new(store).with_mcp_oauth_service(service).await;

        let begin = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/mcp/auth:begin".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "name": "srv",
                    "device_authorization_endpoint": url,
                    "client_id": "client-1"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(begin.status, 200);
        let begin_body: Value = serde_json::from_slice(&begin.body).unwrap();
        assert_eq!(begin_body["user_code"], "ABCD");
        assert_eq!(
            begin_body["verification_uri"],
            "https://example.test/device"
        );

        let complete = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/mcp/auth:complete".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "name": "srv",
                    "url": "https://example.test/mcp",
                    "device_code": "dev-1",
                    "token_endpoint": url,
                    "client_id": "client-1",
                    "interval": 0,
                    "expires_in": 60
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(complete.status, 200);
        let complete_body: Value = serde_json::from_slice(&complete.body).unwrap();
        assert_eq!(complete_body["authenticated"], true);

        let statuses = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/mcp/auth-statuses".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let statuses_body: Value = serde_json::from_slice(&statuses.body).unwrap();
        let key =
            crate::mcp::oauth::mcp_oauth_store_key("srv", "https://example.test/mcp").unwrap();
        assert_eq!(statuses_body["statuses"][&key]["authenticated"], true);
        assert_eq!(statuses_body["statuses"][&key]["status"], "authenticated");
        // A usable token is required: an empty credentials dir reports no key
        // at all, and a stored-but-unusable key must say `needs-auth` rather
        // than a fabricated `true` (covered by the OAuth service's own tests).

        let reset = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/mcp/auth:reset".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "name": "srv",
                    "url": "https://example.test/mcp"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(reset.status, 200);
        let reset_body: Value = serde_json::from_slice(&reset.body).unwrap();
        assert_eq!(reset_body["removed"], true);
    }

    #[tokio::test]
    async fn test_http_session_events_and_projection() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let hub = Arc::new(EventHub::new());
        let server = HttpServer::with_hub(store.clone(), hub.clone());

        let sid = "sess-event-http";
        store
            .create_session(sid, Some("Event Stream Test"))
            .unwrap();

        // 1. Publish events onto hub lane -> automatically captured by persister into wire_events
        let bus = hub.bus_for(sid);
        bus.publish(&crate::events::EngineEvent::Custom(json!({
            "type": "message.user",
            "content": "What is the capital of France?"
        })));
        bus.publish(&crate::events::EngineEvent::Custom(json!({
            "type": "message.assistant",
            "content": "The capital of France is Paris."
        })));

        // 2. GET /api/v1/sessions/:id/events (both /events and :events)
        let res_events_slash = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/events"),
                query: Some("since=0&limit=10".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_events_slash.status, 200);
        let val_slash: Value = serde_json::from_slice(&res_events_slash.body).unwrap();
        assert_eq!(val_slash["sessionId"], sid);
        assert_eq!(val_slash["events"].as_array().unwrap().len(), 2);
        assert_eq!(val_slash["total"], 2);

        let res_events_colon = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}:events"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_events_colon.status, 200);

        // 3. GET /api/v1/sessions/:id/projection
        let res_proj = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/projection"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_proj.status, 200);
        let val_proj: Value = serde_json::from_slice(&res_proj.body).unwrap();
        let msgs = val_proj["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "What is the capital of France?");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "The capital of France is Paris.");

        // 4. POST /api/v1/sessions/:id/events:compact
        let res_compact = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}:events:compact"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "summary": "Paris geography summary" })).unwrap(),
            })
            .await;
        assert_eq!(res_compact.status, 200);

        // Projection after compaction must reflect summary
        let res_proj_after = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}:projection"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_proj_after.status, 200);
        let val_proj_after: Value = serde_json::from_slice(&res_proj_after.body).unwrap();
        let msgs_after = val_proj_after["messages"].as_array().unwrap();
        assert_eq!(msgs_after.len(), 1);
        assert_eq!(msgs_after[0]["role"], "system");
        assert_eq!(msgs_after[0]["content"], "Paris geography summary");
    }

    #[tokio::test]
    async fn test_http_transcript_routes() {
        let server = HttpServer::in_memory().unwrap();
        let sid = "sess-transcript";
        server
            .store
            .create_session(sid, Some("Transcript"))
            .unwrap();

        let mut assistant = crate::turn_loop::types::LLMMessage::new("assistant", "hello");
        assistant.tool_calls = vec![crate::turn_loop::types::ToolCall {
            id: "c1".into(),
            name: "ExitPlanMode".into(),
            arguments: json!({}),
            extras: None,
        }];
        let mut tool = crate::turn_loop::types::LLMMessage::new(
            "tool",
            "Plan saved to: /tmp/plan.md\n## Approved Plan:\ndo the thing",
        );
        tool.tool_call_id = Some("c1".into());
        let messages = vec![
            crate::turn_loop::types::LLMMessage::new("user", "start the work"),
            assistant,
            tool,
        ];
        server
            .store
            .save_turn(sid, "turn-1", 1, &messages, None, None)
            .unwrap();

        let transcript = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/transcript"),
                query: Some("agent_id=main".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(transcript.status, 200);
        let val: Value = serde_json::from_slice(&transcript.body).unwrap();
        assert_eq!(val["agent_id"], "main");
        assert_eq!(val["items"].as_array().unwrap().len(), 1);
        assert_eq!(val["items"][0]["prompt"], "start the work");
        assert_eq!(val["items"][0]["steps"][0]["frames"][1]["state"], "done");

        let user_messages = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/transcript/user-messages"),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(user_messages.status, 200);
        let um: Value = serde_json::from_slice(&user_messages.body).unwrap();
        assert_eq!(um["agents"][0]["messages"][0]["prompt"], "start the work");

        let plan = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/transcript/plan"),
                query: Some("agent_id=main&tool_call_id=c1".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(plan.status, 200);
        let plan_val: Value = serde_json::from_slice(&plan.body).unwrap();
        assert_eq!(plan_val["plans"].as_array().unwrap().len(), 1);
        assert_eq!(plan_val["plans"][0]["path"], "/tmp/plan.md");

        let ops = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/transcript/ops"),
                query: Some("agent_id=main&since_seq=0".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(ops.status, 200);
        let ops_val: Value = serde_json::from_slice(&ops.body).unwrap();
        assert_eq!(ops_val["complete"], false);

        // With a persisted journal the catch-up serves an idempotent reset
        // batch instead of falling back to a full refresh.
        server
            .hub()
            .bus_for(sid)
            .publish(&crate::events::EngineEvent::LlmStepBegin {
                turn_id: "turn-1".into(),
                step: 1,
            });
        let ops_after = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/transcript/ops"),
                query: Some("agent_id=main&since_seq=0".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let ops_after_val: Value = serde_json::from_slice(&ops_after.body).unwrap();
        assert_eq!(ops_after_val["complete"], true);
        assert_eq!(ops_after_val["batches"][0]["ops"][0]["op"], "reset");
        assert!(
            ops_after_val["batches"][0]["seq"].as_u64().unwrap() > 0,
            "batch carries the journal seq"
        );
    }

    #[test]
    fn prompt_content_maps_uploaded_files_to_media_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let files = crate::server::files::FileStore::with_root(dir.path().to_path_buf());
        let png = files
            .save("photo.png", "image/png", None, &[0x89, 0x50, 0x4e, 0x47])
            .unwrap();
        let pdf = files
            .save("doc.pdf", "application/pdf", None, b"%PDF-1.4")
            .unwrap();

        let content = vec![
            json!({ "type": "text", "text": "look at this" }),
            json!({ "type": "image", "source": { "kind": "file", "file_id": png.id } }),
            json!({
                "type": "file",
                "file_id": pdf.id,
                "name": "doc.pdf",
                "media_type": "application/pdf",
                "size": 8,
            }),
        ];
        let (prompt, blocks) = prompt_content_to_blocks(&content, &files).unwrap();
        assert_eq!(prompt, "look at this");
        assert_eq!(blocks.len(), 2);
        // The bytes stay in the store: the engine's resolver reads them once
        // it knows which model the turn runs on.
        match &blocks[0] {
            crate::rpc::types::ContentBlock::MediaRef { file_id, kind } => {
                assert_eq!(file_id, &png.id);
                assert_eq!(*kind, crate::rpc::types::MediaKind::Image);
            }
            other => panic!("expected a media reference, got {other:?}"),
        }
        match &blocks[1] {
            crate::rpc::types::ContentBlock::Text { text } => {
                assert!(text.contains("doc.pdf"));
                assert!(text.contains("application/pdf"));
            }
            other => panic!("expected text fallback, got {other:?}"),
        }
    }

    /// ROADMAP #3747b: an inline base64 image over the model's pixel/byte
    /// budget is compressed at intake, the original persisted, and a caption
    /// naming both precedes the image — the HTTP path's half of v2's
    /// `resolvePromptMediaFiles` (the TUI path does it host-side).
    #[test]
    fn prompt_content_compresses_an_over_budget_inline_image_with_a_caption() {
        let dir = tempfile::tempdir().unwrap();
        let files = crate::server::files::FileStore::with_root(dir.path().to_path_buf());
        let img = image::RgbImage::from_fn(4000, 3000, |x, y| {
            image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD.encode(&png);

        let content = vec![
            json!({ "type": "text", "text": "look at this" }),
            json!({
                "type": "image",
                "name": "shot.png",
                "source": { "kind": "base64", "media_type": "image/png", "data": data },
            }),
        ];
        let (prompt, blocks) = prompt_content_to_blocks(&content, &files).unwrap();
        assert_eq!(prompt, "look at this");
        assert_eq!(blocks.len(), 2, "the caption precedes the compressed image");

        match &blocks[0] {
            crate::rpc::types::ContentBlock::Text { text } => {
                assert!(text.starts_with(
                    "<system>Image compressed to fit model limits: original 4000x3000,"
                ));
                assert!(text.contains("call Read on that path"));
            }
            other => panic!("expected the compression caption, got {other:?}"),
        }
        match &blocks[1] {
            crate::rpc::types::ContentBlock::Image {
                media_type,
                data: sent,
                name,
            } => {
                assert_eq!(name.as_deref(), Some("shot.png"));
                assert!(media_type.starts_with("image/"));
                assert_ne!(sent, &data, "the sent bytes are the compressed ones");
            }
            other => panic!("expected the compressed image, got {other:?}"),
        }
    }

    #[test]
    fn prompt_content_rejects_an_unknown_file_id() {
        let dir = tempfile::tempdir().unwrap();
        let files = crate::server::files::FileStore::with_root(dir.path().to_path_buf());
        let content =
            vec![json!({ "type": "image", "source": { "kind": "file", "file_id": "f_missing" } })];
        assert!(prompt_content_to_blocks(&content, &files).is_err());
    }

    /// `POST /api/v1/prompts` used to mint an id and answer
    /// `{"status":"enqueued"}` without touching the queue. It now delegates to
    /// the session submit path: missing session / unknown session / no engine
    /// all refuse instead of issuing a receipt for a prompt that never runs.
    #[tokio::test]
    async fn collection_prompt_route_refuses_instead_of_faking_enqueue() {
        let server = HttpServer::in_memory().unwrap();

        let missing_session = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/prompts".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "prompt": "hi" })).unwrap(),
            })
            .await;
        assert_eq!(missing_session.status, 400, "session_id is required");
        assert!(
            !String::from_utf8_lossy(&missing_session.body).contains("enqueued"),
            "the fake enqueue receipt is still being served"
        );

        server
            .store
            .create_session("sess-collection", Some("c"))
            .unwrap();
        let unknown_session = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/prompts".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "session_id": "sess-does-not-exist",
                    "prompt": "hi",
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(unknown_session.status, 404);

        let no_engine = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/prompts".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "session_id": "sess-collection",
                    "prompt": "hi",
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(no_engine.status, 503, "no engine attached");

        // Nothing was ever admitted to the queue by the fake path.
        assert!(
            server.prompt_queue.snapshot("sess-collection").0.is_none(),
            "a refused submit must not leave a phantom active prompt"
        );
    }

    /// `fs:open` / `fs:reveal` used to answer success without launching
    /// anything. They now resolve the path (denying traversal) and report the
    /// launcher's error rather than a fabricated `{"opened":true}`. The launch
    /// itself is environment-dependent, so the assertions cover the paths that
    /// are deterministic: a traversal attempt and a missing `path` field.
    #[tokio::test]
    async fn fs_open_routes_do_not_report_success_for_rejected_paths() {
        let server = HttpServer::in_memory().unwrap();
        let sid = "sess-fs-open";
        server.store.create_session(sid, Some("fs")).unwrap();

        let missing_field = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/fs:open"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({})).unwrap(),
            })
            .await;
        assert_eq!(missing_field.status, 400);

        let traversal = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/fs:reveal"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "path": "../../etc/passwd" })).unwrap(),
            })
            .await;
        assert_ne!(
            traversal.status, 200,
            "a traversal path must not report success"
        );
        assert!(
            !String::from_utf8_lossy(&traversal.body).contains("\"revealed\":true"),
            "the fake reveal success is still being served"
        );
    }

    /// `fs:open-in` is wired: an unknown app id reports the valid set instead
    /// of answering `{"opened":true}`.
    #[tokio::test]
    async fn fs_open_in_rejects_unknown_app() {
        let server = HttpServer::in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.txt"), "x").unwrap();
        let ws = server
            .store
            .create_workspace(&dir.path().to_string_lossy(), Some("open-in WS"))
            .unwrap();
        let sid = "sess-open-in";
        server
            .store
            .create_session_with_workspace(sid, Some("oi"), Some(&ws.id))
            .unwrap();

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/fs:open-in"),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "path": "x.txt", "app": "photoshop" })).unwrap(),
            })
            .await;
        assert_ne!(res.status, 200, "an unknown app must not report success");
        assert!(
            String::from_utf8_lossy(&res.body).contains("Unsupported app"),
            "{}",
            String::from_utf8_lossy(&res.body)
        );
    }

    // A session whose turn is streaming right now answers history with
    // `in_flight` — the same turn/step entity ids the live deltas carry —
    // so a reconnecting client splices at the right position (upstream
    // `projection.inFlight`).

    // The official Web bundle's listSessionsV2/archiveSessions/restoreSessions
    // contract (upstream routes/v2/sessions.ts): a domain-grouped page plus
    // per-item batch results.
    #[tokio::test]
    async fn v2_sessions_contract_serves_the_official_web_bundle() {
        let server = HttpServer::in_memory().unwrap();
        server
            .store
            .create_workspace("G:/kimi/kimi-code", Some("kimi-code"))
            .ok();
        let ws_id = server.store.list_workspaces().unwrap_or_default()[0]
            .id
            .clone();
        server
            .store
            .create_session_with_workspace("sess-v2-a", Some("Contract"), Some(&ws_id))
            .unwrap();
        server
            .store
            .save_turn(
                "sess-v2-a",
                "turn-1",
                1,
                &[crate::turn_loop::types::LLMMessage::user("hi")],
                None,
                None,
            )
            .unwrap();

        // GET /api/v2/sessions answers the v2SessionPageSchema envelope with
        // domain-grouped items.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v2/sessions".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(
            body["total"],
            body["items"].as_array().map(|i| i.len()).unwrap()
        );
        assert_eq!(body["has_more"], false);
        assert!(body["next_page_token"].is_null());
        let first = &body["items"][0];
        assert_eq!(first["id"], "sess-v2-a");
        // Title may be null for a session created without one; the bundle
        // falls back to last_prompt then the id prefix.
        assert!(first["meta"]["title"].is_null() || first["meta"]["title"].is_string());
        assert!(first["meta"]["archived"].is_boolean());
        assert!(
            ["running", "approval", "question", "failed", "idle"]
                .contains(&first["activity"]["status"].as_str().unwrap())
        );

        // view=by_workspace (the sessions sidebar's first load) returns
        // per-workspace groups: the workspace object plus the first
        // group.page_size sessions of that workspace.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v2/sessions".into(),
                query: Some("view=by_workspace&group.page_size=5&meta.has_prompt=true".into()),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        let groups = body["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1, "one workspace holds the session");
        assert_eq!(groups[0]["workspace"]["cwd"], "G:/kimi/kimi-code");
        assert_eq!(groups[0]["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(groups[0]["total"], 1);

        // Batch archive: {ids} in, per-item results out — a missing session
        // folds into its own item instead of failing the batch.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v2/sessions:archive".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "ids": ["sess-v2-a", "sess-v2-missing"]
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["succeeded"], 1);
        assert_eq!(body["failed"], 1);
        assert_eq!(body["results"][0]["ok"], true);
        assert_eq!(body["results"][1]["ok"], false);

        // The archived flag is visible on the item after the batch.
        let res = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v2/sessions".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        let archived = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == "sess-v2-a")
            .unwrap()["meta"]["archived"]
            .clone();
        assert_eq!(archived, true);

        // Restore flips it back.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v2/sessions:restore".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "ids": ["sess-v2-a"] })).unwrap(),
            })
            .await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["succeeded"], 1);
    }

    /// Every shape here is read off the shipped `dist-web` bundle's API client;
    /// each assertion fails against the response the route used to serve, which
    /// is what made the corresponding Web feature unusable.
    #[tokio::test]
    async fn the_web_bundle_contract_holds_for_the_shapes_it_maps_directly() {
        let server = HttpServer::in_memory().unwrap();
        server
            .store
            .create_workspace("G:/kimi/kimi-code", Some("kimi-code"))
            .ok();
        let ws_id = server.store.list_workspaces().unwrap_or_default()[0]
            .id
            .clone();
        server
            .store
            .create_session_with_workspace("sess-wire", Some("Wire"), Some(&ws_id))
            .unwrap();
        server
            .store
            .save_turn(
                "sess-wire",
                "turn-1",
                1,
                &[crate::turn_loop::types::LLMMessage::user("hi")],
                None,
                None,
            )
            .unwrap();

        // Every shape here is read off the shipped `dist-web` bundle's API client;
        // each assertion fails against the response the route used to serve, which
        // is what made the corresponding Web feature unusable.
        async fn get(server: &HttpServer, path: &str) -> HttpResponse {
            server
                .handle_request(&HttpRequest {
                    method: "GET".into(),
                    path: path.into(),
                    query: None,
                    headers: HashMap::new(),
                    body: Vec::new(),
                })
                .await
        }

        // v2 `GET /sessions/{session_id}` answers the bare session document
        // (`sessionSchema`), which is why the mapper can read `metadata.cwd`
        // straight off the top level.
        let res = get(&server, "/api/v1/sessions/sess-wire").await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(body["id"], "sess-wire");
        // `format_wire_session` falls back to the process cwd when the session
        // never recorded one; the contract being pinned is that `metadata.cwd`
        // is a string at the top level, which is what the mapper dereferences.
        assert!(
            body["metadata"]["cwd"].is_string(),
            "the mapper reads `e.metadata.cwd` unconditionally"
        );
        assert!(body["agent_config"]["model"].is_string());
        assert!(
            body.get("messages").is_none(),
            "messages live on `/messages`, not on the session document"
        );

        // v2 `listMessagesResponseSchema` is `{items, has_more}`.
        let res = get(&server, "/api/v1/sessions/sess-wire/messages").await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert!(body.get("items").is_some() || body.get("messages").is_some());

        // v2 `listTasks` answers `pageResponseSchema(taskSchema)`: `{items}`,
        // every element carrying the protocol field names including
        // `run_in_background`.
        let res = get(&server, "/api/v1/sessions/sess-wire/tasks").await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        let items = body["items"].as_array().expect("`items` key");
        assert!(items.is_empty(), "no task was spawned in this test");

        // v2 `getSessionGoalResponseSchema = goalSnapshotSchema.nullable()`, so
        // an inactive goal is `null` — never a wrapper object.
        let res = get(&server, "/api/v1/sessions/sess-wire/goal").await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert!(
            body.is_null(),
            "no active goal reads as null, matching goalSnapshotSchema.nullable()"
        );

        // `getSessionStatus` reads the session's real profile; these used to be
        // the literals "auto" / "medium" with five fields absent entirely.
        let res = get(&server, "/api/v1/sessions/sess-wire/status").await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        for key in [
            "permission",
            "thinking_level",
            "plan_mode",
            "swarm_mode",
            "tower_mode",
            "max_context_tokens",
            "context_usage",
        ] {
            assert!(body.get(key).is_some(), "status field `{key}` is served");
        }
        assert!(body["max_context_tokens"].as_u64().unwrap() > 0);

        // `listCapabilities` filters on `supported`, so the elements must be
        // objects — a bare id array made every row disappear.
        let res = get(&server, "/api/v1/capabilities").await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        let caps = body["capabilities"].as_array().unwrap();
        assert!(!caps.is_empty());
        assert!(caps.iter().all(|c| c["supported"] == true));
        assert!(caps.iter().all(|c| c["id"].is_string()));

        // `pollOAuthLogin` reads snake_case and treats `authenticated` as the
        // terminal success; no flow is running, so the body is null.
        let res = get(&server, "/api/v1/oauth/login").await;
        assert_eq!(res.status, 200);
        let body: Value = serde_json::from_slice(&res.body).unwrap();
        assert!(body.is_null(), "no live flow reads as null");

        // The bundle's `installPlugin` posts `{ source }`, which used to 400 as
        // "Missing plugin id" because only `id` / `name` were read.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/plugins".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "source": "definitely-not-a-plugin" })).unwrap(),
            })
            .await;
        assert_ne!(
            res.status, 400,
            "a `source`-only body must reach the installer, not be rejected as malformed"
        );

        // The bundle spells the suggest route with a single colon; only the
        // `search` sibling accepted that form, so every file-mention request
        // paid a 404 round-trip first.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/workspace/fs:suggest".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({})).unwrap(),
            })
            .await;
        assert_ne!(res.status, 404, "single-colon fs:suggest is routed");
    }
}
