//! Native `Agent` tool — the foreground core of v2's `SubagentTool` (P46).
//!
//! Scope (deliberately narrow): a foreground `Agent` call with a known
//! profile runs an inline subagent turn through the same native pipeline
//! (permission gate, stale/plan/dedup guards, truncation) and reports the
//! v2-shaped result. Everything the v2 tool supports beyond that stays
//! host-owned by falling back (returning `None`):
//! - `resume` / `fork` / `run_in_background` / `model` arguments
//! - profiles missing from the pushed snapshot (plugin sources, external
//!   backends like claude-code/codex)
//! - a turn without an injected subagent runtime
//!
//! The host keeps its `Agent` tool registered either way, so a fallback is
//! a routing decision, never a capability loss.

use std::sync::Arc;

use crate::subagent::SubagentManager;
use crate::subagent::manager::ForegroundTurnOutcome;
use crate::subagent::types::ParentCancel;
use crate::turn_loop::types::{ExecutableToolResult, LoopTurnStopReason};

/// The v2 default profile name (`DEFAULT_PROFILE_NAME`).
pub const DEFAULT_PROFILE_NAME: &str = "coder";

/// The default foreground timeout (v2 `DEFAULT_SUBAGENT_TIMEOUT_MS`: 2h).
pub const DEFAULT_SUBAGENT_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000;

/// The v2 stopped messages (`agent/tools/agent/agent.ts`), byte-identical.
const SUBAGENT_STOPPED_MESSAGE: &str = "The subagent was stopped before it finished.";
const USER_INTERRUPTED_SUBAGENT_MESSAGE: &str =
    "The subagent was stopped before it finished by user.";

/// The v2 timeout resume hint (`formatForegroundAgentFailure`), verbatim.
fn timeout_resume_hint(agent_id: &str) -> String {
    format!(
        "resume_hint: Continue with Agent(resume=\"{agent_id}\", prompt=\"continue\"). \
Use agent_id only; do not set subagent_type. The subagent retains its prior context; \
redo any unfinished tool call if its result was lost."
    )
}

/// The v2 timeout duration rendering (`formatSubagentTimeoutDescription`).
pub fn format_timeout_description(ms: u64) -> String {
    const HOUR: u64 = 60 * 60 * 1000;
    const MINUTE: u64 = 60 * 1000;
    if ms.is_multiple_of(HOUR) {
        let h = ms / HOUR;
        return format!("{h} hour{}", if h == 1 { "" } else { "s" });
    }
    if ms.is_multiple_of(MINUTE) {
        let m = ms / MINUTE;
        return format!("{m} minute{}", if m == 1 { "" } else { "s" });
    }
    if ms.is_multiple_of(1000) {
        let s = ms / 1000;
        return format!("{s} second{}", if s == 1 { "" } else { "s" });
    }
    format!("{ms} ms")
}

fn string_arg(args: &serde_json::Value, name: &str) -> Option<String> {
    args.get(name)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Whether the call must run on the host: a feature the engine scope does
/// not absorb. `fork` and the call-level `model` override stay host-owned;
/// `resume` is resolved per-id at execution time (native when we hold the
/// conversation history); `run_in_background` runs natively since P58.
pub fn requires_host(args: &serde_json::Value) -> bool {
    args.get("fork").and_then(|v| v.as_bool()) == Some(true) || string_arg(args, "model").is_some()
}

/// The v2 success shape (`formatForegroundAgentSuccess`).
fn format_success(agent_id: &str, profile: &str, summary: &str) -> String {
    format!(
        "agent_id: {agent_id}\nactual_subagent_type: {profile}\nstatus: completed\n\n[summary]\n{summary}"
    )
}

/// The v2 failure shape (`formatForegroundAgentFailure`); the timeout case
/// appends the resume hint.
fn format_failure(agent_id: &str, profile: &str, message: &str, timed_out: bool) -> String {
    let mut text = format!(
        "agent_id: {agent_id}\nactual_subagent_type: {profile}\nstatus: failed\n\nsubagent error: {message}"
    );
    if timed_out {
        text.push('\n');
        text.push_str(&timeout_resume_hint(agent_id));
    }
    text
}

/// Fire-and-forget subagent lifecycle event to the host (v2
/// `mirrorAgentRun` event surface: `SubagentSpawned` / `SubagentStarted` /
/// `SubagentCompleted` / `SubagentFailed`; the adapter maps them onto the
/// host's event dispatcher).
fn emit_subagent_event(callbacks: &dyn crate::callbacks::HostCallbacks, event: serde_json::Value) {
    callbacks.emit_event(event);
}

/// The spawned + started event pair (P59 extraction: identical at all four
/// launch sites — foreground, resume, background).
fn emit_spawned_started(
    callbacks: &dyn crate::callbacks::HostCallbacks,
    agent_id: &str,
    profile_name: &str,
    tool_call_id: Option<&str>,
    description: Option<&str>,
    run_in_background: bool,
) {
    emit_subagent_event(
        callbacks,
        serde_json::json!({
            "type": "subagent.spawned",
            "subagent_id": agent_id,
            "subagent_name": profile_name,
            "parent_tool_call_id": tool_call_id,
            "description": description,
            "run_in_background": run_in_background,
        }),
    );
    emit_subagent_event(
        callbacks,
        serde_json::json!({ "type": "subagent.started", "subagent_id": agent_id }),
    );
}

fn emit_completed(
    callbacks: &dyn crate::callbacks::HostCallbacks,
    agent_id: &str,
    summary: &str,
    usage: &crate::rpc::types::TokenUsage,
) {
    emit_subagent_event(
        callbacks,
        serde_json::json!({
            "type": "subagent.completed",
            "subagent_id": agent_id,
            "result_summary": summary,
            "usage": usage_json(usage),
        }),
    );
}

fn emit_failed(callbacks: &dyn crate::callbacks::HostCallbacks, agent_id: &str, error: &str) {
    emit_subagent_event(
        callbacks,
        serde_json::json!({
            "type": "subagent.failed",
            "subagent_id": agent_id,
            "error": error,
        }),
    );
}

fn usage_json(usage: &crate::rpc::types::TokenUsage) -> serde_json::Value {
    serde_json::json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "input_cache_read": usage.input_cache_read,
        "input_cache_creation": usage.input_cache_creation,
    })
}

/// Execute a native `resume`: continue a conversation the manager still
/// holds. Returns `None` when the id is unknown (host-owned persistent
/// scopes) so the call falls back verbatim.
async fn execute_resume(
    manager: &Arc<SubagentManager>,
    args: &serde_json::Value,
    resume_id: &str,
    timeout_ms: Option<u64>,
    parent_cancel: Option<&ParentCancel>,
    tool_call_id: Option<&str>,
) -> Option<ExecutableToolResult> {
    let profile_name = manager.resume_profile(resume_id).await?;
    let runtime = manager.runtime().await?;
    let prompt = string_arg(args, "prompt").unwrap_or_default();

    emit_spawned_started(
        runtime.callbacks.as_ref(),
        resume_id,
        &profile_name,
        tool_call_id,
        None,
        false,
    );

    let timeout = timeout_ms
        .filter(|t| *t > 0)
        .unwrap_or(DEFAULT_SUBAGENT_TIMEOUT_MS);
    let run = tokio::time::timeout(
        std::time::Duration::from_millis(timeout),
        manager.resume_foreground_turn(resume_id, &prompt, parent_cancel),
    )
    .await;

    let run = match run {
        // The manager answered `None` only if its runtime vanished mid-call;
        // surface it as a regular failure instead of a fallback.
        Ok(None) => Ok(Some(Err("resume state was lost".to_string()))),
        other => other,
    };

    let (content, is_error) = match run {
        Ok(Some(Ok(ForegroundTurnOutcome::Completed(turn)))) => {
            let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
            emit_completed(runtime.callbacks.as_ref(), resume_id, &summary, &turn.usage);
            (format_success(resume_id, &profile_name, &summary), false)
        }
        Ok(Some(Ok(ForegroundTurnOutcome::ParentCancelled))) => (
            format_failure(
                resume_id,
                &profile_name,
                USER_INTERRUPTED_SUBAGENT_MESSAGE,
                false,
            ),
            true,
        ),
        Ok(Some(Err(message))) => {
            emit_subagent_event(
                runtime.callbacks.as_ref(),
                serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": resume_id,
                    "error": message,
                }),
            );
            (
                format_failure(resume_id, &profile_name, &message, false),
                true,
            )
        }
        Ok(None) => {
            // Runtime vanished mid-call; surface it as a regular failure.
            let message = "resume state was lost".to_string();
            emit_subagent_event(
                runtime.callbacks.as_ref(),
                serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": resume_id,
                    "error": message,
                }),
            );
            (
                format_failure(resume_id, &profile_name, &message, false),
                true,
            )
        }
        Err(_elapsed) => {
            let _ = manager.kill(resume_id).await;
            let message = format!(
                "Agent timed out after {}.",
                format_timeout_description(timeout)
            );
            emit_subagent_event(
                runtime.callbacks.as_ref(),
                serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": resume_id,
                    "error": message,
                }),
            );
            (
                format_failure(resume_id, &profile_name, &message, true),
                true,
            )
        }
    };
    Some(ExecutableToolResult {
        content,
        is_error,
        note: None,
    })
}

/// Execute the `Agent` tool natively (foreground core). Returns `None`
/// when the call must fall back to the host — see the module docs.
pub async fn execute_agent(
    manager: &Arc<SubagentManager>,
    args: &serde_json::Value,
    timeout_ms: Option<u64>,
    parent_cancel: Option<&ParentCancel>,
    tool_call_id: Option<&str>,
) -> Option<ExecutableToolResult> {
    if requires_host(args) {
        return None;
    }
    // Native resume (P55): a `resume` for an agent whose conversation we
    // hold continues natively; unknown ids stay host-owned (v2 persistent
    // scopes live there).
    if let Some(resume_id) = string_arg(args, "resume") {
        return execute_resume(
            manager,
            args,
            &resume_id,
            timeout_ms,
            parent_cancel,
            tool_call_id,
        )
        .await;
    }
    let profile_name =
        string_arg(args, "subagent_type").unwrap_or_else(|| DEFAULT_PROFILE_NAME.into());
    // Unknown profiles stay host-owned: plugin sources and external
    // backends never reach the pushed snapshot.
    manager.get_definition(&profile_name).await?;
    // No injected runtime (unwired transport) — the host tool still works.
    let runtime = manager.runtime().await?;

    let prompt = string_arg(args, "prompt").unwrap_or_default();
    let description = string_arg(args, "description").unwrap_or_default();

    // P58: background execution — spawn, launch detached, return the v2
    // running shape immediately. Completion flows back through the
    // `subagent.completed` / `subagent.failed` lifecycle events, which the
    // host turns into the usual synthetic notification turn.
    if args.get("run_in_background").and_then(|v| v.as_bool()) == Some(true) {
        let agent_id = manager.spawn(&profile_name, &description).await.ok()?;
        emit_spawned_started(
            runtime.callbacks.as_ref(),
            &agent_id,
            &profile_name,
            tool_call_id,
            Some(&description),
            true,
        );
        let mgr = manager.clone();
        let cb = runtime.callbacks.clone();
        let agent = agent_id.clone();
        tokio::spawn(async move {
            let _ = mgr
                .run_foreground_turn(&agent, &prompt, None)
                .await
                .map(|outcome| {
                    if let ForegroundTurnOutcome::Completed(turn) = outcome {
                        let summary =
                            crate::subagent::manager::final_assistant_summary(&turn.messages);
                        cb.emit_event(serde_json::json!({
                            "type": "subagent.completed",
                            "subagent_id": agent,
                            "result_summary": summary,
                            "usage": usage_json(&turn.usage),
                        }));
                    }
                });
        });
        let content = [
            format!("task_id: {agent_id}"),
            "status: running".into(),
            format!("agent_id: {agent_id}"),
            format!("actual_subagent_type: {profile_name}"),
            "automatic_notification: true".into(),
            String::new(),
            format!("description: {description}"),
            String::new(),
            "next_step: The completion arrives automatically in a later turn — do NOT wait, \
             poll, or call TaskOutput on it; continue with other work or hand back to the user. \
             (If you have nothing to do until it finishes, run such tasks in the foreground next time.)"
                .into(),
            format!(
                "resume_hint: To continue or recover this same subagent later, call \
                 Agent(resume=\"{agent_id}\", prompt=\"...\"). The parameter is agent_id \
                 (\"{agent_id}\"), NOT task_id."
            ),
        ]
        .join("\n");
        return Some(ExecutableToolResult {
            content,
            is_error: false,
            note: None,
        });
    }

    // Spawn first so the id exists even if the run times out (the failure
    // text carries it, matching v2).
    let agent_id = manager.spawn(&profile_name, &description).await.ok()?;

    // v2 `emitAgentRunSpawned` + `mirrorAgentRun`'s SubagentStarted: the
    // host dispatches the same lifecycle events the host-side subagent
    // path does, keyed by the parent tool call id.
    emit_spawned_started(
        runtime.callbacks.as_ref(),
        &agent_id,
        &profile_name,
        tool_call_id,
        Some(&description),
        false,
    );

    let timeout = timeout_ms
        .filter(|t| *t > 0)
        .unwrap_or(DEFAULT_SUBAGENT_TIMEOUT_MS);

    let run = tokio::time::timeout(
        std::time::Duration::from_millis(timeout),
        manager.run_foreground_turn(&agent_id, &prompt, parent_cancel),
    )
    .await;

    let (content, is_error) = match run {
        Ok(Ok(ForegroundTurnOutcome::Completed(turn))) => {
            if matches!(turn.stop_reason, LoopTurnStopReason::Aborted) {
                let interrupted = parent_cancel.is_some_and(|signal| signal.triggered());
                let message = if interrupted {
                    USER_INTERRUPTED_SUBAGENT_MESSAGE
                } else {
                    SUBAGENT_STOPPED_MESSAGE
                };
                (
                    format_failure(&agent_id, &profile_name, message, false),
                    true,
                )
            } else {
                let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
                emit_subagent_event(
                    runtime.callbacks.as_ref(),
                    serde_json::json!({
                        "type": "subagent.completed",
                        "subagent_id": agent_id,
                        "result_summary": summary,
                        "usage": usage_json(&turn.usage),
                    }),
                );
                (format_success(&agent_id, &profile_name, &summary), false)
            }
        }
        Ok(Ok(ForegroundTurnOutcome::ParentCancelled)) => {
            // v2 suppresses the failure event for aborts; the user-interruption
            // message still becomes the tool result.
            (
                format_failure(
                    &agent_id,
                    &profile_name,
                    USER_INTERRUPTED_SUBAGENT_MESSAGE,
                    false,
                ),
                true,
            )
        }
        Ok(Err(message)) => {
            emit_failed(runtime.callbacks.as_ref(), &agent_id, &message);
            (
                format_failure(&agent_id, &profile_name, &message, false),
                true,
            )
        }
        Err(_elapsed) => {
            let _ = manager.kill(&agent_id).await;
            let message = format!(
                "Agent timed out after {}.",
                format_timeout_description(timeout)
            );
            emit_failed(runtime.callbacks.as_ref(), &agent_id, &message);
            (
                format_failure(&agent_id, &profile_name, &message, true),
                true,
            )
        }
    };
    Some(ExecutableToolResult {
        content,
        is_error,
        note: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::callbacks::HostCallbacks;
    use crate::rpc::types::{
        AskQuestionRequest, AskQuestionResponse, BoxFuture, ListToolsResponse, LlmChatRequest,
        LlmChatResponse, PermissionCheckRequest, PermissionDecision, TokenUsage,
        ToolExecuteRequest, ToolExecuteResponse,
    };
    use crate::subagent::types::SummaryPolicy;
    use crate::turn_loop::types::{
        LLM, LLMChatParams, LLMChatResponse as TurnChatResponse, ToolCall, ToolInfo,
    };
    use std::sync::Mutex;

    /// LLM that answers with one assistant text on the first call, then
    /// stops (a subagent that "summarizes" immediately).
    struct SummaryLlm;
    impl LLM for SummaryLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "summary-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            Box::pin(async {
                Ok(TurnChatResponse {
                    content: "findings: the loop is in run_turn.rs".into(),
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    /// LLM whose every answer is one tool call, forcing a long loop for
    /// timeout tests.
    struct ToolForeverLlm;
    impl LLM for ToolForeverLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "tool-forever-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            Box::pin(async {
                Ok(TurnChatResponse {
                    content: String::new(),
                    tool_calls: vec![ToolCall {
                        id: format!("tc-{}", fastrand::u64(..)),
                        name: "echo".into(),
                        arguments: serde_json::json!({}),
                    }],
                    finish_reason: Some("tool_calls".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    struct NoopCallbacks;
    impl HostCallbacks for NoopCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async {
                Ok(ToolExecuteResponse {
                    content: "ok".into(),
                    is_error: false,
                    note: None,
                })
            })
        }
        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }
        fn ask_question(
            &self,
            _: AskQuestionRequest,
        ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
            // A real table so tool-looping LLMs actually schedule calls
            // (the default error seam empties the table and ends the turn).
            Box::pin(async {
                Ok(ListToolsResponse {
                    tools: vec![ToolInfo {
                        name: "echo".into(),
                        description: "echo".into(),
                        input_schema: serde_json::json!({}),
                    }],
                })
            })
        }
    }

    async fn manager_with(llm: Arc<dyn LLM>) -> Arc<SubagentManager> {
        let manager = Arc::new(SubagentManager::new());
        manager.set_runtime(llm, Arc::new(NoopCallbacks)).await;
        manager
    }

    /// Register a profile without an allowlist so the looping LLM's `echo`
    /// tool survives the profile filter.
    async fn register_looper(manager: &SubagentManager) {
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "looper".into(),
                description: "loops".into(),
                system_prompt: "You loop.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
    }

    #[test]
    fn requires_host_routes_extended_features() {
        // P55: resume is resolved per-id at execution time, not routed here.
        assert!(!requires_host(&serde_json::json!({ "resume": "agent-1" })));
        assert!(requires_host(&serde_json::json!({ "fork": true })));
        // P58: run_in_background runs natively (detached spawn + completion
        // events); the host task system bridges the notification.
        assert!(!requires_host(
            &serde_json::json!({ "run_in_background": true })
        ));
        assert!(requires_host(&serde_json::json!({ "model": "k2" })));
        assert!(!requires_host(&serde_json::json!({
            "subagent_type": "research",
            "prompt": "go"
        })));
        // Blank resume is normalized away by v2's preprocess — not a resume.
        assert!(!requires_host(&serde_json::json!({ "resume": "  " })));
    }

    #[tokio::test]
    async fn resume_continues_a_completed_foreground_conversation() {
        let recorder = Arc::new(EventRecorder::new());
        let llm = Arc::new(RecordingPromptLlm::new(vec![
            "first pass findings".into(),
            "follow-up answer".into(),
        ]));
        let manager = manager_with_callbacks(llm.clone(), recorder.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let first = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "research", "prompt": "go" }),
            None,
            None,
            None,
        )
        .await
        .expect("first turn runs natively");
        assert!(!first.is_error);
        let agent_id = recorder.events.lock().unwrap()[0]["subagent_id"]
            .as_str()
            .unwrap()
            .to_string();

        let second = execute_agent(
            &manager,
            &serde_json::json!({ "resume": agent_id, "prompt": "continue" }),
            None,
            None,
            None,
        )
        .await
        .expect("native resume for a held conversation");
        assert!(!second.is_error);
        assert!(second.content.contains("follow-up answer"));
        assert_eq!(llm.call_count(), 2);
        // The resume turn saw the full prior conversation.
        let second_messages = llm.prompts.lock().unwrap().len();
        assert_eq!(second_messages, 2);
    }

    #[tokio::test]
    async fn unknown_resume_ids_stay_host_owned() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "resume": "agent-unknown", "prompt": "x" }),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_none(), "unknown resume ids fall back to the host");
    }

    /// A finish_reason of `length` maps to a MaxTokens stop — v2 fails the
    /// subagent run with a verbatim error instead of reporting a summary.
    struct MaxTokensLlm;
    impl LLM for MaxTokensLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "max-tokens-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _: LLMChatParams,
        ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            Box::pin(async {
                Ok(TurnChatResponse {
                    content: "partial".into(),
                    tool_calls: vec![],
                    finish_reason: Some("length".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    #[tokio::test]
    async fn max_tokens_truncation_fails_the_subagent_run() {
        let manager = manager_with(Arc::new(MaxTokensLlm)).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "research", "prompt": "go" }),
            None,
            None,
            None,
        )
        .await
        .expect("truncation is a native outcome, not a fallback");
        assert!(result.is_error);
        assert!(
            result
                .content
                .contains("Subagent turn failed before completing its final summary"),
            "v2 max_tokens error text: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn resume_turns_distill_under_the_same_policy() {
        let recorder = Arc::new(EventRecorder::new());
        let llm = Arc::new(RecordingPromptLlm::new(vec![
            "first pass summary that is long enough".into(),
            "short".into(),
            "follow-up answer with plenty of detail".into(),
        ]));
        let manager = manager_with_callbacks(llm.clone(), recorder.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: Some(SummaryPolicy {
                    min_chars: 20,
                    continuation_prompt: "Summarize fully.".into(),
                    retries: 1,
                }),
                model: None,
            })
            .await;
        let first = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "research", "prompt": "go" }),
            None,
            None,
            None,
        )
        .await
        .expect("first turn runs natively");
        assert!(!first.is_error);
        let agent_id = recorder.events.lock().unwrap()[0]["subagent_id"]
            .as_str()
            .unwrap()
            .to_string();

        let second = execute_agent(
            &manager,
            &serde_json::json!({ "resume": agent_id, "prompt": "more" }),
            None,
            None,
            None,
        )
        .await
        .expect("resume runs natively");
        assert!(!second.is_error);
        // three LLM calls: initial, resume turn, distillation continuation
        assert_eq!(llm.call_count(), 3);
        assert!(
            second
                .content
                .contains("follow-up answer with plenty of detail"),
            "the distilled continuation becomes the resume summary: {}",
            second.content
        );
    }

    #[test]
    fn timeout_description_mirrors_v2() {
        assert_eq!(format_timeout_description(2 * 60 * 60 * 1000), "2 hours");
        assert_eq!(format_timeout_description(60 * 60 * 1000), "1 hour");
        assert_eq!(format_timeout_description(5 * 60 * 1000), "5 minutes");
        assert_eq!(format_timeout_description(90 * 1000), "90 seconds");
        assert_eq!(format_timeout_description(1500), "1500 ms");
    }

    #[tokio::test]
    async fn foreground_success_formats_v2_shape() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "research",
                "prompt": "find the loop",
                "description": "Loop finder"
            }),
            None,
            None,
            None,
        )
        .await
        .expect("foreground call must run natively");
        assert!(!result.is_error);
        let content = result.content;
        assert!(content.contains("actual_subagent_type: research"));
        assert!(content.contains("status: completed"));
        assert!(content.contains("[summary]\nfindings: the loop is in run_turn.rs"));
        assert!(content.starts_with("agent_id: subagent-"));
    }

    #[tokio::test]
    async fn default_profile_is_coder() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        // The snapshot pushes `coder`; untyped calls must resolve to it.
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "coder".into(),
                description: "default".into(),
                system_prompt: "You code.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "prompt": "do it", "description": "x" }),
            None,
            None,
            None,
        )
        .await
        .expect("untyped call resolves to the coder profile");
        assert!(result.content.contains("actual_subagent_type: coder"));
    }

    #[tokio::test]
    async fn unknown_profile_falls_back_to_host() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "plugin-reviewer", "prompt": "x" }),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_none(), "unknown profiles stay host-owned");
    }

    #[tokio::test]
    async fn extended_features_fall_back_to_host() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        for args in [
            serde_json::json!({ "resume": "agent-9", "prompt": "x" }),
            serde_json::json!({ "run_in_background": true, "prompt": "x" }),
        ] {
            assert!(
                execute_agent(&manager, &args, None, None, None)
                    .await
                    .is_none(),
                "host-only feature must fall back: {args}"
            );
        }
    }

    #[tokio::test]
    async fn timeout_reports_v2_failure_shape() {
        let manager = manager_with(Arc::new(ToolForeverLlm)).await;
        register_looper(&manager).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "looper", "prompt": "loop forever" }),
            Some(300),
            None,
            None,
        )
        .await
        .expect("timeout is a native outcome, not a fallback");
        assert!(result.is_error);
        assert!(result.content.contains("status: failed"));
        assert!(result.content.contains("Agent timed out after 300 ms."));
        assert!(result.content.contains("resume_hint:"));
    }

    #[tokio::test]
    async fn parent_cancellation_interrupts_the_subagent() {
        let manager = manager_with(Arc::new(ToolForeverLlm)).await;
        register_looper(&manager).await;
        let parent_cancel = ParentCancel::new();
        let signal = parent_cancel.clone();
        let abort_task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            signal.trigger();
        });
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "looper", "prompt": "loop until aborted" }),
            Some(60_000),
            Some(&parent_cancel),
            None,
        )
        .await
        .expect("abort is a native outcome, not a fallback");
        abort_task.await.unwrap();
        assert!(result.is_error);
        assert!(
            result.content.contains(USER_INTERRUPTED_SUBAGENT_MESSAGE),
            "parent abort reports the user-interrupted message: {}",
            result.content
        );
    }

    #[test]
    fn tool_policy_filter_allowlist_and_disallowed() {
        use crate::subagent::manager::ToolPolicyFilter;
        use crate::subagent::types::SubagentDefinition;
        let allow = ToolPolicyFilter::from_definition(&SubagentDefinition {
            name: "a".into(),
            description: String::new(),
            system_prompt: String::new(),
            tools: vec!["read".into(), "grep".into()],
            disallowed_tools: vec![],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        });
        assert!(allow.allows("Read"));
        assert!(allow.allows("grep"));
        assert!(!allow.allows("bash"));

        let deny = ToolPolicyFilter::from_definition(&SubagentDefinition {
            name: "b".into(),
            description: String::new(),
            system_prompt: String::new(),
            tools: vec![],
            disallowed_tools: vec!["Bash".into()],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        });
        assert!(deny.allows("read"));
        assert!(!deny.allows("bash"));
    }

    /// LLM that records the user content of every chat call, so tests can
    /// assert the prompt prefix and the continuation turn reached the model.
    struct RecordingPromptLlm {
        prompts: Mutex<Vec<String>>,
        /// Content returned per call (cycled on the last entry).
        responses: Vec<String>,
        calls: Mutex<usize>,
    }

    impl RecordingPromptLlm {
        fn new(responses: Vec<String>) -> Self {
            Self {
                prompts: Mutex::new(Vec::new()),
                responses,
                calls: Mutex::new(0),
            }
        }

        fn call_count(&self) -> usize {
            *self.calls.lock().unwrap()
        }

        fn first_prompt(&self) -> String {
            self.prompts.lock().unwrap()[0].clone()
        }
    }

    impl LLM for RecordingPromptLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "recording-prompt-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            params: LLMChatParams,
        ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let mut prompts = self.prompts.lock().unwrap();
            if let Some(last_user) = params
                .messages
                .iter()
                .rev()
                .find(|m| m.role == "user" && !m.content.starts_with("<system-reminder>"))
            {
                prompts.push(last_user.content.clone());
            }
            drop(prompts);
            let mut calls = self.calls.lock().unwrap();
            let index = (*calls).min(self.responses.len() - 1);
            *calls += 1;
            let content = self.responses[index].clone();
            drop(calls);
            Box::pin(async move {
                Ok(TurnChatResponse {
                    content,
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    /// [`NoopCallbacks`] that records the `emit_event` payloads.
    struct EventRecorder {
        inner: NoopCallbacks,
        events: Mutex<Vec<serde_json::Value>>,
    }

    impl EventRecorder {
        fn new() -> Self {
            Self {
                inner: NoopCallbacks,
                events: Mutex::new(Vec::new()),
            }
        }

        fn types(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| event.get("type").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        }
    }

    impl HostCallbacks for EventRecorder {
        fn llm_chat(
            &self,
            request: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            self.inner.llm_chat(request)
        }
        fn execute_tool(
            &self,
            request: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.inner.execute_tool(request)
        }
        fn check_permission(
            &self,
            request: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            self.inner.check_permission(request)
        }
        fn emit_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event);
        }
    }

    async fn manager_with_callbacks(
        llm: Arc<dyn LLM>,
        callbacks: Arc<dyn HostCallbacks>,
    ) -> Arc<SubagentManager> {
        let manager = Arc::new(SubagentManager::new());
        manager.set_runtime(llm, callbacks).await;
        manager
    }

    #[tokio::test]
    async fn prompt_prefix_rides_ahead_of_the_prompt() {
        let llm = Arc::new(RecordingPromptLlm::new(vec!["done".into()]));
        let manager = manager_with(llm.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "explore".into(),
                description: "d".into(),
                system_prompt: "You explore.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: Some("<git-context>".into()),
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "explore", "prompt": "scan it" }),
            None,
            None,
            None,
        )
        .await
        .expect("prefix profile runs natively");
        assert!(!result.is_error);
        let prompt = llm.first_prompt();
        assert!(
            prompt.contains("<git-context>\n\nscan it"),
            "prefix rides ahead of the prompt as {{prefix}}\\n\\n{{prompt}}: {prompt}"
        );
        assert_eq!(llm.call_count(), 1, "no policy: no continuation turns");
    }

    #[tokio::test]
    async fn summary_policy_distills_through_continuation_turns() {
        let llm = Arc::new(RecordingPromptLlm::new(vec![
            "too short".into(),
            "a much longer final summary that clearly clears the floor".into(),
        ]));
        let manager = manager_with(llm.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "coder".into(),
                description: "d".into(),
                system_prompt: "You code.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: Some(SummaryPolicy {
                    min_chars: 20,
                    continuation_prompt: "Summarize fully.".into(),
                    retries: 2,
                }),
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "coder", "prompt": "do it" }),
            None,
            None,
            None,
        )
        .await
        .expect("distill runs natively");
        assert!(!result.is_error);
        assert!(
            result
                .content
                .contains("[summary]\na much longer final summary that clearly clears the floor"),
            "the adequate continuation text becomes the summary: {}",
            result.content
        );
        assert_eq!(llm.call_count(), 2, "one continuation turn");
        let second_prompt = llm.prompts.lock().unwrap()[1].clone();
        assert_eq!(second_prompt, "Summarize fully.");
    }

    #[tokio::test]
    async fn adequate_summary_skips_distillation() {
        let long = "x".repeat(200);
        let llm = Arc::new(RecordingPromptLlm::new(vec![long.clone()]));
        let manager = manager_with(llm.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "coder".into(),
                description: "d".into(),
                system_prompt: "You code.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: Some(SummaryPolicy {
                    min_chars: 100,
                    continuation_prompt: "continue".into(),
                    retries: 1,
                }),
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "coder", "prompt": "do it" }),
            None,
            None,
            None,
        )
        .await
        .expect("runs natively");
        assert!(!result.is_error);
        assert_eq!(llm.call_count(), 1, "adequate summary: no re-prompt");
        assert!(result.content.contains(&long));
    }

    #[tokio::test]
    async fn lifecycle_events_mirror_the_v2_surface() {
        let llm = Arc::new(RecordingPromptLlm::new(vec!["findings: all done".into()]));
        let recorder = Arc::new(EventRecorder::new());
        let manager = manager_with_callbacks(llm, recorder.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "research",
                "prompt": "go",
                "description": "Scout"
            }),
            None,
            None,
            Some("tool-call-7"),
        )
        .await
        .expect("runs natively");
        assert!(!result.is_error);
        assert_eq!(
            recorder.types(),
            vec![
                "subagent.spawned".to_string(),
                "subagent.started".to_string(),
                "subagent.completed".to_string(),
            ]
        );
        let events = recorder.events.lock().unwrap();
        let spawned = &events[0];
        assert_eq!(spawned["subagent_name"], "research");
        assert_eq!(spawned["parent_tool_call_id"], "tool-call-7");
        assert_eq!(spawned["description"], "Scout");
        assert_eq!(spawned["run_in_background"], false);
        let agent_id = spawned["subagent_id"].as_str().unwrap();
        assert!(agent_id.starts_with("subagent-"));
        assert_eq!(events[1]["subagent_id"], spawned["subagent_id"]);
        assert_eq!(events[2]["result_summary"], "findings: all done");
        assert!(events[2]["usage"]["total_tokens"].is_number());
    }
}
