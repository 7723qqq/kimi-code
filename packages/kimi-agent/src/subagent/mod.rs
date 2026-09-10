//! Pure Rust multi-agent collaboration engine (P28).
//!
//! Provides in-process native subagent definitions, concurrent task spawning,
//! inter-agent messaging, and lifecycle management without Node/Bun dependencies.

pub mod btw;
pub mod fork;
pub mod manager;
pub mod persistent;
pub mod secondary;
pub mod types;

pub use btw::{
    check_btw_tool_denial, start_btw, SIDE_QUESTION_SYSTEM_REMINDER, TOOL_CALL_DISABLED_MESSAGE,
};
pub use fork::{
    close_trailing_open_tool_exchange, fork_incompatibility,
    FORK_WITH_MODEL_UNAVAILABLE, FORK_WITH_RESUME_UNAVAILABLE, FORK_WITH_TYPE_UNAVAILABLE,
    INHERITED_IN_FLIGHT_TOOL_OUTPUT, PRIMARY_SUBAGENT_MODEL_CHOICE,
};
pub use manager::SubagentManager;
pub use persistent::{
    AgentMention, ConsensusEvaluation, DebateParticipant, DebateStage, PersistentSubagentManager,
    SubagentConfig, SubagentHandle,
};
pub use types::{
    ParentCancel, SubagentDefinition, SubagentInstance, SubagentState, SubagentSummary,
};
