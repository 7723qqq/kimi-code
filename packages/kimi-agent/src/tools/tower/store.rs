use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::tools::tower::frontmatter::{parse_frontmatter, render_frontmatter};
use crate::tools::tower::git::{
    branch_exists, branch_tip, current_branch, diff_name_only, has_any_commit, is_inside_repo,
    is_worktree_dirty, merge_no_ff, worktree_add, worktree_remove,
};
use crate::tools::tower::paths::{
    ACTIVITY_LOG, BROADCAST_NAME, FINDINGS_DIR, INBOX_DIR, LOG_DIR, MISSIONS_DIR, MISSIONS_INDEX,
    REVIEWS_DIR, STATE_FILE, TOWER_NAME, WORKTREES_DIR, date_dash, finding_file_name,
    inbox_file_name, mission_file_name, review_file_name, slugify, target_slug,
};
use crate::tools::tower::types::{
    TowerFindingInput, TowerInboxItem, TowerInitResult, TowerMission, TowerMissionPatch,
    TowerMissionStatus, TowerPlanInput, TowerReviewInfo, TowerReviewInput, TowerRoster,
    TowerRosterEntry, TowerSendInput, TowerState,
};

/// Process-global tower-state locks keyed by the resolved repo root. Tower
/// workers run as concurrent tasks in one engine process and share a single
/// `.tower/comms/state.json`; every read-modify-write must be serialized per
/// repo so a later save cannot clobber an earlier one (lost update) or publish
/// a half-written file. Keyed by the *resolved* root so a worktree cwd and the
/// main checkout contend on one lock. The guard is held across a whole
/// `execute_tower_*` call — the outermost entry — so the store's own methods
/// nest freely (init → adopt_foreign_roster → save) without re-entering a
/// non-reentrant mutex.
static REPO_STATE_LOCKS: OnceLock<StdMutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

fn state_lock_for(root: &Path) -> Arc<Mutex<()>> {
    let registry = REPO_STATE_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut map = registry.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(root.to_path_buf()).or_default().clone()
}

pub struct TowerStore {
    pub repo_root: PathBuf,
}

impl TowerStore {
    pub fn new<P: Into<PathBuf>>(repo_root: P) -> Self {
        Self {
            repo_root: repo_root.into(),
        }
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        self.repo_root.join(rel)
    }

    /// The process-global mutex serializing this repo's tower state mutations.
    /// Bind the returned `Arc` before locking so the guard can borrow it:
    /// `let lock = store.state_lock(); let _guard = lock.lock().await;`.
    pub fn state_lock(&self) -> Arc<Mutex<()>> {
        state_lock_for(&self.repo_root)
    }

    pub async fn is_initialized(&self) -> bool {
        fs::metadata(self.abs(STATE_FILE)).await.is_ok()
    }

    pub async fn init(
        &self,
        session_id: Option<String>,
        base: Option<String>,
    ) -> Result<TowerInitResult, String> {
        if !is_inside_repo(&self.repo_root).await {
            return Err(
                "tower needs a git repository (the session working directory is not inside one)"
                    .into(),
            );
        }
        if !has_any_commit(&self.repo_root).await {
            return Err(
                "the repository has no commits yet — create an initial commit first".into(),
            );
        }
        if self.is_initialized().await {
            let mut state = self.load().await?;
            let retired_agents = self.adopt_foreign_roster(&mut state, session_id).await?;
            let checkout = self.checked_out_branch().await;
            let ignored_base = if let Some(ref b) = base {
                if b != &state.base {
                    Some(b.clone())
                } else {
                    None
                }
            } else {
                None
            };
            let open_missions = state
                .missions
                .iter()
                .filter(|m| m.status.is_open())
                .map(|m| m.id.clone())
                .collect();
            return Ok(TowerInitResult {
                base: state.base,
                created: false,
                retired_agents,
                checkout,
                ignored_base,
                open_missions,
            });
        }

        let checkout = self.checked_out_branch().await;
        let resolved_base = match base {
            Some(b) => {
                if !branch_exists(&self.repo_root, &b).await {
                    return Err(format!(
                        "base branch \"{b}\" does not exist as a local branch — merges land on a local branch, so remote-tracking refs and tags are not accepted; create a local branch first"
                    ));
                }
                b
            }
            None => {
                if checkout == "HEAD" {
                    return Err("cannot determine the base branch from a detached HEAD — pass the base branch explicitly".into());
                }
                checkout.clone()
            }
        };

        for dir in &[
            INBOX_DIR,
            FINDINGS_DIR,
            REVIEWS_DIR,
            MISSIONS_DIR,
            LOG_DIR,
            WORKTREES_DIR,
        ] {
            fs::create_dir_all(self.abs(dir))
                .await
                .map_err(|e| e.to_string())?;
        }
        self.ensure_git_exclude().await?;

        let state = TowerState {
            version: 1,
            base: resolved_base.clone(),
            mode: "branch".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            session_id,
            roster: TowerRoster::default(),
            missions: Vec::new(),
        };
        self.save(&state).await?;
        fs::write(self.abs(ACTIVITY_LOG), b"")
            .await
            .map_err(|e| e.to_string())?;
        self.render_missions_index(&state).await?;
        self.append_log(
            TOWER_NAME,
            "init",
            &[("mode", &state.mode), ("base", &resolved_base)],
            Some(MISSIONS_INDEX),
        )
        .await?;

        Ok(TowerInitResult {
            base: resolved_base,
            created: true,
            retired_agents: Vec::new(),
            checkout,
            open_missions: Vec::new(),
            ignored_base: None,
        })
    }

    async fn checked_out_branch(&self) -> String {
        current_branch(&self.repo_root)
            .await
            .unwrap_or_else(|_| "HEAD".into())
    }

    async fn adopt_foreign_roster(
        &self,
        state: &mut TowerState,
        session_id: Option<String>,
    ) -> Result<Vec<String>, String> {
        let Some(ref sid) = session_id else {
            return Ok(Vec::new());
        };
        if state.session_id.as_deref() == Some(sid.as_str()) {
            return Ok(Vec::new());
        }

        let previous = state.session_id.clone();
        let stale: Vec<String> = state
            .roster
            .agents
            .iter()
            .filter(|a| a.session_id.as_deref() != Some(sid.as_str()))
            .map(|a| a.name.clone())
            .collect();

        state
            .roster
            .agents
            .retain(|a| a.session_id.as_deref() == Some(sid.as_str()));
        state.session_id = Some(sid.clone());
        self.save(state).await?;

        let retired_str = stale.join(",");
        self.append_log(
            TOWER_NAME,
            "adopt",
            &[
                ("session", sid.as_str()),
                ("previous", previous.as_deref().unwrap_or("unknown")),
                ("retired", if stale.is_empty() { "" } else { &retired_str }),
            ],
            None,
        )
        .await?;

        Ok(stale)
    }

    async fn ensure_git_exclude(&self) -> Result<(), String> {
        let git_dir = match read_git_dir(&self.repo_root).await {
            Some(d) => PathBuf::from(d),
            None => self.repo_root.join(".git"),
        };
        let exclude_path = git_dir.join("info").join("exclude");
        if let Some(parent) = exclude_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        let existing = fs::read_to_string(&exclude_path).await.unwrap_or_default();
        if existing.lines().any(|l| l.trim() == ".tower/") {
            return Ok(());
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&exclude_path)
            .await
            .map_err(|e| e.to_string())?;
        let newline = if existing.ends_with('\n') || existing.is_empty() {
            ""
        } else {
            "\n"
        };
        file.write_all(format!("{newline}.tower/\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn load(&self) -> Result<TowerState, String> {
        let path = self.abs(STATE_FILE);
        let raw = fs::read_to_string(&path)
            .await
            .map_err(|_| "tower is not initialized in this repository — run TowerInit first")?;
        serde_json::from_str(&raw).map_err(|e| format!("corrupted tower state: {e}"))
    }

    pub async fn save(&self, state: &TowerState) -> Result<(), String> {
        let file = self.abs(STATE_FILE);
        // A random suffix keeps two saves from ever interleaving into one tmp
        // file and publishing a half-written state.json; the rename below is
        // atomic either way, and the per-repo lock already serializes writers.
        let tmp = format!("{}.{}.tmp", file.to_string_lossy(), fastrand::u64(..));
        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        fs::write(&tmp, format!("{json}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        fs::rename(&tmp, &file).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn append_log(
        &self,
        actor: &str,
        action: &str,
        details: &[(&str, &str)],
        ref_path: Option<&str>,
    ) -> Result<(), String> {
        let mut parts = vec![
            chrono::Utc::now().to_rfc3339(),
            actor.to_string(),
            action.to_string(),
        ];
        for &(k, v) in details {
            if !v.is_empty() {
                parts.push(format!("{k}={v}"));
            }
        }
        if let Some(r) = ref_path {
            parts.push(format!("ref={r}"));
        }
        let line = format!("{}\n", parts.join(" "));
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.abs(ACTIVITY_LOG))
            .await
            .map_err(|e| e.to_string())?;
        file.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn recent_log(&self, lines_count: usize) -> Vec<String> {
        let content = fs::read_to_string(self.abs(ACTIVITY_LOG))
            .await
            .unwrap_or_default();
        let all: Vec<String> = content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect();
        all.iter().rev().take(lines_count).rev().cloned().collect()
    }

    pub fn resolve_caller_name(
        &self,
        state: &TowerState,
        agent_id: &str,
    ) -> Result<String, String> {
        if agent_id == "main" {
            return Ok(TOWER_NAME.into());
        }
        if let Some(entry) = state.roster.agents.iter().find(|a| a.agent_id == agent_id) {
            return Ok(entry.name.clone());
        }
        Err(format!(
            "agent \"{agent_id}\" is not a tower participant — only spawned workers/reviewers and the tower can use tower tools"
        ))
    }

    pub fn find_agent(&self, state: &TowerState, name: &str) -> Option<TowerRosterEntry> {
        state.roster.agents.iter().find(|a| a.name == name).cloned()
    }

    pub async fn register_agent(&self, entry: TowerRosterEntry) -> Result<(), String> {
        let mut state = self.load().await?;
        if self.find_agent(&state, &entry.name).is_some() {
            return Err(format!(
                "tower agent name \"{}\" is already registered",
                entry.name
            ));
        }
        state.roster.agents.push(entry);
        self.save(&state).await
    }

    pub async fn plan(&self, input: &[TowerPlanInput]) -> Result<Vec<TowerMission>, String> {
        if input.is_empty() {
            return Err("TowerPlan needs at least one mission".into());
        }
        let mut state = self.load().await?;
        let start_index = state.missions.len();

        let missions: Vec<TowerMission> = input
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let n = start_index + index + 1;
                let slug = slugify(&item.title, 40);
                TowerMission {
                    id: format!("M{n}"),
                    title: item.title.clone(),
                    slug: slug.clone(),
                    kind: item.kind.unwrap_or_default(),
                    scope: item.scope.clone(),
                    branch: format!("feat/{slug}"),
                    worktree: format!("wt-{n}"),
                    deps: item.deps.clone().unwrap_or_default(),
                    status: TowerMissionStatus::Planned,
                    tasks: item
                        .tasks
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|text| crate::tools::tower::types::TowerMissionTask {
                            text,
                            done: false,
                        })
                        .collect(),
                    notes: Vec::new(),
                    blockers: Vec::new(),
                    owner: None,
                }
            })
            .collect();

        let known_ids: std::collections::HashSet<String> = state
            .missions
            .iter()
            .map(|m| m.id.clone())
            .chain(missions.iter().map(|m| m.id.clone()))
            .collect();

        for mission in &missions {
            for dep in &mission.deps {
                if !known_ids.contains(dep) {
                    return Err(format!(
                        "mission {} depends on unknown mission \"{dep}\"",
                        mission.id
                    ));
                }
            }
        }

        let all_open: Vec<TowerMission> = state
            .missions
            .iter()
            .filter(|m| m.status.is_open())
            .cloned()
            .chain(missions.clone())
            .collect();
        self.assert_scopes_disjoint(&all_open)?;

        state.missions.extend(missions.clone());
        self.save(&state).await?;
        self.render_missions_index(&state).await?;
        for mission in &missions {
            self.render_mission_file(mission).await?;
        }

        let ids = missions
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        self.append_log(
            TOWER_NAME,
            "plan",
            &[("missions", &ids)],
            Some(MISSIONS_INDEX),
        )
        .await?;

        Ok(missions)
    }

    pub fn assert_scopes_disjoint(&self, missions: &[TowerMission]) -> Result<(), String> {
        let mut scopes = Vec::new();
        for mission in missions {
            if mission.kind == crate::tools::tower::types::TowerMissionKind::Survey {
                continue;
            }
            for raw in &mission.scope {
                let stem = raw
                    .trim_end_matches("/**")
                    .trim_end_matches("/*")
                    .trim_end_matches('*')
                    .trim_end_matches('/');
                if stem.is_empty() {
                    return Err(format!(
                        "mission {} scope \"{raw}\" covers the whole repo — narrow it down",
                        mission.id
                    ));
                }
                scopes.push((mission.id.clone(), raw.clone(), stem.to_string()));
            }
        }

        for i in 0..scopes.len() {
            for j in (i + 1)..scopes.len() {
                let (id_a, raw_a, stem_a) = &scopes[i];
                let (id_b, raw_b, stem_b) = &scopes[j];
                if id_a == id_b {
                    continue;
                }
                if stem_a == stem_b
                    || stem_a.starts_with(&format!("{stem_b}/"))
                    || stem_b.starts_with(&format!("{stem_a}/"))
                {
                    return Err(format!(
                        "mission scopes overlap: {id_a} (\"{raw_a}\") vs {id_b} (\"{raw_b}\") — split the shared files into exactly one mission; if one of them is stale finished work, abandon it first (TowerMission status=abandoned)"
                    ));
                }
            }
        }
        Ok(())
    }

    pub async fn update_mission(
        &self,
        caller_name: &str,
        id: &str,
        patch: TowerMissionPatch,
    ) -> Result<TowerMission, String> {
        let mut state = self.load().await?;
        if !state.missions.iter().any(|m| m.id == id) {
            return Err(format!("unknown mission \"{id}\""));
        }

        if caller_name != TOWER_NAME {
            let caller = self.find_agent(&state, caller_name);
            if caller.as_ref().and_then(|c| c.mission_id.as_deref()) != Some(id) {
                return Err(format!(
                    "agent \"{caller_name}\" does not own mission {id} — workers update only their own mission file"
                ));
            }
        }

        if patch.owner.is_some() && caller_name != TOWER_NAME {
            return Err(format!(
                "agent \"{caller_name}\" cannot assign mission ownership — only the tower sets owner"
            ));
        }

        if let Some(ref scope) = patch.scope {
            if caller_name != TOWER_NAME {
                return Err(format!(
                    "agent \"{caller_name}\" cannot change mission scope — only the tower widens a scope, and every change is logged"
                ));
            }
            let mut test_missions = state
                .missions
                .iter()
                .filter(|m| m.id != id && m.status.is_open())
                .cloned()
                .collect::<Vec<_>>();
            let mut patched_m = state
                .missions
                .iter()
                .find(|m| m.id == id)
                .cloned()
                .expect("mission existence checked above");
            patched_m.scope = scope.clone();
            test_missions.push(patched_m);
            self.assert_scopes_disjoint(&test_missions)?;
        }

        let mission = state
            .missions
            .iter_mut()
            .find(|m| m.id == id)
            .expect("mission existence checked above");

        if let Some(ref owner) = patch.owner {
            mission.owner = Some(owner.clone());
        }

        if let Some(ref scope) = patch.scope {
            mission.scope = scope.clone();
        }

        if let Some(status) = patch.status {
            if status == TowerMissionStatus::Abandoned && caller_name != TOWER_NAME {
                return Err(format!(
                    "agent \"{caller_name}\" cannot abandon mission {id} — abandoning releases the mission scope, so only the tower does it"
                ));
            }
            mission.status = status;
        }

        if let Some(ref note) = patch.note {
            mission.notes.push(note.clone());
        }

        if let Some(ref blocker) = patch.blocker {
            mission.blockers.push(blocker.clone());
            mission.status = TowerMissionStatus::Blocked;
        }

        if patch.clear_blockers == Some(true) {
            mission.blockers.clear();
        }

        if let Some(ref task_done_text) = patch.task_done {
            let task = mission
                .tasks
                .iter_mut()
                .find(|t| !t.done && t.text.contains(task_done_text));
            match task {
                Some(t) => t.done = true,
                None => {
                    return Err(format!(
                        "mission {id} has no open task matching \"{task_done_text}\""
                    ));
                }
            }
        }

        let updated = mission.clone();
        self.save(&state).await?;
        self.render_missions_index(&state).await?;
        self.render_mission_file(&updated).await?;

        let status_str = patch
            .status
            .map(|s| s.as_str().to_string())
            .unwrap_or_default();
        self.append_log(
            caller_name,
            "mission.update",
            &[("id", id), ("status", &status_str)],
            None,
        )
        .await?;

        Ok(updated)
    }

    pub async fn send(&self, caller_name: &str, input: TowerSendInput) -> Result<String, String> {
        let state = self.load().await?;
        let to = input.to.trim();
        if to != TOWER_NAME && to != BROADCAST_NAME && self.find_agent(&state, to).is_none() {
            let mut known = vec![TOWER_NAME.to_string(), BROADCAST_NAME.to_string()];
            known.extend(state.roster.agents.iter().map(|a| a.name.clone()));
            return Err(format!(
                "unknown recipient \"{to}\" — address a roster agent, {TOWER_NAME}, or {BROADCAST_NAME} (known: {})",
                known.join(", ")
            ));
        }
        if to == caller_name {
            return Err("cannot send an inbox message to yourself".into());
        }

        let sent_at = chrono::Utc::now().to_rfc3339();
        let mut fields = vec![
            ("type", "inbox"),
            ("from", caller_name),
            ("to", to),
            ("subject", input.subject.as_str()),
            ("sent_at", sent_at.as_str()),
        ];
        if let Some(ref s) = input.scope {
            fields.push(("scope", s.as_str()));
        }
        if let Some(ref a) = input.action {
            fields.push(("action", a.as_str()));
        }
        if let Some(ref c) = input.consent_ref {
            fields.push(("consent_ref", c.as_str()));
        }

        let frontmatter = render_frontmatter(&fields)?;
        let content = format!("{frontmatter}\n\n{}\n", input.body.trim());
        let file_name = inbox_file_name(caller_name, to, &input.subject);
        let rel = format!("{INBOX_DIR}/{file_name}");
        let written = self.write_unique(&rel, &content).await?;

        self.append_log(
            caller_name,
            "inbox.send",
            &[("to", to), ("subject", &slugify(&input.subject, 60))],
            Some(&written),
        )
        .await?;

        Ok(written)
    }

    pub async fn read_inbox(
        &self,
        caller_name: &str,
        limit: usize,
    ) -> Result<Vec<TowerInboxItem>, String> {
        let dir = self.abs(INBOX_DIR);
        let mut read_dir = match fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => return Ok(Vec::new()),
        };

        let mut items = Vec::new();
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path).await else {
                continue;
            };
            let (fields, body) = parse_frontmatter(&text);
            if fields.get("type").map(|s| s.as_str()) != Some("inbox") {
                continue;
            }
            let to = fields.get("to").cloned().unwrap_or_default();
            if caller_name != TOWER_NAME && to != caller_name && to != BROADCAST_NAME {
                continue;
            }
            items.push(TowerInboxItem {
                file: format!("{INBOX_DIR}/{}", entry.file_name().to_string_lossy()),
                from: fields
                    .get("from")
                    .cloned()
                    .unwrap_or_else(|| "unknown".into()),
                to,
                subject: fields.get("subject").cloned().unwrap_or_default(),
                sent_at: fields.get("sent_at").cloned().unwrap_or_default(),
                scope: fields.get("scope").cloned(),
                action: fields.get("action").cloned(),
                consent_ref: fields.get("consent_ref").cloned(),
                body,
            });
        }

        items.sort_by(|a, b| b.sent_at.cmp(&a.sent_at));
        items.truncate(limit.max(1));
        Ok(items)
    }

    pub async fn file_finding(
        &self,
        caller_name: &str,
        input: TowerFindingInput,
    ) -> Result<String, String> {
        let state = self.load().await?;
        let caller = self.find_agent(&state, caller_name);
        let mission = caller
            .as_ref()
            .and_then(|c| c.mission_id.as_deref())
            .and_then(|mid| state.missions.iter().find(|m| m.id == mid));

        let mission_desc = match mission {
            Some(m) => format!("{} — {}", m.id, m.title),
            None => "(none)".to_string(),
        };

        let not_fixed_reason = match mission {
            Some(m) => format!(
                "This finding is outside the scope of mission {} ({}). Fixing it directly would violate scope isolation. Assigning to the control tower for routing.",
                m.id,
                m.scope.join(", ")
            ),
            None => "This finding is outside the reporting agent's assignment. Assigning to the control tower for routing.".to_string(),
        };

        let lines = vec![
            format!("# Finding: {}", input.title),
            String::new(),
            format!("**Date**: {}", date_dash().replace('-', "")),
            format!("**Agent**: {caller_name}"),
            format!("**Type**: {}", input.r#type.as_str()),
            format!(
                "**Severity**: {}",
                input.severity.unwrap_or_default().as_str()
            ),
            format!("**Mission**: {mission_desc}"),
            String::new(),
            "---".into(),
            String::new(),
            "## Summary".into(),
            input.summary.trim().into(),
            String::new(),
            "## Location".into(),
            input
                .location
                .unwrap_or_else(|| "(not specified)".into())
                .trim()
                .into(),
            String::new(),
            "## Details".into(),
            input.details.trim().into(),
            String::new(),
            "## Suggested Fix / Action".into(),
            input.suggested_fix.trim().into(),
            String::new(),
            "## Why Not Fixed Directly".into(),
            not_fixed_reason,
            String::new(),
            "---".into(),
            String::new(),
            format!("*Filed by tower agent {caller_name} via `{FINDINGS_DIR}/`*"),
            String::new(),
        ];

        let file_name = finding_file_name(caller_name, input.r#type.as_str(), &input.title);
        let rel = format!("{FINDINGS_DIR}/{file_name}");
        let written = self.write_unique(&rel, &lines.join("\n")).await?;

        self.append_log(
            caller_name,
            "finding.file",
            &[
                ("type", input.r#type.as_str()),
                ("slug", &slugify(&input.title, 60)),
            ],
            Some(&written),
        )
        .await?;

        Ok(written)
    }

    pub async fn submit_review(
        &self,
        caller_name: &str,
        input: TowerReviewInput,
    ) -> Result<String, String> {
        let state = self.load().await?;
        if caller_name != TOWER_NAME {
            let caller = self.find_agent(&state, caller_name);
            if caller.as_ref().map(|c| c.kind)
                != Some(crate::tools::tower::types::TowerAgentKind::Reviewer)
                || caller.as_ref().and_then(|c| c.review_target.as_deref()) != Some(&input.target)
            {
                return Err(format!(
                    "agent \"{caller_name}\" is not an assigned reviewer for \"{}\"",
                    input.target
                ));
            }
        }

        let status_regex = regex::Regex::new(r"^(clean|p[12]-\d+items)$").unwrap();
        if !status_regex.is_match(&input.status) {
            return Err(format!(
                "review status must be clean | p1-Nitems | p2-Nitems, got \"{}\"",
                input.status
            ));
        }
        if !["merge", "fix-then-merge", "hold"].contains(&input.merge.as_str()) {
            return Err(format!(
                "review merge verdict must be merge | fix-then-merge | hold, got \"{}\"",
                input.merge
            ));
        }

        let existing = self.reviews_for(&input.target).await;
        let my_rounds = existing
            .iter()
            .filter(|r| r.reviewer == caller_name)
            .count() as u32;
        let round = my_rounds + 1;
        let reviewed_commit = branch_tip(&self.repo_root, &input.target).await?;

        let round_str = round.to_string();
        let frontmatter = render_frontmatter(&[
            ("date", &date_dash()),
            ("reviewer", caller_name),
            ("target", &input.target),
            ("round", &round_str),
            ("status", &input.status),
            ("merge", &input.merge),
            ("reviewed_commit", &reviewed_commit),
        ])?;

        let checks_text = match input.checks {
            Some(ref list) if !list.is_empty() => list
                .iter()
                .map(|c| format!("- [x] {c}"))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => "- [x] (reviewer reported no formal checks)".into(),
        };

        let content = format!(
            "{frontmatter}\n\n## Findings\n\n{}\n\n## Checks\n\n{checks_text}\n\n## Decision\n\n{}\n",
            input.findings.trim(),
            input.decision.trim()
        );

        let file_name = review_file_name(&input.target, caller_name, round);
        let rel = format!("{REVIEWS_DIR}/{file_name}");
        let written = self.write_unique(&rel, &content).await?;

        let rev_short = if reviewed_commit.len() >= 7 {
            &reviewed_commit[..7]
        } else {
            &reviewed_commit
        };
        self.append_log(
            caller_name,
            "review.write",
            &[
                ("target", &input.target),
                ("round", &round_str),
                ("verdict", &input.status),
                ("reviewed", rev_short),
            ],
            Some(&written),
        )
        .await?;

        Ok(written)
    }

    pub async fn reviews_for(&self, target: &str) -> Vec<TowerReviewInfo> {
        let dir = self.abs(REVIEWS_DIR);
        let mut read_dir = match fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(_) => return Vec::new(),
        };

        let prefix = format!("review-{}-", target_slug(target));
        let mut reviews = Vec::new();
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with(&prefix) || !name.ends_with(".md") {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()).await else {
                continue;
            };
            let (fields, _) = parse_frontmatter(&text);
            let round = fields
                .get("round")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            if round == 0 {
                continue;
            }
            reviews.push(TowerReviewInfo {
                reviewer: fields
                    .get("reviewer")
                    .cloned()
                    .unwrap_or_else(|| "unknown".into()),
                target: fields
                    .get("target")
                    .cloned()
                    .unwrap_or_else(|| target.into()),
                round,
                status: fields.get("status").cloned().unwrap_or_default(),
                merge: fields.get("merge").cloned().unwrap_or_default(),
                reviewed_commit: fields.get("reviewed_commit").cloned().unwrap_or_default(),
                date: fields.get("date").cloned().unwrap_or_default(),
                file: format!("{REVIEWS_DIR}/{name}"),
            });
        }
        reviews.sort_by_key(|r| r.round);
        reviews
    }

    pub async fn latest_review(&self, target: &str) -> Option<TowerReviewInfo> {
        self.reviews_for(target).await.into_iter().last()
    }

    pub async fn merge(
        &self,
        branch: &str,
    ) -> Result<(String, Vec<(String, Vec<String>)>, bool), String> {
        let mut state = self.load().await?;
        let unmerged_deps: Vec<String> = {
            let Some(m) = state.missions.iter().find(|m| m.branch == branch) else {
                return Err(format!("no tower mission owns branch \"{branch}\""));
            };
            m.deps
                .iter()
                .filter(|dep| {
                    state
                        .missions
                        .iter()
                        .any(|m2| m2.id == **dep && m2.status.is_open())
                })
                .cloned()
                .collect()
        };
        let mission = state
            .missions
            .iter_mut()
            .find(|m| m.branch == branch)
            .ok_or_else(|| format!("no tower mission owns branch \"{branch}\""))?;

        if !unmerged_deps.is_empty() {
            self.append_log(
                TOWER_NAME,
                "merge.blocked",
                &[("branch", branch), ("reason", "deps-unmerged")],
                None,
            )
            .await?;
            return Err(format!(
                "merge blocked: dependencies not merged yet ({}) — merge in Dependency Flow order",
                unmerged_deps.join(", ")
            ));
        }

        if mission.kind == crate::tools::tower::types::TowerMissionKind::Survey {
            let changed = diff_name_only(&self.repo_root, &state.base, branch).await?;
            if !changed.is_empty() {
                self.append_log(
                    TOWER_NAME,
                    "merge.blocked",
                    &[("branch", branch), ("reason", "read-only-survey")],
                    None,
                )
                .await?;
                return Err(format!(
                    "merge blocked: survey mission {} is read-only but {} has {} changed file(s): {} — investigate the worker; if the changes are worth keeping, move them onto a build mission's branch",
                    mission.id,
                    branch,
                    changed.len(),
                    changed
                        .iter()
                        .take(5)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            mission.status = TowerMissionStatus::Merged;
            let m_copy = mission.clone();
            self.save(&state).await?;
            self.render_missions_index(&state).await?;
            self.render_mission_file(&m_copy).await?;
            let tip = branch_tip(&self.repo_root, &state.base).await?;
            self.append_log(
                TOWER_NAME,
                "merge.noop",
                &[("branch", branch), ("kind", "survey")],
                None,
            )
            .await?;
            return Ok((tip, Vec::new(), true));
        }

        let review = self.latest_review(branch).await;
        let Some(rev) = review else {
            self.append_log(
                TOWER_NAME,
                "merge.blocked",
                &[("branch", branch), ("reason", "no-review")],
                None,
            )
            .await?;
            return Err(format!(
                "merge blocked: {branch} has no review — assign a reviewer first"
            ));
        };

        if rev.status != "clean" {
            self.append_log(
                TOWER_NAME,
                "merge.blocked",
                &[("branch", branch), ("reason", "not-clean")],
                None,
            )
            .await?;
            return Err(format!(
                "merge blocked: latest review (round {} by {}) is \"{}\" — a clean round is required",
                rev.round, rev.reviewer, rev.status
            ));
        }

        let tip = branch_tip(&self.repo_root, branch).await?;
        if rev.reviewed_commit != tip {
            self.append_log(
                TOWER_NAME,
                "merge.blocked",
                &[("branch", branch), ("reason", "tip-moved")],
                None,
            )
            .await?;
            let rev_short = if rev.reviewed_commit.len() >= 7 {
                &rev.reviewed_commit[..7]
            } else {
                &rev.reviewed_commit
            };
            let tip_short = if tip.len() >= 7 { &tip[..7] } else { &tip };
            return Err(format!(
                "merge blocked: {branch} moved since the clean review (reviewed {rev_short}, tip {tip_short}) — re-review required"
            ));
        }

        let changed = diff_name_only(&self.repo_root, &state.base, branch).await?;
        let mut out_of_scope = Vec::new();
        for file in &changed {
            let in_scope = mission.scope.iter().any(|pattern| {
                if let Ok(glob) = globset::Glob::new(pattern) {
                    glob.compile_matcher().is_match(file)
                } else {
                    file.starts_with(pattern.trim_end_matches('*'))
                }
            });
            if !in_scope {
                out_of_scope.push(file.clone());
            }
        }
        if !out_of_scope.is_empty() {
            self.append_log(
                TOWER_NAME,
                "merge.blocked",
                &[("branch", branch), ("reason", "out-of-scope")],
                None,
            )
            .await?;
            return Err(format!(
                "merge blocked: {branch} changed files outside mission {} scope ({}): {} — the tower must widen the mission scope (TowerMission scope patch) or revert those changes",
                mission.id,
                mission.scope.join(", "),
                out_of_scope.join(", ")
            ));
        }

        let checked_out = current_branch(&self.repo_root).await.map_err(|_| {
            format!(
                "merge blocked: the main checkout is in a detached HEAD state — check out the recorded base branch \"{}\" before merging; nothing was merged",
                state.base
            )
        })?;
        if checked_out != state.base {
            return Err(format!(
                "merge blocked: the main checkout is on \"{checked_out}\", not the recorded base \"{}\" — switch it back (`git checkout {}`) and retry; nothing was merged",
                state.base, state.base
            ));
        }

        let merge_commit = merge_no_ff(&self.repo_root, branch).await?;
        mission.status = TowerMissionStatus::Merged;
        let m_copy = mission.clone();

        let changed_set: std::collections::HashSet<String> = changed.into_iter().collect();
        let mut conflicts_with = Vec::new();
        for other in &state.missions {
            if other.branch == branch || !other.status.is_open() {
                continue;
            }
            if !branch_exists(&self.repo_root, &other.branch).await {
                continue;
            }
            let other_changed = diff_name_only(&self.repo_root, &state.base, &other.branch)
                .await
                .unwrap_or_default();
            let overlap: Vec<String> = other_changed
                .into_iter()
                .filter(|f| changed_set.contains(f))
                .collect();
            if !overlap.is_empty() {
                conflicts_with.push((other.branch.clone(), overlap));
            }
        }

        self.save(&state).await?;
        self.render_missions_index(&state).await?;
        self.render_mission_file(&m_copy).await?;
        let commit_short = if merge_commit.len() >= 7 {
            &merge_commit[..7]
        } else {
            &merge_commit
        };
        self.append_log(
            TOWER_NAME,
            "merge",
            &[
                ("branch", branch),
                ("base", &state.base),
                ("merge_commit", commit_short),
            ],
            None,
        )
        .await?;

        Ok((merge_commit, conflicts_with, false))
    }

    pub async fn add_worktree(
        &self,
        worktree: &str,
        branch: &str,
        base: &str,
    ) -> Result<String, String> {
        let rel = format!("{WORKTREES_DIR}/{worktree}");
        let abs_path = self.abs(&rel);
        worktree_add(&self.repo_root, &abs_path, branch, base).await?;
        self.append_log(
            TOWER_NAME,
            "worktree.add",
            &[("worktree", worktree), ("branch", branch), ("base", base)],
            None,
        )
        .await?;
        Ok(rel)
    }

    pub async fn teardown(&self, force: bool) -> Result<Vec<String>, String> {
        let state = self.load().await?;
        let mut report = Vec::new();
        for mission in &state.missions {
            let rel = format!("{WORKTREES_DIR}/{}", mission.worktree);
            let abs_path = self.abs(&rel);
            if is_worktree_dirty(&abs_path).await && !force {
                report.push(format!(
                    "kept {rel} (uncommitted changes — rerun with force to remove)"
                ));
                self.append_log(
                    TOWER_NAME,
                    "worktree.keep",
                    &[
                        ("worktree", &mission.worktree),
                        ("reason", "uncommitted-changes"),
                    ],
                    None,
                )
                .await?;
                continue;
            }

            match worktree_remove(&self.repo_root, &abs_path).await {
                Ok(_) => {
                    report.push(format!("removed {rel}"));
                    self.append_log(
                        TOWER_NAME,
                        "worktree.remove",
                        &[("worktree", &mission.worktree)],
                        None,
                    )
                    .await?;
                }
                Err(err) => {
                    report.push(format!("failed to remove {rel}: {err}"));
                    self.append_log(
                        TOWER_NAME,
                        "worktree.remove.failed",
                        &[("worktree", &mission.worktree), ("reason", &err)],
                        None,
                    )
                    .await?;
                }
            }
        }

        self.append_log(
            TOWER_NAME,
            "teardown",
            &[("force", if force { "yes" } else { "" })],
            None,
        )
        .await?;

        Ok(report)
    }

    pub async fn render_missions_index(&self, state: &TowerState) -> Result<(), String> {
        let mut rows = Vec::new();
        for m in &state.missions {
            let owner = m.owner.as_deref().unwrap_or("—");
            rows.push(format!(
                "| {} | {} | {} | {} | {} | {} |",
                m.id,
                m.title,
                m.branch,
                m.worktree,
                m.status.emoji(),
                owner
            ));
        }

        let mut deps = Vec::new();
        for m in &state.missions {
            for dep in &m.deps {
                deps.push(format!("{dep} → {}", m.id));
            }
        }
        let deps_str = if deps.is_empty() {
            "(none)".into()
        } else {
            deps.join("\n")
        };

        let mut scopes = Vec::new();
        for m in &state.missions {
            let note = if m.kind == crate::tools::tower::types::TowerMissionKind::Survey {
                " (survey — informational, reserves nothing)"
            } else {
                ""
            };
            scopes.push(format!("- {}{note}: {}", m.id, m.scope.join(", ")));
        }
        let scopes_str = if scopes.is_empty() {
            "(none)".into()
        } else {
            scopes.join("\n")
        };

        let content = vec![
            "# MISSIONS".into(),
            String::new(),
            "<!-- Generated by tower tools from state.json — do not edit by hand. -->".into(),
            String::new(),
            "| ID | Mission | Branch | Worktree | Status | Owner |".into(),
            "| -- | ------- | ------ | -------- | ------ | ----- |".into(),
            rows.join("\n"),
            String::new(),
            "Status: 🟡 planned · 🔵 active · 🟢 completed · 🔴 blocked · ⏸️ paused · ✅ merged · 🚫 abandoned".into(),
            format!("Mode: {} — Base: {}", state.mode, state.base),
            String::new(),
            "## Dependency Flow".into(),
            deps_str,
            String::new(),
            "## Scope Map".into(),
            scopes_str,
            String::new(),
        ].join("\n");

        fs::write(self.abs(MISSIONS_INDEX), content.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn render_mission_file(&self, mission: &TowerMission) -> Result<(), String> {
        let rel = format!(
            "{MISSIONS_DIR}/{}",
            mission_file_name(&mission.id, &mission.slug)
        );
        let survey_tag = if mission.kind == crate::tools::tower::types::TowerMissionKind::Survey {
            " 🔍 (read-only survey)"
        } else {
            ""
        };
        let owner = mission.owner.as_deref().unwrap_or("—");

        let tasks_str = if mission.tasks.is_empty() {
            "- [ ] (no tasks recorded)".into()
        } else {
            mission
                .tasks
                .iter()
                .map(|t| format!("- [{}] {}", if t.done { "x" } else { " " }, t.text))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let deps_str = if mission.deps.is_empty() {
            "(none)".into()
        } else {
            mission.deps.join(", ")
        };

        let blockers_str = if mission.blockers.is_empty() {
            "- (none)".into()
        } else {
            mission
                .blockers
                .iter()
                .map(|b| format!("- {b}"))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let notes_str = if mission.notes.is_empty() {
            "- (none)".into()
        } else {
            mission
                .notes
                .iter()
                .map(|n| format!("- {n}"))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let content = vec![
            format!("# Mission {}: {}{survey_tag}", mission.id, mission.title),
            String::new(),
            "<!-- Generated by tower tools from state.json — update via the TowerMission tool. -->"
                .into(),
            String::new(),
            "| Branch | Worktree | Status | Scope | Owner |".into(),
            "| ------ | -------- | ------ | ----- | ----- |".into(),
            format!(
                "| {} | {} | {} | {} | {} |",
                mission.branch,
                mission.worktree,
                mission.status.emoji(),
                mission.scope.join(", "),
                owner
            ),
            String::new(),
            "## Tasks".into(),
            tasks_str,
            String::new(),
            "## Dependencies".into(),
            deps_str,
            String::new(),
            "## Blockers".into(),
            blockers_str,
            String::new(),
            "## Notes".into(),
            notes_str,
            String::new(),
        ]
        .join("\n");

        fs::write(self.abs(&rel), content.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn write_unique(&self, rel: &str, content: &str) -> Result<String, String> {
        let (stem, ext) = match rel.rfind('.') {
            Some(pos) => (&rel[..pos], &rel[pos..]),
            None => (rel, ""),
        };

        for attempt in 0..100 {
            let candidate = if attempt == 0 {
                rel.to_string()
            } else {
                format!("{stem}-{attempt}{ext}")
            };
            let abs_path = self.abs(&candidate);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&abs_path)
                .await
            {
                Ok(mut file) => {
                    file.write_all(content.as_bytes())
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(candidate);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        Err(format!("could not create a unique file for {rel}"))
    }
}

async fn read_git_dir(cwd: &Path) -> Option<String> {
    let raw = fs::read_to_string(cwd.join(".git")).await.ok()?;
    let line = raw.lines().find(|l| l.starts_with("gitdir:"))?;
    Some(line["gitdir:".len()..].trim().to_string())
}
