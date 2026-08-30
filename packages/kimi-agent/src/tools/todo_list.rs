//! Native execution of the TodoList tool (state bridge protocol, design doc
//! milestone 7).
//!
//! The engine reads and writes the host's todo state through
//! [`crate::callbacks::HostCallbacks::state_read`] / `state_write` (the
//! `host/state_read` / `host/state_write` RPCs). The host stays the
//! persistence + undo authority; this module only parses the tool arguments,
//! normalizes the todo items, and renders the v2-aligned output.

use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{StateReadRequest, StateWriteRequest};
use crate::tools::todo_item::{read_todo_items, render_todo_list};
use crate::turn_loop::types::ExecutableToolResult;

/// v2 `TODO_LIST_WRITE_REMINDER` (todo-list-write-reminder.md): appended to
/// every non-empty write output.
const TODO_LIST_WRITE_REMINDER: &str = "Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.";

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot persist todo
/// state for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot persist todo list changes.";

/// Execute the TodoList tool natively: omit `todos` to read the current
/// list, pass an empty array to clear it, or pass a full replacement list
/// (v2 semantics — no incremental patch).
pub async fn execute_todo_list(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let Some(todos) = args.get("todos") else {
        return read_todo_list(callbacks, args).await;
    };
    let Some(entries) = todos.as_array() else {
        return err_result(
            "Invalid TodoList arguments: `todos` must be an array of { title, status } items."
                .into(),
        );
    };
    let Some(normalized) = normalize_write_items(entries) else {
        return err_result(
            "Invalid TodoList arguments: each todo needs a non-empty `title` and a `status` of \"pending\", \"in_progress\", or \"done\"."
                .into(),
        );
    };
    write_todo_list(callbacks, args, normalized).await
}

/// Read mode: `state_read` the todo domain and render the host's list.
async fn read_todo_list(callbacks: &dyn HostCallbacks, args: &Value) -> ExecutableToolResult {
    let request = StateReadRequest {
        domain: "todo".into(),
        key: "todo".into(),
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
        Ok(response) => ok_result(render_todo_list(&read_todo_items(&response.value))),
        Err(error) => map_state_error(error),
    }
}

/// Write mode: normalize the submitted items (id assignment, progress
/// clamping), `state_write` them as undoable, and render the host's
/// post-write state.
async fn write_todo_list(
    callbacks: &dyn HostCallbacks,
    args: &Value,
    normalized: Vec<crate::tools::todo_item::TodoItem>,
) -> ExecutableToolResult {
    let request = StateWriteRequest {
        domain: "todo".into(),
        key: "todo".into(),
        value: serde_json::to_value(&normalized).unwrap_or(Value::Array(Vec::new())),
        undoable: true,
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
        Ok(response) => {
            // The host's response value is the authoritative post-write
            // state (it re-normalizes the submitted items).
            let stored = read_todo_items(&response.value);
            if stored.is_empty() {
                ok_result("Todo list cleared.".into())
            } else {
                ok_result(format!(
                    "Todo list updated.\n{}\n\n{TODO_LIST_WRITE_REMINDER}",
                    render_todo_list(&stored)
                ))
            }
        }
        Err(error) => map_state_error(error),
    }
}

/// Strictly validate the submitted entries against the v2 zod contract
/// (non-empty title, valid status; extra fields are ignored like zod's
/// default strip). `None` when any entry violates the shape.
fn normalize_write_items(entries: &[Value]) -> Option<Vec<crate::tools::todo_item::TodoItem>> {
    for entry in entries {
        let obj = entry.as_object()?;
        let title = obj.get("title")?.as_str()?;
        if title.is_empty() {
            return None;
        }
        if !matches!(
            obj.get("status").and_then(|s| s.as_str()),
            Some("pending" | "in_progress" | "done")
        ) {
            return None;
        }
    }
    // Validation passed; `read_todo_items` performs the v2 normalization
    // (id assignment, progress clamping) on the raw entries.
    Some(read_todo_items(&Value::Array(entries.to_vec())))
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

/// Engine tool definition for TodoList, so the model can discover and call
/// it (used by the standalone REPL and native tool listing). The schema
/// mirrors v2 `TodoListInputSchema`.
pub fn todo_list_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "TodoList".into(),
        description: "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\n\n**When to use:**\n- Multi-step tasks that span several tool calls\n- Tracking investigation progress across a large codebase search\n- Planning a sequence of edits before making them\n- After receiving new multi-step instructions, capture the requirements as todos\n- Before starting a tracked task, mark exactly one item as `in_progress`\n- Immediately after finishing a tracked task, mark it `done`; do not batch completions at the end\n\n**When NOT to use:**\n- Single-shot answers that complete in one or two tool calls\n- Trivial requests where tracking adds no clarity\n- Purely conversational or informational replies\n\n**Granularity — split to the smallest verifiable unit:**\n- A leaf task must be one minimal, independently verifiable unit: read one file, change one function, run one command.\n- If finishing an item takes several distinct tool calls, split it further before starting it.\n- Splitting is not busywork: a fine-grained list is your working reference — each turn starts with a digest of the items you are tracking, so the granularity you record is the granularity you plan against. Finer items also make progress reportable (see below), which is how you signal and verify forward motion.\n\n**Milestone structure (tiered):**\n- Work of 3 steps or fewer: a flat list of fine-grained tasks, no milestones.\n- Work of 4 steps or more: first lay out a milestone skeleton — the first milestone is the starting point (confirm context / environment), 1..n middle milestones are coherent phases, the last milestone is the finish line (verify / wrap up) — then attach fine-grained leaf tasks under each milestone.\n- Milestones use `kind: \"milestone\"` with `parentId: null`; leaf tasks reference their milestone via `parentId`. The full list stays a flat array with parent links.\n\n**Progress reporting:**\n- On every meaningful update of an `in_progress` leaf task, include its `progress` (0-100). It is persisted and rendered — it is the signal your work is advancing.\n- Never set `progress` on milestones — it is computed from their children automatically.\n- `done` implies 100; omit `progress` on done items.\n\n**Keep updates cheap:**\n- For small changes — marking one item done, bumping a progress percent, reordering a status — prefer `updates: [{ id, ... }]` over rewriting the whole list. Only the fields you pass change; unknown ids are an error naming the current ids.\n- Use `todos` only when the structure itself changes (add/remove items, re-tier milestones).\n\n**Avoid churn:**\n- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.\n- When unsure of the current state, call query mode first (omit `todos`) to check the list before deciding what to update.\n- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.\n\n**How to use:**\n- Call with `updates: [{ id, status?, progress?, title?, description?, parentId?, kind? }]` to patch existing items in place — the cheap path for daily progress.\n- Call with `todos: [...]` to replace the full list (when structure changes). Each item has `title`, `status`, and optionally `id`, `parentId`, `kind`, `progress`, `description`.\n- Call with no arguments to retrieve the current list without changing it.\n- Call with `todos: []` to clear the list.\n- `todos` and `updates` are mutually exclusive.\n- Keep titles short and actionable (e.g. \"Read session-control.ts\", \"Add planMode flag to TurnManager\").\n- Update statuses as you make progress.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "minLength": 1,
                                "description": "Short, actionable title for the todo."
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "done"],
                                "description": "Current status of the todo."
                            }
                        },
                        "required": ["title", "status"]
                    }
                }
            }
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
    async fn test_read_mode_renders_host_list() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(serde_json::json!([
                { "id": "T1", "parentId": null, "kind": "task", "title": "Read session-control.ts", "status": "in_progress", "progress": 40 },
                { "id": "T2", "parentId": null, "kind": "task", "title": "Write tests", "status": "done" }
            ])),
            write_ok(Value::Null),
        );
        let result = execute_todo_list(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Current todo list: (overall 1/2 · 70%)\n  [in_progress] T1: Read session-control.ts (40%)\n  [done] T2: Write tests"
        );
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "todo");
        assert_eq!(request.key, "todo");
        assert_eq!(request.turn_id, "");
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_read_mode_empty_list() {
        let (callbacks, _, _) = scripted(read_ok(serde_json::json!([])), write_ok(Value::Null));
        let result = execute_todo_list(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Todo list is empty.");
    }

    #[tokio::test]
    async fn test_write_mode_replaces_and_renders() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!([
                { "id": "T1", "parentId": null, "kind": "task", "title": "Read session-control.ts", "status": "in_progress", "progress": 40 },
                { "id": "T2", "parentId": null, "kind": "task", "title": "Write tests", "status": "done" }
            ])),
        );
        let result = execute_todo_list(
            &callbacks,
            &serde_json::json!({
                "todos": [
                    { "title": "Read session-control.ts", "status": "in_progress", "progress": 40 },
                    { "title": "Write tests", "status": "done" }
                ]
            }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            format!(
                "Todo list updated.\nCurrent todo list: (overall 1/2 · 70%)\n  [in_progress] T1: Read session-control.ts (40%)\n  [done] T2: Write tests\n\n{TODO_LIST_WRITE_REMINDER}"
            )
        );
        assert!(read_received.lock().unwrap().is_none());
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "todo");
        assert_eq!(request.key, "todo");
        assert!(request.undoable);
        // The submitted value is normalized: ids assigned, progress clamped.
        assert_eq!(request.value[0]["id"], "T1");
        assert_eq!(request.value[0]["title"], "Read session-control.ts");
        assert_eq!(request.value[0]["status"], "in_progress");
        assert_eq!(request.value[0]["progress"], 40);
        assert_eq!(request.value[1]["id"], "T2");
    }

    #[tokio::test]
    async fn test_write_mode_uses_host_response_when_present() {
        // The host's post-write state wins over the submitted value (it is
        // authoritative after re-normalization).
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!([
                { "id": "H1", "parentId": null, "kind": "task", "title": "Host title", "status": "pending" }
            ])),
        );
        let result = execute_todo_list(
            &callbacks,
            &serde_json::json!({ "todos": [{ "title": "Submitted", "status": "pending" }] }),
        )
        .await;
        assert!(!result.is_error);
        assert!(result.content.contains("H1: Host title"));
        assert!(!result.content.contains("Submitted"));
    }

    #[tokio::test]
    async fn test_clear_mode() {
        let (callbacks, _, write_received) =
            scripted(read_ok(Value::Null), write_ok(serde_json::json!([])));
        let result = execute_todo_list(&callbacks, &serde_json::json!({ "todos": [] })).await;
        assert!(!result.is_error);
        assert_eq!(result.content, "Todo list cleared.");
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.value, serde_json::json!([]));
        assert!(request.undoable);
    }

    #[tokio::test]
    async fn test_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [
            serde_json::json!({ "todos": "nope" }),
            serde_json::json!({ "todos": [{}] }),
            serde_json::json!({ "todos": [{ "title": "", "status": "pending" }] }),
            serde_json::json!({ "todos": [{ "title": "x", "status": "weird" }] }),
            serde_json::json!({ "todos": [{ "title": "x" }] }),
            serde_json::json!({ "todos": [42] }),
        ] {
            let result = execute_todo_list(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid TodoList arguments"));
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
        let result = execute_todo_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_unsupported_host_on_write_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32603] host does not support state bridge".into()),
        );
        let result = execute_todo_list(
            &callbacks,
            &serde_json::json!({ "todos": [{ "title": "x", "status": "pending" }] }),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_other_host_error_passes_through() {
        let (callbacks, _, _) = scripted(
            Err("State read error: [-32001] unknown domain: goal".into()),
            write_ok(Value::Null),
        );
        let result = execute_todo_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("-32001"));
        assert!(result.content.contains("unknown domain"));
    }

    #[tokio::test]
    async fn test_write_error_passes_through() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32003] invalid value: title must be a string".into()),
        );
        let result = execute_todo_list(
            &callbacks,
            &serde_json::json!({ "todos": [{ "title": "x", "status": "pending" }] }),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("-32003"));
    }

    #[tokio::test]
    async fn test_turn_and_tool_call_ids_are_forwarded() {
        let (callbacks, read_received, _) =
            scripted(read_ok(serde_json::json!([])), write_ok(Value::Null));
        let result = execute_todo_list(
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
        let def = todo_list_tool_def();
        assert_eq!(def.name, "TodoList");
        assert_eq!(def.input_schema["type"], "object");
        assert!(def.input_schema["properties"]["todos"].is_object());
        assert_eq!(
            def.input_schema["properties"]["todos"]["items"]["required"][0],
            "title"
        );
        assert_eq!(
            def.input_schema["properties"]["todos"]["items"]["properties"]["status"]["enum"][1],
            "in_progress"
        );
        assert!(def.description.contains("multi-step task"));
        assert!(def.description.contains("todos: []"));
    }
}
