//! The thinking effort an OpenAI-shaped request puts on the wire.
//!
//! v2 encodes thinking inside the requester
//! (`human/llm/thinking.ts::resolveThinkingEffort`, reached from
//! `prepareOpenAIRequest` through `encodeReasoningEffortFallback`): two of the
//! tokens the host resolves are **host-level**, not wire values, and are
//! encoded silently —
//!
//! - `"on"` — "thinking enabled, no concrete level chosen". It is what a
//!   boolean model resolves to (one that declares `thinking` but no
//!   `support_efforts`, so the effort axis is on/off rather than a scale).
//! - `"off"` — thinking disabled. The wire value in that case is the model's
//!   own `off_effort`, when it declares one; otherwise nothing is sent.
//!
//! Every other value is a declared effort and travels verbatim.
//!
//! Forwarding `"on"` breaks the request. The OpenAI-compatible vendors validate
//! the field against a fixed set and reject anything else:
//!
//! ```text
//! 400 {"error":{"type":"server_error","message":"Upstream request failed:
//!     [400] reasoning_effort: Invalid option: expected one of
//!     \"max\"|\"xhigh\"|\"high\"|\"medium\"|\"low\"|\"minimal\"|\"none\""}}
//! ```
//!
//! `"on"` is not in that set, so a session on a boolean model could not send a
//! single turn. `"none"` **is** in the set, which is why the filter here keeps
//! it: an `off_effort` of `"none"` is a real wire value that must survive to the
//! provider for thinking to actually turn off.

/// The value to send as the request's reasoning effort, or `None` to omit the
/// field entirely.
///
/// `"on"`, `"off"` and the empty string are host-level tokens with no wire
/// meaning; a declared effort — including `"none"`, which vendors accept as
/// "reasoning off" — is returned unchanged.
pub(crate) fn wire_reasoning_effort(effort: Option<&str>) -> Option<&str> {
    effort.filter(|value| !value.is_empty() && *value != "off" && *value != "on")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_declared_efforts_verbatim() {
        for effort in [
            "low", "medium", "high", "xhigh", "max", "minimal", "none", "4096",
        ] {
            assert_eq!(
                wire_reasoning_effort(Some(effort)),
                Some(effort),
                "{effort} is a declared effort and must reach the wire unchanged"
            );
        }
    }

    #[test]
    fn drops_the_host_level_tokens() {
        // `on` is the boolean-model sentinel; sending it is a 400.
        assert_eq!(wire_reasoning_effort(Some("on")), None);
        assert_eq!(wire_reasoning_effort(Some("off")), None);
        assert_eq!(wire_reasoning_effort(Some("")), None);
        assert_eq!(wire_reasoning_effort(None), None);
    }

    #[test]
    fn does_not_trim_or_lowercase() {
        // The host trims before it resolves an effort, and a value it let
        // through is the value the provider declared — "On" is a typo the
        // provider should reject loudly rather than a token to swallow.
        assert_eq!(wire_reasoning_effort(Some("On")), Some("On"));
        assert_eq!(wire_reasoning_effort(Some(" on ")), Some(" on "));
    }
}
