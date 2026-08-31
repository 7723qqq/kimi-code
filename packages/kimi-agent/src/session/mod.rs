//! EngineSession — the turn lifecycle owner (M1a).
//!
//! Owns what v2's `loopService.ts` owns today: turn admission (four modes),
//! the pending-turn FIFO, serial turn execution, turn-id assignment, and
//! cancellation (active via the run_turn cancel flag, queued by dropping the
//! entry). Cross-turn conversation history is owned here too: each turn
//! starts from the accumulated history plus the enqueued prompt, and the
//! turn's final messages (assistant/tool turns included) fold back into the
//! history for the next turn.
//!
//! Deliberately out of scope for M1a (see
//! `reports/rust-engine-turn-lifecycle-design.md`): durable turn events and
//! the persisted turn clock (M1b), quiescence/backpressure and telemetry
//! (M1c), `host/list_tools` (M1d).

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

/// A prompt enqueued into the session.
#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub prompt: LLMMessage,
    pub admission: Admission,
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
}

impl EngineSession {
    pub fn new(config: SessionConfig) -> Self {
        let core = Arc::new(Mutex::new(Core {
            next_turn_id: 1,
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
        tokio::spawn(pump(core.clone(), ctx, wakeup.clone()));
        Self {
            core,
            wakeup: Arc::new(Notify::new()),
            steer_queue,
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
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        match turn_id {
            Some(id) if core.active_turn_id == Some(id) => {
                if let Some(flag) = &core.active_cancel {
                    flag.store(true, Ordering::SeqCst);
                    return true;
                }
                false
            }
            Some(id) => {
                if let Some(pos) = core.pending.iter().position(|t| t.turn_id == id) {
                    let mut entry = core.pending.remove(pos);
                    entry.cancel.store(true, Ordering::SeqCst);
                    if let Some(tx) = entry.outcome.take() {
                        let _ = tx.send(Ok(TurnOutcome::CancelledBeforeStart));
                    }
                    true
                } else {
                    false
                }
            }
            None => match &core.active_cancel {
                Some(flag) => {
                    flag.store(true, Ordering::SeqCst);
                    core.active_turn_id.is_some()
                }
                None => false,
            },
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
            cancel,
            ..
        } = entry;
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
        if let Some(tx) = entry_outcome {
            let _ = tx.send(outcome.clone());
        }
        for (_, receipt) in steer_receipts {
            let _ = receipt.send(outcome.clone());
        }
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

    fn make_session(llm: Arc<dyn LLM>, callbacks: Arc<dyn HostCallbacks>) -> EngineSession {
        let config = SessionConfig {
            llm,
            callbacks,
            max_steps: 5,
            tool_defs: Arc::new(|| Box::pin(async { Vec::new() })),
            goal: None,
            on_before_turn: None,
        };
        EngineSession::new(config)
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
        let session = make_session(llm, rpc_callbacks(server));

        let mut r1 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "hello"),
                admission: Admission::NewTurn,
            })
            .unwrap();
        let mut r2 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "world"),
                admission: Admission::NewTurn,
            })
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
        let session = make_session(llm, rpc_callbacks(server));
        let mut r1 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "a"),
                admission: Admission::NewTurn,
            })
            .unwrap();
        let mut r2 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "b"),
                admission: Admission::NewTurn,
            })
            .unwrap();
        let mut r3 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "c"),
                admission: Admission::NewTurn,
            })
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
        let session = make_session(llm, rpc_callbacks(server));

        let mut r1 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "first"),
                admission: Admission::NewTurn,
            })
            .unwrap();
        wait_until(|| !requests.lock().unwrap().is_empty()).await;
        let mut r2 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "second"),
                admission: Admission::NewTurn,
            })
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
        let session = make_session(llm, rpc_callbacks(server));

        let mut r1 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "first"),
                admission: Admission::NewTurn,
            })
            .unwrap();
        wait_until(|| session.status().active_turn_id == Some(r1.turn_id)).await;
        let mut r2 = session
            .enqueue_turn(TurnRequest {
                prompt: msg("user", "steer-me"),
                admission: Admission::ActiveOrNewTurn,
            })
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
        let session = make_session(llm, rpc_callbacks(server));
        let result = session.enqueue_turn(TurnRequest {
            prompt: msg("user", "x"),
            admission: Admission::ActiveTurnOnly,
        });
        assert!(result.is_err());
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("expected ActiveTurnOnly without an active turn to error"),
        };
        assert!(err.contains("requires an active turn"));
    }
}
