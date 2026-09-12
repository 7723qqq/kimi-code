//! Tower rate limit governor — native port of v2 `TowerRateLimitService`.
//!
//! Enforces adaptive concurrency budgeting and provider rate-limit backoff
//! for detached tower worker and reviewer subagent runs.

use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS: u64 = 2_000;
pub const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS: u64 = 180_000;
pub const TOWER_SPAWN_PAUSE_MS: u64 = 60_000;
pub const TOWER_MAX_BUDGET: usize = 16;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TowerRateLimitSnapshot {
    pub budget: usize,
    pub inflight: usize,
    pub blocked_until: Option<u64>,
}

#[derive(Debug)]
struct TowerRateLimitInner {
    capacity: usize,
    inflight: usize,
    blocked_until: Option<u64>,
    last_rate_limit_at: Option<u64>,
    last_shrink_at: Option<u64>,
    last_recovery_at: Option<u64>,
}

#[derive(Debug)]
pub struct TowerRateLimit {
    inner: Mutex<TowerRateLimitInner>,
}

impl Default for TowerRateLimit {
    fn default() -> Self {
        Self::new()
    }
}

impl TowerRateLimit {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(TowerRateLimitInner {
                capacity: TOWER_MAX_BUDGET,
                inflight: 0,
                blocked_until: None,
                last_rate_limit_at: None,
                last_shrink_at: None,
                last_recovery_at: None,
            }),
        }
    }

    /// Process-wide global rate limiter (mirrors v2 LifecycleScope.App singleton).
    pub fn global() -> Arc<Self> {
        static GLOBAL: LazyLock<Arc<TowerRateLimit>> =
            LazyLock::new(|| Arc::new(TowerRateLimit::new()));
        GLOBAL.clone()
    }

    pub fn report_rate_limited(&self) {
        let now = now_ms();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.inflight > 0
            && (g.last_shrink_at.is_none()
                || now.saturating_sub(g.last_shrink_at.unwrap_or(0))
                    >= RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS)
        {
            g.capacity = g.capacity.saturating_sub(1).max(1);
            g.last_shrink_at = Some(now);
        }
        g.last_rate_limit_at = Some(now);
        g.blocked_until = Some(now + TOWER_SPAWN_PAUSE_MS);
    }

    pub fn report_success(&self) {
        let now = now_ms();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.blocked_until = None;
        Self::maybe_recover(&mut g, now);
    }

    fn maybe_recover(g: &mut TowerRateLimitInner, now: u64) {
        if let Some(last_limit) = g.last_rate_limit_at {
            let ref_time = g.last_recovery_at.unwrap_or(last_limit);
            if now >= ref_time + RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS {
                g.capacity = (g.capacity + 1).min(TOWER_MAX_BUDGET);
                g.last_recovery_at = Some(now);
            }
        }
    }

    pub fn budget(&self) -> usize {
        let now = now_ms();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::maybe_recover(&mut g, now);
        g.capacity.clamp(1, TOWER_MAX_BUDGET)
    }

    pub fn acquire(&self) -> Result<(), String> {
        let now = now_ms();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(until) = g.blocked_until {
            if now < until {
                let retry_after_s = ((until - now) as f64 / 1000.0).ceil() as u64;
                return Err(format!(
                    "provider rate limit hit — new tower spawns paused for ~{retry_after_s}s. \
                     Successful requests lift the pause early; wait and retry, or let running agents finish first."
                ));
            }
            g.blocked_until = None;
        }
        Self::maybe_recover(&mut g, now);
        let budget = g.capacity.clamp(1, TOWER_MAX_BUDGET);
        if g.inflight >= budget {
            return Err(format!(
                "tower concurrency budget exhausted ({}/{} agents running). \
                 Wait for a running agent to complete, then retry.",
                g.inflight, budget
            ));
        }
        g.inflight += 1;
        Ok(())
    }

    pub fn release(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.inflight = g.inflight.saturating_sub(1);
    }

    pub fn snapshot(&self) -> TowerRateLimitSnapshot {
        let now = now_ms();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::maybe_recover(&mut g, now);
        let budget = g.capacity.clamp(1, TOWER_MAX_BUDGET);
        TowerRateLimitSnapshot {
            budget,
            inflight: g.inflight,
            blocked_until: g.blocked_until,
        }
    }

    pub fn render_concurrency(&self) -> String {
        let snap = self.snapshot();
        let now = now_ms();
        let mut parts = vec![format!(
            "budget: {} agent(s) · inflight: {}",
            snap.budget, snap.inflight
        )];
        if let Some(until) = snap.blocked_until {
            if until > now {
                let rem_s = ((until - now) as f64 / 1000.0).ceil() as u64;
                parts.push(format!(
                    "spawns PAUSED for ~{rem_s}s (provider rate limit — successful requests lift the pause early)"
                ));
            } else {
                parts.push("spawn pause expired — budget probing resumes".to_string());
            }
        } else {
            parts.push("spawns open".to_string());
        }
        parts.join(" · ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tower_rate_limit_acquire_release() {
        let rl = TowerRateLimit::new();
        assert_eq!(rl.budget(), TOWER_MAX_BUDGET);
        assert!(rl.acquire().is_ok());
        let snap = rl.snapshot();
        assert_eq!(snap.inflight, 1);
        rl.release();
        assert_eq!(rl.snapshot().inflight, 0);
    }

    #[test]
    fn test_tower_rate_limit_exhaustion_blocks() {
        let rl = TowerRateLimit::new();
        for _ in 0..TOWER_MAX_BUDGET {
            assert!(rl.acquire().is_ok());
        }
        let err = rl.acquire().unwrap_err();
        assert!(err.contains("concurrency budget exhausted"));
        rl.release();
        assert!(rl.acquire().is_ok());
    }

    #[test]
    fn test_tower_rate_limit_report_pause() {
        let rl = TowerRateLimit::new();
        rl.report_rate_limited();
        let err = rl.acquire().unwrap_err();
        assert!(err.contains("spawns paused"));

        // report_success clears pause early
        rl.report_success();
        assert!(rl.acquire().is_ok());
    }
}
