//! The swarm feature.
//!
//! Port of v2 `features/swarm/` (`agent-core-v2` swarm feature). Swarm is its
//! own feature here, not a flavour of the `Agent` tool:
//!
//! - [`agent_run_batch`] — the batch scheduler (v2 `session/agentRunBatch.ts`).
//! - [`service`] — the session-level owner of a run: member lifecycle,
//!   cancellation, in-flight registry (v2 `session/sessionSwarmService.ts`).
//! - [`mode`] — swarm as a mode the agent enters/exits, plus the gate that
//!   vetoes a response mixing `AgentSwarm` with anything else (v2
//!   `agent/swarm.ts`, `agent/swarmService.ts`, `swarmOps.ts`).

pub mod agent_run_batch;
pub mod mode;
pub mod service;

pub use agent_run_batch::{
    AbortReason, AbortSignal, AgentRunAttemptHandle, AgentRunAttemptOptions, AgentRunBatch,
    AgentRunBatchLauncher, AgentRunBatchOptions, AgentRunBatchTiming, AgentRunCompletion,
    AgentRunError, AgentRunResult, AgentRunState, AgentRunStatus, AgentRunSuspendedEvent,
    AgentRunTask, AgentRunTaskKind, AgentSpawnAttemptOptions, SubagentSpawnPlan,
    resolve_swarm_max_concurrency,
};
pub use mode::{SwarmModeRegistry, SwarmModeTrigger, veto_message, veto_swarm_batch};
pub use service::{SwarmLauncher, SwarmRegistry, SwarmRun};
