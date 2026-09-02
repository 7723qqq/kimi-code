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

use std::sync::Arc;

use crate::callbacks::HostCallbacks;
use crate::pipeline::{PipelineHost, PipelineSpec, build_engine_pipeline};
use crate::rpc::types::{
    BoxFuture, LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision,
    TokenUsage, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::server::hub::EventHub;
use crate::session::sqlite_store::SqliteSessionStore;
use crate::subagent::SubagentManager;
use crate::turn_loop::run_turn::run_turn;
use crate::turn_loop::types::{LLM, LLMMessage, RunTurnInput};

/// A host that is not there. Every answer is a refusal or a deny; nothing here
/// waits.
pub struct ServerHost;

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

    /// No interactive approver exists here, so anything reaching this leg is
    /// denied. The permission engine runs before it for native tools, so this
    /// is the fallback, not the default path.
    fn check_permission(
        &self,
        _request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        Box::pin(async {
            Ok(PermissionDecision {
                decision: "deny".into(),
                reason: Some("no interactive approver in the standalone engine".into()),
            })
        })
    }
}

/// What one completed turn reports back to the caller.
#[derive(Debug, Clone)]
pub struct TurnReport {
    pub turn_id: String,
    pub stop_reason: String,
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
    hub: EventHub,
    store: Arc<SqliteSessionStore>,
    max_steps: u32,
}

impl ServerEngine {
    pub fn new(spec: PipelineSpec, hub: EventHub, store: Arc<SqliteSessionStore>) -> Self {
        Self {
            spec,
            hub,
            store,
            max_steps: 32,
        }
    }

    pub fn with_max_steps(mut self, max_steps: u32) -> Self {
        self.max_steps = max_steps.max(1);
        self
    }

    pub fn store(&self) -> &Arc<SqliteSessionStore> {
        &self.store
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
        let spec = PipelineSpec {
            rust_self_contained: true,
            ..clone_spec(&self.spec)
        };
        let pipeline = build_engine_pipeline(
            &spec,
            Arc::new(ServerHost),
            PipelineHost {
                subagent_manager: Arc::new(SubagentManager::new()),
                parent_cancel: None,
                parent_cancel_slot: None,
                // No external MCP servers: their configs come from the host.
                mcp_manager: None,
                // The hub's bus, so events from this turn fan out to connected
                // WebSocket clients.
                event_bus: Some(self.hub.bus().clone()),
            },
        )
        .await
        .map_err(|error| EngineError::NoModel(error.message))?;

        self.execute(
            pipeline.llm.as_ref(),
            &pipeline.callbacks,
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
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(ServerHost);
        self.execute(llm, &callbacks, session_id, turn_number, history, prompt)
            .await
    }

    async fn execute(
        &self,
        llm: &dyn LLM,
        callbacks: &Arc<dyn HostCallbacks>,
        session_id: &str,
        turn_number: u32,
        history: Vec<LLMMessage>,
        prompt: &str,
    ) -> Result<TurnReport, EngineError> {
        let turn_id = format!("turn-{}", fastrand::u64(..));
        let mut messages = history;
        messages.push(LLMMessage::user(prompt));
        let input_len = messages.len();

        let input = RunTurnInput {
            turn_id: turn_id.clone(),
            llm,
            messages,
            tools: &[],
            tool_defs: vec![],
            max_steps: self.max_steps,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, callbacks)
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

        Ok(TurnReport {
            turn_id,
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventBus;
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
        }
    }

    fn engine() -> ServerEngine {
        ServerEngine::new(
            spec(),
            EventHub::new(Arc::new(EventBus::new())),
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
        let host = ServerHost;

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
}
