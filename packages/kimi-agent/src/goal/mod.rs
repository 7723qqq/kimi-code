//! Goal domain pure functions, ported from the v2 goal feature
//! (`agent-core-v2/src/features/goal/`): wire types, snapshot
//! serialization, budget conversion, and reminder rendering helpers.
//!
//! The engine receives the durable goal state from the host via the state
//! bridge (`host/state_read {domain: "goal"}`), projects it into a
//! [`GoalSnapshot`] with [`to_snapshot`], and renders model-facing output
//! with [`goal_for_model`] / [`goal_result_for_model`]. Budget conversion
//! ([`normalize_budget_input`] / [`budget_limits_from_input`] /
//! [`to_milliseconds`]) mirrors the v2 SetGoalBudget tool.

use serde::{Deserialize, Serialize};

/// Goal status, mirroring v2 `GoalStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Complete,
    BudgetLimited,
    UsageLimited,
}

impl GoalStatus {
    /// The wire string for this status.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::Complete => "complete",
            Self::BudgetLimited => "budget_limited",
            Self::UsageLimited => "usage_limited",
        }
    }
}

/// Budget limits, mirroring v2 `GoalBudgetLimits` (camelCase wire fields;
/// absent limits are omitted).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalBudgetLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_budget: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_clock_budget_ms: Option<u64>,
}

/// Budget report, mirroring v2 `GoalBudgetReport` (camelCase wire fields;
/// absent budgets serialize as `null`, like the v2 `number | null` fields).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalBudgetReport {
    pub token_budget: Option<u64>,
    pub turn_budget: Option<u64>,
    pub wall_clock_budget_ms: Option<u64>,
    pub remaining_tokens: Option<u64>,
    pub remaining_turns: Option<u64>,
    pub remaining_wall_clock_ms: Option<u64>,
    pub token_budget_reached: bool,
    pub turn_budget_reached: bool,
    pub wall_clock_budget_reached: bool,
    pub over_budget: bool,
    pub input_tokens_used: u64,
    pub output_tokens_used: u64,
}

/// Durable goal state as stored by the host, mirroring v2 `GoalState` (the
/// `state_read` value for the goal domain).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub goal_id: String,
    pub objective: String,
    #[serde(default)]
    pub completion_criterion: Option<String>,
    pub status: GoalStatus,
    pub turns_used: u64,
    pub tokens_used: u64,
    pub input_tokens_used: u64,
    pub output_tokens_used: u64,
    pub wall_clock_ms: u64,
    #[serde(default)]
    pub wall_clock_resumed_at: Option<u64>,
    #[serde(default, alias = "budget")]
    pub budget_limits: GoalBudgetLimits,
    #[serde(default)]
    pub terminal_reason: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Model-facing goal snapshot, mirroring v2 `GoalSnapshot` (camelCase wire
/// fields; optional fields are omitted when absent).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSnapshot {
    pub goal_id: String,
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_criterion: Option<String>,
    pub status: GoalStatus,
    pub turns_used: u64,
    pub tokens_used: u64,
    pub input_tokens_used: u64,
    pub output_tokens_used: u64,
    pub wall_clock_ms: u64,
    pub budget: GoalBudgetReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_streak: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Project the durable state into a snapshot, mirroring v2 `toSnapshot`.
/// `wall_clock_ms` is the live wall-clock figure the caller computes (the
/// v2 runtime adds the elapsed time since the last resume for active goals).
pub fn to_snapshot(state: &GoalState, wall_clock_ms: u64) -> GoalSnapshot {
    GoalSnapshot {
        goal_id: state.goal_id.clone(),
        objective: state.objective.clone(),
        completion_criterion: state.completion_criterion.clone(),
        status: state.status,
        turns_used: state.turns_used,
        tokens_used: state.tokens_used,
        input_tokens_used: state.input_tokens_used,
        output_tokens_used: state.output_tokens_used,
        wall_clock_ms,
        budget: compute_budget_report(state, wall_clock_ms),
        terminal_reason: state.terminal_reason.clone(),
        blocked_streak: None,
        created_at: state.created_at,
        updated_at: state.updated_at,
    }
}

/// Compute the budget report, mirroring v2 `computeBudgetReport`: reached
/// flags compare usage against the limits, remaining figures saturate at 0.
pub fn compute_budget_report(state: &GoalState, wall_clock_ms: u64) -> GoalBudgetReport {
    let token_budget = state.budget_limits.token_budget;
    let turn_budget = state.budget_limits.turn_budget;
    let wall_clock_budget_ms = state.budget_limits.wall_clock_budget_ms;

    let token_budget_reached = token_budget.is_some_and(|b| state.tokens_used >= b);
    let turn_budget_reached = turn_budget.is_some_and(|b| state.turns_used >= b);
    let wall_clock_budget_reached = wall_clock_budget_ms.is_some_and(|b| wall_clock_ms >= b);

    GoalBudgetReport {
        token_budget,
        turn_budget,
        wall_clock_budget_ms,
        remaining_tokens: token_budget.map(|b| b.saturating_sub(state.tokens_used)),
        remaining_turns: turn_budget.map(|b| b.saturating_sub(state.turns_used)),
        remaining_wall_clock_ms: wall_clock_budget_ms.map(|b| b.saturating_sub(wall_clock_ms)),
        token_budget_reached,
        turn_budget_reached,
        wall_clock_budget_reached,
        over_budget: token_budget_reached || turn_budget_reached || wall_clock_budget_reached,
        input_tokens_used: state.input_tokens_used,
        output_tokens_used: state.output_tokens_used,
    }
}

/// Model-facing snapshot without `goalId`, mirroring v2
/// `Omit<GoalSnapshot, 'goalId'>` (the `goalForModel` return type).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalForModel {
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_criterion: Option<String>,
    pub status: GoalStatus,
    pub turns_used: u64,
    pub tokens_used: u64,
    pub input_tokens_used: u64,
    pub output_tokens_used: u64,
    pub wall_clock_ms: u64,
    pub budget: GoalBudgetReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_streak: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Model-facing tool result, mirroring v2 `goalResultForModel`'s return
/// shape `{goal: Omit<GoalSnapshot, 'goalId'> | null}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GoalResultForModel {
    pub goal: Option<GoalForModel>,
}

/// Strip `goalId` from a snapshot, mirroring v2 `goalForModel`.
pub fn goal_for_model(goal: &GoalSnapshot) -> GoalForModel {
    GoalForModel {
        objective: goal.objective.clone(),
        completion_criterion: goal.completion_criterion.clone(),
        status: goal.status,
        turns_used: goal.turns_used,
        tokens_used: goal.tokens_used,
        input_tokens_used: goal.input_tokens_used,
        output_tokens_used: goal.output_tokens_used,
        wall_clock_ms: goal.wall_clock_ms,
        budget: goal.budget.clone(),
        terminal_reason: goal.terminal_reason.clone(),
        blocked_streak: goal.blocked_streak,
        created_at: goal.created_at,
        updated_at: goal.updated_at,
    }
}

/// Build the model-facing tool result, mirroring v2 `goalResultForModel`.
pub fn goal_result_for_model(goal: Option<&GoalSnapshot>) -> GoalResultForModel {
    GoalResultForModel {
        goal: goal.map(goal_for_model),
    }
}

/// SetGoalBudget input unit, mirroring v2 `BUDGET_UNITS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetUnit {
    Turns,
    Tokens,
    Milliseconds,
    Seconds,
    Minutes,
    Hours,
}

impl BudgetUnit {
    /// Parse a wire unit string.
    pub fn parse_unit(s: &str) -> Option<Self> {
        match s {
            "turns" => Some(Self::Turns),
            "tokens" => Some(Self::Tokens),
            "milliseconds" => Some(Self::Milliseconds),
            "seconds" => Some(Self::Seconds),
            "minutes" => Some(Self::Minutes),
            "hours" => Some(Self::Hours),
            _ => None,
        }
    }

    /// The wire string for this unit.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turns => "turns",
            Self::Tokens => "tokens",
            Self::Milliseconds => "milliseconds",
            Self::Seconds => "seconds",
            Self::Minutes => "minutes",
            Self::Hours => "hours",
        }
    }
}

/// Smallest wall-clock budget the SetGoalBudget tool accepts (v2
/// `MIN_REASONABLE_TIME_BUDGET_MS`).
pub const MIN_REASONABLE_TIME_BUDGET_MS: u64 = 1_000;
/// Largest wall-clock budget the SetGoalBudget tool accepts (v2
/// `MAX_REASONABLE_TIME_BUDGET_MS`).
pub const MAX_REASONABLE_TIME_BUDGET_MS: u64 = 24 * 60 * 60 * 1000;

/// Normalize a budget input value, mirroring v2 `normalizeBudgetInput`:
/// turn/token budgets round to whole numbers and floor at 1; time units
/// pass through unchanged. Input must be finite (the tool schema rejects
/// NaN/Infinity upstream).
pub fn normalize_budget_input(value: f64, unit: BudgetUnit) -> f64 {
    match unit {
        BudgetUnit::Turns | BudgetUnit::Tokens => value.round().max(1.0),
        BudgetUnit::Milliseconds
        | BudgetUnit::Seconds
        | BudgetUnit::Minutes
        | BudgetUnit::Hours => value,
    }
}

/// Convert a time-unit value to milliseconds, mirroring v2 `toMilliseconds`.
/// Returns `None` for turn/token units, which never reach this helper.
pub fn to_milliseconds(value: f64, unit: BudgetUnit) -> Option<f64> {
    match unit {
        BudgetUnit::Milliseconds => Some(value),
        BudgetUnit::Seconds => Some(value * 1000.0),
        BudgetUnit::Minutes => Some(value * 60.0 * 1000.0),
        BudgetUnit::Hours => Some(value * 60.0 * 60.0 * 1000.0),
        BudgetUnit::Turns | BudgetUnit::Tokens => None,
    }
}

/// Convert a normalized budget input into budget limits, mirroring v2
/// `budgetLimitsFromInput`. Wall-clock budgets outside the reasonable
/// window (1s..24h) yield `None`.
pub fn budget_limits_from_input(value: f64, unit: BudgetUnit) -> Option<GoalBudgetLimits> {
    match unit {
        BudgetUnit::Turns => Some(GoalBudgetLimits {
            turn_budget: Some(value as u64),
            ..GoalBudgetLimits::default()
        }),
        BudgetUnit::Tokens => Some(GoalBudgetLimits {
            token_budget: Some(value as u64),
            ..GoalBudgetLimits::default()
        }),
        BudgetUnit::Milliseconds
        | BudgetUnit::Seconds
        | BudgetUnit::Minutes
        | BudgetUnit::Hours => {
            let wall_clock_budget_ms = to_milliseconds(value, unit)?.round();
            if wall_clock_budget_ms < MIN_REASONABLE_TIME_BUDGET_MS as f64
                || wall_clock_budget_ms > MAX_REASONABLE_TIME_BUDGET_MS as f64
            {
                return None;
            }
            Some(GoalBudgetLimits {
                wall_clock_budget_ms: Some(wall_clock_budget_ms as u64),
                ..GoalBudgetLimits::default()
            })
        }
    }
}

/// Render a budget value with its unit, mirroring v2 `formatBudget`
/// (singular unit when the value is exactly 1).
pub fn format_budget(value: f64, unit: BudgetUnit) -> String {
    let unit_str = unit.as_str();
    let singular = unit_str.strip_suffix('s').unwrap_or(unit_str);
    if value == 1.0 {
        format!("{value} {singular}")
    } else {
        format!("{value} {unit_str}")
    }
}

/// Format an elapsed duration, mirroring v2 `formatElapsed` (`42s`,
/// `3m05s`, `1h02m`).
pub fn format_elapsed(ms: u64) -> String {
    let total_seconds = (ms as f64 / 1000.0).round() as u64;
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    if minutes < 60 {
        return format!("{minutes}m{seconds:02}s");
    }
    let hours = minutes / 60;
    format!("{hours}h{:02}m", minutes % 60)
}

/// Render the budget lines of a goal reminder, mirroring v2 `formatBudgets`
/// (`turns 3/10 (remaining 7); tokens ...; time ...`).
pub fn format_budgets(goal: &GoalSnapshot) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(turn_budget) = goal.budget.turn_budget {
        lines.push(format!(
            "turns {}/{} (remaining {})",
            goal.turns_used,
            turn_budget,
            goal.budget.remaining_turns.unwrap_or(0)
        ));
    }
    if let Some(token_budget) = goal.budget.token_budget {
        lines.push(format!(
            "tokens {}/{} (remaining {})",
            goal.tokens_used,
            token_budget,
            goal.budget.remaining_tokens.unwrap_or(0)
        ));
    }
    if let Some(wall_clock_budget_ms) = goal.budget.wall_clock_budget_ms {
        lines.push(format!(
            "time {}/{} (remaining {})",
            format_elapsed(goal.wall_clock_ms),
            format_elapsed(wall_clock_budget_ms),
            format_elapsed(goal.budget.remaining_wall_clock_ms.unwrap_or(0))
        ));
    }
    lines.join("; ")
}

/// Maximum fraction of any budget consumed, mirroring v2 `maxBudgetFraction`
/// (0 when no budget is set).
pub fn max_budget_fraction(goal: &GoalSnapshot) -> f64 {
    let mut fractions: Vec<f64> = Vec::new();
    if let Some(budget) = goal.budget.turn_budget.filter(|b| *b > 0) {
        fractions.push(goal.turns_used as f64 / budget as f64);
    }
    if let Some(budget) = goal.budget.token_budget.filter(|b| *b > 0) {
        fractions.push(goal.tokens_used as f64 / budget as f64);
    }
    if let Some(budget) = goal.budget.wall_clock_budget_ms.filter(|b| *b > 0) {
        fractions.push(goal.wall_clock_ms as f64 / budget as f64);
    }
    fractions.into_iter().fold(0.0, f64::max)
}

/// Whether the goal is nearing any budget (>= 75% consumed), mirroring v2
/// `isNearingBudget`.
pub fn is_nearing_budget(goal: &GoalSnapshot) -> bool {
    max_budget_fraction(goal) >= 0.75
}

/// Escape untrusted goal text for reminder templates, mirroring v2
/// `escapeUntrustedText` (`&`, `<`, `>`).
pub fn escape_untrusted_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Render the terminal-reason suffix of a reminder, mirroring v2
/// `reasonSuffix` (empty when no reason).
pub fn reason_suffix(goal: &GoalSnapshot) -> String {
    match goal.terminal_reason.as_deref() {
        Some(reason) => format!(" ({})", escape_untrusted_text(reason)),
        None => String::new(),
    }
}

/// Render the completion-criterion block of a reminder, mirroring v2
/// `completionCriterionBlock` (empty when no criterion).
pub fn completion_criterion_block(goal: &GoalSnapshot) -> String {
    match goal.completion_criterion.as_deref() {
        Some(criterion) => format!(
            "<untrusted_completion_criterion>\n{}\n</untrusted_completion_criterion>\n",
            escape_untrusted_text(criterion)
        ),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_state() -> GoalState {
        GoalState {
            goal_id: "goal-1".into(),
            objective: "Ship the feature".into(),
            completion_criterion: Some("Tests pass".into()),
            status: GoalStatus::Active,
            turns_used: 3,
            tokens_used: 100,
            input_tokens_used: 60,
            output_tokens_used: 40,
            wall_clock_ms: 42_000,
            wall_clock_resumed_at: None,
            budget_limits: GoalBudgetLimits {
                token_budget: Some(500),
                turn_budget: Some(10),
                wall_clock_budget_ms: Some(3_600_000),
            },
            terminal_reason: None,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_042_000,
        }
    }

    #[test]
    fn test_normalize_budget_input() {
        assert_eq!(normalize_budget_input(2.6, BudgetUnit::Turns), 3.0);
        assert_eq!(normalize_budget_input(0.4, BudgetUnit::Turns), 1.0);
        assert_eq!(normalize_budget_input(-5.0, BudgetUnit::Tokens), 1.0);
        assert_eq!(normalize_budget_input(2.5, BudgetUnit::Milliseconds), 2.5);
        assert_eq!(normalize_budget_input(1.5, BudgetUnit::Hours), 1.5);
    }

    #[test]
    fn test_to_milliseconds() {
        assert_eq!(
            to_milliseconds(1_000.0, BudgetUnit::Milliseconds),
            Some(1_000.0)
        );
        assert_eq!(to_milliseconds(2.0, BudgetUnit::Seconds), Some(2_000.0));
        assert_eq!(to_milliseconds(1.5, BudgetUnit::Minutes), Some(90_000.0));
        assert_eq!(to_milliseconds(2.0, BudgetUnit::Hours), Some(7_200_000.0));
        assert_eq!(to_milliseconds(1.0, BudgetUnit::Turns), None);
        assert_eq!(to_milliseconds(1.0, BudgetUnit::Tokens), None);
    }

    #[test]
    fn test_budget_limits_from_input() {
        let turns = budget_limits_from_input(5.0, BudgetUnit::Turns).unwrap();
        assert_eq!(turns.turn_budget, Some(5));
        assert_eq!(turns.token_budget, None);
        assert_eq!(turns.wall_clock_budget_ms, None);

        let tokens = budget_limits_from_input(500.0, BudgetUnit::Tokens).unwrap();
        assert_eq!(tokens.token_budget, Some(500));
        assert_eq!(tokens.turn_budget, None);

        let seconds = budget_limits_from_input(30.0, BudgetUnit::Seconds).unwrap();
        assert_eq!(seconds.wall_clock_budget_ms, Some(30_000));
        assert_eq!(seconds.token_budget, None);

        let half_hour = budget_limits_from_input(0.5, BudgetUnit::Hours).unwrap();
        assert_eq!(half_hour.wall_clock_budget_ms, Some(1_800_000));

        assert_eq!(budget_limits_from_input(0.9, BudgetUnit::Seconds), None);
        assert_eq!(budget_limits_from_input(25.0, BudgetUnit::Hours), None);
        assert_eq!(
            budget_limits_from_input(1.0, BudgetUnit::Seconds)
                .unwrap()
                .wall_clock_budget_ms,
            Some(1_000)
        );
        assert_eq!(
            budget_limits_from_input(24.0, BudgetUnit::Hours)
                .unwrap()
                .wall_clock_budget_ms,
            Some(86_400_000)
        );
    }

    #[test]
    fn test_format_budget() {
        assert_eq!(format_budget(1.0, BudgetUnit::Turns), "1 turn");
        assert_eq!(format_budget(2.0, BudgetUnit::Turns), "2 turns");
        assert_eq!(format_budget(1.0, BudgetUnit::Hours), "1 hour");
        assert_eq!(format_budget(2.0, BudgetUnit::Hours), "2 hours");
        assert_eq!(format_budget(1.5, BudgetUnit::Hours), "1.5 hours");
        assert_eq!(format_budget(1.0, BudgetUnit::Tokens), "1 token");
        assert_eq!(
            format_budget(1.0, BudgetUnit::Milliseconds),
            "1 millisecond"
        );
    }

    #[test]
    fn test_goal_state_deserializes_wire_shape() {
        let raw = json!({
            "goalId": "goal-1",
            "objective": "Ship the feature",
            "completionCriterion": "Tests pass",
            "status": "active",
            "turnsUsed": 3,
            "tokensUsed": 100,
            "inputTokensUsed": 60,
            "outputTokensUsed": 40,
            "wallClockMs": 42000,
            "budgetLimits": { "tokenBudget": 500, "turnBudget": 10, "wallClockBudgetMs": 3600000 },
            "createdAt": 1700000000000u64,
            "updatedAt": 1700000042000u64
        });
        let state: GoalState = serde_json::from_value(raw).unwrap();
        assert_eq!(state.goal_id, "goal-1");
        assert_eq!(state.status, GoalStatus::Active);
        assert_eq!(state.budget_limits.token_budget, Some(500));
        assert_eq!(state.budget_limits.turn_budget, Some(10));
        assert_eq!(state.budget_limits.wall_clock_budget_ms, Some(3_600_000));
        assert_eq!(state.wall_clock_resumed_at, None);
        assert_eq!(state.terminal_reason, None);
    }

    #[test]
    fn test_goal_state_minimal_defaults() {
        let raw = json!({
            "goalId": "goal-2",
            "objective": "Minimal",
            "status": "blocked",
            "turnsUsed": 0,
            "tokensUsed": 0,
            "inputTokensUsed": 0,
            "outputTokensUsed": 0,
            "wallClockMs": 0,
            "createdAt": 0,
            "updatedAt": 0
        });
        let state: GoalState = serde_json::from_value(raw).unwrap();
        assert_eq!(state.completion_criterion, None);
        assert_eq!(state.budget_limits, GoalBudgetLimits::default());
        assert_eq!(state.status, GoalStatus::Blocked);
    }

    #[test]
    fn test_goal_state_round_trip() {
        let state = sample_state();
        let wire = serde_json::to_value(&state).unwrap();
        let back: GoalState = serde_json::from_value(wire).unwrap();
        assert_eq!(back, state);
    }

    #[test]
    fn test_budget_limits_wire_shape() {
        let limits = GoalBudgetLimits {
            token_budget: Some(500),
            ..GoalBudgetLimits::default()
        };
        let value = serde_json::to_value(limits).unwrap();
        assert_eq!(value, json!({ "tokenBudget": 500 }));
        assert!(value.get("turnBudget").is_none());
        assert!(value.get("wallClockBudgetMs").is_none());
    }

    #[test]
    fn test_snapshot_serializes_wire_shape() {
        let snapshot = to_snapshot(&sample_state(), 42_000);
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert_eq!(
            wire,
            r#"{"goalId":"goal-1","objective":"Ship the feature","completionCriterion":"Tests pass","status":"active","turnsUsed":3,"tokensUsed":100,"inputTokensUsed":60,"outputTokensUsed":40,"wallClockMs":42000,"budget":{"tokenBudget":500,"turnBudget":10,"wallClockBudgetMs":3600000,"remainingTokens":400,"remainingTurns":7,"remainingWallClockMs":3558000,"tokenBudgetReached":false,"turnBudgetReached":false,"wallClockBudgetReached":false,"overBudget":false,"inputTokensUsed":60,"outputTokensUsed":40},"createdAt":1700000000000,"updatedAt":1700000042000}"#
        );
    }

    #[test]
    fn test_snapshot_omits_absent_optionals() {
        let mut state = sample_state();
        state.completion_criterion = None;
        state.terminal_reason = Some("Blocked after goal budget reached".into());
        let snapshot = to_snapshot(&state, 42_000);
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(!wire.contains("completionCriterion"));
        assert!(wire.contains(r#""terminalReason":"Blocked after goal budget reached""#));
        assert!(!wire.contains("blockedStreak"));
    }

    #[test]
    fn test_budget_report_over_budget_and_saturating() {
        let mut state = sample_state();
        state.tokens_used = 600;
        state.turns_used = 10;
        let report = compute_budget_report(&state, 3_700_000);
        assert!(report.token_budget_reached);
        assert!(report.turn_budget_reached);
        assert!(report.wall_clock_budget_reached);
        assert!(report.over_budget);
        assert_eq!(report.remaining_tokens, Some(0));
        assert_eq!(report.remaining_turns, Some(0));
        assert_eq!(report.remaining_wall_clock_ms, Some(0));
    }

    #[test]
    fn test_budget_report_without_limits() {
        let mut state = sample_state();
        state.budget_limits = GoalBudgetLimits::default();
        let report = compute_budget_report(&state, 42_000);
        assert_eq!(report.token_budget, None);
        assert_eq!(report.turn_budget, None);
        assert_eq!(report.wall_clock_budget_ms, None);
        assert_eq!(report.remaining_tokens, None);
        assert!(!report.over_budget);
    }

    #[test]
    fn test_goal_for_model_strips_goal_id() {
        let snapshot = to_snapshot(&sample_state(), 42_000);
        let for_model = goal_for_model(&snapshot);
        let value = serde_json::to_value(&for_model).unwrap();
        assert!(value.get("goalId").is_none());
        assert_eq!(value["objective"], "Ship the feature");
        assert_eq!(value["status"], "active");
        assert_eq!(value["budget"]["tokenBudget"], 500);
    }

    #[test]
    fn test_goal_result_for_model() {
        let snapshot = to_snapshot(&sample_state(), 42_000);
        let result = goal_result_for_model(Some(&snapshot));
        let value = serde_json::to_value(&result).unwrap();
        assert!(value["goal"].get("goalId").is_none());
        assert_eq!(value["goal"]["objective"], "Ship the feature");

        let none = goal_result_for_model(None);
        let value = serde_json::to_value(&none).unwrap();
        assert_eq!(value, json!({ "goal": null }));
    }

    #[test]
    fn test_format_elapsed() {
        assert_eq!(format_elapsed(0), "0s");
        assert_eq!(format_elapsed(42_000), "42s");
        assert_eq!(format_elapsed(59_999), "1m00s");
        assert_eq!(format_elapsed(185_000), "3m05s");
        assert_eq!(format_elapsed(3_600_000), "1h00m");
        assert_eq!(format_elapsed(3_723_000), "1h02m");
    }

    #[test]
    fn test_format_budgets() {
        let snapshot = to_snapshot(&sample_state(), 42_000);
        assert_eq!(
            format_budgets(&snapshot),
            "turns 3/10 (remaining 7); tokens 100/500 (remaining 400); time 42s/1h00m (remaining 59m18s)"
        );
        let mut no_budgets = sample_state();
        no_budgets.budget_limits = GoalBudgetLimits::default();
        assert_eq!(format_budgets(&to_snapshot(&no_budgets, 0)), "");
    }

    #[test]
    fn test_max_budget_fraction_and_nearing() {
        let state = sample_state();
        assert!(!is_nearing_budget(&to_snapshot(&state, 42_000)));

        let mut state = sample_state();
        state.turns_used = 8;
        assert!(is_nearing_budget(&to_snapshot(&state, 42_000)));

        let mut state = sample_state();
        state.tokens_used = 375;
        let snapshot = to_snapshot(&state, 42_000);
        assert!((max_budget_fraction(&snapshot) - 0.75).abs() < 1e-9);
        assert!(is_nearing_budget(&snapshot));

        let mut state = sample_state();
        state.budget_limits = GoalBudgetLimits::default();
        assert_eq!(max_budget_fraction(&to_snapshot(&state, 42_000)), 0.0);
        assert!(!is_nearing_budget(&to_snapshot(&state, 42_000)));
    }

    #[test]
    fn test_escape_and_reminder_fragments() {
        assert_eq!(escape_untrusted_text("<a & b>"), "&lt;a &amp; b&gt;");

        let snapshot = to_snapshot(&sample_state(), 42_000);
        assert_eq!(
            completion_criterion_block(&snapshot),
            "<untrusted_completion_criterion>\nTests pass\n</untrusted_completion_criterion>\n"
        );
        assert_eq!(reason_suffix(&snapshot), "");

        let mut state = sample_state();
        state.terminal_reason = Some("Blocked after goal budget reached".into());
        let snapshot = to_snapshot(&state, 42_000);
        assert_eq!(
            reason_suffix(&snapshot),
            " (Blocked after goal budget reached)"
        );

        let mut state = sample_state();
        state.completion_criterion = None;
        assert_eq!(completion_criterion_block(&to_snapshot(&state, 42_000)), "");
    }
}
