//! Workflow types — run lifecycle status, run entries, and workflow metadata.
//!
//! Mirrors `packages/agent-core-v2/src/app/workflow/workflowTypes.ts`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// Lifecycle status of a workflow run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkflowRunStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl WorkflowRunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A single workflow run's mutable state. Lives behind an `Arc<Mutex<..>>`
/// shared between the run registry (on the `Agent`) and the background
/// executor task, so `status` / `wait` / `cancel` can observe progress while
/// the workflow is still running.
pub(crate) struct WorkflowRunEntry {
    pub run_id: String,
    pub workflow_name: String,
    pub status: WorkflowRunStatus,
    pub current_phase: Option<String>,
    pub agent_count: usize,
    pub error: Option<String>,
    pub started_at: Instant,
    pub finished_at: Option<Instant>,
    /// Cooperative cancellation flag — checked by the executor between
    /// phases and between search/fetch iterations.
    pub cancelled: Arc<AtomicBool>,
    pub result: Option<String>,
}

impl WorkflowRunEntry {
    pub(crate) fn new(run_id: String, workflow_name: String) -> Self {
        Self {
            run_id,
            workflow_name,
            status: WorkflowRunStatus::Running,
            current_phase: None,
            agent_count: 0,
            error: None,
            started_at: Instant::now(),
            finished_at: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            result: None,
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// Format a run's status the same way the TS `formatStatus` helper does.
pub(crate) fn format_status(entry: &WorkflowRunEntry) -> String {
    let now = entry.finished_at.unwrap_or_else(Instant::now);
    let elapsed = now.duration_since(entry.started_at).as_secs_f64();
    let mut lines = vec![
        format!("run_id: {}", entry.run_id),
        format!("workflow: {}", entry.workflow_name),
        format!("status: {}", entry.status.as_str()),
        format!("agents: {}", entry.agent_count),
        format!("elapsed: {elapsed:.1}s"),
    ];
    if let Some(phase) = &entry.current_phase {
        lines.push(format!("phase: {phase}"));
    }
    if let Some(err) = &entry.error {
        lines.push(format!("error: {err}"));
    }
    lines.join("\n")
}
