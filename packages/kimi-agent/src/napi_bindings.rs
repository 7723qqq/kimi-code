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
    bindgen_prelude::{Env, JsFunction},
    threadsafe_function::{
        ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction,
        ThreadsafeFunctionCallMode,
    },
    JsObject,
};
use napi_derive::napi;
use tokio::sync::oneshot;

use crate::callbacks::{
    CountingCallbacks, HOST_LLM_TIMEOUT, HOST_TOOL_TIMEOUT, HostCallbacks, NativeToolCallbacks,
};
use crate::llm::http::NativeHttpLlm;
use crate::llm::multi::{LlmProvider, MultiLLM};
use crate::llm::proxy::HostLlmProxy;
use crate::rpc::types::{
    BoxFuture, LlmChatRequest, LlmChatResponse, NativeLlmConfig, PermissionCheckRequest,
    PermissionDecision, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::turn_loop::{
    run_turn::run_turn,
    types::*,
};

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
/// registry is full.
fn store_payload(id: u32, payload: String) {
    let mut registry = PAYLOAD_REGISTRY.lock().unwrap();
    registry.insert(id, payload);
    let excess = registry.len().saturating_sub(PAYLOAD_REGISTRY_MAX_ENTRIES);
    if excess == 0 {
        return;
    }
    let oldest: Vec<u32> = registry.keys().take(excess).copied().collect();
    for id in oldest {
        registry.remove(&id);
    }
}


/// Monotonically increasing callback ID. Wrapping is fine because the ID
/// space is large enough that collisions are impossible in practice.
static NEXT_CALLBACK_ID: AtomicU32 = AtomicU32::new(1);

/// Active-turn cancellation flags keyed by `turn_id`. `run_turn_rust`
/// registers a flag before running and removes it afterwards; `cancel_turn`
/// sets the flag of a running turn from the JS side so the loop can observe
/// the cancellation at the next step boundary.
static CANCEL_MAP: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Ask a running turn (identified by `turn_id`) to stop. The flag is
/// observed by the turn loop between LLM/tool steps; if the turn has already
/// finished this is a no-op.
#[napi]
pub fn cancel_turn(turn_id: String) -> napi::Result<()> {
    if let Some(flag) = CANCEL_MAP.lock().unwrap().get(&turn_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Called by JS to fetch the payload for a given callback ID.
/// Returns the JSON-serialized request payload, or null if not found.
#[napi]
pub fn get_callback_payload(id: u32) -> napi::Result<Option<String>> {
    let payload = PAYLOAD_REGISTRY.lock().unwrap().remove(&id);
    Ok(payload)
}

/// Called by JS to resolve a pending host callback.
///
/// * `id` — the callback ID that was passed to the JS function
/// * `error` — if present, the callback failed with this error message
/// * `result` — if present (and `error` is absent), the JSON-serialized response
#[napi]
pub fn resolve_callback(id: u32, error: Option<String>, result: Option<String>) -> napi::Result<()> {
    if let Some(tx) = CALLBACK_REGISTRY.lock().unwrap().remove(&id) {
        let outcome = match (error, result) {
            (Some(err), _) => Err(err),
            (_, Some(res)) => Ok(res),
            (None, None) => Err("callback resolved with no result".to_string()),
        };
        let _ = tx.send(outcome);
    }
    Ok(())
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
}

impl HostCallbacks for NapiHostCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<LlmChatResponse, std::string::String>> {
        let tsfn = self.llm_chat_fn.clone();
        let input = serde_json::to_string(&request).unwrap_or_else(|e| {
            format!(r#"{{"error":"serialize: {}"}}"#, e)
        });
        Box::pin(napi_llm_chat(tsfn, input))
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<ToolExecuteResponse, std::string::String>> {
        let tsfn = self.execute_tool_fn.clone();
        let input = serde_json::to_string(&request).unwrap_or_else(|e| {
            format!(r#"{{"error":"serialize: {}"}}"#, e)
        });
        Box::pin(napi_execute_tool(tsfn, input))
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
        let input = serde_json::to_string(&request).unwrap_or_else(|e| {
            format!(r#"{{"error":"serialize: {}"}}"#, e)
        });
        Box::pin(async move {
            // No timeout: this one waits on a human, and giving up would
            // discard an approval the user has already granted.
            let output = invoke_via_registry(&tsfn, input, "check_permission", None).await?;
            serde_json::from_str(&output).map_err(|e| format!("check_permission parse: {e}"))
        })
    }

    fn emit_event(&self, event: serde_json::Value) {
        let Some(ref tsfn) = self.emit_event_fn else { return };
        let Ok(payload) = serde_json::to_string(&event) else { return };
        let id = NEXT_CALLBACK_ID.fetch_add(1, Ordering::SeqCst);
        // Payload-only registration: no oneshot — JS fetches and forgets.
        // Pruning matters here too: an event the host never collects would
        // otherwise accumulate for the life of the process.
        store_payload(id, payload);
        let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
        if status != napi::Status::Ok {
            PAYLOAD_REGISTRY.lock().unwrap().remove(&id);
        }
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
async fn invoke_via_registry(
    tsfn: &Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
    label: &str,
    timeout: Option<Duration>,
) -> std::result::Result<std::string::String, std::string::String> {
    let id = NEXT_CALLBACK_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();

    // Store the payload so JS can fetch it via getCallbackPayload(id).
    store_payload(id, input);

    // Register the sender so resolve_callback can find it.
    CALLBACK_REGISTRY.lock().unwrap().insert(id, tx);

    // Fire the JS function with just the callback ID (a number).
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
    if status != napi::Status::Ok {
        // Clean up on failure.
        PAYLOAD_REGISTRY.lock().unwrap().remove(&id);
        CALLBACK_REGISTRY.lock().unwrap().remove(&id);
        return Err(format!("{label} call: {status:?}"));
    }

    // Await the oneshot receiver. The sender is triggered by resolve_callback.
    let outcome = match timeout {
        Some(limit) => match tokio::time::timeout(limit, rx).await {
            Ok(outcome) => outcome,
            Err(_) => {
                // Leave nothing behind: the late resolve_callback would find
                // no sender, and the payload would sit in the registry until
                // it was pruned.
                PAYLOAD_REGISTRY.lock().unwrap().remove(&id);
                CALLBACK_REGISTRY.lock().unwrap().remove(&id);
                return Err(format!("{label} timed out after {}s", limit.as_secs()));
            }
        },
        None => rx.await,
    };

    outcome.map_err(|e| format!("{label} closed: {e}"))?
}

/// Standalone async function for LLM chat via callback registry.
async fn napi_llm_chat(
    tsfn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
) -> std::result::Result<LlmChatResponse, std::string::String> {
    let output = invoke_via_registry(&tsfn, input, "llm_chat", Some(HOST_LLM_TIMEOUT)).await?;
    serde_json::from_str(&output).map_err(|e| format!("llm_chat parse: {e}"))
}

/// Standalone async function for tool execution via callback registry.
async fn napi_execute_tool(
    tsfn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
) -> std::result::Result<ToolExecuteResponse, std::string::String> {
    let output =
        invoke_via_registry(&tsfn, input, "execute_tool", Some(HOST_TOOL_TIMEOUT)).await?;
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
    /// When true (with `workspace_root`), Read/Grep/Glob run in-process.
    pub native_tools: Option<bool>,
    /// Host shell for native Bash (bash everywhere, Git Bash on Windows).
    /// Absent on Windows → native Bash stays with the host.
    pub shell_path: Option<String>,
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
///
/// JsFunction is converted to ThreadsafeFunction synchronously, then the
/// async work is dispatched via `env.execute_tokio_future` so the JS event
/// loop stays alive to process TSFN callbacks.
#[napi]
pub fn run_turn_rust(
    env: Env,
    params: JsRunTurnParams,
    #[napi(ts_arg_type = "(callbackId: number) => void")] llm_chat_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] execute_tool_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] emit_event_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] check_permission_cb: Option<JsFunction>,
) -> napi::Result<JsObject> {
    // ── Convert JsFunction → ThreadsafeFunction synchronously ──────────
    // The TSFN passes only the callback ID (u32). The JS side fetches
    // the payload via getCallbackPayload(id) and resolves via resolveCallback.
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    let llm_chat_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> =
        llm_chat_cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let id = ctx.value;
            let js_num = ctx.env.create_uint32(id)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })?;

    let execute_tool_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> =
        execute_tool_cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let id = ctx.value;
            let js_num = ctx.env.create_uint32(id)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })?;

    let emit_event_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> = match emit_event_cb {
        Some(cb) => Some(cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let id = ctx.value;
            let js_num = ctx.env.create_uint32(id)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })?),
        None => None,
    };

    let check_permission_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> =
        match check_permission_cb {
            Some(cb) => Some(cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let id = ctx.value;
                let js_num = ctx.env.create_uint32(id)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?),
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
            )
            .await
        },
        |env: &mut Env, val: JsRunTurnResult| {
            let mut obj = env.create_object()?;
            obj.set_named_property("stopReason", env.create_string_from_std(val.stop_reason)?)?;
            obj.set_named_property("steps", env.create_uint32(val.steps)?)?;
            obj.set_named_property("inputTokens", env.create_uint32(val.input_tokens)?)?;
            obj.set_named_property("outputTokens", env.create_uint32(val.output_tokens)?)?;
            obj.set_named_property("totalTokens", env.create_uint32(val.total_tokens)?)?;
            obj.set_named_property("eventsEmitted", env.create_uint32(val.events_emitted)?)?;
            obj.set_named_property("llmRetries", env.create_uint32(val.llm_retries)?)?;
            Ok(obj)
        },
    )
}

/// Inner async implementation — all captured values are `Send`.
async fn run_turn_rust_impl(
    params: JsRunTurnParams,
    llm_chat_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    execute_tool_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    emit_event_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    check_permission_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
) -> napi::Result<JsRunTurnResult> {
    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(NapiHostCallbacks {
        llm_chat_fn: Arc::new(llm_chat_tsfn),
        execute_tool_fn: Arc::new(execute_tool_tsfn),
        emit_event_fn: emit_event_tsfn.map(Arc::new),
        check_permission_fn: check_permission_tsfn.map(Arc::new),
    });

    // Count every event this turn emits (step lifecycle, deltas, native
    // tools, goal budget limits) for the turn telemetry. Wrapped before the
    // tool wrapper and the native LLM event sink so all paths are counted.
    let turn_event_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(CountingCallbacks {
        inner: base_callbacks,
        event_count: turn_event_count.clone(),
    });

    // Native tool execution: wrap the callbacks so Read/Grep/Glob run
    // in-process (sandboxed to the workspace) and everything else — and
    // anything that escapes the sandbox — still round-trips to the host.
    let callbacks: Arc<dyn HostCallbacks> = match (
        params.native_tools.unwrap_or(false),
        params.workspace_root.as_deref(),
    ) {
        (true, Some(root)) => match crate::tools::NativeToolset::new(root, params.shell_path.as_deref()) {
            Some(toolset) => Arc::new(NativeToolCallbacks {
                inner: base_callbacks.clone(),
                toolset: Arc::new(toolset),
            }),
            None => base_callbacks.clone(),
        },
        _ => base_callbacks.clone(),
    };

    // LLM selection — priority order:
    //   1. providers (concurrent MultiLLM race) — when set, all providers
    //      run in parallel and the first success wins
    //   2. native_llm — Rust calls a single provider directly via HTTP/SSE
    //   3. host proxy — caller (napi host) handles the actual LLM call
    let llm: Box<dyn LLM> = if let Some(providers) = params.providers.as_ref().filter(|p| !p.is_empty()) {
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
        match params.native_llm {
            Some(cfg) => {
                let sink_callbacks = callbacks.clone();
                let native = NativeHttpLlm::new(
                    NativeLlmConfig {
                        protocol: cfg.protocol,
                        base_url: cfg.base_url,
                        api_key: cfg.api_key,
                        model: cfg.model,
                        max_tokens: cfg.max_tokens,
                        custom_headers: Default::default(),
                    },
                    params.system_prompt.clone(),
                )
                .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event)));
                Box::new(native)
            }
            None => Box::new(
                HostLlmProxy::new(params.system_prompt.clone(), params.model_name.clone())
                    .with_callbacks(callbacks.clone()),
            ),
        }
    };

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

    let turn_id = params.turn_id.clone();
    let cancellation = Arc::new(AtomicBool::new(false));
    CANCEL_MAP.lock().unwrap().insert(turn_id.clone(), cancellation.clone());

    let input = RunTurnInput {
        turn_id: turn_id.clone(),
        llm: &*llm,
        messages,
        tools: &[],
        tool_defs,
        // None = unbounded, mirroring the JS loop (which only stops on a
        // configured `maxStepsPerTurn`).
        max_steps: params.max_steps.unwrap_or(u32::MAX),
        goal,
        cancellation: Some(cancellation),
    };

    let result = run_turn(input, &callbacks)
        .await
        .map_err(|e| napi::Error::from_reason(format!("run_turn failed: {e}")))?;

    CANCEL_MAP.lock().unwrap().remove(&turn_id);

    Ok(JsRunTurnResult {
        stop_reason: format!("{:?}", result.stop_reason),
        steps: result.steps,
        input_tokens: result.usage.input_tokens as u32,
        output_tokens: result.usage.output_tokens as u32,
        total_tokens: result.usage.total_tokens as u32,
        input_cache_read: result.usage.input_cache_read as u32,
        input_cache_creation: result.usage.input_cache_creation as u32,
        events_emitted: turn_event_count.load(std::sync::atomic::Ordering::Relaxed),
        llm_retries: result.llm_retries,
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
        assert!(registry.len() <= PAYLOAD_REGISTRY_MAX_ENTRIES, "registry must stay bounded");
        assert!(!registry.contains_key(&base), "the oldest payload must go first");
        assert!(
            registry.contains_key(&(base + total - 1)),
            "the newest payload must survive"
        );
    }
}
