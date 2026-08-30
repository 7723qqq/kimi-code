//! Interactive Terminal REPL for pure-Rust CLI execution (P27, P28, P29, P31).
//!
//! Provides a standalone interactive REPL without Node/Bun dependencies.
//! Supports real-time streaming output, slash commands, multi-turn history,
//! in-process native tool execution, and durable JSONL session persistence.

pub mod ui;

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32};

use futures_util::future::BoxFuture;

use crate::callbacks::{CountingCallbacks, HostCallbacks, NativeToolCallbacks};
use crate::config::KimiConfig;
use crate::events::EventBus;
use crate::events::types::EngineEvent;
use crate::llm::http::NativeHttpLlm;
use crate::mcp::McpManager;
use crate::permission::PermissionEngine;
use crate::rpc::types::{
    LlmChatRequest, LlmChatResponse, NativeLlmConfig, PermissionCheckRequest, PermissionDecision,
    TokenUsage, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::storage::SessionStore;
use crate::subagent::SubagentManager;
use crate::tool_result_truncation::ToolResultTruncator;
use crate::tools::NativeToolset;
use crate::turn_loop::run_turn::run_turn;
use crate::turn_loop::types::{LLMMessage, RunTurnInput};

struct ReplDummyHostCallbacks;
impl HostCallbacks for ReplDummyHostCallbacks {
    fn llm_chat(
        &self,
        _req: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        Box::pin(async { Err("Host proxy not supported in standalone REPL".into()) })
    }
    fn execute_tool(
        &self,
        _req: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        Box::pin(async { Err("Host execute_tool not supported in standalone REPL".into()) })
    }
    fn check_permission(
        &self,
        _req: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        Box::pin(async { Ok(PermissionDecision::allow()) })
    }
}

pub async fn start_repl(
    mut config: KimiConfig,
    workspace: PathBuf,
    target_model: Option<String>,
) -> anyhow::Result<()> {
    let mut current_model = target_model.or_else(|| config.default_model.clone());
    let mut messages: Vec<LLMMessage> = Vec::new();
    let mut total_usage = TokenUsage::default();

    let session_store = SessionStore::for_workspace(&workspace)?;
    let mut current_session_id = format!("session-{}", fastrand::u64(..));

    let active_model_str = current_model.as_deref().unwrap_or("default");
    ui::render_banner(&workspace, active_model_str, &current_session_id);

    let subagent_manager = Arc::new(SubagentManager::new());
    let mcp_manager = Arc::new(McpManager::new());
    // P29 批 3 接线: connect MCP servers declared in config.toml so their
    // tools are discovered and exposed to the model this session.
    mcp_manager.spawn_from_config(&config.mcp_servers).await;

    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();

    loop {
        ui::render_prompt();

        let line = match lines.next() {
            Some(Ok(l)) => l.trim().to_string(),
            Some(Err(e)) => {
                eprintln!("[Error reading input]: {e}");
                break;
            }
            None => break, // EOF (Ctrl+D)
        };

        if line.is_empty() {
            continue;
        }

        // Handle slash commands
        if line.starts_with('/') {
            let mut parts = line.split_whitespace();
            let cmd = parts.next().unwrap_or("");
            let arg = parts.next();

            match cmd {
                "/exit" | "/quit" => {
                    println!("Goodbye.");
                    break;
                }
                "/help" => {
                    println!("\nAvailable Slash Commands:");
                    println!("  /help              - Show this help message");
                    println!("  /status            - Show current session status & token metrics");
                    println!("  /sessions          - List persisted sessions in this workspace");
                    println!(
                        "  /resume <id>       - Resume and load history from a previous session"
                    );
                    println!("  /new               - Start a new conversation session");
                    println!("  /model <name>      - Switch the active model for this session");
                    println!(
                        "  /yolo              - Toggle YOLO permission mode (auto-approve writes)"
                    );
                    println!("  /clear             - Clear in-memory conversation history");
                    println!("  /exit, /quit       - Exit the CLI\n");
                    continue;
                }
                "/sessions" => {
                    println!("\nSaved Sessions in workspace:");
                    match session_store.list_sessions() {
                        Ok(list) => {
                            if list.is_empty() {
                                println!("  (No saved sessions found)");
                            } else {
                                for s in list {
                                    println!(
                                        "  - {} (turns: {}, tokens: {})",
                                        s.session_id, s.turns_count, s.total_usage.total_tokens
                                    );
                                }
                            }
                        }
                        Err(e) => eprintln!("  [Error listing sessions]: {e}"),
                    }
                    println!();
                    continue;
                }
                "/resume" => {
                    if let Some(id) = arg {
                        match session_store.load_history(id) {
                            Ok(history) => {
                                current_session_id = id.to_string();
                                messages = history;
                                println!(
                                    "Resumed session '{}' with {} messages.",
                                    id,
                                    messages.len()
                                );
                            }
                            Err(e) => eprintln!("[Error loading session]: {e}"),
                        }
                    } else {
                        println!("Usage: /resume <session_id>");
                    }
                    continue;
                }
                "/new" => {
                    current_session_id = format!("session-{}", fastrand::u64(..));
                    messages.clear();
                    total_usage = TokenUsage::default();
                    println!("Started new session: {current_session_id}");
                    continue;
                }
                "/status" => {
                    ui::render_status_panel(
                        &workspace,
                        current_model.as_deref().unwrap_or("default"),
                        &current_session_id,
                        config.agent.yolo.unwrap_or(false),
                        messages.len() / 2,
                        &total_usage,
                    );
                    continue;
                }
                "/yolo" => {
                    let current = config.agent.yolo.unwrap_or(false);
                    config.agent.yolo = Some(!current);
                    println!(
                        "YOLO Mode {}",
                        if !current { "ENABLED" } else { "DISABLED" }
                    );
                    continue;
                }
                "/model" => {
                    if let Some(m) = arg {
                        current_model = Some(m.to_string());
                        println!("Switched model to: {m}");
                    } else {
                        println!("Usage: /model <model-name>");
                    }
                    continue;
                }
                "/clear" => {
                    messages.clear();
                    println!("Conversation history cleared.");
                    continue;
                }
                _ => {
                    println!("Unknown command '{cmd}'. Type '/help' for available commands.");
                    continue;
                }
            }
        }

        // Build native LLM from current config
        let native_llm_def = match config.extract_native_llm(current_model.as_deref()) {
            Some(def) => def,
            None => {
                eprintln!(
                    "[Configuration Error] No valid provider/key found for model '{}'.",
                    current_model.as_deref().unwrap_or("default")
                );
                eprintln!("Check your ~/.kimi-code/config.toml credentials.");
                continue;
            }
        };

        let system_prompt = "You are Kimi, a helpful agentic coding assistant.".to_string();
        let llm: Arc<dyn crate::turn_loop::types::LLM> = Arc::new(NativeHttpLlm::new(
            NativeLlmConfig {
                protocol: native_llm_def.protocol,
                base_url: native_llm_def.base_url,
                api_key: native_llm_def.api_key,
                model: native_llm_def.model,
                max_tokens: native_llm_def.max_tokens,
                custom_headers: HashMap::new(),
            },
            system_prompt,
        ));

        // Add user prompt to conversation history
        let user_msg = LLMMessage {
            role: "user".into(),
            content: line.clone(),
            blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        };
        messages.push(user_msg.clone());

        // Set up in-process event bus with real-time token streaming to terminal
        let event_bus = Arc::new(EventBus::new());
        event_bus.subscribe(|event| match event {
            EngineEvent::LlmDelta { part, .. } => {
                if let Some(delta) = part.get("delta").and_then(|d| d.as_str()) {
                    print!("{delta}");
                    let _ = io::stdout().flush();
                } else if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    print!("{text}");
                    let _ = io::stdout().flush();
                }
            }
            EngineEvent::ToolNative {
                tool_name,
                arguments,
                is_error,
                ..
            } => {
                ui::render_tool_call(tool_name, arguments, *is_error, None);
            }
            _ => {}
        });

        let policy_snapshot = config.build_policy_snapshot(Some(workspace.clone()));
        let permission_engine = Arc::new(PermissionEngine::new(policy_snapshot));
        let tool_truncator = Arc::new(ToolResultTruncator::for_workspace(&workspace));

        // Build callback pipeline
        let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(ReplDummyHostCallbacks);
        let event_counter = Arc::new(AtomicU32::new(0));
        let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(
            CountingCallbacks::new(base_callbacks, event_counter).with_bus(event_bus.clone()),
        );

        let native_count = Arc::new(AtomicU32::new(0));
        let workspace_str = workspace.to_string_lossy().to_string();
        let toolset = Arc::new(
            NativeToolset::new(&workspace_str, None)
                .unwrap_or_else(|| panic!("Invalid workspace root: {}", workspace.display()))
                .with_subagents(subagent_manager.clone())
                .with_mcp(mcp_manager.clone()),
        );
        let tool_callbacks: Arc<dyn HostCallbacks> = Arc::new(NativeToolCallbacks {
            inner: base_callbacks,
            toolset,
            native_count,
            permission_engine: Some(permission_engine),
            truncator: Some(tool_truncator),
        });
        // P28 批 3 接线: give subagents the same llm + callback pipeline so
        // invoke_subagent runs real autonomous turns instead of just records.
        subagent_manager
            .set_runtime(llm.clone(), tool_callbacks.clone())
            .await;

        let cancellation = Arc::new(AtomicBool::new(false));
        let turn_id = format!("turn-{}", fastrand::u64(..));

        println!(); // Linebreak before streaming
        let result = run_turn(
            RunTurnInput {
                turn_id: turn_id.clone(),
                llm: llm.as_ref(),
                messages: messages.clone(),
                tools: &[],
                tool_defs: {
                    let mut defs = crate::tools::subagent_tools::subagent_tool_defs();
                    defs.extend(mcp_manager.list_tool_infos().await);
                    defs
                },
                max_steps: 25,
                goal: None,
                cancellation: Some(cancellation),
            },
            &tool_callbacks,
        )
        .await;

        println!(); // Linebreak after completion

        match result {
            Ok(turn_res) => {
                total_usage.input_tokens += turn_res.usage.input_tokens;
                total_usage.output_tokens += turn_res.usage.output_tokens;
                total_usage.total_tokens += turn_res.usage.total_tokens;
                total_usage.input_cache_read += turn_res.usage.input_cache_read;
                total_usage.input_cache_creation += turn_res.usage.input_cache_creation;

                // Persist turn to session store
                let _ = session_store.append_turn(
                    &current_session_id,
                    &turn_id,
                    &user_msg,
                    None,
                    &turn_res.usage,
                );
            }
            Err(e) => {
                eprintln!("\n[Turn Error] {e}");
            }
        }
    }

    Ok(())
}
