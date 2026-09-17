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
        }
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
}
