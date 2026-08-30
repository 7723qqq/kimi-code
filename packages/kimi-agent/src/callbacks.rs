/// Host callback trait for LLM chat and tool execution.
///
/// This trait abstracts the transport layer — whether it's JSON-RPC over
/// stdio (the RpcServer-based implementation) or direct napi-rs
/// ThreadsafeFunction calls. The turn loop uses this trait to call back
/// to the JS host for LLM inference and tool execution.
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, BoxFuture, LlmChatRequest, LlmChatResponse,
    PermissionCheckRequest, PermissionDecision, ToolExecuteRequest, ToolExecuteResponse,
    ToolFinalizeRequest,
};
use crate::turn_loop::types::LLMMessage;

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

    /// Hand a natively-executed result to the host for finalization before it
    /// enters the model context. The host owns result truncation and
    /// spill-to-disk, so without this seam a large native result reaches the
    /// model unprocessed while the same call on the host path would be
    /// truncated and spilled. The default returns the result unchanged, for
    /// hosts that do not implement the seam.
    fn finalize_tool_result(
        &self,
        request: ToolFinalizeRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        Box::pin(async move {
            Ok(ToolExecuteResponse {
                content: request.content,
                is_error: request.is_error,
                note: request.note,
            })
        })
    }

    /// Ask the host to release steering the user injected during this turn.
    /// The host owns the turn's step-request queue and records each steer into
    /// the transcript as it releases it, so an engine driving the whole turn
    /// has to ask at every step head — otherwise the prompt waits for the turn
    /// to end. The default answers with nothing, for hosts without the seam.
    fn drain_steers(&self) -> BoxFuture<'static, Result<Vec<LLMMessage>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    /// Fire-and-forget event notification to the JS host. Used by the
    /// native LLM / native tool paths to report step boundaries, streaming
    /// deltas, and natively-executed tool results so the host can record
    /// them in the transcript. The default implementation drops the event.
    fn emit_event(&self, event: serde_json::Value) {
        let _ = event;
    }

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

/// Outer bound on finalizing a natively-executed result. The host truncates and
/// optionally spills a string — no human in the loop — so a stalled call must
/// not hold the turn open for as long as a real tool execution may.
pub const HOST_FINALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Outer bound on releasing queued mid-turn steering. Like finalization this is
/// host bookkeeping with no human in the loop, so a stalled answer must not
/// hold the step open.
pub const HOST_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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

    fn finalize_tool_result(
        &self,
        request: ToolFinalizeRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Tool finalize serialize error: {e}"))?;
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_FINALIZE_TOOL_RESULT,
                    params,
                    Some(HOST_FINALIZE_TIMEOUT),
                )
                .await
                .map_err(|e| format!("Tool finalize error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("Tool finalize parse error: {e}"))
        })
    }

    fn drain_steers(&self) -> BoxFuture<'static, Result<Vec<LLMMessage>, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let response_value = server
                .invoke(
                    crate::rpc::types::methods::HOST_DRAIN_STEERS,
                    serde_json::json!({}),
                    Some(HOST_DRAIN_TIMEOUT),
                )
                .await
                .map_err(|e| format!("Drain steers error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("Drain steers parse error: {e}"))
        })
    }

    fn emit_event(&self, event: serde_json::Value) {
        // JSON-RPC notification over stdout — fire-and-forget by design.
        crate::rpc::server::RpcServer::notify_now(crate::rpc::types::methods::HOST_EVENT, &event);
    }
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
    /// results are truncated and spilled locally; the host's
    /// `finalize_tool_result` seam is bypassed. When `None`, the wrapper
    /// falls back to `inner.finalize_tool_result(...)` for backwards
    /// compatibility.
    pub truncator: Option<Arc<crate::tool_result_truncation::ToolResultTruncator>>,
    /// Optional in-process permission engine (P26 批 3). When `Some`, tool
    /// calls are evaluated against the per-turn `PolicySnapshot` locally in
    /// Rust, bypassing the host `host/check_permission` seam for allow/deny
    /// verdicts.
    pub permission_engine: Option<Arc<crate::permission::PermissionEngine>>,
}

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
        if !self.toolset.handles(&request.tool_name) {
            return self.inner.execute_tool(request);
        }
        let this = NativeToolCallbacks {
            inner: self.inner.clone(),
            toolset: self.toolset.clone(),
            native_count: self.native_count.clone(),
            truncator: self.truncator.clone(),
            permission_engine: self.permission_engine.clone(),
        };
        Box::pin(async move {
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
            let result = this
                .toolset
                .execute_tool(&request.tool_name, &request.arguments)
                .await;
            match result {
                Some(result) => {
                    this.native_count.fetch_add(1, Ordering::Relaxed);
                    let raw = ToolExecuteResponse {
                        content: result.content,
                        is_error: result.is_error,
                        note: result.note,
                    };
                    // P26 批 4: when a local truncator is configured, run the
                    // policy in-process and bypass the host's finalize seam.
                    // The TS host still receives the *truncated* text via
                    // emit_event so its transcript shows what the model saw.
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
                        None => {
                            // Legacy path: the host owns result truncation and
                            // spill-to-disk; a large native result must not
                            // reach the model raw the way an identical
                            // host-executed call never could.
                            this.inner
                                .finalize_tool_result(ToolFinalizeRequest {
                                    tool_name: request.tool_name.clone(),
                                    tool_call_id: request.tool_call_id.clone(),
                                    content: raw.content.clone(),
                                    is_error: raw.is_error,
                                    note: raw.note.clone(),
                                })
                                .await
                                // A failed result policy must not cost the
                                // model its tool output.
                                .unwrap_or(raw)
                        }
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
                // already allowed the call, so run it there.
                None => this.inner.execute_tool(request).await,
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

    fn finalize_tool_result(
        &self,
        request: ToolFinalizeRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.inner.finalize_tool_result(request)
    }

    fn drain_steers(&self) -> BoxFuture<'static, Result<Vec<LLMMessage>, String>> {
        self.inner.drain_steers()
    }

    fn emit_event(&self, event: serde_json::Value) {
        self.inner.emit_event(event);
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

    fn finalize_tool_result(
        &self,
        request: ToolFinalizeRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.inner.finalize_tool_result(request)
    }

    fn drain_steers(&self) -> BoxFuture<'static, Result<Vec<LLMMessage>, String>> {
        self.inner.drain_steers()
    }

    fn emit_event(&self, event: serde_json::Value) {
        self.event_count.fetch_add(1, Ordering::Relaxed);
        if let Some(ref bus) = self.bus {
            bus.publish_json(event.clone());
        }
        self.inner.emit_event(event);
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

        fn finalize_tool_result(
            &self,
            request: ToolFinalizeRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async move {
                Ok(ToolExecuteResponse {
                    content: format!("finalized:{}", request.content),
                    is_error: request.is_error,
                    note: request.note,
                })
            })
        }
    }

    /// A decorator that forgets to forward `finalize_tool_result` silently
    /// answers with the trait default, so the host policy never runs and every
    /// natively-executed result reaches the model raw.
    #[tokio::test]
    async fn test_counting_callbacks_forwards_result_finalization() {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let counting = CountingCallbacks::new(
            Arc::new(RecordingCallbacks {
                events: events.clone(),
            }),
            Arc::new(AtomicU32::new(0)),
        );
        let resolved = counting
            .finalize_tool_result(ToolFinalizeRequest {
                tool_name: "Read".into(),
                tool_call_id: "c".into(),
                content: "body".into(),
                is_error: false,
                note: None,
            })
            .await
            .unwrap();
        assert_eq!(resolved.content, "finalized:body");
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
        };
        (dir, native, permission_calls, executed, native_count)
    }

    use crate::tools::NativeToolset;

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
}
