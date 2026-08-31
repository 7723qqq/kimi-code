//! Event-driven, stateless turn loop with resource-conflict-aware tool
//! scheduling.
//!
//! Flow per step:
//!   1. Call the LLM with the current message history + tool definitions.
//!   2. If the response has tool calls, schedule them via
//!      [`tool_scheduler::schedule_tool_calls`]: calls whose declared
//!      resource accesses conflict run in separate batches (serial),
//!      non-conflicting calls run concurrently within a batch.
//!   3. Append tool results to the message history.
//!   4. Continue to the next step, or finish when the LLM stops.
//!
//! Tooling is delegated to the JS host through [`HostCallbacks`]; this
//! module only drives control flow and applies conflict scheduling.

use std::sync::Arc;

use super::retry::RetryConfig;
use super::tool_scheduler::{self, ScheduledToolCall};
use super::turn_step::execute_loop_step_with_retry;
use super::types::*;
use crate::callbacks::HostCallbacks;
use crate::rpc::types::{BoxFuture, TokenUsage, ToolExecuteRequest};

/// Build a [`TurnResult`] with the turn's telemetry counters.
///
/// `events_emitted`, `llm_transport` and `native_tool_calls` are left empty
/// here and filled by the composition root (see
/// [`crate::callbacks::CountingCallbacks`] and
/// [`crate::callbacks::NativeToolCallbacks`]); the LLM retry count is
/// accumulated in this loop from per-step attempt figures.
fn turn_result(
    stop_reason: LoopTurnStopReason,
    steps: u32,
    usage: TokenUsage,
    events_emitted: u32,
    llm_retries: u32,
) -> TurnResult {
    TurnResult {
        stop_reason,
        steps,
        usage,
        events_emitted,
        llm_retries,
        llm_transport: String::new(),
        native_tool_calls: 0,
    }
}

/// Map a provider finish reason onto a turn-level stop reason.
///
/// `length` (OpenAI) / `max_tokens` (Anthropic) mean the response was cut off
/// by the token limit → `MaxTokens`; `content_filter` → `Filtered`;
/// everything else ends the turn normally.
fn turn_stop_reason_from_finish(finish_reason: Option<&str>) -> LoopTurnStopReason {
    match finish_reason {
        Some("length") | Some("max_tokens") => LoopTurnStopReason::MaxTokens,
        Some("content_filter") => LoopTurnStopReason::Filtered,
        _ => LoopTurnStopReason::EndTurn,
    }
}

/// Run a single turn.
#[tracing::instrument(name = "run_turn", skip_all, fields(turn_id = %input.turn_id, max_steps = input.max_steps, has_goal = input.goal.is_some()))]
pub fn run_turn<'a>(
    input: RunTurnInput<'a>,
    callbacks: &'a Arc<dyn HostCallbacks>,
) -> BoxFuture<'a, Result<TurnResult, Box<dyn std::error::Error + 'a>>> {
    let turn_id = input.turn_id.clone();
    let max_steps = input.max_steps.max(1);
    let user_messages = input.messages.clone();
    let tool_defs = input.tool_defs.clone();
    let goal = input.goal.clone();

    Box::pin(async move {
        let mut total_usage = crate::rpc::types::TokenUsage::default();
        let mut steps: u32 = 0;
        // LLM retries performed so far (attempts beyond the first per step);
        // surfaced on the turn result as a telemetry figure. Event counting
        // lives at the composition root, hence the zero here.
        let mut llm_retries: u32 = 0;
        // Provider finish reason of the most recent step, consulted when the
        // turn ends to surface provider-side truncation/filtering.
        let mut last_finish_reason: Option<String> = None;

        // Turn wall-clock anchor for the goal's wall-clock budget.
        let turn_started = std::time::Instant::now();
        let elapsed_wall_clock_ms = |started: std::time::Instant| {
            started.elapsed().as_millis().min(i64::MAX as u128) as i64
        };

        // Build system prompt, optionally enriched with goal steering text.
        let system_prompt = if let Some(ref goal) = goal {
            format!(
                "{}\n\n{}",
                input.llm.system_prompt(),
                render_goal_steering(goal, 0, 0, 0)
            )
        } else {
            input.llm.system_prompt().to_string()
        };
        let mut messages = vec![LLMMessage {
            role: "system".into(),
            content: system_prompt,
            ..Default::default()
        }];
        messages.extend(user_messages);

        // Default retry configuration for LLM calls within this turn.
        let retry_config = RetryConfig::default();

        // Context compaction knobs. The engine has no model capability
        // data, so the window defaults to a fixed 128k-token budget.
        let compaction_config = crate::compaction::CompactionConfig::default();

        // Turn-level injection registry. The built-in date-change and
        // workspace-AGENTS.md reminders are registered by `with_defaults`;
        // goal/plan-mode providers register from the local state store.
        //
        // The state store is created only on the paths that actually build
        // injections: `StateStore::for_workspace` creates `<cwd>/.kimi/state/`,
        // and in host-proxy mode the host owns both the transcript and the
        // state, so creating that directory here would be a side effect with
        // no consumer — it would leave an untracked directory behind in
        // whatever workspace the user happened to run in.
        let mut injection_registry = crate::injection::InjectionRegistry::with_defaults();
        if input.llm.transport() != "host-proxy"
            && let Ok(cwd) = std::env::current_dir()
            && let Ok(store) = crate::storage::state_store::StateStore::for_workspace(&cwd)
        {
            crate::injection::goal_plan::register_goal_plan_injections(
                &mut injection_registry,
                std::sync::Arc::new(store),
            );
        }

        for step_num in 0..max_steps {
            steps = step_num + 1;
            let turn_wall_clock_ms = elapsed_wall_clock_ms(turn_started);

            // ── Goal budget check ──────────────────────────────────────────
            // Before each step, verify the goal is still active and within
            // budget. If the host paused/blocked it or a budget is exhausted,
            // stop the turn immediately.
            if let Some(ref goal) = goal {
                if !goal.status.is_active() {
                    let reason = match goal.status {
                        GoalStatus::Paused => LoopTurnStopReason::Paused,
                        GoalStatus::Blocked => LoopTurnStopReason::Aborted,
                        _ => LoopTurnStopReason::EndTurn,
                    };
                    return Ok(turn_result(
                        reason,
                        step_num, // this step didn't run
                        total_usage,
                        0,
                        llm_retries,
                    ));
                }
                // Check budgets with cumulative usage so far.
                let turn_tokens = total_usage.total_tokens as i64;
                let turns_this_turn = step_num as i64;
                if goal.would_exceed_budget(turn_tokens, turns_this_turn, turn_wall_clock_ms) {
                    callbacks.emit_event(serde_json::json!({
                        "type": "goal.budget.limit_reached",
                        "turn_id": turn_id,
                        "goal_id": goal.goal_id,
                    }));
                    return Ok(turn_result(
                        LoopTurnStopReason::BudgetLimited,
                        step_num,
                        total_usage,
                        0,
                        llm_retries,
                    ));
                }
                // Update steering text in system prompt with current progress.
                let steering =
                    render_goal_steering(goal, turn_tokens, turns_this_turn, turn_wall_clock_ms);
                messages[0].content = format!("{}\n\n{}", input.llm.system_prompt(), steering);
            }

            // ── Cancellation check ────────────────────────────────────────
            // If the host sent a CANCEL_TURN request, the cancellation flag
            // is set. Abort the turn before calling the LLM.
            if let Some(ref cancel) = input.cancellation
                && cancel.load(std::sync::atomic::Ordering::Relaxed)
            {
                return Ok(turn_result(
                    LoopTurnStopReason::Aborted,
                    step_num,
                    total_usage,
                    0,
                    llm_retries,
                ));
            }

            // Drain mid-turn steering from host when engine owns the history.
            if input.llm.transport() != "host-proxy"
                && let Ok(steers) = callbacks.drain_steers().await
            {
                messages.extend(steers);
            }

            // ── Context compaction check ─────────────────────────────────
            // Before each LLM call, estimate the message history against
            // the context window. When it crosses the trigger threshold,
            // replace the oldest messages with a summary placeholder so
            // the turn can continue instead of failing on a context
            // overflow. Independent of the goal budget check above: the
            // goal budget stops the turn, compaction keeps it running.
            //
            // Injection messages never participate in compaction trimming
            // (v2 classifies them with `origin.kind === 'injection'`): they
            // are pulled out before compacting and re-appended after, so
            // reminders survive the windowing.
            let injections = crate::injection::split_injections(&mut messages);
            let compacted = crate::compaction::compact_messages(&messages, &compaction_config);
            if compacted.len() != messages.len() {
                tracing::debug!(
                    turn_id = %turn_id,
                    step = step_num,
                    before = messages.len(),
                    after = compacted.len(),
                    "compacted turn context before LLM call"
                );
            }
            let mut messages = compacted;
            messages.extend(injections);

            // ── Injection pass ───────────────────────────────────────────
            // Mirror v2's `onWillBeginStep` injection gate: build this
            // step's reminders (date change, workspace AGENTS.md, …) and
            // append them right before the LLM call. In host-proxy mode
            // the host owns the transcript and injects itself, so the
            // pass is skipped there to avoid duplicate reminders.
            if input.llm.transport() != "host-proxy" {
                for text in injection_registry.build_injections() {
                    messages.push(crate::injection::injection_message(text));
                }
            }

            // Delegate LLM call (with retry) to turn_step module.
            // Convert the 'static error to the turn's 'a-bounded error type.
            let step_result = execute_loop_step_with_retry(
                &turn_id,
                step_num,
                input.llm,
                messages.clone(),
                input.tools,
                tool_defs.clone(),
                &retry_config,
            )
            .await
            .map_err(|e| -> Box<dyn std::error::Error + 'a> {
                Box::new(std::io::Error::other(e.to_string()))
            })?;

            total_usage.input_tokens += step_result.usage.input_tokens;
            total_usage.output_tokens += step_result.usage.output_tokens;
            total_usage.total_tokens += step_result.usage.total_tokens;
            total_usage.input_cache_read += step_result.usage.input_cache_read;
            total_usage.input_cache_creation += step_result.usage.input_cache_creation;
            llm_retries += step_result.attempts.saturating_sub(1);
            last_finish_reason = step_result.finish_reason.clone();

            match step_result.stop_reason {
                LoopStepStopReason::Complete => {
                    return Ok(turn_result(
                        turn_stop_reason_from_finish(step_result.finish_reason.as_deref()),
                        steps,
                        total_usage,
                        0,
                        llm_retries,
                    ));
                }
                LoopStepStopReason::ToolCalls(tool_calls) => {
                    // Append ONE assistant message carrying all tool calls. Wire
                    // formats group an assistant turn's calls into a single
                    // message; keeping them structural (not flattened into
                    // `content`) lets a native provider round-trip them.
                    messages.push(LLMMessage {
                        role: "assistant".into(),
                        content: step_result.content.clone(),
                        blocks: Vec::new(),
                        tool_calls: tool_calls.clone(),
                        tool_call_id: None,
                    });

                    // Execute tools with resource-conflict scheduling:
                    // non-conflicting calls run concurrently, conflicting
                    // calls (e.g. two writes to the same file) are
                    // serialized across batches.
                    let exec_fn = {
                        let turn_id = turn_id.clone();
                        let callbacks = callbacks.clone();
                        move |tc: ToolCall| {
                            let turn_id = turn_id.clone();
                            let callbacks = callbacks.clone();
                            async move {
                                let req = ToolExecuteRequest {
                                    turn_id: turn_id.clone(),
                                    tool_call_id: tc.id.clone(),
                                    tool_name: tc.name.clone(),
                                    arguments: tc.arguments.clone(),
                                };
                                let response = callbacks
                                    .execute_tool(req)
                                    .await
                                    .map_err(|e| format!("Tool execution error: {e}"))?;
                                Ok(ExecutableToolResult {
                                    content: response.content,
                                    is_error: response.is_error,
                                    note: response.note,
                                })
                            }
                        }
                    };
                    let scheduled: Vec<ScheduledToolCall> = tool_calls
                        .iter()
                        .map(|tc| ScheduledToolCall {
                            tool_call: tc.clone(),
                            accesses: tool_scheduler::infer_tool_accesses(&tc.name, &tc.arguments),
                        })
                        .collect();
                    let results = match tool_scheduler::execute_scheduled(
                        input.cancellation.as_ref(),
                        scheduled,
                        exec_fn,
                    )
                    .await
                    {
                        Ok(results) => results,
                        Err(err) => {
                            // The scheduler stops mid-batch when the host
                            // cancels. That is a clean abort, not a failed
                            // turn — mirror the step-top and step-result paths.
                            let cancelled = input.cancellation.as_ref().is_some_and(|flag| {
                                flag.load(std::sync::atomic::Ordering::Relaxed)
                            });
                            if cancelled {
                                return Ok(turn_result(
                                    LoopTurnStopReason::Aborted,
                                    steps,
                                    total_usage,
                                    0,
                                    llm_retries,
                                ));
                            }
                            return Err(err);
                        }
                    };

                    // Insert tool results, each linked back to its call
                    // via `tool_call_id` (same call order as `tool_calls`).
                    for (i, tr) in results.iter().enumerate() {
                        messages.push(LLMMessage {
                            role: "tool".into(),
                            content: tr.content.clone(),
                            blocks: Vec::new(),
                            tool_calls: Vec::new(),
                            tool_call_id: tool_calls.get(i).map(|tc| tc.id.clone()),
                        });
                    }
                }
                LoopStepStopReason::Aborted => {
                    return Ok(turn_result(
                        LoopTurnStopReason::Aborted,
                        steps,
                        total_usage,
                        0,
                        llm_retries,
                    ));
                }
            }
        }

        // Turn ended (max_steps exhausted): surface the last step's provider
        // finish reason so truncation/filtering is not reported as a normal
        // completion.
        Ok(turn_result(
            turn_stop_reason_from_finish(last_finish_reason.as_deref()),
            steps,
            total_usage,
            0,
            llm_retries,
        ))
    })
}

// ── Goal steering ───────────────────────────────────────────────────────────

/// Render goal steering text injected into the system prompt.
///
/// Mirrors the TS `buildGoalReminder` format: objective, progress, budgets,
/// and convergence guidance when nearing a budget.
fn render_goal_steering(
    goal: &GoalContext,
    turn_tokens: i64,
    turns_this_turn: i64,
    turn_wall_clock_ms: i64,
) -> String {
    let mut lines = Vec::new();
    lines.push(format!("## Goal\n{}", goal.objective));

    // Progress line
    let total_tokens = goal.tokens_used + turn_tokens;
    let total_turns = goal.turns_used + turns_this_turn;
    let total_wall_clock_ms = goal.wall_clock_ms + turn_wall_clock_ms;
    lines.push(format!(
        "Progress: {} continuation turns, {} tokens consumed, {} elapsed.",
        total_turns,
        total_tokens,
        format_elapsed(total_wall_clock_ms)
    ));

    // Budgets line
    let mut budget_parts = Vec::new();
    if let Some(budget) = goal.token_budget {
        let remaining = (budget - total_tokens).max(0);
        budget_parts.push(format!(
            "tokens {}/{} (remaining {})",
            total_tokens, budget, remaining
        ));
    }
    if let Some(budget) = goal.turn_budget {
        let remaining = (budget - total_turns).max(0);
        budget_parts.push(format!(
            "turns {}/{} (remaining {})",
            total_turns, budget, remaining
        ));
    }
    if let Some(budget) = goal.wall_clock_budget_ms {
        let remaining = (budget - total_wall_clock_ms).max(0);
        budget_parts.push(format!(
            "time {}/{} (remaining {})",
            format_elapsed(total_wall_clock_ms),
            format_elapsed(budget),
            format_elapsed(remaining)
        ));
    }
    if !budget_parts.is_empty() {
        lines.push(format!("Budgets: {}.", budget_parts.join("; ")));
    }

    // Budget guidance
    let fraction = goal.budget_fraction(turn_tokens, turns_this_turn, turn_wall_clock_ms);
    if fraction >= 0.75 {
        lines.push(
            "Budget guidance: you are nearing a budget. \
             Converge on the objective and avoid starting new discretionary work."
                .to_string(),
        );
    } else {
        lines.push(
            "Budget guidance: you are within budget. \
             Make steady, focused progress toward the objective."
                .to_string(),
        );
    }

    lines.join("\n")
}

/// Format a millisecond duration compactly (`1m05s`, `2h00m`, …).
fn format_elapsed(ms: i64) -> String {
    let total_seconds = ms / 1000;
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let minutes = total_seconds / 60;
    if minutes < 60 {
        let seconds = total_seconds % 60;
        return format!("{minutes}m{seconds:02}s");
    }
    let hours = minutes / 60;
    format!("{hours}h{}m", minutes % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::callbacks::RpcHostCallbacks;
    use crate::rpc::server::RpcServer;
    use crate::rpc::types::{self, JsonRpcError, TokenUsage, ToolExecuteResponse};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    /// Helper: create an RpcHostCallbacks from an RpcServer.
    fn rpc_callbacks(server: Arc<RpcServer>) -> Arc<dyn HostCallbacks> {
        Arc::new(RpcHostCallbacks { server })
    }

    /// HostCallbacks decorator that records emitted events so tests can
    /// assert on fire-and-forget notifications (e.g. goal budget limits).
    struct EventCapturingCallbacks {
        inner: Arc<dyn HostCallbacks>,
        events: Arc<Mutex<Vec<serde_json::Value>>>,
    }

    impl EventCapturingCallbacks {
        fn new(inner: Arc<dyn HostCallbacks>) -> (Self, Arc<Mutex<Vec<serde_json::Value>>>) {
            let events = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    inner,
                    events: events.clone(),
                },
                events,
            )
        }
    }

    impl HostCallbacks for EventCapturingCallbacks {
        fn llm_chat(
            &self,
            request: crate::rpc::types::LlmChatRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
        {
            self.inner.llm_chat(request)
        }

        fn execute_tool(
            &self,
            request: crate::rpc::types::ToolExecuteRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            self.inner.execute_tool(request)
        }

        fn check_permission(
            &self,
            request: crate::rpc::types::PermissionCheckRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            self.inner.check_permission(request)
        }

        fn emit_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event.clone());
            self.inner.emit_event(event);
        }
    }

    struct PredictTestLlm {
        system_prompt: String,
        model_name: String,
        return_tool_calls: bool,
        tool_responses: Vec<ToolCall>,
    }

    impl LLM for PredictTestLlm {
        fn system_prompt(&self) -> &str {
            &self.system_prompt
        }
        fn model_name(&self) -> &str {
            &self.model_name
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }

        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let return_tc = self.return_tool_calls;
            let tcs = self.tool_responses.clone();
            Box::pin(async move {
                if return_tc {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: tcs,
                        finish_reason: Some("tool_calls".into()),
                        usage: TokenUsage {
                            input_tokens: 10,
                            output_tokens: 5,
                            total_tokens: 15,
                            ..Default::default()
                        },
                    })
                } else {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage {
                            input_tokens: 10,
                            output_tokens: 5,
                            total_tokens: 15,
                            ..Default::default()
                        },
                    })
                }
            })
        }
    }

    #[tokio::test]
    async fn test_run_turn_no_tool_calls() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };

        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let input = RunTurnInput {
            turn_id: "test-turn-1".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await;
        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.steps, 1);
    }

    #[tokio::test]
    async fn test_run_turn_no_tool_calls_with_messages() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };

        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let input = RunTurnInput {
            turn_id: "test-turn-3".into(),
            llm: &llm,
            messages: vec![
                LLMMessage {
                    role: "user".into(),
                    content: "First message".into(),
                    ..Default::default()
                },
                LLMMessage {
                    role: "user".into(),
                    content: "Second message".into(),
                    ..Default::default()
                },
            ],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await;
        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.steps, 1);
    }

    /// LLM that always completes with a fixed finish reason (no tool calls).
    struct FinishReasonLlm {
        finish_reason: &'static str,
    }
    impl LLM for FinishReasonLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "finish-reason-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let fr = self.finish_reason;
            Box::pin(async move {
                Ok(LLMChatResponse {
                    content: String::new(),
                    tool_calls: vec![],
                    finish_reason: Some(fr.into()),
                    usage: TokenUsage {
                        input_tokens: 1,
                        output_tokens: 1,
                        total_tokens: 2,
                        ..Default::default()
                    },
                })
            })
        }
    }

    #[tokio::test]
    async fn test_finish_reason_length_maps_to_max_tokens() {
        let llm = FinishReasonLlm {
            finish_reason: "length",
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-finish-length".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };
        let turn = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(turn.stop_reason, LoopTurnStopReason::MaxTokens));
    }

    #[tokio::test]
    async fn test_finish_reason_max_tokens_maps_to_max_tokens() {
        let llm = FinishReasonLlm {
            finish_reason: "max_tokens",
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-finish-max-tokens".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };
        let turn = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(turn.stop_reason, LoopTurnStopReason::MaxTokens));
    }

    #[tokio::test]
    async fn test_finish_reason_content_filter_maps_to_filtered() {
        let llm = FinishReasonLlm {
            finish_reason: "content_filter",
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-finish-filtered".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };
        let turn = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(turn.stop_reason, LoopTurnStopReason::Filtered));
    }

    #[tokio::test]
    async fn test_truncation_on_exhausted_steps_surfaces_max_tokens() {
        // The LLM always returns tool calls with a `length` finish reason;
        // the turn ends by max_steps exhaustion and must report MaxTokens,
        // not EndTurn.
        struct AlwaysToolTruncatedLlm;
        impl LLM for AlwaysToolTruncatedLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "always-tool-truncated"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                Box::pin(async move {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![ToolCall {
                            id: "tc1".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({"path": "/a.txt"}),
                        }],
                        finish_reason: Some("length".into()),
                        usage: TokenUsage {
                            input_tokens: 1,
                            output_tokens: 1,
                            total_tokens: 2,
                            ..Default::default()
                        },
                    })
                })
            }
        }
        let llm = AlwaysToolTruncatedLlm;
        let server = Arc::new(RpcServer::new());
        // Register a stub tool handler so the loop's per-step tool execution
        // does not block waiting for a host response.
        RpcServer::register_arc(&server, types::methods::HOST_EXECUTE_TOOL, |_params| {
            Box::pin(async move {
                let resp = ToolExecuteResponse {
                    content: "stub".into(),
                    is_error: false,
                    note: None,
                };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });
        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-exhausted-truncated".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 3,
            goal: None,
            cancellation: None,
        };
        let turn = run_turn(input, &callbacks).await.unwrap();
        assert_eq!(turn.steps, 3);
        assert!(matches!(turn.stop_reason, LoopTurnStopReason::MaxTokens));
    }

    #[tokio::test]
    async fn test_cache_usage_accumulates_across_steps() {
        struct CacheUsageLlm {
            call: AtomicU32,
        }
        impl LLM for CacheUsageLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "cache-usage-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.call.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call == 0 {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![ToolCall {
                                id: "tc1".into(),
                                name: "read".into(),
                                arguments: serde_json::json!({"path": "/a.txt"}),
                            }],
                            finish_reason: Some("tool_calls".into()),
                            usage: TokenUsage {
                                input_tokens: 10,
                                output_tokens: 5,
                                total_tokens: 15,
                                input_cache_read: 4,
                                input_cache_creation: 3,
                            },
                        })
                    } else {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![],
                            finish_reason: Some("stop".into()),
                            usage: TokenUsage {
                                input_tokens: 8,
                                output_tokens: 2,
                                total_tokens: 10,
                                input_cache_read: 6,
                                input_cache_creation: 1,
                            },
                        })
                    }
                })
            }
        }
        let llm = CacheUsageLlm {
            call: AtomicU32::new(0),
        };
        let server = Arc::new(RpcServer::new());
        RpcServer::register_arc(&server, types::methods::HOST_EXECUTE_TOOL, |_params| {
            Box::pin(async move {
                let resp = ToolExecuteResponse {
                    content: "stub".into(),
                    is_error: false,
                    note: None,
                };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });
        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-cache-usage".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };
        let turn = run_turn(input, &callbacks).await.unwrap();
        assert_eq!(turn.usage.input_tokens, 18);
        assert_eq!(turn.usage.output_tokens, 7);
        assert_eq!(turn.usage.input_cache_read, 10);
        assert_eq!(turn.usage.input_cache_creation, 4);
    }

    // ── Turn telemetry counters ─────────────────────────────────────────

    /// The turn result carries the LLM retry count: the transient failure
    /// on the first chat attempt counts as one retry.
    #[tokio::test]
    async fn test_turn_result_llm_retry_counter() {
        struct RetryOnceLlm {
            calls: AtomicU32,
        }
        impl LLM for RetryOnceLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "retry-once"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                true
            }

            fn chat(
                &self,
                _: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call == 0 {
                        return Err("transient failure".into());
                    }
                    Ok(LLMChatResponse {
                        content: "done".into(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage {
                            input_tokens: 1,
                            output_tokens: 1,
                            total_tokens: 2,
                            ..Default::default()
                        },
                    })
                })
            }
        }

        let llm = RetryOnceLlm {
            calls: AtomicU32::new(0),
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let input = RunTurnInput {
            turn_id: "test-retry-counter".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
        assert_eq!(result.llm_retries, 1, "one retryable failure is one retry");
        assert_eq!(
            result.events_emitted, 0,
            "event counting lives at the composition root"
        );
    }

    // ── Goal budget tests ───────────────────────────────────────────────

    /// A goal whose status is Paused must abort the turn before step 0,
    /// yielding `Paused` and 0 steps.
    #[tokio::test]
    async fn test_goal_paused_stops_before_first_step() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let goal = GoalContext {
            goal_id: "g1".into(),
            objective: "Do thing".into(),
            status: GoalStatus::Paused,
            token_budget: None,
            turn_budget: None,
            tokens_used: 0,
            turns_used: 0,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };

        let input = RunTurnInput {
            turn_id: "test-paused".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: Some(goal),
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::Paused));
        assert_eq!(result.steps, 0, "paused goal should not run any steps");
    }

    /// A goal whose status is Blocked must abort the turn before step 0,
    /// yielding `Aborted`.
    #[tokio::test]
    async fn test_goal_blocked_stops_before_first_step() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let goal = GoalContext {
            goal_id: "g2".into(),
            objective: "Do thing".into(),
            status: GoalStatus::Blocked,
            token_budget: None,
            turn_budget: None,
            tokens_used: 0,
            turns_used: 0,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };

        let input = RunTurnInput {
            turn_id: "test-blocked".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: Some(goal),
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::Aborted));
        assert_eq!(result.steps, 0);
    }

    /// A goal whose token budget is already exhausted (tokens_used >= budget)
    /// must stop with `BudgetLimited` before running any step.
    #[tokio::test]
    async fn test_goal_token_budget_exhausted() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let (capturing, captured_events) =
            EventCapturingCallbacks::new(rpc_callbacks(server.clone()));
        let capturing: Arc<dyn HostCallbacks> = Arc::new(capturing);

        let goal = GoalContext {
            goal_id: "g3".into(),
            objective: "Do thing".into(),
            status: GoalStatus::Active,
            token_budget: Some(100),
            turn_budget: None,
            // Already used 100 tokens — at the budget limit.
            tokens_used: 100,
            turns_used: 0,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };

        let input = RunTurnInput {
            turn_id: "test-budget-tokens".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: Some(goal),
            cancellation: None,
        };

        let result = run_turn(input, &capturing).await.unwrap();
        assert!(matches!(
            result.stop_reason,
            LoopTurnStopReason::BudgetLimited
        ));
        assert_eq!(result.steps, 0);

        let events = captured_events.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|e| e["type"] == "goal.budget.limit_reached" && e["goal_id"] == "g3"),
            "budget exhaustion must emit goal.budget.limit_reached, got {events:?}"
        );
    }

    /// A goal whose turn budget is already exhausted must stop with
    /// `BudgetLimited`.
    #[tokio::test]
    async fn test_goal_turn_budget_exhausted() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let goal = GoalContext {
            goal_id: "g4".into(),
            objective: "Do thing".into(),
            status: GoalStatus::Active,
            token_budget: None,
            turn_budget: Some(3),
            tokens_used: 0,
            // Already used 3 turns — at the limit.
            turns_used: 3,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };

        let input = RunTurnInput {
            turn_id: "test-budget-turns".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: Some(goal),
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(
            result.stop_reason,
            LoopTurnStopReason::BudgetLimited
        ));
        assert_eq!(result.steps, 0);
    }

    /// An active goal with remaining budget should let the turn proceed
    /// normally and complete with `EndTurn`.
    #[tokio::test]
    async fn test_goal_active_with_budget_completes() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let goal = GoalContext {
            goal_id: "g5".into(),
            objective: "Do thing".into(),
            status: GoalStatus::Active,
            token_budget: Some(10000),
            turn_budget: Some(100),
            tokens_used: 100,
            turns_used: 1,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };

        let input = RunTurnInput {
            turn_id: "test-active-goal".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: Some(goal),
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
        assert_eq!(result.steps, 1);
    }

    // ── Cancellation tests ──────────────────────────────────────────────

    /// When the cancellation flag is set before the turn starts, the loop
    /// must abort immediately with `Aborted` and 0 steps.
    #[tokio::test]
    async fn test_cancellation_set_before_turn_aborts() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(true));

        let input = RunTurnInput {
            turn_id: "test-cancel-before".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: Some(cancel_flag),
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::Aborted));
        assert_eq!(result.steps, 0);
    }

    /// HostCallbacks decorator that raises the cancellation flag as a tool
    /// call runs, so the scheduler observes the cancel inside a batch.
    struct CancelDuringToolCallbacks {
        inner: Arc<dyn HostCallbacks>,
        cancellation: Arc<std::sync::atomic::AtomicBool>,
    }

    impl HostCallbacks for CancelDuringToolCallbacks {
        fn llm_chat(
            &self,
            request: crate::rpc::types::LlmChatRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
        {
            self.inner.llm_chat(request)
        }

        fn execute_tool(
            &self,
            request: crate::rpc::types::ToolExecuteRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            self.cancellation.store(true, Ordering::Relaxed);
            self.inner.execute_tool(request)
        }

        fn check_permission(
            &self,
            request: crate::rpc::types::PermissionCheckRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            self.inner.check_permission(request)
        }

        fn emit_event(&self, event: serde_json::Value) {
            self.inner.emit_event(event);
        }
    }

    /// A cancel landing while tools execute ends the turn as `Aborted`: the
    /// host asked to stop, so the turn must not surface a hard error.
    #[tokio::test]
    async fn test_cancellation_during_tool_execution_aborts() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: true,
            tool_responses: vec![ToolCall {
                id: "tc-cancel".into(),
                name: "read".into(),
                arguments: serde_json::json!({ "path": "/a.txt" }),
            }],
        };

        let server = Arc::new(RpcServer::new());
        RpcServer::register_arc(&server, types::methods::HOST_EXECUTE_TOOL, |_params| {
            Box::pin(async move {
                let resp = ToolExecuteResponse {
                    content: "stub".into(),
                    is_error: false,
                    note: None,
                };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(CancelDuringToolCallbacks {
            inner: rpc_callbacks(server.clone()),
            cancellation: cancellation.clone(),
        });

        let input = RunTurnInput {
            turn_id: "test-cancel-during-tools".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: Some(cancellation),
        };

        let result = run_turn(input, &callbacks)
            .await
            .expect("a cancel must not fail the turn");
        assert!(matches!(result.stop_reason, LoopTurnStopReason::Aborted));
        assert_eq!(result.steps, 1);
    }

    /// When the cancellation flag is cleared, the turn runs normally.
    #[tokio::test]
    async fn test_cancellation_cleared_runs_normally() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let input = RunTurnInput {
            turn_id: "test-cancel-clear".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: Some(cancel_flag),
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
        assert_eq!(result.steps, 1);
    }

    // ── Goal steering text injection test ────────────────────────────────

    /// Verify that when a goal is active, the system prompt is enriched
    /// with steering text containing the objective and budget info.
    #[tokio::test]
    async fn test_goal_steering_injected_into_system_prompt() {
        use std::sync::Mutex;

        // LLM that captures the messages it receives so we can inspect
        // the system prompt.
        struct CaptureLlm {
            captured_system: Arc<Mutex<Option<String>>>,
            call: AtomicU32,
        }
        impl LLM for CaptureLlm {
            fn system_prompt(&self) -> &str {
                "base prompt"
            }
            fn model_name(&self) -> &str {
                "capture"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let captured = self.captured_system.clone();
                let call = self.call.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call == 0 && !params.messages.is_empty() {
                        *captured.lock().unwrap() = Some(params.messages[0].content.clone());
                    }
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage {
                            input_tokens: 5,
                            output_tokens: 3,
                            total_tokens: 8,
                            ..Default::default()
                        },
                    })
                })
            }
        }

        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let llm = CaptureLlm {
            captured_system: captured.clone(),
            call: AtomicU32::new(0),
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());

        let goal = GoalContext {
            goal_id: "g-steer".into(),
            objective: "Write a hello world program".into(),
            status: GoalStatus::Active,
            token_budget: Some(1000),
            turn_budget: Some(10),
            tokens_used: 100,
            turns_used: 1,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };

        let input = RunTurnInput {
            turn_id: "test-steering".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: Some(goal),
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));

        let captured = captured
            .lock()
            .unwrap()
            .clone()
            .expect("system prompt was captured");
        assert!(
            captured.contains("base prompt"),
            "should contain base system prompt"
        );
        assert!(
            captured.contains("Write a hello world program"),
            "should contain objective"
        );
        assert!(captured.contains("Goal"), "should contain Goal header");
        assert!(captured.contains("Budgets:"), "should contain budget info");
        assert!(captured.contains("1000"), "should mention token budget");
        assert!(captured.contains("10"), "should mention turn budget");
    }

    // ── Max steps enforcement test ──────────────────────────────────────

    /// When the LLM always returns tool calls, the loop must stop at
    /// max_steps with EndTurn (the loop exits after the max_steps
    /// iterations).
    #[tokio::test]
    async fn test_max_steps_enforcement() {
        // LLM that always returns a tool call — never stops on its own.
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: true,
            tool_responses: vec![ToolCall {
                id: "loop".into(),
                name: "read".into(),
                arguments: serde_json::json!({"path": "/x"}),
            }],
        };

        let server = Arc::new(RpcServer::new());
        RpcServer::register_arc(&server, types::methods::HOST_EXECUTE_TOOL, |_params| {
            Box::pin(async move {
                let resp = ToolExecuteResponse {
                    content: "ok".into(),
                    is_error: false,
                    note: None,
                };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-max-steps".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "loop".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 3,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        // The loop runs max_steps iterations; steps = max_steps.
        assert_eq!(result.steps, 3, "should stop at max_steps");
    }

    // ── render_goal_steering tests ──────────────────────────────────────

    #[test]
    fn test_render_goal_steering_basic() {
        let goal = GoalContext {
            goal_id: "g".into(),
            objective: "Write tests".into(),
            status: GoalStatus::Active,
            token_budget: Some(1000),
            turn_budget: Some(10),
            tokens_used: 100,
            turns_used: 1,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };
        let text = render_goal_steering(&goal, 50, 1, 0);
        assert!(text.contains("Write tests"), "should contain objective");
        assert!(text.contains("Goal"), "should contain Goal header");
        assert!(text.contains("Budgets:"), "should contain budget section");
        assert!(text.contains("1000"), "should mention token budget");
        assert!(
            text.contains("within budget"),
            "should say within budget when low"
        );
    }

    #[test]
    fn test_render_goal_steering_wall_clock_budget() {
        let goal = GoalContext {
            goal_id: "g".into(),
            objective: "Finish".into(),
            status: GoalStatus::Active,
            token_budget: None,
            turn_budget: None,
            wall_clock_budget_ms: Some(10_000),
            wall_clock_ms: 5000,
            tokens_used: 0,
            turns_used: 0,
        };
        let text = render_goal_steering(&goal, 0, 0, 500);
        assert!(
            text.contains("time 5s/10s (remaining 4s)"),
            "should show wall-clock budget"
        );
        assert!(
            text.contains("elapsed"),
            "should mention elapsed time in progress"
        );
    }

    #[test]
    fn test_format_elapsed() {
        assert_eq!(format_elapsed(500), "0s");
        assert_eq!(format_elapsed(59_000), "59s");
        assert_eq!(format_elapsed(65_000), "1m05s");
        assert_eq!(format_elapsed(3_600_000), "1h0m");
        assert_eq!(format_elapsed(7_200_000), "2h0m");
    }

    #[test]
    fn test_render_goal_steering_near_limit() {
        let goal = GoalContext {
            goal_id: "g".into(),
            objective: "Finish".into(),
            status: GoalStatus::Active,
            token_budget: Some(100),
            turn_budget: None,
            tokens_used: 80,
            turns_used: 0,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };
        // 80 + 10 = 90 / 100 = 0.9 >= 0.75 → should say "nearing"
        let text = render_goal_steering(&goal, 10, 0, 0);
        assert!(
            text.contains("nearing a budget"),
            "should warn about nearing budget"
        );
    }

    #[test]
    fn test_render_goal_steering_no_budgets() {
        let goal = GoalContext {
            goal_id: "g".into(),
            objective: "Do thing".into(),
            status: GoalStatus::Active,
            token_budget: None,
            turn_budget: None,
            tokens_used: 0,
            turns_used: 0,
            wall_clock_budget_ms: None,
            wall_clock_ms: 0,
        };
        let text = render_goal_steering(&goal, 0, 0, 0);
        assert!(text.contains("Do thing"), "should contain objective");
        assert!(
            !text.contains("Budgets:"),
            "should not contain budget section when no budgets"
        );
    }

    // ── Context compaction wiring tests ────────────────────────────────

    /// When the message history crosses the context trigger threshold, the
    /// loop compacts it before the LLM call: the system prompt and the
    /// most recent messages survive, the middle is replaced by a summary
    /// placeholder.
    #[tokio::test]
    async fn test_context_compaction_before_llm_call() {
        use std::sync::Mutex;

        struct CaptureLlm {
            captured: Arc<Mutex<Vec<LLMMessage>>>,
        }
        impl LLM for CaptureLlm {
            fn system_prompt(&self) -> &str {
                "base prompt"
            }
            fn model_name(&self) -> &str {
                "capture"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let captured = self.captured.clone();
                Box::pin(async move {
                    *captured.lock().unwrap() = params.messages.clone();
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage {
                            input_tokens: 1,
                            output_tokens: 1,
                            total_tokens: 2,
                            ..Default::default()
                        },
                    })
                })
            }
        }

        // Default trigger threshold is 128k - 50k reserved = 81_072 tokens;
        // at 4 chars/token that is ~324k chars. Three 120k-char messages
        // (90k estimated tokens) cross it.
        let big = "x".repeat(120_000);
        let captured: Arc<Mutex<Vec<LLMMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let llm = CaptureLlm {
            captured: captured.clone(),
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-compaction".into(),
            llm: &llm,
            messages: vec![
                LLMMessage {
                    role: "user".into(),
                    content: big.clone(),
                    ..Default::default()
                },
                LLMMessage {
                    role: "assistant".into(),
                    content: big.clone(),
                    ..Default::default()
                },
                LLMMessage {
                    role: "user".into(),
                    content: big.clone(),
                    ..Default::default()
                },
            ],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));

        let captured = captured.lock().unwrap();
        assert!(
            captured.len() >= 4,
            "system + placeholder + recent user + injections"
        );
        assert_eq!(captured[0].role, "system");
        assert_eq!(captured[1].role, "user");
        assert!(
            captured[1].content.contains("compacted"),
            "placeholder must mention compaction"
        );
        assert_eq!(captured[2].content, big, "most recent message preserved");
        assert!(
            captured[2..]
                .iter()
                .any(|m| m.content.starts_with("<system-reminder>\n")),
            "injection appended after compaction"
        );
    }

    // ── Injection wiring tests ─────────────────────────────────────────

    /// The injection pass must append the date-change reminder right before
    /// the LLM call: the captured request contains a `<system-reminder>`
    /// user message with the baseline date text.
    #[tokio::test]
    async fn test_injections_appended_before_llm_call() {
        use std::sync::Mutex;

        struct CaptureLlm {
            captured: Arc<Mutex<Vec<LLMMessage>>>,
        }
        impl LLM for CaptureLlm {
            fn system_prompt(&self) -> &str {
                "base prompt"
            }
            fn model_name(&self) -> &str {
                "capture"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let captured = self.captured.clone();
                Box::pin(async move {
                    *captured.lock().unwrap() = params.messages.clone();
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage {
                            input_tokens: 1,
                            output_tokens: 1,
                            total_tokens: 2,
                            ..Default::default()
                        },
                    })
                })
            }
        }

        let captured: Arc<Mutex<Vec<LLMMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let llm = CaptureLlm {
            captured: captured.clone(),
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
        let input = RunTurnInput {
            turn_id: "test-injection".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await.unwrap();
        assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));

        let captured = captured.lock().unwrap();
        assert!(
            captured.len() >= 3,
            "system + user + at least the date injection"
        );
        assert_eq!(captured[0].role, "system");
        assert_eq!(captured[1].content, "hi");
        let date_injection = captured
            .iter()
            .find(|m| m.content.contains("Today's date is"));
        let date_injection = date_injection.expect("date reminder must be injected");
        assert_eq!(date_injection.role, "user");
        assert!(date_injection.content.starts_with("<system-reminder>\n"));
        assert!(date_injection.content.ends_with("\n</system-reminder>"));
    }
}
