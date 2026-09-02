//! Pure Rust multi-agent collaboration engine (P28).
//!
//! Provides in-process native subagent definitions, concurrent task spawning,
//! inter-agent messaging, and lifecycle management without Node/Bun dependencies.

pub mod manager;
pub mod types;

pub use manager::SubagentManager;
pub use types::{
    ParentCancel, SubagentDefinition, SubagentInstance, SubagentState, SubagentSummary,
};
