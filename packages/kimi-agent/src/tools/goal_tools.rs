//! Native execution of the goal write tools (UpdateGoal / SetGoalBudget)
//! over the state bridge protocol (design doc milestone 7, batch 7).
//!
//! The host stays the goal authority: it applies the lifecycle and budget
//! semantics and returns the post-write goal snapshot in the response value
//! (`{goal: <snapshot> | null}`, the same shape as the goal read domain).
//! This module validates the tool arguments with the ported goal pure
//! functions and renders the v2-aligned output from the host's snapshot.

use serde::Deserialize;
use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::goal::{BudgetUnit, format_budget, format_elapsed, normalize_budget_input};
use crate::rpc::types::StateWriteRequest;
use crate::turn_loop::types::ExecutableToolResult;

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot update goal
/// state for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot update goal state.";

/// Wire shape of the goal domain (`GoalToolResult`): the host returns the
/// full `GoalSnapshot` (including `goalId`) or `null` when no goal exists.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalStateWire {
    goal: Option<GoalSnapshotWire>,
}

/// The goal snapshot fields the v2 write outputs render; unknown fields are
/// ignored by serde.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalSnapshotWire {
    turns_used: u64,
    tokens_used: u64,
    wall_clock_ms: u64,
    #[serde(default)]
    terminal_reason: Option<String>,
    budget: GoalBudgetReportWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalBudgetReportWire {
    over_budget: bool,
}

/// Execute the UpdateGoal tool natively: validate the status, `state_write`
/// an action-shaped update, and render the v2 output from the host's
/// post-write goal snapshot.
pub async fn execute_update_goal(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let Some(status) = args.get("status").and_then(|s| s.as_str()) else {
        return err_result("Invalid UpdateGoal arguments: `status` must be a string.".into());
    };
    if !matches!(status, "active" | "complete" | "blocked") {
        return err_result("Invalid goal status. Use `active`, `complete`, or `blocked`.".into());
    }
    let request = StateWriteRequest {
        domain: "goal".into(),
        key: "goal".into(),
        value: serde_json::json!({ "action": "update", "status": status }),
        undoable: false,
        turn_id: args
            .get("turn_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        tool_call_id: args
            .get("tool_call_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    };
    match callbacks.state_write(request).await {
        Ok(response) => render_update_goal(&response.value, status),
        Err(error) => map_state_error(error),
    }
}

/// Render the host's post-write goal state as the v2 `UpdateGoal` output: a
/// `null` goal means the operation had nothing to act on (v2
/// `missingGoalOutput`), a present goal means it succeeded.
fn render_update_goal(value: &Value, status: &str) -> ExecutableToolResult {
    let wire: GoalStateWire = match serde_json::from_value(value.clone()) {
        Ok(wire) => wire,
        Err(_) => {
            return err_result(
                "Invalid goal state from host: expected { goal: <snapshot> | null }.".into(),
            );
        }
    };
    let Some(goal) = wire.goal else {
        return ok_result(
            match status {
                "active" => "Goal not resumed: no current goal.",
                "complete" => "Goal not completed: no active goal.",
                _ => "Goal not blocked: no active goal.",
            }
            .into(),
        );
    };
    match status {
        "active" => ok_result("Goal resumed.".into()),
        "complete" => ok_result(goal_completion_summary_prompt(&goal)),
        _ => ok_result(goal_blocked_reason_prompt(&goal)),
    }
}

/// Execute the SetGoalBudget tool natively: normalize and validate the
/// budget input with the ported goal pure functions, `state_write` an
/// action-shaped set_budget, and render the v2 output from the host's
/// post-write goal snapshot.
pub async fn execute_set_goal_budget(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let Some(value) = args.get("value").and_then(|v| v.as_f64()) else {
        return err_result("Invalid SetGoalBudget arguments: `value` must be a number.".into());
    };
    let Some(unit_str) = args.get("unit").and_then(|u| u.as_str()) else {
        return err_result("Invalid SetGoalBudget arguments: `unit` must be a string.".into());
    };
    let Some(unit) = BudgetUnit::parse_unit(unit_str) else {
        return err_result(
            "Invalid SetGoalBudget arguments: `unit` must be one of turns, tokens, milliseconds, seconds, minutes, hours.".into(),
        );
    };
    if value <= 0.0 {
        return err_result("Invalid SetGoalBudget arguments: `value` must be positive.".into());
    }
    let normalized = normalize_budget_input(value, unit);
    // v2 `budgetLimitsFromInput`: time budgets outside 1s..24h are not
    // reasonable and the tool refuses before writing.
    let Some(_) = crate::goal::budget_limits_from_input(normalized, unit) else {
        return err_result(format!(
            "Goal budget not set: {} is not a reasonable goal budget.",
            format_budget(normalized, unit)
        ));
    };
    let request = StateWriteRequest {
        domain: "goal".into(),
        key: "goal".into(),
        value: serde_json::json!({
            "action": "set_budget",
            "value": normalized,
            "unit": unit_str,
        }),
        undoable: false,
        turn_id: args
            .get("turn_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        tool_call_id: args
            .get("tool_call_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    };
    match callbacks.state_write(request).await {
        Ok(response) => render_set_goal_budget(&response.value, normalized, unit),
        Err(error) => map_state_error(error),
    }
}

/// Render the host's post-write goal state as the v2 `SetGoalBudget` output.
fn render_set_goal_budget(
    value: &Value,
    normalized: f64,
    unit: BudgetUnit,
) -> ExecutableToolResult {
    let wire: GoalStateWire = match serde_json::from_value(value.clone()) {
        Ok(wire) => wire,
        Err(_) => {
            return err_result(
                "Invalid goal state from host: expected { goal: <snapshot> | null }.".into(),
            );
        }
    };
    let Some(goal) = wire.goal else {
        return ok_result("Goal budget not set: no current goal.".into());
    };
    let set_message = format!("Goal budget set: {}.", format_budget(normalized, unit));
    if goal.budget.over_budget {
        ok_result(format!(
            "{set_message} The goal has already reached this budget and will stop now."
        ))
    } else {
        ok_result(set_message)
    }
}

/// v2 `buildGoalCompletionSummaryPrompt`.
fn goal_completion_summary_prompt(goal: &GoalSnapshotWire) -> String {
    let head = match goal.terminal_reason.as_deref() {
        Some(reason) => format!("Goal completed successfully: {reason}."),
        None => "Goal completed successfully.".to_string(),
    };
    format!(
        "{head}\n{}\n\nWrite a concise final message for the user. State that the goal is complete, summarize the main work completed, and mention any validation you ran. Do not call more goal tools.",
        goal_stats(goal)
    )
}

/// v2 `buildGoalBlockedReasonPrompt`.
fn goal_blocked_reason_prompt(goal: &GoalSnapshotWire) -> String {
    format!(
        "Goal blocked.\n{}\n\nWrite a concise final message for the user. State that the goal is blocked, explain the concrete blocker, and say what input or change is needed before work can continue. Do not call more goal tools.",
        goal_stats(goal)
    )
}

/// v2 `Worked N turns over <elapsed>, using <tokens> tokens.`
fn goal_stats(goal: &GoalSnapshotWire) -> String {
    let turns = if goal.turns_used == 1 {
        "1 turn".to_string()
    } else {
        format!("{} turns", goal.turns_used)
    };
    format!(
        "Worked {turns} over {}, using {} tokens.",
        format_elapsed(goal.wall_clock_ms),
        format_tokens(goal.tokens_used)
    )
}

/// v2 `formatTokens`: `999` → `999`, `1234` → `1.2k`, `1234567` → `1.2M`.
fn format_tokens(tokens: u64) -> String {
    if tokens < 1000 {
        tokens.to_string()
    } else if tokens < 1_000_000 {
        format!("{:.1}k", tokens as f64 / 1000.0)
    } else {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    }
}

/// Map a state bridge error to a tool result: an unwired host (message
/// carries the `does not support state bridge` phrase) gets the dedicated
/// failure message; everything else is passed through verbatim — the engine
/// never retries a failed state write.
fn map_state_error(error: String) -> ExecutableToolResult {
    if error.contains("does not support state bridge") {
        err_result(STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE.into())
    } else {
        err_result(error)
    }
}

fn ok_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: false,
        note: None,
    }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: true,
        note: None,
    }
}

/// Engine tool definition for UpdateGoal, so the model can discover and call
/// it (used by the standalone REPL and native tool listing). The schema
/// mirrors v2 `UpdateGoalToolInputSchema` (strict).
pub fn update_goal_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "UpdateGoal".into(),
        description: r#"Set the status of the current goal. This is how you resume, complete, or block an autonomous goal.

- `active` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.
- `complete` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use `complete` merely because a budget is nearly exhausted or you want to stop.
- `blocked` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use `blocked` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call `blocked`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call `blocked` in the same turn instead of running more goal turns. Do not use `blocked` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call `blocked` instead of leaving the goal active.

Most active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue in the next goal turn. Call `complete` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call `complete` after only producing a plan, summary, first pass, or partial result. Call `blocked` only after the blocked audit threshold is met. If you call `blocked`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["active", "complete", "blocked"],
                    "description": "The lifecycle status to set for the current goal. Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns."
                }
            },
            "required": ["status"],
            "additionalProperties": false
        }),
    }
}

/// Engine tool definition for SetGoalBudget, so the model can discover and
/// call it (used by the standalone REPL and native tool listing). The schema
/// mirrors v2 `SetGoalBudgetToolInputSchema` (strict).
pub fn set_goal_budget_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "SetGoalBudget".into(),
        description: r#"Set a hard budget limit for the current goal.

Use this only when the user clearly gives a runtime limit, such as:

- "stop after 20 turns"
- "use no more than 500k tokens"
- "finish within 30 minutes"

Do not invent limits. Do not call this for vague wording such as "spend some time" or
"try to be quick".

If the user gives a compound time, convert it to one supported unit before calling this tool.
For example, "2 hours and 3 minutes" can be set as `value: 123, unit: "minutes"`.

A time budget must be between 1 second and 24 hours — the tool rejects anything shorter or
longer, telling the user it is not a reasonable goal budget. Turn and token budgets are not
bounded this way; they must be positive and are rounded to the nearest whole number (minimum 1).

Supported units:

- `turns`
- `tokens`
- `milliseconds`
- `seconds`
- `minutes`
- `hours`"#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "value": {
                    "type": "number",
                    "exclusiveMinimum": 0,
                    "description": "The positive numeric budget value."
                },
                "unit": {
                    "type": "string",
                    "enum": ["turns", "tokens", "milliseconds", "seconds", "minutes", "hours"]
                }
            },
            "required": ["value", "unit"],
            "additionalProperties": false
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{BoxFuture, PermissionDecision, StateReadResponse, StateWriteResponse};
    use std::sync::Arc;

    /// Scripted callbacks: records the received state requests and answers
    /// with canned responses.
    struct ScriptedCallbacks {
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
        read_received: Arc<std::sync::Mutex<Option<crate::rpc::types::StateReadRequest>>>,
        write_received: Arc<std::sync::Mutex<Option<StateWriteRequest>>>,
    }

    impl HostCallbacks for ScriptedCallbacks {
        fn llm_chat(
            &self,
            _: crate::rpc::types::LlmChatRequest,
        ) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: crate::rpc::types::ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<crate::rpc::types::ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: crate::rpc::types::PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }

        fn state_read(
            &self,
            request: crate::rpc::types::StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
            *self.read_received.lock().unwrap() = Some(request);
            let response = self.read_response.clone();
            Box::pin(async move { response })
        }

        fn state_write(
            &self,
            request: StateWriteRequest,
        ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
            *self.write_received.lock().unwrap() = Some(request);
            let response = self.write_response.clone();
            Box::pin(async move { response })
        }
    }

    #[allow(clippy::type_complexity)]
    fn scripted(
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
    ) -> (
        ScriptedCallbacks,
        Arc<std::sync::Mutex<Option<crate::rpc::types::StateReadRequest>>>,
        Arc<std::sync::Mutex<Option<StateWriteRequest>>>,
    ) {
        let read_received = Arc::new(std::sync::Mutex::new(None));
        let write_received = Arc::new(std::sync::Mutex::new(None));
        (
            ScriptedCallbacks {
                read_response,
                write_response,
                read_received: read_received.clone(),
                write_received: write_received.clone(),
            },
            read_received,
            write_received,
        )
    }

    fn write_ok(value: Value) -> Result<StateWriteResponse, String> {
        Ok(StateWriteResponse { ok: true, value })
    }

    fn goal_wire(status: &str, over_budget: bool) -> Value {
        serde_json::json!({
            "goal": {
                "goalId": "goal-1",
                "objective": "Ship the feature",
                "status": status,
                "turnsUsed": 3,
                "tokensUsed": 1234,
                "inputTokensUsed": 600,
                "outputTokensUsed": 634,
                "wallClockMs": 185000,
                "budget": {
                    "tokenBudget": 5000,
                    "turnBudget": 10,
                    "wallClockBudgetMs": 600000,
                    "remainingTokens": 3766,
                    "remainingTurns": 7,
                    "remainingWallClockMs": 415000,
                    "tokenBudgetReached": false,
                    "turnBudgetReached": false,
                    "wallClockBudgetReached": false,
                    "overBudget": over_budget,
                    "inputTokensUsed": 600,
                    "outputTokensUsed": 634
                },
                "createdAt": 1700000000000u64,
                "updatedAt": 1700000185000u64
            }
        })
    }

    #[tokio::test]
    async fn test_update_active_resumes() {
        let (callbacks, read_received, write_received) =
            scripted(Err("not used".into()), write_ok(goal_wire("active", false)));
        let result =
            execute_update_goal(&callbacks, &serde_json::json!({ "status": "active" })).await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Goal resumed.");
        assert!(read_received.lock().unwrap().is_none());
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "goal");
        assert_eq!(request.key, "goal");
        assert!(!request.undoable);
        assert_eq!(request.value["action"], "update");
        assert_eq!(request.value["status"], "active");
    }

    #[tokio::test]
    async fn test_update_complete_renders_summary() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            write_ok(serde_json::json!({
                "goal": {
                    "goalId": "goal-1",
                    "objective": "Ship the feature",
                    "status": "complete",
                    "turnsUsed": 3,
                    "tokensUsed": 1234,
                    "inputTokensUsed": 600,
                    "outputTokensUsed": 634,
                    "wallClockMs": 185000,
                    "budget": {
                        "overBudget": false,
                        "tokenBudget": null,
                        "turnBudget": null,
                        "wallClockBudgetMs": null,
                        "remainingTokens": null,
                        "remainingTurns": null,
                        "remainingWallClockMs": null,
                        "tokenBudgetReached": false,
                        "turnBudgetReached": false,
                        "wallClockBudgetReached": false,
                        "inputTokensUsed": 600,
                        "outputTokensUsed": 634
                    },
                    "terminalReason": "All tests pass",
                    "createdAt": 1700000000000u64,
                    "updatedAt": 1700000185000u64
                }
            })),
        );
        let result =
            execute_update_goal(&callbacks, &serde_json::json!({ "status": "complete" })).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Goal completed successfully: All tests pass.\nWorked 3 turns over 3m05s, using 1.2k tokens.\n\nWrite a concise final message for the user. State that the goal is complete, summarize the main work completed, and mention any validation you ran. Do not call more goal tools."
        );
    }

    #[tokio::test]
    async fn test_update_complete_without_reason() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            write_ok(goal_wire("complete", false)),
        );
        let result =
            execute_update_goal(&callbacks, &serde_json::json!({ "status": "complete" })).await;
        assert!(!result.is_error);
        assert!(result.content.starts_with("Goal completed successfully.\n"));
    }

    #[tokio::test]
    async fn test_update_blocked_renders_reason_prompt() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            write_ok(goal_wire("blocked", false)),
        );
        let result =
            execute_update_goal(&callbacks, &serde_json::json!({ "status": "blocked" })).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Goal blocked.\nWorked 3 turns over 3m05s, using 1.2k tokens.\n\nWrite a concise final message for the user. State that the goal is blocked, explain the concrete blocker, and say what input or change is needed before work can continue. Do not call more goal tools."
        );
    }

    #[tokio::test]
    async fn test_update_no_goal_messages() {
        for (status, expected) in [
            ("active", "Goal not resumed: no current goal."),
            ("complete", "Goal not completed: no active goal."),
            ("blocked", "Goal not blocked: no active goal."),
        ] {
            let (callbacks, _, _) = scripted(
                Err("not used".into()),
                write_ok(serde_json::json!({ "goal": null })),
            );
            let result =
                execute_update_goal(&callbacks, &serde_json::json!({ "status": status })).await;
            assert!(!result.is_error, "status: {status}");
            assert_eq!(result.content, expected, "status: {status}");
        }
    }

    #[tokio::test]
    async fn test_update_invalid_status_returns_error_without_calling_host() {
        let (callbacks, _, write_received) =
            scripted(Err("not used".into()), write_ok(Value::Null));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "status": "paused" }),
            serde_json::json!({ "status": 42 }),
        ] {
            let result = execute_update_goal(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(
                result.content.contains("Invalid goal status")
                    || result.content.contains("Invalid UpdateGoal arguments")
            );
        }
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_update_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            Err("State write error: [-32603] host does not support state bridge".into()),
        );
        let result =
            execute_update_goal(&callbacks, &serde_json::json!({ "status": "active" })).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_update_host_rejection_passes_through() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            Err("State write error: [-32004] Goal not completed: the current goal changed.".into()),
        );
        let result =
            execute_update_goal(&callbacks, &serde_json::json!({ "status": "complete" })).await;
        assert!(result.is_error);
        assert!(result.content.contains("-32004"));
        assert!(result.content.contains("the current goal changed"));
    }

    #[tokio::test]
    async fn test_update_invalid_wire_shape_returns_error() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            write_ok(serde_json::json!({ "goal": "nope" })),
        );
        let result =
            execute_update_goal(&callbacks, &serde_json::json!({ "status": "active" })).await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid goal state from host"));
    }

    #[tokio::test]
    async fn test_set_budget_renders() {
        let (callbacks, read_received, write_received) =
            scripted(Err("not used".into()), write_ok(goal_wire("active", false)));
        let result = execute_set_goal_budget(
            &callbacks,
            &serde_json::json!({ "value": 20, "unit": "turns" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Goal budget set: 20 turns.");
        assert!(read_received.lock().unwrap().is_none());
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "goal");
        assert_eq!(request.key, "goal");
        assert!(!request.undoable);
        assert_eq!(request.value["action"], "set_budget");
        assert_eq!(request.value["value"], 20.0);
        assert_eq!(request.value["unit"], "turns");
    }

    #[tokio::test]
    async fn test_set_budget_normalizes_turns_and_tokens() {
        let (callbacks, _, write_received) =
            scripted(Err("not used".into()), write_ok(goal_wire("active", false)));
        let result = execute_set_goal_budget(
            &callbacks,
            &serde_json::json!({ "value": 2.6, "unit": "turns" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Goal budget set: 3 turns.");
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.value["value"], 3.0);

        let (callbacks, _, write_received) =
            scripted(Err("not used".into()), write_ok(goal_wire("active", false)));
        let result = execute_set_goal_budget(
            &callbacks,
            &serde_json::json!({ "value": 0.4, "unit": "tokens" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Goal budget set: 1 token.");
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.value["value"], 1.0);
    }

    #[tokio::test]
    async fn test_set_budget_time_unit_renders() {
        let (callbacks, _, _) =
            scripted(Err("not used".into()), write_ok(goal_wire("active", false)));
        let result = execute_set_goal_budget(
            &callbacks,
            &serde_json::json!({ "value": 30, "unit": "seconds" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Goal budget set: 30 seconds.");
    }

    #[tokio::test]
    async fn test_set_budget_over_budget_renders_stop_notice() {
        let (callbacks, _, _) =
            scripted(Err("not used".into()), write_ok(goal_wire("blocked", true)));
        let result = execute_set_goal_budget(
            &callbacks,
            &serde_json::json!({ "value": 1, "unit": "turns" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Goal budget set: 1 turn. The goal has already reached this budget and will stop now."
        );
    }

    #[tokio::test]
    async fn test_set_budget_no_goal() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            write_ok(serde_json::json!({ "goal": null })),
        );
        let result = execute_set_goal_budget(
            &callbacks,
            &serde_json::json!({ "value": 20, "unit": "turns" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Goal budget not set: no current goal.");
    }

    #[tokio::test]
    async fn test_set_budget_unreasonable_time_returns_error_without_calling_host() {
        let (callbacks, _, write_received) =
            scripted(Err("not used".into()), write_ok(Value::Null));
        for (value, unit, expected) in [
            (
                0.5,
                "seconds",
                "Goal budget not set: 0.5 seconds is not a reasonable goal budget.",
            ),
            (
                25.0,
                "hours",
                "Goal budget not set: 25 hours is not a reasonable goal budget.",
            ),
        ] {
            let result = execute_set_goal_budget(
                &callbacks,
                &serde_json::json!({ "value": value, "unit": unit }),
            )
            .await;
            assert!(result.is_error, "value: {value}");
            assert_eq!(result.content, expected);
        }
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_set_budget_invalid_args_return_error_without_calling_host() {
        let (callbacks, _, write_received) =
            scripted(Err("not used".into()), write_ok(Value::Null));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "value": 10 }),
            serde_json::json!({ "unit": "turns" }),
            serde_json::json!({ "value": -5, "unit": "turns" }),
            serde_json::json!({ "value": 0, "unit": "turns" }),
            serde_json::json!({ "value": "10", "unit": "turns" }),
            serde_json::json!({ "value": 10, "unit": "parsecs" }),
        ] {
            let result = execute_set_goal_budget(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid SetGoalBudget arguments"));
        }
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_set_budget_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            Err("not used".into()),
            Err("host does not support state bridge".into()),
        );
        let result = execute_set_goal_budget(
            &callbacks,
            &serde_json::json!({ "value": 20, "unit": "turns" }),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[test]
    fn test_format_tokens() {
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(1234), "1.2k");
        assert_eq!(format_tokens(999_999), "1000.0k");
        assert_eq!(format_tokens(1_234_567), "1.2M");
    }

    #[test]
    fn test_tool_defs_match_v2_schema() {
        let update = update_goal_tool_def();
        assert_eq!(update.name, "UpdateGoal");
        assert_eq!(update.input_schema["required"][0], "status");
        assert_eq!(
            update.input_schema["properties"]["status"]["enum"],
            serde_json::json!(["active", "complete", "blocked"])
        );
        assert_eq!(update.input_schema["additionalProperties"], false);
        assert!(update.description.contains("resume, complete, or block"));

        let budget = set_goal_budget_tool_def();
        assert_eq!(budget.name, "SetGoalBudget");
        assert_eq!(budget.input_schema["required"][0], "value");
        assert_eq!(budget.input_schema["required"][1], "unit");
        assert_eq!(
            budget.input_schema["properties"]["value"]["exclusiveMinimum"],
            0
        );
        assert_eq!(
            budget.input_schema["properties"]["unit"]["enum"],
            serde_json::json!([
                "turns",
                "tokens",
                "milliseconds",
                "seconds",
                "minutes",
                "hours"
            ])
        );
        assert_eq!(budget.input_schema["additionalProperties"], false);
        assert!(budget.description.contains("1 second and 24 hours"));
    }
}
