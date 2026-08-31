//! kimi-agent — Rust agent engine with stdio JSON-RPC bridge.
//!
//! Usage:
//!   kimi-agent [--health] [--test]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use clap::Parser;

use kimi_agent::{
    callbacks::{CountingCallbacks, HostCallbacks, NativeToolCallbacks, RpcHostCallbacks},
    llm::{
        http::NativeHttpLlm,
        multi::{LlmProvider, MultiLLM},
        proxy::HostLlmProxy,
    },
    rpc::{
        server::RpcServer,
        types::{self, CancelTurnParams, HealthStatus, RunTurnResult, TokenUsage},
    },
    turn_loop::{run_turn::run_turn, types::*},
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

    // Shared map of turn_id → cancellation flag, so CANCEL_TURN can
    // signal a running turn to abort before its next step.
    let cancel_map: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
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

            // Create and register a cancellation flag for this turn.
            let cancel_flag = Arc::new(AtomicBool::new(false));
            {
                let mut map = cancel_map.lock().unwrap();
                map.insert(turn_id.clone(), cancel_flag.clone());
            }

            // Build the HostCallbacks from the RPC server, optionally
            // wrapped so read-only tools execute natively inside the
            // workspace sandbox.
            let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(RpcHostCallbacks {
                server: server.clone(),
            });
            // Count every event this turn emits (step lifecycle, deltas,
            // native tools, goal budget limits) for the turn telemetry.
            let turn_event_count = Arc::new(AtomicU32::new(0));
            let event_bus = Arc::new(kimi_agent::events::EventBus::new());
            let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(
                CountingCallbacks::new(base_callbacks, turn_event_count.clone())
                    .with_bus(event_bus.clone()),
            );
            let native_tool_count = Arc::new(AtomicU32::new(0));
            // P26 批 4: when `rust_self_contained` is set, build a local
            // truncator so result truncation + spill happen in-process and
            // the host's `host/finalize_tool_result` seam is bypassed.
            let truncator = if input.rust_self_contained {
                input
                    .workspace_root
                    .as_deref()
                    .map(std::path::Path::new)
                    .map(|root| {
                        Arc::new(
                            kimi_agent::tool_result_truncation::ToolResultTruncator::for_workspace(
                                root,
                            ),
                        )
                    })
            } else {
                None
            };
            let permission_engine = input
                .policy_snapshot
                .map(|s| Arc::new(kimi_agent::permission::PermissionEngine::new(s)));
            let callbacks: Arc<dyn HostCallbacks> =
                match (input.native_tools, input.workspace_root.as_deref()) {
                    (true, Some(root)) => {
                        match kimi_agent::tools::NativeToolset::new(
                            root,
                            input.shell_path.as_deref(),
                        ) {
                            Some(toolset) => {
                                // Plan-mode guard (v2
                                // `AgentPlanService.guardToolExecution`):
                                // guarded native calls read the host's plan
                                // state through the state bridge and are
                                // denied when plan mode forbids them.
                                // Unguarded tools skip the round-trip.
                                let plan_callbacks = base_callbacks.clone();
                                let plan_workspace = input.workspace_root.clone();
                                Arc::new(NativeToolCallbacks {
                                    inner: base_callbacks.clone(),
                                    toolset: Arc::new(
                                        toolset
                                            .with_callbacks(base_callbacks.clone())
                                            .with_github_credentials(
                                                kimi_agent::tools::github::GitHubCredentials {
                                                    token: input.github_token.clone(),
                                                    base_url: input.github_base_url.clone(),
                                                },
                                            ),
                                    ),
                                    native_count: native_tool_count.clone(),
                                    truncator: truncator.clone(),
                                    permission_engine,
                                    plan_guard: Some(Arc::new(move |tool_name, args| {
                                        if !kimi_agent::tools::plan_mode::plan_guarded_tool(
                                            tool_name,
                                        ) {
                                            return Box::pin(async { None });
                                        }
                                        let callbacks = plan_callbacks.clone();
                                        let tool_name = tool_name.to_string();
                                        let args = args.clone();
                                        let workspace = plan_workspace.clone();
                                        Box::pin(async move {
                                            let request =
                                                kimi_agent::rpc::types::StateReadRequest {
                                                    domain: "plan".into(),
                                                    key: "plan".into(),
                                                    turn_id: String::new(),
                                                    tool_call_id: String::new(),
                                                };
                                            match callbacks.state_read(request).await {
                                                Ok(response) => {
                                                    kimi_agent::tools::plan_mode::plan_denial(
                                                        &response.value,
                                                        &tool_name,
                                                        &args,
                                                        workspace
                                                            .as_deref()
                                                            .map(std::path::Path::new),
                                                    )
                                                }
                                                Err(_) => None,
                                            }
                                        })
                                    })),
                                })
                            }
                            None => base_callbacks.clone(),
                        }
                    }
                    _ => base_callbacks.clone(),
                };

            // Build the LLM — MultiLLM providers, native HTTP, or host proxy.
            // Priority must match the napi channel (napi_bindings.rs):
            // providers (concurrent MultiLLM race) → native_llm → host
            // proxy. Checking native_llm first would silently route a
            // MultiLLM session to a single model on this transport.
            let llm: Box<dyn LLM> = if !input.providers.is_empty() {
                let providers: Vec<LlmProvider> = input
                    .providers
                    .iter()
                    .map(|p| LlmProvider {
                        name: p.name.clone(),
                        system_prompt: p.system_prompt.clone(),
                        model: p.model.clone(),
                        callbacks: callbacks.clone(),
                    })
                    .collect();
                let multi = MultiLLM::new(providers);
                Box::new(multi)
            } else if let Some(cfg) = input.native_llm.clone() {
                let sink_callbacks = callbacks.clone();
                Box::new(
                    NativeHttpLlm::new(cfg, input.system_prompt.clone())
                        .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event))),
                )
            } else {
                // Self-contained mode: refuse to fall back to host proxy.
                if input.rust_self_contained {
                    return Err(types::JsonRpcError::internal_error(
                        "rustSelfContained=true requires providers or native_llm to be \
                         set; refusing to fall back to host/llm_chat (P26 批 1)"
                            .to_string(),
                    ));
                }
                Box::new(
                    HostLlmProxy::new(input.system_prompt.clone(), input.model_name.clone())
                        .with_callbacks(callbacks.clone()),
                )
            };

            let messages: Vec<LLMMessage> = input
                .messages
                .into_iter()
                .map(|m| LLMMessage {
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
                })
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
                llm: &*llm,
                messages,
                tools: &tools,
                tool_defs,
                max_steps,
                goal: input.goal,
                cancellation: Some(cancel_flag.clone()),
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

    // Register cancel_turn handler
    let cm = cancel_map.clone();
    RpcServer::register_arc(&server, types::methods::CANCEL_TURN, move |params| {
        let cancel_map = cm.clone();
        Box::pin(async move {
            let input: CancelTurnParams = serde_json::from_value(params)
                .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

            let cancelled = {
                let map = cancel_map.lock().unwrap();
                if let Some(flag) = map.get(&input.turn_id) {
                    flag.store(true, Ordering::Relaxed);
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
