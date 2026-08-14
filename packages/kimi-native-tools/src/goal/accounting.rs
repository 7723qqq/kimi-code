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
    let input_delta = current
        .input_tokens
        .saturating_sub(prev.input_tokens)
        .saturating_sub(
            current
                .cached_input_tokens
                .saturating_sub(prev.cached_input_tokens),
        );
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
}
