//! Server-level shared state — the engine state that method families must
//! share (session manager, host callbacks, approval store, permission gate).
//! Mirrors how main.rs assembles these once and passes clones to handlers;
//! here the processors borrow from a single `ServerState`.

use std::sync::Arc;

use kimi_agent::approval::{ApprovalStore, SharedApprovalStore};
use kimi_agent::callbacks::HostCallbacks;
use kimi_agent::permission::gate::PermissionGate;
use kimi_agent::persistence::{SessionStore, SqliteStore};
use kimi_agent::plugin::store::PluginStore;
use kimi_agent::session::manager::SessionManager;
use tokio::sync::Mutex;

use crate::callbacks::ToolExecuteStep;



/// Open the engine's session store (`$KIMI_AGENT_HOME/sessions.db` or
/// in-memory) — mirrors `open_session_store` in main.rs.
pub fn open_session_store() -> anyhow::Result<SqliteStore> {
    match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = std::path::Path::new(dir.trim()).join("sessions.db");
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            SqliteStore::open(&path)
        }
        _ => SqliteStore::in_memory(),
    }
}

/// Open the engine's plugin store (`$KIMI_AGENT_HOME/plugins.db` or
/// in-memory) — mirrors `PluginProcessor::with_manager` / main.rs.
pub fn open_plugin_store() -> anyhow::Result<PluginStore> {
    match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = std::path::Path::new(dir.trim()).join("plugins.db");
            SqliteStore::open(&path).map(PluginStore::new)
        }
        _ => SqliteStore::in_memory().map(PluginStore::new),
    }
}

/// The engine's plugin directory under `$KIMI_AGENT_HOME` (or a temp dir
/// when unset), matching main.rs / `PluginProcessor`.
pub fn plugins_dir() -> std::path::PathBuf {
    match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => std::path::Path::new(&dir).join("plugins"),
        _ => std::env::temp_dir().join("kimi-plugins"),
    }
}

/// Shared engine state for all method families.
#[derive(Clone)]
pub struct ServerState {
    /// Session lifecycle + agent registry.
    pub manager: Arc<Mutex<SessionManager>>,
    /// Host back-channel (events fan out here).
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Engine event fan-out (interface layer subscribes).
    pub events: crate::callbacks::EventBus,
    /// Web-facing approval store (shared with session agents).
    pub approval: SharedApprovalStore,
    /// Process-wide permission gate (shared with session agents).
    pub permission: PermissionGate,
    /// Shared host-tool step handle — the SDK harness installs its per-session
    /// tool handler here at runtime (`Session.setToolHandler`).
    pub tool_step: std::sync::Arc<std::sync::Mutex<Option<ToolExecuteStep>>>,
    /// Plugin store shared by `plugin/*` methods and the `session/create`
    /// injection path (enabled plugins contribute skills / MCP servers /
    /// hooks / system-prompt sections).
    pub plugin_store: Arc<PluginStore>,
    /// Plugin install directory (resolves github/url plugin roots).
    pub plugin_dir: std::path::PathBuf,
}

impl ServerState {
    /// Assemble fresh shared state (own store, own approval/permission).
    pub fn new() -> anyhow::Result<Self> {
        Self::assemble(None)
    }

    /// Assemble shared state with an LLM step override installed on the host
    /// callbacks (SDK runtime-test hook; mirrors TS `createKimiHarness`'s
    /// `llmStep`). Without one, `llm_chat` reports "not configured".
    pub fn with_llm_step(step: crate::callbacks::LlmStep) -> anyhow::Result<Self> {
        Self::assemble(Some(step))
    }

    fn assemble(llm_step: Option<crate::callbacks::LlmStep>) -> anyhow::Result<Self> {
        let store = open_session_store()?;
        let manager = Arc::new(Mutex::new(SessionManager::new(SessionStore::new(store))));
        let events = crate::callbacks::EventBus::new(256);
        let mut callbacks = crate::callbacks::ServerHostCallbacks::with_events(events.clone());
        if let Some(step) = llm_step {
            callbacks = callbacks.with_llm_step(step);
        }
        let tool_step = callbacks.tool_step_handle();
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(callbacks);
        let approval = Arc::new(ApprovalStore::new());
        let permission = PermissionGate::from_env();
        let plugin_store = open_plugin_store()?;
        let _ = plugin_store.init();
        Ok(Self {
            manager,
            callbacks,
            events,
            approval,
            permission,
            tool_step,
            plugin_store: Arc::new(plugin_store),
            plugin_dir: plugins_dir(),
        })
    }

    /// Subscribe to engine events (interface layer / tests).
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<serde_json::Value> {
        self.events.subscribe()
    }

    /// Clone the engine event sender, so transports (e.g. the HTTP/WS
    /// projection) can fan engine events out to every connected client.
    pub fn event_sender(&self) -> tokio::sync::broadcast::Sender<serde_json::Value> {
        self.events.sender()
    }
}
