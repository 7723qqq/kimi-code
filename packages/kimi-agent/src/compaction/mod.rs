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

pub mod micro;

use crate::turn_loop::retry::{RetryConfig, retry_delay};
use crate::turn_loop::turn_step::{retry_after_hint, step_delay};
use crate::turn_loop::types::{ContentBlock, LLM, LLMChatParams, LLMMessage};
use tokio_util::sync::CancellationToken;

/// Default context window (tokens) assumed when the engine has no model
/// capability data. Mirrors `DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS` in
/// `packages/kimi-native-tools/src/compaction.rs`.
pub const DEFAULT_MAX_CONTEXT_TOKENS: u32 = 128 * 1024;

/// Total requests one compaction round may issue when the host configures no
/// cap (v2 #3750 `MAX_COMPACTION_RETRY_ATTEMPTS`). The fork takes upstream's
/// 5 rather than the step-retry default of 10: a summarizer that failed five
/// times is not going to succeed on the tenth, and every attempt re-sends the
/// whole omitted prefix.
pub const DEFAULT_COMPACTION_MAX_ATTEMPTS: u32 = 5;

/// Token accounting for the summary request's own scaffolding (v2
/// `requestTokens([])`), subtracted from the pre-shrink budget.
const SUMMARY_REQUEST_TOKENS: u32 = 1_000;

/// v2 `OVERFLOW_CONTEXT_SAFETY_RATIO` (fullCompactionService.ts:78): leave
/// headroom under the window so the token estimate's own error cannot tip the
/// request back over it.
const OVERFLOW_CONTEXT_SAFETY_RATIO: f64 = 0.85;

/// v2 `DEFAULT_COMPACTION_CONFIG.maxOverflowCompactionAttempts`
/// (strategy.ts:23): one turn may compact-and-retry after a context overflow
/// this many times in a row before the turn is failed. v2's companion
/// `maxCompactionPerTurn` is `Infinity` by default and has no production setter,
/// so this is the only overflow brake that actually fires.
pub const DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS: u32 = 3;

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
    /// Total requests one compaction round may issue (v2 #3750
    /// `loopControl.compactionMaxAttempts`); `None` keeps
    /// [`DEFAULT_COMPACTION_MAX_ATTEMPTS`].
    pub max_attempts: Option<u32>,
    /// How many times in a row one turn may recover from a context overflow by
    /// compacting and retrying the step (v2 `maxOverflowCompactionAttempts`,
    /// `strategy.ts:23`). The counter resets as soon as a step completes, so
    /// this bounds only the case the recovery cannot fix: a context that stays
    /// above the window no matter how it is shrunk.
    pub max_overflow_compaction_attempts: u32,
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
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
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
            | ContentBlock::MediaRef { .. }
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

/// [`should_compact`] *and* a safe split point exists — what the turn loop
/// must check **before** it announces `compaction.started`.
///
/// Crossing the threshold only says the history is too long; it says nothing
/// about whether [`compute_compact_count`] can find anywhere to cut, and a
/// count of 0 makes [`force_compact_messages_with_summary_report`] a no-op
/// that still reports `tokensAfter == tokensBefore` with an empty summary.
/// Announced from the turn loop that reads as a `compaction.completed`
/// success that changed nothing — and because the trigger is unchanged, the
/// next step would announce it again.
///
/// The empty case is not exotic: the compacted head is a run of user-shaped
/// messages (kept user input + elision + summary + continuation) and
/// [`can_split_after`] refuses to cut after a user message, so a second
/// compaction arriving before the model has written another assistant turn
/// has nowhere to split.
pub fn should_compact_auto(
    messages: &[LLMMessage],
    used_size: u32,
    config: &CompactionConfig,
) -> bool {
    should_compact(used_size, config) && compute_compact_count(messages, config) > 0
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
pub fn force_compact_messages(
    messages: &[LLMMessage],
    config: &CompactionConfig,
) -> Vec<LLMMessage> {
    apply_compaction(messages, compute_compact_count(messages, config))
}

/// Manual compaction (`POST :compact`): the count comes from the tail scan
/// below instead of the auto window, so it compacts far more of the history
/// (v2 `computeCompactCount(..., 'manual')`, strategy.ts:182-189).
pub fn force_compact_messages_manual(
    messages: &[LLMMessage],
    config: &CompactionConfig,
) -> Vec<LLMMessage> {
    apply_compaction(messages, compute_compact_count_manual(messages, config))
}

/// Project `count` leading messages into a summary placeholder, keeping the
/// system message (index 0) and the tail untouched.
fn apply_compaction(messages: &[LLMMessage], count: u32) -> Vec<LLMMessage> {
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

/// Manual split-point search: walk from the tail and take the *deepest* safe
/// split, so a manual compaction keeps only the smallest safe tail
/// (v2 `computeCompactCount` manual branch).
pub fn compute_compact_count_manual(messages: &[LLMMessage], config: &CompactionConfig) -> u32 {
    let n = messages.len();
    if n <= 1 {
        return 0;
    }
    for index in (1..n).rev() {
        if can_split_after(messages, index) {
            let count = fit_compact_count_to_window(messages, (index + 1) as u32, config);
            // A count of 1 would mean compacting only the header (index 0),
            // which is never allowed — the same floor the auto branch
            // applies. Without it the "compaction" would insert a summary
            // without removing anything.
            return if count <= 1 { 0 } else { count };
        }
    }
    0
}

/// Status codes whose overflow wording v2 trusts. `isContextOverflowStatusError`
/// (human/llm/errors.ts:279-283) refuses every other code before it looks at the
/// message, so a 500 whose body happens to contain `max_tokens` is a server
/// fault rather than an overflow.
const OVERFLOW_KEYWORD_STATUSES: [u16; 3] = [400, 413, 422];

/// How full the window must already be before a bare 413 is still read as an
/// overflow. v2 `OVERFLOW_STATUS_RECOVERY_RATIO` (fullCompactionService.ts:79).
const OVERFLOW_STATUS_RECOVERY_RATIO: f64 = 0.5;

/// Observed effective windows per model (v2 `observedMaxContextTokensByModel`,
/// fullCompactionService.ts:215). The fork's window is host-resolved per turn;
/// this in-process cache lowers it after an observed overflow so the next
/// request — and the auto-compaction trigger — use the conservative value
/// instead of re-overflowing every turn. v2 persists the map through
/// `defineState`; the fork's engine is per-process, so an observation is
/// relearned after a restart (recorded difference). Keyed by model name: the
/// real window is a property of the provider/model, not of the session.
static OBSERVED_MAX_TOKENS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, u64>>,
> = std::sync::OnceLock::new();

fn observed_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, u64>> {
    OBSERVED_MAX_TOKENS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// v2 `observeContextOverflow` (fullCompactionService.ts:320-331): after an
/// observed overflow, remember `max(1, floor(estimated × 0.85))` as the
/// model's effective window — only ever lowering it, and never below what
/// the host already configured.
pub fn observe_context_overflow(
    model: &str,
    estimated_request_tokens: u32,
    configured: Option<u32>,
) {
    if model.is_empty() || estimated_request_tokens == 0 {
        return;
    }
    let observed = ((f64::from(estimated_request_tokens)) * OVERFLOW_CONTEXT_SAFETY_RATIO)
        .floor()
        .max(1.0) as u64;
    let current = effective_max_tokens(model, configured).unwrap_or(0);
    if current > 0 && observed >= u64::from(current) {
        return;
    }
    observed_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(model.to_string(), observed);
}

/// v2 `getEffectiveMaxContextTokens` (fullCompactionService.ts:258-267):
/// `min(configured, observed)`; the configured value stands when nothing was
/// observed, and a lone observation (no configured window) stands on its own.
pub fn effective_max_tokens(model: &str, configured: Option<u32>) -> Option<u32> {
    let observed = observed_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(model)
        .copied();
    match (configured, observed) {
        (Some(configured), Some(observed)) => Some(configured.min(observed as u32)),
        (Some(configured), None) => Some(configured),
        (None, Some(observed)) => Some(observed as u32),
        (None, None) => None,
    }
}

/// Classify whether an LLM error string indicates that the context length / window was exceeded.
///
/// Mirrors `CONTEXT_OVERFLOW_MESSAGE_PATTERNS` in `agent-core-v2` / `kosong`,
/// behind the status gate v2 puts in front of it (`isContextOverflowStatusError`):
/// the wording table is consulted only for a 400/413/422, or for an error that
/// carries no status at all — an in-stream provider error such as OpenAI's
/// `context_length_exceeded`, which v2 classifies by code and stamps with a
/// synthetic 400 (`errorFromOpenAIResponsesEvent`). Any other status is
/// rejected outright.
pub fn is_context_overflow_error(error: &str) -> bool {
    if let Some(code) = crate::llm::http::llm_http_status(error)
        && !OVERFLOW_KEYWORD_STATUSES.contains(&code)
    {
        return false;
    }
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

/// Whether a failed LLM call should trigger emergency compaction.
///
/// Mirrors v2 `shouldRecoverFromContextOverflow` (fullCompactionService.ts:305-318),
/// minus the branches the Rust engine cannot reach: v2's first branch tests a
/// coded `context.overflow` error, and there is no typed error channel here.
/// Two ways in remain —
///
/// 1. wording that names a context overflow (see
///    [`is_context_overflow_error`]); or
/// 2. an HTTP 413 whose request already filled at least
///    [`OVERFLOW_STATUS_RECOVERY_RATIO`] of the model's window. This is what
///    covers a gateway that answers 413 with an opaque body: the size, not the
///    text, is the evidence.
///
/// A 413 for a small request is a proxy rejecting it (a body limit, an auth
/// wrapper), and compacting for that would only throw context away — which is
/// why the size gate exists instead of accepting every 413. With no known
/// window there is nothing to compare against, so only branch 1 applies.
pub fn should_recover_from_context_overflow(
    error: &str,
    estimated_request_tokens: u32,
    max_context_tokens: Option<u32>,
) -> bool {
    if is_context_overflow_error(error) {
        return true;
    }
    if crate::llm::http::llm_http_status(error) != Some(413) {
        return false;
    }
    let Some(max) = max_context_tokens.filter(|max| *max > 0) else {
        return false;
    };
    let threshold = (f64::from(max) * OVERFLOW_STATUS_RECOVERY_RATIO) as u32;
    estimated_request_tokens >= threshold
}

/// Placeholder text standing in for the compacted prefix, matching the TS
/// `createCompactionSummaryMessage` marker.
///
/// Only the synchronous legacy helpers insert this marker. Summary-producing
/// APIs propagate failures without replacing history.
pub(crate) fn summary_placeholder(omitted: usize) -> String {
    format!(
        "[Earlier conversation compacted: {omitted} messages were summarized away \
         to fit the context window. Continue from the most recent context.]"
    )
}

/// The compaction summary prefix (v2 `compaction-summary-prefix.md`,
/// `COMPACTION_SUMMARY_PREFIX`). Tells the model the summary is its own
/// working notes and that earlier user messages are preserved verbatim in
/// this context — a promise the kept head/tail below fulfills.
pub const COMPACTION_SUMMARY_PREFIX: &str = "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary. The summary records which earlier requests were already addressed.";

/// Head budget for user messages kept verbatim across compaction (v2
/// `COMPACT_USER_MESSAGE_HEAD_TOKENS`).
const COMPACT_USER_MESSAGE_HEAD_TOKENS: u32 = 2_000;
/// Tail budget for user messages kept verbatim across compaction (v2
/// `COMPACT_USER_MESSAGE_MAX_TOKENS`).
const COMPACT_USER_MESSAGE_MAX_TOKENS: u32 = 20_000;

/// The elision note inserted between the kept head and tail (v2
/// `buildCompactionElisionText`).
fn compaction_elision_text(omitted_tokens: u32) -> String {
    crate::injection::wrap_system_reminder(&format!(
        "Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly {omitted_tokens} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation."
    ))
}

/// Truncate text to at most `max_tokens` estimated tokens, keeping the END
/// (v2 `truncateTextToTokensFromEnd`).
fn truncate_text_to_tokens_from_end(text: &str, max_tokens: u32) -> &str {
    if max_tokens == 0 {
        return "";
    }
    let mut ascii_count: u32 = 0;
    let mut non_ascii_count: u32 = 0;
    let mut start = text.len();
    for (byte_offset, ch) in text.char_indices().rev() {
        if ch.is_ascii() {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
        if ascii_count.div_ceil(4) + non_ascii_count > max_tokens {
            break;
        }
        start = byte_offset;
    }
    &text[start..]
}

/// Truncate text to at most `max_tokens` estimated tokens, keeping the HEAD
/// (v2 `truncateTextToTokens`).
fn truncate_text_to_tokens(text: &str, max_tokens: u32) -> &str {
    if max_tokens == 0 {
        return "";
    }
    let mut ascii_count: u32 = 0;
    let mut non_ascii_count: u32 = 0;
    let mut end = text.len();
    for (byte_offset, ch) in text.char_indices() {
        if ch.is_ascii() {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
        if ascii_count.div_ceil(4) + non_ascii_count > max_tokens {
            break;
        }
        end = byte_offset + ch.len_utf8();
    }
    &text[..end]
}

/// The kept-verbatim user messages v2's `selectCompactionUserMessages`
/// picks from the compacted range, returned as the assembled v2 kept
/// sequence: the head fills `head_tokens` (oldest input, possibly
/// truncated — one truncating message ends the head), then the elision
/// note (when anything was omitted), then the tail fits `max_tokens` (the
/// newest input, possibly suffix-truncated at the boundary).
fn select_kept_user_messages(user_messages: &[LLMMessage]) -> Vec<LLMMessage> {
    let total_tokens: u32 = user_messages.iter().map(estimate_message_tokens).sum();
    if total_tokens <= COMPACT_USER_MESSAGE_MAX_TOKENS {
        return user_messages.to_vec();
    }

    let head_budget = COMPACT_USER_MESSAGE_HEAD_TOKENS.min(COMPACT_USER_MESSAGE_MAX_TOKENS);
    let tail_budget = COMPACT_USER_MESSAGE_MAX_TOKENS - head_budget;

    let mut tail: Vec<LLMMessage> = Vec::new();
    let mut tail_remaining = tail_budget;
    let mut head_end_exclusive = user_messages.len();
    let mut tail_boundary_prefix: Option<String> = None;
    for index in (0..user_messages.len()).rev() {
        // v2 `i >= 0 && tailRemaining > 0`: once the tail budget is spent the
        // loop stops before straddling — the next message belongs whole to
        // the head side, and no empty suffix message is emitted.
        if tail_remaining == 0 {
            break;
        }
        let message = &user_messages[index];
        let tokens = estimate_message_tokens(message);
        if tokens <= tail_remaining {
            tail.push(message.clone());
            tail_remaining -= tokens;
            head_end_exclusive = index;
            continue;
        }
        let full_text = message.content.clone();
        let kept_suffix = truncate_text_to_tokens_from_end(&full_text, tail_remaining);
        let mut kept = message.clone();
        kept.content = kept_suffix.to_string();
        tail.push(kept);
        head_end_exclusive = index;
        let dropped = &full_text[..full_text.len() - kept_suffix.len()];
        if !dropped.is_empty() {
            let mut prefix = message.clone();
            prefix.content = dropped.to_string();
            tail_boundary_prefix = Some(prefix.content);
        }
        break;
    }
    tail.reverse();

    let mut head: Vec<LLMMessage> = Vec::new();
    let mut head_remaining = head_budget;
    let head_candidates_len = head_end_exclusive + usize::from(tail_boundary_prefix.is_some());
    #[allow(clippy::needless_range_loop)] // indexes user_messages and the boundary prefix
    for index in 0..head_candidates_len {
        if head_remaining == 0 {
            break;
        }
        if tail_boundary_prefix.is_some() && index == head_end_exclusive {
            // v2 order: truncate the head-side half to the remaining budget
            // FIRST (truncateUserMessage), then spend exactly that many
            // tokens — the truncation itself must not be driven to empty by
            // a budget the message is about to consume.
            let text = tail_boundary_prefix.as_deref().unwrap_or_default();
            let kept_text = truncate_text_to_tokens(text, head_remaining);
            head_remaining = head_remaining.saturating_sub(estimate_tokens(kept_text));
            let mut head_message = user_messages[index].clone();
            head_message.content = kept_text.to_string();
            head.push(head_message);
        } else {
            let message = &user_messages[index];
            let tokens = estimate_message_tokens(message);
            if tokens <= head_remaining {
                head.push(message.clone());
                head_remaining -= tokens;
            } else {
                let mut truncated = message.clone();
                truncated.content =
                    truncate_text_to_tokens(&message.content, head_remaining).to_string();
                head.push(truncated);
                // v2: one truncated message ends the head — without this the
                // budget is never spent and every further candidate is
                // truncated and kept too.
                break;
            }
        }
    }

    let kept_tokens: u32 = head
        .iter()
        .chain(tail.iter())
        .map(estimate_message_tokens)
        .sum();
    let omitted = total_tokens.saturating_sub(kept_tokens);
    let elision = LLMMessage {
        role: "user".into(),
        content: compaction_elision_text(omitted),
        ..Default::default()
    };
    head.push(elision);
    head.extend(tail);
    head
}

/// Continuation reminder appended after context compaction, matching upstream #3537.
pub const COMPACTION_CONTINUATION_TEXT: &str = "<system-reminder>\nContext compaction is complete — continue the work that was in progress when it began.\n</system-reminder>";

/// Build the continuation message that anchors context compaction resumption.
pub fn compaction_continuation_message() -> LLMMessage {
    LLMMessage {
        role: "user".into(),
        content: COMPACTION_CONTINUATION_TEXT.into(),
        ..Default::default()
    }
}

/// v2's handoff template — `agent/fullCompaction/compaction-instruction.md`,
/// byte-identical (SHA256 `9578d8c2088f64d0b58f2ec0f10b4a0cf2a70caa9b08d46c847a8d12e6ec6545`)
/// to the copy `human/compaction/` ships. Model input, so it stays English like
/// the rest of the prompt surface. The trailing `${custom_instruction_block}` is
/// filled by [`render_compaction_instruction`].
const COMPACTION_INSTRUCTION_TEMPLATE: &str = include_str!("compaction-instruction.md");

/// v2 `renderCompactionInstruction` (`fullCompaction/compactionInstruction.ts`)
/// and `human/compaction/summarize.ts`'s `compactionInstructionText`: the
/// template always ships in full, and a caller instruction is appended *inside*
/// it rather than substituted for it. An absent or blank instruction leaves the
/// placeholder empty. Mirrors v2's `.trimEnd()` on the rendered result.
fn render_compaction_instruction(instruction: Option<&str>) -> String {
    let block = match instruction
        .map(str::trim)
        .filter(|custom| !custom.is_empty())
    {
        Some(custom) => format!("\nOptional user instruction:\n{custom}\n"),
        None => String::new(),
    };
    COMPACTION_INSTRUCTION_TEMPLATE
        .replace("${custom_instruction_block}", &block)
        .trim_end()
        .to_string()
}

/// Build the prompt messages for the summarizer LLM call.
///
/// The system message instructs the model to summarize; the user message
/// carries the omitted conversation as a flat `role: content` transcript,
/// *followed by* the handoff instruction. v2 appends that instruction as the
/// last message after the history (`fullCompactionService.ts`: `[...
/// messagesToCompact, createUserMessage(instruction)]`), which is also the
/// only position where the template's own "This message is a direct task, not
/// part of the above conversation" reads correctly. Tool calls are serialized
/// inline so the summarizer can see what was done.
fn summarization_prompt(omitted: &[LLMMessage], instruction: Option<&str>) -> Vec<LLMMessage> {
    let mut transcript = String::new();
    for m in omitted {
        if !transcript.is_empty() {
            transcript.push('\n');
        }
        transcript.push_str(&m.role);
        transcript.push_str(": ");
        transcript.push_str(&m.content);
        for call in &m.tool_calls {
            transcript.push_str(&format!(" [tool_call: {}({})]", call.name, call.arguments));
        }
    }

    let rendered = render_compaction_instruction(instruction);
    let user_content = format!("{transcript}\n\n{rendered}");

    vec![
        LLMMessage::system(
            "You are a conversation summarizer. Produce a concise, self-contained summary.",
        ),
        LLMMessage::user(user_content),
    ]
}

/// The compaction's failure modes. `Display` renders through the engine i18n
/// layer (`LocalizedText`), so a host that installed a locale sees its own
/// language — hand-written instead of `thiserror` for exactly that reason;
/// `Provider` keeps `transparent` semantics (its text and `source()` are the
/// wrapped error's).
#[derive(Debug)]
pub enum CompactionError {
    Cancelled,
    EmptySummary,
    Provider(Box<dyn std::error::Error + Send + Sync>),
}

impl std::fmt::Display for CompactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(
                f,
                "{}",
                crate::i18n::LocalizedText::plain(
                    "engine.compaction.cancelled",
                    "compaction cancelled",
                )
                .render()
            ),
            Self::EmptySummary => write!(
                f,
                "{}",
                crate::i18n::LocalizedText::plain(
                    "engine.compaction.emptySummary",
                    "The compaction response did not contain a usable summary.",
                )
                .render()
            ),
            Self::Provider(error) => std::fmt::Display::fmt(error, f),
        }
    }
}

impl std::error::Error for CompactionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Provider(error) => Some(error.as_ref()),
            Self::Cancelled | Self::EmptySummary => None,
        }
    }
}

/// Generate a usable summary before any history is replaced. Empty responses
/// retry with the oldest message and leading tool results removed, as in v2.
pub async fn summarize_with_llm(
    omitted: &[LLMMessage],
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
    max_attempts: Option<u32>,
) -> Result<String, CompactionError> {
    summarize_with_llm_budgeted(omitted, llm, instruction, cancel, max_attempts, None).await
}

/// [`summarize_with_llm`] with the effective model window, so the summarizer's
/// **first** request is pre-shrunk to fit instead of being sent whole.
///
/// v2 #3911 `preShrinkHistoryToWindowBudget` (fullCompactionService.ts:818-841):
/// without this, a compaction whose omitted history already exceeds the model
/// window sends the whole thing, overflows, and only then starts dropping one
/// message per empty-summary retry — so a turn that switched to a
/// smaller-window model burns the whole retry budget and fails. The budget
/// reserves room for the summary itself and applies the same safety ratio the
/// overflow path uses.
pub async fn summarize_with_llm_budgeted(
    omitted: &[LLMMessage],
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
    max_attempts: Option<u32>,
    effective_max_tokens: Option<u32>,
) -> Result<String, CompactionError> {
    let pre_shrunk = pre_shrink_to_window_budget(omitted, instruction, effective_max_tokens);
    // The overflow shrink below replaces the working set, so it owns its
    // buffer; the common path borrows the caller's slice untouched.
    let mut current: std::borrow::Cow<'_, [LLMMessage]> = match pre_shrunk {
        Some(shrunken) => std::borrow::Cow::Owned(shrunken),
        None => std::borrow::Cow::Borrowed(omitted),
    };
    let retry_config = RetryConfig {
        max_attempts: max_attempts.unwrap_or(DEFAULT_COMPACTION_MAX_ATTEMPTS),
        ..RetryConfig::default()
    };
    let infinite = crate::turn_loop::retry::infinite_retry_enabled();
    let mut attempt: u32 = 0;
    let mut overflow_shrink_count: u32 = 0;
    loop {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(CompactionError::Cancelled);
        }
        attempt += 1;
        let mut history: &[LLMMessage] = &current;
        let params = LLMChatParams {
            messages: std::sync::Arc::from(summarization_prompt(history, instruction)),
            tools: std::sync::Arc::from(Vec::new()),
            cancel: cancel.cloned(),
        };
        let response = match cancel {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => return Err(CompactionError::Cancelled),
                response = llm.chat(params) => response,
            },
            None => llm.chat(params).await,
        };
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(CompactionError::Cancelled);
        }
        match response {
            Ok(response) => {
                let trimmed = response.content.trim();
                if !trimmed.is_empty() {
                    return Ok(trimmed.to_string());
                }
                if attempt >= retry_config.max_attempts || history.len() <= 1 {
                    return Err(CompactionError::EmptySummary);
                }
                history = &history[1..];
                while history
                    .first()
                    .is_some_and(|message| message.role == "tool")
                {
                    history = &history[1..];
                }
                if history.is_empty() {
                    return Err(CompactionError::EmptySummary);
                }
            }
            Err(err) => {
                let err_str = err.to_string();
                if crate::llm::http::is_cancelled_error(&err_str) {
                    return Err(CompactionError::Cancelled);
                }
                // v2's overflow recovery inside the compaction request itself
                // (fullCompactionService.ts:690-710): the pre-shrink is an
                // estimate, and a provider that counts tokens differently can
                // still refuse the summarization request — shrink the history
                // by this attempt's ratio and retry instead of failing the
                // compaction.
                let prompt = summarization_prompt(&current, instruction);
                let estimated_request_tokens = prompt
                    .iter()
                    .map(estimate_message_tokens)
                    .fold(0u32, u32::saturating_add);
                if should_recover_from_context_overflow(
                    &err_str,
                    estimated_request_tokens,
                    effective_max_tokens,
                ) {
                    // v2 `observeContextOverflow` (fullCompactionService.ts:695):
                    // the summarization request that just overflowed is
                    // evidence the real window is smaller than configured —
                    // remember it so the next turn uses the conservative value.
                    observe_context_overflow(
                        llm.model_name(),
                        estimated_request_tokens,
                        effective_max_tokens,
                    );
                    overflow_shrink_count += 1;
                    if overflow_shrink_count > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS
                        || attempt >= retry_config.max_attempts
                        || current.len() <= 1
                    {
                        return Err(CompactionError::Provider(err));
                    }
                    let ratio =
                        COMPACTION_OVERFLOW_SHRINK_RATIOS[(overflow_shrink_count - 1) as usize];
                    let total: u32 = current
                        .iter()
                        .map(estimate_message_tokens)
                        .fold(0, u32::saturating_add);
                    let shrunk =
                        take_recent_within_budget(&current, (f64::from(total) * ratio) as u32);
                    if shrunk.is_empty() {
                        return Err(CompactionError::Provider(err));
                    }
                    current = std::borrow::Cow::Owned(shrunk);
                    continue;
                }
                if !llm.is_retryable_error(&err_str)
                    || (!infinite && attempt >= retry_config.max_attempts)
                {
                    return Err(CompactionError::Provider(err));
                }
                let delay = step_delay(
                    retry_delay(attempt, &retry_config),
                    retry_after_hint(&err_str),
                );
                match cancel {
                    Some(token) => tokio::select! {
                        biased;
                        _ = token.cancelled() => return Err(CompactionError::Cancelled),
                        _ = tokio::time::sleep(delay) => {},
                    },
                    None => tokio::time::sleep(delay).await,
                }
            }
        }
    }
}

/// Shrink the summarizer's history to what the model window can actually take,
/// or `None` when it already fits.
///
/// v2 #3911 `preShrinkHistoryToWindowBudget` (fullCompactionService.ts:818-841):
/// reserve room for the summary (`compaction_max_output_size`, capped at an
/// eighth of the window), apply the safety ratio, subtract the request's own
/// tokens, and keep the most recent messages that fit. Without this a
/// compaction whose omitted history already exceeds the window sends the whole
/// thing, overflows, and only then starts dropping one message per
/// empty-summary retry — so switching to a smaller-window model burns the
/// retry budget and fails the turn.
///
/// `None` means "send what you had": no window to respect, the history already
/// fits, or nothing would survive.
/// v2 `MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS` (fullCompactionService.ts:80):
/// how many times one compaction may shrink its own history after the
/// summarization request itself overflowed.
const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS: u32 = 3;

/// v2 `COMPACTION_OVERFLOW_SHRINK_RATIOS` (fullCompactionService.ts:81): the
/// share of the history a retry after an overflowed compaction request keeps,
/// by shrink attempt.
const COMPACTION_OVERFLOW_SHRINK_RATIOS: [f64; 3] = [0.7, 0.5, 0.35];

fn pre_shrink_to_window_budget(
    history: &[LLMMessage],
    instruction: Option<&str>,
    effective_max_tokens: Option<u32>,
) -> Option<Vec<LLMMessage>> {
    let effective_max_tokens = effective_max_tokens.filter(|tokens| *tokens > 0)?;
    let output_reserve = effective_max_tokens / 8;
    let message_budget =
        ((effective_max_tokens - output_reserve) as f64 * OVERFLOW_CONTEXT_SAFETY_RATIO) as u32;
    let message_budget = message_budget.saturating_sub(SUMMARY_REQUEST_TOKENS);
    if message_budget == 0 {
        return None;
    }

    let instruction_tokens = instruction.map(estimate_tokens).unwrap_or(0);
    let total: u32 = history
        .iter()
        .map(estimate_message_tokens)
        .fold(instruction_tokens, u32::saturating_add);
    if total <= message_budget {
        return None;
    }

    let shrunken = take_recent_within_budget(history, message_budget);
    if shrunken.is_empty() {
        None
    } else {
        Some(shrunken)
    }
}

/// Keep the newest messages that fit `budget`, then drop leading tool results —
/// a tool result without its call is not a sequence a provider accepts.
/// v2 `takeRecentMessagesWithinTokenBudget` (fullCompactionService.ts:933-950).
fn take_recent_within_budget(history: &[LLMMessage], budget: u32) -> Vec<LLMMessage> {
    let mut start = history.len();
    let mut tokens: u32 = 0;
    for (index, message) in history.iter().enumerate().rev() {
        let message_tokens = estimate_message_tokens(message);
        if tokens.saturating_add(message_tokens) > budget {
            break;
        }
        tokens = tokens.saturating_add(message_tokens);
        start = index;
    }
    // v2 `if (start === 0) start = 1;` — everything fit, so keep all but the
    // oldest. When nothing fits, `start` stays at `length` and the slice is
    // empty; `pre_shrink_to_window_budget` reads that as "send what you had"
    // rather than an empty prompt.
    if start == 0 {
        start = 1;
    }
    let mut slice = history[start..].to_vec();
    while slice.first().is_some_and(|message| message.role == "tool") {
        slice.remove(0);
    }
    slice
}

/// v2 `postProcessSummary` (fullCompactionService.ts:844-851): when the
/// session has todos, the compaction summary carries the rendered list so the
/// model's working notes keep the todo state once the history is folded away.
/// `todos` is the rendered list; `None` (an empty list) leaves the summary
/// untouched — v2 returns it untrimmed in that case too.
pub fn post_process_summary(summary: String, todos: Option<String>) -> String {
    match todos {
        None => summary,
        Some(list) => format!("{}\n\n{list}", summary.trim()),
    }
}

/// The rendered todo list a compaction summary carries: `None` when the raw
/// domain value is missing or holds no items (v2's `todos.length === 0`
/// guard). Shared by the host-bridge read and the server's own state store,
/// so both seams append the same bytes.
pub fn todo_list_for_summary(raw: Option<&serde_json::Value>) -> Option<String> {
    let todos = crate::tools::todo_item::read_todo_items(raw?);
    if todos.is_empty() {
        None
    } else {
        Some(crate::tools::todo_item::render_todo_list_with_title(
            &todos,
            "## TODO List",
        ))
    }
}

/// Read the session's todos through the host state bridge and render the
/// list [`post_process_summary`] appends. A host without the state bridge or
/// without todos degrades to `None` (a plain summary) instead of erroring
/// the compaction.
pub async fn read_todos_for_summary(
    callbacks: &dyn crate::callbacks::HostCallbacks,
) -> Option<String> {
    let response = callbacks
        .state_read(crate::rpc::types::StateReadRequest {
            domain: "todo".into(),
            key: "todo".into(),
            turn_id: String::new(),
            tool_call_id: String::new(),
        })
        .await
        .ok()?;
    todo_list_for_summary(Some(&response.value))
}

/// Unconditionally compact `messages` only after a usable LLM summary succeeds.
///
/// Like [`force_compact_messages`] but the compacted prefix is replaced by a
/// user message carrying the LLM-generated summary instead of a fixed
/// placeholder.
pub async fn force_compact_messages_with_summary(
    messages: &[LLMMessage],
    config: &CompactionConfig,
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> Result<Vec<LLMMessage>, CompactionError> {
    force_compact_messages_with_summary_budgeted(messages, config, llm, instruction, cancel, None)
        .await
}

/// [`force_compact_messages_with_summary`] with the model's effective window,
/// so the summarizer's first request is pre-shrunk to fit it (v2 #3911).
/// Callers that know the window pass it — the turn loop on both the threshold
/// and the overflow path, the REST `:compact` route, and the NAPI manual
/// compaction; the convenience wrappers keep the unbudgeted behaviour.
pub async fn force_compact_messages_with_summary_budgeted(
    messages: &[LLMMessage],
    config: &CompactionConfig,
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
    effective_max_tokens: Option<u32>,
) -> Result<Vec<LLMMessage>, CompactionError> {
    let tokens_before = estimate_messages_tokens(messages);
    Ok(force_compact_messages_with_summary_report(
        messages,
        config,
        llm,
        instruction,
        cancel,
        effective_max_tokens,
        tokens_before,
        None,
    )
    .await?
    .0)
}

/// What one compaction did, for the host's `compaction.completed` event (v2
/// `full_compaction.completed`). The engine folds a prefix into an LLM-written
/// summary; the host renders a transcript card from these numbers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionReport {
    pub summary: String,
    pub compacted_count: u32,
    pub tokens_before: u32,
    pub tokens_after: u32,
}

/// [`force_compact_messages_with_summary_budgeted`] that also returns the
/// report the host's `compaction.completed` event carries. Additive: the
/// existing entry point delegates here and discards the report, so callers that
/// only need the messages are untouched. `tokens_before` is the caller's own
/// estimate for the pre-compaction history (the threshold path already has it;
/// the overflow-recovery path passes its own). `todos` is the rendered todo
/// list from [`read_todos_for_summary`] — v2 `postProcessSummary` appends it
/// to the written summary; `None` skips the suffix.
#[allow(clippy::too_many_arguments)]
pub async fn force_compact_messages_with_summary_report(
    messages: &[LLMMessage],
    config: &CompactionConfig,
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
    effective_max_tokens: Option<u32>,
    tokens_before: u32,
    todos: Option<String>,
) -> Result<(Vec<LLMMessage>, CompactionReport), CompactionError> {
    let count = compute_compact_count(messages, config);
    if count == 0 {
        return Ok((
            messages.to_vec(),
            CompactionReport {
                summary: String::new(),
                compacted_count: 0,
                tokens_before,
                tokens_after: tokens_before,
            },
        ));
    }
    let omitted = &messages[1..count as usize];
    let summary = summarize_with_llm_budgeted(
        omitted,
        llm,
        instruction,
        cancel,
        config.max_attempts,
        effective_max_tokens,
    )
    .await?;
    let summary = post_process_summary(summary, todos);
    let compacted = apply_compaction_with_summary(messages, count, summary.clone());
    let tokens_after = estimate_messages_tokens(&compacted);
    Ok((
        compacted,
        CompactionReport {
            summary,
            compacted_count: count,
            tokens_before,
            tokens_after,
        },
    ))
}

/// Manual compaction (`POST :compact`) with a real LLM summary.
///
/// Like [`force_compact_messages_manual`] but the compacted prefix is
/// replaced by the LLM-written summary (honoring the caller's `instruction`).
/// The raw summary rides back next to the compacted history (the split
/// [`force_compact_messages_with_summary_report`] makes): the summary message
/// inside the history carries the `COMPACTION_SUMMARY_PREFIX` preamble, which
/// is not what a host-facing report should show. `effective_max_tokens` (the
/// model's effective window) pre-shrinks the summarizer's first request the
/// same way the automatic paths do (v2 #3911). `todos` follows
/// [`force_compact_messages_with_summary_report`]: the rendered list v2's
/// `postProcessSummary` appends to the summary, `None` for no suffix.
pub async fn force_compact_messages_manual_with_summary(
    messages: &[LLMMessage],
    config: &CompactionConfig,
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
    effective_max_tokens: Option<u32>,
    todos: Option<String>,
) -> Result<(Vec<LLMMessage>, String), CompactionError> {
    let count = compute_compact_count_manual(messages, config);
    if count == 0 {
        return Ok((messages.to_vec(), String::new()));
    }
    let omitted = &messages[1..count as usize];
    let summary = summarize_with_llm_budgeted(
        omitted,
        llm,
        instruction,
        cancel,
        config.max_attempts,
        effective_max_tokens,
    )
    .await?;
    let summary = post_process_summary(summary, todos);
    let compacted = apply_compaction_with_summary(messages, count, summary.clone());
    Ok((compacted, summary))
}

/// Threshold-gated compaction with a real LLM summary.
///
/// Like [`compact_messages`] but uses [`force_compact_messages_with_summary`]
/// when the trigger fires. Returns `None` when the trigger did not fire, so
/// the common no-compaction path allocates nothing instead of cloning the
/// whole history.
pub async fn compact_messages_with_summary(
    messages: &[LLMMessage],
    config: &CompactionConfig,
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> Result<Option<Vec<LLMMessage>>, CompactionError> {
    compact_messages_with_summary_at(
        messages,
        estimate_messages_tokens(messages),
        config,
        llm,
        instruction,
        cancel,
    )
    .await
}

/// [`compact_messages_with_summary`] with a caller-supplied token estimate, so
/// an incremental estimator can pass the running total instead of forcing a
/// full rescan here.
pub async fn compact_messages_with_summary_at(
    messages: &[LLMMessage],
    used_tokens: u32,
    config: &CompactionConfig,
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> Result<Option<Vec<LLMMessage>>, CompactionError> {
    Ok(compact_messages_with_summary_at_report(
        messages,
        used_tokens,
        config,
        llm,
        instruction,
        cancel,
        None,
        None,
    )
    .await?
    .map(|(messages, _)| messages))
}

/// [`compact_messages_with_summary_at`] that also returns the report, so the
/// turn loop can emit `compaction.completed` with the summary and token counts.
/// `effective_max_tokens` (the model's effective window) pre-shrinks the
/// summarizer's first request to fit it (v2 #3911); pass `None` when the
/// caller does not know the window.
#[allow(clippy::too_many_arguments)]
pub async fn compact_messages_with_summary_at_report(
    messages: &[LLMMessage],
    used_tokens: u32,
    config: &CompactionConfig,
    llm: &dyn LLM,
    instruction: Option<&str>,
    cancel: Option<&CancellationToken>,
    effective_max_tokens: Option<u32>,
    todos: Option<String>,
) -> Result<Option<(Vec<LLMMessage>, CompactionReport)>, CompactionError> {
    if !should_compact(used_tokens, config) {
        return Ok(None);
    }
    Ok(Some(
        force_compact_messages_with_summary_report(
            messages,
            config,
            llm,
            instruction,
            cancel,
            effective_max_tokens,
            used_tokens,
            todos,
        )
        .await?,
    ))
}

/// Project `count` leading messages into a summary, keeping the system
/// message (index 0) and the tail untouched. Like [`apply_compaction`] but
/// uses the provided `summary` text instead of [`summary_placeholder`].
pub(crate) fn apply_compaction_with_summary(
    messages: &[LLMMessage],
    count: u32,
    summary: String,
) -> Vec<LLMMessage> {
    if count == 0 {
        return messages.to_vec();
    }
    // v2 `buildContextCompactionShape`: the compacted range's real user input
    // survives verbatim — head (2k tokens) + elision note + tail (20k tokens)
    // — then the prefixed summary and the continuation note close the block.
    // The system message (index 0) and the uncompacted tail are untouched.
    let user_in_range: Vec<LLMMessage> = messages[1..count as usize]
        .iter()
        .filter(|m| m.role == "user")
        .cloned()
        .collect();
    let kept = select_kept_user_messages(&user_in_range);
    let summary_text = format!(
        "{COMPACTION_SUMMARY_PREFIX}
{}",
        summary.trim()
    );
    let mut compacted = Vec::with_capacity(1 + kept.len() + 2 + (messages.len() - count as usize));
    compacted.push(messages[0].clone());
    compacted.extend(kept);
    compacted.push(LLMMessage {
        role: "user".into(),
        content: summary_text,
        ..Default::default()
    });
    compacted.push(compaction_continuation_message());
    compacted.extend_from_slice(&messages[count as usize..]);
    compacted
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
    use crate::rpc::types::BoxFuture;
    use crate::rpc::types::TokenUsage;
    use crate::turn_loop::types::{ContentBlock, LLM, LLMChatParams, LLMChatResponse, ToolCall};

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
            extras: None,
        }
    }

    fn small_config(max_context_tokens: u32) -> CompactionConfig {
        CompactionConfig {
            max_context_tokens,
            ..Default::default()
        }
    }

    /// The pre-shrink is what keeps a small-window model from burning its
    /// whole retry budget: without it the summarizer's first request carries the
    /// entire omitted history, overflows, and only then starts dropping one
    /// message per attempt (v2 #3911).
    #[test]
    fn pre_shrink_keeps_the_newest_messages_that_fit_the_window() {
        // 4000 chars ≈ 1000 tokens per message under the module's 4:1 estimate,
        // so the ten-message history below is ≈ 10 000 tokens.
        let history: Vec<LLMMessage> = (0..10)
            .map(|index| msg("user", &format!("{index}").repeat(4000)))
            .collect();

        // A generous window: everything fits, so nothing is shrunk.
        assert!(
            pre_shrink_to_window_budget(&history, None, Some(1_000_000)).is_none(),
            "a history that fits must be sent whole"
        );
        // No window known: no shrink either.
        assert!(pre_shrink_to_window_budget(&history, None, None).is_none());
        // 20 000 leaves a ≈ 13 875 budget, which still takes all ten.
        assert!(pre_shrink_to_window_budget(&history, None, Some(20_000)).is_none());

        // 12 000 leaves a ≈ 7 925 budget — about seven of the ten messages.
        let shrunken = pre_shrink_to_window_budget(&history, None, Some(12_000))
            .expect("a tight window shrinks");
        assert!(
            !shrunken.is_empty() && shrunken.len() < history.len(),
            "expected a proper subset, got {} of {}",
            shrunken.len(),
            history.len()
        );
        // The tail is what survives — the shrink must not drop the newest turn.
        assert_eq!(
            shrunken.last().map(|message| message.content.clone()),
            history.last().map(|message| message.content.clone())
        );
    }

    /// A shrunk history must not start with a tool result: a result without its
    /// call is not a sequence a provider accepts (v2 `dropLeadingToolResults`).
    #[test]
    fn pre_shrink_drops_leading_tool_results() {
        // Four ≈ 1000-token messages against a ≈ 7 925 budget: everything fits,
        // so force the shrink by growing the history instead.
        let mut history = vec![
            msg("assistant", &"a".repeat(4000)),
            msg("tool", &"b".repeat(4000)),
            msg("user", &"c".repeat(4000)),
            msg("user", &"d".repeat(4000)),
        ];
        // Push the total past the budget so the shrink runs and the surviving
        // slice is forced to begin at the `tool` entry.
        for index in 0..8 {
            history.insert(0, msg("user", &format!("filler{index}").repeat(2000)));
        }
        let shrunken = pre_shrink_to_window_budget(&history, None, Some(12_000)).expect("shrinks");
        assert_ne!(
            shrunken.first().map(|message| message.role.as_str()),
            Some("tool"),
            "the shrink must not leave a dangling tool result at the front"
        );
    }

    /// v2's helper returns an empty slice when nothing fits, and the caller
    /// reads that as "send what you had" — never an empty prompt, which would
    /// ask the model to summarize nothing.
    #[test]
    fn pre_shrink_falls_back_to_the_full_history_when_nothing_fits() {
        let history = vec![msg("user", &"x".repeat(400_000))];
        assert!(
            pre_shrink_to_window_budget(&history, None, Some(4_000)).is_none(),
            "a single message larger than the budget must fall back to the whole history"
        );
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
            assert_eq!(
                act.tool_calls.len(),
                exp.tool_calls.len(),
                "tool_calls count mismatch at index {i}"
            );
            for (tc_idx, (tc_act, tc_exp)) in
                act.tool_calls.iter().zip(exp.tool_calls.iter()).enumerate()
            {
                assert_eq!(
                    tc_act.id, tc_exp.id,
                    "tool_call id mismatch at msg {i} tc {tc_idx}"
                );
                assert_eq!(
                    tc_act.name, tc_exp.name,
                    "tool_call name mismatch at msg {i} tc {tc_idx}"
                );
                assert_eq!(
                    tc_act.arguments, tc_exp.arguments,
                    "tool_call args mismatch at msg {i} tc {tc_idx}"
                );
            }
            assert_eq!(
                act.tool_call_id, exp.tool_call_id,
                "tool_call_id mismatch at index {i}"
            );
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
        assert_eq!(
            config_for_window(Some(u32::MAX)).max_context_tokens,
            u32::MAX
        );
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
            details_index: None,
            reasoning_key: None,
            details_summary: None,
        });
        assert_eq!(estimate_message_tokens(&m_think), 4);

        // Multimodal media blocks: all count MEDIA_TOKEN_ESTIMATE (2000)
        let mut m_img = msg("user", "");
        m_img.blocks.push(ContentBlock::Image {
            media_type: "image/png".into(),
            data: "base64data".into(),
            name: None,
        });
        assert_eq!(estimate_message_tokens(&m_img), MEDIA_TOKEN_ESTIMATE);

        let mut m_img_url = msg("user", "");
        m_img_url.blocks.push(ContentBlock::ImageUrl {
            url: "http://example.com/pic.png".into(),
            id: None,
            name: None,
        });
        assert_eq!(estimate_message_tokens(&m_img_url), MEDIA_TOKEN_ESTIMATE);

        let mut m_audio = msg("user", "");
        m_audio.blocks.push(ContentBlock::AudioUrl {
            url: "http://example.com/audio.mp3".into(),
            id: Some("a1".into()),
            name: None,
        });
        assert_eq!(estimate_message_tokens(&m_audio), MEDIA_TOKEN_ESTIMATE);

        let mut m_video = msg("user", "");
        m_video.blocks.push(ContentBlock::VideoUrl {
            url: "http://example.com/video.mp4".into(),
            id: None,
            name: None,
        });
        assert_eq!(estimate_message_tokens(&m_video), MEDIA_TOKEN_ESTIMATE);

        // Additive combination: content + text block + think block + image block
        let mut m_combo = msg("user", "abcd"); // 1 token
        m_combo.blocks.push(ContentBlock::Text {
            text: "efgh".into(),
        }); // 1 token
        m_combo.blocks.push(ContentBlock::Think {
            think: "ijkl".into(), // 1 token
            encrypted: None,
            details_index: None,
            reasoning_key: None,
            details_summary: None,
        });
        m_combo.blocks.push(ContentBlock::ImageUrl {
            url: "http://example.com/img.jpg".into(), // 2000 tokens
            id: None,
            name: None,
        });
        assert_eq!(estimate_message_tokens(&m_combo), 1 + 1 + 1 + 2000);
    }

    #[test]
    fn test_estimate_message_tokens_tool_calls_and_results_exact() {
        let mut m = msg("assistant", "hello world!"); // 12 chars -> 3 tokens
        // tool_call 1: name "read" (4 chars -> 1 token), args {"path":"/a.txt"} (17 chars -> 5 tokens -> ceil(5*1.3) = 7 tokens)
        // Subtotal = 1 + 7 = 8 tokens.
        m.tool_calls.push(tool_call(
            "tc1",
            "read",
            serde_json::json!({ "path": "/a.txt" }),
        ));
        assert_eq!(estimate_message_tokens(&m), 3 + 8);

        // tool_call 2: name "bash" (4 chars -> 1 token), args {"cmd":"ls"} (10 chars -> 3 tokens -> ceil(3*1.3) = 4 tokens)
        // Subtotal = 1 + 4 = 5 tokens.
        m.tool_calls
            .push(tool_call("tc2", "bash", serde_json::json!({ "cmd": "ls" })));
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
        let zero_cfg = CompactionConfig {
            max_context_tokens: 0,
            ..Default::default()
        };
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
            trigger_ratio: 0.90,           // 90,000 threshold
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
    fn test_should_compact_auto_stays_silent_when_the_split_search_finds_nowhere_to_cut() {
        let config = CompactionConfig {
            max_context_tokens: 1_000,
            trigger_ratio: 0.01,
            reserved_context_size: 0,
            max_recent_messages: 4,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.5,
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
        };

        // The shape a previous compaction leaves behind: the kept user input,
        // the elision note, the summary and the continuation are all user
        // messages, and `can_split_after` refuses to cut after a user message.
        // The only split left is after the system prompt, which floors to 0 —
        // so crossing the threshold alone must not get the turn loop to
        // announce a compaction that folds nothing.
        let compacted_head = vec![
            msg("system", "system-prompt"),
            msg("user", "kept user input"),
            msg("user", "[messages omitted during compaction]"),
            msg("user", "[summary of the compacted conversation]"),
            msg("user", "[context compaction is complete]"),
        ];
        assert_eq!(compute_compact_count(&compacted_head, &config), 0);
        let used = estimate_messages_tokens(&compacted_head);
        assert!(
            should_compact(used, &config),
            "the threshold itself must be crossed, so only the split search can veto"
        );
        assert!(!should_compact_auto(&compacted_head, used, &config));

        // The same threshold with a real split point still runs.
        let splittable = vec![
            msg("system", "system-prompt"),
            msg("user", "user-1"),
            msg("assistant", "assistant-1"),
            msg("user", "user-2"),
            msg("assistant", "assistant-2"),
            msg("user", "user-3"),
            msg("assistant", "assistant-3"),
            msg("user", "user-4"),
        ];
        assert!(compute_compact_count(&splittable, &config) > 0);
        assert!(should_compact_auto(&splittable, used, &config));

        // Under the threshold it stays out of the way either way.
        assert!(!should_compact_auto(&splittable, 0, &config));
        assert!(!should_compact_auto(&compacted_head, 0, &config));
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
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
        };

        let count = compute_compact_count(&messages, &config);
        assert_eq!(
            count, 5,
            "compacts messages 0..5 (system + 4 conversation messages)"
        );

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
        assert!(!should_compact(
            estimate_messages_tokens(&messages),
            &config
        ));
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
        assert_eq!(
            compacted[1].content,
            summary_placeholder(count as usize - 1)
        );
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
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
        };
        let count_a = compute_compact_count(&messages, &config_a);
        assert_eq!(
            count_a, 7,
            "compacts up to index 7 (sys + u1 + a1 + u2 + a2 + r1 + r2)"
        );
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
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
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
        a.tool_calls
            .push(tool_call("t1", "read", serde_json::json!({})));
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
        assert!(
            !can_split_after(&msgs, 1),
            "cannot split after partial tool exchange"
        );

        // 6. Resolved tool exchange in prefix: 2 calls and 2 results
        let mut a = msg("assistant", "a");
        a.tool_calls = vec![
            tool_call("t1", "read", serde_json::json!({})),
            tool_call("t2", "write", serde_json::json!({})),
        ];
        let msgs = vec![a, msg("tool", "r1"), msg("tool", "r2"), msg("user", "u")];
        assert!(
            can_split_after(&msgs, 2),
            "safe to split after fully satisfied tool exchange"
        );

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
        assert!(!prefix_ends_with_open_tool_exchange(
            &[msg("assistant", "a")],
            0
        ));
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
        let msgs = vec![a_first, msg("tool", "r1"), a_second, msg("tool", "r2")];
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
            msg("system", "s000"),    // 1 token
            msg("user", "u001"),      // 1 token
            msg("assistant", "a002"), // 1 token (can split after index 2)
            msg("user", "u003"),      // 1 token
            msg("assistant", "a004"), // 1 token (can split after index 4)
            msg("user", "u005"),      // 1 token
            msg("assistant", "a006"), // 1 token (can split after index 6)
            msg("user", "u007"),      // 1 token
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
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
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
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
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
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
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

    /// v2 `observeContextOverflow` / `getEffectiveMaxContextTokens`: an
    /// observed overflow lowers the model's effective window to
    /// `floor(estimated × 0.85)`, never raises it, and the configured value
    /// wins when nothing was observed. The cache is process-global, so each
    /// test uses its own model name.
    #[test]
    fn test_observe_context_overflow_lowers_and_never_raises() {
        let model = "test-observe-lower";
        assert_eq!(effective_max_tokens(model, Some(10_000)), Some(10_000));

        observe_context_overflow(model, 1_000, Some(10_000));
        assert_eq!(effective_max_tokens(model, Some(10_000)), Some(850));

        // A later, larger observation never raises the floor.
        observe_context_overflow(model, 5_000, Some(10_000));
        assert_eq!(effective_max_tokens(model, Some(10_000)), Some(850));

        // A smaller one lowers further.
        observe_context_overflow(model, 500, Some(10_000));
        assert_eq!(effective_max_tokens(model, Some(10_000)), Some(425));
    }

    #[test]
    fn test_effective_max_tokens_without_a_configured_window() {
        let model = "test-observe-no-config";
        assert_eq!(effective_max_tokens(model, None), None);

        // A lone observation stands when the host resolved no window.
        observe_context_overflow(model, 2_000, None);
        assert_eq!(effective_max_tokens(model, None), Some(1_700));

        // The floor is at least one token.
        let tiny = "test-observe-tiny";
        observe_context_overflow(tiny, 1, None);
        assert_eq!(effective_max_tokens(tiny, None), Some(1));
    }

    #[test]
    fn test_observe_context_overflow_ignores_empty_marks() {
        let model = "test-observe-empty";
        observe_context_overflow("", 1_000, Some(10_000));
        observe_context_overflow(model, 0, Some(10_000));
        assert_eq!(effective_max_tokens(model, Some(10_000)), Some(10_000));
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

    /// v2 gates the wording table on the status code
    /// (`isContextOverflowStatusError`): only 400/413/422 may be read as an
    /// overflow, and an error carrying no status is classified on its own
    /// terms — the in-stream provider-error path.
    #[test]
    fn test_context_overflow_wording_is_status_gated() {
        for status in [400, 413, 422] {
            assert!(
                is_context_overflow_error(&format!(
                    "llm http status {status} Too Many Requests: context_length_exceeded"
                )),
                "a {status} that names the overflow must be detected"
            );
        }
        // The wording is there, but the status says this is a server fault.
        assert!(!is_context_overflow_error(
            "llm http status 500 Internal Server Error: max_tokens rejected by backend"
        ));
        assert!(!is_context_overflow_error(
            "llm http status 401 Unauthorized: prompt is too long for this plan"
        ));
        // No status at all: the in-stream `context_length_exceeded` code path.
        assert!(is_context_overflow_error(
            "llm provider stream error: context_length_exceeded"
        ));
    }

    /// A 413 with an opaque body is still an overflow when the request had
    /// already filled half the window — v2's size-based branch, which is what
    /// covers gateways that never echo the wording.
    #[test]
    fn test_bare_413_recovers_only_near_the_window() {
        let opaque = "llm http status 413 Payload Too Large: <html>nginx</html>";
        assert!(should_recover_from_context_overflow(
            opaque,
            100_000,
            Some(200_000)
        ));
        // Half the window exactly: v2's `>=` on the ratio.
        assert!(should_recover_from_context_overflow(
            opaque,
            100_000,
            Some(200_000)
        ));
        // One token under the ratio: a proxy rejecting a small request.
        assert!(!should_recover_from_context_overflow(
            opaque,
            99_999,
            Some(200_000)
        ));
        // Nothing to compare against, or a nonsensical window.
        assert!(!should_recover_from_context_overflow(opaque, 100_000, None));
        assert!(!should_recover_from_context_overflow(
            opaque,
            100_000,
            Some(0)
        ));
    }

    /// The three shapes that used to slip through: a gateway 413, a proxy 413
    /// and a bare status line, none of which name the overflow.
    #[test]
    fn test_opaque_413_shapes_recover_near_the_window() {
        for err in [
            "llm http status 413 Payload Too Large: <html><body>413</body></html>",
            "llm http status 413 Request Entity Too Large: proxy refused the request",
            "llm http status 413: ",
        ] {
            assert!(
                !is_context_overflow_error(err),
                "none of these name the overflow: {err}"
            );
            assert!(
                should_recover_from_context_overflow(err, 190_000, Some(200_000)),
                "a full window behind an opaque 413 must still recover: {err}"
            );
            assert!(
                !should_recover_from_context_overflow(err, 1_000, Some(200_000)),
                "a small request behind a 413 is a proxy limit, not an overflow: {err}"
            );
        }
    }

    /// The size gate is specific to 413: other statuses recover on wording
    /// alone, and never on size.
    #[test]
    fn test_overflow_recovery_ignores_size_for_non_413_statuses() {
        assert!(should_recover_from_context_overflow(
            "llm http status 400 Bad Request: context length exceeded",
            1,
            Some(200_000)
        ));
        assert!(!should_recover_from_context_overflow(
            "llm http status 500 Internal Server Error: backend exploded",
            199_999,
            Some(200_000)
        ));
        // A 429 near the window is a rate limit, not an overflow.
        assert!(!should_recover_from_context_overflow(
            "llm http status 429 Too Many Requests: slow down",
            199_999,
            Some(200_000)
        ));
    }

    /// The recovery decision is the wording test plus the size branch — it must
    /// not lose a case the wording test already accepts.
    #[test]
    fn test_overflow_recovery_supersedes_the_wording_test() {
        for err in [
            "context_length_exceeded",
            "model error: context length reached",
            "request payload exceeds the maximum size allowed",
            "llm http status 400: context_length_exceeded",
        ] {
            assert!(is_context_overflow_error(err));
            assert!(should_recover_from_context_overflow(err, 0, None));
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

    /// Manual compaction walks the history from the tail and takes the
    /// deepest safe split, so it compacts strictly more than the auto window
    /// (v2 `computeCompactCount(..., 'manual')`, strategy.ts:182-189).
    #[test]
    fn test_manual_compaction_scans_deeper_than_auto() {
        let config = small_config(100_000);
        let mut messages = vec![msg("system", "sys")];
        for i in 0..20 {
            messages.push(msg("user", &format!("u{i}")));
            messages.push(msg("assistant", &format!("a{i}")));
        }

        let auto = compute_compact_count(&messages, &config);
        let manual = compute_compact_count_manual(&messages, &config);
        assert!(
            manual > auto,
            "manual {manual} must compact deeper than auto {auto}"
        );
        // The deepest safe split sits after the final assistant message, so a
        // manual compaction keeps only the system prompt plus the summary —
        // the manual branch probes `messages.length - 1`, unlike the auto
        // window (v2 strategy.ts:182-189 does the same).
        assert_eq!(manual as usize, messages.len());

        let manual_compacted = force_compact_messages_manual(&messages, &config);
        assert_eq!(manual_compacted.len(), 2);
        assert_eq!(manual_compacted[0].role, "system");
        assert_eq!(
            manual_compacted[1].content,
            summary_placeholder(messages.len() - 1)
        );
        assert!(force_compact_messages(&messages, &config).len() > manual_compacted.len());
    }

    // ── LLM summarizer tests ──────────────────────────────────────────────

    /// Mock summarizer. The first `fail_times` calls fail; `retryable`
    /// decides whether the engine may retry them. `calls` counts every call.
    struct SummarizerMockLlm {
        content: String,
        fail_times: u32,
        retryable: bool,
        fail_message: String,
        calls: std::sync::atomic::AtomicU32,
        last_user_content: std::sync::Mutex<Option<String>>,
    }

    impl SummarizerMockLlm {
        /// Every call succeeds with `content`.
        fn ok(content: &str) -> Self {
            Self {
                content: content.into(),
                fail_times: 0,
                retryable: false,
                fail_message: "summarizer unavailable".into(),
                calls: std::sync::atomic::AtomicU32::new(0),
                last_user_content: std::sync::Mutex::new(None),
            }
        }

        /// Every call fails with a non-retryable error.
        fn error() -> Self {
            Self {
                content: String::new(),
                fail_times: u32::MAX,
                retryable: false,
                fail_message: "summarizer unavailable".into(),
                calls: std::sync::atomic::AtomicU32::new(0),
                last_user_content: std::sync::Mutex::new(None),
            }
        }

        /// The first `fail_times` calls fail with a retryable error, then
        /// calls succeed with `content`.
        fn transient(content: &str, fail_times: u32) -> Self {
            Self {
                content: content.into(),
                fail_times,
                retryable: true,
                fail_message: "summarizer unavailable".into(),
                calls: std::sync::atomic::AtomicU32::new(0),
                last_user_content: std::sync::Mutex::new(None),
            }
        }

        /// The first `fail_times` calls fail with a context-overflow error
        /// (the shape the compaction-overflow shrink recovers from), then
        /// calls succeed with `content`.
        fn overflow_then_ok(content: &str, fail_times: u32) -> Self {
            Self {
                content: content.into(),
                fail_times,
                retryable: false,
                fail_message: "llm http status 400 Bad Request: context_length_exceeded".into(),
                calls: std::sync::atomic::AtomicU32::new(0),
                last_user_content: std::sync::Mutex::new(None),
            }
        }

        /// Every call fails with a context-overflow error.
        fn overflow_always() -> Self {
            Self::overflow_then_ok("", u32::MAX)
        }

        fn call_count(&self) -> u32 {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }

        /// The user-role prompt of the most recent call (instruction +
        /// transcript), for asserting what the summarizer was asked.
        fn last_user_content(&self) -> String {
            self.last_user_content
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or_default()
        }
    }

    impl LLM for SummarizerMockLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "test-summarizer"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            self.retryable
        }
        fn chat(
            &self,
            params: LLMChatParams,
        ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let content = self.content.clone();
            let fail_message = self.fail_message.clone();
            let attempt = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let fails = attempt <= self.fail_times;
            let user_content = params
                .messages
                .iter()
                .rev()
                .find(|m| m.role == "user")
                .map(|m| m.content.clone());
            *self
                .last_user_content
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = user_content;
            Box::pin(async move {
                if fails {
                    Err(fail_message.into())
                } else {
                    Ok(LLMChatResponse {
                        content,
                        thinking: vec![],
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage::default(),
                        timing: None,
                    })
                }
            })
        }
    }

    fn compactable_messages() -> Vec<LLMMessage> {
        vec![
            msg("system", "system-prompt"),
            msg("user", "user-1"),
            msg("assistant", "assistant-1"),
            msg("user", "user-2"),
            msg("assistant", "assistant-2"),
            msg("user", "user-3"),
            msg("assistant", "assistant-3"),
            msg("user", "user-4"),
        ]
    }

    fn compacting_config() -> CompactionConfig {
        CompactionConfig {
            max_context_tokens: 1000,
            trigger_ratio: 0.01,
            reserved_context_size: 0,
            max_recent_messages: 4,
            max_recent_user_messages: u32::MAX,
            max_recent_size_ratio: 0.5,
            max_attempts: None,
            max_overflow_compaction_attempts: DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
        }
    }

    #[tokio::test]
    async fn test_summarize_with_llm_returns_summary_on_success() {
        let omitted = vec![
            msg("user", "user-1"),
            msg("assistant", "assistant-1"),
            msg("user", "user-2"),
        ];
        let llm = SummarizerMockLlm::ok("  Summary of earlier conversation.  ");
        let result = summarize_with_llm(&omitted, &llm, None, None, None).await;
        assert_eq!(result.unwrap(), "Summary of earlier conversation.");
    }

    #[tokio::test]
    async fn test_summarize_with_llm_returns_error_on_empty_content() {
        let omitted = vec![msg("user", "user-1"), msg("assistant", "assistant-1")];
        let llm = SummarizerMockLlm::ok("");
        let result = summarize_with_llm(&omitted, &llm, None, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_summarize_with_llm_returns_error_on_error() {
        let omitted = vec![msg("user", "user-1"), msg("assistant", "assistant-1")];
        let llm = SummarizerMockLlm::error();
        let result = summarize_with_llm(&omitted, &llm, None, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_summarization_prompt_includes_instruction_and_transcript() {
        let omitted = vec![msg("user", "hello"), msg("assistant", "hi there")];
        let prompt = summarization_prompt(&omitted, Some("Custom instruction."));
        assert_eq!(prompt.len(), 2);
        assert_eq!(prompt[0].role, "system");
        assert_eq!(prompt[1].role, "user");
        assert!(
            prompt[1].content.contains("Custom instruction."),
            "user message must contain the custom instruction"
        );
        assert!(
            prompt[1].content.contains("user: hello"),
            "user message must contain the transcript"
        );
        assert!(
            prompt[1].content.contains("assistant: hi there"),
            "user message must contain the transcript"
        );
    }

    #[tokio::test]
    async fn test_summarization_prompt_uses_the_v2_handoff_template_when_none() {
        let omitted = vec![msg("user", "hello")];
        let prompt = summarization_prompt(&omitted, None);
        assert_eq!(prompt.len(), 2);
        assert_eq!(
            prompt[1].content,
            format!("user: hello\n\n{}", render_compaction_instruction(None)),
            "the transcript is followed by the rendered v2 template"
        );
        assert!(
            !prompt[1].content.contains("${custom_instruction_block}"),
            "the template placeholder must be filled, never sent verbatim"
        );
        // The two demands the retired one-liner omitted and the observed
        // summaries then omitted too: exact history, and a forward plan.
        assert!(
            prompt[1].content.contains("the exact file paths touched")
                && prompt[1].content.contains("The forward plan"),
            "the v2 handoff template must ship in full"
        );
    }

    #[tokio::test]
    async fn test_a_caller_instruction_lands_inside_the_template() {
        let omitted = vec![msg("user", "hello")];
        let prompt = summarization_prompt(&omitted, Some("Custom instruction."));
        let rendered = render_compaction_instruction(Some("Custom instruction."));
        assert_eq!(prompt[1].content, format!("user: hello\n\n{rendered}"));
        assert!(
            rendered.contains("Optional user instruction:\nCustom instruction."),
            "v2 appends the caller's instruction inside the template"
        );
        assert!(
            rendered.contains("The forward plan"),
            "a caller instruction must not replace the template"
        );
        // A blank instruction is v2's `custom.length > 0` guard: no empty block.
        assert_eq!(
            render_compaction_instruction(Some("   ")),
            render_compaction_instruction(None)
        );
    }

    #[tokio::test]
    async fn test_summarization_prompt_serializes_tool_calls() {
        let mut m = msg("assistant", "running tools");
        m.tool_calls
            .push(tool_call("t1", "read", serde_json::json!({ "path": "/a" })));
        let omitted = vec![m];
        let prompt = summarization_prompt(&omitted, None);
        assert!(
            prompt[1].content.contains("[tool_call: read("),
            "tool calls must be serialized in the transcript"
        );
    }

    /// v2 `postProcessSummary`: no todos means the summary passes through
    /// untouched (v2 returns it untrimmed); with todos it is trimmed and the
    /// rendered list rides after exactly one blank line.
    #[test]
    fn test_post_process_summary_appends_todo_list() {
        let raw = "  The earlier work, padded.  ".to_string();
        assert_eq!(
            post_process_summary(raw.clone(), None),
            "  The earlier work, padded.  "
        );
        assert_eq!(
            post_process_summary(raw, Some("## TODO List\n  [in_progress] t1: ship".into())),
            "The earlier work, padded.\n\n## TODO List\n  [in_progress] t1: ship"
        );
    }

    #[tokio::test]
    async fn test_force_compact_with_summary_uses_llm_summary() {
        let messages = compactable_messages();
        let config = compacting_config();
        let llm = SummarizerMockLlm::ok("LLM summary of the conversation.");
        let compacted = force_compact_messages_with_summary(&messages, &config, &llm, None, None)
            .await
            .unwrap();
        assert_eq!(compacted[0].role, "system");
        assert_eq!(compacted[0].content, "system-prompt");
        let summary_message = compacted
            .iter()
            .find(|m| m.content.contains(COMPACTION_SUMMARY_PREFIX))
            .expect("the prefixed summary must be present");
        assert!(
            summary_message
                .content
                .ends_with("LLM summary of the conversation.")
        );
        assert!(
            compacted
                .iter()
                .any(|m| m.content.contains(COMPACTION_CONTINUATION_TEXT)),
            "the continuation note must be present after the summary"
        );
    }

    #[tokio::test]
    async fn test_force_compact_with_summary_returns_error_on_empty_content() {
        let messages = compactable_messages();
        let config = compacting_config();
        let llm = SummarizerMockLlm::ok("");
        let compacted =
            force_compact_messages_with_summary(&messages, &config, &llm, None, None).await;
        assert!(compacted.is_err());
    }

    #[tokio::test]
    async fn test_force_compact_with_summary_returns_error_on_error() {
        let messages = compactable_messages();
        let config = compacting_config();
        let llm = SummarizerMockLlm::error();
        let compacted =
            force_compact_messages_with_summary(&messages, &config, &llm, None, None).await;
        assert!(compacted.is_err());
    }

    #[tokio::test]
    async fn test_force_compact_with_summary_no_compaction_returns_unchanged() {
        let messages = vec![msg("system", "sys"), msg("user", "hi")];
        let config = compacting_config();
        let llm = SummarizerMockLlm::ok("unused");
        let compacted = force_compact_messages_with_summary(&messages, &config, &llm, None, None)
            .await
            .unwrap();
        assert_messages_eq(&compacted, &messages);
    }

    #[tokio::test]
    async fn test_compact_with_summary_skips_when_below_threshold() {
        let messages = compactable_messages();
        let config = small_config(100_000);
        let llm = SummarizerMockLlm::ok("unused");
        let compacted = compact_messages_with_summary(&messages, &config, &llm, None, None)
            .await
            .unwrap();
        assert!(compacted.is_none(), "below threshold must be a no-op");
    }

    #[tokio::test]
    async fn test_compact_with_summary_triggers_when_above_threshold() {
        let messages = compactable_messages();
        let config = compacting_config();
        let llm = SummarizerMockLlm::ok("Real summary.");
        let compacted = compact_messages_with_summary(&messages, &config, &llm, None, None)
            .await
            .unwrap()
            .expect("above threshold must compact");
        let summary_message = compacted
            .iter()
            .find(|m| m.content.contains(COMPACTION_SUMMARY_PREFIX))
            .expect("the prefixed summary must be present");
        assert!(summary_message.content.ends_with("Real summary."));
    }

    #[tokio::test]
    async fn test_compact_with_summary_passes_instruction_to_summarizer() {
        let messages = compactable_messages();
        let config = compacting_config();
        let llm = SummarizerMockLlm::ok("Instruction-aware summary.");
        let compacted = compact_messages_with_summary(
            &messages,
            &config,
            &llm,
            Some("Focus on user goals."),
            None,
        )
        .await
        .unwrap()
        .expect("above threshold must compact");
        let summary_message = compacted
            .iter()
            .find(|m| m.content.contains(COMPACTION_SUMMARY_PREFIX))
            .expect("the prefixed summary must be present");
        assert!(
            summary_message
                .content
                .ends_with("Instruction-aware summary.")
        );
        assert!(
            llm.last_user_content().contains("Focus on user goals."),
            "the custom instruction must ride into the summarizer prompt, got: {}",
            llm.last_user_content()
        );
    }

    #[tokio::test]
    async fn test_manual_compaction_with_summary_uses_deepest_split() {
        let messages = compactable_messages();
        let config = compacting_config();
        let llm = SummarizerMockLlm::ok("Manual summary.");
        let (compacted, raw_summary) = force_compact_messages_manual_with_summary(
            &messages, &config, &llm, None, None, None, None,
        )
        .await
        .unwrap();
        assert_eq!(raw_summary, "Manual summary.");
        let count = compute_compact_count_manual(&messages, &config);
        assert!(count >= 2, "manual compaction must remove messages");
        assert_eq!(compacted[0].role, "system");
        assert_eq!(compacted[0].content, "system-prompt");
        let summary_message = compacted
            .iter()
            .find(|m| m.content.contains(COMPACTION_SUMMARY_PREFIX))
            .expect("the prefixed summary must be present");
        assert!(summary_message.content.ends_with("Manual summary."));
        assert!(
            compacted.len()
                < force_compact_messages_with_summary(&messages, &config, &llm, None, None)
                    .await
                    .unwrap()
                    .len(),
            "manual compaction must keep a smaller tail than auto compaction"
        );
    }

    #[tokio::test]
    async fn test_manual_compaction_with_summary_guards_against_header_only_count() {
        // A window smaller than the header lets the fit loop shrink the split
        // to index 1 — compacting "only the header" must be a no-op, never an
        // inserted summary with nothing removed.
        let messages = vec![
            msg("system", &"s".repeat(100)),
            msg("user", "user-1"),
            msg("assistant", "assistant-1"),
        ];
        let config = CompactionConfig {
            max_context_tokens: 10,
            ..CompactionConfig::default()
        };
        assert_eq!(compute_compact_count_manual(&messages, &config), 0);
        let llm = SummarizerMockLlm::ok("unused");
        let (compacted, raw_summary) = force_compact_messages_manual_with_summary(
            &messages, &config, &llm, None, None, None, None,
        )
        .await
        .unwrap();
        assert_eq!(raw_summary, "");
        assert_messages_eq(&compacted, &messages);
        assert_eq!(
            llm.call_count(),
            0,
            "no summary call for a no-op compaction"
        );
    }

    #[tokio::test]
    async fn test_summarizer_retries_retryable_failure_then_succeeds() {
        let omitted = vec![msg("user", "user-1"), msg("assistant", "assistant-1")];
        let llm = SummarizerMockLlm::transient("Recovered summary.", 1);
        let result = summarize_with_llm(&omitted, &llm, None, None, None).await;
        assert_eq!(result.unwrap(), "Recovered summary.");
        assert_eq!(llm.call_count(), 2, "one retry after the transient failure");
    }

    /// v2's overflow recovery inside the compaction request
    /// (fullCompactionService.ts:690-710): when the summarization request
    /// itself overflows, the history is shrunk by the attempt's ratio and
    /// retried instead of failing the compaction.
    #[tokio::test]
    async fn test_summarizer_shrinks_history_after_overflow_and_retries() {
        let omitted = vec![
            msg("user", "user-1"),
            msg("assistant", "assistant-1"),
            msg("user", "user-2"),
            msg("assistant", "assistant-2"),
            msg("user", "user-3"),
        ];
        let llm = SummarizerMockLlm::overflow_then_ok("Recovered summary.", 1);
        let result = summarize_with_llm_budgeted(&omitted, &llm, None, None, None, None).await;
        assert_eq!(result.unwrap(), "Recovered summary.");
        assert_eq!(llm.call_count(), 2, "one shrink-retry after the overflow");
        let second_prompt = llm.last_user_content();
        assert!(
            !second_prompt.contains("user-1"),
            "the shrink must drop the oldest message: {second_prompt}"
        );
        assert!(
            second_prompt.contains("user-3"),
            "the newest messages must survive the shrink: {second_prompt}"
        );
    }

    /// The shrink is bounded: after `MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS`
    /// shrinks the original error surfaces instead of looping forever.
    #[tokio::test]
    async fn test_summarizer_gives_up_after_max_overflow_shrinks() {
        // Enough messages that the `len <= 1` guard does not preempt the
        // shrink bound: each shrink keeps a majority of the tail.
        let mut omitted = Vec::new();
        for i in 0..11 {
            omitted.push(msg(
                if i % 2 == 0 { "user" } else { "assistant" },
                &format!("m{i}"),
            ));
        }
        let llm = SummarizerMockLlm::overflow_always();
        // A generous attempt cap isolates the shrink bound as the stop reason.
        let result = summarize_with_llm_budgeted(&omitted, &llm, None, None, Some(10), None).await;
        assert!(
            matches!(result, Err(CompactionError::Provider(_))),
            "the original overflow error must surface"
        );
        assert_eq!(
            llm.call_count(),
            1 + MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS,
            "one initial request plus one per shrink attempt"
        );
    }

    /// v2 #3750: the host's `loopControl.compactionMaxAttempts` is a true cap
    /// on total requests, so a summarizer that never succeeds stops there
    /// instead of at the engine default.
    #[tokio::test]
    async fn test_summarizer_honors_the_configured_attempt_cap() {
        let omitted = vec![msg("user", "user-1"), msg("assistant", "assistant-1")];
        let llm = SummarizerMockLlm::transient("never reached", u32::MAX);
        let result = summarize_with_llm(&omitted, &llm, None, None, Some(2)).await;
        assert!(result.is_err());
        assert_eq!(
            llm.call_count(),
            2,
            "the configured cap bounds the requests"
        );
    }

    /// The cap rides `CompactionConfig`, so the wrappers the turn loop calls
    /// pass it through to the summarizer.
    #[tokio::test]
    async fn test_compaction_config_attempt_cap_reaches_the_summarizer() {
        let messages = compactable_messages();
        let config = CompactionConfig {
            max_attempts: Some(1),
            ..compacting_config()
        };
        let llm = SummarizerMockLlm::transient("never reached", u32::MAX);
        let compacted =
            force_compact_messages_with_summary(&messages, &config, &llm, None, None).await;
        assert_eq!(llm.call_count(), 1, "one request, then an error");
        assert!(compacted.is_err());
    }

    #[tokio::test]
    async fn test_summarizer_cancel_during_backoff_returns_error() {
        let omitted = vec![msg("user", "user-1"), msg("assistant", "assistant-1")];
        let llm = SummarizerMockLlm::transient("never reached", u32::MAX);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let started = std::time::Instant::now();
        let result = summarize_with_llm(&omitted, &llm, None, Some(&cancel), None).await;
        assert!(result.is_err());
        assert_eq!(llm.call_count(), 0, "cancel must not start a request");
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "cancel during backoff must return immediately, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn test_compaction_continuation_message_structure() {
        let msg = compaction_continuation_message();
        assert_eq!(msg.role, "user");
        assert!(msg.content.contains("Context compaction is complete"));
        assert!(msg.content.starts_with("<system-reminder>\n"));
        assert!(msg.content.ends_with("\n</system-reminder>"));
    }

    #[test]
    fn test_select_kept_user_messages_head_elision_tail_budget() {
        // v2 `selectCompactionUserMessages` (compactionHandoff.ts:234): above
        // the 20k budget the selection keeps at most the 2k head (ended by the
        // first truncating message) plus the 18k tail, with the elision note
        // between. 10 user messages x 3000 tokens = 30000 > 20000.
        let user_messages: Vec<LLMMessage> = (0..10)
            .map(|i| LLMMessage {
                role: "user".into(),
                content: format!("m{i:02}") + &"x".repeat(11_997), // 12000 chars = 3000 tokens
                ..Default::default()
            })
            .collect();
        assert_eq!(estimate_messages_tokens(&user_messages), 30_000);

        let kept = select_kept_user_messages(&user_messages);
        // [1 truncated head, elision, 6 full tail messages]
        assert_eq!(kept.len(), 8);
        let head_message = &kept[0];
        assert_eq!(
            estimate_message_tokens(head_message),
            COMPACT_USER_MESSAGE_HEAD_TOKENS,
            "one truncating message ends the head at the head budget"
        );
        let elision = &kept[1];
        assert_eq!(elision.role, "user");
        assert!(
            elision.content.contains("omitted here during compaction"),
            "kept[1] must be the elision note, got: {}",
            &elision.content[..elision.content.len().min(80)]
        );
        assert!(
            elision.content.contains("roughly 10000 tokens"),
            "elision records 30000 - 20000 = 10000 omitted tokens"
        );
        let tail = &kept[2..];
        assert_eq!(tail.len(), 6, "the tail survives verbatim below the note");
        for message in tail {
            assert_eq!(estimate_message_tokens(message), 3_000);
        }
        let verbatim: u32 = std::iter::once(head_message)
            .chain(tail.iter())
            .map(estimate_message_tokens)
            .sum();
        assert_eq!(verbatim, COMPACT_USER_MESSAGE_MAX_TOKENS);
        // The tail loop stops at tail_remaining == 0 — no empty suffix message.
        assert!(
            kept.iter().all(|m| !m.content.is_empty()),
            "no empty-content message may be kept"
        );
    }
}
