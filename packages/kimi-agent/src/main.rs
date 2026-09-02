//! kimi-agent — Rust agent engine with stdio JSON-RPC bridge.
//!
//! Usage:
//!   kimi-agent [--health] [--test]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use clap::Parser;
use tokio::sync::oneshot;

use kimi_agent::{
    callbacks::{CountingCallbacks, HostCallbacks, NativeToolCallbacks, RpcHostCallbacks},
    llm::{
        http::NativeHttpLlm,
        multi::{LlmProvider, MultiLLM},
        proxy::HostLlmProxy,
    },
    rpc::{
        server::RpcServer,
        types::{
            self, CancelTurnParams, HealthStatus, Message, RunTurnParams, RunTurnResult,
            SessionCancelParams, SessionEnqueueParams, SessionHistoryParams, SessionIdParams,
            SessionOutcomeResult, SessionStatusResult, SessionTurnOutcomeParams, TokenUsage,
        },
    },
    session::{
        Admission, EngineSession, GoalProvider, QuiescenceGuard, SessionConfig, ToolDefsProvider,
        TurnOutcome, TurnRequest,
    },
    subagent::ParentCancel,
    turn_loop::{
        run_turn::{run_turn, run_turn_with_telemetry},
        types::*,
    },
};

#[derive(Parser)]
#[command(
    name = "kimi-agent",
    version = "0.1.0",
    about = "Kimi Agent engine (Rust)"
)]
struct Cli {
    /// Start interactive standalone REPL session
    #[arg(long, short)]
    repl: bool,

    /// Override model to use
    #[arg(long, short)]
    model: Option<String>,

    /// Specific config file path to load
    #[arg(long, short)]
    config: Option<std::path::PathBuf>,

    /// Run a health check and exit
    #[arg(long)]
    health: bool,

    /// Run a self-test and exit
    #[arg(long)]
    test: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.health {
        let status = HealthStatus {
            status: "ok".into(),
            version: "0.1.0".into(),
        };
        println!("{}", serde_json::to_string(&status)?);
        return Ok(());
    }

    if cli.test {
        return run_self_test().await;
    }

    if cli.repl {
        let (config, _) = if let Some(ref path) = cli.config {
            let cfg = kimi_agent::config::KimiConfig::from_file(path)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            (cfg, path.clone())
        } else {
            kimi_agent::config::KimiConfig::discover().map_err(|e| anyhow::anyhow!("{e}"))?
        };
        let cwd = std::env::current_dir()?;
        return kimi_agent::repl::start_repl(config, cwd, cli.model).await;
    }

    // Build the RPC server and register handlers
    let server = Arc::new(RpcServer::new());

    // Shared map of turn_id → cancellation signal, so CANCEL_TURN can
    // signal a running turn to abort before its next step — and, since
    // P51, wake the foreground subagent's event-driven wait immediately.
    let cancel_map: Arc<Mutex<HashMap<String, ParentCancel>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Register run_turn handler
    let s = server.clone();
    let cm = cancel_map.clone();
    RpcServer::register_arc(&s.clone(), types::methods::RUN_TURN, move |params| {
        let server = s.clone();
        let cancel_map = cm.clone();
        Box::pin(async move {
            let input: types::RunTurnParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

            let turn_id = input.turn_id.clone();
            // None = unbounded, mirroring the JS loop (which only stops
            // on a configured `maxStepsPerTurn`).
            let max_steps = input.max_steps.unwrap_or(u32::MAX);

            // Create and register a cancellation signal for this turn.
            let cancel = ParentCancel::new();
            {
                let mut map = cancel_map.lock().unwrap();
                map.insert(turn_id.clone(), cancel.clone());
            }

            // The engine pipeline is shared with the session handle: the
            // callback chain (counting + native tools over the RPC host
            // bridge) and the LLM selection are built once per context.
            let pipeline =
                build_engine_pipeline(&input, server.clone(), Some(cancel.clone()), None).await?;
            let llm = pipeline.llm;
            let callbacks = pipeline.callbacks;
            let turn_event_count = pipeline.turn_event_count;
            let native_tool_count = pipeline.native_tool_count;

            let messages: Vec<LLMMessage> = input
                .messages
                .into_iter()
                .map(wire_message_to_llm)
                .collect();

            let tool_defs: Vec<ToolInfo> = input
                .tools
                .into_iter()
                .map(|t| ToolInfo {
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                })
                .collect();

            let tools: Vec<&dyn ExecutableTool> = vec![];

            let run_input = RunTurnInput {
                turn_id: turn_id.clone(),
                llm: llm.as_ref(),
                messages,
                tools: &tools,
                tool_defs,
                max_steps,
                goal: input.goal,
                cancellation: Some(cancel.flag()),
            };

            let result = match input.telemetry {
                Some(context) => run_turn_with_telemetry(run_input, context, &callbacks).await,
                None => run_turn(run_input, &callbacks).await,
            };

            // Clean up the cancellation flag.
            {
                let mut map = cancel_map.lock().unwrap();
                map.remove(&turn_id);
            }

            match result {
                Ok(res) => {
                    let output = RunTurnResult {
                        stop_reason: format!("{:?}", res.stop_reason),
                        steps: res.steps,
                        usage: res.usage,
                        events_emitted: turn_event_count.load(Ordering::Relaxed),
                        llm_retries: res.llm_retries,
                        llm_transport: llm.transport().to_string(),
                        native_tool_calls: native_tool_count.load(Ordering::Relaxed),
                    };
                    serde_json::to_value(&output).map_err(|e| {
                        types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                    })
                }
                Err(e) => {
                    let output = RunTurnResult {
                        stop_reason: format!("Error: {e}"),
                        steps: 0,
                        usage: TokenUsage::default(),
                        events_emitted: 0,
                        llm_retries: 0,
                        llm_transport: llm.transport().to_string(),
                        native_tool_calls: native_tool_count.load(Ordering::Relaxed),
                    };
                    serde_json::to_value(&output).map_err(|_| {
                        types::JsonRpcError::internal_error(format!("Turn failed: {e}"))
                    })
                }
            }
        })
    });

    // ── EngineSession handle over stdio (M1d 3b) ─────────────────────────
    // The stdio transport gets the same session surface as the napi addon:
    // create once (the engine pipeline is built once), enqueue turns, await
    // outcomes. The registry + outcome receivers mirror napi_bindings.rs.

    // Register session/create handler
    {
        let s = server.clone();
        RpcServer::register_arc(&server, types::methods::SESSION_CREATE, move |params| {
            let server = s.clone();
            Box::pin(async move {
                let input: RunTurnParams = serde_json::from_value(params).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Invalid params: {e}"))
                })?;
                // P55: session-wide cancel slot — the pump refreshes it per
                // turn, `cancel_turn` triggers it, and the native `Agent`
                // tool reads the live signal from it.
                let agent_cancel_slot: Arc<Mutex<Option<ParentCancel>>> =
                    Arc::new(Mutex::new(None));
                let pipeline = build_engine_pipeline(
                    &input,
                    server.clone(),
                    None,
                    Some(agent_cancel_slot.clone()),
                )
                .await?;

                // Turn-start tool table: pulled fresh from the host per turn
                // on native transports (host-proxy rebuilds tools inside
                // llm_chat and never consults the engine's table).
                let is_host_proxy = pipeline.llm.transport() == "host-proxy";
                let tool_callbacks = pipeline.callbacks.clone();
                let tool_defs_provider: ToolDefsProvider = if is_host_proxy {
                    Arc::new(|| Box::pin(async { Vec::new() }))
                } else {
                    Arc::new(move || {
                        let callbacks = tool_callbacks.clone();
                        Box::pin(async move {
                            callbacks
                                .list_tools()
                                .await
                                .map(|r| r.tools)
                                .unwrap_or_default()
                        })
                    })
                };

                // Fresh goal snapshot per turn (budget checks + steering),
                // read through the host/goal seam; unwired hosts degrade to
                // no goal budgeting.
                let goal_callbacks = pipeline.callbacks.clone();
                let goal_provider: Option<GoalProvider> = Some(Arc::new(move || {
                    let callbacks = goal_callbacks.clone();
                    Box::pin(async move { callbacks.goal().await.ok().flatten() })
                }));

                let session = EngineSession::new(SessionConfig {
                    llm: pipeline.llm.clone(),
                    callbacks: pipeline.callbacks.clone(),
                    max_steps: input.max_steps.unwrap_or(u32::MAX),
                    tool_defs: tool_defs_provider,
                    goal: goal_provider,
                    on_before_turn: None,
                    agent_cancel_slot: Some(agent_cancel_slot),
                })
                .await;

                let session_id =
                    format!("session-{}", SESSION_NEXT_ID.fetch_add(1, Ordering::SeqCst));
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
                serde_json::to_value(&session_id).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                })
            })
        });
    }

    // Register session/enqueue_turn handler
    RpcServer::register_arc(&server, types::methods::SESSION_ENQUEUE_TURN, |params| {
        Box::pin(async move {
            let input: SessionEnqueueParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            let admission = parse_admission(&input.admission)?;
            let receipt = entry
                .session
                .enqueue_turn(TurnRequest::user(
                    wire_message_to_llm(input.prompt),
                    admission,
                ))
                .map_err(types::JsonRpcError::internal_error)?;
            let (turn_id, outcome) = receipt.into_parts();
            SESSION_OUTCOMES
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert((input.session_id, turn_id), outcome);
            serde_json::to_value(turn_id).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/turn_outcome handler
    RpcServer::register_arc(&server, types::methods::SESSION_TURN_OUTCOME, |params| {
        Box::pin(async move {
            let input: SessionTurnOutcomeParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let receiver = {
                let mut outcomes = SESSION_OUTCOMES.lock().unwrap_or_else(|e| e.into_inner());
                outcomes
                    .remove(&(input.session_id.clone(), input.turn_id))
                    .ok_or_else(|| {
                        types::JsonRpcError::internal_error(format!(
                            "no outcome pending for {} turn {}",
                            input.session_id, input.turn_id
                        ))
                    })?
            };
            let entry = session_entry(&input.session_id)?;
            let outcome = receiver
                .await
                .map_err(|_| types::JsonRpcError::internal_error("session dropped".to_string()))?
                .map_err(types::JsonRpcError::internal_error)?;
            let result = match outcome {
                TurnOutcome::Ran(res) => SessionOutcomeResult {
                    status: "ran".into(),
                    result: Some(RunTurnResult {
                        stop_reason: format!("{:?}", res.stop_reason),
                        steps: res.steps,
                        usage: res.usage,
                        events_emitted: entry.turn_event_count.load(Ordering::Relaxed),
                        llm_retries: res.llm_retries,
                        llm_transport: entry.llm_transport.clone(),
                        native_tool_calls: entry.native_tool_count.load(Ordering::Relaxed),
                    }),
                },
                TurnOutcome::CancelledBeforeStart => SessionOutcomeResult {
                    status: "cancelledBeforeStart".into(),
                    result: None,
                },
            };
            serde_json::to_value(&result).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/cancel_turn handler
    RpcServer::register_arc(&server, types::methods::SESSION_CANCEL_TURN, |params| {
        Box::pin(async move {
            let input: SessionCancelParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            serde_json::to_value(entry.session.cancel_turn(input.turn_id)).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/status handler
    RpcServer::register_arc(&server, types::methods::SESSION_STATUS, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            let status = entry.session.status();
            let result = SessionStatusResult {
                active_turn_id: status.active_turn_id,
                pending_turn_ids: status.pending_turn_ids,
                engine: status.engine,
            };
            serde_json::to_value(&result).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/is_settled handler
    RpcServer::register_arc(&server, types::methods::SESSION_IS_SETTLED, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            serde_json::to_value(entry.session.is_settled()).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/settled handler
    RpcServer::register_arc(&server, types::methods::SESSION_SETTLED, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            entry.session.settled().await;
            Ok(serde_json::Value::Null)
        })
    });

    // Register session/try_acquire_quiescence handler
    RpcServer::register_arc(
        &server,
        types::methods::SESSION_TRY_ACQUIRE_QUIESCENCE,
        |params| {
            Box::pin(async move {
                let input: SessionIdParams = serde_json::from_value(params).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Invalid params: {e}"))
                })?;
                let entry = session_entry(&input.session_id)?;
                let acquired = match entry.session.try_acquire_quiescence() {
                    Some(guard) => {
                        *entry
                            .quiescence_guard
                            .lock()
                            .unwrap_or_else(|e| e.into_inner()) = Some(guard);
                        true
                    }
                    None => false,
                };
                serde_json::to_value(acquired).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                })
            })
        },
    );

    // Register session/release_quiescence handler
    RpcServer::register_arc(
        &server,
        types::methods::SESSION_RELEASE_QUIESCENCE,
        |params| {
            Box::pin(async move {
                let input: SessionIdParams = serde_json::from_value(params).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Invalid params: {e}"))
                })?;
                let entry = session_entry(&input.session_id)?;
                *entry
                    .quiescence_guard
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                Ok(serde_json::Value::Null)
            })
        },
    );

    // Register session/set_history handler
    RpcServer::register_arc(&server, types::methods::SESSION_SET_HISTORY, |params| {
        Box::pin(async move {
            let input: SessionHistoryParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            let history: Vec<LLMMessage> =
                input.history.into_iter().map(wire_message_to_llm).collect();
            entry.session.set_history(history);
            Ok(serde_json::Value::Null)
        })
    });

    // Register session/clear_history handler
    RpcServer::register_arc(&server, types::methods::SESSION_CLEAR_HISTORY, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            entry.session.clear_history();
            Ok(serde_json::Value::Null)
        })
    });

    // Register session/extend_history handler
    RpcServer::register_arc(&server, types::methods::SESSION_EXTEND_HISTORY, |params| {
        Box::pin(async move {
            let input: SessionHistoryParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            let history: Vec<LLMMessage> =
                input.history.into_iter().map(wire_message_to_llm).collect();
            entry.session.extend_history(history);
            Ok(serde_json::Value::Null)
        })
    });

    // Register session/history_len handler
    RpcServer::register_arc(&server, types::methods::SESSION_HISTORY_LEN, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            serde_json::to_value(entry.session.history_len()).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/dispose handler
    RpcServer::register_arc(&server, types::methods::SESSION_DISPOSE, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            SESSION_REGISTRY
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&input.session_id);
            Ok(serde_json::Value::Null)
        })
    });

    // Register cancel_turn handler
    let cm = cancel_map.clone();
    RpcServer::register_arc(&server, types::methods::CANCEL_TURN, move |params| {
        let cancel_map = cm.clone();
        Box::pin(async move {
            let input: CancelTurnParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

            let cancelled = {
                let map = cancel_map.lock().unwrap();
                if let Some(cancel) = map.get(&input.turn_id) {
                    cancel.trigger();
                    true
                } else {
                    false
                }
            };

            let result = serde_json::json!({ "cancelled": cancelled });
            Ok(result)
        })
    });

    // Register health handler
    RpcServer::register_arc(&server, types::methods::HEALTH, |_| {
        Box::pin(async move {
            let status = HealthStatus {
                status: "ok".into(),
                version: "0.1.0".into(),
            };
            serde_json::to_value(&status).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register shutdown handler
    RpcServer::register_arc(&server, types::methods::SHUTDOWN, |_| {
        Box::pin(async move {
            std::process::exit(0);
        })
    });

    eprintln!("kimi-agent ready, listening on stdin/stdout");

    // Initialize tracing when the host opts in. Default (env unset) is a
    // no-op so the existing JSON-RPC stdout is never polluted. The host
    // sets `KIMI_AGENT_TRACE=1` (or any non-empty value) to enable
    // structured tracing to stderr; `KIMI_AGENT_TRACE_FORMAT=json` opts
    // into JSON for chrome://tracing / speedscope.app visualisation.
    if std::env::var("KIMI_AGENT_TRACE").is_ok_and(|v| !v.is_empty()) {
        let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("kimi_agent=info"));
        if std::env::var("KIMI_AGENT_TRACE_FORMAT").as_deref() == Ok("json") {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .json()
                .with_writer(std::io::stderr)
                .init();
        } else {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .with_writer(std::io::stderr)
                .init();
        }
    }

    // Handlers hold Arc clones of the server (self-referential by design: the
    // RUN_TURN handler captures a server clone to spawn tool/LLM callbacks), so
    // the strong count is never 1 here. Keep the Arc and run on it directly.
    server.run().await
}

// ── Engine pipeline (shared by RUN_TURN and the session handle) ────────────

/// The engine pipeline built once per context: the host callback chain
/// (counting + native-tool execution over the RPC host bridge) plus the LLM
/// selection (multi / native-http / host-proxy). Mirrors
/// `build_engine_pipeline` in napi_bindings.rs — keep the two in lockstep.
struct EnginePipeline {
    llm: Arc<dyn LLM>,
    callbacks: Arc<dyn HostCallbacks>,
    /// Event counter from the counting wrapper (turn result telemetry).
    turn_event_count: Arc<AtomicU32>,
    /// Native tool call counter from the native-tool wrapper.
    native_tool_count: Arc<AtomicU32>,
}

/// Build the callback chain and the LLM for one engine context. The chain is
/// identical for every entry path: RpcHostCallbacks → counting wrapper →
/// native-tool wrapper (in-process Read/Grep/Glob/Write/Edit/Bash,
/// permission engine, truncation, plan-mode guard). The LLM picks multi >
/// native-http > host-proxy, with self-contained mode refusing the
/// host-proxy fallback.
async fn build_engine_pipeline(
    params: &RunTurnParams,
    server: Arc<RpcServer>,
    parent_cancel: Option<ParentCancel>,
    parent_cancel_slot: Option<Arc<Mutex<Option<ParentCancel>>>>,
) -> Result<EnginePipeline, types::JsonRpcError> {
    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(RpcHostCallbacks { server });

    // Subagent manager for the native `Agent` tool (P46): one per pipeline
    // (the legacy stdio entry rebuilds the pipeline per turn; the session
    // entry builds once). The host's profile catalog snapshot registers
    // here — empty snapshot means every `Agent` call falls back to the
    // host tool.
    let subagent_manager = Arc::new(kimi_agent::subagent::SubagentManager::new());
    subagent_manager
        .register_profile_snapshot(&params.subagent_profiles)
        .await;

    // Count every event this turn emits (step lifecycle, deltas, native
    // tools, goal budget limits) for the turn telemetry. Wrapped before the
    // tool wrapper and the native LLM event sink so all paths are counted.
    let turn_event_count = Arc::new(AtomicU32::new(0));
    let event_bus = Arc::new(kimi_agent::events::EventBus::new());
    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(
        CountingCallbacks::new(base_callbacks, turn_event_count.clone())
            .with_bus(event_bus.clone()),
    );

    // Native tool execution: wrap the callbacks so the in-process toolset
    // runs inside the Rust process (sandboxed to the workspace) and
    // everything else — and anything that escapes the sandbox — still
    // round-trips to the host. The wrapper always carries a local truncator
    // (M2 切片 2): result truncation + spill run in-process, no host
    // finalize seam.
    let native_tool_count = Arc::new(AtomicU32::new(0));
    let truncator = params
        .workspace_root
        .as_deref()
        .map(std::path::Path::new)
        .map(|root| {
            Arc::new(kimi_agent::tool_result_truncation::ToolResultTruncator::for_workspace(root))
        });
    let policy_snapshot = params.policy_snapshot.clone();
    let permission_engine = policy_snapshot
        .clone()
        .map(|s| Arc::new(kimi_agent::permission::PermissionEngine::new(s)));
    let callbacks: Arc<dyn HostCallbacks> =
        match (params.native_tools, params.workspace_root.as_deref()) {
            (true, Some(root)) => {
                match kimi_agent::tools::NativeToolset::new(root, params.shell_path.as_deref()) {
                    Some(toolset) => {
                        // Plan-mode guard (v2
                        // `AgentPlanService.guardToolExecution`): guarded
                        // native calls read the host's plan state through the
                        // state bridge and are denied when plan mode forbids
                        // them. Unguarded tools skip the round-trip.
                        let plan_callbacks = base_callbacks.clone();
                        let plan_workspace = params.workspace_root.clone();
                        // Stale-write gate (v2 `staleGuardService`, G-6 #3):
                        // one CLI process = one session, so the table created
                        // here lives for the session like v2's per-agent-scope
                        // guard state.
                        let stale_gate = Arc::new(kimi_agent::tools::stale_guard::StaleGate::new(
                            params.workspace_root.clone().map(std::path::PathBuf::from),
                        ));
                        // Goal-operation guard (v2 `goalAgentRuntime`,
                        // G-6 #7/#8): non-auto CreateGoal routes to the host;
                        // stale goal mutations veto.
                        let goal_guard = Arc::new(kimi_agent::tools::goal_guard::GoalGuard::new(
                            permission_engine.as_ref().map(|e| e.mode()),
                            true,
                        ));
                        // PreToolUse hooks (v2 `agentExternalHooksService`,
                        // G-6 #6): user-configured commands gate native calls.
                        let hook_guard = policy_snapshot.clone().map(|s| {
                            Arc::new(kimi_agent::tools::external_hooks::HookGuard::new(
                                s.pre_tool_hooks,
                            ))
                        });
                        Arc::new(NativeToolCallbacks {
                            inner: base_callbacks.clone(),
                            toolset: Arc::new(
                                toolset
                                    .with_subagents(subagent_manager.clone())
                                    .with_agent_context(params.subagent_timeout_ms, parent_cancel)
                                    .with_parent_cancel_slot_if(parent_cancel_slot)
                                    .with_callbacks(base_callbacks.clone())
                                    .with_github_credentials(
                                        kimi_agent::tools::github::GitHubCredentials {
                                            token: params.github_token.clone(),
                                            base_url: params.github_base_url.clone(),
                                        },
                                    ),
                            ),
                            native_count: native_tool_count.clone(),
                            truncator: truncator.clone(),
                            permission_engine,
                            plan_guard: Some(Arc::new(move |tool_name, args| {
                                if !kimi_agent::tools::plan_mode::plan_guarded_tool(tool_name) {
                                    return Box::pin(async { None });
                                }
                                let callbacks = plan_callbacks.clone();
                                let tool_name = tool_name.to_string();
                                let args = args.clone();
                                let workspace = plan_workspace.clone();
                                Box::pin(async move {
                                    let request = kimi_agent::rpc::types::StateReadRequest {
                                        domain: "plan".into(),
                                        key: "plan".into(),
                                        turn_id: String::new(),
                                        tool_call_id: String::new(),
                                    };
                                    match callbacks.state_read(request).await {
                                        Ok(response) => kimi_agent::tools::plan_mode::plan_denial(
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

    // LLM selection — priority order (must match napi_bindings.rs):
    //   1. providers (concurrent MultiLLM race)
    //   2. native_llm (Rust calls the provider directly via HTTP/SSE)
    //   3. host proxy (skipped when `rust_self_contained` is set; the
    //      engine errors out instead, see kimi-agent ROADMAP P26 批 1)
    let llm: Box<dyn LLM> = if !params.providers.is_empty() {
        let providers: Vec<LlmProvider> = params
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
    } else if let Some(cfg) = params.native_llm.clone() {
        let sink_callbacks = callbacks.clone();
        Box::new(
            NativeHttpLlm::new(cfg, params.system_prompt.clone())
                .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event))),
        )
    } else {
        if params.rust_self_contained {
            return Err(types::JsonRpcError::internal_error(
                "rustSelfContained=true requires providers or native_llm to be \
                 set; refusing to fall back to host/llm_chat (P26 批 1)"
                    .to_string(),
            ));
        }
        Box::new(
            HostLlmProxy::new(params.system_prompt.clone(), params.model_name.clone())
                .with_callbacks(callbacks.clone()),
        )
    };

    let llm: Arc<dyn LLM> = Arc::from(llm);
    // Subagent execution runtime (P46): spawned subagent turns run with
    // this pipeline's llm + callback chain, mirroring the napi seam.
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

/// Convert a wire `Message` into the engine's `LLMMessage` (the tool-call
/// structural mapping).
fn wire_message_to_llm(m: Message) -> LLMMessage {
    LLMMessage {
        role: m.role,
        content: m.content,
        blocks: m.blocks,
        tool_calls: m
            .tool_calls
            .into_iter()
            .map(|tc| ToolCall {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            })
            .collect(),
        tool_call_id: m.tool_call_id,
    }
}

fn parse_admission(value: &str) -> Result<Admission, types::JsonRpcError> {
    match value {
        "newTurn" => Ok(Admission::NewTurn),
        "activeOrNewTurn" => Ok(Admission::ActiveOrNewTurn),
        "activeOrNextTurn" => Ok(Admission::ActiveOrNextTurn),
        "activeTurnOnly" => Ok(Admission::ActiveTurnOnly),
        other => Err(types::JsonRpcError::internal_error(format!(
            "unknown admission mode: {other}"
        ))),
    }
}

// ── EngineSession registry (M1d 3b, mirrors napi_bindings.rs) ──────────────

/// Live sessions keyed by id. One CLI process runs one session today; the
/// registry keeps the surface uniform for tests and future multi-session
/// hosts. A disposed session's pump task parks forever on its wakeup channel
/// (bounded: one session per process) — teardown joins it in M2.
#[derive(Clone)]
struct SessionEntry {
    session: Arc<EngineSession>,
    turn_event_count: Arc<AtomicU32>,
    native_tool_count: Arc<AtomicU32>,
    llm_transport: String,
    /// The live quiescence guard (M1c RAII). Acquire stores it; release
    /// drops it — the drop replays held turns and wakes the pump.
    quiescence_guard: Arc<Mutex<Option<QuiescenceGuard>>>,
}

static SESSION_REGISTRY: LazyLock<Mutex<HashMap<String, SessionEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Outcome receivers for enqueued turns, keyed by (session, turn). Enqueue
/// stores the receiver; `session/turn_outcome` takes it and resolves the
/// caller once the pump finishes the turn.
type SessionOutcomeMap = HashMap<(String, u64), oneshot::Receiver<Result<TurnOutcome, String>>>;
static SESSION_OUTCOMES: LazyLock<Mutex<SessionOutcomeMap>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static SESSION_NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn session_entry(session_id: &str) -> Result<SessionEntry, types::JsonRpcError> {
    SESSION_REGISTRY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .cloned()
        .ok_or_else(|| {
            types::JsonRpcError::internal_error(format!("unknown session: {session_id}"))
        })
}

/// Self-test: runs the turn loop with a mock LLM.
async fn run_self_test() -> anyhow::Result<()> {
    eprintln!("Running self-test...");

    // Create a mock LLM that returns a simple response
    let mock_llm = MockLlm {
        system_prompt: "You are a helpful assistant.".into(),
        model_name: "test-model".into(),
    };

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: "Hello!".into(),
        ..Default::default()
    }];

    let input = RunTurnInput {
        turn_id: "test-turn-1".into(),
        llm: &mock_llm,
        messages,
        tools: &[],
        tool_defs: vec![],
        max_steps: 5,
        goal: None,
        cancellation: None,
    };

    // Create a minimal server for the test
    let server = Arc::new(RpcServer::new());
    let callbacks: Arc<dyn HostCallbacks> = Arc::new(RpcHostCallbacks { server });

    let result = run_turn(input, &callbacks).await;

    match result {
        Ok(res) => {
            eprintln!("  Turn completed: {:?}", res.stop_reason);
            eprintln!("  Steps: {}", res.steps);
            eprintln!(
                "  Usage: {} in / {} out / {} total",
                res.usage.input_tokens, res.usage.output_tokens, res.usage.total_tokens
            );
            eprintln!("Self-test PASSED");
            Ok(())
        }
        Err(e) => {
            eprintln!("  Turn failed: {e}");
            eprintln!("Self-test FAILED");
            Err(anyhow::anyhow!("{e}"))
        }
    }
}

/// A mock LLM that returns a fixed response without tool calls.
struct MockLlm {
    system_prompt: String,
    model_name: String,
}

impl LLM for MockLlm {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_retryable_error(&self, _error: &str) -> bool {
        false
    }

    fn chat(
        &self,
        _params: LLMChatParams,
    ) -> kimi_agent::rpc::types::BoxFuture<
        '_,
        Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>,
    > {
        Box::pin(async move {
            Ok(LLMChatResponse {
                content: String::new(),
                tool_calls: vec![],
                finish_reason: Some("stop".into()),
                usage: TokenUsage {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                    ..Default::default()
                },
            })
        })
    }
}
