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
    callbacks::{HostCallbacks, RpcHostCallbacks},
    pipeline::{self, EnginePipeline, PipelineHost, PipelineProvider, PipelineSpec},
    rpc::types::NativeLlmConfig,
    rpc::{
        server::RpcServer,
        types::{
            self, CancelTurnParams, HealthStatus, Message, RunTurnParams, RunTurnResult,
            SessionBackgroundTaskOutputParams, SessionBackgroundTaskStopParams,
            SessionBtwCancelParams, SessionBtwPromptParams, SessionCancelParams,
            SessionEnqueueParams, SessionGenerateTitleParams, SessionHistoryParams,
            SessionIdParams, SessionOutcomeResult, SessionStatusResult, SessionTurnOutcomeParams,
            TokenUsage,
        },
    },
    session::{
        Admission, EngineSession, GoalProvider, QuiescenceGuard, SessionConfig, ToolDefsProvider,
        TurnOutcome, TurnRequest,
    },
    subagent::{ParentCancel, SubagentManager},
    turn_loop::{
        run_turn::{run_turn_continued, run_turn_with_telemetry},
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

    /// Serve the native REST + WebSocket API on ADDRESS (e.g.
    /// 127.0.0.1:8080) instead of speaking stdio JSON-RPC
    #[arg(long, value_name = "ADDRESS")]
    serve: Option<String>,

    /// Where `--serve` keeps its session database (default: ./.kimi-agent)
    #[arg(long, value_name = "PATH", default_value = ".kimi-agent")]
    data_dir: String,

    /// Skip the bearer credential for `--serve` (loopback binds only)
    #[arg(long)]
    no_auth: bool,

    /// Directory containing built Web UI static assets to serve (default: auto-detected)
    #[arg(long, value_name = "PATH")]
    web_assets: Option<std::path::PathBuf>,

    /// Run as an Agent Client Protocol (ACP) server over stdio
    #[arg(long)]
    acp: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.acp {
        let db_path = std::path::Path::new(&cli.data_dir).join("sessions.db");
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let store = Arc::new(kimi_agent::session::sqlite_store::SqliteSessionStore::open(
            db_path,
        )?);

        let (config, _) = if let Some(ref path) = cli.config {
            let cfg = kimi_agent::config::KimiConfig::from_file(path)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            (cfg, path.clone())
        } else {
            kimi_agent::config::KimiConfig::discover().map_err(|e| anyhow::anyhow!("{e}"))?
        };

        let acp_server = if let Some(native) = config.extract_native_llm(cli.model.as_deref()) {
            let workspace = std::env::current_dir()?;
            let system_prompt = kimi_agent::prompt::SystemPromptBuilder::build_default(&workspace);
            let spec = PipelineSpec {
                system_prompt,
                model_name: native.model.clone(),
                providers: Vec::new(),
                native_llm: Some(NativeLlmConfig {
                    protocol: native.protocol,
                    base_url: native.base_url,
                    api_key: native.api_key,
                    model: native.model,
                    max_tokens: native.max_tokens,
                    custom_headers: Default::default(),
                    reasoning_effort: None,
                    thinking_budget: None,
                    auth_provider: None,
                    thinking_keep: None,
                }),
                workspace_root: Some(workspace.display().to_string()),
                native_tools: true,
                rust_self_contained: true,
                shell_path: None,
                policy_snapshot: None,
                session_id: None,
                secondary_model: None,
                sandbox_mode: None,
                sandbox_policy: None,
                todo_tool_veto: None,
                tower_worktree_root: None,
                caller_agent_id: None,
                github_token: None,
                github_base_url: None,
                subagent_timeout_ms: None,
                agent_tool_veto: None,
                tools_veto: None,
            };
            let hub = Arc::new(kimi_agent::server::hub::EventHub::new());
            let engine = Arc::new(kimi_agent::server::engine::ServerEngine::new(
                spec,
                hub,
                store.clone(),
            ));
            kimi_agent::acp::AcpServer::with_engine(store, engine)
        } else {
            // No native LLM resolved: the canned-prompt dev/test path. The auth
            // gate would otherwise refuse every session (no engine = not
            // authed), so it is disabled here (v2 `disableAuth`).
            let mut server = kimi_agent::acp::AcpServer::new(store);
            server.set_disable_auth(true);
            server
        };

        return acp_server
            .run_stdio()
            .await
            .map_err(|e| anyhow::anyhow!("{e}"));
    }

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

    if cli.serve.is_some() {
        return run_serve(&cli).await;
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
            let max_context_tokens = input.max_context_tokens;

            // Create and register a cancellation signal for this turn.
            let cancel = ParentCancel::new();
            {
                let mut map = cancel_map.lock().unwrap();
                map.insert(turn_id.clone(), cancel.clone());
            }

            // The engine pipeline is shared with the session handle: the
            // callback chain (counting + native tools over the RPC host
            // bridge) and the LLM selection are built once per context.
            // One-shot turns have no session, so the manager is dropped.
            let (pipeline, _) =
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
                max_attempts: input.max_attempts,
                turn_id: turn_id.clone(),
                llm: llm.as_ref(),
                messages,
                tools: &tools,
                tool_defs,
                max_steps,
                max_context_tokens,
                goal: input.goal,
                cancellation: Some(cancel.flag()),
                hook_guard: pipeline.hook_guard.clone(),
            };

            let result = match input.telemetry {
                Some(context) => run_turn_with_telemetry(run_input, context, &callbacks).await,
                None => run_turn_continued(run_input, &callbacks).await,
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
                let (pipeline, subagent_manager) = build_engine_pipeline(
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
                    max_attempts: input.max_attempts,
                    max_context_tokens: input.max_context_tokens,
                    tool_defs: tool_defs_provider,
                    goal: goal_provider,
                    on_before_turn: None,
                    agent_cancel_slot: Some(agent_cancel_slot),
                    hook_guard: pipeline.hook_guard.clone(),
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
                            subagent_manager,
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

    // Register session/get_history handler
    RpcServer::register_arc(&server, types::methods::SESSION_GET_HISTORY, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            let history: Vec<Message> = entry
                .session
                .snapshot_history()
                .into_iter()
                .map(llm_message_to_wire)
                .collect();
            serde_json::to_value(history).map_err(|e| {
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

    // ── Wave 1 harness parity: btw / title / background tasks over stdio ──
    // Same semantics as the napi addon (napi_bindings.rs) and the standalone
    // server, so the TS StdioSessionTransport can stop throwing
    // "not supported" for them.

    // Register session/start_btw handler
    RpcServer::register_arc(&server, types::methods::SESSION_START_BTW, |params| {
        Box::pin(async move {
            let input: SessionIdParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            let history = entry.session.snapshot_history();
            let agent_id = kimi_agent::subagent::start_btw(&entry.subagent_manager, &history)
                .await
                .map_err(types::JsonRpcError::internal_error)?;
            serde_json::to_value(&agent_id).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/btw_prompt handler
    RpcServer::register_arc(&server, types::methods::SESSION_BTW_PROMPT, |params| {
        Box::pin(async move {
            let input: SessionBtwPromptParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            // The session must be live, but the side channel owns its
            // conversation: the turn runs on the session manager's subagent
            // runtime, outside the session's turn queue.
            let entry = session_entry(&input.session_id)?;
            let manager = entry.subagent_manager.clone();
            let agent_id = input.agent_id.clone();
            let cancel = ParentCancel::new();
            BTW_CANCEL_MAP
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(agent_id.clone(), cancel.clone());
            let outcome = manager
                .resume_foreground_turn(&agent_id, &input.prompt, Some(&cancel))
                .await;
            BTW_CANCEL_MAP
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&agent_id);
            let (content, stop_reason) = match outcome {
                Some(Ok(kimi_agent::subagent::manager::ForegroundTurnOutcome::Completed(
                    result,
                ))) => {
                    let content = result
                        .messages
                        .iter()
                        .rev()
                        .find(|m| m.role == "assistant")
                        .map(|m| m.content.clone())
                        .unwrap_or_default();
                    (content, format!("{:?}", result.stop_reason))
                }
                Some(Ok(kimi_agent::subagent::manager::ForegroundTurnOutcome::ParentCancelled)) => {
                    (String::new(), "Aborted".to_string())
                }
                Some(Err(message)) => {
                    return Err(types::JsonRpcError::internal_error(message));
                }
                None => {
                    return Err(types::JsonRpcError::internal_error(format!(
                        "unknown btw side-channel instance: {agent_id}"
                    )));
                }
            };
            Ok(serde_json::json!({ "content": content, "stopReason": stop_reason }))
        })
    });

    // Register session/btw_cancel handler
    RpcServer::register_arc(&server, types::methods::SESSION_BTW_CANCEL, |params| {
        Box::pin(async move {
            let input: SessionBtwCancelParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let cancelled = BTW_CANCEL_MAP
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&input.agent_id)
                .cloned()
                .is_some_and(|cancel| {
                    cancel.trigger();
                    true
                });
            serde_json::to_value(cancelled).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/generate_title handler
    RpcServer::register_arc(&server, types::methods::SESSION_GENERATE_TITLE, |params| {
        Box::pin(async move {
            let input: SessionGenerateTitleParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
            let entry = session_entry(&input.session_id)?;
            let history = entry.session.snapshot_history();
            let title = kimi_agent::session::sqlite_store::derive_session_title(
                &history,
                input.source.as_deref(),
            )
            .map_err(types::JsonRpcError::internal_error)?;
            serde_json::to_value(title).map_err(|e| {
                types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
            })
        })
    });

    // Register session/background_task_list handler
    RpcServer::register_arc(
        &server,
        types::methods::SESSION_BACKGROUND_TASK_LIST,
        |params| {
            Box::pin(async move {
                let input: SessionIdParams = serde_json::from_value(params).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Invalid params: {e}"))
                })?;
                let entry = session_entry(&input.session_id)?;
                let tasks = entry
                    .subagent_manager
                    .get_task_runner_sync()
                    .map(|runner| runner.list())
                    .unwrap_or_default();
                let raw = serde_json::to_string(&tasks).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                })?;
                serde_json::to_value(raw).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                })
            })
        },
    );

    // Register session/background_task_output handler
    RpcServer::register_arc(
        &server,
        types::methods::SESSION_BACKGROUND_TASK_OUTPUT,
        |params| {
            Box::pin(async move {
                let input: SessionBackgroundTaskOutputParams = serde_json::from_value(params)
                    .map_err(|e| {
                        types::JsonRpcError::internal_error(format!("Invalid params: {e}"))
                    })?;
                let entry = session_entry(&input.session_id)?;
                let output = entry
                    .subagent_manager
                    .get_task_runner_sync()
                    .and_then(|runner| runner.get_output(&input.task_id));
                serde_json::to_value(output).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                })
            })
        },
    );

    // Register session/background_task_stop handler
    RpcServer::register_arc(
        &server,
        types::methods::SESSION_BACKGROUND_TASK_STOP,
        |params| {
            Box::pin(async move {
                let input: SessionBackgroundTaskStopParams = serde_json::from_value(params)
                    .map_err(|e| {
                        types::JsonRpcError::internal_error(format!("Invalid params: {e}"))
                    })?;
                let entry = session_entry(&input.session_id)?;
                let runner = entry.subagent_manager.get_task_runner_sync().ok_or_else(|| {
                    types::JsonRpcError::internal_error(
                        "no background task runner is active for this session".to_string(),
                    )
                })?;
                let wire = runner
                    .stop(&input.task_id, input.reason.as_deref())
                    .await
                    .map_err(types::JsonRpcError::internal_error)?;
                Ok(wire)
            })
        },
    );

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

/// The stdio entry's view of the shared engine pipeline
/// (`kimi_agent::pipeline`). Everything the chain itself does — counting
/// wrapper, native-tool wrapper and its guards, LLM selection — lives there
/// now; this only maps the typed wire params into a `PipelineSpec` and applies
/// the stdio host policy: a per-pipeline subagent manager snapshotted from
/// `params.subagent_profiles`, plus the cancel slot that lets a replacement
/// turn be reached by `session/cancel`.
async fn build_engine_pipeline(
    params: &RunTurnParams,
    server: Arc<RpcServer>,
    parent_cancel: Option<ParentCancel>,
    parent_cancel_slot: Option<Arc<Mutex<Option<ParentCancel>>>>,
) -> Result<(EnginePipeline, Arc<SubagentManager>), types::JsonRpcError> {
    let spec = PipelineSpec {
        system_prompt: params.system_prompt.clone(),
        model_name: params.model_name.clone(),
        providers: params
            .providers
            .iter()
            .map(|p| PipelineProvider {
                name: p.name.clone(),
                system_prompt: p.system_prompt.clone(),
                model: p.model.clone(),
            })
            .collect(),
        native_llm: params.native_llm.clone(),
        workspace_root: params.workspace_root.clone(),
        native_tools: params.native_tools,
        rust_self_contained: params.rust_self_contained,
        shell_path: params.shell_path.clone(),
        policy_snapshot: params.policy_snapshot.clone(),
        github_token: params.github_token.clone(),
        github_base_url: params.github_base_url.clone(),
        subagent_timeout_ms: params.subagent_timeout_ms,
        agent_tool_veto: params.agent_tool_veto.clone(),
        tools_veto: params.tools_veto.clone(),
        todo_tool_veto: params.todo_tool_veto.clone(),
        tower_worktree_root: params.tower_worktree_root.clone(),
        sandbox_mode: params.sandbox_mode.clone(),
        sandbox_policy: None,
        caller_agent_id: params.caller_agent_id.clone(),
        session_id: params.session_id.clone(),
        secondary_model: params.secondary_model.clone(),
    };

    // Subagent manager for the native `Agent` tool (P46): one per pipeline (the
    // legacy stdio entry rebuilds the pipeline per turn; the session entry
    // builds once). An empty snapshot means every `Agent` call falls back to
    // the host tool.
    let subagent_manager = Arc::new(SubagentManager::new());
    subagent_manager
        .register_profile_snapshot(&params.subagent_profiles)
        .await;
    // Host-resolved swarm timeout (v2 `resolveSwarmTimeoutMs`): the manager
    // carries it so the native `AgentSwarm` tool reads it at execution time.
    subagent_manager.set_swarm_timeout_ms(params.swarm_timeout_ms);
    // Host-resolved `[services.moonshot_*]` backends (v2 `configSection.ts`).
    // Always installed — including `None` — so a backend resolved for one
    // session never leaks into a later pipeline that resolves none.
    kimi_agent::tools::web_search::set_service_config(params.web_search.as_ref().map(|cfg| {
        kimi_agent::tools::web_search::WebSearchServiceConfig {
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            custom_headers: cfg.custom_headers.clone(),
        }
    }));
    kimi_agent::tools::fetch_url::set_service_config(params.web_fetch.as_ref().map(|cfg| {
        kimi_agent::tools::fetch_url::WebFetchServiceConfig {
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            custom_headers: cfg.custom_headers.clone(),
        }
    }));

    pipeline::build_engine_pipeline(
        &spec,
        Arc::new(RpcHostCallbacks { server }),
        PipelineHost {
            subagent_manager: subagent_manager.clone(),
            parent_cancel,
            parent_cancel_slot,
            mcp_manager: None,
            event_bus: None,
        },
    )
    .await
    .map(|pipeline| (pipeline, subagent_manager))
    .map_err(|error| types::JsonRpcError::internal_error(error.message))
}

/// The composition root for the standalone server: config -> `PipelineSpec` ->
/// `ServerEngine` -> `HttpServer` -> TCP listener.
///
/// Until now every part of that chain existed but nothing assembled it, so the
/// native REST surface was unreachable from a real process.
async fn run_serve(cli: &Cli) -> anyhow::Result<()> {
    let address = cli.serve.clone().expect("checked by the caller");

    // The credential is kap-server's own: a bearer token in
    // `<kimi home>/server.token`, generated on first run so one client
    // credential works against either server. `--no-auth` opts out, and only on
    // loopback — `http::serve` is what actually refuses a non-loopback bind
    // with no credential, so this early check just fails with a usable message.
    let host = address
        .rsplit_once(':')
        .map_or(address.as_str(), |(host, _)| host);
    let loopback =
        matches!(host, "127.0.0.1" | "localhost" | "::1") || host.strip_prefix("127.").is_some();
    let (auth, token_path) = if cli.no_auth {
        if !loopback {
            anyhow::bail!("--no-auth only allows a loopback address, refusing to serve {address}");
        }
        (kimi_agent::server::auth::ServerAuth::disabled(), None)
    } else {
        let path = kimi_agent::server::auth::ServerAuth::default_token_path().ok_or_else(|| {
            anyhow::anyhow!(
                "cannot resolve the kimi home for server.token: set KIMI_CODE_HOME, or pass --no-auth to serve loopback without a credential"
            )
        })?;
        let auth = kimi_agent::server::auth::ServerAuth::load_or_create(&path)
            .map_err(|error| anyhow::anyhow!("cannot read or create {path:?}: {error}"))?;
        (auth, Some(path))
    };

    let (config, source) = match cli.config.as_ref() {
        Some(path) => {
            let cfg = kimi_agent::config::KimiConfig::from_file(path)
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            (cfg, path.clone())
        }
        None => kimi_agent::config::KimiConfig::discover()
            .map_err(|error| anyhow::anyhow!("{error}"))?,
    };

    let native = config.extract_native_llm(cli.model.as_deref()).ok_or_else(|| {
        anyhow::anyhow!(
            "no native LLM resolved from {source:?}: give the model a provider with base_url + api_key, or point --model at one"
        )
    })?;

    let workspace = std::env::current_dir()?;
    let system_prompt = kimi_agent::prompt::SystemPromptBuilder::build_default(&workspace);
    let spec = PipelineSpec {
        system_prompt,
        model_name: native.model.clone(),
        providers: Vec::new(),
        native_llm: Some(NativeLlmConfig {
            protocol: native.protocol,
            base_url: native.base_url,
            api_key: native.api_key,
            model: native.model,
            max_tokens: native.max_tokens,
            custom_headers: Default::default(),
            reasoning_effort: None,
            thinking_budget: None,
            auth_provider: None,
            thinking_keep: None,
        }),
        workspace_root: Some(workspace.display().to_string()),
        native_tools: true,
        // The standalone server has no JS host to fall back to; refusing the
        // host-proxy leg here means a misconfiguration fails at startup rather
        // than mid-turn.
        rust_self_contained: true,
        shell_path: None,
        policy_snapshot: Some(config.build_policy_snapshot(Some(workspace.clone()))),
        github_token: config.github.token.clone(),
        github_base_url: config.github.base_url.clone(),
        subagent_timeout_ms: None,
        agent_tool_veto: None,
        tools_veto: None,
        todo_tool_veto: None,
        tower_worktree_root: None,
        sandbox_mode: None,
        sandbox_policy: None,
        caller_agent_id: None,
        session_id: None,
        secondary_model: None,
    };

    std::fs::create_dir_all(&cli.data_dir)?;
    let db_path = std::path::Path::new(&cli.data_dir).join("sessions.db");
    let store = Arc::new(
        kimi_agent::session::sqlite_store::SqliteSessionStore::open(&db_path)
            .map_err(|error| anyhow::anyhow!("cannot open {db_path:?}: {error}"))?,
    );

    // One hub for both sides: a turn publishes onto its session's lane and
    // connecting WebSocket clients attach through the same registry, so a turn's
    // events genuinely reach them with the numbering that lane assigns.
    let hub = Arc::new(kimi_agent::server::hub::EventHub::new());
    let engine = kimi_agent::server::engine::ServerEngine::new(spec, hub.clone(), store.clone());
    let mut server = kimi_agent::server::HttpServer::with_hub(store, hub)
        .with_engine(engine)
        .with_auth(auth);

    let web_assets_dir = cli.web_assets.clone().or_else(|| {
        let candidates = [
            std::path::PathBuf::from("dist-web"),
            std::path::PathBuf::from("apps/kimi-code/dist-web"),
            std::path::PathBuf::from("../../apps/kimi-code/dist-web"),
        ];
        candidates
            .into_iter()
            .find(|p| p.join("index.html").is_file())
    });

    let has_web = if let Some(dir) = web_assets_dir {
        server = server.with_web_assets(dir);
        true
    } else {
        false
    };

    let handle = kimi_agent::server::http::serve(&address, Arc::new(server)).await?;
    let credential = match &token_path {
        Some(path) => format!("bearer token {path:?}"),
        None => "no credential (--no-auth)".into(),
    };
    let web_notice = if has_web { " and Web UI" } else { "" };
    println!(
        "kimi-agent serving /api/v1{web_notice} on http://{} (config {source:?}, db {db_path:?}, {credential})",
        handle.local_addr
    );

    // Park forever. Ctrl-C terminates the process; there is no graceful drain
    // of in-flight turns yet, and no signal handler is installed on purpose
    // rather than pretending to have one.
    std::future::pending::<()>().await;
    Ok(())
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
                extras: tc.extras,
            })
            .collect(),
        tool_call_id: m.tool_call_id,
    }
}

fn llm_message_to_wire(m: LLMMessage) -> Message {
    Message {
        role: m.role,
        content: m.content,
        blocks: m.blocks,
        tool_calls: m
            .tool_calls
            .into_iter()
            .map(|tc| types::LlmToolCall {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                extras: tc.extras,
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
    /// The pipeline's subagent manager (runtime registered): btw
    /// side-channel turns and background-task queries run against it.
    subagent_manager: Arc<SubagentManager>,
    /// The live quiescence guard (M1c RAII). Acquire stores it; release
    /// drops it — the drop replays held turns and wakes the pump.
    quiescence_guard: Arc<Mutex<Option<QuiescenceGuard>>>,
}

static SESSION_REGISTRY: LazyLock<Mutex<HashMap<String, SessionEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// agent-id → parent-cancel for stdio btw turns (mirrors napi's CANCEL_MAP
/// for `session_btw_prompt`; one-shot RUN_TURN turns use `cancel_map`).
static BTW_CANCEL_MAP: LazyLock<Mutex<HashMap<String, ParentCancel>>> =
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
        max_attempts: None,
        turn_id: "test-turn-1".into(),
        llm: &mock_llm,
        messages,
        tools: &[],
        tool_defs: vec![],
        max_steps: 5,
        max_context_tokens: None,
        goal: None,
        cancellation: None,
        hook_guard: None,
    };

    // Create a minimal server for the test
    let server = Arc::new(RpcServer::new());
    let callbacks: Arc<dyn HostCallbacks> = Arc::new(RpcHostCallbacks { server });

    let result = run_turn_continued(input, &callbacks).await;

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
                thinking: vec![],
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
