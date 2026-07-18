/// Single step execution within a turn.

use super::types::*;
use crate::rpc::types::TokenUsage;

/// Execute a single LLM step: call the LLM, return the result.
pub fn execute_loop_step(
    _turn_id: &str,
    _step: u32,
    llm: &dyn LLM,
    _messages: &[LLMMessage],
    _tools: &[&dyn ExecutableTool],
) -> Result<StepResult, Box<dyn std::error::Error>> {
    let mut messages = vec![LLMMessage {
        role: "system".into(),
        content: llm.system_prompt().to_string(),
    }];
    messages.extend_from_slice(_messages);

    let tools: Vec<ToolInfo> = _tools
        .iter()
        .map(|t| ToolInfo {
            name: t.name().to_string(),
            description: t.description().to_string(),
            input_schema: serde_json::Value::Object(Default::default()),
        })
        .collect();

    let params = LLMChatParams { messages, tools };

    match llm.chat(params) {
        Ok(response) => {
            let usage = response.usage.clone();

            if response.tool_calls.is_empty() {
                Ok(StepResult {
                    usage,
                    stop_reason: LoopStepStopReason::Complete,
                })
            } else {
                Ok(StepResult {
                    usage,
                    stop_reason: LoopStepStopReason::ToolCalls(response.tool_calls),
                })
            }
        }
        Err(e) => {
            let msg = format!("{e}");
            Ok(StepResult {
                usage: TokenUsage::default(),
                stop_reason: LoopStepStopReason::Error(msg),
            })
        }
    }
}