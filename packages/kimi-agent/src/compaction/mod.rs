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
#[derive(Debug, Clone, Copy, PartialEq)]
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

/// Config for the window the host resolved for the active model. Every other
/// knob stays at its default; a missing or non-positive window falls back to
/// [`DEFAULT_MAX_CONTEXT_TOKENS`].
pub fn config_for_window(max_context_tokens: Option<u32>) -> CompactionConfig {
    match max_context_tokens {
        Some(tokens) if tokens > 0 => CompactionConfig {
            max_context_tokens: tokens,
            ..CompactionConfig::default()
        },
        _ => CompactionConfig::default(),
    }
}

/// Character-based token-count estimates for messages, tools, and content parts,
/// mirroring `packages/kosong/src/tokens.ts` (`tsEstimateTokens`).
/// ASCII ≈ 4 chars/token, non-ASCII (CJK/Unicode) ≈ 1 token/char.
pub fn estimate_tokens(text: &str) -> u32 {
    let mut ascii_count = 0usize;
    let mut non_ascii_count = 0usize;
    for ch in text.chars() {
        if (ch as u32) <= 127 {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
    }
    (ascii_count.div_ceil(4) + non_ascii_count) as u32
}

/// Estimate tokens for JSON-serialized content. The multiplier compensates
/// for the heuristic's under-counting of JSON's dense punctuation (matching kosong `JSON_TOKEN_MULTIPLIER = 1.3`).
pub fn estimate_tokens_for_json(text: &str) -> u32 {
    ((estimate_tokens(text) as f64) * 1.3).ceil() as u32
}

/// Flat token cost assigned to media parts, mirroring kosong `MEDIA_TOKEN_ESTIMATE = 2000`.
pub const MEDIA_TOKEN_ESTIMATE: u32 = 2000;

/// Rough token estimate for a single message: text content, multimodal
/// blocks, tool call names/arguments, and the tool call id.
pub fn estimate_message_tokens(message: &LLMMessage) -> u32 {
    let mut tokens = estimate_tokens(&message.content);
    for block in &message.blocks {
        tokens += match block {
            ContentBlock::Text { text } => estimate_tokens(text),
            ContentBlock::Image { .. }
            | ContentBlock::ImageUrl { .. }
            | ContentBlock::AudioUrl { .. }
            | ContentBlock::VideoUrl { .. } => MEDIA_TOKEN_ESTIMATE,
            ContentBlock::Think { think, .. } => estimate_tokens(think),
        };
    }
    for call in &message.tool_calls {
        tokens += estimate_tokens(&call.name);
        tokens += estimate_tokens_for_json(&call.arguments.to_string());
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
    force_compact_messages(messages, config)
}

/// Unconditionally compact `messages` if a safe split point exists, bypassing the
/// `should_compact` threshold estimate. Used for runtime context overflow recovery.
pub fn force_compact_messages(messages: &[LLMMessage], config: &CompactionConfig) -> Vec<LLMMessage> {
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

/// Classify whether an LLM error string indicates that the context length / window was exceeded.
/// Mirrors `CONTEXT_OVERFLOW_MESSAGE_PATTERNS` in `agent-core-v2` / `kosong`.
pub fn is_context_overflow_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("context_length_exceeded")
        || lower.contains("context_length")
        || lower.contains("context length")
        || lower.contains("context window")
        || lower.contains("maximum context")
        || lower.contains("max_tokens")
        || lower.contains("model token limit")
        || lower.contains("too many tokens")
        || lower.contains("prompt is too long")
        || lower.contains("input token count")
        || lower.contains("exceeds the maximum size")
}

/// Placeholder text standing in for the compacted prefix. The TS side
/// generates a real LLM summary (`createCompactionSummaryMessage` in
/// `compactionHandoff.ts`); the Rust engine has no summarizer, so it
/// inserts a fixed marker instead.
pub(crate) fn summary_placeholder(omitted: usize) -> String {
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
    use crate::turn_loop::types::{ContentBlock, ToolCall};

    fn msg(role: &str, content: &str) -> LLMMessage {
        LLMMessage {
            role: role.into(),
            content: content.into(),
            ..Default::default()
        }
    }

    fn tool_call(id: &str, name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args,
        }
    }

    fn small_config(max_context_tokens: u32) -> CompactionConfig {
        CompactionConfig {
            max_context_tokens,
            ..Default::default()
        }
    }

    fn assert_messages_eq(actual: &[LLMMessage], expected: &[LLMMessage]) {
        assert_eq!(
            actual.len(),
            expected.len(),
            "message count mismatch: actual {} vs expected {}",
            actual.len(),
            expected.len()
        );
        for (i, (act, exp)) in actual.iter().zip(expected.iter()).enumerate() {
            assert_eq!(act.role, exp.role, "role mismatch at index {i}");
            assert_eq!(act.content, exp.content, "content mismatch at index {i}");
            assert_eq!(act.blocks, exp.blocks, "blocks mismatch at index {i}");
            assert_eq!(act.tool_calls.len(), exp.tool_calls.len(), "tool_calls count mismatch at index {i}");
            for (tc_idx, (tc_act, tc_exp)) in act.tool_calls.iter().zip(exp.tool_calls.iter()).enumerate() {
                assert_eq!(tc_act.id, tc_exp.id, "tool_call id mismatch at msg {i} tc {tc_idx}");
                assert_eq!(tc_act.name, tc_exp.name, "tool_call name mismatch at msg {i} tc {tc_idx}");
                assert_eq!(tc_act.arguments, tc_exp.arguments, "tool_call args mismatch at msg {i} tc {tc_idx}");
            }
            assert_eq!(act.tool_call_id, exp.tool_call_id, "tool_call_id mismatch at index {i}");
        }
    }

    #[test]
    fn config_for_window_uses_the_host_window_and_keeps_other_knobs() {
        let host_window = 262_144;
        let config = config_for_window(Some(host_window));
        let default = CompactionConfig::default();
        assert_eq!(
            config,
            CompactionConfig {
                max_context_tokens: host_window,
                ..default
            },
            "P63: host window must be used and all other knobs preserved"
        );
        assert_eq!(config.max_context_tokens, 262_144);
        assert_eq!(config.trigger_ratio, 0.85);
        assert_eq!(config.reserved_context_size, 50_000);
        assert_eq!(config.max_recent_messages, 4);
        assert_eq!(config.max_recent_user_messages, u32::MAX);
        assert_eq!(config.max_recent_size_ratio, 0.2);

        // Boundary windows
        assert_eq!(config_for_window(Some(1)).max_context_tokens, 1);
        assert_eq!(config_for_window(Some(u32::MAX)).max_context_tokens, u32::MAX);
    }

    #[test]
    fn config_for_window_falls_back_without_a_usable_window() {
        let default = CompactionConfig::default();
        assert_eq!(
            config_for_window(None),
            default,
            "P63: None window must fall back to CompactionConfig::default()"
        );
        assert_eq!(
            config_for_window(Some(0)),
            default,
            "P63: zero window must fall back to CompactionConfig::default()"
        );
    }

    #[test]
    fn test_estimate_tokens_ascii_boundaries_and_unicode() {
        assert_eq!(estimate_tokens(""), 0);
        // ASCII stepping: div_ceil(len, 4)
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("ab"), 1);
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens("abcdefg"), 2);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("abcdefghi"), 3);
        assert_eq!(estimate_tokens("123456789012"), 3);

        // Unicode and CJK: 1 token per code point > 127
        assert_eq!(estimate_tokens("你好"), 2);
        assert_eq!(estimate_tokens("你好世界"), 4);
        assert_eq!(estimate_tokens("ab你"), 2); // 2 ASCII -> 1 token + 1 CJK -> 2 tokens
        assert_eq!(estimate_tokens("Hello, 世界!"), 4); // 8 ASCII -> 2 tokens + 2 CJK -> 4 tokens
        assert_eq!(estimate_tokens("café"), 2); // 3 ASCII -> 1 token + 1 accented char -> 2 tokens
        assert_eq!(estimate_tokens("🦀🚀"), 2); // 2 emojis -> 2 tokens
        assert_eq!(estimate_tokens("AI 助手 🤖: 您好！"), 8); // 5 ASCII (2) + 6 non-ASCII (6) = 8 tokens
    }

    #[test]
    fn test_estimate_tokens_for_json() {
        assert_eq!(estimate_tokens_for_json(""), 0);
        // 1 token base -> ceil(1 * 1.3) = 2
        assert_eq!(estimate_tokens_for_json("abcd"), 2);
        // 2 tokens base -> ceil(2 * 1.3) = 3
        assert_eq!(estimate_tokens_for_json("abcdefgh"), 3);
        // 3 tokens base -> ceil(3 * 1.3) = 4
        assert_eq!(estimate_tokens_for_json("abcdefghi"), 4);
        // 4 tokens base (15-16 ASCII chars) -> ceil(4 * 1.3) = 6
        assert_eq!(estimate_tokens_for_json("{\"key\":\"value\"}"), 6);
        // 5 tokens base (17 ASCII chars) -> ceil(5 * 1.3) = 7
        assert_eq!(estimate_tokens_for_json("{\"path\":\"/a.txt\"}"), 7);
        // JSON with CJK: 10 ASCII (3 tokens) + 2 CJK (2 tokens) = 5 tokens -> ceil(5 * 1.3) = 7
        assert_eq!(estimate_tokens_for_json("{\"name\":\"张三\"}"), 7);
    }

    #[test]
    fn test_estimate_message_tokens_multimodal_content_blocks() {
        let text_msg = msg("user", "12345678"); // 8 chars -> 2 tokens
        assert_eq!(estimate_message_tokens(&text_msg), 2);

        // ContentBlock::Text
        let mut m_text = msg("user", "");
        m_text.blocks.push(ContentBlock::Text {
            text: "123456789012".into(), // 12 chars -> 3 tokens
        });
        assert_eq!(estimate_message_tokens(&m_text), 3);

        // ContentBlock::Think
        let mut m_think = msg("assistant", "");
        m_think.blocks.push(ContentBlock::Think {
            think: "reasoning step".into(), // 14 chars -> 4 tokens
            encrypted: None,
        });
        assert_eq!(estimate_message_tokens(&m_think), 4);

        // Multimodal media blocks: all count MEDIA_TOKEN_ESTIMATE (2000)
        let mut m_img = msg("user", "");
        m_img.blocks.push(ContentBlock::Image {
            media_type: "image/png".into(),
            data: "base64data".into(),
        });
        assert_eq!(estimate_message_tokens(&m_img), MEDIA_TOKEN_ESTIMATE);

        let mut m_img_url = msg("user", "");
        m_img_url.blocks.push(ContentBlock::ImageUrl {
            url: "http://example.com/pic.png".into(),
        });
        assert_eq!(estimate_message_tokens(&m_img_url), MEDIA_TOKEN_ESTIMATE);

        let mut m_audio = msg("user", "");
        m_audio.blocks.push(ContentBlock::AudioUrl {
            url: "http://example.com/audio.mp3".into(),
            id: Some("a1".into()),
        });
        assert_eq!(estimate_message_tokens(&m_audio), MEDIA_TOKEN_ESTIMATE);

        let mut m_video = msg("user", "");
        m_video.blocks.push(ContentBlock::VideoUrl {
            url: "http://example.com/video.mp4".into(),
            id: None,
        });
        assert_eq!(estimate_message_tokens(&m_video), MEDIA_TOKEN_ESTIMATE);

        // Additive combination: content + text block + think block + image block
        let mut m_combo = msg("user", "abcd"); // 1 token
        m_combo.blocks.push(ContentBlock::Text { text: "efgh".into() }); // 1 token
        m_combo.blocks.push(ContentBlock::Think {
            think: "ijkl".into(), // 1 token
            encrypted: None,
        });
        m_combo.blocks.push(ContentBlock::ImageUrl {
            url: "http://example.com/img.jpg".into(), // 2000 tokens
        });
        assert_eq!(estimate_message_tokens(&m_combo), 1 + 1 + 1 + 2000);
    }

    #[test]
    fn test_estimate_message_tokens_tool_calls_and_results_exact() {
        let mut m = msg("assistant", "hello world!"); // 12 chars -> 3 tokens
        // tool_call 1: name "read" (4 chars -> 1 token), args {"path":"/a.txt"} (17 chars -> 5 tokens -> ceil(5*1.3) = 7 tokens)
        // Subtotal = 1 + 7 = 8 tokens.
        m.tool_calls.push(tool_call("tc1", "read", serde_json::json!({ "path": "/a.txt" })));
        assert_eq!(estimate_message_tokens(&m), 3 + 8);

        // tool_call 2: name "bash" (4 chars -> 1 token), args {"cmd":"ls"} (10 chars -> 3 tokens -> ceil(3*1.3) = 4 tokens)
        // Subtotal = 1 + 4 = 5 tokens.
        m.tool_calls.push(tool_call("tc2", "bash", serde_json::json!({ "cmd": "ls" })));
        assert_eq!(estimate_message_tokens(&m), 3 + 8 + 5);

        // Tool result message with tool_call_id
        let mut tool_msg = msg("tool", "file content"); // 12 chars -> 3 tokens
        tool_msg.tool_call_id = Some("tc1_unique_id".into()); // 13 chars -> 4 tokens
        assert_eq!(estimate_message_tokens(&tool_msg), 3 + 4);
    }

    #[test]
    fn test_estimate_messages_tokens_empty_and_accumulated() {
        assert_eq!(estimate_messages_tokens(&[]), 0);

        let m1 = msg("user", "1234"); // 1 token
        let m2 = msg("assistant", "12345678"); // 2 tokens
        let m3 = msg("user", "123456789012"); // 3 tokens
        assert_eq!(estimate_messages_tokens(&[m1, m2, m3]), 6);
    }

    #[test]
    fn test_empty_and_single_system_messages_invariance() {
        let config = CompactionConfig::default();
        // Empty message slice
        assert_eq!(estimate_messages_tokens(&[]), 0);
        assert_eq!(compute_compact_count(&[], &config), 0);
        assert!(compact_messages(&[], &config).is_empty());
        assert!(force_compact_messages(&[], &config).is_empty());
        assert!(!should_compact(0, &config));
        assert!(!can_split_after(&[], 0));

        // System message alone: never compacted under normal or forced compaction
        let system_only = vec![msg("system", "You are an assistant.")];
        assert_eq!(compute_compact_count(&system_only, &config), 0);
        assert_messages_eq(&compact_messages(&system_only, &config), &system_only);
        assert_messages_eq(&force_compact_messages(&system_only, &config), &system_only);

        // System message + single user message (2 messages total): cannot split without removing system
        let two_msgs = vec![msg("system", "sys"), msg("user", "hi")];
        assert_eq!(compute_compact_count(&two_msgs, &config), 0);
        assert_messages_eq(&compact_messages(&two_msgs, &config), &two_msgs);
        assert_messages_eq(&force_compact_messages(&two_msgs, &config), &two_msgs);
    }

    #[test]
    fn test_should_compact_all_threshold_and_boundary_conditions() {
        // Zero context window: never compacts
        let mut zero_cfg = CompactionConfig::default();
        zero_cfg.max_context_tokens = 0;
        assert!(!should_compact(0, &zero_cfg));
        assert!(!should_compact(100_000, &zero_cfg));

        // trigger_ratio boundary (isolated by setting reserved_context_size = 0)
        let ratio_cfg = CompactionConfig {
            max_context_tokens: 10_000,
            trigger_ratio: 0.85,
            reserved_context_size: 0,
            ..Default::default()
        };
        assert!(!should_compact(8499, &ratio_cfg), "8499 < 8500 threshold");
        assert!(should_compact(8500, &ratio_cfg), "8500 >= 8500 threshold");
        assert!(should_compact(8501, &ratio_cfg), "8501 >= 8500 threshold");

        // reserved_context_size boundary (triggers before trigger_ratio)
        let reserved_cfg = CompactionConfig {
            max_context_tokens: 100_000,
            trigger_ratio: 0.90, // 90,000 threshold
            reserved_context_size: 20_000, // triggers at 80,000 (100k - 20k)
            ..Default::default()
        };
        assert!(!should_compact(79_999, &reserved_cfg));
        assert!(should_compact(80_000, &reserved_cfg));
        assert!(should_compact(80_001, &reserved_cfg));
        assert!(should_compact(90_000, &reserved_cfg));

        // reserved_context_size >= max_context_tokens disabled guard
        let disabled_reserved_cfg = CompactionConfig {
            max_context_tokens: 1_000,
            trigger_ratio: 0.85,
            reserved_context_size: 50_000, // 50k >= 1k, disabled
            ..Default::default()
        };
        assert!(!should_compact(849, &disabled_reserved_cfg));
        assert!(should_compact(850, &disabled_reserved_cfg));

        // Saturating addition does not overflow u32
        let sat_cfg = CompactionConfig {
            max_context_tokens: 100_000,
            trigger_ratio: 0.85,
            reserved_context_size: 50_000,
            ..Default::default()
        };
        assert!(should_compact(u32::MAX, &sat_cfg));
    }

    #[test]
    fn test_summary_placeholder_format_exact() {
        assert_eq!(
            summary_placeholder(0),
            "[Earlier conversation compacted: 0 messages were summarized away to fit the context window. Continue from the most recent context.]"
        );
        assert_eq!(
            summary_placeholder(1),
            "[Earlier conversation compacted: 1 messages were summarized away to fit the context window. Continue from the most recent context.]"
        );
        assert_eq!(
            summary_placeholder(42),
            "[Earlier conversation compacted: 42 messages were summarized away to fit the context window. Continue from the most recent context.]"
        );
    }

    #[test]
    fn test_compact_preserves_system_replaces_middle_with_exact_placeholder_and_tail() {
        let messages = vec![
            msg("system", "system-prompt"),
            msg("user", "user-1"),
            msg("assistant", "assistant-1"),
            msg("user", "user-2"),
            msg("assistant", "assistant-2"),
            msg("user", "user-3"),
            msg("assistant", "assistant-3"),
            msg("user", "user-4"),
        ];

        let config = CompactionConfig {
            max_context_tokens: 1000,
            trigger_ratio: 0.01, // Force trigger
            reserved_context_size: 0,
            max_recent_messages: 4,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.5,
        };

        let count = compute_compact_count(&messages, &config);
        assert_eq!(count, 5, "compacts messages 0..5 (system + 4 conversation messages)");

        let compacted = compact_messages(&messages, &config);
        let expected = vec![
            msg("system", "system-prompt"),
            msg("user", &summary_placeholder(4)),
            msg("user", "user-3"),
            msg("assistant", "assistant-3"),
            msg("user", "user-4"),
        ];
        assert_messages_eq(&compacted, &expected);
    }

    #[test]
    fn test_budget_boundary_exact() {
        let config = small_config(1_000);
        // Each message is 16 chars = 4 tokens.
        // 211 messages * 4 tokens = 844 tokens < 850 threshold -> no compaction.
        let mut messages = vec![msg("system", "sys-16chars-pad!")];
        for i in 0..210 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(msg(role, &format!("msg-{:012}", i)));
        }
        assert_eq!(estimate_messages_tokens(&messages), 844);
        assert!(!should_compact(estimate_messages_tokens(&messages), &config));
        assert_messages_eq(&compact_messages(&messages, &config), &messages);

        // Add 2 more messages: 213 messages * 4 tokens = 852 tokens >= 850 threshold -> triggers compaction.
        messages.push(msg("user", "msg-000000000210"));
        messages.push(msg("assistant", "msg-000000000211"));
        assert_eq!(estimate_messages_tokens(&messages), 852);
        assert!(should_compact(estimate_messages_tokens(&messages), &config));

        let count = compute_compact_count(&messages, &config);
        assert!(count >= 2, "must compact at least system + 1 message");
        let compacted = compact_messages(&messages, &config);
        assert_eq!(compacted.len(), messages.len() - count as usize + 2);
        assert_messages_eq(&compacted[0..1], &messages[0..1]);
        assert_eq!(compacted[1].role, "user");
        assert_eq!(compacted[1].content, summary_placeholder(count as usize - 1));
        assert_messages_eq(&compacted[2..], &messages[count as usize..]);
    }

    #[test]
    fn test_does_not_split_inside_tool_exchange_keeps_or_drops_intact() {
        let messages = vec![
            msg("system", "sys"),
            msg("user", "u1"),
            msg("assistant", "a1"),
            msg("user", "u2"),
            {
                let mut a = msg("assistant", "a2");
                a.tool_calls = vec![
                    tool_call("t1", "read", serde_json::json!({})),
                    tool_call("t2", "write", serde_json::json!({})),
                ];
                a
            },
            msg("tool", "r1"),
            msg("tool", "r2"),
            msg("assistant", "a3"),
            msg("user", "u3"),
        ];

        // Case A: Recent tail cutoff (max_recent_messages = 3) lands at a3 / r2.
        // It cannot split after r1 (open exchange) or a2 (pending tool calls),
        // so it compacts the ENTIRE tool exchange into the prefix.
        let config_a = CompactionConfig {
            max_context_tokens: 1000,
            trigger_ratio: 0.01,
            reserved_context_size: 0,
            max_recent_messages: 3,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.5,
        };
        let count_a = compute_compact_count(&messages, &config_a);
        assert_eq!(count_a, 7, "compacts up to index 7 (sys + u1 + a1 + u2 + a2 + r1 + r2)");
        let compacted_a = compact_messages(&messages, &config_a);
        let expected_a = vec![
            msg("system", "sys"),
            msg("user", &summary_placeholder(6)),
            msg("assistant", "a3"),
            msg("user", "u3"),
        ];
        assert_messages_eq(&compacted_a, &expected_a);

        // Case B: Longer recent tail requirement (max_recent_messages = 6) forces
        // the split BEFORE the tool exchange (after a1 at index 2).
        // The ENTIRE tool exchange is kept in the tail intact.
        let config_b = CompactionConfig {
            max_context_tokens: 1000,
            trigger_ratio: 0.01,
            reserved_context_size: 0,
            max_recent_messages: 6,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.5,
        };
        let count_b = compute_compact_count(&messages, &config_b);
        assert_eq!(count_b, 3, "compacts up to index 3 (sys + u1 + a1)");
        let compacted_b = compact_messages(&messages, &config_b);
        assert_eq!(compacted_b.len(), 8);
        assert_messages_eq(&compacted_b[0..1], &messages[0..1]);
        assert_eq!(compacted_b[1].content, summary_placeholder(2));
        assert_messages_eq(&compacted_b[2..], &messages[3..]);
    }

    #[test]
    fn test_can_split_after_all_safety_rules() {
        // 1. Out of bounds
        assert!(!can_split_after(&[], 0));
        let msgs = vec![msg("assistant", "a")];
        assert!(!can_split_after(&msgs, 1));
        assert!(!can_split_after(&msgs, 5));

        // 2. Never split after a user message
        let msgs = vec![msg("user", "u"), msg("assistant", "a")];
        assert!(!can_split_after(&msgs, 0));

        // 3. Never split after assistant with pending tool calls
        let mut a = msg("assistant", "a");
        a.tool_calls.push(tool_call("t1", "read", serde_json::json!({})));
        let msgs = vec![a, msg("user", "u")];
        assert!(!can_split_after(&msgs, 0));

        // 4. Never split immediately before a tool message (would orphan the tool)
        let msgs = vec![msg("assistant", "a"), msg("tool", "r"), msg("user", "u")];
        assert!(!can_split_after(&msgs, 0));

        // 5. Open tool exchange in prefix: assistant issued 2 calls, only 1 result in prefix
        let mut a = msg("assistant", "a");
        a.tool_calls = vec![
            tool_call("t1", "read", serde_json::json!({})),
            tool_call("t2", "write", serde_json::json!({})),
        ];
        let msgs = vec![a, msg("tool", "r1"), msg("user", "u")];
        assert!(!can_split_after(&msgs, 1), "cannot split after partial tool exchange");

        // 6. Resolved tool exchange in prefix: 2 calls and 2 results
        let mut a = msg("assistant", "a");
        a.tool_calls = vec![
            tool_call("t1", "read", serde_json::json!({})),
            tool_call("t2", "write", serde_json::json!({})),
        ];
        let msgs = vec![a, msg("tool", "r1"), msg("tool", "r2"), msg("user", "u")];
        assert!(can_split_after(&msgs, 2), "safe to split after fully satisfied tool exchange");

        // 7. Clean assistant -> user boundary
        let msgs = vec![msg("assistant", "a"), msg("user", "u")];
        assert!(can_split_after(&msgs, 0));

        // 8. Clean assistant at end of messages
        let msgs = vec![msg("user", "u"), msg("assistant", "a")];
        assert!(can_split_after(&msgs, 1));

        // 9. System message followed by user
        let msgs = vec![msg("system", "sys"), msg("user", "u")];
        assert!(can_split_after(&msgs, 0));

        // 10. System message followed by tool (malformed, but must be rejected)
        let msgs = vec![msg("system", "sys"), msg("tool", "r")];
        assert!(!can_split_after(&msgs, 0));
    }

    #[test]
    fn test_prefix_ends_with_open_tool_exchange_direct() {
        // Non-tool message returns false immediately
        assert!(!prefix_ends_with_open_tool_exchange(&[msg("assistant", "a")], 0));
        assert!(!prefix_ends_with_open_tool_exchange(&[], 0));

        // 2 calls, 1 result -> open (true)
        let mut a2 = msg("assistant", "a");
        a2.tool_calls = vec![
            tool_call("1", "read", serde_json::json!({})),
            tool_call("2", "write", serde_json::json!({})),
        ];
        let msgs = vec![a2.clone(), msg("tool", "r1")];
        assert!(prefix_ends_with_open_tool_exchange(&msgs, 1));

        // 2 calls, 2 results -> closed (false)
        let msgs = vec![a2.clone(), msg("tool", "r1"), msg("tool", "r2")];
        assert!(!prefix_ends_with_open_tool_exchange(&msgs, 2));

        // 1 call, 2 results -> closed (false)
        let mut a1 = msg("assistant", "a");
        a1.tool_calls = vec![tool_call("1", "read", serde_json::json!({}))];
        let msgs = vec![a1, msg("tool", "r1"), msg("tool", "r2")];
        assert!(!prefix_ends_with_open_tool_exchange(&msgs, 2));

        // Multiple assistants in history: backwards walk checks the immediately preceding assistant
        let mut a_first = msg("assistant", "first");
        a_first.tool_calls = vec![tool_call("1", "read", serde_json::json!({}))];
        let mut a_second = msg("assistant", "second");
        a_second.tool_calls = vec![
            tool_call("2", "read", serde_json::json!({})),
            tool_call("3", "read", serde_json::json!({})),
        ];
        let msgs = vec![
            a_first,
            msg("tool", "r1"),
            a_second,
            msg("tool", "r2"),
        ];
        assert!(prefix_ends_with_open_tool_exchange(&msgs, 3));

        // Tool preceded by user (no assistant) -> returns false
        let msgs = vec![msg("user", "u"), msg("tool", "r")];
        assert!(!prefix_ends_with_open_tool_exchange(&msgs, 1));
    }

    #[test]
    fn test_fit_compact_count_to_window_shrinks_safely() {
        let config = CompactionConfig {
            max_context_tokens: 5,
            ..Default::default()
        };
        // Zero window or zero count returns unchanged
        assert_eq!(fit_compact_count_to_window(&[], 0, &config), 0);
        let mut zero_cfg = config;
        zero_cfg.max_context_tokens = 0;
        assert_eq!(fit_compact_count_to_window(&[], 5, &zero_cfg), 5);

        // 8 messages, each 4 chars = 1 token
        let messages = vec![
            msg("system", "s000"), // 1 token
            msg("user", "u001"),   // 1 token
            msg("assistant", "a002"), // 1 token (can split after index 2)
            msg("user", "u003"),   // 1 token
            msg("assistant", "a004"), // 1 token (can split after index 4)
            msg("user", "u005"),   // 1 token
            msg("assistant", "a006"), // 1 token (can split after index 6)
            msg("user", "u007"),   // 1 token
        ];

        // Candidate count 7 has 7 tokens > max_context_tokens 5.
        // It must shrink backwards:
        // n = 6: tokens = 6 > 5.
        // n = 5: tokens = 5 <= 5. Can split after index 4 (assistant a004)? Yes!
        // Returns 5.
        assert_eq!(fit_compact_count_to_window(&messages, 7, &config), 5);
    }

    #[test]
    fn test_compaction_config_knobs_control_tail_boundary() {
        let messages = vec![
            msg("system", "system-prompt"),
            msg("user", "user-1"),
            msg("assistant", "assistant-1"),
            msg("user", "user-2"),
            msg("assistant", "assistant-2"),
            msg("user", "user-3"),
            msg("assistant", "assistant-3"),
            msg("user", "user-4"),
        ];

        // Knob: max_recent_messages = 2
        let cfg_recent = CompactionConfig {
            max_context_tokens: 10_000,
            trigger_ratio: 0.01,
            reserved_context_size: 0,
            max_recent_messages: 2,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.5,
        };
        assert_eq!(compute_compact_count(&messages, &cfg_recent), 7);

        // Knob: max_recent_user_messages = 1
        // As soon as 1 user message is included in recent tail (user-4),
        // and a safe split point exists (assistant-3), search halts.
        let cfg_user = CompactionConfig {
            max_context_tokens: 10_000,
            trigger_ratio: 0.01,
            reserved_context_size: 0,
            max_recent_messages: 10,
            max_recent_user_messages: 1,
            max_recent_size_ratio: 0.5,
        };
        assert_eq!(compute_compact_count(&messages, &cfg_user), 7);

        // Knob: max_recent_size_ratio halts tail growth when size budget reached
        let cfg_ratio = CompactionConfig {
            max_context_tokens: 100,
            trigger_ratio: 0.01,
            reserved_context_size: 0,
            max_recent_messages: 10,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.02, // 2 tokens max for recent tail
        };
        // Each message is >= 3 tokens, so first message already hits 2-token budget
        assert_eq!(compute_compact_count(&messages, &cfg_ratio), 7);
    }

    #[test]
    fn test_unsplittable_history_remains_untouched() {
        let config = small_config(100);

        // All user messages: cannot split after any user message
        let all_users = vec![
            msg("system", "sys"),
            msg("user", "u1"),
            msg("user", "u2"),
            msg("user", "u3"),
        ];
        assert_eq!(compute_compact_count(&all_users, &config), 0);
        assert_messages_eq(&compact_messages(&all_users, &config), &all_users);
        assert_messages_eq(&force_compact_messages(&all_users, &config), &all_users);

        // Open tool exchange with no safe prior split point
        let mut a = msg("assistant", "a");
        a.tool_calls = vec![
            tool_call("t1", "f", serde_json::json!({})),
            tool_call("t2", "f", serde_json::json!({})),
        ];
        let open_tool = vec![
            msg("system", "sys"),
            msg("user", "u1"),
            a,
            msg("tool", "r1"),
        ];
        assert_eq!(compute_compact_count(&open_tool, &config), 0);
        assert_messages_eq(&compact_messages(&open_tool, &config), &open_tool);
        assert_messages_eq(&force_compact_messages(&open_tool, &config), &open_tool);
    }

    #[test]
    fn test_is_context_overflow_error_all_patterns_and_negatives() {
        // All 11 recognized patterns from CONTEXT_OVERFLOW_MESSAGE_PATTERNS
        let positive_cases = [
            "llm http status 400: context_length_exceeded",
            "model error: context_length reached",
            "request error: context length exceeded",
            "exceeded context window limit of 128k",
            "reached maximum context for this model",
            "max_tokens limit was exceeded",
            "request exceeds model token limit",
            "too many tokens in prompt",
            "prompt is too long for selected model",
            "input token count exceeds allowed maximum",
            "request payload exceeds the maximum size allowed",
        ];
        for err in positive_cases {
            assert!(
                is_context_overflow_error(err),
                "pattern in '{}' must be detected as context overflow",
                err
            );
        }

        // Case insensitivity
        assert!(is_context_overflow_error("CONTEXT_LENGTH_EXCEEDED"));
        assert!(is_context_overflow_error("Prompt Is Too Long"));
        assert!(is_context_overflow_error("INPUT TOKEN COUNT EXCEEDED"));
        assert!(is_context_overflow_error("MAX_TOKENS"));
        assert!(is_context_overflow_error("EXCEEDS THE MAXIMUM SIZE"));

        // Negative cases that must NOT trigger
        let negative_cases = [
            "",
            "llm http status 401: unauthorized",
            "llm http status 429: rate limit exceeded",
            "llm http status 500: internal server error",
            "connection reset by peer",
            "context is important for good answers",
            "tokens remaining: 50",
            "maximum speed achieved",
            "prompt submitted successfully",
        ];
        for err in negative_cases {
            assert!(
                !is_context_overflow_error(err),
                "non-overflow error '{}' must not trigger overflow detection",
                err
            );
        }
    }

    #[test]
    fn test_force_compact_bypasses_should_compact_threshold() {
        let config = small_config(100_000);
        let messages = vec![
            msg("system", "sys"),
            msg("user", "u1"),
            msg("assistant", "a1"),
            msg("user", "u2"),
            msg("assistant", "a2"),
            msg("user", "u3"),
        ];

        // Normal compact_messages does not trigger because 100k window is far away
        assert_messages_eq(&compact_messages(&messages, &config), &messages);

        // force_compact_messages triggers emergency compaction
        let count = compute_compact_count(&messages, &config);
        assert_eq!(count, 3, "splits after assistant a1 at index 2");

        let forced = force_compact_messages(&messages, &config);
        let expected = vec![
            msg("system", "sys"),
            msg("user", &summary_placeholder(2)),
            msg("user", "u2"),
            msg("assistant", "a2"),
            msg("user", "u3"),
        ];
        assert_messages_eq(&forced, &expected);
    }
}
