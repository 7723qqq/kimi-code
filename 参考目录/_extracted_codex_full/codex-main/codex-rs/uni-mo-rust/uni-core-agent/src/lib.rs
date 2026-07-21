//! uni-core-agent: Core agent turn processing loop.
//!
//! This crate provides the fundamental turn-processing loop for AI agents:
//! model invocation, tool execution, result handling, and auto-compaction.
//!
//! Ported from codex-rs core/src/session/turn.rs with adaptations for
//! the uni-mo-rust ecosystem.

pub mod agent;
pub mod compact;
pub mod sampling;
pub mod stream;
pub mod types;

pub use agent::run_turn;
pub use types::{
    AgentError, AgentResult, SamplingRequestResult, TurnContext, TurnInput,
};
