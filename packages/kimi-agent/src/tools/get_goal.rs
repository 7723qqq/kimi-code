//! Native execution of the GetGoal tool (state bridge protocol, design doc
//! milestone 7, batch 2).
//!
//! The engine reads the host's goal state through `host/state_read` and
//! renders the v2 `GetGoal` output: a pretty-printed JSON document
//! `{ "goal": <snapshot> | null }` with the internal `goalId` stripped (the
//! model-facing shape, `goalResultForModel`). The host stays the goal
//! authority; this module only parses the wire value and re-serializes it
//! with the v2 field order.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::StateReadRequest;
use crate::turn_loop::types::ExecutableToolResult;

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot provide goal
/// state for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot provide goal state.";

/// Wire shape of the goal domain (`GoalToolResult`): the host returns the
/// full `GoalSnapshot` (including `goalId`) or `null` when no goal exists.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoalStateWire {
    goal: Option<GoalSnapshotWire>,
}

/// v2 `GoalSnapshot` minus `goalId` — the model-facing shape
/// (`goalForModel`). Field order mirrors the v2 serializer so the rendered
/// JSON matches `JSON.stringify(goalResultForModel(result), null, 2)`;
/// optional fields are omitted when absent, like `JSON.stringify` drops
/// `undefined` properties. The wire's `goalId` is ignored by serde.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoalSnapshotWire {
    objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    completion_criterion: Option<String>,
    status: String,
    turns_used: u64,
    tokens_used: u64,
    input_tokens_used: u64,
    output_tokens_used: u64,
    wall_clock_ms: u64,
    budget: GoalBudgetReportWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_reason: Option<String>,
    created_at: u64,
    updated_at: u64,
}

/// v2 `GoalBudgetReport` — nullable budget fields serialize as JSON `null`.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoalBudgetReportWire {
    token_budget: Option<u64>,
    turn_budget: Option<u64>,
    wall_clock_budget_ms: Option<u64>,
    remaining_tokens: Option<u64>,
    remaining_turns: Option<u64>,
    remaining_wall_clock_ms: Option<u64>,
    token_budget_reached: bool,
    turn_budget_reached: bool,
    wall_clock_budget_reached: bool,
    over_budget: bool,
    input_tokens_used: u64,
    output_tokens_used: u64,
}

/// Execute the GetGoal tool natively: `state_read` the goal domain and
/// render the v2-aligned JSON output.
pub async fn execute_get_goal(callbacks: &dyn HostCallbacks, args: &Value) -> ExecutableToolResult {
    let request = StateReadRequest {
        domain: "goal".into(),
        key: "goal".into(),
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
    match callbacks.state_read(request).await {
        Ok(response) => render_goal(&response.value),
        Err(error) => map_state_error(error),
    }
}

/// Render the host's goal wire value as the v2 `GetGoal` output.
fn render_goal(value: &Value) -> ExecutableToolResult {
    let wire: GoalStateWire = match serde_json::from_value(value.clone()) {
        Ok(wire) => wire,
        Err(_) => {
            return err_result(
                "Invalid goal state from host: expected { goal: <snapshot> | null }.".into(),
            );
        }
    };
    match serde_json::to_string_pretty(&wire) {
        Ok(json) => ok_result(json),
        Err(_) => err_result("Failed to render goal state.".into()),
    }
}

/// Map a state bridge error to a tool result: an unwired host (message
/// carries the `does not support state bridge` phrase) gets the dedicated
/// failure message; everything else is passed through verbatim.
fn map_state_error(error: String) -> ExecutableToolResult {
    if error.contains("does not support state bridge") {
        err_result(STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE.into())
    } else {
        err_result(error)
    }
}

/// Engine tool definition for GetGoal, so the model can discover and call it
/// (used by the standalone REPL and native tool listing). The description
/// mirrors v2 `get-goal.md`; the schema mirrors `GetGoalToolInputSchema`
/// (strict empty object).
pub fn get_goal_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "GetGoal".into(),
        description: "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens, time, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\n\nUse `GetGoal` before deciding whether to continue working, report completion, report a blocker, or respect a pause. It returns `{ \"goal\": null }` when there is no current goal.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{
        BoxFuture, PermissionDecision, StateReadRequest, StateReadResponse, StateWriteRequest,
        StateWriteResponse,
    };
    use std::sync::Arc;

    /// Scripted callbacks: records the received state requests and answers
    /// with canned responses.
    struct ScriptedCallbacks {
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
        read_received: Arc<std::sync::Mutex<Option<StateReadRequest>>>,
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
            request: StateReadRequest,
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
        Arc<std::sync::Mutex<Option<StateReadRequest>>>,
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

    fn read_ok(value: Value) -> Result<StateReadResponse, String> {
        Ok(StateReadResponse { value })
    }

    fn write_ok(value: Value) -> Result<StateWriteResponse, String> {
        Ok(StateWriteResponse { ok: true, value })
    }

    #[tokio::test]
    async fn test_no_goal_renders_null() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(serde_json::json!({ "goal": null })),
            write_ok(Value::Null),
        );
        let result = execute_get_goal(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(result.content, "{\n  \"goal\": null\n}");
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "goal");
        assert_eq!(request.key, "goal");
        assert_eq!(request.turn_id, "");
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_goal_renders_v2_json() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({
                "goal": {
                    "goalId": "goal-1",
                    "objective": "Do the thing",
                    "status": "active",
                    "turnsUsed": 2,
                    "tokensUsed": 100,
                    "inputTokensUsed": 40,
                    "outputTokensUsed": 60,
                    "wallClockMs": 1000,
                    "budget": {
                        "tokenBudget": 5000,
                        "turnBudget": 20,
                        "wallClockBudgetMs": 60000,
                        "remainingTokens": 4900,
                        "remainingTurns": 18,
                        "remainingWallClockMs": 59000,
                        "tokenBudgetReached": false,
                        "turnBudgetReached": false,
                        "wallClockBudgetReached": false,
                        "overBudget": false,
                        "inputTokensUsed": 40,
                        "outputTokensUsed": 60
                    },
                    "createdAt": 1700000000000i64,
                    "updatedAt": 1700000001000i64
                }
            })),
            write_ok(Value::Null),
        );
        let result = execute_get_goal(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            r#"{
  "goal": {
    "objective": "Do the thing",
    "status": "active",
    "turnsUsed": 2,
    "tokensUsed": 100,
    "inputTokensUsed": 40,
    "outputTokensUsed": 60,
    "wallClockMs": 1000,
    "budget": {
      "tokenBudget": 5000,
      "turnBudget": 20,
      "wallClockBudgetMs": 60000,
      "remainingTokens": 4900,
      "remainingTurns": 18,
      "remainingWallClockMs": 59000,
      "tokenBudgetReached": false,
      "turnBudgetReached": false,
      "wallClockBudgetReached": false,
      "overBudget": false,
      "inputTokensUsed": 40,
      "outputTokensUsed": 60
    },
    "createdAt": 1700000000000,
    "updatedAt": 1700000001000
  }
}"#
        );
    }

    #[tokio::test]
    async fn test_goal_with_optional_fields_and_null_budgets() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({
                "goal": {
                    "goalId": "goal-2",
                    "objective": "Ship feature X",
                    "completionCriterion": "tests pass",
                    "status": "blocked",
                    "turnsUsed": 5,
                    "tokensUsed": 120,
                    "inputTokensUsed": 50,
                    "outputTokensUsed": 70,
                    "wallClockMs": 3000,
                    "budget": {
                        "tokenBudget": null,
                        "turnBudget": null,
                        "wallClockBudgetMs": null,
                        "remainingTokens": null,
                        "remainingTurns": null,
                        "remainingWallClockMs": null,
                        "tokenBudgetReached": false,
                        "turnBudgetReached": false,
                        "wallClockBudgetReached": false,
                        "overBudget": false,
                        "inputTokensUsed": 50,
                        "outputTokensUsed": 70
                    },
                    "terminalReason": "Blocked after goal budget reached: token budget 100",
                    "createdAt": 1700000000000i64,
                    "updatedAt": 1700000002000i64
                }
            })),
            write_ok(Value::Null),
        );
        let result = execute_get_goal(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            r#"{
  "goal": {
    "objective": "Ship feature X",
    "completionCriterion": "tests pass",
    "status": "blocked",
    "turnsUsed": 5,
    "tokensUsed": 120,
    "inputTokensUsed": 50,
    "outputTokensUsed": 70,
    "wallClockMs": 3000,
    "budget": {
      "tokenBudget": null,
      "turnBudget": null,
      "wallClockBudgetMs": null,
      "remainingTokens": null,
      "remainingTurns": null,
      "remainingWallClockMs": null,
      "tokenBudgetReached": false,
      "turnBudgetReached": false,
      "wallClockBudgetReached": false,
      "overBudget": false,
      "inputTokensUsed": 50,
      "outputTokensUsed": 70
    },
    "terminalReason": "Blocked after goal budget reached: token budget 100",
    "createdAt": 1700000000000,
    "updatedAt": 1700000002000
  }
}"#
        );
    }

    #[tokio::test]
    async fn test_invalid_wire_shape_returns_error() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({ "goal": "nope" })),
            write_ok(Value::Null),
        );
        let result = execute_get_goal(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid goal state from host"));
    }

    #[tokio::test]
    async fn test_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            Err("host does not support state bridge".into()),
            write_ok(Value::Null),
        );
        let result = execute_get_goal(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_other_host_error_passes_through() {
        let (callbacks, _, _) = scripted(
            Err("State read error: [-32001] unknown domain: cron".into()),
            write_ok(Value::Null),
        );
        let result = execute_get_goal(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("-32001"));
        assert!(result.content.contains("unknown domain"));
    }

    #[tokio::test]
    async fn test_turn_and_tool_call_ids_are_forwarded() {
        let (callbacks, read_received, _) = scripted(
            read_ok(serde_json::json!({ "goal": null })),
            write_ok(Value::Null),
        );
        let result = execute_get_goal(
            &callbacks,
            &serde_json::json!({ "turn_id": "turn-42", "tool_call_id": "call_abc" }),
        )
        .await;
        assert!(!result.is_error);
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.turn_id, "turn-42");
        assert_eq!(request.tool_call_id, "call_abc");
    }

    #[test]
    fn test_tool_def_matches_v2_schema() {
        let def = get_goal_tool_def();
        assert_eq!(def.name, "GetGoal");
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["additionalProperties"], false);
        assert!(def.input_schema["properties"].is_object());
        assert!(def.description.contains("Read the current goal"));
        assert!(def.description.contains("`{ \"goal\": null }`"));
    }
}
