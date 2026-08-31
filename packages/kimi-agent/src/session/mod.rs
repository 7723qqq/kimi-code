//! EngineSession — the turn lifecycle owner (M1a/M1b).
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
//! Deliberately out of scope (see the M1 section of `ROADMAP.md`):
//! quiescence/backpressure and telemetry (M1c), `host/list_tools` (M1d).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{Notify, oneshot};

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, LlmChatRequest, LlmChatResponse,
    PermissionCheckRequest, PermissionDecision, StateReadRequest, StateReadResponse,
    StateWriteRequest, StateWriteResponse, ToolExecuteRequest, ToolExecuteResponse,
    ToolFinalizeRequest,
};
use crate::turn_events::{TurnCancelReason, TurnCancelTarget, TurnEndReason, TurnEvent};
use crate::turn_loop::run_turn::run_turn;
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
}

/// Live session shape (v2 `AgentLoopStatus`).
#[derive(Debug, Clone)]
pub struct SessionStatus {
    pub active_turn_id: Option<u64>,
    pub pending_turn_ids: Vec<u64>,
}

/// Session-level configuration, fixed for the session's lifetime.
pub struct SessionConfig {
    pub llm: Arc<dyn LLM>,
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Step cap for every turn (v2 `maxStepsPerTurn`).
    pub max_steps: u32,
    /// Fresh tool definitions per turn (MCP tools can change mid-session;
    /// M1d replaces this provider with `host/list_tools`).
    pub tool_defs:
        Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Vec<ToolInfo>> + Send + Sync>,
    /// Fresh goal snapshot per turn (budget checks + steering).
    pub goal: Option<Arc<dyn Fn() -> Option<GoalContext> + Send + Sync>>,
    /// Ran before each turn's first step (REPL: the undo checkpoint).
    pub on_before_turn: Option<Arc<dyn Fn() + Send + Sync>>,
}

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
}

struct SessionContext {
    llm: Arc<dyn LLM>,
    callbacks: Arc<dyn HostCallbacks>,
    tool_defs:
        Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, Vec<ToolInfo>> + Send + Sync>,
    goal: Option<Arc<dyn Fn() -> Option<GoalContext> + Send + Sync>>,
    on_before_turn: Option<Arc<dyn Fn() + Send + Sync>>,
    max_steps: u32,
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
        });
        let wakeup = Arc::new(Notify::new());
        let callbacks = ctx.callbacks.clone();
        tokio::spawn(pump(core.clone(), ctx, wakeup.clone()));
        Self {
            core,
            wakeup,
            steer_queue,
            callbacks,
        }
    }

    /// Enqueue a prompt. The turn id is assigned synchronously (monotonic,
    /// never reused — cancelled queued turns consume their id, matching v2's
    /// reserved-id clock), so the caller can cancel by id immediately.
    pub fn enqueue_turn(&self, request: TurnRequest) -> Result<TurnReceipt, String> {
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        match request.admission {
            Admission::NewTurn | Admission::ActiveOrNextTurn => {
                let turn_id = core.next_turn_id;
                core.next_turn_id += 1;
                core.pending.push(PendingTurn {
                    turn_id,
                    prompt: request.prompt,
                    input: request.input,
                    origin: request.origin,
                    cancel: Arc::new(AtomicBool::new(false)),
                    outcome: Some(outcome_tx),
                });
                drop(core);
                self.wakeup.notify_one();
                Ok(TurnReceipt {
                    turn_id,
                    outcome: outcome_rx,
                })
            }
            Admission::ActiveOrNewTurn | Admission::ActiveTurnOnly => {
                if core.active_turn_id.is_some() {
                    // Steer: the prompt joins the active turn through the
                    // drain_steers seam; the receipt resolves with the active
                    // turn's outcome.
                    let turn_id = core.active_turn_id.unwrap_or_else(|| core.next_turn_id);
                    core.steer_waiters.push((turn_id, outcome_tx));
                    drop(core);
                    self.steer_queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(request.prompt);
                    Ok(TurnReceipt {
                        turn_id,
                        outcome: outcome_rx,
                    })
                } else if request.admission == Admission::ActiveTurnOnly {
                    Err("Step request requires an active turn".to_string())
                } else {
                    let turn_id = core.next_turn_id;
                    core.next_turn_id += 1;
                    core.pending.push(PendingTurn {
                        turn_id,
                        prompt: request.prompt,
                        input: request.input,
                        origin: request.origin,
                        cancel: Arc::new(AtomicBool::new(false)),
                        outcome: Some(outcome_tx),
                    });
                    drop(core);
                    self.wakeup.notify_one();
                    Ok(TurnReceipt {
                        turn_id,
                        outcome: outcome_rx,
                    })
                }
            }
        }
    }

    /// Cancel a turn by id. An active turn is interrupted at the next step
    /// boundary; a queued turn is dropped before starting (its receipt
    /// resolves with [`TurnOutcome::CancelledBeforeStart`]). Without an id
    /// the active turn (if any) is cancelled. Returns whether anything was
    /// cancelled.
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
            match turn_id {
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
                    None => Decision::Nothing,
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
            }
        };
        match decision {
            Decision::CancelActive { turn_id } => {
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
        }
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

        let (mut entry, history) = match next {
            Some(pair) => pair,
            None => {
                // Idle: wait for the next enqueue. A stored permit (an
                // enqueue that raced ahead of this await) wakes immediately.
                wakeup.notified().await;
                continue;
            }
        };
        let entry_outcome = entry.outcome.take();
        let PendingTurn {
            turn_id,
            prompt,
            input,
            origin,
            cancel,
            ..
        } = entry;
        let started = std::time::Instant::now();
        ctx.callbacks.turn_event(TurnEvent::Prompt {
            turn_id,
            input,
            origin: origin.clone(),
        });
        ctx.callbacks
            .turn_event(TurnEvent::Started { turn_id, origin });
        let outcome = run_session_turn(&ctx, turn_id, prompt, cancel, history).await;

        // Fold the turn's final messages into the session history (system
        // message excluded — run_turn rebuilds it per turn), release the
        // active slot, and resolve steer receipts with the turn's outcome.
        let steer_receipts = {
            let mut core = core.lock().unwrap_or_else(|e| e.into_inner());
            core.active_turn_id = None;
            core.active_cancel = None;
            if let Ok(TurnOutcome::Ran(result)) = &outcome {
                core.history.extend(result.messages.iter().skip(1).cloned());
            }
            std::mem::take(&mut core.steer_waiters)
        };
        // Durable: the host folds this into `turnKey.lastEnded` and drives any
        // terminal-state display from it.
        if let Ok(TurnOutcome::Ran(result)) = &outcome {
            ctx.callbacks.turn_event(TurnEvent::Ended {
                turn_id,
                reason: end_reason_of(&result.stop_reason),
                error: None,
                duration_ms: Some(started.elapsed().as_millis() as u64),
            });
        } else if let Err(e) = &outcome {
            ctx.callbacks.turn_event(TurnEvent::Ended {
                turn_id,
                reason: TurnEndReason::Failed,
                error: Some(serde_json::Value::String(e.clone())),
                duration_ms: Some(started.elapsed().as_millis() as u64),
            });
        }
        if let Some(tx) = entry_outcome {
            let _ = tx.send(outcome.clone());
        }
        for (_, receipt) in steer_receipts {
            let _ = receipt.send(outcome.clone());
        }
    }
}

/// Map the engine's step-level stop reason onto v2's four-value turn end
/// reason. `MaxTokens` / `Filtered` are finish reasons on a response the model
/// did produce, so the turn completed; `Paused` / `BudgetLimited` stop because
/// the goal cannot progress right now, which v2 reports as blocked; `Aborted`
/// is the cancellation flag (also how a blocked goal stops).
fn end_reason_of(stop: &crate::turn_loop::types::LoopTurnStopReason) -> TurnEndReason {
    use crate::turn_loop::types::LoopTurnStopReason as Stop;
    match stop {
        Stop::EndTurn | Stop::MaxTokens | Stop::Filtered => TurnEndReason::Completed,
        Stop::Paused | Stop::BudgetLimited => TurnEndReason::Blocked,
        Stop::Aborted => TurnEndReason::Cancelled,
        Stop::Unknown => TurnEndReason::Failed,
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
    let goal = ctx.goal.as_ref().and_then(|provider| provider());
    let mut messages = history;
    messages.push(prompt);
    let input = RunTurnInput {
        turn_id: format!("turn-{turn_id}"),
        llm: ctx.llm.as_ref(),
        messages,
        tools: &[],
        tool_defs,
        max_steps: ctx.max_steps,
        goal,
        cancellation: Some(cancel),
    };
    let result = run_turn(input, &ctx.callbacks)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TurnOutcome::Ran(result))
}

/// Callbacks decorator: serves the session's steer queue through the
/// `drain_steers` seam the turn loop already consumes (native transports
/// only — in host-proxy mode the host owns steering). Everything else
/// delegates unchanged.
struct SteerQueueCallbacks {
    inner: Arc<dyn HostCallbacks>,
    steer_queue: Arc<Mutex<Vec<LLMMessage>>>,
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

    fn finalize_tool_result(
        &self,
        request: ToolFinalizeRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.inner.finalize_tool_result(request)
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

    fn emit_event(&self, event: serde_json::Value) {
        self.inner.emit_event(event);
    }

    fn turn_event(&self, event: TurnEvent) {
        self.inner.turn_event(event);
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
                .push(params.messages);
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
            tool_calls: Vec::new(),
            finish_reason: Some("stop".into()),
            usage: TokenUsage::default(),
        }
    }

    fn rpc_callbacks(server: Arc<RpcServer>) -> Arc<dyn HostCallbacks> {
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
            tool_defs: Arc::new(|| Box::pin(async { Vec::new() })),
            goal: None,
            on_before_turn: None,
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
            (Stop::Filtered, TurnEndReason::Completed),
            (Stop::Paused, TurnEndReason::Blocked),
            (Stop::BudgetLimited, TurnEndReason::Blocked),
            (Stop::Aborted, TurnEndReason::Cancelled),
            (Stop::Unknown, TurnEndReason::Failed),
        ];
        for (stop, expected) in cases {
            assert_eq!(end_reason_of(&stop), expected, "{stop:?}");
        }
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
}
