pub mod frontmatter;
pub mod git;
pub mod paths;
pub mod rate_limit;
pub mod store;
pub mod types;

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::subagent::SubagentManager;
use crate::tools::tower::paths::{
    MISSIONS_DIR, WORKTREES_DIR, mission_file_name, resolve_tower_repo_root,
};
use crate::tools::tower::rate_limit::TowerRateLimit;
use crate::tools::tower::store::TowerStore;
use crate::tools::tower::types::{
    TowerFindingInput, TowerMissionPatch, TowerPlanInput, TowerReviewInput, TowerRosterEntry,
    TowerSendInput,
};
use crate::turn_loop::types::{ExecutableToolResult, ToolInfo};

pub const TOWER_MAIN_AGENT_ONLY: &str =
    "Tower orchestration tools are only supported by the main agent.";

fn err_result(msg: impl Into<String>) -> ExecutableToolResult {
    ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: msg.into(),
        is_error: true,
        note: None,
    }
}

fn ok_result(msg: impl Into<String>) -> ExecutableToolResult {
    ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: msg.into(),
        is_error: false,
        note: None,
    }
}

const TOWER_WORKER_PROFILE: &str = "tower-worker";

fn spawn_detached_run(
    manager: Arc<SubagentManager>,
    callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    agent_id: &str,
    prompt: &str,
    parent_cancel: Option<crate::subagent::types::ParentCancel>,
) {
    let agent = agent_id.to_string();
    let prompt = prompt.to_string();
    tokio::spawn(async move {
        // Mirror the swarm launcher's terminal handling: pass the parent cancel
        // so a detached worker stops when the user cancels or the session ends
        // (run_foreground_turn aborts the turn and kills the instance), and emit
        // a terminal event for *every* outcome so the worker's card never sticks
        // in "running" — the previous `let _ = …map(…)` swallowed the error and
        // cancelled arms and only ever reported a clean completion.
        let outcome = manager
            .run_foreground_turn(&agent, &prompt, parent_cancel.as_ref())
            .await;
        let rate_limit = TowerRateLimit::global();
        rate_limit.release();
        match outcome {
            Ok(crate::subagent::manager::ForegroundTurnOutcome::Completed(turn)) => {
                rate_limit.report_success();
                if matches!(
                    turn.stop_reason,
                    crate::turn_loop::types::LoopTurnStopReason::Aborted
                ) {
                    callbacks.emit_event(serde_json::json!({
                        "type": "subagent.failed",
                        "subagent_id": agent,
                        "error": "The tower worker was stopped before it finished.",
                    }));
                } else {
                    let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
                    callbacks.emit_event(serde_json::json!({
                        "type": "subagent.completed",
                        "subagent_id": agent,
                        "result_summary": summary,
                        "usage": crate::tools::agent_tool::usage_json(&turn.usage),
                    }));
                }
            }
            Ok(crate::subagent::manager::ForegroundTurnOutcome::ParentCancelled) => {
                callbacks.emit_event(serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": agent,
                    "error": "The tower worker was stopped by the user before it finished.",
                }));
            }
            Err(err) => {
                if err.contains("rate limit") || err.contains("429") {
                    rate_limit.report_rate_limited();
                }
                callbacks.emit_event(serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": agent,
                    "error": err,
                }));
            }
        }
    });
}

pub async fn execute_tower_init(
    cwd: &Path,
    caller_agent_id: &str,
    session_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    if caller_agent_id != "main" {
        return err_result(TOWER_MAIN_AGENT_ONLY);
    }

    #[derive(Deserialize, Default)]
    struct InitArgs {
        base: Option<String>,
    }
    let args: InitArgs = serde_json::from_str(raw_args).unwrap_or_default();

    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    match store.init(Some(session_id.to_string()), args.base).await {
        Ok(res) => {
            let mut lines = vec![
                if res.created {
                    "tower workspace initialized".to_string()
                } else {
                    "tower workspace already initialized — existing state preserved".to_string()
                },
                format!("base branch: {}", res.base),
            ];
            if let Some(ignored) = res.ignored_base {
                lines.push(format!(
                    "requested base \"{ignored}\" ignored — the existing workspace already records base \"{}\"; tear it down first to rebase the tower",
                    res.base
                ));
            }
            if res.checkout != res.base {
                if res.checkout == "HEAD" {
                    lines.push(format!(
                        "note: the main checkout is in a detached HEAD state — merges stay blocked until the base is checked out (git checkout {})",
                        res.base
                    ));
                } else {
                    lines.push(format!(
                        "note: the main checkout is on \"{}\", not base \"{}\" — merges stay blocked until it is switched over (git checkout {})",
                        res.checkout, res.base, res.base
                    ));
                }
            }
            lines.push(
                "workspace: .tower/ (comms under .tower/comms/, worktrees under .tower/worktrees/)"
                    .to_string(),
            );
            if !res.open_missions.is_empty() {
                lines.push(format!(
                    "carried-over open missions: {} — their scopes are still reserved. Continue them (TowerSpawn fresh workers), or — when they belong to an unrelated earlier task — abandon them first (TowerMission status=abandoned) so a new plan can use those files.",
                    res.open_missions.join(", ")
                ));
            }
            if !res.retired_agents.is_empty() {
                lines.push(format!(
                    "adopted from a previous session — retired its stale roster entries: {}. Their agents belong to the dead session and cannot be resumed; missions and worktrees are preserved — TowerSpawn fresh workers to continue them.",
                    res.retired_agents.join(", ")
                ));
            }
            lines.push(String::new());
            lines.push("Tower mode is active and the tower tool set is enabled.".to_string());
            lines.push("Next: split the work with TowerPlan (one mission per disjoint file scope), then TowerSpawn a worker per mission. Assign reviewers for their branches, and merge with TowerMerge only after a clean review.".to_string());

            ok_result(lines.join("\n"))
        }
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_plan(
    cwd: &Path,
    caller_agent_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    if caller_agent_id != "main" {
        return err_result(TOWER_MAIN_AGENT_ONLY);
    }

    #[derive(Deserialize)]
    struct PlanArgs {
        missions: Vec<TowerPlanInput>,
    }
    let args: PlanArgs = match serde_json::from_str(raw_args) {
        Ok(a) => a,
        Err(e) => return err_result(format!("failed to parse TowerPlan input: {e}")),
    };

    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    match store.plan(&args.missions).await {
        Ok(missions) => {
            let mut lines = vec![
                format!("planned {} mission(s):", missions.len()),
                String::new(),
                "| ID | Mission | Kind | Branch | Worktree | Scope |".to_string(),
                "| -- | ------- | ---- | ------ | -------- | ----- |".to_string(),
            ];
            for m in &missions {
                lines.push(format!(
                    "| {} | {} | {} | {} | {} | {} |",
                    m.id,
                    m.title,
                    m.kind.as_str(),
                    m.branch,
                    m.worktree,
                    m.scope.join(", ")
                ));
            }
            lines.push(String::new());
            lines.push("Next: TowerSpawn one worker per mission (workers get their worktree path and mission briefing automatically), plus reviewers for the branches. Survey missions need no reviewer — they close with a zero-diff TowerMerge.".to_string());
            ok_result(lines.join("\n"))
        }
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_spawn(
    cwd: &Path,
    caller_agent_id: &str,
    session_id: &str,
    subagent_manager: Option<&Arc<SubagentManager>>,
    tool_call_id: Option<&str>,
    parent_cancel: Option<&crate::subagent::types::ParentCancel>,
    raw_args: &str,
) -> Option<ExecutableToolResult> {
    if caller_agent_id != "main" {
        return Some(err_result(TOWER_MAIN_AGENT_ONLY));
    }

    #[derive(Deserialize)]
    struct SpawnArgs {
        name: String,
        kind: String,
        mission_id: Option<String>,
        review_target: Option<String>,
        instructions: Option<String>,
    }
    let args: SpawnArgs = match serde_json::from_str(raw_args) {
        Ok(a) => a,
        Err(e) => return Some(err_result(format!("failed to parse TowerSpawn input: {e}"))),
    };

    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(&repo_root));
    // Serialize this repo's tower state against concurrent workers (see above).
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    let state = match store.load().await {
        Ok(s) => s,
        Err(e) => return Some(err_result(e)),
    };

    if let Some(existing) = store.find_agent(&state, &args.name) {
        return Some(err_result(format!(
            "tower agent \"{}\" already exists — resume it with Agent(resume=\"{}\", prompt=\"...\") instead",
            args.name, existing.agent_id
        )));
    }

    struct TowerSlotGuard {
        held: bool,
    }
    impl TowerSlotGuard {
        fn acquire() -> Result<Self, String> {
            TowerRateLimit::global()
                .acquire()
                .map(|()| Self { held: true })
        }
        fn disarm(mut self) {
            self.held = false;
        }
    }
    impl Drop for TowerSlotGuard {
        fn drop(&mut self) {
            if self.held {
                TowerRateLimit::global().release();
            }
        }
    }

    let slot = match TowerSlotGuard::acquire() {
        Ok(s) => s,
        Err(reason) => return Some(err_result(reason)),
    };

    let spawned_at = chrono::Utc::now().to_rfc3339();

    match args.kind.as_str() {
        "worker" => {
            let Some(ref mid) = args.mission_id else {
                return Some(err_result("worker spawns require mission_id"));
            };
            let Some(mission) = state.missions.iter().find(|m| &m.id == mid).cloned() else {
                return Some(err_result(format!("unknown mission \"{mid}\"")));
            };

            let manager = subagent_manager?;
            let runtime = manager.runtime().await?;
            manager.get_definition(TOWER_WORKER_PROFILE).await?;

            if let Err(e) = store
                .add_worktree(&mission.worktree, &mission.branch, &state.base)
                .await
            {
                return Some(err_result(format!("failed to create worktree: {e}")));
            }

            let _ = store
                .update_mission(
                    "tower",
                    &mission.id,
                    TowerMissionPatch {
                        owner: Some(args.name.clone()),
                        ..Default::default()
                    },
                )
                .await;

            let worktree_abs = store.abs(&format!("{WORKTREES_DIR}/{}", mission.worktree));
            let prompt = build_worker_prompt(
                &args.name,
                &mission,
                &worktree_abs,
                &state.base,
                args.instructions.as_deref(),
            );
            let agent_id = match manager.spawn(TOWER_WORKER_PROFILE, &args.name).await {
                Ok(id) => id,
                Err(e) => return Some(err_result(format!("failed to spawn worker: {e}"))),
            };

            let entry = TowerRosterEntry {
                name: args.name.clone(),
                agent_id: agent_id.clone(),
                session_id: Some(session_id.to_string()),
                kind: crate::tools::tower::types::TowerAgentKind::Worker,
                mission_id: Some(mission.id.clone()),
                review_target: None,
                worktree: Some(mission.worktree.clone()),
                branch: Some(mission.branch.clone()),
                spawned_at,
            };
            if let Err(e) = store.register_agent(entry).await {
                return Some(err_result(e));
            }

            crate::tools::agent_tool::emit_spawned_started(
                runtime.callbacks.as_ref(),
                &agent_id,
                TOWER_WORKER_PROFILE,
                tool_call_id,
                Some(&args.name),
                true,
            );
            slot.disarm();
            spawn_detached_run(
                manager.clone(),
                runtime.callbacks.clone(),
                &agent_id,
                &prompt,
                parent_cancel.cloned(),
            );

            let lines = [
                format!("name: {}", args.name),
                "kind: worker".to_string(),
                format!("agent_id: {agent_id}"),
                format!("task_id: {agent_id}"),
                "status: running".to_string(),
                format!("mission: {} — {}", mission.id, mission.title),
                format!("branch: {}", mission.branch),
                format!("worktree: {}", worktree_abs.to_string_lossy()),
                String::new(),
                "The worker runs detached in the background; its completion arrives as a notification. Track progress with TowerStatus / TowerInbox; recover a dead agent with Agent(resume=\"...\", prompt=\"...\").".to_string(),
            ];

            Some(ok_result(lines.join("\n")))
        }
        "reviewer" => {
            let Some(ref target) = args.review_target else {
                return Some(err_result("reviewer spawns require review_target"));
            };
            if !git::branch_exists(&store.repo_root, target).await {
                return Some(err_result(format!("branch \"{target}\" does not exist")));
            }

            let manager = subagent_manager?;
            let runtime = manager.runtime().await?;
            manager.get_definition(TOWER_WORKER_PROFILE).await?;

            let author = state
                .missions
                .iter()
                .find(|m| &m.branch == target)
                .and_then(|m| m.owner.as_deref());
            let prompt = build_reviewer_prompt(
                &args.name,
                target,
                &state.base,
                &store.repo_root,
                author,
                args.instructions.as_deref(),
            );
            let agent_id = match manager.spawn(TOWER_WORKER_PROFILE, &args.name).await {
                Ok(id) => id,
                Err(e) => return Some(err_result(format!("failed to spawn reviewer: {e}"))),
            };

            let entry = TowerRosterEntry {
                name: args.name.clone(),
                agent_id: agent_id.clone(),
                session_id: Some(session_id.to_string()),
                kind: crate::tools::tower::types::TowerAgentKind::Reviewer,
                mission_id: None,
                review_target: Some(target.clone()),
                worktree: None,
                branch: None,
                spawned_at,
            };
            if let Err(e) = store.register_agent(entry).await {
                return Some(err_result(e));
            }

            crate::tools::agent_tool::emit_spawned_started(
                runtime.callbacks.as_ref(),
                &agent_id,
                TOWER_WORKER_PROFILE,
                tool_call_id,
                Some(&args.name),
                true,
            );
            slot.disarm();
            spawn_detached_run(
                manager.clone(),
                runtime.callbacks.clone(),
                &agent_id,
                &prompt,
                parent_cancel.cloned(),
            );

            let lines = [
                format!("name: {}", args.name),
                "kind: reviewer".to_string(),
                format!("agent_id: {agent_id}"),
                format!("task_id: {agent_id}"),
                "status: running".to_string(),
                format!("review_target: {target}"),
                String::new(),
                "The reviewer runs detached in the background; its completion arrives as a notification. Track progress with TowerStatus / TowerInbox.".to_string(),
            ];

            Some(ok_result(lines.join("\n")))
        }
        other => Some(err_result(format!(
            "unknown kind \"{other}\" (expected worker | reviewer)"
        ))),
    }
}

fn build_worker_prompt(
    name: &str,
    mission: &crate::tools::tower::types::TowerMission,
    worktree: &Path,
    base: &str,
    instructions: Option<&str>,
) -> String {
    let extra = instructions
        .filter(|i| !i.trim().is_empty())
        .map(|i| format!("\n\n# Additional instructions from the tower\n{}", i.trim()))
        .unwrap_or_default();

    let workplace = format!(
        "# Your workplace\n- Your private git worktree: {}\n- Your branch: {} (base: {})\n- Address the worktree explicitly for code operations.\n- Scope: {}\n\n",
        worktree.to_string_lossy(),
        mission.branch,
        base,
        mission.scope.join(", ")
    );

    if mission.kind == crate::tools::tower::types::TowerMissionKind::Survey {
        format!(
            "You are \"{name}\", a tower worker agent assigned a READ-ONLY survey mission.\n\n\
            {workplace}\
            # Your mission\nMission {}: {}\n\n\
            # Read-only discipline\n\
            - Do NOT modify any code in the repo.\n\
            - Record findings as TowerMission notes and send summaries with TowerSend.\n\n\
            # When done\n\
            1. TowerMission(id=\"{}\", status=\"completed\")\n\
            2. TowerSend(to=\"tower\", subject=\"survey-summary\", body=result){extra}",
            mission.id, mission.title, mission.id
        )
    } else {
        format!(
            "You are \"{name}\", a tower worker agent in a multi-agent workspace.\n\n\
            {workplace}\
            # Your mission\nMission {}: {}\n\n\
            # Communication protocol\n\
            - Coordinate via TowerSend / TowerInbox / TowerFinding / TowerMission.\n\
            - Keep tasks up to date with TowerMission.\n\n\
            # When done\n\
            1. Commit your changes in the worktree.\n\
            2. TowerMission(id=\"{}\", status=\"completed\")\n\
            3. TowerSend(to=\"tower\", subject=\"review-request\", body=changes){extra}",
            mission.id, mission.title, mission.id
        )
    }
}

fn build_reviewer_prompt(
    name: &str,
    target: &str,
    base: &str,
    repo_root: &Path,
    author: Option<&str>,
    instructions: Option<&str>,
) -> String {
    let extra = instructions
        .filter(|i| !i.trim().is_empty())
        .map(|i| format!("\n\n# Additional instructions from the tower\n{}", i.trim()))
        .unwrap_or_default();

    let notify = match author {
        Some(a) => {
            format!("Notify the author: TowerSend(to=\"{a}\", subject=\"review-result\", ...)")
        }
        None => {
            "Notify the tower: TowerSend(to=\"tower\", subject=\"review-result\", ...)".to_string()
        }
    };

    format!(
        "You are \"{name}\", a tower reviewer agent.\n\n\
        # Your assignment\n\
        Review branch \"{target}\" against base \"{base}\" in {}.\n\
        - Work read-only via git diff / git log.\n\n\
        # When done\n\
        1. TowerReview(target=\"{target}\", status=\"clean\", merge=\"merge\", ...)\n\
        2. {notify}{extra}",
        repo_root.to_string_lossy()
    )
}

pub async fn execute_tower_merge(
    cwd: &Path,
    caller_agent_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    if caller_agent_id != "main" {
        return err_result(TOWER_MAIN_AGENT_ONLY);
    }

    #[derive(Deserialize)]
    struct MergeArgs {
        branch: String,
    }
    let args: MergeArgs = match serde_json::from_str(raw_args) {
        Ok(a) => a,
        Err(e) => return err_result(format!("failed to parse TowerMerge input: {e}")),
    };

    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    match store.merge(&args.branch).await {
        Ok((commit, conflicts, noop)) => {
            if noop {
                return ok_result(format!(
                    "{} is a read-only survey with a zero-diff branch — mission marked merged, no git merge needed.\nContinue with the remaining missions in Dependency Flow order.",
                    args.branch
                ));
            }
            let short_commit = if commit.len() >= 7 {
                &commit[..7]
            } else {
                &commit
            };
            let mut lines = vec![
                format!("merged {} (merge commit {short_commit})", args.branch),
                format!("full commit: {commit}"),
            ];
            if !conflicts.is_empty() {
                lines.push(String::new());
                lines.push("These unmerged branches changed the same files and now likely conflict with the base:".to_string());
                for (b, files) in conflicts {
                    lines.push(format!("- {b}: {}", files.join(", ")));
                }
                lines.push("Tell each affected worker (Agent resume) to rebase onto the updated base, resolve, push, and request a re-review.".to_string());
            } else {
                lines.push("The mission is now marked merged. Continue with the remaining missions in Dependency Flow order.".to_string());
            }
            ok_result(lines.join("\n"))
        }
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_teardown(
    cwd: &Path,
    caller_agent_id: &str,
    _session_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    if caller_agent_id != "main" {
        return err_result(TOWER_MAIN_AGENT_ONLY);
    }

    #[derive(Deserialize, Default)]
    struct TeardownArgs {
        #[serde(default)]
        force: Option<bool>,
    }
    let args: TeardownArgs = serde_json::from_str(raw_args).unwrap_or_default();

    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    match store.teardown(args.force.unwrap_or(false)).await {
        Ok(report) => {
            let mut lines = vec!["tower teardown:".to_string()];
            for item in report {
                lines.push(format!("- {item}"));
            }
            lines.push(String::new());
            lines.push("Tower mode exited. .tower/comms/ (state, inbox, findings, reviews, activity log) is kept as the audit trail — remove it by hand only if you are sure.".to_string());
            ok_result(lines.join("\n"))
        }
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_send(
    cwd: &Path,
    caller_agent_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    let state = match store.load().await {
        Ok(s) => s,
        Err(e) => return err_result(e),
    };

    let caller = match store.resolve_caller_name(&state, caller_agent_id) {
        Ok(c) => c,
        Err(e) => return err_result(e),
    };

    let input: TowerSendInput = match serde_json::from_str(raw_args) {
        Ok(i) => i,
        Err(e) => return err_result(format!("failed to parse TowerSend input: {e}")),
    };

    let to = input.to.clone();
    match store.send(&caller, input).await {
        Ok(rel) => ok_result(format!("message sent to {to}\nfile: {rel}")),
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_inbox(
    cwd: &Path,
    caller_agent_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    let state = match store.load().await {
        Ok(s) => s,
        Err(e) => return err_result(e),
    };

    let caller = match store.resolve_caller_name(&state, caller_agent_id) {
        Ok(c) => c,
        Err(e) => return err_result(e),
    };

    #[derive(Deserialize, Default)]
    struct InboxArgs {
        limit: Option<usize>,
    }
    let args: InboxArgs = serde_json::from_str(raw_args).unwrap_or_default();

    match store.read_inbox(&caller, args.limit.unwrap_or(20)).await {
        Ok(items) => {
            if items.is_empty() {
                return ok_result(format!("inbox empty for {caller}"));
            }
            let mut sections = Vec::new();
            for item in &items {
                let mut header = vec![
                    format!("file: {}", item.file),
                    format!("from: {}", item.from),
                    format!("to: {}", item.to),
                    format!("subject: {}", item.subject),
                    format!("sent_at: {}", item.sent_at),
                ];
                if let Some(ref s) = item.scope {
                    header.push(format!("scope: {s}"));
                }
                if let Some(ref a) = item.action {
                    header.push(format!("action: {a}"));
                }
                header.push(String::new());
                header.push(item.body.clone());
                sections.push(header.join("\n"));
            }
            let output = format!(
                "{} message(s) for {caller} (newest first):\n\n{}",
                items.len(),
                sections.join("\n\n---\n\n")
            );
            ok_result(output)
        }
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_finding(
    cwd: &Path,
    caller_agent_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    let state = match store.load().await {
        Ok(s) => s,
        Err(e) => return err_result(e),
    };

    let caller = match store.resolve_caller_name(&state, caller_agent_id) {
        Ok(c) => c,
        Err(e) => return err_result(e),
    };

    let input: TowerFindingInput = match serde_json::from_str(raw_args) {
        Ok(i) => i,
        Err(e) => return err_result(format!("failed to parse TowerFinding input: {e}")),
    };

    match store.file_finding(&caller, input).await {
        Ok(rel) => ok_result(format!(
            "finding filed: {rel}\nThe tower will route it — do not fix out-of-scope issues yourself."
        )),
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_review(
    cwd: &Path,
    caller_agent_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    let state = match store.load().await {
        Ok(s) => s,
        Err(e) => return err_result(e),
    };

    let caller = match store.resolve_caller_name(&state, caller_agent_id) {
        Ok(c) => c,
        Err(e) => return err_result(e),
    };

    let input: TowerReviewInput = match serde_json::from_str(raw_args) {
        Ok(i) => i,
        Err(e) => return err_result(format!("failed to parse TowerReview input: {e}")),
    };

    match store.submit_review(&caller, input).await {
        Ok(rel) => ok_result(format!(
            "review submitted: {rel}\nAlso notify the branch author (or the tower) with TowerSend so the verdict is seen."
        )),
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_mission(
    cwd: &Path,
    caller_agent_id: &str,
    raw_args: &str,
) -> ExecutableToolResult {
    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(&repo_root));
    // Serialize this repo's tower state against concurrent workers (see above).
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    let state = match store.load().await {
        Ok(s) => s,
        Err(e) => return err_result(e),
    };

    let caller = match store.resolve_caller_name(&state, caller_agent_id) {
        Ok(c) => c,
        Err(e) => return err_result(e),
    };

    #[derive(Deserialize)]
    struct MissionArgs {
        id: String,
        status: Option<crate::tools::tower::types::TowerMissionStatus>,
        note: Option<String>,
        blocker: Option<String>,
        clear_blockers: Option<bool>,
        task_done: Option<String>,
        scope: Option<Vec<String>>,
    }
    let args: MissionArgs = match serde_json::from_str(raw_args) {
        Ok(a) => a,
        Err(e) => return err_result(format!("failed to parse TowerMission input: {e}")),
    };

    let has_patch = args.status.is_some()
        || args.note.is_some()
        || args.blocker.is_some()
        || args.clear_blockers.is_some()
        || args.task_done.is_some()
        || args.scope.is_some();

    if !has_patch {
        let Some(mission) = state.missions.iter().find(|m| m.id == args.id) else {
            let known = state
                .missions
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return err_result(format!(
                "unknown mission \"{}\" — known missions: {}",
                args.id,
                if known.is_empty() {
                    "(none planned yet)"
                } else {
                    &known
                }
            ));
        };
        let file_path = store.abs(&format!(
            "{MISSIONS_DIR}/{}",
            mission_file_name(&mission.id, &mission.slug)
        ));
        let content = tokio::fs::read_to_string(&file_path)
            .await
            .unwrap_or_default();
        return ok_result(content);
    }

    let patch = TowerMissionPatch {
        status: args.status,
        note: args.note,
        blocker: args.blocker,
        clear_blockers: args.clear_blockers,
        task_done: args.task_done,
        owner: None,
        scope: args.scope,
    };

    match store.update_mission(&caller, &args.id, patch).await {
        Ok(mission) => {
            let open_tasks = mission.tasks.iter().filter(|t| !t.done).count();
            let file_path = store.abs(&format!(
                "{MISSIONS_DIR}/{}",
                mission_file_name(&mission.id, &mission.slug)
            ));
            let content = tokio::fs::read_to_string(&file_path)
                .await
                .unwrap_or_default();
            let msg = format!(
                "mission {} updated — status: {}, open tasks: {open_tasks}, blockers: {}\n\n{content}",
                mission.id,
                mission.status.as_str(),
                mission.blockers.len()
            );
            ok_result(msg)
        }
        Err(e) => err_result(e),
    }
}

pub async fn execute_tower_status(cwd: &Path, caller_agent_id: &str) -> ExecutableToolResult {
    let repo_root = resolve_tower_repo_root(&cwd.to_string_lossy());
    let store = TowerStore::new(PathBuf::from(repo_root));
    // Serialize this repo's tower state against concurrent workers: hold the
    // per-repo lock across the whole operation so its load→mutate→save cannot
    // interleave with another agent's and lose an update.
    let state_lock = store.state_lock();
    let _state_guard = state_lock.lock().await;

    let state = match store.load().await {
        Ok(s) => s,
        Err(e) => return err_result(e),
    };

    let caller = match store.resolve_caller_name(&state, caller_agent_id) {
        Ok(c) => c,
        Err(e) => return err_result(e),
    };

    let mut sections = vec![
        format!(
            "# Tower status — base: {} (mode: {}), you are: {caller}",
            state.base, state.mode
        ),
        String::new(),
        "## Missions".to_string(),
        String::new(),
    ];

    if state.missions.is_empty() {
        sections.push("(no missions planned yet)".to_string());
    } else {
        for m in &state.missions {
            let owner = m.owner.as_deref().unwrap_or("—");
            sections.push(format!(
                "- {} {}: {} [{}] (branch: {}, worktree: {}, owner: {})",
                m.status.emoji(),
                m.id,
                m.title,
                m.status.as_str(),
                m.branch,
                m.worktree,
                owner
            ));
        }
    }

    sections.push(String::new());
    sections.push("## Roster".to_string());
    sections.push(String::new());

    if state.roster.agents.is_empty() {
        sections.push("(no agents spawned yet)".to_string());
    } else {
        for a in &state.roster.agents {
            sections.push(format!(
                "- {} ({:?}) — agent_id: {}",
                a.name, a.kind, a.agent_id
            ));
        }
    }

    sections.push(String::new());
    sections.push("## Review gate (unmerged branches)".to_string());
    sections.push(String::new());

    let mut unmerged_count = 0;
    for m in &state.missions {
        if m.status.is_open() {
            unmerged_count += 1;
            let review = store.latest_review(&m.branch).await;
            match review {
                Some(r) => sections.push(format!(
                    "- {}: latest review round {} by {} is \"{}\" (merge: {})",
                    m.branch, r.round, r.reviewer, r.status, r.merge
                )),
                None => sections.push(format!("- {}: no review submitted yet", m.branch)),
            }
        }
    }
    if unmerged_count == 0 {
        sections.push("(all missions are merged or abandoned)".to_string());
    }

    if !state.missions.is_empty() && state.missions.iter().all(|m| !m.status.is_open()) {
        sections.push(String::new());
        sections.push("## Done".to_string());
        sections.push(String::new());
        sections.push("All missions are merged or abandoned. Free the worktree checkouts now: run TowerTeardown (branches and .tower/comms/ are kept; dirty worktrees are protected).".to_string());
    }

    let inbox = store.read_inbox(&caller, 1000).await.unwrap_or_default();
    sections.push(String::new());
    sections.push("## Inbox".to_string());
    sections.push(String::new());
    sections.push(format!(
        "{} message(s) visible to you — read with TowerInbox.",
        inbox.len()
    ));

    sections.push(String::new());
    sections.push("## Concurrency (adaptive)".to_string());
    sections.push(String::new());
    sections.push(TowerRateLimit::global().render_concurrency());

    sections.push(String::new());
    sections.push("## Recent activity".to_string());
    sections.push(String::new());
    let logs = store.recent_log(10).await;
    if logs.is_empty() {
        sections.push("(activity log is empty)".to_string());
    } else {
        sections.extend(logs);
    }

    ok_result(sections.join("\n"))
}

pub fn tower_tool_defs() -> Vec<ToolInfo> {
    vec![
        ToolInfo {
            name: "TowerInit".into(),
            description:
                "Initialize tower multi-agent orchestration workspace in the current repository"
                    .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "base": { "type": "string", "description": "Base branch for the tower (defaults to current branch)" }
                }
            }),
        },
        ToolInfo {
            name: "TowerPlan".into(),
            description: "Plan tower missions with disjoint file scopes".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["missions"],
                "properties": {
                    "missions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["title", "scope"],
                            "properties": {
                                "title": { "type": "string" },
                                "scope": { "type": "array", "items": { "type": "string" } },
                                "tasks": { "type": "array", "items": { "type": "string" } },
                                "deps": { "type": "array", "items": { "type": "string" } },
                                "kind": { "type": "string", "enum": ["build", "survey"] }
                            }
                        }
                    }
                }
            }),
        },
        ToolInfo {
            name: "TowerSpawn".into(),
            description: "Spawn a worker or reviewer tower subagent".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["name", "kind"],
                "properties": {
                    "name": { "type": "string" },
                    "kind": { "type": "string", "enum": ["worker", "reviewer"] },
                    "mission_id": { "type": "string" },
                    "review_target": { "type": "string" },
                    "instructions": { "type": "string" }
                }
            }),
        },
        ToolInfo {
            name: "TowerMerge".into(),
            description: "Merge a completed tower mission branch back into base".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["branch"],
                "properties": {
                    "branch": { "type": "string" }
                }
            }),
        },
        ToolInfo {
            name: "TowerTeardown".into(),
            description: "Tear down tower worktrees and exit tower mode".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "force": { "type": "boolean" }
                }
            }),
        },
        ToolInfo {
            name: "TowerSend".into(),
            description: "Send an inbox message to another tower agent or broadcast".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["to", "subject", "body"],
                "properties": {
                    "to": { "type": "string" },
                    "subject": { "type": "string" },
                    "body": { "type": "string" },
                    "scope": { "type": "string" },
                    "action": { "type": "string" },
                    "consent_ref": { "type": "string" }
                }
            }),
        },
        ToolInfo {
            name: "TowerInbox".into(),
            description: "Read messages from your tower inbox".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer" }
                }
            }),
        },
        ToolInfo {
            name: "TowerFinding".into(),
            description: "Record an out-of-scope finding for the tower to route".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["type", "title", "summary", "details", "suggested_fix"],
                "properties": {
                    "type": { "type": "string", "enum": ["bug", "improve", "vuln", "idea"] },
                    "title": { "type": "string" },
                    "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
                    "summary": { "type": "string" },
                    "location": { "type": "string" },
                    "details": { "type": "string" },
                    "suggested_fix": { "type": "string" }
                }
            }),
        },
        ToolInfo {
            name: "TowerReview".into(),
            description: "Submit a code review for a mission branch".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["target", "status", "merge", "findings", "decision"],
                "properties": {
                    "target": { "type": "string" },
                    "status": { "type": "string" },
                    "merge": { "type": "string", "enum": ["merge", "fix-then-merge", "hold"] },
                    "findings": { "type": "string" },
                    "checks": { "type": "array", "items": { "type": "string" } },
                    "decision": { "type": "string" }
                }
            }),
        },
        ToolInfo {
            name: "TowerMission".into(),
            description: "Inspect or update a tower mission's status, notes, or tasks".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": { "type": "string" },
                    "status": { "type": "string" },
                    "note": { "type": "string" },
                    "blocker": { "type": "string" },
                    "clear_blockers": { "type": "boolean" },
                    "task_done": { "type": "string" },
                    "scope": { "type": "array", "items": { "type": "string" } }
                }
            }),
        },
        ToolInfo {
            name: "TowerStatus".into(),
            description: "Check the overall status of tower missions, roster, reviews, and inbox"
                .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        },
    ]
}
