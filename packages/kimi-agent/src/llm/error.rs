//! The typed failure an LLM transport raises.
//!
//! v2 keeps provider request metadata on the error object itself — `statusCode`,
//! `retryAfterMs`, `requestId`, `headers` (`llm-adapter/contract/errors.ts`) —
//! and every classifier reads those fields rather than the message
//! (`normalizeAPIStatusError`, `classifyApiError`). The Rust transport renders a
//! single string instead, which forced the retry layer to recover the wait with
//! a substring search over the rendered text. This module restores the typed
//! channel for the two fields the retry layer actually needs, without changing
//! the `LLM` trait's `Box<dyn Error>` signature.

use std::time::Duration;

/// An LLM transport failure with the request metadata v2 keeps on its typed API
/// errors.
///
/// The retry layer reads [`Self::retry_after`] and [`Self::status_code`]
/// directly. The rendered message still carries the same text a bare string
/// would, because the message is what logs, telemetry and every string-based
/// classifier (`is_retryable_error`, `is_context_overflow_error`) consume — so
/// `Display` is byte-identical to the string this replaced.
#[derive(Debug, Clone)]
pub struct LlmError {
    message: String,
    /// The wait the provider asked for, at millisecond precision. v2
    /// `retryAfterMs`; `None` when the provider asked for nothing.
    retry_after: Option<Duration>,
    /// The HTTP status, when the failure reached a response. v2 `statusCode`.
    status_code: Option<u16>,
    /// The provider's own request id for the failed call (v2 `requestId`),
    /// captured from the `x-trace-id` response header. It is the one string a
    /// user can quote to the provider's support, and nothing else in the
    /// failure carries it.
    request_id: Option<String>,
}

impl LlmError {
    /// Build a status-coded failure.
    ///
    /// Renders as `llm http status {status}: {brief}` plus a
    /// ` (retry-after {seconds}s)` suffix when the provider asked for a wait —
    /// the shape the retry layer used to parse back out. The suffix is now
    /// diagnostic: it keeps the wait visible in logs and preserves the wire
    /// text, while [`Self::retry_after`] is what the retry layer actually uses.
    pub fn http(status: u16, brief: &str, retry_after: Option<Duration>) -> Self {
        let suffix = retry_after.map_or(String::new(), |wait| {
            format!(" (retry-after {}s)", wait.as_secs())
        });
        Self {
            message: format!("llm http status {status}: {brief}{suffix}"),
            retry_after,
            status_code: Some(status),
            request_id: None,
        }
    }

    /// Attach the provider's request id and append it to the rendered message.
    ///
    /// v2 keeps `requestId` on the typed error and every classifier reads the
    /// field; this transport renders a string, so the id is written into it as
    /// well — the field is what code reads, the suffix is what a log and a bug
    /// report show. The suffix is absent when the provider sent no header, which
    /// keeps the rendered text of the common case exactly what it was.
    #[must_use]
    pub fn with_request_id(mut self, request_id: Option<&str>) -> Self {
        let Some(id) = request_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return self;
        };
        self.message = format!("{} [trace {id}]", self.message);
        self.request_id = Some(id.to_string());
        self
    }

    /// The rendered message, without the `Display` round trip.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The wait the provider asked for, if any.
    pub fn retry_after(&self) -> Option<Duration> {
        self.retry_after
    }

    /// The HTTP status, if the failure reached a response.
    pub fn status_code(&self) -> Option<u16> {
        self.status_code
    }

    /// The provider's request id for a failed call, when it sent one.
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LlmError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_same_text_the_bare_string_used_to() {
        let without = LlmError::http(500, "internal server error", None);
        assert_eq!(
            without.to_string(),
            "llm http status 500: internal server error"
        );
        assert_eq!(without.status_code(), Some(500));
        assert_eq!(without.retry_after(), None);

        let with = LlmError::http(429, "slow down", Some(Duration::from_secs(7)));
        assert_eq!(
            with.to_string(),
            "llm http status 429: slow down (retry-after 7s)"
        );
        assert_eq!(with.retry_after(), Some(Duration::from_secs(7)));
    }

    /// The typed field keeps sub-second precision that the rendered suffix
    /// drops — the reason the round trip had to go.
    #[test]
    fn keeps_sub_second_precision_the_suffix_loses() {
        let err = LlmError::http(429, "slow down", Some(Duration::from_millis(1500)));
        assert_eq!(err.retry_after(), Some(Duration::from_millis(1500)));
        // The diagnostic suffix still reads as whole seconds.
        assert_eq!(
            err.to_string(),
            "llm http status 429: slow down (retry-after 1s)"
        );
    }

    /// The string classifiers must keep working on a rendered `LlmError`, since
    /// that is all they are handed.
    #[test]
    fn renders_a_string_the_classifiers_still_read() {
        let err = LlmError::http(413, "request too large", None);
        assert_eq!(
            crate::llm::http::llm_http_status(&err.to_string()),
            Some(413)
        );
    }

    /// The provider's request id is the one identifier its support can search
    /// on, so a failed call must keep it — in the field and in the text.
    #[test]
    fn a_request_id_is_carried_and_rendered() {
        let err = LlmError::http(500, "upstream broke", None).with_request_id(Some("abc-123"));
        assert_eq!(err.request_id(), Some("abc-123"));
        assert_eq!(
            err.to_string(),
            "llm http status 500: upstream broke [trace abc-123]"
        );
        // The typed channel survives the same suffix the retry layer parses
        // around: a status classifier must still find the code.
        assert_eq!(
            crate::llm::http::llm_http_status(&err.to_string()),
            Some(500)
        );
    }

    /// With no id the rendered text must be byte-identical to what it was
    /// before the field existed — that is the contract this module states for
    /// `Display`, and the common case is a provider that sends no header.
    #[test]
    fn no_request_id_leaves_the_message_untouched() {
        let plain = LlmError::http(429, "slow down", Some(Duration::from_secs(7)));
        let expected = "llm http status 429: slow down (retry-after 7s)";
        assert_eq!(plain.to_string(), expected);
        for absent in [None, Some(""), Some("   ")] {
            let err = LlmError::http(429, "slow down", Some(Duration::from_secs(7)))
                .with_request_id(absent);
            assert_eq!(err.to_string(), expected, "absent: {absent:?}");
            assert_eq!(err.request_id(), None);
        }
    }

    /// The id is trimmed, so a header padded with whitespace cannot put a
    /// trailing blank inside the marker.
    #[test]
    fn a_request_id_is_trimmed() {
        let err = LlmError::http(503, "busy", None).with_request_id(Some("  t-9  "));
        assert_eq!(err.request_id(), Some("t-9"));
        assert!(err.to_string().ends_with("[trace t-9]"));
    }
}
