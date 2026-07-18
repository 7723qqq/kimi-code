/// The main `run_turn` function — the stateless turn loop.
///
/// This is the Rust equivalent of `packages/agent-core/src/loop/run-turn.ts`.

use super::types::*;
use crate::rpc::types::TokenUsage;

/// Run a single turn with the given input.
///
/// The turn loop:
/// 1. Calls before_step hook (if present)
/// 2. Calls LLM.chat() to get a response
/// 3. If the LLM returned tool calls, executes them
/// 4. Calls after_step hook (if present)
/// 5. Repeats until stop condition or max_steps
pub fn run_turn(input: RunTurnInput<'_>) -> Result<TurnResult, Box<dyn std::error::Error>> {
    let turn_id = input.turn_id.clone();
    let max_steps = input.max_steps.max(1);

    let mut total_usage = TokenUsage::default();
    let mut steps: u32 = 0;

    for step_num in 0..max_steps {
        steps = step_num + 1;

        // Check hooks: before_step
        if let Some(ref hooks) = input.hooks {
            if let Some(ref before_step) = hooks.before_step {
                let ctx = StepContext {
                    turn_id: turn_id.clone(),
                    step: step_num,
                };
                match before_step(&ctx)? {
                    Some(BeforeStepResult::StopTurn(reason)) => {
                        return Ok(TurnResult {
                            stop_reason: reason,
                            steps,
                            usage: total_usage,
                        });
                    }
                    Some(BeforeStepResult::Continue) | None => {}
                }
            }
        }

        // Execute a single step
        let step_result = super::turn_step::execute_loop_step(
            &turn_id,
            step_num,
            input.llm,
            &input.messages,
            input.tools,
        )?;

        // Accumulate usage
        total_usage.input_tokens += step_result.usage.input_tokens;
        total_usage.output_tokens += step_result.usage.output_tokens;
        total_usage.total_tokens += step_result.usage.total_tokens;

        // Check hooks: after_step
        if let Some(ref hooks) = input.hooks {
            if let Some(ref after_step) = hooks.after_step {
                let ctx = AfterStepContext {
                    turn_id: turn_id.clone(),
                    step: step_num,
                    tool_results: vec![],
                };
                match after_step(&ctx)? {
                    Some(AfterStepResult::StopTurn(reason)) => {
                        return Ok(TurnResult {
                            stop_reason: reason,
                            steps,
                            usage: total_usage,
                        });
                    }
                    Some(AfterStepResult::Continue) | None => {}
                }
            }
        }

        // Determine if we should continue based on stop reason
        match step_result.stop_reason {
            LoopStepStopReason::Complete => {
                return Ok(TurnResult {
                    stop_reason: LoopTurnStopReason::EndTurn,
                    steps,
                    usage: total_usage,
                });
            }
            LoopStepStopReason::ToolCalls(tool_calls) => {
                super::tool_call::execute_tool_calls(
                    &turn_id,
                    step_num,
                    &tool_calls,
                    input.tools,
                )?;
            }
            LoopStepStopReason::Aborted => {
                return Ok(TurnResult {
                    stop_reason: LoopTurnStopReason::Aborted,
                    steps,
                    usage: total_usage,
                });
            }
            LoopStepStopReason::Error(_msg) => {
                continue;
            }
        }
    }

    Ok(TurnResult {
        stop_reason: LoopTurnStopReason::EndTurn,
        steps,
        usage: total_usage,
    })
}