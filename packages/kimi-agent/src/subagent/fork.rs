//! Native subagent context forking and open tool exchange reconciliation.
//!
//! Mirrors `openToolExchange.ts` and `spawn.ts` from upstream
//! `agent-core-v2/src/agent/contextMemory/` and `session/subagent/`.

use std::collections::HashSet;

use crate::turn_loop::types::{LLMMessage, ToolCall};

/// Synthetic tool output placed into an inherited conversation for tool calls
/// that were still executing on the parent agent when the fork was created.
pub const INHERITED_IN_FLIGHT_TOOL_OUTPUT: &str =
    "This tool call was still executing when this conversation snapshot was inherited \
from the source agent, so its result is not part of this context. The outcome is \
unknown — do not assume it succeeded or failed, and do not wait for it.";

pub const FORK_WITH_RESUME_UNAVAILABLE: &str =
    "A non-empty resume cannot be combined with fork.";
pub const FORK_WITH_TYPE_UNAVAILABLE: &str =
    "subagent_type must match the caller's profile when fork is enabled.";
pub const FORK_WITH_MODEL_UNAVAILABLE: &str =
    "model must match the caller's model or 'primary' when fork is enabled.";
pub const PRIMARY_SUBAGENT_MODEL_CHOICE: &str = "primary";

/// Validate arguments for a fork-enabled subagent invocation against caller's profile.
///
/// Mirrors `forkIncompatibility` in `upstream/main:packages/agent-core-v2/src/session/subagent/spawn.ts`.
pub fn fork_incompatibility(
    resume: Option<&str>,
    subagent_type: Option<&str>,
    model: Option<&str>,
    caller_profile: &str,
    caller_model: Option<&str>,
) -> Option<&'static str> {
    if let Some(r) = resume
        && !r.trim().is_empty()
    {
        return Some(FORK_WITH_RESUME_UNAVAILABLE);
    }
    if let Some(st) = subagent_type {
        let trimmed = st.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case(caller_profile) {
            return Some(FORK_WITH_TYPE_UNAVAILABLE);
        }
    }
    if let Some(m) = model {
        let trimmed = m.trim();
        if !trimmed.is_empty()
            && trimmed != PRIMARY_SUBAGENT_MODEL_CHOICE
            && caller_model.map(|cm| cm != trimmed).unwrap_or(true)
        {
            return Some(FORK_WITH_MODEL_UNAVAILABLE);
        }
    }
    None
}

/// Close any unanswered trailing tool calls in the conversation history with synthetic
/// in-flight results before handing the conversation snapshot to a forked child.
///
/// Mirrors `closeTrailingOpenToolExchange` in upstream `agent-core-v2/src/agent/contextMemory/openToolExchange.ts`.
pub fn close_trailing_open_tool_exchange(history: &[LLMMessage]) -> Vec<LLMMessage> {
    if history.is_empty() {
        return Vec::new();
    }

    let mut last_non_tool_index = history.len() as isize - 1;
    while last_non_tool_index >= 0 && history[last_non_tool_index as usize].role == "tool" {
        last_non_tool_index -= 1;
    }

    if last_non_tool_index < 0 {
        return history.to_vec();
    }

    let idx = last_non_tool_index as usize;
    let assistant = &history[idx];
    if assistant.role != "assistant" || assistant.tool_calls.is_empty() {
        return history.to_vec();
    }

    let answered_ids: HashSet<&str> = history[idx + 1..]
        .iter()
        .filter(|m| m.role == "tool")
        .filter_map(|m| m.tool_call_id.as_deref())
        .collect();

    let open_calls: Vec<&ToolCall> = assistant
        .tool_calls
        .iter()
        .filter(|tc| !answered_ids.contains(tc.id.as_str()))
        .collect();

    if open_calls.is_empty() {
        return history.to_vec();
    }

    let mut result = Vec::with_capacity(history.len() + open_calls.len());
    result.extend_from_slice(&history[..=idx]);
    result.extend_from_slice(&history[idx + 1..]);
    for tc in open_calls {
        result.push(LLMMessage {
            role: "tool".into(),
            content: INHERITED_IN_FLIGHT_TOOL_OUTPUT.into(),
            blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: Some(tc.id.clone()),
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_history() {
        assert_eq!(close_trailing_open_tool_exchange(&[]), Vec::<LLMMessage>::new());
    }

    #[test]
    fn test_history_without_tool_calls() {
        let history = vec![LLMMessage::new("user", "hi")];
        assert_eq!(close_trailing_open_tool_exchange(&history), history);
    }

    #[test]
    fn test_fully_answered_trailing_exchange() {
        let read_call = ToolCall {
            id: "call_read".into(),
            name: "Read".into(),
            arguments: "{}".into(),
            extras: None,
        };
        let history = vec![
            LLMMessage::new("user", "hi"),
            LLMMessage {
                role: "assistant".into(),
                content: String::new(),
                blocks: Vec::new(),
                tool_calls: vec![read_call],
                tool_call_id: None,
            },
            LLMMessage {
                role: "tool".into(),
                content: "contents".into(),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_read".into()),
            },
        ];
        assert_eq!(close_trailing_open_tool_exchange(&history), history);
    }

    #[test]
    fn test_closes_unanswered_trailing_call() {
        let agent_call = ToolCall {
            id: "call_agent".into(),
            name: "Agent".into(),
            arguments: "{}".into(),
            extras: None,
        };
        let history = vec![
            LLMMessage::new("user", "hi"),
            LLMMessage {
                role: "assistant".into(),
                content: "delegating the follow-up".into(),
                blocks: Vec::new(),
                tool_calls: vec![agent_call],
                tool_call_id: None,
            },
        ];
        let closed = close_trailing_open_tool_exchange(&history);
        assert_eq!(closed.len(), 3);
        assert_eq!(closed[0].role, "user");
        assert_eq!(closed[1].role, "assistant");
        assert_eq!(closed[2].role, "tool");
        assert_eq!(closed[2].tool_call_id.as_deref(), Some("call_agent"));
        assert_eq!(closed[2].content, INHERITED_IN_FLIGHT_TOOL_OUTPUT);
    }

    #[test]
    fn test_fills_only_unanswered_calls_of_partial_parallel_batch() {
        let read_call = ToolCall {
            id: "call_read".into(),
            name: "Read".into(),
            arguments: "{}".into(),
            extras: None,
        };
        let agent_call = ToolCall {
            id: "call_agent".into(),
            name: "Agent".into(),
            arguments: "{}".into(),
            extras: None,
        };
        let history = vec![
            LLMMessage::new("user", "hi"),
            LLMMessage {
                role: "assistant".into(),
                content: String::new(),
                blocks: Vec::new(),
                tool_calls: vec![read_call, agent_call],
                tool_call_id: None,
            },
            LLMMessage {
                role: "tool".into(),
                content: "contents".into(),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_read".into()),
            },
        ];
        let closed = close_trailing_open_tool_exchange(&history);
        assert_eq!(closed.len(), 4);
        assert_eq!(closed[2].tool_call_id.as_deref(), Some("call_read"));
        assert_eq!(closed[2].content, "contents");
        assert_eq!(closed[3].tool_call_id.as_deref(), Some("call_agent"));
        assert_eq!(closed[3].content, INHERITED_IN_FLIGHT_TOOL_OUTPUT);
    }

    #[test]
    fn test_fork_incompatibility_rules() {
        // Non-empty resume rejected
        assert_eq!(
            fork_incompatibility(Some("agent-1"), None, None, "coder", None),
            Some(FORK_WITH_RESUME_UNAVAILABLE)
        );
        // Empty resume passes
        assert_eq!(
            fork_incompatibility(Some(""), None, None, "coder", None),
            None
        );

        // Mismatched subagent_type rejected
        assert_eq!(
            fork_incompatibility(None, Some("plan"), None, "coder", None),
            Some(FORK_WITH_TYPE_UNAVAILABLE)
        );
        // Matching subagent_type passes (case-insensitive)
        assert_eq!(
            fork_incompatibility(None, Some("Coder"), None, "coder", None),
            None
        );

        // Mismatched model rejected
        assert_eq!(
            fork_incompatibility(None, None, Some("other-model"), "coder", Some("my-model")),
            Some(FORK_WITH_MODEL_UNAVAILABLE)
        );
        // 'primary' model passes
        assert_eq!(
            fork_incompatibility(None, None, Some("primary"), "coder", Some("my-model")),
            None
        );
        // Matching caller_model passes
        assert_eq!(
            fork_incompatibility(None, None, Some("my-model"), "coder", Some("my-model")),
            None
        );
    }
}
