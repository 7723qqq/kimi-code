//! The host seam and turn driver for a server process that has **no host**.
//!
//! Both product entries reach the engine through a `HostCallbacks`
//! implementation backed by a live JS side (`RpcHostCallbacks` over stdio,
//! `NapiHostCallbacks` over the addon). A standalone HTTP/WS server has nobody
//! behind that seam, and inventing a fifth implementation ad hoc is how legs
//! end up quietly hanging a request. This module owns the two pieces that
//! difference requires:
//!
//! - [`ServerHost`] — an explicit, documented answer for every leg the engine
//!   may call, so an unsupported capability fails fast with a message instead
//!   of blocking a socket;
//! - [`ServerEngine`] — builds an engine context on the shared pipeline with
//!   its events published onto the [`EventHub`]'s bus, runs one turn, and
//!   persists the resulting transcript.
//!
//! Note the asymmetry this deliberately keeps: a self-contained server selects
//! `native_llm` or `providers`, so `llm_chat` must never be reached. It is an
//! error rather than a stubbed-out success precisely so that a misconfiguration
//! surfaces as one.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::callbacks::HostCallbacks;
use crate::mcp::manager::McpManager;
use crate::pipeline::{PipelineHost, PipelineSpec, build_engine_pipeline};
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, BoxFuture, ContentBlock, LlmChatRequest,
    LlmChatResponse, PermissionCheckRequest, PermissionDecision, TokenUsage, ToolExecuteRequest,
    ToolExecuteResponse,
};
use crate::server::hub::EventHub;
use crate::server::interaction::InteractionManager;
use crate::session::sqlite_store::SqliteSessionStore;
use crate::subagent::SubagentManager;
use crate::turn_loop::run_turn::run_turn_continued;
use crate::turn_loop::types::{LLM, LLMMessage, RunTurnInput};

/// A host for standalone server execution with optional interactive interaction
/// support (questions and approvals).
#[derive(Clone, Default)]
pub struct ServerHost {
    interaction_manager: Option<Arc<InteractionManager>>,
    session_id: Option<String>,
    /// OAuth-managed token source for `auth_provider`-configured transports.
    oauth: Option<Arc<crate::server::oauth::OAuthManager>>,
}

impl ServerHost {
    pub fn standalone() -> Self {
        Self {
            interaction_manager: None,
            session_id: None,
            oauth: None,
        }
    }

    pub fn with_interaction(manager: Arc<InteractionManager>, session_id: String) -> Self {
        Self {
            interaction_manager: Some(manager),
            session_id: Some(session_id),
            oauth: None,
        }
    }

    /// Attach the OAuth token source so an OAuth-only provider
    /// (`[providers.*].oauth`, no static key) can fetch a bearer token.
    #[must_use]
    pub fn with_oauth(mut self, oauth: Option<Arc<crate::server::oauth::OAuthManager>>) -> Self {
        self.oauth = oauth;
        self
    }
}

impl HostCallbacks for ServerHost {
    /// OAuth-managed bearer token for `auth_provider`-configured transports.
    /// `managed_access_token` already refreshes an expired token and retries
    /// once on the host's 401/403 path, so `force` needs no separate handling.
    fn auth_token(
        &self,
        _provider: String,
        _force: bool,
    ) -> BoxFuture<'static, Result<String, String>> {
        match self.oauth.clone() {
            Some(oauth) => Box::pin(async move { oauth.managed_access_token().await }),
            None => Box::pin(async { Err("host does not support oauth token fetch".into()) }),
        }
    }
    /// The host-proxy LLM leg. Only reachable if a pipeline was built without
    /// `providers` or `native_llm`, which [`ServerEngine`] refuses up front.
    fn llm_chat(
        &self,
        _request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        Box::pin(async {
            Err(
                "this server has no LLM host: configure providers or native_llm \
                 (the engine runs self-contained)"
                    .into(),
            )
        })
    }

    /// Tools the sandboxed native toolset does not serve. Answering "not
    /// available" keeps a model from waiting forever on a host that cannot
    /// answer, and keeps a capability gap visible in the transcript.
    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        Box::pin(async move {
            Err(format!(
                "tool `{}` is not available in the standalone engine",
                request.tool_name
            ))
        })
    }

    /// Ask the host whether a mutating tool call may execute natively.
    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        if std::env::var("KIMI_AUTO_APPROVE")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false)
        {
            return Box::pin(async { Ok(PermissionDecision::allow()) });
        }
        if let (Some(mgr), Some(sid)) = (self.interaction_manager.clone(), self.session_id.clone())
        {
            Box::pin(async move {
                let (_aid, rx) = mgr.register_approval(&sid, request, "tool_execution");
                match rx.await {
                    Ok(decision) => Ok(decision),
                    Err(_) => Ok(PermissionDecision::deny("Interaction channel closed")),
                }
            })
        } else {
            Box::pin(async {
                Ok(PermissionDecision {
                    decision: "deny".into(),
                    reason: Some("no interactive approver in the standalone engine".into()),
                })
            })
        }
    }

    /// Ask the host an interactive question and wait for a human answer.
    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        if let (Some(mgr), Some(sid)) = (self.interaction_manager.clone(), self.session_id.clone())
        {
            Box::pin(async move {
                let rx = mgr.register_question(&sid, request);
                match rx.await {
                    Ok(resp) => Ok(resp),
                    Err(_) => Ok(AskQuestionResponse {
                        answers: HashMap::new(),
                        method: None,
                        note: None,
                        cancelled: Some(true),
                        reason: Some("interaction_cancelled".into()),
                    }),
                }
            })
        } else {
            Box::pin(async {
                Err(
                    "The connected client does not support interactive questions. \
                     Do NOT call this tool again. Ask the user directly in your text response instead."
                        .into(),
                )
            })
        }
    }
}

/// What one completed turn reports back to the caller.
#[derive(Debug, Clone)]
pub struct TurnReport {
    pub turn_id: String,
    pub stop_reason: String,
    /// The turn's final assistant text; empty when the loop ended without one.
    pub reply: String,
    pub steps: u32,
    pub usage: TokenUsage,
    /// Events the turn emitted through the counting wrapper — the same events
    /// that went out over the [`EventHub`].
    pub events_emitted: u32,
    pub llm_transport: String,
    pub native_tool_calls: u32,
}

/// Why a server-side turn could not run. Flattened to a message because the
/// turn loop's own error is a boxed trait object; a server reports this as
/// JSON, and keeping the chain of causes in a type buys nothing there.
#[derive(Debug)]
pub enum EngineError {
    /// No usable LLM was configured.
    NoModel(String),
    /// The turn loop itself failed.
    Turn(String),
    /// Persisting the turn failed.
    Store(rusqlite::Error),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoModel(why) => write!(f, "no model configured: {why}"),
            Self::Turn(why) => write!(f, "turn failed: {why}"),
            Self::Store(error) => write!(f, "session store error: {error}"),
        }
    }
}

impl std::error::Error for EngineError {}

/// Runs turns for the standalone server on a fixed configuration.
pub struct ServerEngine {
    spec: PipelineSpec,
    hub: Arc<EventHub>,
    store: Arc<SqliteSessionStore>,
    max_steps: u32,
    /// Host `loopControl.maxAttemptsPerStep` override (`None` = the engine
    /// default). Wired per host like `max_steps`; the session pump threads
    /// its own value instead.
    max_attempts: Option<u32>,
    active_turns: Mutex<HashMap<String, Arc<AtomicBool>>>,
    mcp_manager: Mutex<Option<Arc<McpManager>>>,
    interaction_manager: Mutex<Option<Arc<InteractionManager>>>,
    subagent_manager: Arc<SubagentManager>,
    /// OAuth token source for OAuth-bound providers; `None` until the server
    /// attaches one (see [`Self::set_oauth_manager`]).
    oauth_manager: Mutex<Option<Arc<crate::server::oauth::OAuthManager>>>,
    /// Per-session steering prompts queued while a turn is running; the turn
    /// drains them at each step head (`SteerQueueCallbacks::drain_steers`).
    steer_queues: Mutex<HashMap<String, Arc<Mutex<Vec<LLMMessage>>>>>,
    /// The server's live config handle, so a session model override can be
    /// re-resolved to its provider (base URL / key) rather than only renaming
    /// the model on the engine's base transport.
    config_source: Mutex<Option<Arc<tokio::sync::Mutex<Option<crate::config::KimiConfig>>>>>,
    /// Optional per-session host factory; non-HTTP hosts (ACP) install one to
    /// answer permission checks through their own transport.
    host_factory: Mutex<Option<HostFactory>>,
    /// Last published `agent.status.updated` payload hash per session, so a
    /// re-publish with unchanged state stays silent (kap-server dedups its
    /// legacy status the same way, by snapshot equality).
    status_hashes: Mutex<HashMap<String, u64>>,
    /// Per-session activity trackers (the `agent.status.updated` phase
    /// machine), shared with the interaction manager so a pending
    /// approval/question moves the phase too.
    activity_registry: Arc<crate::server::activity::ActivityRegistry>,
}

/// Builds the host callbacks for one session.
pub type HostFactory = Arc<dyn Fn(&str) -> Arc<dyn crate::callbacks::HostCallbacks> + Send + Sync>;

impl ServerEngine {
    pub fn new(spec: PipelineSpec, hub: Arc<EventHub>, store: Arc<SqliteSessionStore>) -> Self {
        Self {
            spec,
            activity_registry: Arc::new(crate::server::activity::ActivityRegistry::new(
                hub.clone(),
            )),
            hub,
            store: store.clone(),
            max_steps: 32,
            max_attempts: None,
            active_turns: Mutex::new(HashMap::new()),
            mcp_manager: Mutex::new(None),
            interaction_manager: Mutex::new(None),
            subagent_manager: Arc::new(SubagentManager::with_store(store)),
            oauth_manager: Mutex::new(None),
            steer_queues: Mutex::new(HashMap::new()),
            config_source: Mutex::new(None),
            host_factory: Mutex::new(None),
            status_hashes: Mutex::new(HashMap::new()),
        }
    }

    /// Install a per-session host factory (ACP permission bridge).
    pub fn set_host_factory(&self, factory: HostFactory) {
        *self.host_factory.lock().unwrap_or_else(|e| e.into_inner()) = Some(factory);
    }

    fn host_factory(&self) -> Option<HostFactory> {
        self.host_factory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Attach the OAuth token source so OAuth-bound providers can fetch bearer
    /// tokens on this engine's turns.
    pub fn set_oauth_manager(&self, manager: Arc<crate::server::oauth::OAuthManager>) {
        *self.oauth_manager.lock().unwrap_or_else(|e| e.into_inner()) = Some(manager);
    }

    /// Attach the server's config handle so per-session model overrides resolve
    /// to the right provider (base URL / key / protocol), not just a renamed
    /// model on the engine's base transport.
    pub fn set_config_source(
        &self,
        source: Arc<tokio::sync::Mutex<Option<crate::config::KimiConfig>>>,
    ) {
        *self.config_source.lock().unwrap_or_else(|e| e.into_inner()) = Some(source);
    }

    fn config_source(&self) -> Option<Arc<tokio::sync::Mutex<Option<crate::config::KimiConfig>>>> {
        self.config_source
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Build the native transport config for a model alias from the live
    /// config. `None` when the alias cannot be resolved (no provider / key).
    async fn resolved_native_llm(&self, model: &str) -> Option<crate::rpc::types::NativeLlmConfig> {
        let source = self.config_source()?;
        let config = {
            let guard = source.lock().await;
            guard.clone()
        }
        .unwrap_or_else(|| {
            crate::config::KimiConfig::discover()
                .map(|(config, _)| config)
                .unwrap_or_default()
        });
        let native = config.extract_native_llm(Some(model))?;
        Some(crate::rpc::types::NativeLlmConfig {
            protocol: native.protocol,
            base_url: native.base_url,
            api_key: native.api_key,
            model: native.model,
            max_tokens: native.max_tokens,
            custom_headers: native.custom_headers,
            reasoning_effort: config.resolve_effort(native.off_effort.as_deref()),
            thinking_budget: None,
            auth_provider: native.auth_provider.clone(),
            thinking_keep: config.resolve_thinking_keep(),
            beta_api: native.beta_api,
        })
    }

    fn oauth_manager(&self) -> Option<Arc<crate::server::oauth::OAuthManager>> {
        self.oauth_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Whether a turn is currently executing for `session_id`.
    pub fn is_turn_active(&self, session_id: &str) -> bool {
        self.active_turns.lock().unwrap().contains_key(session_id)
    }

    /// Queue a steering prompt for `session_id`'s active turn. Returns `false`
    /// when no turn is running, so the caller can answer "nothing to steer"
    /// rather than park the message until some later turn.
    pub fn enqueue_steer(&self, session_id: &str, message: LLMMessage) -> bool {
        if !self.is_turn_active(session_id) {
            return false;
        }
        self.steer_queue(session_id)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(message);
        true
    }

    /// Number of steering prompts currently queued for `session_id`.
    pub fn queued_steer_count(&self, session_id: &str) -> usize {
        self.steer_queues
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .map(|queue| queue.lock().unwrap_or_else(|e| e.into_inner()).len())
            .unwrap_or(0)
    }

    fn steer_queue(&self, session_id: &str) -> Arc<Mutex<Vec<LLMMessage>>> {
        let mut queues = self.steer_queues.lock().unwrap_or_else(|e| e.into_inner());
        queues
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Vec::new())))
            .clone()
    }

    pub fn with_mcp_manager(self, mcp_manager: Arc<McpManager>) -> Self {
        *self.mcp_manager.lock().unwrap_or_else(|e| e.into_inner()) = Some(mcp_manager);
        self
    }

    pub fn set_mcp_manager(&self, mcp_manager: Arc<McpManager>) {
        *self.mcp_manager.lock().unwrap_or_else(|e| e.into_inner()) = Some(mcp_manager);
    }

    pub fn mcp_manager(&self) -> Option<Arc<McpManager>> {
        self.mcp_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The event hub every turn publishes to; callers subscribe per session
    /// through `EventHub::bus_for`.
    pub fn hub(&self) -> Arc<EventHub> {
        self.hub.clone()
    }

    pub fn with_interaction_manager(self, manager: Arc<InteractionManager>) -> Self {
        self.set_interaction_manager(manager);
        self
    }

    pub fn set_interaction_manager(&self, manager: Arc<InteractionManager>) {
        // Interaction blocks move the session's activity phase; the registry
        // is engine-owned, so the notifier is (re)installed on every attach.
        let registry = self.activity_registry.clone();
        manager.set_activity_notifier(Arc::new(move |session_id, signal| {
            let tracker = registry.tracker(session_id);
            match signal {
                crate::server::interaction::ActivitySignal::Pending {
                    approval_id,
                    tool_call_id,
                } => tracker.awaiting(&approval_id, &tool_call_id),
                crate::server::interaction::ActivitySignal::Resolved => {
                    tracker.interaction_resolved()
                }
            }
        }));
        *self
            .interaction_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(manager);
    }

    pub fn interaction_manager(&self) -> Option<Arc<InteractionManager>> {
        self.interaction_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn with_max_steps(mut self, max_steps: u32) -> Self {
        self.max_steps = max_steps.max(1);
        self
    }

    pub fn with_max_attempts(mut self, max_attempts: Option<u32>) -> Self {
        self.max_attempts = max_attempts;
        self
    }

    /// Host-resolved `[subagent] timeout_ms` (v2 `resolveSubagentTimeoutMs`):
    /// rides the pipeline spec, so every subagent turn the sessions spawn
    /// (foreground and background) reads the same override. `None` keeps the
    /// engine's 2h default; `0` means the same as `None` to the tools.
    pub fn with_subagent_timeout_ms(mut self, timeout_ms: Option<u64>) -> Self {
        self.spec.subagent_timeout_ms = timeout_ms;
        self
    }

    /// Host-resolved `[swarm] timeout_ms` (v2 `resolveSwarmTimeoutMs`): a
    /// dedicated knob on the shared subagent manager — swarms never inherit
    /// the subagent timeout. `None` keeps the 2h swarm default.
    pub fn with_swarm_timeout_ms(self, timeout_ms: Option<u64>) -> Self {
        self.subagent_manager.set_swarm_timeout_ms(timeout_ms);
        self
    }

    pub fn store(&self) -> &Arc<SqliteSessionStore> {
        &self.store
    }

    pub fn subagent_manager(&self) -> Arc<SubagentManager> {
        self.subagent_manager.clone()
    }

    pub fn model_name(&self) -> &str {
        &self.spec.model_name
    }

    /// Check whether a turn is currently executing for the given session.
    pub fn is_busy(&self, session_id: &str) -> bool {
        self.active_turns.lock().unwrap().contains_key(session_id)
    }

    /// Signal cancellation for the active turn in the given session, if one is running.
    pub fn cancel_turn(&self, session_id: &str) -> bool {
        if let Some(mgr) = self.interaction_manager() {
            mgr.cancel_session(session_id);
        }
        let turns = self.active_turns.lock().unwrap();
        if let Some(flag) = turns.get(session_id) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    /// Publish the `event.session.work_changed` fact the Web client folds
    /// into its live session state (kap-server `SessionWorkChangedEvent`):
    /// the busy flip a turn start/end produces plus the interaction, if any,
    /// currently blocking the session. Without it the WebSocket stream never
    /// tells a client the session went busy or idle.
    fn publish_work_changed(&self, session_id: &str, busy: bool, last_turn_reason: Option<&str>) {
        let pending_interaction = self
            .interaction_manager()
            .and_then(|mgr| mgr.pending_interaction_kind(session_id))
            .unwrap_or("none")
            .to_string();
        self.hub
            .bus_for(session_id)
            .publish(&crate::events::EngineEvent::SessionWorkChanged {
                busy,
                main_turn_active: busy,
                pending_interaction,
                last_turn_reason: last_turn_reason.map(str::to_string),
            });
    }

    /// Publish the `agent.status.updated` fact the Web client's status bar
    /// folds (kap-server `AgentStatusUpdatedEvent`): the session's model,
    /// thinking effort, permission mode, plan mode and context-token estimate.
    ///
    /// The payload keys are camelCase exactly as the kimi-web projector reads
    /// them (`p?.model`, `p?.contextTokens`, …) — unlike the `event.*` family,
    /// whose payloads are snake_case. A publish whose payload is byte-identical
    /// to the session's last one is dropped, mirroring the broadcaster's
    /// snapshot dedup.
    pub async fn publish_status_updated(&self, session_id: &str) {
        let payload = self.status_payload(session_id);
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&payload.to_string(), &mut hasher);
        let hash = std::hash::Hasher::finish(&hasher);
        {
            let mut hashes = self.status_hashes.lock().unwrap();
            if hashes.get(session_id) == Some(&hash) {
                return;
            }
            hashes.insert(session_id.to_string(), hash);
        }
        self.hub
            .bus_for(session_id)
            .publish(&crate::events::EngineEvent::Custom(payload));
    }

    /// Assemble the status snapshot from every state source the client folds:
    /// `agent_config` (model / thinking / permission / plan mode) and the
    /// session history (context-token estimate, the same `len() / 4` budget
    /// `format_wire_session` reports). `maxContextTokens` needs the model
    /// catalog the engine does not hold, so it stays the caller's addition.
    fn status_payload(&self, session_id: &str) -> serde_json::Value {
        let agent_config = self
            .store
            .get_state("agent_config", session_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| serde_json::json!({}));
        let metadata = self
            .store
            .get_state("metadata", session_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| serde_json::json!({}));
        let history = self
            .store
            .load_session_history(session_id)
            .unwrap_or_default();
        let context_tokens: usize = history.iter().map(|m| m.content.len() / 4).sum();

        let mut payload = serde_json::json!({
            "type": "agent.status.updated",
            "model": agent_config
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or(self.spec.model_name.as_str()),
            "contextTokens": context_tokens,
        });
        let object = payload.as_object_mut().unwrap_or_else(|| {
            panic!("status payload is always an object");
        });
        if let Some(thinking) = agent_config.get("thinking").and_then(|v| v.as_str()) {
            object.insert("thinkingEffort".into(), serde_json::json!(thinking));
        }
        // The permission mode has two homes: `agent_config` (the profile
        // route writes it) and `metadata` (the engine's per-turn mode
        // resolution reads it). Either source wins over silence.
        let permission = agent_config
            .get("permission_mode")
            .and_then(|v| v.as_str())
            .or_else(|| metadata.get("permission_mode").and_then(|v| v.as_str()));
        if let Some(permission) = permission {
            object.insert("permission".into(), serde_json::json!(permission));
        }
        if let Some(plan_mode) = agent_config.get("plan_mode").and_then(|v| v.as_bool()) {
            object.insert("planMode".into(), serde_json::json!(plan_mode));
        }
        payload
    }

    /// Build an engine context for one turn and run it.
    ///
    /// The pipeline is rebuilt per turn, as the legacy stdio entry does: the
    /// configuration is fixed for the process, but the subagent runtime and the
    /// event bus binding are per-context, and nothing here is long-lived enough
    /// to be worth caching yet.
    pub async fn run_turn(
        &self,
        session_id: &str,
        turn_number: u32,
        history: Vec<LLMMessage>,
        prompt: &str,
    ) -> Result<TurnReport, EngineError> {
        self.run_turn_with_media(session_id, turn_number, history, prompt, Vec::new())
            .await
    }

    /// Run a turn whose opening user message carries media content blocks
    /// (prompt attachments resolved from the local file store).
    pub async fn run_turn_with_media(
        &self,
        session_id: &str,
        turn_number: u32,
        history: Vec<LLMMessage>,
        prompt: &str,
        media: Vec<ContentBlock>,
    ) -> Result<TurnReport, EngineError> {
        // A self-contained engine must refuse the host-proxy fallback rather
        // than reach ServerHost.llm_chat and fail mid-turn.
        let mut policy_snapshot = self.spec.policy_snapshot.clone().unwrap_or_default();
        if policy_snapshot.mode == crate::permission::PermissionMode::Manual {
            if std::env::var("KIMI_AUTO_APPROVE")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false)
            {
                policy_snapshot.mode = crate::permission::PermissionMode::Auto;
            } else if let Ok(Some(meta_val)) = self.store.get_state("metadata", session_id) {
                if let Some(mode_str) = meta_val.get("permission_mode").and_then(|v| v.as_str()) {
                    match mode_str.to_ascii_lowercase().as_str() {
                        "auto" => policy_snapshot.mode = crate::permission::PermissionMode::Auto,
                        "yolo" => policy_snapshot.mode = crate::permission::PermissionMode::Yolo,
                        _ => {}
                    }
                } else if meta_val.get("yolo").and_then(|v| v.as_bool()) == Some(true) {
                    policy_snapshot.mode = crate::permission::PermissionMode::Yolo;
                }
            }
        }
        let mut session_system_prompt = self.spec.system_prompt.clone();
        if (session_system_prompt.is_empty()
            || session_system_prompt == "sys"
            || session_system_prompt
                .starts_with("You are kimi-agent, running as a standalone service."))
            && let Some(ref ws) = self.spec.workspace_root
        {
            session_system_prompt =
                crate::prompt::SystemPromptBuilder::build_default_with_skill_dirs(
                    ws,
                    self.spec.skill_dirs.clone(),
                );
        }

        let mut spec = PipelineSpec {
            rust_self_contained: true,
            policy_snapshot: Some(policy_snapshot),
            session_id: Some(session_id.to_string()),
            system_prompt: session_system_prompt,
            ..clone_spec(&self.spec)
        };
        // The session's persisted profile (`agent_config`) overrides the
        // engine-wide spec for this turn: the REST prompt/profile surface
        // writes model / thinking / disabled-tools there and the standalone
        // server has no host to re-resolve per-turn params.
        let session_profile = self
            .store
            .get_state("agent_config", session_id)
            .ok()
            .flatten()
            .unwrap_or_default();
        // A session model override re-resolves to its provider first, so a
        // cross-provider alias picks up the right base URL / key; the
        // field-level overrides below then win for model / thinking / tools.
        if let Some(model) = session_profile
            .get("model")
            .and_then(|v| v.as_str())
            .filter(|model| !model.is_empty())
            && let Some(native) = self.resolved_native_llm(model).await
        {
            spec.model_name = model.to_string();
            spec.native_llm = Some(native);
        }
        apply_session_overrides(&mut spec, &session_profile);
        let host_callbacks: Arc<dyn HostCallbacks> = match self.host_factory() {
            Some(factory) => factory(session_id),
            None => {
                if let Some(mgr) = self.interaction_manager() {
                    Arc::new(
                        ServerHost::with_interaction(mgr, session_id.to_string())
                            .with_oauth(self.oauth_manager()),
                    )
                } else {
                    Arc::new(ServerHost::standalone().with_oauth(self.oauth_manager()))
                }
            }
        };

        let ws_root = match self.store.get_session(session_id) {
            Ok(Some(s)) if s.workspace_id.is_some() => {
                let wid = s.workspace_id.unwrap();
                self.store
                    .get_workspace(&wid)
                    .ok()
                    .flatten()
                    .map(|w| std::path::PathBuf::from(w.root))
            }
            _ => None,
        };
        let ws_ref = ws_root.as_deref().unwrap_or(std::path::Path::new("."));
        let host_callbacks: Arc<dyn HostCallbacks> =
            match crate::storage::StateStore::for_workspace(ws_ref) {
                Ok(store) => Arc::new(crate::callbacks::StateStoreCallbacks {
                    inner: host_callbacks,
                    store: Arc::new(store),
                }),
                Err(_) => host_callbacks,
            };
        let pipeline = build_engine_pipeline(
            &spec,
            host_callbacks,
            PipelineHost {
                subagent_manager: self.subagent_manager.clone(),
                parent_cancel: None,
                parent_cancel_slot: None,
                mcp_manager: self.mcp_manager(),
                // This session's lane, so the turn's events carry its session id
                // and its seq. Every connection still sees every lane.
                event_bus: Some(self.hub.bus_for(session_id)),
            },
        )
        .await
        .map_err(|error| EngineError::NoModel(error.message))?;

        self.execute(
            pipeline.llm.as_ref(),
            &pipeline.callbacks,
            pipeline.hook_guard.clone(),
            session_id,
            turn_number,
            history,
            prompt,
            media,
        )
        .await
    }

    /// Run a turn on a caller-supplied LLM, skipping pipeline construction.
    ///
    /// The two product entries never use this; it exists so the exact same
    /// loop, persistence and reporting path can be driven from a test, and so
    /// a future custom transport has one obvious insertion point.
    pub async fn run_turn_on(
        &self,
        llm: &dyn LLM,
        session_id: &str,
        turn_number: u32,
        history: Vec<LLMMessage>,
        prompt: &str,
    ) -> Result<TurnReport, EngineError> {
        let callbacks: Arc<dyn HostCallbacks> = if let Some(mgr) = self.interaction_manager() {
            Arc::new(
                ServerHost::with_interaction(mgr, session_id.to_string())
                    .with_oauth(self.oauth_manager()),
            )
        } else {
            Arc::new(ServerHost::standalone().with_oauth(self.oauth_manager()))
        };
        self.execute(
            llm,
            &callbacks,
            None,
            session_id,
            turn_number,
            history,
            prompt,
            Vec::new(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute(
        &self,
        llm: &dyn LLM,
        callbacks: &Arc<dyn HostCallbacks>,
        hook_guard: Option<Arc<crate::tools::external_hooks::HookGuard>>,
        session_id: &str,
        turn_number: u32,
        history: Vec<LLMMessage>,
        prompt: &str,
        media: Vec<ContentBlock>,
    ) -> Result<TurnReport, EngineError> {
        let turn_id = format!("turn-{}", fastrand::u64(..));
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut turns = self.active_turns.lock().unwrap();
            turns.insert(session_id.to_string(), Arc::clone(&cancel));
        }
        self.publish_work_changed(session_id, true, None);
        self.publish_status_updated(session_id).await;
        // The activity phase machine follows the turn from here: running →
        // streaming / tool_call / retrying (via the callback decorator) →
        // ended or interrupted.
        let activity = self.activity_registry.tracker(session_id);
        activity.turn_started(turn_number);
        // Innermost decorator: drains this session's steering queue at every
        // step head, so a `POST /prompts:steer` lands in the running turn.
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(crate::session::SteerQueueCallbacks::new(
            callbacks.clone(),
            self.steer_queue(session_id),
        ));
        // Outermost decorator: every step boundary, streaming delta and tool
        // execution the turn produces moves the session's activity phase
        // before the underlying chain sees the event.
        let callbacks: Arc<dyn HostCallbacks> =
            Arc::new(crate::server::activity::ActivityCallbacks {
                inner: callbacks.clone(),
                tracker: activity.clone(),
            });
        // Outermost of all: the turn's prompt and every step's assistant
        // output get message identities (`event.message.created` /
        // `event.assistant.delta` / `event.message.updated`), the vocabulary
        // the Web client's transcript folds.
        let callbacks: Arc<dyn HostCallbacks> =
            Arc::new(crate::server::message_events::MessageCallbacks::new(
                callbacks.clone(),
                session_id,
                self.hub.clone(),
                turn_number,
                prompt,
            ));
        struct ActiveGuard<'a> {
            engine: &'a ServerEngine,
            session_id: String,
        }
        impl<'a> Drop for ActiveGuard<'a> {
            fn drop(&mut self) {
                let mut turns = self.engine.active_turns.lock().unwrap();
                turns.remove(&self.session_id);
                drop(turns);
                let mut queues = self
                    .engine
                    .steer_queues
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                queues.remove(&self.session_id);
            }
        }
        let _guard = ActiveGuard {
            engine: self,
            session_id: session_id.to_string(),
        };

        let mut messages = history;
        let user_message = LLMMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
            blocks: media,
            tool_calls: Vec::new(),
            tool_call_id: None,
        };
        messages.push(user_message.clone());
        let input_len = messages.len();

        let goal = callbacks.goal().await.ok().flatten();
        let input = RunTurnInput {
            max_attempts: self.max_attempts,
            turn_id: turn_id.clone(),
            llm,
            messages,
            tools: &[],
            tool_defs: vec![],
            max_steps: self.max_steps,
            max_context_tokens: None,
            goal,
            cancellation: Some(cancel),
            hook_guard,
        };

        // Flatten the loop error before any later await: `Box<dyn StdError>`
        // is not `Send`, and the spawned turn future must stay `Send`.
        let turn = match run_turn_continued(input, &callbacks).await {
            Ok(result) => Ok(result),
            Err(error) => Err(error.to_string()),
        };
        let result = match turn {
            Ok(result) => {
                let reason = work_turn_reason(&result.stop_reason);
                self.publish_work_changed(session_id, false, Some(reason));
                result
            }
            Err(error) => {
                self.publish_work_changed(session_id, false, Some("failed"));
                self.publish_status_updated(session_id).await;
                activity.interrupted(
                    crate::server::activity::InterruptReason::Error,
                    Some(error.clone()),
                );
                return Err(EngineError::Turn(error));
            }
        };

        // The loop returns system (index 0) + everything it was handed + what it
        // appended, so adopting `messages[1..]` would rewrite the carried
        // history on every turn. `EngineSession` already solved this at
        // `session/mod.rs:742` by skipping the system message *and* its own
        // input; this store additionally owns the transcript, so the prompt
        // itself is kept while the history is not re-written.
        //
        // Still open: the appended slice includes the loop's per-turn injected
        // reminders (date change, workspace AGENTS.md), which are regenerated
        // each turn and were never meant to be durable. Filtering them needs a
        // tag from the injection registry; until then they land in history.
        let mut transcript =
            Vec::with_capacity(1 + result.messages.len().saturating_sub(input_len));
        transcript.push(user_message);
        transcript.extend(result.messages.iter().skip(1 + input_len).cloned());
        self.store
            .save_turn(
                session_id,
                &turn_id,
                turn_number,
                &transcript,
                Some(&result.usage),
            )
            .map_err(EngineError::Store)?;

        // Report the status only after the turn is durable: the snapshot
        // reads the session history, so it must see this turn's context
        // growth. Before persistence the payload is identical to the turn
        // start's and the dedup would swallow it.
        self.publish_status_updated(session_id).await;

        // Live token accounting for the Web client (kap-server
        // `event.session.usage_updated`): the turn's counters ride as the
        // delta, and the usage snapshot carries the same context estimate
        // the wire session reports (session totals are not persisted here
        // yet, so the client folds the deltas).
        let session_history = self
            .store
            .load_session_history(session_id)
            .unwrap_or_default();
        let context_tokens = (session_history
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            / 4) as u64;
        self.hub
            .bus_for(session_id)
            .publish(&crate::events::EngineEvent::Custom(serde_json::json!({
                "type": "event.session.usage_updated",
                "usage": {
                    "input_tokens": result.usage.input_tokens,
                    "output_tokens": result.usage.output_tokens,
                    "cache_read_tokens": result.usage.input_cache_read,
                    "cache_creation_tokens": result.usage.input_cache_creation,
                    "context_tokens": context_tokens,
                    "turn_count": turn_number,
                },
                "delta": {
                    "input_tokens": result.usage.input_tokens,
                    "output_tokens": result.usage.output_tokens,
                    "cache_read_tokens": result.usage.input_cache_read,
                    "cache_creation_tokens": result.usage.input_cache_creation,
                },
            })));
        activity.turn_ended(work_turn_reason(&result.stop_reason));

        let reply = transcript
            .iter()
            .rev()
            .find(|message| message.role == "assistant")
            .map(|message| message.content.clone())
            .unwrap_or_default();

        Ok(TurnReport {
            turn_id,
            reply,
            stop_reason: format!("{:?}", result.stop_reason),
            steps: result.steps,
            usage: result.usage,
            events_emitted: result.events_emitted,
            llm_transport: result.llm_transport,
            native_tool_calls: result.native_tool_calls,
        })
    }
}

/// Map the loop's stop reason onto the three `last_turn_reason` values the
/// kap-server contract allows ('completed' | 'cancelled' | 'failed').
/// `MaxSteps` and `Filtered` are failed turns (ROADMAP §2.5), `Aborted` is a
/// cancellation, everything else completed.
fn work_turn_reason(reason: &crate::turn_loop::types::LoopTurnStopReason) -> &'static str {
    use crate::turn_loop::types::LoopTurnStopReason::*;
    match reason {
        Aborted => "cancelled",
        MaxSteps | Filtered => "failed",
        EndTurn | MaxTokens | Paused | Unknown | BudgetLimited | RepeatBreaker => "completed",
    }
}

/// Overlay a session's persisted profile (`agent_config`) onto the engine's
/// base spec for one turn. Model switching is alias-level: the transport
/// (base URL / key) stays the engine's, so an alias on a different provider is
/// not re-resolved here.
fn apply_session_overrides(spec: &mut PipelineSpec, profile: &serde_json::Value) {
    if let Some(model) = profile
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|model| !model.is_empty())
    {
        spec.model_name = model.to_string();
        if let Some(native) = spec.native_llm.as_mut() {
            native.model = model.to_string();
        }
    }
    if let Some(effort) = profile
        .get("thinking")
        .and_then(|v| v.as_str())
        .filter(|effort| !effort.is_empty())
        && let Some(native) = spec.native_llm.as_mut()
    {
        native.reasoning_effort = Some(effort.to_string());
    }
    let disabled: Vec<String> = profile
        .get("disabled_tools")
        .and_then(|v| v.as_array())
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !disabled.is_empty() {
        let snapshot = spec
            .policy_snapshot
            .get_or_insert_with(crate::permission::PolicySnapshot::default);
        match snapshot.tools_filter.as_mut() {
            Some(filter) => {
                for name in disabled {
                    if !filter.disabled.contains(&name) {
                        filter.disabled.push(name);
                    }
                }
            }
            None => {
                snapshot.tools_filter = Some(crate::tools::tool_policy::ToolsFilter {
                    enabled: Vec::new(),
                    disabled,
                });
            }
        }
    }
}

/// `PipelineSpec` has no `Clone`: a provider list and a couple of option
/// fields, cheap to rebuild field by field at the one call site that needs it.
fn clone_spec(spec: &PipelineSpec) -> PipelineSpec {
    PipelineSpec {
        system_prompt: spec.system_prompt.clone(),
        model_name: spec.model_name.clone(),
        providers: spec
            .providers
            .iter()
            .map(|provider| crate::pipeline::PipelineProvider {
                name: provider.name.clone(),
                system_prompt: provider.system_prompt.clone(),
                model: provider.model.clone(),
            })
            .collect(),
        native_llm: spec.native_llm.clone(),
        workspace_root: spec.workspace_root.clone(),
        native_tools: spec.native_tools,
        rust_self_contained: spec.rust_self_contained,
        shell_path: spec.shell_path.clone(),
        policy_snapshot: spec.policy_snapshot.clone(),
        github_token: spec.github_token.clone(),
        github_base_url: spec.github_base_url.clone(),
        subagent_timeout_ms: spec.subagent_timeout_ms,
        agent_tool_veto: spec.agent_tool_veto.clone(),
        tools_veto: spec.tools_veto.clone(),
        todo_tool_veto: spec.todo_tool_veto.clone(),
        tower_worktree_root: spec.tower_worktree_root.clone(),
        sandbox_mode: spec.sandbox_mode.clone(),
        sandbox_policy: spec.sandbox_policy.clone(),
        secondary_model: spec.secondary_model.clone(),
        caller_agent_id: spec.caller_agent_id.clone(),
        session_id: spec.session_id.clone(),
        image_read_byte_budget: spec.image_read_byte_budget,
        image_max_edge_px: spec.image_max_edge_px,
        model_capabilities: spec.model_capabilities.clone(),
        skill_dirs: spec.skill_dirs.clone(),
        background: spec.background,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::StateReadRequest;
    use crate::turn_loop::types::{LLMChatParams, LLMChatResponse};

    fn spec() -> PipelineSpec {
        PipelineSpec {
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
            secondary_model: None,
            image_read_byte_budget: None,
            image_max_edge_px: None,
            model_capabilities: None,
            skill_dirs: Vec::new(),
            background: crate::storage::BackgroundLimits::default(),
        }
    }

    fn engine() -> ServerEngine {
        ServerEngine::new(
            spec(),
            Arc::new(EventHub::new()),
            Arc::new(SqliteSessionStore::in_memory().unwrap()),
        )
    }

    #[test]
    fn session_profile_overrides_spec_for_the_turn() {
        let mut spec = spec();
        spec.native_llm = Some(crate::rpc::types::NativeLlmConfig {
            model: "base".into(),
            reasoning_effort: Some("low".into()),
            ..Default::default()
        });
        let profile = serde_json::json!({
            "model": "alias-2",
            "thinking": "high",
            "disabled_tools": ["Bash", "Write"],
        });
        apply_session_overrides(&mut spec, &profile);
        assert_eq!(spec.model_name, "alias-2");
        assert_eq!(spec.native_llm.as_ref().unwrap().model, "alias-2");
        assert_eq!(
            spec.native_llm
                .as_ref()
                .unwrap()
                .reasoning_effort
                .as_deref(),
            Some("high")
        );
        let filter = spec
            .policy_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.tools_filter.as_ref())
            .expect("tools filter");
        assert!(filter.disabled.contains(&"Bash".to_string()));
        assert!(filter.disabled.contains(&"Write".to_string()));
    }

    #[test]
    fn empty_session_profile_leaves_spec_untouched() {
        let mut spec = spec();
        spec.native_llm = Some(crate::rpc::types::NativeLlmConfig {
            model: "base".into(),
            ..Default::default()
        });
        apply_session_overrides(&mut spec, &serde_json::json!({}));
        assert_eq!(spec.model_name, "test-model");
        assert_eq!(spec.native_llm.as_ref().unwrap().model, "base");
        assert!(spec.policy_snapshot.is_none());
    }

    #[tokio::test]
    async fn session_model_resolves_cross_provider_from_config() {
        let engine = engine();
        let config: crate::config::KimiConfig = r#"
default_model = "alias-2"

[providers.acme]
type = "openai"
api_key = "k"
base_url = "https://api.example.test/v1"

[models.alias-2]
provider = "acme"
model = "gpt-x"
"#
        .parse()
        .expect("parse config");
        engine.set_config_source(Arc::new(tokio::sync::Mutex::new(Some(config))));

        let native = engine
            .resolved_native_llm("alias-2")
            .await
            .expect("alias resolves to its provider");
        assert_eq!(native.base_url, "https://api.example.test/v1");
        assert_eq!(native.model, "gpt-x");
        assert_eq!(native.api_key, "k");
    }

    struct ScriptedLlm;

    impl LLM for ScriptedLlm {
        fn system_prompt(&self) -> &str {
            "sys"
        }
        fn model_name(&self) -> &str {
            "scripted"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            Box::pin(async {
                Ok(LLMChatResponse {
                    content: "done".into(),
                    thinking: Vec::new(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    #[tokio::test]
    async fn the_absent_host_refuses_instead_of_waiting() {
        let host = ServerHost::standalone();

        let error = host
            .llm_chat(LlmChatRequest {
                system_prompt: "sys".into(),
                model_name: "m".into(),
                messages: Vec::new(),
                tools: Vec::new(),
                request_id: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("no LLM host"), "{error}");

        let error = host
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c".into(),
                tool_name: "WebSearch".into(),
                arguments: serde_json::json!({}),
            })
            .await
            .unwrap_err();
        assert!(error.contains("WebSearch"), "{error}");

        let verdict = host
            .check_permission(PermissionCheckRequest {
                tool_name: "Bash".into(),
                tool_call_id: "c".into(),
                arguments: serde_json::json!({}),
            })
            .await
            .unwrap();
        assert_eq!(verdict.decision, "deny");

        // Legs left on the trait's defaults must also answer, not hang.
        assert!(host.list_tools().await.is_err());
        assert!(host.goal().await.is_err());
        assert!(
            host.state_read(StateReadRequest {
                domain: "plan".into(),
                key: "plan".into(),
                turn_id: String::new(),
                tool_call_id: String::new(),
            })
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn a_turn_without_any_configured_model_is_refused_up_front() {
        let engine = engine();
        let error = engine
            .run_turn("sess-1", 1, Vec::new(), "hello")
            .await
            .expect_err("no providers and no native_llm must not run");

        match error {
            EngineError::NoModel(message) => {
                assert!(message.contains("rustSelfContained"), "{message}")
            }
            other => panic!("expected NoModel, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_turn_runs_persists_and_reports_its_transport() {
        let engine = engine();
        engine
            .store()
            .create_session("sess-1", Some("engine test"))
            .unwrap();

        let report = engine
            .run_turn_on(&ScriptedLlm, "sess-1", 1, Vec::new(), "hello")
            .await
            .expect("scripted turn completes");

        assert_eq!(report.steps, 1);
        assert_eq!(report.stop_reason, "EndTurn");
        // Counting-wrapper figures are zero on this path: no pipeline was built,
        // so nothing was counted. Asserting it keeps the seam honest.
        assert_eq!(report.events_emitted, 0);
        assert_eq!(report.native_tool_calls, 0);

        let history = engine.store().load_session_history("sess-1").unwrap();
        let contents: Vec<&str> = history.iter().map(|m| m.content.as_str()).collect();
        assert!(
            contents.contains(&"hello"),
            "prompt not persisted: {contents:?}"
        );
        assert!(
            contents.contains(&"done"),
            "reply not persisted: {contents:?}"
        );
        // The loop owns its own message list (system prompt plus an injected
        // context turn); the store must hold only the non-system transcript.
        assert!(
            !history.iter().any(|m| m.role == "system"),
            "system row persisted as conversation: {contents:?}"
        );
    }

    #[tokio::test]
    async fn a_second_turn_does_not_re_write_the_carried_history() {
        let engine = engine();
        engine.store().create_session("sess-3", None).unwrap();

        engine
            .run_turn_on(&ScriptedLlm, "sess-3", 1, Vec::new(), "first")
            .await
            .unwrap();
        let after_first = engine.store().load_session_history("sess-3").unwrap();
        let first_prompts = after_first.iter().filter(|m| m.content == "first").count();

        engine
            .run_turn_on(&ScriptedLlm, "sess-3", 2, after_first, "second")
            .await
            .unwrap();
        let history = engine.store().load_session_history("sess-3").unwrap();

        assert_eq!(first_prompts, 1, "turn 1 duplicated its own prompt");
        assert_eq!(
            history.iter().filter(|m| m.content == "first").count(),
            1,
            "turn 2 re-persisted the carried history: {:?}",
            history.iter().map(|m| &m.content).collect::<Vec<_>>()
        );
        assert!(history.iter().any(|m| m.content == "second"));
    }

    #[tokio::test]
    async fn history_before_the_prompt_is_carried_into_the_turn() {
        let engine = engine();
        engine.store().create_session("sess-2", None).unwrap();

        let history = vec![LLMMessage {
            role: "user".into(),
            content: "earlier question".into(),
            ..Default::default()
        }];
        let report = engine
            .run_turn_on(&ScriptedLlm, "sess-2", 2, history, "follow-up")
            .await
            .expect("turn completes");

        // The prompt is appended after the history, so the loop sees both.
        assert_eq!(report.steps, 1);
    }

    #[tokio::test]
    async fn a_turn_publishes_work_changed_busy_then_idle() {
        let engine = engine();
        engine
            .store()
            .create_session("sess-wc", Some("work changed test"))
            .unwrap();
        let mut sub = engine.hub().attach();

        let report = engine
            .run_turn_on(&ScriptedLlm, "sess-wc", 1, Vec::new(), "hello")
            .await
            .expect("scripted turn");
        assert_eq!(report.stop_reason, "EndTurn");

        // The turn boundary now publishes three facts in a fixed order — the
        // work_changed busy flip, the deduped status snapshot and the
        // activity phase — at start and again at end. Every recv is bounded
        // so a regression fails instead of hanging the suite.
        async fn next_event(
            sub: &mut crate::server::hub::WsSubscription,
        ) -> std::sync::Arc<crate::server::hub::SequencedEvent> {
            tokio::time::timeout(std::time::Duration::from_secs(5), sub.recv())
                .await
                .expect("event within 5s")
                .expect("hub open")
        }
        let events: Vec<std::sync::Arc<crate::server::hub::SequencedEvent>> = {
            let mut collected = Vec::new();
            for _ in 0..8 {
                collected.push(next_event(&mut sub).await);
            }
            collected
        };
        let sequence: Vec<String> = events
            .iter()
            .map(|e| e.event.event_type().to_string())
            .collect();
        assert_eq!(
            sequence,
            vec![
                "event.session.work_changed",  // busy=true
                "agent.status.updated",        // snapshot (first for the session)
                "agent.status.updated",        // phase: running
                "event.message.created",       // the user prompt
                "event.session.work_changed",  // busy=false
                "agent.status.updated",        // snapshot (context grew)
                "event.session.usage_updated", // live token accounting
                "agent.status.updated",        // phase: ended
            ]
        );

        let crate::events::EngineEvent::SessionWorkChanged {
            busy,
            main_turn_active,
            pending_interaction,
            last_turn_reason,
        } = &events[0].event
        else {
            panic!("expected work_changed, got {:?}", events[0].event);
        };
        assert!(*busy);
        assert!(*main_turn_active);
        assert_eq!(pending_interaction, "none");
        assert!(last_turn_reason.is_none());

        let crate::events::EngineEvent::Custom(start_phase) = &events[2].event else {
            panic!("expected the running phase, got {:?}", events[2].event);
        };
        assert_eq!(start_phase["phase"]["kind"], "running");

        let crate::events::EngineEvent::Custom(end_phase) = &events[7].event else {
            panic!("expected the ended phase, got {:?}", events[7].event);
        };
        assert_eq!(end_phase["phase"]["kind"], "ended");
        assert_eq!(end_phase["phase"]["reason"], "completed");

        let crate::events::EngineEvent::SessionWorkChanged {
            busy,
            last_turn_reason,
            ..
        } = &events[4].event
        else {
            panic!("expected work_changed, got {:?}", events[4].event);
        };
        assert!(!busy);
        assert_eq!(last_turn_reason.as_deref(), Some("completed"));
    }

    #[tokio::test]
    async fn status_updated_folds_agent_config_and_context_then_dedups() {
        let engine = engine();
        engine
            .store()
            .create_session("sess-status", Some("status test"))
            .unwrap();
        engine
            .store
            .put_state(
                "agent_config",
                "sess-status",
                &serde_json::json!({
                    "model": "k3-test",
                    "thinking": "high",
                    "permission_mode": "manual",
                    "plan_mode": true,
                }),
            )
            .unwrap();
        // Four content bytes → the same `len() / 4` estimate the wire session
        // reports, so the assertion pins the exact budget.
        engine
            .store
            .save_turn(
                "sess-status",
                "turn-status",
                1,
                &[LLMMessage::user("abcd")],
                None,
            )
            .unwrap();
        let mut sub = engine.hub().attach();

        engine.publish_status_updated("sess-status").await;
        let event = sub.recv().await.unwrap();
        assert_eq!(&*event.session_id, "sess-status");
        assert_eq!(event.event.event_type(), "agent.status.updated");
        let crate::events::EngineEvent::Custom(payload) = &event.event else {
            panic!("expected a Custom status payload");
        };
        assert_eq!(payload["model"], "k3-test");
        assert_eq!(payload["thinkingEffort"], "high");
        assert_eq!(payload["permission"], "manual");
        assert_eq!(payload["planMode"], true);
        assert_eq!(payload["contextTokens"], 1);

        // An unchanged state re-publish is dropped by the snapshot dedup.
        engine.publish_status_updated("sess-status").await;
        let next = tokio::time::timeout(std::time::Duration::from_millis(50), sub.recv()).await;
        assert!(next.is_err(), "dedup must swallow the identical payload");
    }

    #[test]
    fn work_turn_reason_maps_the_loop_vocabulary() {
        use crate::turn_loop::types::LoopTurnStopReason;
        assert_eq!(work_turn_reason(&LoopTurnStopReason::EndTurn), "completed");
        assert_eq!(work_turn_reason(&LoopTurnStopReason::MaxSteps), "failed");
        assert_eq!(work_turn_reason(&LoopTurnStopReason::Filtered), "failed");
        assert_eq!(work_turn_reason(&LoopTurnStopReason::Aborted), "cancelled");
    }

    #[test]
    fn engine_with_mcp_manager_wires_and_exposes_manager() {
        let engine = engine();
        assert!(engine.mcp_manager().is_none());

        let mcp = Arc::new(McpManager::new());
        let engine = engine.with_mcp_manager(mcp);
        assert!(engine.mcp_manager().is_some());
    }
}
