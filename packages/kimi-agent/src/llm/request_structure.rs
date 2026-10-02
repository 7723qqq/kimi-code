//! Recognising a provider's rejection of the request *structure*.
//!
//! A strict projection is only worth sending after the provider has told us the
//! shape of the request was the problem, so this module owns that decision and
//! nothing else. v2 keeps it in `isRecoverableRequestStructureError`
//! (`llm-adapter/contract/errors.ts:327`), which delegates to
//! `isRequestStructureStatusError` (`human/llm/errors.ts:306`):
//!
//! ```text
//! isRecoverableRequestStructureError
//!   └─ not an APIStatusError                      → false
//!   └─ is an APIContextOverflowError              → false
//!   └─ isRequestStructureStatusError(status, msg)
//!        ├─ status not 400 / 422                   → false
//!        ├─ isToolExchangeAdjacencyStatusError     → true
//!        └─ STRUCTURAL_REQUEST_MESSAGE_PATTERNS   → true
//! ```
//!
//! The two recovery classes that share a 400 are deliberately *not* handled
//! here: context overflow and media rejection are classified first by the caller
//! and have their own recoveries (v2 checks them in the same order,
//! `llmRequesterService.ts:583-601`). A strict projection cannot fix either —
//! one compacts, the other strips media — so a structure verdict here would
//! trade a working recovery for a wasted round trip.

/// v2 `TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS`
/// (`human/llm/errors.ts:155-164`).
///
/// The provider complaining that a `tool_use` block and its `tool_result` are
/// not adjacent, or that a result answers no call. This is the half of the
/// structure class that `dedupe_duplicate_tool_calls` actually addresses.
const TOOL_EXCHANGE_ADJACENCY_PATTERNS: [&str; 6] = [
    "role 'tool' must be a response to a preceding message",
    "role \"tool\" must be a response to a preceding message",
    "role `tool` must be a response to a preceding message",
    "assistant message with 'tool_calls' must be followed by tool messages",
    "tool_call_ids did not have response messages",
    "insufficient tool messages following",
];

/// v2 `STRUCTURAL_REQUEST_MESSAGE_PATTERNS`
/// (`human/llm/errors.ts:166-174`), restricted to the entries that are plain
/// substrings. The two that are not — the `in a row` and the `message at
/// position` patterns — are matched by [`matches_shaped_patterns`] below
/// rather than being flattened, because a bare `"in a row"` would fire on any
/// prose that happens to end a sentence with it.
const STRUCTURAL_REQUEST_PATTERNS: [&str; 6] = [
    "text content blocks must be non-empty",
    "text content blocks must be non empty",
    "text content blocks must contain non-whitespace",
    "text content blocks must contain non whitespace",
    "first message must use the",
    "roles must alternate",
];

/// v2's two shaped patterns:
/// `/multiple .*(?:user|assistant).* roles in a row/` and
/// `/message at position \d+ with role ['"`]?[a-z]+['"`]? must not be empty/`.
fn matches_shaped_patterns(lower: &str) -> bool {
    // `multiple <anything> user|assistant <anything> roles in a row`
    if lower.contains("multiple ") && lower.contains(" roles in a row") {
        let between = lower
            .split_once("multiple ")
            .map(|(_, rest)| rest.split(" roles in a row").next().unwrap_or(""))
            .unwrap_or("");
        if between.contains("user") || between.contains("assistant") {
            return true;
        }
    }
    // `message at position <digits> with role <word> must not be empty`
    if lower.contains("message at position") && lower.contains("must not be empty") {
        let rest = lower
            .split_once("message at position")
            .map(|(_, rest)| rest.trim_start())
            .unwrap_or("");
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            return true;
        }
    }
    false
}

/// v2 `isToolExchangeAdjacencyStatusError` (`human/llm/errors.ts:300-304`).
///
/// The status alone does not decide: a 400 that says nothing about the tool
/// exchange is some other 400. v2 gates on `400`/`422` and then matches prose.
fn is_tool_exchange_adjacency_error(status: u16, lower: &str) -> bool {
    if status != 400 && status != 422 {
        return false;
    }
    // v2's first two patterns are `/tool_use[\s\S]*tool_result/` and its
    // mirror — order-independent, so "both appear" is the same test. A third
    // (`/unexpected\s+`?tool_result/`) is covered by the `tool_result` arm
    // below being present at all. Note this pair is NOT sufficient on its own:
    // a message naming both without complaining about the exchange would
    // otherwise be swallowed, so the plain patterns still get their turn.
    let has_use = lower.contains("tool_use");
    let has_result = lower.contains("tool_result");
    if has_use && has_result {
        return true;
    }
    if has_result && lower.contains("unexpected") {
        return true;
    }
    // `tool_use[\s\S]*ids must be unique` — the gap between the two halves is
    // unconstrained in v2, and real bodies write it as `tool_use ids must be
    // unique`, so a literal `tool_use_ids` would miss the very complaint
    // `dedupe_duplicate_tool_calls` exists to answer. Matched by splitting on
    // `ids must be unique` and checking that `tool_use` precedes it.
    if let Some((before, _)) = lower.split_once("ids must be unique")
        && before.contains("tool_use")
    {
        return true;
    }
    // `/tool_call_id[\s\S]*not found/` — same unconstrained gap as above; real
    // bodies write `tool_call_id: call_9 not found`, not the adjacent form.
    if let Some((before, _)) = lower.split_once("not found")
        && before.contains("tool_call_id")
    {
        return true;
    }
    TOOL_EXCHANGE_ADJACENCY_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// v2 `isRequestStructureStatusError` (`human/llm/errors.ts:306-311`).
///
/// Whether a status-coded provider error means the request's *shape* was
/// rejected — as opposed to its size, its media, or its credentials.
pub fn is_request_structure_error(status: u16, message: &str) -> bool {
    let lower = message.to_lowercase();
    if is_tool_exchange_adjacency_error(status, &lower) {
        return true;
    }
    if status != 400 && status != 422 {
        return false;
    }
    STRUCTURAL_REQUEST_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
        || matches_shaped_patterns(&lower)
}

/// The `WarningEvent.code` a strict-projection retry reports under (v2's
/// `strict` projection, `llmRequesterService.ts:600`).
pub const STRUCTURE_STRICT_CODE: &str = "structure-strict";

/// v2 `isRecoverableRequestStructureError`
/// (`llm-adapter/contract/errors.ts:327-331`), reading the status back out of a
/// rendered transport error the way the sibling classifiers in
/// `llm::media_budget` do.
pub fn is_recoverable_request_structure_error(error: &str) -> bool {
    match crate::llm::http::llm_http_status(error) {
        Some(status) => is_request_structure_error(status, error),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_tool_exchange_complaints_it_can_repair() {
        for message in [
            "messages: tool_use ids must be unique",
            "unexpected `tool_result` block in the request",
            "tool_use block and tool_result block are not adjacent",
            "Invalid `tool_call_id`: not found in the preceding messages",
        ] {
            assert!(
                is_recoverable_request_structure_error(&format!("llm http status 400: {message}")),
                "expected a structure verdict for {message:?}"
            );
        }
    }

    #[test]
    fn accepts_the_remaining_shape_complaints() {
        for (status, message) in [
            (400, "text content blocks must be non-empty"),
            (400, "roles must alternate between user and assistant"),
            (400, "first message must use the \"user\" role"),
            (
                400,
                "invalid_request_error: message at position 3 with role \"user\" must not be empty",
            ),
            (422, "text content blocks must contain non-whitespace"),
        ] {
            assert!(
                is_recoverable_request_structure_error(&format!(
                    "llm http status {status}: {message}"
                )),
                "expected a structure verdict for {message:?}"
            );
        }
    }

    /// A strict projection is only the right recovery for a shape complaint. The
    /// two classes that share a 400 must fall through to the recoveries that
    /// already handle them — otherwise this branch would swallow a compaction
    /// or a media strip that actually works.
    #[test]
    fn declines_the_classes_that_have_their_own_recovery() {
        for (status, message) in [
            (413, "Request too large"),
            (400, "invalid image data"),
            (400, "prompt is too long: 250000 tokens > 200000 maximum"),
            (429, "rate limit exceeded"),
            (500, "internal server error"),
            (401, "invalid api key"),
        ] {
            assert!(
                !is_recoverable_request_structure_error(&format!(
                    "llm http status {status}: {message}"
                )),
                "{message:?} must not be answered with a strict projection"
            );
        }
    }

    /// A body that never reached a status is a transport failure, not a verdict
    /// about the request's shape — resending it strictly would burn a round trip
    /// on a connection reset.
    #[test]
    fn declines_an_error_that_carries_no_status() {
        assert!(!is_recoverable_request_structure_error(
            "error sending request for url (https://api.example.com/v1/chat/completions)"
        ));
        assert!(!is_recoverable_request_structure_error(
            "connection reset by peer"
        ));
    }

    /// A 400 that says nothing about structure is some other 400. v2 gates the
    /// adjacency class on the status but still requires prose, so a bare
    /// "invalid request" must not be treated as repairable.
    #[test]
    fn declines_a_bare_400_with_no_shape_complaint() {
        assert!(!is_recoverable_request_structure_error(
            "llm http status 400: invalid request"
        ));
    }
}
