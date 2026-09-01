//! Subagent data types and lifecycle states.

use serde::{Deserialize, Serialize};

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
    pub model: Option<String>,
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
