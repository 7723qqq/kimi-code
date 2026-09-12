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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

use crate::storage::StateStore;

/// The grace period [`TaskRunner::stop`] waits for a task to settle at
/// its next cooperative point before returning (v2 `SIGTERM_GRACE_MS`).
const STOP_GRACE: Duration = Duration::from_secs(5);

/// The runner's view of a task's status; the wire strings match the v2
/// task domain (`running` / `completed` / `killed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Running,
    Completed,
    Killed,
}

impl TaskStatus {
    /// The v2 task-domain wire string (`running` / `completed` / `killed`).
    pub fn as_str(&self) -> &'static str {
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

/// Spawn context a caller can attach: which session the task belongs to and
/// what kind of work it is, so the lifecycle events reach the right lane with
/// the Web vocabulary's task shapes.
#[derive(Debug, Clone, Default)]
pub struct TaskSpawnMeta<'a> {
    pub session_id: Option<&'a str>,
    /// `subagent` | `bash` | `tool` (kimi-web `WireTask.kind`).
    pub kind: &'a str,
    pub subagent_type: Option<&'a str>,
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
    /// Which session spawned the task (`event.task.*` lane routing).
    session_id: Option<String>,
    /// `subagent` | `bash` | `tool`.
    kind: String,
    subagent_type: Option<String>,
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

/// The lifecycle sink signature: the task's session (for lane routing; `None`
/// means the `global` lane) and the event payload.
pub type TaskEventSink = Arc<dyn Fn(Option<&str>, Value) + Send + Sync>;

/// The `[background]` knobs one engine context applies to its own task runner
/// and Bash tool. Every field is optional: `None` keeps the built-in behavior
/// (5s stop grace / unlimited concurrency / auto-background on / 600s
/// background Bash timeout), so an unconfigured file behaves exactly as
/// before.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackgroundLimits {
    /// `kill_grace_period_ms`: how long `stop` waits for a cooperative exit.
    pub kill_grace_period_ms: Option<u64>,
    /// `max_running_tasks`: cap on concurrently running tasks; `Some(0)` (and
    /// `None`) mean unlimited.
    pub max_running_tasks: Option<u32>,
    /// `bash_auto_background_on_timeout`: migrate a timed-out foreground Bash
    /// call to the background instead of killing it.
    pub bash_auto_background_on_timeout: Option<bool>,
    /// `bash_task_timeout_s`: default timeout for background Bash tasks;
    /// `Some(0)` means "no timeout".
    pub bash_task_timeout_s: Option<u64>,
}

impl BackgroundLimits {
    /// Build from host-resolved wire values (the session params of the napi /
    /// stdio entries). A non-positive grace period or concurrency cap is not
    /// meaningful and is treated as unset; `bash_task_timeout_s` keeps `0`,
    /// which is a real value meaning "no timeout".
    #[must_use]
    pub fn from_wire(
        kill_grace_period_ms: Option<u64>,
        max_running_tasks: Option<u64>,
        bash_auto_background_on_timeout: Option<bool>,
        bash_task_timeout_s: Option<u64>,
    ) -> Self {
        Self {
            kill_grace_period_ms: kill_grace_period_ms.filter(|value| *value > 0),
            max_running_tasks: max_running_tasks
                .filter(|value| *value > 0)
                .and_then(|value| u32::try_from(value).ok()),
            bash_auto_background_on_timeout,
            bash_task_timeout_s,
        }
    }
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
    /// Completion notifications awaiting delivery (v2
    /// `task.notificationDelivery`). Settled tasks push here so a host
    /// or in-process consumer can drain and surface them as
    /// conversation input; the runner itself does not inject — v2
    /// wires the dispatcher, repl, and host to consume.
    pending_notifications: Mutex<Vec<TaskNotification>>,
    /// Optional lifecycle sink (the server's hub): fired as
    /// `event.task.created` / `background.task.started` on spawn and
    /// `event.task.completed` / `background.task.terminated` on settle, with
    /// the task's session for lane routing. Absent = purely local runner.
    event_sink: Mutex<Option<TaskEventSink>>,
    /// How long [`Self::stop`] waits for a cooperative exit
    /// (`[background].kill_grace_period_ms`); defaults to [`STOP_GRACE`].
    /// Mutable so a shared runner can pick the value up after construction
    /// (the daemon receives its config after the runner exists).
    kill_grace: Mutex<Duration>,
    /// Cap on concurrently running tasks
    /// (`[background].max_running_tasks`); `0` is unlimited.
    max_running: AtomicUsize,
}

/// A task completion event queued by [`TaskRunner::settle_task`] and
/// drained via [`TaskRunner::take_pending_notifications`]. Mirrors v2's
/// `task.notificationDelivery` payload shape: identifier, description,
/// terminal status, optional output preview, and wall-clock end time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNotification {
    pub task_id: String,
    pub description: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<String>,
    pub ended_at: u64,
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
            pending_notifications: Mutex::new(Vec::new()),
            event_sink: Mutex::new(None),
            kill_grace: Mutex::new(STOP_GRACE),
            max_running: AtomicUsize::new(0),
        }
    }

    /// Apply the `[background]` knobs: the cooperative-stop grace period and
    /// the cap on concurrently running tasks. Unset values keep the
    /// built-in behavior (5s / unlimited).
    #[must_use]
    pub fn with_background_limits(
        self,
        kill_grace_period_ms: Option<u64>,
        max_running_tasks: Option<u32>,
    ) -> Self {
        self.apply_background_limits(kill_grace_period_ms, max_running_tasks);
        self
    }

    /// [`Self::with_background_limits`] on a shared runner: the daemon
    /// resolves its config after the runner was built.
    pub fn apply_background_limits(
        &self,
        kill_grace_period_ms: Option<u64>,
        max_running_tasks: Option<u32>,
    ) {
        if let Some(ms) = kill_grace_period_ms.filter(|ms| *ms > 0) {
            *self.kill_grace.lock().unwrap() = Duration::from_millis(ms);
        }
        if let Some(Ok(cap)) = max_running_tasks
            .filter(|cap| *cap > 0)
            .map(usize::try_from)
        {
            self.max_running.store(cap, Ordering::Relaxed);
        }
    }

    /// Install the lifecycle event sink (the server does this once, fanning
    /// out to the task's session lane — or `global` when the task has none).
    pub fn set_event_sink(&self, sink: TaskEventSink) {
        *self.event_sink.lock().unwrap() = Some(sink);
    }

    /// Emit one live output chunk for a running task on its session lane
    /// (`event.task.progress`). A no-op for an unknown task or when no sink is
    /// wired, so a streaming caller can report unconditionally.
    pub fn emit_progress(&self, task_id: &str, output_chunk: &str, stream: &str) {
        let session = {
            let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match tasks.get(task_id) {
                Some(entry) => entry.session_id.clone(),
                None => return,
            }
        };
        self.fire_event(
            session.as_deref(),
            serde_json::json!({
                "type": "event.task.progress",
                "task_id": task_id,
                "output_chunk": output_chunk,
                "stream": stream,
            }),
        );
    }

    fn fire_event(&self, session_id: Option<&str>, event: Value) {
        if let Some(sink) = self.event_sink.lock().unwrap().as_ref() {
            sink(session_id, event);
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
        self.spawn_task_with_meta(
            TaskSpawnMeta {
                session_id: None,
                kind: "tool",
                subagent_type: None,
            },
            id,
            description,
            future,
        )
    }

    /// [`Self::spawn_task`] with spawn context: the task's session (event
    /// lane routing) and work kind (the Web task vocabulary's shapes).
    pub fn spawn_task_with_meta<F>(
        self: &Arc<Self>,
        meta: TaskSpawnMeta<'_>,
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
        // `[background].max_running_tasks`: refuse rather than queue, so the
        // caller sees the limit immediately (v2 `TASK_LIMIT_EXCEEDED`).
        let cap = self.max_running.load(Ordering::Relaxed);
        if cap > 0 {
            let running = tasks
                .values()
                .filter(|entry| entry.status == TaskStatus::Running)
                .count();
            if running >= cap {
                return Err(format!(
                    "Too many background tasks are already running (limit {cap})."
                ));
            }
        }
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done: Shared<BoxFuture<'static, ()>> = Box::pin(async move {
            let _ = done_rx.await;
        })
        .boxed()
        .shared();
        let started_at = now_ms();
        let entry = TaskEntry {
            id: id.clone(),
            description: description.clone(),
            started_at,
            status: TaskStatus::Running,
            ended_at: None,
            stop_reason: None,
            output: None,
            session_id: meta.session_id.map(str::to_string),
            kind: meta.kind.to_string(),
            subagent_type: meta.subagent_type.map(str::to_string),
            cancel: Arc::new(AtomicBool::new(false)),
            cancel_notify: Arc::new(Notify::new()),
            done,
            handle: None,
        };
        self.persist_wire(&self.entry_wire(&entry));
        let cancel = Arc::clone(&entry.cancel);
        let cancel_notify = Arc::clone(&entry.cancel_notify);
        let spawn_session = entry.session_id.clone();
        let spawn_kind = entry.kind.clone();
        let spawn_subagent_type = entry.subagent_type.clone();
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
                // Killed via the cancel flag, which only `stop()` sets — and
                // `stop()` records the reason on the entry up front — so the
                // wrapper settles with `None` and never overwrites it.
                (TaskStatus::Killed, None)
            };
            runner.settle_task(&task_id, status, output, stop_reason);
            let _ = done_tx.send(());
        });
        tasks.get_mut(&id).unwrap().handle = Some(handle);
        drop(tasks);

        // Announce the task in both vocabularies the Web client consumes:
        // the protocol shape (mappers `event.task.created`) and the legacy
        // agent-event name (projector allowlist).
        let session = spawn_session.as_deref();
        self.fire_event(
            session,
            serde_json::json!({
                "type": "event.task.created",
                "task": {
                    "id": id,
                    "session_id": session,
                    "kind": spawn_kind,
                    "description": description,
                    "status": "running",
                    "created_at": chrono::Utc::now().to_rfc3339(),
                    "started_at": chrono::Utc::now().to_rfc3339(),
                    "subagent_type": spawn_subagent_type,
                    "run_in_background": true,
                },
            }),
        );
        self.fire_event(
            session,
            serde_json::json!({
                "type": "background.task.started",
                "task_id": id,
                "description": description,
            }),
        );
        Ok(())
    }

    /// Ids of the tasks still `running`, oldest first.
    ///
    /// The print-mode settle loop (`session/mod.rs`) polls this until the
    /// list drains or its ceiling elapses: the runner owns no completion
    /// signal a caller can await on, so a poll is the only way to observe
    /// "the background work finished".
    pub fn running_ids(&self) -> Vec<String> {
        let tasks = self.tasks.lock().unwrap();
        let mut running: Vec<(&u64, &String)> = tasks
            .values()
            .filter(|entry| entry.status == TaskStatus::Running)
            .map(|entry| (&entry.started_at, &entry.id))
            .collect();
        running.sort_by_key(|(started_at, _)| **started_at);
        running.into_iter().map(|(_, id)| id.clone()).collect()
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
    ///
    /// The `reason` becomes the entry's `stopReason` (blank/`None` falls
    /// back to `"Stopped by TaskStop"`); a reason already on the entry is
    /// never overwritten.
    pub async fn stop(&self, id: &str, reason: Option<&str>) -> Result<Value, String> {
        let done = {
            let mut tasks = self.tasks.lock().unwrap();
            let Some(entry) = tasks.get_mut(id) else {
                return Err(format!("Task not found: {id}"));
            };
            if entry.status != TaskStatus::Running {
                return Ok(self.entry_wire(entry));
            }
            if entry.stop_reason.is_none() {
                let reason = reason
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| "Stopped by TaskStop".to_string());
                entry.stop_reason = Some(reason);
            }
            entry.cancel.store(true, Ordering::Relaxed);
            entry.cancel_notify.notify_waiters();
            entry.done.clone()
        };
        let grace = *self.kill_grace.lock().unwrap();
        let _ = tokio::time::timeout(grace, done).await;
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
        let (description, ended_at, output_preview, wire, session_id, kind, output_bytes) = {
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
            let ended_at = entry.ended_at.unwrap_or(now_ms());
            let preview = entry.output.as_deref().and_then(truncate_preview);
            let description = entry.description.clone();
            let wire = self.entry_wire(entry);
            (
                description,
                ended_at,
                preview,
                wire,
                entry.session_id.clone(),
                entry.kind.clone(),
                entry.output.as_ref().map(|o| o.len()),
            )
        };
        if let Some(output) = wire.get("output").and_then(|v| v.as_str())
            && let Some(store) = &self.store
        {
            store.write_task_output(id, output);
        }
        self.persist_wire(&wire);
        // Queue a completion notification for delivery (v2
        // `task.notificationDelivery`). Consumers (host, repl, engine
        // injection) drain via `take_pending_notifications`.
        self.pending_notifications
            .lock()
            .unwrap()
            .push(TaskNotification {
                task_id: id.to_string(),
                description,
                status,
                output_preview: output_preview.clone(),
                ended_at,
            });
        // Terminal facts, both vocabularies (mappers + projector).
        let session = session_id.as_deref();
        self.fire_event(
            session,
            serde_json::json!({
                "type": "event.task.completed",
                "task_id": id,
                "status": status.as_str(),
                "output_preview": output_preview,
                "output_bytes": output_bytes,
            }),
        );
        self.fire_event(
            session,
            serde_json::json!({
                "type": "background.task.terminated",
                "task_id": id,
                "status": status.as_str(),
                "kind": kind,
            }),
        );
    }

    /// Drain pending completion notifications. The runner retains nothing
    /// after the call; consumers that need persistence persist themselves.
    pub fn take_pending_notifications(&self) -> Vec<TaskNotification> {
        std::mem::take(&mut *self.pending_notifications.lock().unwrap())
    }

    /// Pending notification count (for hosts that want to know whether to
    /// poll without consuming the queue).
    pub fn pending_notification_count(&self) -> usize {
        self.pending_notifications.lock().unwrap().len()
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
    /// task domain file carries the v2 task entry shape only; the output
    /// log is persisted separately by `settle_task` via
    /// `StateStore::write_task_output`.
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

/// Truncate a task output for inclusion in the completion notification
/// payload (v2 `renderNotificationXml` keeps a head/tail preview).
const NOTIFICATION_PREVIEW_CHARS: usize = 500;

fn truncate_preview(output: &str) -> Option<String> {
    let total = output.chars().count();
    if total <= NOTIFICATION_PREVIEW_CHARS {
        return Some(output.to_string());
    }
    // For moderate lengths, keep head and tail so the model can still see
    // what the task started and finished with.
    let head: String = output.chars().take(NOTIFICATION_PREVIEW_CHARS).collect();
    let tail: String = output
        .chars()
        .rev()
        .take(NOTIFICATION_PREVIEW_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    Some(format!("{head}\n…\n{tail}"))
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

    /// Captured sink events: `(session lane, payload)` pairs.
    type CapturedEvents = Arc<std::sync::Mutex<Vec<(Option<String>, Value)>>>;

    fn runner() -> (TempDir, Arc<TaskRunner>) {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::for_dir(tmp.path().join("state")).unwrap();
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

    #[test]
    fn background_limits_from_wire_drops_only_meaningless_zeroes() {
        // Unset wire values keep every built-in.
        assert_eq!(
            BackgroundLimits::from_wire(None, None, None, None),
            BackgroundLimits::default()
        );
        // A zero grace period / concurrency cap is not meaningful (JSON has no
        // way to say "unset"), so it falls back to the built-in...
        assert_eq!(
            BackgroundLimits::from_wire(Some(0), Some(0), None, None),
            BackgroundLimits::default()
        );
        // ...but `bash_task_timeout_s = 0` is a real value meaning "no
        // timeout", and a concurrency cap wider than `u32` is discarded.
        let limits = BackgroundLimits::from_wire(
            Some(250),
            Some(u64::from(u32::MAX) + 1),
            Some(false),
            Some(0),
        );
        assert_eq!(
            limits,
            BackgroundLimits {
                kill_grace_period_ms: Some(250),
                max_running_tasks: None,
                bash_auto_background_on_timeout: Some(false),
                bash_task_timeout_s: Some(0),
            }
        );
        // A cap that fits is carried through.
        assert_eq!(
            BackgroundLimits::from_wire(None, Some(4), None, None).max_running_tasks,
            Some(4)
        );
    }

    #[tokio::test]
    async fn lifecycle_events_carry_the_session_and_both_vocabularies() {
        let (_tmp, runner) = runner();
        let events: CapturedEvents = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        runner.set_event_sink(Arc::new(move |session, event| {
            sink.lock()
                .unwrap()
                .push((session.map(str::to_string), event));
        }));

        runner
            .spawn_task_with_meta(
                TaskSpawnMeta {
                    session_id: Some("sess-9"),
                    kind: "subagent",
                    subagent_type: Some("research"),
                },
                "task-ev".into(),
                "Subagent research: investigate".into(),
                async { "done".to_string() },
            )
            .unwrap();

        // Spawn announces created + started on the task's session lane.
        let (created_session, created) = events.lock().unwrap()[0].clone();
        assert_eq!(created_session.as_deref(), Some("sess-9"));
        assert_eq!(created["type"], "event.task.created");
        assert_eq!(created["task"]["id"], "task-ev");
        assert_eq!(created["task"]["session_id"], "sess-9");
        assert_eq!(created["task"]["kind"], "subagent");
        assert_eq!(created["task"]["status"], "running");
        assert_eq!(created["task"]["subagent_type"], "research");
        assert_eq!(created["task"]["run_in_background"], true);
        let (started_session, started) = events.lock().unwrap()[1].clone();
        assert_eq!(started_session.as_deref(), Some("sess-9"));
        assert_eq!(started["type"], "background.task.started");
        assert_eq!(started["task_id"], "task-ev");

        // Settling announces completed + terminated with the output facts.
        assert!(
            matches!(
                runner.wait("task-ev", 2000).await,
                TaskWaitResult::Completed(_)
            ),
            "the task must settle for the assertion below"
        );
        {
            let lock = events.lock().unwrap();
            let completed = &lock[2].1;
            assert_eq!(completed["type"], "event.task.completed");
            assert_eq!(completed["task_id"], "task-ev");
            assert_eq!(completed["status"], "completed");
            assert_eq!(completed["output_preview"], "done");
            assert_eq!(completed["output_bytes"], 4);
            let terminated = &lock[3].1;
            assert_eq!(terminated["type"], "background.task.terminated");
            assert_eq!(terminated["task_id"], "task-ev");
            assert_eq!(terminated["status"], "completed");
        }
    }

    #[tokio::test]
    async fn emit_progress_reports_on_the_running_tasks_lane() {
        let (_tmp, runner) = runner();
        let events: CapturedEvents = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        runner.set_event_sink(Arc::new(move |session, event| {
            sink.lock()
                .unwrap()
                .push((session.map(str::to_string), event));
        }));

        runner
            .spawn_task_with_meta(
                TaskSpawnMeta {
                    session_id: Some("sess-prog"),
                    kind: "bash",
                    subagent_type: None,
                },
                "task-prog".into(),
                "background job".into(),
                async {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    "done".to_string()
                },
            )
            .unwrap();

        // An unknown task id is a silent no-op.
        runner.emit_progress("missing", "ignored", "stdout");
        runner.emit_progress("task-prog", "hello ", "stdout");

        assert!(matches!(
            runner.wait("task-prog", 2000).await,
            TaskWaitResult::Completed(_)
        ));

        let lock = events.lock().unwrap();
        let progress: Vec<_> = lock
            .iter()
            .filter(|(_, event)| event["type"] == "event.task.progress")
            .collect();
        assert_eq!(progress.len(), 1, "unknown task must not emit");
        assert_eq!(progress[0].0.as_deref(), Some("sess-prog"));
        assert_eq!(progress[0].1["task_id"], "task-prog");
        assert_eq!(progress[0].1["output_chunk"], "hello ");
        assert_eq!(progress[0].1["stream"], "stdout");
    }

    #[tokio::test]
    async fn background_limits_cap_concurrent_tasks() {
        // `[background].max_running_tasks`: the cap refuses a spawn rather
        // than queueing it, and frees up once a task settles.
        let runner = Arc::new(TaskRunner::new(None).with_background_limits(None, Some(1)));
        // A oneshot (not a Notify): the release must not race the task's
        // first poll, or the wait never ends.
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        runner
            .spawn_task("t1".into(), "first".into(), async move {
                let _ = held.await;
                "done".to_string()
            })
            .unwrap();

        let err = runner
            .spawn_task("t2".into(), "second".into(), async { "x".to_string() })
            .expect_err("the cap is one running task");
        assert!(err.contains("Too many background tasks"), "{err}");

        let _ = release.send(());
        assert!(matches!(
            runner.wait("t1", 2000).await,
            TaskWaitResult::Completed(_)
        ));
        runner
            .spawn_task("t3".into(), "third".into(), async { "x".to_string() })
            .expect("the slot frees up when the task settles");
    }

    #[tokio::test]
    async fn metaless_spawns_route_to_the_global_lane() {
        let (_tmp, runner) = runner();
        let events: CapturedEvents = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        runner.set_event_sink(Arc::new(move |session, event| {
            sink.lock()
                .unwrap()
                .push((session.map(str::to_string), event));
        }));

        runner
            .spawn_task("task-none".into(), "bash".into(), async { "x".to_string() })
            .unwrap();
        let (session, created) = events.lock().unwrap()[0].clone();
        assert_eq!(session, None, "no meta → no session → global lane");
        assert_eq!(created["task"]["session_id"], Value::Null);
        assert_eq!(created["task"]["kind"], "tool");
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
        let wire = runner.stop("task-1", None).await.unwrap();
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
        let wire = runner.stop("task-1", None).await.unwrap();
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
        runner.stop("task-1", None).await.unwrap();
    }

    #[tokio::test]
    async fn unknown_task_is_not_found() {
        let (_tmp, runner) = runner();
        assert!(matches!(
            runner.wait("nope", 100).await,
            TaskWaitResult::NotFound
        ));
        let err = runner.stop("nope", None).await.unwrap_err();
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
        runner.stop("task-2", None).await.unwrap();
    }

    #[tokio::test]
    async fn stop_records_custom_reason() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task(
                "task-1".into(),
                "long".into(),
                std::future::pending::<String>(),
            )
            .unwrap();
        let wire = runner
            .stop("task-1", Some("User initiated stop"))
            .await
            .unwrap();
        assert_eq!(wire["status"], "killed");
        assert_eq!(wire["stopReason"], "User initiated stop");
        // A blank reason falls back to the default.
        runner
            .spawn_task(
                "task-2".into(),
                "long".into(),
                std::future::pending::<String>(),
            )
            .unwrap();
        let wire = runner.stop("task-2", Some("   ")).await.unwrap();
        assert_eq!(wire["stopReason"], "Stopped by TaskStop");
    }

    #[tokio::test]
    async fn stop_on_terminal_task_returns_current_status() {
        let (_tmp, runner) = runner();
        runner
            .spawn_task("task-1".into(), "a".into(), async { "x".to_string() })
            .unwrap();
        runner.wait("task-1", 5000).await;
        let wire = runner.stop("task-1", Some("late reason")).await.unwrap();
        assert_eq!(wire["status"], "completed");
        // Terminal entries keep their state: no reason is attached.
        assert!(wire.get("stopReason").is_none());
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
