//! Mode mutex (v2 `agent/modeMutex` port): plan, swarm and tower modes are
//! mutually exclusive — entering one auto-exits the others.
//!
//! v2 enforced this with a per-agent mode flag (`PlanModeEnter` and
//! `SwarmModeEnter` exit tower, `TowerModeEnter` exits plan and swarm). The
//! native engine has no tower/swarm mode flags — tower state is file-based
//! (`.tower/`) and swarm is a one-shot batch tool — so the mutex is expressed
//! in those terms. Plan enter with open tower missions pauses them (`Paused`,
//! never deleted or torn down; resume via TowerMission), while a swarm dispatch
//! is *refused* while any mission is open (v2 #3976: the modes are exclusive,
//! and the tower fleet already runs through TowerSpawn). Tower init with plan
//! active deactivates plan through the host state bridge
//! (`{active:false}`, undoable, like ExitPlanMode).
//!
//! Swarm has no persistent mode to exit on the tower side (each AgentSwarm
//! call runs its batch and returns), so that half of v2's tower-enter rule
//! is a documented no-op. Like v2, the mutex never blocks entry on an I/O
//! error — except the swarm gate, which denies when a tower's state exists but
//! cannot be read (a tower it cannot clear is not a tower it may ignore).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::tower::paths::{TOWER_NAME, resolve_tower_repo_root};
use super::tower::store::TowerStore;
use super::tower::types::{TowerMission, TowerMissionPatch, TowerMissionStatus, TowerState};
use crate::callbacks::HostCallbacks;
use crate::rpc::types::{StateReadRequest, StateWriteRequest};

/// Ids of missions that count as "tower active" (v2 `tower.isActive` had a
/// mode flag; here openness is derived from mission status).
pub fn open_mission_ids(state: &TowerState) -> Vec<String> {
    state
        .missions
        .iter()
        .filter(|m| m.status.is_open())
        .map(|m| m.id.clone())
        .collect()
}

/// v2 `PlanModeEnter` / `SwarmModeEnter` → `tower.exit()`: pause every open
/// mission of this workspace's tower so plan/swarm work cannot diverge from
/// worker writes. Returns the paused ids. Never fails: an uninitialized,
/// unreadable or unpausable tower simply yields no ids.
pub async fn pause_tower_for_mode_enter(workspace_root: &Path, reason: &str) -> Vec<String> {
    let repo_root = resolve_tower_repo_root(&workspace_root.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    if !store.is_initialized().await.unwrap_or(false) {
        return Vec::new();
    }
    // Same per-repo serialization as the `execute_tower_*` entry points.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;
    let state = match store.load().await {
        Ok(state) => state,
        Err(_) => return Vec::new(),
    };
    let mut paused = Vec::new();
    for id in open_mission_ids(&state) {
        let patch = TowerMissionPatch {
            status: Some(TowerMissionStatus::Paused),
            note: Some(format!(
                "mode mutex: auto-paused ({reason}); resume with TowerMission status=active"
            )),
            ..Default::default()
        };
        // The mutex acts as the tower itself, so ownership checks pass;
        // a mission that refuses the patch keeps its status and is skipped.
        if store.update_mission(TOWER_NAME, &id, patch).await.is_ok() {
            paused.push(id);
        }
    }
    paused
}

/// v2 `TowerModeEnter` → `plan.exit()`: deactivate plan mode through the
/// host state bridge when it is active. Returns whether plan was exited.
pub async fn exit_plan_for_tower_enter(callbacks: &dyn HostCallbacks) -> bool {
    let read = StateReadRequest {
        domain: "plan".into(),
        key: "plan".into(),
        turn_id: String::new(),
        tool_call_id: String::new(),
    };
    let plan = match callbacks.state_read(read).await {
        Ok(response) => response.value,
        Err(_) => return false,
    };
    if plan.get("active").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let write = StateWriteRequest {
        domain: "plan".into(),
        key: "plan".into(),
        value: serde_json::json!({ "active": false }),
        undoable: true,
        turn_id: String::new(),
        tool_call_id: String::new(),
    };
    callbacks.state_write(write).await.is_ok()
}

/// v2 #3976: swarm and tower modes are mutually exclusive, and with tower
/// active the fleet runs through TowerSpawn — one mission per worker in its own
/// worktree. Returns the denial message when a tower has open missions, or
/// `None` to let the swarm run. Never fails: like [`pause_tower_for_mode_enter`],
/// an uninitialized or unreadable tower simply yields no denial, so the mutex
/// degrades to doing nothing rather than wedging the tool.
/// Fail-closed where it counts: a tower whose state exists but cannot be read is
/// a tower this gate cannot clear, so it denies rather than waving the batch
/// through. A workspace with no tower at all (`is_initialized` false) is the one
/// case that yields no denial — that is the documented "no mutex here" path,
/// not a swallowed error.
pub async fn refuse_swarm_with_active_tower(workspace_root: &Path) -> Option<String> {
    let repo_root = resolve_tower_repo_root(&workspace_root.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    if !store.is_initialized().await.unwrap_or(false) {
        return None;
    }
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;
    let state = match store.load().await {
        Ok(state) => state,
        Err(error) => {
            return Some(format!(
                "AgentSwarm is not available: this workspace has a tower whose state could not be read ({error}), so the mode mutex cannot confirm that swarm and tower are exclusive. Repair or remove the tower state under .tower/, or run the swarm from a workspace without one."
            ));
        }
    };
    let open = open_mission_ids(&state);
    if open.is_empty() {
        return None;
    }
    // The remedy has to be the action that actually clears the gate: this
    // mutex reads open missions, not the host's tower-mode flag, and turning
    // that flag off leaves the missions open.
    Some(format!(
        "AgentSwarm is not available while tower mode is active — swarm and tower modes are mutually exclusive, and the tower fleet runs through TowerSpawn, one mission per worker in its own worktree. Open mission(s): {}. Finish them (merge or abandon with TowerMission) before dispatching a swarm.",
        open.join(", ")
    ))
}

/// Enforcement half of the pause: worker spawns and merges against a paused
/// mission are refused (v2 gated the whole tower toolset once exited; here
/// the gate is per-mission). Returns the refusal message, or `None` to let
/// the call through. Resume with TowerMission `status=active`.
pub fn refuse_paused_mission(mission: &TowerMission) -> Option<String> {
    if mission.status != TowerMissionStatus::Paused {
        return None;
    }
    Some(format!(
        "mission {} is paused by the mode mutex (plan mode or a swarm took over) — spawning workers and merging stay blocked so the modes cannot diverge. Resume it with TowerMission status=active when the current work no longer conflicts.",
        mission.id
    ))
}

/// Model-facing note appended when the mutex paused tower missions.
pub fn tower_paused_note(ids: &[String]) -> String {
    format!(
        "\n\nMode mutex: paused {} open tower mission(s) ({}) so planning and worker writes cannot diverge. Worker spawns and merges on paused missions are refused until resume — resume any of them with TowerMission status=active when the current work no longer conflicts.",
        ids.len(),
        ids.join(", ")
    )
}

/// Model-facing note prepended when tower init auto-exited plan mode.
pub fn plan_exited_note() -> String {
    "Mode mutex: plan mode was active, so it was exited before tower init (plan file preserved)."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::callbacks::HostCallbacks;
    use crate::rpc::types::{
        BoxFuture, LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision,
        StateReadResponse, StateWriteResponse, ToolExecuteRequest, ToolExecuteResponse,
    };
    use crate::tools::tower::types::{TowerMission, TowerMissionKind};
    use std::sync::{Arc, Mutex as StdMutex};

    fn mission(id: &str, status: TowerMissionStatus) -> TowerMission {
        TowerMission {
            id: id.into(),
            title: format!("{id} title"),
            slug: id.into(),
            kind: TowerMissionKind::default(),
            scope: vec!["src/".into()],
            branch: format!("tower/{id}"),
            worktree: format!("wt-{id}"),
            spawn_base: None,
            deps: Vec::new(),
            status,
            owner: None,
            context: None,
            tasks: Vec::new(),
            notes: Vec::new(),
            blockers: Vec::new(),
        }
    }

    fn state_with(missions: Vec<TowerMission>) -> TowerState {
        TowerState {
            version: 1,
            base: "main".into(),
            mode: "tower".into(),
            created_at: "2026-09-14T00:00:00Z".into(),
            session_id: None,
            roster: Default::default(),
            missions,
        }
    }

    #[test]
    fn open_mission_ids_lists_only_open() {
        let state = state_with(vec![
            mission("m1", TowerMissionStatus::Active),
            mission("m2", TowerMissionStatus::Merged),
            mission("m3", TowerMissionStatus::Abandoned),
            mission("m4", TowerMissionStatus::Paused),
        ]);
        assert_eq!(
            open_mission_ids(&state),
            vec!["m1".to_string(), "m4".to_string()]
        );
    }

    #[test]
    fn refuse_paused_mission_gates_only_paused() {
        let refused = refuse_paused_mission(&mission("m1", TowerMissionStatus::Paused)).unwrap();
        assert!(refused.contains("m1"), "refusal must name the mission");
        assert!(
            refused.contains("status=active"),
            "refusal must tell how to resume"
        );
        assert!(refuse_paused_mission(&mission("m2", TowerMissionStatus::Active)).is_none());
        assert!(refuse_paused_mission(&mission("m3", TowerMissionStatus::Planned)).is_none());
    }

    #[tokio::test]
    async fn pause_skips_uninitialized_repo() {
        let dir = tempfile::tempdir().unwrap();
        let paused = pause_tower_for_mode_enter(dir.path(), "test").await;
        assert!(paused.is_empty());
    }

    #[tokio::test]
    async fn pause_marks_open_paused_and_keeps_closed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tower/comms/missions")).unwrap();
        std::fs::create_dir_all(root.join(".tower/comms/log")).unwrap();
        // resolve_tower_repo_root returns the root unchanged outside
        // .tower/worktrees/, so the mutex opens this same store.
        let store = TowerStore::new(root.to_path_buf());
        store
            .save(&state_with(vec![
                mission("m1", TowerMissionStatus::Active),
                mission("m2", TowerMissionStatus::Merged),
                mission("m3", TowerMissionStatus::Planned),
            ]))
            .await
            .unwrap();

        // resolve_tower_repo_root returns the root unchanged unless it sits
        // under .tower/worktrees/, so the mutex opens this same store.
        let paused = pause_tower_for_mode_enter(root, "test").await;
        assert_eq!(paused, vec!["m1".to_string(), "m3".to_string()]);

        let reloaded = store.load().await.unwrap();
        let status_of = |id: &str| {
            reloaded
                .missions
                .iter()
                .find(|m| m.id == id)
                .map(|m| m.status)
        };
        assert_eq!(status_of("m1"), Some(TowerMissionStatus::Paused));
        assert_eq!(status_of("m3"), Some(TowerMissionStatus::Paused));
        assert_eq!(status_of("m2"), Some(TowerMissionStatus::Merged));
    }

    /// The #3976 swarm veto: an active tower refuses the batch outright.
    #[tokio::test]
    async fn refuse_swarm_with_active_tower_denies_when_missions_open() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tower/comms/missions")).unwrap();
        std::fs::create_dir_all(root.join(".tower/comms/log")).unwrap();
        let store = TowerStore::new(root.to_path_buf());
        store.save(&state_with(Vec::new())).await.unwrap();
        assert!(
            refuse_swarm_with_active_tower(root).await.is_none(),
            "an initialized tower with no open mission still allows a swarm"
        );

        store
            .save(&state_with(vec![mission("m1", TowerMissionStatus::Active)]))
            .await
            .unwrap();
        let denial = refuse_swarm_with_active_tower(root)
            .await
            .expect("open mission denies the swarm");
        assert!(denial.contains("not available while tower mode is active"));
        assert!(denial.contains("mutually exclusive"));
        // The remedy must be the action that actually clears the gate: this
        // mutex reads open missions, and turning the tower-mode flag off leaves
        // them open.
        assert!(denial.contains("m1"), "{denial}");
        assert!(denial.contains("merge or abandon"), "{denial}");
    }

    /// A tower whose state file exists but cannot be parsed is a tower this gate
    /// cannot clear, so the swarm is refused rather than waved through.
    #[tokio::test]
    async fn refuse_swarm_with_active_tower_denies_when_the_state_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tower/comms")).unwrap();
        std::fs::write(root.join(".tower/comms/state.json"), "{ not json").unwrap();

        let denial = refuse_swarm_with_active_tower(root)
            .await
            .expect("an unreadable tower state denies the swarm");
        assert!(denial.contains("could not be read"), "{denial}");
    }

    #[tokio::test]
    async fn refuse_swarm_with_active_tower_skips_uninitialized_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(refuse_swarm_with_active_tower(dir.path()).await.is_none());
    }

    /// Scriptable state-bridge host: reads answer with `plan_active`, writes
    /// are recorded for assertion.
    struct MutexProbeCallbacks {
        plan_active: bool,
        writes: Arc<StdMutex<Vec<Value>>>,
    }

    impl HostCallbacks for MutexProbeCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async {
                Ok(PermissionDecision {
                    decision: "allow".into(),
                    reason: None,
                })
            })
        }

        fn emit_event(&self, _: Value) {}

        fn state_read(
            &self,
            _: StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
            let active = self.plan_active;
            Box::pin(async move {
                Ok(StateReadResponse {
                    value: serde_json::json!({ "active": active }),
                })
            })
        }

        fn state_write(
            &self,
            request: StateWriteRequest,
        ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
            self.writes.lock().unwrap().push(request.value.clone());
            let value = request.value;
            Box::pin(async move { Ok(StateWriteResponse { ok: true, value }) })
        }
    }

    fn probe(active: bool) -> (MutexProbeCallbacks, Arc<StdMutex<Vec<Value>>>) {
        let writes = Arc::new(StdMutex::new(Vec::new()));
        (
            MutexProbeCallbacks {
                plan_active: active,
                writes: writes.clone(),
            },
            writes,
        )
    }

    #[tokio::test]
    async fn exit_plan_deactivates_active_plan() {
        let (callbacks, writes) = probe(true);
        assert!(exit_plan_for_tower_enter(&callbacks).await);
        let writes = writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0], serde_json::json!({ "active": false }));
    }

    #[tokio::test]
    async fn exit_plan_noop_when_inactive() {
        let (callbacks, writes) = probe(false);
        assert!(!exit_plan_for_tower_enter(&callbacks).await);
        assert!(writes.lock().unwrap().is_empty());
    }
}
