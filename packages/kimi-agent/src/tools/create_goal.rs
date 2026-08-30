//! Native execution of the CreateGoal tool (state bridge protocol, design
//! doc milestone 7, batch 7).
//!
//! The engine submits an action-shaped create through `host/state_write`
//! (`{action: "create", objective, completion_criterion?}`) and renders the
//! host's post-write goal snapshot with the v2 `CreateGoal` output: a
//! pretty-printed JSON document `{ "goal": <snapshot> | null }` with the
//! internal `goalId` stripped (the model-facing shape, `goalForModel`). The
//! host stays the goal authority — it owns the lifecycle, the replace
//! semantics, and the budget defaults; this module only parses the tool
//! arguments and re-serializes the wire value with the v2 field order.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::StateWriteRequest;
use crate::turn_loop::types::ExecutableToolResult;

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot create goal
/// state for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot create a goal.";

/// Wire shape of the goal domain (`GoalToolResult`): the host returns the
/// full `GoalSnapshot` (including `goalId`) or `null` when no goal exists.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoalStateWire {
    goal: Option<GoalSnapshotWire>,
}

/// v2 `GoalSnapshot` minus `goalId` — the model-facing shape
/// (`goalForModel`). Field order mirrors the v2 serializer so the rendered
/// JSON matches `JSON.stringify(goalForModel(result), null, 2)`; optional
/// fields are omitted when absent, like `JSON.stringify` drops `undefined`
/// properties. The wire's `goalId` is ignored by serde.
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

/// Execute the CreateGoal tool natively: validate the arguments, submit an
/// action-shaped create through the state bridge, and render the v2-aligned
/// JSON output from the host's post-write goal snapshot.
pub async fn execute_create_goal(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let Some(objective) = args.get("objective").and_then(|o| o.as_str()) else {
        return err_result("Invalid CreateGoal arguments: `objective` must be a string.".into());
    };
    if objective.is_empty() {
        return err_result("Invalid CreateGoal arguments: `objective` must not be empty.".into());
    }
    // The wire contract carries no replace flag; a model that asks for it
    // must not get a silent no-op create.
    if args.get("replace").is_some() {
        return err_result(
            "Invalid CreateGoal arguments: `replace` is not supported by the connected host."
                .into(),
        );
    }
    let completion_criterion = match args.get("completionCriterion") {
        None => None,
        Some(value) => match value.as_str() {
            Some(criterion) => Some(criterion.to_string()),
            None => {
                return err_result(
                    "Invalid CreateGoal arguments: `completionCriterion` must be a string.".into(),
                );
            }
        },
    };
    let mut value = serde_json::Map::new();
    value.insert("action".into(), "create".into());
    value.insert("objective".into(), objective.into());
    if let Some(criterion) = completion_criterion {
        value.insert("completion_criterion".into(), criterion.into());
    }
    let request = StateWriteRequest {
        domain: "goal".into(),
        key: "goal".into(),
        value: Value::Object(value),
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
        Ok(response) => render_goal(&response.value),
        Err(error) => map_state_error(error),
    }
}

/// Render the host's goal wire value as the v2 `CreateGoal` output.
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
/// failure message; everything else is passed through verbatim — the engine
/// never retries a failed state write.
fn map_state_error(error: String) -> ExecutableToolResult {
    if error.contains("does not support state bridge") {
        err_result(STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE.into())
    } else {
        err_result(error)
    }
}

/// Engine tool definition for CreateGoal, so the model can discover and call
/// it (used by the standalone REPL and native tool listing). The description
/// mirrors v2 `create-goal.md`; the schema mirrors `CreateGoalToolInputSchema`
/// minus `replace`, which the wire contract does not carry.
pub fn create_goal_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "CreateGoal".into(),
        description: "Create a durable, structured goal that the runtime will pursue across multiple turns.\n\nCall `CreateGoal` only when:\n\n- the user explicitly asks you to start a goal or work autonomously toward an outcome, or\n- a host goal-intake prompt asks you to create one.\n\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a\nverifiable completion condition. A goal needs a checkable end state.\n\nWhen the request is vague, ask the user for the missing completion criterion before creating\nthe goal. If the user clearly insists after you warn them that the wording is vague or risky,\nrespect that and create the goal.\n\nInclude a `completionCriterion` when the user provides one, or when it can be stated without\ninventing new requirements. Keep `objective` concise; reference long task descriptions by file\npath rather than pasting them.\n\nCreating a goal fails if one already exists, so use `replace: true` only when the user explicitly\nwants to abandon the current goal and start a new one.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "objective": {
                    "type": "string",
                    "minLength": 1,
                    "description": "The objective to pursue. Must have a verifiable end state."
                },
                "completionCriterion": {
                    "type": "string",
                    "description": "How to verify the goal is complete. Include when the user provides one."
                }
            },
            "required": ["objective"],
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
        BoxFuture, PermissionDecision, StateReadRequest, StateReadResponse, StateWriteResponse,
    };
    use std::sync::Arc;

    /// Scripted callbacks: records the received state requests and answers
    /// with canned responses.
    struct ScriptedCallbacks {
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
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
            _: StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
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

    fn scripted(
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
    ) -> (
        ScriptedCallbacks,
        Arc<std::sync::Mutex<Option<StateWriteRequest>>>,
    ) {
        let write_received = Arc::new(std::sync::Mutex::new(None));
        (
            ScriptedCallbacks {
                read_response,
                write_response,
                write_received: write_received.clone(),
            },
            write_received,
        )
    }

    fn write_ok(value: Value) -> Result<StateWriteResponse, String> {
        Ok(StateWriteResponse { ok: true, value })
    }

    fn read_ok(value: Value) -> Result<StateReadResponse, String> {
        Ok(StateReadResponse { value })
    }

    fn created_goal() -> Value {
        serde_json::json!({
            "goal": {
                "goalId": "goal-1",
                "objective": "Do the thing",
                "completionCriterion": "tests pass",
                "status": "active",
                "turnsUsed": 0,
                "tokensUsed": 0,
                "inputTokensUsed": 0,
                "outputTokensUsed": 0,
                "wallClockMs": 0,
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
                    "inputTokensUsed": 0,
                    "outputTokensUsed": 0
                },
                "createdAt": 1700000000000i64,
                "updatedAt": 1700000000000i64
            }
        })
    }

    #[tokio::test]
    async fn test_create_sends_action_and_renders_v2_json() {
        let (callbacks, write_received) = scripted(read_ok(Value::Null), write_ok(created_goal()));
        let result = execute_create_goal(
            &callbacks,
            &serde_json::json!({
                "objective": "Do the thing",
                "completionCriterion": "tests pass",
            }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            r#"{
  "goal": {
    "objective": "Do the thing",
    "completionCriterion": "tests pass",
    "status": "active",
    "turnsUsed": 0,
    "tokensUsed": 0,
    "inputTokensUsed": 0,
    "outputTokensUsed": 0,
    "wallClockMs": 0,
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
      "inputTokensUsed": 0,
      "outputTokensUsed": 0
    },
    "createdAt": 1700000000000,
    "updatedAt": 1700000000000
  }
}"#
        );
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "goal");
        assert_eq!(request.key, "goal");
        assert_eq!(request.value["action"], "create");
        assert_eq!(request.value["objective"], "Do the thing");
        assert_eq!(request.value["completion_criterion"], "tests pass");
        assert!(!request.undoable);
    }

    #[tokio::test]
    async fn test_create_without_completion_criterion_omits_key() {
        let (callbacks, write_received) = scripted(read_ok(Value::Null), write_ok(created_goal()));
        let result = execute_create_goal(
            &callbacks,
            &serde_json::json!({ "objective": "Do the thing" }),
        )
        .await;
        assert!(!result.is_error);
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.value["action"], "create");
        assert_eq!(request.value["objective"], "Do the thing");
        assert!(request.value.get("completion_criterion").is_none());
    }

    #[tokio::test]
    async fn test_goal_null_renders_null() {
        let (callbacks, _) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!({ "goal": null })),
        );
        let result = execute_create_goal(
            &callbacks,
            &serde_json::json!({ "objective": "Do the thing" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(result.content, "{\n  \"goal\": null\n}");
    }

    #[tokio::test]
    async fn test_invalid_args_return_error_without_calling_host() {
        let (callbacks, write_received) = scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "objective": "" }),
            serde_json::json!({ "objective": 42 }),
            serde_json::json!({ "objective": "x", "replace": true }),
            serde_json::json!({ "objective": "x", "completionCriterion": 42 }),
        ] {
            let result = execute_create_goal(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid CreateGoal arguments"));
        }
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_unsupported_host_returns_failure_message() {
        let (callbacks, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32603] host does not support state bridge".into()),
        );
        let result = execute_create_goal(
            &callbacks,
            &serde_json::json!({ "objective": "Do the thing" }),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_host_rejection_passes_through() {
        let (callbacks, _) = scripted(
            read_ok(Value::Null),
            Err(
                "State write error: [-32004] Goal already exists; use replace to start a new one."
                    .into(),
            ),
        );
        let result = execute_create_goal(
            &callbacks,
            &serde_json::json!({ "objective": "Do the thing" }),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("-32004"));
        assert!(result.content.contains("Goal already exists"));
    }

    #[tokio::test]
    async fn test_invalid_wire_shape_returns_error() {
        let (callbacks, _) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!({ "goal": "nope" })),
        );
        let result = execute_create_goal(
            &callbacks,
            &serde_json::json!({ "objective": "Do the thing" }),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid goal state from host"));
    }

    #[tokio::test]
    async fn test_turn_and_tool_call_ids_are_forwarded() {
        let (callbacks, write_received) = scripted(read_ok(Value::Null), write_ok(created_goal()));
        let result = execute_create_goal(
            &callbacks,
            &serde_json::json!({
                "objective": "Do the thing",
                "turn_id": "turn-42",
                "tool_call_id": "call_abc"
            }),
        )
        .await;
        assert!(!result.is_error);
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.turn_id, "turn-42");
        assert_eq!(request.tool_call_id, "call_abc");
    }

    #[test]
    fn test_tool_def_matches_v2_schema() {
        let def = create_goal_tool_def();
        assert_eq!(def.name, "CreateGoal");
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["additionalProperties"], false);
        assert_eq!(def.input_schema["required"][0], "objective");
        assert_eq!(def.input_schema["properties"]["objective"]["minLength"], 1);
        assert!(def.input_schema["properties"]["completionCriterion"].is_object());
        // The wire contract does not carry `replace`.
        assert!(def.input_schema["properties"].get("replace").is_none());
        assert!(def.description.contains("verifiable completion condition"));
    }
}
