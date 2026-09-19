//! Micro compaction — pure algorithm port of v2 `microCompaction`.
//!
//! Ported from `packages/agent-core-v2/src/agent/microCompaction/`:
//! `microCompactionService.ts` (the `compact()` method, our algorithm core),
//! `microCompaction.ts` (config shape + defaults), `microCompactionOps.ts`
//! (the `micro_compaction.apply` event carries only a `cutoff`), and `flag.ts`
//! (the `micro_compaction` experimental flag). The consumer-side semantics
//! (cutoff gate, min-content gate, CJK full-token weighting) are cross-checked
//! against `apps/vis/server/src/lib/context-projector.ts`.
//!
//! ## Semantics
//! After a prompt-cache miss, the oldest/oversized tool results in the
//! outgoing request are replaced by a fixed marker string so the rebuilt
//! prefix stays small. This module is a **pure function**: no IO, no global
//! state, no env reads. It mirrors `AgentMicroCompactionService.compact()`.
//!
//! The cache-miss trigger (`cacheMissedThresholdMs`), the context-usage gate
//! (`minContextUsageRatio`), and the `micro_compaction` flag are the CALLER's
//! responsibility — they live in `turn_loop` (see the header comment of
//! `microCompactionService.ts`, method `detect()`). This module only performs
//! the truncation once the caller has decided to trigger.
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
//! This module is algorithm-only. The caller must:
//! 1. decide to trigger on a detected prompt-cache miss + context-usage gate,
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

/// Knobs for the micro-compaction truncation pass. Mirrors the relevant fields
/// of v2 `MicroCompactionConfig` (`microCompaction.ts`). The cache-miss and
/// context-usage gate fields from v2 are intentionally omitted: the caller
/// decides *when* to trigger, this module only performs the truncation.
#[derive(Debug, Clone, PartialEq, Eq)]
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
}

impl Default for MicroCompactionConfig {
    fn default() -> Self {
        Self {
            keep_recent_messages: 20,
            min_content_tokens: 100,
            truncated_marker: DEFAULT_TRUNCATED_MARKER.to_string(),
        }
    }
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
#[derive(Debug, Clone, PartialEq, Eq)]
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
