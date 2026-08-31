//! Background task runner for the standalone REPL (P32 批 2).
//!
//! Provides a local task runner over the task domain of the state store:
//! [`TaskRunner`] registers spawned tokio tasks by id, snapshots their
//! output on completion, and mirrors the task status (`running` /
//! `completed` / `killed`) back into `<workspace>/.kimi/state/task.json`
//! so the state bridge's TaskList / TaskOutput / TaskStop / TaskWait
//! renderers see the same wire shapes as the v2 host.
//!
//! Cancellation is cooperative: [`TaskRunner::stop`] sets a per-task
//! cancel flag and wakes the runner's wrapper, which races the task
//! future against the flag at the task's next yield point (the future is
//! dropped, cancelling its pending work). The wrapper settles the entry
//! (`killed` + `stopReason` + `endedAt`) and notifies waiters. A task
//! that finishes before the stop lands settles as `completed`.
//!
//! Waiters are woken through a shared completion future
//! (`futures_util::future::Shared` over a oneshot), which resolves for
//! every waiter — including waiters that register after the task already
//! settled — so a wait can never miss the completion.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

use crate::storage::StateStore;

/// The grace period [`TaskRunner::stop`] waits for a task to settle at
/// its next cooperative point before returning (v2 `SIGTERM_GRACE_MS`).
const STOP_GRACE: Duration = Duration::from_secs(5);

/// The runner's view of a task's status; the wire strings match the v2
/// task domain (`running` / `completed` / `killed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Running,
    Completed,
    Killed,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Completed => "completed",
            TaskStatus::Killed => "killed",
        }
    }
}

/// The outcome of [`TaskRunner::wait`]: the task settled, the wait
/// elapsed while the task was still running, or no such task exists.
#[derive(Debug)]
pub enum TaskWaitResult {
    /// The task reached a terminal state; carries the settled entry wire.
    Completed(Value),
    /// The wait elapsed before the task finished; carries the current
    /// (still-running) entry wire.
    TimedOut(Value),
    /// No task with this id is registered.
    NotFound,
}

/// One registered background task.
struct TaskEntry {
    id: String,
    description: String,
    started_at: u64,
    status: TaskStatus,
    ended_at: Option<u64>,
    stop_reason: Option<String>,
    output: Option<String>,
    /// Cooperative cancellation flag, set by `stop()`; the spawned
    /// wrapper checks it at the task's next yield point.
    cancel: Arc<AtomicBool>,
    /// Wakes the wrapper when the cancel flag is set.
    cancel_notify: Arc<Notify>,
    /// Resolves once the wrapper has settled the entry; every waiter
    /// (including late ones) observes the completion.
    done: Shared<BoxFuture<'static, ()>>,
    /// The spawned tokio task.
    handle: Option<JoinHandle<()>>,
}

/// Local background task runner: a registry of spawned tasks plus their
/// output snapshots, with the task domain state mirrored into the
/// [`StateStore`] when one is attached.
pub struct TaskRunner {
    tasks: Mutex<HashMap<String, TaskEntry>>,
    /// Serializes task.json read-modify-write cycles so concurrent
    /// settles cannot lose each other's updates.
    persist_lock: Mutex<()>,
    store: Option<StateStore>,
}

impl TaskRunner {
    /// Create a runner; `store` is the state store whose `task` domain
    /// receives the status updates (`None` keeps the runner purely
    /// in-memory).
    pub fn new(store: Option<StateStore>) -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            persist_lock: Mutex::new(()),
            store,
        }
    }

    /// Create a runner backed by the state store of a workspace
    /// (`<workspace>/.kimi/state/`).
    pub fn for_workspace(workspace_root: &Path) -> std::io::Result<Self> {
        Ok(Self::new(Some(StateStore::for_workspace(workspace_root)?)))
    }

    /// Register a background task and spawn it on the current tokio
    /// runtime. The task's output is snapshotted when it completes; a
    /// `stop()` that lands before completion settles the task as
    /// `killed` with no output. The runner must be shared (`Arc`) so the
    /// spawned wrapper can settle the entry.
    pub fn spawn_task<F>(
        self: &Arc<Self>,
        id: String,
        description: String,
        future: F,
    ) -> Result<(), String>
    where
        F: Future<Output = String> + Send + 'static,
    {
        let mut tasks = self.tasks.lock().unwrap();
        if tasks.contains_key(&id) {
            return Err(format!("task already exists: {id}"));
        }
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done: Shared<BoxFuture<'static, ()>> = Box::pin(async move {
            let _ = done_rx.await;
        })
        .boxed()
        .shared();
        let entry = TaskEntry {
            id: id.clone(),
            description,
            started_at: now_ms(),
            status: TaskStatus::Running,
            ended_at: None,
            stop_reason: None,
            output: None,
            cancel: Arc::new(AtomicBool::new(false)),
            cancel_notify: Arc::new(Notify::new()),
            done,
            handle: None,
        };
        self.persist_wire(&self.entry_wire(&entry));
        let cancel = Arc::clone(&entry.cancel);
        let cancel_notify = Arc::clone(&entry.cancel_notify);
        tasks.insert(id.clone(), entry);
        let runner = Arc::clone(self);
        let task_id = id.clone();
        let handle = tokio::spawn(async move {
            let output = tokio::select! {
                biased;
                output = future => Some(output),
                _ = cancelled(cancel, cancel_notify) => None,
            };
            let (status, stop_reason) = if output.is_some() {
                (TaskStatus::Completed, None)
            } else {
                (TaskStatus::Killed, Some("Stopped by TaskStop".to_string()))
            };
            runner.settle_task(&task_id, status, output, stop_reason);
            let _ = done_tx.send(());
        });
        tasks.get_mut(&id).unwrap().handle = Some(handle);
        Ok(())
    }

    /// The output snapshot of a settled task; `None` while the task is
    /// still running (or unknown), and for tasks that were stopped
    /// before completing.
    pub fn get_output(&self, id: &str) -> Option<String> {
        let tasks = self.tasks.lock().unwrap();
        let entry = tasks.get(id)?;
        if entry.status == TaskStatus::Running {
            return None;
        }
        entry.output.clone()
    }

    /// Request a cooperative stop: sets the task's cancel flag and wakes
    /// its wrapper, then waits up to [`STOP_GRACE`] for the task to
    /// settle at its next yield point. Returns the current entry wire —
    /// `killed` once the task settled, the still-running entry if it
    /// never yields (the wrapper settles it later). Stopping a terminal
    /// task returns its current entry unchanged.
    pub async fn stop(&self, id: &str) -> Result<Value, String> {
        let done = {
            let tasks = self.tasks.lock().unwrap();
            let Some(entry) = tasks.get(id) else {
                return Err(format!("Task not found: {id}"));
            };
            if entry.status != TaskStatus::Running {
                return Ok(self.entry_wire(entry));
            }
            entry.cancel.store(true, Ordering::Relaxed);
            entry.cancel_notify.notify_waiters();
            entry.done.clone()
        };
        let _ = tokio::time::timeout(STOP_GRACE, done).await;
        let tasks = self.tasks.lock().unwrap();
        let entry = tasks.get(id).unwrap();
        Ok(self.entry_wire(entry))
    }

    /// Wait for a task to settle, up to `timeout_ms` (v2 `wait`
    /// semantics: a terminal task returns immediately, `timeout_ms == 0`
    /// returns the current entry without waiting, and a timeout is not
    /// an error — the caller decides whether to wait again).
    pub async fn wait(&self, id: &str, timeout_ms: u64) -> TaskWaitResult {
        let done = {
            let tasks = self.tasks.lock().unwrap();
            let Some(entry) = tasks.get(id) else {
                return TaskWaitResult::NotFound;
            };
            if entry.status != TaskStatus::Running {
                return TaskWaitResult::Completed(self.entry_wire(entry));
            }
            entry.done.clone()
        };
        if timeout_ms == 0 {
            let tasks = self.tasks.lock().unwrap();
            let entry = tasks.get(id).unwrap();
            return TaskWaitResult::TimedOut(self.entry_wire(entry));
        }
        let result = tokio::time::timeout(Duration::from_millis(timeout_ms), done).await;
        let tasks = self.tasks.lock().unwrap();
        let entry = tasks.get(id).unwrap();
        let wire = self.entry_wire(entry);
        // A task that settled just as the timeout fired reports the
        // terminal state, matching v2's post-race status check.
        if result.is_ok() || entry.status != TaskStatus::Running {
            TaskWaitResult::Completed(wire)
        } else {
            TaskWaitResult::TimedOut(wire)
        }
    }

    /// Every registered task's entry wire, oldest first; the output
    /// snapshot is omitted (TaskList does not carry output).
    pub fn list(&self) -> Vec<Value> {
        let tasks = self.tasks.lock().unwrap();
        let mut entries: Vec<Value> = tasks.values().map(|entry| self.entry_wire(entry)).collect();
        for entry in &mut entries {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove("output");
            }
        }
        entries.sort_by(|a, b| {
            let a_started = a.get("startedAt").and_then(|v| v.as_u64()).unwrap_or(0);
            let b_started = b.get("startedAt").and_then(|v| v.as_u64()).unwrap_or(0);
            a_started
                .cmp(&b_started)
                .then_with(|| a["taskId"].as_str().cmp(&b["taskId"].as_str()))
        });
        entries
    }

    /// One task's entry wire (with the output snapshot when settled), or
    /// `None` for an unknown id.
    pub fn entry(&self, id: &str) -> Option<Value> {
        let tasks = self.tasks.lock().unwrap();
        tasks.get(id).map(|entry| self.entry_wire(entry))
    }

    /// Settle a task from its spawned wrapper: record the terminal
    /// status, the end time, the output snapshot and the stop reason,
    /// then mirror the entry into the task domain.
    fn settle_task(
        &self,
        id: &str,
        status: TaskStatus,
        output: Option<String>,
        stop_reason: Option<String>,
    ) {
        let wire = {
            let mut tasks = self.tasks.lock().unwrap();
            let Some(entry) = tasks.get_mut(id) else {
                return;
            };
            entry.status = status;
            entry.ended_at = Some(now_ms());
            entry.output = output;
            if let Some(reason) = stop_reason {
                entry.stop_reason = Some(reason);
            }
            self.entry_wire(entry)
        };
        self.persist_wire(&wire);
    }

    /// The task entry as the state bridge wire value: `taskId` /
    /// `description` / `status` / `startedAt` / `endedAt` / `stopReason`
    /// plus the `output` snapshot when settled (the renderers filter the
    /// output key from metadata lines).
    fn entry_wire(&self, entry: &TaskEntry) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("taskId".into(), json!(entry.id));
        obj.insert("description".into(), json!(entry.description));
        obj.insert("status".into(), json!(entry.status.as_str()));
        obj.insert("startedAt".into(), json!(entry.started_at));
        if let Some(ended_at) = entry.ended_at {
            obj.insert("endedAt".into(), json!(ended_at));
        }
        if let Some(reason) = &entry.stop_reason {
            obj.insert("stopReason".into(), json!(reason));
        }
        if let Some(output) = &entry.output {
            obj.insert("output".into(), json!(output));
        }
        Value::Object(obj)
    }

    /// Mirror an entry wire into the `task` domain of the state store
    /// (best-effort: a missing store or a failed write only logs). The
    /// output snapshot is not persisted — the task domain file carries
    /// the v2 task entry shape only.
    fn persist_wire(&self, wire: &Value) {
        let Some(store) = &self.store else {
            return;
        };
        let _guard = self.persist_lock.lock().unwrap();
        let mut tasks = store
            .read_domain("task")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let id = wire
            .get("taskId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let mut stored = wire.clone();
        if let Some(obj) = stored.as_object_mut() {
            obj.remove("output");
        }
        match tasks
            .iter_mut()
            .find(|t| t.get("taskId").and_then(|v| v.as_str()) == Some(id))
        {
            Some(entry) => *entry = stored,
            None => tasks.push(stored),
        }
        if let Err(error) = store.write_domain("task", &Value::Array(tasks)) {
            tracing::warn!(target: "kimi_agent::storage::task_runner", "persist task state: {error}");
        }
    }
}

/// Await the cooperative cancellation flag: returns as soon as `stop()`
/// has been called for the task. The flag is re-checked around the
/// notification wait so a stop that lands between the check and the wait
/// is never missed.
async fn cancelled(cancel: Arc<AtomicBool>, cancel_notify: Arc<Notify>) {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let notified = cancel_notify.notified();
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        notified.await;
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn runner() -> (TempDir, Arc<TaskRunner>) {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::for_workspace(tmp.path()).unwrap();
        (tmp, Arc::new(TaskRunner::new(Some(store))))
    }

    fn stored_tasks(runner: &TaskRunner) -> Value {
        runner
            .store
            .as_ref()
            .unwrap()
            .read_domain("task")
            .unwrap_or(Value::Array(vec![]))
    }

    #[tokio::test]
    async fn spawn_completes_and_snapshots_output() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task("task-1".into(), "run tests".into(), async {
                "All tests passed.".to_string()
            })
            .unwrap();
        match runner.wait("task-1", 5000).await {
            TaskWaitResult::Completed(wire) => {
                assert_eq!(wire["taskId"], "task-1");
                assert_eq!(wire["description"], "run tests");
                assert_eq!(wire["status"], "completed");
                assert!(wire["startedAt"].as_u64().unwrap() > 0);
                assert!(wire["endedAt"].as_u64().unwrap() >= wire["startedAt"].as_u64().unwrap());
                assert_eq!(wire["output"], "All tests passed.");
            }
            other => panic!("expected completed, got {other:?}"),
        }
        assert_eq!(
            runner.get_output("task-1").as_deref(),
            Some("All tests passed.")
        );
        // The task domain state reflects the terminal status.
        let tasks = stored_tasks(&runner);
        assert_eq!(tasks.as_array().unwrap().len(), 1);
        assert_eq!(tasks[0]["taskId"], "task-1");
        assert_eq!(tasks[0]["status"], "completed");
        assert!(tasks[0].get("endedAt").is_some());
    }

    #[tokio::test]
    async fn output_is_none_while_running() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task(
                "task-1".into(),
                "long".into(),
                std::future::pending::<String>(),
            )
            .unwrap();
        assert_eq!(runner.get_output("task-1"), None);
        // The task domain state shows the running entry.
        let tasks = stored_tasks(&runner);
        assert_eq!(tasks[0]["taskId"], "task-1");
        assert_eq!(tasks[0]["status"], "running");
        // Clean up the pending task so the test runtime can shut down.
        let wire = runner.stop("task-1").await.unwrap();
        assert_eq!(wire["status"], "killed");
    }

    #[tokio::test]
    async fn stop_kills_running_task() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task(
                "task-1".into(),
                "long".into(),
                std::future::pending::<String>(),
            )
            .unwrap();
        let wire = runner.stop("task-1").await.unwrap();
        assert_eq!(wire["status"], "killed");
        assert_eq!(wire["stopReason"], "Stopped by TaskStop");
        assert!(wire["endedAt"].as_u64().unwrap() >= wire["startedAt"].as_u64().unwrap());
        // A stopped task has no output snapshot.
        assert_eq!(runner.get_output("task-1"), None);
        // Waiting on the killed task reports the terminal state.
        match runner.wait("task-1", 5000).await {
            TaskWaitResult::Completed(wire) => assert_eq!(wire["status"], "killed"),
            other => panic!("expected completed, got {other:?}"),
        }
        // The task domain state reflects the kill.
        let tasks = stored_tasks(&runner);
        assert_eq!(tasks[0]["status"], "killed");
        assert_eq!(tasks[0]["stopReason"], "Stopped by TaskStop");
    }

    #[tokio::test]
    async fn wait_times_out_then_completes() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task("task-1".into(), "slow".into(), async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                "done".to_string()
            })
            .unwrap();
        match runner.wait("task-1", 50).await {
            TaskWaitResult::TimedOut(wire) => assert_eq!(wire["status"], "running"),
            other => panic!("expected timed out, got {other:?}"),
        }
        match runner.wait("task-1", 5000).await {
            TaskWaitResult::Completed(wire) => {
                assert_eq!(wire["status"], "completed");
                assert_eq!(wire["output"], "done");
            }
            other => panic!("expected completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn wait_zero_timeout_returns_immediately() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task(
                "task-1".into(),
                "long".into(),
                std::future::pending::<String>(),
            )
            .unwrap();
        match runner.wait("task-1", 0).await {
            TaskWaitResult::TimedOut(wire) => assert_eq!(wire["status"], "running"),
            other => panic!("expected timed out, got {other:?}"),
        }
        runner.stop("task-1").await.unwrap();
    }

    #[tokio::test]
    async fn unknown_task_is_not_found() {
        let (_tmp, runner) = runner();
        assert!(matches!(
            runner.wait("nope", 100).await,
            TaskWaitResult::NotFound
        ));
        let err = runner.stop("nope").await.unwrap_err();
        assert!(err.contains("Task not found: nope"));
        assert_eq!(runner.get_output("nope"), None);
        assert_eq!(runner.entry("nope"), None);
    }

    #[tokio::test]
    async fn duplicate_spawn_is_rejected() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task("task-1".into(), "a".into(), async { "x".to_string() })
            .unwrap();
        let err = runner
            .spawn_task("task-1".into(), "b".into(), async { "y".to_string() })
            .unwrap_err();
        assert!(err.contains("task-1"));
    }

    #[tokio::test]
    async fn list_returns_entries_without_output() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task("task-1".into(), "a".into(), async { "x".to_string() })
            .unwrap();
        runner
            .spawn_task(
                "task-2".into(),
                "b".into(),
                std::future::pending::<String>(),
            )
            .unwrap();
        runner.wait("task-1", 5000).await;
        let entries = runner.list();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["taskId"], "task-1");
        assert_eq!(entries[0]["status"], "completed");
        assert!(entries[0].get("output").is_none());
        assert_eq!(entries[1]["taskId"], "task-2");
        assert_eq!(entries[1]["status"], "running");
        runner.stop("task-2").await.unwrap();
    }

    #[tokio::test]
    async fn stop_on_terminal_task_returns_current_status() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task("task-1".into(), "a".into(), async { "x".to_string() })
            .unwrap();
        runner.wait("task-1", 5000).await;
        let wire = runner.stop("task-1").await.unwrap();
        assert_eq!(wire["status"], "completed");
    }

    #[tokio::test]
    async fn runner_works_without_state_store() {
        let runner = Arc::new(TaskRunner::new(None));
        runner
            .spawn_task("task-1".into(), "a".into(), async { "x".to_string() })
            .unwrap();
        match runner.wait("task-1", 5000).await {
            TaskWaitResult::Completed(wire) => assert_eq!(wire["output"], "x"),
            other => panic!("expected completed, got {other:?}"),
        }
    }
}
