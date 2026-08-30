//! Native execution of the task tool family (TaskList / TaskOutput /
//! TaskStop / TaskWait) over the state bridge protocol (design doc
//! milestone 7, batch 7).
//!
//! The host stays the task authority: it owns the task registry, the
//! output ring buffers, and the blocking wait. The engine reads the task
//! list through `host/state_read {domain: "task", key: "task"}` and one
//! task's output snapshot through `key: "<task_id>"`, and submits
//! action-shaped writes (`{action: "stop" | "wait", ...}`) through
//! `host/state_write`. Rendering mirrors the v2 task tools
//! (`agent-core-v2/src/agent/tools/task/`); the wire shapes
//! (`TaskEntryWire` / `TaskOutputWire`) are host-defined.

use serde_json::Value;
use std::time::Instant;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{StateReadRequest, StateWriteRequest};
use crate::tools::task_format;
use crate::turn_loop::types::ExecutableToolResult;

/// v2 `WAIT_FOR_MAX_TIMEOUT_S` (`DEFAULT_BACKGROUND_TIMEOUT_S`): the
/// TaskWait `timeout` argument is capped at 600 seconds.
const WAIT_FOR_MAX_TIMEOUT_S: u64 = 600;

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot manage
/// background tasks for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot manage background tasks.";

/// v2 `TERMINAL_STATUSES`: statuses that mean the task is no longer
/// running.
fn is_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "timed_out" | "killed" | "lost"
    )
}

/// Execute the TaskList tool natively: `state_read` the task registry and
/// render the v2-aligned list (header, `---`-separated entries, empty
/// message).
pub async fn execute_task_list(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let active_only = match args.get("active_only") {
        None | Some(Value::Null) => true,
        Some(value) => match value.as_bool() {
            Some(active_only) => active_only,
            None => {
                return err_result(
                    "Invalid TaskList arguments: `active_only` must be a boolean.".into(),
                );
            }
        },
    };
    // v2 zod bounds (1..=100). The read request cannot carry the limit, so
    // the host applies its own cap; the argument is validated for parity.
    if let Some(limit) = args.get("limit")
        && limit
            .as_u64()
            .is_none_or(|limit| !(1..=100).contains(&limit))
    {
        return err_result(
            "Invalid TaskList arguments: `limit` must be an integer between 1 and 100.".into(),
        );
    }
    let request = StateReadRequest {
        domain: "task".into(),
        key: "task".into(),
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
        Ok(response) => render_task_list(&response.value, active_only),
        Err(error) => map_state_error(error, None),
    }
}

/// Render the host's task registry wire value (an array of task entries)
/// as the v2 `TaskList` output: `active_background_tasks: N` header,
/// entries joined by a lone `---` line, and the dedicated empty message.
/// The host returns every task (its read cannot carry the filter), so
/// `active_only` is applied here: terminal entries are dropped.
fn render_task_list(value: &Value, active_only: bool) -> ExecutableToolResult {
    let Some(tasks) = value.as_array() else {
        return err_result(
            "Invalid task state from host: expected an array of task entries.".into(),
        );
    };
    let filtered: Vec<&Value> = if active_only {
        tasks
            .iter()
            .filter(|task| {
                task.get("status")
                    .and_then(|s| s.as_str())
                    .is_none_or(|status| !is_terminal_status(status))
            })
            .collect()
    } else {
        tasks.iter().collect()
    };
    let label = if active_only {
        "active_background_tasks"
    } else {
        "background_tasks"
    };
    let header = format!("{label}: {}", filtered.len());
    if filtered.is_empty() {
        return ok_result(format!("{header}\nNo background tasks found."));
    }
    let records: Vec<String> = filtered
        .iter()
        .map(|task| render_task_entry(task))
        .collect();
    ok_result(format!("{header}\n{}", records.join("\n---\n")))
}

/// Render one task wire entry as v2 `formatPlainObject` renders an
/// `AgentTaskInfo`: `field: value` lines, camelCase keys snake_cased,
/// nulls skipped, the wire's `id` mapped to v2's `task_id` (the host
/// sends `taskId`; the contract shape uses `id`). The output preview
/// fields (`preview` / `output`) are rendered separately by the
/// output/wait renderers, so they are excluded here.
fn render_task_entry(value: &Value) -> String {
    let Some(obj) = value.as_object() else {
        return String::new();
    };
    let entries: Vec<(&str, &Value)> = obj
        .iter()
        .filter(|(key, _)| key.as_str() != "output" && key.as_str() != "preview")
        .map(|(key, value)| {
            if key == "id" {
                ("taskId", value)
            } else {
                (key.as_str(), value)
            }
        })
        .collect();
    task_format::format_plain_object_entries(&entries)
}

/// Execute the TaskOutput tool natively: `state_read` the task's output
/// snapshot and render the v2-aligned output (metadata lines, truncation
/// note, `[output]` preview).
pub async fn execute_task_output(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let task_id = match parse_task_id(args, "TaskOutput") {
        Ok(task_id) => task_id,
        Err(message) => return err_result(message),
    };
    let request = StateReadRequest {
        domain: "task".into(),
        key: task_id.clone(),
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
        Ok(response) => render_task_output(&response.value),
        Err(error) => map_state_error(error, Some(&task_id)),
    }
}

/// Render the host's output snapshot as the v2 `TaskOutput` output:
/// metadata lines, a truncation note when the preview is truncated, then
/// the `[output]` preview section.
fn render_task_output(value: &Value) -> ExecutableToolResult {
    if !value.is_object() {
        return err_result("Invalid task state from host: expected a task output snapshot.".into());
    }
    let mut lines = vec![render_task_entry(value), String::new()];
    if let Some(truncated) = truncated_line(value) {
        lines.push(truncated);
    }
    lines.push("[output]".into());
    lines.push(output_preview(value));
    ok_result(lines.join("\n"))
}

/// v2 `TaskOutputTool` truncation note: only when the preview is
/// truncated; the full-log variant needs `fullOutputAvailable` plus an
/// `outputPath`. The host sends `truncated`; the contract shape uses
/// `outputTruncated`.
fn truncated_line(value: &Value) -> Option<String> {
    let obj = value.as_object()?;
    let truncated = obj
        .get("truncated")
        .or_else(|| obj.get("outputTruncated"))
        .and_then(|v| v.as_bool());
    if truncated != Some(true) {
        return None;
    }
    let full_available = obj.get("fullOutputAvailable").and_then(|v| v.as_bool()) == Some(true);
    let output_path = obj.get("outputPath").and_then(|v| v.as_str());
    match (full_available, output_path) {
        (true, Some(path)) => Some(format!("[Truncated. Full output: {path}]")),
        _ => Some("[Truncated. No persisted full log is available for this task.]".into()),
    }
}

/// v2 `output.preview || '[no output available]'`. The host sends
/// `preview`; the contract shape uses `output`.
fn output_preview(value: &Value) -> String {
    match value.get("preview").or_else(|| value.get("output")) {
        Some(Value::String(preview)) if !preview.is_empty() => preview.clone(),
        _ => "[no output available]".into(),
    }
}

/// Whether the value carries an output preview section (`preview` /
/// `output` field). The host's wait response is the task entry without
/// one, so the completed wait report omits the `[output]` section then.
fn has_output_section(value: &Value) -> bool {
    value.get("preview").is_some() || value.get("output").is_some()
}

/// Execute the TaskStop tool natively: `state_write` an action-shaped
/// stop and render the v2-aligned `task_id` / `status` / `reason` lines.
pub async fn execute_task_stop(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let task_id = match parse_task_id(args, "TaskStop") {
        Ok(task_id) => task_id,
        Err(message) => return err_result(message),
    };
    // v2 default reason. The wire action carries only the id — the host
    // records its own reason, and the response's stopReason wins in the
    // render.
    let reason = match args.get("reason").and_then(|r| r.as_str()) {
        Some(reason) => {
            let trimmed = reason.trim();
            if trimmed.is_empty() {
                "Stopped by TaskStop".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => "Stopped by TaskStop".to_string(),
    };
    let request = StateWriteRequest {
        domain: "task".into(),
        key: "task".into(),
        value: serde_json::json!({ "action": "stop", "id": task_id }),
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
        Ok(response) => render_task_stop(&response.value, &task_id, &reason),
        Err(error) => map_state_error(error, Some(&task_id)),
    }
}

/// Render the host's stop response as the v2 `TaskStop` output: exactly
/// `task_id` / `status` / `reason` lines. The id falls back to the
/// requested task id, the reason to the submitted one.
fn render_task_stop(value: &Value, task_id: &str, reason: &str) -> ExecutableToolResult {
    let Some(obj) = value.as_object() else {
        return err_result("Invalid task state from host: expected the stopped task.".into());
    };
    let id = obj
        .get("taskId")
        .or_else(|| obj.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or(task_id);
    let mut lines = vec![format!("task_id: {id}")];
    if let Some(status) = obj.get("status").and_then(|v| v.as_str()) {
        lines.push(format!("status: {status}"));
    }
    let stop_reason = obj
        .get("stopReason")
        .or_else(|| obj.get("reason"))
        .and_then(|v| v.as_str())
        .unwrap_or(reason);
    lines.push(format!("reason: {stop_reason}"));
    ok_result(lines.join("\n"))
}

/// Execute the TaskWait tool natively: `state_write` a blocking wait
/// action and render the v2-aligned outcome. The host blocks until the
/// task finishes or the timeout elapses; a non-terminal status in the
/// returned snapshot (or a timeout error) renders the v2 timeout report.
pub async fn execute_task_wait(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let task_id = match parse_task_id(args, "TaskWait") {
        Ok(task_id) => task_id,
        Err(message) => return err_result(message),
    };
    let timeout_s = match parse_timeout(args) {
        Ok(timeout) => timeout,
        Err(message) => return err_result(message),
    };
    let timeout_ms = timeout_s * 1000;
    let started = Instant::now();
    let request = StateWriteRequest {
        domain: "task".into(),
        key: "task".into(),
        value: serde_json::json!({ "action": "wait", "id": task_id, "timeout_ms": timeout_ms }),
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
        Ok(response) => render_task_wait(&response.value, &task_id, timeout_ms, waited_ms(started)),
        Err(error) => map_wait_error(error, &task_id, timeout_ms, waited_ms(started)),
    }
}

/// Render the host's wait response as the v2 `WaitFor` outcome: a
/// terminal status renders the completed report, anything else the
/// timeout report (a timeout is not an error).
fn render_task_wait(
    value: &Value,
    task_id: &str,
    timeout_ms: u64,
    waited_ms: u64,
) -> ExecutableToolResult {
    let Some(obj) = value.as_object() else {
        return err_result("Invalid task state from host: expected a task output snapshot.".into());
    };
    let status = obj.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if is_terminal_status(status) {
        render_wait_completed(value, task_id, timeout_ms, waited_ms)
    } else {
        render_wait_timeout(task_id, timeout_ms, waited_ms)
    }
}

/// v2 `WaitFor.formatCompleted`: wait metadata, `[finished]` task report
/// (metadata lines + truncation note + `[output]` preview when the host
/// included the output snapshot).
fn render_wait_completed(
    value: &Value,
    task_id: &str,
    timeout_ms: u64,
    waited_ms: u64,
) -> ExecutableToolResult {
    let mut lines = vec![
        wait_metadata("completed", task_id, timeout_ms, waited_ms),
        String::new(),
        "[finished]".into(),
        render_task_entry(value),
    ];
    if has_output_section(value) {
        lines.push(String::new());
        if let Some(truncated) = truncated_line(value) {
            lines.push(truncated);
        }
        lines.push("[output]".into());
        lines.push(output_preview(value));
    }
    ok_result(lines.join("\n"))
}

/// v2 `WaitFor.formatTimeout`: the timeout report. A timeout is not an
/// error — the tool returns it as a success result.
fn render_wait_timeout(task_id: &str, timeout_ms: u64, waited_ms: u64) -> ExecutableToolResult {
    ok_result(format!(
        "{}\n\nThe wait ended before the task finished — a timeout is not an error. Call TaskWait again to keep waiting, or continue with other work; completion also arrives via automatic notification.",
        wait_metadata("timed_out", task_id, timeout_ms, waited_ms)
    ))
}

/// v2 `formatPlainObject({waitStatus, taskId, waitedMs, timeoutMs})`.
fn wait_metadata(status: &str, task_id: &str, timeout_ms: u64, waited_ms: u64) -> String {
    task_format::format_plain_object_entries(&[
        ("waitStatus", &Value::String(status.into())),
        ("taskId", &Value::String(task_id.into())),
        ("waitedMs", &Value::from(waited_ms)),
        ("timeoutMs", &Value::from(timeout_ms)),
    ])
}

/// Parse the required `task_id` argument (non-empty string).
fn parse_task_id(args: &Value, tool: &str) -> Result<String, String> {
    match args.get("task_id").and_then(|t| t.as_str()) {
        Some(task_id) if !task_id.is_empty() => Ok(task_id.to_string()),
        _ => Err(format!(
            "Invalid {tool} arguments: `task_id` must be a non-empty string."
        )),
    }
}

/// Parse the required `timeout` argument (v2 bounds: integer 1..=600).
fn parse_timeout(args: &Value) -> Result<u64, String> {
    match args.get("timeout") {
        Some(value) => match value.as_u64() {
            Some(timeout) if (1..=WAIT_FOR_MAX_TIMEOUT_S).contains(&timeout) => Ok(timeout),
            _ => Err(format!(
                "Invalid TaskWait arguments: `timeout` must be an integer between 1 and {WAIT_FOR_MAX_TIMEOUT_S}."
            )),
        },
        None => Err("Invalid TaskWait arguments: `timeout` is required.".into()),
    }
}

fn waited_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// Map a state bridge error to a tool result: an unwired host (message
/// carries the `does not support state bridge` phrase) gets the dedicated
/// failure message; a not-found task (`-32002`) gets the v2 `Task not
/// found` error; everything else passes through verbatim.
fn map_state_error(error: String, task_id: Option<&str>) -> ExecutableToolResult {
    if error.contains("does not support state bridge") {
        err_result(STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE.into())
    } else if let Some(task_id) = task_id
        && is_task_not_found(&error)
    {
        err_result(format!("Task not found: {task_id}"))
    } else {
        err_result(error)
    }
}

/// Map a wait write error: the state-bridge phrase gets the dedicated
/// failure message, a not-found task gets the v2 `Task not found` error,
/// and a timeout error renders the v2 timeout report (not an error).
fn map_wait_error(
    error: String,
    task_id: &str,
    timeout_ms: u64,
    waited_ms: u64,
) -> ExecutableToolResult {
    if error.contains("does not support state bridge") {
        err_result(STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE.into())
    } else if is_task_not_found(&error) {
        err_result(format!("Task not found: {task_id}"))
    } else {
        let lower = error.to_lowercase();
        if lower.contains("timed out") || lower.contains("timeout") {
            render_wait_timeout(task_id, timeout_ms, waited_ms)
        } else {
            err_result(error)
        }
    }
}

/// Whether a host error means the task does not exist: the `-32002` code
/// (unknown key) or a `task not found` phrase.
fn is_task_not_found(error: &str) -> bool {
    error.contains("-32002") || error.to_lowercase().contains("task not found")
}

/// Engine tool definition for TaskList, mirroring v2 `TaskListTool` and
/// `TaskListInputSchema`.
pub fn task_list_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "TaskList".into(),
        description: r#"List background tasks and their current status.

Use this tool to discover which background tasks exist and where each one
stands. It is the entry point for inspecting background work: it returns a
task ID, status, and description for every task it reports, plus the command,
PID, and (once finished) exit code for shell tasks, and a stop reason for any
task that ended early.

Guidelines:

- After a context compaction, or whenever you are unsure which background
  tasks are running or what their task IDs are, call this tool to
  re-enumerate them instead of guessing a task ID.
- Prefer the default `active_only=true`, which lists only non-terminal tasks.
  Pass `active_only=false` only when you specifically need to see tasks that
  have already finished. With `active_only=false` the result may also include
  `lost` tasks — tasks left over from a previous process that can no longer be
  inspected or controlled; treat them as already terminated.
- `limit` caps how many tasks are returned. It accepts a value between 1 and
  100 and defaults to 20 when omitted.
- This tool only lists tasks; it does not return their output. Use it first
  to locate the task ID you need, then call `TaskOutput` with that ID to read
  the task's output and details.
- This tool is read-only and does not change any state, so it is always safe
  to call, including in plan mode."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "active_only": {
                    "type": "boolean",
                    "default": true,
                    "description": "Whether to list only non-terminal background tasks."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 20,
                    "description": "Maximum number of tasks to return."
                }
            },
            "additionalProperties": false
        }),
    }
}

/// Engine tool definition for TaskOutput, mirroring v2 `TaskOutputTool`
/// and `TaskOutputInputSchema`.
pub fn task_output_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "TaskOutput".into(),
        description: r#"Retrieve a snapshot of a running or completed background task.

Use this after `Bash(run_in_background=true)`, `Agent(run_in_background=true)`, or `AskUserQuestion(background=true)` to check progress, or to read the output of a task that has already completed.

Guidelines:
- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.
- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.
- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.
- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.
- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports `status: completed` on a zero exit, or `status: failed` with its non-zero `exit_code` — judge that failure from the `exit_code`, because a plain command failure carries no `stop_reason` and no `terminal_reason`. `terminal_reason` is a categorical label emitted only when the end is not an ordinary exit: `timed_out` when the deadline aborted it, `stopped` when it was explicitly stopped, or `failed` when it errored without producing an exit code; the `stopped` and `failed` cases also carry a human-readable `stop_reason`. A task that finished on its own with a clean exit carries neither `stop_reason` nor `terminal_reason`.
- The full, never-truncated log is always available at output_path; use the `Read` tool with that path to page through it, whether or not the preview was truncated.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "The background task ID to inspect."
                }
            },
            "required": ["task_id"],
            "additionalProperties": false
        }),
    }
}

/// Engine tool definition for TaskStop, mirroring v2 `TaskStopTool` and
/// `TaskStopInputSchema`.
pub fn task_stop_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "TaskStop".into(),
        description: r#"Stop a running background task.

Only use this when a task must genuinely be cancelled — for a task that is
finishing normally, wait for its completion notification or inspect it with
`TaskOutput` instead of stopping it.

Guidelines:
- This is a general-purpose stop capability for any background task. It is not
  a bash-specific kill.
- Stopping a task is destructive: it may leave partial side effects behind.
  Use it with care.
- If the task has already finished, this tool simply returns its current
  status."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "The background task ID to stop."
                },
                "reason": {
                    "type": "string",
                    "default": "Stopped by TaskStop",
                    "description": "Short reason recorded when the task is stopped."
                }
            },
            "required": ["task_id"],
            "additionalProperties": false
        }),
    }
}

/// Engine tool definition for TaskWait, mirroring v2 `WaitForTool` and
/// `WaitForInputSchema` (with `task_id` required — the wire wait action
/// always targets one task).
pub fn task_wait_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "TaskWait".into(),
        description: r#"Wait for background tasks to finish without ending the current turn.

Use this when your next step depends on the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made.

Guidelines:

- Do not call TaskWait right after dispatching work whose result you do not need yet — finished background tasks notify you automatically. TaskWait is for the moment you genuinely cannot proceed without a result.
- `timeout` is required, in seconds, capped at 600. To wait longer, call TaskWait again; waking up periodically also lets you re-evaluate the situation.
- A timeout is not an error: the tool reports the timeout and you decide whether to wait again or do other work meanwhile; completion also arrives via automatic notification.
- With `task_id`, the wait ends when that task finishes. An unknown `task_id` is an error; a task that has already finished returns immediately.
- Waiting has no side effects on the waited tasks: TaskWait never stops a task, and interrupting the wait (for example, a user interruption) leaves every task running.
- A finished task's result is delivered exactly once: tasks reported by TaskWait do not also produce an automatic completion notification.
- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "timeout": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 600,
                    "description": "Maximum time to wait, in seconds (1-600). A timeout is not an error: call the tool again to keep waiting, or continue with other work; completion also arrives via automatic notification."
                },
                "task_id": {
                    "type": "string",
                    "description": "The background task ID to wait for."
                }
            },
            "required": ["timeout", "task_id"],
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

    fn sample_entry() -> Value {
        serde_json::json!({
            "taskId": "task-1",
            "description": "Running tests",
            "status": "running",
            "startedAt": 1700000000000u64
        })
    }

    fn sample_snapshot() -> Value {
        serde_json::json!({
            "taskId": "task-1",
            "description": "Running tests",
            "status": "completed",
            "startedAt": 1700000000000u64,
            "endedAt": 1700000001000u64,
            "outputPath": "C:/logs/task-1.log",
            "outputSizeBytes": 1024,
            "previewBytes": 512,
            "truncated": false,
            "fullOutputAvailable": true,
            "preview": "All tests passed."
        })
    }

    // ── TaskList ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_list_renders_header_and_records() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(serde_json::json!([
                sample_entry(),
                {
                    "taskId": "task-2",
                    "description": "Fetching docs",
                    "status": "completed",
                    "startedAt": 1699990000000u64,
                    "endedAt": 1699990001000u64
                }
            ])),
            write_ok(Value::Null),
        );
        let result =
            execute_task_list(&callbacks, &serde_json::json!({ "active_only": false })).await;
        assert!(!result.is_error);
        let lines: Vec<&str> = result.content.lines().collect();
        assert_eq!(lines[0], "background_tasks: 2");
        assert!(lines[1..].contains(&"task_id: task-1"));
        assert!(result.content.contains("description: Running tests"));
        assert!(result.content.contains("status: running"));
        assert!(result.content.contains("started_at: 1700000000000"));
        assert!(result.content.contains("---"));
        assert!(result.content.contains("task_id: task-2"));
        assert!(result.content.contains("ended_at: 1699990001000"));
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "task");
        assert_eq!(request.key, "task");
        assert_eq!(request.turn_id, "");
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_list_active_only_filters_terminal_entries() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!([
                sample_entry(),
                {
                    "taskId": "task-2",
                    "description": "Fetching docs",
                    "status": "completed",
                    "startedAt": 1699990000000u64
                },
                {
                    "taskId": "task-3",
                    "description": "Lost process",
                    "status": "lost",
                    "startedAt": 1699980000000u64
                }
            ])),
            write_ok(Value::Null),
        );
        let result = execute_task_list(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        let lines: Vec<&str> = result.content.lines().collect();
        assert_eq!(lines[0], "active_background_tasks: 1");
        assert!(result.content.contains("task_id: task-1"));
        assert!(!result.content.contains("task-2"));
        assert!(!result.content.contains("task-3"));
    }

    #[test]
    fn test_render_task_entry_maps_contract_id_to_task_id() {
        // The contract shape uses `id`; the host shape uses `taskId`.
        let rendered = render_task_entry(&serde_json::json!({
            "id": "task-9",
            "description": "Contract shape",
            "status": "running"
        }));
        assert!(rendered.contains("task_id: task-9"));
        assert!(rendered.contains("description: Contract shape"));
        let rendered = render_task_entry(&serde_json::json!({
            "taskId": "task-8",
            "description": "Host shape",
            "status": "running"
        }));
        assert!(rendered.contains("task_id: task-8"));
    }

    #[tokio::test]
    async fn test_list_empty_renders_empty_message() {
        let (callbacks, _, _) = scripted(read_ok(serde_json::json!([])), write_ok(Value::Null));
        let result = execute_task_list(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "active_background_tasks: 0\nNo background tasks found."
        );
    }

    #[tokio::test]
    async fn test_list_active_only_false_uses_all_label() {
        let (callbacks, _, _) = scripted(read_ok(serde_json::json!([])), write_ok(Value::Null));
        let result =
            execute_task_list(&callbacks, &serde_json::json!({ "active_only": false })).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "background_tasks: 0\nNo background tasks found."
        );
    }

    #[tokio::test]
    async fn test_list_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [
            serde_json::json!({ "active_only": "yes" }),
            serde_json::json!({ "limit": 0 }),
            serde_json::json!({ "limit": 101 }),
            serde_json::json!({ "limit": "many" }),
        ] {
            let result = execute_task_list(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid TaskList arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_list_invalid_wire_shape_returns_error() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({ "tasks": [] })),
            write_ok(Value::Null),
        );
        let result = execute_task_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid task state from host"));
    }

    #[tokio::test]
    async fn test_list_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            Err("host does not support state bridge".into()),
            write_ok(Value::Null),
        );
        let result = execute_task_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_list_other_host_error_passes_through() {
        let (callbacks, _, _) = scripted(
            Err("State read error: [-32001] unknown domain: task".into()),
            write_ok(Value::Null),
        );
        let result = execute_task_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("-32001"));
        assert!(result.content.contains("unknown domain"));
    }

    #[tokio::test]
    async fn test_list_turn_and_tool_call_ids_are_forwarded() {
        let (callbacks, read_received, _) =
            scripted(read_ok(serde_json::json!([])), write_ok(Value::Null));
        let result = execute_task_list(
            &callbacks,
            &serde_json::json!({ "turn_id": "turn-42", "tool_call_id": "call_abc" }),
        )
        .await;
        assert!(!result.is_error);
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.turn_id, "turn-42");
        assert_eq!(request.tool_call_id, "call_abc");
    }

    // ── TaskOutput ────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_output_reads_task_key_and_renders() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(sample_snapshot()), write_ok(Value::Null));
        let result =
            execute_task_output(&callbacks, &serde_json::json!({ "task_id": "task-1" })).await;
        assert!(!result.is_error);
        assert!(result.content.contains("task_id: task-1"));
        assert!(result.content.contains("status: completed"));
        assert!(result.content.contains("output_path: C:/logs/task-1.log"));
        assert!(result.content.contains("full_output_available: true"));
        assert!(result.content.contains("[output]"));
        assert!(result.content.contains("All tests passed."));
        // The preview is not duplicated in the metadata lines.
        let metadata = result.content.split("[output]").next().unwrap();
        assert!(!metadata.contains("output:"));
        assert!(!metadata.contains("preview:"));
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "task");
        assert_eq!(request.key, "task-1");
        assert!(write_received.lock().unwrap().is_none());
    }

    #[test]
    fn test_output_truncated_note_variants() {
        let mut snapshot = sample_snapshot();
        snapshot["truncated"] = serde_json::json!(true);
        let rendered = render_task_output(&snapshot);
        assert!(!rendered.is_error);
        assert!(
            rendered
                .content
                .contains("[Truncated. Full output: C:/logs/task-1.log]")
        );

        snapshot["fullOutputAvailable"] = serde_json::json!(false);
        let rendered = render_task_output(&snapshot);
        assert!(
            rendered
                .content
                .contains("[Truncated. No persisted full log is available for this task.]")
        );

        snapshot["outputPath"] = Value::Null;
        let rendered = render_task_output(&snapshot);
        assert!(
            rendered
                .content
                .contains("[Truncated. No persisted full log is available for this task.]")
        );
    }

    #[test]
    fn test_output_truncated_contract_field_fallback() {
        // The contract shape uses `outputTruncated` / `output`.
        let mut snapshot = sample_snapshot();
        snapshot.as_object_mut().unwrap().remove("truncated");
        snapshot.as_object_mut().unwrap().remove("preview");
        snapshot["outputTruncated"] = serde_json::json!(true);
        snapshot["output"] = serde_json::json!("partial output");
        let rendered = render_task_output(&snapshot);
        assert!(
            rendered
                .content
                .contains("[Truncated. Full output: C:/logs/task-1.log]")
        );
        assert!(rendered.content.contains("[output]\npartial output"));
    }

    #[test]
    fn test_output_no_preview_renders_placeholder() {
        let mut snapshot = sample_snapshot();
        snapshot["preview"] = Value::Null;
        let rendered = render_task_output(&snapshot);
        assert!(rendered.content.contains("[output]\n[no output available]"));
    }

    #[tokio::test]
    async fn test_output_not_found_maps_to_task_not_found() {
        let (callbacks, _, _) = scripted(
            Err("State read error: [-32002] unknown key: task-9".into()),
            write_ok(Value::Null),
        );
        let result =
            execute_task_output(&callbacks, &serde_json::json!({ "task_id": "task-9" })).await;
        assert!(result.is_error);
        assert_eq!(result.content, "Task not found: task-9");
    }

    #[tokio::test]
    async fn test_output_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [serde_json::json!({}), serde_json::json!({ "task_id": "" })] {
            let result = execute_task_output(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid TaskOutput arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_output_invalid_wire_shape_returns_error() {
        let (callbacks, _, _) = scripted(read_ok(serde_json::json!("nope")), write_ok(Value::Null));
        let result =
            execute_task_output(&callbacks, &serde_json::json!({ "task_id": "task-1" })).await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid task state from host"));
    }

    #[tokio::test]
    async fn test_output_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            Err("host does not support state bridge".into()),
            write_ok(Value::Null),
        );
        let result =
            execute_task_output(&callbacks, &serde_json::json!({ "task_id": "task-1" })).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    // ── TaskStop ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_stop_sends_action_and_renders() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!({
                "taskId": "task-1",
                "status": "killed",
                "stopReason": "Stopped by TaskStop"
            })),
        );
        let result =
            execute_task_stop(&callbacks, &serde_json::json!({ "task_id": "task-1" })).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "task_id: task-1\nstatus: killed\nreason: Stopped by TaskStop"
        );
        assert!(read_received.lock().unwrap().is_none());
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "task");
        assert_eq!(request.key, "task");
        assert!(!request.undoable);
        assert_eq!(request.value["action"], "stop");
        assert_eq!(request.value["id"], "task-1");
    }

    #[test]
    fn test_stop_render_falls_back_to_requested_id_and_reason() {
        let rendered = render_task_stop(
            &serde_json::json!({ "status": "killed" }),
            "task-1",
            "Stopped by TaskStop",
        );
        assert!(!rendered.is_error);
        assert_eq!(
            rendered.content,
            "task_id: task-1\nstatus: killed\nreason: Stopped by TaskStop"
        );
        // The wire's `id` and `reason` keys are honored too.
        let rendered = render_task_stop(
            &serde_json::json!({ "id": "task-2", "status": "completed", "reason": "done" }),
            "task-1",
            "Stopped by TaskStop",
        );
        assert_eq!(
            rendered.content,
            "task_id: task-2\nstatus: completed\nreason: done"
        );
    }

    #[tokio::test]
    async fn test_stop_custom_reason_is_trimmed_for_fallback() {
        let (callbacks, _, write_received) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!({ "taskId": "task-1", "status": "killed" })),
        );
        let result = execute_task_stop(
            &callbacks,
            &serde_json::json!({ "task_id": "task-1", "reason": "  user asked  " }),
        )
        .await;
        assert!(!result.is_error);
        assert!(result.content.contains("reason: user asked"));
        // The wire action carries only the id.
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.value["action"], "stop");
        assert!(request.value.get("reason").is_none());
    }

    #[tokio::test]
    async fn test_stop_not_found_maps_to_task_not_found() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32002] task not found: task-9".into()),
        );
        let result =
            execute_task_stop(&callbacks, &serde_json::json!({ "task_id": "task-9" })).await;
        assert!(result.is_error);
        assert_eq!(result.content, "Task not found: task-9");
    }

    #[tokio::test]
    async fn test_stop_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [serde_json::json!({}), serde_json::json!({ "task_id": 42 })] {
            let result = execute_task_stop(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid TaskStop arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_stop_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32603] host does not support state bridge".into()),
        );
        let result =
            execute_task_stop(&callbacks, &serde_json::json!({ "task_id": "task-1" })).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    // ── TaskWait ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_wait_sends_action_and_renders_completed() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(Value::Null), write_ok(sample_snapshot()));
        let result = execute_task_wait(
            &callbacks,
            &serde_json::json!({ "task_id": "task-1", "timeout": 30 }),
        )
        .await;
        assert!(!result.is_error);
        let lines: Vec<&str> = result.content.lines().collect();
        assert_eq!(lines[0], "wait_status: completed");
        assert_eq!(lines[1], "task_id: task-1");
        assert!(lines[2].starts_with("waited_ms: "));
        assert_eq!(lines[3], "timeout_ms: 30000");
        assert!(lines.contains(&"[finished]"));
        assert!(result.content.contains("status: completed"));
        assert!(result.content.contains("[output]"));
        assert!(result.content.contains("All tests passed."));
        assert!(read_received.lock().unwrap().is_none());
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "task");
        assert_eq!(request.key, "task");
        assert!(!request.undoable);
        assert_eq!(request.value["action"], "wait");
        assert_eq!(request.value["id"], "task-1");
        assert_eq!(request.value["timeout_ms"], 30000);
    }

    #[test]
    fn test_wait_completed_render_golden() {
        let rendered = render_task_wait(&sample_snapshot(), "task-1", 30000, 1234);
        assert!(!rendered.is_error);
        assert_eq!(
            rendered.content,
            "wait_status: completed\n\
             task_id: task-1\n\
             waited_ms: 1234\n\
             timeout_ms: 30000\n\
             \n\
             [finished]\n\
             description: Running tests\n\
             ended_at: 1700000001000\n\
             full_output_available: true\n\
             output_path: C:/logs/task-1.log\n\
             output_size_bytes: 1024\n\
             preview_bytes: 512\n\
             started_at: 1700000000000\n\
             status: completed\n\
             task_id: task-1\n\
             truncated: false\n\
             \n\
             [output]\n\
             All tests passed."
        );
    }

    #[test]
    fn test_wait_entry_only_response_skips_output_section() {
        // The host's wait response is the task entry (no preview): the
        // completed report has no `[output]` section.
        let entry = serde_json::json!({
            "taskId": "task-1",
            "description": "Running tests",
            "status": "completed",
            "startedAt": 1700000000000u64,
            "endedAt": 1700000001000u64
        });
        let rendered = render_task_wait(&entry, "task-1", 30000, 1234);
        assert!(!rendered.is_error);
        assert_eq!(
            rendered.content,
            "wait_status: completed\n\
             task_id: task-1\n\
             waited_ms: 1234\n\
             timeout_ms: 30000\n\
             \n\
             [finished]\n\
             description: Running tests\n\
             ended_at: 1700000001000\n\
             started_at: 1700000000000\n\
             status: completed\n\
             task_id: task-1"
        );
        assert!(!rendered.content.contains("[output]"));
    }

    #[test]
    fn test_wait_non_terminal_status_renders_timeout() {
        let mut snapshot = sample_snapshot();
        snapshot["status"] = serde_json::json!("running");
        let rendered = render_task_wait(&snapshot, "task-1", 30000, 30000);
        assert!(!rendered.is_error);
        assert_eq!(
            rendered.content,
            "wait_status: timed_out\n\
             task_id: task-1\n\
             waited_ms: 30000\n\
             timeout_ms: 30000\n\
             \n\
             The wait ended before the task finished — a timeout is not an error. Call TaskWait again to keep waiting, or continue with other work; completion also arrives via automatic notification."
        );
    }

    #[tokio::test]
    async fn test_wait_timeout_error_renders_timeout_report() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32003] wait timed out after 30000ms".into()),
        );
        let result = execute_task_wait(
            &callbacks,
            &serde_json::json!({ "task_id": "task-1", "timeout": 30 }),
        )
        .await;
        assert!(!result.is_error);
        assert!(result.content.starts_with("wait_status: timed_out\n"));
        assert!(result.content.contains("a timeout is not an error"));
    }

    #[tokio::test]
    async fn test_wait_not_found_maps_to_task_not_found() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32002] task not found: task-9".into()),
        );
        let result = execute_task_wait(
            &callbacks,
            &serde_json::json!({ "task_id": "task-9", "timeout": 30 }),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, "Task not found: task-9");
    }

    #[tokio::test]
    async fn test_wait_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [
            serde_json::json!({ "timeout": 30 }),
            serde_json::json!({ "task_id": "task-1" }),
            serde_json::json!({ "task_id": "task-1", "timeout": 0 }),
            serde_json::json!({ "task_id": "task-1", "timeout": 601 }),
            serde_json::json!({ "task_id": "task-1", "timeout": "30" }),
        ] {
            let result = execute_task_wait(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid TaskWait arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_wait_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32603] host does not support state bridge".into()),
        );
        let result = execute_task_wait(
            &callbacks,
            &serde_json::json!({ "task_id": "task-1", "timeout": 30 }),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_wait_other_host_error_passes_through() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32603] something else broke".into()),
        );
        let result = execute_task_wait(
            &callbacks,
            &serde_json::json!({ "task_id": "task-1", "timeout": 30 }),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("something else broke"));
    }

    // ── Tool defs ─────────────────────────────────────────────────────

    #[test]
    fn test_task_list_tool_def_matches_v2_schema() {
        let def = task_list_tool_def();
        assert_eq!(def.name, "TaskList");
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["additionalProperties"], false);
        assert_eq!(
            def.input_schema["properties"]["active_only"]["default"],
            true
        );
        assert_eq!(def.input_schema["properties"]["limit"]["maximum"], 100);
        assert!(def.description.contains("List background tasks"));
        assert!(def.description.contains("`TaskOutput`"));
    }

    #[test]
    fn test_task_output_tool_def_matches_v2_schema() {
        let def = task_output_tool_def();
        assert_eq!(def.name, "TaskOutput");
        assert_eq!(def.input_schema["required"][0], "task_id");
        assert!(def.description.contains("Retrieve a snapshot"));
    }

    #[test]
    fn test_task_stop_tool_def_matches_v2_schema() {
        let def = task_stop_tool_def();
        assert_eq!(def.name, "TaskStop");
        assert_eq!(def.input_schema["required"][0], "task_id");
        assert_eq!(
            def.input_schema["properties"]["reason"]["default"],
            "Stopped by TaskStop"
        );
        assert!(def.description.contains("Stop a running background task"));
    }

    #[test]
    fn test_task_wait_tool_def_matches_v2_schema() {
        let def = task_wait_tool_def();
        assert_eq!(def.name, "TaskWait");
        assert_eq!(def.input_schema["required"][0], "timeout");
        assert_eq!(def.input_schema["required"][1], "task_id");
        assert_eq!(def.input_schema["properties"]["timeout"]["maximum"], 600);
        assert!(def.description.contains("Wait for background tasks"));
    }
}
