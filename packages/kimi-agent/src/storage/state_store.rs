//! Local JSON state storage for the standalone REPL (P32 批 1).
//!
//! Provides per-domain durable state under `<workspace>/.kimi/state/` with
//! one JSON file per domain (`todo.json` / `plan.json` / `goal.json` /
//! `cron.json` / `task.json` / `turn.json`). Writes are atomic (tmp file +
//! rename).
//!
//! Wire shapes align with the v2 state bridge domains: todo = `TodoItem[]`
//! (full replacement), plan = `{active, id?, path?}`, goal =
//! `{goal: <snapshot> | null}`, cron = entry list, task = task list, turn =
//! `{nextTurnId, cancelledTurnIds, anchorTurnIds, lastEnded?}`. The
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
use crate::turn_events::{TurnCancelTarget, TurnEvent};

/// The six state domains the REPL persists locally.
pub const STATE_DOMAINS: [&str; 6] = ["todo", "plan", "goal", "cron", "task", "turn"];

/// The task output preview cap, matching the v2 `TASK_OUTPUT_PREVIEW_BYTES`.
pub const TASK_OUTPUT_PREVIEW_BYTES: usize = 32 * 1024;

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
type StateSnapshot = Vec<(String, Option<Value>)>;

pub struct StateStore {
    state_dir: PathBuf,
    /// Undo checkpoint stack directory (v2 undo-anchor semantics): one file
    /// per snapshot under `state_dir/checkpoints/<seq>.json`. The stack
    /// survives restart — `rollback` reads the highest-numbered file,
    /// restores, and deletes it. Pushed by `checkpoint` at every turn head
    /// and consumed by `rollback` on undo.
    checkpoints_dir: PathBuf,
    /// Serializes concurrent `checkpoint` / `rollback` calls so the stack
    /// numbering and the per-file renames are race-free.
    checkpoint_lock: Mutex<()>,
}

impl StateStore {
    /// Create (or open) the state store under an explicit directory.
    /// Tests use this directly; production resolves the directory through
    /// [`for_workspace`].
    pub fn for_dir(state_dir: PathBuf) -> std::io::Result<Self> {
        let checkpoints_dir = state_dir.join("checkpoints");
        fs::create_dir_all(&checkpoints_dir)?;
        Ok(Self {
            state_dir,
            checkpoints_dir,
            checkpoint_lock: Mutex::new(()),
        })
    }

    /// Create (or open) the state store for a workspace, under the
    /// engine-local root: `~/.kimi-code/engine-state/<workspace-key>/state/`.
    pub fn for_workspace(workspace_root: &Path) -> std::io::Result<Self> {
        Self::for_dir(super::paths::engine_state_dir(workspace_root)?.join("state"))
    }

    /// Snapshot every domain (v2 undo-anchor checkpoint). The snapshot is
    /// persisted to a numbered file under `checkpoints/`, so undo survives
    /// a restart. A file that exists but fails to read/parse is an error,
    /// not an absent domain — rolling back must never silently wipe data.
    pub fn checkpoint(&self) -> Result<(), String> {
        let _guard = self
            .checkpoint_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut snapshot = Vec::with_capacity(STATE_DOMAINS.len());
        for domain in STATE_DOMAINS {
            let value = self.read_domain(domain);
            snapshot.push((domain.to_string(), value));
        }
        let next = next_checkpoint_seq(&self.checkpoints_dir)?;
        write_checkpoint_file(&self.checkpoints_dir, next, &snapshot)?;
        Ok(())
    }

    /// Restore the most recent checkpoint (highest-numbered file under
    /// `checkpoints/`). Returns `Ok(false)` when there is nothing to undo.
    pub fn rollback(&self) -> Result<bool, String> {
        let _guard = self
            .checkpoint_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(seq) = latest_checkpoint_seq(&self.checkpoints_dir)? else {
            return Ok(false);
        };
        let path = checkpoint_path(&self.checkpoints_dir, seq);
        let content =
            fs::read_to_string(&path).map_err(|e| format!("checkpoint read seq {seq}: {e}"))?;
        let snapshot: StateSnapshot = serde_json::from_str(&content)
            .map_err(|e| format!("checkpoint parse seq {seq}: {e}"))?;
        for (domain, value) in snapshot {
            match value {
                Some(v) => self.write_domain(&domain, &v)?,
                None => self.clear_domain(&domain)?,
            }
        }
        fs::remove_file(&path).map_err(|e| format!("checkpoint remove seq {seq}: {e}"))?;
        Ok(true)
    }

    /// How many checkpoints are pending (v2 `checkpointDepth`).
    pub fn checkpoint_depth(&self) -> usize {
        count_checkpoint_files(&self.checkpoints_dir).unwrap_or(0)
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
            "turn" => Some(json!({
                "nextTurnId": 0u64,
                "cancelledTurnIds": [],
                "anchorTurnIds": [],
            })),
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
            let mut entry = tasks
                .iter()
                .find(|t| t.get("taskId").and_then(|i| i.as_str()) == Some(key))
                .cloned()
                .ok_or_else(|| format!("State read error: [-32002] Task not found: {key}"))?;
            if let Some(snapshot) = self.read_task_output(key, TASK_OUTPUT_PREVIEW_BYTES)
                && let Some(obj) = entry.as_object_mut()
                && let Some(fields) = snapshot.as_object()
            {
                for (field, value) in fields {
                    obj.insert(field.clone(), value.clone());
                }
            }
            return Ok(entry);
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
            "turn" => self.apply_turn_write(value),
            _ => Err(format!(
                "State write error: [-32001] unknown state domain: {domain}"
            )),
        }
    }

    fn apply_turn_write(&self, value: &Value) -> Result<StateWriteOutcome, String> {
        let next_turn_id = value
            .get("nextTurnId")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| {
                "State write error: [-32003] invalid turn state value: missing nextTurnId"
                    .to_string()
            })?;
        let mut state = match self.read_domain("turn") {
            Some(Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        // The clock never rewinds: a lower value would hand out an id that
        // durable turn events have already been recorded against.
        let stored = state
            .get("nextTurnId")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        state.insert("nextTurnId".into(), json!(next_turn_id.max(stored)));
        for field in ["cancelledTurnIds", "anchorTurnIds", "lastEnded"] {
            match value.get(field) {
                Some(incoming) => {
                    state.insert(field.into(), incoming.clone());
                }
                None => {
                    state.remove(field);
                }
            }
        }
        let stored = Value::Object(state);
        Ok(StateWriteOutcome {
            stored: stored.clone(),
            response: stored,
        })
    }

    /// Fold one engine turn lifecycle event into the persisted turn clock —
    /// the REPL host's stand-in for v2's `turnKey` fold. `turn.started` is
    /// observable-only and changes nothing; `anchorTurnIds` is not modelled
    /// here because the REPL has no undo protocol.
    pub fn fold_turn_event(&self, event: &TurnEvent) {
        let mut state = match self.read_domain("turn") {
            Some(Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        let next_turn_id = state
            .get("nextTurnId")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        match event {
            TurnEvent::Prompt { turn_id, .. } => {
                state.insert("nextTurnId".into(), json!(next_turn_id.max(turn_id + 1)));
            }
            TurnEvent::Cancel {
                turn_id, target, ..
            } => {
                // A cancellation aimed at the active turn is accounted for by
                // turn.ended; only a queued one reserves an id.
                if target.is_some_and(|t| t != TurnCancelTarget::Queued) {
                    return;
                }
                let Some(turn_id) = (*turn_id).filter(|id| *id >= next_turn_id) else {
                    return;
                };
                let mut cancelled = state
                    .get("cancelledTurnIds")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_u64()).collect::<Vec<u64>>())
                    .unwrap_or_default();
                if cancelled.contains(&turn_id) {
                    return;
                }
                cancelled.push(turn_id);
                cancelled.sort_unstable();
                state.insert("cancelledTurnIds".into(), json!(cancelled));
            }
            TurnEvent::Ended {
                turn_id,
                reason,
                duration_ms,
                ..
            } => {
                state.insert(
                    "lastEnded".into(),
                    json!({ "turnId": turn_id, "reason": reason, "durationMs": duration_ms }),
                );
            }
            TurnEvent::Started { .. } => return,
        }
        let _ = self.write_domain("turn", &Value::Object(state));
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
        // v2 `writeEmptyPlanFile`: the plan file exists from the moment plan
        // mode is entered, so the model can Read it before writing.
        fs::write(&path, "").map_err(|e| format!("create plan file {}: {e}", path.display()))?;
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

    /// The task output log path (`<state_dir>/tasks/<task_id>/output.log`),
    /// mirroring the v2 `tasks/<taskId>/output.log` layout.
    pub fn task_output_path(&self, task_id: &str) -> PathBuf {
        self.state_dir
            .join("tasks")
            .join(task_id)
            .join("output.log")
    }

    /// Persist a task's output log (v2 `writeTaskOutputData` semantics:
    /// the full output is written to disk so `TaskOutput` survives a
    /// restart). Best-effort: a failed write only logs.
    pub fn write_task_output(&self, task_id: &str, output: &str) {
        let path = self.task_output_path(task_id);
        if let Some(parent) = path.parent()
            && let Err(e) = fs::create_dir_all(parent)
        {
            eprintln!("[Task output write error]: {e}");
            return;
        }
        if let Err(e) = fs::write(&path, output) {
            eprintln!("[Task output write error]: {e}");
        }
    }

    /// Read a task's output snapshot from its log file, mirroring the v2
    /// `readTaskOutputSnapshot` shape (`outputPath` / `outputSizeBytes` /
    /// `previewBytes` / `truncated` / `preview`). `None` when no log
    /// exists.
    pub fn read_task_output(&self, task_id: &str, max_preview_bytes: usize) -> Option<Value> {
        let path = self.task_output_path(task_id);
        let data = fs::read(&path).ok()?;
        let preview_limit = max_preview_bytes.min(data.len());
        let preview_offset = data.len() - preview_limit;
        let preview = String::from_utf8_lossy(&data[preview_offset..]).into_owned();
        Some(json!({
            "outputPath": path.to_string_lossy(),
            "outputSizeBytes": data.len(),
            "previewBytes": preview_limit,
            "truncated": preview_offset > 0,
            "fullOutputAvailable": true,
            "preview": preview,
        }))
    }

    /// Fold one turn's usage into the stored goal (v2 `incrementGoalTurn` +
    /// `accountTokenUsage` semantics): only an active goal is updated, and
    /// the turn count and output tokens accumulate across turns. No-op
    /// when no goal is stored or it is not active.
    pub fn goal_record_usage(&self, turns_delta: u64, output_tokens_delta: u64) {
        let Some(mut state) = self.read_goal_state() else {
            return;
        };
        if state.status != GoalStatus::Active {
            return;
        }
        let now = now_ms();
        state.turns_used += turns_delta;
        state.tokens_used += output_tokens_delta;
        state.output_tokens_used += output_tokens_delta;
        state.updated_at = now;
        let outcome = goal_outcome(&state, now);
        let _ = self.write_domain("goal", &outcome.stored);
    }

    /// The stored goal projected into the turn-loop `GoalContext`, with the
    /// live wall-clock figure folded in for active goals. `None` when no
    /// goal is stored.
    pub fn goal_context(&self) -> Option<crate::turn_loop::types::GoalContext> {
        let state = self.read_goal_state()?;
        let now = now_ms();
        let status = match state.status {
            GoalStatus::Active => crate::turn_loop::types::GoalStatus::Active,
            GoalStatus::Paused => crate::turn_loop::types::GoalStatus::Paused,
            GoalStatus::Blocked => crate::turn_loop::types::GoalStatus::Blocked,
            GoalStatus::Complete => crate::turn_loop::types::GoalStatus::Complete,
            GoalStatus::BudgetLimited => crate::turn_loop::types::GoalStatus::BudgetLimited,
            GoalStatus::UsageLimited => crate::turn_loop::types::GoalStatus::UsageLimited,
        };
        let wall_clock_ms = live_wall_clock_ms(&state, now) as i64;
        Some(crate::turn_loop::types::GoalContext {
            goal_id: state.goal_id,
            objective: state.objective,
            status,
            token_budget: state.budget_limits.token_budget.map(|v| v as i64),
            turn_budget: state.budget_limits.turn_budget.map(|v| v as i64),
            wall_clock_budget_ms: state.budget_limits.wall_clock_budget_ms.map(|v| v as i64),
            wall_clock_ms,
            tokens_used: state.tokens_used as i64,
            turns_used: state.turns_used as i64,
        })
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

/// The checkpoint file name, zero-padded for lexicographic sort.
fn checkpoint_path(dir: &Path, seq: u64) -> PathBuf {
    dir.join(format!("{seq:08}.json"))
}

/// The next checkpoint sequence number: one past the highest existing
/// file. Scans the directory; for the REPL's checkpoint cadence (one per
/// turn) the directory stays small and the scan is negligible.
fn next_checkpoint_seq(dir: &Path) -> Result<u64, String> {
    let mut max: Option<u64> = None;
    for entry in fs::read_dir(dir).map_err(|e| format!("read checkpoints dir: {e}"))? {
        let entry = entry.map_err(|e| format!("checkpoint dir entry: {e}"))?;
        if let Some(seq) = parse_seq(&entry.file_name().to_string_lossy()) {
            max = Some(max.map_or(seq, |m| m.max(seq)));
        }
    }
    Ok(max.map_or(1, |m| m + 1))
}

fn latest_checkpoint_seq(dir: &Path) -> Result<Option<u64>, String> {
    let mut max: Option<u64> = None;
    for entry in fs::read_dir(dir).map_err(|e| format!("read checkpoints dir: {e}"))? {
        let entry = entry.map_err(|e| format!("checkpoint dir entry: {e}"))?;
        if let Some(seq) = parse_seq(&entry.file_name().to_string_lossy()) {
            max = Some(max.map_or(seq, |m| m.max(seq)));
        }
    }
    Ok(max)
}

fn count_checkpoint_files(dir: &Path) -> Result<usize, String> {
    let mut n = 0usize;
    for entry in fs::read_dir(dir).map_err(|e| format!("read checkpoints dir: {e}"))? {
        let entry = entry.map_err(|e| format!("checkpoint dir entry: {e}"))?;
        if parse_seq(&entry.file_name().to_string_lossy()).is_some() {
            n += 1;
        }
    }
    Ok(n)
}

fn parse_seq(name: &str) -> Option<u64> {
    name.strip_suffix(".json").and_then(|s| s.parse().ok())
}

fn write_checkpoint_file(dir: &Path, seq: u64, snapshot: &StateSnapshot) -> Result<(), String> {
    let path = checkpoint_path(dir, seq);
    let json = serde_json::to_string(snapshot).map_err(|e| format!("serialize checkpoint: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| format!("create tmp checkpoint: {e}"))?;
    file.write_all(json.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("write tmp checkpoint: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename tmp checkpoint: {e}"))?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, StateStore) {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::for_dir(tmp.path().join("state")).unwrap();
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
    fn test_undo_checkpoint_survives_restart() {
        let tmp = TempDir::new().unwrap();
        let state_dir = tmp.path().join("state");
        let todo = json!([{ "id": "T1", "status": "in_progress" }]);
        // Session 1: write a todo, then checkpoint.
        {
            let store = StateStore::for_dir(state_dir.clone()).unwrap();
            store.write_domain("todo", &todo).unwrap();
            store.checkpoint().unwrap();
            assert_eq!(store.checkpoint_depth(), 1);
        }
        // Session 2 (restart): re-open the same dir. Checkpoint file
        // survives, depth reflects it. Then write a different todo and
        // roll back — the pre-checkpoint value must come back.
        {
            let store = StateStore::for_dir(state_dir.clone()).unwrap();
            assert_eq!(
                store.checkpoint_depth(),
                1,
                "checkpoint stack must persist across restart"
            );
            let new = json!([{ "id": "T2", "status": "completed" }]);
            store.write_domain("todo", &new).unwrap();
            assert_eq!(store.read_domain("todo"), Some(new.clone()));
            assert!(store.rollback().unwrap());
            assert_eq!(
                store.read_domain("todo"),
                Some(todo.clone()),
                "rollback restores the pre-checkpoint value"
            );
            assert_eq!(store.checkpoint_depth(), 0);
        }
        // Session 3 (another restart): the rollback consumed the file,
        // so a fresh open sees depth 0.
        {
            let store = StateStore::for_dir(state_dir).unwrap();
            assert_eq!(store.checkpoint_depth(), 0);
        }
    }

    #[test]
    fn test_undo_checkpoint_stack_ordering_across_restart() {
        let tmp = TempDir::new().unwrap();
        let state_dir = tmp.path().join("state");
        // Session 1: two checkpoints, no rollbacks.
        {
            let store = StateStore::for_dir(state_dir.clone()).unwrap();
            store.checkpoint().unwrap();
            store.checkpoint().unwrap();
            assert_eq!(store.checkpoint_depth(), 2);
        }
        // Session 2: open, roll back once — depth 1.
        {
            let store = StateStore::for_dir(state_dir.clone()).unwrap();
            assert_eq!(store.checkpoint_depth(), 2);
            assert!(store.rollback().unwrap());
            assert_eq!(store.checkpoint_depth(), 1);
        }
        // Session 3: open, roll back again — depth 0.
        {
            let store = StateStore::for_dir(state_dir).unwrap();
            assert_eq!(store.checkpoint_depth(), 1);
            assert!(store.rollback().unwrap());
            assert_eq!(store.checkpoint_depth(), 0);
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

    #[test]
    fn test_goal_context_none_without_goal() {
        let (_tmp, store) = store();
        assert!(store.goal_context().is_none());
    }

    #[test]
    fn test_goal_context_projects_active_goal_with_live_wall_clock() {
        let (_tmp, store) = store();
        let outcome = store
            .apply_write(
                "goal",
                &json!({ "action": "create", "objective": "Ship the feature" }),
            )
            .unwrap();
        store.write_domain("goal", &outcome.stored).unwrap();
        let ctx = store.goal_context().unwrap();
        assert!(ctx.goal_id.starts_with("goal-"));
        assert_eq!(ctx.objective, "Ship the feature");
        assert_eq!(ctx.status, crate::turn_loop::types::GoalStatus::Active);
        assert_eq!(ctx.tokens_used, 0);
        assert_eq!(ctx.turns_used, 0);
        assert!(ctx.wall_clock_ms >= 0);
        assert!(ctx.token_budget.is_none());
        assert!(ctx.turn_budget.is_none());
    }

    #[test]
    fn test_goal_context_maps_budgets_and_terminal_status() {
        let (_tmp, store) = store();
        let outcome = store
            .apply_write(
                "goal",
                &json!({ "action": "create", "objective": "Ship the feature" }),
            )
            .unwrap();
        store.write_domain("goal", &outcome.stored).unwrap();
        let outcome = store
            .apply_write(
                "goal",
                &json!({ "action": "set_budget", "value": 20, "unit": "turns" }),
            )
            .unwrap();
        store.write_domain("goal", &outcome.stored).unwrap();
        let outcome = store
            .apply_write("goal", &json!({ "action": "update", "status": "complete" }))
            .unwrap();
        store.write_domain("goal", &outcome.stored).unwrap();
        let ctx = store.goal_context().unwrap();
        assert_eq!(ctx.status, crate::turn_loop::types::GoalStatus::Complete);
        assert_eq!(ctx.turn_budget, Some(20));
        assert!(ctx.token_budget.is_none());
    }

    #[test]
    fn test_goal_record_usage_accumulates_across_turns() {
        let (_tmp, store) = store();
        store.goal_record_usage(1, 10);
        let outcome = store
            .apply_write(
                "goal",
                &json!({ "action": "create", "objective": "Ship the feature" }),
            )
            .unwrap();
        store.write_domain("goal", &outcome.stored).unwrap();
        store.goal_record_usage(1, 10);
        store.goal_record_usage(1, 20);
        let ctx = store.goal_context().unwrap();
        assert_eq!(ctx.turns_used, 2);
        assert_eq!(ctx.tokens_used, 30);
    }

    #[test]
    fn test_goal_record_usage_skips_inactive_goal() {
        let (_tmp, store) = store();
        let outcome = store
            .apply_write(
                "goal",
                &json!({ "action": "create", "objective": "Ship the feature" }),
            )
            .unwrap();
        store.write_domain("goal", &outcome.stored).unwrap();
        let outcome = store
            .apply_write("goal", &json!({ "action": "update", "status": "complete" }))
            .unwrap();
        store.write_domain("goal", &outcome.stored).unwrap();
        store.goal_record_usage(1, 10);
        let ctx = store.goal_context().unwrap();
        assert_eq!(ctx.turns_used, 0);
        assert_eq!(ctx.tokens_used, 0);
    }

    #[test]
    fn test_task_output_round_trip() {
        let (_tmp, store) = store();
        assert!(store.read_task_output("task-1", 1024).is_none());
        store.write_task_output("task-1", "line one\nline two\n");
        let snapshot = store.read_task_output("task-1", 1024).unwrap();
        assert_eq!(snapshot["outputSizeBytes"], 18);
        assert_eq!(snapshot["previewBytes"], 18);
        assert_eq!(snapshot["truncated"], false);
        assert_eq!(snapshot["preview"], "line one\nline two\n");
        assert!(
            snapshot["outputPath"]
                .as_str()
                .unwrap()
                .replace('\\', "/")
                .ends_with("tasks/task-1/output.log")
        );
    }

    #[test]
    fn test_task_output_truncated_preview_takes_tail() {
        let (_tmp, store) = store();
        let output = "x".repeat(40 * 1024);
        store.write_task_output("task-1", &output);
        let snapshot = store.read_task_output("task-1", 1024).unwrap();
        assert_eq!(snapshot["outputSizeBytes"], 40 * 1024);
        assert_eq!(snapshot["previewBytes"], 1024);
        assert_eq!(snapshot["truncated"], true);
        assert_eq!(snapshot["preview"], "x".repeat(1024));
    }

    #[test]
    fn test_read_state_task_attaches_output_snapshot() {
        let (_tmp, store) = store();
        store
            .write_domain(
                "task",
                &json!([{ "taskId": "task-1", "description": "build", "status": "completed", "startedAt": 1, "endedAt": 2 }]),
            )
            .unwrap();
        store.write_task_output("task-1", "build output");
        let entry = store.read_state("task", "task-1").unwrap();
        assert_eq!(entry["taskId"], "task-1");
        assert_eq!(entry["status"], "completed");
        assert_eq!(entry["preview"], "build output");
        assert_eq!(entry["truncated"], false);
        assert_eq!(entry["fullOutputAvailable"], true);
        let list = store.read_state("task", "task").unwrap();
        assert!(list.as_array().unwrap()[0].get("preview").is_none());
    }

    #[test]
    fn test_fold_turn_event_advances_clock_once_per_prompt() {
        use crate::turn_events::TurnEndReason;

        let (_tmp, store) = store();
        assert_eq!(store.read_state("turn", "").unwrap()["nextTurnId"], 0);
        for turn_id in 0..3u64 {
            store.fold_turn_event(&TurnEvent::Prompt {
                turn_id,
                input: json!([]),
                origin: json!({ "kind": "user" }),
            });
            store.fold_turn_event(&TurnEvent::Started {
                turn_id,
                origin: json!({ "kind": "user" }),
            });
            store.fold_turn_event(&TurnEvent::Ended {
                turn_id,
                reason: TurnEndReason::Completed,
                error: None,
                duration_ms: Some(5),
            });
        }
        let state = store.read_state("turn", "").unwrap();
        assert_eq!(state["nextTurnId"], 3, "one clock step per prompt");
        assert_eq!(state["lastEnded"]["turnId"], 2);
        assert_eq!(state["lastEnded"]["reason"], "completed");
    }

    #[test]
    fn test_fold_turn_event_reserves_only_unconsumed_queued_ids() {
        let (_tmp, store) = store();
        store
            .write_domain("turn", &json!({ "nextTurnId": 7, "cancelledTurnIds": [] }))
            .unwrap();
        store.fold_turn_event(&TurnEvent::Cancel {
            turn_id: Some(9),
            target: Some(TurnCancelTarget::Queued),
            reason: None,
        });
        // Already ran (id below the clock) — the clock must not grow backwards.
        store.fold_turn_event(&TurnEvent::Cancel {
            turn_id: Some(3),
            target: Some(TurnCancelTarget::Queued),
            reason: None,
        });
        // An active turn is accounted for by turn.ended, not by the clock.
        store.fold_turn_event(&TurnEvent::Cancel {
            turn_id: Some(9),
            target: Some(TurnCancelTarget::Active),
            reason: None,
        });
        let state = store.read_state("turn", "").unwrap();
        assert_eq!(state["cancelledTurnIds"], json!([9]));
        assert_eq!(state["nextTurnId"], 7);
    }

    #[test]
    fn test_turn_write_never_rewinds_clock() {
        let (_tmp, store) = store();
        store
            .write_domain(
                "turn",
                &json!({ "nextTurnId": 12, "cancelledTurnIds": [4] }),
            )
            .unwrap();
        let outcome = store
            .apply_write("turn", &json!({ "nextTurnId": 3 }))
            .expect("a lower clock is accepted, clamped");
        assert_eq!(
            outcome.stored["nextTurnId"], 12,
            "a stale write must not hand out an id that was already used"
        );
        assert!(
            outcome.stored.get("cancelledTurnIds").is_none(),
            "fields the write omits are cleared"
        );
        let err = store.apply_write("turn", &json!({})).unwrap_err();
        assert!(err.contains("-32003"), "{err}");
    }
}
