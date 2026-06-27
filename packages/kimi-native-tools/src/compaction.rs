//! Context compaction strategy — decides when and how much to compact.
//!
//! Mirrors `packages/agent-core/src/agent/compaction/strategy.ts` so the
//! TS and Rust layers cannot drift on the windowing algorithm. The TS side
//! builds `CompactionMessageMeta[]` from `Message[]` (one pass, using the
//! cached `estimateTokensForMessage`) and passes it across the napi
//! boundary; Rust only sees the lightweight projection.
//!
//! Only `compute_compact_count` and `reduce_compact_on_overflow` are
//! exposed as napi bindings; `fit_compact_count_to_window`,
//! `can_split_after`, and `prefix_ends_with_open_tool_exchange` stay
//! private to this module.
//!
//! The 128k output cap and `resolve_compaction_max_completion_tokens`
//! helper mirror `packages/agent-core/src/agent/compaction/full.ts`
//! (introduced in upstream commits `d02b5c49` and `794db555`). They live
//! here so the TS and Rust sides cannot drift on the default cap when the
//! caller does not set `maxOutputSize` explicitly. Rust still does not
//! drive the LLM call itself — `compaction/full.ts` applies this cap via
//! `resolveCompletionBudget` — but the constant and the resolution
//! function are kept in sync so any future Rust-side compaction path can
//! reuse them without re-deriving the magic number.

use napi_derive::napi;

/// Lightweight projection of a `Message` for the compaction algorithm.
///
/// Only the fields the windowing logic actually inspects cross the
/// boundary: `role` (for split-safety checks), `tool_calls_count` (to
/// detect pending tool exchanges), and `tokens` (pre-computed by TS via
/// the cached `estimateTokensForMessage`).
#[derive(Debug, Clone)]
#[napi(object)]
pub struct CompactionMessageMeta {
    pub role: String,
    pub tool_calls_count: u32,
    pub tokens: u32,
}

/// Knobs for the compaction algorithm.
///
/// `max_recent_user_messages` uses `u32::MAX` as a stand-in for TS
/// `Infinity` (the `DEFAULT_COMPACTION_CONFIG` default). The threshold
/// `recent_user_messages >= max_recent_user_messages` then never fires
/// for realistic message counts, matching the TS behavior.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct CompactionConfigMeta {
    pub max_size: u32,
    pub max_recent_messages: u32,
    pub max_recent_user_messages: u32,
    pub max_recent_size_ratio: f64,
    pub min_overflow_reduction_ratio: f64,
}

/// Default hard cap on compaction output tokens when `maxOutputSize` is not
/// configured on the model alias. Without this, compaction falls back to the
/// full context window size, which exceeds the `max_tokens` ceiling enforced
/// by many OpenAI-compatible providers. 128k matches the chat-completions
/// ceiling applied by the OpenAI Legacy provider.
///
/// Mirrors `DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS` in
/// `packages/agent-core/src/agent/compaction/full.ts`.
#[napi]
pub const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS: u32 = 128 * 1024;

/// Resolve the effective `maxOutputSize` for a compaction call.
///
/// Mirrors the `defaultCompactionCap` computation in
/// `packages/agent-core/src/agent/compaction/full.ts`:
///
/// 1. If `max_output_size` is set and positive, the caller wins.
/// 2. Otherwise, when `max_context_tokens > 0`, use the lesser of
///    `max_context_tokens` and `DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS`.
/// 3. When the context window is unknown (`max_context_tokens == 0`),
///    return `None` so the upstream budget resolver falls back to its
///    conservative unknown-context default.
///
/// `None` here means "unset"; callers (e.g. `resolveCompletionBudget`)
/// decide what to do with the unset case.
#[napi]
pub fn resolve_compaction_max_completion_tokens(
    max_context_tokens: u32,
    max_output_size: Option<u32>,
) -> Option<u32> {
    if let Some(v) = max_output_size {
        if v > 0 {
            return Some(v);
        }
    }
    if max_context_tokens > 0 {
        Some(max_context_tokens.min(DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS))
    } else {
        None
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;

    #[test]
    fn default_cap_matches_ts_constant() {
        assert_eq!(DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS, 128 * 1024);
    }

    #[test]
    fn resolve_prefers_explicit_override() {
        assert_eq!(
            resolve_compaction_max_completion_tokens(1_000_000, Some(50_000)),
            Some(50_000)
        );
    }

    #[test]
    fn resolve_falls_back_to_min_when_no_override() {
        // max_context_tokens = 64k < 128k → cap = 64k
        assert_eq!(
            resolve_compaction_max_completion_tokens(64_000, None),
            Some(64_000)
        );
        // max_context_tokens = 1M > 128k → cap = 128k
        assert_eq!(
            resolve_compaction_max_completion_tokens(1_000_000, None),
            Some(128 * 1024)
        );
    }

    #[test]
    fn resolve_returns_none_when_context_unknown_and_no_override() {
        assert_eq!(resolve_compaction_max_completion_tokens(0, None), None);
    }

    #[test]
    fn resolve_treats_zero_override_as_unset() {
        // 0 means "disabled" in resolveCompletionBudget; fall through to cap.
        assert_eq!(
            resolve_compaction_max_completion_tokens(1_000_000, Some(0)),
            Some(128 * 1024)
        );
    }
}

/// Decide how many leading messages to compact.
///
/// Returns N where `messages[0..N]` is compacted and `messages[N..]` is
/// preserved. 0 means no compaction possible (no valid split point).
///
/// `is_manual` selects the manual path (scan backward for the first safe
/// split); otherwise the auto path runs (grow the recent tail until a
/// cap is reached, recording the last valid split point).
pub fn compute_compact_count(
    messages: &[CompactionMessageMeta],
    config: &CompactionConfigMeta,
    is_manual: bool,
) -> u32 {
    let n = messages.len();
    if n == 0 {
        return 0;
    }

    if is_manual {
        for i in (1..n).rev() {
            if can_split_after(messages, i) {
                return fit_compact_count_to_window(messages, (i + 1) as u32, config);
            }
        }
        return 0;
    }

    let max_size = config.max_size as f64;
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
        recent_size = recent_size.saturating_add(m.tokens);

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

    fit_compact_count_to_window(messages, best_n.unwrap_or(0), config)
}

/// Find a split point when the LLM throws a context overflow error.
///
/// Walks backward from the tail accumulating tokens until the reduced
/// size reaches `min_overflow_reduction_ratio * max_size`, returning the
/// first valid split point that satisfies the threshold. Falls back to
/// the last valid split point found, or `messages.len()` if none.
pub fn reduce_compact_on_overflow(
    messages: &[CompactionMessageMeta],
    config: &CompactionConfigMeta,
) -> u32 {
    let n = messages.len();
    if n <= 2 {
        return n as u32;
    }

    let min_reduced_size = ((config.max_size as f64) * config.min_overflow_reduction_ratio)
        .ceil()
        .max(1.0) as u32;

    let mut reduced_size = 0u32;
    let mut best_n: Option<u32> = None;

    for i in (1..n - 1).rev() {
        reduced_size = reduced_size.saturating_add(messages[i + 1].tokens);
        if can_split_after(messages, i) {
            best_n = Some((i + 1) as u32);
            if reduced_size >= min_reduced_size {
                return (i + 1) as u32;
            }
        }
    }

    best_n.unwrap_or(n as u32)
}

/// Shrink `compacted_count` so the compacted prefix fits within `max_size`.
///
/// Walks `n` backward from `compacted_count - 1` to `1`, subtracting
/// `messages[n].tokens` at each step. The first `n` where
/// `can_split_after(messages, n-1)` holds and `compacted_size <= max_size`
/// is returned. Falls back to the last valid split point, or the original
/// `compacted_count` if no valid split exists.
fn fit_compact_count_to_window(
    messages: &[CompactionMessageMeta],
    compacted_count: u32,
    config: &CompactionConfigMeta,
) -> u32 {
    if config.max_size == 0 || compacted_count == 0 {
        return compacted_count;
    }

    let mut compacted_size: u32 = messages
        .iter()
        .take(compacted_count as usize)
        .map(|m| m.tokens)
        .sum();
    if compacted_size <= config.max_size {
        return compacted_count;
    }

    let mut best_n: Option<u32> = None;
    for n in (1..compacted_count as usize).rev() {
        compacted_size = compacted_size.saturating_sub(messages[n].tokens);
        if !can_split_after(messages, n - 1) {
            continue;
        }
        best_n = Some(n as u32);
        if compacted_size <= config.max_size {
            return n as u32;
        }
    }

    best_n.unwrap_or(compacted_count)
}

/// Whether a compaction split is safe to place immediately after
/// `messages[index]`.
///
/// A split is safe only when:
///   - `messages[index]` is not a user message and not an assistant
///     message with pending tool calls (cutting either off from what
///     follows would break the conversation), AND
///   - the next message is not a tool result (its owning assistant
///     would be in the compacted prefix, orphaning the result), AND
///   - the compacted prefix itself does not end with an unresolved
///     tool exchange (pending tool results must stay in the tail).
fn can_split_after(messages: &[CompactionMessageMeta], index: usize) -> bool {
    let m = match messages.get(index) {
        Some(m) => m,
        None => return false,
    };
    if m.role == "user" {
        return false;
    }
    if m.role == "assistant" && m.tool_calls_count > 0 {
        return false;
    }
    if messages
        .get(index + 1)
        .map(|m| m.role == "tool")
        .unwrap_or(false)
    {
        return false;
    }
    if prefix_ends_with_open_tool_exchange(messages, index) {
        return false;
    }
    true
}

/// Whether the prefix `messages[0..=index]` ends with an unresolved
/// tool exchange — i.e. the last message is a tool result whose owning
/// assistant had more tool calls than the trailing results can satisfy.
fn prefix_ends_with_open_tool_exchange(
    messages: &[CompactionMessageMeta],
    index: usize,
) -> bool {
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
        return msg.role == "assistant" && msg.tool_calls_count > tool_result_count;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, tokens: u32, tool_calls: u32) -> CompactionMessageMeta {
        CompactionMessageMeta {
            role: role.to_string(),
            tool_calls_count: tool_calls,
            tokens,
        }
    }

    // Mirror of testCompactionStrategy() in strategy.test.ts.
    fn default_config(max_size: u32) -> CompactionConfigMeta {
        CompactionConfigMeta {
            max_size,
            max_recent_messages: 10,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.2,
            min_overflow_reduction_ratio: 0.05,
        }
    }

    // ---- compute_compact_count: auto path ----

    #[test]
    fn keeps_oversized_trailing_user_as_recent() {
        // user, assistant, user(oversized)
        let messages = vec![
            msg("user", 10, 0),
            msg("assistant", 10, 0),
            msg("user", 1_200, 0),
        ];
        // Split after assistant (index 1) → compact first 2.
        assert_eq!(compute_compact_count(&messages, &default_config(1_000), false), 2);
    }

    #[test]
    fn keeps_consecutive_oversized_trailing_users_as_recent() {
        let messages = vec![
            msg("user", 10, 0),
            msg("assistant", 10, 0),
            msg("user", 1_200, 0),
            msg("user", 1_200, 0),
        ];
        assert_eq!(compute_compact_count(&messages, &default_config(1_000), false), 2);
    }

    #[test]
    fn compacts_prefix_when_trailing_exchange_is_oversized() {
        // user, assistant, user, assistant(oversized)
        let messages = vec![
            msg("user", 10, 0),
            msg("assistant", 10, 0),
            msg("user", 10, 0),
            msg("assistant", 1_200, 0),
        ];
        assert_eq!(compute_compact_count(&messages, &default_config(1_000), false), 2);
    }

    #[test]
    fn returns_zero_when_nothing_to_compact() {
        assert_eq!(compute_compact_count(&[], &default_config(1_000), false), 0);
        let single = vec![msg("user", 10, 0)];
        assert_eq!(compute_compact_count(&single, &default_config(1_000), false), 0);
        let all_users = vec![
            msg("user", 10, 0),
            msg("user", 10, 0),
            msg("user", 10, 0),
        ];
        assert_eq!(compute_compact_count(&all_users, &default_config(1_000), false), 0);
    }

    #[test]
    fn returns_zero_when_last_message_is_unsplittable() {
        // user, assistant with pending tool call
        let messages = vec![
            msg("user", 10, 0),
            msg("assistant", 10, 1),
        ];
        assert_eq!(compute_compact_count(&messages, &default_config(1_000), false), 0);
    }

    #[test]
    fn does_not_split_inside_parallel_tool_exchange() {
        // user, assistant, user, assistant(2 calls), tool_a, tool_b, user
        let messages = vec![
            msg("user", 10, 0),
            msg("assistant", 10, 0),
            msg("user", 10, 0),
            msg("assistant", 10, 2),
            msg("tool", 10, 0),
            msg("tool", 10, 0),
            msg("user", 10, 0),
        ];
        // Valid split: after the first "old assistant" (index 1) → compact 2.
        // Splitting after tool_a (index 4) would orphan tool_b.
        assert_eq!(compute_compact_count(&messages, &default_config(1_000), false), 2);
    }

    #[test]
    fn shrinks_auto_compaction_to_fit_window() {
        // 30 assistant messages, each 100 tokens (oversized for max_size=1000).
        let messages: Vec<_> = (0..30).map(|_| msg("assistant", 100, 0)).collect();
        let count = compute_compact_count(&messages, &default_config(1_000), false);
        assert!(count > 0, "expected positive count, got {count}");
        assert!(count < 30, "expected shrink, got {count}");
        let total: u32 = messages[..count as usize].iter().map(|m| m.tokens).sum();
        assert!(total <= 1_000, "compacted prefix exceeds window: {total}");
        let next_total: u32 = messages[..count as usize + 1].iter().map(|m| m.tokens).sum();
        assert!(next_total > 1_000, "could have compacted one more");
    }

    // ---- compute_compact_count: manual path ----

    #[test]
    fn shrinks_manual_compaction_to_fit_window() {
        let messages: Vec<_> = (0..30).map(|_| msg("assistant", 100, 0)).collect();
        let count = compute_compact_count(&messages, &default_config(1_000), true);
        assert!(count > 0, "expected positive count, got {count}");
        assert!(count < 30, "expected shrink, got {count}");
        let total: u32 = messages[..count as usize].iter().map(|m| m.tokens).sum();
        assert!(total <= 1_000, "compacted prefix exceeds window: {total}");
        let next_total: u32 = messages[..count as usize + 1].iter().map(|m| m.tokens).sum();
        assert!(next_total > 1_000, "could have compacted one more");
    }

    // ---- reduce_compact_on_overflow ----

    #[test]
    fn reduce_compact_finds_overflow_split() {
        // 5 messages, each 100 tokens. max_size=1000, ratio=0.05 → min_reduced=50.
        // Walking backward from i=3: reduced_size=messages[4].tokens=100 >= 50 → return i+1=4.
        let messages: Vec<_> = (0..5).map(|_| msg("assistant", 100, 0)).collect();
        let count = reduce_compact_on_overflow(&messages, &default_config(1_000));
        assert_eq!(count, 4);
    }

    #[test]
    fn reduce_compact_returns_full_length_when_no_split() {
        // All user messages → no valid split → return n.
        let messages = vec![
            msg("user", 100, 0),
            msg("user", 100, 0),
            msg("user", 100, 0),
            msg("user", 100, 0),
        ];
        let count = reduce_compact_on_overflow(&messages, &default_config(1_000));
        assert_eq!(count, 4);
    }

    #[test]
    fn reduce_compact_handles_tiny_arrays() {
        assert_eq!(reduce_compact_on_overflow(&[], &default_config(1_000)), 0);
        let one = vec![msg("user", 10, 0)];
        assert_eq!(reduce_compact_on_overflow(&one, &default_config(1_000)), 1);
        let two = vec![msg("assistant", 10, 0), msg("user", 10, 0)];
        assert_eq!(reduce_compact_on_overflow(&two, &default_config(1_000)), 2);
    }

    // ---- canSplitAfter rejection cases ----

    #[test]
    fn can_split_after_rejects_user_message() {
        let messages = vec![msg("user", 10, 0), msg("assistant", 10, 0)];
        assert!(!can_split_after(&messages, 0));
    }

    #[test]
    fn can_split_after_rejects_assistant_with_tool_calls() {
        let messages = vec![
            msg("assistant", 10, 1),
            msg("user", 10, 0),
        ];
        assert!(!can_split_after(&messages, 0));
    }

    #[test]
    fn can_split_after_rejects_trailing_tool_result() {
        // assistant (no tool calls), then tool result — splitting would orphan the tool.
        let messages = vec![
            msg("assistant", 10, 0),
            msg("tool", 10, 0),
            msg("user", 10, 0),
        ];
        assert!(!can_split_after(&messages, 0));
    }

    #[test]
    fn can_split_after_rejects_open_tool_exchange_in_prefix() {
        // assistant(2 calls), tool_a, [split here], tool_b
        // Splitting after tool_a would leave tool_b orphaned in the tail
        // because the prefix ends with an open exchange (1 result < 2 calls).
        let messages = vec![
            msg("assistant", 10, 2),
            msg("tool", 10, 0),
            msg("tool", 10, 0),
        ];
        assert!(!can_split_after(&messages, 1));
    }

    #[test]
    fn can_split_after_accepts_safe_split() {
        // assistant (no tool calls), then user — safe to split.
        let messages = vec![
            msg("assistant", 10, 0),
            msg("user", 10, 0),
        ];
        assert!(can_split_after(&messages, 0));
    }

    #[test]
    fn can_split_after_returns_false_for_out_of_bounds() {
        let messages = vec![msg("user", 10, 0)];
        assert!(!can_split_after(&messages, 5));
    }

    // ---- prefix_ends_with_open_tool_exchange ----

    #[test]
    fn open_exchange_detected_when_results_fewer_than_calls() {
        // assistant(2 calls), tool_a — 1 result < 2 calls → open.
        let messages = vec![
            msg("assistant", 10, 2),
            msg("tool", 10, 0),
        ];
        assert!(prefix_ends_with_open_tool_exchange(&messages, 1));
    }

    #[test]
    fn open_exchange_not_detected_when_results_match_calls() {
        // assistant(1 call), tool_a — 1 result == 1 call → resolved.
        let messages = vec![
            msg("assistant", 10, 1),
            msg("tool", 10, 0),
        ];
        assert!(!prefix_ends_with_open_tool_exchange(&messages, 1));
    }

    #[test]
    fn open_exchange_not_detected_for_non_tool_prefix() {
        let messages = vec![
            msg("assistant", 10, 0),
            msg("user", 10, 0),
        ];
        assert!(!prefix_ends_with_open_tool_exchange(&messages, 1));
    }
}
