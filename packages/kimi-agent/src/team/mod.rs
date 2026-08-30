//! Team coordination — multi-agent roundtable discussions and structured
//! debates.
//!
//! Port of the v2 `agent/team` domain (`agent-core-v2`): a pure-data
//! `DiscussionContext` plus two coordinators that drive persistent subagents
//! through round-based discussion / phased debate, and the result renderers.
//! The coordinators depend only on the `PersistentSubagentHost` trait, so
//! they are fully testable with a mock host; `SubagentManagerHost` wires the
//! trait to the engine's `SubagentManager` persistent interface.

pub mod context;
pub mod coordinator;

pub use context::{
    CrossReference, CrossReferenceStance, DebatePhase, DiscussionContext, DiscussionEntry,
    PositionRecord,
};
pub use coordinator::{
    DebateOptions, DebateParticipantConfig, DebateResult, DiscussionObserver, DiscussionOptions,
    DiscussionParticipantConfig, DiscussionResult, DiscussionTurnEvent, EndedBy,
    PersistentSubagentHost, PhaseBreakdown, StructuredDebateCoordinator, SubagentManagerHost,
    TeamCoordinator, format_debate_result, format_discussion_result, turn_failure_message,
};
