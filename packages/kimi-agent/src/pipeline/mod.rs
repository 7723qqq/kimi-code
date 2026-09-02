//! Host-agnostic engine pipeline construction, shared by every entry path.
//!
//! One engine context = one `HostCallbacks` implementation (the host seam) plus
//! the same wrapper chain on top of it: counting wrapper (all event paths) →
//! native-tool wrapper (in-process Read/Grep/Glob/Write/Edit/Bash, permission
//! engine, truncation, plan-mode/stale/goal/hook guards). The LLM is picked in
//! one place: multi > native-http > host-proxy, with self-contained mode
//! refusing the host-proxy fallback.
//!
//! Before this module the chain existed twice, once per transport
//! (`src/main.rs` for stdio JSON-RPC, `src/napi_bindings.rs` for the addon), and
//! the two copies had drifted: the stdio copy builds a per-pipeline
//! `SubagentManager` while the addon refreshes a process-wide one; the
//! `parent_cancel_slot` seam is wired only on the stdio side. Both policies are
//! now inputs (`PipelineHost`) so each entry keeps its own semantics while the
//! chain itself has a single definition. A third host — an in-process server
//! front reached over HTTP/WebSocket instead of stdio — needs only its own
//! `HostCallbacks` impl and a `PipelineSpec`.

use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};

use crate::callbacks::{CountingCallbacks, HostCallbacks, NativeToolCallbacks};
use crate::events::EventBus;
use crate::llm::{
    http::NativeHttpLlm,
    multi::{LlmProvider, MultiLLM},
    proxy::HostLlmProxy,
};
use crate::mcp::McpManager;
use crate::permission::PolicySnapshot;
use crate::rpc::types::NativeLlmConfig;
use crate::subagent::{ParentCancel, SubagentManager};
use crate::tool_result_truncation::ToolResultTruncator;
use crate::tools::{
    external_hooks::HookGuard, github::GitHubCredentials, goal_guard::GoalGuard, plan_mode,
    stale_guard::StaleGate, NativeToolset,
};
use crate::turn_loop::types::LLM;

/// The assembled engine context: the LLM to drive the turn loop with, the
/// callback chain it reports through, and the two counters the turn result
/// reports.
pub struct EnginePipeline {
    pub llm: Arc<dyn LLM>,
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Event counter from the counting wrapper (turn result telemetry).
    pub turn_event_count: Arc<AtomicU32>,
    /// Native tool call counter from the native-tool wrapper.
    pub native_tool_count: Arc<AtomicU32>,
}

/// One concurrent provider for the MultiLLM race. The chain needs only these
/// three fields; each entry maps them from its own wire type.
pub struct PipelineProvider {
    pub name: String,
    pub system_prompt: String,
    pub model: String,
}

/// Host-resolved settings one engine context runs with. Every field is already
/// normalized — each entry maps its own wire params (typed `RunTurnParams` on
/// stdio, `JsRunTurnParams` with JSON-string fields on the addon) into this
/// shape before calling [`build_engine_pipeline`].
pub struct PipelineSpec {
    pub system_prompt: String,
    pub model_name: String,
    /// Concurrent providers (MultiLLM race). Non-empty wins over `native_llm`.
    pub providers: Vec<PipelineProvider>,
    pub native_llm: Option<NativeLlmConfig>,
    /// Workspace root used to sandbox native tool execution. Absent → every
    /// tool round-trips to the host.
    pub workspace_root: Option<String>,
    /// When true (and `workspace_root` is set), sandboxable tools run in the
    /// Rust process, each still gated on a host permission grant.
    pub native_tools: bool,
    /// When true, the engine refuses the `host/llm_chat` fallback: `providers`
    /// or `native_llm` must be set, or building fails with a message naming
    /// `rustSelfContained` (ROADMAP P26 批 1).
    pub rust_self_contained: bool,
    pub shell_path: Option<String>,
    pub policy_snapshot: Option<PolicySnapshot>,
    pub github_token: Option<String>,
    pub github_base_url: Option<String>,
    /// Host-resolved foreground subagent timeout in ms (v2
    /// `resolveSubagentTimeoutMs`). `None` → engine default (2h).
    pub subagent_timeout_ms: Option<u64>,
    /// P52 native-path vetoes: non-empty reason = the engine rejects the
    /// affected native executions with this text as the tool result.
    /// `agent_tool_veto` denies the native `Agent` tool only (swarm mode);
    /// `tools_veto` denies every native tool (btw side-channel contexts).
    pub agent_tool_veto: Option<String>,
    pub tools_veto: Option<String>,
}

/// The two per-entry policies the chain must not decide on its own.
pub struct PipelineHost {
    /// Subagent manager to bind as this pipeline's execution runtime. Which
    /// manager, and when its profile snapshot was registered, is the entry's
    /// choice: the stdio CLI builds one per pipeline, the addon shares a
    /// process-wide one.
    pub subagent_manager: Arc<SubagentManager>,
    pub parent_cancel: Option<ParentCancel>,
    /// Stdio session entry only: lets a newly spawned turn publish its cancel
    /// handle so `session/cancel` can reach the turn it replaced.
    pub parent_cancel_slot: Option<Arc<Mutex<Option<ParentCancel>>>>,
    /// Already-connected MCP manager to attach to the native toolset, so
    /// external tools execute in-process. `None` → the toolset carries no MCP
    /// clients. Which servers to connect and when is the entry's policy: the
    /// addon builds one from `params.mcp_servers` per pipeline, the stdio CLI
    /// has no native MCP path yet.
    pub mcp_manager: Option<Arc<McpManager>>,
}

/// Why a pipeline could not be built. Carries the message each entry renders
/// into its own error type (`JsonRpcError::internal_error` / `napi::Error`).
#[derive(Debug, Clone)]
pub struct PipelineError {
    pub message: String,
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PipelineError {}

/// Build the callback chain and the LLM for one engine context.
pub async fn build_engine_pipeline(
    spec: &PipelineSpec,
    base_callbacks: Arc<dyn HostCallbacks>,
    host: PipelineHost,
) -> Result<EnginePipeline, PipelineError> {
    let PipelineHost {
        subagent_manager,
        parent_cancel,
        parent_cancel_slot,
        mcp_manager,
    } = host;

    let turn_event_count = Arc::new(AtomicU32::new(0));
    let event_bus = Arc::new(EventBus::new());
    // Count every event this turn emits (step lifecycle, deltas, native tools,
    // goal budget limits) for the turn telemetry. Wrapped before the tool
    // wrapper and the native LLM event sink so all paths are counted.
    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(
        CountingCallbacks::new(base_callbacks, turn_event_count.clone())
            .with_bus(event_bus.clone()),
    );

    // Native tool execution: wrap the callbacks so the in-process toolset runs
    // inside the Rust process (sandboxed to the workspace) and everything
    // else — and anything that escapes the sandbox — still round-trips to the
    // host. The wrapper always carries a local truncator (M2 切片 2): result
    // truncation + spill run in-process, no host finalize seam.
    let native_tool_count = Arc::new(AtomicU32::new(0));
    let truncator = spec
        .workspace_root
        .as_deref()
        .map(std::path::Path::new)
        .map(|root| Arc::new(ToolResultTruncator::for_workspace(root)));
    let policy_snapshot = spec.policy_snapshot.clone();
    let permission_engine = policy_snapshot
        .clone()
        .map(|s| Arc::new(crate::permission::PermissionEngine::new(s)));
    let callbacks: Arc<dyn HostCallbacks> =
        match (spec.native_tools, spec.workspace_root.as_deref()) {
            (true, Some(root)) => match NativeToolset::new(root, spec.shell_path.as_deref()) {
                Some(toolset) => {
                    // Plan-mode guard (v2 `AgentPlanService.guardToolExecution`):
                    // guarded native calls read the host's plan state through the
                    // state bridge and are denied when plan mode forbids them.
                    // Unguarded tools skip the round-trip.
                    let plan_callbacks = base_callbacks.clone();
                    let plan_workspace = spec.workspace_root.clone();
                    // Stale-write gate (v2 `staleGuardService`, G-6 #3).
                    let stale_gate = Arc::new(StaleGate::new(
                        spec.workspace_root.clone().map(std::path::PathBuf::from),
                    ));
                    // Goal-operation guard (v2 `goalAgentRuntime`, G-6 #7/#8):
                    // non-auto CreateGoal routes to the host; stale goal mutations
                    // veto.
                    let goal_guard = Arc::new(GoalGuard::new(
                        permission_engine.as_ref().map(|e| e.mode()),
                        true,
                    ));
                    // PreToolUse hooks (v2 `agentExternalHooksService`, G-6 #6):
                    // user-configured commands gate native calls.
                    let hook_guard = policy_snapshot
                        .clone()
                        .map(|s| Arc::new(HookGuard::new(s.pre_tool_hooks)));
                    let mut toolset = toolset
                        .with_subagents(subagent_manager.clone())
                        .with_agent_context(spec.subagent_timeout_ms, parent_cancel)
                        .with_parent_cancel_slot_if(parent_cancel_slot)
                        .with_callbacks(base_callbacks.clone())
                        .with_github_credentials(GitHubCredentials {
                            token: spec.github_token.clone(),
                            base_url: spec.github_base_url.clone(),
                        });
                    if let Some(manager) = mcp_manager {
                        toolset = toolset.with_mcp(manager);
                    }
                    Arc::new(NativeToolCallbacks {
                        inner: base_callbacks.clone(),
                        toolset: Arc::new(toolset),
                        native_count: native_tool_count.clone(),
                        truncator: truncator.clone(),
                        permission_engine,
                        plan_guard: Some(Arc::new(move |tool_name, args| {
                            if !plan_mode::plan_guarded_tool(tool_name) {
                                return Box::pin(async { None });
                            }
                            let callbacks = plan_callbacks.clone();
                            let tool_name = tool_name.to_string();
                            let args = args.clone();
                            let workspace = plan_workspace.clone();
                            Box::pin(async move {
                                let request = crate::rpc::types::StateReadRequest {
                                    domain: "plan".into(),
                                    key: "plan".into(),
                                    turn_id: String::new(),
                                    tool_call_id: String::new(),
                                };
                                match callbacks.state_read(request).await {
                                    Ok(response) => plan_mode::plan_denial(
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
                        agent_tool_veto: spec.agent_tool_veto.clone(),
                        tools_veto: spec.tools_veto.clone(),
                    })
                }
                None => base_callbacks.clone(),
            },
            _ => base_callbacks.clone(),
        };

    // LLM selection — priority order:
    //   1. providers (concurrent MultiLLM race)
    //   2. native_llm (Rust calls the provider directly via HTTP/SSE)
    //   3. host proxy (skipped when `rust_self_contained` is set; the engine
    //      errors out instead, see ROADMAP P26 批 1)
    let llm: Box<dyn LLM> = if !spec.providers.is_empty() {
        let providers: Vec<LlmProvider> = spec
            .providers
            .iter()
            .map(|p| LlmProvider {
                name: p.name.clone(),
                system_prompt: p.system_prompt.clone(),
                model: p.model.clone(),
                callbacks: callbacks.clone(),
            })
            .collect();
        Box::new(MultiLLM::new(providers))
    } else if let Some(cfg) = spec.native_llm.clone() {
        let sink_callbacks = callbacks.clone();
        Box::new(
            NativeHttpLlm::new(cfg, spec.system_prompt.clone())
                .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event))),
        )
    } else {
        if spec.rust_self_contained {
            return Err(PipelineError {
                message: "rustSelfContained=true requires providers or native_llm to be \
                 set; refusing to fall back to host/llm_chat (P26 批 1)"
                    .to_string(),
            });
        }
        Box::new(
            HostLlmProxy::new(spec.system_prompt.clone(), spec.model_name.clone())
                .with_callbacks(callbacks.clone()),
        )
    };

    let llm: Arc<dyn LLM> = Arc::from(llm);
    // Subagent execution runtime (P46): spawned subagent turns run with this
    // pipeline's llm + callback chain.
    subagent_manager
        .set_runtime(llm.clone(), callbacks.clone())
        .await;

    Ok(EnginePipeline {
        llm,
        callbacks,
        turn_event_count,
        native_tool_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{
        BoxFuture, LlmChatMessage, LlmChatRequest, LlmChatResponse, PermissionCheckRequest,
        PermissionDecision, TokenUsage, ToolExecuteRequest, ToolExecuteResponse,
    };
    use std::sync::Mutex as StdMutex;

    /// A third host transport: in-process, scripted, recording every seam call.
    /// Neither `RpcHostCallbacks` (stdio) nor `NapiHostCallbacks` (addon).
    struct InProcessHost {
        calls: Arc<StdMutex<Vec<String>>>,
    }

    impl InProcessHost {
        fn new() -> (Self, Arc<StdMutex<Vec<String>>>) {
            let calls = Arc::new(StdMutex::new(Vec::new()));
            (
                Self {
                    calls: calls.clone(),
                },
                calls,
            )
        }
    }

    impl HostCallbacks for InProcessHost {
        fn llm_chat(
            &self,
            _request: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            let calls = self.calls.clone();
            Box::pin(async move {
                calls.lock().unwrap().push("llm_chat".into());
                Ok(LlmChatResponse {
                    content: "from the in-process host".into(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                })
            })
        }

        fn execute_tool(
            &self,
            request: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            let calls = self.calls.clone();
            let tool = request.tool_name.clone();
            Box::pin(async move {
                calls.lock().unwrap().push(format!("execute_tool:{tool}"));
                Ok(ToolExecuteResponse {
                    content: format!("{tool} ran on the host"),
                    is_error: false,
                    note: None,
                })
            })
        }

        fn check_permission(
            &self,
            _request: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async {
                Ok(PermissionDecision {
                    decision: "allow".into(),
                    reason: None,
                })
            })
        }
    }

    fn spec() -> PipelineSpec {
        PipelineSpec {
            system_prompt: "sys".into(),
            model_name: "test-model".into(),
            providers: Vec::new(),
            native_llm: None,
            workspace_root: None,
            native_tools: false,
            rust_self_contained: false,
            shell_path: None,
            policy_snapshot: None,
            github_token: None,
            github_base_url: None,
            subagent_timeout_ms: None,
            agent_tool_veto: None,
            tools_veto: None,
        }
    }

    fn host(manager: Arc<SubagentManager>) -> PipelineHost {
        PipelineHost {
            subagent_manager: manager,
            parent_cancel: None,
            parent_cancel_slot: None,
            mcp_manager: None,
        }
    }

    fn chat_request() -> LlmChatRequest {
        LlmChatRequest {
            system_prompt: "sys".into(),
            model_name: "test-model".into(),
            messages: vec![LlmChatMessage {
                role: "user".into(),
                content: "hello".into(),
                blocks: Vec::new(),
            }],
            tools: Vec::new(),
            request_id: None,
        }
    }

    #[tokio::test]
    async fn third_host_builds_pipeline_and_receives_the_llm_call() {
        let (inner, calls) = InProcessHost::new();
        let pipeline = build_engine_pipeline(
            &spec(),
            Arc::new(inner),
            host(Arc::new(SubagentManager::new())),
        )
        .await
        .expect("pipeline builds for an in-process host");

        // No providers and no native_llm → the host-proxy leg, so the LLM call
        // must land on this host through the counting + tool wrapper chain.
        assert_eq!(pipeline.llm.transport(), "host-proxy");
        let response = pipeline
            .callbacks
            .llm_chat(chat_request())
            .await
            .expect("llm call");
        assert_eq!(response.content, "from the in-process host");
        assert_eq!(calls.lock().unwrap().as_slice(), ["llm_chat"]);
        assert_eq!(
            pipeline
                .native_tool_count
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "native_tools=false must not route any tool in-process"
        );
    }

    #[tokio::test]
    async fn wrapper_chain_forwards_tool_execution_to_the_host() {
        let (inner, calls) = InProcessHost::new();
        let pipeline = build_engine_pipeline(
            // workspace_root set but native_tools off: the toolset is not built,
            // so every tool still round-trips.
            &PipelineSpec {
                workspace_root: Some(std::env::temp_dir().display().to_string()),
                ..spec()
            },
            Arc::new(inner),
            host(Arc::new(SubagentManager::new())),
        )
        .await
        .expect("pipeline builds");

        let result = pipeline
            .callbacks
            .execute_tool(ToolExecuteRequest {
                turn_id: "t1".into(),
                tool_call_id: "c1".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({}),
            })
            .await
            .expect("host answers");
        assert_eq!(result.content, "Read ran on the host");
        assert_eq!(calls.lock().unwrap().as_slice(), ["execute_tool:Read"]);
    }

    #[tokio::test]
    async fn self_contained_mode_refuses_the_host_proxy_fallback() {
        let (inner, calls) = InProcessHost::new();
        let error = match build_engine_pipeline(
            &PipelineSpec {
                rust_self_contained: true,
                ..spec()
            },
            Arc::new(inner),
            host(Arc::new(SubagentManager::new())),
        )
        .await
        {
            Ok(_) => panic!("self-contained without an LLM must not build"),
            Err(error) => error,
        };

        assert!(
            error.message.contains("rustSelfContained"),
            "unexpected message: {}",
            error.message
        );
        assert!(
            calls.lock().unwrap().is_empty(),
            "refusing the fallback must not reach the host"
        );
    }
}
