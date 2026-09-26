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
    NativeToolset, external_hooks::HookGuard, github::GitHubCredentials, goal_guard::GoalGuard,
    plan_mode, stale_guard::StaleGate,
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
    /// Turn-lifecycle hook dispatch (`UserPromptSubmit` / `PreCompact` /
    /// `Stop`); `None` when the policy snapshot configures no hooks. Turn
    /// drivers clone it per turn; subagent turns pass `None` by design.
    pub hook_guard: Option<Arc<HookGuard>>,
    /// The `[secondary_model]` pool's default model, for engine-side
    /// background work that must not spend the session model's budget (the
    /// memory filing pass). `None` when no pool is configured.
    pub secondary_llm: Option<Arc<dyn LLM>>,
    /// The permission mode the policy snapshot resolved to, for the turn
    /// drivers to pass as `RunTurnInput.permission_mode`. `None` when the
    /// spec carries no policy snapshot.
    pub permission_mode: Option<crate::permission::PermissionMode>,
    /// The live permission engine the native-tool wrapper evaluates each call
    /// with. Kept so an entry point can switch the mode mid-turn through
    /// [`crate::permission::PermissionEngine::set_mode`] instead of rebuilding
    /// the whole pipeline. `None` when no policy snapshot configured one.
    pub permission_engine: Option<Arc<crate::permission::PermissionEngine>>,
    /// The roots and policy the skill catalog is scanned with, owned so a host
    /// can read the *engine's* catalog (v2 serves it from the engine) instead
    /// of re-scanning the filesystem itself — the builtins, the dotted
    /// sub-skill commands and `extra_skill_dirs` only exist on this side.
    pub skill_scan: crate::skills::SkillScanRoots,
    /// The MCP manager this pipeline connected from the spec's
    /// `mcp_manager`. Handed back so an embedder can read the roster — the
    /// manager is built once per pipeline, and without the handle a host had
    /// no way to see servers the engine had already connected.
    pub mcp_manager: Option<Arc<McpManager>>,
    /// Resolves the media references a turn carries (v2
    /// `AgentMediaResolverService`).
    pub media: crate::llm::media_resolver::MediaResolver,
    /// The pipeline's cross-turn record of omitted media (v2
    /// `media.budgetDropped`).
    pub media_dropped: crate::llm::media_budget::DroppedMedia,
    /// The pipeline's own background-task runner (native tools over a
    /// workspace state store). `None` when native tools are off or the store
    /// could not open — hosts install the #3717 liveness predicate on it.
    pub task_runner: Option<Arc<crate::storage::TaskRunner>>,
    /// The native toolset, when native tools are on. The turn loop reads the
    /// progressive-tool-disclosure announcement from it (v2
    /// `toolSelectAnnouncementsService`); the toolset keeps the announced
    /// set, so the diff spans turns within a session.
    pub toolset: Option<Arc<crate::tools::NativeToolset>>,
}

/// One concurrent provider for the MultiLLM race. The chain needs only these
/// three fields; each entry maps them from its own wire type.
pub struct PipelineProvider {
    pub name: String,
    pub system_prompt: String,
    pub model: String,
    /// The racer's native HTTP transport. `None` races a host proxy instead,
    /// which requires a host that serves `host/llm_chat`.
    pub native: Option<NativeLlmConfig>,
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
    /// Host-authorized directories outside `workspace_root` that native tools
    /// may still touch — the `/add-dir` list (`additionalDirs` on the host
    /// side). Without them a path outside the workspace root cannot be served
    /// natively, and the host has no tool runtime to fall back to.
    pub extra_roots: Vec<String>,
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
    pub todo_tool_veto: Option<String>,
    pub tower_worktree_root: Option<String>,
    /// Whether tower mode is enabled (`KIMI_CODE_EXPERIMENTAL_TOWER` /
    /// `[experimental].tower`). Gates the advertised Tower* tool table; the
    /// worker write-scope guard above is a separate, per-worker concern.
    pub tower_enabled: bool,
    /// Whether progressive tool disclosure is on (`[experimental].
    /// tool_select`, v2 `TOOL_SELECT_FLAG_ID`). Together with the model's
    /// `dynamically_loaded_tools` capability it gates the `select_tools`
    /// advertisement and the per-server `deferred` MCP disclosure.
    pub tool_select: bool,
    pub sandbox_mode: Option<String>,
    pub sandbox_policy: Option<crate::tools::sandbox::SandboxExecutionPolicy>,
    pub caller_agent_id: Option<String>,
    pub session_id: Option<String>,
    /// The host-resolved `[secondary_model]` subagent model pool, when the
    /// section is configured and the experimental flag enables it. `None`
    /// keeps the v2 default: subagents inherit the caller's model.
    pub secondary_model: Option<crate::rpc::types::SecondaryModelPool>,
    /// `[image].read_byte_budget` (v2 `resolveReadImageByteBudget`): raw-byte
    /// budget for model-initiated image reads. `None` keeps the 256KB default.
    pub image_read_byte_budget: Option<u64>,
    /// `[image].max_edge_px` for model-initiated image reads. `None` keeps
    /// the 2000px default.
    pub image_max_edge_px: Option<u32>,
    /// The session model's declared capabilities (`[models.<alias>]
    /// .capabilities`); `None` = unknown, and image reads are allowed.
    pub model_capabilities: Option<Vec<String>>,
    /// Extra skill scan roots (`extra_skill_dirs`) for the system prompt's
    /// skills section.
    pub skill_dirs: Vec<std::path::PathBuf>,
    /// `merge_all_available_skills` resolved by the entry: whether each skill
    /// scope group scans every available directory or only its first existing
    /// one. The prompt is rendered with this switch, so the `Skill` tool must
    /// read the same value or the two disagree about what exists.
    pub merge_all_available_skills: bool,
    /// `[background]` knobs for this context's own task runner and Bash tool:
    /// cooperative-stop grace, concurrent-task cap, auto-background on
    /// timeout, and the background Bash timeout. Every field is optional —
    /// `None` keeps the engine default — so an unconfigured file behaves
    /// exactly as before.
    pub background: crate::storage::BackgroundLimits,
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
    /// Session entry only: the slot a steering message fires to end a blocking
    /// `WaitFor` early, so the toolset's wait can observe the interrupt.
    pub steer_slot: Option<Arc<Mutex<Option<ParentCancel>>>>,
    /// Already-connected MCP manager to attach to the native toolset, so
    /// external tools execute in-process. `None` → the toolset carries no MCP
    /// clients. Which servers to connect and when is the entry's policy: the
    /// addon builds one from `params.mcp_servers` per pipeline, the stdio CLI
    /// has no native MCP path yet.
    pub mcp_manager: Option<Arc<McpManager>>,
    /// Bus the counting wrapper publishes onto. `None` gives this pipeline a
    /// private bus that nobody observes — right for the two product entries, wrong
    /// for an embedder that must see engine events (the standalone server has to
    /// fan them out to WebSocket clients, so it passes its hub's bus).
    pub event_bus: Option<Arc<EventBus>>,
    /// Where this pipeline's own background-task runner reports task lifecycle
    /// (`event.task.*` / `background.task.*`). The runner is per-pipeline
    /// (`TaskRunner::for_workspace` below), so without a sink its events go
    /// nowhere — the addon passes one that forwards to the host callbacks so
    /// the TUI badge/transcript see task starts and settles. The standalone
    /// server keeps its own server-scoped runner and passes `None`.
    pub task_event_sink: Option<crate::storage::TaskEventSink>,
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

/// `[subagent]` / `[background]` print defaults (docs `config-files.md`): in
/// print mode (`kimi -p`) an *unset* wall-clock timeout means "no timeout" —
/// background work is not killed by the clock there (the settle phase waits
/// for it instead); only the model stops it. An explicit value always wins,
/// including `0`, which every timeout consumer treats as "never arm".
#[must_use]
pub fn print_timeout_default(timeout: Option<u64>, print_mode: bool) -> Option<u64> {
    timeout.or_else(|| print_mode.then_some(0))
}

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
        steer_slot,
        mcp_manager,
        event_bus,
        task_event_sink,
    } = host;

    let turn_event_count = Arc::new(AtomicU32::new(0));
    // An embedder that must observe engine events (the standalone server, which
    // fans them out to WebSocket clients) passes its own bus; otherwise this
    // pipeline gets a private one nobody listens on, as before.
    let event_bus = event_bus.unwrap_or_else(|| Arc::new(EventBus::new()));
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
    let permission_engine = policy_snapshot.clone().map(|s| {
        // The engine's `GitCwdWriteApprove` gate needs the session workspace
        // (v2 `ISessionWorkspaceContext`): the root its containment resolves
        // against and the `/add-dir` roots that widen the boundary. Both are
        // already host-resolved here — the snapshot carries only the cwd, so
        // reading them off the spec keeps `additionalDirs` out of the wire.
        Arc::new(crate::permission::PermissionEngine::with_workspace(
            s,
            spec.workspace_root.clone(),
            spec.extra_roots.clone(),
        ))
    });
    // Turn-lifecycle hooks (v2 `agentExternalHooksService`, G-6 #6):
    // user-configured commands observe the turn (`UserPromptSubmit` /
    // `PreCompact`) and can veto a clean text stop (`Stop`). Built once
    // per pipeline; turn drivers clone it per turn, subagent turns skip it.
    let hook_guard = policy_snapshot
        .clone()
        .map(|s| Arc::new(HookGuard::new(s.pre_tool_hooks)));
    // The pool's default model, hoisted out of the native-tool arm so the
    // engine can reach it without downcasting the callback chain.
    let mut secondary_llm: Option<Arc<dyn LLM>> = None;
    // Hoisted so hosts can install the liveness predicate (#3717) after the
    // build: the runner is per-pipeline here (workspace state store), and the
    // host knows the session this pipeline serves.
    let mut pipeline_task_runner: Option<Arc<crate::storage::TaskRunner>> = None;
    // Hoisted alongside it: the disclosure announcement diff state lives on
    // the toolset and must span turns, so the pipeline carries the handle.
    let mut pipeline_toolset: Option<Arc<crate::tools::NativeToolset>> = None;
    let callbacks: Arc<dyn HostCallbacks> =
        match (spec.native_tools, spec.workspace_root.as_deref()) {
            (true, Some(root)) => match NativeToolset::new(root, spec.shell_path.as_deref())
                // The `Skill` tool resolves from the engine's scan, so it needs
                // the same roots *and* the same scope-group policy the prompt
                // was rendered with.
                .map(|toolset| {
                    toolset
                        .with_skill_scan(spec.skill_dirs.clone(), spec.merge_all_available_skills)
                }) {
                Some(toolset) => {
                    let (base_callbacks, task_runner): (
                        Arc<dyn HostCallbacks>,
                        Option<Arc<crate::storage::TaskRunner>>,
                    ) = match crate::storage::StateStore::for_workspace(std::path::Path::new(root))
                    {
                        Ok(store) => {
                            let runner = crate::storage::TaskRunner::for_workspace(
                                std::path::Path::new(root),
                            )
                            .ok()
                            .map(Arc::new);
                            // The runner is per-pipeline, so its lifecycle
                            // events only exist if the entry wired a sink.
                            if let (Some(runner), Some(sink)) =
                                (runner.as_ref(), task_event_sink.as_ref())
                            {
                                runner.set_event_sink(sink.clone());
                            }
                            (
                                Arc::new(crate::callbacks::StateStoreCallbacks {
                                    inner: base_callbacks.clone(),
                                    store: Arc::new(store),
                                }),
                                runner,
                            )
                        }
                        Err(_) => (base_callbacks.clone(), None),
                    };
                    // Plan-mode guard (v2 `AgentPlanService.guardToolExecution`):
                    // guarded native calls read the host's plan state through the
                    // state bridge and are denied when plan mode forbids them.
                    // Unguarded tools skip the round-trip.
                    let plan_callbacks = base_callbacks.clone();
                    let plan_workspace = spec.workspace_root.clone();
                    // Stale-write gate (fork-original, G-6 #3).
                    let shell_bridge = toolset.shell_bridge();
                    let plan_bridge = shell_bridge.clone();
                    let stale_gate = Arc::new(StaleGate::new(
                        spec.workspace_root.clone().map(std::path::PathBuf::from),
                        shell_bridge.clone(),
                    ));
                    // Goal-operation guard (G-6 #7/#8):
                    // non-auto CreateGoal routes to the host; stale goal mutations
                    // veto.
                    let goal_guard = Arc::new(GoalGuard::new(
                        permission_engine.as_ref().map(|e| e.mode()),
                        true,
                    ));
                    // PreToolUse hooks (v2 `agentExternalHooksService`, G-6 #6):
                    // user-configured commands gate native calls.
                    let mut toolset = toolset
                        .with_extra_roots(spec.extra_roots.clone())
                        .with_subagents(subagent_manager.clone())
                        .with_agent_context(spec.subagent_timeout_ms, parent_cancel)
                        .with_parent_cancel_slot_if(parent_cancel_slot)
                        .with_steer_slot_if(steer_slot)
                        .with_image_limits(spec.image_read_byte_budget, spec.image_max_edge_px)
                        .with_model_capabilities(effective_model_capabilities(spec))
                        // Progressive tool disclosure reads both halves of the
                        // gate at table-shaping time: the flag here, the
                        // model's `dynamically_loaded_tools` capability on the
                        // toolset's own capability set.
                        .with_tool_select_enabled(spec.tool_select)
                        .with_bash_auto_background(spec.background.bash_auto_background_on_timeout)
                        .with_bash_task_timeout(spec.background.bash_task_timeout_s)
                        .with_callbacks(base_callbacks.clone())
                        .with_tools_filter(
                            spec.policy_snapshot
                                .as_ref()
                                .and_then(|snapshot| snapshot.tools_filter.clone()),
                        )
                        .with_github_credentials(GitHubCredentials {
                            token: spec.github_token.clone(),
                            base_url: spec.github_base_url.clone(),
                        });
                    if let Some(ref caller) = spec.caller_agent_id {
                        toolset = toolset.with_caller_agent_id(caller);
                    }
                    if let Some(ref session) = spec.session_id {
                        toolset = toolset.with_session_id(session);
                    }
                    // `[secondary_model]`: one ready-built LLM per pool alias.
                    // Built here (before the session LLM) because the pool only
                    // needs the alias configs; `primary` binds the session LLM
                    // at resolve time.
                    let secondary_model = spec.secondary_model.as_ref().map(|pool| {
                        let llms = pool
                            .models
                            .iter()
                            .map(|entry| {
                                let llm: Arc<dyn crate::turn_loop::types::LLM> =
                                    Arc::from(build_native_llm(
                                        &entry.llm,
                                        &spec.system_prompt,
                                        &base_callbacks,
                                    ));
                                (entry.alias.clone(), llm)
                            })
                            .collect();
                        Arc::new(crate::subagent::secondary::SecondaryModelRuntime::new(
                            pool.clone(),
                            llms,
                        ))
                    });
                    secondary_llm = secondary_model.as_ref().and_then(|pool| pool.default_llm());
                    toolset = toolset.with_secondary_model(secondary_model);
                    if let Some(ref manager) = mcp_manager {
                        toolset = toolset.with_mcp(manager.clone());
                    }
                    if let Some(ref runner) = task_runner {
                        // `[background]` knobs: the pipeline builds its own
                        // runner per context, so the limits are applied here
                        // rather than at construction.
                        runner.apply_background_limits(
                            spec.background.kill_grace_period_ms,
                            spec.background.max_running_tasks,
                        );
                        toolset = toolset.with_task_runner(runner.clone());
                        // The async setter: `set_task_runner_sync` can lose the
                        // runner to a concurrent reader, and a lost runner is
                        // permanent for the process.
                        subagent_manager.set_task_runner(runner.clone()).await;
                        pipeline_task_runner = Some(runner.clone());
                    }
                    // Hoist the toolset for the pipeline's disclosure
                    // announcement provider — the announced-set state must
                    // span turns, which only a pipeline-held handle gives.
                    let toolset = Arc::new(toolset);
                    pipeline_toolset = Some(toolset.clone());
                    let toolset = toolset;
                    let sandbox_policy = if let Some(ref policy) = spec.sandbox_policy {
                        Some(policy.clone())
                    } else if let Some(ref mode_str) = spec.sandbox_mode {
                        let mode = crate::tools::sandbox::SandboxMode::parse(mode_str);
                        let root = spec.workspace_root.clone().unwrap_or_default();
                        // Host-authorized `additionalDirs` are part of the
                        // boundary: without them the guard rejects writes into
                        // a directory the host explicitly handed over.
                        Some(
                            crate::tools::sandbox::SandboxExecutionPolicy::new(mode, root)
                                .with_extra_roots(spec.extra_roots.clone()),
                        )
                    } else {
                        None
                    };
                    Arc::new(NativeToolCallbacks {
                        inner: base_callbacks.clone(),
                        toolset,
                        native_count: native_tool_count.clone(),
                        truncator: truncator.clone(),
                        permission_engine: permission_engine.clone(),
                        plan_guard: Some(Arc::new(move |tool_name, args| {
                            if !plan_mode::plan_guarded_tool(tool_name) {
                                return Box::pin(async { None });
                            }
                            let callbacks = plan_callbacks.clone();
                            let tool_name = tool_name.to_string();
                            let args = args.clone();
                            let workspace = plan_workspace.clone();
                            let plan_bridge = plan_bridge.clone();
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
                                        &plan_bridge,
                                    ),
                                    Err(_) => None,
                                }
                            })
                        })),
                        stale_guard: Some(stale_gate),
                        goal_guard: Some(goal_guard),
                        hook_guard: hook_guard.clone(),
                        agent_tool_veto: spec.agent_tool_veto.clone(),
                        tools_veto: spec.tools_veto.clone(),
                        todo_tool_veto: spec.todo_tool_veto.clone(),
                        tower_worktree_root: spec.tower_worktree_root.clone(),
                        tower_enabled: spec.tower_enabled,
                        sandbox_policy,
                    })
                }
                None => base_callbacks.clone(),
            },
            _ => base_callbacks.clone(),
        };

    let llm = build_llm_for_spec(spec, &callbacks)?;
    // Subagent execution runtime (P46): spawned subagent turns run with this
    // pipeline's llm + callback chain.
    subagent_manager
        .set_runtime(llm.clone(), callbacks.clone(), spec.session_id.clone())
        .await;

    // Server-side hook usage telemetry rides the host's own `host/telemetry`
    // seam: the guard emits through it when the host serves that callback, so
    // the napi / stdio hosts receive `external_hook_resolved` on the channel
    // they already read (v2 #3897). A sink set directly on the guard would have
    // nowhere to go on every current entry point.
    if let Some(guard) = &hook_guard {
        let callbacks_for_hooks = callbacks.clone();
        guard.with_telemetry(Arc::new(move |event, payload| {
            let value = match payload {
                serde_json::Value::Null => serde_json::json!({ "event": event }),
                serde_json::Value::Object(mut fields) => {
                    fields.insert("event".into(), serde_json::json!(event));
                    serde_json::Value::Object(fields)
                }
                other => other,
            };
            callbacks_for_hooks.telemetry(value);
        }));
        // Host-facing `hook.result`: the hook's stdout and whether it blocked,
        // so the transcript can show what the hook said. Without this sink the
        // hook ran and its output was discarded.
        let callbacks_for_hook_results = callbacks.clone();
        guard.with_hook_result(Arc::new(move |event, content, blocked| {
            callbacks_for_hook_results.emit_event(serde_json::json!({
                "type": "hook.result",
                "hookEvent": event,
                "content": content,
                "blocked": blocked,
            }));
        }));
    }

    Ok(EnginePipeline {
        llm,
        callbacks,
        turn_event_count,
        native_tool_count,
        hook_guard,
        secondary_llm,
        permission_mode: spec.policy_snapshot.as_ref().map(|snapshot| snapshot.mode),
        permission_engine,
        skill_scan: crate::skills::SkillScanRoots {
            root: spec.workspace_root.as_deref().map(std::path::PathBuf::from),
            extra_dirs: spec.skill_dirs.clone(),
            merge_all_available_skills: spec.merge_all_available_skills,
        },
        mcp_manager,
        media: crate::llm::media_resolver::MediaResolver::new(),
        media_dropped: Default::default(),
        task_runner: pipeline_task_runner,
        toolset: pipeline_toolset,
    })
}

/// The model capabilities the image-read gate runs with: the host's explicit
/// set wins, and the transport config's declared set is the fallback — the
/// addon carries them on the transport config rather than in the run params.
fn effective_model_capabilities(spec: &PipelineSpec) -> Option<Vec<String>> {
    spec.model_capabilities.clone().or_else(|| {
        spec.native_llm
            .as_ref()
            .and_then(|cfg| cfg.capabilities.clone())
    })
}

/// Build the LLM one [`PipelineSpec`] selects, in priority order:
///   1. providers (concurrent MultiLLM race)
///   2. native_llm (Rust calls the provider directly via HTTP/SSE)
///   3. host proxy (skipped when `rust_self_contained` is set; the engine
///      errors out instead, see ROADMAP P26 批 1)
///
/// Split out of [`build_engine_pipeline`] so engine-side work that needs the
/// session's model without a whole pipeline — the REST `:compact` summarizer —
/// resolves it through this same chain instead of a second copy that could
/// drift on the event sink or the OAuth token plumbing.
pub fn build_llm_for_spec(
    spec: &PipelineSpec,
    callbacks: &Arc<dyn HostCallbacks>,
) -> Result<Arc<dyn LLM>, PipelineError> {
    let llm: Box<dyn LLM> = if !spec.providers.is_empty() {
        let providers: Vec<LlmProvider> = spec
            .providers
            .iter()
            .map(|p| match p.native.clone() {
                // A racer the engine can call directly. Without this the race
                // would run entirely on `host/llm_chat`, which every
                // config-reading entry point answers with an error — so the
                // race could never produce a winner.
                Some(config) => LlmProvider::native(
                    p.name.clone(),
                    p.system_prompt.clone(),
                    config,
                    callbacks.clone(),
                ),
                None => LlmProvider::host(
                    p.name.clone(),
                    p.model.clone(),
                    p.system_prompt.clone(),
                    callbacks.clone(),
                ),
            })
            .collect();
        Box::new(MultiLLM::new(providers))
    } else if let Some(cfg) = spec.native_llm.clone() {
        build_native_llm(&cfg, &spec.system_prompt, callbacks)
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
    Ok(Arc::from(llm))
}

/// Build a native HTTP LLM for one `NativeLlmConfig`: the single place the
/// session model and every `[secondary_model]` pool alias go through, so the
/// event sink and OAuth token plumbing cannot drift between them.
fn build_native_llm(
    cfg: &NativeLlmConfig,
    system_prompt: &str,
    callbacks: &Arc<dyn HostCallbacks>,
) -> Box<dyn crate::turn_loop::types::LLM> {
    let sink_callbacks = callbacks.clone();
    let mut llm = NativeHttpLlm::new(cfg.clone(), system_prompt.to_string())
        .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event)));
    if cfg.auth_provider.is_some() {
        let auth_callbacks = callbacks.clone();
        let provider_name = cfg.auth_provider.clone().unwrap_or_default();
        llm = llm.with_auth_provider(Arc::new(move |force| {
            let cb = auth_callbacks.clone();
            let provider = provider_name.clone();
            Box::pin(async move { cb.auth_token(provider, force).await })
        }));
    }
    Box::new(llm)
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
                    thinking: vec![],
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
                    delivery: None,
                    stop_turn: false,
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

    /// The print timeout default: an explicit value (including `0` = "never
    /// arm") always wins; the print-mode unset resolves to "no timeout" while
    /// interactive mode keeps each knob's own engine default.
    #[test]
    fn print_timeout_default_applies_only_in_print_mode() {
        assert_eq!(print_timeout_default(Some(3_600), true), Some(3_600));
        assert_eq!(print_timeout_default(Some(0), true), Some(0));
        assert_eq!(
            print_timeout_default(Some(7_200_000), false),
            Some(7_200_000)
        );
        assert_eq!(print_timeout_default(None, true), Some(0));
        assert_eq!(print_timeout_default(None, false), None);
    }

    /// The image-read gate reads the model's declared capabilities: the host's
    /// explicit set wins, and the transport config's set is the fallback.
    #[test]
    fn model_capabilities_fall_back_to_the_transport_config() {
        let mut from_transport = spec();
        from_transport.native_llm = Some(NativeLlmConfig {
            capabilities: Some(vec!["image_in".into()]),
            ..Default::default()
        });
        assert_eq!(
            effective_model_capabilities(&from_transport),
            Some(vec!["image_in".to_string()])
        );

        let mut explicit = from_transport;
        explicit.model_capabilities = Some(vec!["thinking".into()]);
        assert_eq!(
            effective_model_capabilities(&explicit),
            Some(vec!["thinking".to_string()])
        );

        assert_eq!(effective_model_capabilities(&spec()), None);
    }

    fn spec() -> PipelineSpec {
        PipelineSpec {
            system_prompt: "sys".into(),
            model_name: "test-model".into(),
            providers: Vec::new(),
            native_llm: None,
            workspace_root: None,
            native_tools: false,
            extra_roots: Vec::new(),
            rust_self_contained: false,
            shell_path: None,
            policy_snapshot: None,
            github_token: None,
            github_base_url: None,
            subagent_timeout_ms: None,
            agent_tool_veto: None,
            tools_veto: None,
            todo_tool_veto: None,
            tower_worktree_root: None,
            tower_enabled: false,
            tool_select: false,
            sandbox_mode: None,
            sandbox_policy: None,
            caller_agent_id: None,
            session_id: None,
            secondary_model: None,
            image_read_byte_budget: None,
            image_max_edge_px: None,
            model_capabilities: None,
            skill_dirs: Vec::new(),
            merge_all_available_skills: true,
            background: crate::storage::BackgroundLimits::default(),
        }
    }

    fn host(manager: Arc<SubagentManager>) -> PipelineHost {
        PipelineHost {
            subagent_manager: manager,
            parent_cancel: None,
            parent_cancel_slot: None,
            steer_slot: None,
            mcp_manager: None,
            event_bus: None,
            task_event_sink: None,
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
    async fn pipeline_carries_the_policy_snapshot_mode() {
        let (inner, _calls) = InProcessHost::new();
        let pipeline = build_engine_pipeline(
            &PipelineSpec {
                policy_snapshot: Some(PolicySnapshot {
                    mode: crate::permission::PermissionMode::Auto,
                    ..Default::default()
                }),
                ..spec()
            },
            Arc::new(inner),
            host(Arc::new(SubagentManager::new())),
        )
        .await
        .expect("pipeline builds");
        assert_eq!(
            pipeline.permission_mode,
            Some(crate::permission::PermissionMode::Auto),
            "the turn drivers read the mode the permission engine enforces"
        );

        let (inner, _calls) = InProcessHost::new();
        let bare = build_engine_pipeline(
            &spec(),
            Arc::new(inner),
            host(Arc::new(SubagentManager::new())),
        )
        .await
        .expect("pipeline builds");
        assert_eq!(bare.permission_mode, None);
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
