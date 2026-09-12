//! EngineSession — the turn lifecycle owner (M1a/M1b/M1c).
//!
//! Owns what v2's `loopService.ts` owns today: turn admission (four modes),
//! the pending-turn FIFO, serial turn execution, turn-id assignment, and
//! cancellation (active via the run_turn cancel flag, queued by dropping the
//! entry). Cross-turn conversation history is owned here too: each turn
//! starts from the accumulated history plus the enqueued prompt, and the
//! turn's final messages (assistant/tool turns included) fold back into the
//! history for the next turn.
//!
//! The turn clock is hydrated once from the host's `turn` state domain and
//! then advanced locally; every id assignment is mirrored to the host by a
//! durable [`TurnEvent::Prompt`], so the host's own `turnKey` fold stays the
//! single writer of persisted turn state.
//!
//! M1c adds the quiescence/backpressure half of `loopService.ts`
//! (`tryAcquireQuiescence` / `settled`): while a quiescence guard is held,
//! enqueued turns are held back instead of admitted; releasing the guard
//! replays them in FIFO order; [`EngineSession::settled`] resolves once no
//! turn is active, pending, or held.
//!
//! Deliberately out of scope (see the M1 section of `ROADMAP.md`):
//! telemetry is served by the `host/telemetry` callback (M1c, emitted from
//! `run_turn`), `host/list_tools` is M1d.

pub mod patch;
pub mod sqlite_store;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{Notify, oneshot};

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, ListToolsResponse, LlmChatRequest, LlmChatResponse,
    PermissionCheckRequest, PermissionDecision, StateReadRequest, StateReadResponse,
    StateWriteRequest, StateWriteResponse, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::turn_events::{TurnCancelReason, TurnCancelTarget, TurnEndReason, TurnEvent};
use crate::turn_loop::run_turn::run_turn_continued;
use crate::turn_loop::types::{GoalContext, LLM, LLMMessage, RunTurnInput, ToolInfo, TurnResult};

/// How an enqueued prompt joins the turn pipeline (v2 `StepRequest.admission`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// Always start a new queued turn.
    NewTurn,
    /// Join the active turn as steering, else start a new turn.
    ActiveOrNewTurn,
    /// Queue behind the active turn, else start a new turn.
    ActiveOrNextTurn,
    /// Join the active turn as steering; error when no turn is active.
    ActiveTurnOnly,
}

/// The host's persisted turn clock, read once at session construction so a
/// resumed session continues its id sequence instead of restarting at zero.
///
/// Read-only by design. The host owns the clock: it advances from the durable
/// [`TurnEvent::Prompt`] the engine emits per turn, and its `turn` state also
/// carries host-only fields (undo anchors, last-end summary) that a whole-value
/// write from the engine would clobber.
async fn read_turn_clock(callbacks: &Arc<dyn HostCallbacks>) -> u64 {
    let read = StateReadRequest {
        domain: "turn".into(),
        key: String::new(),
        turn_id: String::new(),
        tool_call_id: String::new(),
    };
    match callbacks.state_read(read).await {
        Ok(resp) => resp
            .value
            .get("nextTurnId")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        Err(_) => 0,
    }
}

/// A prompt to enqueue, plus the payload the host wants mirrored back on the
/// durable `turn.prompt` event.
#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub prompt: LLMMessage,
    pub admission: Admission,
    /// The prompt as the host wrote it — a `ContentPart[]` JSON array the
    /// engine echoes back verbatim on the durable `turn.prompt` event, so the
    /// host persists exactly what it sent rather than the engine's re-render.
    pub input: serde_json::Value,
    /// v2 `PromptOrigin` JSON, echoed back verbatim. The engine does not model
    /// origin variants; the host needs them for the undo anchor and transcript.
    pub origin: serde_json::Value,
}

impl TurnRequest {
    /// A plain text prompt from the user — the minimum the host can fold:
    /// v2's undo-anchor check reads `origin.kind`, so a missing origin would
    /// throw inside the fold rather than degrade.
    pub fn user(prompt: LLMMessage, admission: Admission) -> Self {
        let input = serde_json::json!([{ "type": "text", "text": prompt.content.clone() }]);
        Self {
            input,
            origin: serde_json::json!({ "kind": "user" }),
            prompt,
            admission,
        }
    }
}

/// The outcome of an enqueued turn.
#[derive(Debug, Clone)]
pub enum TurnOutcome {
    /// The turn ran to a stop (mid-turn cancellation included —
    /// `TurnResult.stop_reason` says which).
    Ran(TurnResult),
    /// Cancelled while still queued; the engine never ran it.
    CancelledBeforeStart,
}

/// Handle for one enqueued turn. Cancellation goes through
/// [`EngineSession::cancel_turn`] with the receipt's `turn_id`.
pub struct TurnReceipt {
    /// For steering admissions this is the active turn's id — the steer
    /// joins that turn and its outcome resolves with the turn's.
    pub turn_id: u64,
    outcome: oneshot::Receiver<Result<TurnOutcome, String>>,
}

impl TurnReceipt {
    /// Wait for the turn to finish (or be cancelled while queued). Takes
    /// `&mut self` so the receipt (and its `turn_id`) remains accessible
    /// after the await — callers that only need the outcome can `let _ =
    /// receipt.outcome().await?` to drop the receipt after.
    pub async fn outcome(&mut self) -> Result<TurnOutcome, String> {
        (&mut self.outcome)
            .await
            .map_err(|_| "session dropped".to_string())?
    }

    /// Split the receipt into its turn id and the outcome receiver — the
    /// shape the napi session surface stores to serve `turn_outcome`
    /// promises.
    pub fn into_parts(self) -> (u64, oneshot::Receiver<Result<TurnOutcome, String>>) {
        (self.turn_id, self.outcome)
    }
}

/// Live session shape (v2 `AgentLoopStatus`).
#[derive(Debug, Clone)]
pub struct SessionStatus {
    pub active_turn_id: Option<u64>,
    pub pending_turn_ids: Vec<u64>,
    /// P56 (G-5): execution-path summary of the most recent completed turn
    /// — the cross-process half of `/status`'s engine line. `None` until
    /// the session has run a turn.
    pub engine: Option<crate::rpc::types::EngineExecSummary>,
}

/// Fresh-per-turn tool-table provider (the turn-start snapshot source; the
/// per-step refresh goes through `host/list_tools`).
pub type ToolDefsProvider =
    Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Vec<ToolInfo>> + Send + Sync>;

/// Fresh-per-turn async goal provider (budget checks + steering). Async like
/// `tool_defs`: the napi session reads it through a host callback.
pub type GoalProvider =
    Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Option<GoalContext>> + Send + Sync>;

/// Session-level configuration, fixed for the session's lifetime.
pub struct SessionConfig {
    pub llm: Arc<dyn LLM>,
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Step cap for every turn (v2 `maxStepsPerTurn`).
    pub max_steps: u32,
    /// Host `loopControl.maxAttemptsPerStep` (v2); `None` keeps the engine
    /// default.
    pub max_attempts: Option<u32>,
    /// Context window the host resolved for the session's model (v2
    /// `ModelCapability.max_context_tokens`); `None` keeps the engine default.
    pub max_context_tokens: Option<u32>,
    /// Fresh tool definitions per turn (MCP tools can change mid-session;
    /// M1d replaces this provider with `host/list_tools`).
    pub tool_defs: ToolDefsProvider,
    /// Fresh goal snapshot per turn (budget checks + steering). Async like
    /// `tool_defs`: the napi session reads it through a host callback.
    pub goal: Option<GoalProvider>,
    /// Ran before each turn's first step (REPL: the undo checkpoint).
    pub on_before_turn: Option<Arc<dyn Fn() + Send + Sync>>,
    /// P55: session-wide slot the pump refreshes per turn with that turn's
    /// [`ParentCancel`] signal. The native toolset shares the same Arc, so a
    /// foreground `Agent` spawn sees the live signal even though the toolset
    /// itself is built once per session. `None` = no native agent context.
    pub agent_cancel_slot:
        Option<Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>>,
    /// Turn-lifecycle hook dispatch (`UserPromptSubmit` / `PreCompact` /
    /// `Stop`); `None` skips those dispatches.
    pub hook_guard: Option<Arc<crate::tools::external_hooks::HookGuard>>,
    /// Print-mode (`kimi -p`) background policy the host resolved from
    /// `[background]`. `None` keeps the engine default: a turn receipt
    /// resolves as soon as the turn ends, whatever the background tasks do.
    pub print_background: Option<PrintBackgroundPolicy>,
    /// The process-wide task runner the print settle waits on. `None` outside
    /// a wired pipeline, where the wait is a no-op.
    pub task_runner: Option<Arc<crate::storage::TaskRunner>>,
}

/// What a print-mode (`kimi -p`) session does once its main turn ends while
/// background tasks are still running (`[background].print_background_mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrintBackgroundMode {
    /// Exit as soon as the turn ends, leaving pending tasks behind.
    Exit,
    /// Keep the session open until the runner's tasks reach a terminal state.
    Drain,
    /// Like [`Self::Drain`]; the host additionally feeds the completions back
    /// as a further turn.
    Steer,
}

impl PrintBackgroundMode {
    /// Wire string (`exit` / `drain` / `steer`). An unknown value resolves to
    /// [`Self::Exit`] so a typo cannot silently stall a run behind the
    /// ceiling.
    #[must_use]
    pub fn from_wire(value: &str) -> Self {
        match value {
            "drain" => Self::Drain,
            "steer" => Self::Steer,
            _ => Self::Exit,
        }
    }

    /// Whether the session holds its turn receipt until the runner drains.
    #[must_use]
    pub fn waits(&self) -> bool {
        matches!(self, Self::Drain | Self::Steer)
    }
}

/// The `[background]` print policy the host passed with the session.
#[derive(Debug, Clone, Copy)]
pub struct PrintBackgroundPolicy {
    pub mode: PrintBackgroundMode,
    /// Wall-clock ceiling for the run's whole settle phase (drain + steer
    /// turns), in seconds.
    pub ceiling_s: u64,
    /// Cap on the steer turns the engine may add for background completions
    /// (`[background].print_max_turns`).
    pub max_turns: u32,
}

/// Ceiling used when the host passes none: the documented
/// `print_wait_ceiling_s` default (~24.8 days), i.e. effectively unbounded.
pub const PRINT_WAIT_CEILING_S_DEFAULT: u64 = 2_147_483;

/// Steer-turn budget used when the host passes none: the documented
/// `print_max_turns` default.
pub const PRINT_MAX_TURNS_DEFAULT: u32 = 100_000;

impl PrintBackgroundPolicy {
    /// From the raw knobs the host resolved (`print_background_mode` /
    /// `print_wait_ceiling_s` / `print_max_turns`). `None` (no mode) keeps the
    /// engine's exit-on-turn-end default, so non-print entries are unaffected;
    /// a non-positive bound keeps the documented default, since `0` cannot
    /// mean "never wait".
    #[must_use]
    pub fn from_wire(
        mode: Option<&str>,
        ceiling_s: Option<u64>,
        max_turns: Option<u32>,
    ) -> Option<Self> {
        Some(Self {
            mode: PrintBackgroundMode::from_wire(mode?),
            ceiling_s: ceiling_s
                .filter(|ceiling| *ceiling > 0)
                .unwrap_or(PRINT_WAIT_CEILING_S_DEFAULT),
            max_turns: max_turns
                .filter(|max_turns| *max_turns > 0)
                .unwrap_or(PRINT_MAX_TURNS_DEFAULT),
        })
    }
}

/// Cross-turn budget of one print run's settle phase. The ceiling deadline and
/// the steer-turn count span every turn of the run — `[background]` bounds the
/// run, not each turn's share of it.
#[derive(Default)]
struct PrintRunState {
    /// Wall-clock deadline, anchored at the first settle of the run.
    deadline: Option<std::time::Instant>,
    /// Steer turns enqueued so far.
    steer_turns: usize,
}

/// How often the settle loop re-checks the runner. The interval only bounds
/// how late a drain is noticed, never how long a wait may run.
const PRINT_SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// How long after a cron's fire time the settle still accepts it (v2
/// `CRON_FIRE_GRACE_MS`): the wake is never exactly on the minute.
const CRON_FIRE_GRACE_MS: i64 = 2_000;

struct PendingTurn {
    turn_id: u64,
    prompt: LLMMessage,
    input: serde_json::Value,
    origin: serde_json::Value,
    cancel: Arc<AtomicBool>,
    /// `Some(sender)` until the pump claims it to resolve the receipt; the
    /// cancel path takes it out to deliver `CancelledBeforeStart`. `None`
    /// after one of those has run.
    outcome: Option<oneshot::Sender<Result<TurnOutcome, String>>>,
}

/// State shared between the public API and the pump. Guarded by one mutex;
/// the pump never holds it across an await.
struct Core {
    next_turn_id: u64,
    pending: Vec<PendingTurn>,
    active_turn_id: Option<u64>,
    active_cancel: Option<Arc<AtomicBool>>,
    /// Steer receipts waiting on the active turn's outcome.
    steer_waiters: Vec<(u64, oneshot::Sender<Result<TurnOutcome, String>>)>,
    /// Cross-turn conversation history (system message excluded — run_turn
    /// rebuilds it per turn from the LLM's system prompt).
    history: Vec<LLMMessage>,
    /// M1c: while > 0 (a [`QuiescenceGuard`] is alive) enqueued turns are
    /// parked in `held` instead of admitted.
    quiescence_depth: usize,
    /// Turns enqueued during quiescence, replayed in FIFO order on release.
    held: Vec<HeldTurn>,
    /// Waiters resolved by [`EngineSession::settled`] once nothing is
    /// active, pending, or held.
    settle_waiters: Vec<oneshot::Sender<()>>,
    /// P56 (G-5): execution-path summary of the last completed turn.
    last_engine: Option<crate::rpc::types::EngineExecSummary>,
}

/// A turn parked by quiescence: the id was allocated at enqueue time (the
/// receipt is already in the caller's hands), the turn itself starts only
/// when the guard is released.
struct HeldTurn {
    turn_id: u64,
    request: TurnRequest,
    cancel: Arc<AtomicBool>,
    outcome: Option<oneshot::Sender<Result<TurnOutcome, String>>>,
}

/// Resolve every [`Core::settle_waiters`] when the session is fully idle.
fn maybe_settle_locked(core: &mut Core) {
    if core.active_turn_id.is_none() && core.pending.is_empty() && core.held.is_empty() {
        for tx in std::mem::take(&mut core.settle_waiters) {
            let _ = tx.send(());
        }
    }
}

struct SessionContext {
    llm: Arc<dyn LLM>,
    callbacks: Arc<dyn HostCallbacks>,
    tool_defs: ToolDefsProvider,
    goal: Option<GoalProvider>,
    on_before_turn: Option<Arc<dyn Fn() + Send + Sync>>,
    max_steps: u32,
    max_attempts: Option<u32>,
    max_context_tokens: Option<u32>,
    /// P55: see [`SessionConfig::agent_cancel_slot`].
    agent_cancel_slot: Option<Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>>,
    /// Turn-lifecycle hook dispatch; see [`SessionConfig::hook_guard`].
    hook_guard: Option<Arc<crate::tools::external_hooks::HookGuard>>,
    /// Print-mode background policy; see [`SessionConfig::print_background`].
    print_background: Option<PrintBackgroundPolicy>,
    /// The runner the print settle polls; see [`SessionConfig::task_runner`].
    task_runner: Option<Arc<crate::storage::TaskRunner>>,
    /// Cross-turn settle budget of the current print run; see [`PrintRunState`].
    print_run: std::sync::Mutex<PrintRunState>,
}

/// The turn lifecycle owner. A cloneable handle; the pump task runs turns
/// serially in the background.
#[derive(Clone)]
pub struct EngineSession {
    core: Arc<Mutex<Core>>,
    wakeup: Arc<Notify>,
    steer_queue: Arc<Mutex<Vec<LLMMessage>>>,
    /// Steer-queue-decorated callbacks (for event dispatch + state bridge).
    callbacks: Arc<dyn HostCallbacks>,
    /// P55: shared with the pump (per-turn refresh) and `cancel_turn`
    /// (trigger), and with the native toolset's agent context.
    agent_cancel_slot: Option<Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>>,
}

impl EngineSession {
    pub async fn new(config: SessionConfig) -> Self {
        let initial_clock = read_turn_clock(&config.callbacks).await;
        let core = Arc::new(Mutex::new(Core {
            next_turn_id: initial_clock,
            pending: Vec::new(),
            active_turn_id: None,
            active_cancel: None,
            steer_waiters: Vec::new(),
            history: Vec::new(),
            quiescence_depth: 0,
            held: Vec::new(),
            settle_waiters: Vec::new(),
            last_engine: None,
        }));
        let steer_queue = Arc::new(Mutex::new(Vec::new()));
        let ctx = Arc::new(SessionContext {
            llm: config.llm,
            callbacks: Arc::new(SteerQueueCallbacks {
                inner: config.callbacks,
                steer_queue: steer_queue.clone(),
            }),
            tool_defs: config.tool_defs,
            goal: config.goal,
            on_before_turn: config.on_before_turn,
            max_steps: config.max_steps,
            max_attempts: config.max_attempts,
            max_context_tokens: config.max_context_tokens,
            agent_cancel_slot: config.agent_cancel_slot.clone(),
            hook_guard: config.hook_guard.clone(),
            print_background: config.print_background,
            task_runner: config.task_runner.clone(),
            print_run: std::sync::Mutex::new(PrintRunState::default()),
        });
        let wakeup = Arc::new(Notify::new());
        let callbacks = ctx.callbacks.clone();
        tokio::spawn(pump(core.clone(), ctx, wakeup.clone()));
        Self {
            core,
            wakeup,
            steer_queue,
            callbacks,
            agent_cancel_slot: config.agent_cancel_slot,
        }
    }

    /// Enqueue a prompt. The turn id is assigned synchronously (monotonic,
    /// never reused — cancelled queued turns consume their id, matching v2's
    /// reserved-id clock), so the caller can cancel by id immediately.
    ///
    /// While a [`QuiescenceGuard`] is alive the request is parked (M1c
    /// backpressure, v2 `heldAdmissions`) and only admitted on guard release.
    pub fn enqueue_turn(&self, request: TurnRequest) -> Result<TurnReceipt, String> {
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if core.quiescence_depth > 0 {
            // Quiescence: park the request. The id is allocated now (the
            // receipt is already in the caller's hands); admission happens on
            // guard release. There is never an active turn during
            // quiescence, so steering admissions park too.
            let turn_id = core.next_turn_id;
            core.next_turn_id += 1;
            core.held.push(HeldTurn {
                turn_id,
                request,
                cancel: Arc::new(AtomicBool::new(false)),
                outcome: Some(outcome_tx),
            });
            return Ok(TurnReceipt {
                turn_id,
                outcome: outcome_rx,
            });
        }
        let turn_id = Self::admit_locked(
            &mut core,
            request,
            outcome_tx,
            None,
            &self.steer_queue,
            &self.wakeup,
        )?;
        Ok(TurnReceipt {
            turn_id,
            outcome: outcome_rx,
        })
    }

    /// Shared admission logic (v2 `admit`, :242-265). `preallocated_id` is
    /// set when replaying a quiescence-held turn whose id was already handed
    /// out at enqueue time. Notifies the pump after queueing; the caller may
    /// still hold the core lock — `Notify` is non-blocking and the pump
    /// takes the lock only after waking.
    fn admit_locked(
        core: &mut Core,
        request: TurnRequest,
        outcome_tx: oneshot::Sender<Result<TurnOutcome, String>>,
        preallocated_id: Option<u64>,
        steer_queue: &Mutex<Vec<LLMMessage>>,
        wakeup: &Notify,
    ) -> Result<u64, String> {
        match request.admission {
            Admission::NewTurn | Admission::ActiveOrNextTurn => {
                let turn_id = match preallocated_id {
                    Some(id) => id,
                    None => {
                        let id = core.next_turn_id;
                        core.next_turn_id += 1;
                        id
                    }
                };
                core.pending.push(PendingTurn {
                    turn_id,
                    prompt: request.prompt,
                    input: request.input,
                    origin: request.origin,
                    cancel: Arc::new(AtomicBool::new(false)),
                    outcome: Some(outcome_tx),
                });
                wakeup.notify_one();
                Ok(turn_id)
            }
            Admission::ActiveOrNewTurn | Admission::ActiveTurnOnly => {
                if let Some(active) = core.active_turn_id {
                    // Steer: the prompt joins the active turn through the
                    // drain_steers seam; the receipt resolves with the active
                    // turn's outcome.
                    core.steer_waiters.push((active, outcome_tx));
                    steer_queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(request.prompt);
                    Ok(active)
                } else if request.admission == Admission::ActiveTurnOnly {
                    Err("Step request requires an active turn".to_string())
                } else {
                    let turn_id = match preallocated_id {
                        Some(id) => id,
                        None => {
                            let id = core.next_turn_id;
                            core.next_turn_id += 1;
                            id
                        }
                    };
                    core.pending.push(PendingTurn {
                        turn_id,
                        prompt: request.prompt,
                        input: request.input,
                        origin: request.origin,
                        cancel: Arc::new(AtomicBool::new(false)),
                        outcome: Some(outcome_tx),
                    });
                    wakeup.notify_one();
                    Ok(turn_id)
                }
            }
        }
    }

    /// Cancel a turn by id. An active turn is interrupted at the next step
    /// boundary; a queued or quiescence-held turn is dropped before starting
    /// (its receipt resolves with [`TurnOutcome::CancelledBeforeStart`]).
    /// Without an id the active turn (if any) is cancelled. Returns whether
    /// anything was cancelled.
    pub fn cancel_turn(&self, turn_id: Option<u64>) -> bool {
        // Decide under the lock, dispatch after releasing it: `turn_event`
        // hands the event to the host, which must never run while the core
        // mutex is held.
        enum Decision {
            CancelActive { turn_id: Option<u64> },
            CancelQueued { turn_id: u64 },
            Nothing,
        }
        let decision = {
            let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
            let decision = match turn_id {
                Some(id) if core.active_turn_id == Some(id) => match &core.active_cancel {
                    Some(flag) => {
                        flag.store(true, Ordering::SeqCst);
                        Decision::CancelActive { turn_id: Some(id) }
                    }
                    None => Decision::Nothing,
                },
                Some(id) => match core.pending.iter().position(|t| t.turn_id == id) {
                    Some(pos) => {
                        let mut entry = core.pending.remove(pos);
                        entry.cancel.store(true, Ordering::SeqCst);
                        if let Some(tx) = entry.outcome.take() {
                            let _ = tx.send(Ok(TurnOutcome::CancelledBeforeStart));
                        }
                        Decision::CancelQueued { turn_id: id }
                    }
                    None => match core.held.iter().position(|t| t.turn_id == id) {
                        Some(pos) => {
                            let mut entry = core.held.remove(pos);
                            entry.cancel.store(true, Ordering::SeqCst);
                            if let Some(tx) = entry.outcome.take() {
                                let _ = tx.send(Ok(TurnOutcome::CancelledBeforeStart));
                            }
                            Decision::CancelQueued { turn_id: id }
                        }
                        None => Decision::Nothing,
                    },
                },
                None => match &core.active_cancel {
                    Some(flag) => {
                        flag.store(true, Ordering::SeqCst);
                        // v2 always attributes the cancellation to the active
                        // turn's id, even when the caller said "cancel all".
                        Decision::CancelActive {
                            turn_id: core.active_turn_id,
                        }
                    }
                    None => Decision::Nothing,
                },
            };
            maybe_settle_locked(&mut core);
            decision
        };
        match decision {
            Decision::CancelActive { turn_id } => {
                // P55: wake the foreground `Agent` spawn's event-driven wait
                // immediately (the flag store above covers step tops).
                if let Some(slot) = &self.agent_cancel_slot
                    && let Some(signal) = slot.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                {
                    signal.trigger();
                }
                self.callbacks.turn_event(TurnEvent::Cancel {
                    turn_id,
                    target: Some(TurnCancelTarget::Active),
                    reason: Some(TurnCancelReason::UserCancelled),
                });
                true
            }
            Decision::CancelQueued { turn_id } => {
                self.callbacks.turn_event(TurnEvent::Cancel {
                    turn_id: Some(turn_id),
                    target: Some(TurnCancelTarget::Queued),
                    reason: Some(TurnCancelReason::UserCancelled),
                });
                true
            }
            Decision::Nothing => false,
        }
    }

    /// Live session shape.
    pub fn status(&self) -> SessionStatus {
        let core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        SessionStatus {
            active_turn_id: core.active_turn_id,
            pending_turn_ids: core.pending.iter().map(|t| t.turn_id).collect(),
            engine: core.last_engine.clone(),
        }
    }

    /// Try to acquire quiescence (v2 `tryAcquireQuiescence`): an exclusive
    /// window in which enqueued turns are parked instead of admitted. Fails
    /// (`None`) when a guard is already held or any turn is active, pending,
    /// or held — the caller must wait for [`EngineSession::settled`] and
    /// retry. Undo checkpoints, compaction, and reminder injection run
    /// inside this window (v2 consumers: undoService, fullCompactionService,
    /// reminderAgentRuntime).
    pub fn try_acquire_quiescence(&self) -> Option<QuiescenceGuard> {
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if core.quiescence_depth > 0
            || core.active_turn_id.is_some()
            || !core.pending.is_empty()
            || !core.held.is_empty()
        {
            return None;
        }
        core.quiescence_depth += 1;
        Some(QuiescenceGuard {
            core: self.core.clone(),
            steer_queue: self.steer_queue.clone(),
            wakeup: self.wakeup.clone(),
        })
    }

    /// Whether the session is fully idle (nothing active, pending, or held)
    /// right now — the non-blocking probe behind [`EngineSession::settled`].
    pub fn is_settled(&self) -> bool {
        let core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        core.active_turn_id.is_none() && core.pending.is_empty() && core.held.is_empty()
    }

    /// Resolves once the session is fully idle: no active turn, no pending
    /// or held turns (v2 `settled`). Session teardown awaits this before
    /// disposing engine-owned resources.
    pub async fn settled(&self) {
        let rx = {
            let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
            if core.active_turn_id.is_none() && core.pending.is_empty() && core.held.is_empty() {
                return;
            }
            let (tx, rx) = oneshot::channel();
            core.settle_waiters.push(tx);
            rx
        };
        let _ = rx.await;
    }

    /// Replace the session's cross-turn history. The next enqueued turn
    /// starts from `history` (with the new prompt appended). Used by the
    /// REPL's `/resume` and `/clear` slash commands between turns.
    pub fn set_history(&self, history: Vec<LLMMessage>) {
        self.core.lock().unwrap_or_else(|e| e.into_inner()).history = history;
    }

    /// Clear the session's history (the next enqueued turn starts fresh).
    pub fn clear_history(&self) {
        self.core
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .clear();
    }

    /// Append messages to the history without starting a turn (REPL cron path:
    /// cron-fired prompts join the next user turn's context).
    pub fn extend_history(&self, msgs: Vec<LLMMessage>) {
        self.core
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .extend(msgs);
    }

    /// Current history length, for `/status` display. Counts every message
    /// including the system message and the most recent user prompt.
    pub fn history_len(&self) -> usize {
        self.core
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .len()
    }

    /// A clone of the current cross-turn history. The napi `session_get_history`
    /// serializes this so the host can carry the conversation across an
    /// engine-session rebuild (a mid-session model / permission change) and
    /// implement undo / fork without losing context — the inverse of
    /// [`Self::set_history`].
    pub fn snapshot_history(&self) -> Vec<LLMMessage> {
        self.core
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .clone()
    }
}

/// Exclusive quiescence window (v2 `IDisposable` from
/// `tryAcquireQuiescence`). Releasing the guard — explicit `drop` or scope
/// exit — replays every held turn in FIFO order and wakes the pump. RAII
/// replaces v2's manual `dispose()`, so an early return inside the window
/// cannot strand the session in quiescence.
pub struct QuiescenceGuard {
    core: Arc<Mutex<Core>>,
    steer_queue: Arc<Mutex<Vec<LLMMessage>>>,
    wakeup: Arc<Notify>,
}

impl Drop for QuiescenceGuard {
    fn drop(&mut self) {
        let held = {
            let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
            core.quiescence_depth = core.quiescence_depth.saturating_sub(1);
            if core.quiescence_depth > 0 {
                return;
            }
            std::mem::take(&mut core.held)
        };
        // Replay held turns in FIFO order. Admission modes are preserved; a
        // replayed steer admission with no active turn queues a new turn,
        // matching v2's admit-on-replay.
        {
            let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
            for entry in held {
                let HeldTurn {
                    turn_id,
                    request,
                    cancel: _,
                    outcome,
                } = entry;
                // The outcome sender is always `Some` here — only the cancel
                // path takes it, and a cancelled held turn never reaches the
                // replay. The fallback keeps the compiler happy without a
                // panic path.
                let outcome = outcome.unwrap_or_else(|| {
                    let (tx, _rx) = oneshot::channel();
                    tx
                });
                let _ = EngineSession::admit_locked(
                    &mut core,
                    request,
                    outcome,
                    Some(turn_id),
                    &self.steer_queue,
                    &self.wakeup,
                );
            }
        }
        self.wakeup.notify_one();
    }
}

async fn pump(core: Arc<Mutex<Core>>, ctx: Arc<SessionContext>, wakeup: Arc<Notify>) {
    loop {
        // Start the next runnable turn when idle. Cancelled entries are
        // dropped (their receipts were resolved at cancel time).
        let next = {
            let mut core = core.lock().unwrap_or_else(|e| e.into_inner());
            if core.active_turn_id.is_some() {
                None
            } else {
                let pos = core
                    .pending
                    .iter()
                    .position(|t| !t.cancel.load(Ordering::SeqCst));
                pos.map(|pos| {
                    let entry = core.pending.remove(pos);
                    core.active_turn_id = Some(entry.turn_id);
                    core.active_cancel = Some(entry.cancel.clone());
                    (entry, core.history.clone())
                })
            }
        };

        // P55: publish this turn's cancel signal into the session-wide slot
        // so the native `Agent` tool's foreground spawn awaits a signal the
        // host's `cancel_turn` can trip immediately (not just at step tops).
        // (Written after the entry destructure below, where `cancel` lives.)

        let (mut entry, history) = match next {
            Some(pair) => pair,
            None => {
                // Idle: wait for the next enqueue. A stored permit (an
                // enqueue that raced ahead of this await) wakes immediately.
                wakeup.notified().await;
                continue;
            }
        };
        // The turn is handed `history + prompt`; its result echoes all of it
        // back. The fold below must skip the system message AND the handed
        // history — re-folding the history would duplicate it from the third
        // turn on.
        let history_len = history.len();
        // `mut`: a print steer turn can inherit it — the receipt rides along
        // to the follow-up turn instead of resolving here.
        let mut entry_outcome = entry.outcome.take();
        let PendingTurn {
            turn_id,
            prompt,
            input,
            origin,
            cancel,
            ..
        } = entry;
        let started = std::time::Instant::now();
        if let Some(slot) = &ctx.agent_cancel_slot {
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(
                crate::subagent::types::ParentCancel::from_flag(cancel.clone()),
            );
        }
        ctx.callbacks.turn_event(TurnEvent::Prompt {
            turn_id,
            input,
            origin: origin.clone(),
        });
        ctx.callbacks
            .turn_event(TurnEvent::Started { turn_id, origin });
        // Kept past the move into `run_session_turn` so the print settle can
        // observe a cancel that arrives while it holds the receipt.
        let turn_cancel = cancel.clone();
        let outcome = run_session_turn(&ctx, turn_id, prompt, cancel, history).await;
        // Captured before the print settle: a drain can hold the receipt for a
        // long time and must not inflate the turn's own reported duration.
        let turn_duration_ms = started.elapsed().as_millis() as u64;

        // `[background]` print policy (`kimi -p`): drain the session's
        // background tasks while the turn slot is still held, so the session
        // never reads as settled mid-drain and the follow-up decisions below
        // see the final task state. Resolving the receipt is what ends the
        // host's `prompt()`, so holding it here is what keeps the host free
        // of a settle loop of its own.
        let mut print_warnings = Vec::new();
        if outcome.is_ok() && !settle_print_background(&ctx, &turn_cancel).await {
            // Cut short by the ceiling (a cancel stays silent — the host asked
            // for it): v2 warned before finishing.
            if !turn_cancel.load(Ordering::SeqCst)
                && let Some(policy) = ctx.print_background
            {
                print_warnings.push(settle_warning(
                    "print.settle_ceiling",
                    format!(
                        "print settle ceiling reached ({}s), finishing",
                        policy.ceiling_s
                    ),
                ));
            }
        }
        // Follow-up producers, in v2's settle order (goal → cron → tasks) and
        // only for print runs: interactive sessions keep their per-turn
        // round-trips unchanged.
        let mut goal_continuation = None;
        let mut cron_followups = Vec::new();
        if outcome.is_ok() && ctx.print_background.is_some() {
            // `goal.continuation`: the turn loop renders the follow-up prompt
            // and reports it as telemetry, but no host consumes that event —
            // v2's host loop did the re-prompting and the native host never
            // wired it. A print run therefore owes the turn itself.
            goal_continuation = pending_goal_continuation(&ctx, &outcome).await;
            if goal_continuation.is_none() {
                cron_followups = pending_cron_followups(&ctx, &turn_cancel).await;
            }
        }

        // Fold the turn's final messages into the session history (system
        // message excluded — run_turn rebuilds it per turn), release the
        // active slot, and resolve steer receipts with the turn's outcome.
        let steer_receipts = {
            let mut core = core.lock().unwrap_or_else(|e| e.into_inner());
            core.active_turn_id = None;
            core.active_cancel = None;
            if let Some(slot) = &ctx.agent_cancel_slot {
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            if let Ok(TurnOutcome::Ran(result)) = &outcome {
                core.history
                    .extend(result.messages.iter().skip(1 + history_len).cloned());
                // P56 (G-5): remember how this turn executed for the
                // cross-process status surface.
                core.last_engine = Some(crate::rpc::types::EngineExecSummary {
                    transport: Some(result.llm_transport.clone()),
                    native_tool_calls: Some(result.native_tool_calls),
                    steps: Some(result.steps),
                    stop_reason: Some(format!("{:?}", result.stop_reason)),
                });
            } else if outcome.is_err() {
                core.last_engine = Some(crate::rpc::types::EngineExecSummary {
                    transport: None,
                    native_tool_calls: None,
                    steps: None,
                    stop_reason: Some("failed".into()),
                });
            }
            // `steer` / goal / cron: hand what the model is still owed back as
            // follow-up turns, before the idle gate below sees an empty queue.
            print_warnings.extend(maybe_enqueue_print_followup(
                &ctx,
                &mut core,
                &mut entry_outcome,
                goal_continuation,
                cron_followups,
            ));
            // Wake `settled()` waiters when nothing else is queued (M1c).
            maybe_settle_locked(&mut core);
            std::mem::take(&mut core.steer_waiters)
        };
        // Durable: the host folds this into `turnKey.lastEnded` and drives any
        // terminal-state display from it.
        if let Ok(TurnOutcome::Ran(result)) = &outcome {
            ctx.callbacks.turn_event(TurnEvent::Ended {
                turn_id,
                reason: end_reason_of(&result.stop_reason),
                error: turn_end_error_payload(&result.stop_reason, result.steps),
                duration_ms: Some(turn_duration_ms),
            });
        } else if let Err(e) = &outcome {
            ctx.callbacks.turn_event(TurnEvent::Ended {
                turn_id,
                reason: TurnEndReason::Failed,
                error: Some(serde_json::Value::String(e.clone())),
                duration_ms: Some(turn_duration_ms),
            });
        }
        for warning in print_warnings {
            ctx.callbacks.emit_event(warning);
        }
        if let Some(tx) = entry_outcome {
            let _ = tx.send(outcome.clone());
        }
        for (_, receipt) in steer_receipts {
            let _ = receipt.send(outcome.clone());
        }
    }
}

/// Hold a print-mode session open after a turn while background tasks are still
/// running, bounded by the run's `[background].print_wait_ceiling_s`.
///
/// Runs while the finished turn's slot is still held, before the history fold:
/// the session therefore never reads as settled mid-drain, and the follow-up
/// decision that follows sees the final task state. Returns whether the drain
/// completed — `false` means the ceiling (or a cancel) cut it short with tasks
/// still running. A no-op for `exit`, for an absent policy, and when the
/// process has no task runner wired.
async fn settle_print_background(ctx: &SessionContext, cancel: &AtomicBool) -> bool {
    let Some(policy) = ctx.print_background else {
        return true;
    };
    if !policy.mode.waits() {
        return true;
    }
    let Some(runner) = &ctx.task_runner else {
        return true;
    };
    // One deadline for the whole run, anchored at the first settle: v2's
    // ceiling bounds the entire settle phase (drain + steer turns), not each
    // turn's share of it.
    let deadline = {
        let mut state = ctx.print_run.lock().unwrap_or_else(|e| e.into_inner());
        *state.deadline.get_or_insert_with(|| {
            std::time::Instant::now() + std::time::Duration::from_secs(policy.ceiling_s)
        })
    };
    loop {
        // A cancelled turn ends the wait too: the host asked to stop, so
        // holding its receipt longer would only delay the stop.
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        if runner.running_ids().is_empty() {
            return true;
        }
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            return false;
        };
        tokio::time::sleep(remaining.min(PRINT_SETTLE_POLL)).await;
    }
}

/// The goal continuation a print run owes the model after a completed turn,
/// or `None`.
///
/// The turn loop renders the follow-up prompt and reports it as
/// `goal.continuation` telemetry, but no host consumes that event — v2's host
/// loop did the re-prompting and the native host never wired it. A print run
/// therefore owes the turn itself. Only a turn that *completed* with a still
/// `Active` goal continues: a failed turn surfaces through the receipt
/// instead, the way v2's `PrintSteeredTurnFailedError` did. Read before the
/// core lock because the provider is async.
async fn pending_goal_continuation(
    ctx: &SessionContext,
    outcome: &Result<TurnOutcome, String>,
) -> Option<String> {
    let Ok(TurnOutcome::Ran(result)) = outcome else {
        return None;
    };
    if end_reason_of(&result.stop_reason) != TurnEndReason::Completed {
        return None;
    }
    let goal = (ctx.goal.as_ref()?)().await?;
    if !goal.status.is_active() {
        return None;
    }
    Some(crate::native::goal::steering::render_continuation(
        &goal.objective,
        goal.tokens_used,
        goal.token_budget,
    ))
}

/// The cron jobs a print run owes the model, due within the run's remaining
/// ceiling, as `(prompt, origin)` pairs.
///
/// The native host has no cron dispatcher — `cron.fired` has producers only in
/// the daemon lineage, and the cron tools merely read and write the host's
/// registry — so a print run owns the firing itself: it sleeps until the
/// earliest fire within the ceiling, renders the fired prompts in the
/// documented `<cron-fire>` envelope (docs/reference/tools.md), and deletes
/// one-shot jobs from the registry after firing. Jobs whose fire time already
/// passed are the daemon's missed-fire territory (coalescing) and stay out of
/// scope; `KIMI_DISABLE_CRON=1` disables the whole feature.
async fn pending_cron_followups(
    ctx: &SessionContext,
    cancel: &AtomicBool,
) -> Vec<(String, serde_json::Value)> {
    if crate::turn_loop::retry::parse_truthy_env("KIMI_DISABLE_CRON") {
        return Vec::new();
    }
    let Some(policy) = ctx.print_background else {
        return Vec::new();
    };
    // One deadline for the whole run (shared with the drain; see
    // `settle_print_background`). No point sleeping for a fire the budget
    // will not allow.
    let deadline = {
        let mut state = ctx.print_run.lock().unwrap_or_else(|e| e.into_inner());
        *state.deadline.get_or_insert_with(|| {
            std::time::Instant::now() + std::time::Duration::from_secs(policy.ceiling_s)
        })
    };
    let Some(tasks) = read_cron_registry(ctx).await else {
        return Vec::new();
    };
    if tasks.is_empty() {
        return Vec::new();
    }
    let scheduler = crate::cron::scheduler::CronScheduler::new(tasks, local_utc_offset_minutes());
    let now = now_ms_epoch();
    let Some(fire_at) = scheduler.next_fire_at(now) else {
        return Vec::new();
    };
    // A fire past the ceiling will never run inside this run: leave it for
    // whatever ticks the registry next.
    let remaining_ms = deadline
        .checked_duration_since(std::time::Instant::now())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if fire_at - now > remaining_ms {
        return Vec::new();
    }

    // Sleep until the fire (plus a small grace so a just-due job is caught),
    // in poll-sized chunks so a cancel is observed promptly.
    let wake_at = fire_at + CRON_FIRE_GRACE_MS;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Vec::new();
        }
        let now = now_ms_epoch();
        if now >= wake_at {
            break;
        }
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            return Vec::new();
        };
        let until_wake = std::time::Duration::from_millis(
            (wake_at - now).min(remaining.as_millis() as i64) as u64,
        );
        tokio::time::sleep(
            until_wake
                .min(PRINT_SETTLE_POLL)
                .max(std::time::Duration::from_millis(1)),
        )
        .await;
    }

    // Fresh registry: jobs may have appeared or vanished while waiting.
    let Some(tasks) = read_cron_registry(ctx).await else {
        return Vec::new();
    };
    let mut scheduler =
        crate::cron::scheduler::CronScheduler::new(tasks, local_utc_offset_minutes());
    let fired = scheduler.tick(fire_at - CRON_FIRE_GRACE_MS, now_ms_epoch());
    let mut followups = Vec::with_capacity(fired.len());
    for entry in fired {
        // One-shot jobs auto-delete after firing (docs/reference/tools.md);
        // best-effort — the host owns the registry and may reject.
        if !entry.recurring {
            let _ = ctx
                .callbacks
                .state_write(crate::rpc::types::StateWriteRequest {
                    domain: "cron".into(),
                    key: "cron".into(),
                    value: serde_json::json!({ "action": "delete", "id": entry.id }),
                    undoable: false,
                    turn_id: String::new(),
                    tool_call_id: String::new(),
                })
                .await;
        }
        followups.push((render_cron_fire(&entry), cron_fire_origin(&entry)));
    }
    followups
}

/// The host's cron registry, as scheduler entries. `None` on an unwired state
/// bridge; entries missing `id` / `cron` / `prompt` are skipped (the create
/// path validates before storing, so this is defensive only).
async fn read_cron_registry(
    ctx: &SessionContext,
) -> Option<Vec<crate::cron::scheduler::CronEntry>> {
    let response = ctx
        .callbacks
        .state_read(crate::rpc::types::StateReadRequest {
            domain: "cron".into(),
            key: "cron".into(),
            turn_id: String::new(),
            tool_call_id: String::new(),
        })
        .await
        .ok()?;
    Some(
        response
            .value
            .as_array()?
            .iter()
            .filter_map(|task| {
                Some(crate::cron::scheduler::CronEntry {
                    id: task.get("id")?.as_str()?.to_string(),
                    cron: task.get("cron")?.as_str()?.to_string(),
                    prompt: task.get("prompt")?.as_str()?.to_string(),
                    recurring: task
                        .get("recurring")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(true),
                })
            })
            .collect(),
    )
}

/// The documented `<cron-fire>` envelope (docs/reference/tools.md): the fired
/// prompt wrapped in attributes the renderers strip before display. One fire
/// per tick here, so `coalescedCount` is always 1 and `stale` never applies
/// (the 7-day stale rule belongs to the long-lived daemon).
fn render_cron_fire(entry: &crate::cron::scheduler::CronEntry) -> String {
    format!(
        "<cron-fire jobId=\"{}\" cron=\"{}\" recurring=\"{}\" coalescedCount=\"1\" stale=\"false\">\n<prompt>\n{}\n</prompt>\n</cron-fire>",
        entry.id, entry.cron, entry.recurring, entry.prompt
    )
}

/// `CronJobOrigin` (protocol `events.ts`) — the transcript folds these as
/// cron cards rather than user prompts, exactly what a daemon-fired turn
/// looked like.
fn cron_fire_origin(entry: &crate::cron::scheduler::CronEntry) -> serde_json::Value {
    serde_json::json!({
        "kind": "cron_job",
        "jobId": entry.id,
        "cron": entry.cron,
        "recurring": entry.recurring,
        "coalescedCount": 1,
        "stale": false,
    })
}

/// A `WarningEvent` (protocol `events.ts`) for a print run's settle-side
/// warnings; the host renders it wherever its own warnings go.
fn settle_warning(code: &str, message: String) -> serde_json::Value {
    serde_json::json!({ "type": "warning", "message": message, "code": code })
}

/// The process's local UTC offset in minutes east of UTC — the cron module's
/// `tz_offset_minutes`. std has no local-time API; chrono reads the system
/// zone on every platform the crate builds for.
fn local_utc_offset_minutes() -> i32 {
    // `DateTime::offset()` is inherent on chrono's `DateTime<Local>` — no
    // trait import needed.
    chrono::Local::now().offset().local_minus_utc() / 60
}

fn now_ms_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Enqueue the print run's follow-up turns, if the model is owed any, and
/// return the settle warnings the host should see.
///
/// Called under the core lock, before the idle gate: follow-up turns enter
/// `pending` first, so `settled()` waiters and session teardown see a session
/// that is still working. The first follow-up turn inherits the finished
/// turn's receipt (`entry_outcome`), which is what keeps the host's `prompt()`
/// pending until the last follow-up has run — the host stays free of any wait
/// loop.
///
/// Priority follows v2's settle order: the goal continuation, then due cron
/// jobs, then completed background tasks (only in `steer` mode — `drain`
/// waits without feeding back). A pending notification keeps for the
/// follow-up turn's own settle round. Notifications are consumed only once
/// their turn is actually admitted, so a budgeted-out run leaves them queued
/// rather than dropping them silently.
fn maybe_enqueue_print_followup(
    ctx: &SessionContext,
    core: &mut Core,
    entry_outcome: &mut Option<oneshot::Sender<Result<TurnOutcome, String>>>,
    goal_continuation: Option<String>,
    cron_followups: Vec<(String, serde_json::Value)>,
) -> Vec<serde_json::Value> {
    let Some(policy) = ctx.print_background else {
        return Vec::new();
    };

    // Is the model owed anything? The budget warnings only fire when a
    // pending follow-up is actually refused.
    let tasks_pending = policy.mode == PrintBackgroundMode::Steer
        && ctx
            .task_runner
            .as_ref()
            .is_some_and(|runner| runner.pending_notification_count() > 0);
    if goal_continuation.is_none() && cron_followups.is_empty() && !tasks_pending {
        return Vec::new();
    }

    // One ceiling and one turn budget for the whole run: v2 bounded the goal,
    // cron, and task turns of a settle phase alike, and `print_max_turns` is
    // documented as the cap on *triggered* turns, not per producer.
    let mut state = ctx.print_run.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = state.deadline.get_or_insert_with(|| {
        std::time::Instant::now() + std::time::Duration::from_secs(policy.ceiling_s)
    });
    let mut warnings = Vec::new();
    if std::time::Instant::now() >= *deadline {
        warnings.push(settle_warning(
            "print.settle_ceiling",
            format!(
                "print settle ceiling reached ({}s), finishing",
                policy.ceiling_s
            ),
        ));
        return warnings;
    }
    if state.steer_turns >= policy.max_turns as usize {
        warnings.push(settle_warning(
            "print.settle_max_turns",
            format!(
                "print steer max turns reached ({}), finishing",
                policy.max_turns
            ),
        ));
        return warnings;
    }

    if let Some(text) = goal_continuation {
        state.steer_turns += 1;
        enqueue_print_followup_turn(
            core,
            entry_outcome,
            text,
            // `SystemTriggerOrigin(name: goal_continuation)`: the transcript
            // folds these as their own turn-opening system trigger, exactly
            // what a v2 goal continuation looked like.
            serde_json::json!({ "kind": "system_trigger", "name": "goal_continuation" }),
        );
        return warnings;
    }

    let mut enqueued = false;
    for (text, origin) in cron_followups {
        if state.steer_turns >= policy.max_turns as usize {
            break;
        }
        state.steer_turns += 1;
        enqueue_print_followup_turn(core, entry_outcome, text, origin);
        enqueued = true;
    }
    if enqueued {
        return warnings;
    }

    if policy.mode != PrintBackgroundMode::Steer {
        return warnings;
    }
    let Some(runner) = &ctx.task_runner else {
        return warnings;
    };
    if runner.pending_notification_count() == 0 {
        return warnings;
    }
    let notifications = runner.take_pending_notifications();
    let Some(first) = notifications.first() else {
        return warnings;
    };
    state.steer_turns += 1;
    let text = render_task_notifications(&notifications);
    enqueue_print_followup_turn(
        core,
        entry_outcome,
        text,
        // `TaskOrigin` (protocol `events.ts`): the transcript folds these as
        // task-notification turns instead of user prompts. The first task
        // names the turn; the rest ride in the prompt text.
        serde_json::json!({
            "kind": "task",
            "taskId": first.task_id,
            "status": first.status.as_str(),
            "notificationId": format!("{}-{}", first.task_id, first.ended_at),
        }),
    );
    warnings
}

/// Push the follow-up turn: the model sees the rendered text as a user
/// message, the host sees the same text echoed as the `turn.prompt` input, and
/// the finished turn's receipt rides along so `prompt()` resolves only when
/// this turn ends.
fn enqueue_print_followup_turn(
    core: &mut Core,
    entry_outcome: &mut Option<oneshot::Sender<Result<TurnOutcome, String>>>,
    text: String,
    origin: serde_json::Value,
) {
    let turn_id = core.next_turn_id;
    core.next_turn_id += 1;
    core.pending.push(PendingTurn {
        turn_id,
        prompt: LLMMessage {
            role: "user".to_string(),
            content: text.clone(),
            ..LLMMessage::default()
        },
        // The `ContentPart[]` echo the host renders for `turn.prompt`; a
        // single text part is the whole story here.
        input: serde_json::json!([{ "type": "text", "text": text }]),
        origin,
        cancel: Arc::new(AtomicBool::new(false)),
        outcome: entry_outcome.take(),
    });
}

/// The user-role text a steer turn hands the model: one block per completed
/// background task, plus its output preview when the runner kept one.
fn render_task_notifications(notifications: &[crate::storage::TaskNotification]) -> String {
    notifications
        .iter()
        .map(|notification| {
            let mut block = format!(
                "Background task {} ({}) finished: {}",
                notification.task_id,
                notification.status.as_str(),
                notification.description
            );
            if let Some(preview) = &notification.output_preview {
                block.push('\n');
                block.push_str(preview);
            }
            block
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Map the engine's step-level stop reason onto v2's four-value turn end
/// reason. `MaxTokens` is a finish reason on a response the model did
/// produce, so the turn completed; `Filtered` and the step-budget
/// exhaustion (`max_steps`) fail the turn in v2 (loopService.ts:877-882 and
/// :956-962); `Paused` / `BudgetLimited` stop because the goal cannot
/// progress right now, which v2 reports as blocked; `Aborted` is the
/// cancellation flag (also how a blocked goal stops).
fn end_reason_of(stop: &crate::turn_loop::types::LoopTurnStopReason) -> TurnEndReason {
    use crate::turn_loop::types::LoopTurnStopReason as Stop;
    match stop {
        Stop::EndTurn | Stop::MaxTokens | Stop::RepeatBreaker => TurnEndReason::Completed,
        Stop::Paused | Stop::BudgetLimited => TurnEndReason::Blocked,
        Stop::Aborted => TurnEndReason::Cancelled,
        Stop::Filtered | Stop::MaxSteps | Stop::Unknown => TurnEndReason::Failed,
    }
}

/// The `error` payload v2 puts on `turn.ended` for failing reasons
/// (loop.ts:20-27 `createMaxStepsExceededError`, loopService.ts:877-882
/// `PROVIDER_FILTERED`). `None` for reasons that end the turn cleanly.
fn turn_end_error_payload(
    stop: &crate::turn_loop::types::LoopTurnStopReason,
    steps: u32,
) -> Option<serde_json::Value> {
    use crate::turn_loop::types::LoopTurnStopReason as Stop;
    match stop {
        Stop::MaxSteps => Some(serde_json::Value::String(format!(
            "Turn exceeded maxSteps={steps}. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run \"/update-config\" to update it, then \"/reload\"."
        ))),
        Stop::Filtered => Some(serde_json::Value::String(
            "Provider safety policy blocked the response.".into(),
        )),
        _ => None,
    }
}

async fn run_session_turn(
    ctx: &Arc<SessionContext>,
    turn_id: u64,
    prompt: LLMMessage,
    cancel: Arc<AtomicBool>,
    history: Vec<LLMMessage>,
) -> Result<TurnOutcome, String> {
    if let Some(hook) = &ctx.on_before_turn {
        hook();
    }
    let tool_defs = (ctx.tool_defs)().await;
    let goal = match ctx.goal.as_ref() {
        Some(provider) => provider().await,
        None => None,
    };
    let mut messages = history;
    messages.push(prompt);
    let input = RunTurnInput {
        max_attempts: ctx.max_attempts,
        turn_id: format!("turn-{turn_id}"),
        llm: ctx.llm.as_ref(),
        messages,
        tools: &[],
        tool_defs,
        max_steps: ctx.max_steps,
        max_context_tokens: ctx.max_context_tokens,
        goal,
        cancellation: Some(cancel),
        hook_guard: ctx.hook_guard.clone(),
    };
    let result = run_turn_continued(input, &ctx.callbacks)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TurnOutcome::Ran(result))
}

/// Callbacks decorator: serves the session's steer queue through the
/// `drain_steers` seam the turn loop already consumes (native transports
/// only — in host-proxy mode the host owns steering). Everything else
/// delegates unchanged.
pub(crate) struct SteerQueueCallbacks {
    inner: Arc<dyn HostCallbacks>,
    steer_queue: Arc<Mutex<Vec<LLMMessage>>>,
}

impl SteerQueueCallbacks {
    pub(crate) fn new(
        inner: Arc<dyn HostCallbacks>,
        steer_queue: Arc<Mutex<Vec<LLMMessage>>>,
    ) -> Self {
        Self { inner, steer_queue }
    }
}

impl HostCallbacks for SteerQueueCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.inner.execute_tool(request)
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<PermissionDecision, String>> {
        self.inner.check_permission(request)
    }

    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<AskQuestionResponse, String>> {
        self.inner.ask_question(request)
    }

    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<StateReadResponse, String>> {
        self.inner.state_read(request)
    }

    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<StateWriteResponse, String>> {
        self.inner.state_write(request)
    }

    fn drain_steers(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<Vec<LLMMessage>, String>> {
        let queue = self.steer_queue.clone();
        Box::pin(async move {
            let drained = std::mem::take(&mut *queue.lock().unwrap_or_else(|e| e.into_inner()));
            Ok(drained)
        })
    }

    fn list_tools(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<ListToolsResponse, String>> {
        self.inner.list_tools()
    }

    fn goal(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<Option<GoalContext>, String>> {
        self.inner.goal()
    }

    fn auth_token(
        &self,
        provider: String,
        force: bool,
    ) -> futures_util::future::BoxFuture<'static, Result<String, String>> {
        self.inner.auth_token(provider, force)
    }

    fn set_turn_goal(&self, turn_id: &str, goal_id: Option<&str>) {
        self.inner.set_turn_goal(turn_id, goal_id);
    }

    fn emit_event(&self, event: serde_json::Value) {
        self.inner.emit_event(event);
    }

    fn turn_event(&self, event: TurnEvent) {
        self.inner.turn_event(event);
    }

    fn telemetry(&self, event: serde_json::Value) {
        self.inner.telemetry(event);
    }

    fn cancel_llm_chat(&self, request_id: &str) {
        self.inner.cancel_llm_chat(request_id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::callbacks::RpcHostCallbacks;
    use crate::rpc::server::RpcServer;
    use crate::rpc::types::TokenUsage;
    use crate::turn_loop::types::{LLMChatParams, LLMChatResponse};

    struct ScriptedLlm {
        requests: Arc<std::sync::Mutex<Vec<Vec<LLMMessage>>>>,
        /// One entry per call: `None` = no gate, `Some(rx)` = await before
        /// returning. `simple(...)` leaves the vec empty; `with_gate(...)`
        /// fills it with one Some per response.
        gates: Arc<std::sync::Mutex<Vec<Option<tokio::sync::oneshot::Receiver<()>>>>>,
        responses: Arc<std::sync::Mutex<Vec<LLMChatResponse>>>,
    }

    impl ScriptedLlm {
        fn simple(responses: Vec<LLMChatResponse>) -> Self {
            Self {
                requests: Arc::new(std::sync::Mutex::new(Vec::new())),
                gates: Arc::new(std::sync::Mutex::new(Vec::new())),
                responses: Arc::new(std::sync::Mutex::new(responses)),
            }
        }

        fn with_gate(
            responses: Vec<LLMChatResponse>,
        ) -> (Self, Vec<tokio::sync::oneshot::Sender<()>>) {
            let mut senders = Vec::new();
            let gates: Vec<Option<tokio::sync::oneshot::Receiver<()>>> = (0..responses.len())
                .map(|_| {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    senders.push(tx);
                    Some(rx)
                })
                .collect();
            (
                Self {
                    requests: Arc::new(std::sync::Mutex::new(Vec::new())),
                    gates: Arc::new(std::sync::Mutex::new(gates)),
                    responses: Arc::new(std::sync::Mutex::new(responses)),
                },
                senders,
            )
        }
    }

    impl LLM for ScriptedLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "scripted-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn transport(&self) -> &'static str {
            "native-http"
        }
        fn chat(
            &self,
            params: LLMChatParams,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>,
        > {
            let resp = self
                .responses
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(0);
            let gate = self.gates.lock().unwrap_or_else(|e| e.into_inner()).pop();
            self.requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(params.messages.to_vec());
            Box::pin(async move {
                if let Some(rx) = gate.and_then(|g| g) {
                    let _ = rx.await;
                }
                Ok(resp)
            })
        }
    }

    fn text_response(text: &str) -> LLMChatResponse {
        LLMChatResponse {
            content: text.into(),
            thinking: Vec::new(),
            tool_calls: Vec::new(),
            finish_reason: Some("stop".into()),
            usage: TokenUsage::default(),
        }
    }

    fn rpc_callbacks(server: Arc<RpcServer>) -> Arc<dyn HostCallbacks> {
        // The engine pulls the tool table before every LLM call (M1d) and the
        // goal/plan injection snapshot reads the state bridge at each step
        // head (M4). With no local handler the server falls back to a stdio
        // round-trip that stalls for the full timeout, so the session tests
        // answer both here.
        RpcServer::register_arc(
            &server,
            crate::rpc::types::methods::HOST_LIST_TOOLS,
            |_params| {
                Box::pin(async move {
                    let resp = crate::rpc::types::ListToolsResponse { tools: vec![] };
                    serde_json::to_value(&resp)
                        .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e.to_string()))
                })
            },
        );
        RpcServer::register_arc(
            &server,
            crate::rpc::types::methods::HOST_STATE_READ,
            |_params| {
                Box::pin(async move {
                    let resp = crate::rpc::types::StateReadResponse {
                        value: serde_json::Value::Null,
                    };
                    serde_json::to_value(&resp)
                        .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e.to_string()))
                })
            },
        );
        Arc::new(RpcHostCallbacks { server })
    }

    fn msg(role: &str, content: &str) -> LLMMessage {
        LLMMessage {
            role: role.into(),
            content: content.into(),
            ..Default::default()
        }
    }

    async fn make_session(llm: Arc<dyn LLM>, callbacks: Arc<dyn HostCallbacks>) -> EngineSession {
        let config = SessionConfig {
            llm,
            callbacks,
            max_steps: 5,
            max_attempts: None,
            max_context_tokens: None,
            tool_defs: Arc::new(|| Box::pin(async { Vec::new() })),
            goal: None,
            on_before_turn: None,
            agent_cancel_slot: None,
            hook_guard: None,
            print_background: None,
            task_runner: None,
        };
        EngineSession::new(config).await
    }

    async fn wait_until<F: FnMut() -> bool>(mut pred: F) {
        for _ in 0..1000 {
            if pred() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("condition not met after yield loop");
    }

    /// `[background].print_background_mode` wire mapping: only `drain` /
    /// `steer` hold a turn receipt, and an unrecognised mode must resolve to
    /// `exit` so a typo cannot stall a run behind the ceiling.
    #[test]
    fn test_print_background_mode_from_wire() {
        assert_eq!(
            PrintBackgroundMode::from_wire("drain"),
            PrintBackgroundMode::Drain
        );
        assert_eq!(
            PrintBackgroundMode::from_wire("steer"),
            PrintBackgroundMode::Steer
        );
        assert_eq!(
            PrintBackgroundMode::from_wire("exit"),
            PrintBackgroundMode::Exit
        );
        assert_eq!(
            PrintBackgroundMode::from_wire("wat"),
            PrintBackgroundMode::Exit
        );
        assert!(PrintBackgroundMode::Drain.waits());
        assert!(PrintBackgroundMode::Steer.waits());
        assert!(!PrintBackgroundMode::Exit.waits());
    }

    /// The steer prompt the engine hands the model: one block per completed
    /// task, with the output preview attached when the runner kept one.
    #[test]
    fn test_render_task_notifications() {
        use crate::storage::{TaskNotification, TaskStatus};
        let rendered = render_task_notifications(&[
            TaskNotification {
                task_id: 't'.to_string(),
                description: "run the test suite".into(),
                status: TaskStatus::Completed,
                output_preview: Some("42 passing".into()),
                ended_at: 100,
            },
            TaskNotification {
                task_id: "t2".into(),
                description: "stop me".into(),
                status: TaskStatus::Killed,
                output_preview: None,
                ended_at: 200,
            },
        ]);
        assert_eq!(
            rendered,
            "Background task t (completed) finished: run the test suite\n42 passing\n\n\
             Background task t2 (killed) finished: stop me"
        );
    }

    /// `steer`: a completed background task is fed back to the model as a
    /// follow-up turn, and the original turn's receipt stays pending until that
    /// follow-up has run — the host's `prompt()` covers the whole run.
    #[tokio::test]
    async fn test_print_steer_feeds_task_notifications_back() {
        let runner = Arc::new(crate::storage::TaskRunner::new(None));
        runner
            .spawn_task("t1".into(), "quick job".into(), async {
                "done output".to_string()
            })
            .unwrap();
        wait_until(|| runner.pending_notification_count() == 1).await;

        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![
            text_response("main-response"),
            text_response("steer-response"),
        ]));
        let requests = llm.requests.clone();
        let config = SessionConfig {
            llm,
            callbacks: rpc_callbacks(server),
            max_steps: 5,
            max_attempts: None,
            max_context_tokens: None,
            tool_defs: Arc::new(|| Box::pin(async { Vec::new() })),
            goal: None,
            on_before_turn: None,
            agent_cancel_slot: None,
            hook_guard: None,
            print_background: Some(PrintBackgroundPolicy {
                mode: PrintBackgroundMode::Steer,
                ceiling_s: 30,
                max_turns: 5,
            }),
            task_runner: Some(runner),
        };
        let session = EngineSession::new(config).await;

        let mut receipt = session
            .enqueue_turn(TurnRequest::user(msg("user", "hello"), Admission::NewTurn))
            .unwrap();
        let outcome = receipt.outcome().await.unwrap();
        assert!(matches!(outcome, TurnOutcome::Ran(_)));

        let calls = requests.lock().unwrap();
        assert_eq!(calls.len(), 2, "steer must run one follow-up turn");
        let steer_call = &calls[1];
        assert!(
            steer_call.iter().any(|m| {
                m.role == "user"
                    && m.content
                        .contains("Background task t1 (completed) finished: quick job")
                    && m.content.contains("done output")
            }),
            "steer turn missing the task notification: {steer_call:?}"
        );
        assert!(
            steer_call
                .iter()
                .any(|m| m.role == "assistant" && m.content == "main-response"),
            "steer turn history missing the main turn's answer"
        );
    }

    /// A print run with an active goal continues the goal itself: the turn
    /// loop renders the follow-up prompt (v2's host loop re-prompted, and no
    /// native host consumes `goal.continuation`), and the receipt rides along
    /// until the continuation turn has run. `drain` on purpose — the goal
    /// continuation is mode-independent, the way v2's goal wait preceded the
    /// mode check. `max_turns: 1` also proves the shared budget stops the
    /// loop: the provider here never completes its goal, so an unbounded run
    /// would spin forever.
    #[tokio::test]
    async fn test_print_run_continues_active_goal() {
        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![
            text_response("main-response"),
            text_response("goal-response"),
        ]));
        let requests = llm.requests.clone();
        let goal: GoalProvider = Arc::new(|| {
            Box::pin(async {
                Some(crate::turn_loop::types::GoalContext {
                    goal_id: "g1".into(),
                    objective: "ship the thing".into(),
                    status: crate::turn_loop::types::GoalStatus::Active,
                    token_budget: None,
                    turn_budget: None,
                    wall_clock_budget_ms: None,
                    wall_clock_ms: 0,
                    tokens_used: 100,
                    turns_used: 1,
                })
            })
        });
        let config = SessionConfig {
            llm,
            callbacks: rpc_callbacks(server),
            max_steps: 5,
            max_attempts: None,
            max_context_tokens: None,
            tool_defs: Arc::new(|| Box::pin(async { Vec::new() })),
            goal: Some(goal),
            on_before_turn: None,
            agent_cancel_slot: None,
            hook_guard: None,
            print_background: Some(PrintBackgroundPolicy {
                mode: PrintBackgroundMode::Drain,
                ceiling_s: 30,
                max_turns: 1,
            }),
            task_runner: Some(Arc::new(crate::storage::TaskRunner::new(None))),
        };
        let session = EngineSession::new(config).await;

        let mut receipt = session
            .enqueue_turn(TurnRequest::user(msg("user", "hello"), Admission::NewTurn))
            .unwrap();
        let outcome = receipt.outcome().await.unwrap();
        assert!(matches!(outcome, TurnOutcome::Ran(_)));

        let calls = requests.lock().unwrap();
        assert_eq!(
            calls.len(),
            2,
            "one goal continuation, then the shared budget stops the loop"
        );
        let continuation = &calls[1];
        assert!(
            continuation
                .iter()
                .any(|m| m.role == "user" && m.content.contains("ship the thing")),
            "continuation turn missing the goal objective: {continuation:?}"
        );
        assert!(
            continuation
                .iter()
                .any(|m| m.role == "assistant" && m.content == "main-response"),
            "continuation turn history missing the main turn's answer"
        );
    }

    /// The cron fire a print run injects: the documented `<cron-fire>`
    /// envelope (renderers strip it before display) with the `CronJobOrigin`
    /// the transcript folds into a cron card.
    #[test]
    fn test_render_cron_fire_matches_documented_envelope() {
        let entry = crate::cron::scheduler::CronEntry {
            id: "a3f9c2".into(),
            cron: "*/5 * * * *".into(),
            prompt: "Check the deploy status".into(),
            recurring: true,
        };
        assert_eq!(
            render_cron_fire(&entry),
            "<cron-fire jobId=\"a3f9c2\" cron=\"*/5 * * * *\" recurring=\"true\" coalescedCount=\"1\" stale=\"false\">\n<prompt>\nCheck the deploy status\n</prompt>\n</cron-fire>"
        );
        assert_eq!(
            cron_fire_origin(&entry),
            serde_json::json!({
                "kind": "cron_job",
                "jobId": "a3f9c2",
                "cron": "*/5 * * * *",
                "recurring": true,
                "coalescedCount": 1,
                "stale": false,
            })
        );
    }

    #[tokio::test]
    async fn test_history_accumulates_across_turns() {
        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![
            text_response("first-response"),
            text_response("second-response"),
        ]));
        let requests = llm.requests.clone();
        let session = make_session(llm, rpc_callbacks(server)).await;

        let mut r1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "hello"), Admission::NewTurn))
            .unwrap();
        let mut r2 = session
            .enqueue_turn(TurnRequest::user(msg("user", "world"), Admission::NewTurn))
            .unwrap();
        let o1 = r1.outcome().await.unwrap();
        let o2 = r2.outcome().await.unwrap();
        assert!(matches!(o1, TurnOutcome::Ran(_)));
        assert!(matches!(o2, TurnOutcome::Ran(_)));

        let calls = requests.lock().unwrap();
        assert_eq!(calls.len(), 2);
        let turn2 = &calls[1];
        assert!(
            turn2
                .iter()
                .any(|m| m.role == "assistant" && m.content == "first-response"),
            "turn 2 history missing turn 1 assistant: {turn2:?}"
        );
        assert!(
            turn2
                .iter()
                .any(|m| m.role == "user" && m.content == "world")
        );
    }

    /// The fold must not re-include the history a turn was handed: from the
    /// third turn on, a re-folding fold would duplicate every earlier message
    /// in the model's context.
    #[tokio::test]
    async fn test_history_does_not_duplicate_across_three_turns() {
        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![
            text_response("first-response"),
            text_response("second-response"),
            text_response("third-response"),
        ]));
        let requests = llm.requests.clone();
        let session = make_session(llm, rpc_callbacks(server)).await;

        for prompt in ["hello", "world", "again"] {
            let mut receipt = session
                .enqueue_turn(TurnRequest::user(msg("user", prompt), Admission::NewTurn))
                .unwrap();
            assert!(matches!(
                receipt.outcome().await.unwrap(),
                TurnOutcome::Ran(_)
            ));
        }

        let calls = requests.lock().unwrap();
        assert_eq!(calls.len(), 3);
        let turn3 = &calls[2];
        let hello_count = turn3
            .iter()
            .filter(|m| m.role == "user" && m.content == "hello")
            .count();
        assert_eq!(
            hello_count, 1,
            "turn 3 context must carry each earlier message exactly once: {turn3:?}"
        );
        assert!(
            turn3
                .iter()
                .any(|m| m.role == "assistant" && m.content == "second-response"),
            "turn 3 history missing turn 2 assistant: {turn3:?}"
        );
        assert!(
            turn3
                .iter()
                .any(|m| m.role == "user" && m.content == "again")
        );
    }

    #[tokio::test]
    async fn test_pending_turns_run_in_fifo_order() {
        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![
            text_response("1"),
            text_response("2"),
            text_response("3"),
        ]));
        let session = make_session(llm, rpc_callbacks(server)).await;
        let mut r1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "a"), Admission::NewTurn))
            .unwrap();
        let mut r2 = session
            .enqueue_turn(TurnRequest::user(msg("user", "b"), Admission::NewTurn))
            .unwrap();
        let mut r3 = session
            .enqueue_turn(TurnRequest::user(msg("user", "c"), Admission::NewTurn))
            .unwrap();
        let o1 = r1.outcome().await.unwrap();
        let o2 = r2.outcome().await.unwrap();
        let o3 = r3.outcome().await.unwrap();
        assert!(matches!(o1, TurnOutcome::Ran(_)));
        assert!(matches!(o2, TurnOutcome::Ran(_)));
        assert!(matches!(o3, TurnOutcome::Ran(_)));
        let status = session.status();
        assert!(status.active_turn_id.is_none());
        assert!(status.pending_turn_ids.is_empty());
    }

    #[tokio::test]
    async fn test_cancel_queued_turn_resolves_immediately() {
        let (llm, gates) = ScriptedLlm::with_gate(vec![text_response("first")]);
        let llm = Arc::new(llm);
        let requests = llm.requests.clone();
        let server = Arc::new(RpcServer::new());
        let session = make_session(llm, rpc_callbacks(server)).await;

        let mut r1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "first"), Admission::NewTurn))
            .unwrap();
        wait_until(|| !requests.lock().unwrap().is_empty()).await;
        let mut r2 = session
            .enqueue_turn(TurnRequest::user(msg("user", "second"), Admission::NewTurn))
            .unwrap();
        assert!(session.cancel_turn(Some(r2.turn_id)));
        let o2 = r2.outcome().await.unwrap();
        assert!(matches!(o2, TurnOutcome::CancelledBeforeStart));
        gates.into_iter().next().unwrap().send(()).unwrap();
        let o1 = r1.outcome().await.unwrap();
        assert!(matches!(o1, TurnOutcome::Ran(_)));
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_active_or_new_steers_when_active() {
        let (llm, gates) = ScriptedLlm::with_gate(vec![text_response("active-response")]);
        let llm = Arc::new(llm);
        let server = Arc::new(RpcServer::new());
        let session = make_session(llm, rpc_callbacks(server)).await;

        let mut r1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "first"), Admission::NewTurn))
            .unwrap();
        wait_until(|| session.status().active_turn_id == Some(r1.turn_id)).await;
        let mut r2 = session
            .enqueue_turn(TurnRequest::user(
                msg("user", "steer-me"),
                Admission::ActiveOrNewTurn,
            ))
            .unwrap();
        assert_eq!(r2.turn_id, r1.turn_id);
        gates.into_iter().next().unwrap().send(()).unwrap();
        let o1 = r1.outcome().await.unwrap();
        let o2 = r2.outcome().await.unwrap();
        assert!(matches!(o1, TurnOutcome::Ran(_)));
        assert!(matches!(o2, TurnOutcome::Ran(_)));
    }

    #[tokio::test]
    async fn test_active_turn_only_without_active_errors() {
        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![]));
        let session = make_session(llm, rpc_callbacks(server)).await;
        let result = session.enqueue_turn(TurnRequest::user(
            msg("user", "x"),
            Admission::ActiveTurnOnly,
        ));
        assert!(result.is_err());
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("expected ActiveTurnOnly without an active turn to error"),
        };
        assert!(err.contains("requires an active turn"));
    }

    #[tokio::test]
    async fn test_pump_wakes_after_idle_gap() {
        // Regression: the handle must share the pump's wakeup `Notify`. With a
        // second one, an enqueue arriving after the pump parked for an idle gap
        // never woke it — the REPL hung on its second prompt.
        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![
            text_response("one"),
            text_response("two"),
        ]));
        let session = make_session(llm, rpc_callbacks(server)).await;

        let mut r1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "a"), Admission::NewTurn))
            .unwrap();
        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(5), r1.outcome())
                .await
                .expect("turn 1 never ran"),
            Ok(TurnOutcome::Ran(_))
        ));

        // Let the pump reach its idle await before the next enqueue.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let mut r2 = session
            .enqueue_turn(TurnRequest::user(msg("user", "b"), Admission::NewTurn))
            .unwrap();
        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(5), r2.outcome())
                .await
                .expect("turn 2 never ran — pump stayed parked after the idle gap"),
            Ok(TurnOutcome::Ran(_))
        ));
    }

    /// Records every turn event and answers the `turn` state domain from a
    /// fixed value, so clock hydration and event dispatch share one harness.
    struct TurnRecordingCallbacks {
        events: Arc<Mutex<Vec<TurnEvent>>>,
        turn_state: serde_json::Value,
    }

    impl TurnRecordingCallbacks {
        fn new(turn_state: serde_json::Value) -> (Self, Arc<Mutex<Vec<TurnEvent>>>) {
            let events = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    events: events.clone(),
                    turn_state,
                },
                events,
            )
        }
    }

    impl HostCallbacks for TurnRecordingCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> futures_util::future::BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> futures_util::future::BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> futures_util::future::BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }
        fn state_read(
            &self,
            request: StateReadRequest,
        ) -> futures_util::future::BoxFuture<'static, Result<StateReadResponse, String>> {
            let value = if request.domain == "turn" {
                self.turn_state.clone()
            } else {
                serde_json::Value::Null
            };
            Box::pin(async move { Ok(StateReadResponse { value }) })
        }
        fn turn_event(&self, event: TurnEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    fn recorded(events: &Arc<Mutex<Vec<TurnEvent>>>) -> Vec<TurnEvent> {
        events.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn test_turn_events_dispatch_in_order() {
        let (callbacks, events) = TurnRecordingCallbacks::new(serde_json::json!({}));
        let llm = Arc::new(ScriptedLlm::simple(vec![text_response("answer")]));
        let session = make_session(llm, Arc::new(callbacks)).await;

        let mut receipt = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "hello"),
                admission: Admission::NewTurn,
                input: serde_json::json!([{"type": "text", "text": "hello"}]),
                origin: serde_json::json!({"kind": "user"}),
            })
            .unwrap();
        receipt.outcome().await.unwrap();

        let seen = recorded(&events);
        assert_eq!(seen.len(), 3, "prompt + started + ended: {seen:?}");
        assert_eq!(
            seen[0],
            TurnEvent::Prompt {
                turn_id: 0,
                input: serde_json::json!([{"type": "text", "text": "hello"}]),
                origin: serde_json::json!({"kind": "user"}),
            },
            "the host's own payload must come back unchanged"
        );
        assert_eq!(
            seen[1],
            TurnEvent::Started {
                turn_id: 0,
                origin: serde_json::json!({"kind": "user"}),
            }
        );
        match &seen[2] {
            TurnEvent::Ended {
                turn_id,
                reason,
                error,
                duration_ms,
            } => {
                assert_eq!(*turn_id, 0);
                assert_eq!(*reason, TurnEndReason::Completed);
                assert!(error.is_none());
                assert!(duration_ms.is_some());
            }
            other => panic!("expected turn.ended, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_cancel_dispatches_turn_cancel() {
        let (llm, gates) = ScriptedLlm::with_gate(vec![text_response("first")]);
        let llm = Arc::new(llm);
        let (callbacks, events) = TurnRecordingCallbacks::new(serde_json::json!({}));
        let session = make_session(llm, Arc::new(callbacks)).await;

        let mut r1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "first"), Admission::NewTurn))
            .unwrap();
        wait_until(|| session.status().active_turn_id == Some(r1.turn_id)).await;
        let r2 = session
            .enqueue_turn(TurnRequest::user(msg("user", "second"), Admission::NewTurn))
            .unwrap();

        assert!(session.cancel_turn(Some(r2.turn_id)));
        assert!(recorded(&events).contains(&TurnEvent::Cancel {
            turn_id: Some(r2.turn_id),
            target: Some(TurnCancelTarget::Queued),
            reason: Some(TurnCancelReason::UserCancelled),
        }));

        assert!(session.cancel_turn(Some(r1.turn_id)));
        assert!(recorded(&events).contains(&TurnEvent::Cancel {
            turn_id: Some(r1.turn_id),
            target: Some(TurnCancelTarget::Active),
            reason: Some(TurnCancelReason::UserCancelled),
        }));

        gates.into_iter().next().unwrap().send(()).unwrap();
        r1.outcome().await.unwrap();
        assert!(!session.cancel_turn(Some(9999)));
        assert_eq!(
            recorded(&events)
                .iter()
                .filter(|e| matches!(e, TurnEvent::Cancel { .. }))
                .count(),
            2,
            "an id matching nothing must not report a cancellation"
        );
    }

    #[tokio::test]
    async fn test_clock_continues_host_turn_sequence() {
        // A resumed session keeps counting where the host's fold left off
        // (v2 `turnKey.nextTurnId` is 0-based), rather than restarting at zero.
        let (callbacks, events) =
            TurnRecordingCallbacks::new(serde_json::json!({ "nextTurnId": 41 }));
        let llm = Arc::new(ScriptedLlm::simple(vec![text_response("ok")]));
        let session = make_session(llm, Arc::new(callbacks)).await;

        let mut receipt = session
            .enqueue_turn(TurnRequest::user(
                msg("user", "after resume"),
                Admission::NewTurn,
            ))
            .unwrap();
        assert_eq!(receipt.turn_id, 41);
        receipt.outcome().await.unwrap();
        assert!(matches!(
            recorded(&events)[0],
            TurnEvent::Prompt { turn_id: 41, .. }
        ));
    }

    #[tokio::test]
    async fn test_host_without_turn_domain_starts_at_zero() {
        let server = Arc::new(RpcServer::new());
        let llm = Arc::new(ScriptedLlm::simple(vec![text_response("ok")]));
        // RpcHostCallbacks has no state bridge wired, so the read fails.
        let session = make_session(llm, rpc_callbacks(server)).await;
        let receipt = session
            .enqueue_turn(TurnRequest::user(
                msg("user", "first-ever"),
                Admission::NewTurn,
            ))
            .unwrap();
        assert_eq!(receipt.turn_id, 0);
    }

    #[test]
    fn turn_end_reasons_map_onto_v2s_four_values() {
        use crate::turn_loop::types::LoopTurnStopReason as Stop;
        let cases = [
            (Stop::EndTurn, TurnEndReason::Completed),
            (Stop::MaxTokens, TurnEndReason::Completed),
            (Stop::Paused, TurnEndReason::Blocked),
            (Stop::BudgetLimited, TurnEndReason::Blocked),
            (Stop::Aborted, TurnEndReason::Cancelled),
            // v2 fails the turn on a filtered response (loopService.ts:877-882)
            // and on step-budget exhaustion (loopService.ts:956-962).
            (Stop::Filtered, TurnEndReason::Failed),
            (Stop::MaxSteps, TurnEndReason::Failed),
            (Stop::Unknown, TurnEndReason::Failed),
        ];
        for (stop, expected) in cases {
            assert_eq!(end_reason_of(&stop), expected, "{stop:?}");
        }
        assert_eq!(
            turn_end_error_payload(&Stop::MaxSteps, 7),
            Some(serde_json::json!(
                "Turn exceeded maxSteps=7. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run \"/update-config\" to update it, then \"/reload\"."
            )),
            "the max_steps payload mirrors createMaxStepsExceededError (loop.ts:20-27)"
        );
        assert_eq!(
            turn_end_error_payload(&Stop::Filtered, 3),
            Some(serde_json::json!(
                "Provider safety policy blocked the response."
            ))
        );
        assert_eq!(turn_end_error_payload(&Stop::EndTurn, 3), None);
    }

    struct FailingLlm;

    impl LLM for FailingLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "failing-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn transport(&self) -> &'static str {
            "native-http"
        }
        fn chat(
            &self,
            _: LLMChatParams,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>,
        > {
            Box::pin(async { Err("provider is offline".into()) })
        }
    }

    #[tokio::test]
    async fn test_failed_turn_reports_ended_with_error() {
        let (callbacks, events) = TurnRecordingCallbacks::new(serde_json::json!({}));
        let session = make_session(Arc::new(FailingLlm), Arc::new(callbacks)).await;
        let mut receipt = session
            .enqueue_turn(TurnRequest::user(msg("user", "boom"), Admission::NewTurn))
            .unwrap();
        assert!(receipt.outcome().await.is_err());
        let seen = recorded(&events);
        assert!(
            matches!(
                seen.last(),
                Some(TurnEvent::Ended {
                    reason: TurnEndReason::Failed,
                    error: Some(_),
                    ..
                })
            ),
            "a turn that never produced a stop reason must still close: {seen:?}"
        );
    }

    #[tokio::test]
    async fn test_cancel_without_id_reports_the_active_turn_id() {
        let (llm, gates) = ScriptedLlm::with_gate(vec![text_response("first")]);
        let (callbacks, events) = TurnRecordingCallbacks::new(serde_json::json!({}));
        let session = make_session(Arc::new(llm), Arc::new(callbacks)).await;

        let mut r1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "a"), Admission::NewTurn))
            .unwrap();
        wait_until(|| session.status().active_turn_id == Some(r1.turn_id)).await;

        assert!(session.cancel_turn(None));
        assert!(recorded(&events).contains(&TurnEvent::Cancel {
            turn_id: Some(r1.turn_id),
            target: Some(TurnCancelTarget::Active),
            reason: Some(TurnCancelReason::UserCancelled),
        }));

        gates.into_iter().next().unwrap().send(()).unwrap();
        let _ = r1.outcome().await;
    }

    // ── M1c: quiescence / backpressure / settled ────────────────────────────

    #[tokio::test]
    async fn test_settled_resolves_immediately_when_idle() {
        let server = Arc::new(RpcServer::new());
        let session = make_session(
            Arc::new(ScriptedLlm::simple(vec![text_response("unused")])),
            rpc_callbacks(server),
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_millis(100), session.settled())
            .await
            .expect("settled must resolve immediately on an idle session");
    }

    #[tokio::test]
    async fn test_settled_waits_for_active_turn() {
        let (llm, mut gates) = ScriptedLlm::with_gate(vec![text_response("gated")]);
        let server = Arc::new(RpcServer::new());
        let session = make_session(Arc::new(llm), rpc_callbacks(server)).await;
        let mut receipt = session
            .enqueue_turn(TurnRequest::user(msg("user", "a"), Admission::NewTurn))
            .unwrap();
        wait_until(|| session.status().active_turn_id.is_some()).await;

        let settled = session.settled();
        tokio::pin!(settled);
        // The turn is gated open — settled must not resolve while it runs.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut settled)
                .await
                .is_err(),
            "settled resolved while a turn was active"
        );

        gates.remove(0).send(()).unwrap();
        let _ = receipt.outcome().await;
        tokio::time::timeout(std::time::Duration::from_millis(1000), settled)
            .await
            .expect("settled must resolve once the turn finished");
    }

    #[tokio::test]
    async fn test_quiescence_holds_turns_and_release_replays_in_order() {
        let llm = Arc::new(ScriptedLlm::simple(vec![
            text_response("first"),
            text_response("second"),
        ]));
        let requests = llm.requests.clone();
        let server = Arc::new(RpcServer::new());
        let session = make_session(llm, rpc_callbacks(server)).await;

        let guard = session
            .try_acquire_quiescence()
            .expect("an idle session must grant quiescence");
        let mut held1 = session
            .enqueue_turn(TurnRequest::user(msg("user", "held-a"), Admission::NewTurn))
            .unwrap();
        let mut held2 = session
            .enqueue_turn(TurnRequest::user(msg("user", "held-b"), Admission::NewTurn))
            .unwrap();
        assert!(
            requests.lock().unwrap().is_empty(),
            "no turn may start while quiescence is held"
        );

        drop(guard);

        let o1 = held1.outcome().await.unwrap();
        let o2 = held2.outcome().await.unwrap();
        assert!(matches!(o1, TurnOutcome::Ran(_)));
        assert!(matches!(o2, TurnOutcome::Ran(_)));
        let calls = requests.lock().unwrap();
        assert_eq!(calls.len(), 2, "both held turns must run after release");
        assert!(calls[0].iter().any(|m| m.content == "held-a"));
        assert!(calls[1].iter().any(|m| m.content == "held-b"));
    }

    #[tokio::test]
    async fn test_try_acquire_quiescence_fails_while_turns_outstanding() {
        let (llm, mut gates) = ScriptedLlm::with_gate(vec![text_response("b"), text_response("a")]);
        let server = Arc::new(RpcServer::new());
        let session = make_session(Arc::new(llm), rpc_callbacks(server)).await;
        let mut receipt_a = session
            .enqueue_turn(TurnRequest::user(msg("user", "a"), Admission::NewTurn))
            .unwrap();
        wait_until(|| session.status().active_turn_id == Some(receipt_a.turn_id)).await;
        // chat pops gates LIFO, so turn a is parked on gates[1].
        assert!(
            session.try_acquire_quiescence().is_none(),
            "an active turn must deny quiescence"
        );
        // A pending turn denies too.
        let mut receipt_b = session
            .enqueue_turn(TurnRequest::user(
                msg("user", "b"),
                Admission::ActiveOrNextTurn,
            ))
            .unwrap();
        assert!(
            session.try_acquire_quiescence().is_none(),
            "a pending turn must deny quiescence"
        );
        // Finish turn a; turn b starts and parks on the remaining gate.
        gates.swap_remove(1).send(()).unwrap();
        let _ = receipt_a.outcome().await;
        wait_until(|| session.status().active_turn_id == Some(receipt_b.turn_id)).await;
        assert!(session.try_acquire_quiescence().is_none());
        gates.swap_remove(0).send(()).unwrap();
        let _ = receipt_b.outcome().await;
        wait_until(|| session.is_settled()).await;
        assert!(session.try_acquire_quiescence().is_some());
    }

    #[tokio::test]
    async fn test_cancel_held_turn_resolves_and_settles() {
        let llm = Arc::new(ScriptedLlm::simple(vec![text_response("unused")]));
        let (callbacks, events) = TurnRecordingCallbacks::new(serde_json::json!({}));
        let session = make_session(llm, Arc::new(callbacks)).await;

        let guard = session.try_acquire_quiescence().unwrap();
        let mut held = session
            .enqueue_turn(TurnRequest::user(msg("user", "held"), Admission::NewTurn))
            .unwrap();
        assert!(session.cancel_turn(Some(held.turn_id)));
        drop(guard);

        let outcome = held.outcome().await.unwrap();
        assert!(
            matches!(outcome, TurnOutcome::CancelledBeforeStart),
            "a cancelled held turn must never run"
        );
        assert!(recorded(&events).contains(&TurnEvent::Cancel {
            turn_id: Some(held.turn_id),
            target: Some(TurnCancelTarget::Queued),
            reason: Some(TurnCancelReason::UserCancelled),
        }));
        tokio::time::timeout(std::time::Duration::from_millis(1000), session.settled())
            .await
            .expect("cancelling the only held turn must settle the session");
    }
}
