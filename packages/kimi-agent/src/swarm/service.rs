//! Swarm service — the session-level owner of swarm runs.
//!
//! Port of v2 `features/swarm/session/sessionSwarmService.ts`, which is the
//! piece the port was missing: `AgentRunBatch` is only the *scheduler*, while
//! the service owns what a swarm needs above it —
//!
//! - an in-flight registry keyed by the calling agent, so a swarm can be
//!   cancelled as a unit (`cancel`), not by reaching for the parent turn's
//!   `ParentCancel` and hoping every member polls it;
//! - the launcher (member spawn / resume / retry) and the per-member
//!   terminalization that dispatches `subagent.completed|failed|cancelled`.
//!
//! Without this layer the swarm was just "N `Agent` calls behind a batch",
//! which is what made cancellation collapse onto subagent machinery designed
//! for a *single* foreground subagent.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::rpc::types::BoxFuture;
use crate::subagent::types::ParentCancel;
use crate::swarm::agent_run_batch::{
    AbortReason, AbortSignal, AgentRunAbandonOutcome, AgentRunAbandonedEvent,
    AgentRunAttemptHandle, AgentRunAttemptOptions, AgentRunBatch, AgentRunBatchLauncher,
    AgentRunBatchOptions, AgentRunCompletion, AgentRunError, AgentRunResult,
    AgentRunSuspendedEvent, AgentRunTask, AgentSpawnAttemptOptions, resolve_swarm_max_concurrency,
};

/// The member lifecycle events the swarm announces.
///
/// v2 splits failure from cancellation: `classifyRunTermination` decides
/// between them, and the two produce different events. A member reaches
/// exactly one of them — never two, and never none — so a requeued rate-limited
/// worker does not first report a failure and then a completion.
pub trait SwarmEventSink: Send + Sync {
    fn member_suspended(&self, agent_id: &str, reason: &str);
    fn member_completed(&self, agent_id: &str, summary: Option<&str>);
    fn member_failed(&self, agent_id: &str, error: &str);
    fn member_cancelled(&self, agent_id: &str);
}

/// A swarm run's cancellation handle, mirroring v2's `inFlight` map.
#[derive(Clone, Default)]
pub struct SwarmRegistry {
    /// Keyed by the calling agent id (v2 `callerAgentId`), so a swarm is
    /// cancellable as a unit rather than per tool call.
    in_flight: Arc<Mutex<HashMap<String, AbortSignal>>>,
}

impl SwarmRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a run's signal. A second concurrent swarm from the same
    /// caller replaces it, matching v2's single-controller-per-caller map.
    pub fn register(&self, caller_agent_id: &str, signal: AbortSignal) {
        let mut guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(caller_agent_id.to_string(), signal);
    }

    /// Drop a finished run's registration (v2's `finally` block: the entry is
    /// removed only if it is still *this* run's controller).
    pub fn clear(&self, caller_agent_id: &str, run: &AbortSignal) {
        let mut guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        let is_current = guard
            .get(caller_agent_id)
            .is_some_and(|signal| signal.same_signal(run));
        if is_current {
            guard.remove(caller_agent_id);
        }
    }

    /// Cancel the caller's running swarm (v2 `SessionSwarmService.cancel`).
    /// Returns whether a swarm was actually cancelled.
    pub fn cancel(&self, caller_agent_id: &str) -> bool {
        let guard = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        match guard.get(caller_agent_id) {
            Some(signal) => {
                signal.abort(Some(AbortReason::UserCancellation));
                true
            }
            None => false,
        }
    }
}

/// Drives one swarm run: owns the batch signal and hands the scheduler a
/// launcher that reports member lifecycle back through [`SwarmEventSink`].
pub struct SwarmRun<T: Clone + Send + Sync + 'static> {
    launcher: Arc<dyn AgentRunBatchLauncher<T>>,
    signal: AbortSignal,
    tasks: Vec<AgentRunTask<T>>,
    max_concurrency: Option<usize>,
}

impl<T: Clone + Send + Sync + 'static> SwarmRun<T> {
    pub fn new(
        launcher: Arc<dyn AgentRunBatchLauncher<T>>,
        tasks: Vec<AgentRunTask<T>>,
        signal: AbortSignal,
        max_concurrency: Option<usize>,
    ) -> Self {
        Self {
            launcher,
            signal,
            tasks,
            max_concurrency,
        }
    }

    /// The run's cancellation signal — shared by every member, so cancelling
    /// the swarm cancels all of them (v2: tasks are relinked onto one
    /// controller signal).
    pub fn signal(&self) -> AbortSignal {
        self.signal.clone()
    }

    pub async fn run(self) -> Result<Vec<AgentRunResult<T>>, String> {
        let env_map: HashMap<String, String> = std::env::vars().collect();
        let max_concurrency = self
            .max_concurrency
            .or_else(|| resolve_swarm_max_concurrency(&env_map).unwrap_or(None));
        AgentRunBatch::new(
            self.launcher,
            self.tasks,
            AgentRunBatchOptions {
                max_concurrency,
                timing: Default::default(),
            },
        )
        .run()
        .await
    }
}

/// Terminalize a member exactly once, so a retrying or rate-limited member
/// cannot emit two terminal events (v2 `terminalized` set).
#[derive(Default)]
pub struct Terminalizer {
    seen: Mutex<Vec<String>>,
}

impl Terminalizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `false` when this member already reached a terminal state.
    pub fn terminalize(&self, agent_id: &str) -> bool {
        let mut guard = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if guard.iter().any(|id| id == agent_id) {
            return false;
        }
        guard.push(agent_id.to_string());
        true
    }
}

/// The `HostCallbacks` sink: the swarm's member lifecycle as the wire events
/// the host folds (v2 `mirrorAgentRun`'s `SubagentCompleted` / `SubagentFailed`
/// / `SubagentCancelled` / `SubagentSuspended`).
///
/// A swarm member *is* a subagent, so these are the ordinary subagent events —
/// the host routes every child event through `subagentInfo`, which only
/// `subagent.spawned` populates. Emitting the terminal half is what lets a
/// member leave the running state in the TUI's swarm progress row instead of
/// sitting there until the batch returns one XML blob.
pub struct CallbackSink {
    callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    terminalized: Arc<Terminalizer>,
}

impl CallbackSink {
    pub fn new(callbacks: Arc<dyn crate::callbacks::HostCallbacks>) -> Self {
        Self {
            callbacks,
            terminalized: Arc::new(Terminalizer::new()),
        }
    }
}

impl SwarmEventSink for CallbackSink {
    fn member_suspended(&self, agent_id: &str, reason: &str) {
        self.callbacks.emit_event(serde_json::json!({
            "type": "subagent.suspended",
            "subagent_id": agent_id,
            "reason": reason,
        }));
    }

    fn member_completed(&self, agent_id: &str, summary: Option<&str>) {
        if !self.terminalized.terminalize(agent_id) {
            return;
        }
        self.callbacks.emit_event(serde_json::json!({
            "type": "subagent.completed",
            "subagent_id": agent_id,
            "result_summary": summary.unwrap_or_default(),
        }));
    }

    fn member_failed(&self, agent_id: &str, error: &str) {
        if !self.terminalized.terminalize(agent_id) {
            return;
        }
        self.callbacks.emit_event(serde_json::json!({
            "type": "subagent.failed",
            "subagent_id": agent_id,
            "error": error,
        }));
    }

    fn member_cancelled(&self, agent_id: &str) {
        if !self.terminalized.terminalize(agent_id) {
            return;
        }
        self.callbacks.emit_event(serde_json::json!({
            "type": "subagent.cancelled",
            "subagent_id": agent_id,
        }));
    }
}

/// The parent-cancel bridge: link an outer cancellation into the swarm's own
/// signal instead of sharing the parent's `ParentCancel` with every member.
///
/// v2 does this with `linkAbortSignal(task.signal, controller)`. Keeping the
/// bridge here — and giving each member the swarm's *own* signal — is what
/// stops a swarm of N members from piling N waiters onto a single
/// `ParentCancel::wait`, where one `trigger` used to wake only one of them.
pub fn bridge_parent_cancel(parent: ParentCancel, signal: AbortSignal) {
    tokio::spawn(async move {
        parent.wait().await;
        signal.abort(Some(AbortReason::UserCancellation));
    });
}

/// Classify a member's terminal outcome, mirroring v2
/// `classifyRunTermination`: an abort raised by user cancellation is a
/// *cancellation*, anything else is a failure.
pub fn is_user_cancellation(signal: &AbortSignal) -> bool {
    signal.is_aborted() && matches!(signal.reason(), Some(AbortReason::UserCancellation))
}

/// v2 `isRateLimitError`: a throttled member is requeued with backoff rather
/// than failed outright.
pub fn is_rate_limit_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
        || lower.contains("resource exhausted")
}

/// Everything the lifecycle events need that does not change between
/// attempts of one task. Cloned into each attempt future.
#[derive(Clone)]
pub struct Emitter {
    pub callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    pub profile_name: String,
    pub parent_tool_call_id: String,
    pub description: String,
    pub swarm_index: Option<usize>,
}

impl Emitter {
    pub fn emit(&self, agent_id: &str) {
        // v2 `emitAgentRunSpawned` (called from
        // `SessionSwarmService.spawnAttempt`): a swarm member is announced
        // with the ordinary `subagent.spawned` / `subagent.started` pair,
        // carrying `swarmIndex` so the host knows it belongs to a swarm.
        crate::tools::agent_tool::emit_spawned_started(
            self.callbacks.as_ref(),
            agent_id,
            &self.profile_name,
            Some(&self.parent_tool_call_id),
            Some(&self.description),
            false,
            self.swarm_index,
        );
    }

    /// A rate-limited attempt requeued with backoff.
    ///
    /// Superseded by [`SwarmEventSink::member_suspended`], which is where the
    /// event is emitted from now that the sink owns the member lifecycle.
    /// Kept for the `Emitter` construction sites that still report the spawn
    /// pair.
    #[allow(dead_code)]
    pub fn emit_suspended(&self, agent_id: &str, reason: &str) {
        self.callbacks.emit_event(serde_json::json!({
            "type": "subagent.suspended",
            "subagent_id": agent_id,
            "parent_tool_call_id": self.parent_tool_call_id,
            "reason": reason,
        }));
    }
}

/// The swarm's member launcher.
///
/// Lives in the swarm layer — not in `tools` — because owning member
/// spawn/resume/retry is the service's job (v2
/// `SessionSwarmService.spawnAttempt/resumeAttempt/observe`). It still drives
/// members through `SubagentManager`, exactly as v2 drives them through
/// `ISessionSubagentService`: a swarm member *is* a subagent, but the swarm —
/// not the Agent tool — owns its lifecycle and cancellation.
pub struct SwarmLauncher {
    pub manager: Arc<crate::subagent::SubagentManager>,
    /// The parent turn's cancel, forwarded so an interrupted turn stops the
    /// worker mid-flight. The swarm's own signal is the primary cancellation
    /// path; this only bridges the outer one in.
    pub parent_cancel: Option<ParentCancel>,
    /// Fork history snapshot for item-spawned members.
    pub inherited_history: Option<Vec<crate::turn_loop::types::LLMMessage>>,
    /// `[secondary_model]` binding for item-spawned members; `None` inherits
    /// the session model.
    pub llm: Option<Arc<dyn crate::turn_loop::types::LLM>>,
    /// The parent session's callback chain, used to emit the same
    /// `subagent.*` lifecycle events the `Agent` tool emits.
    ///
    /// Without it the host never learns a swarm worker exists: the TUI routes
    /// every child event through `subagentInfo`, which is populated *only* by
    /// `subagent.spawned`, and drops the rest when the id is unknown
    /// (`subagent-event-handler.ts:92`). The swarm progress component would
    /// therefore never render and the user would see nothing until the batch
    /// returned one XML blob.
    pub callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    /// The member lifecycle sink. Shared by every attempt of every task, so a
    /// rate-limited requeue that later completes still reports exactly one
    /// terminal event (v2's `terminalized` set is per-run, not per-attempt).
    pub sink: Arc<dyn SwarmEventSink>,
}

/// Map a finished foreground turn into the batch's completion shape.
///
/// Anything but `EndTurn` means the model did not choose to stop: the step
/// budget, goal budget, repeat breaker or a pause cut the turn short, so the
/// summary is partial. Recording it lets the aggregator say so instead of
/// reporting the worker as finished (v2 `stopReason`).
fn completion_from_turn(
    turn: crate::turn_loop::types::TurnResult,
) -> Result<AgentRunCompletion, AgentRunError> {
    use crate::turn_loop::types::LoopTurnStopReason;

    if matches!(turn.stop_reason, LoopTurnStopReason::Aborted) {
        return Err(AgentRunError {
            message: "The subagent was stopped before it finished.".into(),
            is_rate_limit: false,
            cancelled: true,
        });
    }
    let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
    let stop_reason =
        (!matches!(turn.stop_reason, LoopTurnStopReason::EndTurn)).then_some(turn.stop_reason);
    Ok(AgentRunCompletion {
        result: summary,
        usage: Some(turn.usage),
        stop_reason,
    })
}

/// Run one member to completion, mapping every way it can stop onto the batch's
/// error shape.
///
/// `cancelled` is what separates "the user stopped this" from "the worker
/// broke", and the two produce different events (v2 `classifyRunTermination`).
/// The outer `select` is the swarm's own signal: cancelling the batch kills the
/// member mid-flight, which is a cancellation too.
async fn run_member(
    manager: &Arc<crate::subagent::SubagentManager>,
    agent_id: &str,
    prompt: &str,
    fork_history: Option<Vec<crate::turn_loop::types::LLMMessage>>,
    parent_cancel: Option<&ParentCancel>,
    signal: &AbortSignal,
) -> Result<AgentRunCompletion, AgentRunError> {
    let run_fut =
        manager.run_foreground_turn_with_history(agent_id, prompt, fork_history, parent_cancel);
    tokio::select! {
        res = run_fut => match res {
            Ok(crate::subagent::manager::ForegroundTurnOutcome::Completed(turn)) => {
                completion_from_turn(turn)
            }
            Ok(crate::subagent::manager::ForegroundTurnOutcome::ParentCancelled) => {
                Err(AgentRunError {
                    message: "The subagent was stopped before it finished by user.".into(),
                    is_rate_limit: false,
                    cancelled: true,
                })
            }
            Err(err) => Err(AgentRunError {
                is_rate_limit: is_rate_limit_error(&err),
                message: err,
                cancelled: false,
            }),
        },
        _ = signal.wait() => {
            let _ = manager.kill(agent_id).await;
            Err(AgentRunError {
                message: "The subagent was stopped before it finished.".into(),
                is_rate_limit: false,
                cancelled: true,
            })
        }
    }
}

/// As `run_member`, for a member that is being resumed: it continues its own
/// history when it has one, and starts a fresh turn when it does not.
async fn resume_member(
    manager: &Arc<crate::subagent::SubagentManager>,
    agent_id: &str,
    prompt: &str,
    parent_cancel: Option<&ParentCancel>,
    signal: &AbortSignal,
) -> Result<AgentRunCompletion, AgentRunError> {
    let run_fut = async {
        if let Some(res) = manager
            .resume_foreground_turn(agent_id, prompt, parent_cancel)
            .await
        {
            res
        } else {
            manager
                .run_foreground_turn(agent_id, prompt, parent_cancel)
                .await
        }
    };
    tokio::select! {
        res = run_fut => match res {
            Ok(crate::subagent::manager::ForegroundTurnOutcome::Completed(turn)) => {
                completion_from_turn(turn)
            }
            Ok(crate::subagent::manager::ForegroundTurnOutcome::ParentCancelled) => {
                Err(AgentRunError {
                    message: "The subagent was stopped before it finished by user.".into(),
                    is_rate_limit: false,
                    cancelled: true,
                })
            }
            Err(err) => Err(AgentRunError {
                is_rate_limit: is_rate_limit_error(&err),
                message: err,
                cancelled: false,
            }),
        },
        _ = signal.wait() => {
            let _ = manager.kill(agent_id).await;
            Err(AgentRunError {
                message: "The subagent was stopped before it finished.".into(),
                is_rate_limit: false,
                cancelled: true,
            })
        }
    }
}

/// Report a member's terminal state exactly once (v2 `emitTerminal`).
///
/// A rate-limited member is the one silent case: the batch requeues it, so the
/// run is not over and a failure now would contradict the retry (v2
/// `suppressesRateLimitFailure`).
fn announce_member(
    sink: &dyn SwarmEventSink,
    agent_id: &str,
    outcome: &Result<AgentRunCompletion, AgentRunError>,
) {
    match outcome {
        Ok(completion) => sink.member_completed(agent_id, Some(&completion.result)),
        Err(error) if error.is_rate_limit => {}
        Err(error) if error.cancelled => sink.member_cancelled(agent_id),
        Err(error) => sink.member_failed(agent_id, &error.message),
    }
}

impl<T: Clone + Send + Sync + 'static> AgentRunBatchLauncher<T> for SwarmLauncher {
    fn spawn(
        &self,
        options: AgentSpawnAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
        let manager = self.manager.clone();
        let parent_cancel = self.parent_cancel.clone();
        let item_llm = self.llm.clone();
        let self_sink = self.sink.clone();
        let emit = Emitter {
            callbacks: self.callbacks.clone(),
            profile_name: options.profile_name.clone(),
            parent_tool_call_id: options.run.parent_tool_call_id.clone(),
            description: options.run.description.clone(),
            swarm_index: options.run.swarm_index,
        };
        let fork_history = if options.plan.fork {
            self.inherited_history.clone()
        } else {
            None
        };
        Box::pin(async move {
            let role = format!("Swarm worker for {}", options.run.description);
            let agent_id = manager.spawn(&options.profile_name, &role).await?;
            if let Some(llm) = item_llm.clone() {
                manager.set_instance_llm(&agent_id, llm).await;
            }
            emit.emit(&agent_id);
            let prompt = options.run.prompt;
            let signal = options.run.signal;
            let handle_id = agent_id.clone();
            let target_id = agent_id.clone();

            let completion: BoxFuture<'static, Result<AgentRunCompletion, AgentRunError>> =
                Box::pin(async move {
                    let outcome = run_member(
                        &manager,
                        &target_id,
                        &prompt,
                        fork_history,
                        parent_cancel.as_ref(),
                        &signal,
                    )
                    .await;
                    announce_member(self_sink.as_ref(), &target_id, &outcome);
                    outcome
                });

            Ok(AgentRunAttemptHandle {
                agent_id: handle_id,
                completion,
            })
        })
    }

    fn resume(
        &self,
        agent_id: String,
        options: AgentRunAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
        let manager = self.manager.clone();
        let parent_cancel = self.parent_cancel.clone();
        let sink = self.sink.clone();
        // A resumed member was already announced with `subagent.spawned` when
        // it first launched; only the lifecycle moves back to running. Emitting
        // the pair again would re-register it in the host's `subagentInfo` and
        // reset the progress row's counters mid-batch.
        let callbacks = self.callbacks.clone();
        Box::pin(async move {
            let prompt = options.prompt;
            let signal = options.signal;
            let handle_id = agent_id.clone();
            let target_id = agent_id.clone();

            callbacks.emit_event(serde_json::json!({
                "type": "subagent.started",
                "subagent_id": target_id,
            }));

            let completion: BoxFuture<'static, Result<AgentRunCompletion, AgentRunError>> =
                Box::pin(async move {
                    let outcome = resume_member(
                        &manager,
                        &target_id,
                        &prompt,
                        parent_cancel.as_ref(),
                        &signal,
                    )
                    .await;
                    announce_member(sink.as_ref(), &target_id, &outcome);
                    outcome
                });

            Ok(AgentRunAttemptHandle {
                agent_id: handle_id,
                completion,
            })
        })
    }

    fn retry(
        &self,
        agent_id: String,
        options: AgentRunAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
        // `resume` is generic over the impl's `T`, so name it: a retry is
        // just a resume of the same member (v2 `retryTurn`).
        <Self as AgentRunBatchLauncher<T>>::resume(self, agent_id, options)
    }

    fn suspended(&self, event: AgentRunSuspendedEvent<T>) {
        self.sink.member_suspended(&event.agent_id, &event.reason);
    }

    /// v2 `AgentRunBatchLauncher.abandoned`: a member the batch gave up on
    /// reaches its terminal state here. The sink's terminalizer keeps this to
    /// one event per member, so a member that already settled — or one whose
    /// retry later succeeds — cannot double-report.
    fn abandoned(&self, event: AgentRunAbandonedEvent<T>) {
        match event.outcome {
            AgentRunAbandonOutcome::Cancelled => self.sink.member_cancelled(&event.agent_id),
            AgentRunAbandonOutcome::Failed => self.sink.member_failed(
                &event.agent_id,
                event.error.as_deref().unwrap_or("Provider rate limit"),
            ),
        }
    }
}

/// The outcome of a member the batch gave up on, reported through v2's
/// `abandoned` launcher hook. The outcome enum now lives with the batch that
/// produces it, next to the two call sites that raise it.
pub use crate::swarm::agent_run_batch::AgentRunAbandonOutcome as SwarmAbandonOutcome;

/// Re-exports so the service module is the single import site for swarm
/// callers, rather than callers reaching into `agent_run_batch` and
/// `subagent` separately.
pub use crate::swarm::agent_run_batch::AgentRunStatus;

/// Convenience alias used by the launcher implementations.
pub type SwarmCompletion = BoxFuture<'static, Result<AgentRunCompletion, AgentRunError>>;

/// Build an attempt handle from a spawned/resumed member id.
pub fn attempt_handle(agent_id: String, completion: SwarmCompletion) -> AgentRunAttemptHandle {
    AgentRunAttemptHandle {
        agent_id,
        completion,
    }
}

/// The options a launcher needs for a resume/retry attempt, kept here so a
/// swarm launcher does not import from `subagent` for scheduling types.
pub type SwarmAttemptOptions = AgentRunAttemptOptions;

/// Spawn attempt options, re-exported for the same reason.
pub type SwarmSpawnOptions = AgentSpawnAttemptOptions;

/// Foreground turn outcomes are the launcher's business; re-exported so
/// launchers can match on them without importing `subagent::manager`.
pub use crate::subagent::manager::ForegroundTurnOutcome as SwarmTurnOutcome;

/// A suspended member (v2 `SubagentSuspended`).
pub type SwarmSuspended = AgentRunSuspendedEvent<()>;
