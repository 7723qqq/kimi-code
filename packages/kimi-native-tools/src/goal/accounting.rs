//! Goal accounting — stateless chargeable-token delta computation.
//!
//! Based on Codex `ext/goal/src/accounting.rs`, reduced to the stateless core
//! the napi layer actually uses: turn accounting baselines live in the TS
//! runtime (which owns the goal state), so the native side only computes the
//! chargeable delta between two usage snapshots.

// ---------------------------------------------------------------------------
// Token usage snapshot (matches TS TokenUsage shape)
// ---------------------------------------------------------------------------

/// Token usage counters, mirroring the TS `TokenUsage` type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

/// The delta in goal-chargeable tokens between two usage snapshots.
/// Input tokens are charged at full rate minus cached portion; output tokens
/// are charged at full rate. This matches Codex's `goal_token_delta_for_usage`.
pub fn goal_token_delta(prev: &TokenUsage, current: &TokenUsage) -> i64 {
    // The cached-input delta is clamped to non-negative: a snapshot after a
    // reset can report cached tokens going backwards, and a negative cached
    // delta must not inflate the chargeable input delta.
    let cached_delta = current
        .cached_input_tokens
        .saturating_sub(prev.cached_input_tokens)
        .max(0);
    let input_delta = current
        .input_tokens
        .saturating_sub(prev.input_tokens)
        .saturating_sub(cached_delta);
    let output_delta = current.output_tokens.saturating_sub(prev.output_tokens);
    input_delta.max(0).saturating_add(output_delta.max(0))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: i64, cached: i64, output: i64) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
        }
    }

    #[test]
    fn test_token_delta() {
        let prev = usage(100, 20, 50);
        let curr = usage(200, 30, 100);
        // delta: (200-100) - (30-20) + (100-50) = 100 - 10 + 50 = 140
        assert_eq!(goal_token_delta(&prev, &curr), 140);
    }

    #[test]
    fn test_token_delta_no_regression() {
        // Usage counters going backwards (snapshot after a reset) must not
        // produce a negative charge.
        let prev = usage(200, 30, 100);
        let curr = usage(100, 20, 50);
        assert_eq!(goal_token_delta(&prev, &curr), 0);
    }

    #[test]
    fn test_token_delta_cached_exceeds_input() {
        // Cached-input delta larger than the input delta: the chargeable
        // input delta saturates to 0 (never negative), output still counts.
        let prev = usage(100, 20, 50);
        let curr = usage(200, 250, 100);
        // input_delta = (200-100) - (250-20) = 100 - 230 -> saturates to 0
        // output_delta = 100 - 50 = 50
        assert_eq!(goal_token_delta(&prev, &curr), 50);
    }

    #[test]
    fn test_token_delta_cached_delta_alone_exceeds_input_delta() {
        // Cached-input growth alone exceeds the input growth, so the input
        // portion charges nothing; only the output delta is charged.
        let prev = usage(100, 0, 0);
        let curr = usage(150, 100, 0);
        // input_delta = (150-100) - (100-0) = 50 - 100 -> saturates to 0
        assert_eq!(goal_token_delta(&prev, &curr), 0);
    }

    #[test]
    fn test_token_delta_cached_goes_backwards() {
        // Cached-input delta negative (snapshot after a reset): the cached
        // delta saturates to 0, so the input delta is not reduced by it and
        // the full input growth is charged.
        let prev = usage(100, 50, 0);
        let curr = usage(200, 20, 0);
        // input_delta = (200-100) - saturating(20-50) = 100 - 0 = 100
        assert_eq!(goal_token_delta(&prev, &curr), 100);
    }
}
