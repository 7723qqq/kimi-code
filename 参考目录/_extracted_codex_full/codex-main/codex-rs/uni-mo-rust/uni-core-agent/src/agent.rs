//! Core agent turn processing loop.
//!
//! Implements the fundamental turn lifecycle for AI agents:
//! 1.  Drain pending user input and record into conversation history.
//! 2.  Run pre-sampling compaction if the token budget is exhausted.
//! 3.  Build tool definitions and the model prompt from conversation history.
//! 4.  Issue a sampling request (model invocation) and process the response.
//! 5.  Execute any requested tool calls inline and feed results back to the model.
//! 6.  Repeat (4)-(5) until the model emits a terminal assistant message.
//!
//! While the model may return multiple items in a single sampling request, in
//! practice we generally see one item per request:
//!
//! - If the model requests a function call, we execute it and send the output
//!   back to the model in the next sampling request.
//! - If the model sends only an assistant message, we record it in the
//!   conversation history and consider the turn complete.

use crate::compact;
use crate::sampling;
use crate::types::{
    AgentError, AgentEvent, AgentResult, AgentSession, AutoCompactTokenLimitScope,
    CompactionPhase, CompactionReason, InitialContextInjection, PreviousTurnSettings,
    Prompt, ResponseItem, SamplingRequestResult, TurnContext, TurnInput, UserInputItem,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, instrument, trace, trace_span, warn};

/// Main turn processing loop.
///
/// Takes initial turn input and runs a loop where, at each sampling request,
/// the model replies with either requested function calls or an assistant
/// message. Tool calls are executed inline and their results fed back to the
/// model until the turn concludes with a terminal assistant message.
///
/// Returns the text of the last assistant message produced by the model,
/// or `None` if the turn was aborted or ended in error.
#[instrument(level = "trace", skip_all, fields(turn_id = %turn_context.sub_id))]
pub async fn run_turn(
    sess: Arc<dyn AgentSession>,
    turn_context: Arc<TurnContext>,
    input: Vec<TurnInput>,
    cancellation_token: CancellationToken,
) -> Option<String> {
    // Pre-sampling compaction
    if let Err(err) = compact::run_pre_sampling_compact(&sess, &turn_context).await {
        let event = AgentEvent::Error {
            message: format!("Pre-sampling compact failed: {err}"),
        };
        sess.emit_event(&turn_context, event).await;
        sess.record_turn_error(&turn_context, &err).await;
        error!("Failed to run pre-sampling compact");
        return None;
    }

    // Record context updates and user input
    if run_hooks_and_record_inputs(&sess, &turn_context, &input).await {
        return None;
    }

    let previous_settings = Some(PreviousTurnSettings {
        model: turn_context.model_info.slug.clone(),
        comp_hash: turn_context.comp_hash.clone(),
        realtime_active: Some(turn_context.realtime_active),
    });
    sess.set_previous_turn_settings(previous_settings).await;

    // Main sampling loop
    let mut last_agent_message: Option<String> = None;
    let mut can_drain_pending_input = input.is_empty();

    loop {
        // Drain pending input (e.g. user messages submitted via UI while the
        // model was running). Deferred at turn start so fresh input is sampled
        // first, and after auto-compact so tool continuation resumes first.
        let pending_input = if can_drain_pending_input {
            sess.get_pending_input().await
        } else {
            Vec::new()
        };

        if run_hooks_and_record_inputs(&sess, &turn_context, &pending_input).await {
            break;
        }

        // Build the prompt from current conversation history.
        let sampling_request_input: Vec<ResponseItem> = async {
            sess.clone_history_for_prompt(&turn_context.model_info.input_modalities)
                .await
        }
        .instrument(trace_span!("run_turn.prepare_sampling_request_input"))
        .await;

        let tokens_before_sampling = sess.get_total_token_usage().await;

        match run_sampling_request(
            sess.clone(),
            turn_context.clone(),
            &mut last_agent_message,
            sampling_request_input.clone(),
            cancellation_token.child_token(),
        )
        .await
        {
            Ok(sampling_request_output) => {
                can_drain_pending_input = true;

                let (has_pending_input, token_status) = async {
                    let has_pending_input = sess.has_pending_input().await;
                    let token_status =
                        compact::auto_compact_token_status(&sess, &turn_context).await;
                    (has_pending_input, token_status)
                }
                .instrument(trace_span!("run_turn.collect_post_sampling_state"))
                .await;

                let needs_follow_up =
                    sampling_request_output.needs_follow_up || has_pending_input;
                let token_limit_reached = token_status.token_limit_reached;

                trace!(
                    turn_id = %turn_context.sub_id,
                    total_usage_tokens = token_status.active_context_tokens,
                    auto_compact_scope_tokens = token_status.auto_compact_scope_tokens,
                    auto_compact_scope_limit = token_status.auto_compact_scope_limit,
                    full_context_window_limit = ?token_status.full_context_window_limit,
                    token_limit_reached,
                    needs_follow_up,
                    has_pending_input,
                    "post sampling token usage"
                );

                let tokens_after_sampling = token_status.active_context_tokens;
                trace!(
                    turn_id = %turn_context.sub_id,
                    tokens_before = tokens_before_sampling,
                    tokens_after = tokens_after_sampling,
                    delta = tokens_after_sampling - tokens_before_sampling,
                    "token budget delta after sampling"
                );

                // If token limit is reached and the model needs follow-up,
                // compact before continuing.
                if needs_follow_up && token_limit_reached {
                    if let Err(err) = sess
                        .run_auto_compact(
                            &turn_context,
                            InitialContextInjection::BeforeLastUserMessage,
                            CompactionReason::ContextLimit,
                            CompactionPhase::MidTurn,
                        )
                        .await
                    {
                        let event = AgentEvent::Error {
                            message: format!("Mid-turn compaction failed: {err}"),
                        };
                        sess.emit_event(&turn_context, event).await;
                        sess.record_turn_error(&turn_context, &err).await;
                        return None;
                    }
                    can_drain_pending_input =
                        !sampling_request_output.needs_follow_up;
                    continue;
                }

                if !needs_follow_up {
                    last_agent_message = sampling_request_output.last_agent_message;
                    break;
                }
                // Otherwise: model needs follow-up (e.g. tool call), loop again.
                continue;
            }
            Err(AgentError::TurnAborted) => {
                // Aborted turn is reported via a different event path.
                break;
            }
            Err(AgentError::InvalidImage) => {
                warn!("Invalid image detected in model input");
                sess.record_turn_error(&turn_context, &AgentError::InvalidImage)
                    .await;
                sess.emit_event(
                    &turn_context,
                    AgentEvent::Error {
                        message: "Invalid image in your last message. \
                                  Please remove it and try again."
                            .to_string(),
                    },
                )
                .await;
                break;
            }
            Err(e) => {
                info!("Turn error: {e:#}");
                sess.record_turn_error(&turn_context, &e).await;
                let event = AgentEvent::Error {
                    message: format!("{e}"),
                };
                sess.emit_event(&turn_context, event).await;
                // Let the user continue the conversation.
                break;
            }
        }
    }

    last_agent_message
}

/// Processes pending input items: records accepted user input into
/// conversation history. Returns `true` if all input was blocked (i.e. no
/// input accepted).
#[instrument(level = "trace", skip_all)]
async fn run_hooks_and_record_inputs(
    sess: &Arc<dyn AgentSession>,
    turn_context: &Arc<TurnContext>,
    input: &[TurnInput],
) -> bool {
    let mut accepted_user_input = false;

    for input_item in input {
        match input_item {
            TurnInput::UserInput { content, .. }
                if !is_input_empty(content) =>
            {
                accepted_user_input = true;
                let msg = ResponseItem::Message {
                    role: "user".to_string(),
                    content: user_input_items_to_content(content),
                    phase: None,
                };
                sess.record_conversation_items(turn_context, &[msg]).await;
            }
            TurnInput::ResponseItem(item) => {
                sess.record_conversation_items(turn_context, &[item.clone()])
                    .await;
            }
            _ => {}
        }
    }

    !accepted_user_input && !input.is_empty()
}

fn is_input_empty(content: &[UserInputItem]) -> bool {
    content.iter().all(|item| match item {
        UserInputItem::Text { text } => text.trim().is_empty(),
        UserInputItem::Image { .. } | UserInputItem::LocalImage { .. } => false,
    })
}

fn user_input_items_to_content(
    items: &[UserInputItem],
) -> Vec<crate::types::ContentItem> {
    items
        .iter()
        .map(|item| match item {
            UserInputItem::Text { text } => crate::types::ContentItem::InputText {
                text: text.clone(),
            },
            UserInputItem::Image { url } => crate::types::ContentItem::Image {
                url: Some(url.clone()),
            },
            UserInputItem::LocalImage { path } => {
                crate::types::ContentItem::LocalImage {
                    path: path.clone(),
                }
            }
        })
        .collect()
}

/// Builds a `Prompt` from the given input items and tool definitions.
pub(crate) fn build_prompt(
    input: Vec<ResponseItem>,
    tools: Vec<crate::types::ToolSpec>,
    turn_context: &TurnContext,
    base_instructions: crate::types::BaseInstructions,
) -> Prompt {
    Prompt {
        input,
        tools,
        parallel_tool_calls: turn_context.model_info.supports_parallel_tool_calls,
        base_instructions,
        personality: None,
        output_schema: None,
        output_schema_strict: false,
    }
}

/// Executes a single sampling request with retry logic.
///
/// Wraps `try_run_sampling_request` with retry handling for transient errors.
/// On success returns the `SamplingRequestResult` indicating whether follow-up
/// is needed (e.g. for tool calls).
#[allow(clippy::too_many_arguments)]
#[instrument(
    level = "trace",
    skip_all,
    fields(
        turn_id = %turn_context.sub_id,
        model = %turn_context.model_info.slug,
    )
)]
async fn run_sampling_request(
    sess: Arc<dyn AgentSession>,
    turn_context: Arc<TurnContext>,
    last_agent_message: &mut Option<String>,
    input: Vec<ResponseItem>,
    cancellation_token: CancellationToken,
) -> AgentResult<SamplingRequestResult> {
    let tools = sess.build_tools(&turn_context).await?;
    let base_instructions = sess.get_base_instructions().await;

    // Default retry budget for transient HTTP/network errors. In the full
    // codex-rs source this is read from the provider configuration.
    const MAX_RETRIES: u32 = 3;
    let mut retries: u32 = 0;
    let mut initial_input = Some(input);

    loop {
        let prompt_input = if let Some(input) = initial_input.take() {
            input
        } else {
            sess.clone_history_for_prompt(
                &turn_context.model_info.input_modalities,
            )
            .await
        };

        let prompt = build_prompt(
            prompt_input,
            tools.model_visible_specs(),
            &turn_context,
            base_instructions.clone(),
        );

        let err = match sampling::try_run_sampling_request(
            sess.clone(),
            turn_context.clone(),
            last_agent_message,
            &prompt,
            cancellation_token.child_token(),
        )
        .await
        {
            Ok(output) => return Ok(output),
            Err(AgentError::ContextWindowExceeded) => {
                sess.set_total_tokens_full(&turn_context).await;
                return Err(AgentError::ContextWindowExceeded);
            }
            Err(AgentError::UsageLimitReached(_)) => {
                return Err(AgentError::UsageLimitReached("rate limit".into()));
            }
            Err(err) => err,
        };

        if !err.is_retryable() {
            return Err(err);
        }

        sess.handle_retryable_stream_error(err, &mut retries, MAX_RETRIES)
            .await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn test_is_input_empty_all_empty_text() {
        let content = vec![
            UserInputItem::Text {
                text: "  ".to_string(),
            },
            UserInputItem::Text {
                text: String::new(),
            },
        ];
        assert!(is_input_empty(&content));
    }

    #[test]
    fn test_is_input_empty_has_non_empty_text() {
        let content = vec![UserInputItem::Text {
            text: "  hello  ".to_string(),
        }];
        assert!(!is_input_empty(&content));
    }

    #[test]
    fn test_is_input_empty_has_image() {
        let content = vec![
            UserInputItem::Text {
                text: String::new(),
            },
            UserInputItem::Image {
                url: "https://example.com/img.png".to_string(),
            },
        ];
        assert!(!is_input_empty(&content));
    }

    #[test]
    fn test_is_input_empty_has_local_image() {
        let content = vec![UserInputItem::LocalImage {
            path: "/tmp/photo.jpg".to_string(),
        }];
        assert!(!is_input_empty(&content));
    }

    #[test]
    fn test_user_input_items_to_content_text() {
        let items = vec![UserInputItem::Text {
            text: "hello world".to_string(),
        }];
        let result = user_input_items_to_content(&items);
        assert_eq!(result.len(), 1);
        match &result[0] {
            crate::types::ContentItem::InputText { text } => {
                assert_eq!(text, "hello world");
            }
            _ => panic!("expected InputText"),
        }
    }

    #[test]
    fn test_build_prompt_basic() {
        let ctx = TurnContext {
            sub_id: "turn-1".into(),
            model_info: crate::types::ModelInfo {
                slug: "test-model".into(),
                provider: "test".into(),
                context_window: None,
                effective_context_window_percent: 100,
                supports_parallel_tool_calls: true,
                input_modalities: vec!["text".into()],
                supports_reasoning_summaries: false,
                default_reasoning_effort: None,
            },
            comp_hash: None,
            cwd: PathBuf::from("/tmp"),
            apps_enabled: false,
            plan_mode: false,
            realtime_active: false,
            auto_compact_token_limit_scope: AutoCompactTokenLimitScope::Total,
            auto_compact_token_limit: None,
            auto_compact_scope_limit: i64::MAX,
            current_date: None,
            timezone: None,
            cancellation_token: CancellationToken::new(),
            server_model_warning_emitted: AtomicBool::new(false),
            model_verification_emitted: AtomicBool::new(false),
        };

        let tools = Vec::new();
        let base = crate::types::BaseInstructions {
            text: "Be helpful.".into(),
        };
        let prompt = build_prompt(Vec::new(), tools, &ctx, base);

        assert!(prompt.input.is_empty());
        assert!(prompt.parallel_tool_calls);
        assert_eq!(prompt.base_instructions.text, "Be helpful.");
        assert!(prompt.output_schema.is_none());
    }

    #[test]
    fn test_build_prompt_with_tools() {
        let ctx = TurnContext {
            sub_id: "turn-2".into(),
            model_info: crate::types::ModelInfo {
                slug: "test-model".into(),
                provider: "test".into(),
                context_window: None,
                effective_context_window_percent: 100,
                supports_parallel_tool_calls: false,
                input_modalities: vec!["text".into()],
                supports_reasoning_summaries: false,
                default_reasoning_effort: None,
            },
            comp_hash: None,
            cwd: PathBuf::from("/tmp"),
            apps_enabled: false,
            plan_mode: false,
            realtime_active: false,
            auto_compact_token_limit_scope: AutoCompactTokenLimitScope::Total,
            auto_compact_token_limit: None,
            auto_compact_scope_limit: i64::MAX,
            current_date: None,
            timezone: None,
            cancellation_token: CancellationToken::new(),
            server_model_warning_emitted: AtomicBool::new(false),
            model_verification_emitted: AtomicBool::new(false),
        };

        let tools = vec![crate::types::ToolSpec {
            name: "search".into(),
            description: "search the web".into(),
            parameters: None,
        }];
        let base = crate::types::BaseInstructions {
            text: "You are a helpful assistant.".into(),
        };

        let input = vec![ResponseItem::Message {
            role: "user".into(),
            content: vec![crate::types::ContentItem::InputText {
                text: "hello".into(),
            }],
            phase: None,
        }];

        let prompt = build_prompt(input.clone(), tools, &ctx, base);

        assert_eq!(prompt.input.len(), 1);
        assert!(!prompt.parallel_tool_calls);
        assert_eq!(prompt.tools.len(), 1);
        assert_eq!(prompt.tools[0].name, "search");
    }
}
