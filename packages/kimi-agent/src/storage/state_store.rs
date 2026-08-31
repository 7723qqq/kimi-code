//! Local JSON state storage for the standalone REPL (P32 批 1).
//!
//! Provides per-domain durable state under `<workspace>/.kimi/state/` with
//! one JSON file per domain (`todo.json` / `plan.json` / `goal.json` /
//! `cron.json` / `task.json`). Writes are atomic (tmp file + rename).
//!
//! Wire shapes align with the v2 state bridge domains: todo = `TodoItem[]`
//! (full replacement), plan = `{active, id?, path?}`, goal =
//! `{goal: <snapshot> | null}`, cron = entry list, task = task list. The
//! action-shaped writes the engine submits (goal `create`/`update`/
//! `set_budget`, cron `create`/`delete`, task `stop`/`wait`) are applied
//! here with the v2 domain semantics, so the ported native tools render
//! their v2-aligned output against the local store.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};

use crate::goal::{GoalBudgetLimits, GoalState, GoalStatus, to_snapshot};

/// The five state domains the REPL persists locally.
pub const STATE_DOMAINS: [&str; 5] = ["todo", "plan", "goal", "cron", "task"];

/// The result of applying a domain write: the value to persist and the
/// value to return to the caller (the v2 host response value). They differ
/// for the action-shaped domains — cron create returns the created entry
/// while the stored value is the full list, task stop returns the stopped
/// entry — mirroring the v2 `state_write` adapter.
#[derive(Debug)]
pub struct StateWriteOutcome {
    pub stored: Value,
    pub response: Value,
}

/// Local per-domain JSON state store.
/// A full snapshot of every state domain, taken at a turn checkpoint.
/// `None` means the domain had no stored value at snapshot time (rollback
/// clears it back to absent).
type StateSnapshot = Vec<(&'static str, Option<Value>)>;

pub struct StateStore {
    state_dir: PathBuf,
    /// Undo checkpoint stack (v2 undo-anchor semantics): one full snapshot
    /// per turn, popped by `rollback()`. In-memory only — checkpoints do
    /// not survive a restart.
    checkpoints: Mutex<Vec<StateSnapshot>>,
}

impl StateStore {
    /// Create (or open) the state store for a workspace:
    /// `<workspace>/.kimi/state/`.
    pub fn for_workspace(workspace_root: &Path) -> std::io::Result<Self> {
        let state_dir = workspace_root.join(".kimi").join("state");
        fs::create_dir_all(&state_dir)?;
        Ok(Self {
            state_dir,
            checkpoints: Mutex::new(Vec::new()),
        })
    }

    /// Snapshot every domain (v2 undo-anchor checkpoint). A file that
    /// exists but fails to read/parse is an error, not an absent domain —
    /// rolling back must never silently wipe data.
    pub fn checkpoint(&self) -> Result<(), String> {
        let mut snapshot = Vec::with_capacity(STATE_DOMAINS.len());
        for domain in STATE_DOMAINS {
            let path = self.domain_file(domain);
            let value = if path.as_deref().is_some_and(|p| p.is_file()) {
                let content = fs::read_to_string(path.as_deref().unwrap())
                    .map_err(|e| format!("checkpoint read {domain}: {e}"))?;
                Some(
                    serde_json::from_str(&content)
                        .map_err(|e| format!("checkpoint parse {domain}: {e}"))?,
                )
            } else {
                None
            };
            snapshot.push((domain, value));
        }
        self.checkpoints
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(snapshot);
        Ok(())
    }

    /// Restore the most recent checkpoint. Returns `Ok(false)` when there
    /// is nothing to undo.
    pub fn rollback(&self) -> Result<bool, String> {
        let snapshot = self
            .checkpoints
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop();
        let Some(snapshot) = snapshot else {
            return Ok(false);
        };
        for (domain, value) in snapshot {
            match value {
                Some(v) => {
                    self.write_domain(domain, &v)?;
                }
                None => {
                    self.clear_domain(domain)?;
                }
            }
        }
        Ok(true)
    }

    /// How many checkpoints are pending (v2 `checkpointDepth`).
    pub fn checkpoint_depth(&self) -> usize {
        self.checkpoints
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// The state directory (`<workspace>/.kimi/state`).
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    fn domain_file(&self, domain: &str) -> Option<PathBuf> {
        STATE_DOMAINS
            .contains(&domain)
            .then(|| self.state_dir.join(format!("{domain}.json")))
    }

    /// Read a domain's stored value; `None` when the domain is unknown or
    /// has no stored state yet.
    pub fn read_domain(&self, domain: &str) -> Option<Value> {
        let path = self.domain_file(domain)?;
        if !path.is_file() {
            return None;
        }
        let content = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// Write a domain's value atomically (tmp file + rename, so a crash
    /// mid-write never leaves a truncated domain file behind).
    pub fn write_domain(&self, domain: &str, value: &Value) -> Result<(), String> {
        let path = self
            .domain_file(domain)
            .ok_or_else(|| format!("unknown state domain: {domain}"))?;
        let json = serde_json::to_string_pretty(value)
            .map_err(|e| format!("serialize {domain} state: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        let mut file = fs::File::create(&tmp).map_err(|e| format!("create tmp file: {e}"))?;
        file.write_all(json.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("write tmp file: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("rename tmp file: {e}"))?;
        Ok(())
    }

    /// Remove a domain's stored state.
    pub fn clear_domain(&self, domain: &str) -> Result<(), String> {
        let path = self
            .domain_file(domain)
            .ok_or_else(|| format!("unknown state domain: {domain}"))?;
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("remove {domain} state: {e}"))?;
        }
        Ok(())
    }

    /// The v2-aligned default wire value for a domain with no stored state.
    pub fn default_value(domain: &str) -> Option<Value> {
        match domain {
            "todo" => Some(json!([])),
            "plan" => Some(json!({ "active": false })),
            "goal" => Some(json!({ "goal": null })),
            "cron" => Some(json!([])),
            "task" => Some(json!([])),
            _ => None,
        }
    }

    /// Read a domain's state through the bridge protocol: the stored value,
    /// the domain default when none is stored, or a `-32001` error for an
    /// unknown domain. The task domain reads a single task's entry when
    /// `key` is a task id (TaskOutput) and the full list when `key ==
    /// "task"` (TaskList); an unknown task id is a `-32002` error.
    pub fn read_state(&self, domain: &str, key: &str) -> Result<Value, String> {
        if domain == "task" && key != "task" {
            let tasks = self
                .read_domain("task")
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            return tasks
                .iter()
                .find(|t| t.get("taskId").and_then(|i| i.as_str()) == Some(key))
                .cloned()
                .ok_or_else(|| format!("State read error: [-32002] Task not found: {key}"));
        }
        match self.read_domain(domain) {
            Some(value) => Ok(value),
            None => Self::default_value(domain).ok_or_else(|| {
                format!("State read error: [-32001] unknown state domain: {domain}")
            }),
        }
    }

    /// Apply the v2 domain write semantics to `value` and return the
    /// post-write outcome (the caller persists `stored` and returns
    /// `response`). Unknown domains are `-32001` errors; invalid values and
    /// rejected writes carry the v2 `-32003` / `-32004` codes so the
    /// engine's error mapping stays intact.
    pub fn apply_write(&self, domain: &str, value: &Value) -> Result<StateWriteOutcome, String> {
        match domain {
            "todo" => {
                if !value.is_array() {
                    return Err(
                        "State write error: [-32003] invalid todo state value: expected an array of todo items".into(),
                    );
                }
                Ok(StateWriteOutcome {
                    stored: value.clone(),
                    response: value.clone(),
                })
            }
            "plan" => self.apply_plan_write(value),
            "goal" => self.apply_goal_write(value),
            "cron" => self.apply_cron_write(value),
            "task" => self.apply_task_write(value),
            _ => Err(format!(
                "State write error: [-32001] unknown state domain: {domain}"
            )),
        }
    }

    fn apply_plan_write(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(active) = value.get("active").and_then(|v| v.as_bool()) else {
            return Err(
                "State write error: [-32003] invalid plan state value: expected { active: boolean }"
                    .into(),
            );
        };
        if !active {
            let stored = json!({ "active": false });
            return Ok(StateWriteOutcome {
                stored: stored.clone(),
                response: stored,
            });
        }
        // Enter: the host generates the plan id and file path (v2
        // `PlanModeEnter`); an already-active plan rejects the write.
        let already_active = self
            .read_domain("plan")
            .and_then(|p| p.get("active").and_then(|v| v.as_bool()))
            == Some(true);
        if already_active {
            return Err("State write error: [-32004] plan mode is already active".into());
        }
        let id = format!("plan-{:016x}", fastrand::u64(..));
        let plans_dir = self
            .state_dir
            .parent()
            .unwrap_or(&self.state_dir)
            .join("plans");
        fs::create_dir_all(&plans_dir)
            .map_err(|e| format!("create plan directory {}: {e}", plans_dir.display()))?;
        let path = plans_dir.join(format!("{id}.md"));
        let stored = json!({
            "active": true,
            "id": id,
            "path": path.to_string_lossy(),
        });
        Ok(StateWriteOutcome {
            stored: stored.clone(),
            response: stored,
        })
    }

    fn apply_goal_write(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(action) = value.get("action").and_then(|a| a.as_str()) else {
            return Err(
                "State write error: [-32003] invalid goal state value: expected { action: \"create\" | \"update\" | \"set_budget\", ... }".into(),
            );
        };
        match action {
            "create" => self.goal_create(value),
            "update" => self.goal_update(value),
            "set_budget" => self.goal_set_budget(value),
            _ => Err(format!(
                "State write error: [-32003] invalid goal action: {action}"
            )),
        }
    }

    fn goal_create(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(objective) = value.get("objective").and_then(|o| o.as_str()) else {
            return Err(
                "State write error: [-32003] invalid goal create value: expected { action: \"create\", objective: string, completion_criterion?: string }".into(),
            );
        };
        if self.read_goal_state().is_some() {
            return Err(
                "State write error: [-32004] A goal already exists; use replace to start a new one"
                    .into(),
            );
        }
        let now = now_ms();
        let state = GoalState {
            goal_id: format!("goal-{:016x}", fastrand::u64(..)),
            objective: objective.to_string(),
            completion_criterion: value
                .get("completion_criterion")
                .and_then(|c| c.as_str())
                .map(str::to_string),
            status: GoalStatus::Active,
            turns_used: 0,
            tokens_used: 0,
            input_tokens_used: 0,
            output_tokens_used: 0,
            wall_clock_ms: 0,
            wall_clock_resumed_at: Some(now),
            budget_limits: GoalBudgetLimits::default(),
            terminal_reason: None,
            created_at: now,
            updated_at: now,
        };
        Ok(goal_outcome(&state, now))
    }

    fn goal_update(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(status) = value.get("status").and_then(|s| s.as_str()) else {
            return Err(
                "State write error: [-32003] invalid goal update value: expected { action: \"update\", status: \"active\" | \"complete\" | \"blocked\" }".into(),
            );
        };
        if !matches!(status, "active" | "complete" | "blocked") {
            return Err(
                "State write error: [-32003] Invalid goal status. Use `active`, `complete`, or `blocked`.".into(),
            );
        }
        let Some(mut state) = self.read_goal_state() else {
            let message = match status {
                "active" => "No current goal",
                "complete" => "Goal not completed: no active goal.",
                _ => "Goal not blocked: no active goal.",
            };
            return Err(format!("State write error: [-32004] {message}"));
        };
        let now = now_ms();
        match status {
            "active" => {
                if state.status == GoalStatus::Active {
                    return Ok(goal_outcome(&state, now));
                }
                if !matches!(state.status, GoalStatus::Paused | GoalStatus::Blocked) {
                    return Err(format!(
                        "State write error: [-32004] Cannot resume a goal in status \"{}\"",
                        state.status.as_str()
                    ));
                }
                state.status = GoalStatus::Active;
                state.wall_clock_resumed_at = Some(now);
            }
            "complete" => {
                if state.status != GoalStatus::Active {
                    return Err(
                        "State write error: [-32004] Goal not completed: no active goal.".into(),
                    );
                }
                settle_wall_clock(&mut state, now);
                state.status = GoalStatus::Complete;
                state.terminal_reason = None;
            }
            _ => {
                if state.status != GoalStatus::Active {
                    return Err(
                        "State write error: [-32004] Goal not blocked: no active goal.".into(),
                    );
                }
                settle_wall_clock(&mut state, now);
                state.status = GoalStatus::Blocked;
                state.terminal_reason = None;
            }
        }
        state.updated_at = now;
        Ok(goal_outcome(&state, now))
    }

    fn goal_set_budget(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(budget_value) = value.get("value").and_then(|v| v.as_f64()) else {
            return Err(
                "State write error: [-32003] invalid goal set_budget value: expected { action: \"set_budget\", value: number, unit: string }".into(),
            );
        };
        let Some(unit_str) = value.get("unit").and_then(|u| u.as_str()) else {
            return Err(
                "State write error: [-32003] invalid goal set_budget value: expected { action: \"set_budget\", value: number, unit: string }".into(),
            );
        };
        let Some(unit) = crate::goal::BudgetUnit::parse_unit(unit_str) else {
            return Err(
                "State write error: [-32003] invalid goal set_budget value: unit must be one of turns, tokens, milliseconds, seconds, minutes, hours".into(),
            );
        };
        let Some(limits) = crate::goal::budget_limits_from_input(budget_value, unit) else {
            return Err(format!(
                "State write error: [-32003] Goal budget not set: {} is not a reasonable goal budget.",
                crate::goal::format_budget(budget_value, unit)
            ));
        };
        let Some(mut state) = self.read_goal_state() else {
            return Err("State write error: [-32004] No current goal".into());
        };
        // v2 merges the new limit into the existing limits.
        if limits.token_budget.is_some() {
            state.budget_limits.token_budget = limits.token_budget;
        }
        if limits.turn_budget.is_some() {
            state.budget_limits.turn_budget = limits.turn_budget;
        }
        if limits.wall_clock_budget_ms.is_some() {
            state.budget_limits.wall_clock_budget_ms = limits.wall_clock_budget_ms;
        }
        let now = now_ms();
        state.updated_at = now;
        Ok(goal_outcome(&state, now))
    }

    fn apply_cron_write(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(action) = value.get("action").and_then(|a| a.as_str()) else {
            return Err(
                "State write error: [-32003] invalid cron state value: expected { action: \"create\" | \"delete\", ... }".into(),
            );
        };
        match action {
            "create" => self.cron_create(value),
            "delete" => self.cron_delete(value),
            _ => Err(format!(
                "State write error: [-32003] invalid cron action: {action}"
            )),
        }
    }

    fn cron_create(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(cron) = value.get("cron").and_then(|c| c.as_str()) else {
            return Err(
                "State write error: [-32003] invalid cron create value: expected { action: \"create\", cron: string, prompt: string, recurring?: boolean }".into(),
            );
        };
        let Some(prompt) = value.get("prompt").and_then(|p| p.as_str()) else {
            return Err(
                "State write error: [-32003] invalid cron create value: expected { action: \"create\", cron: string, prompt: string, recurring?: boolean }".into(),
            );
        };
        let recurring = value
            .get("recurring")
            .and_then(|r| r.as_bool())
            .unwrap_or(true);
        let mut entries = self
            .read_domain("cron")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        // No scheduler in the REPL yet, so `nextFireAt` stays null (the
        // renderers show "null") and `stale` is always false.
        let entry = json!({
            "id": ulid(),
            "cron": cron,
            "prompt": prompt,
            "createdAt": now_ms(),
            "recurring": recurring,
            "nextFireAt": null,
            "stale": false,
        });
        entries.push(entry.clone());
        Ok(StateWriteOutcome {
            stored: Value::Array(entries),
            response: entry,
        })
    }

    fn cron_delete(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(id) = value.get("id").and_then(|i| i.as_str()) else {
            return Err(
                "State write error: [-32003] invalid cron delete value: expected { action: \"delete\", id: string }".into(),
            );
        };
        let mut entries = self
            .read_domain("cron")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let before = entries.len();
        entries.retain(|entry| entry.get("id").and_then(|i| i.as_str()) != Some(id));
        if entries.len() == before {
            return Err(format!(
                "State write error: [-32004] No cron job with id {id}."
            ));
        }
        let stored = Value::Array(entries);
        Ok(StateWriteOutcome {
            stored: stored.clone(),
            response: stored,
        })
    }

    fn apply_task_write(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(action) = value.get("action").and_then(|a| a.as_str()) else {
            return Err(
                "State write error: [-32003] invalid task state value: expected { action: \"stop\" | \"wait\", ... }".into(),
            );
        };
        match action {
            "stop" => self.task_stop(value),
            "wait" => self.task_wait(value),
            _ => Err(format!(
                "State write error: [-32003] invalid task action: {action}"
            )),
        }
    }

    fn task_stop(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(id) = value.get("id").and_then(|i| i.as_str()) else {
            return Err(
                "State write error: [-32003] invalid task stop value: expected { action: \"stop\", id: string }".into(),
            );
        };
        let mut tasks = self
            .read_domain("task")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let Some(index) = tasks
            .iter()
            .position(|t| t.get("taskId").and_then(|i| i.as_str()) == Some(id))
        else {
            return Err(format!("State write error: [-32002] Task not found: {id}"));
        };
        let mut entry = tasks[index].clone();
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("status".into(), json!("killed"));
            obj.insert("stopReason".into(), json!("Stopped by TaskStop"));
            obj.insert("endedAt".into(), json!(now_ms()));
        }
        tasks[index] = entry.clone();
        Ok(StateWriteOutcome {
            stored: Value::Array(tasks),
            response: entry,
        })
    }

    fn task_wait(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let Some(id) = value.get("id").and_then(|i| i.as_str()) else {
            return Err(
                "State write error: [-32003] invalid task wait value: expected { action: \"wait\", id: string, timeout_ms?: number }".into(),
            );
        };
        let tasks = self
            .read_domain("task")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let Some(entry) = tasks
            .iter()
            .find(|t| t.get("taskId").and_then(|i| i.as_str()) == Some(id))
            .cloned()
        else {
            return Err(format!("State write error: [-32002] Task not found: {id}"));
        };
        // The REPL has no background task runner yet: a terminal task
        // reports completion, anything else reports the v2 wait outcome for
        // a still-running task (an immediate timeout report).
        Ok(StateWriteOutcome {
            stored: Value::Array(tasks),
            response: entry,
        })
    }

    fn read_goal_state(&self) -> Option<GoalState> {
        let goal = self.read_domain("goal")?.get("goal")?.clone();
        if goal.is_null() {
            return None;
        }
        serde_json::from_value(goal).ok()
    }
}

/// The stored goal domain value `{goal: <snapshot> | null}` with the live
/// wall-clock figure for active goals.
fn goal_outcome(state: &GoalState, now_ms: u64) -> StateWriteOutcome {
    let snapshot = to_snapshot(state, live_wall_clock_ms(state, now_ms));
    let stored = json!({ "goal": serde_json::to_value(&snapshot).unwrap_or(Value::Null) });
    StateWriteOutcome {
        stored: stored.clone(),
        response: stored,
    }
}

/// The live wall-clock figure for an active goal: the stored elapsed time
/// plus the time since the last resume (v2 `toSnapshot` semantics).
fn live_wall_clock_ms(state: &GoalState, now_ms: u64) -> u64 {
    if state.status == GoalStatus::Active
        && let Some(resumed_at) = state.wall_clock_resumed_at
    {
        return state.wall_clock_ms + now_ms.saturating_sub(resumed_at);
    }
    state.wall_clock_ms
}

/// Fold the elapsed time since the last resume into `wall_clock_ms` and
/// clear the resume anchor (v2 `settleWallClock` on lifecycle transitions).
fn settle_wall_clock(state: &mut GoalState, now_ms: u64) {
    state.wall_clock_ms = live_wall_clock_ms(state, now_ms);
    state.wall_clock_resumed_at = None;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A v2-style 26-character Crockford base32 ULID (48-bit timestamp + 80
/// bits of randomness), matching the id shape the cron tools validate.
fn ulid() -> String {
    const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut out = String::with_capacity(26);
    let ts = now_ms() & 0xFFFF_FFFF_FFFF;
    for shift in (0..48).step_by(5).rev() {
        out.push(CROCKFORD[((ts >> shift) & 0x1F) as usize] as char);
    }
    for _ in 0..16 {
        out.push(CROCKFORD[(fastrand::u32(..) & 0x1F) as usize] as char);
    }
    out
}

impl crate::injection::goal_plan::StateStore for StateStore {
    fn read_domain(&self, domain: &str) -> Option<serde_json::Value> {
        StateStore::read_domain(self, domain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, StateStore) {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::for_workspace(tmp.path()).unwrap();
        (tmp, store)
    }

    #[test]
    fn test_round_trip_all_domains() {
        let (_tmp, store) = store();
        let cases = [
            (
                "todo",
                json!([
                    { "id": "T1", "parentId": null, "kind": "task", "title": "Read", "status": "in_progress", "progress": 40 }
                ]),
            ),
            (
                "plan",
                json!({ "active": true, "id": "plan-1", "path": "/plans/plan-1.md" }),
            ),
            (
                "goal",
                json!({ "goal": { "goalId": "goal-1", "objective": "Ship", "status": "active", "turnsUsed": 0, "tokensUsed": 0, "inputTokensUsed": 0, "outputTokensUsed": 0, "wallClockMs": 0, "budget": { "tokenBudget": null, "turnBudget": null, "wallClockBudgetMs": null, "remainingTokens": null, "remainingTurns": null, "remainingWallClockMs": null, "tokenBudgetReached": false, "turnBudgetReached": false, "wallClockBudgetReached": false, "overBudget": false, "inputTokensUsed": 0, "outputTokensUsed": 0 }, "createdAt": 1, "updatedAt": 1 } }),
            ),
            (
                "cron",
                json!([{ "id": "01ABCDEFGHJKMNPQRSTVWXYZ", "cron": "0 9 * * *", "prompt": "daily", "createdAt": 1, "recurring": true, "nextFireAt": null, "stale": false }]),
            ),
            (
                "task",
                json!([{ "taskId": "task-1", "description": "run", "status": "running", "startedAt": 1 }]),
            ),
        ];
        for (domain, value) in cases {
            store.write_domain(domain, &value).unwrap();
            assert_eq!(store.read_domain(domain), Some(value), "domain: {domain}");
        }
    }

    #[test]
    fn test_atomic_write_replaces_and_leaves_no_tmp() {
        let (_tmp, store) = store();
        store
            .write_domain(
                "todo",
                &json!([{ "id": "T1", "title": "First", "status": "pending" }]),
            )
            .unwrap();
        store
            .write_domain(
                "todo",
                &json!([{ "id": "T2", "title": "Second", "status": "done" }]),
            )
            .unwrap();
        let value = store.read_domain("todo").unwrap();
        assert_eq!(value[0]["id"], "T2");
        assert_eq!(value[0]["title"], "Second");
        let leftovers: Vec<_> = fs::read_dir(store.state_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "tmp files left behind: {leftovers:?}");
    }

    #[test]
    fn test_defaults_for_empty_domains() {
        let (_tmp, store) = store();
        for (domain, expected) in [
            ("todo", json!([])),
            ("plan", json!({ "active": false })),
            ("goal", json!({ "goal": null })),
            ("cron", json!([])),
            ("task", json!([])),
        ] {
            assert_eq!(
                store.read_state(domain, domain).unwrap(),
                expected,
                "domain: {domain}"
            );
        }
    }

    #[test]
    fn test_clear_domain_restores_default() {
        let (_tmp, store) = store();
        store
            .write_domain(
                "todo",
                &json!([{ "id": "T1", "title": "A", "status": "pending" }]),
            )
            .unwrap();
        store.clear_domain("todo").unwrap();
        assert_eq!(store.read_domain("todo"), None);
        assert_eq!(store.read_state("todo", "todo").unwrap(), json!([]));
        // Clearing an already-empty domain is a no-op, not an error.
        store.clear_domain("cron").unwrap();
    }

    #[test]
    fn test_unknown_domain_errors() {
        let (_tmp, store) = store();
        let read = store.read_state("skill", "commit").unwrap_err();
        assert!(read.contains("-32001"));
        assert!(read.contains("unknown state domain: skill"));
        let write = store.write_domain("skill", &json!({})).unwrap_err();
        assert!(write.contains("unknown state domain: skill"));
        let apply = store.apply_write("skill", &json!({})).unwrap_err();
        assert!(apply.contains("-32001"));
    }

    #[test]
    fn test_plan_enter_exit() {
        let (_tmp, store) = store();
        let outcome = store
            .apply_write("plan", &json!({ "active": true }))
            .unwrap();
        assert_eq!(outcome.stored["active"], true);
        assert!(outcome.stored["id"].is_string());
        assert!(outcome.stored["path"].is_string());
        assert!(outcome.stored["path"].as_str().unwrap().ends_with(".md"));
        store.write_domain("plan", &outcome.stored).unwrap();
        // A second enter while active is rejected (-32004).
        let err = store
            .apply_write("plan", &json!({ "active": true }))
            .unwrap_err();
        assert!(err.contains("-32004"));
        // Exit deactivates and clears the id/path.
        let outcome = store
            .apply_write("plan", &json!({ "active": false }))
            .unwrap();
        assert_eq!(outcome.stored, json!({ "active": false }));
        store.write_domain("plan", &outcome.stored).unwrap();
        assert_eq!(
            store.read_state("plan", "plan").unwrap(),
            json!({ "active": false })
        );
        // Invalid values are rejected (-32003).
        let err = store
            .apply_write("plan", &json!({ "active": "yes" }))
            .unwrap_err();
        assert!(err.contains("-32003"));
    }

    #[test]
    fn test_goal_create_update_set_budget() {
        let (_tmp, store) = store();
        // Create.
        let outcome = store
            .apply_write(
                "goal",
                &json!({ "action": "create", "objective": "Ship the feature", "completion_criterion": "Tests pass" }),
            )
            .unwrap();
        let goal = &outcome.stored["goal"];
        assert_eq!(goal["objective"], "Ship the feature");
        assert_eq!(goal["completionCriterion"], "Tests pass");
        assert_eq!(goal["status"], "active");
        assert!(goal["goalId"].is_string());
        store.write_domain("goal", &outcome.stored).unwrap();
        // A second create is rejected (-32004).
        let err = store
            .apply_write("goal", &json!({ "action": "create", "objective": "Again" }))
            .unwrap_err();
        assert!(err.contains("-32004"));
        // Update to complete.
        let outcome = store
            .apply_write("goal", &json!({ "action": "update", "status": "complete" }))
            .unwrap();
        assert_eq!(outcome.stored["goal"]["status"], "complete");
        store.write_domain("goal", &outcome.stored).unwrap();
        // Resuming a completed goal is rejected (-32004).
        let err = store
            .apply_write("goal", &json!({ "action": "update", "status": "active" }))
            .unwrap_err();
        assert!(err.contains("-32004"));
        // Set a budget on the completed goal.
        let outcome = store
            .apply_write(
                "goal",
                &json!({ "action": "set_budget", "value": 20, "unit": "turns" }),
            )
            .unwrap();
        assert_eq!(outcome.stored["goal"]["budget"]["turnBudget"], 20);
        store.write_domain("goal", &outcome.stored).unwrap();
        // Update with no goal at all.
        store.clear_domain("goal").unwrap();
        let err = store
            .apply_write("goal", &json!({ "action": "update", "status": "complete" }))
            .unwrap_err();
        assert!(err.contains("-32004"));
        assert!(err.contains("no active goal"));
        let err = store
            .apply_write(
                "goal",
                &json!({ "action": "set_budget", "value": 5, "unit": "turns" }),
            )
            .unwrap_err();
        assert!(err.contains("-32004"));
        // Unreasonable time budgets are rejected (-32003).
        let err = store
            .apply_write(
                "goal",
                &json!({ "action": "set_budget", "value": 25, "unit": "hours" }),
            )
            .unwrap_err();
        assert!(err.contains("-32003"));
    }

    #[test]
    fn test_cron_create_delete() {
        let (_tmp, store) = store();
        let outcome = store
            .apply_write(
                "cron",
                &json!({ "action": "create", "cron": "0 9 * * *", "prompt": "daily check", "recurring": true }),
            )
            .unwrap();
        // The response is the created entry; the stored value is the list.
        assert_eq!(outcome.response["cron"], "0 9 * * *");
        assert_eq!(outcome.response["prompt"], "daily check");
        assert_eq!(outcome.response["recurring"], true);
        let id = outcome.response["id"].as_str().unwrap().to_string();
        assert_eq!(id.len(), 26);
        assert_eq!(outcome.stored.as_array().unwrap().len(), 1);
        store.write_domain("cron", &outcome.stored).unwrap();
        // Delete the created job.
        let outcome = store
            .apply_write("cron", &json!({ "action": "delete", "id": id }))
            .unwrap();
        assert_eq!(outcome.stored, json!([]));
        store.write_domain("cron", &outcome.stored).unwrap();
        // Deleting an unknown id is rejected (-32004).
        let err = store
            .apply_write(
                "cron",
                &json!({ "action": "delete", "id": "01ABCDEFGHJKMNPQRSTVWXYZ" }),
            )
            .unwrap_err();
        assert!(err.contains("-32004"));
        // Invalid actions are rejected (-32003).
        let err = store
            .apply_write("cron", &json!({ "action": "pause" }))
            .unwrap_err();
        assert!(err.contains("-32003"));
    }

    #[test]
    fn test_task_stop_wait_output() {
        let (_tmp, store) = store();
        let task = json!({
            "taskId": "task-1",
            "description": "run tests",
            "status": "running",
            "startedAt": 1,
        });
        store.write_domain("task", &json!([task])).unwrap();
        // TaskOutput-style read by task id.
        let value = store.read_state("task", "task-1").unwrap();
        assert_eq!(value["taskId"], "task-1");
        assert_eq!(value["status"], "running");
        // Unknown task id is a -32002 error.
        let err = store.read_state("task", "nope").unwrap_err();
        assert!(err.contains("-32002"));
        // Stop marks the task killed.
        let outcome = store
            .apply_write("task", &json!({ "action": "stop", "id": "task-1" }))
            .unwrap();
        assert_eq!(outcome.response["status"], "killed");
        assert_eq!(outcome.response["stopReason"], "Stopped by TaskStop");
        store.write_domain("task", &outcome.stored).unwrap();
        // Wait on the terminal task returns its entry.
        let outcome = store
            .apply_write(
                "task",
                &json!({ "action": "wait", "id": "task-1", "timeout_ms": 5000 }),
            )
            .unwrap();
        assert_eq!(outcome.response["status"], "killed");
        // Stopping an unknown task is a -32002 error.
        let err = store
            .apply_write("task", &json!({ "action": "stop", "id": "nope" }))
            .unwrap_err();
        assert!(err.contains("-32002"));
    }

    #[test]
    fn test_ulid_shape() {
        let id = ulid();
        assert_eq!(id.len(), 26);
        assert!(id.bytes().all(|b| b.is_ascii_alphanumeric()));
        assert!(!id.contains('I') && !id.contains('L') && !id.contains('O') && !id.contains('U'));
        assert_ne!(ulid(), id);
    }
}
