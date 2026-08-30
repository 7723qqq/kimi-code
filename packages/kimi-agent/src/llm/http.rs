//! Native HTTP LLM transport — calls the provider directly from Rust with
//! SSE streaming, instead of proxying `llm_chat` back to the JS host.
//!
//! Request projection and stream accumulation live in `openai.rs` /
//! `anthropic.rs` (pure functions); this module owns the transport:
//! reqwest client, credentials, SSE decoding, and delta forwarding.

use std::sync::Arc;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::llm::wire::to_wire;
use crate::llm::{anthropic, openai};
use crate::rpc::types::{BoxFuture, NativeLlmConfig};
use crate::turn_loop::types::{LLM, LLMChatParams, LLMChatResponse};

/// Default `max_tokens` for the Anthropic Messages API when the host does
/// not configure one (the field is mandatory there).
const DEFAULT_ANTHROPIC_MAX_TOKENS: u32 = 8192;

/// Per-request timeout. Generous because streaming responses for long
/// completions can take minutes; the read is still bounded per-chunk by
/// the connect/idle behavior of the pool.
const REQUEST_TIMEOUT_SECS: u64 = 600;

/// Fire-and-forget sink for streaming events (text deltas). The value is a
/// JSON event object; the receiver forwards it to the JS host transcript.
pub type EventSink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// An [`LLM`] implementation that talks to an OpenAI-compatible or
/// Anthropic endpoint over HTTPS with SSE streaming.
pub struct NativeHttpLlm {
    config: NativeLlmConfig,
    system_prompt: String,
    client: reqwest::Client,
    sink: Option<EventSink>,
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
        }
    }

    /// Attach a streaming event sink. Text deltas are forwarded to it as
    /// `{ "type": "llm.delta", "part": { "type": "text", "text": ... } }`.
    pub fn with_sink(mut self, sink: EventSink) -> Self {
        self.sink = Some(sink);
        self
    }

    fn endpoint(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        match self.config.protocol.as_str() {
            "anthropic" => format!("{base}/messages"),
            _ => format!("{base}/chat/completions"),
        }
    }

    fn emit_delta(&self, text: &str) {
        if let Some(ref sink) = self.sink {
            sink(serde_json::json!({
                "type": "llm.delta",
                "part": { "type": "text", "text": text },
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
        let started_at = std::time::Instant::now();

        // Step boundary: the host mirrors these into transcript step events.
        self.emit(serde_json::json!({ "type": "llm.step.begin", "model": self.config.model }));

        let body = if is_anthropic {
            anthropic::build_request_with_options(
                &self.config.model,
                self.config
                    .max_tokens
                    .unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS),
                &wire,
                &params.tools,
                true,
            )
        } else {
            openai::build_request_with_options(&self.config.model, &wire, &params.tools, true)
        };

        let mut req = self.client.post(self.endpoint()).json(&body);
        if is_anthropic {
            req = req
                .header("x-api-key", &self.config.api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            req = req.header("authorization", format!("Bearer {}", self.config.api_key));
        }
        for (k, v) in &self.config.custom_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let response = req
            .send()
            .await
            .map_err(|e| format!("{}: {e}", transport_error_message(&e)))?;

        let status = response.status();
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

        // Two accumulator shapes (different SSE grammars); drive whichever
        // matches the protocol over the same event stream.
        let mut openai_acc = (!is_anthropic).then(openai::StreamAccumulator::new);
        let mut anthropic_acc = is_anthropic.then(anthropic::StreamAccumulator::new);

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
            let delta = if let Some(acc) = openai_acc.as_mut() {
                acc.feed(&value)
            } else if let Some(acc) = anthropic_acc.as_mut() {
                acc.feed(&value)
            } else {
                None
            };
            if let Some(text) = delta {
                self.emit_delta(&text);
            }
        }

        let response = match (openai_acc, anthropic_acc) {
            (Some(acc), _) => acc.finish(),
            (_, Some(acc)) => acc.finish(),
            _ => unreachable!("one accumulator is always constructed"),
        };

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

    fn config(protocol: &str, base_url: &str) -> NativeLlmConfig {
        NativeLlmConfig {
            protocol: protocol.into(),
            base_url: base_url.into(),
            api_key: "test-key".into(),
            model: "test-model".into(),
            max_tokens: None,
            custom_headers: HashMap::new(),
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
        assert!(llm.is_retryable_error(
            "llm transport error decode: error decoding response body"
        ));
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
}
