//! Subagent data types and lifecycle states.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

/// A profile's summary distillation policy (v2 `AgentProfileSummaryPolicy`):
/// when the subagent's final assistant text is shorter than `min_chars`
/// (UTF-16 code units, v2 `String.length`), the engine re-prompts with
/// `continuation_prompt` up to `retries` times until the summary is long
/// enough or the retries are exhausted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryPolicy {
    #[serde(default)]
    pub min_chars: usize,
    pub continuation_prompt: String,
    #[serde(default)]
    pub retries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentDefinition {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub tools: Vec<String>,
    /// Tool names the profile forbids (v2 `disallowedTools`). Applied when
    /// `tools` is empty (empty allowlist = all tools minus this list).
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    /// Host-resolved prompt prefix (v2 `applyProfilePromptPrefix`):
    /// prepended to the user prompt as `{prefix}\n\n{prompt}`. The v2
    /// prefix is a function resolved at spawn time with the execution
    /// runtime; the wire carries the pre-resolved string, computed once
    /// per turn when the profile snapshot is pushed.
    #[serde(default)]
    pub prompt_prefix: Option<String>,
    #[serde(default)]
    pub summary_policy: Option<SummaryPolicy>,
    pub model: Option<String>,
}

/// The parent turn's cancellation signal, event-driven (P51): [`Self::trigger`]
/// flips the flag the turn loop polls at step tops AND wakes a parked
/// waiter, so a foreground subagent awaiting this signal aborts
/// immediately instead of at a poll tick.
#[derive(Clone)]
pub struct ParentCancel {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl ParentCancel {
    pub fn new() -> Self {
        Self::from_flag(Arc::new(AtomicBool::new(false)))
    }

    /// Wrap an existing flag (the per-turn `cancel_map` entry): the turn
    /// loop keeps observing the raw flag at step tops, the foreground
    /// subagent additionally awaits the notify half.
    pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
        Self {
            flag,
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// The raw flag for the turn loop's step-boundary checks.
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }

    pub fn trigger(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // Wake every parked waiter, not just one. A swarm parks one waiter
        // per member *plus* the batch's bridge, and `notify_one` would
        // release exactly one of them — the rest stay parked forever and
        // never observe the cancellation, leaving orphaned workers running
        // after the batch has already reported them aborted. Waiters that
        // arrive later are covered by `wait`'s flag pre-check below, so no
        // stored permit is needed.
        self.notify.notify_waiters();
    }

    pub fn triggered(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves once triggered. Safe against the trigger-before-wait race:
    /// the pre-check covers an already-stored flag, and `trigger` wakes
    /// every waiter parked at that moment.
    pub async fn wait(&self) {
        if self.triggered() {
            return;
        }
        self.notify.notified().await;
    }
}

impl Default for ParentCancel {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentState {
    Running,
    Idle,
    Completed,
    Failed,
    Terminated,
}

impl SubagentState {
    /// Terminal states retire the scope into the completed-scope LRU
    /// (v2 `SubagentCompleted` / `SubagentFailed` / `SubagentCancelled`).
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Terminated)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentInstance {
    pub id: String,
    pub type_name: String,
    pub role: String,
    pub state: SubagentState,
    pub created_at_ms: u64,
    pub last_result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentSummary {
    pub id: String,
    pub type_name: String,
    pub role: String,
    pub state: SubagentState,
    pub created_at_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A swarm parks one waiter per member *plus* the batch's bridge on the
    /// same `ParentCancel`. Triggering must release every one of them.
    ///
    /// With `notify_one` only a single waiter woke: the rest stayed parked
    /// forever, never observed the cancellation, and kept running after the
    /// batch had already reported them aborted (orphaned workers).
    #[tokio::test]
    async fn trigger_wakes_every_parked_waiter() {
        const WAITERS: usize = 4; // 1 batch bridge + 3 swarm members

        let cancel = ParentCancel::new();
        let woken = Arc::new(AtomicUsize::new(0));

        let barrier = Arc::new(tokio::sync::Barrier::new(WAITERS + 1));
        let mut handles = Vec::new();
        for _ in 0..WAITERS {
            let cancel = cancel.clone();
            let woken = woken.clone();
            let barrier = barrier.clone();
            handles.push(tokio::spawn(async move {
                let wait = cancel.wait();
                // Park first: `wait` must be in flight before the trigger so
                // this exercises the wake path, not the flag pre-check.
                barrier.wait().await;
                wait.await;
                woken.fetch_add(1, Ordering::SeqCst);
            }));
        }

        // Every waiter has entered `wait()` (they are parked on the notify).
        barrier.wait().await;
        tokio::task::yield_now().await;
        cancel.trigger();

        for handle in handles {
            handle.await.expect("waiter resolves once triggered");
        }
        assert_eq!(
            woken.load(Ordering::SeqCst),
            WAITERS,
            "every parked waiter must observe the cancellation"
        );
    }

    /// A waiter that arrives after the trigger must not block: the flag is
    /// checked before parking, so no stored permit is required.
    #[tokio::test]
    async fn wait_after_trigger_returns_immediately() {
        let cancel = ParentCancel::new();
        cancel.trigger();
        cancel.wait().await;
    }
}
