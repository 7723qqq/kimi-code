//! LLM Streaming — HTTP SSE streaming client with provider-specific event decoders.
//!
//! Handles the full pipeline: HTTP POST → SSE byte stream → event parsing →
//! provider-specific decoding → StreamedPart output.
//!
//! Supported providers:
//! - OpenAI Responses API (`openai-responses`)
//! - OpenAI Chat Completions / Legacy (`openai-legacy`)
//! - Anthropic Messages API (`anthropic`)
//! - Google GenAI / Gemini (`google` | `google-genai` | `gemini`)

use std::time::Duration;

use eventsource_stream::Eventsource as EvensourceExt;
use futures_util::StreamExt;
use reqwest::header::{
    AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT,
};
use serde_json::Value;

use crate::llm::google_genai;
use crate::llm::wire::StreamDelta;

/// Whether this provider string is the Google GenerateContent wire. The
/// endpoint builder (`llm::http`) and the config resolver match the same three
/// spellings.
fn is_google_provider(provider: &str) -> bool {
    matches!(provider, "google" | "google-genai" | "gemini")
}

/// Shared HTTP client: one connection pool and TLS session cache across every
/// LLM stream request. The per-request deadline rides on the request builder.
static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .build()
        .expect("build shared HTTP client")
});

// ── Types ────────────────────────────────────────────────────────────────────

/// Configuration for initiating an LLM stream.
///
/// The model name is not carried here: it already rides inside the serialized
/// `request_body`, which is the only place the provider needs it.
#[derive(Debug, Clone)]
pub struct LlmStreamConfig {
    pub provider: String,
    pub url: String,
    pub api_key: String,
    pub request_body: String,
    pub timeout_ms: u64,
    pub extra_headers: Vec<(String, String)>,
}

/// A single streamed part yielded from the SSE stream.
#[derive(Debug, Clone, Default)]
pub struct StreamedPart {
    pub part_type: String,
    pub text: Option<String>,
    pub think: Option<String>,
    pub encrypted: Option<String>,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
    pub arguments_part: Option<String>,
    pub stream_index: Option<u32>,
}

/// Metadata collected after the stream completes.
#[derive(Debug, Clone, Default)]
pub struct StreamMetadata {
    pub response_id: Option<String>,
    pub finish_reason: Option<String>,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cached_tokens: u32,
    pub trace_id: Option<String>,
}

/// Events emitted by the stream processor.
#[derive(Debug)]
pub enum StreamEvent {
    Part(StreamedPart),
    Done(StreamMetadata),
    Error(String),
}

// ── Public entry point ───────────────────────────────────────────────────────

/// Execute the full LLM streaming pipeline.
///
/// Returns a stream of `StreamEvent`s. The caller (NAPI binding) iterates
/// this and dispatches each event to the appropriate JS callback.
pub async fn run_llm_stream(config: &LlmStreamConfig) -> Result<Vec<StreamEvent>, String> {
    let mut events = Vec::new();
    run_llm_stream_with(config, |event| events.push(event)).await?;
    Ok(events)
}

/// Execute the full LLM streaming pipeline, invoking `emit` for each event as
/// it is decoded — the SSE loop stays fully streaming; nothing is buffered.
/// The NAPI layer uses this to forward parts to JS via a ThreadsafeFunction
/// as they arrive (true incremental streaming, not "collect then return").
pub async fn run_llm_stream_with(
    config: &LlmStreamConfig,
    mut emit: impl FnMut(StreamEvent),
) -> Result<(), String> {
    let timeout = Duration::from_millis(config.timeout_ms);

    // Build headers
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("kimi-native-tools/0.1"),
    );

    // Auth header
    if !config.api_key.is_empty() {
        let auth_value = if config.provider == "anthropic" {
            config.api_key.to_string() // Anthropic uses x-api-key, not Bearer
        } else {
            format!("Bearer {}", config.api_key)
        };
        if config.provider == "anthropic" {
            headers.insert(
                HeaderName::from_static("x-api-key"),
                HeaderValue::from_str(&config.api_key)
                    .map_err(|e| format!("Invalid API key header: {e}"))?,
            );
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
        } else {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&auth_value)
                    .map_err(|e| format!("Invalid auth header: {e}"))?,
            );
        }
    }

    // Extra headers
    for (key, value) in &config.extra_headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(name, val);
        }
    }

    // A Google endpoint without a version segment is not an API route: a
    // catch-all gateway answers it 200 with a body the decoder cannot use, which
    // reaches the user as "the model returned nothing". The engine transport
    // appends the segment itself (`google_api_base`); this path receives a full
    // endpoint URL, so it can only refuse the request loudly.
    if is_google_provider(&config.provider) && !crate::llm::http::url_has_api_version(&config.url) {
        return Err(format!(
            "google-genai stream url \"{}\" carries no API version segment (expected e.g. /v1beta/models/<model>:streamGenerateContent). Refusing to issue a request that would be answered by a catch-all route.",
            config.url
        ));
    }

    // Make the HTTP request
    let response = HTTP_CLIENT
        .post(&config.url)
        .timeout(timeout)
        .headers(headers)
        .body(config.request_body.clone())
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("HTTP timeout: {e}")
            } else if e.is_connect() {
                format!("HTTP connection failed: {e}")
            } else {
                format!("HTTP request failed: {e}")
            }
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API error ({}): {}", status.as_u16(), body));
    }

    // Extract trace-id header if present
    let trace_id = response
        .headers()
        .get("x-trace-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut metadata = StreamMetadata {
        trace_id,
        ..Default::default()
    };

    // Google frames are cumulative deltas: `usageMetadata` and `finishReason`
    // ride on arbitrary frames, so the accumulator has to outlive the loop
    // (unlike the stateless decoders below).
    let mut google =
        is_google_provider(&config.provider).then(google_genai::StreamAccumulator::new);

    // A stream that never yields a parseable frame must not end as a silent
    // `Done`: the caller sees zero parts and reports "the model returned
    // nothing". Same failure mode the engine transport guards against.
    // Read the content type before `bytes_stream()` consumes the response.
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Read SSE stream
    let bytes_stream = response.bytes_stream();
    let mut sse_stream = bytes_stream.eventsource();

    let mut n_parsed: u32 = 0;
    let mut n_malformed: u32 = 0;
    let mut first_malformed: Option<String> = None;
    // An in-band error or a decode failure already reported the terminal state;
    // emitting `Done` afterwards would tell the caller the stream completed.
    let mut errored = false;
    // Thinking-loop guard: a degenerate thinking stream is a decoding attractor
    // the model cannot notice from inside, so the repetition is caught here and
    // the rest of the block is dropped from the display.
    let mut thinking_guard = crate::llm::thinking_guard::ThinkingGuard::from_settings();

    while let Some(result) = sse_stream.next().await {
        match result {
            Ok(event) => {
                let data = event.data;
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }

                let parsed: Value = match serde_json::from_str(&data) {
                    Ok(v) => v,
                    // Count instead of discarding silently: a catch-all gateway
                    // answering 200 with a non-SSE body lands here.
                    Err(_) => {
                        n_malformed += 1;
                        if first_malformed.is_none() {
                            first_malformed = Some(truncate_for_diagnosis(&data));
                        }
                        continue;
                    }
                };
                n_parsed += 1;

                // Gateways and providers report mid-stream failures as in-band
                // error frames (Chat Completions: a top-level `error` object;
                // Anthropic / Responses: a `type: "error"` event). Surface them
                // as stream errors instead of silently ending with whatever
                // partial content arrived — the SDK path throws on these too.
                if let Some(message) = extract_in_band_error(&parsed) {
                    emit(StreamEvent::Error(format!(
                        "Provider stream error: {message}"
                    )));
                    errored = true;
                    break;
                }

                let decoded = match config.provider.as_str() {
                    "openai-responses" => decode_openai_responses_event(&parsed, &mut metadata),
                    "openai-legacy" => decode_openai_legacy_event(&parsed, &mut metadata),
                    "anthropic" => decode_anthropic_event(&parsed, &mut metadata),
                    "google" | "google-genai" | "gemini" => match google.as_mut() {
                        Some(accumulator) => decode_google_event(accumulator, &parsed),
                        None => Vec::new(),
                    },
                    _ => vec![],
                };

                for part in decoded {
                    match part.part_type.as_str() {
                        "think" => {
                            // Drop the rest of a degenerate thinking loop.
                            // Borrow rather than clone: this runs per token.
                            let forward = match part.think.as_deref() {
                                Some(text) => {
                                    thinking_guard.observe(text)
                                        == crate::llm::thinking_guard::ThinkingVerdict::Forward
                                }
                                None => true,
                            };
                            if forward {
                                emit(StreamEvent::Part(part));
                            }
                        }
                        "text" => {
                            // The thinking block ended; the next one starts clean.
                            thinking_guard.reset();
                            emit(StreamEvent::Part(part));
                        }
                        _ => emit(StreamEvent::Part(part)),
                    }
                }
            }
            Err(e) => {
                emit(StreamEvent::Error(format!("SSE stream error: {e}")));
                errored = true;
                break;
            }
        }
    }

    // Google reports usage and the finish reason across the stream rather than
    // in a final frame, so `finish()` is where the accumulator hands them over.
    if let Some(accumulator) = google.take() {
        let final_response = accumulator.finish();
        metadata.input_tokens = final_response.usage.input_tokens;
        metadata.output_tokens = final_response.usage.output_tokens;
        // `TokenUsage` names the cache fields after Anthropic's; Google's
        // `cachedContentTokenCount` lands in `input_cache_read`.
        metadata.cached_tokens = final_response.usage.input_cache_read;
        metadata.finish_reason = final_response.finish_reason;

        // Gemini function calls only exist once the accumulator is finalized —
        // the per-frame delta carries text/think only. They used to be dropped
        // here, so on this path the agent received a Gemini function call as
        // nothing at all and could not act on it.
        for (index, call) in final_response.tool_calls.into_iter().enumerate() {
            emit(StreamEvent::Part(StreamedPart {
                part_type: "function".into(),
                text: None,
                think: None,
                encrypted: None,
                id: Some(call.id),
                name: Some(call.name),
                arguments: Some(call.arguments.to_string()),
                arguments_part: None,
                stream_index: Some(index as u32),
            }));
        }
    }

    if errored {
        // The terminal event was already emitted; do not follow it with `Done`.
        return Ok(());
    }

    // No parseable frame at all: report a stream error instead of `Done`, which
    // the caller would read as "the model returned nothing".
    if n_parsed == 0 {
        emit(StreamEvent::Error(empty_stream_error(
            &content_type,
            n_malformed,
            first_malformed.as_deref(),
        )));
        return Ok(());
    }

    emit(StreamEvent::Done(metadata));
    Ok(())
}

// ── In-band error detection ──────────────────────────────────────────────────

/// Prefix for a 200 response whose body is not an SSE chat stream at all (every
/// frame failed to parse). Retrying cannot fix a wrong `base_url`, so the engine
/// transport refuses to retry it.
pub(crate) const NOT_AN_SSE_ENDPOINT_PREFIX: &str = "llm endpoint is not an SSE stream";

/// Keeps a diagnosis readable: the first frame of a non-SSE body is the useful
/// part, and a catch-all gateway can answer with a megabyte of HTML.
///
/// Shared with the engine transport (`llm::http`) so both paths truncate a
/// captured frame the same way.
pub(crate) fn truncate_for_diagnosis(text: &str) -> String {
    const LIMIT: usize = 200;
    let cleaned = text.trim().replace(['\r', '\n'], " ");
    if cleaned.is_empty() {
        return "<empty frame>".to_string();
    }
    let mut out: String = cleaned.chars().take(LIMIT).collect();
    if cleaned.chars().count() > LIMIT {
        out.push('…');
    }
    out
}

/// Explains a stream that produced no parseable frame.
///
/// The common cause in practice is a `base_url` that is not an API route — a
/// catch-all gateway answers 200 for anything — so the message names that
/// explicitly instead of letting the empty result read as "the model said
/// nothing". Shared by both transports.
pub(crate) fn empty_stream_error(
    content_type: &str,
    n_malformed: u32,
    first_malformed: Option<&str>,
) -> String {
    let mut detail: Vec<String> = Vec::new();
    if !content_type.is_empty() {
        detail.push(format!("content-type \"{content_type}\""));
    }
    detail.push(format!("{n_malformed} unparsable SSE frame(s)"));
    if let Some(sample) = first_malformed {
        detail.push(format!("first frame: {sample}"));
    }
    let detail = detail.join(", ");
    let advice = "check that the provider base_url is the API root, including the protocol version segment (e.g. /v1beta for google-genai)";
    // A catch-all gateway answers 200 with whatever it serves by default —
    // typically a directory listing or an error page. That body yields *no*
    // frames at all (no `data:` lines), so "unparsable frame count > 0" is not
    // the right test: the content type is what gives such a response away.
    let content_type_is_streamy = content_type.contains("event-stream")
        || content_type.contains("json")
        || content_type.contains("text/plain");
    if n_malformed > 0 || (!content_type.is_empty() && !content_type_is_streamy) {
        return format!(
            "{NOT_AN_SSE_ENDPOINT_PREFIX}: the endpoint answered 200 with a body that carries no parseable events ({detail}). It answered, but not with a chat stream — {advice}."
        );
    }
    format!(
        "llm stream produced no events ({detail}). The endpoint answered 200 with an empty body; {advice}."
    )
}

/// Extract the message of an in-band stream error frame, if the event is one.
///
/// Recognized shapes:
/// - Chat Completions gateways (one-api / new-api style): a top-level `error`
///   object alongside or instead of `choices`, e.g.
///   `{"error": {"message": "...", "type": "upstream_error"}}`.
/// - Anthropic Messages: `{"type": "error", "error": {"type": ..., "message": ...}}`.
/// - OpenAI Responses: `{"type": "error", "message": ..., "code": ...}`.
///
/// Returns `None` for every non-error event, including `"error": null`.
///
/// Shared with the engine's own HTTP transport (`llm::http`) so the two paths
/// cannot disagree about what an in-band error looks like — the engine path
/// shipped without any such check at all, which is how a gateway error frame
/// turned into a silently empty response.
pub(crate) fn extract_in_band_error(event: &Value) -> Option<String> {
    let top_error = event.get("error");
    if let Some(err) = top_error.filter(|v| v.is_object()) {
        if let Some(message) = err.get("message").and_then(|v| v.as_str())
            && !message.is_empty()
        {
            return Some(message.to_string());
        }
        return Some(err.to_string());
    }

    // OpenAI Responses API terminal failure: `{"type":"response.failed",
    // "response":{"error":{"message":...}}}`. Neither the engine transport
    // nor the napi decoder may normalize this into an empty completion.
    if event.get("type").and_then(|v| v.as_str()) == Some("response.failed") {
        let message = event
            .get("response")
            .and_then(|r| r.get("error"))
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .filter(|m| !m.is_empty())
            .map(|m| m.to_string())
            .unwrap_or_else(|| "response.failed".to_string());
        return Some(message);
    }

    if event.get("type").and_then(|v| v.as_str()) == Some("error") {
        if let Some(message) = top_error
            .filter(|v| v.is_object())
            .and_then(|err| err.get("message"))
            .and_then(|v| v.as_str())
            .filter(|m| !m.is_empty())
        {
            return Some(message.to_string());
        }
        if let Some(message) = event
            .get("message")
            .and_then(|v| v.as_str())
            .filter(|m| !m.is_empty())
        {
            return Some(message.to_string());
        }
        return Some(event.to_string());
    }

    None
}

// ── OpenAI Responses API decoder ─────────────────────────────────────────────

/// Decode one Google GenAI `streamGenerateContent` frame.
///
/// Unlike the decoders below this is **not** pure: the accumulator owns the
/// cross-frame state, because Google spreads `usageMetadata` and `finishReason`
/// over arbitrary frames instead of emitting a terminal one. Without this arm
/// every Gemini frame fell through to `_ => vec![]` — the stream produced zero
/// parts and zero errors, which is exactly what "the model returns nothing"
/// looks like from outside.
fn decode_google_event(
    accumulator: &mut google_genai::StreamAccumulator,
    event: &Value,
) -> Vec<StreamedPart> {
    let Some(delta) = accumulator.feed(event) else {
        return Vec::new();
    };
    match delta {
        StreamDelta::Text(text) => vec![StreamedPart {
            part_type: "text".into(),
            text: Some(text),
            ..Default::default()
        }],
        StreamDelta::Think(think) => vec![StreamedPart {
            part_type: "think".into(),
            think: Some(think),
            ..Default::default()
        }],
    }
}

fn decode_openai_responses_event(
    event: &Value,
    metadata: &mut StreamMetadata,
) -> Vec<StreamedPart> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match event_type {
        "response.output_text.delta" => {
            let text = event.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            vec![StreamedPart {
                part_type: "text".into(),
                text: Some(text.to_string()),
                ..Default::default()
            }]
        }

        "response.created" | "response.in_progress" => {
            if let Some(resp) = event.get("response")
                && let Some(id) = resp.get("id").and_then(|v| v.as_str())
            {
                metadata.response_id = Some(id.to_string());
            }
            vec![]
        }

        "response.output_item.added" => {
            let item = event.get("item").unwrap_or(&Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if item_type == "function_call" {
                let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let arguments = item
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let item_id = item.get("id").and_then(|v| v.as_str());
                let output_index = event.get("output_index").and_then(|v| v.as_u64());
                let stream_idx = item_id.map(|_| output_index.unwrap_or(0) as u32);

                vec![StreamedPart {
                    part_type: "function".into(),
                    id: Some(call_id.to_string()),
                    name: Some(name.to_string()),
                    arguments,
                    stream_index: stream_idx,
                    ..Default::default()
                }]
            } else {
                vec![]
            }
        }

        "response.function_call_arguments.delta" => {
            let delta = event.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            let output_index = event.get("output_index").and_then(|v| v.as_u64());
            vec![StreamedPart {
                part_type: "tool_call_part".into(),
                arguments_part: Some(delta.to_string()),
                stream_index: output_index.map(|i| i as u32),
                ..Default::default()
            }]
        }

        "response.reasoning_summary_part.added" => {
            vec![StreamedPart {
                part_type: "think".into(),
                think: Some(String::new()),
                ..Default::default()
            }]
        }

        "response.reasoning_summary_text.delta" => {
            let delta = event.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            vec![StreamedPart {
                part_type: "think".into(),
                think: Some(delta.to_string()),
                ..Default::default()
            }]
        }

        "response.output_item.done" => {
            let item = event.get("item").unwrap_or(&Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if item_type == "reasoning" {
                let encrypted = item
                    .get("encrypted_content")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                vec![StreamedPart {
                    part_type: "think".into(),
                    think: Some(String::new()),
                    encrypted,
                    ..Default::default()
                }]
            } else {
                vec![]
            }
        }

        "response.completed" | "response.incomplete" => {
            if let Some(resp) = event.get("response") {
                if let Some(id) = resp.get("id").and_then(|v| v.as_str()) {
                    metadata.response_id = Some(id.to_string());
                }
                if let Some(usage) = resp.get("usage") {
                    metadata.input_tokens = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    metadata.output_tokens = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    if let Some(details) = usage.get("input_tokens_details") {
                        metadata.cached_tokens = details
                            .get("cached_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32;
                    }
                }
                let status = resp.get("status").and_then(|v| v.as_str());
                metadata.finish_reason = status.map(|s| s.to_string());
            }
            vec![]
        }

        "error" => {
            let msg = event
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            vec![StreamedPart {
                part_type: "error".into(),
                text: Some(msg.to_string()),
                ..Default::default()
            }]
        }

        _ => vec![], // Unknown event types ignored
    }
}

// ── OpenAI Legacy (Chat Completions) decoder ─────────────────────────────────

fn decode_openai_legacy_event(event: &Value, metadata: &mut StreamMetadata) -> Vec<StreamedPart> {
    // Extract response id
    if let Some(id) = event.get("id").and_then(|v| v.as_str()) {
        metadata.response_id = Some(id.to_string());
    }

    // Extract usage if present
    if let Some(usage) = event.get("usage") {
        metadata.input_tokens = usage
            .get("prompt_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        metadata.output_tokens = usage
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        // DeepSeek proprietary cache counters: prompt_cache_hit_tokens /
        // prompt_cache_miss_tokens (top-level). Fall back to the Moonshot
        // top-level cached_tokens for Kimi-compatible endpoints.
        if let Some(hit) = usage
            .get("prompt_cache_hit_tokens")
            .and_then(|v| v.as_u64())
        {
            metadata.cached_tokens = hit as u32;
        } else {
            metadata.cached_tokens = usage
                .get("cached_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
        }
    }

    let choices = match event.get("choices").and_then(|v| v.as_array()) {
        Some(c) => c,
        None => return vec![],
    };

    let choice = match choices.first() {
        Some(c) => c,
        None => return vec![],
    };

    // Capture finish_reason
    if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
        metadata.finish_reason = Some(reason.to_string());
    }

    let delta = match choice.get("delta") {
        Some(d) => d,
        None => return vec![],
    };

    let mut parts = Vec::new();

    // Text content delta
    if let Some(content) = delta.get("content").and_then(|v| v.as_str())
        && !content.is_empty()
    {
        parts.push(StreamedPart {
            part_type: "text".into(),
            text: Some(content.to_string()),
            ..Default::default()
        });
    }

    // Tool calls delta
    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tool_calls {
            let index = tc.get("index").and_then(|v| v.as_u64()).map(|i| i as u32);
            let tc_id = tc.get("id").and_then(|v| v.as_str());
            let func = tc.get("function");

            if let Some(func) = func {
                let name = func.get("name").and_then(|v| v.as_str());
                let arguments = func.get("arguments").and_then(|v| v.as_str());

                if let Some(name) = name
                    && !name.is_empty()
                {
                    // New tool call header
                    parts.push(StreamedPart {
                        part_type: "function".into(),
                        id: tc_id.map(|s| s.to_string()),
                        name: Some(name.to_string()),
                        arguments: arguments.map(|s| s.to_string()),
                        stream_index: index,
                        ..Default::default()
                    });
                    continue;
                }

                if let Some(args) = arguments
                    && !args.is_empty()
                {
                    // Argument delta
                    parts.push(StreamedPart {
                        part_type: "tool_call_part".into(),
                        arguments_part: Some(args.to_string()),
                        stream_index: index,
                        ..Default::default()
                    });
                }
            }
        }
    }

    parts
}

// ── Anthropic Messages API decoder ───────────────────────────────────────────

fn decode_anthropic_event(event: &Value, metadata: &mut StreamMetadata) -> Vec<StreamedPart> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match event_type {
        "message_start" => {
            if let Some(message) = event.get("message") {
                if let Some(id) = message.get("id").and_then(|v| v.as_str()) {
                    metadata.response_id = Some(id.to_string());
                }
                if let Some(usage) = message.get("usage") {
                    metadata.input_tokens = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    metadata.output_tokens = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    metadata.cached_tokens = usage
                        .get("cache_read_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                }
            }
            vec![]
        }

        "content_block_start" => {
            let block = event.get("content_block").unwrap_or(&Value::Null);
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let block_index = event
                .get("index")
                .and_then(|v| v.as_u64())
                .map(|i| i as u32);

            match block_type {
                "text" => {
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    vec![StreamedPart {
                        part_type: "text".into(),
                        text: Some(text.to_string()),
                        ..Default::default()
                    }]
                }
                "thinking" => {
                    let thinking = block.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                    vec![StreamedPart {
                        part_type: "think".into(),
                        think: Some(thinking.to_string()),
                        ..Default::default()
                    }]
                }
                "redacted_thinking" => {
                    let data = block
                        .get("data")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    vec![StreamedPart {
                        part_type: "think".into(),
                        think: Some(String::new()),
                        encrypted: data,
                        ..Default::default()
                    }]
                }
                "tool_use" => {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    vec![StreamedPart {
                        part_type: "function".into(),
                        id: Some(id.to_string()),
                        name: Some(name.to_string()),
                        arguments: Some(String::new()),
                        stream_index: block_index,
                        ..Default::default()
                    }]
                }
                _ => vec![],
            }
        }

        "content_block_delta" => {
            let delta = event.get("delta").unwrap_or(&Value::Null);
            let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let block_index = event
                .get("index")
                .and_then(|v| v.as_u64())
                .map(|i| i as u32);

            match delta_type {
                "text_delta" => {
                    let text = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    vec![StreamedPart {
                        part_type: "text".into(),
                        text: Some(text.to_string()),
                        ..Default::default()
                    }]
                }
                "thinking_delta" => {
                    let thinking = delta.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
                    vec![StreamedPart {
                        part_type: "think".into(),
                        think: Some(thinking.to_string()),
                        ..Default::default()
                    }]
                }
                "input_json_delta" => {
                    let partial_json = delta
                        .get("partial_json")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    vec![StreamedPart {
                        part_type: "tool_call_part".into(),
                        arguments_part: Some(partial_json.to_string()),
                        stream_index: block_index,
                        ..Default::default()
                    }]
                }
                "signature_delta" => {
                    let signature = delta
                        .get("signature")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    vec![StreamedPart {
                        part_type: "think".into(),
                        think: Some(String::new()),
                        encrypted: signature,
                        ..Default::default()
                    }]
                }
                _ => vec![],
            }
        }

        "message_delta" => {
            if let Some(usage) = event.get("usage") {
                if let Some(output) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                    metadata.output_tokens = output as u32;
                }
                if let Some(cached) = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                {
                    metadata.cached_tokens = cached as u32;
                }
                if let Some(input) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
                    metadata.input_tokens = input as u32;
                }
            }
            if let Some(delta) = event.get("delta")
                && let Some(reason) = delta.get("stop_reason").and_then(|v| v.as_str())
            {
                metadata.finish_reason = Some(reason.to_string());
            }
            vec![]
        }

        "content_block_stop" | "message_stop" => vec![],

        _ => vec![],
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ══════════════════════════════════════════════════════════════════════
    // Google GenAI decoding
    // ══════════════════════════════════════════════════════════════════════

    /// A Gemini frame must yield a part. Before the `google` arm existed every
    /// frame fell through to `_ => vec![]`, so the stream produced nothing at
    /// all — and no error either.
    #[test]
    fn google_frame_decodes_into_a_text_part() {
        let mut accumulator = google_genai::StreamAccumulator::new();
        let frame = json!({
            "candidates": [{
                "content": { "parts": [{ "text": "Hello" }] },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 11,
                "candidatesTokenCount": 5,
                "cachedContentTokenCount": 3
            }
        });

        let parts = decode_google_event(&mut accumulator, &frame);
        assert_eq!(parts.len(), 1, "parts: {parts:?}");
        assert_eq!(parts[0].part_type, "text");
        assert_eq!(parts[0].text.as_deref(), Some("Hello"));

        // Usage and the finish reason ride on the stream, so they only surface
        // from `finish()` — that is why the accumulator outlives the loop.
        let final_response = accumulator.finish();
        assert_eq!(final_response.usage.input_tokens, 11);
        assert_eq!(final_response.usage.output_tokens, 5);
        assert_eq!(final_response.usage.input_cache_read, 3);
        assert_eq!(final_response.finish_reason.as_deref(), Some("stop"));
    }

    /// `thought: true` parts are reasoning, not the visible answer.
    #[test]
    fn google_thought_frames_decode_into_think_parts() {
        let mut accumulator = google_genai::StreamAccumulator::new();
        let frame = json!({
            "candidates": [{
                "content": { "parts": [{ "text": "let me think", "thought": true }] }
            }]
        });

        let parts = decode_google_event(&mut accumulator, &frame);
        assert_eq!(parts.len(), 1, "parts: {parts:?}");
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some("let me think"));
        assert_eq!(parts[0].text, None);
    }

    #[test]
    fn is_google_provider_covers_every_spelling() {
        assert!(is_google_provider("google"));
        assert!(is_google_provider("google-genai"));
        assert!(is_google_provider("gemini"));
        assert!(!is_google_provider("openai"));
        assert!(!is_google_provider("anthropic"));
    }

    // ══════════════════════════════════════════════════════════════════════
    // In-band error detection tests
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_in_band_error_gateway_error_object_message() {
        let event = json!({
            "error": {
                "message": "Upstream request failed: [1210] Invalid API parameter",
                "type": "upstream_error",
                "code": 1210
            }
        });
        assert_eq!(
            extract_in_band_error(&event).as_deref(),
            Some("Upstream request failed: [1210] Invalid API parameter")
        );
    }

    #[test]
    fn test_in_band_error_gateway_error_object_without_message() {
        let event = json!({ "error": { "code": "internal" } });
        let extracted = extract_in_band_error(&event);
        assert!(extracted.is_some());
        assert!(extracted.unwrap().contains("internal"));
    }

    #[test]
    fn test_in_band_error_anthropic_shape() {
        let event = json!({
            "type": "error",
            "error": { "type": "overloaded_error", "message": "Overloaded" }
        });
        assert_eq!(extract_in_band_error(&event).as_deref(), Some("Overloaded"));
    }

    #[test]
    fn test_in_band_error_responses_shape() {
        let event = json!({ "type": "error", "message": "Rate limit exceeded" });
        assert_eq!(
            extract_in_band_error(&event).as_deref(),
            Some("Rate limit exceeded")
        );
    }

    #[test]
    fn test_in_band_error_non_error_events_ignored() {
        assert_eq!(extract_in_band_error(&json!({ "error": null })), None);
        assert_eq!(
            extract_in_band_error(&json!({
                "id": "chatcmpl_1",
                "choices": [{ "delta": { "content": "Hi" }, "finish_reason": null }]
            })),
            None
        );
        assert_eq!(extract_in_band_error(&json!({ "type": "ping" })), None);
        assert_eq!(
            extract_in_band_error(&json!({ "type": "message_stop" })),
            None
        );
        assert_eq!(extract_in_band_error(&json!({})), None);
    }

    // ══════════════════════════════════════════════════════════════════════
    // OpenAI Responses API decoder tests
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_openai_responses_text_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "type": "response.output_text.delta", "delta": "Hello" });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "text");
        assert_eq!(parts[0].text.as_deref(), Some("Hello"));
    }

    #[test]
    fn test_openai_responses_text_delta_empty() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "type": "response.output_text.delta", "delta": "" });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].text.as_deref(), Some(""));
    }

    #[test]
    fn test_openai_responses_function_call() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "type": "function_call",
                "id": "item_1",
                "call_id": "call_abc",
                "name": "Read",
                "arguments": ""
            }
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "function");
        assert_eq!(parts[0].id.as_deref(), Some("call_abc"));
        assert_eq!(parts[0].name.as_deref(), Some("Read"));
        assert_eq!(parts[0].arguments.as_deref(), Some(""));
        assert_eq!(parts[0].stream_index, Some(0));
    }

    #[test]
    fn test_openai_responses_function_call_arguments_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.function_call_arguments.delta",
            "delta": "{\"path\":",
            "item_id": "item_1",
            "output_index": 2
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "tool_call_part");
        assert_eq!(parts[0].arguments_part.as_deref(), Some("{\"path\":"));
        assert_eq!(parts[0].stream_index, Some(2));
    }

    #[test]
    fn test_openai_responses_reasoning_summary_added() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "type": "response.reasoning_summary_part.added" });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some(""));
    }

    #[test]
    fn test_openai_responses_reasoning_summary_delta() {
        let mut meta = StreamMetadata::default();
        let event =
            json!({ "type": "response.reasoning_summary_text.delta", "delta": "Let me think..." });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some("Let me think..."));
    }

    #[test]
    fn test_openai_responses_output_item_done_reasoning() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "type": "reasoning",
                "encrypted_content": "enc_abc123"
            }
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].encrypted.as_deref(), Some("enc_abc123"));
    }

    #[test]
    fn test_openai_responses_output_item_done_non_reasoning() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": { "type": "message" }
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_openai_responses_created_captures_id() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.created",
            "response": { "id": "resp_early" }
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert!(parts.is_empty());
        assert_eq!(meta.response_id.as_deref(), Some("resp_early"));
    }

    #[test]
    fn test_openai_responses_in_progress_captures_id() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.in_progress",
            "response": { "id": "resp_mid" }
        });
        decode_openai_responses_event(&event, &mut meta);
        assert_eq!(meta.response_id.as_deref(), Some("resp_mid"));
    }

    #[test]
    fn test_openai_responses_completed() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.completed",
            "response": {
                "id": "resp_123",
                "status": "completed",
                "usage": { "input_tokens": 100, "output_tokens": 50, "input_tokens_details": { "cached_tokens": 20 } }
            }
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert!(parts.is_empty());
        assert_eq!(meta.response_id.as_deref(), Some("resp_123"));
        assert_eq!(meta.input_tokens, 100);
        assert_eq!(meta.output_tokens, 50);
        assert_eq!(meta.cached_tokens, 20);
        assert_eq!(meta.finish_reason.as_deref(), Some("completed"));
    }

    #[test]
    fn test_openai_responses_incomplete() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.incomplete",
            "response": {
                "id": "resp_trunc",
                "status": "incomplete",
                "usage": { "input_tokens": 80, "output_tokens": 4096 }
            }
        });
        decode_openai_responses_event(&event, &mut meta);
        assert_eq!(meta.finish_reason.as_deref(), Some("incomplete"));
        assert_eq!(meta.output_tokens, 4096);
    }

    #[test]
    fn test_openai_responses_error_event() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "error",
            "message": "Rate limit exceeded",
            "code": "rate_limit_exceeded"
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "error");
        assert_eq!(parts[0].text.as_deref(), Some("Rate limit exceeded"));
    }

    #[test]
    fn test_openai_responses_unknown_event_ignored() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "type": "response.some_future_event", "data": 42 });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_openai_responses_non_function_output_item_ignored() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "type": "message", "content": [] }
        });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    // ══════════════════════════════════════════════════════════════════════
    // OpenAI Legacy (Chat Completions) decoder tests
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_openai_legacy_text_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-abc",
            "choices": [{ "delta": { "content": "World" }, "finish_reason": null }]
        });
        let parts = decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "text");
        assert_eq!(parts[0].text.as_deref(), Some("World"));
        assert_eq!(meta.response_id.as_deref(), Some("chatcmpl-abc"));
    }

    #[test]
    fn test_openai_legacy_tool_call_header() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-x",
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_1",
                        "function": { "name": "Grep", "arguments": "{\"q\":" }
                    }]
                },
                "finish_reason": null
            }]
        });
        let parts = decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "function");
        assert_eq!(parts[0].name.as_deref(), Some("Grep"));
        assert_eq!(parts[0].id.as_deref(), Some("call_1"));
        assert_eq!(parts[0].arguments.as_deref(), Some("{\"q\":"));
        assert_eq!(parts[0].stream_index, Some(0));
    }

    #[test]
    fn test_openai_legacy_tool_call_argument_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-x",
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "function": { "arguments": "\"foo\"}" }
                    }]
                },
                "finish_reason": null
            }]
        });
        let parts = decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "tool_call_part");
        assert_eq!(parts[0].arguments_part.as_deref(), Some("\"foo\"}"));
        assert_eq!(parts[0].stream_index, Some(0));
    }

    #[test]
    fn test_openai_legacy_finish_reason_stop() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-done",
            "choices": [{ "delta": {}, "finish_reason": "stop" }]
        });
        decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(meta.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn test_openai_legacy_finish_reason_tool_calls() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-tc",
            "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
        });
        decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(meta.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn test_openai_legacy_usage_extraction() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-u",
            "choices": [{ "delta": {}, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 55, "completion_tokens": 30 }
        });
        decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(meta.input_tokens, 55);
        assert_eq!(meta.output_tokens, 30);
        assert_eq!(meta.cached_tokens, 0);
    }

    #[test]
    fn test_openai_legacy_usage_extraction_deepseek_cache_counters() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-u",
            "choices": [{ "delta": {}, "finish_reason": "stop" }],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "prompt_cache_hit_tokens": 70,
                "prompt_cache_miss_tokens": 30
            }
        });
        decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(meta.input_tokens, 100);
        assert_eq!(meta.output_tokens, 20);
        assert_eq!(meta.cached_tokens, 70);
    }

    #[test]
    fn test_openai_legacy_usage_extraction_moonshot_cached_tokens_fallback() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-u",
            "choices": [{ "delta": {}, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 55, "completion_tokens": 30, "cached_tokens": 20 }
        });
        decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(meta.input_tokens, 55);
        assert_eq!(meta.cached_tokens, 20);
    }

    #[test]
    fn test_openai_legacy_empty_choices() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "id": "chatcmpl-e", "choices": [] });
        let parts = decode_openai_legacy_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_openai_legacy_empty_content_ignored() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-x",
            "choices": [{ "delta": { "content": "" }, "finish_reason": null }]
        });
        let parts = decode_openai_legacy_event(&event, &mut meta);
        assert!(parts.is_empty()); // Empty string content is not emitted
    }

    #[test]
    fn test_openai_legacy_multiple_parallel_tool_calls() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "id": "chatcmpl-p",
            "choices": [{
                "delta": {
                    "tool_calls": [
                        { "index": 0, "id": "call_a", "function": { "name": "Read", "arguments": "" } },
                        { "index": 1, "id": "call_b", "function": { "name": "Grep", "arguments": "" } }
                    ]
                },
                "finish_reason": null
            }]
        });
        let parts = decode_openai_legacy_event(&event, &mut meta);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].name.as_deref(), Some("Read"));
        assert_eq!(parts[0].stream_index, Some(0));
        assert_eq!(parts[1].name.as_deref(), Some("Grep"));
        assert_eq!(parts[1].stream_index, Some(1));
    }

    #[test]
    fn test_openai_legacy_no_choices_field() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "id": "chatcmpl-x" });
        let parts = decode_openai_legacy_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    // ══════════════════════════════════════════════════════════════════════
    // Anthropic Messages API decoder tests
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_anthropic_message_start() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "message_start",
            "message": {
                "id": "msg_abc",
                "usage": { "input_tokens": 200, "output_tokens": 0, "cache_read_input_tokens": 50 }
            }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
        assert_eq!(meta.response_id.as_deref(), Some("msg_abc"));
        assert_eq!(meta.input_tokens, 200);
        assert_eq!(meta.cached_tokens, 50);
    }

    #[test]
    fn test_anthropic_text_block_start() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "text", "text": "Hi" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "text");
        assert_eq!(parts[0].text.as_deref(), Some("Hi"));
    }

    #[test]
    fn test_anthropic_thinking_block_start() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "thinking", "thinking": "Let me analyze" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some("Let me analyze"));
    }

    #[test]
    fn test_anthropic_redacted_thinking_block_start() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "redacted_thinking", "data": "encrypted_data_here" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some(""));
        assert_eq!(parts[0].encrypted.as_deref(), Some("encrypted_data_here"));
    }

    #[test]
    fn test_anthropic_text_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "Hello" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "text");
        assert_eq!(parts[0].text.as_deref(), Some("Hello"));
    }

    #[test]
    fn test_anthropic_thinking_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "reasoning step" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some("reasoning step"));
    }

    #[test]
    fn test_anthropic_signature_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "signature_delta", "signature": "sig_xyz" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "think");
        assert_eq!(parts[0].think.as_deref(), Some(""));
        assert_eq!(parts[0].encrypted.as_deref(), Some("sig_xyz"));
    }

    #[test]
    fn test_anthropic_tool_use_start() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_start",
            "index": 1,
            "content_block": { "type": "tool_use", "id": "tu_1", "name": "Read" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "function");
        assert_eq!(parts[0].id.as_deref(), Some("tu_1"));
        assert_eq!(parts[0].name.as_deref(), Some("Read"));
        assert_eq!(parts[0].stream_index, Some(1));
        assert_eq!(parts[0].arguments.as_deref(), Some(""));
    }

    #[test]
    fn test_anthropic_input_json_delta() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "tool_call_part");
        assert_eq!(parts[0].arguments_part.as_deref(), Some("{\"path\":"));
        assert_eq!(parts[0].stream_index, Some(1));
    }

    #[test]
    fn test_anthropic_message_delta_stop() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 42 }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
        assert_eq!(meta.finish_reason.as_deref(), Some("end_turn"));
        assert_eq!(meta.output_tokens, 42);
    }

    #[test]
    fn test_anthropic_message_delta_tool_use() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "message_delta",
            "delta": { "stop_reason": "tool_use" },
            "usage": { "output_tokens": 100 }
        });
        decode_anthropic_event(&event, &mut meta);
        assert_eq!(meta.finish_reason.as_deref(), Some("tool_use"));
        assert_eq!(meta.output_tokens, 100);
    }

    #[test]
    fn test_anthropic_message_delta_with_cache_tokens() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": {
                "output_tokens": 55,
                "input_tokens": 300,
                "cache_read_input_tokens": 80
            }
        });
        decode_anthropic_event(&event, &mut meta);
        assert_eq!(meta.output_tokens, 55);
        assert_eq!(meta.input_tokens, 300);
        assert_eq!(meta.cached_tokens, 80);
    }

    #[test]
    fn test_anthropic_content_block_stop_no_op() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "type": "content_block_stop", "index": 0 });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_anthropic_message_stop_no_op() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "type": "message_stop" });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_anthropic_unknown_event_ignored() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "type": "ping" });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_anthropic_unknown_content_block_type_ignored() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "future_type" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_anthropic_unknown_delta_type_ignored() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "future_delta_type" }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    // ══════════════════════════════════════════════════════════════════════
    // Cross-provider / edge case tests
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_metadata_accumulates_across_events() {
        let mut meta = StreamMetadata::default();

        // First event sets response_id
        let event1 = json!({ "type": "response.created", "response": { "id": "resp_1" } });
        decode_openai_responses_event(&event1, &mut meta);
        assert_eq!(meta.response_id.as_deref(), Some("resp_1"));

        // Completion event updates id and adds usage
        let event2 = json!({
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "status": "completed",
                "usage": { "input_tokens": 50, "output_tokens": 25 }
            }
        });
        decode_openai_responses_event(&event2, &mut meta);
        assert_eq!(meta.input_tokens, 50);
        assert_eq!(meta.output_tokens, 25);
        assert_eq!(meta.finish_reason.as_deref(), Some("completed"));
    }

    #[test]
    fn test_missing_type_field_returns_empty() {
        let mut meta = StreamMetadata::default();
        let event = json!({ "data": "something" });
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert!(parts.is_empty());
    }

    #[test]
    fn test_null_event_returns_empty() {
        let mut meta = StreamMetadata::default();
        let event = Value::Null;
        let parts = decode_openai_responses_event(&event, &mut meta);
        assert!(parts.is_empty());
        let parts2 = decode_anthropic_event(&event, &mut meta);
        assert!(parts2.is_empty());
        let parts3 = decode_openai_legacy_event(&event, &mut meta);
        assert!(parts3.is_empty());
    }

    // ══════════════════════════════════════════════════════════════════════
    // End-to-end stream guards
    //
    // These drive the real transport against a loopback server: the failure
    // modes being guarded (empty body, non-SSE body, in-band error, a dropped
    // Gemini tool call) only exist end to end.
    // ══════════════════════════════════════════════════════════════════════

    /// Serve a single 200 response per connection with a fixed body.
    async fn spawn_http_server(
        content_type: &'static str,
        body: &'static str,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (addr, handle)
    }

    fn stream_config(url: String, provider: &str) -> LlmStreamConfig {
        LlmStreamConfig {
            provider: provider.to_string(),
            url,
            api_key: "test-key".to_string(),
            request_body: "{}".to_string(),
            timeout_ms: 10_000,
            extra_headers: Vec::new(),
        }
    }

    async fn collect_events(config: &LlmStreamConfig) -> Result<Vec<StreamEvent>, String> {
        let mut events = Vec::new();
        run_llm_stream_with(config, |event| events.push(event)).await?;
        Ok(events)
    }

    fn error_event(events: &[StreamEvent]) -> Option<String> {
        events.iter().find_map(|event| match event {
            StreamEvent::Error(message) => Some(message.clone()),
            _ => None,
        })
    }

    fn has_done(events: &[StreamEvent]) -> bool {
        events
            .iter()
            .any(|event| matches!(event, StreamEvent::Done(_)))
    }

    /// A 200 whose body is not SSE must surface an error and must not be
    /// followed by `Done` — the caller reads `Done` with zero parts as "the
    /// model returned nothing".
    #[tokio::test]
    async fn non_sse_body_emits_an_error_instead_of_done() {
        let (addr, server) = spawn_http_server("text/html", "<html>index of /</html>").await;
        let config = stream_config(format!("http://{addr}/stream"), "openai-legacy");
        let events = collect_events(&config)
            .await
            .expect("transport itself succeeded");
        server.abort();

        let error = error_event(&events).expect("a non-SSE body must produce an error event");
        assert!(
            error.starts_with(NOT_AN_SSE_ENDPOINT_PREFIX),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("text/html"),
            "the diagnosis must name the type: {error}"
        );
        assert!(!has_done(&events), "a failed stream must not emit Done");
    }

    /// An empty 200 body is an error too.
    #[tokio::test]
    async fn empty_body_emits_an_error_instead_of_done() {
        let (addr, server) = spawn_http_server("text/event-stream", "").await;
        let config = stream_config(format!("http://{addr}/stream"), "openai-legacy");
        let events = collect_events(&config)
            .await
            .expect("transport itself succeeded");
        server.abort();

        let error = error_event(&events).expect("an empty body must produce an error event");
        assert!(
            error.contains("produced no events"),
            "unexpected error: {error}"
        );
        assert!(!has_done(&events), "a failed stream must not emit Done");
    }

    /// The guards must not break a normal stream.
    #[tokio::test]
    async fn a_normal_stream_emits_parts_then_done() {
        let (addr, server) = spawn_http_server(
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n",
        )
        .await;
        let config = stream_config(format!("http://{addr}/stream"), "openai-legacy");
        let events = collect_events(&config)
            .await
            .expect("a normal stream must succeed");
        server.abort();

        assert!(
            events.iter().any(
                |event| matches!(event, StreamEvent::Part(p) if p.text.as_deref() == Some("hi"))
            ),
            "the text part must be emitted: {events:?}"
        );
        assert!(has_done(&events), "a normal stream must emit Done");
    }

    /// An in-band provider error ends the stream without a trailing `Done`.
    #[tokio::test]
    async fn in_band_error_ends_the_stream_without_done() {
        let (addr, server) = spawn_http_server(
            "text/event-stream",
            "data: {\"error\":{\"message\":\"boom\"}}\n\n",
        )
        .await;
        let config = stream_config(format!("http://{addr}/stream"), "openai-legacy");
        let events = collect_events(&config)
            .await
            .expect("transport itself succeeded");
        server.abort();

        let error = error_event(&events).expect("an in-band error must be surfaced");
        assert!(
            error.contains("boom"),
            "the provider message must survive: {error}"
        );
        assert!(!has_done(&events), "an errored stream must not emit Done");
    }

    /// Gemini function calls only materialize when the accumulator is finalized;
    /// they were dropped entirely, so the agent could not act on one.
    #[tokio::test]
    async fn google_tool_calls_are_emitted_as_function_parts() {
        let (addr, server) = spawn_http_server(
            "text/event-stream",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"Grep\",\"args\":{\"query\":\"x\"},\"id\":\"fc_1\"},\"thoughtSignature\":\"sig-x\"}]}}]}\n\n",
        )
        .await;
        let config = stream_config(format!("http://{addr}/v1beta/stream"), "google-genai");
        let events = collect_events(&config)
            .await
            .expect("a google stream must succeed");
        server.abort();

        let call = events
            .iter()
            .find_map(|event| match event {
                StreamEvent::Part(part) if part.part_type == "function" => Some(part),
                _ => None,
            })
            .expect("a function part must be emitted");
        assert_eq!(call.name.as_deref(), Some("Grep"));
        assert_eq!(call.id.as_deref(), Some("fc_1"));
        assert_eq!(call.arguments.as_deref(), Some("{\"query\":\"x\"}"));
        assert!(
            has_done(&events),
            "the stream must still terminate with Done"
        );
    }

    /// A google URL without a version segment is refused up front instead of
    /// being answered by a catch-all route and looking like an empty answer.
    #[tokio::test]
    async fn google_url_without_a_version_segment_is_refused() {
        let config = stream_config(
            "http://127.0.0.1:1/models/x:streamGenerateContent".into(),
            "google-genai",
        );
        let error = run_llm_stream_with(&config, |_| {})
            .await
            .expect_err("a versionless google url must be refused");
        assert!(error.contains("no API version segment"), "{error}");
    }
}
