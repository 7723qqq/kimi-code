//! Native execution of the EnterPlanMode tool (state bridge protocol, design
//! doc milestone 7).
//!
//! The engine reads the host's plan state and, when plan mode is inactive,
//! writes `{active: true}` through the state bridge. The host generates the
//! plan id and file path and returns them in the write response, which this
//! module renders with the v2 `enteredPlanModeMessage` wording.

use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{StateReadRequest, StateWriteRequest};
use crate::turn_loop::types::ExecutableToolResult;

/// v2 already-active error output (`EnterPlanModeTool`).
const PLAN_MODE_ALREADY_ACTIVE_MESSAGE: &str =
    "Plan mode is already active. Use ExitPlanMode when the plan is ready.";

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot activate plan
/// mode for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot activate plan mode.";

/// Execute the EnterPlanMode tool natively: read the plan domain, return the
/// v2 already-active error when plan mode is on, otherwise write
/// `{active: true}` and render the v2 entered-plan-mode message with the
/// host-returned plan file path.
pub async fn execute_enter_plan_mode(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    // v2 `EnterPlanModeInputSchema` is a strict empty object.
    if !args.as_object().is_some_and(|obj| obj.is_empty()) {
        return err_result("Invalid EnterPlanMode arguments: the tool takes no arguments.".into());
    }
    let read = StateReadRequest {
        domain: "plan".into(),
        key: "plan".into(),
        turn_id: String::new(),
        tool_call_id: String::new(),
    };
    let plan = match callbacks.state_read(read).await {
        Ok(response) => response.value,
        Err(error) => return map_state_error(error),
    };
    if plan.get("active").and_then(|v| v.as_bool()) == Some(true) {
        return err_result(PLAN_MODE_ALREADY_ACTIVE_MESSAGE.into());
    }
    let write = StateWriteRequest {
        domain: "plan".into(),
        key: "plan".into(),
        value: serde_json::json!({ "active": true }),
        undoable: true,
        turn_id: String::new(),
        tool_call_id: String::new(),
    };
    match callbacks.state_write(write).await {
        Ok(response) => {
            let path = response.value.get("path").and_then(|p| p.as_str());
            ok_result(entered_plan_mode_message(path))
        }
        Err(error) => {
            // -32004: the host rejected the enter because plan mode became
            // active between our read and write — same already-active output.
            if error.contains("-32004") {
                err_result(PLAN_MODE_ALREADY_ACTIVE_MESSAGE.into())
            } else {
                map_state_error(error)
            }
        }
    }
}

/// v2 `enteredPlanModeMessage(path)`: the full workflow message when the
/// host returned a plan file path, the degraded variant without one.
fn entered_plan_mode_message(plan_path: Option<&str>) -> String {
    let lines: Vec<String> = match plan_path {
        Some(path) => vec![
            "Plan mode is now active. Your workflow:".into(),
            String::new(),
            format!("Plan file: {path}"),
            String::new(),
            "1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.".into(),
            "2. Design a concrete, step-by-step plan.".into(),
            "3. Write the plan to the plan file with Write or Edit.".into(),
            "4. When the plan is ready, call ExitPlanMode for user approval.".into(),
            String::new(),
            "Do NOT edit files other than the plan file while plan mode is active.".into(),
            "Use Bash only when needed; Bash follows the normal permission mode and rules.".into(),
        ],
        None => vec![
            "Plan mode is now active. Your workflow:".into(),
            String::new(),
            "1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.".into(),
            "2. Design a concrete, step-by-step plan.".into(),
            "3. Wait for the host to provide a plan file path before calling ExitPlanMode.".into(),
            String::new(),
            "Do NOT use Write or Edit while plan mode is active in this host; no plan file path is available.".into(),
            "Use Bash only when needed; Bash follows the normal permission mode and rules.".into(),
        ],
    };
    lines.join("\n")
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

/// Engine tool definition for EnterPlanMode, so the model can discover and
/// call it (used by the standalone REPL and native tool listing). The schema
/// mirrors v2 `EnterPlanModeInputSchema` (strict empty object).
pub fn enter_plan_mode_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "EnterPlanMode".into(),
        description: "Use this tool proactively when you're about to start a non-trivial implementation task.\nGetting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.\n\nUse it when ANY of these conditions apply:\n\n1. New Feature Implementation - e.g. \"Add a caching layer to the API\"\n2. Multiple Valid Approaches - e.g. \"Optimize database queries\" (indexing vs rewrite vs caching)\n3. Code Modifications - e.g. \"Refactor auth module to support OAuth\"\n4. Architectural Decisions - e.g. \"Add WebSocket support\"\n5. Multi-File Changes - involves more than 2-3 files\n6. Unclear Requirements - need exploration to understand scope\n7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision\n\nPermission mode notes:\n- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.\n- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.\n- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.\n- In auto permission mode, ExitPlanMode exits plan mode without asking the user.\n- Use EnterPlanMode only when planning itself adds value.\n\nWhen NOT to use:\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\n- User gave very specific, detailed instructions\n- Pure research/exploration tasks\n\nOnce you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → `ExitPlanMode`) and enforces read-only access. For non-trivial tasks where you are unsure of the codebase structure or relevant code paths, use `Agent(subagent_type=\"explore\")` to investigate first when the `Agent` tool is available.\n\n**Plan file structure for automatic TodoList seeding.** Writing the plan in a structured form lets the system build the initial todo list for you as soon as the plan is approved, so you can start executing immediately instead of recreating the steps in TodoList yourself. Use this structure in the plan file (markdown):\n\n- Each phase is a `## <phase name>` or `### <phase name>` heading — it becomes a `milestone` (first = start, last = finish, middle = phase).\n- Under each phase, list concrete steps as `- <step text>` or `1. <step text>` — each becomes a leaf task (parentId = the milestone id).\n- A completed step `- [x] <text>` seeds `status: 'done'`; a pending step `- [ ] <text>` or a bare `- <text>` seeds `status: 'pending'`.\n- Steps at the top level (no preceding heading) and paragraphs without a list are ignored — you can use them for rationale that should not become a todo.\n\nIf the plan lacks this structure, the todo list is not seeded automatically and the post-plan-mode reminder will nudge you to build it via TodoList. If a todo list already exists for this agent at the moment of plan approval, the existing list is left untouched for the same reason.".into(),
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
    use crate::rpc::types::{BoxFuture, PermissionDecision, StateReadResponse, StateWriteResponse};
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
    async fn test_already_active_returns_error_without_writing() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(serde_json::json!({ "active": true, "id": "plan-1" })),
            write_ok(Value::Null),
        );
        let result = execute_enter_plan_mode(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, PLAN_MODE_ALREADY_ACTIVE_MESSAGE);
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "plan");
        assert_eq!(request.key, "plan");
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_enter_writes_active_and_renders_path_message() {
        let (callbacks, _, write_received) = scripted(
            read_ok(serde_json::json!({ "active": false })),
            write_ok(serde_json::json!({
                "active": true,
                "id": "plan-7f3a",
                "path": "/session/agents/agent-1/plans/plan-7f3a.md"
            })),
        );
        let result = execute_enter_plan_mode(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Plan mode is now active. Your workflow:\n\nPlan file: /session/agents/agent-1/plans/plan-7f3a.md\n\n1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.\n2. Design a concrete, step-by-step plan.\n3. Write the plan to the plan file with Write or Edit.\n4. When the plan is ready, call ExitPlanMode for user approval.\n\nDo NOT edit files other than the plan file while plan mode is active.\nUse Bash only when needed; Bash follows the normal permission mode and rules."
        );
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "plan");
        assert_eq!(request.key, "plan");
        assert_eq!(request.value, serde_json::json!({ "active": true }));
        assert!(request.undoable);
    }

    #[tokio::test]
    async fn test_enter_without_path_renders_degraded_message() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({ "active": false })),
            write_ok(serde_json::json!({ "active": true, "id": "plan-1" })),
        );
        let result = execute_enter_plan_mode(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Plan mode is now active. Your workflow:\n\n1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.\n2. Design a concrete, step-by-step plan.\n3. Wait for the host to provide a plan file path before calling ExitPlanMode.\n\nDo NOT use Write or Edit while plan mode is active in this host; no plan file path is available.\nUse Bash only when needed; Bash follows the normal permission mode and rules."
        );
    }

    #[tokio::test]
    async fn test_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(serde_json::json!({ "active": false })),
            write_ok(Value::Null),
        );
        for bad in [
            serde_json::json!({ "plan": "x" }),
            serde_json::json!({ "active": true }),
            serde_json::json!("nope"),
            serde_json::json!(42),
        ] {
            let result = execute_enter_plan_mode(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid EnterPlanMode arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            Err("host does not support state bridge".into()),
            write_ok(Value::Null),
        );
        let result = execute_enter_plan_mode(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_unsupported_host_on_write_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({ "active": false })),
            Err("State write error: [-32603] host does not support state bridge".into()),
        );
        let result = execute_enter_plan_mode(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_32004_maps_to_already_active() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({ "active": false })),
            Err("State write error: [-32004] plan mode is already active".into()),
        );
        let result = execute_enter_plan_mode(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, PLAN_MODE_ALREADY_ACTIVE_MESSAGE);
    }

    #[tokio::test]
    async fn test_other_host_error_passes_through() {
        let (callbacks, _, _) = scripted(
            Err("State read error: [-32001] unknown domain: goal".into()),
            write_ok(Value::Null),
        );
        let result = execute_enter_plan_mode(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("-32001"));
        assert!(result.content.contains("unknown domain"));
    }

    #[test]
    fn test_tool_def_matches_v2_schema() {
        let def = enter_plan_mode_tool_def();
        assert_eq!(def.name, "EnterPlanMode");
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["additionalProperties"], false);
        assert!(def.input_schema["properties"].is_object());
        assert!(def.description.contains("non-trivial implementation task"));
        assert!(def.description.contains("ExitPlanMode"));
    }
}
