//! LLM Streaming — HTTP SSE streaming client with provider-specific event decoders.
//!
//! Handles the full pipeline: HTTP POST → SSE byte stream → event parsing →
//! provider-specific decoding → StreamedPart output.
//!
//! Supported providers:
//! - OpenAI Responses API (`openai-responses`)
//! - OpenAI Chat Completions / Legacy (`openai-legacy`)
//! - Anthropic Messages API (`anthropic`)

use std::time::Duration;

use eventsource_stream::Eventsource as EvensourceExt;
use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, USER_AGENT,
};
use serde_json::Value;

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
    pub cache_creation_tokens: u32,
    pub trace_id: Option<String>,
}

/// Events emitted by the stream processor.
#[derive(Debug)]
pub enum StreamEvent {
    Part(StreamedPart),
    Done(StreamMetadata),
    Error(String),
}

// ── Timeouts ─────────────────────────────────────────────────────────────────

/// Budget for establishing the TCP+TLS connection, kept separate from the
/// request budget so a host that accepts nothing cannot hold a whole turn.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Lower bound for the overall request budget. `timeout_ms` carries idle
/// semantics (see `idle_event_timeout`), so it must not double as the
/// wall-clock ceiling of a healthy long stream.
const MIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// How long the stream may go without a single SSE event before it is treated
/// as dead. This is the `timeout_ms` the caller passed: the SDK paths give
/// 120 s meaning "no data for 120 s", not "the whole response in 120 s", and a
/// healthy slow stream must not be cut off mid-answer.
fn idle_event_timeout(timeout_ms: u64) -> Duration {
    Duration::from_millis(timeout_ms)
}

/// Overall request ceiling — only guards against a stream that never ends.
fn request_timeout(timeout_ms: u64) -> Duration {
    idle_event_timeout(timeout_ms).max(MIN_REQUEST_TIMEOUT)
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
    let idle_timeout = idle_event_timeout(config.timeout_ms);
    let timeout = request_timeout(config.timeout_ms);

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

    // Make the HTTP request
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let response = client
        .post(&config.url)
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

    // Read SSE stream. Each `next()` gets the idle budget on its own: a stream
    // that keeps sending events may run for hours, while one that goes silent
    // for `idle_timeout` is dead whatever the wall clock says.
    let bytes_stream = response.bytes_stream();
    let mut sse_stream = bytes_stream.eventsource();

    loop {
        let result = match tokio::time::timeout(idle_timeout, sse_stream.next()).await {
            Ok(Some(result)) => result,
            // The stream ended cleanly.
            Ok(None) => break,
            Err(_) => {
                emit(StreamEvent::Error(format!(
                    "SSE stream idle for {}s: no event received",
                    idle_timeout.as_secs_f64()
                )));
                break;
            }
        };
        match result {
            Ok(event) => {
                let data = event.data;
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }

                let parsed: Value = match serde_json::from_str(&data) {
                    Ok(v) => v,
                    Err(_) => continue, // Skip malformed JSON
                };

                // Gateways and providers report mid-stream failures as in-band
                // error frames (Chat Completions: a top-level `error` object;
                // Anthropic / Responses: a `type: "error"` event). Surface them
                // as stream errors instead of silently ending with whatever
                // partial content arrived — the SDK path throws on these too.
                if let Some(message) = extract_in_band_error(&parsed) {
                    emit(StreamEvent::Error(format!("Provider stream error: {message}")));
                    break;
                }

                let decoded = match config.provider.as_str() {
                    "openai-responses" => decode_openai_responses_event(&parsed, &mut metadata),
                    "openai-legacy" => decode_openai_legacy_event(&parsed, &mut metadata),
                    "anthropic" => decode_anthropic_event(&parsed, &mut metadata),
                    _ => vec![],
                };

                for part in decoded {
                    emit(StreamEvent::Part(part));
                }
            }
            Err(e) => {
                emit(StreamEvent::Error(format!("SSE stream error: {e}")));
                break;
            }
        }
    }

    emit(StreamEvent::Done(metadata));
    Ok(())
}

// ── In-band error detection ──────────────────────────────────────────────────

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
fn extract_in_band_error(event: &Value) -> Option<String> {
    let top_error = event.get("error");
    if let Some(err) = top_error.filter(|v| v.is_object()) {
        if let Some(message) = err.get("message").and_then(|v| v.as_str()) {
            if !message.is_empty() {
                return Some(message.to_string());
            }
        }
        return Some(err.to_string());
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
            if let Some(resp) = event.get("response") {
                if let Some(id) = resp.get("id").and_then(|v| v.as_str()) {
                    metadata.response_id = Some(id.to_string());
                }
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
    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
        if !content.is_empty() {
            parts.push(StreamedPart {
                part_type: "text".into(),
                text: Some(content.to_string()),
                ..Default::default()
            });
        }
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

                if let Some(name) = name {
                    if !name.is_empty() {
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
                }

                if let Some(args) = arguments {
                    if !args.is_empty() {
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
                    if let Some(creation) = usage
                        .get("cache_creation_input_tokens")
                        .and_then(|v| v.as_u64())
                    {
                        metadata.cache_creation_tokens = creation as u32;
                    }
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
                if let Some(creation) = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_u64())
                {
                    metadata.cache_creation_tokens = creation as u32;
                }
            }
            if let Some(delta) = event.get("delta") {
                if let Some(reason) = delta.get("stop_reason").and_then(|v| v.as_str()) {
                    metadata.finish_reason = Some(reason.to_string());
                }
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
        assert_eq!(extract_in_band_error(&json!({ "type": "message_stop" })), None);
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
                "usage": {
                    "input_tokens": 200,
                    "output_tokens": 0,
                    "cache_read_input_tokens": 50,
                    "cache_creation_input_tokens": 7
                }
            }
        });
        let parts = decode_anthropic_event(&event, &mut meta);
        assert!(parts.is_empty());
        assert_eq!(meta.response_id.as_deref(), Some("msg_abc"));
        assert_eq!(meta.input_tokens, 200);
        assert_eq!(meta.cached_tokens, 50);
        assert_eq!(meta.cache_creation_tokens, 7);
    }

    #[test]
    fn test_anthropic_message_delta_cache_creation() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": {
                "output_tokens": 55,
                "input_tokens": 300,
                "cache_read_input_tokens": 80,
                "cache_creation_input_tokens": 12
            }
        });
        decode_anthropic_event(&event, &mut meta);
        assert_eq!(meta.cache_creation_tokens, 12);
    }

    #[test]
    fn test_anthropic_message_start_without_cache_creation_leaves_zero() {
        let mut meta = StreamMetadata::default();
        let event = json!({
            "type": "message_start",
            "message": {
                "id": "msg_no_creation",
                "usage": { "input_tokens": 5, "output_tokens": 0 }
            }
        });
        decode_anthropic_event(&event, &mut meta);
        assert_eq!(meta.cache_creation_tokens, 0);
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
    // Timeout semantics (fake SSE server)
    // ══════════════════════════════════════════════════════════════════════
    //
    // A stream that keeps sending events must survive far longer than the idle
    // budget, while one that goes silent must fail. The fake server below is a
    // plain std TcpListener on a background thread: no extra dev-dependency.

    struct FakeSseServer {
        addr: String,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl FakeSseServer {
        /// `script` is called with a write handle per accepted connection; the
        /// test server writes raw HTTP bytes so the SSE decode path is real.
        fn start<F>(script: F) -> Self
        where
            F: FnOnce(&mut dyn std::io::Write) + Send + 'static,
        {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = format!("http://{}", listener.local_addr().unwrap());
            let handle = std::thread::spawn(move || {
                if let Ok((mut socket, _)) = listener.accept() {
                    // Drain the request head before answering.
                    let mut buf = [0u8; 4096];
                    let _ = std::io::Read::read(&mut socket, &mut buf);
                    let mut w = socket;
                    let _ = std::io::Write::write_all(
                        &mut w,
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                          Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
                    );
                    let _ = std::io::Write::flush(&mut w);
                    script(&mut w);
                }
            });
            FakeSseServer {
                addr,
                handle: Some(handle),
            }
        }
    }

    impl Drop for FakeSseServer {
        fn drop(&mut self) {
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    fn sse_data_event(w: &mut dyn std::io::Write, payload: &str) {
        let _ = write!(w, "data: {payload}\n\n");
        let _ = w.flush();
    }

    fn legacy_text_event(id: &str, text: &str) -> String {
        json!({
            "id": id,
            "choices": [{ "delta": { "content": text }, "finish_reason": null }]
        })
        .to_string()
    }

    fn stream_config(url: String, timeout_ms: u64) -> LlmStreamConfig {
        LlmStreamConfig {
            provider: "openai-legacy".to_string(),
            url,
            api_key: "test-key".to_string(),
            request_body: "{}".to_string(),
            timeout_ms,
            extra_headers: vec![],
        }
    }

    fn run_buffered(config: &LlmStreamConfig) -> Result<Vec<StreamEvent>, String> {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(run_llm_stream(config))
    }

    fn error_message(events: &[StreamEvent]) -> Option<String> {
        events.iter().find_map(|e| match e {
            StreamEvent::Error(msg) => Some(msg.clone()),
            _ => None,
        })
    }

    fn text_of(events: &[StreamEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Part(p) => p.text.clone(),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn test_stream_silent_after_first_event_times_out_on_idle() {
        // One event, then silence. The idle budget (300 ms here) must fire even
        // though the whole request is nowhere near its wall-clock ceiling.
        let idle_ms = 300u64;
        let server = FakeSseServer::start(move |w| {
            sse_data_event(w, &legacy_text_event("chatcmpl_1", "partial"));
            std::thread::sleep(Duration::from_millis(2_000));
        });

        let started = std::time::Instant::now();
        let events = run_buffered(&stream_config(server.addr.clone(), idle_ms)).unwrap();
        let elapsed = started.elapsed();

        let msg = error_message(&events).expect("a silent stream must report an idle timeout");
        assert!(
            msg.contains("idle"),
            "error should name the idle timeout, got: {msg}"
        );
        assert_eq!(text_of(&events), "partial");
        assert!(
            elapsed < Duration::from_millis(1_500),
            "idle timeout should fire near {idle_ms}ms, took {elapsed:?}"
        );
    }

    #[test]
    fn test_slow_stream_longer_than_idle_budget_completes() {
        // Events every idle/2 for 5x the idle budget: a healthy slow stream.
        // With `timeout_ms` as a whole-request deadline this is cut off; with
        // idle semantics every event resets the budget and it finishes.
        let idle_ms = 300u64;
        let gap_ms = idle_ms / 2;
        let event_count = 10usize;
        let server = FakeSseServer::start(move |w| {
            for i in 0..event_count {
                sse_data_event(w, &legacy_text_event("chatcmpl_1", &format!("{i}")));
                if i + 1 < event_count {
                    std::thread::sleep(Duration::from_millis(gap_ms));
                }
            }
        });

        let started = std::time::Instant::now();
        let events = run_buffered(&stream_config(server.addr.clone(), idle_ms)).unwrap();
        let elapsed = started.elapsed();

        assert_eq!(
            error_message(&events),
            None,
            "a slow but live stream must not be cut off"
        );
        let expected: String = (0..event_count).map(|i| i.to_string()).collect();
        assert_eq!(text_of(&events), expected);
        assert!(
            elapsed > Duration::from_millis(idle_ms * 4),
            "the stream should have taken longer than the idle budget, took {elapsed:?}"
        );
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Done(_))));
    }

}
