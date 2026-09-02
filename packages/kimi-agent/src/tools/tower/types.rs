use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TowerAgentKind {
    Worker,
    Reviewer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerRosterEntry {
    pub name: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub kind: TowerAgentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub spawned_at: String,
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
pub struct TowerMission {
    pub id: String,
    pub title: String,
    pub slug: String,
    #[serde(default)]
    pub kind: TowerMissionKind,
    pub scope: Vec<String>,
    pub branch: String,
    pub worktree: String,
    #[serde(default)]
    pub deps: Vec<String>,
    pub status: TowerMissionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default)]
    pub tasks: Vec<TowerMissionTask>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TowerState {
    pub version: u32,
    pub base: String,
    pub mode: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
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
