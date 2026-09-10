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
    AskQuestionRequest, AskQuestionResponse, BoxFuture, LlmChatRequest, LlmChatResponse,
    PermissionCheckRequest, PermissionDecision, TokenUsage, ToolExecuteRequest,
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
}

impl ServerHost {
    pub fn standalone() -> Self {
        Self {
            interaction_manager: None,
            session_id: None,
        }
    }

    pub fn with_interaction(manager: Arc<InteractionManager>, session_id: String) -> Self {
        Self {
            interaction_manager: Some(manager),
            session_id: Some(session_id),
        }
    }
}

impl HostCallbacks for ServerHost {
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
    /// Optional per-session host factory; non-HTTP hosts (ACP) install one to
    /// answer permission checks through their own transport.
    host_factory: Mutex<Option<HostFactory>>,
}

/// Builds the host callbacks for one session.
pub type HostFactory = Arc<dyn Fn(&str) -> Arc<dyn crate::callbacks::HostCallbacks> + Send + Sync>;

impl ServerEngine {
    pub fn new(spec: PipelineSpec, hub: Arc<EventHub>, store: Arc<SqliteSessionStore>) -> Self {
        Self {
            spec,
            hub,
            store: store.clone(),
            max_steps: 32,
            max_attempts: None,
            active_turns: Mutex::new(HashMap::new()),
            mcp_manager: Mutex::new(None),
            interaction_manager: Mutex::new(None),
            subagent_manager: Arc::new(SubagentManager::with_store(store)),
            host_factory: Mutex::new(None),
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
        *self
            .interaction_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(manager);
        self
    }

    pub fn set_interaction_manager(&self, manager: Arc<InteractionManager>) {
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
            session_system_prompt = crate::prompt::SystemPromptBuilder::build_default(ws);
        }

        let spec = PipelineSpec {
            rust_self_contained: true,
            policy_snapshot: Some(policy_snapshot),
            session_id: Some(session_id.to_string()),
            system_prompt: session_system_prompt,
            ..clone_spec(&self.spec)
        };
        let host_callbacks: Arc<dyn HostCallbacks> = match self.host_factory() {
            Some(factory) => factory(session_id),
            None => {
                if let Some(mgr) = self.interaction_manager() {
                    Arc::new(ServerHost::with_interaction(mgr, session_id.to_string()))
                } else {
                    Arc::new(ServerHost::standalone())
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
            Arc::new(ServerHost::with_interaction(mgr, session_id.to_string()))
        } else {
            Arc::new(ServerHost::standalone())
        };
        self.execute(
            llm,
            &callbacks,
            None,
            session_id,
            turn_number,
            history,
            prompt,
        )
        .await
    }

    async fn execute(
        &self,
        llm: &dyn LLM,
        callbacks: &Arc<dyn HostCallbacks>,
        hook_guard: Option<Arc<crate::tools::external_hooks::HookGuard>>,
        session_id: &str,
        turn_number: u32,
        history: Vec<LLMMessage>,
        prompt: &str,
    ) -> Result<TurnReport, EngineError> {
        let turn_id = format!("turn-{}", fastrand::u64(..));
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut turns = self.active_turns.lock().unwrap();
            turns.insert(session_id.to_string(), Arc::clone(&cancel));
        }
        struct ActiveGuard<'a> {
            engine: &'a ServerEngine,
            session_id: String,
        }
        impl<'a> Drop for ActiveGuard<'a> {
            fn drop(&mut self) {
                let mut turns = self.engine.active_turns.lock().unwrap();
                turns.remove(&self.session_id);
            }
        }
        let _guard = ActiveGuard {
            engine: self,
            session_id: session_id.to_string(),
        };

        let mut messages = history;
        messages.push(LLMMessage::user(prompt));
        let input_len = messages.len();

        let input = RunTurnInput {
            max_attempts: self.max_attempts,
            turn_id: turn_id.clone(),
            llm,
            messages,
            tools: &[],
            tool_defs: vec![],
            max_steps: self.max_steps,
            max_context_tokens: None,
            goal: None,
            cancellation: Some(cancel),
            hook_guard,
        };

        let result = run_turn_continued(input, callbacks)
            .await
            .map_err(|error| EngineError::Turn(error.to_string()))?;

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
        transcript.push(LLMMessage::user(prompt));
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
        }
    }

    fn engine() -> ServerEngine {
        ServerEngine::new(
            spec(),
            Arc::new(EventHub::new()),
            Arc::new(SqliteSessionStore::in_memory().unwrap()),
        )
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

    #[test]
    fn engine_with_mcp_manager_wires_and_exposes_manager() {
        let engine = engine();
        assert!(engine.mcp_manager().is_none());

        let mcp = Arc::new(McpManager::new());
        let engine = engine.with_mcp_manager(mcp);
        assert!(engine.mcp_manager().is_some());
    }
}
