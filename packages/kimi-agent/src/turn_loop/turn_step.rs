//! Single step execution within a turn.

use std::time::Duration;

use super::retry::RetryConfig;
use super::retry::retry_delay;
use super::types::*;
use crate::rpc::types::BoxFuture;

/// Wrap a string error into a `Box<dyn Error + Send + Sync>` (`'static`).
fn boxed_err(s: String) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(std::io::Error::other(s))
}

/// What the retry layer learned from a failed attempt.
///
/// Carries the fields v2 attaches to `TurnStepRetrying` through
/// `retryErrorFields` (_base/utils/retry.ts:46-52) plus the wait the provider
/// asked for. The Rust transport reports failures as strings, so the name and
/// status are recovered from the text rather than from a typed error.
struct RetryDecision {
    /// v2 `RetryErrorFields.errorName`: the failure class, so a consumer can
    /// tell a cancelled request from a throttled one without parsing prose.
    error_name: &'static str,
    /// v2 `RetryErrorFields.errorMessage`.
    error_message: String,
    /// v2 `RetryErrorFields.statusCode`; `None` when no HTTP status reached
    /// the error (in-stream provider error, transport fault, decode failure).
    status_code: Option<u16>,
    /// The wait the provider asked for, if it asked for one.
    wait_hint: Option<Duration>,
}

/// Classify an LLM error: decide whether to return it or continue retrying.
///
/// Returns the [`RetryDecision`] if the error is retryable and attempts
/// remain, or `Err(boxed_error)` if the error should be propagated.
///
/// This is a standalone function (not an async block) so that the non-`Send`
/// `Box<dyn Error>` is consumed and dropped before any `.await` in the caller.
fn classify_llm_error(
    err: Box<dyn std::error::Error>,
    llm: &dyn LLM,
    attempt: u32,
    config: &RetryConfig,
    infinite_retry: bool,
) -> Result<RetryDecision, Box<dyn std::error::Error + Send + Sync>> {
    // Read the provider metadata off the typed error when the transport set it
    // (v2 keeps `retryAfterMs` / `statusCode` on the error object and every
    // classifier reads the fields). `retry_after_hint` stays as the fallback
    // for failures raised by paths that only have a string — the host proxy and
    // the racing multi-LLM build their own errors.
    let typed = err.downcast_ref::<crate::llm::LlmError>();
    let typed_retry_after = typed.and_then(crate::llm::LlmError::retry_after);
    let typed_status = typed.and_then(crate::llm::LlmError::status_code);
    let err_str = err.to_string();
    // `err` is dropped here (end of function scope for the parameter).
    if !llm.is_retryable_error(&err_str) {
        return Err(boxed_err(err_str));
    }
    // `KIMI_CODE_INFINITE_RETRY` retries every retryable LLM request without
    // exhausting the budget (v2 #3240, llmRequesterService.ts). Context
    // overflow is never retryable, so the deterministic overflow-recovery
    // path is unaffected.
    if !infinite_retry && attempt >= config.max_attempts {
        return Err(boxed_err(format!(
            "LLM call failed after {attempt} attempts: {err_str}"
        )));
    }
    let status_code = typed_status.or_else(|| crate::llm::http::llm_http_status(&err_str));
    // v2's `errorName` is the JS error class name; the closest analogue here is
    // the failure family the transport already encodes in the text.
    let error_name = if crate::llm::http::is_cancelled_error(&err_str) {
        "AbortError"
    } else if status_code.is_some() {
        "APIStatusError"
    } else if err_str.starts_with("llm transport error ") {
        "TransportError"
    } else {
        "Error"
    };
    Ok(RetryDecision {
        error_name,
        error_message: err_str.clone(),
        status_code,
        wait_hint: typed_retry_after.or_else(|| retry_after_hint(&err_str)),
    })
}

/// A 200 response that carries no answer — v2's `empty_response`.
///
/// `think_only` distinguishes v2's two shapes (`empty-response.ts:22-24`): the
/// provider returned nothing at all, or returned reasoning and nothing else.
struct EmptyResponse {
    think_only: bool,
}

const EMPTY_RESPONSE_DETAIL: &str = "The API returned an empty response (no content, no tool calls).";
const THINK_ONLY_RESPONSE_DETAIL: &str = "The API returned a response containing only thinking content without any text or tool calls. This usually indicates the stream was interrupted or the output token budget was exhausted during reasoning.";

/// Whether the provider's finish reason is a content filter.
///
/// v2 carries one `filtered` value (kosong folds the six provider-specific
/// spellings into it); this engine's turn-level mapping already accepts the
/// wider set, so the retry guard has to use the same list or a filtered turn
/// would be re-requested as an empty one. Mirrors
/// `turn_stop_reason_from_finish` (run_turn.rs:197-199).
/// Must stay the same list as `run_turn::turn_stop_reason_from_finish`.
pub(crate) fn is_content_filtered(finish_reason: Option<&str>) -> bool {
    matches!(
        finish_reason,
        Some(
            "content_filter"
                | "filtered"
                | "refusal"
                | "safety"
                | "recitation"
                | "blocklist"
                | "prohibited_content"
                | "spii"
                | "image_safety"
        )
    )
}

/// v2 `emptyResponseError` (human/llm/empty-response.ts:33-49).
///
/// v2 keeps think and text parts in one `message.content` array, so its first
/// arm (`content.length === 0`) means "no parts at all" and a think-only reply
/// falls through to the second arm. This engine splits them: `thinking` holds
/// the reasoning blocks and `content` the visible text. The field split is why
/// the first arm tests **both** fields — a response carrying only `thinking`
/// has `content == ""` in Rust while v2's equivalent had a non-empty array.
fn empty_response_of(response: &LLMChatResponse) -> Option<EmptyResponse> {
    let has_tool_calls = !response.tool_calls.is_empty();
    if response.content.is_empty() && response.thinking.is_empty() && !has_tool_calls {
        return Some(EmptyResponse { think_only: false });
    }
    // v2's text test trims (`part.text.trim().length > 0`), so a whitespace-only
    // body counts as "no text" here too.
    let has_think = !response.thinking.is_empty();
    let has_text = !response.content.trim().is_empty();
    if has_think && !has_text && !has_tool_calls {
        return Some(EmptyResponse { think_only: true });
    }
    None
}

/// v2 `createEmptyResponseError` (empty-response.ts:17-31) plus the
/// `Provider: …, model: …` suffix it appends. The user-facing half of this
/// failure is the `engine.providers.providerEmptyResponse` /
/// `providerThinkOnlyResponse` locale string; this text is what the retry
/// telemetry and the terminal error carry.
fn empty_response_message(
    empty: &EmptyResponse,
    response: &LLMChatResponse,
    llm: &dyn LLM,
) -> String {
    let detail = if empty.think_only {
        THINK_ONLY_RESPONSE_DETAIL
    } else {
        EMPTY_RESPONSE_DETAIL
    };
    let finish_hint = match response.finish_reason.as_deref() {
        None => String::new(),
        Some(reason) => format!(" Provider stop details: finishReason={reason}."),
    };
    format!(
        "{detail}{finish_hint} Provider: {}, model: {}",
        llm.transport(),
        llm.model_name()
    )
}

/// A successful response v2 would have turned into a retryable
/// `empty_response`.
///
/// Two guards, both behavioural rather than stylistic:
///
/// - **Transport.** Only the native transport assembles the assistant message
///   this check is about. On the host-proxy leg the host owns the transcript,
///   so an empty body is a legitimate answer, and the `multi` racer already
///   drops empty completions on its own (`llm/multi.rs::is_empty_completion`).
///   Without this, every proxy turn would be re-requested.
/// - **Filtering.** v2 `isRetryableError` makes `empty_response` retryable
///   *unless* the provider filtered it (requester/retry.ts:50-51). A filtered
///   turn is a real final answer; re-requesting it would spend the budget
///   re-eliciting the same refusal.
fn empty_response_retryable(
    response: &LLMChatResponse,
    llm: &dyn LLM,
) -> Option<EmptyResponse> {
    if llm.transport() != "native-http" {
        return None;
    }
    if is_content_filtered(response.finish_reason.as_deref()) {
        return None;
    }
    empty_response_of(response)
}

/// A wait the provider asked for, recovered from the error text.
///
/// **Fallback only.** A failure from the native HTTP transport carries the wait
/// on [`crate::llm::LlmError`], which the caller reads first; this path exists
/// for errors that are still bare strings — the host proxy and the racing
/// multi-LLM. Retrying sooner than the provider asked is wasted: the request
/// will be throttled again, and one exhausted retry budget is spent on requests
/// that were always going to be rejected.
pub(crate) fn retry_after_hint(error: &str) -> Option<Duration> {
    let marker = " (retry-after ";
    let start = error.rfind(marker)? + marker.len();
    let rest = &error[start..];
    let end = rest.find('s')?;
    rest[..end]
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// Pick the wait before the next attempt: the provider's request when it is
/// longer than the plain backoff, the backoff otherwise.
pub(crate) fn step_delay(backoff: Duration, hint: Option<Duration>) -> Duration {
    match hint {
        Some(hint) if hint > backoff => hint,
        _ => backoff,
    }
}

/// Execute a single LLM step with default retry configuration.
///
/// Convenience wrapper around `execute_loop_step_with_retry` that uses
/// `RetryConfig::default()`.
pub fn execute_loop_step<'a>(
    turn_id: &'a str,
    step: u32,
    llm: &'a dyn LLM,
    messages: &'a [LLMMessage],
    tools: &'a [&'a dyn ExecutableTool],
    tool_defs: &'a [ToolInfo],
    cancel: Option<&'a tokio_util::sync::CancellationToken>,
) -> BoxFuture<'a, Result<StepResult, Box<dyn std::error::Error + Send + Sync>>> {
    execute_loop_step_with_retry(
        turn_id,
        step,
        llm,
        messages,
        tools,
        tool_defs,
        &RetryConfig::default(),
        cancel,
        None,
    )
}

/// Execute a single LLM step: call the LLM using the current messages,
/// return the response with any tool calls. Retries retryable errors
/// using exponential backoff with jitter (see `retry::retry_delay`).
///
/// Non-retryable errors fail immediately. Retryable errors are retried up
/// to `retry_config.max_attempts` times. Each attempt is 1-based: the
/// first call is attempt 1, the first retry is attempt 2, etc.
///
/// `cancel` rides into every attempt's `LLMChatParams` so the provider
/// transport can abort the in-flight request mid-stream (v2's AbortSignal).
///
/// Borrows `messages` and `tool_defs`; the owned copy an attempt needs is
/// built at the provider boundary. The success path (the common case) hands
/// the first copy straight through instead of cloning per attempt, so a step
/// keeps only one history/tool-table copy rather than one per retry.
#[allow(clippy::too_many_arguments)]
pub fn execute_loop_step_with_retry<'a>(
    turn_id: &'a str,
    step: u32,
    llm: &'a dyn LLM,
    messages: &'a [LLMMessage],
    _tools: &'a [&'a dyn ExecutableTool],
    tool_defs: &'a [ToolInfo],
    retry_config: &RetryConfig,
    cancel: Option<&'a tokio_util::sync::CancellationToken>,
    // Optional telemetry sink: fires the v2 `TurnStepRetrying` event on every
    // retry backoff (the activity phase machine folds it into the `retrying`
    // phase; hosts forward it to their telemetry sink).
    telemetry: Option<&'a (dyn Fn(serde_json::Value) + Send + Sync)>,
) -> BoxFuture<'a, Result<StepResult, Box<dyn std::error::Error + Send + Sync>>> {
    let retry_config = retry_config.clone();
    let cancel_token = cancel.cloned();
    Box::pin(async move {
        // Snapshot the borrowed slice/tool table into shared buffers once, then
        // every attempt (success and retry alike) clones only the `Arc`.
        let messages: std::sync::Arc<[LLMMessage]> = std::sync::Arc::from(messages);
        let tools: std::sync::Arc<[ToolInfo]> = std::sync::Arc::from(tool_defs);
        let build_params = || LLMChatParams {
            messages: std::sync::Arc::clone(&messages),
            tools: std::sync::Arc::clone(&tools),
            cancel: cancel_token.clone(),
        };
        let mut params = Some(build_params());

        let mut attempt: u32 = 0;
        let infinite_retry = crate::turn_loop::retry::infinite_retry_enabled();
        let response = loop {
            attempt += 1;
            // Match the chat result and extract only Send-safe values, so the
            // non-Send `Box<dyn Error>` is fully consumed before the `.await`.
            let call_params = match params.take() {
                Some(params) => params,
                None => build_params(),
            };
            let (break_resp, return_err, retry_decision) = match llm.chat(call_params).await {
                Ok(resp) => match empty_response_retryable(&resp, llm) {
                    None => (Some(resp), None, None),
                    // v2 raises `empty_response` here and hands it to the same
                    // `shouldRetry` path every transport failure takes, so the
                    // backoff, the `TurnStepRetrying` telemetry and the cancel
                    // race below are reused unchanged rather than reimplemented.
                    Some(empty) => {
                        let message = empty_response_message(&empty, &resp, llm);
                        if !infinite_retry && attempt >= retry_config.max_attempts {
                            (None, Some(boxed_err(message)), None)
                        } else {
                            (
                                None,
                                None,
                                Some(RetryDecision {
                                    error_name: "EmptyResponseError",
                                    error_message: message,
                                    status_code: None,
                                    wait_hint: None,
                                }),
                            )
                        }
                    }
                },
                Err(err) => {
                    match classify_llm_error(err, llm, attempt, &retry_config, infinite_retry) {
                        Ok(decision) => (None, None, Some(decision)),
                        Err(e) => (None, Some(e), None),
                    }
                }
            };
            if let Some(resp) = break_resp {
                break resp;
            }
            if let Some(e) = return_err {
                return Err(e);
            }
            let decision = retry_decision.expect("a retryable failure carries its decision");
            let delay = step_delay(retry_delay(attempt, &retry_config), decision.wait_hint);
            // v2 `TurnStepRetrying` telemetry event parity
            // (loopService.ts:1571-1585, payload in turnEvents.ts:163).
            tracing::warn!(
                turn_id = turn_id,
                step = step,
                failed_attempt = attempt,
                next_attempt = attempt + 1,
                max_attempts = retry_config.max_attempts,
                infinite_retry = infinite_retry,
                delay_ms = delay.as_millis() as u64,
                error_name = decision.error_name,
                status_code = decision.status_code,
                error_message = %decision.error_message,
                "TurnStepRetrying"
            );
            if let Some(telemetry) = telemetry {
                telemetry(serde_json::json!({
                    "event": "TurnStepRetrying",
                    "turn_id": turn_id,
                    "step": step,
                    "failed_attempt": attempt,
                    "next_attempt": attempt + 1,
                    "max_attempts": retry_config.max_attempts,
                    "infinite_retry": infinite_retry,
                    "delay_ms": delay.as_millis() as u64,
                    // v2 carries the failure itself, not just the fact of a
                    // retry — without these a consumer cannot tell a throttled
                    // request from a timed-out one.
                    "error_name": decision.error_name,
                    "error_message": decision.error_message,
                    "status_code": decision.status_code,
                }));
            }
            // A cancellation landing during the backoff wait aborts the step
            // immediately instead of sleeping out the delay (v2 #3240).
            match cancel {
                Some(token) => tokio::select! {
                    _ = token.cancelled() => {
                        return Err(boxed_err("llm cancelled during retry backoff".into()));
                    }
                    _ = tokio::time::sleep(delay) => {}
                },
                None => tokio::time::sleep(delay).await,
            }
        };

        let usage = response.usage.clone();
        let attempts = attempt;
        let finish_reason = response.finish_reason.clone();
        // Reasoning blocks ride along untouched: the turn loop folds them
        // into the assistant history so attested thinking (signature and all)
        // round-trips on the next provider call.
        let thinking = response.thinking.clone();
        if response.tool_calls.is_empty() {
            Ok(StepResult {
                usage,
                stop_reason: LoopStepStopReason::Complete,
                content: response.content,
                thinking,
                attempts,
                finish_reason,
                timing: response.timing,
            })
        } else {
            let mut tool_calls = response.tool_calls;
            // P61: some OpenAI-compatible gateways (MiniMax) return tool
            // calls with an empty id; the follow-up tool result then
            // references `""` and the provider rejects the request
            // (2013: tool id not found). Synthesize unique ids before the
            // calls enter the message history.
            for tc in &mut tool_calls {
                if tc.id.trim().is_empty() {
                    tc.id = format!("toolu_{}", fastrand::u64(..));
                }
            }
            Ok(StepResult {
                usage,
                stop_reason: LoopStepStopReason::ToolCalls(tool_calls),
                content: response.content,
                thinking,
                attempts,
                finish_reason,
                timing: response.timing,
            })
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::TokenUsage;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A test LLM that fails N times then succeeds, with configurable retryability.
    struct FlakyLlm {
        system_prompt: String,
        model_name: String,
        fail_count: u32,
        calls: AtomicU32,
        retryable: bool,
    }

    impl FlakyLlm {
        fn new(fail_count: u32, retryable: bool) -> Self {
            Self {
                system_prompt: "test".into(),
                model_name: "flaky".into(),
                fail_count,
                calls: AtomicU32::new(0),
                retryable,
            }
        }
    }

    impl LLM for FlakyLlm {
        fn system_prompt(&self) -> &str {
            &self.system_prompt
        }
        fn model_name(&self) -> &str {
            &self.model_name
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            self.retryable
        }

        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let fail_count = self.fail_count;
            Box::pin(async move {
                if call < fail_count {
                    return Err(format!("simulated failure {}", call + 1).into());
                }
                Ok(LLMChatResponse {
                    content: String::new(),
                    thinking: vec![],
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage {
                        input_tokens: 1,
                        output_tokens: 1,
                        total_tokens: 2,
                        ..Default::default()
                    },
                    timing: None,
                })
            })
        }
    }

    #[tokio::test]
    async fn test_retry_succeeds_after_failures() {
        // Fails 2 times, succeeds on 3rd try. max_attempts=3 should succeed.
        let llm = FlakyLlm::new(2, true);
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 1, // fast for tests
            max_delay_ms: 10,
        };
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None).await;
        assert!(
            result.is_ok(),
            "should succeed after retries: {:?}",
            result.err()
        );
        assert_eq!(llm.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn test_retry_exhausted() {
        // Always fails; with max_attempts=2, should give up after 2 tries.
        let llm = FlakyLlm::new(100, true);
        let config = RetryConfig {
            max_attempts: 2,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None).await;
        assert!(result.is_err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_non_retryable_fails_immediately() {
        // Non-retryable error should fail on first attempt, no retries.
        let llm = FlakyLlm::new(100, false);
        let config = RetryConfig {
            max_attempts: 5,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None).await;
        assert!(result.is_err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
    }

    /// A test LLM that always fails with a fixed status-coded error.
    struct StatusLlm {
        system_prompt: String,
        model_name: String,
        error: String,
    }

    impl StatusLlm {
        fn new(error: &str) -> Self {
            Self {
                system_prompt: "test".into(),
                model_name: "status".into(),
                error: error.into(),
            }
        }
    }

    impl LLM for StatusLlm {
        fn system_prompt(&self) -> &str {
            &self.system_prompt
        }
        fn model_name(&self) -> &str {
            &self.model_name
        }
        fn is_retryable_error(&self, error: &str) -> bool {
            // The production classifier's rule: 429 is retryable.
            crate::llm::http::llm_http_status(error) == Some(429)
        }
        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let error = self.error.clone();
            Box::pin(async move { Err(error.into()) })
        }
    }

    /// v2's `TurnStepRetrying` payload carries the failure itself
    /// (`retryErrorFields`: errorName / errorMessage / statusCode), not just the
    /// fact that a retry happened — a consumer cannot tell a throttled request
    /// from a timed-out one without them.
    #[tokio::test]
    async fn turn_step_retrying_carries_the_v2_error_fields() {
        let llm =
            StatusLlm::new("llm http status 429 Too Many Requests: slow down (retry-after 7s)");
        let config = RetryConfig {
            max_attempts: 2,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let events: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let telemetry = move |event: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(event);
        };

        let _ = execute_loop_step_with_retry(
            "t1",
            3,
            &llm,
            &[],
            &[],
            &[],
            &config,
            None,
            Some(&telemetry),
        )
        .await;

        let recorded = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        assert_eq!(
            recorded.len(),
            1,
            "one backoff before giving up: {recorded:?}"
        );
        let event = &recorded[0];
        assert_eq!(event["event"], "TurnStepRetrying");
        assert_eq!(event["step"], 3);
        assert_eq!(event["failed_attempt"], 1);
        assert_eq!(event["next_attempt"], 2);
        assert_eq!(event["max_attempts"], 2);
        // The provider's wait wins over the 1ms backoff.
        assert_eq!(event["delay_ms"], 7000);
        assert_eq!(event["error_name"], "APIStatusError");
        assert_eq!(event["status_code"], 429);
        assert!(
            event["error_message"]
                .as_str()
                .unwrap_or_default()
                .contains("slow down"),
            "the failure text must ride along: {event}"
        );
    }

    /// The failure family is reported, so a cancelled request is distinguishable
    /// from a provider fault without reading prose.
    #[tokio::test]
    async fn turn_step_retrying_names_a_cancelled_failure() {
        let llm = StatusLlm::new("llm cancelled: request aborted");
        let config = RetryConfig {
            max_attempts: 2,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let events: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let telemetry = move |event: serde_json::Value| {
            sink.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(event);
        };
        // `StatusLlm` only retries 429s, so this one propagates — the point is
        // the classifier's name mapping, asserted directly.
        let _ = execute_loop_step_with_retry(
            "t1",
            1,
            &llm,
            &[],
            &[],
            &[],
            &config,
            None,
            Some(&telemetry),
        )
        .await;
        assert!(
            events.lock().unwrap().is_empty(),
            "a cancellation never retries"
        );
        assert!(crate::llm::http::is_cancelled_error(
            "llm cancelled: request aborted"
        ));
        assert!(!crate::llm::http::is_cancelled_error(
            "llm http status 429: slow down"
        ));
    }

    #[tokio::test]
    async fn test_no_retry_needed() {
        // Succeeds on first try.
        let llm = FlakyLlm::new(0, true);
        let config = RetryConfig::default();
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None).await;
        assert!(result.is_ok());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_empty_tool_call_id_gets_synthesized() {
        // P61: MiniMax-style gateways return tool calls with an empty id;
        // the engine must synthesize one before the calls enter history,
        // otherwise the follow-up tool result references "" and the
        // provider rejects the request (2013).
        struct EmptyIdLlm;
        impl LLM for EmptyIdLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "empty-id-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                Box::pin(async {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        thinking: vec![],
                        tool_calls: vec![
                            ToolCall {
                                id: String::new(),
                                name: "read".into(),
                                arguments: serde_json::json!({}),
                                extras: None,
                            },
                            ToolCall {
                                id: "  ".into(),
                                name: "glob".into(),
                                arguments: serde_json::json!({}),
                                extras: None,
                            },
                        ],
                        finish_reason: Some("tool_calls".into()),
                        usage: crate::rpc::types::TokenUsage::default(),
                        timing: None,
                    })
                })
            }
        }
        let result = execute_loop_step_with_retry(
            "t1",
            1,
            &EmptyIdLlm,
            &[],
            &[],
            &[],
            &RetryConfig::default(),
            None,
            None,
        )
        .await
        .unwrap();
        let LoopStepStopReason::ToolCalls(tool_calls) = result.stop_reason else {
            panic!("expected tool calls");
        };
        assert_eq!(tool_calls.len(), 2);
        for tc in &tool_calls {
            assert!(!tc.id.trim().is_empty(), "id must be synthesized");
        }
        assert_ne!(tool_calls[0].id, tool_calls[1].id, "ids must be unique");
    }

    #[tokio::test]
    async fn test_retry_tool_calls_in_response() {
        let calls = Arc::new(AtomicU32::new(0));
        struct ToolCallLlm {
            calls: Arc<AtomicU32>,
        }
        impl LLM for ToolCallLlm {
            fn system_prompt(&self) -> &str {
                "test"
            }
            fn model_name(&self) -> &str {
                "tool-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _: LLMChatParams,
            ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        thinking: vec![],
                        tool_calls: if call == 0 {
                            vec![ToolCall {
                                id: "c1".into(),
                                name: "read".into(),
                                arguments: serde_json::json!({}),
                                extras: None,
                            }]
                        } else {
                            vec![]
                        },
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage {
                            input_tokens: 1,
                            output_tokens: 1,
                            total_tokens: 2,
                            ..Default::default()
                        },
                        timing: None,
                    })
                })
            }
        }

        let llm = ToolCallLlm {
            calls: calls.clone(),
        };
        let result = execute_loop_step_with_retry(
            "t1",
            1,
            &llm,
            &[],
            &[],
            &[],
            &RetryConfig::default(),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let step = result.unwrap();
        match step.stop_reason {
            LoopStepStopReason::ToolCalls(tcs) => assert_eq!(tcs.len(), 1),
            _ => panic!("expected ToolCalls stop reason"),
        }
    }

    #[tokio::test]
    async fn test_retry_max_attempts_one() {
        let llm = FlakyLlm::new(1, true);
        let config = RetryConfig {
            max_attempts: 1,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None).await;
        assert!(result.is_err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_retry_succeeds_on_first_retry() {
        let llm = FlakyLlm::new(1, true);
        let config = RetryConfig {
            max_attempts: 2,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None).await;
        assert!(result.is_ok());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_execute_loop_step_no_retry_config() {
        let llm = FlakyLlm::new(0, true);
        let result = execute_loop_step("t1", 1, &llm, &[], &[], &[], None).await;
        assert!(result.is_ok());
    }

    #[test]
    fn retry_after_hint_is_parsed_from_the_error_text() {
        let with_hint = "llm http status 429 Too Many Requests: slow down (retry-after 30s)";
        assert_eq!(retry_after_hint(with_hint), Some(Duration::from_secs(30)));

        // No hint, or a hint in HTTP-date form (seconds only is what the
        // transport emits): fall back to the plain backoff.
        assert_eq!(retry_after_hint("llm http status 429: slow down"), None);
        assert_eq!(
            retry_after_hint("llm http status 429: (retry-after Wed, 21 Oct 2015 07:28:00 GMT)"),
            None
        );
    }

    #[tokio::test]
    async fn test_retry_waits_at_least_as_long_as_the_provider_asks() {
        // A provider asking for 30s must not be retried at the 1s backoff.
        assert_eq!(
            step_delay(Duration::from_secs(1), Some(Duration::from_secs(30))),
            Duration::from_secs(30)
        );
        // And a short hint must not shorten the backoff either.
        assert_eq!(
            step_delay(Duration::from_secs(5), Some(Duration::from_millis(200))),
            Duration::from_secs(5)
        );
        // No hint: the backoff stands.
        assert_eq!(
            step_delay(Duration::from_secs(3), None),
            Duration::from_secs(3)
        );
    }

    /// Infinite retry mode (`KIMI_CODE_INFINITE_RETRY`) lifts the attempt cap
    /// for retryable errors only; the flag is injected so the test never
    /// touches the process environment.
    #[test]
    fn classify_llm_error_honors_infinite_retry() {
        let llm = FlakyLlm::new(100, true);
        let config = RetryConfig {
            max_attempts: 2,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };

        let exhausted = classify_llm_error(
            Box::new(std::io::Error::other("simulated failure")),
            &llm,
            2,
            &config,
            false,
        );
        assert!(exhausted.is_err(), "cap reached without infinite mode");

        let infinite = classify_llm_error(
            Box::new(std::io::Error::other("simulated failure")),
            &llm,
            2,
            &config,
            true,
        );
        assert!(
            infinite.is_ok(),
            "infinite mode must keep retrying past max_attempts"
        );

        // Non-retryable errors still fail fast in infinite mode.
        let non_retryable_llm = FlakyLlm::new(100, false);
        let fatal = classify_llm_error(
            Box::new(std::io::Error::other("bad request")),
            &non_retryable_llm,
            1,
            &config,
            true,
        );
        assert!(fatal.is_err(), "non-retryable errors never retry");
    }

    #[tokio::test]
    async fn test_cancel_aborts_during_backoff_wait() {
        // A retryable failure with a long backoff: cancellation must end the
        // step immediately instead of sleeping out the delay (v2 #3240).
        let llm = FlakyLlm::new(u32::MAX, true);
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 30_000,
            max_delay_ms: 30_000,
        };
        let token = tokio_util::sync::CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, Some(&token), None)
                .await;
        assert!(result.is_err(), "cancelled step must resolve with an error");
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1, "no retry after cancel");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancel must not wait out the 30s backoff, took {:?}",
            started.elapsed()
        );
    }

    // ── empty_response (v2 human/llm/empty-response.ts) ──────────────────
    //
    // A 200 that carries no answer used to be booked as a finished turn, so
    // the model stopped early and nothing — log, telemetry, transcript — could
    // tell it from a real reply. v2 raises `empty_response` and retries it
    // (requester/retry.ts:50-51).

    /// A native-transport LLM that answers `empty_times` times with an empty
    /// body before returning a real answer.
    struct EmptyThenLlm {
        empty_times: u32,
        transport: &'static str,
        calls: AtomicU32,
    }

    impl EmptyThenLlm {
        fn new(empty_times: u32, transport: &'static str) -> Self {
            Self {
                empty_times,
                transport,
                calls: AtomicU32::new(0),
            }
        }
    }

    /// A response with no visible answer, in whichever of v2's two shapes the
    /// case under test needs.
    fn answer(content: &str, think: bool, finish: &'static str) -> LLMChatResponse {
        LLMChatResponse {
            content: content.into(),
            thinking: if think {
                vec![ContentBlock::Text {
                    text: "reasoning".into(),
                }]
            } else {
                vec![]
            },
            tool_calls: vec![],
            finish_reason: Some(finish.into()),
            usage: TokenUsage::default(),
            timing: None,
        }
    }

    fn tool_call() -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: "Read".into(),
            arguments: serde_json::json!({ "path": "a.txt" }),
            extras: None,
        }
    }

    impl LLM for EmptyThenLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "empty-then"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            true
        }
        fn transport(&self) -> &'static str {
            self.transport
        }
        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let empty_times = self.empty_times;
            Box::pin(async move {
                if call < empty_times {
                    Ok(answer("", false, "stop"))
                } else {
                    Ok(answer("a real answer", false, "stop"))
                }
            })
        }
    }

    /// v2 `emptyResponseError` shape: the two arms are decided by different
    /// emptiness tests, and neither fires when a tool call is present.
    #[test]
    fn empty_response_of_matches_v2_empty_response_error() {
        // Neither content nor tool calls — the plain empty arm.
        let empty = empty_response_of(&answer("", false, "stop")).expect("plain empty response");
        assert!(!empty.think_only);
        // Reasoning only — the think-only arm.
        let think = empty_response_of(&answer("", true, "stop")).expect("think-only response");
        assert!(think.think_only);
        // Whitespace-only content is *not* the plain empty arm (v2 tests
        // `length === 0`), and with no reasoning it is a legitimate answer.
        assert!(empty_response_of(&answer("   ", false, "stop")).is_none());
        // Real text is never empty, with or without reasoning alongside it.
        assert!(empty_response_of(&answer("hi", false, "stop")).is_none());
        assert!(empty_response_of(&answer("hi", true, "stop")).is_none());

        // A tool call makes an otherwise empty body a real turn.
        let mut with_call = answer("", false, "tool_calls");
        with_call.tool_calls = vec![tool_call()];
        assert!(empty_response_of(&with_call).is_none());
        let mut think_and_call = answer("", true, "tool_calls");
        think_and_call.tool_calls = vec![tool_call()];
        assert!(empty_response_of(&think_and_call).is_none());
    }

    /// The content-filter arm, independent of the transport: v2 folds six
    /// provider spellings into `filtered`, and this engine's turn-level stop
    /// mapping accepts the wider set, so the retry guard has to use the same
    /// list or a filtered turn is re-requested as an empty one.
    #[test]
    fn is_content_filtered_covers_the_turn_level_filter_vocabulary() {
        for filtered in [
            "content_filter",
            "filtered",
            "refusal",
            "safety",
            "recitation",
            "blocklist",
            "prohibited_content",
            "spii",
            "image_safety",
        ] {
            assert!(
                is_content_filtered(Some(filtered)),
                "{filtered} must count as a filter stop"
            );
        }
        // The ordinary stops, and the absent case, must not.
        for ordinary in ["stop", "length", "max_tokens", "tool_calls"] {
            assert!(
                !is_content_filtered(Some(ordinary)),
                "{ordinary} is not a filter stop"
            );
        }
        assert!(!is_content_filtered(None));
    }

    /// A 200 with no answer must be retried, and the recovered attempt must
    /// carry its content through.
    #[tokio::test]
    async fn an_empty_response_is_retried_until_the_provider_answers() {
        let llm = EmptyThenLlm::new(2, "native-http");
        let config = RetryConfig {
            max_attempts: 5,
            base_delay_ms: 1,
            max_delay_ms: 2,
        };
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None)
                .await
                .expect("the third attempt carries a real answer");
        assert_eq!(llm.calls.load(Ordering::SeqCst), 3, "two empty retries");
        assert_eq!(result.content, "a real answer");
    }

    /// v2 `isRetryableError`: `empty_response` is retryable *unless* the
    /// provider filtered the response. A filtered turn is a final answer.
    #[tokio::test]
    async fn a_content_filtered_empty_response_is_not_retried() {
        for filtered in ["content_filter", "refusal", "safety", "image_safety"] {
            let llm = FilteredEmptyLlm {
                finish: filtered,
                calls: AtomicU32::new(0),
            };
            let config = RetryConfig {
                max_attempts: 5,
                base_delay_ms: 1,
                max_delay_ms: 2,
            };
            let result =
                execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None)
                    .await
                    .expect("a filtered turn completes rather than erroring");
            assert_eq!(
                llm.calls.load(Ordering::SeqCst),
                1,
                "{filtered} must not spend a retry"
            );
            assert!(
                matches!(result.stop_reason, LoopStepStopReason::Complete),
                "a filtered turn completes; got {:?}",
                result.stop_reason
            );
        }
    }

    struct FilteredEmptyLlm {
        finish: &'static str,
        calls: AtomicU32,
    }

    impl LLM for FilteredEmptyLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "filtered"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            true
        }
        fn transport(&self) -> &'static str {
            "native-http"
        }
        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let finish = self.finish;
            Box::pin(async move { Ok(answer("", false, finish)) })
        }
    }

    /// The host owns the transcript on the proxy leg, so an empty body there
    /// is a legitimate answer. Without the transport guard every proxy turn
    /// would be re-requested — and the pre-existing `FlakyLlm` suite, whose
    /// success path *is* an empty body, would spend real backoff on it.
    #[tokio::test]
    async fn an_empty_response_on_the_host_proxy_is_left_alone() {
        let llm = EmptyThenLlm::new(u32::MAX, "host-proxy");
        let config = RetryConfig {
            max_attempts: 5,
            base_delay_ms: 1,
            max_delay_ms: 2,
        };
        let result =
            execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None)
                .await
                .expect("the proxy leg owns its own transcript");
        assert_eq!(
            llm.calls.load(Ordering::SeqCst),
            1,
            "no retry on the proxy"
        );
        assert!(result.content.is_empty());
    }

    /// With the budget spent the failure must surface rather than loop: v2
    /// propagates the `empty_response` error once `shouldRetry` says stop.
    #[tokio::test]
    async fn a_persistently_empty_response_surfaces_after_the_budget() {
        let llm = EmptyThenLlm::new(u32::MAX, "native-http");
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 1,
            max_delay_ms: 2,
        };
        let err = execute_loop_step_with_retry("t1", 1, &llm, &[], &[], &[], &config, None, None)
            .await
            .expect_err("a permanently empty provider must not read as success");
        assert_eq!(llm.calls.load(Ordering::SeqCst), 3, "the budget is spent");
        assert!(
            err.to_string().contains("empty response"),
            "the error must name the cause, got: {err}"
        );
    }
}
