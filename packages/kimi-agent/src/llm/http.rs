//! Native HTTP LLM transport — calls the provider directly from Rust with
//! SSE streaming, instead of proxying `llm_chat` back to the JS host.
//!
//! Request projection and stream accumulation live in `openai.rs` /
//! `anthropic.rs` (pure functions); this module owns the transport:
//! reqwest client, credentials, SSE decoding, and delta forwarding.

use std::sync::Arc;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::llm::wire::{StreamDelta, to_wire};
use crate::llm::{anthropic, google_genai, openai, openai_responses};
use crate::rpc::types::{BoxFuture, NativeLlmConfig};
use crate::turn_loop::types::{LLM, LLMChatParams, LLMChatResponse};

/// Per-request timeout. Generous because streaming responses for long
/// completions can take minutes; the read is still bounded per-chunk by
/// the connect/idle behavior of the pool.
const REQUEST_TIMEOUT_SECS: u64 = 600;

/// Fire-and-forget sink for streaming events (text or thinking deltas). The value is a
/// JSON event object; the receiver forwards it to the JS host transcript.
pub type EventSink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// Fetches a bearer token for an OAuth-managed provider. `force` asks the
/// host to refresh past its cache — the transport calls it after a 401/403,
/// mirroring the host's own `getAuth({ force: true })` retry.
pub type AuthTokenProvider =
    Arc<dyn Fn(bool) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

enum Accumulator {
    OpenAI(openai::StreamAccumulator),
    Responses(openai_responses::StreamAccumulator),
    Anthropic(anthropic::StreamAccumulator),
    Google(google_genai::StreamAccumulator),
}

impl Accumulator {
    fn feed(&mut self, value: &serde_json::Value) -> Option<StreamDelta> {
        match self {
            Self::OpenAI(acc) => acc.feed(value),
            Self::Responses(acc) => acc.feed(value),
            Self::Anthropic(acc) => acc.feed(value),
            Self::Google(acc) => acc.feed(value),
        }
    }

    fn finish(self) -> LLMChatResponse {
        match self {
            Self::OpenAI(acc) => acc.finish(),
            Self::Responses(acc) => acc.finish(),
            Self::Anthropic(acc) => acc.finish(),
            Self::Google(acc) => acc.finish(),
        }
    }

    /// Terminal accumulation failure (e.g. truncated Responses function-call
    /// arguments). Only the Responses accumulator can produce one today.
    fn take_error(&mut self) -> Option<String> {
        match self {
            Self::Responses(acc) => acc.take_error(),
            _ => None,
        }
    }
}

/// An [`LLM`] implementation that talks to an OpenAI-compatible or
/// Anthropic endpoint over HTTPS with SSE streaming.
/// Process-wide HTTP client. TCP/TLS connections pool across turns; building
/// a client per LLM instance dropped that pool on every rebuild, so each turn
/// paid a fresh connect + TLS handshake before its first token. Keep-alive
/// reuse is what lets the host transport (Node fetch) start streaming sooner.
static SHARED_HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> =
    once_cell::sync::Lazy::new(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    });

pub struct NativeHttpLlm {
    config: NativeLlmConfig,
    system_prompt: String,
    client: reqwest::Client,
    sink: Option<EventSink>,
    /// OAuth token channel for `auth_provider`-configured transports. Absent
    /// means static-key auth (`config.api_key`).
    auth: Option<AuthTokenProvider>,
    /// Last token fetched through `auth`, reused across requests until a
    /// 401/403 forces a refresh — the host's OAuth manager keeps it fresh,
    /// so re-asking per request would only add round-trips.
    cached_token: std::sync::Mutex<Option<String>>,
    /// Single-flight gate for the cold token fetch and the forced refresh:
    /// held across the host round-trip so N concurrent callers share one
    /// fetch instead of each triggering an OAuth refresh. Async because the
    /// round-trip it serializes is itself async.
    fetch_gate: tokio::sync::Mutex<()>,
}

impl NativeHttpLlm {
    pub fn new(config: NativeLlmConfig, system_prompt: String) -> Self {
        let client = SHARED_HTTP_CLIENT.clone();
        Self {
            config,
            system_prompt,
            client,
            sink: None,
            auth: None,
            cached_token: std::sync::Mutex::new(None),
            fetch_gate: tokio::sync::Mutex::new(()),
        }
    }

    /// Attach a streaming event sink. Deltas are forwarded to it as
    /// `{ "type": "llm.delta", "part": { "type": "text" | "think", ... } }`.
    pub fn with_sink(mut self, sink: EventSink) -> Self {
        self.sink = Some(sink);
        self
    }

    /// Attach the OAuth token channel. Required when the config names an
    /// `auth_provider`; ignored otherwise.
    pub fn with_auth_provider(mut self, auth: AuthTokenProvider) -> Self {
        self.auth = Some(auth);
        self
    }

    /// Moonshot preserved-thinking keep is active (`[thinking] keep` /
    /// `KIMI_MODEL_THINKING_KEEP`); the host filters off-values, so any value
    /// here reaches the wire.
    fn thinking_keep_active(&self) -> bool {
        self.config
            .thinking_keep
            .as_deref()
            .is_some_and(|keep| !keep.is_empty())
    }

    /// Whether anthropic requests take the **beta** Messages API
    /// (`POST {base}/messages?beta=true`). Enabling keep routes there as well
    /// — `clear_thinking_20251015` is honored only on the beta API — which is
    /// the same override the host provider applies in `withThinkingKeep`.
    fn beta_messages_api(&self) -> bool {
        self.config.beta_api || self.thinking_keep_active()
    }

    fn endpoint(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        match self.config.protocol.as_str() {
            "anthropic" => {
                if self.beta_messages_api() {
                    format!("{base}/messages?beta=true")
                } else {
                    format!("{base}/messages")
                }
            }
            "openai_responses" | "openai-responses" => format!("{base}/responses"),
            "google" | "google-genai" | "gemini" => {
                // The GenerateContent API always carries a version segment; the
                // host resolvers normalize `base_url` for this, but the URL is
                // actually assembled here, so this must not depend on the
                // caller having done so. A bare host root otherwise builds a
                // path that is not an API route at all.
                let base = google_api_base(base);
                format!(
                    "{base}/models/{}:streamGenerateContent?alt=sse",
                    google_model_id(&self.config.model)
                )
            }
            _ => format!("{base}/chat/completions"),
        }
    }

    fn emit_delta(&self, delta: StreamDelta) {
        if let Some(ref sink) = self.sink {
            sink(serde_json::json!({
                "type": "llm.delta",
                "part": delta.to_part(),
            }));
        }
    }

    fn emit(&self, event: serde_json::Value) {
        if let Some(ref sink) = self.sink {
            sink(event);
        }
    }

    async fn chat_impl(&self, params: LLMChatParams) -> Result<LLMChatResponse, String> {
        let wire = to_wire(&params.messages);
        let is_anthropic = self.config.protocol == "anthropic";
        let is_responses = matches!(
            self.config.protocol.as_str(),
            "openai_responses" | "openai-responses"
        );
        let is_google = matches!(
            self.config.protocol.as_str(),
            "google" | "google-genai" | "gemini"
        );
        let started_at = std::time::Instant::now();

        // Step boundary: the host mirrors these into transcript step events.
        self.emit(serde_json::json!({ "type": "llm.step.begin", "model": self.config.model }));

        let body = if is_anthropic {
            anthropic::build_request_full(
                &self.config.model,
                self.config
                    .max_tokens
                    .unwrap_or_else(|| anthropic::default_max_tokens_for_model(&self.config.model)),
                &wire,
                &params.tools,
                true,
                self.config.thinking_budget,
                self.config.thinking_keep.as_deref(),
            )
        } else if is_responses {
            openai_responses::build_request_full(
                &self.config.model,
                &wire,
                &params.tools,
                true,
                self.config.reasoning_effort.as_deref(),
            )
        } else if is_google {
            // The host expresses "thinking on" as an *effort* for every
            // non-anthropic protocol (`thinking_budget` stays None), so that —
            // not the anthropic-only budget — is the signal that the request
            // must ask Gemini for its reasoning. Without `includeThoughts` the
            // response carries no `thought` part and the stream emits no think
            // delta, which is exactly why Gemini showed no thinking in the TUI
            // while the effort was configured and on.
            let reasoning_on = self
                .config
                .reasoning_effort
                .as_deref()
                .is_some_and(|e| !e.is_empty() && e != "off" && e != "none")
                || self.config.thinking_budget.is_some_and(|b| b > 0);
            let include_thoughts =
                reasoning_on && google_genai::model_supports_thoughts(&self.config.model);
            google_genai::build_request_full(
                &wire,
                &params.tools,
                self.config.thinking_budget,
                include_thoughts,
            )
        } else {
            openai::build_request_full(
                &self.config.model,
                &wire,
                &params.tools,
                true,
                self.config.reasoning_effort.as_deref(),
                self.config.thinking_keep.as_deref(),
            )
        };

        let mut token = self.credential().await?;
        let mut response = self
            .send_request(&body, token.as_str(), params.cancel.as_ref())
            .await?;
        let mut status = response.status();
        // A 401/403 on an OAuth-managed transport means the cached token went
        // stale (expired early, revoked, rotated); force a host-side refresh
        // and retry once before surfacing the failure. Static-key transports
        // have nothing to refresh — a bad key never becomes good by retrying.
        if !status.is_success() && matches!(status.as_u16(), 401 | 403) && self.auth.is_some() {
            token = self.refresh_credential().await?;
            response = self
                .send_request(&body, token.as_str(), params.cancel.as_ref())
                .await?;
            status = response.status();
        }
        let t_headers = started_at.elapsed();
        if !status.is_success() {
            // The provider may ask for a specific wait; carry it out-of-band
            // so the retry layer can honour it instead of burning its
            // attempts at its own pace.
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            let brief = read_brief_body(response).await;
            let suffix = retry_after.map_or(String::new(), |s| format!(" (retry-after {s}s)"));
            return Err(format!("llm http status {status}: {brief}{suffix}"));
        }

        let mut acc = if is_anthropic {
            Accumulator::Anthropic(anthropic::StreamAccumulator::new())
        } else if is_responses {
            Accumulator::Responses(openai_responses::StreamAccumulator::new())
        } else if is_google {
            Accumulator::Google(google_genai::StreamAccumulator::new())
        } else {
            Accumulator::OpenAI(openai::StreamAccumulator::new())
        };

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let mut n_events: u32 = 0;
        // Frames that arrived but were not JSON, and in-band provider errors.
        // Both used to be dropped without a trace: a gateway answering 200 with
        // a catch-all (HTML/plain) body produced zero events, the accumulator
        // finished on EOF with an empty response, and the step layer mapped that
        // to a normal `Complete`. From the outside it looked like "the model
        // returned nothing", with no error anywhere.
        let mut n_malformed: u32 = 0;
        let mut first_malformed: Option<String> = None;
        let mut in_band_error: Option<String> = None;
        let mut t_first_event: Option<std::time::Duration> = None;
        // Thinking-loop guard: a degenerate thinking stream is a decoding
        // attractor the model cannot notice from inside, so the repetition is
        // caught here and the rest of the block is dropped from the display.
        // The accumulator keeps its own copy — an Anthropic thinking block
        // must round-trip with its signature intact.
        let mut thinking_guard = crate::llm::thinking_guard::ThinkingGuard::from_settings();
        let mut stream = response.bytes_stream().eventsource();
        while let Some(event) = tokio::select! {
            // Mid-stream cancellation (generate.ts:154-202): abort the read
            // instead of draining the rest of the response. Already-emitted
            // deltas stay in the transcript, mirroring v2's behavior of
            // keeping consumed content after an abort.
            _ = cancelled_or_pending(params.cancel.as_ref()) => {
                return Err(CANCELLED_MESSAGE.into());
            }
            event = stream.next() => event,
        } {
            let event = event.map_err(|e| format!("llm sse decode error: {e}"))?;
            if event.data == "[DONE]"
                || event.event == "message_stop"
                || event.event == "response.done"
            {
                break;
            }
            let value: serde_json::Value = match serde_json::from_str(&event.data) {
                Ok(v) => v,
                // Tolerate non-JSON keep-alive payloads, but count them: an
                // endpoint that is not actually speaking SSE must not look like
                // an empty completion.
                Err(_) => {
                    n_malformed += 1;
                    if first_malformed.is_none() {
                        first_malformed = Some(truncate_for_diagnosis(&event.data));
                    }
                    continue;
                }
            };
            if let Some(message) = crate::native::extract_in_band_error(&value) {
                in_band_error = Some(message);
                break;
            }
            n_events += 1;
            if t_first_event.is_none() {
                t_first_event = Some(started_at.elapsed());
            }
            if let Some(event_type) = value.get("type").and_then(|t| t.as_str())
                && (event_type == "message_stop" || event_type == "response.done")
            {
                break;
            }
            if let Some(delta) = acc.feed(&value)
                && let Some(delta) =
                    crate::llm::thinking_guard::gate_delta(&mut thinking_guard, delta)
            {
                self.emit_delta(delta);
            }
        }

        if let Some(message) = in_band_error {
            return Err(format!("llm provider stream error: {message}"));
        }

        // Failures the accumulator recorded itself (truncated Responses
        // function-call arguments) must also fail the request: finishing
        // here would run tools with fabricated empty arguments or complete
        // the turn with an empty answer.
        if let Some(message) = acc.take_error() {
            return Err(format!("llm provider stream error: {message}"));
        }

        // Hyper returns a connection to the pool only after its body is read
        // to EOF. The loop above breaks on the terminal marker and would
        // otherwise drop the stream mid-body — closing the connection and
        // forcing the next turn to pay a fresh TCP+TLS handshake. Drain the
        // remainder off-thread, bounded, so the pool keeps the connection.
        tokio::spawn(async move {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while let Some(Ok(_)) = stream.next().await {}
            })
            .await;
        });

        if std::env::var_os("KIMI_HTTP_TIMING").is_some_and(|v| v == "1") {
            eprintln!(
                "[native-http-timing] total={}ms headers={}ms first_event={}ms events={} model={}",
                started_at.elapsed().as_millis(),
                t_headers.as_millis(),
                t_first_event.map(|d| d.as_millis()).unwrap_or(0),
                n_events,
                self.config.model
            );
        }

        let response = acc.finish();

        // A stream that produced no usable events is a transport failure, not an
        // empty answer. Returning `Ok` here is what turned a misconfigured
        // endpoint into "the model said nothing", with no error anywhere for the
        // retry layer or the user to act on.
        if n_events == 0 {
            return Err(empty_stream_error(
                &content_type,
                n_malformed,
                first_malformed.as_deref(),
            ));
        }
        if response.content.is_empty()
            && response.tool_calls.is_empty()
            && response.finish_reason.is_none()
        {
            return Err(format!(
                "llm stream ended without content, tool calls or a finish reason ({n_events} event(s), {n_malformed} unparsable frame(s), content-type \"{content_type}\"). The endpoint answered 200 but nothing usable was decoded."
            ));
        }

        // Report the finished step (content + tool calls + usage) so the
        // host can record the assistant message without owning the call.
        self.emit(serde_json::json!({
            "type": "llm.step.end",
            "content": response.content,
            "tool_calls": response.tool_calls.iter().map(|tc| serde_json::json!({
                "id": tc.id,
                "name": tc.name,
                "arguments": tc.arguments,
            })).collect::<Vec<_>>(),
            "finish_reason": response.finish_reason,
            "latency_ms": started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.total_tokens,
                "input_cache_read": response.usage.input_cache_read,
                "input_cache_creation": response.usage.input_cache_creation,
            },
        }));

        Ok(response)
    }

    /// Send one request with the protocol's auth headers carrying `token`.
    async fn send_request(
        &self,
        body: &serde_json::Value,
        token: &str,
        cancel: Option<&tokio_util::sync::CancellationToken>,
    ) -> Result<reqwest::Response, String> {
        let is_google = matches!(
            self.config.protocol.as_str(),
            "google" | "google-genai" | "gemini"
        );
        let is_anthropic = self.config.protocol == "anthropic";
        let mut req = self.client.post(self.endpoint()).json(body);
        if is_google {
            if token.starts_with("ya29.") || self.config.auth_provider.is_some() {
                req = req.header("authorization", format!("Bearer {token}"));
            } else {
                req = req.header("x-goog-api-key", token);
            }
        } else if is_anthropic {
            req = req
                .header("x-api-key", token)
                .header("anthropic-version", "2023-06-01");
            // Preserved thinking rides the beta Messages API
            // (`context-management-2025-06-27`), mirroring the host provider;
            // `endpoint()` switches the URL to `?beta=true` for the same
            // reason.
            if self.thinking_keep_active() {
                req = req.header("anthropic-beta", "context-management-2025-06-27");
            }
        } else {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        for (k, v) in &self.config.custom_headers {
            req = req.header(k.as_str(), v.as_str());
        }
        // v2 aborts preflight sends through the same signal
        // (generate.ts:107-109): a cancel landing before the response
        // headers arrives must not pay for the request.
        // The shared client no longer carries the whole-request timeout, so it
        // rides on each request (same value the per-instance client used).
        let send = req
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .send();
        let response = match cancel {
            Some(cancel) => tokio::select! {
                _ = cancel.cancelled() => return Err(CANCELLED_MESSAGE.into()),
                sent = send => sent,
            },
            None => send.await,
        };
        response.map_err(|e| format!("{}: {e}", transport_error_message(&e)))
    }

    /// The credential for this request: the cached OAuth token (fetched once,
    /// then reused until a 401/403 forces a refresh) or the static key.
    async fn credential(&self) -> Result<String, String> {
        if self.config.auth_provider.is_some() {
            let fetch = self.auth.as_ref().ok_or_else(|| {
                format!(
                    "native transport names auth_provider {:?} but no token channel is wired",
                    self.config.auth_provider
                )
            })?;
            // Fast path: a cached token needs neither the gate nor a round-trip.
            if let Some(token) = self.cached_token_value() {
                return Ok(token);
            }
            // Single-flight the cold fetch. Without this gate, N concurrent
            // first-requests would each call `host/auth_token` and the host's
            // OAuth manager could refresh N times for one logical login. The
            // winner populates the cache; the rest re-check under the gate and
            // reuse it.
            let _gate = self.fetch_gate.lock().await;
            if let Some(token) = self.cached_token_value() {
                return Ok(token);
            }
            return self.store_token(fetch(false).await?);
        }
        Ok(self.config.api_key.clone())
    }

    /// Force-refresh the OAuth token through the host after a 401/403.
    async fn refresh_credential(&self) -> Result<String, String> {
        match &self.auth {
            // Serialize forced refreshes too, so concurrent 401s share one
            // host round-trip instead of stampeding the OAuth manager.
            Some(fetch) => {
                let _gate = self.fetch_gate.lock().await;
                self.store_token(fetch(true).await?)
            }
            None => Ok(self.config.api_key.clone()),
        }
    }

    /// The currently cached token, if any.
    fn cached_token_value(&self) -> Option<String> {
        self.cached_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn store_token(&self, token: String) -> Result<String, String> {
        *self.cached_token.lock().unwrap_or_else(|e| e.into_inner()) = Some(token.clone());
        Ok(token)
    }
}

/// Google's GenerateContent routes live under a version segment (`/v1beta`).
/// Append it when the configured base URL carries none, so a host-root-only
/// `base_url` — the documented contract for the `google-genai` provider —
/// still resolves to a real API route.
pub fn google_api_base(base: &str) -> String {
    if url_has_api_version(base) {
        return base.to_string();
    }
    format!("{base}/v1beta")
}

/// Whether a URL already carries an API version segment (`v1`, `v1beta`, …).
///
/// The native streaming transport receives a full endpoint URL rather than a
/// base, so it cannot append a version segment — but it can refuse to issue a
/// request that has none, instead of letting a catch-all gateway answer 200 and
/// the empty result read as "the model said nothing".
pub fn url_has_api_version(url: &str) -> bool {
    url.split('/').any(is_api_version_segment)
}

/// The model id as the GenerateContent path expects it: only the final segment.
///
/// Callers may hand over a `provider/model` alias (e.g.
/// `zhongzhuan/gemini-3.8-flash-high`) when the alias is not declared under
/// `[models.*]`. The model path segment must be the bare model id — a
/// Gemini-compatible relay answers the prefixed form with 404
/// (`protocol_endpoint_not_found`), which reaches the user as an empty
/// response because nothing in the stream decodes.
///
/// Only applied to Google: other wires legitimately use `provider/model`
/// (OpenRouter-style aliases), and they carry it in a body field rather than
/// in the URL path.
pub(crate) fn google_model_id(model: &str) -> &str {
    model.rsplit('/').next().unwrap_or(model)
}

/// Whether one path segment is an API version marker: `v` + digits + optional
/// alpha suffix (`v1`, `v1beta`, `v2alpha`). `vertex` is not one — the digits
/// must come immediately after the `v`.
fn is_api_version_segment(segment: &str) -> bool {
    let Some(rest) = segment.strip_prefix(['v', 'V']) else {
        return false;
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].chars().all(|c| c.is_ascii_alphabetic())
}

/// Cap on how much of an error body is read. Only a brief excerpt is
/// rendered, so there is no reason to buffer an unbounded response first.
const ERROR_BODY_MAX_BYTES: usize = 16 * 1024;

/// Build the machine-readable transport-error prefix. reqwest 0.12's
/// `Display` hides the actual cause (timeout / refused / DNS ...) behind
/// `.source()`, so classify it here while the `reqwest::Error` is in hand —
/// the retry layer matches this prefix instead of grepping free text.
/// Stable prefix for cancellation failures. `is_retryable_error` treats it
/// as deterministic (the caller asked to stop), mirroring v2 where an
/// `AbortError` is never classified as a retryable provider error.
const CANCELLED_MESSAGE: &str = "llm cancelled: request aborted";

/// Prefix for a response that is not an SSE stream at all. Re-exported from the
/// native stream module so both transports classify it identically.
const NOT_AN_SSE_ENDPOINT_PREFIX: &str = crate::native::NOT_AN_SSE_ENDPOINT_PREFIX;

/// Keeps a diagnosis readable: the first frame of a non-SSE body is the useful
/// part, and a catch-all gateway can answer with a megabyte of HTML.
///
/// Delegates to the native-stream implementation so the two transports cannot
/// drift apart.
fn truncate_for_diagnosis(text: &str) -> String {
    crate::native::truncate_for_diagnosis(text)
}

/// Explains a stream that produced no events. Delegates to the shared
/// implementation so both transports word the diagnosis the same way.
fn empty_stream_error(
    content_type: &str,
    n_malformed: u32,
    first_malformed: Option<&str>,
) -> String {
    crate::native::empty_stream_error(content_type, n_malformed, first_malformed)
}

/// Resolve immediately when no cancel handle is wired (test stubs) so the
/// select arm stays inert.
async fn cancelled_or_pending(cancel: Option<&tokio_util::sync::CancellationToken>) {
    match cancel {
        Some(cancel) => cancel.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

fn transport_error_message(e: &reqwest::Error) -> String {
    let kind = if e.is_builder() {
        "invalid_request"
    } else if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_decode() || e.is_body() {
        "decode"
    } else {
        "transport"
    };
    format!("llm transport error {kind}")
}

/// Read the start of an error body, bounded, for inclusion in the error
/// message.
async fn read_brief_body(response: reqwest::Response) -> String {
    let mut stream = response;
    let mut buf: Vec<u8> = Vec::new();
    while buf.len() < ERROR_BODY_MAX_BYTES {
        match stream.chunk().await {
            Ok(Some(chunk)) => buf.extend_from_slice(&chunk),
            _ => break,
        }
    }
    String::from_utf8_lossy(&buf).chars().take(500).collect()
}

/// Quota/arrears detection mirroring v2 `classifyKimiQuotaError`
/// (the deleted `providers/kimi-errors.ts:6-22`) and
/// `isOpenAIInsufficientQuotaError` (the deleted `openai-common.ts:90`): the
/// structured Kimi code, the OpenAI `insufficient_quota` code, and the
/// balance/billing message patterns. A hit means the request can never succeed
/// without human action, so the retry loop must stand down even though the
/// wire status looks transient.
fn is_quota_exhaustion_error(error: &str) -> bool {
    const QUOTA_MARKERS: &[&str] = &[
        "exceeded_current_quota_error",
        "insufficient_quota",
        "exceeded your current quota",
        "check your account balance",
        "insufficient balance",
        "recharge your account",
        "please recharge",
        "account is in arrears",
        "account in arrears",
    ];
    let lower = error.to_lowercase();
    QUOTA_MARKERS.iter().any(|m| lower.contains(m))
}

impl LLM for NativeHttpLlm {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.config.model
    }

    fn transport(&self) -> &'static str {
        "native-http"
    }

    fn is_retryable_error(&self, error: &str) -> bool {
        // Status-coded errors are classified by code, not by body. Scanning
        // the body for keywords would retry a 400 whose text happens to
        // contain "connection", or a 401 that mentions a session timeout —
        // requests that can never succeed no matter how often they repeat.
        if error.starts_with(CANCELLED_MESSAGE) {
            return false;
        }
        // A body that is not SSE at all is a configuration error, not a
        // transient one: no number of retries will make it parseable.
        if error.starts_with(NOT_AN_SSE_ENDPOINT_PREFIX) {
            return false;
        }
        if let Some(rest) = error.strip_prefix("llm http status ") {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let code: u16 = digits.parse().unwrap_or(0);
            // The code set mirrors v2 `isRetryableGenerateError`
            // (kosong/contract/errors.ts:234-251): [408, 409, 429, 500..=599]
            // plus the 425 Rust adds for retry-later transports. The quota
            // exemption mirrors v2 `classifyKimiQuotaError` +
            // `APIProviderQuotaExhaustedError` (kimi-errors.ts:7-22): a 429
            // that is really "your account is out of quota / balance" is
            // deterministic — retrying burns attempts for nothing.
            if code == 429 && is_quota_exhaustion_error(error) {
                return false;
            }
            return matches!(code, 408 | 409 | 425 | 429 | 500..=599);
        }
        // 402 "Payment Required" (DeepSeek arrears, some Kimi plans) is
        // never in the retryable set, so no explicit exemption is needed.
        // Transport-level failures are classified at the error site too:
        // reqwest 0.12's Display only renders "error sending request for
        // url (...)" — the underlying cause (dns timeout, connection
        // refused/reset, ...) sits in `.source()` and keyword-matching the
        // Display string would classify every transport failure as
        // non-retryable. The transport step stamps a stable kind instead.
        if let Some(rest) = error.strip_prefix("llm transport error ") {
            return !rest.starts_with("invalid_request");
        }
        // Fallback keyword list for errors produced by older code paths
        // (e.g. SSE decode failures, which carry their own prefix).
        //
        // An empty-but-well-formed stream is included deliberately: relays do
        // intermittently answer 200 with an empty body, and the retry layer is
        // the only thing that turns that into a usable turn.
        const RETRYABLE: &[&str] = &[
            "overloaded",
            "timed out",
            "timeout",
            "connect",
            "connection",
            "sse decode error",
            "produced no events",
        ];
        let lower = error.to_lowercase();
        if is_quota_exhaustion_error(&lower) {
            return false;
        }
        RETRYABLE.iter().any(|s| lower.contains(s))
    }

    fn chat(
        &self,
        params: LLMChatParams,
    ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        Box::pin(async move {
            self.chat_impl(params)
                .await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    Box::new(std::io::Error::other(e))
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn google_base_url_gets_a_version_segment() {
        // Host root only (the documented contract for `google-genai`): the
        // version segment is appended here, so the assembled URL is an API route.
        assert_eq!(
            google_api_base("https://generativelanguage.googleapis.com"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            google_api_base("http://127.0.0.1:3001"),
            "http://127.0.0.1:3001/v1beta"
        );
        assert_eq!(
            google_api_base("http://107.173.87.151:8045"),
            "http://107.173.87.151:8045/v1beta"
        );
    }

    #[test]
    fn google_base_url_keeps_an_explicit_version_segment() {
        assert_eq!(
            google_api_base("https://generativelanguage.googleapis.com/v1beta"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            google_api_base("http://127.0.0.1:3001/v1"),
            "http://127.0.0.1:3001/v1"
        );
        assert_eq!(
            google_api_base("https://proxy.example.com/v2alpha"),
            "https://proxy.example.com/v2alpha"
        );
    }

    #[test]
    fn google_model_id_strips_a_provider_prefix() {
        // A `provider/model` alias must not reach the URL path: the relay
        // answers `/models/zhongzhuan/gemini-...` with 404
        // (`protocol_endpoint_not_found`) and the turn comes back empty.
        assert_eq!(
            google_model_id("zhongzhuan/gemini-3.8-flash-high"),
            "gemini-3.8-flash-high"
        );
        assert_eq!(google_model_id("gemini-2.5-pro"), "gemini-2.5-pro");
        assert_eq!(google_model_id("models/gemini-2.5-pro"), "gemini-2.5-pro");
    }

    #[test]
    fn a_non_version_segment_is_not_mistaken_for_one() {
        // `vertex` starts with `v` but carries no digits directly after it.
        assert_eq!(
            google_api_base("https://x.example.com/vertex"),
            "https://x.example.com/vertex/v1beta"
        );
    }

    fn config(protocol: &str, base_url: &str) -> NativeLlmConfig {
        NativeLlmConfig {
            protocol: protocol.into(),
            base_url: base_url.into(),
            api_key: "test-key".into(),
            model: "test-model".into(),
            max_tokens: None,
            custom_headers: HashMap::new(),
            reasoning_effort: None,
            thinking_budget: None,
            auth_provider: None,
            thinking_keep: None,
            beta_api: false,
        }
    }

    #[test]
    fn endpoint_joins_openai_and_anthropic_paths() {
        let llm = NativeHttpLlm::new(
            config("openai", "https://api.example.com/v1/"),
            String::new(),
        );
        assert_eq!(
            llm.endpoint(),
            "https://api.example.com/v1/chat/completions"
        );

        let llm = NativeHttpLlm::new(
            config("anthropic", "https://api.example.com/v1"),
            String::new(),
        );
        assert_eq!(llm.endpoint(), "https://api.example.com/v1/messages");
    }

    #[test]
    fn retryable_error_classification() {
        let llm = NativeHttpLlm::new(
            config("openai", "https://api.example.com/v1"),
            String::new(),
        );
        assert!(llm.is_retryable_error("llm http status 429 Too Many Requests: slow down"));
        assert!(llm.is_retryable_error("llm http status 409 Conflict: concurrent edit"));
        assert!(llm.is_retryable_error("llm http status 503 Service Unavailable: busy"));
        assert!(llm.is_retryable_error("llm transport error connect: connection refused"));
        assert!(llm.is_retryable_error("llm transport error timeout: operation timed out"));
        assert!(llm.is_retryable_error("llm sse decode error: expected value at line 1"));
        assert!(!llm.is_retryable_error("llm http status 401 Unauthorized: bad key"));
        assert!(!llm.is_retryable_error("llm http status 400 Bad Request: invalid schema"));
        assert!(
            !llm.is_retryable_error("llm http status 402 Payment Required: Insufficient Balance")
        );
    }

    #[test]
    fn quota_exhaustion_is_not_retryable() {
        // Mirrors the v2 quota-exemption cases (kimi-errors.ts:7-22,
        // openai-common.ts:90): a 429 carrying quota/balance wording is a
        // deterministic failure — retrying burns attempts without any
        // chance of success.
        let llm = NativeHttpLlm::new(
            config("openai", "https://api.example.com/v1"),
            String::new(),
        );
        let quota_bodies = [
            r#"{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}"#,
            r#"{"error":{"code":"exceeded_current_quota_error","type":"quota","message":"quota reached"}}"#,
            r#"{"error":{"message":"Insufficient Balance in your account"}}"#,
            r#"{"error":{"message":"Please recharge your account to continue"}}"#,
            r#"{"error":{"message":"Your account is in arrears. Settle the balance to resume."}}"#,
            "Check your account balance before retrying",
        ];
        for body in quota_bodies {
            assert!(
                !llm.is_retryable_error(&format!("llm http status 429 Too Many Requests: {body}")),
                "quota body must be non-retryable: {body}"
            );
        }
        // A rate-limit 429 without quota wording stays retryable.
        assert!(llm.is_retryable_error(
            "llm http status 429 Too Many Requests: rate limit exceeded, slow down"
        ));
        // The exemption also covers the keyword-fallback path (SSE decode
        // failures that quote quota wording).
        assert!(!llm.is_retryable_error(
            "llm sse decode error: exceeded_current_quota_error while decoding"
        ));
    }

    #[test]
    fn transport_errors_are_classified_by_stamped_kind() {
        // reqwest 0.12's Display only renders "error sending request for
        // url (...)" — the retryable-ness must come from the stamped kind,
        // not from keywords that never appear in that string.
        let llm = NativeHttpLlm::new(
            config("anthropic", "https://api.example.com/v1"),
            String::new(),
        );
        assert!(llm.is_retryable_error(
            "llm transport error timeout: error sending request for url (https://api.example.com): connection timed out"
        ));
        assert!(llm.is_retryable_error(
            "llm transport error connect: error sending request for url (https://api.example.com)"
        ));
        assert!(llm.is_retryable_error(
            "llm transport error transport: failed to lookup address information: Name or service not known"
        ));
        assert!(llm.is_retryable_error("llm transport error decode: error decoding response body"));
        assert!(!llm.is_retryable_error(
            "llm transport error invalid_request: builder error: relative URL without a base"
        ));
    }

    #[test]
    fn retryable_error_ignores_status_body_keywords() {
        let llm = NativeHttpLlm::new(
            config("openai", "https://api.example.com/v1"),
            String::new(),
        );
        // A 400 whose body mentions connections, and a 401 that mentions a
        // session timeout, describe requests that can never succeed — no
        // amount of retrying changes that.
        assert!(
            !llm.is_retryable_error("llm http status 400 Bad Request: unknown field 'connection'")
        );
        assert!(!llm.is_retryable_error(
            "llm http status 401 Unauthorized: session timeout, please re-authenticate"
        ));
        assert!(llm.is_retryable_error("llm http status 429 Too Many Requests: (retry-after 30s)"));
        assert!(llm.is_retryable_error("llm http status 529 overloaded"));
    }

    #[test]
    fn model_name_and_system_prompt_come_from_config() {
        let llm = NativeHttpLlm::new(config("openai", "https://api.example.com/v1"), "sys".into());
        assert_eq!(llm.model_name(), "test-model");
        assert_eq!(llm.system_prompt(), "sys");
    }

    #[tokio::test]
    async fn chat_fails_cleanly_on_unreachable_endpoint() {
        // Port 1 on loopback is essentially never listening — the connect
        // is refused immediately without reaching any real server.
        let mut cfg = config("openai", "http://127.0.0.1:1/v1");
        cfg.custom_headers.insert("x-test".into(), "1".into());
        let llm = NativeHttpLlm::new(cfg, String::new());
        let result = llm
            .chat(LLMChatParams {
                cancel: None,
                messages: Arc::from(Vec::new()),
                tools: Arc::from(Vec::new()),
            })
            .await;
        assert!(result.is_err());
        let msg = result.err().unwrap().to_string();
        assert!(
            msg.contains("llm transport error"),
            "unexpected error: {msg}"
        );
    }

    /// A cancel firing while the provider is still streaming must abort the
    /// read with the stable cancellation error (v2 AbortSignal,
    /// generate.ts:154-202) — and that error must never be retried, the way
    /// v2's `AbortError` short-circuits `isRetryableGenerateError`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn chat_cancels_mid_stream_and_never_retries() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            // One streamed delta, then hold the connection open: the model
            // never finishes, so only the cancel handle can end the call.
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n";
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}"
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.flush().await;
            // Park the socket so the stream stays open until the test ends.
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        });

        let cfg = config("openai", &format!("http://{addr}/v1"));
        let llm = std::sync::Arc::new(NativeHttpLlm::new(cfg, String::new()));
        let token = tokio_util::sync::CancellationToken::new();

        let chat_llm = llm.clone();
        let chat_token = token.clone();
        let chat = tokio::spawn(async move {
            chat_llm
                .chat(LLMChatParams {
                    cancel: Some(chat_token),
                    messages: Arc::from(vec![crate::turn_loop::types::LLMMessage {
                        role: "user".into(),
                        content: "hi".into(),
                        ..Default::default()
                    }]),
                    tools: Arc::from(Vec::new()),
                })
                .await
        });

        // Let the first delta arrive, then cancel mid-stream.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        token.cancel();

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), chat)
            .await
            .expect("a cancelled chat must return promptly, not drain the stream")
            .unwrap();
        assert!(result.is_err(), "a cancelled chat must fail");
        let msg = result.err().unwrap().to_string();
        assert!(msg.starts_with("llm cancelled"), "unexpected error: {msg}");
        assert!(
            !llm.is_retryable_error(&msg),
            "cancellation must never be classified as retryable"
        );

        server.abort();
    }

    /// One-shot local HTTP server: the first request draws a 401, every later
    /// one a 200 with a one-delta SSE body. The body used to be empty, which
    /// made this test the only place asserting that an empty stream is `Ok` —
    /// the behaviour that hid "the model returned nothing".
    async fn spawn_401_then_ok_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut requests = 0;
            while let Ok((mut sock, _)) = listener.accept().await {
                requests += 1;
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                // `connection: close` is critical: without it HTTP/1.1
                // defaults to keep-alive and the eventsource stream hangs
                // forever waiting for the server to push more events or close
                // the TCP connection.
                let response = if requests == 1 {
                    "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        .to_string()
                } else {
                    sse_response(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"}}]}\n\ndata: [DONE]\n\n",
                    )
                };
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (addr, handle)
    }

    /// A local server that always answers 200 with a fixed body.
    async fn spawn_fixed_200_server(
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

    fn sse_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    async fn chat_once(llm: &NativeHttpLlm) -> Result<LLMChatResponse, String> {
        llm.chat(LLMChatParams {
            cancel: None,
            messages: Arc::from(Vec::new()),
            tools: Arc::from(Vec::new()),
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// An empty 200 body must be an error the retry layer can act on, not an
    /// `Ok` empty response that the step layer reports as a finished turn.
    #[tokio::test]
    async fn empty_sse_body_is_reported_instead_of_returning_an_empty_answer() {
        let (addr, server) = spawn_fixed_200_server("text/event-stream", "").await;
        let llm = NativeHttpLlm::new(
            config("openai", &format!("http://{addr}/v1")),
            String::new(),
        );
        let error = chat_once(&llm)
            .await
            .expect_err("empty body must not be Ok");
        assert!(
            error.contains("produced no events"),
            "unexpected error: {error}"
        );
        assert!(
            llm.is_retryable_error(&error),
            "a transient empty relay body must be retried: {error}"
        );
        server.abort();
    }

    /// A catch-all gateway answers 200 with anything. That must be diagnosed as
    /// a wrong endpoint, and must not be retried (retries cannot fix it).
    #[tokio::test]
    async fn non_sse_body_is_reported_as_a_misconfigured_endpoint() {
        let (addr, server) =
            spawn_fixed_200_server("text/html", "<html><body>index of /</body></html>").await;
        let llm = NativeHttpLlm::new(
            config("openai", &format!("http://{addr}/v1")),
            String::new(),
        );
        let error = chat_once(&llm)
            .await
            .expect_err("non-SSE body must not be Ok");
        assert!(
            error.starts_with(NOT_AN_SSE_ENDPOINT_PREFIX),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("content-type \"text/html\""),
            "the diagnosis must name the content type: {error}"
        );
        assert!(
            !llm.is_retryable_error(&error),
            "a misconfigured endpoint must not be retried: {error}"
        );
        server.abort();
    }

    /// Gateways report mid-stream failures in-band. The engine path used to
    /// ignore these and finish with whatever partial content had arrived.
    #[tokio::test]
    async fn in_band_error_frame_is_surfaced() {
        let (addr, server) = spawn_fixed_200_server(
            "text/event-stream",
            "data: {\"error\":{\"message\":\"upstream exploded\",\"type\":\"upstream_error\"}}\n\n",
        )
        .await;
        let llm = NativeHttpLlm::new(
            config("openai", &format!("http://{addr}/v1")),
            String::new(),
        );
        let error = chat_once(&llm)
            .await
            .expect_err("in-band error must not be Ok");
        assert!(
            error.contains("upstream exploded"),
            "the provider message must survive: {error}"
        );
        assert!(error.contains("llm provider stream error"), "{error}");
        server.abort();
    }

    /// The happy path still works, so the new guards are not over-eager.
    #[tokio::test]
    async fn a_normal_sse_stream_still_decodes() {
        let (addr, server) = spawn_fixed_200_server(
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n",
        )
        .await;
        let llm = NativeHttpLlm::new(
            config("openai", &format!("http://{addr}/v1")),
            String::new(),
        );
        let response = chat_once(&llm).await.expect("a normal stream must succeed");
        assert_eq!(response.content, "hello");
        server.abort();
    }

    #[tokio::test]
    async fn oauth_token_refreshes_once_on_401() {
        let (addr, server) = spawn_401_then_ok_server().await;

        let mut cfg = config("openai", &format!("http://{addr}/v1"));
        cfg.api_key = String::new();
        cfg.auth_provider = Some("kimi".into());
        let fetches = Arc::new(AtomicU32::new(0));
        let fetch_count = fetches.clone();
        let llm =
            NativeHttpLlm::new(cfg, String::new()).with_auth_provider(Arc::new(move |force| {
                let n = fetch_count.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move { Ok(format!("token-{n}-force-{force}")) })
            }));

        let result = llm
            .chat(LLMChatParams {
                cancel: None,
                messages: Arc::from(Vec::new()),
                tools: Arc::from(Vec::new()),
            })
            .await;
        let response = result.expect("expected the 401 to be recovered");
        assert_eq!(
            response.content, "recovered",
            "the post-refresh request must return the streamed content"
        );
        assert_eq!(
            fetches.load(Ordering::SeqCst),
            2,
            "initial fetch + exactly one forced refresh"
        );
        server.abort();
    }

    #[tokio::test]
    async fn oauth_cached_token_is_reused_across_requests() {
        // Test the caching logic directly via `credential()` without going
        // through the network at all — the network path is already covered by
        // `oauth_token_refreshes_once_on_401`.
        let mut cfg = config("openai", "http://127.0.0.1:1/v1");
        cfg.api_key = String::new();
        cfg.auth_provider = Some("kimi".into());
        let fetches = Arc::new(AtomicU32::new(0));
        let fetch_count = fetches.clone();
        let llm =
            NativeHttpLlm::new(cfg, String::new()).with_auth_provider(Arc::new(move |_force| {
                let n = fetch_count.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move { Ok(format!("token-{n}")) })
            }));

        // First call: cache miss, fetches token-1.
        let t1 = llm.credential().await.unwrap();
        assert_eq!(t1, "token-1");
        assert_eq!(fetches.load(Ordering::SeqCst), 1, "first call must fetch");

        // Second call: cache hit, must not invoke the provider again.
        let t2 = llm.credential().await.unwrap();
        assert_eq!(t2, "token-1", "cached token must be returned unchanged");
        assert_eq!(
            fetches.load(Ordering::SeqCst),
            1,
            "the cached token must serve the second call without a host round-trip"
        );
    }

    #[tokio::test]
    async fn oauth_without_wired_channel_fails_cleanly() {
        let mut cfg = config("openai", "http://127.0.0.1:1/v1");
        cfg.api_key = String::new();
        cfg.auth_provider = Some("kimi".into());
        let llm = NativeHttpLlm::new(cfg, String::new());
        let result = llm
            .chat(LLMChatParams {
                cancel: None,
                messages: Arc::from(Vec::new()),
                tools: Arc::from(Vec::new()),
            })
            .await;
        let msg = result.err().unwrap().to_string();
        assert!(
            msg.contains("no token channel is wired"),
            "unexpected error: {msg}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn oauth_cold_fetch_is_single_flighted_across_concurrent_callers() {
        let mut cfg = config("openai", "http://127.0.0.1:1/v1");
        cfg.api_key = String::new();
        cfg.auth_provider = Some("kimi".into());
        let fetches = Arc::new(AtomicU32::new(0));
        let fetch_count = fetches.clone();
        let llm = Arc::new(
            NativeHttpLlm::new(cfg, String::new()).with_auth_provider(Arc::new(move |_force| {
                let n = fetch_count.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move {
                    // Yield so concurrent callers pile up on the gate while the
                    // winner is still fetching.
                    tokio::task::yield_now().await;
                    Ok(format!("token-{n}"))
                })
            })),
        );

        let mut joins = Vec::new();
        for _ in 0..8 {
            let llm = Arc::clone(&llm);
            joins.push(tokio::spawn(async move { llm.credential().await.unwrap() }));
        }
        let mut tokens = Vec::new();
        for join in joins {
            tokens.push(join.await.unwrap());
        }
        assert_eq!(
            fetches.load(Ordering::SeqCst),
            1,
            "concurrent cold fetches must collapse to a single host round-trip"
        );
        assert!(
            tokens.iter().all(|t| t == "token-1"),
            "every caller reuses the winner's token: {tokens:?}"
        );
    }

    /// A degenerate thinking loop must stop reaching the host, while the
    /// answer that follows it still does. This drives the real SSE loop
    /// against a local server, so it covers the wiring and not just the guard.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_thinking_loop_is_dropped_from_the_stream() {
        const LOOP_DELTAS: usize = 60;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;

            let mut body = String::from(
                "data: {\"type\":\"content_block_start\",\"index\":0,\
                 \"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            );
            for _ in 0..LOOP_DELTAS {
                body.push_str(
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\
                     \"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Let me check. \"}}\n\n",
                );
            }
            body.push_str(
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
                 data: {\"type\":\"content_block_start\",\"index\":1,\
                 \"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
                 data: {\"type\":\"content_block_delta\",\"index\":1,\
                 \"delta\":{\"type\":\"text_delta\",\"text\":\"Here is the fix.\"}}\n\n\
                 data: {\"type\":\"message_stop\"}\n\n",
            );
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}"
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.flush().await;
        });

        let seen: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let cfg = config("anthropic", &format!("http://{addr}"));
        let llm = NativeHttpLlm::new(cfg, String::new()).with_sink(Arc::new(move |event| {
            sink_seen.lock().unwrap().push(event);
        }));

        llm.chat(LLMChatParams {
            cancel: None,
            messages: Arc::from(vec![crate::turn_loop::types::LLMMessage {
                role: "user".into(),
                content: "hi".into(),
                ..Default::default()
            }]),
            tools: Arc::from(Vec::new()),
        })
        .await
        .expect("the stream completes");

        let events = seen.lock().unwrap().clone();
        let think_deltas = events
            .iter()
            .filter(|e| e["part"]["type"] == "think")
            .count();
        let text_deltas = events
            .iter()
            .filter(|e| e["part"]["type"] == "text")
            .count();

        assert!(
            think_deltas > 0,
            "the opening of the thinking block is still shown"
        );
        assert!(
            think_deltas < LOOP_DELTAS,
            "the loop must stop reaching the host: {think_deltas} of {LOOP_DELTAS} forwarded"
        );
        assert_eq!(text_deltas, 1, "the answer is never gated");

        server.abort();
    }
}
