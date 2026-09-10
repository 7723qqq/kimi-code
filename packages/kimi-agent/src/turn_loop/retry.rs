//! Retry logic for LLM calls and tool executions.
//!
//! Corresponds to `packages/agent-core-v2/src/_base/utils/retry.ts`.

use std::time::Duration;

/// v2 `DEFAULT_MAX_RETRY_ATTEMPTS` (_base/utils/retry.ts:3): the loop retries
/// a retryable step error up to 10 times unless the host overrides
/// `RunTurnInput::max_attempts` (`loopControl.maxAttemptsPerStep`).
pub const DEFAULT_MAX_RETRY_ATTEMPTS: u32 = 10;

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
            base_delay_ms: 1000,
            max_delay_ms: 30000,
        }
    }
}

/// Calculate the delay for a retry attempt using exponential backoff with jitter.
pub fn retry_delay(attempt: u32, config: &RetryConfig) -> Duration {
    let delay = config.base_delay_ms * 2u64.pow(attempt.saturating_sub(1));
    let delay = delay.min(config.max_delay_ms);
    // Add jitter: ±25%
    let jitter = fastrand::i64(-(delay as i64 / 4)..=(delay as i64 / 4));
    Duration::from_millis((delay as i64 + jitter).max(100) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_config_defaults() {
        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, 10);
        assert_eq!(config.base_delay_ms, 1000);
        assert_eq!(config.max_delay_ms, 30000);
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
        let delay = retry_delay(1, &config);
        let ms = delay.as_millis() as u64;
        assert!(
            (750..=1250).contains(&ms),
            "attempt 1: delay must be in [750, 1250], got {ms}"
        );
    }

    #[test]
    fn test_retry_delay_second_attempt() {
        let config = RetryConfig::default();
        let delay = retry_delay(2, &config);
        let ms = delay.as_millis() as u64;
        assert!(
            (1500..=2500).contains(&ms),
            "attempt 2: delay must be in [1500, 2500], got {ms}"
        );
    }

    #[test]
    fn test_retry_delay_third_attempt() {
        let config = RetryConfig::default();
        let delay = retry_delay(3, &config);
        let ms = delay.as_millis() as u64;
        assert!(
            (3000..=5000).contains(&ms),
            "attempt 3: delay must be in [3000, 5000], got {ms}"
        );
    }

    #[test]
    fn test_retry_delay_caps_at_max() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 1000,
            max_delay_ms: 5000,
        };
        let delay = retry_delay(5, &config);
        let ms = delay.as_millis() as u64;
        assert!(
            (3750..=6250).contains(&ms),
            "capped delay must be in [3750, 6250], got {ms}"
        );
    }

    #[test]
    fn test_retry_delay_zero_base_delay() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 0,
            max_delay_ms: 1000,
        };
        let delay = retry_delay(1, &config);
        let ms = delay.as_millis() as u64;
        assert_eq!(ms, 100, "should floor at 100ms minimum");
    }

    #[test]
    fn test_retry_delay_high_attempt_respects_max() {
        let config = RetryConfig {
            max_attempts: 20,
            base_delay_ms: 100,
            max_delay_ms: 2000,
        };
        for attempt in 1..=10 {
            let delay = retry_delay(attempt, &config);
            let ms = delay.as_millis() as u64;
            let expected_max = (config.base_delay_ms * 2u64.pow(attempt.saturating_sub(1)))
                .min(config.max_delay_ms) as i64;
            let with_jitter = expected_max + expected_max / 4;
            let cap = with_jitter.max(100) as u64;
            assert!(
                ms <= cap,
                "attempt {attempt}: delay {ms} exceeded cap {cap}"
            );
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

    #[test]
    fn test_retry_delay_non_zero() {
        let config = RetryConfig::default();
        for attempt in 1..=10 {
            let delay = retry_delay(attempt, &config);
            assert!(
                delay.as_millis() >= 100,
                "attempt {attempt}: delay must respect minimum 100ms floor"
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
        let delay = retry_delay(3, &config);
        let ms = delay.as_millis() as u64;
        assert!(
            (1500..=2500).contains(&ms),
            "custom config attempt 3: delay must be in [1500, 2500], got {ms}"
        );
    }

    #[test]
    fn test_retry_delay_attempt_zero() {
        let config = RetryConfig::default();
        let delay = retry_delay(0, &config);
        // attempt 0 → saturating_sub(1) = 0 → 1000 * 1 = 1000, jitter ±250
        let ms = delay.as_millis() as u64;
        assert!(
            (750..=1250).contains(&ms),
            "attempt 0: delay must be in [750, 1250], got {ms}"
        );
    }

    #[test]
    fn test_retry_delay_jitter_lower_bound() {
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 50,
            max_delay_ms: 1000,
        };
        let delay = retry_delay(1, &config);
        // base=50, jitter ±12 → 38..62, floored to 100
        assert_eq!(delay.as_millis(), 100, "should floor at 100ms minimum");
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
            let delay = retry_delay(attempt, &config).as_millis() as u64;
            let nominal = config.base_delay_ms * 2u64.pow(attempt - 1);
            let min_expected = (nominal * 3) / 4;
            let max_expected = (nominal * 5) / 4;
            assert!(
                delay >= min_expected && delay <= max_expected,
                "attempt {attempt}: delay {delay} outside [{min_expected}, {max_expected}]"
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
            max_delay_ms: 30000,
        };
        let delays: Vec<_> = (1..=3).map(|a| retry_delay(a, &config)).collect();
        // Each delay should be distinct (due to jitter or base growth)
        // delay 3 (base 4000) > delay 2 (base 2000) > delay 1 (base 1000) in expectation
        // We can't guarantee strict ordering due to jitter, but we can verify
        // that delay 3's jitter range is above delay 1's jitter range
        let d1 = delays[0].as_millis();
        let d3 = delays[2].as_millis();
        // d3 base = 4000, min with jitter = 3000; d1 base = 1000, max with jitter = 1250
        // So d3 should always be >= d1
        assert!(d3 >= d1, "d3={d3} should be >= d1={d1}");
    }

    #[test]
    fn test_retry_delay_consistent_type() {
        let config = RetryConfig {
            max_attempts: 10,
            base_delay_ms: 1000,
            max_delay_ms: 8000,
        };
        for attempt in 1..=10 {
            let delay = retry_delay(attempt, &config);
            let ms = delay.as_millis() as u64;
            assert!(ms >= 100, "attempt {attempt}: delay must respect 100ms floor");
            assert!(
                ms <= 10000,
                "attempt {attempt}: delay {ms} must not exceed max_delay + 25% jitter"
            );
        }
    }
}
