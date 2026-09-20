use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TowerAgentKind {
    Worker,
    Reviewer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerRosterEntry {
    pub name: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub kind: TowerAgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_target: Option<String>,
    /// The mission a reviewer's target belongs to (v2 `reviewMissionId`).
    /// Preserved so a v2-written state round-trips without dropping it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_mission_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub spawned_at: String,
    /// v2's worker-death triple (`diedAt` / `deathStatus` / `deathReason`).
    /// The fork collapses them into `status` below; these are preserved so a
    /// v2-written roster is not silently rewritten without them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub died_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub death_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub death_reason: Option<String>,
    /// `dead` once a detached run finished with a failure outcome (failed,
    /// timed out, killed, or lost); absent while the agent may still be alive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerRoster {
    pub agents: Vec<TowerRosterEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TowerMissionStatus {
    Planned,
    Active,
    Completed,
    Blocked,
    Paused,
    Merged,
    Abandoned,
}

impl TowerMissionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Active => "active",
            Self::Completed => "completed",
            Self::Blocked => "blocked",
            Self::Paused => "paused",
            Self::Merged => "merged",
            Self::Abandoned => "abandoned",
        }
    }

    pub fn emoji(&self) -> &'static str {
        match self {
            Self::Planned => "🟡",
            Self::Active => "🔵",
            Self::Completed => "🟢",
            Self::Blocked => "🔴",
            Self::Paused => "⏸️",
            Self::Merged => "✅",
            Self::Abandoned => "🚫",
        }
    }

    pub fn is_open(&self) -> bool {
        !matches!(self, Self::Merged | Self::Abandoned)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TowerMissionKind {
    #[default]
    Build,
    Survey,
}

impl TowerMissionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Survey => "survey",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerMissionTask {
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerMission {
    pub id: String,
    pub title: String,
    pub slug: String,
    #[serde(default)]
    pub kind: TowerMissionKind,
    pub scope: Vec<String>,
    pub branch: String,
    pub worktree: String,
    /// The base commit/branch a worker's worktree starts from (v2
    /// `spawnBase`). Preserved so a v2-written mission round-trips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_base: Option<String>,
    #[serde(default)]
    pub deps: Vec<String>,
    pub status: TowerMissionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// The mission's briefing for its workers (v2 `context`). Preserved so a
    /// v2-written mission does not lose its instructions on the next save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default)]
    pub tasks: Vec<TowerMissionTask>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerState {
    pub version: u32,
    pub base: String,
    pub mode: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub roster: TowerRoster,
    #[serde(default)]
    pub missions: Vec<TowerMission>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TowerFindingType {
    Bug,
    Improve,
    Vuln,
    Idea,
}

impl TowerFindingType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bug => "bug",
            Self::Improve => "improve",
            Self::Vuln => "vuln",
            Self::Idea => "idea",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TowerFindingSeverity {
    Low,
    #[default]
    Medium,
    High,
    Critical,
}

impl TowerFindingSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerReviewInfo {
    pub reviewer: String,
    pub target: String,
    pub round: u32,
    pub status: String,
    pub merge: String,
    pub reviewed_commit: String,
    pub date: String,
    pub file: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerInboxItem {
    pub file: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub sent_at: String,
    pub scope: Option<String>,
    pub action: Option<String>,
    pub consent_ref: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TowerInitResult {
    pub base: String,
    pub created: bool,
    pub retired_agents: Vec<String>,
    pub checkout: String,
    pub ignored_base: Option<String>,
    pub open_missions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TowerPlanInput {
    pub title: String,
    pub scope: Vec<String>,
    #[serde(default)]
    pub tasks: Option<Vec<String>>,
    #[serde(default)]
    pub deps: Option<Vec<String>>,
    #[serde(default)]
    pub kind: Option<TowerMissionKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TowerSendInput {
    pub to: String,
    pub subject: String,
    pub body: String,
    pub scope: Option<String>,
    pub action: Option<String>,
    pub consent_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TowerFindingInput {
    pub r#type: TowerFindingType,
    pub title: String,
    #[serde(default)]
    pub severity: Option<TowerFindingSeverity>,
    pub summary: String,
    pub location: Option<String>,
    pub details: String,
    pub suggested_fix: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TowerReviewInput {
    pub target: String,
    pub status: String,
    pub merge: String,
    pub findings: String,
    #[serde(default)]
    pub checks: Option<Vec<String>>,
    pub decision: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TowerMissionPatch {
    pub status: Option<TowerMissionStatus>,
    pub note: Option<String>,
    pub blocker: Option<String>,
    pub clear_blockers: Option<bool>,
    pub task_done: Option<String>,
    pub owner: Option<String>,
    pub scope: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The persisted state is v2's camelCase contract (`TowerState` in
    /// `agent-core-v2/src/features/tower/protocol/types.ts`). The fork wrote
    /// snake_case here, so a state file v2 produced read back as
    /// "corrupted tower state: missing field `created_at`" and every tower
    /// tool became unavailable.
    #[test]
    fn tower_state_reads_the_v2_camel_case_contract() {
        let raw = r#"{
            "version": 1,
            "base": "main",
            "mode": "branch",
            "createdAt": "2026-09-18T04:00:00.000Z",
            "sessionId": "session-1",
            "roster": { "agents": [{
                "name": "worker-1",
                "agentId": "agent-1",
                "sessionId": "session-1",
                "kind": "worker",
                "missionId": "M1",
                "reviewTarget": "feat/x",
                "reviewMissionId": "M1",
                "worktree": "wt-1",
                "branch": "feat/x",
                "spawnedAt": "2026-09-18T04:00:00.000Z",
                "diedAt": "2026-09-18T05:00:00.000Z",
                "deathStatus": "failed",
                "deathReason": "boom"
            }] },
            "missions": [{
                "id": "M1",
                "title": "Mission 1",
                "slug": "mission-1",
                "kind": "build",
                "scope": ["src/**"],
                "branch": "feat/x",
                "worktree": "wt-1",
                "spawnBase": "abc123",
                "deps": [],
                "status": "active",
                "context": "briefing",
                "tasks": [{ "text": "do it", "done": false }],
                "notes": [],
                "blockers": []
            }]
        }"#;

        let state: TowerState = serde_json::from_str(raw).expect("v2 state must deserialize");
        assert_eq!(state.created_at, "2026-09-18T04:00:00.000Z");
        assert_eq!(state.session_id.as_deref(), Some("session-1"));
        assert_eq!(state.roster.agents[0].agent_id, "agent-1");
        assert_eq!(state.roster.agents[0].mission_id.as_deref(), Some("M1"));
        assert_eq!(
            state.roster.agents[0].review_mission_id.as_deref(),
            Some("M1")
        );
        assert_eq!(
            state.roster.agents[0].death_status.as_deref(),
            Some("failed")
        );
        assert_eq!(state.missions[0].spawn_base.as_deref(), Some("abc123"));
        assert_eq!(state.missions[0].context.as_deref(), Some("briefing"));

        // v2 marks these optional; a state that omits them must still load.
        let minimal: TowerState = serde_json::from_str(
            r#"{"version":1,"base":"main","mode":"branch","createdAt":"x",
                "roster":{"agents":[{"name":"w","agentId":"a","kind":"worker","spawnedAt":"y"}]},
                "missions":[]}"#,
        )
        .expect("v2 optional fields must default");
        assert!(minimal.session_id.is_none());
        assert!(minimal.roster.agents[0].session_id.is_none());
        assert!(minimal.roster.agents[0].mission_id.is_none());
    }

    /// A save must write the same camelCase keys back, so a v2 reader keeps
    /// working and the fields v2 owns are not dropped.
    #[test]
    fn tower_state_serializes_the_v2_camel_case_contract() {
        let state = TowerState {
            version: 1,
            base: "main".into(),
            mode: "branch".into(),
            created_at: "2026-09-18T04:00:00.000Z".into(),
            session_id: Some("session-1".into()),
            roster: TowerRoster::default(),
            missions: vec![],
        };
        let json = serde_json::to_value(&state).unwrap();
        assert!(json.get("createdAt").is_some());
        assert!(json.get("created_at").is_none());
        assert!(json.get("sessionId").is_some());
        assert!(json.get("session_id").is_none());
    }
}
