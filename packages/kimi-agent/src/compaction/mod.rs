//! Turn-internal context compaction.
//!
//! When the message history approaches the model's context window, the
//! oldest messages are replaced by a summary placeholder so the turn can
//! continue instead of failing on a context overflow. Mirrors the
//! windowing strategy of
//! `packages/agent-core-v2/src/agent/fullCompaction/strategy.ts` (and its
//! native twin `packages/kimi-native-tools/src/compaction.rs`): the system
//! prompt is always preserved, the oldest messages are dropped up to a
//! split point that cannot orphan a tool exchange, and the most recent
//! tail is kept verbatim.

use crate::turn_loop::types::{ContentBlock, LLMMessage};

/// Default context window (tokens) assumed when the engine has no model
/// capability data. Mirrors `DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS` in
/// `packages/kimi-native-tools/src/compaction.rs`.
pub const DEFAULT_MAX_CONTEXT_TOKENS: u32 = 128 * 1024;

/// Knobs for the compaction algorithm, mirroring `DEFAULT_COMPACTION_CONFIG`
/// in `packages/agent-core-v2/src/agent/fullCompaction/strategy.ts`.
#[derive(Debug, Clone, Copy)]
pub struct CompactionConfig {
    /// Context window in tokens; compaction triggers once the estimated
    /// history reaches `trigger_ratio * max_context_tokens` or leaves less
    /// than `reserved_context_size` tokens of headroom.
    pub max_context_tokens: u32,
    /// Fraction of the window that triggers compaction.
    pub trigger_ratio: f64,
    /// Headroom (tokens) to keep free below the window; compaction also
    /// triggers when `used + reserved >= max`.
    pub reserved_context_size: u32,
    /// How many trailing messages to keep verbatim.
    pub max_recent_messages: u32,
    /// How many trailing user messages to keep verbatim (`u32::MAX` =
    /// unlimited, mirroring the TS `Infinity` default).
    pub max_recent_user_messages: u32,
    /// Fraction of the window the recent tail may occupy.
    pub max_recent_size_ratio: f64,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            max_context_tokens: DEFAULT_MAX_CONTEXT_TOKENS,
            trigger_ratio: 0.85,
            reserved_context_size: 50_000,
            max_recent_messages: 4,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.2,
        }
    }
}

/// Rough token estimate for a text: one token per 4 characters (the usual
/// heuristic for English text). CJK text is underestimated, but the
/// estimate only drives the compaction trigger, not provider limits.
pub fn estimate_tokens(text: &str) -> u32 {
    text.chars().count().div_ceil(4) as u32
}

/// Rough token estimate for a single message: text content, multimodal
/// blocks, tool call names/arguments, and the tool call id.
pub fn estimate_message_tokens(message: &LLMMessage) -> u32 {
    let mut tokens = estimate_tokens(&message.content);
    for block in &message.blocks {
        tokens += match block {
            ContentBlock::Text { text } => estimate_tokens(text),
            ContentBlock::Image { media_type, data } => {
                estimate_tokens(media_type) + estimate_tokens(data)
            }
            ContentBlock::ImageUrl { url } => estimate_tokens(url),
            ContentBlock::AudioUrl { url, id } | ContentBlock::VideoUrl { url, id } => {
                estimate_tokens(url) + id.as_deref().map_or(0, estimate_tokens)
            }
        };
    }
    for call in &message.tool_calls {
        tokens += estimate_tokens(&call.name);
        tokens += estimate_tokens(&call.arguments.to_string());
    }
    if let Some(id) = &message.tool_call_id {
        tokens += estimate_tokens(id);
    }
    tokens
}

/// Total estimated tokens of a message list.
pub fn estimate_messages_tokens(messages: &[LLMMessage]) -> u32 {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Whether the estimated history size should trigger compaction. Mirrors
/// `shouldCompact` in strategy.ts, including the reserved-context rule.
pub fn should_compact(used_size: u32, config: &CompactionConfig) -> bool {
    if config.max_context_tokens == 0 {
        return false;
    }
    let max_size = config.max_context_tokens as f64;
    used_size as f64 >= max_size * config.trigger_ratio
        || (config.reserved_context_size > 0
            && config.reserved_context_size < config.max_context_tokens
            && used_size.saturating_add(config.reserved_context_size) >= config.max_context_tokens)
}

/// Compact `messages`, replacing the oldest non-system messages with a
/// summary placeholder.
///
/// Returns a new list where `messages[1..count]` is replaced by a summary
/// placeholder and `messages[count..]` is preserved verbatim. The system
/// prompt (index 0) is never touched. When the estimated history is below
/// the trigger threshold, or no safe split point exists, the input is
/// returned unchanged.
pub fn compact_messages(messages: &[LLMMessage], config: &CompactionConfig) -> Vec<LLMMessage> {
    if !should_compact(estimate_messages_tokens(messages), config) {
        return messages.to_vec();
    }
    let count = compute_compact_count(messages, config);
    if count == 0 {
        return messages.to_vec();
    }
    let mut compacted = Vec::with_capacity(messages.len() - count as usize + 2);
    compacted.push(messages[0].clone());
    compacted.push(LLMMessage {
        role: "user".into(),
        content: summary_placeholder(count as usize - 1),
        ..Default::default()
    });
    compacted.extend_from_slice(&messages[count as usize..]);
    compacted
}

/// Placeholder text standing in for the compacted prefix. The TS side
/// generates a real LLM summary (`createCompactionSummaryMessage` in
/// `compactionHandoff.ts`); the Rust engine has no summarizer, so it
/// inserts a fixed marker instead.
fn summary_placeholder(omitted: usize) -> String {
    format!(
        "[Earlier conversation compacted: {omitted} messages were summarized away \
         to fit the context window. Continue from the most recent context.]"
    )
}

/// Decide how many leading messages to compact.
///
/// Returns N where `messages[0..N]` is replaced by a summary placeholder
/// and `messages[N..]` is preserved. The system message (index 0) is never
/// compacted, so N is either 0 (no compaction) or >= 2. Mirrors the auto
/// path of `computeCompactCount` in strategy.ts.
pub fn compute_compact_count(messages: &[LLMMessage], config: &CompactionConfig) -> u32 {
    let n = messages.len();
    if n <= 1 {
        return 0;
    }
    let max_size = config.max_context_tokens as f64;
    let mut recent_messages = 1usize;
    let mut recent_user_messages = 0u32;
    let mut recent_size = 0u32;
    let mut best_n: Option<u32> = None;

    while recent_messages < n {
        let m_idx = n - recent_messages;
        let m = &messages[m_idx];
        if m.role == "user" {
            recent_user_messages += 1;
        }
        recent_size = recent_size.saturating_add(estimate_message_tokens(m));

        let split_index = m_idx - 1;
        if can_split_after(messages, split_index) {
            best_n = Some((split_index + 1) as u32);
        }

        let reaches_max_count = (recent_messages as u32) >= config.max_recent_messages;
        let reaches_max_user = recent_user_messages >= config.max_recent_user_messages;
        let reaches_max_size = (recent_size as f64) >= max_size * config.max_recent_size_ratio;
        if (reaches_max_count || reaches_max_user || reaches_max_size) && best_n.is_some() {
            break;
        }
        recent_messages += 1;
    }

    let count = fit_compact_count_to_window(messages, best_n.unwrap_or(0), config);
    // A count of 1 would mean compacting only the system prompt, which is
    // never allowed — treat it as "nothing to compact".
    if count <= 1 { 0 } else { count }
}

/// Shrink `compacted_count` so the compacted prefix fits within the
/// context window. Mirrors `fitCompactCountToWindow` in strategy.ts.
fn fit_compact_count_to_window(
    messages: &[LLMMessage],
    compacted_count: u32,
    config: &CompactionConfig,
) -> u32 {
    if config.max_context_tokens == 0 || compacted_count == 0 {
        return compacted_count;
    }
    let mut compacted_size: u32 = messages
        .iter()
        .take(compacted_count as usize)
        .map(estimate_message_tokens)
        .sum();
    if compacted_size <= config.max_context_tokens {
        return compacted_count;
    }
    let mut best_n: Option<u32> = None;
    for n in (1..compacted_count as usize).rev() {
        compacted_size = compacted_size.saturating_sub(estimate_message_tokens(&messages[n]));
        if !can_split_after(messages, n - 1) {
            continue;
        }
        best_n = Some(n as u32);
        if compacted_size <= config.max_context_tokens {
            return n as u32;
        }
    }
    best_n.unwrap_or(compacted_count)
}

/// Whether a compaction split is safe to place immediately after
/// `messages[index]`. Mirrors `canSplitAfter` in strategy.ts.
///
/// A split is safe only when:
///   - `messages[index]` is not a user message and not an assistant
///     message with pending tool calls (cutting either off from what
///     follows would break the conversation), AND
///   - the next message is not a tool result (its owning assistant would
///     be in the compacted prefix, orphaning the result), AND
///   - the compacted prefix itself does not end with an unresolved tool
///     exchange (pending tool results must stay in the tail).
pub fn can_split_after(messages: &[LLMMessage], index: usize) -> bool {
    let m = match messages.get(index) {
        Some(m) => m,
        None => return false,
    };
    if m.role == "user" {
        return false;
    }
    if m.role == "assistant" && !m.tool_calls.is_empty() {
        return false;
    }
    if messages.get(index + 1).is_some_and(|m| m.role == "tool") {
        return false;
    }
    if prefix_ends_with_open_tool_exchange(messages, index) {
        return false;
    }
    true
}

/// Whether the prefix `messages[0..=index]` ends with an unresolved tool
/// exchange — a trailing tool result whose owning assistant issued more
/// calls than the trailing results satisfy.
fn prefix_ends_with_open_tool_exchange(messages: &[LLMMessage], index: usize) -> bool {
    let m = match messages.get(index) {
        Some(m) => m,
        None => return false,
    };
    if m.role != "tool" {
        return false;
    }

    let mut tool_result_count = 0u32;
    for i in (0..=index).rev() {
        let msg = match messages.get(i) {
            Some(m) => m,
            None => return false,
        };
        if msg.role == "tool" {
            tool_result_count += 1;
            continue;
        }
        return msg.role == "assistant" && msg.tool_calls.len() as u32 > tool_result_count;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_loop::types::ToolCall;

    fn msg(role: &str, content: &str) -> LLMMessage {
        LLMMessage {
            role: role.into(),
            content: content.into(),
            ..Default::default()
        }
    }

    fn tool_call(id: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "read".into(),
            arguments: serde_json::json!({ "path": "/a.txt" }),
        }
    }

    fn small_config(max_context_tokens: u32) -> CompactionConfig {
        CompactionConfig {
            max_context_tokens,
            ..Default::default()
        }
    }

    /// Assert `tail` equals the trailing messages of `history` (compared
    /// by role + content; `LLMMessage` has no `PartialEq`).
    fn assert_suffix(history: &[LLMMessage], tail: &[LLMMessage]) {
        assert!(history.len() >= tail.len());
        let offset = history.len() - tail.len();
        for (i, m) in tail.iter().enumerate() {
            let orig = &history[offset + i];
            assert_eq!(m.role, orig.role, "role mismatch at tail index {i}");
            assert_eq!(
                m.content, orig.content,
                "content mismatch at tail index {i}"
            );
        }
    }

    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
    }

    #[test]
    fn test_estimate_message_tokens_includes_tool_calls() {
        let mut m = msg("assistant", "hello");
        m.tool_calls.push(tool_call("tc1"));
        assert!(estimate_message_tokens(&m) > estimate_message_tokens(&msg("assistant", "hello")));
    }

    #[test]
    fn test_empty_messages() {
        let config = CompactionConfig::default();
        assert_eq!(estimate_messages_tokens(&[]), 0);
        assert_eq!(compute_compact_count(&[], &config), 0);
        assert!(compact_messages(&[], &config).is_empty());
        assert!(!should_compact(0, &config));
    }

    #[test]
    fn test_system_only_unchanged() {
        let config = CompactionConfig::default();
        let messages = vec![msg("system", "You are helpful.")];
        assert_eq!(compute_compact_count(&messages, &config), 0);
        assert_eq!(compact_messages(&messages, &config).len(), 1);
    }

    #[test]
    fn test_keeps_system_prompt_trims_middle_keeps_recent_tail() {
        // 1000-token window: trigger at 850 tokens (the reserved-context
        // rule is disabled because 50k > window). 300 messages of 4 tokens
        // each cross the threshold.
        let config = small_config(1_000);
        let system = msg("system", "You are helpful.");
        let mut messages = vec![system.clone()];
        for i in 0..300 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(msg(role, &"x".repeat(16)));
        }
        assert!(should_compact(estimate_messages_tokens(&messages), &config));

        let compacted = compact_messages(&messages, &config);
        assert!(compacted.len() < messages.len(), "history must shrink");
        assert_eq!(
            compacted[0].content, system.content,
            "system prompt preserved"
        );
        assert_eq!(
            compacted[1].role, "user",
            "summary placeholder is a user message"
        );
        assert!(
            compacted[1].content.contains("compacted"),
            "placeholder mentions compaction"
        );
        assert_eq!(
            compacted.last().unwrap().content,
            messages.last().unwrap().content
        );
        assert_suffix(&messages, &compacted[2..]);
    }

    #[test]
    fn test_budget_boundary() {
        let config = small_config(1_000);
        // 200 messages of 4 tokens = 800 tokens < 850 → no compaction.
        let mut messages = vec![msg("system", "s")];
        for i in 0..200 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(msg(role, &"x".repeat(16)));
        }
        assert!(!should_compact(
            estimate_messages_tokens(&messages),
            &config
        ));
        assert_eq!(compact_messages(&messages, &config).len(), messages.len());

        // 225 messages of 4 tokens = 900 tokens >= 850 → compaction.
        let mut messages = vec![msg("system", "s")];
        for i in 0..225 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(msg(role, &"x".repeat(16)));
        }
        assert!(should_compact(estimate_messages_tokens(&messages), &config));
        let compacted = compact_messages(&messages, &config);
        assert!(compacted.len() < messages.len());
        assert_eq!(compacted[0].content, "s");
        assert!(compacted[1].content.contains("compacted"));
    }

    #[test]
    fn test_does_not_split_inside_tool_exchange() {
        // The tool exchange (assistant with 2 calls + 2 results) must be
        // compacted as a unit or kept as a unit — never split. 600-token
        // window: trigger at 510, total history is 529.
        let config = small_config(600);
        let mut messages = vec![msg("system", "s")];
        messages.push(msg("user", &"x".repeat(300)));
        let mut a = msg("assistant", &"x".repeat(300));
        a.tool_calls = vec![tool_call("t1"), tool_call("t2")];
        messages.push(a);
        messages.push(msg("tool", &"x".repeat(300)));
        messages.push(msg("tool", &"x".repeat(300)));
        messages.push(msg("user", &"x".repeat(300)));
        messages.push(msg("assistant", &"x".repeat(300)));
        messages.push(msg("user", &"x".repeat(300)));

        let compacted = compact_messages(&messages, &config);
        assert!(compacted.len() < messages.len(), "history must shrink");
        // The tail after the placeholder must not contain orphaned tool
        // results, and must be a suffix of the original history.
        let tail = &compacted[2..];
        assert!(
            !tail.iter().any(|m| m.role == "tool"),
            "no orphaned tool results in the preserved tail"
        );
        assert_suffix(&messages, tail);
    }

    #[test]
    fn test_can_split_after_safety_rules() {
        // Never split after a user message.
        let messages = vec![msg("user", "a"), msg("assistant", "b")];
        assert!(!can_split_after(&messages, 0));
        // Never split after an assistant message with pending tool calls.
        let mut a = msg("assistant", "a");
        a.tool_calls.push(tool_call("t1"));
        let messages = vec![a, msg("user", "b")];
        assert!(!can_split_after(&messages, 0));
        // Never split before a tool result (would orphan it).
        let messages = vec![msg("assistant", "a"), msg("tool", "r"), msg("user", "b")];
        assert!(!can_split_after(&messages, 0));
        // Never split when the prefix ends with an open tool exchange
        // (assistant issued 2 calls but only 1 result is in the prefix).
        let mut a = msg("assistant", "a");
        a.tool_calls = vec![tool_call("t1"), tool_call("t2")];
        let messages = vec![a, msg("tool", "r1"), msg("user", "b")];
        assert!(!can_split_after(&messages, 1));
        // A completed exchange (results match calls) is safe to split after.
        let mut a = msg("assistant", "a");
        a.tool_calls = vec![tool_call("t1"), tool_call("t2")];
        let messages = vec![a, msg("tool", "r1"), msg("tool", "r2"), msg("user", "b")];
        assert!(can_split_after(&messages, 2));
        // A clean assistant → user boundary is safe.
        let messages = vec![msg("assistant", "a"), msg("user", "b")];
        assert!(can_split_after(&messages, 0));
        // Out of bounds is never safe.
        assert!(!can_split_after(&messages, 5));
    }
}
