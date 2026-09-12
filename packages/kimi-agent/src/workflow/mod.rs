//! Native workflow engine.
//!
//! Workflows are JavaScript scripts executed in an embedded QuickJS sandbox
//! with injected orchestration primitives (`agent`, `parallel`, `pipeline`,
//! `phase`, `log`, file IO, `fetch`, `search`, `exec`). The App-scoped
//! [`WorkflowService`] owns the run registry so runs survive across turns.
//!
//! Ported from the retired `agent-core-v2` workflow domain
//! (`src/app/workflow/`): the JS sandbox contract, the meta parser, and the
//! nine built-in scripts.

pub mod host;
pub mod registry;
pub mod runtime;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

pub use registry::{get_builtin, list_builtins, resolve_user_workflow};
pub use runtime::{SearchHit, WorkflowAgentOpts, WorkflowHost};

/// Process-wide workflow run registry. v2 scoped `WorkflowService` to the App,
/// i.e. every run outlives a single turn; a global here gives the per-turn
/// `NativeToolset` that same persistence without threading a handle through
/// the pipeline.
static GLOBAL_SERVICE: once_cell::sync::Lazy<WorkflowService> =
    once_cell::sync::Lazy::new(WorkflowService::new);

pub fn global_service() -> &'static WorkflowService {
    &GLOBAL_SERVICE
}

/// The Kimi home (`KIMI_CODE_HOME`, else `~/.kimi-code`), where user workflows
/// live under `workflows/`.
pub fn kimi_home() -> Option<std::path::PathBuf> {
    if let Some(home) = std::env::var_os("KIMI_CODE_HOME") {
        return Some(std::path::PathBuf::from(home));
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| std::path::PathBuf::from(home).join(".kimi-code"))
}
/// Script metadata parsed from the `meta` literal and surfaced by `list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowMeta {
    pub name: String,
    pub description: String,
    #[serde(rename = "whenToUse", skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phases: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunResult {
    pub run_id: String,
    pub status: WorkflowStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "currentPhase", skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    #[serde(rename = "agentCount")]
    pub agent_count: usize,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "finishedAt", skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Shared, interior-mutable state of one run. The JS host hooks update the
/// phase / agent counter in place while the service reads them.
pub(crate) struct RunState {
    pub run_id: String,
    status: Mutex<WorkflowStatus>,
    result: Mutex<Option<Value>>,
    error: Mutex<Option<String>>,
    current_phase: Mutex<Option<String>>,
    agent_count: AtomicUsize,
    cancelled: AtomicBool,
    started_at: i64,
    finished_at: Mutex<Option<i64>>,
    settled: Notify,
}

impl RunState {
    fn new(run_id: String) -> Self {
        Self {
            run_id,
            status: Mutex::new(WorkflowStatus::Running),
            result: Mutex::new(None),
            error: Mutex::new(None),
            current_phase: Mutex::new(None),
            agent_count: AtomicUsize::new(0),
            cancelled: AtomicBool::new(false),
            started_at: now_ms(),
            finished_at: Mutex::new(None),
            settled: Notify::new(),
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    #[cfg_attr(not(feature = "workflow-js"), allow(dead_code))]
    pub(crate) fn record_agent(&self) {
        self.agent_count.fetch_add(1, Ordering::SeqCst);
    }

    #[cfg_attr(not(feature = "workflow-js"), allow(dead_code))]
    pub(crate) fn set_phase(&self, phase: &str) {
        if let Ok(mut current) = self.current_phase.lock() {
            *current = Some(phase.to_string());
        }
    }

    fn to_result(&self) -> WorkflowRunResult {
        WorkflowRunResult {
            run_id: self.run_id.clone(),
            status: *self.status.lock().unwrap(),
            result: self.result.lock().unwrap().clone(),
            error: self.error.lock().unwrap().clone(),
            current_phase: self.current_phase.lock().unwrap().clone(),
            agent_count: self.agent_count.load(Ordering::SeqCst),
            started_at: self.started_at,
            finished_at: *self.finished_at.lock().unwrap(),
        }
    }
}

/// App-scoped workflow run registry. Cloneable handle; all clones share runs.
#[derive(Clone, Default)]
pub struct WorkflowService {
    runs: Arc<Mutex<HashMap<String, Arc<RunState>>>>,
    counter: Arc<AtomicU64>,
}

impl std::fmt::Debug for WorkflowService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkflowService")
            .field(
                "runs",
                &self.runs.lock().map(|runs| runs.len()).unwrap_or(0),
            )
            .finish()
    }
}

impl WorkflowService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a workflow in the background and return its run id immediately.
    pub fn start(
        &self,
        script: String,
        args: Option<Value>,
        host: Arc<dyn WorkflowHost>,
    ) -> String {
        let run_id = format!("wf_{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        let entry = Arc::new(RunState::new(run_id.clone()));
        if let Ok(mut runs) = self.runs.lock() {
            runs.insert(run_id.clone(), Arc::clone(&entry));
        }

        let settle = Arc::clone(&entry);
        // The QuickJS context and its futures are not `Send`, so the run gets
        // its own current-thread runtime on a dedicated thread instead of a
        // `tokio::spawn` (the run registry stays shared and `Send`).
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build();
            let outcome = match runtime {
                Ok(runtime) => runtime.block_on(runtime::execute_workflow(
                    &script,
                    args,
                    host,
                    Arc::clone(&settle),
                )),
                Err(error) => Err(error.to_string()),
            };
            match outcome {
                Ok(value) => {
                    *settle.result.lock().unwrap() = Some(value);
                    *settle.status.lock().unwrap() = WorkflowStatus::Completed;
                }
                Err(error) => {
                    if settle.is_cancelled() {
                        *settle.status.lock().unwrap() = WorkflowStatus::Cancelled;
                    } else {
                        *settle.status.lock().unwrap() = WorkflowStatus::Failed;
                        *settle.error.lock().unwrap() = Some(error);
                    }
                }
            }
            *settle.finished_at.lock().unwrap() = Some(now_ms());
            settle.settled.notify_waiters();
        });

        run_id
    }

    pub fn status(&self, run_id: &str) -> Option<WorkflowRunResult> {
        let entry = self.runs.lock().ok()?.get(run_id).cloned()?;
        Some(entry.to_result())
    }

    /// Wait for a run to settle, optionally bounded by `timeout_ms`.
    pub async fn wait(&self, run_id: &str, timeout_ms: Option<u64>) -> Option<WorkflowRunResult> {
        let entry = self.runs.lock().ok()?.get(run_id).cloned()?;
        if *entry.status.lock().unwrap() != WorkflowStatus::Running {
            return Some(entry.to_result());
        }
        let waiter = entry.settled.notified();
        match timeout_ms {
            Some(ms) => {
                let _ = tokio::time::timeout(std::time::Duration::from_millis(ms), waiter).await;
            }
            None => waiter.await,
        }
        Some(entry.to_result())
    }

    pub async fn cancel(&self, run_id: &str) {
        let entry = self
            .runs
            .lock()
            .ok()
            .and_then(|runs| runs.get(run_id).cloned());
        let Some(entry) = entry else {
            return;
        };
        entry.cancel();
        // Give the script a moment to unwind, then force-settle a run that is
        // parked on a host call which does not observe the cancel flag.
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            entry.settled.notified(),
        )
        .await;
        if *entry.status.lock().unwrap() == WorkflowStatus::Running {
            *entry.status.lock().unwrap() = WorkflowStatus::Cancelled;
            *entry.finished_at.lock().unwrap() = Some(now_ms());
            entry.settled.notify_waiters();
        }
    }

    pub fn list_builtins(&self) -> Vec<WorkflowMeta> {
        registry::list_builtins()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct EchoHost;

    #[async_trait]
    impl WorkflowHost for EchoHost {
        async fn spawn_agent(&self, prompt: String, _opts: WorkflowAgentOpts) -> Option<Value> {
            Some(Value::String(format!("echo:{prompt}")))
        }

        async fn search(&self, _query: String, _count: usize) -> Vec<SearchHit> {
            Vec::new()
        }

        fn workspace_root(&self) -> std::path::PathBuf {
            std::env::temp_dir()
        }

        fn home_dir(&self) -> Option<std::path::PathBuf> {
            None
        }
    }

    #[cfg(feature = "workflow-js")]
    #[tokio::test]
    async fn minimal_script() {
        let service = WorkflowService::new();
        let run_id = service.start("return 42;".to_string(), None, Arc::new(EchoHost));
        let result = service.wait(&run_id, Some(5_000)).await.unwrap();
        assert_eq!(result.status, WorkflowStatus::Completed);
        assert_eq!(result.result, Some(serde_json::json!(42)));
    }

    #[cfg(not(feature = "workflow-js"))]
    #[tokio::test]
    async fn without_the_js_engine_runs_fail_cleanly() {
        let service = WorkflowService::new();
        let run_id = service.start("return 1;".to_string(), None, Arc::new(EchoHost));
        let result = service.wait(&run_id, Some(5_000)).await.unwrap();
        assert_eq!(result.status, WorkflowStatus::Failed);
        assert!(
            result
                .error
                .unwrap()
                .contains("not compiled into this build")
        );
    }

    #[cfg(feature = "workflow-js")]
    #[tokio::test]
    async fn runs_a_script_and_reports_the_result() {
        let service = WorkflowService::new();
        let run_id = service.start(
            "phase('Go');\nlog('hi');\nconst a = await agent('x');\nconst b = await agent('y');\nreturn [a, b];".to_string(),
            None,
            Arc::new(EchoHost),
        );
        let result = service.wait(&run_id, Some(10_000)).await.unwrap();
        assert_eq!(result.status, WorkflowStatus::Completed);
        assert_eq!(result.agent_count, 2);
        assert_eq!(result.current_phase.as_deref(), Some("Go"));
        assert_eq!(
            result.result.unwrap(),
            serde_json::json!(["echo:x", "echo:y"])
        );
    }

    #[cfg(feature = "workflow-js")]
    #[tokio::test]
    async fn cancel_settles_a_running_run() {
        let service = WorkflowService::new();
        let run_id = service.start(
            "await sleep(60000); return 'late';".to_string(),
            None,
            Arc::new(EchoHost),
        );
        service.cancel(&run_id).await;
        let result = service.status(&run_id).unwrap();
        assert_eq!(result.status, WorkflowStatus::Cancelled);
    }

    #[cfg(feature = "workflow-js")]
    #[tokio::test]
    async fn failures_are_reported() {
        let service = WorkflowService::new();
        let run_id = service.start(
            "throw new Error('boom');".to_string(),
            None,
            Arc::new(EchoHost),
        );
        let result = service.wait(&run_id, Some(10_000)).await.unwrap();
        assert_eq!(result.status, WorkflowStatus::Failed);
        assert!(result.error.unwrap().contains("boom"));
    }
}
