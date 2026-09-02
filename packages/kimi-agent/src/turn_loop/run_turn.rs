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

/// Goal/plan state snapshot backed by the host callbacks.
///
/// The injection providers render synchronously, while the state authority is
/// behind the async `host/state_read` channel — so the turn loop refreshes
/// this snapshot at each step head (see the injection pass) and the providers
/// read the cached values. A failed read keeps the previous value, so a host
/// without the state bridge degrades to "no goal/plan reminder" instead of
/// erroring the turn.
#[derive(Default)]
struct CallbackStateSnapshot {
    goal: std::sync::Mutex<Option<serde_json::Value>>,
    plan: std::sync::Mutex<Option<serde_json::Value>>,
}

impl CallbackStateSnapshot {
    async fn refresh(&self, callbacks: &dyn HostCallbacks) {
        for (domain, slot) in [("goal", &self.goal), ("plan", &self.plan)] {
            let request = crate::rpc::types::StateReadRequest {
                domain: domain.to_string(),
                key: domain.to_string(),
                turn_id: String::new(),
                tool_call_id: String::new(),
            };
            let value = callbacks.state_read(request).await.ok().map(|r| r.value);
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = value;
        }
    }
}

impl crate::injection::goal_plan::StateStore for CallbackStateSnapshot {
    fn read_domain(&self, domain: &str) -> Option<serde_json::Value> {
        let slot = match domain {
            "goal" => &self.goal,
            "plan" => &self.plan,
            _ => return None,
        };
        slot.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

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
    messages: Vec<LLMMessage>,
) -> TurnResult {
    TurnResult {
        stop_reason,
        steps,
        usage,
        events_emitted,
        llm_retries,
        llm_transport: String::new(),
        native_tool_calls: 0,
        messages,
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

/// Run a single turn with engine-side telemetry emission (M1c).
///
/// Wraps [`run_turn`] and emits `turn_started` / `turn_ended` /
/// `turn_interrupted` through the `host/telemetry` seam, merging the
/// host-injected [`TelemetryContext`] (mode / provider_type / protocol /
/// thinking_effort) with the engine-observed outcome (reason, duration_ms,
/// steps, at_step, interrupt_reason). The host forwards one track2 per event
/// and suppresses its own turn-lifecycle telemetry for engine-driven turns —
/// this is the ownership hand-over for telemetry.
///
/// `trace_id` is a known gap: the engine does not yet capture the provider
/// request id from native LLM responses, and in host-proxy mode the host
/// never sees the value either.
pub fn run_turn_with_telemetry<'a>(
    input: RunTurnInput<'a>,
    telemetry: TelemetryContext,
    callbacks: &'a Arc<dyn HostCallbacks>,
) -> BoxFuture<'a, Result<TurnResult, Box<dyn std::error::Error + 'a>>> {
    let turn_id = input.turn_id.clone();
    callbacks.telemetry(telemetry_payload(
        "turn_started",
        &telemetry,
        &turn_id,
        None,
    ));
    Box::pin(async move {
        let started = std::time::Instant::now();
        let result = run_turn(input, callbacks).await;
        match &result {
            Ok(result) => {
                let reason = telemetry_reason(&result.stop_reason);
                callbacks.telemetry(telemetry_payload(
                    "turn_ended",
                    &telemetry,
                    &turn_id,
                    Some(serde_json::json!({
                        "reason": reason,
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "steps": result.steps,
                    })),
                ));
                if reason != "completed" {
                    callbacks.telemetry(telemetry_payload(
                        "turn_interrupted",
                        &telemetry,
                        &turn_id,
                        Some(serde_json::json!({
                            "at_step": result.steps,
                            "interrupt_reason": telemetry_interrupt_reason(&result.stop_reason),
                        })),
                    ));
                }
            }
            Err(_) => {
                callbacks.telemetry(telemetry_payload(
                    "turn_ended",
                    &telemetry,
                    &turn_id,
                    Some(serde_json::json!({
                        "reason": "failed",
                        "duration_ms": started.elapsed().as_millis() as u64,
                    })),
                ));
                callbacks.telemetry(telemetry_payload(
                    "turn_interrupted",
                    &telemetry,
                    &turn_id,
                    Some(serde_json::json!({ "interrupt_reason": "error" })),
                ));
            }
        }
        result
    })
}

/// Map the stop reason onto v2's `TurnResult.type` telemetry vocabulary
/// (`completed` / `cancelled` / `failed`). The engine path never produces
/// `max_tokens`-style types: `MaxTokens` / `Filtered` are finish reasons on
/// a response the model did produce, and `Paused` / `BudgetLimited` surface
/// as normal turn ends with a blocked marker.
fn telemetry_reason(stop: &LoopTurnStopReason) -> &'static str {
    match stop {
        LoopTurnStopReason::EndTurn
        | LoopTurnStopReason::MaxTokens
        | LoopTurnStopReason::Filtered
        | LoopTurnStopReason::Paused
        | LoopTurnStopReason::BudgetLimited => "completed",
        LoopTurnStopReason::Aborted => "cancelled",
        LoopTurnStopReason::Unknown => "failed",
    }
}

/// The engine sees only the cancellation flag, not the host's abort reason —
/// `user_cancelled` vs `aborted` cannot be distinguished here, so every
/// engine-side cancellation reports `aborted` until the reason travels with
/// the cancel request.
fn telemetry_interrupt_reason(stop: &LoopTurnStopReason) -> &'static str {
    match stop {
        LoopTurnStopReason::Aborted => "aborted",
        _ => "error",
    }
}

fn telemetry_payload(
    event: &str,
    ctx: &TelemetryContext,
    turn_id: &str,
    extra: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut value = serde_json::json!({
        "event": event,
        "turn_id": turn_id,
        "mode": ctx.mode,
        "provider_type": ctx.provider_type,
        "protocol": ctx.protocol,
    });
    if let Some(effort) = &ctx.thinking_effort {
        value["thinking_effort"] = serde_json::Value::String(effort.clone());
    }
    if let (Some(extra_obj), Some(obj)) = (
        extra.as_ref().and_then(|extra| extra.as_object()),
        value.as_object_mut(),
    ) {
        for (key, val) in extra_obj {
            obj.insert(key.clone(), val.clone());
        }
    }
    value
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
    // Bind this turn to the goal that was active when it started (G-6 #8):
    // the native goal gate vetoes mutation calls once the current goal no
    // longer matches. The default no-op leaves unguarded paths unbound.
    callbacks.set_turn_goal(&turn_id, goal.as_ref().map(|g| g.goal_id.as_str()));

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

        // Context compaction knobs. The window comes from the host's model
        // resolution; without it the budget falls back to the fixed default.
        let compaction_config = crate::compaction::config_for_window(input.max_context_tokens);

        // Turn-level injection registry. The built-in date-change and
        // workspace-AGENTS.md reminders are registered by `with_defaults`;
        // goal/plan-mode providers read the state through the host callbacks
        // (the same channel the state-bridge tools write through), so the
        // reminders track the state authority wherever it lives — the host in
        // the product, the local store in the REPL. No local store is built
        // here: in the product the state lives host-side and a workspace- or
        // home-local directory would be a side effect with no consumer.
        let mut injection_registry = crate::injection::InjectionRegistry::with_defaults();
        let goal_plan_state = Arc::new(CallbackStateSnapshot::default());
        if input.llm.transport() != "host-proxy" {
            crate::injection::goal_plan::register_goal_plan_injections(
                &mut injection_registry,
                goal_plan_state.clone(),
            );
        }

        // Tool-call dedup guard (v2 `toolDedupeService` mirror, G-6 #2):
        // same-step repeats share the original's result instead of executing,
        // cross-step streaks earn escalating reminders, and a 12-repeat
        // streak stops the turn. State is per-turn (v2 resets the streak
        // when the turn id changes), so the guard lives only in this call.
        let mut tool_dedupe = crate::tools::tool_dedupe::DedupeGuard::new();

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
                        messages.clone(),
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
                        messages.clone(),
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
                    messages.clone(),
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
            messages = compacted;
            messages.extend(injections);

            // ── Injection pass ───────────────────────────────────────────
            // Mirror v2's `onWillBeginStep` injection gate: build this
            // step's reminders (date change, workspace AGENTS.md, …) and
            // append them right before the LLM call. In host-proxy mode
            // the host owns the transcript and injects itself, so the
            // pass is skipped there to avoid duplicate reminders.
            if input.llm.transport() != "host-proxy" {
                // Refresh the goal/plan snapshot through the host callbacks so
                // the injections render the state the tools just wrote — the
                // same channel, so a mid-turn plan exit or goal pause shows up
                // at this step head. A failed read keeps the previous value.
                goal_plan_state.refresh(callbacks.as_ref()).await;
                for text in injection_registry.build_injections() {
                    messages.push(crate::injection::injection_message(text));
                }
            }

            // M1d: pull the host's current tool table before each LLM call so
            // mid-turn registry changes (feature tools, MCP reconnects) reach
            // the model. Host-proxy mode rebuilds tools host-side per call and
            // never consults the engine's table; a host without the seam (or a
            // failed pull) falls back to the turn-start snapshot.
            let step_tool_defs = if input.llm.transport() != "host-proxy" {
                match callbacks.list_tools().await {
                    Ok(response) => response.tools,
                    Err(_) => tool_defs.clone(),
                }
            } else {
                tool_defs.clone()
            };

            // Delegate LLM call (with retry) to turn_step module.
            // Convert the 'static error to the turn's 'a-bounded error type.
            let step_result = execute_loop_step_with_retry(
                &turn_id,
                step_num,
                input.llm,
                messages.clone(),
                input.tools,
                step_tool_defs,
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
                    // Persist the assistant text into the in-turn history so
                    // the session (and any future cross-turn caller) sees the
                    // model's reply. For ToolCalls the assistant message is
                    // pushed below with the tool_calls payload.
                    if !step_result.content.is_empty() {
                        messages.push(LLMMessage {
                            role: "assistant".into(),
                            content: step_result.content.clone(),
                            blocks: Vec::new(),
                            tool_calls: Vec::new(),
                            tool_call_id: None,
                        });
                    }
                    return Ok(turn_result(
                        turn_stop_reason_from_finish(step_result.finish_reason.as_deref()),
                        steps,
                        total_usage,
                        0,
                        llm_retries,
                        messages.clone(),
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

                    // Tool-call dedup plan (v2 `toolDedupeService`, G-6 #2):
                    // identical calls inside this step never execute twice —
                    // a repeat awaits the original's result instead. Scoped
                    // to natively-executable names: calls forwarded to the
                    // host stay under the host's own dedup service. Cells
                    // carry each call's result by its position in
                    // `tool_calls` (the scheduler preserves call order).
                    let dedupe_plan = tool_dedupe.plan_step_by(&tool_calls, |tc| {
                        crate::tools::is_native_tool_name(&tc.name)
                            .then(|| crate::tools::tool_dedupe::make_key(&tc.name, &tc.arguments))
                    });
                    let call_index: std::collections::HashMap<String, usize> = tool_calls
                        .iter()
                        .enumerate()
                        .map(|(i, tc)| (tc.id.clone(), i))
                        .collect();
                    let dedupe_cells: Vec<
                        std::sync::Arc<tokio::sync::OnceCell<ExecutableToolResult>>,
                    > = tool_calls
                        .iter()
                        .map(|_| std::sync::Arc::default())
                        .collect();

                    // Execute tools with resource-conflict scheduling:
                    // non-conflicting calls run concurrently, conflicting
                    // calls (e.g. two writes to the same file) are
                    // serialized across batches.
                    let exec_fn = {
                        let turn_id = turn_id.clone();
                        let callbacks = callbacks.clone();
                        let dedupe_cells = dedupe_cells.clone();
                        let original_of = dedupe_plan.original_of.clone();
                        move |tc: ToolCall| {
                            let index = call_index.get(&tc.id).copied();
                            // The step's first same-key occurrence this
                            // repeat shares (`None` for originals).
                            let dup_source = index
                                .zip(index.map(|i| original_of[i]))
                                .filter(|(i, o)| i != o)
                                .map(|(_, o)| o);
                            let turn_id = turn_id.clone();
                            let callbacks = callbacks.clone();
                            let dedupe_cells = dedupe_cells.clone();
                            async move {
                                // A same-step repeat never executes: it
                                // shares the original's result, which the
                                // step's finalize pass rewrites with any
                                // repeat reminder before the results reach
                                // the history (v2 deferred resolution). The
                                // fallback only runs if the original's task
                                // vanished before publishing (a cancellation
                                // abort) — never executes the tool, matching
                                // v2's lost-deferred error result.
                                if let Some(original) = dup_source {
                                    let shared = dedupe_cells[original]
                                        .get_or_init(|| async {
                                            ExecutableToolResult {
                                                content: "Tool call deduplicated but original result was lost".into(),
                                                is_error: true,
                                                note: None,
                                            }
                                        })
                                        .await;
                                    return Ok(shared.clone());
                                }
                                let req = ToolExecuteRequest {
                                    turn_id: turn_id.clone(),
                                    tool_call_id: tc.id.clone(),
                                    tool_name: tc.name.clone(),
                                    arguments: tc.arguments.clone(),
                                };
                                // Publish the outcome through the cell so a
                                // repeat can share it; a transport error
                                // becomes the same error result the
                                // scheduler would synthesize for it.
                                let execute = async {
                                    match callbacks.execute_tool(req).await {
                                        Ok(response) => ExecutableToolResult {
                                            content: response.content,
                                            is_error: response.is_error,
                                            note: response.note,
                                        },
                                        Err(e) => ExecutableToolResult {
                                            content: format!("Tool execution error: {e}"),
                                            is_error: true,
                                            note: None,
                                        },
                                    }
                                };
                                match index {
                                    Some(i) => {
                                        let result = dedupe_cells[i].get_or_init(|| execute).await;
                                        Ok(result.clone())
                                    }
                                    // Unknown call id (defensive): no cell to
                                    // share through, execute plainly.
                                    None => Ok(execute.await),
                                }
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
                    let mut results = match tool_scheduler::execute_scheduled(
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
                                    messages.clone(),
                                ));
                            }
                            return Err(err);
                        }
                    };

                    // Dedup finalize (v2 `finalizeResult` + `endStep`):
                    // streak reminders are appended to the originals'
                    // results, same-step repeats receive the original's
                    // final result, and the cross-step streak advances.
                    let dedupe_force_stop = tool_dedupe.finalize_step(&dedupe_plan, &mut results);

                    // Insert tool results, each linked back to its call
                    // via `tool_call_id` (same call order as `tool_calls`).
                    for (i, tr) in results.iter().enumerate() {
                        // A same-step repeat shared the original's execution
                        // and never reached the native gate, so no tool.native
                        // event surfaced it — emit one here so the transcript
                        // still shows the call with its shared result (v2
                        // keeps the vetoed repeat visible).
                        if dedupe_plan.original_of.get(i).is_some_and(|o| *o != i)
                            && let Some(tc) = tool_calls.get(i)
                        {
                            callbacks.emit_event(serde_json::json!({
                                "type": "tool.native",
                                "turn_id": turn_id,
                                "tool_call_id": tc.id,
                                "tool_name": tc.name,
                                "arguments": tc.arguments,
                                "content": tr.content,
                                "is_error": tr.is_error,
                                "note": tr.note,
                            }));
                        }
                        messages.push(LLMMessage {
                            role: "tool".into(),
                            content: tr.content.clone(),
                            blocks: Vec::new(),
                            tool_calls: Vec::new(),
                            tool_call_id: tool_calls.get(i).map(|tc| tc.id.clone()),
                        });
                    }

                    if dedupe_force_stop {
                        // v2 `stopTurn`: the turn ends as `completed` once
                        // the step's results are recorded.
                        return Ok(turn_result(
                            LoopTurnStopReason::EndTurn,
                            steps,
                            total_usage,
                            0,
                            llm_retries,
                            messages.clone(),
                        ));
                    }
                }
                LoopStepStopReason::Aborted => {
                    return Ok(turn_result(
                        LoopTurnStopReason::Aborted,
                        steps,
                        total_usage,
                        0,
                        llm_retries,
                        messages.clone(),
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
            messages.clone(),
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
    ///
    /// Registers the per-step host seams (`list_tools`, `state_read`) with
    /// no-op answers: with no local handler the server falls back to a stdio
    /// round-trip that stalls for the full timeout, which used to cost every
    /// native-transport test 30s per step.
    fn rpc_callbacks(server: Arc<RpcServer>) -> Arc<dyn HostCallbacks> {
        RpcServer::register_arc(&server, types::methods::HOST_LIST_TOOLS, |_params| {
            Box::pin(async move {
                let resp = types::ListToolsResponse { tools: vec![] };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });
        RpcServer::register_arc(&server, types::methods::HOST_STATE_READ, |_params| {
            Box::pin(async move {
                let resp = types::StateReadResponse {
                    value: serde_json::Value::Null,
                };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });
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

        fn telemetry(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event.clone());
            self.inner.telemetry(event);
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
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await;
        assert!(result.is_ok());
        let turn = result.unwrap();
        assert_eq!(turn.steps, 1);
    }

    /// Callbacks wrapper recording `set_turn_goal` bindings.
    struct GoalBindingCallbacks {
        inner: Arc<dyn HostCallbacks>,
        #[allow(clippy::type_complexity)]
        bound: Arc<Mutex<Vec<(String, Option<String>)>>>,
    }

    impl HostCallbacks for GoalBindingCallbacks {
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

        fn set_turn_goal(&self, turn_id: &str, goal_id: Option<&str>) {
            self.bound
                .lock()
                .unwrap()
                .push((turn_id.to_string(), goal_id.map(str::to_string)));
        }
    }

    #[tokio::test]
    async fn test_turn_binds_start_goal_for_stale_check() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let base = rpc_callbacks(server.clone());
        let bound = Arc::new(Mutex::new(Vec::new()));
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(GoalBindingCallbacks {
            inner: base.clone(),
            bound: bound.clone(),
        });

        let goal = crate::turn_loop::types::GoalContext {
            goal_id: "g-1".into(),
            objective: "objective".into(),
            status: crate::turn_loop::types::GoalStatus::Active,
            token_budget: None,
            turn_budget: None,
            wall_clock_budget_ms: None,
            tokens_used: 0,
            turns_used: 0,
            wall_clock_ms: 0,
        };
        let input = RunTurnInput {
            turn_id: "turn-goal".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: Some(goal),
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await;
        assert!(result.is_ok());
        assert_eq!(
            bound.lock().unwrap().as_slice(),
            &[("turn-goal".to_string(), Some("g-1".to_string()))],
            "run_turn must bind the turn-start goal for the stale gate"
        );
    }

    #[tokio::test]
    async fn test_turn_binds_no_goal_when_goalless() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let base = rpc_callbacks(server.clone());
        let bound = Arc::new(Mutex::new(Vec::new()));
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(GoalBindingCallbacks {
            inner: base.clone(),
            bound: bound.clone(),
        });
        let input = RunTurnInput {
            turn_id: "turn-goal-free".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };

        let result = run_turn(input, &callbacks).await;
        assert!(result.is_ok());
        assert_eq!(
            bound.lock().unwrap().as_slice(),
            &[("turn-goal-free".to_string(), None)],
            "a goal-less turn binds None so the stale gate skips it"
        );
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        let turn = run_turn(input, &callbacks).await.unwrap();
        assert_eq!(turn.usage.input_tokens, 18);
        assert_eq!(turn.usage.output_tokens, 7);
        assert_eq!(turn.usage.input_cache_read, 10);
        assert_eq!(turn.usage.input_cache_creation, 4);
    }

    /// Regression (found via the napi-integration suite after a fresh
    /// `.node` build): the compaction rebind inside the step loop
    /// (`let mut messages = compacted;`) shadowed the outer history
    /// binding, so every step restarted from `[system] + user` and the
    /// model never saw tool results. The history must accumulate across
    /// steps: the second request carries the assistant tool_calls message
    /// and the tool result.
    #[tokio::test]
    async fn test_history_accumulates_across_steps() {
        struct RecordingLlm {
            call: AtomicU32,
            requests: std::sync::Mutex<Vec<Vec<LLMMessage>>>,
        }
        impl LLM for RecordingLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "recording-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.call.fetch_add(1, Ordering::SeqCst);
                self.requests.lock().unwrap().push(params.messages.clone());
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
                            usage: TokenUsage::default(),
                        })
                    } else {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![],
                            finish_reason: Some("stop".into()),
                            usage: TokenUsage::default(),
                        })
                    }
                })
            }
        }
        let llm = RecordingLlm {
            call: AtomicU32::new(0),
            requests: std::sync::Mutex::new(Vec::new()),
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
            turn_id: "test-history-accumulation".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "Hello!".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        run_turn(input, &callbacks).await.unwrap();
        let requests = llm.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        // Step 2's history: system + user + assistant(tool_calls) + tool result.
        let second = &requests[1];
        assert!(
            second
                .iter()
                .any(|m| m.role == "assistant" && m.tool_calls.iter().any(|tc| tc.id == "tc1")),
            "step 2 history must contain the assistant tool_calls message: {second:?}"
        );
        assert!(
            second.iter().any(|m| m.role == "tool"
                && m.tool_call_id.as_deref() == Some("tc1")
                && m.content == "stub"),
            "step 2 history must contain the tool result: {second:?}"
        );
    }

    // ── Tool-call dedup (v2 `toolDedupeService` mirror, G-6 #2) ─────────

    /// A same-step repeat of an identical call never executes: the host
    /// runs the original once, and the repeat receives the same result.
    #[tokio::test]
    async fn test_same_step_duplicate_executes_once() {
        struct DupLlm {
            call: AtomicU32,
        }
        impl LLM for DupLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "dup-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.call.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call == 0 {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![
                                ToolCall {
                                    id: "tc1".into(),
                                    name: "read".into(),
                                    arguments: serde_json::json!({"path": "/a.txt"}),
                                },
                                // Same key, different call id — the repeat.
                                ToolCall {
                                    id: "tc2".into(),
                                    name: "read".into(),
                                    arguments: serde_json::json!({"path": "/a.txt"}),
                                },
                            ],
                            finish_reason: Some("tool_calls".into()),
                            usage: TokenUsage::default(),
                        })
                    } else {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![],
                            finish_reason: Some("stop".into()),
                            usage: TokenUsage::default(),
                        })
                    }
                })
            }
        }
        let llm = DupLlm {
            call: AtomicU32::new(0),
        };
        let server = Arc::new(RpcServer::new());
        let executions = Arc::new(AtomicU32::new(0));
        let counter = executions.clone();
        RpcServer::register_arc(&server, types::methods::HOST_EXECUTE_TOOL, move |_params| {
            counter.fetch_add(1, Ordering::SeqCst);
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
            turn_id: "test-same-step-dedup".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        let result = run_turn(input, &callbacks).await.unwrap();

        assert_eq!(
            executions.load(Ordering::SeqCst),
            1,
            "the repeat must share the original's execution"
        );
        // Both calls keep their result messages, with identical content.
        let tool_msgs: Vec<&LLMMessage> = result
            .messages
            .iter()
            .filter(|m| m.role == "tool")
            .collect();
        assert_eq!(tool_msgs.len(), 2);
        assert_eq!(tool_msgs[0].tool_call_id.as_deref(), Some("tc1"));
        assert_eq!(tool_msgs[1].tool_call_id.as_deref(), Some("tc2"));
        assert_eq!(tool_msgs[0].content, "stub");
        assert_eq!(tool_msgs[1].content, "stub");
    }

    /// Calls with non-native names are exempt from engine-side dedup: they
    /// run on the host, whose own dedup service stays authoritative.
    #[tokio::test]
    async fn test_same_step_duplicate_of_host_tool_still_executes_twice() {
        struct HostDupLlm {
            call: AtomicU32,
        }
        impl LLM for HostDupLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "host-dup-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.call.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call == 0 {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![
                                ToolCall {
                                    id: "tc1".into(),
                                    name: "echo".into(),
                                    arguments: serde_json::json!({"text": "hello"}),
                                },
                                ToolCall {
                                    id: "tc2".into(),
                                    name: "echo".into(),
                                    arguments: serde_json::json!({"text": "hello"}),
                                },
                            ],
                            finish_reason: Some("tool_calls".into()),
                            usage: TokenUsage::default(),
                        })
                    } else {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![],
                            finish_reason: Some("stop".into()),
                            usage: TokenUsage::default(),
                        })
                    }
                })
            }
        }
        let llm = HostDupLlm {
            call: AtomicU32::new(0),
        };
        let server = Arc::new(RpcServer::new());
        let executions = Arc::new(AtomicU32::new(0));
        let counter = executions.clone();
        RpcServer::register_arc(&server, types::methods::HOST_EXECUTE_TOOL, move |_params| {
            counter.fetch_add(1, Ordering::SeqCst);
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
            turn_id: "test-host-tool-no-dedup".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        run_turn(input, &callbacks).await.unwrap();

        assert_eq!(
            executions.load(Ordering::SeqCst),
            2,
            "non-native names bypass engine dedup (the host dedups them)"
        );
    }

    /// Cross-step repeats earn the escalating reminders, and the 12th
    /// consecutive identical call force-stops the turn as `completed`.
    #[tokio::test]
    async fn test_repeat_streak_appends_reminders_and_force_stops() {
        struct RepeatLlm {
            call: AtomicU32,
        }
        impl LLM for RepeatLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "repeat-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.call.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![ToolCall {
                            id: format!("tc{call}"),
                            name: "read".into(),
                            arguments: serde_json::json!({"path": "/a.txt"}),
                        }],
                        finish_reason: Some("tool_calls".into()),
                        usage: TokenUsage::default(),
                    })
                })
            }
        }
        let llm = RepeatLlm {
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
            turn_id: "test-repeat-streak".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            // Generous ceiling: the force stop, not max_steps, must end it.
            max_steps: 20,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        let result = run_turn(input, &callbacks).await.unwrap();

        assert_eq!(result.steps, 12, "force stop at the 12th repeat");
        assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
        let tool_msgs: Vec<&LLMMessage> = result
            .messages
            .iter()
            .filter(|m| m.role == "tool")
            .collect();
        assert_eq!(tool_msgs.len(), 12);
        // Streak 1 and 2 stay untouched; 3 earns reminder 1.
        assert_eq!(tool_msgs[0].content, "stub");
        assert_eq!(tool_msgs[1].content, "stub");
        assert!(
            tool_msgs[2]
                .content
                .contains("repeated several times in a row")
        );
        // Streak 5 embeds the count (reminder 2).
        assert!(tool_msgs[4].content.contains("issued 5 times in a row"));
        // Streak 8 and 12 carry the final-response reminder; 12 stops the turn.
        assert!(
            tool_msgs[7]
                .content
                .contains("Write your final response now")
        );
        assert!(
            tool_msgs[11]
                .content
                .contains("Write your final response now")
        );
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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
            max_context_tokens: None,
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

    // ── Telemetry emission tests (M1c `host/telemetry`) ─────────────────

    /// The telemetry events must carry the host-injected context merged with
    /// the engine-observed outcome, in v2's payload vocabulary — the host
    /// forwards these to track2 verbatim, so a field drift here is a
    /// dashboard drift.
    #[tokio::test]
    async fn test_run_turn_with_telemetry_emits_started_and_ended() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let (capturing, events) = EventCapturingCallbacks::new(rpc_callbacks(server.clone()));
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(capturing);

        let input = RunTurnInput {
            turn_id: "test-telemetry-ok".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        let telemetry = TelemetryContext {
            mode: "agent".into(),
            provider_type: "kimi".into(),
            protocol: "openai".into(),
            thinking_effort: Some("high".into()),
        };

        let result = run_turn_with_telemetry(input, telemetry, &callbacks).await;
        assert!(result.is_ok());

        let events = events.lock().unwrap();
        let emitted: Vec<&serde_json::Value> =
            events.iter().filter(|e| e.get("event").is_some()).collect();
        assert_eq!(emitted.len(), 2, "started + ended, nothing else");
        assert_eq!(emitted[0]["event"], "turn_started");
        assert_eq!(emitted[0]["turn_id"], "test-telemetry-ok");
        assert_eq!(emitted[0]["mode"], "agent");
        assert_eq!(emitted[0]["provider_type"], "kimi");
        assert_eq!(emitted[0]["protocol"], "openai");
        assert_eq!(emitted[0]["thinking_effort"], "high");
        assert_eq!(emitted[1]["event"], "turn_ended");
        assert_eq!(emitted[1]["reason"], "completed");
        assert_eq!(emitted[1]["steps"], 1);
        assert!(emitted[1]["duration_ms"].is_u64());
    }

    /// An aborted turn ends as `cancelled` and additionally reports
    /// `turn_interrupted` with the engine-side interrupt reason.
    #[tokio::test]
    async fn test_run_turn_with_telemetry_reports_cancellation_as_interrupted() {
        let llm = PredictTestLlm {
            system_prompt: "You are helpful.".into(),
            model_name: "test-model".into(),
            return_tool_calls: false,
            tool_responses: vec![],
        };
        let server = Arc::new(RpcServer::new());
        let (capturing, events) = EventCapturingCallbacks::new(rpc_callbacks(server.clone()));
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(capturing);

        let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let input = RunTurnInput {
            turn_id: "test-telemetry-cancel".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: Some(cancel_flag),
        };
        let telemetry = TelemetryContext {
            mode: "agent".into(),
            provider_type: "kimi".into(),
            protocol: "openai".into(),
            thinking_effort: None,
        };

        let result = run_turn_with_telemetry(input, telemetry, &callbacks).await;
        assert!(matches!(
            result.unwrap().stop_reason,
            LoopTurnStopReason::Aborted
        ));

        let events = events.lock().unwrap();
        let emitted: Vec<&serde_json::Value> =
            events.iter().filter(|e| e.get("event").is_some()).collect();
        assert_eq!(emitted.len(), 3, "started + ended + interrupted");
        assert_eq!(emitted[1]["event"], "turn_ended");
        assert_eq!(emitted[1]["reason"], "cancelled");
        assert_eq!(emitted[1]["steps"], 0);
        assert_eq!(emitted[2]["event"], "turn_interrupted");
        assert_eq!(emitted[2]["at_step"], 0);
        assert_eq!(emitted[2]["interrupt_reason"], "aborted");
        assert!(
            emitted[2].get("thinking_effort").is_none(),
            "an absent context field must not be emitted"
        );
    }

    // ── Tool-table refresh tests (M1d `host/list_tools`) ────────────────

    /// The engine must pull the host's current tool table before every LLM
    /// call on native transports: a table captured at turn start goes stale
    /// the moment the registry changes mid-turn (feature tools, MCP
    /// reconnects), and the model would keep calling a tool that no longer
    /// exists.
    #[tokio::test]
    async fn test_list_tools_refreshes_table_per_step() {
        struct ToolsRecordingLlm {
            call: AtomicU32,
            seen_tools: Mutex<Vec<Vec<String>>>,
        }
        impl LLM for ToolsRecordingLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "tools-recording-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.call.fetch_add(1, Ordering::SeqCst);
                self.seen_tools.lock().unwrap().push(
                    params
                        .tools
                        .iter()
                        .map(|t| t.name.clone())
                        .collect::<Vec<_>>(),
                );
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
                            usage: TokenUsage::default(),
                        })
                    } else {
                        Ok(LLMChatResponse {
                            content: String::new(),
                            tool_calls: vec![],
                            finish_reason: Some("stop".into()),
                            usage: TokenUsage::default(),
                        })
                    }
                })
            }
        }

        let llm = ToolsRecordingLlm {
            call: AtomicU32::new(0),
            seen_tools: Mutex::new(Vec::new()),
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
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
        let list_tools_calls = Arc::new(AtomicU32::new(0));
        let calls_for_handler = list_tools_calls.clone();
        RpcServer::register_arc(&server, types::methods::HOST_LIST_TOOLS, move |_params| {
            let call = calls_for_handler.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                let name = if call == 0 { "fresh_a" } else { "fresh_b" };
                let resp = types::ListToolsResponse {
                    tools: vec![crate::turn_loop::types::ToolInfo {
                        name: name.into(),
                        description: "fresh".into(),
                        input_schema: serde_json::json!({}),
                    }],
                };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        let input = RunTurnInput {
            turn_id: "test-list-tools-refresh".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            // The turn-start snapshot must never reach the LLM here: the
            // host answers list_tools with a fresh table on every step.
            tool_defs: vec![crate::turn_loop::types::ToolInfo {
                name: "snapshot".into(),
                description: "stale".into(),
                input_schema: serde_json::json!({}),
            }],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        run_turn(input, &callbacks).await.unwrap();

        assert_eq!(
            list_tools_calls.load(Ordering::SeqCst),
            2,
            "one pull per step"
        );
        let seen = llm.seen_tools.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], vec!["fresh_a".to_string()]);
        assert_eq!(seen[1], vec!["fresh_b".to_string()]);
    }

    /// A host without the seam (or with a failing one) must not break the
    /// turn: run_turn falls back to the turn-start snapshot.
    #[tokio::test]
    async fn test_list_tools_failure_falls_back_to_snapshot() {
        struct ToolsRecordingLlm {
            seen_tools: Mutex<Vec<Vec<String>>>,
        }
        impl LLM for ToolsRecordingLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "tools-recording-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                self.seen_tools.lock().unwrap().push(
                    params
                        .tools
                        .iter()
                        .map(|t| t.name.clone())
                        .collect::<Vec<_>>(),
                );
                Box::pin(async move {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage::default(),
                    })
                })
            }
        }

        let llm = ToolsRecordingLlm {
            seen_tools: Mutex::new(Vec::new()),
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
        // The seam is wired but the host answers with an error — the same
        // Err branch in run_turn as an unwired host, without the stdio
        // round-trip timeout a missing handler would cost. Registered after
        // the helper so it wins over the no-op default.
        RpcServer::register_arc(&server, types::methods::HOST_LIST_TOOLS, |_params| {
            Box::pin(async move { Err(JsonRpcError::method_not_found("host/list_tools")) })
        });

        let input = RunTurnInput {
            turn_id: "test-list-tools-fallback".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![crate::turn_loop::types::ToolInfo {
                name: "snapshot".into(),
                description: "stale".into(),
                input_schema: serde_json::json!({}),
            }],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        run_turn(input, &callbacks).await.unwrap();

        let seen = llm.seen_tools.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0], vec!["snapshot".to_string()]);
    }

    /// Host-proxy mode rebuilds tools host-side per call; the engine must
    /// not spend a round trip pulling a table it never uses.
    #[tokio::test]
    async fn test_list_tools_skipped_in_host_proxy_mode() {
        struct HostProxyLlm {
            seen_tools: Mutex<Vec<Vec<String>>>,
        }
        impl LLM for HostProxyLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "host-proxy-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn transport(&self) -> &'static str {
                "host-proxy"
            }
            fn chat(
                &self,
                params: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                self.seen_tools.lock().unwrap().push(
                    params
                        .tools
                        .iter()
                        .map(|t| t.name.clone())
                        .collect::<Vec<_>>(),
                );
                Box::pin(async move {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage::default(),
                    })
                })
            }
        }

        let llm = HostProxyLlm {
            seen_tools: Mutex::new(Vec::new()),
        };
        let server = Arc::new(RpcServer::new());
        let callbacks = rpc_callbacks(server.clone());
        let list_tools_calls = Arc::new(AtomicU32::new(0));
        let calls_for_handler = list_tools_calls.clone();
        RpcServer::register_arc(&server, types::methods::HOST_LIST_TOOLS, move |_params| {
            let calls = calls_for_handler.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                let resp = types::ListToolsResponse { tools: vec![] };
                serde_json::to_value(&resp).map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        let input = RunTurnInput {
            turn_id: "test-list-tools-host-proxy".into(),
            llm: &llm,
            messages: vec![LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }],
            tools: &[],
            tool_defs: vec![],
            max_steps: 5,
            max_context_tokens: None,
            goal: None,
            cancellation: None,
        };
        run_turn(input, &callbacks).await.unwrap();

        assert_eq!(
            list_tools_calls.load(Ordering::SeqCst),
            0,
            "host-proxy mode must not pull the engine-side tool table"
        );
    }
}
