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
use std::sync::{Arc, LazyLock, Mutex, Weak};
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
    HOST_AUTH_TOKEN_TIMEOUT, HOST_LIST_TOOLS_TIMEOUT, HOST_LLM_TIMEOUT, HOST_TOOL_TIMEOUT,
    HostCallbacks,
};
use crate::mcp::manager::{McpServerOptions, McpServerRecipe};
use crate::pipeline::{self, EnginePipeline, PipelineHost, PipelineProvider, PipelineSpec};
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, AuthTokenResponse, BoxFuture, CheckpointRequest,
    ListToolsResponse, LlmChatRequest, LlmChatResponse, NativeLlmConfig, PermissionCheckRequest,
    PermissionDecision, StateReadRequest, StateReadResponse, StateWriteRequest, StateWriteResponse,
    SubagentProfileWire, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::session::{
    Admission, EngineSession, GoalProvider, SessionConfig, ToolDefsProvider, TurnOutcome,
    TurnRequest,
};
use crate::turn_loop::{run_turn::run_turn_continued, run_turn::run_turn_with_telemetry, types::*};

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

/// In-flight compaction cancel flags keyed by session id. `session_compact`
/// registers one for the duration of the summarizer call;
/// `session_cancel_compaction` triggers it so a long summarizer request can
/// be aborted from the UI instead of finishing the manual `/compact`.
static COMPACTION_CANCEL: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
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

/// Catch a panic in an async napi export so the JS promise rejects instead of
/// hanging.
///
/// `env.execute_tokio_future` runs the body on the tokio runtime, where a panic
/// is caught by the task boundary: the deferred is never resolved and the JS
/// promise waits forever. `Cargo.toml` sets no `panic = "abort"`, so the panic
/// unwinds and can be caught here.
async fn guard_async_panic<T>(
    body: impl std::future::Future<Output = napi::Result<T>>,
) -> napi::Result<T> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(body)
        .catch_unwind()
        .await
        .map_err(|_| napi::Error::from_reason("internal panic in async napi export"))?
}

/// Removes a registry entry when the scope that registered it ends.
///
/// The explicit `remove` after the awaited work is not enough: an early `?`
/// return skips it, and a napi future dropped by the JS side never reaches it
/// at all — either way the entry outlives the turn it described.
struct MapEntryGuard<V: 'static> {
    map: &'static LazyLock<Mutex<HashMap<String, V>>>,
    key: String,
}

impl<V: 'static> MapEntryGuard<V> {
    fn insert(map: &'static LazyLock<Mutex<HashMap<String, V>>>, key: String, value: V) -> Self {
        map.lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone(), value);
        Self { map, key }
    }
}

impl<V: 'static> Drop for MapEntryGuard<V> {
    fn drop(&mut self) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// Parse a host-supplied JSON field, reporting the drop instead of silently
/// substituting an empty value.
///
/// A malformed `blocks_json` / `tool_calls_json` used to erase the message's
/// content with no trace anywhere, which reads as the model having said
/// nothing.
fn parse_host_json<T: serde::de::DeserializeOwned + Default>(
    json: Option<&str>,
    what: &str,
    role: &str,
) -> T {
    let Some(json) = json else {
        return T::default();
    };
    match serde_json::from_str(json) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%role, "dropping unparseable {what}: {error}");
            T::default()
        }
    }
}

/// Project the host's tool table onto the engine's, failing on a schema that
/// does not parse.
///
/// `unwrap_or_default()` used to turn a malformed schema into `Value::Null`,
/// which rode into the request body verbatim (`llm/openai.rs`,
/// `llm/anthropic.rs`, `llm/google_genai.rs`): the provider then rejected the
/// whole turn with a 400 that named no tool, and nothing was logged.
fn tool_defs_from_wire(tools: &[JsToolDef]) -> napi::Result<Vec<ToolInfo>> {
    tools
        .iter()
        .map(|t| {
            let input_schema = serde_json::from_str(&t.input_schema).map_err(|error| {
                napi::Error::from_reason(format!(
                    "tool schema parse failed for tool `{}`: {error}",
                    t.name
                ))
            })?;
            Ok(ToolInfo {
                name: t.name.clone(),
                description: t.description.clone(),
                input_schema,
            })
        })
        .collect()
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
    /// Optional OAuth token channel (`host/auth_token`). The transport asks
    /// the host for a bearer token when the native LLM config names an
    /// `auth_provider`; absent means OAuth-managed providers are unsupported
    /// and static-key transports are unaffected.
    auth_token_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
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
            return Box::pin(async { Err(crate::callbacks::CHECKPOINT_UNSUPPORTED.to_string()) });
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

    fn auth_token(
        &self,
        provider: String,
        force: bool,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<String, std::string::String>>
    {
        let Some(ref tsfn) = self.auth_token_fn else {
            return Box::pin(async { Err("host does not support oauth token fetch".to_string()) });
        };
        let tsfn = tsfn.clone();
        let cancel = self.cancellation.clone();
        Box::pin(async move {
            // Bounded like the stdio leg: a cache hit answers immediately, a
            // miss covers one OAuth refresh round-trip (network, no human).
            let payload = serde_json::json!({ "provider": provider, "force": force }).to_string();
            let output = invoke_via_registry(
                &tsfn,
                payload,
                "auth_token",
                Some(HOST_AUTH_TOKEN_TIMEOUT),
                cancel,
            )
            .await?;
            let response: AuthTokenResponse =
                serde_json::from_str(&output).map_err(|e| format!("auth_token parse: {e}"))?;
            Ok(response.token)
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
    /// LLM retry attempts per step (v2 `loopControl.maxAttemptsPerStep`).
    /// `None` = engine default (10).
    pub max_attempts: Option<u32>,
    /// Context window the host resolved for the active model. `None` keeps the
    /// engine's default compaction budget.
    pub max_context_tokens: Option<u32>,
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
    /// Host-authorized extra roots (`/add-dir` → `additionalDirs`). Paths that
    /// canonicalize under one of them are served by the native toolset even
    /// though they sit outside `workspace_root`; without this they could only
    /// fall back to the host, which has no tool runtime on this transport.
    pub additional_dirs: Option<Vec<String>>,
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
    /// Optional JSON-serialized `[secondary_model]` subagent model pool: the
    /// default alias, `force`, and one resolved LLM config per pool entry.
    /// Absent = subagents inherit the caller's model.
    pub secondary_model_json: Option<String>,
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
    /// Host-resolved `AgentSwarm` timeout in ms (v2 `resolveSwarmTimeoutMs`).
    /// Absent → the 2h swarm default; swarms never inherit
    /// `subagent_timeout_ms`. `i64` because napi cannot read JS numbers as
    /// `u64`.
    pub swarm_timeout_ms: Option<i64>,
    /// P52 native-path vetoes (host-formatted deny reasons; see
    /// `RunTurnParams`).
    pub agent_tool_veto: Option<String>,
    pub tools_veto: Option<String>,
    pub todo_tool_veto: Option<String>,
    pub tower_worktree_root: Option<String>,
    /// Host-resolved tower enablement (`KIMI_CODE_EXPERIMENTAL_TOWER` /
    /// `[experimental].tower`). `None` falls back to the engine's own env
    /// probe.
    pub tower_enabled: Option<bool>,
    /// Host-resolved progressive tool disclosure (`[experimental].
    /// tool_select`). `None`/`false` keeps every tool advertised inline.
    pub tool_select: Option<bool>,
    pub sandbox_mode: Option<String>,
    pub caller_agent_id: Option<String>,
    pub session_id: Option<String>,
    /// Native MCP servers configuration (P73).
    pub mcp_servers: Option<Vec<JsMcpServerConfig>>,
    /// Host-resolved `[services.moonshot_search]` / `KIMI_WEB_SEARCH_*`
    /// backend (v2 `configSection.ts`). When set, the native WebSearch tool
    /// calls this endpoint instead of scraping DuckDuckGo.
    pub web_search: Option<JsWebServiceConfig>,
    /// Host-resolved `[services.moonshot_fetch]` / `KIMI_WEB_FETCH_*`
    /// backend. When set, the native FetchURL tool tries this endpoint
    /// first and falls back to the direct fetch on failure (v2 semantics).
    pub web_fetch: Option<JsWebServiceConfig>,
    /// Host-resolved `[image].read_byte_budget` (v2
    /// `resolveReadImageByteBudget`). `None` keeps the 256KB default.
    pub image_read_byte_budget: Option<i64>,
    /// Host-resolved `[image].max_edge_px`. `None` keeps the 2000px default.
    /// `i64` because napi cannot read JS numbers as `u32`.
    pub image_max_edge_px: Option<i64>,
    /// The session model's declared capabilities (`[models.<alias>]
    /// .capabilities`). `None`/empty = unknown.
    pub model_capabilities: Option<Vec<String>>,
    /// Host-resolved `[background]` knobs (v2 `configSection.ts`). Absent
    /// fields keep the engine default (5s stop grace / unlimited concurrency /
    /// auto-background on / 600s background Bash timeout); `bash_task_timeout_s
    /// = 0` means "no timeout". `i64` because napi cannot read JS numbers as
    /// `u64`.
    pub kill_grace_period_ms: Option<i64>,
    pub max_running_tasks: Option<i64>,
    pub bash_auto_background_on_timeout: Option<bool>,
    pub bash_task_timeout_s: Option<i64>,
    /// `[background].print_background_mode` — what a print-mode (`kimi -p`)
    /// session does once its main turn ends with background tasks still
    /// running: `exit` resolves the turn receipt at once, `drain` / `steer`
    /// hold it until the task runner drains. Absent keeps the engine's
    /// exit-on-turn-end default.
    pub print_background_mode: Option<String>,
    /// `[background].print_wait_ceiling_s`: wall-clock bound on that hold, in
    /// seconds. Absent / non-positive keeps the documented default. `i64`
    /// because napi cannot read JS numbers as `u64`.
    pub print_wait_ceiling_s: Option<i64>,
    /// `[background].print_max_turns`: cap on the steer turns the engine may
    /// add for background completions. Absent / non-positive keeps the
    /// documented default.
    pub print_max_turns: Option<i64>,
}

/// The compaction window for one run: the model's declared input cap wins over
/// the host's total window (schema `models.*.maxInputSize`: prompt-budget
/// checks prefer it, completion budgeting keeps the window), and the host
/// window is the fallback.
fn compaction_window(
    native_llm: Option<&JsNativeLlmConfig>,
    host_window: Option<u32>,
) -> Option<u32> {
    native_llm
        .and_then(|cfg| cfg.max_input_size)
        .or(host_window)
}

/// Resolve the `[background]` print policy carried by the session params.
///
/// `None` (no `print_background_mode`) leaves the engine untouched: a turn
/// receipt resolves when the turn ends, whatever the background tasks do.
/// `i64` → `u64`/`u32` narrowing lives in
/// [`crate::session::PrintBackgroundPolicy::from_wire`].
fn print_background_policy(
    params: &JsRunTurnParams,
) -> Option<crate::session::PrintBackgroundPolicy> {
    crate::session::PrintBackgroundPolicy::from_wire(
        params.print_background_mode.as_deref(),
        params
            .print_wait_ceiling_s
            .and_then(|ceiling| u64::try_from(ceiling).ok()),
        params
            .print_max_turns
            .and_then(|max_turns| u32::try_from(max_turns).ok()),
    )
}

/// MCP server configuration for pure-Rust MCP manager (P73).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsMcpServerConfig {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    /// Working directory for a stdio server (v2 `cwd`).
    pub cwd: Option<String>,
    /// Env var holding a bearer token for a remote server (v2
    /// `bearerTokenEnvVar`).
    pub bearer_token_env_var: Option<String>,
    /// `false` keeps the server listed as `disabled` and skips connecting it.
    pub enabled: Option<bool>,
    /// Allowlist of tool names exposed to the model (v2 `enabledTools`).
    pub enabled_tools: Option<Vec<String>>,
    /// Denylist applied after the allowlist (v2 `disabledTools`).
    pub disabled_tools: Option<Vec<String>>,
    /// Startup (connect + discovery) timeout in milliseconds (v2
    /// `startupTimeoutMs`).
    pub startup_timeout_ms: Option<u32>,
    /// Single tool-call timeout in milliseconds (v2 `toolTimeoutMs`).
    pub tool_timeout_ms: Option<u32>,
    /// Keep this server's tools out of the top-level tool list and load them
    /// on demand through `select_tools` (v2 per-server `deferred`).
    pub deferred: Option<bool>,
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
    /// "openai" (Chat Completions) or "anthropic" (Messages), or "google" / "openai_responses".
    pub protocol: String,
    /// API base URL including the version segment (e.g. `.../v1`).
    pub base_url: String,
    pub api_key: String,
    /// Name of the environment variable the transport reads the credential
    /// from at request time (`[providers.*].api_key_env`). Set only when the
    /// provider carries neither a static key nor an OAuth binding; an empty
    /// `api_key` with this name and no `auth_provider` is the env-only channel
    /// the transport's `credential()` accepts. Absent means the credential is
    /// the static `api_key`.
    pub api_key_env: Option<String>,
    pub model: String,
    pub max_tokens: Option<u32>,
    /// Extra headers from `[providers.*].customHeaders`, sent with every
    /// request. Absent means none.
    pub custom_headers: Option<std::collections::HashMap<String, String>>,
    /// Reasoning effort for OpenAI-compatible models (e.g. "low", "medium", "high", "max").
    pub reasoning_effort: Option<String>,
    /// Thinking budget in tokens for Anthropic Messages API.
    pub thinking_budget: Option<u32>,
    /// OAuth-managed auth: the host-side provider name the transport asks for
    /// a bearer token (`host/auth_token`) instead of using the static
    /// `api_key`. Absent means static-key auth.
    pub auth_provider: Option<String>,
    /// Moonshot preserved-thinking passthrough (`thinking.keep`): `keep` on
    /// the kimi/openai body, a `clear_thinking_20251015` context-management
    /// edit on anthropic. Host filters off-values; absent = no keep on the
    /// wire.
    pub thinking_keep: Option<String>,
    /// Route an anthropic-protocol model through the beta Messages API
    /// (`POST {base}/messages?beta=true`); absent means the standard endpoint.
    pub beta_api: Option<bool>,
    /// The model's declared capabilities (`[models.<alias>].capabilities`).
    pub capabilities: Option<Vec<String>>,
    /// The model's own system prompt (`[models.<alias>].system_prompt`).
    pub system_prompt: Option<String>,
    /// Declared input cap when below the window
    /// (`[models.<alias>].max_input_size`).
    pub max_input_size: Option<u32>,
    /// Explicit adaptive-thinking support
    /// (`[models.<alias>].adaptive_thinking`).
    pub adaptive_thinking: Option<bool>,
    /// The wire field carrying reasoning content
    /// (`[models.<alias>].reasoning_key`).
    pub reasoning_key: Option<String>,
    /// The effort value that encodes "thinking off" on the wire
    /// (`[models.<alias>].off_effort`).
    pub off_effort: Option<String>,
}

/// One host-resolved `[services.moonshot_*]` entry (v2 `configSection.ts`):
/// the endpoint the native WebSearch / FetchURL tools call instead of the
/// built-in DuckDuckGo scrape / direct HTTP fetch.
#[napi(object)]
#[derive(Clone)]
pub struct JsWebServiceConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub custom_headers: Option<std::collections::HashMap<String, String>>,
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
    #[napi(ts_arg_type = "(callbackId: number) => void")] auth_token_cb: Option<JsFunction>,
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

    let auth_token_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match auth_token_cb
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
        guard_async_panic(async move {
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
                auth_token_tsfn,
            )
            .await
        }),
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
    /// Optional OAuth token channel (`host/auth_token`): the native transport
    /// asks the host for a bearer token when its config names an
    /// `auth_provider`. Absent means OAuth-managed providers are unsupported.
    auth_token: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    /// The cancellation flag the host callbacks observe (per turn today; the
    /// session handle passes its own per-turn flag through `cancel_turn`).
    cancellation: Option<Arc<AtomicBool>>,
}

/// One resolved MCP server handed to [`shared_mcp_manager`]: its name, how to
/// spawn it, and its per-server options.
type McpServerSpec = (String, McpServerRecipe, McpServerOptions);

/// Whether host-supplied `transport: "mock"` configurations are accepted.
///
/// The mock transport answers every call with fabricated results, so it must
/// never be reachable from a production configuration — a typo in `transport`
/// otherwise silently registers a server that feeds invented tool output to
/// the model. Integration tests opt in with `KIMI_NATIVE_ALLOW_MOCK_MCP=1`.
fn allow_mock_mcp_transport() -> bool {
    std::env::var("KIMI_NATIVE_ALLOW_MOCK_MCP")
        .is_ok_and(|value| matches!(value.trim(), "1" | "true"))
}

/// The process-wide MCP managers, keyed by the resolved server set.
///
/// `Weak` on purpose: the cache must never be the reason a manager (and the
/// child processes it owns) stays alive. Sessions hold the strong references,
/// so the entry goes stale once the last session is disposed and the next
/// lookup drops it.
static MCP_MANAGERS: LazyLock<Mutex<HashMap<String, Weak<crate::mcp::McpManager>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The manager for `servers`, connecting it on first use.
///
/// Two sessions built from the same configuration share one manager, so `/new`
/// reuses the live connections instead of re-spawning every server (v2's
/// workspace-scoped manager, workspaceMcpService.ts:61-83). A changed
/// configuration hashes to a different key and gets its own manager; the old
/// one is dropped once its sessions are gone.
fn shared_mcp_manager(servers: Vec<McpServerSpec>) -> Arc<crate::mcp::McpManager> {
    let key = mcp_servers_key(&servers);
    let mut cache = MCP_MANAGERS.lock().unwrap_or_else(|e| e.into_inner());
    // Drop the entries whose sessions are gone before deciding, so a stale
    // entry can never shadow a fresh manager for the same configuration.
    cache.retain(|_, weak| weak.strong_count() > 0);
    if let Some(existing) = cache.get(&key).and_then(Weak::upgrade) {
        return existing;
    }
    let manager = Arc::new(crate::mcp::McpManager::new());
    manager.connect_all(servers);
    cache.insert(key, Arc::downgrade(&manager));
    manager
}

/// A stable fingerprint of a resolved server set.
///
/// `env` and `headers` are maps, so they are sorted before hashing: an
/// unordered walk would give one configuration two different keys and defeat
/// the cache.
fn mcp_servers_key(servers: &[McpServerSpec]) -> String {
    let mut parts: Vec<String> = servers
        .iter()
        .map(|(name, recipe, options)| {
            let body = match recipe {
                McpServerRecipe::Stdio {
                    command,
                    args,
                    env,
                    cwd,
                } => format!(
                    "stdio|{command}|{}|{}|{}",
                    args.join("\u{1f}"),
                    sorted_pairs(env),
                    cwd.as_deref().unwrap_or("")
                ),
                McpServerRecipe::Sse {
                    url,
                    headers,
                    bearer_token_env_var,
                } => format!(
                    "sse|{url}|{}|{}",
                    sorted_pairs(headers),
                    bearer_token_env_var.as_deref().unwrap_or("")
                ),
                McpServerRecipe::Http {
                    url,
                    headers,
                    bearer_token_env_var,
                } => format!(
                    "http|{url}|{}|{}",
                    sorted_pairs(headers),
                    bearer_token_env_var.as_deref().unwrap_or("")
                ),
                McpServerRecipe::Mock => "mock".to_string(),
            };
            format!(
                "{name}\u{1e}{body}\u{1e}{}|{}|{}|{}|{}",
                options.enabled,
                sorted_list(options.enabled_tools.as_deref()),
                sorted_list(options.disabled_tools.as_deref()),
                options.startup_timeout_ms.unwrap_or(0),
                options.tool_timeout_ms.unwrap_or(0),
            )
        })
        .collect();
    parts.sort();
    parts.join("\u{1d}")
}

fn sorted_pairs(map: &HashMap<String, String>) -> String {
    let mut pairs: Vec<(&String, &String)> = map.iter().collect();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn sorted_list(values: Option<&[String]>) -> String {
    let Some(values) = values else {
        return String::new();
    };
    let mut names: Vec<&String> = values.iter().collect();
    names.sort();
    names
        .iter()
        .map(|name| name.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

/// The addon entry's view of the shared engine pipeline
/// (`kimi_agent::pipeline`). The chain itself — counting wrapper, native-tool
/// wrapper and its guards, LLM selection — lives there once; this normalizes
/// `JsRunTurnParams` into a `PipelineSpec` and applies the addon's host policy:
/// the process-wide subagent manager refreshed per turn, no cancel slot, and the
/// process-wide MCP manager resolved from `params.mcp_servers`.
async fn build_engine_pipeline(
    params: &JsRunTurnParams,
    tsfns: EngineCallbackTsfns,
    parent_cancel: Option<crate::subagent::types::ParentCancel>,
    parent_cancel_slot: Option<Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>>,
    steer_slot: Option<Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>>,
) -> napi::Result<EnginePipeline> {
    // Session profile catalog snapshot (P46): refresh the process-wide
    // manager's definitions per turn so the native `Agent` tool sees the
    // host's builtin/workspace/user profiles (plugin and external-backend
    // profiles never arrive here — those calls fall back to the host).
    if let Some(profiles) = &params.subagent_profiles {
        let wires: Vec<SubagentProfileWire> = profiles
            .iter()
            .map(|p| SubagentProfileWire {
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

    // Native MCP servers (P73): the manager is process-wide and keyed by the
    // resolved server set, so every session built from the same configuration
    // shares one set of connections (v2's workspace-scoped
    // `WorkspaceMcpService`, workspaceMcpService.ts:61-83). Building one per
    // session re-spawned every server on `/new` — a stdio server that boots a
    // language runtime cost seconds each time.
    //
    // The connects are started, not awaited: the tool table reads the manager
    // live (`callbacks.rs::list_tools`), so a server that connects later still
    // contributes its tools, and the turn awaits readiness there (v2
    // `onWillBeginStep`, mcpService.ts:70-73). A server that fails to connect
    // is skipped rather than failing the turn.
    let plugin_mcp = plugin_mcp_configs();
    let host_mcp = params.mcp_servers.as_deref().unwrap_or_default();
    let mut servers: Vec<McpServerSpec> = Vec::new();
    for cfg in host_mcp {
        let recipe = match cfg.transport.as_str() {
            "stdio" => cfg.command.as_ref().map(|cmd| McpServerRecipe::Stdio {
                command: cmd.clone(),
                args: cfg.args.clone().unwrap_or_default(),
                env: cfg.env.clone().unwrap_or_default(),
                cwd: cfg.cwd.clone(),
            }),
            "sse" => cfg.url.as_ref().map(|url| McpServerRecipe::Sse {
                url: url.clone(),
                headers: cfg.headers.clone().unwrap_or_default(),
                bearer_token_env_var: cfg.bearer_token_env_var.clone(),
            }),
            "http" => cfg.url.as_ref().map(|url| McpServerRecipe::Http {
                url: url.clone(),
                headers: cfg.headers.clone().unwrap_or_default(),
                bearer_token_env_var: cfg.bearer_token_env_var.clone(),
            }),
            "mock" if allow_mock_mcp_transport() => Some(McpServerRecipe::Mock),
            _ => None,
        };
        let Some(recipe) = recipe else {
            // Without this the server simply vanishes from the roster, and a
            // mistyped `transport` is indistinguishable from a working config.
            tracing::warn!(
                server = %cfg.name,
                transport = %cfg.transport,
                "skipping MCP server: unsupported or unenabled transport"
            );
            continue;
        };
        servers.push((
            cfg.name.clone(),
            recipe,
            McpServerOptions {
                enabled: cfg.enabled.unwrap_or(true),
                enabled_tools: cfg.enabled_tools.clone(),
                disabled_tools: cfg.disabled_tools.clone(),
                startup_timeout_ms: cfg.startup_timeout_ms.map(u64::from),
                tool_timeout_ms: cfg.tool_timeout_ms.map(u64::from),
                deferred: cfg.deferred.unwrap_or(false),
            },
        ));
    }
    // Enabled plugins contribute their own MCP servers. A server the user
    // disabled for that plugin never reaches here (`plugin_mcp_configs`
    // filters it), and the name is namespaced so two plugins can declare the
    // same server name.
    for cfg in &plugin_mcp {
        let recipe = match cfg.transport.as_str() {
            "stdio" => cfg.command.as_ref().map(|cmd| McpServerRecipe::Stdio {
                command: cmd.clone(),
                args: cfg.args.clone(),
                env: cfg.env.clone(),
                cwd: cfg.cwd.clone(),
            }),
            "sse" => cfg.url.as_ref().map(|url| McpServerRecipe::Sse {
                url: url.clone(),
                headers: cfg.headers.clone(),
                bearer_token_env_var: None,
            }),
            "http" => cfg.url.as_ref().map(|url| McpServerRecipe::Http {
                url: url.clone(),
                headers: cfg.headers.clone(),
                bearer_token_env_var: None,
            }),
            _ => None,
        };
        let Some(recipe) = recipe else {
            tracing::warn!(
                server = %cfg.name,
                transport = %cfg.transport,
                "skipping plugin MCP server: unsupported transport"
            );
            continue;
        };
        servers.push((cfg.name.clone(), recipe, McpServerOptions::default()));
    }
    let mcp_manager = (!servers.is_empty()).then(|| shared_mcp_manager(servers));

    // `[subagent]`/`[background]` print defaults (docs config-files.md): an
    // *unset* wall-clock timeout means "no timeout" in print mode — the
    // settle phase waits for background work instead of the clock killing
    // it. The settle policy itself rides the SessionConfig at session build.
    let print_mode = print_background_policy(params).is_some();

    // Host-resolved swarm timeout (v2 `resolveSwarmTimeoutMs`): the
    // process-wide manager carries it so the native `AgentSwarm` tool reads
    // it at execution time. `try_from` drops negatives without wrapping;
    // `0` rides through as "explicitly no timeout" (v2 `taskService` arms
    // only when `timeoutMs > 0`).
    SUBAGENT_MANAGER.set_swarm_timeout_ms(crate::pipeline::print_timeout_default(
        params
            .swarm_timeout_ms
            .and_then(|timeout| u64::try_from(timeout).ok()),
        print_mode,
    ));

    // Host-resolved `[services.moonshot_*]` backends (v2 `configSection.ts`):
    // the tools read the process-global seam at execution time. Always
    // installed — including `None` — so a backend resolved for one session
    // never leaks into a later pipeline that resolves none.
    crate::tools::web_search::set_service_config(params.web_search.as_ref().map(|cfg| {
        crate::tools::web_search::WebSearchServiceConfig {
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            custom_headers: cfg.custom_headers.clone().unwrap_or_default(),
        }
    }));
    crate::tools::fetch_url::set_service_config(params.web_fetch.as_ref().map(|cfg| {
        crate::tools::fetch_url::WebFetchServiceConfig {
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            custom_headers: cfg.custom_headers.clone().unwrap_or_default(),
        }
    }));

    let spec = PipelineSpec {
        system_prompt: params.system_prompt.clone(),
        model_name: params.model_name.clone(),
        providers: params
            .providers
            .as_ref()
            .map(|providers| {
                providers
                    .iter()
                    .map(|p| PipelineProvider {
                        name: p.name.clone(),
                        system_prompt: p.system_prompt.clone(),
                        model: p.model.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        native_llm: params.native_llm.as_ref().map(|cfg| NativeLlmConfig {
            protocol: cfg.protocol.clone(),
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            api_key_env: cfg.api_key_env.clone(),
            model: cfg.model.clone(),
            max_tokens: cfg.max_tokens,
            custom_headers: cfg.custom_headers.clone().unwrap_or_default(),
            reasoning_effort: cfg.reasoning_effort.clone(),
            thinking_budget: cfg.thinking_budget,
            auth_provider: cfg.auth_provider.clone(),
            thinking_keep: cfg.thinking_keep.clone(),
            beta_api: cfg.beta_api.unwrap_or(false),
            capabilities: cfg.capabilities.clone(),
            system_prompt: cfg.system_prompt.clone(),
            max_input_size: cfg.max_input_size,
            adaptive_thinking: cfg.adaptive_thinking,
            reasoning_key: cfg.reasoning_key.clone(),
            off_effort: cfg.off_effort.clone(),
        }),
        workspace_root: params.workspace_root.clone(),
        native_tools: params.native_tools.unwrap_or(false),
        extra_roots: params.additional_dirs.clone().unwrap_or_default(),
        rust_self_contained: params.rust_self_contained.unwrap_or(false),
        shell_path: params.shell_path.clone(),
        // The host hands the permission policy over as JSON (napi has no typed
        // struct for it). A parse failure used to be swallowed by `.ok()`, which
        // dropped the *whole* policy: with no local engine, every native tool
        // call round-trips to the host's `check_permission`, so the user gets an
        // approval prompt no matter which mode the UI shows. The failure and the
        // symptom looked completely unrelated — and nothing was logged, so the
        // engine's own view of the mode was unobservable. Report both.
        policy_snapshot: params.policy_snapshot_json.as_deref().and_then(|json| {
            match serde_json::from_str::<crate::permission::PolicySnapshot>(json) {
                Ok(snapshot) => {
                    tracing::debug!(mode = ?snapshot.mode, "native policy snapshot accepted");
                    Some(snapshot)
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        "native policy snapshot rejected; no local permission engine, \
                         so every tool call will ask the host for permission"
                    );
                    None
                }
            }
        }),
        github_token: params.github_token.clone(),
        github_base_url: params.github_base_url.clone(),
        // `0` from the host means "no timeout" (v2 `taskService` arms only
        // when `timeoutMs > 0`); an *unset* value defaults to no timeout in
        // print mode (docs config-files.md), the 2h engine default otherwise.
        subagent_timeout_ms: crate::pipeline::print_timeout_default(
            params
                .subagent_timeout_ms
                .and_then(|timeout| u64::try_from(timeout).ok()),
            print_mode,
        ),
        agent_tool_veto: params.agent_tool_veto.clone(),
        tools_veto: params.tools_veto.clone(),
        todo_tool_veto: params.todo_tool_veto.clone(),
        tower_worktree_root: params.tower_worktree_root.clone(),
        // The host resolves the experiment itself (env + config) and passes the
        // resulting flag down; falling back to the env switch keeps a direct
        // napi caller working without plumbing a new param.
        tower_enabled: params.tower_enabled.unwrap_or_else(|| {
            crate::tools::tower::paths::tower_enabled(
                crate::tools::tower::paths::tower_env_switch(),
                None,
            )
        }),
        // The host resolves `[experimental].tool_select` itself (the same
        // precedence as every experimental flag: env > config > master env >
        // default); falling back to `false` keeps a direct napi caller on the
        // pre-disclosure behaviour: every tool advertised inline.
        tool_select: params.tool_select.unwrap_or(false),
        sandbox_mode: params.sandbox_mode.clone(),
        sandbox_policy: params.sandbox_mode.as_deref().map(|mode_str| {
            let mode = crate::tools::sandbox::SandboxMode::parse(mode_str);
            let root = params.workspace_root.clone().unwrap_or_default();
            // `additionalDirs` are part of the authorized boundary, not just a
            // toolset search path.
            crate::tools::sandbox::SandboxExecutionPolicy::new(mode, root)
                .with_extra_roots(params.additional_dirs.clone().unwrap_or_default())
        }),
        caller_agent_id: params.caller_agent_id.clone(),
        session_id: params.session_id.clone(),
        secondary_model: params.secondary_model_json.as_deref().and_then(|json| {
            serde_json::from_str::<crate::rpc::types::SecondaryModelPool>(json).ok()
        }),
        image_read_byte_budget: params
            .image_read_byte_budget
            .and_then(|value| u64::try_from(value).ok()),
        image_max_edge_px: params
            .image_max_edge_px
            .and_then(|value| u32::try_from(value).ok()),
        model_capabilities: params.model_capabilities.clone(),
        // Enabled plugins contribute skill roots; the host's own
        // `extra_skill_dirs` arrive through the config the host resolved.
        skill_dirs: plugin_skill_dirs(),
        background: crate::storage::BackgroundLimits::from_wire(
            params
                .kill_grace_period_ms
                .and_then(|value| u64::try_from(value).ok()),
            params
                .max_running_tasks
                .and_then(|value| u64::try_from(value).ok()),
            params.bash_auto_background_on_timeout,
            crate::pipeline::print_timeout_default(
                params
                    .bash_task_timeout_s
                    .and_then(|value| u64::try_from(value).ok()),
                print_mode,
            ),
        ),
    };

    pipeline::build_engine_pipeline(
        &spec,
        Arc::new(NapiHostCallbacks {
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
            auth_token_fn: tsfns.auth_token.map(Arc::new),
            cancellation: tsfns.cancellation,
        }),
        PipelineHost {
            subagent_manager: SUBAGENT_MANAGER.clone(),
            parent_cancel,
            parent_cancel_slot,
            steer_slot,
            mcp_manager,
            event_bus: None,
        },
    )
    .await
    .map_err(|error| napi::Error::from_reason(error.message))
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
    auth_token_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
) -> napi::Result<JsRunTurnResult> {
    // Register the turn's cancellation signal up front so a JS-side
    // `cancel_turn` can interrupt host callbacks (permission waits
    // included) while this turn is in flight — and, since P51, abort a
    // foreground subagent immediately.
    let turn_id = params.turn_id.clone();
    let cancellation = Arc::new(AtomicBool::new(false));
    let parent_cancel = crate::subagent::types::ParentCancel::from_flag(cancellation.clone());
    // The guard, not a trailing `remove`: the pipeline build below can return
    // early with `?`, and a dropped napi future never reaches a trailing
    // statement at all.
    let _cancel_guard = MapEntryGuard::insert(&CANCEL_MAP, turn_id.clone(), parent_cancel.clone());

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
            auth_token: auth_token_tsfn,
            cancellation: Some(cancellation.clone()),
        },
        Some(parent_cancel.clone()),
        None,
        // The legacy one-shot entry owns no steer queue: nothing steers into
        // it mid-turn, so there is no signal to fire.
        None,
    )
    .await?;
    let llm = pipeline.llm;
    let callbacks = pipeline.callbacks;
    let turn_event_count = pipeline.turn_event_count;
    let native_tool_count = pipeline.native_tool_count;
    let hook_guard = pipeline.hook_guard.clone();
    // Read before `params.goal` is moved out below.
    let max_context_tokens =
        compaction_window(params.native_llm.as_ref(), params.max_context_tokens);

    let messages: Vec<LLMMessage> = params
        .messages
        .iter()
        .map(|m| LLMMessage {
            role: m.role.clone(),
            content: m.content.clone(),
            blocks: parse_host_json(m.blocks_json.as_deref(), "message blocks", &m.role),
            tool_calls: parse_host_json(
                m.tool_calls_json.as_deref(),
                "message tool calls",
                &m.role,
            ),
            tool_call_id: m.tool_call_id.clone(),
        })
        .collect();

    // A malformed schema used to become `Value::Null` and ride into the request
    // body verbatim, where the provider rejected the whole turn with a 400 that
    // named no tool. Fail here instead, naming the tool.
    let tool_defs = tool_defs_from_wire(&params.tools)?;

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
        max_attempts: params.max_attempts,
        turn_id: turn_id.clone(),
        llm: llm.as_ref(),
        messages,
        tools: &[],
        tool_defs,
        // None = unbounded, mirroring the JS loop (which only stops on a
        // configured `maxStepsPerTurn`).
        max_steps: params.max_steps.unwrap_or(u32::MAX),
        max_context_tokens,
        // The napi host passes its own `[loop_control]` caps through
        // `max_attempts`; the compaction cap has no napi parameter yet, so this
        // path keeps the engine default.
        compaction_max_attempts: None,
        permission_mode: pipeline.permission_mode,
        goal,
        cancellation: Some(cancellation),
        hook_guard: hook_guard.clone(),
        media: Some(&pipeline.media),
        media_dropped: Some(pipeline.media_dropped.clone()),
        toolset: pipeline.toolset.clone(),
    };

    let telemetry_context = params.telemetry.map(|t| TelemetryContext {
        mode: t.mode,
        provider_type: t.provider_type,
        protocol: t.protocol,
        thinking_effort: t.thinking_effort,
    });
    let result = match telemetry_context {
        Some(context) => run_turn_with_telemetry(input, context, &callbacks).await,
        None => run_turn_continued(input, &callbacks).await,
    };

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
/// hosts. `session_dispose` signals the session's pump to stop, so a disposed
/// session's task — and the conversation it holds — is released rather than
/// parked for the life of the process.
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
    /// The session's own LLM, kept for operations that run outside a turn
    /// (the `/compact` summarizer call).
    llm: Arc<dyn LLM>,
    /// The context window the host resolved for the session's model, used to
    /// derive the compaction config for `/compact`.
    max_context_tokens: Option<u32>,
    /// The live quiescence guard (M1c RAII). Acquire stores it; release drops
    /// it — the drop replays held turns and wakes the pump.
    quiescence_guard: Arc<Mutex<Option<crate::session::QuiescenceGuard>>>,
    /// The MCP manager this session's pipeline connected from
    /// `params.mcp_servers`. Kept so the host can read the roster: the manager
    /// is built once per session, and without a handle the host had no way to
    /// see servers the engine had already connected.
    mcp_manager: Option<Arc<crate::mcp::McpManager>>,
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
    #[napi(ts_arg_type = "(callbackId: number) => void")] auth_token_cb: Option<JsFunction>,
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
    let auth_token_tsfn = make_tsfn(auth_token_cb)?;

    env.execute_tokio_future(
        guard_async_panic(async move {
            let agent_cancel_slot: Arc<
                std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>,
            > = Arc::new(std::sync::Mutex::new(None));
            // #3697: the turn's steer signal, shared with the toolset through
            // the pipeline and refreshed per turn by the session pump.
            let steer_slot: Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>> =
                Arc::new(std::sync::Mutex::new(None));
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
                    auth_token: auth_token_tsfn,
                    cancellation: None,
                },
                None,
                Some(agent_cancel_slot.clone()),
                Some(steer_slot.clone()),
            )
            .await?;

            // Turn-start tool table: pulled fresh through pipeline.callbacks per turn
            // on native transports (host-proxy rebuilds tools inside llm_chat
            // and never consults the engine's table). run_turn's per-step
            // `host/list_tools` refresh stays the authoritative source; this
            // provider only seeds the snapshot fallback, merging MCP tools if attached.
            let is_host_proxy = pipeline.llm.transport() == "host-proxy";
            let callbacks_for_defs = pipeline.callbacks.clone();
            let tool_defs_provider: ToolDefsProvider = if is_host_proxy {
                Arc::new(|| Box::pin(async { Vec::new() }))
            } else {
                Arc::new(move || {
                    let callbacks = callbacks_for_defs.clone();
                    Box::pin(async move {
                        callbacks
                            .list_tools()
                            .await
                            .map(|r| r.tools)
                            .unwrap_or_default()
                    })
                })
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
                max_attempts: params.max_attempts,
                max_context_tokens: compaction_window(
                    params.native_llm.as_ref(),
                    params.max_context_tokens,
                ),
                compaction_max_attempts: None,
                permission_mode: pipeline.permission_mode,
                tool_defs: tool_defs_provider,
                goal: goal_provider,
                on_before_turn: None,
                agent_cancel_slot: Some(agent_cancel_slot),
                steer_slot: Some(steer_slot),
                hook_guard: pipeline.hook_guard.clone(),
                print_background: print_background_policy(&params),
                // The host's session id is also the task-notification key: the
                // print settle drains only this session's completions.
                session_id: params.session_id.clone(),
                task_runner: SUBAGENT_MANAGER.get_task_runner_sync(),
                toolset: pipeline.toolset.clone(),
            })
            .await;

            let session_id = format!("session-{}", SESSION_NEXT_ID.fetch_add(1, Ordering::SeqCst));
            // #3717 late-settle silence: the registry holds the only strong
            // handle, so once `session_dispose` removes the entry the `Weak`
            // dies and late task settles for this host session go silent —
            // the drain (the pump) is gone with it.
            let host_session_id = params.session_id.clone().unwrap_or_default();
            let session = Arc::new(session);
            if let Some(runner) = pipeline.task_runner.clone() {
                let weak = Arc::downgrade(&session);
                runner.set_liveness_check(Arc::new(move |session: Option<&str>| {
                    let Some(live) = weak.upgrade() else {
                        return false;
                    };
                    if live.is_shutdown() {
                        return false;
                    }
                    match session {
                        None => true,
                        Some(s) => s == host_session_id.as_str(),
                    }
                }));
            }
            SESSION_REGISTRY
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    session_id.clone(),
                    SessionEntry {
                        session,
                        turn_event_count: pipeline.turn_event_count,
                        native_tool_count: pipeline.native_tool_count,
                        llm_transport: pipeline.llm.transport().to_string(),
                        llm: pipeline.llm.clone(),
                        max_context_tokens: compaction_window(
                            params.native_llm.as_ref(),
                            params.max_context_tokens,
                        ),
                        quiescence_guard: Arc::new(Mutex::new(None)),
                        mcp_manager: pipeline.mcp_manager.clone(),
                    },
                );
            Ok(session_id)
        }),
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
        let mut prompt: LLMMessage = serde_json::from_str(&prompt)
            .map_err(|e| napi::Error::from_reason(format!("prompt parse: {e}")))?;
        // A client submits an uploaded file as a `kimi-file://` media URL; the
        // engine is the side that knows it is a daemon reference.
        prompt.blocks = crate::llm::media_resolver::normalize_media_refs(prompt.blocks);
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

/// The MCP roster this session's pipeline connected, as a JSON array of
/// `McpServerEntry` (name / transport / status / tool_count / error / tools).
///
/// An empty array means the session was built without `mcp_servers` — the
/// host used to answer `[]` unconditionally, so a configured server was
/// invisible to `/mcp` and to the VS Code MCP panel.
#[napi]
pub fn session_mcp_servers(env: Env, session_id: String) -> napi::Result<JsObject> {
    let manager = session_entry(&session_id)?.mcp_manager;
    env.execute_tokio_future(
        async move {
            let Some(manager) = manager else {
                return Ok("[]".to_string());
            };
            let entries = manager.server_entries().await;
            serde_json::to_string(&entries)
                .map_err(|e| napi::Error::from_reason(format!("serialize MCP roster: {e}")))
        },
        |env, json: String| env.create_string(&json),
    )
}

/// The warnings this session should surface at startup, as a JSON array of
/// `{ code, message, severity }`.
///
/// Derived from the MCP roster: a server the engine could not connect, or one
/// waiting on the user's authorization. A healthy session produces `[]`.
#[napi]
pub fn session_warnings(env: Env, session_id: String) -> napi::Result<JsObject> {
    let manager = session_entry(&session_id)?.mcp_manager;
    env.execute_tokio_future(
        async move {
            let Some(manager) = manager else {
                return Ok("[]".to_string());
            };
            let warnings = manager.session_warnings().await;
            serde_json::to_string(&warnings)
                .map_err(|e| napi::Error::from_reason(format!("serialize session warnings: {e}")))
        },
        |env, json: String| env.create_string(&json),
    )
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

/// The session's current cross-turn history as a JSON `LLMMessage[]` — the
/// inverse of `session_set_history`. Lets the host carry the conversation
/// across an engine-session rebuild (a mid-session model / permission change)
/// and implement undo / fork without losing context.
#[napi]
pub fn session_get_history(session_id: String) -> napi::Result<String> {
    guard_sync_panic(|| {
        let entry = session_entry(&session_id)?;
        serde_json::to_string(&entry.session.snapshot_history())
            .map_err(|e| napi::Error::from_reason(format!("history serialize: {e}")))
    })
}

/// Drop the session handle: the pump task is signalled to stop and the
/// conversation it owns is released with it. Pending outcome receivers are
/// dropped too, so a JS `session_turn_outcome` awaiting one rejects instead of
/// hanging on a pump that will never run again.
#[napi]
pub fn session_dispose(session_id: String) -> napi::Result<()> {
    guard_sync_panic(|| {
        let entry = SESSION_REGISTRY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&session_id);
        if let Some(entry) = entry {
            entry.session.shutdown();
        }
        SESSION_OUTCOMES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(session, _), _| session != &session_id);
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

// ── Embedded harness capabilities (Wave 1) ────────────────────────────────
// Session-scoped capabilities the TUI harness drives outside the turn queue.
// The standalone server exposes the same state over HTTP (btw: POST
// /sessions/:id/btw, title: POST /sessions/:id/title/generate, tasks:
// /api/v1/tasks); here they cross the napi boundary directly.

/// Start a btw side-channel instance forked from the session's current
/// history (v2 `/btw`; mirrors `start_btw` at the standalone server).
/// Returns the engine-assigned subagent id (`agent-btw-…`); the side-channel
/// turns run through `session_btw_prompt` on the process-wide
/// [`SUBAGENT_MANAGER`] runtime.
#[napi]
pub fn session_start_btw(env: Env, session_id: String) -> napi::Result<JsObject> {
    guard_sync_panic(move || {
        let history = session_entry(&session_id)?.session.snapshot_history();
        env.execute_tokio_future(
            async move {
                crate::subagent::start_btw(&SUBAGENT_MANAGER, &history)
                    .await
                    .map_err(napi::Error::from_reason)
            },
            |env, agent_id: String| env.create_string(&agent_id),
        )
    })
}

/// Run one btw side-channel turn (v2 `/btw` panel). The turn runs on the
/// subagent instance's tool-free profile (resume semantics: the prompt is
/// appended to the forked conversation seeded by `session_start_btw`), and
/// its deltas stream through the owning session's `emit_event` callback
/// attributed to the btw agent id. The resolved value carries the final
/// assistant text plus the raw stop reason.
#[napi]
pub fn session_btw_prompt(
    env: Env,
    session_id: String,
    agent_id: String,
    prompt: String,
) -> napi::Result<JsObject> {
    guard_sync_panic(move || {
        // The session must be live, but the side channel owns its conversation:
        // the turn runs on the shared subagent runtime, outside the session's
        // turn queue.
        session_entry(&session_id)?;
        let manager = SUBAGENT_MANAGER.clone();
        env.execute_tokio_future(
            async move {
                // Register a parent-cancel under the agent id so
                // `session_btw_cancel` can abort the run mid-turn. The guard
                // removes it on every exit path, including a dropped future.
                let cancel = crate::subagent::types::ParentCancel::new();
                let _cancel_guard =
                    MapEntryGuard::insert(&CANCEL_MAP, agent_id.clone(), cancel.clone());
                let outcome = manager
                    .resume_foreground_turn(&agent_id, &prompt, Some(&cancel))
                    .await;
                match outcome {
                    Some(Ok(crate::subagent::manager::ForegroundTurnOutcome::Completed(
                        result,
                    ))) => {
                        let content = result
                            .messages
                            .iter()
                            .rev()
                            .find(|m| m.role == "assistant")
                            .map(|m| m.content.clone())
                            .unwrap_or_default();
                        Ok((content, format!("{:?}", result.stop_reason)))
                    }
                    Some(Ok(crate::subagent::manager::ForegroundTurnOutcome::ParentCancelled)) => {
                        Ok((String::new(), "Aborted".to_string()))
                    }
                    Some(Err(message)) => Err(napi::Error::from_reason(message)),
                    None => Err(napi::Error::from_reason(format!(
                        "unknown btw side-channel instance: {agent_id}"
                    ))),
                }
            },
            |env, (content, stop_reason): (String, String)| {
                let mut obj = env.create_object()?;
                obj.set_named_property("content", env.create_string_from_std(content)?)?;
                obj.set_named_property("stopReason", env.create_string_from_std(stop_reason)?)?;
                Ok(obj)
            },
        )
    })
}

/// Abort a running btw side-channel turn (v2 `/btw` panel cancel). Triggers
/// the parent-cancel registered by `session_btw_prompt`; returns whether a
/// turn was pending for this agent id.
#[napi]
pub fn session_btw_cancel(agent_id: String) -> napi::Result<bool> {
    guard_sync_panic(|| {
        let cancel = CANCEL_MAP
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&agent_id)
            .cloned();
        match cancel {
            Some(cancel) => {
                cancel.trigger();
                Ok(true)
            }
            None => Ok(false),
        }
    })
}

/// The session title from the live cross-turn history (v2 `generateTitle`).
///
/// `first_turn` / `user_prompts` derive it deterministically; `digest` asks
/// the managed platform through the `chat_title` tool, which needs an
/// OAuth-managed model — a session on a static API key rejects that source
/// rather than silently falling back to the deterministic title. Resolves
/// null when the history cannot supply an input.
#[napi]
pub fn session_generate_title(
    env: Env,
    session_id: String,
    source: Option<String>,
) -> napi::Result<JsObject> {
    let entry = session_entry(&session_id)?;
    let history = entry.session.snapshot_history();
    let llm = entry.llm.clone();
    env.execute_tokio_future(
        async move {
            crate::session::title::generate_session_title(&history, source.as_deref(), llm.as_ref())
                .await
                .map_err(napi::Error::from_reason)
        },
        |env, title: Option<String>| match title {
            Some(title) => env.create_string(&title).map(|value| value.into_unknown()),
            None => env.get_null().map(|null| null.into_unknown()),
        },
    )
}

/// Manually compact the session's cross-turn history with an LLM-written
/// summary — the embedded `/compact [instruction]` path (v2's compaction
/// operation). Resolves with a JSON compaction report (`changed`,
/// `messageCount`, `compactedCount`, `tokensBefore`, `tokensAfter`,
/// `summary`). Everything up to the deepest safe split is replaced by the
/// summary, so the smallest safe tail is kept verbatim. The host owns the
/// quiescence window around this call; cancellation goes through
/// [`session_cancel_compaction`], and a cancelled compaction leaves the
/// history untouched.
#[napi]
pub fn session_compact(
    env: Env,
    session_id: String,
    instruction: Option<String>,
) -> napi::Result<JsObject> {
    guard_sync_panic(move || {
        let entry = session_entry(&session_id)?;
        let flag = Arc::new(AtomicBool::new(false));
        env.execute_tokio_future(
            async move {
                // The guard removes the cancel flag on every exit path,
                // including a dropped future — a leaked flag would make the
                // next compaction look already-cancelled.
                let _cancel_guard =
                    MapEntryGuard::insert(&COMPACTION_CANCEL, session_id.clone(), flag.clone());
                compact_session_with_summary(&entry, instruction, &flag).await
            },
            |env, report: serde_json::Value| {
                env.create_string_from_std(
                    serde_json::to_string(&report).unwrap_or_else(|e| e.to_string()),
                )
            },
        )
    })
}

/// Abort the compaction `session_compact` is running; true when one was in
/// flight. The summarizer call is cancelled and the session history keeps
/// its pre-compaction content.
#[napi]
pub fn session_cancel_compaction(session_id: String) -> napi::Result<bool> {
    guard_sync_panic(|| {
        let flag = COMPACTION_CANCEL
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&session_id)
            .cloned();
        match flag {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                Ok(true)
            }
            None => Ok(false),
        }
    })
}

/// Compact `entry`'s history with the session's own LLM. The system prompt
/// heads the working list and is never compacted (it is stripped again before
/// the result is stored); injection messages survive the trim exactly as they
/// do in the turn loop.
async fn compact_session_with_summary(
    entry: &SessionEntry,
    instruction: Option<String>,
    flag: &Arc<AtomicBool>,
) -> napi::Result<serde_json::Value> {
    let llm = entry.llm.clone();
    let history = entry.session.snapshot_history();
    let mut messages = vec![LLMMessage::system(llm.system_prompt())];
    messages.extend(history);
    let config = crate::compaction::config_for_window(entry.max_context_tokens);
    let injections = crate::injection::split_injections(&mut messages);
    let tokens_before = crate::compaction::estimate_messages_tokens(&messages);
    let count = crate::compaction::compute_compact_count_manual(&messages, &config);
    if count == 0 {
        return Ok(serde_json::json!({
            "changed": false,
            "messageCount": messages.len() - 1 + injections.len(),
            "tokensBefore": tokens_before,
            "tokensAfter": tokens_before,
        }));
    }
    let cancel = crate::turn_loop::run_turn::TurnCancellation::from_flag(Some(flag.clone()));
    let compacted = crate::compaction::force_compact_messages_manual_with_summary(
        &messages,
        &config,
        llm.as_ref(),
        instruction.as_deref(),
        Some(cancel.token()),
    )
    .await
    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    if flag.load(Ordering::Relaxed) {
        return Err(napi::Error::from_reason("compaction cancelled"));
    }
    let summary = compacted
        .get(1)
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let tokens_after = crate::compaction::estimate_messages_tokens(&compacted);
    let mut new_history = compacted[1..].to_vec();
    new_history.push(crate::compaction::compaction_continuation_message());
    new_history.extend(injections);
    let message_count = new_history.len() as u32;
    entry.session.set_history(new_history);
    Ok(serde_json::json!({
        "changed": true,
        "messageCount": message_count,
        "compactedCount": count - 1,
        "tokensBefore": tokens_before,
        "tokensAfter": tokens_after,
        "summary": summary,
    }))
}

/// The plugin registry lives in the same SQLite store the standalone server
/// uses (`<data_dir>/sessions.db`), so the CLI and `kimi web` read one install
/// state. The host calls [`init_plugin_store`] once with its data dir; every
/// plugin export below answers from the manager it installs.
static PLUGIN_MANAGER: LazyLock<Mutex<Option<Arc<crate::server::plugins::PluginManager>>>> =
    LazyLock::new(|| Mutex::new(None));

/// Open the plugin registry against `<data_dir>/sessions.db`. `marketplace_dir`
/// is the directory holding `marketplace.json` (the host resolves it), so a
/// relative catalog `source` resolves to a real plugin root. Idempotent: a
/// second call replaces the manager, which is harmless because the state lives
/// in the file, not in the manager.
#[napi]
pub fn init_plugin_store(data_dir: String, marketplace_dir: Option<String>) -> napi::Result<()> {
    guard_sync_panic(|| {
        let db_path = std::path::Path::new(&data_dir).join("sessions.db");
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        }
        let store = crate::session::sqlite_store::SqliteSessionStore::open(&db_path)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let manager = crate::server::plugins::PluginManager::new(Arc::new(store))
            .with_marketplace_dir(marketplace_dir.map(std::path::PathBuf::from))
            .with_home_dir(Some(std::path::PathBuf::from(&data_dir)));
        *PLUGIN_MANAGER.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(manager));
        Ok(())
    })
}

fn plugin_manager() -> napi::Result<Arc<crate::server::plugins::PluginManager>> {
    PLUGIN_MANAGER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| {
            napi::Error::from_reason(
                "plugin store not initialized; call initPluginStore(dataDir) first",
            )
        })
}

/// The enabled plugins' skill roots, read from the process-wide registry.
/// Empty when the host never called [`init_plugin_store`], so a process without
/// plugins scans exactly what it did before.
fn plugin_skill_dirs() -> Vec<std::path::PathBuf> {
    PLUGIN_MANAGER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|manager| manager.plugin_skill_dirs())
        .unwrap_or_default()
}

/// Resolve the system prompt for a napi-owned session.
///
/// The host may pass a prompt of its own (`[models.<alias>].systemPrompt` is
/// plumbed through `native_llm`), and that always wins. When it does not — an
/// empty string, the `"sys"` sentinel the ACP path uses, or the one-line stub
/// the native SDK used to send — build the engine's real prompt from the
/// session workspace. `ServerEngine::session_spec` answers the same three cases
/// for the server; keeping the logic here means every napi caller gets it
/// without each host having to know about `prompt/system.md`.
fn build_session_system_prompt(params: &JsRunTurnParams) -> String {
    const STANDALONE_SERVICE_SENTINEL: &str =
        "You are kimi-agent, running as a standalone service.";
    if let Some(provider) = params
        .providers
        .as_ref()
        .and_then(|providers| providers.first())
        && !provider.system_prompt.trim().is_empty()
    {
        return provider.system_prompt.clone();
    }
    let supplied = params.system_prompt.trim();
    let is_placeholder = supplied.is_empty()
        || supplied == "sys"
        || supplied.starts_with(STANDALONE_SERVICE_SENTINEL)
        || supplied.starts_with("You are Kimi Code, an intelligent AI coding assistant");
    if !is_placeholder {
        return params.system_prompt.clone();
    }
    let Some(root) = params.workspace_root.as_deref().filter(|r| !r.is_empty()) else {
        // No workspace to describe: keep whatever the host sent rather than
        // fabricating an environment section for an unknown root.
        return params.system_prompt.clone();
    };
    let skill_dirs = plugin_skill_dirs();
    match params.agent_profile.as_deref().map(str::trim) {
        Some(profile) if !profile.is_empty() => {
            crate::prompt::SystemPromptBuilder::build_for_profile(
                root,
                skill_dirs,
                merge_all_available_skills(),
                profile,
            )
        }
        _ => crate::prompt::SystemPromptBuilder::build_default_with_skill_dirs(root, skill_dirs),
    }
}

/// `[merge_all_available_skills]` for the prompt builder, read from the
/// process-wide config the host pinned. Unset keeps the documented default
/// (`true`), so a process that never loaded a config scans every directory it
/// did before.
fn merge_all_available_skills() -> bool {
    crate::config::KimiConfig::discover()
        .map(|(config, _)| config.resolve_merge_all_available_skills())
        .unwrap_or(true)
}

/// The enabled plugins' MCP servers, read from the process-wide registry.
fn plugin_mcp_configs() -> Vec<crate::server::plugins::PluginMcpConfig> {
    PLUGIN_MANAGER
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|manager| manager.plugin_mcp_configs())
        .unwrap_or_default()
}

/// Drop the plugin registry and close its SQLite connection. The host calls
/// this on shutdown: Windows keeps a lock on an open database, which blocks
/// removing the data directory.
#[napi]
pub fn close_plugin_store() -> napi::Result<()> {
    guard_sync_panic(|| {
        *PLUGIN_MANAGER.lock().unwrap_or_else(|p| p.into_inner()) = None;
        Ok(())
    })
}

/// Every installed plugin as a JSON array of `PluginSummary` wires
/// (`id` / `name` / `version` / `enabled` / `description` / `source`).
#[napi]
pub fn plugin_list() -> napi::Result<String> {
    guard_sync_panic(|| {
        let plugins = plugin_manager()?.list_plugins();
        serde_json::to_string(&plugins).map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Install a plugin from a catalog id, a catalog `source`, or a remote archive
/// URL, answering its `PluginSummary` wire as JSON — or `null` for a source the
/// catalog does not know, so the caller can report "unknown plugin" instead of
/// inventing an install record. A remote source is downloaded and extracted
/// into `<dataDir>/plugins/<id>` first.
#[napi]
pub fn plugin_install(id: String) -> napi::Result<Option<String>> {
    guard_sync_panic(|| {
        let manager = plugin_manager()?;
        let installed = manager
            .install_plugin_from(&id)
            .map_err(napi::Error::from_reason)?;
        let Some((id, _)) = installed else {
            return Ok(None);
        };
        manager
            .list_plugins()
            .into_iter()
            .find(|plugin| plugin.id == id)
            .map(|summary| {
                serde_json::to_string(&summary).map_err(|e| napi::Error::from_reason(e.to_string()))
            })
            .transpose()
    })
}

/// Enable or disable an installed plugin. `false` means the id is neither
/// installed nor catalogued.
#[napi]
pub fn plugin_set_enabled(id: String, enabled: bool) -> napi::Result<bool> {
    guard_sync_panic(|| {
        plugin_manager()?
            .set_plugin_enabled(&id, enabled)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Remove an installed plugin. `false` means it was not installed.
#[napi]
pub fn plugin_remove(id: String) -> napi::Result<bool> {
    guard_sync_panic(|| {
        plugin_manager()?
            .remove_plugin(&id)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Full detail for one installed plugin as a JSON `PluginInfo` wire — the
/// catalog entry, the install state, and everything the manifest contributes
/// (commands, MCP servers, skill/hook counts). `null` when the id is not
/// installed.
#[napi]
pub fn plugin_info(id: String) -> napi::Result<Option<String>> {
    guard_sync_panic(|| {
        plugin_manager()?
            .plugin_info(&id)
            .map(|info| {
                serde_json::to_string(&info).map_err(|e| napi::Error::from_reason(e.to_string()))
            })
            .transpose()
    })
}

/// Every command the enabled plugins contribute, as a JSON array of
/// `PluginCommandDef` wires (`pluginId` / `name` / `description` / `body` /
/// `path`), in plugin-id order.
#[napi]
pub fn plugin_commands() -> napi::Result<String> {
    guard_sync_panic(|| {
        let commands = plugin_manager()?.enabled_commands();
        serde_json::to_string(&commands).map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Enable or disable one MCP server a plugin declares. `false` means the
/// plugin does not declare a server by that name.
#[napi]
pub fn plugin_set_mcp_server_enabled(
    id: String,
    server: String,
    enabled: bool,
) -> napi::Result<bool> {
    guard_sync_panic(|| {
        plugin_manager()?
            .set_mcp_server_enabled(&id, &server, enabled)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Re-read the catalog and every installed manifest, answering a JSON
/// `ReloadSummary` (`{ added, removed, errors }`).
#[napi]
pub fn plugin_reload() -> napi::Result<String> {
    guard_sync_panic(|| {
        let summary = plugin_manager()?.reload();
        serde_json::to_string(&summary).map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Workspace-root file suggestions for the host's mention picker — the
/// `POST /api/v1/fs::suggest` payload (`{ items, truncated }`) as JSON, so the
/// napi transport and the HTTP server answer from one implementation
/// (`server::fs_routes::search_files`). `limit` defaults to 50.
#[napi]
pub fn fs_suggest(work_dir: String, query: String, limit: Option<u32>) -> napi::Result<String> {
    guard_sync_panic(|| {
        let (items, truncated) = crate::server::fs_routes::search_files(
            std::path::Path::new(&work_dir),
            query.trim(),
            limit.unwrap_or(50) as usize,
        );
        serde_json::to_string(&serde_json::json!({ "items": items, "truncated": truncated }))
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Every registered background task's entry wire, oldest first, output
/// omitted — the JSON array the standalone server serves from its task
/// runner (`GET /api/v1/tasks`, server/mod.rs). The runner is the one the
/// active engine pipeline attached to the process-wide subagent manager; an
/// empty array when no pipeline is live.
#[napi]
pub fn background_task_list() -> napi::Result<String> {
    guard_sync_panic(|| {
        let tasks = SUBAGENT_MANAGER
            .get_task_runner_sync()
            .map(|runner| runner.list())
            .unwrap_or_default();
        serde_json::to_string(&tasks).map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// One background task's output snapshot; null while the task is still
/// running (or unknown) — the [`TaskRunner::get_output`] contract.
#[napi]
pub fn background_task_output(id: String) -> napi::Result<Option<String>> {
    guard_sync_panic(|| {
        Ok(SUBAGENT_MANAGER
            .get_task_runner_sync()
            .and_then(|runner| runner.get_output(&id)))
    })
}

/// Request a cooperative stop for one background task and resolve with its
/// entry wire (`killed` once settled) — the `POST /api/v1/tasks/:id/stop`
/// semantics. The optional `reason` becomes the entry's `stopReason` (blank
/// falls back to `"Stopped by TaskStop"`). Fails for an unknown id or a
/// process without a live runner.
#[napi]
pub fn background_task_stop(
    env: Env,
    id: String,
    reason: Option<String>,
) -> napi::Result<JsObject> {
    guard_sync_panic(move || {
        let runner = SUBAGENT_MANAGER.get_task_runner_sync().ok_or_else(|| {
            napi::Error::from_reason("no background task runner is active in this process")
        })?;
        env.execute_tokio_future(
            async move {
                runner
                    .stop(&id, reason.as_deref())
                    .await
                    .map_err(napi::Error::from_reason)
            },
            |env, wire: serde_json::Value| {
                env.create_string_from_std(
                    serde_json::to_string(&wire).unwrap_or_else(|e| e.to_string()),
                )
            },
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js_native_llm() -> JsNativeLlmConfig {
        JsNativeLlmConfig {
            protocol: "openai".into(),
            base_url: "https://api.example.com/v1".into(),
            api_key: "test-key".into(),
            api_key_env: None,
            model: "test-model".into(),
            max_tokens: None,
            custom_headers: None,
            reasoning_effort: None,
            thinking_budget: None,
            auth_provider: None,
            thinking_keep: None,
            beta_api: None,
            capabilities: None,
            system_prompt: None,
            max_input_size: None,
            adaptive_thinking: None,
            reasoning_key: None,
            off_effort: None,
        }
    }

    /// Two sessions built from the same configuration share one manager, so
    /// `/new` reuses the live connections instead of re-spawning every server
    /// (v2's workspace-scoped manager, workspaceMcpService.ts:61-83).
    #[tokio::test]
    async fn test_shared_mcp_manager_reuses_one_manager_per_configuration() {
        let demo = || {
            vec![(
                "demo".to_string(),
                McpServerRecipe::Mock,
                McpServerOptions::default(),
            )]
        };

        let first = shared_mcp_manager(demo());
        let second = shared_mcp_manager(demo());
        assert!(
            Arc::ptr_eq(&first, &second),
            "one configuration, one manager"
        );

        // The key covers the whole resolved server, not just its name: the
        // same name with different options is a different manager.
        let other = shared_mcp_manager(vec![(
            "demo".to_string(),
            McpServerRecipe::Mock,
            McpServerOptions {
                enabled: false,
                ..Default::default()
            },
        )]);
        assert!(
            !Arc::ptr_eq(&first, &other),
            "the same name with different options must not share a manager"
        );
    }

    /// A model that declares an input cap below its window compacts against the
    /// cap; without one the host's total window stands.
    #[test]
    fn a_declared_input_cap_narrows_the_compaction_window() {
        let mut native_llm = js_native_llm();
        native_llm.max_input_size = Some(272_000);
        assert_eq!(
            compaction_window(Some(&native_llm), Some(400_000)),
            Some(272_000)
        );

        native_llm.max_input_size = None;
        assert_eq!(
            compaction_window(Some(&native_llm), Some(400_000)),
            Some(400_000)
        );
        assert_eq!(compaction_window(None, Some(400_000)), Some(400_000));
        assert_eq!(compaction_window(None, None), None);
    }

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

    static TEST_GUARD_MAP: LazyLock<Mutex<HashMap<String, u32>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    fn early_return_with_guard() -> Result<(), ()> {
        let _guard = MapEntryGuard::insert(&TEST_GUARD_MAP, "early".to_string(), 1);
        Err(())
    }

    /// The explicit `remove` after the awaited work is skipped by an early `?`
    /// return and never runs at all when the napi future is dropped, so the
    /// registration has to be released by scope exit.
    #[test]
    fn the_map_entry_guard_removes_on_every_exit_path() {
        {
            let _guard = MapEntryGuard::insert(&TEST_GUARD_MAP, "scope".to_string(), 7);
            assert_eq!(TEST_GUARD_MAP.lock().unwrap().get("scope"), Some(&7));
        }
        assert!(!TEST_GUARD_MAP.lock().unwrap().contains_key("scope"));

        assert!(early_return_with_guard().is_err());
        assert!(!TEST_GUARD_MAP.lock().unwrap().contains_key("early"));
    }

    /// A malformed tool schema used to become `Value::Null` and reach the
    /// provider, which rejected the whole request with a 400 naming no tool.
    #[test]
    fn a_malformed_tool_schema_fails_naming_the_tool() {
        let tools = vec![JsToolDef {
            name: "Read".into(),
            description: "read a file".into(),
            input_schema: "{not json".into(),
        }];
        let error = tool_defs_from_wire(&tools).expect_err("a bad schema must not pass");
        assert!(
            error.reason.contains("Read"),
            "the error must name the tool: {}",
            error.reason
        );
    }

    #[test]
    fn a_well_formed_tool_schema_is_passed_through() {
        let tools = vec![JsToolDef {
            name: "Read".into(),
            description: "read a file".into(),
            input_schema: r#"{"type":"object"}"#.into(),
        }];
        let defs = tool_defs_from_wire(&tools).expect("a valid schema must pass");
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "Read");
        assert_eq!(defs[0].input_schema["type"], "object");
    }

    /// A malformed `blocks_json` used to erase the message's content with no
    /// trace; the fallback stays empty, but the drop is now reported.
    #[test]
    fn unparseable_host_json_falls_back_to_empty() {
        let blocks: Vec<serde_json::Value> =
            parse_host_json(Some("{not json"), "message blocks", "assistant");
        assert!(blocks.is_empty());

        let blocks: Vec<serde_json::Value> =
            parse_host_json(Some(r#"[{"type":"text"}]"#), "message blocks", "assistant");
        assert_eq!(blocks.len(), 1);

        let blocks: Vec<serde_json::Value> = parse_host_json(None, "message blocks", "assistant");
        assert!(blocks.is_empty());
    }
}
