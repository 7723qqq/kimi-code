//! napi-rs bindings for the kimi-agent Rust engine.
//!
//! This module exposes the turn loop as a native Node.js addon via napi-rs,
//! enabling direct in-process communication between Node.js and Rust without
//! the stdio JSON-RPC bridge.
//!
//! ## Callback architecture
//!
//! napi-rs 2.16 `call_async` does not properly await JS Promises returned by
//! async callbacks (it tries to convert the Promise object directly to a
//! String, triggering `StringExpected`). To work around this, we use a
//! **callback registry** pattern:
//!
//! 1. Rust assigns a unique `callback_id` + creates a `oneshot` channel.
//! 2. Rust calls the JS function via `tsfn.call()` (fire-and-forget), passing
//!    the input payload and the `callback_id`.
//! 3. The JS function processes the request asynchronously, then calls the
//!    exported `resolveCallback(id, error, result)` napi function.
//! 4. `resolveCallback` looks up the `oneshot` sender and sends the result.
//! 5. The Rust future (from step 1) awaits the `oneshot` receiver.
//!
//! This avoids `call_async` entirely and works with both sync and async JS
//! callbacks.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use napi::{
    JsObject,
    bindgen_prelude::{Env, JsFunction},
    threadsafe_function::{
        ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
    },
};
use napi_derive::napi;
use tokio::sync::oneshot;

use crate::callbacks::{
    CountingCallbacks, HOST_LIST_TOOLS_TIMEOUT, HOST_LLM_TIMEOUT, HOST_TOOL_TIMEOUT, HostCallbacks,
    NativeToolCallbacks,
};
use crate::llm::http::NativeHttpLlm;
use crate::llm::multi::{LlmProvider, MultiLLM};
use crate::llm::proxy::HostLlmProxy;
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, BoxFuture, CheckpointRequest, ListToolsResponse,
    LlmChatRequest, LlmChatResponse, NativeLlmConfig, PermissionCheckRequest, PermissionDecision,
    StateReadRequest, StateReadResponse, StateWriteRequest, StateWriteResponse, ToolExecuteRequest,
    ToolExecuteResponse,
};
use crate::session::{
    Admission, EngineSession, GoalProvider, SessionConfig, ToolDefsProvider, TurnOutcome,
    TurnRequest,
};
use crate::turn_loop::{run_turn::run_turn, run_turn::run_turn_with_telemetry, types::*};

// ── Global callback registry ───────────────────────────────────────────────

/// Result channel for a pending callback awaiting resolution from JS.
type PendingCallback = oneshot::Sender<Result<String, String>>;

/// Pending callbacks awaiting resolution from the JS side.
static CALLBACK_REGISTRY: LazyLock<Mutex<HashMap<u32, PendingCallback>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Payload registry — stores the JSON request payloads by callback ID.
/// The JS side fetches the payload via `getCallbackPayload(id)` after
/// receiving the callback ID via TSFN.
///
/// To prevent unbounded growth from unfetched event payloads, the registry
/// is pruned when it exceeds [`PAYLOAD_REGISTRY_MAX_ENTRIES`]. Pruning drops
/// the oldest entries (lowest IDs) first, since IDs are monotonically
/// increasing — which is why this is a `BTreeMap`: iterating a `HashMap`
/// yields IDs in arbitrary order and would drop payloads JS has not fetched
/// yet.
static PAYLOAD_REGISTRY: LazyLock<Mutex<BTreeMap<u32, String>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// Maximum number of entries in the payload registry before pruning kicks in.
/// Each entry is a small JSON string; 1000 entries is a generous ceiling that
/// prevents unbounded growth without affecting normal operation.
const PAYLOAD_REGISTRY_MAX_ENTRIES: usize = 1000;

/// Store a payload for JS to collect, pruning the oldest entries when the
/// registry is full — but never evicting a payload whose callback is still
/// awaiting resolution. Evicting one would make JS fetch null for a pending
/// request and strand its oneshot until the timeout (or, for a permission
/// check, forever).
fn store_payload(id: u32, payload: String) {
    let mut registry = PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    registry.insert(id, payload);
    let excess = registry.len().saturating_sub(PAYLOAD_REGISTRY_MAX_ENTRIES);
    if excess == 0 {
        return;
    }
    let pending = CALLBACK_REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let mut evicted = 0usize;
    let mut doomed: Vec<u32> = Vec::new();
    for candidate in registry.keys() {
        if evicted >= excess {
            break;
        }
        if pending.contains_key(candidate) {
            continue;
        }
        doomed.push(*candidate);
        evicted += 1;
    }
    for candidate in doomed {
        registry.remove(&candidate);
    }
}

/// Monotonically increasing callback ID. Wrapping is fine because the ID
/// space is large enough that collisions are impossible in practice.
static NEXT_CALLBACK_ID: AtomicU32 = AtomicU32::new(1);

/// Active-turn cancellation signals keyed by `turn_id`. `run_turn_rust`
/// registers a signal before running and removes it afterwards; `cancel_turn`
/// triggers the signal of a running turn from the JS side so the loop can
/// observe the cancellation at the next step boundary — and, since P51, the
/// foreground subagent's event-driven wait aborts immediately.
static CANCEL_MAP: LazyLock<Mutex<HashMap<String, crate::subagent::types::ParentCancel>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Process-wide subagent manager (P28). Instance state (running/completed
/// subagents) survives across turns; the execution runtime is re-injected
/// per turn because llm/callbacks are turn-scoped.
static SUBAGENT_MANAGER: LazyLock<Arc<crate::subagent::SubagentManager>> =
    LazyLock::new(|| Arc::new(crate::subagent::SubagentManager::new()));

/// Ask a running turn (identified by `turn_id`) to stop. The flag is
/// observed by the turn loop between LLM/tool steps; if the turn has already
/// finished this is a no-op.
#[napi]
pub fn cancel_turn(turn_id: String) -> napi::Result<()> {
    guard_sync_panic(|| {
        if let Some(cancel) = CANCEL_MAP
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&turn_id)
        {
            cancel.trigger();
        }
        Ok(())
    })
}

/// Emit a one-shot `tracing::info!` event. Used by the test harness to
/// confirm the subscriber is wired (so trace files are non-empty even on
/// trivial inputs that don't traverse instrumented hot paths).
#[napi]
pub fn emit_test_trace_event(message: String) -> napi::Result<()> {
    tracing::info!(test_message = %message, "kimi-agent tracing smoke event");
    Ok(())
}

/// Initialise tracing from `KIMI_AGENT_TRACE` / `KIMI_AGENT_TRACE_FORMAT`.
///
/// Returns `true` when the subscriber was installed by this call, `false`
/// when one was already registered (a process-wide subscriber can only be
/// set once) or when the env is not set (no-op). The test harness and
/// future operators call this from JS to turn the P20-A/B/C / future
/// performance work's tracing spans on without restarting the process.
#[napi]
pub fn init_tracing_from_env() -> napi::Result<bool> {
    use std::sync::Once;
    static STARTED: Once = Once::new();
    let mut installed = false;
    STARTED.call_once(|| {
        let enabled = std::env::var("KIMI_AGENT_TRACE")
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        if !enabled {
            return;
        }
        let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("kimi_agent=info"));
        // Default to stdout: vitest's reporter captures stderr in some
        // harness modes, and our existing `eprintln!` diagnostics already
        // write to stderr. Sending tracing to stdout keeps the two
        // channels separate and lets vitest users pipe the trace.
        let use_stderr = std::env::var("KIMI_AGENT_TRACE_STDERR").is_ok();
        let use_json = std::env::var("KIMI_AGENT_TRACE_FORMAT").as_deref() == Ok("json");
        let result = if use_stderr {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .with_writer(std::io::stderr)
                .try_init()
        } else if use_json {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .json()
                .with_writer(std::io::stdout)
                .try_init()
        } else {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .with_writer(std::io::stdout)
                .try_init()
        };
        if result.is_ok() {
            installed = true;
        }
    });
    Ok(installed)
}

/// Called by JS to fetch the payload for a given callback ID.
/// Returns the JSON-serialized request payload, or null if not found.
#[napi]
pub fn get_callback_payload(id: u32) -> napi::Result<Option<String>> {
    guard_sync_panic(|| {
        let payload = PAYLOAD_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        Ok(payload)
    })
}

/// Called by JS to resolve a pending host callback.
///
/// * `id` — the callback ID that was passed to the JS function
/// * `error` — if present, the callback failed with this error message
/// * `result` — if present (and `error` is absent), the JSON-serialized response
#[napi]
pub fn resolve_callback(
    id: u32,
    error: Option<String>,
    result: Option<String>,
) -> napi::Result<()> {
    guard_sync_panic(|| {
        if let Some(tx) = CALLBACK_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        {
            let outcome = match (error, result) {
                (Some(err), _) => Err(err),
                (_, Some(res)) => Ok(res),
                (None, None) => Err("callback resolved with no result".to_string()),
            };
            let _ = tx.send(outcome);
        }
        Ok(())
    })
}

/// Catch a panic in a synchronous napi export so it becomes a JS-side
/// error instead of unwinding across the FFI boundary and aborting the
/// whole Node process.
fn guard_sync_panic<T>(f: impl FnOnce() -> napi::Result<T>) -> napi::Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .map_err(|_| napi::Error::from_reason("internal panic in sync napi export"))?
}

// ── NapiHostCallbacks ──────────────────────────────────────────────────────

/// Implements [`HostCallbacks`] using napi [`ThreadsafeFunction`]s so the
/// Rust turn loop can call back into JS for LLM chat and tool execution.
///
/// The TSFN passes only the callback ID (u32). The JS side fetches the
/// payload via `getCallbackPayload(id)` and resolves via `resolveCallback`.
///
/// Uses `ErrorStrategy::Fatal` so the JS callback receives just the callback ID
/// without the error-first `null` argument that `CalleeHandled` prepends.
struct NapiHostCallbacks {
    llm_chat_fn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    execute_tool_fn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    /// Optional fire-and-forget event channel. The JS side fetches the
    /// payload via `getCallbackPayload(id)` but must NOT resolve it.
    emit_event_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional permission checker for native execution of mutating tools.
    /// Fail-closed when absent: without a checker the engine refuses native
    /// execution of Write/Edit/Bash and the call falls back to the host.
    check_permission_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional interactive question channel: the host owns the interaction
    /// runtime and answers with the v2 `QuestionResult` three states.
    /// Absent means the engine reports "host does not support interactive
    /// questions" as the tool result.
    ask_question_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional state bridge channels: the host reads/writes its durable
    /// state (todo/plan domains) on the engine's behalf. Absent means the
    /// engine reports "host does not support state bridge" as the tool
    /// result.
    state_read_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    state_write_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional host-side file checkpoint channel (P53): native write
    /// executions snapshot their pre-images host-side. Absent means the
    /// host skips checkpointing (fail-open).
    checkpoint_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional turn lifecycle channel: the engine reports the durable
    /// `turn.prompt` / `turn.cancel` / `turn.ended` records and the observable
    /// `turn.started` so the host can append and fold them. Absent means the
    /// host keeps owning the turn lifecycle end to end, which is the
    /// pre-existing behaviour while `run_turn` is a stateless per-turn call.
    turn_event_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional turn telemetry channel (M1c): the engine emits
    /// `turn_started` / `turn_ended` / `turn_interrupted` payloads the host
    /// forwards to its telemetry sink. Absent means the host keeps owning
    /// its turn telemetry end to end.
    telemetry_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional tool-table channel (M1d: `host/list_tools`). The engine
    /// pulls the host's current tool table before each LLM call on native
    /// transports; absent means the turn-start snapshot is the only table.
    list_tools_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional current-goal channel (`host/goal`). The stale goal gate
    /// reads the host's live goal snapshot through it; absent means
    /// `goal()` reports the seam as unsupported (fail-open for staleness).
    goal_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// The current turn's cancellation flag. Awaiting a host callback then
    /// observes it, so `cancel_turn` also interrupts in-flight permission
    /// checks and host tool calls instead of stranding them until timeout.
    cancellation: Option<Arc<AtomicBool>>,
}

impl HostCallbacks for NapiHostCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> crate::rpc::types::BoxFuture<
        'static,
        std::result::Result<LlmChatResponse, std::string::String>,
    > {
        let tsfn = self.llm_chat_fn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        Box::pin(napi_llm_chat(tsfn, input, self.cancellation.clone()))
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> crate::rpc::types::BoxFuture<
        'static,
        std::result::Result<ToolExecuteResponse, std::string::String>,
    > {
        let tsfn = self.execute_tool_fn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        Box::pin(napi_execute_tool(tsfn, input, self.cancellation.clone()))
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        let Some(ref tsfn) = self.check_permission_fn else {
            return Box::pin(async {
                Ok(PermissionDecision::deny(
                    "host did not provide a permission checker; native execution of a mutating tool is refused",
                ))
            });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // No timeout: this one waits on a human, and giving up would
            // discard an approval the user has already granted. A turn
            // cancellation still interrupts the wait.
            let output =
                invoke_via_registry(&tsfn, input, "check_permission", None, cancel).await?;
            serde_json::from_str(&output).map_err(|e| format!("check_permission parse: {e}"))
        })
    }

    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        let Some(ref tsfn) = self.ask_question_fn else {
            return Box::pin(async {
                Err("host does not support interactive questions".to_string())
            });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // No timeout: this one waits on a human, and giving up would
            // discard an answer the user has already given. A turn
            // cancellation still interrupts the wait.
            let output = invoke_via_registry(&tsfn, input, "ask_question", None, cancel).await?;
            serde_json::from_str(&output).map_err(|e| format!("ask_question parse: {e}"))
        })
    }

    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
        let Some(ref tsfn) = self.state_read_fn else {
            return Box::pin(async { Err("host does not support state bridge".to_string()) });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // Bounded: host bookkeeping with no human in the loop. A turn
            // cancellation still interrupts the wait.
            let output = invoke_via_registry(
                &tsfn,
                input,
                "state_read",
                Some(crate::callbacks::HOST_STATE_TIMEOUT),
                cancel,
            )
            .await?;
            serde_json::from_str(&output).map_err(|e| format!("state_read parse: {e}"))
        })
    }

    fn checkpoint(&self, request: CheckpointRequest) -> BoxFuture<'static, Result<(), String>> {
        let Some(ref tsfn) = self.checkpoint_fn else {
            return Box::pin(async { Err("host does not support checkpoint".to_string()) });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // Bounded: pre-image capture is host bookkeeping, but the engine
            // waits for it before writing — the timeout bounds that wait. A
            // turn cancellation still interrupts the wait.
            invoke_via_registry(
                &tsfn,
                input,
                "checkpoint",
                Some(crate::callbacks::HOST_STATE_TIMEOUT),
                cancel,
            )
            .await?;
            Ok(())
        })
    }

    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
        let Some(ref tsfn) = self.state_write_fn else {
            return Box::pin(async { Err("host does not support state bridge".to_string()) });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // Bounded: host bookkeeping with no human in the loop. A turn
            // cancellation still interrupts the wait.
            let output = invoke_via_registry(
                &tsfn,
                input,
                "state_write",
                Some(crate::callbacks::HOST_STATE_TIMEOUT),
                cancel,
            )
            .await?;
            serde_json::from_str(&output).map_err(|e| format!("state_write parse: {e}"))
        })
    }

    fn emit_event(&self, event: serde_json::Value) {
        let Some(ref tsfn) = self.emit_event_fn else {
            return;
        };
        let Ok(payload) = serde_json::to_string(&event) else {
            return;
        };
        fire_payload_only(tsfn, payload);
    }

    fn turn_event(&self, event: crate::turn_events::TurnEvent) {
        let Some(ref tsfn) = self.turn_event_fn else {
            return;
        };
        let Ok(payload) = serde_json::to_string(&event) else {
            return;
        };
        fire_payload_only(tsfn, payload);
    }

    fn telemetry(&self, event: serde_json::Value) {
        let Some(ref tsfn) = self.telemetry_fn else {
            return;
        };
        let Ok(payload) = serde_json::to_string(&event) else {
            return;
        };
        fire_payload_only(tsfn, payload);
    }

    fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
        let Some(ref tsfn) = self.list_tools_fn else {
            return Box::pin(async { Err("host does not support list_tools".to_string()) });
        };
        let tsfn = tsfn.clone();
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // Bounded: host bookkeeping with no human in the loop; on timeout
            // run_turn falls back to the turn-start snapshot.
            let output = invoke_via_registry(
                &tsfn,
                "{}".to_string(),
                "list_tools",
                Some(HOST_LIST_TOOLS_TIMEOUT),
                cancel,
            )
            .await?;
            serde_json::from_str(&output).map_err(|e| format!("list_tools parse: {e}"))
        })
    }

    fn goal(&self) -> BoxFuture<'static, Result<Option<GoalContext>, String>> {
        let Some(ref tsfn) = self.goal_fn else {
            return Box::pin(async { Err("host does not support goal".to_string()) });
        };
        let tsfn = tsfn.clone();
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // Unbounded like the host-side goal read: host bookkeeping, no
            // human in the loop; the stale gate treats a failure as
            // fail-open, so no timeout contract is needed here.
            let output = invoke_via_registry(&tsfn, "{}".to_string(), "goal", None, cancel).await?;
            if output == "null" {
                return Ok(None);
            }
            serde_json::from_str::<GoalContext>(&output)
                .map(Some)
                .map_err(|e| format!("goal parse: {e}"))
        })
    }
}

/// Fire a fire-and-forget TSFN that carries a payload the JS side collects by
/// callback id, with no oneshot to resolve.
///
/// Pruning matters here: an event the host never collects would otherwise
/// accumulate in the payload registry for the life of the process.
fn fire_payload_only(tsfn: &ThreadsafeFunction<u32, ErrorStrategy::Fatal>, payload: String) {
    let id = NEXT_CALLBACK_ID.fetch_add(1, Ordering::SeqCst);
    store_payload(id, payload);
    let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
    if status != napi::Status::Ok {
        PAYLOAD_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }
}

/// Register a callback with the global registry, store the payload for
/// JS-side retrieval, fire the JS function with just the callback ID,
/// and await the result.
///
/// Returns the JSON-serialized response string, or an error message.
///
/// `timeout` bounds how long the host may take to answer. `None` waits
/// indefinitely, which is right for a permission check: that one is
/// answered by a human, and a timeout would land after the user approved.
/// Either way, a turn cancellation interrupts the wait.
async fn invoke_via_registry(
    tsfn: &Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
    label: &str,
    timeout: Option<Duration>,
    cancel: Option<Arc<AtomicBool>>,
) -> std::result::Result<std::string::String, std::string::String> {
    let id = NEXT_CALLBACK_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();

    // Store the payload so JS can fetch it via getCallbackPayload(id).
    store_payload(id, input);

    // Register the sender so resolve_callback can find it.
    CALLBACK_REGISTRY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, tx);

    // Fire the JS function with just the callback ID (a number).
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
    if status != napi::Status::Ok {
        // Clean up on failure.
        PAYLOAD_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        CALLBACK_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        return Err(format!("{label} call: {status:?}"));
    }

    let pending = match timeout {
        Some(limit) => {
            match tokio::time::timeout(limit, wait_for_callback(rx, cancel, label)).await {
                Ok(outcome) => outcome,
                Err(_) => Err(format!("{label} timed out after {}s", limit.as_secs())),
            }
        }
        None => wait_for_callback(rx, cancel, label).await,
    };

    // Whatever ended the wait (resolution, timeout, cancellation, dropped
    // host), leave nothing behind: a late resolve_callback would find no
    // sender, and the payload would sit in the registry until pruned.
    PAYLOAD_REGISTRY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if pending.is_err() {
        CALLBACK_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }

    pending.and_then(|inner| inner)
}

/// Await a host-callback oneshot, optionally observing the turn's
/// cancellation flag so `cancel_turn` can interrupt permission waits and
/// host-tool round-trips instead of stranding them.
async fn wait_for_callback(
    rx: oneshot::Receiver<Result<String, String>>,
    cancel: Option<Arc<AtomicBool>>,
    label: &str,
) -> Result<Result<String, String>, String> {
    let Some(flag) = cancel else {
        return match rx.await {
            Ok(outcome) => Ok(outcome),
            Err(_) => Err(format!("{label} closed: receiver dropped")),
        };
    };
    let mut rx = rx;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if flag.load(Ordering::Relaxed) {
                    return Err(format!("{label} cancelled"));
                }
            }
            outcome = &mut rx => return outcome.map_err(|_| format!("{label} closed: receiver dropped")),
        }
    }
}

/// Standalone async function for LLM chat via callback registry.
async fn napi_llm_chat(
    tsfn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
    cancel: Option<Arc<AtomicBool>>,
) -> std::result::Result<LlmChatResponse, std::string::String> {
    let output =
        invoke_via_registry(&tsfn, input, "llm_chat", Some(HOST_LLM_TIMEOUT), cancel).await?;
    serde_json::from_str(&output).map_err(|e| format!("llm_chat parse: {e}"))
}

/// Standalone async function for tool execution via callback registry.
async fn napi_execute_tool(
    tsfn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
    cancel: Option<Arc<AtomicBool>>,
) -> std::result::Result<ToolExecuteResponse, std::string::String> {
    let output = invoke_via_registry(
        &tsfn,
        input,
        "execute_tool",
        Some(HOST_TOOL_TIMEOUT),
        cancel,
    )
    .await?;
    serde_json::from_str(&output).map_err(|e| format!("execute_tool parse: {e}"))
}

// ── napi JS-side types ─────────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone)]
pub struct JsRunTurnParams {
    pub turn_id: String,
    pub system_prompt: String,
    pub model_name: String,
    pub messages: Vec<JsMessage>,
    pub tools: Vec<JsToolDef>,
    /// Step cap for the turn loop. `None` = unbounded (JS-loop semantics).
    pub max_steps: Option<u32>,
    pub goal: Option<JsGoalContext>,
    /// Native HTTP LLM transport. When present, Rust calls the provider
    /// directly (SSE streaming) instead of proxying through the host.
    pub native_llm: Option<JsNativeLlmConfig>,
    /// Concurrent MultiLLM providers (first-past-the-post race). When
    /// non-empty, the loop dispatches every step to all providers in
    /// parallel and accepts the first successful response. Wins over
    /// `native_llm` only when set.
    pub providers: Option<Vec<JsLlmProviderDef>>,
    /// Workspace root used to sandbox native tool execution.
    pub workspace_root: Option<String>,
    /// When true (with `workspace_root`), the in-process toolset
    /// (Read/Grep/Glob/Write/Edit/Bash, each gated on a host permission
    /// grant) runs inside the Rust process. Any tool not in that set, or
    /// any argument shape the toolset cannot handle, falls back to the
    /// host (`host/execute_tool`).
    ///
    /// Absent means `false`: executing on the host stays the fail-safe for a
    /// caller that does not state an intent, and the product default
    /// (native on) is resolved by the TS adapter — matching the stdio wire,
    /// where an absent `native_tools` is likewise false.
    pub native_tools: Option<bool>,
    /// Rust engine self-contained mode. When true, the engine refuses to
    /// fall back to the host proxy for LLM calls — the user must
    /// configure either `providers` (concurrent MultiLLM race) or
    /// `native_llm` (single provider direct HTTP), or the engine errors
    /// out at construction time instead of silently routing through
    /// `host/llm_chat`. Mirrors `agent.rustSelfContained` from config.
    pub rust_self_contained: Option<bool>,
    /// Host shell for native Bash (bash everywhere, Git Bash on Windows).
    /// Absent on Windows → native Bash stays with the host.
    pub shell_path: Option<String>,
    /// Optional JSON-serialized PolicySnapshot for local permission evaluation (P26 批 3).
    pub policy_snapshot_json: Option<String>,
    /// Host-resolved `[github]` config credentials for the native GitHub
    /// tools (v2 `configSection.ts`). Env fallbacks are applied Rust-side
    /// (v2 `envOverlay.ts` semantics: config wins, env fills the gap).
    pub github_token: Option<String>,
    pub github_base_url: Option<String>,
    /// Host-injected telemetry context (M1c): the host's model configuration
    /// merged into the engine-emitted `host/telemetry` events.
    pub telemetry: Option<JsTelemetryContext>,
    /// Session profile catalog snapshot (P46): profiles the native `Agent`
    /// tool may spawn. Empty/absent = every `Agent` call falls back to
    /// the host tool.
    pub subagent_profiles: Option<Vec<JsSubagentProfile>>,
    /// Host-resolved foreground subagent timeout in ms (v2
    /// `resolveSubagentTimeoutMs`). Absent → engine default (2h). `i64`
    /// because napi cannot read JS numbers as `u64`.
    pub subagent_timeout_ms: Option<i64>,
    /// P52 native-path vetoes (host-formatted deny reasons; see
    /// `RunTurnParams`).
    pub agent_tool_veto: Option<String>,
    pub tools_veto: Option<String>,
}

/// A subagent profile from the host's session catalog snapshot (P46).
#[napi(object)]
#[derive(Clone)]
pub struct JsSubagentProfile {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    /// Explicit tool allowlist; empty means every tool minus
    /// `disallowed_tools`.
    pub tools: Option<Vec<String>>,
    pub disallowed_tools: Option<Vec<String>>,
    /// Host-resolved prompt prefix (v2 `applyProfilePromptPrefix`),
    /// prepended to the prompt as `{prefix}\n\n{prompt}` (P51).
    pub prompt_prefix: Option<String>,
    /// Serialized summary distillation policy (v2
    /// `AgentProfileSummaryPolicy`): `{ minChars, continuationPrompt,
    /// retries }` (P51). Serialized JSON because napi cannot express
    /// nested optionals in a flat object cleanly.
    pub summary_policy_json: Option<String>,
}

/// The host-side half of the turn telemetry payload (M1c): fields the host
/// knows from its model configuration; the engine contributes the outcome
/// fields (reason / duration_ms / steps / at_step / interrupt_reason).
#[napi(object)]
#[derive(Clone)]
pub struct JsTelemetryContext {
    pub mode: String,
    pub provider_type: String,
    pub protocol: String,
    pub thinking_effort: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsLlmProviderDef {
    /// Provider label surfaced in events/telemetry for debugging.
    pub name: String,
    /// Per-provider model identifier (free-form string).
    pub model: String,
    /// Per-provider system prompt override.
    pub system_prompt: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsNativeLlmConfig {
    /// "openai" (Chat Completions) or "anthropic" (Messages).
    pub protocol: String,
    /// API base URL including the version segment (e.g. `.../v1`).
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: Option<u32>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsMessage {
    pub role: String,
    pub content: String,
    /// JSON-serialized `ContentBlock[]` for multimodal messages
    /// (`[{"type":"text",...},{"type":"image_url",...}]`). Optional.
    pub blocks_json: Option<String>,
    /// JSON-serialized tool calls (`[{id,name,arguments}]`) for an
    /// assistant history message. Optional.
    pub tool_calls_json: Option<String>,
    /// For a `tool` history message: the tool call id it answers.
    pub tool_call_id: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsToolDef {
    pub name: String,
    pub description: String,
    /// JSON string of the tool's input schema (e.g. `{"type":"object",...}`).
    /// serde_json::Value does not implement napi ToNapiValue/FromNapiValue,
    /// so we pass the schema as a serialized JSON string.
    pub input_schema: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsGoalContext {
    pub goal_id: String,
    pub objective: String,
    pub status: String,
    pub token_budget: Option<i64>,
    pub turn_budget: Option<i64>,
    pub wall_clock_budget_ms: Option<i64>,
    pub wall_clock_ms: i64,
    pub tokens_used: i64,
    pub turns_used: i64,
}

#[napi(object)]
pub struct JsRunTurnResult {
    pub stop_reason: String,
    pub steps: u32,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
    /// Prompt tokens served from the provider's cache.
    pub input_cache_read: u32,
    /// Prompt tokens written into the provider's cache by this turn.
    pub input_cache_creation: u32,
    /// Host-visible engine events emitted during the turn.
    pub events_emitted: u32,
    /// LLM retries performed during the turn (attempts beyond the first).
    pub llm_retries: u32,
    /// Which LLM transport served this turn: `native-http`, `host-proxy`, `multi`.
    pub llm_transport: String,
    /// Tool calls executed inside the engine; the rest round-tripped to the host.
    pub native_tool_calls: u32,
}

// ── napi exported functions ────────────────────────────────────────────────

/// Run a single turn of the agent loop via napi.
///
/// The two JS callbacks follow the **callback registry** pattern:
/// each receives a single `callbackId: number`. The JS side must:
/// 1. Call `getCallbackPayload(id)` to fetch the JSON request payload
/// 2. Process the request
/// 3. Call `resolveCallback(id, error?, result?)` to resolve
///
/// * `llm_chat_cb` — receives callback ID, fetches `LlmChatRequest` JSON
/// * `execute_tool_cb` — receives callback ID, fetches `ToolExecuteRequest` JSON
/// * `emit_event_cb` — optional; receives callback ID, fetches a JSON event
///   payload. Fire-and-forget: the JS side must NOT call `resolveCallback`.
/// * `ask_question_cb` — optional; receives callback ID, fetches an
///   `AskQuestionRequest` JSON payload and resolves with the host's answer.
/// * `state_read_cb` — optional; receives callback ID, fetches a
///   `StateReadRequest` JSON payload and resolves with the host's state
///   value.
/// * `state_write_cb` — optional; receives callback ID, fetches a
///   `StateWriteRequest` JSON payload and resolves with the host's result
///   state.
/// * `turn_event_cb` — optional; receives callback ID, fetches a
///   `TurnEvent` JSON payload (see `crate::turn_events`) and must NOT resolve
///   it. Only used once the engine owns the turn lifecycle; hosts that drive
///   `run_turn` per turn keep dispatching their own turn events.
///
/// JsFunction is converted to ThreadsafeFunction synchronously, then the
/// async work is dispatched via `env.execute_tokio_future` so the JS event
/// loop stays alive to process TSFN callbacks.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn run_turn_rust(
    env: Env,
    params: JsRunTurnParams,
    #[napi(ts_arg_type = "(callbackId: number) => void")] llm_chat_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] execute_tool_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] emit_event_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] check_permission_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] ask_question_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] state_read_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] state_write_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] checkpoint_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] turn_event_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] telemetry_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] list_tools_cb: Option<JsFunction>,
) -> napi::Result<JsObject> {
    // ── Convert JsFunction → ThreadsafeFunction synchronously ──────────
    // The TSFN passes only the callback ID (u32). The JS side fetches
    // the payload via getCallbackPayload(id) and resolves via resolveCallback.
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    let llm_chat_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> = llm_chat_cb
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let id = ctx.value;
            let js_num = ctx.env.create_uint32(id)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })?;

    let execute_tool_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> = execute_tool_cb
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let id = ctx.value;
            let js_num = ctx.env.create_uint32(id)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })?;

    let emit_event_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match emit_event_cb
    {
        Some(cb) => Some(
            cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?,
        ),
        None => None,
    };

    let check_permission_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> =
        match check_permission_cb {
            Some(cb) => Some(cb.create_threadsafe_function(
                0,
                |ctx: ThreadSafeCallContext<u32>| {
                    let id = ctx.value;
                    let js_num = ctx.env.create_uint32(id)?;
                    let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                    Ok(args)
                },
            )?),
            None => None,
        };

    let ask_question_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> =
        match ask_question_cb {
            Some(cb) => Some(cb.create_threadsafe_function(
                0,
                |ctx: ThreadSafeCallContext<u32>| {
                    let id = ctx.value;
                    let js_num = ctx.env.create_uint32(id)?;
                    let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                    Ok(args)
                },
            )?),
            None => None,
        };

    let state_read_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match state_read_cb
    {
        Some(cb) => Some(
            cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?,
        ),
        None => None,
    };

    let state_write_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> =
        match state_write_cb {
            Some(cb) => Some(cb.create_threadsafe_function(
                0,
                |ctx: ThreadSafeCallContext<u32>| {
                    let id = ctx.value;
                    let js_num = ctx.env.create_uint32(id)?;
                    let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                    Ok(args)
                },
            )?),
            None => None,
        };

    let checkpoint_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match checkpoint_cb
    {
        Some(cb) => Some(
            cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?,
        ),
        None => None,
    };

    let turn_event_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match turn_event_cb
    {
        Some(cb) => Some(
            cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?,
        ),
        None => None,
    };

    let telemetry_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match telemetry_cb {
        Some(cb) => Some(
            cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?,
        ),
        None => None,
    };

    let list_tools_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match list_tools_cb
    {
        Some(cb) => Some(
            cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?,
        ),
        None => None,
    };

    // ── Dispatch async work via execute_tokio_future ───────────────────
    // The future is Send because JsFunction has been converted to TSFN
    // and dropped from scope before the async block.
    env.execute_tokio_future(
        async move {
            run_turn_rust_impl(
                params,
                llm_chat_tsfn,
                execute_tool_tsfn,
                emit_event_tsfn,
                check_permission_tsfn,
                ask_question_tsfn,
                state_read_tsfn,
                state_write_tsfn,
                checkpoint_tsfn,
                turn_event_tsfn,
                telemetry_tsfn,
                list_tools_tsfn,
            )
            .await
        },
        |env: &mut Env, val: JsRunTurnResult| js_object_from_run_turn_result(env, val),
    )
}

/// The TSFN set the JS host wires for one engine attachment — per turn today
/// (`run_turn_rust`), per session once the M1d session handle lands.
struct EngineCallbackTsfns {
    llm_chat: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    execute_tool: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    emit_event: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    check_permission: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    ask_question: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    state_read: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    state_write: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    checkpoint: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    turn_event: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    telemetry: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    list_tools: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    /// Optional current-goal channel (wired by the session handle; the
    /// per-turn legacy entry reads the goal from `JsRunTurnParams`).
    goal: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    /// The cancellation flag the host callbacks observe (per turn today; the
    /// session handle passes its own per-turn flag through `cancel_turn`).
    cancellation: Option<Arc<AtomicBool>>,
}

/// The engine pipeline shared by the per-turn `run_turn_rust` entry and the
/// M1d session handle: the host callback chain (counting + native-tool
/// execution over the TSFN set) plus the LLM selection (multi / native-http /
/// host-proxy).
struct EnginePipeline {
    llm: Arc<dyn LLM>,
    callbacks: Arc<dyn HostCallbacks>,
    /// Event counter from the counting wrapper (turn result telemetry).
    turn_event_count: Arc<std::sync::atomic::AtomicU32>,
    /// Native tool call counter from the native-tool wrapper.
    native_tool_count: Arc<std::sync::atomic::AtomicU32>,
}

/// Build the callback chain and the LLM for one engine context. The chain is
/// identical for every entry path: NapiHostCallbacks over the TSFN set →
/// counting wrapper (all event paths counted) → native-tool wrapper
/// (in-process Read/Grep/Glob/Write/Edit/Bash, permission engine, truncation,
/// plan-mode guard). The LLM picks multi > native-http > host-proxy, with the
/// self-contained mode refusing the host-proxy fallback.
async fn build_engine_pipeline(
    params: &JsRunTurnParams,
    tsfns: EngineCallbackTsfns,
    parent_cancel: Option<crate::subagent::types::ParentCancel>,
) -> napi::Result<EnginePipeline> {
    // Session profile catalog snapshot (P46): refresh the process-wide
    // manager's definitions per turn so the native `Agent` tool sees the
    // host's builtin/workspace/user profiles (plugin and external-backend
    // profiles never arrive here — those calls fall back to the host).
    if let Some(profiles) = &params.subagent_profiles {
        let wires: Vec<crate::rpc::types::SubagentProfileWire> = profiles
            .iter()
            .map(|p| crate::rpc::types::SubagentProfileWire {
                name: p.name.clone(),
                description: p.description.clone().unwrap_or_default(),
                system_prompt: p.system_prompt.clone().unwrap_or_default(),
                tools: p.tools.clone().unwrap_or_default(),
                disallowed_tools: p.disallowed_tools.clone().unwrap_or_default(),
                prompt_prefix: p.prompt_prefix.clone(),
                summary_policy: p.summary_policy_json.as_deref().and_then(|j| {
                    serde_json::from_str::<crate::subagent::types::SummaryPolicy>(j).ok()
                }),
            })
            .collect();
        SUBAGENT_MANAGER.register_profile_snapshot(&wires).await;
    }

    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(NapiHostCallbacks {
        llm_chat_fn: Arc::new(tsfns.llm_chat),
        execute_tool_fn: Arc::new(tsfns.execute_tool),
        emit_event_fn: tsfns.emit_event.map(Arc::new),
        check_permission_fn: tsfns.check_permission.map(Arc::new),
        ask_question_fn: tsfns.ask_question.map(Arc::new),
        state_read_fn: tsfns.state_read.map(Arc::new),
        checkpoint_fn: tsfns.checkpoint.map(Arc::new),
        state_write_fn: tsfns.state_write.map(Arc::new),
        turn_event_fn: tsfns.turn_event.map(Arc::new),
        telemetry_fn: tsfns.telemetry.map(Arc::new),
        list_tools_fn: tsfns.list_tools.map(Arc::new),
        goal_fn: tsfns.goal.map(Arc::new),
        cancellation: tsfns.cancellation,
    });

    // Count every event this turn emits (step lifecycle, deltas, native
    // tools, goal budget limits) for the turn telemetry. Wrapped before the
    // tool wrapper and the native LLM event sink so all paths are counted.
    let turn_event_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let event_bus = std::sync::Arc::new(crate::events::EventBus::new());
    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(
        CountingCallbacks::new(base_callbacks, turn_event_count.clone())
            .with_bus(event_bus.clone()),
    );

    // Native tool execution: wrap the callbacks so the in-process toolset
    // (Read/Grep/Glob/Write/Edit/Bash) runs in-process (sandboxed to the
    // workspace) and everything else — and anything that escapes the
    // sandbox — still round-trips to the host.
    //
    // The wrapper always carries a local truncator (M2 切片 2): result
    // truncation + spill run in-process, no host finalize seam.
    let native_tool_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let truncator = params
        .workspace_root
        .as_deref()
        .map(std::path::Path::new)
        .map(|root| {
            Arc::new(crate::tool_result_truncation::ToolResultTruncator::for_workspace(root))
        });
    let policy_snapshot = params
        .policy_snapshot_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<crate::permission::PolicySnapshot>(j).ok());
    let permission_engine = policy_snapshot
        .clone()
        .map(|s| Arc::new(crate::permission::PermissionEngine::new(s)));
    let callbacks: Arc<dyn HostCallbacks> = match (
        params.native_tools.unwrap_or(false),
        params.workspace_root.as_deref(),
    ) {
        (true, Some(root)) => {
            match crate::tools::NativeToolset::new(root, params.shell_path.as_deref()) {
                Some(toolset) => {
                    // Plan-mode guard (v2 `AgentPlanService.guardToolExecution`):
                    // guarded native calls read the host's plan state through
                    // the state bridge and are denied when plan mode forbids
                    // them. Unguarded tools skip the round-trip entirely.
                    let plan_callbacks = base_callbacks.clone();
                    let plan_workspace = params.workspace_root.clone();
                    // Stale-write gate (v2 `staleGuardService`, G-6 #3): the
                    // table is created with the pipeline — once per session
                    // (create_engine_session) — so read state survives across
                    // turns like v2's per-agent-scope guard state.
                    let stale_gate = Arc::new(crate::tools::stale_guard::StaleGate::new(
                        params.workspace_root.clone().map(std::path::PathBuf::from),
                    ));
                    // Goal-operation guard (v2 `goalAgentRuntime`, G-6 #7/#8):
                    // non-auto CreateGoal routes to the host (goal-start
                    // review fires there); stale goal mutations veto. The
                    // mode comes from the pipeline's permission snapshot.
                    let goal_guard = Arc::new(crate::tools::goal_guard::GoalGuard::new(
                        permission_engine.as_ref().map(|e| e.mode()),
                        true,
                    ));
                    // PreToolUse hooks (v2 `agentExternalHooksService`,
                    // G-6 #6): user-configured commands gate native calls.
                    let hook_guard = policy_snapshot.clone().map(|s| {
                        Arc::new(crate::tools::external_hooks::HookGuard::new(
                            s.pre_tool_hooks,
                        ))
                    });
                    Arc::new(NativeToolCallbacks {
                        inner: base_callbacks.clone(),
                        toolset: Arc::new(
                            toolset
                                .with_subagents(SUBAGENT_MANAGER.clone())
                                .with_agent_context(
                                    params
                                        .subagent_timeout_ms
                                        .filter(|t| *t > 0)
                                        .map(|t| t as u64),
                                    parent_cancel,
                                )
                                .with_callbacks(base_callbacks.clone())
                                .with_github_credentials(crate::tools::github::GitHubCredentials {
                                    token: params.github_token.clone(),
                                    base_url: params.github_base_url.clone(),
                                }),
                        ),
                        native_count: native_tool_count.clone(),
                        truncator: truncator.clone(),
                        permission_engine,
                        plan_guard: Some(Arc::new(move |tool_name, args| {
                            if !crate::tools::plan_mode::plan_guarded_tool(tool_name) {
                                return Box::pin(async { None });
                            }
                            let callbacks = plan_callbacks.clone();
                            let tool_name = tool_name.to_string();
                            let args = args.clone();
                            let workspace = plan_workspace.clone();
                            Box::pin(async move {
                                let request = StateReadRequest {
                                    domain: "plan".into(),
                                    key: "plan".into(),
                                    turn_id: String::new(),
                                    tool_call_id: String::new(),
                                };
                                match callbacks.state_read(request).await {
                                    Ok(response) => crate::tools::plan_mode::plan_denial(
                                        &response.value,
                                        &tool_name,
                                        &args,
                                        workspace.as_deref().map(std::path::Path::new),
                                    ),
                                    Err(_) => None,
                                }
                            })
                        })),
                        stale_guard: Some(stale_gate),
                        goal_guard: Some(goal_guard),
                        hook_guard,
                        agent_tool_veto: params.agent_tool_veto.clone(),
                        tools_veto: params.tools_veto.clone(),
                    })
                }
                None => base_callbacks.clone(),
            }
        }
        _ => base_callbacks.clone(),
    };

    // LLM selection — priority order:
    //   1. providers (concurrent MultiLLM race) — when set, all providers
    //      run in parallel and the first success wins
    //   2. native_llm — Rust calls a single provider directly via HTTP/SSE
    //   3. host proxy — caller (napi host) handles the actual LLM call
    //      (skipped when `rust_self_contained` is set; the engine errors
    //      out instead, see kimi-agent ROADMAP P26 批 1)
    let llm: Box<dyn LLM> =
        if let Some(providers) = params.providers.as_ref().filter(|p| !p.is_empty()) {
            let rust_providers: Vec<LlmProvider> = providers
                .iter()
                .map(|p| LlmProvider {
                    name: p.name.clone(),
                    system_prompt: p.system_prompt.clone(),
                    model: p.model.clone(),
                    callbacks: callbacks.clone(),
                })
                .collect();
            Box::new(MultiLLM::new(rust_providers))
        } else {
            match &params.native_llm {
                Some(cfg) => {
                    let sink_callbacks = callbacks.clone();
                    let native = NativeHttpLlm::new(
                        NativeLlmConfig {
                            protocol: cfg.protocol.clone(),
                            base_url: cfg.base_url.clone(),
                            api_key: cfg.api_key.clone(),
                            model: cfg.model.clone(),
                            max_tokens: cfg.max_tokens,
                            custom_headers: Default::default(),
                        },
                        params.system_prompt.clone(),
                    )
                    .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event)));
                    Box::new(native)
                }
                None => {
                    // Self-contained mode: refuse to fall back to host proxy.
                    if params.rust_self_contained.unwrap_or(false) {
                        return Err(napi::Error::from_reason(
                            "rustSelfContained=true requires providers or native_llm to be \
                             set; refusing to fall back to host/llm_chat (P26 批 1)"
                                .to_string(),
                        ));
                    }
                    Box::new(
                        HostLlmProxy::new(params.system_prompt.clone(), params.model_name.clone())
                            .with_callbacks(callbacks.clone()),
                    )
                }
            }
        };

    // P28 批 3 接线: subagents run real turns with this turn's llm and the
    // native callback pipeline (tools + permission + truncation).
    let llm: Arc<dyn LLM> = Arc::from(llm);
    SUBAGENT_MANAGER
        .set_runtime(llm.clone(), callbacks.clone())
        .await;

    Ok(EnginePipeline {
        llm,
        callbacks,
        turn_event_count,
        native_tool_count,
    })
}

/// Inner async implementation — all captured values are `Send`.
#[allow(clippy::too_many_arguments)]
async fn run_turn_rust_impl(
    params: JsRunTurnParams,
    llm_chat_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    execute_tool_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    emit_event_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    check_permission_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    ask_question_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    state_read_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    state_write_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    checkpoint_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    turn_event_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    telemetry_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    list_tools_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
) -> napi::Result<JsRunTurnResult> {
    // Register the turn's cancellation signal up front so a JS-side
    // `cancel_turn` can interrupt host callbacks (permission waits
    // included) while this turn is in flight — and, since P51, abort a
    // foreground subagent immediately.
    let turn_id = params.turn_id.clone();
    let cancellation = Arc::new(AtomicBool::new(false));
    let parent_cancel = crate::subagent::types::ParentCancel::from_flag(cancellation.clone());
    CANCEL_MAP
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(turn_id.clone(), parent_cancel.clone());

    let pipeline = build_engine_pipeline(
        &params,
        EngineCallbackTsfns {
            llm_chat: llm_chat_tsfn,
            execute_tool: execute_tool_tsfn,
            emit_event: emit_event_tsfn,
            check_permission: check_permission_tsfn,
            ask_question: ask_question_tsfn,
            state_read: state_read_tsfn,
            state_write: state_write_tsfn,
            checkpoint: checkpoint_tsfn,
            turn_event: turn_event_tsfn,
            telemetry: telemetry_tsfn,
            list_tools: list_tools_tsfn,
            // The legacy per-turn entry reads the goal from params, so the
            // callback channel stays unwired (goal() fails open).
            goal: None,
            cancellation: Some(cancellation.clone()),
        },
        Some(parent_cancel.clone()),
    )
    .await?;
    let llm = pipeline.llm;
    let callbacks = pipeline.callbacks;
    let turn_event_count = pipeline.turn_event_count;
    let native_tool_count = pipeline.native_tool_count;

    let messages: Vec<LLMMessage> = params
        .messages
        .iter()
        .map(|m| LLMMessage {
            role: m.role.clone(),
            content: m.content.clone(),
            blocks: m
                .blocks_json
                .as_deref()
                .and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default(),
            tool_calls: m
                .tool_calls_json
                .as_deref()
                .and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default(),
            tool_call_id: m.tool_call_id.clone(),
        })
        .collect();

    let tool_defs: Vec<ToolInfo> = params
        .tools
        .iter()
        .map(|t| ToolInfo {
            name: t.name.clone(),
            description: t.description.clone(),
            input_schema: serde_json::from_str(&t.input_schema).unwrap_or_default(),
        })
        .collect();

    let goal = params.goal.map(|g| GoalContext {
        goal_id: g.goal_id,
        objective: g.objective,
        status: match g.status.as_str() {
            "active" => GoalStatus::Active,
            "paused" => GoalStatus::Paused,
            "blocked" => GoalStatus::Blocked,
            "complete" => GoalStatus::Complete,
            "budgetLimited" => GoalStatus::BudgetLimited,
            "usageLimited" => GoalStatus::UsageLimited,
            _ => GoalStatus::Active,
        },
        token_budget: g.token_budget,
        turn_budget: g.turn_budget,
        wall_clock_budget_ms: g.wall_clock_budget_ms,
        wall_clock_ms: g.wall_clock_ms,
        tokens_used: g.tokens_used,
        turns_used: g.turns_used,
    });

    let input = RunTurnInput {
        turn_id: turn_id.clone(),
        llm: llm.as_ref(),
        messages,
        tools: &[],
        tool_defs,
        // None = unbounded, mirroring the JS loop (which only stops on a
        // configured `maxStepsPerTurn`).
        max_steps: params.max_steps.unwrap_or(u32::MAX),
        goal,
        cancellation: Some(cancellation),
    };

    let telemetry_context = params.telemetry.map(|t| TelemetryContext {
        mode: t.mode,
        provider_type: t.provider_type,
        protocol: t.protocol,
        thinking_effort: t.thinking_effort,
    });
    let result = match telemetry_context {
        Some(context) => run_turn_with_telemetry(input, context, &callbacks).await,
        None => run_turn(input, &callbacks).await,
    };

    CANCEL_MAP
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&turn_id);

    let result = result.map_err(|e| napi::Error::from_reason(format!("run_turn failed: {e}")))?;

    Ok(js_run_turn_result(
        result,
        &turn_event_count,
        &native_tool_count,
        llm.transport(),
    ))
}

/// Project a `TurnResult` onto the napi result shape. The counters come from
/// the pipeline's wrappers (per turn today; per session for the M1d handle).
fn js_run_turn_result(
    result: TurnResult,
    turn_event_count: &std::sync::atomic::AtomicU32,
    native_tool_count: &std::sync::atomic::AtomicU32,
    llm_transport: &str,
) -> JsRunTurnResult {
    JsRunTurnResult {
        stop_reason: format!("{:?}", result.stop_reason),
        steps: result.steps,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        total_tokens: result.usage.total_tokens,
        input_cache_read: result.usage.input_cache_read,
        input_cache_creation: result.usage.input_cache_creation,
        events_emitted: turn_event_count.load(std::sync::atomic::Ordering::Relaxed),
        llm_retries: result.llm_retries,
        llm_transport: llm_transport.to_string(),
        native_tool_calls: native_tool_count.load(std::sync::atomic::Ordering::Relaxed),
    }
}

/// Build the JS object for a `JsRunTurnResult` — shared by the per-turn
/// deferred and the session outcome deferred.
fn js_object_from_run_turn_result(env: &mut Env, val: JsRunTurnResult) -> napi::Result<JsObject> {
    let mut obj = env.create_object()?;
    obj.set_named_property("stopReason", env.create_string_from_std(val.stop_reason)?)?;
    obj.set_named_property("steps", env.create_uint32(val.steps)?)?;
    obj.set_named_property("inputTokens", env.create_uint32(val.input_tokens)?)?;
    obj.set_named_property("outputTokens", env.create_uint32(val.output_tokens)?)?;
    obj.set_named_property("totalTokens", env.create_uint32(val.total_tokens)?)?;
    obj.set_named_property("inputCacheRead", env.create_uint32(val.input_cache_read)?)?;
    obj.set_named_property(
        "inputCacheCreation",
        env.create_uint32(val.input_cache_creation)?,
    )?;
    obj.set_named_property("eventsEmitted", env.create_uint32(val.events_emitted)?)?;
    obj.set_named_property("llmRetries", env.create_uint32(val.llm_retries)?)?;
    obj.set_named_property(
        "llmTransport",
        env.create_string_from_std(val.llm_transport)?,
    )?;
    obj.set_named_property("nativeToolCalls", env.create_uint32(val.native_tool_calls)?)?;
    Ok(obj)
}

// ── EngineSession handle (M1d) ─────────────────────────────────────────────
// The napi boundary upgrades from "one call per turn" to a session handle:
// the pipeline is built once, and admission (four modes), the pending FIFO,
// the pump, turn ids, cancellation, and quiescence live engine-side. This is
// the foundation for deleting `executeTurnViaEngine` and flipping turn
// ownership; the JS side addresses sessions by id (the CANCEL_MAP registry
// style — no napi class surface yet).

/// Live sessions keyed by id. One CLI process runs one session today; the
/// registry keeps the surface uniform for tests and future multi-session
/// hosts. A disposed session's pump task parks forever on its wakeup channel
/// (bounded: one session per process) — teardown joins it in M2.
static SESSION_REGISTRY: LazyLock<Mutex<HashMap<String, SessionEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Outcome receivers for enqueued turns, keyed by (session, turn). Enqueue
/// stores the receiver; `session_turn_outcome` takes it and resolves the JS
/// promise when the pump finishes the turn.
type SessionOutcomeMap = HashMap<(String, u64), oneshot::Receiver<Result<TurnOutcome, String>>>;
static SESSION_OUTCOMES: LazyLock<Mutex<SessionOutcomeMap>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static SESSION_NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Clone)]
struct SessionEntry {
    session: Arc<EngineSession>,
    turn_event_count: Arc<std::sync::atomic::AtomicU32>,
    native_tool_count: Arc<std::sync::atomic::AtomicU32>,
    llm_transport: String,
    /// The live quiescence guard (M1c RAII). Acquire stores it; release drops
    /// it — the drop replays held turns and wakes the pump.
    quiescence_guard: Arc<Mutex<Option<crate::session::QuiescenceGuard>>>,
}

fn session_entry(session_id: &str) -> napi::Result<SessionEntry> {
    SESSION_REGISTRY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .cloned()
        .ok_or_else(|| napi::Error::from_reason(format!("unknown session: {session_id}")))
}

fn make_tsfn(
    cb: Option<JsFunction>,
) -> napi::Result<Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>> {
    match cb {
        Some(cb) => Ok(Some(cb.create_threadsafe_function(
            0,
            |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            },
        )?)),
        None => Ok(None),
    }
}

fn make_required_tsfn(
    cb: JsFunction,
) -> napi::Result<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> {
    cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
        let id = ctx.value;
        let js_num = ctx.env.create_uint32(id)?;
        let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
        Ok(args)
    })
}

/// Live session shape for the JS side (v2 `AgentLoopStatus`).
#[napi(object)]
pub struct JsSessionStatus {
    pub active_turn_id: Option<f64>,
    pub pending_turn_ids: Vec<f64>,
    /// P56 (G-5): execution-path summary of the last completed turn.
    pub engine: Option<JsEngineExecSummary>,
}

/// P56 (G-5): cross-process engine execution summary.
#[napi(object)]
#[derive(Clone, Default)]
pub struct JsEngineExecSummary {
    pub transport: Option<String>,
    pub native_tool_calls: Option<f64>,
    pub steps: Option<f64>,
    pub stop_reason: Option<String>,
}

/// The outcome of one enqueued turn. Engine-side failures reject the outcome
/// promise; `cancelledBeforeStart` means the turn was dropped from the queue
/// without running.
#[napi(object)]
pub struct JsTurnOutcome {
    pub status: String,
    pub result: Option<JsRunTurnResult>,
}

/// Create a session handle: the engine pipeline is built once and every
/// enqueued turn runs through it. The turn clock is read from the host's
/// `turn` state domain at construction (M1b single-writer contract). The
/// tool table is pulled fresh per turn through `list_tools_cb` (native
/// transports only — host-proxy rebuilds tools inside `llm_chat`), and the
/// goal snapshot through `goal_cb` per turn (snake_case wire goal, or null).
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn create_engine_session(
    env: Env,
    params: JsRunTurnParams,
    #[napi(ts_arg_type = "(callbackId: number) => void")] llm_chat_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] execute_tool_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] emit_event_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] check_permission_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] ask_question_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] state_read_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] state_write_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] checkpoint_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] turn_event_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] telemetry_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] list_tools_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] goal_cb: Option<JsFunction>,
) -> napi::Result<JsObject> {
    let llm_chat_tsfn = make_required_tsfn(llm_chat_cb)?;
    let execute_tool_tsfn = make_required_tsfn(execute_tool_cb)?;
    let emit_event_tsfn = make_tsfn(emit_event_cb)?;
    let check_permission_tsfn = make_tsfn(check_permission_cb)?;
    let ask_question_tsfn = make_tsfn(ask_question_cb)?;
    let state_read_tsfn = make_tsfn(state_read_cb)?;
    let state_write_tsfn = make_tsfn(state_write_cb)?;
    let checkpoint_tsfn = make_tsfn(checkpoint_cb)?;
    let turn_event_tsfn = make_tsfn(turn_event_cb)?;
    let telemetry_tsfn = make_tsfn(telemetry_cb)?;
    let list_tools_tsfn = make_tsfn(list_tools_cb)?;
    let goal_tsfn = make_tsfn(goal_cb)?;
    let list_tools_for_defs = list_tools_tsfn.clone();

    env.execute_tokio_future(
        async move {
            let pipeline = build_engine_pipeline(
                &params,
                EngineCallbackTsfns {
                    llm_chat: llm_chat_tsfn,
                    execute_tool: execute_tool_tsfn,
                    emit_event: emit_event_tsfn,
                    check_permission: check_permission_tsfn,
                    ask_question: ask_question_tsfn,
                    state_read: state_read_tsfn,
                    state_write: state_write_tsfn,
                    checkpoint: checkpoint_tsfn,
                    turn_event: turn_event_tsfn,
                    telemetry: telemetry_tsfn,
                    list_tools: list_tools_tsfn,
                    goal: goal_tsfn.clone(),
                    cancellation: None,
                },
                // Session pipeline: no per-turn cancellation at build time
                // (the session pump owns its own abort path); the native
                // `Agent` tool runs with the timeout only.
                None,
            )
            .await?;

            // Turn-start tool table: pulled fresh from the host per turn on
            // native transports (host-proxy rebuilds tools inside llm_chat
            // and never consults the engine's table). run_turn's per-step
            // `host/list_tools` refresh stays the authoritative source; this
            // provider only seeds the snapshot fallback.
            let is_host_proxy = pipeline.llm.transport() == "host-proxy";
            let tool_defs_provider: ToolDefsProvider = if is_host_proxy {
                Arc::new(|| Box::pin(async { Vec::new() }))
            } else {
                match list_tools_for_defs {
                    Some(tsfn) => Arc::new(move || {
                        let tsfn = Arc::new(tsfn.clone());
                        Box::pin(async move {
                            match invoke_via_registry(
                                &tsfn,
                                "{}".to_string(),
                                "list_tools",
                                Some(HOST_LIST_TOOLS_TIMEOUT),
                                None,
                            )
                            .await
                            {
                                Ok(output) => serde_json::from_str::<ListToolsResponse>(&output)
                                    .map(|r| r.tools)
                                    .unwrap_or_default(),
                                Err(_) => Vec::new(),
                            }
                        })
                    }),
                    None => Arc::new(|| Box::pin(async { Vec::new() })),
                }
            };

            // Fresh goal snapshot per turn (budget checks + steering). The
            // callback returns the snake_case wire goal JSON, or null.
            let goal_provider: Option<GoalProvider> = goal_tsfn.map(|tsfn| {
                let provider: GoalProvider = Arc::new(move || {
                    let tsfn = Arc::new(tsfn.clone());
                    Box::pin(async move {
                        let output = invoke_via_registry(
                            &tsfn,
                            "{}".to_string(),
                            "session_goal",
                            None,
                            None,
                        )
                        .await
                        .ok()?;
                        serde_json::from_str::<GoalContext>(&output).ok()
                    })
                });
                provider
            });

            let session = EngineSession::new(SessionConfig {
                llm: pipeline.llm.clone(),
                callbacks: pipeline.callbacks.clone(),
                max_steps: params.max_steps.unwrap_or(u32::MAX),
                tool_defs: tool_defs_provider,
                goal: goal_provider,
                on_before_turn: None,
                agent_cancel_slot: None,
            })
            .await;

            let session_id = format!("session-{}", SESSION_NEXT_ID.fetch_add(1, Ordering::SeqCst));
            SESSION_REGISTRY
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    session_id.clone(),
                    SessionEntry {
                        session: Arc::new(session),
                        turn_event_count: pipeline.turn_event_count,
                        native_tool_count: pipeline.native_tool_count,
                        llm_transport: pipeline.llm.transport().to_string(),
                        quiescence_guard: Arc::new(Mutex::new(None)),
                    },
                );
            Ok(session_id)
        },
        |env, id: String| env.create_string(&id),
    )
}

/// Enqueue a prompt. The turn id is assigned synchronously (monotonic, never
/// reused), so the caller can cancel by id immediately; the outcome resolves
/// through `session_turn_outcome`. `prompt` is a serialized `LLMMessage`
/// JSON (role/content/blocks/tool_calls/tool_call_id).
#[napi]
pub fn session_enqueue_turn(
    session_id: String,
    prompt: String,
    admission: String,
) -> napi::Result<f64> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        let prompt: LLMMessage = serde_json::from_str(&prompt)
            .map_err(|e| napi::Error::from_reason(format!("prompt parse: {e}")))?;
        let admission = match admission.as_str() {
            "newTurn" => Admission::NewTurn,
            "activeOrNewTurn" => Admission::ActiveOrNewTurn,
            "activeOrNextTurn" => Admission::ActiveOrNextTurn,
            "activeTurnOnly" => Admission::ActiveTurnOnly,
            other => {
                return Err(napi::Error::from_reason(format!(
                    "unknown admission mode: {other}"
                )));
            }
        };
        let receipt = entry
            .session
            .enqueue_turn(TurnRequest::user(prompt, admission))
            .map_err(napi::Error::from_reason)?;
        let (turn_id, outcome) = receipt.into_parts();
        SESSION_OUTCOMES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((session_id, turn_id), outcome);
        Ok(turn_id as f64)
    })
}

/// Resolve with the outcome of one enqueued turn. Takes the stored receiver —
/// the outcome is delivered exactly once.
#[napi]
pub fn session_turn_outcome(env: Env, session_id: String, turn_id: f64) -> napi::Result<JsObject> {
    let receiver = {
        let mut outcomes = SESSION_OUTCOMES.lock().unwrap_or_else(|e| e.into_inner());
        outcomes
            .remove(&(session_id.clone(), turn_id as u64))
            .ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "no outcome pending for {session_id} turn {turn_id}"
                ))
            })?
    };
    let entry = session_entry(&session_id)?;
    let turn_event_count = entry.turn_event_count;
    let native_tool_count = entry.native_tool_count;
    let llm_transport = entry.llm_transport;

    env.execute_tokio_future(
        async move {
            let outcome = receiver
                .await
                .map_err(|_| napi::Error::from_reason("session dropped"))?
                .map_err(napi::Error::from_reason)?;
            Ok(outcome)
        },
        move |env, outcome: TurnOutcome| {
            let mut obj = env.create_object()?;
            match outcome {
                TurnOutcome::Ran(result) => {
                    obj.set_named_property("status", env.create_string("ran")?)?;
                    let result_obj = js_object_from_run_turn_result(
                        env,
                        js_run_turn_result(
                            result,
                            &turn_event_count,
                            &native_tool_count,
                            &llm_transport,
                        ),
                    )?;
                    obj.set_named_property("result", result_obj)?;
                }
                TurnOutcome::CancelledBeforeStart => {
                    obj.set_named_property("status", env.create_string("cancelledBeforeStart")?)?;
                    obj.set_named_property("result", env.get_null()?)?;
                }
            }
            Ok(obj)
        },
    )
}

/// Cancel a turn by id (active → interrupted at the next step boundary;
/// queued or quiescence-held → dropped with `cancelledBeforeStart`). Without
/// an id the active turn (if any) is cancelled. Returns whether anything was
/// cancelled.
#[napi]
pub fn session_cancel_turn(session_id: String, turn_id: Option<f64>) -> napi::Result<bool> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        Ok(entry.session.cancel_turn(turn_id.map(|id| id as u64)))
    })
}

/// Live session shape: the active turn id and the queued turn ids.
#[napi]
pub fn session_status(session_id: String) -> napi::Result<JsSessionStatus> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        let status = entry.session.status();
        Ok(JsSessionStatus {
            active_turn_id: status.active_turn_id.map(|id| id as f64),
            pending_turn_ids: status
                .pending_turn_ids
                .into_iter()
                .map(|id| id as f64)
                .collect(),
            engine: status.engine.map(|e| JsEngineExecSummary {
                transport: e.transport,
                native_tool_calls: e.native_tool_calls.map(|n| n as f64),
                steps: e.steps.map(|s| s as f64),
                stop_reason: e.stop_reason,
            }),
        })
    })
}

/// Whether the session is fully idle right now (nothing active, pending, or
/// held).
#[napi]
pub fn session_is_settled(session_id: String) -> napi::Result<bool> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        Ok(entry.session.is_settled())
    })
}

/// Resolves once the session is fully idle: no active turn, no pending or
/// held turns.
#[napi]
pub fn session_settled(env: Env, session_id: String) -> napi::Result<JsObject> {
    let entry = session_entry(&session_id)?;
    let session = entry.session;
    env.execute_tokio_future(
        async move {
            session.settled().await;
            Ok(())
        },
        |env, ()| env.get_undefined(),
    )
}

/// Replace the session's cross-turn history (the next enqueued turn starts
/// from it, with the new prompt appended).
#[napi]
pub fn session_set_history(session_id: String, history_json: String) -> napi::Result<()> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        let history: Vec<LLMMessage> = serde_json::from_str(&history_json)
            .map_err(|e| napi::Error::from_reason(format!("history parse: {e}")))?;
        entry.session.set_history(history);
        Ok(())
    })
}

#[napi]
pub fn session_clear_history(session_id: String) -> napi::Result<()> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        entry.session.clear_history();
        Ok(())
    })
}

/// Append messages to the cross-turn history (e.g. a resumed transcript).
#[napi]
pub fn session_extend_history(session_id: String, history_json: String) -> napi::Result<()> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        let history: Vec<LLMMessage> = serde_json::from_str(&history_json)
            .map_err(|e| napi::Error::from_reason(format!("history parse: {e}")))?;
        entry.session.extend_history(history);
        Ok(())
    })
}

#[napi]
pub fn session_history_len(session_id: String) -> napi::Result<u32> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        Ok(entry.session.history_len() as u32)
    })
}

/// Drop the session handle. The engine-owned pump task parks forever once the
/// process has no other session reference (bounded: one session per process
/// today); a joined teardown belongs to the ownership flip.
#[napi]
pub fn session_dispose(session_id: String) -> napi::Result<()> {
    guard_sync_panic(|| {
        SESSION_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&session_id);
        Ok(())
    })
}

/// Try to acquire quiescence (M1c): an exclusive window in which enqueued
/// turns are parked instead of admitted. Fails when a guard is already held
/// or any turn is active, pending, or held — the caller waits for
/// `session_settled` and retries. The guard lives in the registry; release
/// with `session_release_quiescence`.
#[napi]
pub fn session_try_acquire_quiescence(session_id: String) -> napi::Result<bool> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        match entry.session.try_acquire_quiescence() {
            Some(guard) => {
                *entry
                    .quiescence_guard
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(guard);
                Ok(true)
            }
            None => Ok(false),
        }
    })
}

/// Release the quiescence window: held turns replay in FIFO order and the
/// pump wakes. A no-op when no guard is held.
#[napi]
pub fn session_release_quiescence(session_id: String) -> napi::Result<()> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        *entry
            .quiescence_guard
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pruning must drop the OLDEST payloads. Iterating a HashMap yields ids
    /// in arbitrary order, which used to let the prune discard payloads JS had
    /// not collected yet while keeping long-dead ones.
    #[test]
    fn payload_registry_prunes_oldest_first() {
        let base = NEXT_CALLBACK_ID.fetch_add(2_000, Ordering::SeqCst);
        let total = PAYLOAD_REGISTRY_MAX_ENTRIES as u32 + 50;
        for offset in 0..total {
            store_payload(base + offset, format!("p{offset}"));
        }

        let registry = PAYLOAD_REGISTRY.lock().unwrap();
        assert!(
            registry.len() <= PAYLOAD_REGISTRY_MAX_ENTRIES,
            "registry must stay bounded"
        );
        assert!(
            !registry.contains_key(&base),
            "the oldest payload must go first"
        );
        assert!(
            registry.contains_key(&(base + total - 1)),
            "the newest payload must survive"
        );
    }
}
