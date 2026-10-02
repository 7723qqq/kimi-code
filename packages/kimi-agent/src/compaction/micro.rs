//! Micro compaction — pure algorithm port of the retired fork v2
//! `microCompaction` (`packages/agent-core-v2/src/agent/microCompaction/`):
//! `microCompactionService.ts` (the `compact()` method, our algorithm core),
//! `microCompaction.ts` (config shape + defaults), `microCompactionOps.ts`
//! (the `micro_compaction.apply` event carries only a `cutoff`), and `flag.ts`
//! (the `micro_compaction` experimental flag). That module existed in the
//! fork's own v2 copy and was retired with it; upstream never had it. The
//! consumer-side semantics (cutoff gate, min-content gate, CJK full-token
//! weighting) are cross-checked against
//! `apps/vis/server/src/lib/context-projector.ts`.
//!
//! ## Semantics
//! After a prompt-cache miss, the oldest/oversized tool results in the
//! outgoing request are replaced by a fixed marker string so the rebuilt
//! prefix stays small. This module is a **pure function**: no IO, no global
//! state, no env reads. It mirrors `AgentMicroCompactionService.compact()`.
//!
//! The cache-miss trigger (`cacheMissedThresholdMs`) and the context-usage
//! gate (`minContextUsageRatio`) live in [`detect_micro_compaction`], a pure
//! function over the same config — v2 keeps them in `detect()` on the service,
//! which is stateful only because it tracks `lastAssistantAt`. This module stays
//! pure: the caller supplies that timestamp.
//!
//! ## What gets replaced
//! For each message at history index `i < cutoff` (where
//! `cutoff = max(0, messages.len() - keep_recent_messages)`), if it is a
//! `tool` message with a defined `tool_call_id` and an estimated content size
//! `>= min_content_tokens`, its content is blanked to `truncated_marker` while
//! `role` and `tool_call_id` are preserved (so the assistant's matching tool
//! call still resolves to a well-formed — if empty — response). v2 does NOT
//! embed the tool name, original size, or a pointer to the original content in
//! the marker; the only retained metadata is the message's `tool_call_id`. The
//! marker text is the literal from v2: `[Old tool result content cleared]`.
//!
//! ## Token weighting
//! Mirrors v2 `estimateTokensForContentParts`
//! (`packages/agent-core-v2/src/kosong/contract/tokens.ts`, the retired
//! fork-only kosong module — upstream's copy lives at
//! `agent-core-v2/src/llm-adapter/contract/tokens.ts`): per content part,
//! `ceil(ascii_chars / 4) + non_ascii_chars`, where every non-ASCII code point
//! (e.g. CJK) counts as a FULL token. In Rust the weight is computed over
//! `blocks` when present, otherwise over the `content` string — matching the
//! provider projection boundary that selects `blocks` over `content`.
//!
//! ## Wiring note (for `turn_loop` integration)
//! The caller must:
//! 1. call [`detect_micro_compaction`] with the last assistant-output time, the
//!    current context size and the model's window,
//! 2. call [`apply_micro_compaction`] over the outgoing message view,
//! 3. raise the cutoff (persist `outcome.cutoff` and emit a
//!    `micro_compaction.apply` event carrying `{ cutoff }`, mirroring
//!    `microCompactionOps.ts`), and
//! 4. clamp the cutoff downward on `context.clear` / `context.apply_compaction`
//!    / `context.undo` so the index stays valid.

use crate::turn_loop::types::{ContentBlock, LLMMessage};

/// Default truncation marker. Identical to v2 `DEFAULT_MICRO_COMPACTION_CONFIG
/// .truncatedMarker` (`microCompaction.ts`) and `MICRO_TRUNCATED_MARKER` in
/// `apps/vis/server/src/lib/context-projector.ts`.
pub const DEFAULT_TRUNCATED_MARKER: &str = "[Old tool result content cleared]";

/// Knobs for the micro-compaction truncation pass. Mirrors v2's
/// `MicroCompactionConfig` (`microCompaction.ts`) field for field, including
/// the two gate knobs — [`Self::cache_missed_threshold_ms`] and
/// [`Self::min_context_usage_ratio`] — which [`detect_micro_compaction`]
/// reads. Defaults are v2's `DEFAULT_MICRO_COMPACTION_CONFIG` (`:17-23`).
#[derive(Debug, Clone, PartialEq)]
pub struct MicroCompactionConfig {
    /// Number of trailing messages exempt from truncation. Mirrors
    /// `keepRecentMessages` (v2 default 20).
    pub keep_recent_messages: usize,
    /// Minimum estimated content tokens for a tool result to be truncated.
    /// Mirrors `minContentTokens` (v2 default 100).
    pub min_content_tokens: usize,
    /// Marker text replacing a truncated tool result. Mirrors
    /// `truncatedMarker`.
    pub truncated_marker: String,
    /// Idle time after the last assistant output that counts as a prompt-cache
    /// miss (v2 `cacheMissedThresholdMs`, default 1 hour).
    pub cache_missed_threshold_ms: u64,
    /// Minimum context-window usage ratio for truncation to apply (v2
    /// `minContextUsageRatio`, default 0.5).
    pub min_context_usage_ratio: f64,
}

impl Default for MicroCompactionConfig {
    fn default() -> Self {
        Self {
            keep_recent_messages: 20,
            min_content_tokens: 100,
            truncated_marker: DEFAULT_TRUNCATED_MARKER.to_string(),
            cache_missed_threshold_ms: 60 * 60 * 1000,
            min_context_usage_ratio: 0.5,
        }
    }
}

/// Why micro compaction did or did not trigger, for the caller's telemetry
/// (v2 reports both `cache_age_ms` and the thresholds it compared against).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DetectOutcome {
    /// The context had not been idle long enough to count as a cache miss.
    NotIdleLongEnough,
    /// The context was full enough to be worth compacting.
    Triggered,
    /// The context is too empty to gain anything from compacting.
    ContextTooEmpty,
}

impl DetectOutcome {
    pub fn triggered(self) -> bool {
        matches!(self, Self::Triggered)
    }
}

/// Decide whether a micro-compaction pass should run — the two gates v2's
/// `detect()` applies before it will truncate anything.
///
/// `last_assistant_at_ms` is when this agent last produced assistant output;
/// `None` means it never has, which v2 treats as "no idle time yet" and so does
/// not trigger on (`cacheAgeMs === null` fails the comparison). The fork's
/// engine passes the session's history so the age is measured against real
/// output rather than a step counter.
///
/// Mirrors `AgentMicroCompactionService.detect()`
/// (`microCompactionService.ts:89-107`): idle beyond the threshold, **and** a
/// context filling at least `min_context_usage_ratio` of the window. An unknown
/// or zero window yields a ratio of 1 — v2's `:102-103` treats an undefined
/// `maxContextTokens` as full, so the usage gate never silently suppresses a
/// pass the idle gate already allowed.
pub fn detect_micro_compaction(
    last_assistant_at_ms: Option<i64>,
    now_ms: i64,
    context_tokens: usize,
    max_context_tokens: Option<usize>,
    config: &MicroCompactionConfig,
) -> DetectOutcome {
    let Some(last) = last_assistant_at_ms else {
        return DetectOutcome::NotIdleLongEnough;
    };
    let idle_ms = now_ms.saturating_sub(last).max(0) as u64;
    if idle_ms < config.cache_missed_threshold_ms {
        return DetectOutcome::NotIdleLongEnough;
    }

    let ratio = match max_context_tokens {
        Some(max) if max > 0 => context_tokens as f64 / max as f64,
        _ => 1.0,
    };
    if ratio < config.min_context_usage_ratio {
        return DetectOutcome::ContextTooEmpty;
    }
    DetectOutcome::Triggered
}

/// One tool result that was truncated — the info the caller needs to emit a
/// `micro_compaction.apply`-style event and to populate telemetry later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplacedToolResult {
    /// Original index in the input `messages` slice.
    pub index: usize,
    /// The `tool_call_id` of the truncated tool result. Preserved on the
    /// replacement message and surfaced here for telemetry/eventing. v2 does
    /// not retain the tool name or original content in the marker.
    pub tool_call_id: String,
    /// Estimated tokens of the original content (>= `min_content_tokens`).
    pub tokens_before: usize,
    /// Estimated tokens of the replacement marker.
    pub tokens_after: usize,
}

/// Outcome of a micro-compaction pass.
///
/// `Eq` is not derived: it carries `Vec<LLMMessage>`, whose `origin` field is
/// a `serde_json::Value` (not `Eq`). Nothing compares outcomes for equality
/// beyond `PartialEq`.
#[derive(Debug, Clone, PartialEq)]
pub struct MicroCompactionOutcome {
    /// Cutoff index: messages at history index `i < cutoff` are eligible for
    /// truncation. `max(0, messages.len() - keep_recent_messages)`.
    pub cutoff: usize,
    /// The (possibly) truncated message list. If nothing was replaced,
    /// `changed` is `false` and these clone the input unchanged.
    pub messages: Vec<LLMMessage>,
    /// Whether any tool result was actually replaced.
    pub changed: bool,
    /// Details of each replaced tool result, in ascending index order.
    pub replaced: Vec<ReplacedToolResult>,
    /// The marker text used for replacements.
    pub marker: String,
}

/// Replace oversized old tool results with the truncation marker.
///
/// Pure: same input always yields the same output and performs no IO. Mirrors
/// `AgentMicroCompactionService.compact(messages)` in
/// `microCompactionService.ts`, which iterates the history and blanks any
/// tool message at index `< cutoff` that has a `toolCallId` and content
/// `>= minContentTokens` (estimated via v2's `estimateTokensForContentParts`).
pub fn apply_micro_compaction(
    messages: &[LLMMessage],
    config: &MicroCompactionConfig,
) -> MicroCompactionOutcome {
    let cutoff = messages.len().saturating_sub(config.keep_recent_messages);
    let marker_tokens = estimate_tokens(&config.truncated_marker);

    let mut out: Vec<LLMMessage> = Vec::with_capacity(messages.len());
    let mut replaced: Vec<ReplacedToolResult> = Vec::new();
    let mut changed = false;

    for (i, msg) in messages.iter().enumerate() {
        let is_old = i < cutoff;
        let is_tool = msg.role == "tool";
        let has_call_id = msg.tool_call_id.is_some();
        let tokens = message_content_tokens(msg);

        if is_old && is_tool && has_call_id && tokens >= config.min_content_tokens {
            changed = true;
            replaced.push(ReplacedToolResult {
                index: i,
                tool_call_id: msg.tool_call_id.clone().unwrap_or_default(),
                tokens_before: tokens,
                tokens_after: marker_tokens,
            });
            // Blank the content to the marker. `role` and `tool_call_id` are
            // preserved; `blocks` and `tool_calls` are cleared so the provider
            // projection boundary sees only the marker (not the original blocks).
            out.push(LLMMessage {
                role: msg.role.clone(),
                content: config.truncated_marker.clone(),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: msg.tool_call_id.clone(),
                // The marker replaces the original content, but the message
                // keeps its identity (a steered user prompt stays the same
                // prompt for the projection).
                prompt_id: msg.prompt_id.clone(),
                origin: None,
            });
        } else {
            out.push(msg.clone());
        }
    }

    MicroCompactionOutcome {
        cutoff,
        messages: out,
        changed,
        replaced,
        marker: config.truncated_marker.clone(),
    }
}

/// Estimate the token weight of a message's effective content, mirroring v2
/// `estimateTokensForContentParts`. `blocks` take precedence over `content`
/// when present (provider projection boundary), exactly as v2 estimates each
/// `ContentPart`. ASCII ≈ 4 chars/token; every non-ASCII code point (e.g. CJK)
/// counts as a full token.
fn message_content_tokens(msg: &LLMMessage) -> usize {
    if !msg.blocks.is_empty() {
        msg.blocks.iter().map(block_tokens).sum()
    } else {
        estimate_tokens(&msg.content)
    }
}

fn block_tokens(block: &ContentBlock) -> usize {
    match block {
        ContentBlock::Text { text } => estimate_tokens(text),
        ContentBlock::Think { think, .. } => estimate_tokens(think),
        _ => 0,
    }
}

/// Per-text token estimate mirroring v2 `estimateTokens`
/// (`packages/agent-core-v2/src/kosong/contract/tokens.ts`, the retired
/// fork-only kosong module):
/// `ceil(ascii_chars / 4) + non_ascii_chars`.
fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    for ch in text.chars() {
        if (ch as u32) <= 127 {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }
    ascii.div_ceil(4) + non_ascii
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_loop::types::LLMMessage;

    fn config() -> MicroCompactionConfig {
        MicroCompactionConfig::default()
    }

    /// Config with no recent-messages exemption, so every message is within
    /// the truncation cutoff. Used to exercise the truncation logic directly.
    fn config_truncate_all() -> MicroCompactionConfig {
        MicroCompactionConfig {
            keep_recent_messages: 0,
            ..config()
        }
    }

    /// v2's `detect()` runs two gates, and the fork had neither: the flag alone
    /// decided, so any session with the feature on compacted on every request.
    /// These pin both, plus the two boundary cases that decide silently.
    #[test]
    fn detect_requires_both_idle_time_and_a_full_context() {
        let cfg = config();
        let hour = 60 * 60 * 1000;
        let now = 10 * hour;

        // Never produced output: v2's `cacheAgeMs === null` fails the test, so
        // there is no idle time to judge and nothing triggers.
        assert_eq!(
            detect_micro_compaction(None, now, 1000, Some(1000), &cfg),
            DetectOutcome::NotIdleLongEnough
        );

        // Fresh output (one second idle) must not trigger, however full.
        assert_eq!(
            detect_micro_compaction(Some(now - 1_000), now, 1000, Some(1000), &cfg),
            DetectOutcome::NotIdleLongEnough
        );

        // Idle past the threshold but the context is empty: the usage gate
        // suppresses it. 100/1000 = 0.1 < 0.5.
        assert_eq!(
            detect_micro_compaction(Some(now - hour), now, 100, Some(1000), &cfg),
            DetectOutcome::ContextTooEmpty
        );

        // Both gates satisfied: exactly at the 0.5 boundary, v2's `<` lets it through.
        assert_eq!(
            detect_micro_compaction(Some(now - hour), now, 500, Some(1000), &cfg),
            DetectOutcome::Triggered
        );

        // One millisecond short of the idle threshold does not trigger.
        assert_eq!(
            detect_micro_compaction(Some(now - hour + 1), now, 1000, Some(1000), &cfg),
            DetectOutcome::NotIdleLongEnough
        );
    }

    /// An unknown window counts as full, so a configured idle clock is never
    /// silently cancelled by a model that reports no `max_context_size` (v2
    /// substitutes a ratio of 1 at `detect()` `:102-103`).
    #[test]
    fn an_unknown_window_is_treated_as_full() {
        let cfg = config();
        let hour = 60 * 60 * 1000;
        let now = 10 * hour;
        for window in [None, Some(0)] {
            assert_eq!(
                detect_micro_compaction(Some(now - hour), now, 1, window, &cfg),
                DetectOutcome::Triggered,
                "window {window:?} must not suppress the pass"
            );
        }
    }

    /// A clock that reads as idle must not be defeated by a future timestamp
    /// (clock skew, or a stored value from a later machine).
    #[test]
    fn a_future_last_output_does_not_trigger() {
        let cfg = config();
        let now = 1_000_000;
        assert_eq!(
            detect_micro_compaction(Some(now + 5_000), now, 10_000, Some(1000), &cfg),
            DetectOutcome::NotIdleLongEnough
        );
    }

    #[test]
    fn no_oversized_results_returns_unchanged() {
        // Small tool result (1 token) below the 100-token gate must be left
        // untouched; the pass must report `changed = false`.
        let msgs = vec![
            LLMMessage::user("hi"),
            LLMMessage::tool_result("call_1", "small result"),
            LLMMessage::assistant("done"),
        ];
        let out = apply_micro_compaction(&msgs, &config());
        assert!(!out.changed, "nothing should be replaced");
        assert_eq!(out.replaced.len(), 0);
        assert_eq!(out.messages, msgs, "messages must be returned unchanged");
    }

    #[test]
    fn single_oversized_tool_result_is_replaced_and_meta_preserved() {
        // 400 ASCII chars => ceil(400/4) = 100 tokens >= min_content_tokens.
        let big = "x".repeat(400);
        let msgs = vec![LLMMessage::tool_result("call_42", big)];
        let out = apply_micro_compaction(&msgs, &config_truncate_all());
        assert!(out.changed);
        assert_eq!(out.replaced.len(), 1);
        assert_eq!(out.replaced[0].index, 0);
        assert_eq!(out.replaced[0].tool_call_id, "call_42");
        assert_eq!(out.replaced[0].tokens_before, 100);
        let replaced = &out.messages[0];
        assert_eq!(replaced.content, DEFAULT_TRUNCATED_MARKER);
        assert_eq!(replaced.tool_call_id.as_deref(), Some("call_42"));
        assert!(
            replaced.blocks.is_empty(),
            "blocks must be cleared on replace"
        );
        // The original large content must NOT survive in the replaced message.
        assert_ne!(replaced.content, "x".repeat(400));
    }

    #[test]
    fn threshold_boundary_at_exactly_min_content_tokens() {
        let cfg = config_truncate_all();
        // 400 ASCII => exactly 100 tokens: replaced.
        let at = vec![LLMMessage::tool_result("a", "y".repeat(400))];
        let out_at = apply_micro_compaction(&at, &cfg);
        assert!(out_at.changed, "exactly >= min must be replaced");

        // 396 ASCII => ceil(396/4) = 99 tokens (< 100): NOT replaced.
        let below = vec![LLMMessage::tool_result("b", "y".repeat(396))];
        let out_below = apply_micro_compaction(&below, &cfg);
        assert!(!out_below.changed, "just below min must be kept");
    }

    #[test]
    fn cjk_counts_as_full_token() {
        let cfg = config_truncate_all();
        // 100 CJK chars => 100 non-ASCII tokens => >= 100 => replaced.
        let cjk100 = "中".repeat(100);
        let out = apply_micro_compaction(&[LLMMessage::tool_result("c", cjk100)], &cfg);
        assert!(out.changed, "100 CJK chars must reach the 100-token gate");
        assert_eq!(out.replaced[0].tokens_before, 100);

        // 99 CJK chars => 99 tokens => below gate => kept.
        let cjk99 = "中".repeat(99);
        let out99 = apply_micro_compaction(&[LLMMessage::tool_result("d", cjk99)], &cfg);
        assert!(!out99.changed, "99 CJK chars stay below the gate");

        // 396 ASCII + 1 CJK => ceil(396/4) + 1 = 99 + 1 = 100 tokens.
        // 396 ASCII alone is 99 (< 100), proving the single CJK char adds a
        // full token and pushes the result over the gate.
        let mixed = format!("{}{}", "z".repeat(396), "中");
        let out_mixed = apply_micro_compaction(&[LLMMessage::tool_result("e", mixed)], &cfg);
        assert!(
            out_mixed.changed,
            "396 ascii + 1 cjk = 100 tokens must be replaced"
        );
    }

    #[test]
    fn cjk_weight_also_applies_to_blocks() {
        // Content carries CJK in `blocks` (provider projection boundary path).
        let mut msg = LLMMessage::tool_result("f", "");
        msg.blocks = vec![ContentBlock::Text {
            text: "本".repeat(100),
        }];
        let out = apply_micro_compaction(&[msg], &config_truncate_all());
        assert!(out.changed, "CJK-heavy blocks must be truncated");
    }

    #[test]
    fn multiple_candidates_selected_by_oldest_first_order() {
        // keep_recent_messages = 2 => cutoff = 4 - 2 = 2 (indices 0,1 eligible).
        let cfg = MicroCompactionConfig {
            keep_recent_messages: 2,
            ..config()
        };
        let big = "x".repeat(400);
        let msgs = vec![
            LLMMessage::user("prompt"),                    // index 0: not a tool
            LLMMessage::tool_result("old_a", big.clone()), // index 1: tool, old -> replace
            LLMMessage::tool_result("old_b", big.clone()), // index 2: tool, keepRecent tail
            LLMMessage::tool_result("old_c", big.clone()), // index 3: tool, keepRecent tail
        ];
        let out = apply_micro_compaction(&msgs, &cfg);
        assert_eq!(out.cutoff, 2);
        // Only the single eligible tool message (index 1) is replaced.
        assert_eq!(out.replaced.len(), 1);
        assert_eq!(out.replaced[0].index, 1);
        assert_eq!(out.replaced[0].tool_call_id, "old_a");
        // Newer large tool results are preserved verbatim.
        assert_eq!(out.messages[2].content, big);
        assert_eq!(out.messages[2].tool_call_id.as_deref(), Some("old_b"));
        assert_eq!(out.messages[3].content, big);
        assert_eq!(out.messages[3].tool_call_id.as_deref(), Some("old_c"));
    }

    #[test]
    fn non_tool_messages_never_replaced() {
        // A huge user/assistant message below the keepRecent tail must survive.
        let big = "x".repeat(400);
        let msgs = vec![LLMMessage::user(big.clone()), LLMMessage::assistant(big)];
        let out = apply_micro_compaction(&msgs, &config());
        assert!(!out.changed, "only tool messages are eligible");
        assert_eq!(out.replaced.len(), 0);
    }
}
