//! Retry logic for LLM calls and tool executions.
//!
//! Corresponds to `packages/agent-core-v2/src/_base/utils/retry.ts`.

use std::time::Duration;

/// v2 `DEFAULT_MAX_RETRY_ATTEMPTS` (_base/utils/retry.ts:3): the loop retries
/// a retryable step error up to 10 times unless the host overrides
/// `RunTurnInput::max_attempts` (`loopControl.maxAttemptsPerStep`).
pub const DEFAULT_MAX_RETRY_ATTEMPTS: u32 = 10;

/// v2 `BASE_DELAY_MS` (_base/utils/retry.ts:5): the first retry waits 500ms,
/// not the 1000ms this used to start from.
pub const DEFAULT_BASE_DELAY_MS: u64 = 500;

/// v2 `MAX_DELAY_MS` (_base/utils/retry.ts:6).
pub const DEFAULT_MAX_DELAY_MS: u64 = 32_000;

/// Whether an env switch is set to a truthy value (v2 `parseBooleanEnv`):
/// `1` / `true` / `yes` / `on`, case-insensitive; anything else — including an
/// unset variable — is false.
pub fn parse_truthy_env(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

/// `KIMI_CODE_INFINITE_RETRY` (v2 #3240, llmRequesterService.ts): retry every
/// failed LLM request indefinitely — turn steps and operation requests such
/// as compaction alike — instead of giving up after `max_attempts`. Waits use
/// the same exponential backoff and honor the provider's `Retry-After`;
/// cancellation still aborts during the wait.
pub fn infinite_retry_enabled() -> bool {
    parse_truthy_env("KIMI_CODE_INFINITE_RETRY")
}

/// Configuration for retry behavior.
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Maximum number of retry attempts.
    pub max_attempts: u32,
    /// Base delay for exponential backoff (in milliseconds).
    pub base_delay_ms: u64,
    /// Maximum delay (in milliseconds).
    pub max_delay_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_RETRY_ATTEMPTS,
            base_delay_ms: DEFAULT_BASE_DELAY_MS,
            max_delay_ms: DEFAULT_MAX_DELAY_MS,
        }
    }
}

/// Calculate the delay for a retry attempt using exponential backoff with jitter.
///
/// Mirrors v2 `retryBackoffDelay` (_base/utils/retry.ts:16-19):
/// `min(BASE * 2^index, MAX)` plus a **one-sided** jitter of `[0, 25%]` —
/// `base + Math.random() * 0.25 * base`. `attempt` here is 1-based (the number
/// of the attempt that just failed, see `execute_loop_step_with_retry`), so
/// `attempt - 1` is v2's 0-based `attemptIndex`.
///
/// Centring the jitter instead — as this used to — makes a retry fire up to
/// 25% earlier than v2 would, which is a real behaviour difference for a
/// rate-limited provider, not a stylistic one.
pub fn retry_delay(attempt: u32, config: &RetryConfig) -> Duration {
    let delay = config.base_delay_ms * 2u64.pow(attempt.saturating_sub(1));
    let delay = delay.min(config.max_delay_ms);
    let jitter = fastrand::u64(0..=(delay / 4));
    Duration::from_millis(delay + jitter)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v2 `retryBackoffDelay` as an explicit range: `min(base * 2^index, max)`
    /// through the same value plus a full `25%` jitter.
    ///
    /// Expectations are derived from the formula rather than written out, so a
    /// constant change cannot leave a test asserting a number that no longer
    /// means anything — the failure mode that let the two-sided jitter sit here
    /// unnoticed (every test above simply restated the implementation).
    fn v2_range(config: &RetryConfig, attempt: u32) -> (u64, u64) {
        let nominal =
            (config.base_delay_ms * 2u64.pow(attempt.saturating_sub(1))).min(config.max_delay_ms);
        (nominal, nominal + nominal / 4)
    }

    fn assert_within_v2_range(config: &RetryConfig, attempt: u32) -> u64 {
        let (min, max) = v2_range(config, attempt);
        let ms = retry_delay(attempt, config).as_millis() as u64;
        assert!(
            (min..=max).contains(&ms),
            "attempt {attempt}: delay {ms} outside v2 range [{min}, {max}]"
        );
        ms
    }

    #[test]
    fn test_retry_config_defaults() {
        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, DEFAULT_MAX_RETRY_ATTEMPTS);
        assert_eq!(config.max_attempts, 10);
        assert_eq!(config.base_delay_ms, DEFAULT_BASE_DELAY_MS);
        assert_eq!(config.base_delay_ms, 500);
        assert_eq!(config.max_delay_ms, DEFAULT_MAX_DELAY_MS);
        assert_eq!(config.max_delay_ms, 32_000);
    }

    /// v2 `parseBooleanEnv` parity: `1`/`true`/`yes`/`on` are truthy (case
    /// insensitive, trimmed), everything else — including an unset variable —
    /// is falsy. A test-unique variable name keeps parallel tests out of each
    /// other's environment.
    #[test]
    fn parse_truthy_env_matches_v2_boolean_parsing() {
        let name = "KIMI_TEST_TRUTHY_ENV_PROBE";
        for value in ["1", "true", "TRUE", "yes", "on", " on "] {
            unsafe { std::env::set_var(name, value) };
            assert!(parse_truthy_env(name), "{value:?} must be truthy");
        }
        for value in ["0", "false", "no", "off", "", "maybe"] {
            unsafe { std::env::set_var(name, value) };
            assert!(!parse_truthy_env(name), "{value:?} must be falsy");
        }
        unsafe { std::env::remove_var(name) };
        assert!(!parse_truthy_env(name), "unset must be falsy");
    }

    #[test]
    fn test_retry_delay_first_attempt() {
        let config = RetryConfig::default();
        // v2 index 0 → 500, + [0, 125].
        assert_eq!(v2_range(&config, 1), (500, 625));
        assert_within_v2_range(&config, 1);
    }

    #[test]
    fn test_retry_delay_second_attempt() {
        let config = RetryConfig::default();
        assert_eq!(v2_range(&config, 2), (1000, 1250));
        assert_within_v2_range(&config, 2);
    }

    #[test]
    fn test_retry_delay_third_attempt() {
        let config = RetryConfig::default();
        assert_eq!(v2_range(&config, 3), (2000, 2500));
        assert_within_v2_range(&config, 3);
    }

    #[test]
    fn test_retry_delay_caps_at_max() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 1000,
            max_delay_ms: 5000,
        };
        // 1000 * 2^4 = 16000, capped to 5000, + [0, 1250].
        assert_eq!(v2_range(&config, 5), (5000, 6250));
        assert_within_v2_range(&config, 5);
    }

    /// v2 has no floor: `retryBackoffDelay` returns whatever the formula gives.
    /// The 100ms floor this used to apply existed only to stop the old
    /// *two-sided* jitter from underflowing a `u64` cast — with a one-sided
    /// jitter there is nothing to guard, so the floor is gone and a zero base
    /// means a zero wait, exactly as in v2.
    #[test]
    fn test_retry_delay_zero_base_delay_matches_v2() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 0,
            max_delay_ms: 1000,
        };
        assert_eq!(retry_delay(1, &config).as_millis(), 0);
    }

    #[test]
    fn test_retry_delay_high_attempt_respects_max() {
        let config = RetryConfig {
            max_attempts: 20,
            base_delay_ms: 100,
            max_delay_ms: 2000,
        };
        for attempt in 1..=10 {
            let (min, max) = v2_range(&config, attempt);
            assert!(
                max <= 2500,
                "attempt {attempt}: the 25% jitter must not push past max + 25%"
            );
            let ms = assert_within_v2_range(&config, attempt);
            assert!(ms >= min);
        }
    }

    #[test]
    fn test_retry_delay_jitter_variation() {
        let config = RetryConfig::default();
        let mut delays = std::collections::HashSet::new();
        for _ in 0..50 {
            delays.insert(retry_delay(1, &config));
        }
        assert!(delays.len() >= 2, "jitter should produce varied delays");
    }

    /// The jitter is one-sided: v2 never retries *earlier* than the nominal
    /// backoff. This is the assertion the old suite was missing — every delay
    /// it checked also admitted a value 25% below nominal.
    #[test]
    fn test_retry_delay_never_undercuts_the_nominal_backoff() {
        let config = RetryConfig::default();
        for attempt in 1..=12 {
            let nominal = (config.base_delay_ms * 2u64.pow(attempt - 1)).min(config.max_delay_ms);
            let ms = retry_delay(attempt, &config).as_millis() as u64;
            assert!(
                ms >= nominal,
                "attempt {attempt}: {ms} undercuts the nominal {nominal}; \
                 v2 jitters upward only"
            );
        }
    }

    #[test]
    fn test_retry_delay_non_zero() {
        let config = RetryConfig::default();
        for attempt in 1..=10 {
            assert!(
                retry_delay(attempt, &config).as_millis() >= 500,
                "attempt {attempt}: the default config never waits less than the 500ms base"
            );
        }
    }

    #[test]
    fn test_retry_delay_custom_config() {
        let config = RetryConfig {
            max_attempts: 5,
            base_delay_ms: 500,
            max_delay_ms: 10000,
        };
        // 500 * 2^2 = 2000, + [0, 500].
        assert_eq!(v2_range(&config, 3), (2000, 2500));
        assert_within_v2_range(&config, 3);
    }

    #[test]
    fn test_retry_delay_attempt_zero() {
        let config = RetryConfig::default();
        // `saturating_sub(1)` keeps attempt 0 on the base delay, like v2 index 0.
        assert_eq!(v2_range(&config, 0), (500, 625));
        assert_within_v2_range(&config, 0);
    }

    /// A small base still jitters upward only — the old floor at 100ms used to
    /// swallow this case entirely.
    #[test]
    fn test_retry_delay_small_base() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 50,
            max_delay_ms: 1000,
        };
        assert_eq!(v2_range(&config, 1), (50, 62));
        assert_within_v2_range(&config, 1);
    }

    #[test]
    fn test_retry_delay_exponential_growth() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 200,
            max_delay_ms: 100000,
        };
        let mut prev_max = 0;
        for attempt in 1..=5 {
            let ms = retry_delay(attempt, &config).as_millis() as u64;
            let (min_expected, max_expected) = v2_range(&config, attempt);
            assert!(
                ms >= min_expected && ms <= max_expected,
                "attempt {attempt}: delay {ms} outside [{min_expected}, {max_expected}]"
            );
            if attempt > 1 {
                assert!(
                    min_expected > prev_max,
                    "attempt {attempt} minimum {min_expected} must strictly exceed previous max {prev_max}"
                );
            }
            prev_max = max_expected;
        }
    }

    #[test]
    fn test_retry_delay_max_attempt_delays() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 1000,
            max_delay_ms: 32_000,
        };
        let d1 = retry_delay(1, &config).as_millis();
        let d3 = retry_delay(3, &config).as_millis();
        // d1 ∈ [1000, 1250], d3 ∈ [4000, 5000] — disjoint, so the ordering is
        // guaranteed even with the jitter.
        assert!(d3 > d1, "d3={d3} should exceed d1={d1}");
    }

    #[test]
    fn test_retry_delay_consistent_type() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 1000,
            max_delay_ms: 8000,
        };
        for attempt in 1..=10 {
            let (min, max) = v2_range(&config, attempt);
            let ms = retry_delay(attempt, &config).as_millis() as u64;
            assert!((min..=max).contains(&ms), "attempt {attempt}: {ms}");
            assert!(ms <= 10_000, "attempt {attempt}: {ms} past max + 25%");
        }
    }

    /// The default cap must land exactly on v2's `MAX_DELAY_MS`: at the
    /// attempt where the exponential reaches it, the nominal is 32_000.
    #[test]
    fn test_default_backoff_saturates_at_v2_max() {
        let config = RetryConfig::default();
        // 500 * 2^6 = 32_000, so index 6 (attempt 7) is the first to saturate.
        assert_eq!(v2_range(&config, 7), (32_000, 40_000));
        assert_eq!(v2_range(&config, 12).0, 32_000);
    }
}
