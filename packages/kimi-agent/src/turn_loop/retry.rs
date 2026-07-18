#![allow(dead_code)]

/// Retry logic for LLM calls and tool executions.
///
/// Corresponds to `packages/agent-core/src/loop/retry.ts`.

use std::time::Duration;

/// Configuration for retry behavior.
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
            max_attempts: 3,
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