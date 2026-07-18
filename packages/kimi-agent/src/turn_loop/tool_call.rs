/// Tool call execution within a step.

use super::types::*;

/// Execute a batch of tool calls from the LLM.
pub fn execute_tool_calls(
    _turn_id: &str,
    _step: u32,
    tool_calls: &[super::types::ToolCall],
    _tools: &[&dyn ExecutableTool],
) -> Result<(), Box<dyn std::error::Error>> {
    for tc in tool_calls {
        let tool = _tools.iter().find(|t| t.name() == tc.name);
        match tool {
            Some(tool) => {
                let result = tool.resolve_execution(tc.arguments.clone())?;
                match result {
                    ToolExecution::Runnable(_exec) => {
                        // Tool resolved, execution deferred to Step 4
                    }
                    ToolExecution::Error(err) => {
                        eprintln!("Tool {} error: {}", tc.name, err.message);
                    }
                }
            }
            None => {
                eprintln!("Tool {} not found", tc.name);
            }
        }
    }
    Ok(())
}