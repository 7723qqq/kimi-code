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
        // A permit survives until a waiter consumes it, so triggering
        // before `wait` is observed is still immediate.
        self.notify.notify_one();
    }

    pub fn triggered(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// Resolves once triggered. Safe against the trigger-before-wait race:
    /// the pre-check covers an already-stored flag and `notify_one` stores
    /// a permit when no waiter is parked yet.
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
