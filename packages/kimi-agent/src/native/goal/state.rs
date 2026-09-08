//! Goal state machine — 6-state design based on Codex `ext/goal/`.
//!
//! States:
//! - `Active`: 正在被 goal driver 推进，自动续跑
//! - `Paused`: 暂停，可恢复
//! - `Blocked`: 真实阻塞，可恢复
//! - `Complete`: 完成（瞬态，发出事件后清除）
//! - `BudgetLimited`: token 预算耗尽，仍可收尾
//! - `UsageLimited`: API usage limit 耗尽，仍可收尾
//!
//! JSON schema (camelCase): matches TS `GoalState` one-to-one.
//! Goal mutations consume/produce this schema.
//!
//! | Field | Type | TS name |
//! |---|---|---|
//! | `goal_id` | String | `goalId` |
//! | `objective` | String | `objective` |
//! | `completion_criterion` | Option<String> | `completionCriterion` |
//! | `status` | GoalStatus | `status` |
//! | `token_budget` | Option<i64> | `tokenBudget` |
//! | `turn_budget` | Option<i64> | `turnBudget` |
//! | `wall_clock_budget_ms` | Option<i64> | `wallClockBudgetMs` |
//! | `tokens_used` | i64 | `tokensUsed` |
//! | `turns_used` | i64 | `turnsUsed` |
//! | `wall_clock_ms` | i64 | `wallClockMs` |
//! | `blocked_streak` | u32 | `blockedStreak` |
//! | `wall_clock_resumed_at` | Option<i64> | `wallClockResumedAt` |
//! | `terminal_reason` | Option<String> | `terminalReason` |
//! | `created_at` | i64 | `createdAt` |
//! | `updated_at` | i64 | `updatedAt` |

use std::fmt;

/// The six lifecycle states of a thread goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Complete,
    BudgetLimited,
    UsageLimited,
}

impl GoalStatus {
    /// Serialize to a JSON-safe string (camelCase for napi compat).
    pub fn as_str(self) -> &'static str {
        match self {
            GoalStatus::Active => "active",
            GoalStatus::Paused => "paused",
            GoalStatus::Blocked => "blocked",
            GoalStatus::Complete => "complete",
            GoalStatus::BudgetLimited => "budgetLimited",
            GoalStatus::UsageLimited => "usageLimited",
        }
    }

    /// Deserialize from the JSON-safe string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "active" => Some(GoalStatus::Active),
            "paused" => Some(GoalStatus::Paused),
            "blocked" => Some(GoalStatus::Blocked),
            "complete" => Some(GoalStatus::Complete),
            "budgetLimited" | "budget_limited" => Some(GoalStatus::BudgetLimited),
            "usageLimited" | "usage_limited" => Some(GoalStatus::UsageLimited),
            _ => None,
        }
    }
}

impl fmt::Display for GoalStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// GoalState – the durable, serialisable state of one thread's goal.
// ---------------------------------------------------------------------------

/// Core goal state, persisted via TS wire.jsonl (native is stateless w.r.t storage).
#[derive(Debug, Clone)]
pub struct GoalState {
    /// Opaque identifier (UUID v4), assigned by TS on creation.
    pub goal_id: String,
    /// User-provided objective text.
    pub objective: String,
    /// Optional completion criterion (user-provided proof of done).
    pub completion_criterion: Option<String>,
    /// Current lifecycle status.
    pub status: GoalStatus,
    /// Optional token budget for the goal (total tokens allowed).
    pub token_budget: Option<i64>,
    /// Optional turn budget (max continuation turns).
    pub turn_budget: Option<i64>,
    /// Optional wall-clock budget in milliseconds.
    pub wall_clock_budget_ms: Option<i64>,
    /// Cumulative tokens consumed toward this goal (input + output, excl. cache).
    pub tokens_used: i64,
    /// Cumulative continuation turns run toward this goal.
    pub turns_used: i64,
    /// Cumulative wall-clock milliseconds spent actively pursuing this goal.
    pub wall_clock_ms: i64,
    /// Consecutive turns that encountered a blocking condition (reset on resume).
    pub blocked_streak: u32,
    /// Timestamp when the current active interval started (epoch ms), if active.
    pub wall_clock_resumed_at: Option<i64>,
    /// Reason for the terminal/blocked/paused state (model-readable).
    pub terminal_reason: Option<String>,
    /// Epoch milliseconds when the goal was created.
    pub created_at: i64,
    /// Epoch milliseconds when the goal was last updated.
    pub updated_at: i64,
}

impl GoalState {
    /// Create a new active goal.
    ///
    /// Production code constructs goals via `parse_goal` from TS JSON; this
    /// constructor serves the test suites in `state` / `steering`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(goal_id: String, objective: String, token_budget: Option<i64>) -> Self {
        let now = chrono_now_ms();
        Self {
            goal_id,
            objective,
            completion_criterion: None,
            status: GoalStatus::Active,
            token_budget,
            turn_budget: None,
            wall_clock_budget_ms: None,
            tokens_used: 0,
            turns_used: 0,
            wall_clock_ms: 0,
            blocked_streak: 0,
            wall_clock_resumed_at: None,
            terminal_reason: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Returns remaining tokens (MAX if no budget).
    ///
    /// The budget report computes the `Option<i64>` variant inline; this
    /// `i64`-with-MAX-default form is used by the test suites.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn remaining_tokens(&self) -> i64 {
        self.token_budget
            .map(|b| (b - self.tokens_used).max(0))
            .unwrap_or(i64::MAX)
    }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Validate a goal objective. Returns an error message if invalid.
pub fn validate_goal_objective(objective: &str) -> Result<(), String> {
    let trimmed = objective.trim();
    if trimmed.is_empty() {
        return Err("Goal objective cannot be empty".to_string());
    }
    if trimmed.len() > 10_000 {
        return Err("Goal objective too long (max 10,000 characters)".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// GoalUpdate – partial update applied via apply_update.
// ---------------------------------------------------------------------------

/// A partial update to a goal. All fields are optional; `None` means "keep".
#[derive(Debug, Clone, Default)]
pub struct GoalUpdate {
    pub objective: Option<String>,
    pub completion_criterion: Option<Option<String>>,
    pub status: Option<GoalStatus>,
    pub token_budget: Option<Option<i64>>,
    pub turn_budget: Option<Option<i64>>,
    pub wall_clock_budget_ms: Option<Option<i64>>,
    pub tokens_used: Option<i64>,
    pub turns_used: Option<i64>,
    pub wall_clock_ms: Option<i64>,
    pub blocked_streak: Option<u32>,
    pub wall_clock_resumed_at: Option<Option<i64>>,
    pub terminal_reason: Option<Option<String>>,
    /// If set, the caller's expected goal_id must match the current goal_id.
    /// This provides optimistic concurrency control.
    pub expected_goal_id: Option<String>,
}

/// Outcome of applying an update.
#[derive(Debug)]
pub enum GoalUpdateOutcome {
    /// Goal was updated successfully.
    Updated(GoalState),
    /// No change (all fields were None or identical).
    Unchanged,
    /// expected_goal_id did not match.
    GoalIdMismatch { current: String, expected: String },
    /// The requested status transition is not allowed.
    InvalidTransition {
        current: GoalStatus,
        target: GoalStatus,
    },
}

impl GoalState {
    /// Apply a partial update. Returns the new state on success.
    ///
    /// If `expected_goal_id` is set and does not match `self.goal_id`,
    /// returns `GoalIdMismatch`.
    pub fn apply_update(mut self, update: GoalUpdate) -> GoalUpdateOutcome {
        // Check expected_goal_id
        if let Some(expected) = &update.expected_goal_id {
            if expected != &self.goal_id {
                return GoalUpdateOutcome::GoalIdMismatch {
                    current: self.goal_id,
                    expected: expected.clone(),
                };
            }
        }

        let mut changed = false;

        if let Some(objective) = update.objective {
            if objective != self.objective {
                self.objective = objective;
                changed = true;
            }
        }
        if let Some(criterion) = update.completion_criterion {
            if criterion != self.completion_criterion {
                self.completion_criterion = criterion;
                changed = true;
            }
        }
        if let Some(status) = update.status {
            if status != self.status {
                // Validate transition
                if !is_valid_transition(self.status, status) {
                    return GoalUpdateOutcome::InvalidTransition {
                        current: self.status,
                        target: status,
                    };
                }
                // On resume: reset blocked_streak and start wall clock
                if status == GoalStatus::Active {
                    self.blocked_streak = 0;
                    self.wall_clock_resumed_at = Some(chrono_now_ms());
                    self.terminal_reason = None;
                }
                // On leaving active: fold elapsed wall-clock into wall_clock_ms
                if self.status == GoalStatus::Active && status != GoalStatus::Active {
                    if let Some(resumed_at) = self.wall_clock_resumed_at {
                        let elapsed = (chrono_now_ms() - resumed_at).max(0);
                        self.wall_clock_ms += elapsed;
                    }
                    self.wall_clock_resumed_at = None;
                }
                self.status = status;
                changed = true;
            }
        }
        if let Some(token_budget) = update.token_budget {
            if token_budget != self.token_budget {
                self.token_budget = token_budget;
                changed = true;
            }
        }
        if let Some(turn_budget) = update.turn_budget {
            if turn_budget != self.turn_budget {
                self.turn_budget = turn_budget;
                changed = true;
            }
        }
        if let Some(wc_budget) = update.wall_clock_budget_ms {
            if wc_budget != self.wall_clock_budget_ms {
                self.wall_clock_budget_ms = wc_budget;
                changed = true;
            }
        }
        if let Some(tokens_used) = update.tokens_used {
            if tokens_used != self.tokens_used {
                self.tokens_used = tokens_used;
                changed = true;
            }
        }
        if let Some(turns_used) = update.turns_used {
            if turns_used != self.turns_used {
                self.turns_used = turns_used;
                changed = true;
            }
        }
        if let Some(wall_clock_ms) = update.wall_clock_ms {
            if wall_clock_ms != self.wall_clock_ms {
                self.wall_clock_ms = wall_clock_ms;
                changed = true;
            }
        }
        if let Some(streak) = update.blocked_streak {
            if streak != self.blocked_streak {
                self.blocked_streak = streak;
                changed = true;
            }
        }
        if let Some(wall_clock) = update.wall_clock_resumed_at {
            if wall_clock != self.wall_clock_resumed_at {
                self.wall_clock_resumed_at = wall_clock;
                changed = true;
            }
        }
        if let Some(reason) = update.terminal_reason {
            if reason != self.terminal_reason {
                self.terminal_reason = reason;
                changed = true;
            }
        }

        if changed {
            self.updated_at = chrono_now_ms();
            GoalUpdateOutcome::Updated(self)
        } else {
            GoalUpdateOutcome::Unchanged
        }
    }
}

/// Returns true if the transition from `current` to `target` is valid.
pub fn is_valid_transition(current: GoalStatus, target: GoalStatus) -> bool {
    use GoalStatus::*;
    matches!(
        (current, target),
        // No-op (identical status)
        (Active, Active)
            | (Paused, Paused)
            | (Blocked, Blocked)
            | (Complete, Complete)
            | (BudgetLimited, BudgetLimited)
            | (UsageLimited, UsageLimited)
            // Resume: paused or blocked -> active
            | (Paused, Active)
            | (Blocked, Active)
            // Pause: active, budget_limited, usage_limited -> paused
            | (Active, Paused)
            | (BudgetLimited, Paused)
            | (UsageLimited, Paused)
            // Block: active -> blocked
            | (Active, Blocked)
            // Complete: active -> complete
            | (Active, Complete)
            // Budget limit: active, usage_limited -> budget_limited
            | (Active, BudgetLimited)
            | (UsageLimited, BudgetLimited)
            // Usage limit: active, budget_limited -> usage_limited
            | (Active, UsageLimited)
            | (BudgetLimited, UsageLimited)
    )
}

/// Returns the current time in epoch milliseconds.
fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_goal() {
        let g = GoalState::new("g1".into(), "fix bugs".into(), Some(1000));
        assert_eq!(g.status, GoalStatus::Active);
        assert_eq!(g.tokens_used, 0);
        assert_eq!(g.remaining_tokens(), 1000);
        assert_eq!(g.turns_used, 0);
        assert_eq!(g.wall_clock_ms, 0);
        assert!(g.completion_criterion.is_none());
        assert!(g.turn_budget.is_none());
        assert!(g.wall_clock_budget_ms.is_none());
    }

    #[test]
    fn test_update_status() {
        let g = GoalState::new("g1".into(), "fix bugs".into(), None);
        let u = GoalUpdate {
            status: Some(GoalStatus::Complete),
            expected_goal_id: Some("g1".into()),
            ..Default::default()
        };
        match g.apply_update(u) {
            GoalUpdateOutcome::Updated(state) => {
                assert_eq!(state.status, GoalStatus::Complete);
            }
            _ => panic!("expected Updated"),
        }
    }

    #[test]
    fn test_goal_id_mismatch() {
        let g = GoalState::new("g1".into(), "fix bugs".into(), None);
        let u = GoalUpdate {
            status: Some(GoalStatus::Complete),
            expected_goal_id: Some("g2".into()),
            ..Default::default()
        };
        match g.apply_update(u) {
            GoalUpdateOutcome::GoalIdMismatch { current, expected } => {
                assert_eq!(current, "g1");
                assert_eq!(expected, "g2");
            }
            _ => panic!("expected GoalIdMismatch"),
        }
    }

    #[test]
    fn test_blocked_streak_reset_on_resume() {
        let g = GoalState {
            status: GoalStatus::Blocked,
            blocked_streak: 3,
            ..GoalState::new("g1".into(), "test".into(), None)
        };
        let u = GoalUpdate {
            status: Some(GoalStatus::Active),
            expected_goal_id: Some("g1".into()),
            ..Default::default()
        };
        match g.apply_update(u) {
            GoalUpdateOutcome::Updated(state) => {
                assert_eq!(state.status, GoalStatus::Active);
                assert_eq!(state.blocked_streak, 0);
            }
            other => panic!("expected Updated, got {other:?}"),
        }
    }

    #[test]
    fn test_validate_objective() {
        assert!(validate_goal_objective("").is_err());
        assert!(validate_goal_objective("  ").is_err());
        assert!(validate_goal_objective("fix bugs").is_ok());
        let long = "a".repeat(10_001);
        assert!(validate_goal_objective(&long).is_err());
    }

    #[test]
    fn test_goal_status_round_trip() {
        // Every variant serializes to a JSON-safe string and parses back to
        // the same variant (as_str -> from_str is the identity).
        for status in [
            GoalStatus::Active,
            GoalStatus::Paused,
            GoalStatus::Blocked,
            GoalStatus::Complete,
            GoalStatus::BudgetLimited,
            GoalStatus::UsageLimited,
        ] {
            assert_eq!(GoalStatus::from_str(status.as_str()), Some(status));
        }
    }

    #[test]
    fn test_goal_status_snake_case_aliases() {
        // The camelCase strings are canonical; the snake_case forms are
        // accepted as aliases for backward compatibility.
        assert_eq!(
            GoalStatus::from_str("budget_limited"),
            Some(GoalStatus::BudgetLimited)
        );
        assert_eq!(
            GoalStatus::from_str("usage_limited"),
            Some(GoalStatus::UsageLimited)
        );
    }

    #[test]
    fn test_goal_status_invalid_string() {
        assert_eq!(GoalStatus::from_str(""), None);
        assert_eq!(GoalStatus::from_str("ACTIVE"), None);
        assert_eq!(GoalStatus::from_str("active "), None);
        assert_eq!(GoalStatus::from_str("unknown"), None);
    }

    #[test]
    fn test_goal_status_display_matches_as_str() {
        for status in [
            GoalStatus::Active,
            GoalStatus::Paused,
            GoalStatus::Blocked,
            GoalStatus::Complete,
            GoalStatus::BudgetLimited,
            GoalStatus::UsageLimited,
        ] {
            assert_eq!(status.to_string(), status.as_str());
        }
    }
}
