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
}

/// An [`LLM`] implementation that talks to an OpenAI-compatible or
/// Anthropic endpoint over HTTPS with SSE streaming.
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
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
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

    fn endpoint(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        match self.config.protocol.as_str() {
            "anthropic" => format!("{base}/messages"),
            "openai_responses" | "openai-responses" => format!("{base}/responses"),
            "google" | "google-genai" | "gemini" => {
                format!(
                    "{base}/models/{}:streamGenerateContent?alt=sse",
                    self.config.model
                )
            }
            _ => format!("{base}/chat/completions"),
        }
    }

    fn emit_delta(&self, delta: &StreamDelta) {
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
            google_genai::build_request_full(&wire, &params.tools, self.config.thinking_budget)
        } else {
            openai::build_request_full(
                &self.config.model,
                &wire,
                &params.tools,
                true,
                self.config.reasoning_effort.as_deref(),
            )
        };

        let mut token = self.credential().await?;
        let mut response = self.send_request(&body, token.as_str()).await?;
        let mut status = response.status();
        // A 401/403 on an OAuth-managed transport means the cached token went
        // stale (expired early, revoked, rotated); force a host-side refresh
        // and retry once before surfacing the failure. Static-key transports
        // have nothing to refresh — a bad key never becomes good by retrying.
        if !status.is_success() && matches!(status.as_u16(), 401 | 403) && self.auth.is_some() {
            token = self.refresh_credential().await?;
            response = self.send_request(&body, token.as_str()).await?;
            status = response.status();
        }
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

        let mut stream = response.bytes_stream().eventsource();
        while let Some(event) = stream.next().await {
            let event = event.map_err(|e| format!("llm sse decode error: {e}"))?;
            if event.data == "[DONE]" {
                break;
            }
            let value: serde_json::Value = match serde_json::from_str(&event.data) {
                Ok(v) => v,
                // Tolerate non-JSON keep-alive payloads.
                Err(_) => continue,
            };
            if let Some(delta) = acc.feed(&value) {
                self.emit_delta(&delta);
            }
        }

        let response = acc.finish();

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
        } else {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        for (k, v) in &self.config.custom_headers {
            req = req.header(k.as_str(), v.as_str());
        }
        req.send()
            .await
            .map_err(|e| format!("{}: {e}", transport_error_message(&e)))
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

/// Cap on how much of an error body is read. Only a brief excerpt is
/// rendered, so there is no reason to buffer an unbounded response first.
const ERROR_BODY_MAX_BYTES: usize = 16 * 1024;

/// Build the machine-readable transport-error prefix. reqwest 0.12's
/// `Display` hides the actual cause (timeout / refused / DNS ...) behind
/// `.source()`, so classify it here while the `reqwest::Error` is in hand —
/// the retry layer matches this prefix instead of grepping free text.
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
        if let Some(rest) = error.strip_prefix("llm http status ") {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let code: u16 = digits.parse().unwrap_or(0);
            return matches!(code, 408 | 425 | 429 | 500..=599);
        }
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
        const RETRYABLE: &[&str] = &[
            "overloaded",
            "timed out",
            "timeout",
            "connect",
            "connection",
            "sse decode error",
        ];
        let lower = error.to_lowercase();
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
        assert!(llm.is_retryable_error("llm http status 503 Service Unavailable: busy"));
        assert!(llm.is_retryable_error("llm transport error connect: connection refused"));
        assert!(llm.is_retryable_error("llm transport error timeout: operation timed out"));
        assert!(llm.is_retryable_error("llm sse decode error: expected value at line 1"));
        assert!(!llm.is_retryable_error("llm http status 401 Unauthorized: bad key"));
        assert!(!llm.is_retryable_error("llm http status 400 Bad Request: invalid schema"));
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
                messages: vec![],
                tools: vec![],
            })
            .await;
        assert!(result.is_err());
        let msg = result.err().unwrap().to_string();
        assert!(
            msg.contains("llm transport error"),
            "unexpected error: {msg}"
        );
    }

    /// One-shot local HTTP server: the first request draws a 401, every later
    /// one a 200 with an empty SSE body (the accumulator finishes on EOF).
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
                } else {
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n"
                };
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (addr, handle)
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
                messages: vec![],
                tools: vec![],
            })
            .await;
        assert!(
            result.is_ok(),
            "expected the 401 to be recovered: {result:?}"
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
                messages: vec![],
                tools: vec![],
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
}
