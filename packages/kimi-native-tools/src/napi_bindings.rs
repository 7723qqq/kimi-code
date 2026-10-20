/// NAPI bindings — exposes the LLM SSE streaming bindings to Node.js.
use crate::llm_stream;
use napi::bindgen_prelude::JsFunction;
use napi_derive::napi;

// ============================================================================
// LLM Stream — HTTP SSE streaming with provider-specific event decoding
// ============================================================================

/// Configuration for `native_llm_stream`.
#[napi(object)]
pub struct NativeLlmStreamConfig {
    pub provider: String,
    pub url: String,
    pub api_key: String,
    /// Kept for wire compatibility with TS callers. The native stream does
    /// not read it — the model name already rides inside `request_body`.
    pub model: String,
    pub request_body: String,
    /// Idle deadline in milliseconds: how long the stream may go without a
    /// single SSE event. The caller's 120 s means "no data for 120 s", not
    /// "the whole answer in 120 s"; the overall request has its own ceiling.
    pub timeout_ms: Option<u32>,
    pub extra_headers: Option<Vec<NativeLlmStreamHeader>>,
}

#[napi(object)]
pub struct NativeLlmStreamHeader {
    pub key: String,
    pub value: String,
}

/// A single streamed part from the LLM.
#[napi(object)]
#[derive(Clone)]
pub struct NativeLlmStreamPart {
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

/// One callback event forwarded to JS during an incremental stream.
#[napi(object)]
pub struct NativeLlmStreamEvent {
    /// `"part"` | `"done"` | `"error"`
    pub kind: String,
    pub part: Option<NativeLlmStreamPart>,
    pub metadata: Option<NativeLlmStreamMetadata>,
    pub error: Option<String>,
}

/// Metadata returned when the stream completes.
#[napi(object)]
pub struct NativeLlmStreamMetadata {
    pub response_id: Option<String>,
    pub finish_reason: Option<String>,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cached_tokens: u32,
    pub cache_creation_tokens: u32,
    pub trace_id: Option<String>,
}

/// Result of `native_llm_stream` — all parts + metadata in one response.
/// For the initial implementation, we collect all events and return them
/// at once. A future iteration will use TSFN for true streaming callbacks.
#[napi(object)]
pub struct NativeLlmStreamResult {
    pub parts: Vec<NativeLlmStreamPart>,
    pub metadata: NativeLlmStreamMetadata,
    pub error: Option<String>,
}

/// Execute an LLM streaming request and return all decoded parts.
///
/// The Rust side handles: HTTP POST, SSE parsing, provider-specific event
/// decoding. Returns all parts collected from the stream plus metadata.
///
/// @param config - Stream configuration (provider, url, api_key, request_body, etc.)
#[napi]
pub async fn native_llm_stream(config: NativeLlmStreamConfig) -> NativeLlmStreamResult {
    let stream_config = llm_stream::LlmStreamConfig {
        provider: config.provider,
        url: config.url,
        api_key: config.api_key,
        request_body: config.request_body,
        timeout_ms: config.timeout_ms.unwrap_or(120_000) as u64,
        extra_headers: config
            .extra_headers
            .unwrap_or_default()
            .into_iter()
            .map(|h| (h.key, h.value))
            .collect(),
    };

    let result = llm_stream::run_llm_stream(&stream_config).await;

    match result {
        Ok(events) => {
            let mut parts = Vec::new();
            let mut metadata = llm_stream::StreamMetadata::default();
            let mut error = None;

            for event in events {
                match event {
                    llm_stream::StreamEvent::Part(p) => {
                        parts.push(NativeLlmStreamPart {
                            part_type: p.part_type,
                            text: p.text,
                            think: p.think,
                            encrypted: p.encrypted,
                            id: p.id,
                            name: p.name,
                            arguments: p.arguments,
                            arguments_part: p.arguments_part,
                            stream_index: p.stream_index,
                        });
                    }
                    llm_stream::StreamEvent::Done(m) => {
                        metadata = m;
                    }
                    llm_stream::StreamEvent::Error(e) => {
                        error = Some(e);
                    }
                }
            }

            NativeLlmStreamResult {
                parts,
                metadata: NativeLlmStreamMetadata {
                    response_id: metadata.response_id,
                    finish_reason: metadata.finish_reason,
                    input_tokens: metadata.input_tokens,
                    output_tokens: metadata.output_tokens,
                    cached_tokens: metadata.cached_tokens,
                    cache_creation_tokens: metadata.cache_creation_tokens,
                    trace_id: metadata.trace_id,
                },
                error,
            }
        }
        Err(e) => NativeLlmStreamResult {
            parts: Vec::new(),
            metadata: NativeLlmStreamMetadata {
                response_id: None,
                finish_reason: None,
                input_tokens: 0,
                output_tokens: 0,
                cached_tokens: 0,
                cache_creation_tokens: 0,
                trace_id: None,
            },
            error: Some(e),
        },
    }
}

/// Streaming variant of `native_llm_stream`.
///
/// Runs the same Rust SSE pipeline but forwards each decoded part to the
/// provided JS callback as it arrives, via a ThreadsafeFunction — the JS side
/// observes parts incrementally instead of after the whole stream completes
/// (real streaming, matching the SDK providers' chunked delivery).
///
/// The function returns immediately; `on_event` receives
/// `{ kind: 'part'|'done'|'error', part?, metadata?, error? }` objects as the
/// stream progresses. The stream runs on a dedicated thread with its own
/// current-thread tokio runtime (the napi async runtime is private and the
/// JsFunction handle cannot cross into the `#[napi] async` future), which is
/// fine for an LLM stream: one call, one connection.
#[napi]
pub fn native_llm_stream_streaming(
    config: NativeLlmStreamConfig,
    on_event: JsFunction,
) -> napi::Result<()> {
    use napi::threadsafe_function::ThreadsafeFunction;

    let tsfn: ThreadsafeFunction<NativeLlmStreamEvent> = on_event
        .create_threadsafe_function(
            0,
            |ctx: napi::threadsafe_function::ThreadSafeCallContext<NativeLlmStreamEvent>| {
                ctx.env.create_object().and_then(|mut obj| {
                    obj.set("kind", ctx.value.kind)?;
                    if let Some(part) = ctx.value.part {
                        obj.set("part", part)?;
                    }
                    if let Some(metadata) = ctx.value.metadata {
                        obj.set("metadata", metadata)?;
                    }
                    if let Some(error) = ctx.value.error {
                        obj.set("error", error)?;
                    }
                    Ok(vec![obj])
                })
            },
        )
        .map_err(|e| napi::Error::from_reason(format!("create_threadsafe_function failed: {e}")))?;

    let stream_config = llm_stream::LlmStreamConfig {
        provider: config.provider,
        url: config.url,
        api_key: config.api_key,
        request_body: config.request_body,
        timeout_ms: config.timeout_ms.unwrap_or(120_000) as u64,
        extra_headers: config
            .extra_headers
            .unwrap_or_default()
            .into_iter()
            .map(|h| (h.key, h.value))
            .collect(),
    };

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                tsfn.call(
                    Ok(NativeLlmStreamEvent {
                        kind: "error".to_string(),
                        part: None,
                        metadata: None,
                        error: Some(format!("tokio runtime init failed: {e}")),
                    }),
                    napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                );
                return;
            }
        };
        let result = rt.block_on(llm_stream::run_llm_stream_with(&stream_config, |event| {
            let js_event = match event {
                llm_stream::StreamEvent::Part(p) => NativeLlmStreamEvent {
                    kind: "part".to_string(),
                    part: Some(NativeLlmStreamPart {
                        part_type: p.part_type,
                        text: p.text,
                        think: p.think,
                        encrypted: p.encrypted,
                        id: p.id,
                        name: p.name,
                        arguments: p.arguments,
                        arguments_part: p.arguments_part,
                        stream_index: p.stream_index,
                    }),
                    metadata: None,
                    error: None,
                },
                llm_stream::StreamEvent::Done(m) => NativeLlmStreamEvent {
                    kind: "done".to_string(),
                    part: None,
                    metadata: Some(NativeLlmStreamMetadata {
                        response_id: m.response_id,
                        finish_reason: m.finish_reason,
                        input_tokens: m.input_tokens,
                        output_tokens: m.output_tokens,
                        cached_tokens: m.cached_tokens,
                        cache_creation_tokens: m.cache_creation_tokens,
                        trace_id: m.trace_id,
                    }),
                    error: None,
                },
                llm_stream::StreamEvent::Error(e) => NativeLlmStreamEvent {
                    kind: "error".to_string(),
                    part: None,
                    metadata: None,
                    error: Some(e),
                },
            };
            // NonBlocking: just enqueue for the JS event loop; never blocks the
            // SSE decode loop.
            tsfn.call(
                Ok(js_event),
                napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
            );
        }));
        if let Err(e) = result {
            tsfn.call(
                Ok(NativeLlmStreamEvent {
                    kind: "error".to_string(),
                    part: None,
                    metadata: None,
                    error: Some(e),
                }),
                napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    });
    Ok(())
}
