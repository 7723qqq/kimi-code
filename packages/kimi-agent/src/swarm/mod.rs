//! Swarm-style batch execution.
//!
//! Port of the v2 `AgentRunBatch` scheduler (`agent-core-v2` swarm feature):
//! a pure, host-independent batch scheduler that drives a launcher trait
//! through spawn/resume/retry with concurrency limiting, provider rate-limit
//! backoff (capacity shrink/recovery), per-task timeouts, and cancellation.

pub mod agent_run_batch;

pub use agent_run_batch::{
    AbortReason, AbortSignal, AgentRunAttemptHandle, AgentRunAttemptOptions, AgentRunBatch,
    AgentRunBatchLauncher, AgentRunBatchOptions, AgentRunBatchTiming, AgentRunCompletion,
    AgentRunError, AgentRunResult, AgentRunState, AgentRunStatus, AgentRunSuspendedEvent,
    AgentRunTask, AgentRunTaskKind, AgentSpawnAttemptOptions, SubagentSpawnPlan,
    resolve_swarm_max_concurrency,
};
