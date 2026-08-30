/// Host callback trait for LLM chat and tool execution.
///
/// This trait abstracts the transport layer — whether it's JSON-RPC over
/// stdio (the RpcServer-based implementation) or direct napi-rs
/// ThreadsafeFunction calls. The turn loop uses this trait to call back
/// to the JS host for LLM inference and tool execution.
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::rpc::types::{
    BoxFuture, LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision,
    ToolExecuteRequest, ToolExecuteResponse,
};

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
/// Natively-executed calls are reported to the host via [`emit_event`]
/// (`type: "tool.native"`) so the transcript still records them.
pub struct NativeToolCallbacks {
    pub inner: Arc<dyn HostCallbacks>,
    pub toolset: Arc<crate::tools::NativeToolset>,
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
        };
        Box::pin(async move {
            let decision = this
                .inner
                .check_permission(PermissionCheckRequest {
                    tool_name: request.tool_name.clone(),
                    tool_call_id: request.tool_call_id.clone(),
                    arguments: request.arguments.clone(),
                })
                .await?;
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
            let result = if crate::tools::is_mutating_tool(&request.tool_name) {
                this.toolset
                    .execute_mutating(&request.tool_name, &request.arguments)
                    .await
            } else {
                this.toolset.execute(&request.tool_name, &request.arguments)
            };
            match result {
                Some(result) => {
                    this.inner.emit_event(serde_json::json!({
                        "type": "tool.native",
                        "turn_id": request.turn_id,
                        "tool_call_id": request.tool_call_id,
                        "tool_name": request.tool_name,
                        "arguments": request.arguments,
                        "content": result.content,
                        "is_error": result.is_error,
                        "note": result.note,
                    }));
                    Ok(ToolExecuteResponse {
                        content: result.content,
                        is_error: result.is_error,
                        note: result.note.clone(),
                    })
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

    fn emit_event(&self, event: serde_json::Value) {
        self.event_count.fetch_add(1, Ordering::Relaxed);
        self.inner.emit_event(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let callbacks = CountingCallbacks {
            inner: Arc::new(RecordingCallbacks {
                events: events.clone(),
            }),
            event_count: counter.clone(),
        };

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
    ) {
        let dir = tempfile::tempdir().unwrap();
        let toolset = Arc::new(NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap());
        let permission_calls = Arc::new(AtomicU32::new(0));
        let executed = Arc::new(AtomicU32::new(0));
        let native = NativeToolCallbacks {
            inner: Arc::new(ScriptedPermissionCallbacks {
                decision,
                permission_calls: permission_calls.clone(),
                executed: executed.clone(),
            }),
            toolset,
        };
        (dir, native, permission_calls, executed)
    }

    use crate::tools::NativeToolset;

    #[tokio::test]
    async fn test_native_write_requires_permission_and_runs_on_allow() {
        let (dir, native, permission_calls, executed) = gate_setup(PermissionDecision {
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
        assert!(!response.is_error);
        assert!(dir.path().join("made.txt").exists());
    }

    #[tokio::test]
    async fn test_native_write_denial_never_executes() {
        let (_dir, native, permission_calls, executed) = gate_setup(PermissionDecision {
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
        assert!(response.is_error);
        assert!(response.content.contains("user declined"));
        assert!(!_dir.path().join("made.txt").exists());
    }

    #[tokio::test]
    async fn test_read_only_tools_are_gated_too() {
        // The host policy chain can require interactive approval even for
        // reads (sensitive-file access) — so read-only native executions are
        // gated exactly like mutating ones.
        let (_dir, native, permission_calls, executed) = gate_setup(PermissionDecision {
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
        assert!(response.is_error);
        assert!(response.content.contains("sensitive file"));
    }
}
