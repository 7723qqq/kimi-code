//! AgentRunBatch — pure batch scheduler for swarm-style subagent runs.
//!
//! Direct port of `agent-core-v2/src/features/swarm/session/agentRunBatch.ts`
//! (646 lines): a zero-host-dependency batch scheduler that drives an
//! [`AgentRunBatchLauncher`] through spawn/resume/retry with concurrency
//! limiting, provider rate-limit backoff (capacity shrink/recovery, global
//! retry spacing, pending reordering), per-task timeouts, and cancellation.
//! The launcher is a trait, so the scheduler is fully testable with a mock.
//!
//! Timing knobs live in [`AgentRunBatchTiming`] (defaults mirror the v2
//! constants); tests override them with short durations.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, watch};
use tokio::time::sleep;

use crate::rpc::types::{BoxFuture, TokenUsage};

/// Initial burst of attempts launched without spacing (v2 INITIAL_LAUNCH_LIMIT).
const INITIAL_LAUNCH_LIMIT: usize = 5;
/// Spacing between post-burst normal launches (v2 INITIAL_LAUNCH_INTERVAL_MS).
const INITIAL_LAUNCH_INTERVAL: Duration = Duration::from_millis(700);
/// Base delay for rate-limit retries (v2 RATE_LIMIT_RETRY_BASE_MS).
const RATE_LIMIT_RETRY_BASE: Duration = Duration::from_millis(3000);
/// Exponential factor for rate-limit retry delays (v2 RATE_LIMIT_RETRY_FACTOR).
const RATE_LIMIT_RETRY_FACTOR: u32 = 2;
/// Minimum spacing between capacity shrinks (v2 RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS).
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL: Duration = Duration::from_millis(2000);
/// Time after the last rate limit after which capacity recovers (v2
/// RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS).
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL: Duration = Duration::from_secs(3 * 60);
/// Reason reported to the launcher's `suspended` hook (v2 RATE_LIMIT_SUSPENDED_REASON).
const RATE_LIMIT_SUSPENDED_REASON: &str = "Provider rate limit; subagent requeued for retry.";
/// Env var read by `resolve_swarm_max_concurrency` (v2 AGENT_SWARM_MAX_CONCURRENCY_ENV).
const AGENT_SWARM_MAX_CONCURRENCY_ENV: &str = "KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY";

/// Why an abort happened. Mirrors the v2 distinction between a user
/// cancellation (`UserCancellationError`) and any other abort reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AbortReason {
    /// The user manually interrupted the batch.
    UserCancellation,
    /// Any other abort reason, carrying its message.
    Other(String),
}

impl fmt::Display for AbortReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AbortReason::UserCancellation => write!(f, "Aborted by the user"),
            AbortReason::Other(message) => write!(f, "{message}"),
        }
    }
}

/// A shareable abort signal (v2 `AbortSignal`/`AbortController` pair).
///
/// First abort wins; later aborts are ignored. Waiters are woken through a
/// watch channel, so concurrent waiters never miss an abort.
#[derive(Clone)]
pub struct AbortSignal {
    inner: Arc<AbortSignalInner>,
}

struct AbortSignalInner {
    aborted: AtomicBool,
    reason: Mutex<Option<AbortReason>>,
    tx: watch::Sender<Option<AbortReason>>,
    rx: watch::Receiver<Option<AbortReason>>,
}

impl AbortSignal {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(None);
        Self {
            inner: Arc::new(AbortSignalInner {
                aborted: AtomicBool::new(false),
                reason: Mutex::new(None),
                tx,
                rx,
            }),
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.inner.aborted.load(Ordering::SeqCst)
    }

    pub fn reason(&self) -> Option<AbortReason> {
        self.inner.reason.lock().unwrap().clone()
    }

    pub fn abort(&self, reason: Option<AbortReason>) {
        let mut guard = self.inner.reason.lock().unwrap();
        if guard.is_some() {
            return;
        }
        *guard = reason.clone();
        self.inner.aborted.store(true, Ordering::SeqCst);
        let _ = self.inner.tx.send(reason);
    }

    /// Resolves once the signal is aborted (immediately if already aborted).
    pub async fn wait(&self) {
        if self.is_aborted() {
            return;
        }
        let mut rx = self.inner.rx.clone();
        let _ = rx.changed().await;
    }
}

impl Default for AbortSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for AbortSignal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AbortSignal")
            .field("aborted", &self.is_aborted())
            .finish()
    }
}

/// What kind of agent run a task requests (v2 `SessionSwarmTask` kind).
#[derive(Clone, Debug)]
pub enum AgentRunTaskKind {
    Spawn,
    Resume { resume_agent_id: String },
}

/// A queued agent run task (v2 `SessionSwarmTask<T>`).
#[derive(Clone, Debug)]
pub struct AgentRunTask<T> {
    pub data: T,
    pub kind: AgentRunTaskKind,
    pub profile_name: String,
    pub parent_tool_call_id: String,
    pub parent_tool_call_uuid: Option<String>,
    pub prompt: String,
    pub description: String,
    pub swarm_index: Option<usize>,
    pub swarm_item: Option<String>,
    pub run_in_background: bool,
    pub timeout: Option<Duration>,
    pub signal: Option<AbortSignal>,
    /// Spawn plan; `Some` for spawn tasks, `None` for resume tasks.
    pub plan: Option<SubagentSpawnPlan>,
}

/// Final status of an agent run (v2 `AgentRunResult.status`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentRunStatus {
    Completed,
    Failed,
    Aborted,
}

/// How far an unfinished run got (v2 `AgentRunResult.state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentRunState {
    Started,
    NotStarted,
}

/// Result of one queued task (v2 `SessionSwarmRunResult<T>`).
#[derive(Clone, Debug)]
pub struct AgentRunResult<T> {
    pub task: AgentRunTask<T>,
    pub agent_id: Option<String>,
    pub status: AgentRunStatus,
    pub state: Option<AgentRunState>,
    pub result: Option<String>,
    pub usage: Option<TokenUsage>,
    pub error: Option<String>,
}

/// Successful completion payload of an agent run (v2
/// `AgentRunAttemptHandle.completion`).
#[derive(Clone, Debug)]
pub struct AgentRunCompletion {
    pub result: String,
    pub usage: Option<TokenUsage>,
}

/// Error from an agent run completion. `is_rate_limit` mirrors the v2
/// `isProviderRateLimitError` classification: rate-limited completions are
/// requeued with backoff instead of failing the task.
#[derive(Clone, Debug)]
pub struct AgentRunError {
    pub message: String,
    pub is_rate_limit: bool,
}

/// Handle returned by the launcher for one attempt (v2 `AgentRunAttemptHandle`).
pub struct AgentRunAttemptHandle {
    pub agent_id: String,
    pub completion: BoxFuture<'static, Result<AgentRunCompletion, AgentRunError>>,
}

/// Options passed to every launcher attempt (v2 `AgentRunAttemptOptions`).
pub struct AgentRunAttemptOptions {
    pub parent_tool_call_id: String,
    pub parent_tool_call_uuid: Option<String>,
    pub prompt: String,
    pub description: String,
    pub swarm_index: Option<usize>,
    pub run_in_background: bool,
    pub signal: AbortSignal,
    pub on_ready: Option<Arc<dyn Fn() + Send + Sync>>,
    pub suppress_rate_limit_failure_event: bool,
}

/// Spawn plan (v2 `SubagentSpawnPlan`).
#[derive(Clone, Debug)]
pub struct SubagentSpawnPlan {
    pub profile_name: String,
    pub model: String,
    pub thinking: Option<String>,
    pub fork: bool,
}

/// Options for a spawn attempt (v2 `AgentSpawnAttemptOptions`).
pub struct AgentSpawnAttemptOptions {
    pub profile_name: String,
    pub swarm_item: Option<String>,
    pub plan: SubagentSpawnPlan,
    pub run: AgentRunAttemptOptions,
}

/// Event delivered to the launcher when a rate-limited attempt is requeued
/// (v2 `AgentRunSuspendedEvent`).
#[derive(Clone, Debug)]
pub struct AgentRunSuspendedEvent<T> {
    pub task: AgentRunTask<T>,
    pub agent_id: String,
    pub reason: String,
}

/// Host contract for running one agent attempt (v2 `AgentRunBatchLauncher`).
///
/// `spawn`/`resume`/`retry` start an attempt and return a handle whose
/// `completion` resolves when the agent finishes. Implementations must honor
/// `options.signal`: when it aborts (batch cancellation, task cancellation,
/// or timeout), the in-flight call and the completion must resolve with an
/// error. `suspended` is invoked when a rate-limited attempt is requeued.
pub trait AgentRunBatchLauncher<T>: Send + Sync {
    fn spawn(
        &self,
        options: AgentSpawnAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>>;
    fn resume(
        &self,
        agent_id: String,
        options: AgentRunAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>>;
    fn retry(
        &self,
        agent_id: String,
        options: AgentRunAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>>;
    fn suspended(&self, _event: AgentRunSuspendedEvent<T>) {}
}

/// Timing knobs for the batch scheduler. Defaults mirror the v2 constants;
/// tests override them with short durations.
#[derive(Clone, Copy, Debug)]
pub struct AgentRunBatchTiming {
    pub initial_launch_limit: usize,
    pub initial_launch_interval: Duration,
    pub rate_limit_retry_base: Duration,
    pub rate_limit_retry_factor: u32,
    pub rate_limit_capacity_shrink_interval: Duration,
    pub rate_limit_capacity_recovery_interval: Duration,
}

impl Default for AgentRunBatchTiming {
    fn default() -> Self {
        Self {
            initial_launch_limit: INITIAL_LAUNCH_LIMIT,
            initial_launch_interval: INITIAL_LAUNCH_INTERVAL,
            rate_limit_retry_base: RATE_LIMIT_RETRY_BASE,
            rate_limit_retry_factor: RATE_LIMIT_RETRY_FACTOR,
            rate_limit_capacity_shrink_interval: RATE_LIMIT_CAPACITY_SHRINK_INTERVAL,
            rate_limit_capacity_recovery_interval: RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL,
        }
    }
}

/// Batch options (v2 `AgentRunBatchOptions`; `timing` is a Rust-side
/// testability extension).
#[derive(Clone, Copy, Debug, Default)]
pub struct AgentRunBatchOptions {
    pub max_concurrency: Option<usize>,
    pub timing: AgentRunBatchTiming,
}

struct TaskState<T> {
    index: usize,
    task: AgentRunTask<T>,
    agent_id: Option<String>,
    retry_agent_id: Option<String>,
    retry_count: usize,
    /// Earliest time this task may be relaunched (None = immediately).
    retry_ready_at: Option<Instant>,
    started: bool,
}

struct ActiveAttempt {
    ready: bool,
    signal: AbortSignal,
}

#[allow(clippy::large_enum_variant)]
enum AttemptOutcome<T> {
    Result(AgentRunResult<T>),
    RateLimited { agent_id: String, error: String },
}

#[allow(clippy::large_enum_variant)]
enum BatchEvent<T> {
    Ready(usize),
    Spawned(usize, String),
    Done(usize, AttemptOutcome<T>),
}

#[allow(clippy::large_enum_variant)]
enum LoopAction<T> {
    TimerFired,
    Event(BatchEvent<T>),
    ChannelClosed,
    BatchAborted,
}

/// Batch scheduler (v2 `AgentRunBatch`). Create with [`AgentRunBatch::new`]
/// and drive to completion with [`AgentRunBatch::run`].
pub struct AgentRunBatch<T> {
    launcher: Arc<dyn AgentRunBatchLauncher<T>>,
    timing: AgentRunBatchTiming,
    states: Vec<TaskState<T>>,
    pending: Vec<usize>,
    results: Vec<Option<AgentRunResult<T>>>,
    active: HashMap<usize, ActiveAttempt>,
    batch_signal: Option<AbortSignal>,
    max_concurrency: Option<usize>,
    tx: Option<mpsc::UnboundedSender<BatchEvent<T>>>,
    normal_launch_count: usize,
    rate_limit_mode: bool,
    started_success_count: usize,
    rate_limit_capacity: usize,
    last_rate_limit_at: Option<Instant>,
    last_capacity_shrink_at: Option<Instant>,
    last_capacity_recovery_at: Option<Instant>,
    global_retry_interval: Duration,
    next_rate_limit_launch_at: Option<Instant>,
    finished: bool,
}

impl<T: Clone + Send + Sync + 'static> AgentRunBatch<T> {
    pub fn new(
        launcher: Arc<dyn AgentRunBatchLauncher<T>>,
        tasks: Vec<AgentRunTask<T>>,
        options: AgentRunBatchOptions,
    ) -> Self {
        let states: Vec<TaskState<T>> = tasks
            .into_iter()
            .enumerate()
            .map(|(index, task)| TaskState {
                index,
                task,
                agent_id: None,
                retry_agent_id: None,
                retry_count: 0,
                retry_ready_at: None,
                started: false,
            })
            .collect();
        let batch_signal = states
            .iter()
            .find(|state| state.task.signal.is_some())
            .and_then(|state| state.task.signal.clone());
        let pending = (0..states.len()).collect();
        let results = vec![None; states.len()];
        Self {
            launcher,
            timing: options.timing,
            states,
            pending,
            results,
            active: HashMap::new(),
            batch_signal,
            max_concurrency: options.max_concurrency,
            tx: None,
            normal_launch_count: 0,
            rate_limit_mode: false,
            started_success_count: 0,
            rate_limit_capacity: 1,
            last_rate_limit_at: None,
            last_capacity_shrink_at: None,
            last_capacity_recovery_at: None,
            global_retry_interval: options.timing.rate_limit_retry_base,
            next_rate_limit_launch_at: None,
            finished: false,
        }
    }

    /// Runs the batch to completion and returns per-task results.
    ///
    /// User cancellation (the batch signal aborted with
    /// [`AbortReason::UserCancellation`]) resolves with every unfinished task
    /// marked `aborted`; any other abort rejects with the abort message.
    pub async fn run(mut self) -> Result<Vec<AgentRunResult<T>>, String> {
        if self.states.is_empty() {
            self.finished = true;
            return Ok(Vec::new());
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<BatchEvent<T>>();
        self.tx = Some(tx);

        let mut normal_deadline: Option<Instant> = None;
        loop {
            if self.finished {
                break;
            }
            if self.finish_if_complete() {
                break;
            }
            if self
                .batch_signal
                .as_ref()
                .is_some_and(|signal| signal.is_aborted())
            {
                let reason = self
                    .batch_signal
                    .as_ref()
                    .and_then(|signal| signal.reason());
                // v2 aborts every attempt controller from the batch abort
                // listener before any completion microtask can run; the
                // driver owns that propagation so the abort always wins over
                // in-flight attempt events.
                for attempt in self.active.values() {
                    attempt.signal.abort(reason.clone());
                }
                if is_user_cancellation(&reason) {
                    return Ok(self.finish_with_user_cancellation());
                }
                return Err(match reason {
                    Some(AbortReason::Other(message)) => message,
                    _ => "Aborted".to_string(),
                });
            }

            if self.rate_limit_mode {
                normal_deadline = None;
                self.schedule_rate_limit_launch();
                let wakeup = self.next_rate_limit_wakeup();
                match self.wait_for_event(&mut rx, wakeup).await {
                    LoopAction::TimerFired => {}
                    LoopAction::Event(event) => self.handle_event_or_abort(event),
                    LoopAction::ChannelClosed => {
                        return Err("AgentRunBatch event channel closed unexpectedly".to_string());
                    }
                    LoopAction::BatchAborted => {}
                }
            } else {
                self.schedule_normal_launch();
                if self.pending.is_empty() || self.is_at_concurrency_limit() {
                    normal_deadline = None;
                    match self.wait_for_event(&mut rx, None).await {
                        LoopAction::TimerFired => {}
                        LoopAction::Event(event) => self.handle_event_or_abort(event),
                        LoopAction::ChannelClosed => {
                            return Err(
                                "AgentRunBatch event channel closed unexpectedly".to_string()
                            );
                        }
                        LoopAction::BatchAborted => {}
                    }
                } else {
                    let deadline = *normal_deadline.get_or_insert_with(|| {
                        Instant::now() + self.timing.initial_launch_interval
                    });
                    match self.wait_for_event(&mut rx, Some(deadline)).await {
                        LoopAction::TimerFired => {
                            normal_deadline = None;
                            self.launch_one_normal();
                        }
                        LoopAction::Event(event) => self.handle_event_or_abort(event),
                        LoopAction::ChannelClosed => {
                            return Err(
                                "AgentRunBatch event channel closed unexpectedly".to_string()
                            );
                        }
                        LoopAction::BatchAborted => {}
                    }
                }
            }
        }

        Ok(self
            .results
            .into_iter()
            .map(|result| result.expect("batch finished with incomplete results"))
            .collect())
    }

    async fn wait_for_event(
        &mut self,
        rx: &mut mpsc::UnboundedReceiver<BatchEvent<T>>,
        wakeup: Option<Instant>,
    ) -> LoopAction<T> {
        let batch_wait: Pin<Box<dyn Future<Output = ()> + Send + '_>> = match &self.batch_signal {
            Some(signal) => Box::pin(signal.wait()),
            None => Box::pin(futures_util::future::pending()),
        };
        match wakeup {
            Some(at) => tokio::select! {
                _ = sleep(at.saturating_duration_since(Instant::now())) => LoopAction::TimerFired,
                event = rx.recv() => match event {
                    Some(event) => LoopAction::Event(event),
                    None => LoopAction::ChannelClosed,
                },
                _ = batch_wait => LoopAction::BatchAborted,
            },
            None => tokio::select! {
                event = rx.recv() => match event {
                    Some(event) => LoopAction::Event(event),
                    None => LoopAction::ChannelClosed,
                },
                _ = batch_wait => LoopAction::BatchAborted,
            },
        }
    }

    fn handle_event_or_abort(&mut self, event: BatchEvent<T>) {
        // v2 fires the batch abort listener before any attempt reaction to
        // the same signal, so a batch abort always wins over attempt events.
        if self
            .batch_signal
            .as_ref()
            .is_some_and(|signal| signal.is_aborted())
        {
            return;
        }
        self.handle_event(event);
    }

    fn handle_event(&mut self, event: BatchEvent<T>) {
        match event {
            BatchEvent::Ready(state_index) => self.mark_attempt_ready(state_index),
            BatchEvent::Spawned(state_index, agent_id) => {
                if let Some(state) = self.states.get_mut(state_index) {
                    state.agent_id = Some(agent_id);
                }
            }
            BatchEvent::Done(state_index, outcome) => {
                self.handle_attempt_outcome(state_index, outcome)
            }
        }
    }

    fn schedule_normal_launch(&mut self) {
        while self.normal_launch_count < self.timing.initial_launch_limit
            && !self.pending.is_empty()
            && !self.rate_limit_mode
            && !self.is_at_concurrency_limit()
        {
            let state_index = self.pending.remove(0);
            self.start_attempt(state_index);
            self.normal_launch_count += 1;
        }
    }

    fn launch_one_normal(&mut self) {
        if self.finished || self.rate_limit_mode || self.pending.is_empty() {
            return;
        }
        if self.is_at_concurrency_limit() {
            return;
        }
        let state_index = self.pending.remove(0);
        self.start_attempt(state_index);
        self.normal_launch_count += 1;
    }

    fn is_at_concurrency_limit(&self) -> bool {
        self.max_concurrency
            .is_some_and(|limit| self.active.len() >= limit)
    }

    fn schedule_rate_limit_launch(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let now = Instant::now();
        self.recover_rate_limit_capacity(now);
        if self.active.len() >= self.rate_limit_capacity {
            return;
        }
        let next_allowed = max_opt(self.next_rate_limit_launch_at, self.next_pending_ready_at());
        let next_wakeup = min_opt(next_allowed, self.next_rate_limit_capacity_recovery_at());
        if next_wakeup.is_some_and(|at| at > now) {
            return;
        }
        let pending_index = self
            .pending
            .iter()
            .position(|&index| self.states[index].retry_ready_at.is_none_or(|at| at <= now));
        let Some(pending_index) = pending_index else {
            return;
        };
        let state_index = self.pending.remove(pending_index);
        self.start_attempt(state_index);
        self.next_rate_limit_launch_at = Some(now + self.global_retry_interval);
    }

    fn next_rate_limit_wakeup(&self) -> Option<Instant> {
        if self.pending.is_empty() {
            return None;
        }
        let recovery = self.next_rate_limit_capacity_recovery_at();
        if self.active.len() >= self.rate_limit_capacity {
            return recovery;
        }
        let allowed = max_opt(self.next_rate_limit_launch_at, self.next_pending_ready_at());
        min_opt(allowed, recovery)
    }

    fn start_attempt(&mut self, state_index: usize) {
        if self.finished
            || self
                .batch_signal
                .as_ref()
                .is_some_and(|signal| signal.is_aborted())
        {
            return;
        }
        let task = self.states[state_index].task.clone();
        let retry_agent_id = self.states[state_index].retry_agent_id.clone();
        let initial_agent_id = self.states[state_index].agent_id.clone();

        let attempt_signal = AbortSignal::new();
        self.active.insert(
            state_index,
            ActiveAttempt {
                ready: false,
                signal: attempt_signal.clone(),
            },
        );

        let launcher = self.launcher.clone();
        let tx = self
            .tx
            .clone()
            .expect("AgentRunBatch.run() must be called before attempts start");
        tokio::spawn(async move {
            let outcome = run_attempt(
                launcher.as_ref(),
                tx.clone(),
                state_index,
                task,
                retry_agent_id,
                initial_agent_id,
                attempt_signal,
            )
            .await;
            let _ = tx.send(BatchEvent::Done(state_index, outcome));
        });
    }

    fn mark_attempt_ready(&mut self, state_index: usize) {
        if self.finished {
            return;
        }
        let Some(attempt) = self.active.get_mut(&state_index) else {
            return;
        };
        if attempt.ready {
            return;
        }
        attempt.ready = true;
        self.states[state_index].started = true;
        if !self.rate_limit_mode {
            self.started_success_count += 1;
        }
        if self.rate_limit_mode {
            self.global_retry_interval = self.timing.rate_limit_retry_base;
            self.next_rate_limit_launch_at = Some(Instant::now() + self.global_retry_interval);
        }
    }

    fn handle_attempt_outcome(&mut self, state_index: usize, outcome: AttemptOutcome<T>) {
        let Some(attempt) = self.active.remove(&state_index) else {
            return;
        };
        if self.finished {
            return;
        }
        match outcome {
            AttemptOutcome::Result(result) => {
                self.results[state_index] = Some(result);
            }
            AttemptOutcome::RateLimited { agent_id, error } => {
                if self.is_only_unfinished_task(state_index) {
                    self.results[state_index] = Some(AgentRunResult {
                        task: self.states[state_index].task.clone(),
                        agent_id: Some(agent_id),
                        status: AgentRunStatus::Failed,
                        state: Some(AgentRunState::Started),
                        result: None,
                        usage: None,
                        error: Some(error),
                    });
                } else {
                    self.requeue_rate_limited(state_index, agent_id, attempt.ready);
                }
            }
        }
    }

    fn requeue_rate_limited(&mut self, state_index: usize, agent_id: String, attempt_ready: bool) {
        let state = &mut self.states[state_index];
        state.agent_id = Some(agent_id.clone());
        state.retry_agent_id = Some(agent_id.clone());
        self.launcher.suspended(AgentRunSuspendedEvent {
            task: state.task.clone(),
            agent_id,
            reason: RATE_LIMIT_SUSPENDED_REASON.to_string(),
        });

        let now = Instant::now();
        self.last_rate_limit_at = Some(now);
        state.retry_count += 1;
        let retry_delay = rate_limit_retry_delay(state.retry_count, self.timing);
        state.retry_ready_at = Some(now + retry_delay);
        self.pending.insert(0, state_index);
        self.enter_rate_limit_mode(now);

        if !attempt_ready {
            self.global_retry_interval = self
                .global_retry_interval
                .saturating_mul(self.timing.rate_limit_retry_factor.max(1));
            self.global_retry_interval = self.global_retry_interval.max(retry_delay);
            let candidate = now + self.global_retry_interval;
            self.next_rate_limit_launch_at = Some(match self.next_rate_limit_launch_at {
                Some(existing) => existing.max(candidate),
                None => candidate,
            });
        } else {
            let candidate = now + self.timing.rate_limit_retry_base;
            self.next_rate_limit_launch_at = Some(match self.next_rate_limit_launch_at {
                Some(existing) => existing.max(candidate),
                None => candidate,
            });
        }
    }

    fn enter_rate_limit_mode(&mut self, now: Instant) {
        if !self.rate_limit_mode {
            self.rate_limit_mode = true;
            self.rate_limit_capacity = self.started_success_count.max(1);
            let candidate = now + self.timing.rate_limit_retry_base;
            self.next_rate_limit_launch_at = Some(match self.next_rate_limit_launch_at {
                Some(existing) => existing.max(candidate),
                None => candidate,
            });
            self.shrink_rate_limit_capacity(now, true);
            return;
        }
        self.shrink_rate_limit_capacity(now, false);
    }

    fn shrink_rate_limit_capacity(&mut self, now: Instant, force: bool) {
        if !force
            && self.last_capacity_shrink_at.is_some_and(|at| {
                now.duration_since(at) < self.timing.rate_limit_capacity_shrink_interval
            })
        {
            return;
        }
        self.rate_limit_capacity = self.rate_limit_capacity.saturating_sub(1).max(1);
        self.last_capacity_shrink_at = Some(now);
    }

    fn recover_rate_limit_capacity(&mut self, now: Instant) {
        let next_recovery = self.next_rate_limit_capacity_recovery_at();
        if next_recovery.is_some_and(|at| at > now) {
            return;
        }
        self.rate_limit_capacity += 1;
        self.last_capacity_recovery_at = Some(now);
        self.next_rate_limit_launch_at = self.next_rate_limit_launch_at.map(|at| at.min(now));
    }

    fn next_rate_limit_capacity_recovery_at(&self) -> Option<Instant> {
        if self.pending.is_empty() || self.last_rate_limit_at.is_none() {
            return None;
        }
        let latest = max_opt(self.last_rate_limit_at, self.last_capacity_recovery_at)
            .expect("last_rate_limit_at is Some here");
        Some(latest + self.timing.rate_limit_capacity_recovery_interval)
    }

    fn next_pending_ready_at(&self) -> Option<Instant> {
        self.pending.iter().fold(None, |next, &index| {
            min_opt(next, self.states[index].retry_ready_at)
        })
    }

    fn finish_if_complete(&mut self) -> bool {
        if self.results.iter().all(Option::is_some) {
            self.finished = true;
            true
        } else {
            false
        }
    }

    fn is_only_unfinished_task(&self, state_index: usize) -> bool {
        self.results
            .iter()
            .enumerate()
            .all(|(index, result)| index == state_index || result.is_some())
    }

    fn finish_with_user_cancellation(&mut self) -> Vec<AgentRunResult<T>> {
        self.finished = true;
        self.states
            .iter()
            .map(|state| {
                if let Some(result) = &self.results[state.index] {
                    return result.clone();
                }
                if state.started || state.agent_id.is_some() {
                    AgentRunResult {
                        task: state.task.clone(),
                        agent_id: state.agent_id.clone(),
                        status: AgentRunStatus::Aborted,
                        state: Some(AgentRunState::Started),
                        result: None,
                        usage: None,
                        error: Some(
                            "The user manually interrupted this subagent batch before this subagent finished."
                                .to_string(),
                        ),
                    }
                } else {
                    AgentRunResult {
                        task: state.task.clone(),
                        agent_id: None,
                        status: AgentRunStatus::Aborted,
                        state: Some(AgentRunState::NotStarted),
                        result: None,
                        usage: None,
                        error: Some(
                            "The user manually interrupted this subagent batch before this subagent was started."
                                .to_string(),
                        ),
                    }
                }
            })
            .collect()
    }
}

/// v2 `retry.createTimeout(max(0, retryCount - 1), { minTimeout: base, factor,
/// randomize: false })` → `base * factor^(retryCount - 1)`.
fn rate_limit_retry_delay(retry_count: usize, timing: AgentRunBatchTiming) -> Duration {
    let exponent = retry_count.saturating_sub(1).min(62) as u32;
    let multiplier = (timing.rate_limit_retry_factor.max(1) as u64).saturating_pow(exponent);
    timing
        .rate_limit_retry_base
        .saturating_mul(u32::try_from(multiplier).unwrap_or(u32::MAX))
}

/// `max` over instants where `None` means "the epoch" (v2 `Math.max` with 0).
fn max_opt(a: Option<Instant>, b: Option<Instant>) -> Option<Instant> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// `min` over instants where `None` means "infinity" (v2 `Math.min` with
/// `Number.POSITIVE_INFINITY`).
fn min_opt(a: Option<Instant>, b: Option<Instant>) -> Option<Instant> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn is_user_cancellation(reason: &Option<AbortReason>) -> bool {
    matches!(reason, Some(AbortReason::UserCancellation))
}

/// Runs one attempt: launcher call (spawn/resume/retry) then completion,
/// watching the task signal and the per-task timeout. Batch-level cancellation
/// is propagated by the driver aborting the attempt signal.
async fn run_attempt<T: Clone + Send + Sync + 'static>(
    launcher: &dyn AgentRunBatchLauncher<T>,
    tx: mpsc::UnboundedSender<BatchEvent<T>>,
    state_index: usize,
    task: AgentRunTask<T>,
    retry_agent_id: Option<String>,
    mut agent_id: Option<String>,
    attempt_signal: AbortSignal,
) -> AttemptOutcome<T> {
    let timed_out = Arc::new(AtomicBool::new(false));

    // v2 `attempt.controller.signal.throwIfAborted()`.
    if attempt_signal.is_aborted() {
        return failed_outcome(
            &task,
            agent_id,
            &attempt_signal,
            &timed_out,
            attempt_signal.reason().map(|reason| reason.to_string()),
        );
    }

    // The timeout clock starts at attempt start (v2 `linkAttemptSignals`).
    let mut timeout_sleep: Pin<Box<dyn Future<Output = ()> + Send>> = match task.timeout {
        Some(timeout) if timeout > Duration::ZERO => Box::pin(sleep(timeout)),
        _ => Box::pin(futures_util::future::pending()),
    };

    let ready_tx = tx.clone();
    let run_options = AgentRunAttemptOptions {
        parent_tool_call_id: task.parent_tool_call_id.clone(),
        parent_tool_call_uuid: task.parent_tool_call_uuid.clone(),
        prompt: task.prompt.clone(),
        description: task.description.clone(),
        swarm_index: task.swarm_index,
        run_in_background: task.run_in_background,
        signal: attempt_signal.clone(),
        on_ready: Some(Arc::new(move || {
            let _ = ready_tx.send(BatchEvent::Ready(state_index));
        })),
        suppress_rate_limit_failure_event: true,
    };

    let handle = {
        let mut call = Box::pin(async {
            match retry_agent_id {
                Some(agent_id) => launcher.retry(agent_id, run_options).await,
                None => match &task.kind {
                    AgentRunTaskKind::Resume { resume_agent_id } => {
                        launcher.resume(resume_agent_id.clone(), run_options).await
                    }
                    AgentRunTaskKind::Spawn => {
                        let spawn_options = AgentSpawnAttemptOptions {
                            profile_name: task.profile_name.clone(),
                            swarm_item: task.swarm_item.clone(),
                            plan: task.plan.clone().expect("spawn tasks carry a spawn plan"),
                            run: run_options,
                        };
                        launcher.spawn(spawn_options).await
                    }
                },
            }
        });
        let task_signal = task.signal.clone();
        let mut task_signal_wait: Pin<Box<dyn Future<Output = ()> + Send + '_>> = match &task_signal
        {
            Some(signal) => Box::pin(signal.wait()),
            None => Box::pin(futures_util::future::pending()),
        };
        let mut timed_out_fired = false;
        loop {
            tokio::select! {
                result = &mut call => break result,
                _ = &mut task_signal_wait => {
                    attempt_signal.abort(task_signal.as_ref().and_then(|s| s.reason()));
                }
                _ = &mut timeout_sleep, if !timed_out_fired => {
                    timed_out_fired = true;
                    timed_out.store(true, Ordering::SeqCst);
                    attempt_signal.abort(Some(AbortReason::Other("Aborted".to_string())));
                }
            }
        }
    };

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            return failed_outcome(&task, agent_id, &attempt_signal, &timed_out, Some(error));
        }
    };

    agent_id = Some(handle.agent_id.clone());
    let _ = tx.send(BatchEvent::Spawned(state_index, handle.agent_id.clone()));

    let mut completion = Box::pin(handle.completion);
    let task_signal = task.signal.clone();
    let mut task_signal_wait: Pin<Box<dyn Future<Output = ()> + Send + '_>> = match &task_signal {
        Some(signal) => Box::pin(signal.wait()),
        None => Box::pin(futures_util::future::pending()),
    };
    let mut timed_out_fired = false;
    let completion_result = loop {
        tokio::select! {
            result = &mut completion => break result,
            _ = &mut task_signal_wait => {
                attempt_signal.abort(task_signal.as_ref().and_then(|s| s.reason()));
            }
            _ = &mut timeout_sleep, if !timed_out_fired => {
                timed_out_fired = true;
                timed_out.store(true, Ordering::SeqCst);
                attempt_signal.abort(Some(AbortReason::Other("Aborted".to_string())));
            }
        }
    };

    match completion_result {
        Ok(completion) => AttemptOutcome::Result(AgentRunResult {
            task,
            agent_id,
            status: AgentRunStatus::Completed,
            state: None,
            result: Some(completion.result),
            usage: completion.usage,
            error: None,
        }),
        Err(error) => {
            if error.is_rate_limit {
                AttemptOutcome::RateLimited {
                    agent_id: agent_id.unwrap_or_default(),
                    error: attempt_error_message(
                        &timed_out,
                        &task,
                        AgentRunStatus::Failed,
                        Some(error.message),
                    ),
                }
            } else {
                failed_outcome(
                    &task,
                    agent_id,
                    &attempt_signal,
                    &timed_out,
                    Some(error.message),
                )
            }
        }
    }
}

/// v2 `failedAttemptOutcome`: status is `aborted` only when the attempt signal
/// was aborted with a user cancellation; the state reflects whether an agent
/// id was known.
fn failed_outcome<T: Clone>(
    task: &AgentRunTask<T>,
    agent_id: Option<String>,
    attempt_signal: &AbortSignal,
    timed_out: &AtomicBool,
    error: Option<String>,
) -> AttemptOutcome<T> {
    let status = if attempt_signal.is_aborted()
        && matches!(attempt_signal.reason(), Some(AbortReason::UserCancellation))
    {
        AgentRunStatus::Aborted
    } else {
        AgentRunStatus::Failed
    };
    let state = if agent_id.is_some() {
        Some(AgentRunState::Started)
    } else {
        Some(AgentRunState::NotStarted)
    };
    AttemptOutcome::Result(AgentRunResult {
        task: task.clone(),
        agent_id,
        status,
        state,
        result: None,
        usage: None,
        error: Some(attempt_error_message(timed_out, task, status, error)),
    })
}

/// v2 `attemptErrorMessage`: a timed-out attempt reports the timeout message,
/// an aborted attempt reports the user-interruption message, otherwise the
/// underlying error message.
fn attempt_error_message<T>(
    timed_out: &AtomicBool,
    task: &AgentRunTask<T>,
    status: AgentRunStatus,
    error: Option<String>,
) -> String {
    if timed_out.load(Ordering::SeqCst) && task.timeout.is_some() {
        return "Subagent timed out.".to_string();
    }
    if status == AgentRunStatus::Aborted {
        return "The user manually interrupted this subagent batch.".to_string();
    }
    error.unwrap_or_else(|| "Unknown error".to_string())
}

/// Parses `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (v2 `resolveSwarmMaxConcurrency`).
/// Missing or blank values yield `None`; non-positive-integer values error.
pub fn resolve_swarm_max_concurrency(
    env: &HashMap<String, String>,
) -> Result<Option<usize>, String> {
    let Some(raw) = env.get(AGENT_SWARM_MAX_CONCURRENCY_ENV) else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match trimmed.parse::<usize>() {
        Ok(value) if value > 0 => Ok(Some(value)),
        _ => Err(format!(
            "{} must be a positive integer, got {:?}.",
            AGENT_SWARM_MAX_CONCURRENCY_ENV, raw
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn timing() -> AgentRunBatchTiming {
        AgentRunBatchTiming {
            initial_launch_limit: 5,
            initial_launch_interval: Duration::from_millis(20),
            rate_limit_retry_base: Duration::from_millis(30),
            rate_limit_retry_factor: 2,
            rate_limit_capacity_shrink_interval: Duration::from_millis(20),
            rate_limit_capacity_recovery_interval: Duration::from_millis(150),
        }
    }

    fn task(
        index: usize,
        timeout: Option<Duration>,
        signal: Option<AbortSignal>,
    ) -> AgentRunTask<()> {
        AgentRunTask {
            data: (),
            kind: AgentRunTaskKind::Spawn,
            profile_name: "research".into(),
            parent_tool_call_id: format!("call-{index}"),
            parent_tool_call_uuid: None,
            prompt: format!("prompt-{index}"),
            description: format!("desc-{index}"),
            swarm_index: None,
            swarm_item: None,
            run_in_background: false,
            timeout,
            signal,
            plan: Some(SubagentSpawnPlan {
                profile_name: "research".into(),
                model: "kimi".into(),
                thinking: None,
                fork: false,
            }),
        }
    }

    /// Mock launcher: records spawn/retry/resume counts, peak concurrency,
    /// spawn/completion timestamps, retry inputs and suspended events. The
    /// first `rate_limit_first` completions fail with a rate-limit error;
    /// later ones succeed. The completion honors the attempt signal, so
    /// batch/task aborts and timeouts resolve it with an error.
    #[derive(Clone)]
    struct MockLauncher {
        spawn_delay: Duration,
        ready_delay: Duration,
        completion_delay: Duration,
        rate_limit_first: usize,
        fail_spawn: bool,
        next_agent_id: Arc<AtomicUsize>,
        spawn_count: Arc<AtomicUsize>,
        retry_count: Arc<AtomicUsize>,
        resume_count: Arc<AtomicUsize>,
        completion_count: Arc<AtomicUsize>,
        concurrency: Arc<AtomicUsize>,
        max_concurrency: Arc<AtomicUsize>,
        retry_inputs: Arc<Mutex<Vec<String>>>,
        suspended_events: Arc<Mutex<Vec<AgentRunSuspendedEvent<()>>>>,
        spawn_times: Arc<Mutex<Vec<(String, Instant)>>>,
        completion_times: Arc<Mutex<Vec<(String, Instant)>>>,
    }

    impl MockLauncher {
        fn new() -> Self {
            Self {
                spawn_delay: Duration::ZERO,
                ready_delay: Duration::ZERO,
                completion_delay: Duration::ZERO,
                rate_limit_first: 0,
                fail_spawn: false,
                next_agent_id: Arc::new(AtomicUsize::new(0)),
                spawn_count: Arc::new(AtomicUsize::new(0)),
                retry_count: Arc::new(AtomicUsize::new(0)),
                resume_count: Arc::new(AtomicUsize::new(0)),
                completion_count: Arc::new(AtomicUsize::new(0)),
                concurrency: Arc::new(AtomicUsize::new(0)),
                max_concurrency: Arc::new(AtomicUsize::new(0)),
                retry_inputs: Arc::new(Mutex::new(Vec::new())),
                suspended_events: Arc::new(Mutex::new(Vec::new())),
                spawn_times: Arc::new(Mutex::new(Vec::new())),
                completion_times: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn attempt(
            &self,
            agent_id: String,
            options: AgentRunAttemptOptions,
        ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
            let this = self.clone();
            Box::pin(async move {
                let current = this.concurrency.fetch_add(1, Ordering::SeqCst) + 1;
                this.max_concurrency.fetch_max(current, Ordering::SeqCst);
                if this.spawn_delay > Duration::ZERO {
                    tokio::select! {
                        _ = sleep(this.spawn_delay) => {}
                        _ = options.signal.wait() => {
                            this.concurrency.fetch_sub(1, Ordering::SeqCst);
                            return Err("Aborted".into());
                        }
                    }
                }
                if let Some(on_ready) = &options.on_ready {
                    if this.ready_delay > Duration::ZERO {
                        tokio::select! {
                            _ = sleep(this.ready_delay) => {}
                            _ = options.signal.wait() => {
                                this.concurrency.fetch_sub(1, Ordering::SeqCst);
                                return Err("Aborted".into());
                            }
                        }
                    }
                    on_ready();
                }
                this.spawn_times
                    .lock()
                    .unwrap()
                    .push((agent_id.clone(), Instant::now()));
                let signal = options.signal.clone();
                let completion_delay = this.completion_delay;
                let rate_limit_first = this.rate_limit_first;
                let completion_count = this.completion_count.clone();
                let concurrency = this.concurrency.clone();
                let completion_times = this.completion_times.clone();
                let completion_agent_id = agent_id.clone();
                let completion = Box::pin(async move {
                    tokio::select! {
                        _ = sleep(completion_delay) => {}
                        _ = signal.wait() => {}
                    }
                    concurrency.fetch_sub(1, Ordering::SeqCst);
                    completion_times
                        .lock()
                        .unwrap()
                        .push((completion_agent_id.clone(), Instant::now()));
                    if signal.is_aborted() {
                        return Err(AgentRunError {
                            message: "Aborted".into(),
                            is_rate_limit: false,
                        });
                    }
                    let n = completion_count.fetch_add(1, Ordering::SeqCst);
                    if n < rate_limit_first {
                        return Err(AgentRunError {
                            message: "429 rate limited".into(),
                            is_rate_limit: true,
                        });
                    }
                    Ok(AgentRunCompletion {
                        result: format!("result-{completion_agent_id}"),
                        usage: None,
                    })
                });
                Ok(AgentRunAttemptHandle {
                    agent_id,
                    completion,
                })
            })
        }
    }

    impl AgentRunBatchLauncher<()> for MockLauncher {
        fn spawn(
            &self,
            options: AgentSpawnAttemptOptions,
        ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
            let this = self.clone();
            Box::pin(async move {
                if this.fail_spawn {
                    return Err("spawn failed".into());
                }
                this.spawn_count.fetch_add(1, Ordering::SeqCst);
                let agent_id = format!(
                    "agent-{}",
                    this.next_agent_id.fetch_add(1, Ordering::SeqCst)
                );
                this.attempt(agent_id, options.run).await
            })
        }

        fn resume(
            &self,
            agent_id: String,
            options: AgentRunAttemptOptions,
        ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
            let this = self.clone();
            Box::pin(async move {
                this.resume_count.fetch_add(1, Ordering::SeqCst);
                this.attempt(agent_id, options).await
            })
        }

        fn retry(
            &self,
            agent_id: String,
            options: AgentRunAttemptOptions,
        ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
            let this = self.clone();
            Box::pin(async move {
                this.retry_count.fetch_add(1, Ordering::SeqCst);
                this.retry_inputs.lock().unwrap().push(agent_id.clone());
                let new_id = format!(
                    "agent-{}",
                    this.next_agent_id.fetch_add(1, Ordering::SeqCst)
                );
                this.attempt(new_id, options).await
            })
        }

        fn suspended(&self, event: AgentRunSuspendedEvent<()>) {
            self.suspended_events.lock().unwrap().push(event);
        }
    }

    #[tokio::test]
    async fn test_concurrency_limit() {
        let mut launcher = MockLauncher::new();
        launcher.completion_delay = Duration::from_millis(30);
        let tasks: Vec<AgentRunTask<()>> = (0..6).map(|i| task(i, None, None)).collect();
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: Some(2),
                timing: timing(),
            },
        );
        let results = batch.run().await.unwrap();
        assert_eq!(results.len(), 6);
        for result in &results {
            assert_eq!(result.status, AgentRunStatus::Completed);
            assert!(result.result.is_some());
        }
        assert_eq!(launcher.spawn_count.load(Ordering::SeqCst), 6);
        assert_eq!(launcher.max_concurrency.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_rate_limit_backoff_and_retry() {
        let mut launcher = MockLauncher::new();
        launcher.rate_limit_first = 2;
        let tasks = vec![task(0, None, None), task(1, None, None)];
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let results = batch.run().await.unwrap();
        assert_eq!(results.len(), 2);
        for result in &results {
            assert_eq!(result.status, AgentRunStatus::Completed);
        }
        assert_eq!(launcher.spawn_count.load(Ordering::SeqCst), 2);
        assert_eq!(launcher.retry_count.load(Ordering::SeqCst), 2);
        let mut retry_inputs = launcher.retry_inputs.lock().unwrap().clone();
        retry_inputs.sort();
        assert_eq!(
            retry_inputs,
            vec!["agent-0".to_string(), "agent-1".to_string()]
        );
        let suspended = launcher.suspended_events.lock().unwrap().clone();
        assert_eq!(suspended.len(), 2);
        assert!(
            suspended
                .iter()
                .all(|event| event.reason.contains("rate limit"))
        );
    }

    #[tokio::test]
    async fn test_rate_limit_last_unfinished_task_fails() {
        // v2 semantics: when a rate-limited attempt is the only unfinished
        // task, it is failed instead of requeued.
        let mut launcher = MockLauncher::new();
        launcher.rate_limit_first = 1;
        let tasks = vec![task(0, None, None)];
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let results = batch.run().await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, AgentRunStatus::Failed);
        assert_eq!(results[0].state, Some(AgentRunState::Started));
        assert_eq!(results[0].error.as_deref(), Some("429 rate limited"));
        assert_eq!(launcher.retry_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn test_rate_limit_capacity_shrink_and_recovery() {
        let mut launcher = MockLauncher::new();
        launcher.completion_delay = Duration::from_millis(200);
        launcher.rate_limit_first = 2;
        let tasks = vec![task(0, None, None), task(1, None, None)];
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let results = batch.run().await.unwrap();
        assert_eq!(results.len(), 2);
        for result in &results {
            assert_eq!(result.status, AgentRunStatus::Completed);
        }
        assert_eq!(launcher.retry_count.load(Ordering::SeqCst), 2);
        let spawn_times = launcher.spawn_times.lock().unwrap().clone();
        let completion_times = launcher.completion_times.lock().unwrap().clone();
        let spawn_at = |id: &str| {
            spawn_times
                .iter()
                .find(|(agent, _)| agent == id)
                .map(|(_, at)| *at)
                .unwrap()
        };
        let completion_at = |id: &str| {
            completion_times
                .iter()
                .find(|(agent, _)| agent == id)
                .map(|(_, at)| *at)
                .unwrap()
        };
        // agent-0/agent-1 are the first attempts; agent-2/agent-3 the retries.
        let first_retry = spawn_at("agent-2");
        let second_retry = spawn_at("agent-3");
        // Capacity shrank to 1, so the second retry cannot start until the
        // first retry completes (200ms later) or capacity recovers (150ms
        // later). Recovery fires first, so the second retry starts while the
        // first retry is still in flight.
        assert!(second_retry >= first_retry + Duration::from_millis(100));
        assert!(second_retry < completion_at("agent-2"));
    }

    #[tokio::test]
    async fn test_timeout() {
        let mut launcher = MockLauncher::new();
        launcher.completion_delay = Duration::from_millis(500);
        let tasks = vec![task(0, Some(Duration::from_millis(50)), None)];
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let results = batch.run().await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, AgentRunStatus::Failed);
        assert_eq!(results[0].state, Some(AgentRunState::Started));
        assert_eq!(results[0].error.as_deref(), Some("Subagent timed out."));
    }

    #[tokio::test]
    async fn test_user_cancellation() {
        let mut launcher = MockLauncher::new();
        launcher.completion_delay = Duration::from_millis(500);
        let batch_signal = AbortSignal::new();
        let tasks: Vec<AgentRunTask<()>> = (0..3)
            .map(|i| task(i, None, Some(batch_signal.clone())))
            .collect();
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let handle = tokio::spawn(async move { batch.run().await });
        sleep(Duration::from_millis(30)).await;
        batch_signal.abort(Some(AbortReason::UserCancellation));
        let results = handle.await.unwrap().unwrap();
        assert_eq!(results.len(), 3);
        for result in &results {
            assert_eq!(result.status, AgentRunStatus::Aborted);
            assert_eq!(result.state, Some(AgentRunState::Started));
            assert!(result.agent_id.is_some());
            assert!(
                result
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("manually interrupted")
            );
        }
    }

    #[tokio::test]
    async fn test_batch_abort_rejects() {
        let mut launcher = MockLauncher::new();
        launcher.completion_delay = Duration::from_millis(500);
        let batch_signal = AbortSignal::new();
        let tasks = vec![task(0, None, Some(batch_signal.clone()))];
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let handle = tokio::spawn(async move { batch.run().await });
        sleep(Duration::from_millis(30)).await;
        batch_signal.abort(Some(AbortReason::Other("boom".into())));
        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err, "boom");
    }

    #[tokio::test]
    async fn test_empty_batch() {
        let launcher = MockLauncher::new();
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            Vec::new(),
            AgentRunBatchOptions::default(),
        );
        let results = batch.run().await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_spawn_failure() {
        let mut launcher = MockLauncher::new();
        launcher.fail_spawn = true;
        let tasks = vec![task(0, None, None)];
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            tasks,
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let results = batch.run().await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, AgentRunStatus::Failed);
        assert_eq!(results[0].state, Some(AgentRunState::NotStarted));
        assert_eq!(results[0].agent_id, None);
        assert_eq!(results[0].error.as_deref(), Some("spawn failed"));
    }

    #[tokio::test]
    async fn test_resume_task() {
        let launcher = MockLauncher::new();
        let mut t = task(0, None, None);
        t.kind = AgentRunTaskKind::Resume {
            resume_agent_id: "existing-agent".into(),
        };
        let batch = AgentRunBatch::new(
            Arc::new(launcher.clone()),
            vec![t],
            AgentRunBatchOptions {
                max_concurrency: None,
                timing: timing(),
            },
        );
        let results = batch.run().await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, AgentRunStatus::Completed);
        assert_eq!(launcher.resume_count.load(Ordering::SeqCst), 1);
        assert_eq!(launcher.spawn_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_resolve_swarm_max_concurrency() {
        let mut env = HashMap::new();
        assert_eq!(resolve_swarm_max_concurrency(&env).unwrap(), None);
        env.insert(AGENT_SWARM_MAX_CONCURRENCY_ENV.into(), "8".into());
        assert_eq!(resolve_swarm_max_concurrency(&env).unwrap(), Some(8));
        env.insert(AGENT_SWARM_MAX_CONCURRENCY_ENV.into(), " 4 ".into());
        assert_eq!(resolve_swarm_max_concurrency(&env).unwrap(), Some(4));
        env.insert(AGENT_SWARM_MAX_CONCURRENCY_ENV.into(), "".into());
        assert_eq!(resolve_swarm_max_concurrency(&env).unwrap(), None);
        env.insert(AGENT_SWARM_MAX_CONCURRENCY_ENV.into(), "0".into());
        assert!(resolve_swarm_max_concurrency(&env).is_err());
        env.insert(AGENT_SWARM_MAX_CONCURRENCY_ENV.into(), "-1".into());
        assert!(resolve_swarm_max_concurrency(&env).is_err());
        env.insert(AGENT_SWARM_MAX_CONCURRENCY_ENV.into(), "abc".into());
        assert!(resolve_swarm_max_concurrency(&env).is_err());
    }
}
