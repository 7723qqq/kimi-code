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
use std::sync::atomic::{AtomicBool, Ordering};

use crate::subagent::SubagentManager;
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

/// Whether the call must run on the host: any feature the engine scope
/// does not absorb (resume / fork / background / model override).
pub fn requires_host(args: &serde_json::Value) -> bool {
    string_arg(args, "resume").is_some()
        || args.get("fork").and_then(|v| v.as_bool()) == Some(true)
        || args.get("run_in_background").and_then(|v| v.as_bool()) == Some(true)
        || string_arg(args, "model").is_some()
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

/// Execute the `Agent` tool natively (foreground core). Returns `None`
/// when the call must fall back to the host — see the module docs.
pub async fn execute_agent(
    manager: &Arc<SubagentManager>,
    args: &serde_json::Value,
    timeout_ms: Option<u64>,
    parent_cancel: Option<Arc<AtomicBool>>,
) -> Option<ExecutableToolResult> {
    if requires_host(args) {
        return None;
    }
    let profile_name =
        string_arg(args, "subagent_type").unwrap_or_else(|| DEFAULT_PROFILE_NAME.into());
    // Unknown profiles stay host-owned: plugin sources and external
    // backends never reach the pushed snapshot.
    manager.get_definition(&profile_name).await?;
    // No injected runtime (unwired transport) — the host tool still works.
    manager.runtime().await?;

    let prompt = string_arg(args, "prompt").unwrap_or_default();
    let description = string_arg(args, "description").unwrap_or_default();
    // Spawn first so the id exists even if the run times out (the failure
    // text carries it, matching v2).
    let agent_id = manager.spawn(&profile_name, &description).await.ok()?;
    let timeout = timeout_ms
        .filter(|t| *t > 0)
        .unwrap_or(DEFAULT_SUBAGENT_TIMEOUT_MS);

    let run = tokio::time::timeout(
        std::time::Duration::from_millis(timeout),
        manager.run_foreground_turn(&agent_id, &prompt, parent_cancel.clone()),
    )
    .await;

    let (content, is_error) = match run {
        Ok(Ok(turn)) => {
            if matches!(turn.stop_reason, LoopTurnStopReason::Aborted) {
                let interrupted = parent_cancel
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Relaxed));
                let message = if interrupted {
                    USER_INTERRUPTED_SUBAGENT_MESSAGE
                } else {
                    SUBAGENT_STOPPED_MESSAGE
                };
                (format_failure(&agent_id, &profile_name, message, false), true)
            } else {
                let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
                (format_success(&agent_id, &profile_name, &summary), false)
            }
        }
        Ok(Err(message)) => (format_failure(&agent_id, &profile_name, &message, false), true),
        Err(_elapsed) => {
            let _ = manager.kill(&agent_id).await;
            let message = format!(
                "Agent timed out after {}.",
                format_timeout_description(timeout)
            );
            (format_failure(&agent_id, &profile_name, &message, true), true)
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
    use crate::turn_loop::types::{
        LLM, LLMChatParams, LLMChatResponse as TurnChatResponse, ToolCall, ToolInfo,
    };

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
        manager
            .set_runtime(llm, Arc::new(NoopCallbacks))
            .await;
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
                model: None,
            })
            .await;
    }

    #[test]
    fn requires_host_routes_extended_features() {
        assert!(requires_host(&serde_json::json!({ "resume": "agent-1" })));
        assert!(requires_host(&serde_json::json!({ "fork": true })));
        assert!(requires_host(&serde_json::json!({ "run_in_background": true })));
        assert!(requires_host(&serde_json::json!({ "model": "k2" })));
        assert!(!requires_host(&serde_json::json!({
            "subagent_type": "research",
            "prompt": "go"
        })));
        // Blank resume is normalized away by v2's preprocess — not a resume.
        assert!(!requires_host(&serde_json::json!({ "resume": "  " })));
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
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "prompt": "do it", "description": "x" }),
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
                execute_agent(&manager, &args, None, None).await.is_none(),
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
        let parent_flag = Arc::new(AtomicBool::new(false));
        let flag_for_abort = parent_flag.clone();
        let abort_task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            flag_for_abort.store(true, Ordering::Relaxed);
        });
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "looper", "prompt": "loop until aborted" }),
            Some(60_000),
            Some(parent_flag.clone()),
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
            model: None,
        });
        assert!(deny.allows("read"));
        assert!(!deny.allows("bash"));
    }
}
