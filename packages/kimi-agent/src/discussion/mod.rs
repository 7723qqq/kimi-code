/// Discussion module — Multi-agent discussion and debate orchestration.
///
/// Corresponds to `packages/agent-core/src/agent/discussion/`.
///
/// This module provides:
/// - `DiscussionContext`: transcript + position tracking + cross-reference detection
/// - `SwarmDiscussionCoordinator`: roundtable discussion orchestration
/// - `StructuredDebateCoordinator`: multi-phase structured debate orchestration
///
/// Both coordinators are fully implemented — they spawn participant agents,
/// drive round-robin turns against the transcript, detect cross-references,
/// generate summaries and account usage. The actual sub-agent spawning and
/// turn execution is delegated to host-side callbacks
/// (`DiscussionHostDelegate`): the engine has no subagent runtime of its own,
/// so the host (TUI / web / SDK) provides one.
///
/// # Architecture
/// - `DiscussionContext`: pure data — zero dependencies
/// - Coordinators: define the orchestration protocol; host provides execution callbacks
/// - Delegate trait: `DiscussionHostDelegate` bridges to the JS subagent host

mod context;
pub mod coordinator;
pub mod debate;

pub use context::*;
pub use coordinator::*;
pub use debate::*;