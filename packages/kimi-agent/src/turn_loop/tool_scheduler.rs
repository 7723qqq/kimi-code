/// Tool scheduling — parallel and serial execution of tool calls.
///
/// Corresponds to `packages/agent-core/src/loop/tool-scheduler.ts`.

use crate::turn_loop::types::ToolCall;

/// Schedule tool calls for execution.
///
/// Currently, all tool calls are executed in parallel (default behavior).
pub fn schedule_tool_calls(tool_calls: &[ToolCall]) -> Vec<Vec<ToolCall>> {
    if tool_calls.is_empty() {
        vec![]
    } else {
        vec![tool_calls.to_vec()]
    }
}