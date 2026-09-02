/// Host callback trait for LLM chat and tool execution.
///
/// This trait abstracts the transport layer — whether it's JSON-RPC over
/// stdio (the RpcServer-based implementation) or direct napi-rs
/// ThreadsafeFunction calls. The turn loop uses this trait to call back
/// to the JS host for LLM inference and tool execution.
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, BoxFuture, CheckpointRequest, ListToolsResponse,
    LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision, StateReadRequest,
    StateReadResponse, StateWriteRequest, StateWriteResponse, ToolExecuteRequest,
    ToolExecuteResponse,
};
use crate::turn_loop::types::{GoalContext, LLMMessage};

/// Host-provided callbacks that the turn loop needs to call back to JS.
pub trait HostCallbacks: Send + Sync {
    /// Send an LLM chat request to the JS host and return the response.
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>>;

    /// Send a tool execution request to the JS host and return the response.
    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>>;

    /// Ask the host whether a mutating tool call may execute natively. The
    /// host runs its full permission machinery (mode, rules, policies,
    /// interactive approval) and answers `allow` or `deny`. A deny verdict
    /// must be returned to the model as the tool result — never retried on
    /// the host path, which would prompt the user twice.
    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>>;

    /// Ask the host an interactive question and wait for a human answer
    /// (ask-user-question class tools). The host owns the interaction
    /// runtime — pending key, dismiss, turn-end cancellation — and answers
    /// with the v2 `QuestionResult` three states (answered / dismissed /
    /// cancelled). No timeout: like a permission check, this one waits on a
    /// human. The default answers with an error so an unwired host gets a
    /// tool result telling the model not to call the tool again.
    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        let _ = request;
        Box::pin(async { Err("host does not support interactive questions".into()) })
    }

    /// Read host-owned durable state (state-bridge class tools). The host
    /// stays the persistence and undo authority; the engine's native
    /// todo/plan tools read through this seam. Bounded by
    /// [`HOST_STATE_TIMEOUT`]: host bookkeeping, no human in the loop. The
    /// default answers with an error so an unwired host gets a tool result
    /// telling the model not to call the tool again.
    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
        let _ = request;
        Box::pin(async { Err("host does not support state bridge".into()) })
    }

    /// Write host-owned durable state (state-bridge class tools). The host
    /// applies its domain semantics (re-normalization, undoable events) and
    /// returns the resulting state. Bounded by [`HOST_STATE_TIMEOUT`]. The
    /// default answers with an error so an unwired host gets a tool result
    /// telling the model not to call the tool again.
    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
        let _ = request;
        Box::pin(async { Err("host does not support state bridge".into()) })
    }

    /// Host-side file checkpoint for native write executions (P53:
    /// `host/checkpoint`). `phase: "prepare"` must complete — pre-image
    /// captured — before the engine writes; `phase: "record"` notes the
    /// post-image after execution. Fail-open: the default errors and the
    /// caller skips checkpointing (the pre-P53 status quo, native writes
    /// never checkpointed).
    fn checkpoint(&self, request: CheckpointRequest) -> BoxFuture<'static, Result<(), String>> {
        let _ = request;
        Box::pin(async { Err("host does not support checkpoint".into()) })
    }

    /// Fetch the host's current tool table (M1d: `host/list_tools`). Called
    /// before each LLM call on native transports so mid-turn registry
    /// changes (feature tools, MCP reconnects) reach the model — the
    /// turn-start snapshot is only the fallback. Bounded by
    /// [`HOST_LIST_TOOLS_TIMEOUT`]: host bookkeeping, no human in the loop.
    /// The default answers with an error so run_turn falls back to the
    /// snapshot, matching the pre-seam behaviour.
    fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
        Box::pin(async { Err("host does not support list_tools".into()) })
    }

    /// Fetch the host's current goal snapshot (M1d 3b: `host/goal`). The
    /// session's goal provider reads it fresh per turn so host-side goal
    /// changes (pause, budget edits, terminal states) are reflected. Bounded
    /// by [`HOST_LIST_TOOLS_TIMEOUT`]-style host bookkeeping; the default
    /// answers with an error so sessions without the seam run without goal
    /// budgeting, matching the no-goal fallback.
    fn goal(&self) -> BoxFuture<'static, Result<Option<GoalContext>, String>> {
        Box::pin(async { Err("host does not support goal".into()) })
    }

    /// Release the steering prompts injected during the active turn. The
    /// engine-local steer queue (see `SteerQueueCallbacks`) serves this at
    /// every step head; the default answers with nothing.
    fn drain_steers(&self) -> BoxFuture<'static, Result<Vec<LLMMessage>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    /// Record which goal was active when a turn started (G-6 #8). The turn
    /// loop calls this with its turn-start goal snapshot; the native-tool
    /// gate uses it to veto goal mutation calls from a turn whose goal has
    /// since changed. The default ignores the binding — paths without the
    /// gate never veto on staleness.
    fn set_turn_goal(&self, _turn_id: &str, _goal_id: Option<&str>) {}

    /// Fire-and-forget event notification to the JS host. Used by the
    /// native LLM / native tool paths to report step boundaries, streaming
    /// deltas, and natively-executed tool results so the host can record
    /// them in the transcript. The default implementation drops the event.
    fn emit_event(&self, event: serde_json::Value) {
        let _ = event;
    }

    /// Receive a turn lifecycle event from the engine (M1b: `host/turn_event`).
    /// The host is expected to dispatch the durable events (`prompt`,
    /// `cancel`, `ended`) into its append log + state fold (v2 `Event2`
    /// pipeline) and to surface the observable ones (`started`) to the UI.
    /// The default implementation drops the event — hosts that don't yet
    /// model the engine-owned turn lifecycle can safely no-op.
    fn turn_event(&self, _event: crate::turn_events::TurnEvent) {}

    /// Fire-and-forget turn telemetry from the engine (M1c: `host/telemetry`).
    /// The payload is a JSON object whose `event` field carries the event name
    /// (`turn_started` / `turn_ended` / `turn_interrupted`) plus the v2
    /// telemetry payload fields (turn_id, mode, provider_type, protocol,
    /// thinking_effort, reason, duration_ms, steps, at_step,
    /// interrupt_reason). The host forwards these to its telemetry sink —
    /// one track2 per event, no host-side duplicates. The default drops the
    /// event, so hosts without the seam keep owning their turn telemetry.
    fn telemetry(&self, _event: serde_json::Value) {}

    /// Tell the host it may stop working on an LLM request that lost a race.
    ///
    /// Aborting the Rust task is not enough: the request has already been
    /// handed to the host, and dropping the receiver leaves the host's
    /// provider call running to completion — billed — for every loser of
    /// every MultiLLM step. This is fire-and-forget, so the host is free to
    /// ignore an id it has already finished with.
    fn cancel_llm_chat(&self, request_id: &str) {
        self.emit_event(serde_json::json!({
            "type": "llm_chat.cancel",
            "request_id": request_id,
        }));
    }
}

/// Outer bound on a host LLM call. Generous on purpose — a long generation on
/// a slow provider must still fit — but a host that never answers must not
/// hang the turn forever.
pub const HOST_LLM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(900);

/// Outer bound on a host tool call. Tools carry their own timeouts (native
/// Bash caps at 300s); this covers a stalled host.
pub const HOST_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Outer bound on a host state bridge call (state_read / state_write). The
/// host applies domain semantics to durable state — bookkeeping with no
/// human in the loop — so a stalled answer must not hold the step open.
pub const HOST_STATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Outer bound on a `host/list_tools` call. Building the tool table is host
/// bookkeeping (registry read + schema shaping) with no human in the loop,
/// so a stalled answer must not hold the step open; on timeout run_turn
/// falls back to the turn-start snapshot.
pub const HOST_LIST_TOOLS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// A concrete implementation of [`HostCallbacks`] backed by the stdio
/// JSON-RPC server. Used in the CLI binary mode.
pub struct RpcHostCallbacks {
    pub server: Arc<crate::rpc::server::RpcServer>,
}

impl HostCallbacks for RpcHostCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("LLM chat serialize error: {e}"))?;
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_LLM_CHAT,
                    params,
                    Some(HOST_LLM_TIMEOUT),
                )
                .await
                .map_err(|e| format!("LLM chat error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("LLM chat response parse error: {e}"))
        })
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Tool execute serialize error: {e}"))?;
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_EXECUTE_TOOL,
                    params,
                    Some(HOST_TOOL_TIMEOUT),
                )
                .await
                .map_err(|e| format!("Tool execute error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("Tool execute response parse error: {e}"))
        })
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Permission check serialize error: {e}"))?;
            // No timeout: a permission check is answered by a human, and
            // giving up would discard an approval the user already granted.
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_CHECK_PERMISSION,
                    params,
                    None,
                )
                .await
                .map_err(|e| format!("Permission check error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("Permission decision parse error: {e}"))
        })
    }

    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Ask question serialize error: {e}"))?;
            // No timeout: a question is answered by a human, and giving up
            // would discard an answer the user already gave.
            let response_value = server
                .invoke(crate::rpc::types::methods::HOST_ASK_QUESTION, params, None)
                .await
                .map_err(|e| format!("Ask question error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("Ask question response parse error: {e}"))
        })
    }

    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("State read serialize error: {e}"))?;
            // Bounded: host bookkeeping with no human in the loop.
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_STATE_READ,
                    params,
                    Some(HOST_STATE_TIMEOUT),
                )
                .await
                .map_err(|e| format!("State read error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("State read response parse error: {e}"))
        })
    }

    fn checkpoint(&self, request: CheckpointRequest) -> BoxFuture<'static, Result<(), String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Checkpoint serialize error: {e}"))?;
            // Bounded: pre-image capture is host bookkeeping, but the engine
            // waits for it before writing — the timeout bounds that wait.
            server
                .invoke(
                    crate::rpc::types::methods::HOST_CHECKPOINT,
                    params,
                    Some(HOST_STATE_TIMEOUT),
                )
                .await
                .map(|_| ())
                .map_err(|e| format!("Checkpoint error: {e}"))
        })
    }

    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("State write serialize error: {e}"))?;
            // Bounded: host bookkeeping with no human in the loop.
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_STATE_WRITE,
                    params,
                    Some(HOST_STATE_TIMEOUT),
                )
                .await
                .map_err(|e| format!("State write error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("State write response parse error: {e}"))
        })
    }

    fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_LIST_TOOLS,
                    serde_json::json!({}),
                    Some(HOST_LIST_TOOLS_TIMEOUT),
                )
                .await
                .map_err(|e| format!("List tools error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("List tools response parse error: {e}"))
        })
    }

    fn goal(&self) -> BoxFuture<'static, Result<Option<GoalContext>, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_GOAL,
                    serde_json::json!({}),
                    Some(HOST_LIST_TOOLS_TIMEOUT),
                )
                .await
                .map_err(|e| format!("Goal error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("Goal response parse error: {e}"))
        })
    }

    fn emit_event(&self, event: serde_json::Value) {
        // JSON-RPC notification over stdout — fire-and-forget by design.
        crate::rpc::server::RpcServer::notify_now(crate::rpc::types::methods::HOST_EVENT, &event);
    }

    fn turn_event(&self, event: crate::turn_events::TurnEvent) {
        // Structurally infallible — every field is already JSON — but a
        // failure must not pass silently: the host's schema rejects the
        // marker and reports it, which beats dropping a durable record.
        let payload = serde_json::to_value(&event)
            .unwrap_or_else(|e| serde_json::json!({ "error": format!("turn_event: {e}") }));
        crate::rpc::server::RpcServer::notify_now(
            crate::rpc::types::methods::HOST_TURN_EVENT,
            &payload,
        );
    }

    fn telemetry(&self, event: serde_json::Value) {
        // Fire-and-forget notification over stdout, same contract as
        // `host/event` / `host/turn_event`.
        crate::rpc::server::RpcServer::notify_now(
            crate::rpc::types::methods::HOST_TELEMETRY,
            &event,
        );
    }
}

/// File write paths a native call targets (P53 checkpoint seam): the same
/// inference the tool scheduler uses for conflict detection, filtered to
/// file accesses that write.
fn checkpoint_write_paths(tool_name: &str, args: &serde_json::Value) -> Vec<String> {
    use crate::turn_loop::types::{FileOperation, ToolResourceAccess};
    crate::turn_loop::tool_scheduler::infer_tool_accesses(tool_name, args)
        .into_iter()
        .filter_map(|access| match access {
            ToolResourceAccess::File(file)
                if matches!(
                    file.operation,
                    FileOperation::Write | FileOperation::ReadWrite
                ) =>
            {
                Some(file.path)
            }
            _ => None,
        })
        .collect()
}

/// A [`HostCallbacks`] decorator that executes tools natively (inside the
/// Rust process, sandboxed to the workspace) and forwards everything the
/// sandbox cannot handle to the wrapped callbacks.
///
/// **Every** natively-executed call — read-only or mutating — is gated on a
/// host permission grant first: the host policy chain can require interactive
/// approval even for reads (sensitive-file access). A deny verdict becomes
/// the tool result without any execution, natively or on the host.
/// Natively-executed calls are reported to the host via
/// [`HostCallbacks::emit_event`] (`type: "tool.native"`) so the transcript
/// still records them.
pub struct NativeToolCallbacks {
    pub inner: Arc<dyn HostCallbacks>,
    pub toolset: Arc<crate::tools::NativeToolset>,
    /// Counts the calls this wrapper executed in-process. The composition root
    /// holds the same handle to fill in `TurnResult::native_tool_calls`.
    pub native_count: Arc<AtomicU32>,
    /// Optional in-process truncator (P26 批 4). When `Some`, large native
    /// results are truncated and spilled locally. When `None` (no workspace
    /// root), results pass through untruncated.
    pub truncator: Option<Arc<crate::tool_result_truncation::ToolResultTruncator>>,
    /// Optional in-process permission engine (P26 批 3). When `Some`, tool
    /// calls are evaluated against the per-turn `PolicySnapshot` locally in
    /// Rust, bypassing the host `host/check_permission` seam for allow/deny
    /// verdicts.
    pub permission_engine: Option<Arc<crate::permission::PermissionEngine>>,
    /// Optional plan-mode guard. When plan mode is active, write/edit tools
    /// may only target the plan file and TaskStop / CronCreate / CronDelete
    /// are denied; the closure returns the denial reason, or `None` to let
    /// the call through. The REPL reads its local store; the napi/stdio
    /// paths read the host's plan state through the state bridge per
    /// guarded call.
    pub plan_guard: Option<Arc<PlanGuard>>,
    /// Optional stale-write gate (v2 `staleGuardService` mirror, G-6 #3).
    /// Before a native Write/Edit executes, the gate vetoes targets that
    /// were never read or changed on disk since; after every completed
    /// read/write execution (native or host-forwarded) it records the
    /// target's mtime, so a read the host served also clears a later native
    /// write. State is per-session (mounted once by the pipeline builder).
    pub stale_guard: Option<Arc<crate::tools::stale_guard::StaleGate>>,
    /// Optional goal-operation guard (v2 `goalAgentRuntime` mirror, G-6
    /// #7/#8). CreateGoal calls route to the host when the permission mode
    /// is not `auto` (so the host's goal-start review fires); goal mutation
    /// calls from a turn whose goal has changed since are vetoed.
    pub goal_guard: Option<Arc<crate::tools::goal_guard::GoalGuard>>,
    /// Optional PreToolUse hook gate (v2 `agentExternalHooksService` mirror,
    /// G-6 #6). User-configured hook commands run before native tool calls;
    /// exit 2 or a JSON deny blocks the call (fail-closed).
    pub hook_guard: Option<Arc<crate::tools::external_hooks::HookGuard>>,
    /// P52 native-path vetoes (the host `onBeforeExecuteTool` veto-chain
    /// listeners that have no engine-native counterpart). Non-empty reason:
    /// the affected native calls are rejected with the verbatim reason as
    /// the (error) tool result — no execution, no host fallback. This gate
    /// runs before permission, matching the veto chain's precedence.
    /// `agent_tool_veto` denies the native `Agent` tool only (swarm mode);
    /// `tools_veto` denies every native tool (btw side-channel contexts).
    /// Non-native calls still fall back to the host, whose own veto chain
    /// denies them there.
    pub agent_tool_veto: Option<String>,
    pub tools_veto: Option<String>,
}

/// A plan-mode tool guard: `(tool_name, args) -> denial reason or None`,
/// resolved asynchronously (the product paths read the host's plan state
/// through the state bridge; see
/// [`crate::tools::plan_mode::plan_denial`] for the decision semantics).
pub type PlanGuard =
    dyn Fn(&str, &serde_json::Value) -> BoxFuture<'static, Option<String>> + Send + Sync;

impl HostCallbacks for NativeToolCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let this = NativeToolCallbacks {
            inner: self.inner.clone(),
            toolset: self.toolset.clone(),
            native_count: self.native_count.clone(),
            truncator: self.truncator.clone(),
            permission_engine: self.permission_engine.clone(),
            plan_guard: self.plan_guard.clone(),
            stale_guard: self.stale_guard.clone(),
            goal_guard: self.goal_guard.clone(),
            hook_guard: self.hook_guard.clone(),
            agent_tool_veto: self.agent_tool_veto.clone(),
            tools_veto: self.tools_veto.clone(),
        };
        Box::pin(async move {
            // G-6 #7: a CreateGoal that must be reviewed (permission mode is
            // not `auto`) runs on the host, whose full veto chain — goal-start
            // review included — then applies. Treated exactly like a tool the
            // sandbox cannot handle: host executes, observations still apply.
            if !this.toolset.handles(&request.tool_name)
                || this
                    .goal_guard
                    .as_ref()
                    .is_some_and(|g| g.requires_host(&request.tool_name))
            {
                let response = this.inner.execute_tool(request.clone()).await?;
                // v2 `observeExecution` covers host-served read/writes too —
                // recording here keeps a later native Write to this file
                // from tripping on a read the host path served.
                if let Some(gate) = &this.stale_guard {
                    gate.observe(&request.tool_name, &request.arguments, response.is_error);
                }
                return Ok(response);
            }
            if let Some(guard) = &this.plan_guard
                && let Some(reason) = guard(&request.tool_name, &request.arguments).await
            {
                // The refusal is the tool result the model sees — report it so
                // the host transcript records the card's terminal state too
                // (same contract as the permission denial below).
                this.inner.emit_event(serde_json::json!({
                    "type": "tool.native",
                    "turn_id": request.turn_id,
                    "tool_call_id": request.tool_call_id,
                    "tool_name": request.tool_name,
                    "arguments": request.arguments,
                    "content": reason,
                    "is_error": true,
                    "note": null,
                }));
                return Ok(ToolExecuteResponse {
                    content: reason,
                    is_error: true,
                    note: None,
                });
            }
            // P52 veto gate, before permission — the host veto chain outranks
            // everything (v2 `beforeToolExecuteEvent` aggregation). A denial
            // is the tool result the model sees; no execution, no fallback.
            let veto_reason = if let Some(reason) = &this.tools_veto {
                Some(reason.clone())
            } else if let Some(reason) = &this.agent_tool_veto
                && request.tool_name.eq_ignore_ascii_case("agent")
            {
                Some(reason.clone())
            } else {
                None
            };
            if let Some(reason) = veto_reason {
                this.inner.emit_event(serde_json::json!({
                    "type": "tool.native",
                    "turn_id": request.turn_id,
                    "tool_call_id": request.tool_call_id,
                    "tool_name": request.tool_name,
                    "arguments": request.arguments,
                    "content": reason,
                    "is_error": true,
                    "note": null,
                }));
                return Ok(ToolExecuteResponse {
                    content: reason,
                    is_error: true,
                    note: None,
                });
            }
            let decision = if let Some(ref engine) = this.permission_engine {
                let verdict = engine.evaluate(&request.tool_name, &request.arguments);
                match verdict.decision {
                    crate::permission::VerdictDecision::Allow => PermissionDecision::allow(),
                    crate::permission::VerdictDecision::Deny => PermissionDecision::deny(
                        verdict
                            .reason
                            .unwrap_or_else(|| "Denied by local permission policy".into()),
                    ),
                    crate::permission::VerdictDecision::Ask => {
                        this.inner
                            .check_permission(PermissionCheckRequest {
                                tool_name: request.tool_name.clone(),
                                tool_call_id: request.tool_call_id.clone(),
                                arguments: request.arguments.clone(),
                            })
                            .await?
                    }
                }
            } else {
                this.inner
                    .check_permission(PermissionCheckRequest {
                        tool_name: request.tool_name.clone(),
                        tool_call_id: request.tool_call_id.clone(),
                        arguments: request.arguments.clone(),
                    })
                    .await?
            };
            if !decision.is_allow() {
                let reason = decision
                    .reason
                    .unwrap_or_else(|| "denied by host permission".into());
                // The refusal is the tool result the model sees — report it so
                // the host transcript records the card's terminal state too.
                this.inner.emit_event(serde_json::json!({
                    "type": "tool.native",
                    "turn_id": request.turn_id,
                    "tool_call_id": request.tool_call_id,
                    "tool_name": request.tool_name,
                    "arguments": request.arguments,
                    "content": reason,
                    "is_error": true,
                    "note": null,
                }));
                return Ok(ToolExecuteResponse {
                    content: reason,
                    is_error: true,
                    note: None,
                });
            }
            // PreToolUse hooks (v2 `agentExternalHooksService`, G-6 #6),
            // after permission and plan — v2's chain order. A block is the
            // tool result the model sees (fail-closed on hook errors); no
            // execution, no host fallback.
            if let Some(guard) = &this.hook_guard
                && let Some(reason) = guard.denial(&request).await
            {
                this.inner.emit_event(serde_json::json!({
                    "type": "tool.native",
                    "turn_id": request.turn_id,
                    "tool_call_id": request.tool_call_id,
                    "tool_name": request.tool_name,
                    "arguments": request.arguments,
                    "content": reason,
                    "is_error": true,
                    "note": null,
                }));
                return Ok(ToolExecuteResponse {
                    content: reason,
                    is_error: true,
                    note: None,
                });
            }
            // Goal-operation stale veto (v2 `goalAgentRuntime`, G-6 #8),
            // after permission and before the stale-write guard: a goal
            // mutation call from a turn whose goal changed is the tool
            // result the model sees; no execution, no host fallback.
            if let Some(guard) = &this.goal_guard
                && let Some(reason) = guard
                    .stale_denial(this.inner.as_ref(), &request.turn_id, &request.tool_name)
                    .await
            {
                this.inner.emit_event(serde_json::json!({
                    "type": "tool.native",
                    "turn_id": request.turn_id,
                    "tool_call_id": request.tool_call_id,
                    "tool_name": request.tool_name,
                    "arguments": request.arguments,
                    "content": reason,
                    "is_error": true,
                    "note": null,
                }));
                return Ok(ToolExecuteResponse {
                    content: reason,
                    is_error: true,
                    note: None,
                });
            }
            // Stale-write guard (v2 `staleGuardService`, G-6 #3), after the
            // permission verdict and before execution — v2 chain order is
            // permission → plan → staleGuard. A denial is the tool result
            // the model sees; no execution, no host fallback.
            if let Some(gate) = &this.stale_guard
                && let Some(reason) = gate
                    .denial(this.inner.as_ref(), &request.tool_name, &request.arguments)
                    .await
            {
                this.inner.emit_event(serde_json::json!({
                    "type": "tool.native",
                    "turn_id": request.turn_id,
                    "tool_call_id": request.tool_call_id,
                    "tool_name": request.tool_name,
                    "arguments": request.arguments,
                    "content": reason,
                    "is_error": true,
                    "note": null,
                }));
                return Ok(ToolExecuteResponse {
                    content: reason,
                    is_error: true,
                    note: None,
                });
            }
            // P53 checkpoint prepare (v2 `onWillExecuteTool` counterpart):
            // the engine is about to write these files — the host captures
            // their pre-images before the write lands. Fail-open: a failure
            // or unwired host skips the snapshot. At this point every deny
            // gate (veto / plan / permission / hook / stale) has passed.
            let checkpoint_paths = checkpoint_write_paths(&request.tool_name, &request.arguments);
            if !checkpoint_paths.is_empty() {
                let _ = this
                    .inner
                    .checkpoint(CheckpointRequest {
                        turn_id: request.turn_id.clone(),
                        tool_call_id: request.tool_call_id.clone(),
                        phase: "prepare".into(),
                        paths: checkpoint_paths.clone(),
                        executed: false,
                    })
                    .await;
            }
            let started = std::time::Instant::now();
            // P57 tool.progress stream: bash output chunks flow to the host
            // as `tool.native.progress` events (fire-and-forget UI updates).
            let progress_inner = this.inner.clone();
            let progress_turn_id = request.turn_id.clone();
            let progress_call_id = request.tool_call_id.clone();
            let on_update = |kind: &str, text: &str| {
                progress_inner.emit_event(serde_json::json!({
                    "type": "tool.native.progress",
                    "turn_id": progress_turn_id,
                    "tool_call_id": progress_call_id,
                    "kind": kind,
                    "text": text,
                }));
            };
            let result = this
                .toolset
                .execute_tool_streaming(
                    Some(&request.tool_call_id),
                    &request.tool_name,
                    &request.arguments,
                    Some(&on_update),
                )
                .await;
            match result {
                Some(result) => {
                    this.native_count.fetch_add(1, Ordering::Relaxed);
                    // Self-write refresh + read recording: re-stat after the
                    // completed execution (v2 `observeExecution`), so
                    // consecutive writes never trip the guard.
                    if let Some(gate) = &this.stale_guard {
                        gate.observe(&request.tool_name, &request.arguments, result.is_error);
                    }
                    // P53 checkpoint record (v2 `onDidExecuteTool` counter-
                    // part): the write landed — note the post-image so undo
                    // can detect manual edits. Fire-and-forget: a failure
                    // leaves the group with an unresolvable after-state,
                    // which restore treats as a conflict, not data loss.
                    if !checkpoint_paths.is_empty() {
                        let _ = this
                            .inner
                            .checkpoint(CheckpointRequest {
                                turn_id: request.turn_id.clone(),
                                tool_call_id: request.tool_call_id.clone(),
                                phase: "record".into(),
                                paths: checkpoint_paths,
                                executed: true,
                            })
                            .await;
                    }
                    // P54 tool_call telemetry (v2 `trackToolCall` counter-
                    // part): outcome + duration for every native execution.
                    // `dup_type` is always `normal` — dedupe-supplied repeats
                    // never reach the execution layer. Field set must stay
                    // exactly the v2 `ToolCallEvent` shape (strict telemetry
                    // property check host-side).
                    let mut telemetry_event = serde_json::json!({
                        "event": "tool_call",
                        "turn_id": request.turn_id.parse::<u64>().unwrap_or(0),
                        "tool_call_id": request.tool_call_id,
                        "tool_name": request.tool_name,
                        "outcome": if result.is_error { "error" } else { "success" },
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "dup_type": "normal",
                    });
                    if result.is_error {
                        telemetry_event["error_type"] = serde_json::Value::String("error".into());
                    }
                    this.inner.telemetry(telemetry_event);
                    let raw = ToolExecuteResponse {
                        content: result.content,
                        is_error: result.is_error,
                        note: result.note,
                    };
                    // The local truncator runs the result policy in-process
                    // (truncate + spill to `<workspace>/.kimi/spill`). The TS
                    // host still receives the *truncated* text via emit_event
                    // so its transcript shows what the model saw.
                    let finalized = match this.truncator.as_ref() {
                        Some(truncator) => {
                            let f = truncator.truncate(
                                crate::tool_result_truncation::TruncationRequest {
                                    tool_name: &request.tool_name,
                                    tool_call_id: &request.tool_call_id,
                                    content: &raw.content,
                                    is_error: raw.is_error,
                                    note: raw.note.as_deref(),
                                },
                            );
                            ToolExecuteResponse {
                                content: f.content,
                                is_error: f.is_error,
                                note: f.note,
                            }
                        }
                        None => raw,
                    };
                    this.inner.emit_event(serde_json::json!({
                        "type": "tool.native",
                        "turn_id": request.turn_id,
                        "tool_call_id": request.tool_call_id,
                        "tool_name": request.tool_name,
                        "arguments": request.arguments,
                        "content": finalized.content,
                        "is_error": finalized.is_error,
                        "note": finalized.note,
                    }));
                    Ok(finalized)
                }
                // Sandbox escape or unrecognized argument shape — the host
                // already allowed the call, so run it there. The completed
                // host execution is observed like any other, so a later
                // native Write to this file doesn't trip on it.
                None => {
                    let response = this.inner.execute_tool(request.clone()).await?;
                    if let Some(gate) = &this.stale_guard {
                        gate.observe(&request.tool_name, &request.arguments, response.is_error);
                    }
                    Ok(response)
                }
            }
        })
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        self.inner.check_permission(request)
    }

    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        self.inner.ask_question(request)
    }

    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
        self.inner.state_read(request)
    }

    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
        self.inner.state_write(request)
    }

    fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
        self.inner.list_tools()
    }

    fn goal(&self) -> BoxFuture<'static, Result<Option<GoalContext>, String>> {
        self.inner.goal()
    }

    fn set_turn_goal(&self, turn_id: &str, goal_id: Option<&str>) {
        if let Some(guard) = &self.goal_guard {
            guard.bind_turn(turn_id, goal_id);
        }
    }

    fn emit_event(&self, event: serde_json::Value) {
        self.inner.emit_event(event);
    }

    fn turn_event(&self, event: crate::turn_events::TurnEvent) {
        self.inner.turn_event(event);
    }

    fn telemetry(&self, event: serde_json::Value) {
        self.inner.telemetry(event);
    }
}

/// A [`HostCallbacks`] decorator that counts fire-and-forget events
/// forwarded through it, so the turn result can carry an event-count
/// telemetry figure.
///
/// The composition roots (stdio CLI, napi addon) wrap the base callbacks
/// with this **before** assembling the native tool wrapper and the native
/// LLM event sink, so every event path — step lifecycle, deltas, native
/// tools, goal budget limits — is counted exactly once.
pub struct CountingCallbacks {
    pub inner: Arc<dyn HostCallbacks>,
    pub event_count: Arc<AtomicU32>,
    /// Optional in-process event bus (P26 批 5) for decoupled in-Rust event consumers.
    pub bus: Option<Arc<crate::events::EventBus>>,
}

impl CountingCallbacks {
    pub fn new(inner: Arc<dyn HostCallbacks>, event_count: Arc<AtomicU32>) -> Self {
        Self {
            inner,
            event_count,
            bus: None,
        }
    }

    pub fn with_bus(mut self, bus: Arc<crate::events::EventBus>) -> Self {
        self.bus = Some(bus);
        self
    }
}

impl HostCallbacks for CountingCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.inner.execute_tool(request)
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        self.inner.check_permission(request)
    }

    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        self.inner.ask_question(request)
    }

    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
        self.inner.state_read(request)
    }

    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
        self.inner.state_write(request)
    }

    fn checkpoint(&self, request: CheckpointRequest) -> BoxFuture<'static, Result<(), String>> {
        self.inner.checkpoint(request)
    }

    fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
        self.inner.list_tools()
    }

    fn goal(&self) -> BoxFuture<'static, Result<Option<GoalContext>, String>> {
        self.inner.goal()
    }

    fn emit_event(&self, event: serde_json::Value) {
        self.event_count.fetch_add(1, Ordering::Relaxed);
        if let Some(ref bus) = self.bus {
            bus.publish_json(event.clone());
        }
        self.inner.emit_event(event);
    }

    fn turn_event(&self, event: crate::turn_events::TurnEvent) {
        // Not counted: `event_count` reports content events (deltas, tool
        // results) as a per-turn overhead figure, and lifecycle records are a
        // fixed four per turn regardless of how much work the turn did.
        if let (Some(bus), Ok(payload)) = (&self.bus, serde_json::to_value(&event)) {
            bus.publish_json(payload);
        }
        self.inner.turn_event(event);
    }

    fn telemetry(&self, event: serde_json::Value) {
        // Not counted, same reasoning as `turn_event`: fixed three events per
        // turn (started / [interrupted] / ended), not overhead telemetry.
        if let Some(ref bus) = self.bus {
            bus.publish_json(event.clone());
        }
        self.inner.telemetry(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{AskQuestionItem, AskQuestionOption};
    use std::sync::atomic::AtomicU32;

    /// A stub that records emitted events so the counter can be asserted.
    struct RecordingCallbacks {
        events: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    }

    impl HostCallbacks for RecordingCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async {
                Ok(PermissionDecision {
                    decision: "allow".into(),
                    reason: None,
                })
            })
        }

        fn emit_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[test]
    fn test_counting_callbacks_counts_events_and_forwards() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let counter = Arc::new(AtomicU32::new(0));
        let callbacks = CountingCallbacks::new(
            Arc::new(RecordingCallbacks {
                events: events.clone(),
            }),
            counter.clone(),
        );

        callbacks.emit_event(serde_json::json!({ "type": "a" }));
        callbacks.emit_event(serde_json::json!({ "type": "b" }));

        assert_eq!(counter.load(Ordering::Relaxed), 2);
        assert_eq!(
            events.lock().unwrap().len(),
            2,
            "events must still be forwarded"
        );
    }

    /// Base callbacks whose permission verdicts are scripted, recording any
    /// tool executions that reach them.
    struct ScriptedPermissionCallbacks {
        decision: PermissionDecision,
        permission_calls: Arc<AtomicU32>,
        executed: Arc<AtomicU32>,
    }

    impl HostCallbacks for ScriptedPermissionCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.executed.fetch_add(1, Ordering::Relaxed);
            Box::pin(async {
                Ok(ToolExecuteResponse {
                    content: "host executed".into(),
                    is_error: false,
                    note: None,
                })
            })
        }

        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            self.permission_calls.fetch_add(1, Ordering::Relaxed);
            let decision = self.decision.clone();
            Box::pin(async move { Ok(decision) })
        }
    }

    fn gate_setup(
        decision: PermissionDecision,
    ) -> (
        tempfile::TempDir,
        NativeToolCallbacks,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let toolset = Arc::new(NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap());
        let permission_calls = Arc::new(AtomicU32::new(0));
        let executed = Arc::new(AtomicU32::new(0));
        let native_count = Arc::new(AtomicU32::new(0));
        let native = NativeToolCallbacks {
            inner: Arc::new(ScriptedPermissionCallbacks {
                decision,
                permission_calls: permission_calls.clone(),
                executed: executed.clone(),
            }),
            toolset,
            native_count: native_count.clone(),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: None,
            goal_guard: None,
            hook_guard: None,
            agent_tool_veto: None,
            tools_veto: None,
        };
        (dir, native, permission_calls, executed, native_count)
    }

    use crate::tools::NativeToolset;

    /// Inner callbacks for the P52 veto tests: counts host executions and
    /// permission consults, and records every `emit_event` payload.
    struct VetoProbeCallbacks {
        permission_calls: Arc<AtomicU32>,
        executed: Arc<AtomicU32>,
        events: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        checkpoints: Arc<std::sync::Mutex<Vec<CheckpointRequest>>>,
        telemetry_events: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    }

    impl HostCallbacks for VetoProbeCallbacks {
        fn telemetry(&self, event: serde_json::Value) {
            self.telemetry_events.lock().unwrap().push(event);
        }
        fn checkpoint(&self, request: CheckpointRequest) -> BoxFuture<'static, Result<(), String>> {
            self.checkpoints.lock().unwrap().push(request);
            Box::pin(async { Ok(()) })
        }
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.executed.fetch_add(1, Ordering::Relaxed);
            Box::pin(async {
                Ok(ToolExecuteResponse {
                    content: "host executed".into(),
                    is_error: false,
                    note: None,
                })
            })
        }
        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            self.permission_calls.fetch_add(1, Ordering::Relaxed);
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }
        fn emit_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event);
        }
    }

    type VetoProbe = (
        tempfile::TempDir,
        NativeToolCallbacks,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    );

    fn veto_setup(agent_tool_veto: Option<String>, tools_veto: Option<String>) -> VetoProbe {
        let dir = tempfile::tempdir().unwrap();
        let toolset = Arc::new(NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap());
        let permission_calls = Arc::new(AtomicU32::new(0));
        let executed = Arc::new(AtomicU32::new(0));
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let native = NativeToolCallbacks {
            inner: Arc::new(VetoProbeCallbacks {
                permission_calls: permission_calls.clone(),
                executed: executed.clone(),
                events: events.clone(),
                checkpoints: Arc::new(std::sync::Mutex::new(Vec::new())),
                telemetry_events: Arc::new(std::sync::Mutex::new(Vec::new())),
            }),
            toolset,
            native_count: Arc::new(AtomicU32::new(0)),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: None,
            goal_guard: None,
            hook_guard: None,
            agent_tool_veto,
            tools_veto,
        };
        (dir, native, permission_calls, executed, events)
    }

    fn veto_events(events: &std::sync::Mutex<Vec<serde_json::Value>>) -> Vec<(String, String)> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| {
                let kind = event.get("type")?.as_str()?.to_string();
                let content = event.get("content")?.as_str()?.to_string();
                Some((kind, content))
            })
            .collect()
    }

    #[tokio::test]
    async fn test_tools_veto_denies_every_native_call() {
        let (_dir, native, permission_calls, executed, events) =
            veto_setup(None, Some("side chat: tools are off".into()));
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({ "path": "a.txt" }),
            })
            .await
            .unwrap();
        assert!(response.is_error);
        assert_eq!(response.content, "side chat: tools are off");
        assert_eq!(
            permission_calls.load(Ordering::Relaxed),
            0,
            "veto outranks permission"
        );
        assert_eq!(executed.load(Ordering::Relaxed), 0, "no host fallback");
        assert_eq!(
            veto_events(&events),
            vec![(
                "tool.native".to_string(),
                "side chat: tools are off".to_string()
            )]
        );
    }

    #[tokio::test]
    async fn test_agent_tool_veto_denies_only_agent() {
        let (_dir, native, permission_calls, executed, events) =
            veto_setup(Some("swarm mode denies Agent".into()), None);
        let denied = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Agent".into(),
                arguments: serde_json::json!({ "prompt": "x" }),
            })
            .await
            .unwrap();
        assert!(denied.is_error);
        assert_eq!(denied.content, "swarm mode denies Agent");
        // Any other tool passes the veto gate and reaches permission.
        let allowed = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c2".into(),
                tool_name: "Glob".into(),
                arguments: serde_json::json!({ "pattern": "*.rs" }),
            })
            .await
            .unwrap();
        assert!(!allowed.is_error, "non-Agent tools are not vetoed");
        assert_eq!(permission_calls.load(Ordering::Relaxed), 1);
        let events = veto_events(&events);
        assert_eq!(
            events[0],
            (
                "tool.native".to_string(),
                "swarm mode denies Agent".to_string()
            )
        );
        let _ = executed;
    }

    #[tokio::test]
    async fn test_native_write_checkpoints_prepare_and_record() {
        let (_dir, _native, _permission_calls, _executed, _events) = veto_setup(None, None);
        // Drill into the inner probe: the setup closure hides it, so drive
        // the public seam twice and assert on the checkpoint calls via a
        // fresh probe we control directly.
        let dir = tempfile::tempdir().unwrap();
        let toolset = Arc::new(NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap());
        let checkpoints = Arc::new(std::sync::Mutex::new(Vec::new()));
        let telemetry_events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let native = NativeToolCallbacks {
            inner: Arc::new(VetoProbeCallbacks {
                permission_calls: Arc::new(AtomicU32::new(0)),
                executed: Arc::new(AtomicU32::new(0)),
                events: Arc::new(std::sync::Mutex::new(Vec::new())),
                checkpoints: checkpoints.clone(),
                telemetry_events: telemetry_events.clone(),
            }),
            toolset,
            native_count: Arc::new(AtomicU32::new(0)),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: None,
            goal_guard: None,
            hook_guard: None,
            agent_tool_veto: None,
            tools_veto: None,
        };
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "turn-7".into(),
                tool_call_id: "c9".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "cp.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert!(!response.is_error);
        let recorded = checkpoints.lock().unwrap().clone();
        let phases: Vec<&str> = recorded.iter().map(|r| r.phase.as_str()).collect();
        assert_eq!(phases, vec!["prepare", "record"]);
        assert_eq!(recorded[0].turn_id, "turn-7");
        assert_eq!(recorded[0].paths, vec!["cp.txt".to_string()]);
        assert!(!recorded[0].executed);
        assert!(recorded[1].executed);
        // P54: one tool_call telemetry event, success outcome, numeric turn
        // id (the wire turn id is not numeric here, so it degrades to 0).
        let telemetry = telemetry_events.lock().unwrap();
        assert_eq!(telemetry.len(), 1);
        let event = &telemetry[0];
        assert_eq!(event["event"], "tool_call");
        assert_eq!(event["tool_call_id"], "c9");
        assert_eq!(event["tool_name"], "Write");
        assert_eq!(event["outcome"], "success");
        assert_eq!(event["dup_type"], "normal");
        assert_eq!(event["turn_id"], 0);
        assert!(event["duration_ms"].is_u64());
    }

    #[tokio::test]
    async fn test_native_write_requires_permission_and_runs_on_allow() {
        let (dir, native, permission_calls, executed, native_count) =
            gate_setup(PermissionDecision {
                decision: "allow".into(),
                reason: None,
            });
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "made.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert_eq!(
            permission_calls.load(Ordering::Relaxed),
            1,
            "permission must be consulted"
        );
        assert_eq!(
            executed.load(Ordering::Relaxed),
            0,
            "allowed calls never reach the host executor"
        );
        assert_eq!(
            native_count.load(Ordering::Relaxed),
            1,
            "an in-process execution is reported"
        );
        assert!(!response.is_error);
        assert!(dir.path().join("made.txt").exists());
    }

    #[tokio::test]
    async fn test_native_write_denial_never_executes() {
        let (_dir, native, permission_calls, executed, native_count) =
            gate_setup(PermissionDecision {
                decision: "deny".into(),
                reason: Some("user declined".into()),
            });
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c2".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "made.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert_eq!(permission_calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            executed.load(Ordering::Relaxed),
            0,
            "denied calls must not fall back to the host"
        );
        assert_eq!(
            native_count.load(Ordering::Relaxed),
            0,
            "a denied call executed nowhere, so it is not a native execution"
        );
        assert!(response.is_error);
        assert!(response.content.contains("user declined"));
        assert!(!_dir.path().join("made.txt").exists());
    }

    #[tokio::test]
    async fn test_read_only_tools_are_gated_too() {
        // The host policy chain can require interactive approval even for
        // reads (sensitive-file access) — so read-only native executions are
        // gated exactly like mutating ones.
        let (_dir, native, permission_calls, executed, native_count) =
            gate_setup(PermissionDecision {
                decision: "deny".into(),
                reason: Some("sensitive file".into()),
            });
        std::fs::write(
            _dir.path().join("a.txt"),
            "alpha
",
        )
        .unwrap();
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c3".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({ "path": "a.txt" }),
            })
            .await
            .unwrap();
        assert_eq!(permission_calls.load(Ordering::Relaxed), 1);
        assert_eq!(executed.load(Ordering::Relaxed), 0);
        assert_eq!(native_count.load(Ordering::Relaxed), 0);
        assert!(response.is_error);
        assert!(response.content.contains("sensitive file"));
    }

    #[tokio::test]
    async fn test_sandbox_escape_is_not_reported_as_native_execution() {
        // A call the sandbox declines to handle runs on the host instead, so
        // it must not inflate native_tool_calls — otherwise the turn result
        // would claim a path that never served the call.
        let (_dir, native, _permission_calls, executed, native_count) =
            gate_setup(PermissionDecision {
                decision: "allow".into(),
                reason: None,
            });
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c4".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({ "path": "../outside.txt" }),
            })
            .await
            .unwrap();
        assert_eq!(
            executed.load(Ordering::Relaxed),
            1,
            "the host picks up what the sandbox escapes"
        );
        assert_eq!(native_count.load(Ordering::Relaxed), 0);
        assert!(!response.is_error);
    }

    /// Base callbacks for stale-gate tests: scripted permission verdict,
    /// recorded events, counted host executions, and a scripted plan domain
    /// for the state bridge.
    struct StaleGateHostCallbacks {
        decision: PermissionDecision,
        permission_calls: Arc<AtomicU32>,
        executed: Arc<AtomicU32>,
        events: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        plan: std::sync::Mutex<Option<serde_json::Value>>,
        state_reads: Arc<AtomicU32>,
    }

    impl HostCallbacks for StaleGateHostCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.executed.fetch_add(1, Ordering::Relaxed);
            Box::pin(async {
                Ok(ToolExecuteResponse {
                    content: "host executed".into(),
                    is_error: false,
                    note: None,
                })
            })
        }

        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            self.permission_calls.fetch_add(1, Ordering::Relaxed);
            let decision = self.decision.clone();
            Box::pin(async move { Ok(decision) })
        }

        fn emit_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event);
        }

        fn state_read(
            &self,
            _: StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
            self.state_reads.fetch_add(1, Ordering::Relaxed);
            let value = self.plan.lock().unwrap().clone();
            Box::pin(async move {
                Ok(StateReadResponse {
                    value: value.ok_or("no plan state")?,
                })
            })
        }
    }

    #[allow(clippy::type_complexity)]
    fn stale_gate_setup(
        decision: PermissionDecision,
        plan: Option<serde_json::Value>,
    ) -> (
        tempfile::TempDir,
        NativeToolCallbacks,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        Arc<AtomicU32>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let toolset = Arc::new(NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap());
        let permission_calls = Arc::new(AtomicU32::new(0));
        let executed = Arc::new(AtomicU32::new(0));
        let native_count = Arc::new(AtomicU32::new(0));
        let state_reads = Arc::new(AtomicU32::new(0));
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let native = NativeToolCallbacks {
            inner: Arc::new(StaleGateHostCallbacks {
                decision,
                permission_calls: permission_calls.clone(),
                executed: executed.clone(),
                events: events.clone(),
                plan: std::sync::Mutex::new(plan),
                state_reads: state_reads.clone(),
            }),
            toolset,
            native_count: native_count.clone(),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: Some(Arc::new(crate::tools::stale_guard::StaleGate::new(Some(
                dir.path().to_path_buf(),
            )))),
            goal_guard: None,
            hook_guard: None,
            agent_tool_veto: None,
            tools_veto: None,
        };
        (dir, native, executed, native_count, events, state_reads)
    }

    #[tokio::test]
    async fn test_stale_guard_denies_unread_native_write() {
        let (dir, native, executed, native_count, events, _state_reads) = stale_gate_setup(
            PermissionDecision {
                decision: "allow".into(),
                reason: None,
            },
            Some(serde_json::json!({ "active": false })),
        );
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert!(response.is_error);
        assert!(response.content.contains("has not been read by this agent"));
        assert_eq!(
            executed.load(Ordering::Relaxed),
            0,
            "a stale denial must not fall back to the host"
        );
        assert_eq!(
            native_count.load(Ordering::Relaxed),
            0,
            "a stale denial executed nowhere"
        );
        let events = events.lock().unwrap();
        let native_event = events
            .iter()
            .find(|e| e["type"] == "tool.native")
            .expect("the refusal must be reported as tool.native");
        assert_eq!(native_event["is_error"], true);
        assert!(
            native_event["content"]
                .as_str()
                .unwrap()
                .contains("has not been read by this agent")
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "hello",
            "the denied write must not touch the file"
        );
    }

    #[tokio::test]
    async fn test_stale_guard_allows_read_then_native_write() {
        let (dir, native, _executed, native_count, _events, _state_reads) = stale_gate_setup(
            PermissionDecision {
                decision: "allow".into(),
                reason: None,
            },
            Some(serde_json::json!({ "active": false })),
        );
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let read = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({ "path": "a.txt" }),
            })
            .await
            .unwrap();
        assert!(!read.is_error);
        let write = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c2".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert!(!write.is_error, "read-then-write must pass: {write:?}");
        assert_eq!(native_count.load(Ordering::Relaxed), 2);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "x"
        );
    }

    #[tokio::test]
    async fn test_stale_guard_records_host_forwarded_reads() {
        // A `region` Read falls back to the host (media pipeline); the gate
        // must still record it so a later native Write to the same file
        // passes.
        let (dir, native, executed, _native_count, _events, _state_reads) = stale_gate_setup(
            PermissionDecision {
                decision: "allow".into(),
                reason: None,
            },
            Some(serde_json::json!({ "active": false })),
        );
        std::fs::write(dir.path().join("media.txt"), "hello").unwrap();
        let read = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({ "path": "media.txt", "region": {} }),
            })
            .await
            .unwrap();
        assert!(!read.is_error);
        assert_eq!(
            executed.load(Ordering::Relaxed),
            1,
            "the region read runs on the host"
        );
        let write = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c2".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "media.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert!(
            !write.is_error,
            "a host-served read must clear the native write: {write:?}"
        );
    }

    #[tokio::test]
    async fn test_permission_deny_beats_stale_guard() {
        // v2 chain order: permission → plan → staleGuard. A permission deny
        // short-circuits before the stale gate is consulted at all.
        let (dir, native, _executed, _native_count, _events, state_reads) = stale_gate_setup(
            PermissionDecision {
                decision: "deny".into(),
                reason: Some("user declined".into()),
            },
            Some(serde_json::json!({ "active": false })),
        );
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert!(response.is_error);
        assert!(response.content.contains("user declined"));
        assert!(!response.content.contains("has not been read"));
        assert_eq!(
            state_reads.load(Ordering::Relaxed),
            0,
            "the stale gate must not be consulted after a permission deny"
        );
    }

    /// Base callbacks for goal-guard tests: scripted permission verdict, a
    /// scripted current goal, counted host executions, recorded events.
    struct GoalGateHostCallbacks {
        decision: PermissionDecision,
        permission_calls: Arc<AtomicU32>,
        executed: Arc<AtomicU32>,
        goal_reads: Arc<AtomicU32>,
        events: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        goal: std::sync::Mutex<Option<crate::turn_loop::types::GoalContext>>,
    }

    impl HostCallbacks for GoalGateHostCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.executed.fetch_add(1, Ordering::Relaxed);
            Box::pin(async {
                Ok(ToolExecuteResponse {
                    content: "host executed".into(),
                    is_error: false,
                    note: None,
                })
            })
        }

        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            self.permission_calls.fetch_add(1, Ordering::Relaxed);
            let decision = self.decision.clone();
            Box::pin(async move { Ok(decision) })
        }

        fn emit_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event);
        }

        fn goal(&self) -> BoxFuture<'static, Result<Option<GoalContext>, String>> {
            self.goal_reads.fetch_add(1, Ordering::Relaxed);
            let goal = self.goal.lock().unwrap().clone();
            Box::pin(async move { Ok(goal) })
        }
    }

    #[allow(clippy::type_complexity)]
    fn goal_gate_setup(
        mode: crate::permission::PermissionMode,
        route_to_host: bool,
        current_goal: Option<crate::turn_loop::types::GoalContext>,
    ) -> (
        tempfile::TempDir,
        NativeToolCallbacks,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        Arc<crate::tools::goal_guard::GoalGuard>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let permission_calls = Arc::new(AtomicU32::new(0));
        let executed = Arc::new(AtomicU32::new(0));
        let native_count = Arc::new(AtomicU32::new(0));
        let goal_reads = Arc::new(AtomicU32::new(0));
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let guard = Arc::new(crate::tools::goal_guard::GoalGuard::new(
            Some(mode),
            route_to_host,
        ));
        let fake: Arc<dyn HostCallbacks> = Arc::new(GoalGateHostCallbacks {
            decision: PermissionDecision {
                decision: "allow".into(),
                reason: None,
            },
            permission_calls: permission_calls.clone(),
            executed: executed.clone(),
            goal_reads: goal_reads.clone(),
            events: events.clone(),
            goal: std::sync::Mutex::new(current_goal),
        });
        let toolset = Arc::new(
            NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(fake.clone()),
        );
        let native = NativeToolCallbacks {
            inner: fake,
            toolset,
            native_count: native_count.clone(),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: None,
            goal_guard: Some(guard.clone()),
            hook_guard: None,
            agent_tool_veto: None,
            tools_veto: None,
        };
        (
            dir,
            native,
            executed,
            native_count,
            permission_calls,
            goal_reads,
            events,
            guard,
        )
    }

    fn gate_goal(id: &str) -> crate::turn_loop::types::GoalContext {
        crate::turn_loop::types::GoalContext {
            goal_id: id.into(),
            objective: String::new(),
            status: crate::turn_loop::types::GoalStatus::Active,
            token_budget: None,
            turn_budget: None,
            wall_clock_budget_ms: None,
            tokens_used: 0,
            turns_used: 0,
            wall_clock_ms: 0,
        }
    }

    #[tokio::test]
    async fn test_goal_guard_routes_create_goal_to_host_outside_auto_mode() {
        let (_dir, native, executed, native_count, permission_calls, _goal_reads, _events, _guard) =
            goal_gate_setup(
                crate::permission::PermissionMode::Manual,
                true,
                Some(gate_goal("g1")),
            );
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "CreateGoal".into(),
                arguments: serde_json::json!({ "objective": "do it" }),
            })
            .await
            .unwrap();
        assert!(
            !response.is_error,
            "the host runs the reviewed call: {response:?}"
        );
        assert_eq!(
            executed.load(Ordering::Relaxed),
            1,
            "non-auto CreateGoal must run on the host"
        );
        assert_eq!(
            native_count.load(Ordering::Relaxed),
            0,
            "routed calls are not native executions"
        );
        assert_eq!(
            permission_calls.load(Ordering::Relaxed),
            0,
            "routing happens before the engine's permission step"
        );
    }

    #[tokio::test]
    async fn test_goal_guard_keeps_create_goal_native_in_auto_mode() {
        let (_dir, native, executed, native_count, permission_calls, _goal_reads, _events, _guard) =
            goal_gate_setup(crate::permission::PermissionMode::Auto, true, None);
        let _response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "CreateGoal".into(),
                arguments: serde_json::json!({ "objective": "do it" }),
            })
            .await
            .unwrap();
        // The native CreateGoal runs against the test fake whose state
        // bridge is unwired — the result is a bridge error, but the point
        // is that it executed natively, not on the host.
        assert_eq!(native_count.load(Ordering::Relaxed), 1);
        assert_eq!(executed.load(Ordering::Relaxed), 0);
        assert_eq!(
            permission_calls.load(Ordering::Relaxed),
            1,
            "auto mode goes through the native permission gate"
        );
    }

    #[tokio::test]
    async fn test_goal_guard_vetoes_stale_goal_mutation() {
        let (_dir, native, executed, _native_count, _permission_calls, goal_reads, events, guard) =
            goal_gate_setup(
                crate::permission::PermissionMode::Auto,
                true,
                Some(gate_goal("g2")),
            );
        guard.bind_turn("t", Some("g1"));

        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "UpdateGoal".into(),
                arguments: serde_json::json!({ "status": "complete" }),
            })
            .await
            .unwrap();
        assert!(response.is_error);
        assert_eq!(
            response.content,
            "Goal changed since this turn started; ignored stale goal tool call."
        );
        assert_eq!(executed.load(Ordering::Relaxed), 0);
        assert_eq!(goal_reads.load(Ordering::Relaxed), 1);
        let native_event = events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "tool.native")
            .expect("the refusal is reported as tool.native")
            .clone();
        assert_eq!(native_event["is_error"], true);
    }

    #[tokio::test]
    async fn test_goal_guard_exempts_read_only_goal_tools() {
        let (_dir, native, _executed, _native_count, _permission_calls, goal_reads, _events, guard) =
            goal_gate_setup(
                crate::permission::PermissionMode::Auto,
                true,
                Some(gate_goal("g2")),
            );
        guard.bind_turn("t", Some("g1"));

        // GetGoal is read-only and never stale-checked (v2 `isGoalMutationTool`
        // excludes it): it runs (natively or via the fallback) without a veto.
        let _response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "GetGoal".into(),
                arguments: serde_json::json!({}),
            })
            .await
            .unwrap();
        assert_eq!(
            goal_reads.load(Ordering::Relaxed),
            0,
            "the stale check must not fire for GetGoal"
        );
    }

    /// PreToolUse hook gate tests: a scripted hook list runs before native
    /// execution through the same fake host as the goal-gate setup.
    #[allow(clippy::type_complexity)]
    fn hook_gate_setup(
        hooks: Vec<crate::permission::HookDef>,
    ) -> (
        tempfile::TempDir,
        NativeToolCallbacks,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<AtomicU32>,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let permission_calls = Arc::new(AtomicU32::new(0));
        let executed = Arc::new(AtomicU32::new(0));
        let native_count = Arc::new(AtomicU32::new(0));
        let goal_reads = Arc::new(AtomicU32::new(0));
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let fake: Arc<dyn HostCallbacks> = Arc::new(GoalGateHostCallbacks {
            decision: PermissionDecision {
                decision: "allow".into(),
                reason: None,
            },
            permission_calls: permission_calls.clone(),
            executed: executed.clone(),
            goal_reads: goal_reads.clone(),
            events: events.clone(),
            goal: std::sync::Mutex::new(None),
        });
        let toolset = Arc::new(
            NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(fake.clone()),
        );
        let native = NativeToolCallbacks {
            inner: fake,
            toolset,
            native_count: native_count.clone(),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: None,
            goal_guard: None,
            hook_guard: Some(Arc::new(crate::tools::external_hooks::HookGuard::new(
                hooks,
            ))),
            agent_tool_veto: None,
            tools_veto: None,
        };
        (
            dir,
            native,
            executed,
            native_count,
            permission_calls,
            goal_reads,
            events,
        )
    }

    fn hook_exit_two_with_stderr() -> crate::permission::HookDef {
        crate::permission::HookDef {
            event: "PreToolUse".into(),
            matcher: String::new(),
            command: if cfg!(windows) {
                "echo denied by gate hook 1>&2 & exit /b 2".into()
            } else {
                "echo denied by gate hook >&2; exit 2".into()
            },
            timeout: None,
        }
    }

    #[tokio::test]
    async fn test_hook_guard_denies_native_call() {
        let (_dir, native, executed, _native_count, _permission_calls, _goal_reads, events) =
            hook_gate_setup(vec![hook_exit_two_with_stderr()]);
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert!(response.is_error);
        assert_eq!(response.content, "denied by gate hook");
        assert_eq!(
            executed.load(Ordering::Relaxed),
            0,
            "a hook block must not fall back to the host"
        );
        let native_event = events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "tool.native")
            .expect("the refusal is reported as tool.native")
            .clone();
        assert_eq!(native_event["is_error"], true);
        assert_eq!(native_event["content"], "denied by gate hook");
    }

    #[tokio::test]
    async fn test_hook_guard_allows_when_hook_passes() {
        let (_dir, native, executed, native_count, _permission_calls, _goal_reads, _events) =
            hook_gate_setup(vec![crate::permission::HookDef {
                event: "PreToolUse".into(),
                matcher: String::new(),
                command: if cfg!(windows) {
                    "exit /b 0".into()
                } else {
                    "exit 0".into()
                },
                timeout: None,
            }]);
        let response = native
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Write".into(),
                arguments: serde_json::json!({ "path": "made.txt", "content": "x" }),
            })
            .await
            .unwrap();
        assert!(
            !response.is_error,
            "an allowing hook must not block: {response:?}"
        );
        assert_eq!(native_count.load(Ordering::Relaxed), 1);
        assert_eq!(executed.load(Ordering::Relaxed), 0);
    }
    /// A stub that answers questions, recording the request it received.
    struct AskQuestionCallbacks {
        received: Arc<std::sync::Mutex<Option<AskQuestionRequest>>>,
    }

    impl HostCallbacks for AskQuestionCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }

        fn ask_question(
            &self,
            request: AskQuestionRequest,
        ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
            *self.received.lock().unwrap() = Some(request);
            Box::pin(async {
                Ok(AskQuestionResponse {
                    answers: std::collections::HashMap::new(),
                    method: Some("enter".into()),
                    note: None,
                    cancelled: None,
                    reason: None,
                })
            })
        }
    }

    fn sample_ask_question_request() -> AskQuestionRequest {
        AskQuestionRequest {
            question_id: "question_1".into(),
            turn_id: "turn-1".into(),
            tool_call_id: "call_1".into(),
            background: false,
            timeout_ms: None,
            questions: vec![AskQuestionItem {
                question: "Pick one".into(),
                header: None,
                options: vec![AskQuestionOption {
                    label: "Option A".into(),
                    description: None,
                }],
                multi_select: false,
            }],
        }
    }

    /// A host that never wired the interactive-question seam must get the
    /// trait default: an explicit "not supported" error, so the tool result
    /// tells the model not to call the tool again.
    #[tokio::test]
    async fn test_ask_question_default_impl_errors() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let callbacks = RecordingCallbacks { events };
        let err = callbacks
            .ask_question(sample_ask_question_request())
            .await
            .unwrap_err();
        assert!(err.contains("does not support interactive questions"));
    }

    #[tokio::test]
    async fn test_counting_callbacks_forwards_ask_question() {
        let received = Arc::new(std::sync::Mutex::new(None));
        let counting = CountingCallbacks::new(
            Arc::new(AskQuestionCallbacks {
                received: received.clone(),
            }),
            Arc::new(AtomicU32::new(0)),
        );
        let response = counting
            .ask_question(sample_ask_question_request())
            .await
            .unwrap();
        assert_eq!(response.method.as_deref(), Some("enter"));
        assert!(response.answers.is_empty());
        let received = received.lock().unwrap();
        assert_eq!(received.as_ref().unwrap().question_id, "question_1");
        assert_eq!(received.as_ref().unwrap().questions.len(), 1);
    }

    #[tokio::test]
    async fn test_native_tool_callbacks_forwards_ask_question() {
        let dir = tempfile::tempdir().unwrap();
        let toolset = Arc::new(NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap());
        let received = Arc::new(std::sync::Mutex::new(None));
        let native = NativeToolCallbacks {
            inner: Arc::new(AskQuestionCallbacks {
                received: received.clone(),
            }),
            toolset,
            native_count: Arc::new(AtomicU32::new(0)),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: None,
            goal_guard: None,
            hook_guard: None,
            agent_tool_veto: None,
            tools_veto: None,
        };
        let mut request = sample_ask_question_request();
        request.question_id = "question_2".into();
        request.background = true;
        request.timeout_ms = Some(30_000);
        let response = native.ask_question(request).await.unwrap();
        assert_eq!(response.method.as_deref(), Some("enter"));
        let received = received.lock().unwrap();
        let req = received.as_ref().unwrap();
        assert_eq!(req.question_id, "question_2");
        assert!(req.background);
        assert_eq!(req.timeout_ms, Some(30_000));
    }

    /// A stub that answers state bridge calls, recording the requests it
    /// received.
    struct StateBridgeCallbacks {
        read_received: Arc<std::sync::Mutex<Option<StateReadRequest>>>,
        write_received: Arc<std::sync::Mutex<Option<StateWriteRequest>>>,
    }

    impl HostCallbacks for StateBridgeCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }

        fn state_read(
            &self,
            request: StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
            *self.read_received.lock().unwrap() = Some(request);
            Box::pin(async {
                Ok(StateReadResponse {
                    value: serde_json::json!([
                        {"id": "T1", "title": "Read session-control.ts", "status": "in_progress"}
                    ]),
                })
            })
        }

        fn state_write(
            &self,
            request: StateWriteRequest,
        ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
            *self.write_received.lock().unwrap() = Some(request);
            Box::pin(async {
                Ok(StateWriteResponse {
                    ok: true,
                    value: serde_json::json!({"active": true, "id": "plan-7f3a"}),
                })
            })
        }
    }

    fn sample_state_read_request() -> StateReadRequest {
        StateReadRequest {
            domain: "todo".into(),
            key: "todo".into(),
            turn_id: "turn-1".into(),
            tool_call_id: "call_1".into(),
        }
    }

    fn sample_state_write_request() -> StateWriteRequest {
        StateWriteRequest {
            domain: "plan".into(),
            key: "plan".into(),
            value: serde_json::json!({"active": true}),
            undoable: true,
            turn_id: "turn-1".into(),
            tool_call_id: "call_1".into(),
        }
    }

    /// A host that never wired the state bridge seam must get the trait
    /// default: an explicit "not supported" error, so the tool result tells
    /// the model not to call the tool again.
    #[tokio::test]
    async fn test_state_read_default_impl_errors() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let callbacks = RecordingCallbacks { events };
        let err = callbacks
            .state_read(sample_state_read_request())
            .await
            .unwrap_err();
        assert!(err.contains("does not support state bridge"));
    }

    #[tokio::test]
    async fn test_state_write_default_impl_errors() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let callbacks = RecordingCallbacks { events };
        let err = callbacks
            .state_write(sample_state_write_request())
            .await
            .unwrap_err();
        assert!(err.contains("does not support state bridge"));
    }

    #[tokio::test]
    async fn test_counting_callbacks_forwards_state_bridge() {
        let read_received = Arc::new(std::sync::Mutex::new(None));
        let write_received = Arc::new(std::sync::Mutex::new(None));
        let counting = CountingCallbacks::new(
            Arc::new(StateBridgeCallbacks {
                read_received: read_received.clone(),
                write_received: write_received.clone(),
            }),
            Arc::new(AtomicU32::new(0)),
        );
        let read = counting
            .state_read(sample_state_read_request())
            .await
            .unwrap();
        assert_eq!(read.value[0]["id"], "T1");
        let write = counting
            .state_write(sample_state_write_request())
            .await
            .unwrap();
        assert!(write.ok);
        assert_eq!(write.value["id"], "plan-7f3a");
        let read_req = read_received.lock().unwrap();
        assert_eq!(read_req.as_ref().unwrap().domain, "todo");
        assert_eq!(read_req.as_ref().unwrap().turn_id, "turn-1");
        let write_req = write_received.lock().unwrap();
        assert_eq!(write_req.as_ref().unwrap().domain, "plan");
        assert!(write_req.as_ref().unwrap().undoable);
    }

    #[tokio::test]
    async fn test_native_tool_callbacks_forwards_state_bridge() {
        let dir = tempfile::tempdir().unwrap();
        let toolset = Arc::new(NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap());
        let read_received = Arc::new(std::sync::Mutex::new(None));
        let write_received = Arc::new(std::sync::Mutex::new(None));
        let native = NativeToolCallbacks {
            inner: Arc::new(StateBridgeCallbacks {
                read_received: read_received.clone(),
                write_received: write_received.clone(),
            }),
            toolset,
            native_count: Arc::new(AtomicU32::new(0)),
            truncator: None,
            permission_engine: None,
            plan_guard: None,
            stale_guard: None,
            goal_guard: None,
            hook_guard: None,
            agent_tool_veto: None,
            tools_veto: None,
        };
        let mut read_request = sample_state_read_request();
        read_request.turn_id = "turn-2".into();
        let read = native.state_read(read_request).await.unwrap();
        assert_eq!(read.value[0]["status"], "in_progress");
        let mut write_request = sample_state_write_request();
        write_request.undoable = false;
        let write = native.state_write(write_request).await.unwrap();
        assert!(write.ok);
        let read_req = read_received.lock().unwrap();
        assert_eq!(read_req.as_ref().unwrap().turn_id, "turn-2");
        let write_req = write_received.lock().unwrap();
        assert!(!write_req.as_ref().unwrap().undoable);
    }
}
