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
    AskQuestionRequest, AskQuestionResponse, LlmChatRequest, LlmChatResponse, NativeLlmConfig,
    PermissionCheckRequest, PermissionDecision, StateReadRequest, StateReadResponse,
    StateWriteRequest, StateWriteResponse, TokenUsage, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::storage::{SessionStore, StateStore};
use crate::subagent::SubagentManager;
use crate::tool_result_truncation::ToolResultTruncator;
use crate::tools::NativeToolset;
use crate::turn_loop::run_turn::run_turn;
use crate::turn_loop::types::{LLMMessage, RunTurnInput};

/// Host callbacks for the standalone REPL: LLM/tool execution are
/// unsupported (the REPL runs the native toolset in-process), permission is
/// always allowed, questions are answered interactively on stdin, and the
/// state bridge reads/writes the local per-domain state store (P32 批 1) so
/// the todo/plan/goal/cron/task tools work without a JS host.
struct ReplDummyHostCallbacks {
    state_store: Arc<StateStore>,
    task_runner: Option<Arc<crate::storage::task_runner::TaskRunner>>,
}

impl ReplDummyHostCallbacks {
    fn new(state_store: Arc<StateStore>) -> Self {
        Self {
            state_store,
            task_runner: None,
        }
    }

    fn with_task_runner(mut self, runner: Arc<crate::storage::task_runner::TaskRunner>) -> Self {
        self.task_runner = Some(runner);
        self
    }
}

impl HostCallbacks for ReplDummyHostCallbacks {
    fn llm_chat(
        &self,
        _req: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        Box::pin(async { Err("Host proxy not supported in standalone REPL".into()) })
    }
    fn execute_tool(
        &self,
        req: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let tool_name = req.tool_name;
        Box::pin(async move {
            Err(format!(
                "Tool \"{tool_name}\" is not available in the standalone REPL. Do NOT call this tool again — the REPL executes only the native tool set (read/grep/glob/write/edit/bash/fetch_url/web_search, todo/plan/goal/cron/task/skill/knowledge/team, subagents, MCP)."
            ))
        })
    }
    fn check_permission(
        &self,
        _req: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        Box::pin(async { Ok(PermissionDecision::allow()) })
    }
    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        Box::pin(async move {
            let stdin = io::stdin();
            let mut reader = stdin.lock();
            let stdout = io::stdout();
            let mut writer = stdout.lock();
            Ok(answer_questions_interactive(
                &request,
                &mut reader,
                &mut writer,
            ))
        })
    }
    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
        let store = self.state_store.clone();
        Box::pin(async move {
            let value = store.read_state(&request.domain, &request.key)?;
            Ok(StateReadResponse { value })
        })
    }
    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
        let store = self.state_store.clone();
        let runner = self.task_runner.clone();
        Box::pin(async move {
            // Task stop/wait delegate to the real background runner when one
            // is attached; everything else goes through the pure state
            // bridge.
            if request.domain == "task"
                && let Some(runner) = runner
            {
                let action = request
                    .value
                    .get("action")
                    .and_then(|a| a.as_str())
                    .unwrap_or_default();
                let id = request
                    .value
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or_default();
                match action {
                    "stop" => {
                        let entry = runner
                            .stop(id)
                            .await
                            .map_err(|e| format!("State write error: [-32002] {e}"))?;
                        return Ok(StateWriteResponse {
                            ok: true,
                            value: serde_json::json!({ "ok": true, "value": entry }),
                        });
                    }
                    "wait" => {
                        let timeout_ms = request
                            .value
                            .get("timeout_ms")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(30_000);
                        let entry = match runner.wait(id, timeout_ms).await {
                            crate::storage::task_runner::TaskWaitResult::Completed(entry)
                            | crate::storage::task_runner::TaskWaitResult::TimedOut(entry) => entry,
                            crate::storage::task_runner::TaskWaitResult::NotFound => {
                                return Err(format!(
                                    "State write error: [-32002] Task not found: {id}"
                                ));
                            }
                        };
                        return Ok(StateWriteResponse {
                            ok: true,
                            value: serde_json::json!({ "ok": true, "value": entry }),
                        });
                    }
                    _ => {}
                }
            }
            let outcome = store.apply_write(&request.domain, &request.value)?;
            store.write_domain(&request.domain, &outcome.stored)?;
            Ok(StateWriteResponse {
                ok: true,
                value: outcome.response,
            })
        })
    }
}

/// Mirrors the v2 `QUESTION_DISMISSED_MESSAGE` constant so the native
/// ask_user_question tool maps an EOF/empty-line dismissal to a dismissed
/// result instead of a background-task pass-through.
const QUESTION_DISMISSED_MESSAGE: &str = "User dismissed the question without answering.";

/// Ask the user each question in `request` through `reader`/`writer` and
/// return the v2 `AskQuestionResponse`. Questions are asked one at a time;
/// each answer is one line read from `reader`. EOF or an empty line at any
/// question dismisses the whole request (empty answers + dismissal note).
fn answer_questions_interactive(
    request: &AskQuestionRequest,
    reader: &mut dyn BufRead,
    writer: &mut dyn Write,
) -> AskQuestionResponse {
    let mut answers = HashMap::new();
    for item in &request.questions {
        if let Some(header) = &item.header {
            let _ = writeln!(writer, "[{header}]");
        }
        let _ = writeln!(writer, "{}", item.question);
        for (index, option) in item.options.iter().enumerate() {
            match &option.description {
                Some(description) => {
                    let _ = writeln!(writer, "  {}. {} — {description}", index + 1, option.label);
                }
                None => {
                    let _ = writeln!(writer, "  {}. {}", index + 1, option.label);
                }
            }
        }
        let _ = write!(writer, "> ");
        let _ = writer.flush();

        let mut line = String::new();
        let answer = match reader.read_line(&mut line) {
            Ok(0) => None, // EOF (Ctrl+D)
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            Err(_) => None,
        };
        let Some(answer) = answer else {
            return AskQuestionResponse {
                answers: HashMap::new(),
                method: None,
                note: Some(QUESTION_DISMISSED_MESSAGE.into()),
                cancelled: None,
                reason: None,
            };
        };
        answers.insert(item.question.clone(), answer);
    }
    AskQuestionResponse {
        answers,
        method: Some("enter".into()),
        note: None,
        cancelled: None,
        reason: None,
    }
}

/// The plan-mode tool guard (v2 `AgentPlanService.guardToolExecution`
/// semantics): when plan mode is active, write/edit may only target the
/// plan file and TaskStop is denied. Returns the denial reason, or `None`
/// to let the call through.
fn plan_mode_guard(
    store: &crate::storage::state_store::StateStore,
    tool_name: &str,
    args: &serde_json::Value,
) -> Option<String> {
    let plan = store.read_state("plan", "plan").ok()?;
    if plan.get("active").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let plan_path = plan.get("path").and_then(|p| p.as_str());
    match tool_name.to_ascii_lowercase().as_str() {
        "write" | "edit" => {
            let path = args.get("path").and_then(|p| p.as_str())?;
            let resolved = if std::path::Path::new(path).is_absolute() {
                path.to_string()
            } else if let Some(workspace) = store.state_dir().parent() {
                workspace.join(path).to_string_lossy().into_owned()
            } else {
                path.to_string()
            };
            if plan_path == Some(resolved.as_str()) {
                return None;
            }
            Some(format!(
                "Plan mode is active. You may only write to the current plan file: {}. Call ExitPlanMode to exit plan mode before editing other files.",
                plan_path.unwrap_or("(no plan file selected yet)")
            ))
        }
        "taskstop" | "task_stop" => Some(
            "TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task."
                .into(),
        ),
        _ => None,
    }
}

/// All tool definitions exposed to the model in the REPL: the core native
/// tools (read/grep/glob/write/edit/bash/fetch_url/web_search), subagent
/// tools, MCP-discovered tools, and the natively-executed tool set
/// (todo/plan/goal/cron/task/ask-question/skill classes).
async fn build_repl_tool_defs(mcp_manager: &McpManager) -> Vec<crate::turn_loop::types::ToolInfo> {
    let mut defs = crate::tools::core_tool_defs::core_tool_defs();
    defs.extend(crate::tools::subagent_tools::subagent_tool_defs());
    defs.extend(mcp_manager.list_tool_infos().await);
    defs.push(crate::tools::ask_user_question::ask_user_question_tool_def());
    defs.push(crate::tools::todo_list::todo_list_tool_def());
    defs.push(crate::tools::plan_mode::enter_plan_mode_tool_def());
    defs.push(crate::tools::get_goal::get_goal_tool_def());
    defs.push(crate::tools::cron_tools::cron_list_tool_def());
    defs.push(crate::tools::cron_tools::cron_create_tool_def());
    defs.push(crate::tools::cron_tools::cron_delete_tool_def());
    defs.push(crate::tools::goal_tools::update_goal_tool_def());
    defs.push(crate::tools::goal_tools::set_goal_budget_tool_def());
    defs.push(crate::tools::task_tools::task_list_tool_def());
    defs.push(crate::tools::task_tools::task_output_tool_def());
    defs.push(crate::tools::task_tools::task_stop_tool_def());
    defs.push(crate::tools::task_tools::task_wait_tool_def());
    defs.push(crate::tools::exit_plan_mode::exit_plan_mode_tool_def());
    defs.push(crate::tools::create_goal::create_goal_tool_def());
    defs.push(crate::tools::skill::skill_tool_def());
    defs.push(crate::tools::knowledge_tool::knowledge_tool_def());
    defs.push(crate::tools::team_tool::team_tool_def());
    defs
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
    let state_store = Arc::new(StateStore::for_workspace(&workspace)?);
    let mut current_session_id = format!("session-{}", fastrand::u64(..));

    let active_model_str = current_model.as_deref().unwrap_or("default");
    ui::render_banner(&workspace, active_model_str, &current_session_id);

    let subagent_manager = Arc::new(SubagentManager::new());
    let mcp_manager = Arc::new(McpManager::new());
    // P29 批 3 接线: connect MCP servers declared in config.toml so their
    // tools are discovered and exposed to the model this session.
    mcp_manager.spawn_from_config(&config.mcp_servers).await;

    // Background task runner: task stop/wait delegate to real execution.
    let task_runner = Arc::new(crate::storage::task_runner::TaskRunner::for_workspace(
        &workspace,
    )?);

    // Cron scheduler: fire entries from the local cron state. Fired prompts
    // land in a pending queue consumed at the next prompt (press Enter on an
    // empty line to run them). The scheduler runs in the local timezone
    // (v2 `getTimezoneOffset` semantics), not UTC.
    let cron_pending: Arc<std::sync::Mutex<Vec<String>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    if let Some(entries_value) = state_store.read_domain("cron")
        && let Ok(entries) =
            serde_json::from_value::<Vec<crate::cron::scheduler::CronEntry>>(entries_value)
        && !entries.is_empty()
    {
        let pending = cron_pending.clone();
        let tz_offset = chrono::Local::now().offset().local_minus_utc();
        let _cron_handle = crate::cron::scheduler::CronScheduler::start(entries, tz_offset, move |entry| {
            println!("\n⏰ [cron] {} — press Enter to run it.", entry.prompt);
            pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(entry.prompt.clone());
        });
    }

    loop {
        ui::render_prompt();

        // Lock stdin only for the prompt read and drop it before the turn:
        // the ask_question callback reads stdin from a spawned tool task,
        // and a lock held across the turn would deadlock that read.
        let line = {
            let stdin = io::stdin();
            let mut lines = stdin.lock().lines();
            match lines.next() {
                Some(Ok(l)) => l.trim().to_string(),
                Some(Err(e)) => {
                    eprintln!("[Error reading input]: {e}");
                    break;
                }
                None => break, // EOF (Ctrl+D)
            }
        };

        if line.is_empty() {
            // An empty line consumes a pending cron prompt, if any: the
            // prompt joins the message history and the next non-empty input
            // runs the normal turn pipeline with it.
            if let Some(prompt) = cron_pending.lock().unwrap_or_else(|e| e.into_inner()).pop() {
                println!("[cron] Queued: {prompt}");
                messages.push(LLMMessage {
                    role: "user".into(),
                    content: prompt,
                    blocks: Vec::new(),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
            }
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
                    println!("  /undo              - Undo the last turn's state changes");
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
                "/undo" => {
                    match state_store.rollback() {
                        Ok(true) => println!("Undid the last turn's state changes."),
                        Ok(false) => println!("Nothing to undo."),
                        Err(e) => eprintln!("[Undo error]: {e}"),
                    }
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
                        state_store.goal_context().as_ref(),
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
        let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(
            ReplDummyHostCallbacks::new(state_store.clone()).with_task_runner(task_runner.clone()),
        );
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
                .with_mcp(mcp_manager.clone())
                .with_callbacks(base_callbacks.clone()),
        );
        let plan_guard_store = state_store.clone();
        let tool_callbacks: Arc<dyn HostCallbacks> = Arc::new(NativeToolCallbacks {
            inner: base_callbacks,
            toolset,
            native_count,
            permission_engine: Some(permission_engine),
            truncator: Some(tool_truncator),
            plan_guard: Some(Arc::new(move |tool_name, args| {
                plan_mode_guard(&plan_guard_store, tool_name, args)
            })),
        });
        // P28 批 3 接线: give subagents the same llm + callback pipeline so
        // invoke_subagent runs real autonomous turns instead of just records.
        subagent_manager
            .set_runtime(llm.clone(), tool_callbacks.clone())
            .await;

        let cancellation = Arc::new(AtomicBool::new(false));
        let turn_id = format!("turn-{}", fastrand::u64(..));

        // Undo checkpoint: snapshot all state domains before the turn so
        // /undo can roll back this turn's state changes.
        if let Err(e) = state_store.checkpoint() {
            eprintln!("[Checkpoint error]: {e}");
        }

        println!(); // Linebreak before streaming
        let result = run_turn(
            RunTurnInput {
                turn_id: turn_id.clone(),
                llm: llm.as_ref(),
                messages: messages.clone(),
                tools: &[],
                tool_defs: build_repl_tool_defs(&mcp_manager).await,
                max_steps: 25,
                goal: state_store.goal_context(),
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

                // Fold the turn into the stored goal (v2 turn-end usage
                // accounting): turns_used +1, tokens_used += output.
                state_store.goal_record_usage(1, turn_res.usage.output_tokens.into());

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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::rpc::types::{AskQuestionItem, AskQuestionOption};

    fn question(text: &str, options: &[&str]) -> AskQuestionItem {
        AskQuestionItem {
            question: text.into(),
            header: None,
            options: options
                .iter()
                .map(|label| AskQuestionOption {
                    label: (*label).into(),
                    description: None,
                })
                .collect(),
            multi_select: false,
        }
    }

    fn request(questions: Vec<AskQuestionItem>) -> AskQuestionRequest {
        AskQuestionRequest {
            question_id: "question_test".into(),
            turn_id: "turn_test".into(),
            tool_call_id: "call_test".into(),
            background: false,
            timeout_ms: None,
            questions,
        }
    }

    #[test]
    fn test_answer_question_single() {
        let req = request(vec![question("Pick one", &["Alpha", "Beta"])]);
        let mut reader = Cursor::new(b"Alpha\n".to_vec());
        let mut writer = Vec::new();
        let resp = answer_questions_interactive(&req, &mut reader, &mut writer);
        assert_eq!(
            resp.answers,
            HashMap::from([("Pick one".to_string(), "Alpha".to_string())])
        );
        assert_eq!(resp.method.as_deref(), Some("enter"));
        assert!(resp.note.is_none());
        let out = String::from_utf8(writer).unwrap();
        assert!(out.contains("Pick one"));
        assert!(out.contains("1. Alpha"));
        assert!(out.contains("2. Beta"));
    }

    #[test]
    fn test_answer_question_multiple() {
        let req = request(vec![
            question("First", &["A", "B"]),
            question("Second", &["C", "D"]),
        ]);
        let mut reader = Cursor::new(b"A\nD\n".to_vec());
        let mut writer = Vec::new();
        let resp = answer_questions_interactive(&req, &mut reader, &mut writer);
        assert_eq!(
            resp.answers,
            HashMap::from([
                ("First".to_string(), "A".to_string()),
                ("Second".to_string(), "D".to_string()),
            ])
        );
        assert_eq!(resp.method.as_deref(), Some("enter"));
    }

    #[test]
    fn test_answer_question_eof_dismisses() {
        let req = request(vec![question("Pick one", &["Alpha", "Beta"])]);
        let mut reader = Cursor::new(Vec::new());
        let mut writer = Vec::new();
        let resp = answer_questions_interactive(&req, &mut reader, &mut writer);
        assert!(resp.answers.is_empty());
        assert_eq!(resp.method, None);
        assert_eq!(resp.note.as_deref(), Some(QUESTION_DISMISSED_MESSAGE));
    }

    #[test]
    fn test_answer_question_empty_line_dismisses() {
        let req = request(vec![question("Pick one", &["Alpha", "Beta"])]);
        let mut reader = Cursor::new(b"\n".to_vec());
        let mut writer = Vec::new();
        let resp = answer_questions_interactive(&req, &mut reader, &mut writer);
        assert!(resp.answers.is_empty());
        assert_eq!(resp.note.as_deref(), Some(QUESTION_DISMISSED_MESSAGE));
    }

    #[test]
    fn test_answer_question_eof_midway_dismisses_all() {
        // Answer the first question, then EOF on the second: the whole
        // request is dismissed, not partially answered.
        let req = request(vec![
            question("First", &["A", "B"]),
            question("Second", &["C", "D"]),
        ]);
        let mut reader = Cursor::new(b"A\n".to_vec());
        let mut writer = Vec::new();
        let resp = answer_questions_interactive(&req, &mut reader, &mut writer);
        assert!(resp.answers.is_empty());
        assert_eq!(resp.note.as_deref(), Some(QUESTION_DISMISSED_MESSAGE));
    }

    #[tokio::test]
    async fn test_repl_tool_defs_complete() {
        let defs = build_repl_tool_defs(&McpManager::new()).await;
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        for expected in [
            "invoke_subagent",
            "manage_subagents",
            "define_subagent",
            "ask_user_question",
            "TodoList",
            "EnterPlanMode",
            "GetGoal",
            "CronList",
            "CronCreate",
            "CronDelete",
            "UpdateGoal",
            "SetGoalBudget",
            "TaskList",
            "TaskOutput",
            "TaskStop",
            "TaskWait",
            "ExitPlanMode",
            "CreateGoal",
            "Skill",
        ] {
            assert!(names.contains(&expected), "missing tool def: {expected}");
        }
    }

    #[tokio::test]
    async fn test_repl_state_bridge_reads_defaults_and_round_trips() {
        let tmp = tempfile::TempDir::new().unwrap();
        let callbacks =
            ReplDummyHostCallbacks::new(Arc::new(StateStore::for_workspace(tmp.path()).unwrap()));
        let read = |domain: &str| {
            callbacks.state_read(StateReadRequest {
                domain: domain.into(),
                key: domain.into(),
                turn_id: String::new(),
                tool_call_id: String::new(),
            })
        };
        // Empty domains read their v2 defaults.
        assert_eq!(read("todo").await.unwrap().value, serde_json::json!([]));
        assert_eq!(
            read("plan").await.unwrap().value,
            serde_json::json!({ "active": false })
        );
        assert_eq!(
            read("goal").await.unwrap().value,
            serde_json::json!({ "goal": null })
        );
        // Unknown domains error with the -32001 code.
        let err = read("skill").await.unwrap_err();
        assert!(err.contains("-32001"));
        // A todo write persists and reads back.
        let write = callbacks
            .state_write(StateWriteRequest {
                domain: "todo".into(),
                key: "todo".into(),
                value: serde_json::json!([
                    { "id": "T1", "parentId": null, "kind": "task", "title": "Read", "status": "in_progress", "progress": 40 }
                ]),
                undoable: true,
                turn_id: String::new(),
                tool_call_id: String::new(),
            })
            .await
            .unwrap();
        assert!(write.ok);
        assert_eq!(write.value[0]["id"], "T1");
        let value = read("todo").await.unwrap().value;
        assert_eq!(value[0]["title"], "Read");
        assert_eq!(value[0]["status"], "in_progress");
        // A plan enter returns the generated id/path and persists.
        let write = callbacks
            .state_write(StateWriteRequest {
                domain: "plan".into(),
                key: "plan".into(),
                value: serde_json::json!({ "active": true }),
                undoable: true,
                turn_id: String::new(),
                tool_call_id: String::new(),
            })
            .await
            .unwrap();
        assert!(write.value["active"].as_bool() == Some(true));
        assert!(write.value["id"].is_string());
        assert!(write.value["path"].is_string());
        let value = read("plan").await.unwrap().value;
        assert_eq!(value["active"], true);
        assert_eq!(value["id"], write.value["id"]);
    }

    #[test]
    fn test_plan_mode_guard_passes_when_inactive() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = crate::storage::state_store::StateStore::for_workspace(tmp.path()).unwrap();
        assert!(plan_mode_guard(&store, "write", &serde_json::json!({ "path": "a.txt" })).is_none());
        assert!(plan_mode_guard(&store, "taskstop", &serde_json::json!({})).is_none());
    }

    #[test]
    fn test_plan_enter_creates_empty_plan_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = crate::storage::state_store::StateStore::for_workspace(tmp.path()).unwrap();
        let outcome = store
            .apply_write("plan", &serde_json::json!({ "active": true }))
            .unwrap();
        let path = std::path::Path::new(outcome.stored["path"].as_str().unwrap());
        assert!(path.is_file());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "");
    }

    #[tokio::test]
    async fn test_repl_execute_tool_fallback_names_the_tool() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = crate::storage::state_store::StateStore::for_workspace(tmp.path()).unwrap();
        let callbacks = ReplDummyHostCallbacks::new(std::sync::Arc::new(store));
        let request = crate::rpc::types::ToolExecuteRequest {
            tool_name: "GitHubGetRepo".into(),
            tool_call_id: "call-1".into(),
            arguments: serde_json::json!({ "owner": "a", "repo": "b" }),
            turn_id: "turn-1".into(),
        };
        let result = callbacks.execute_tool(request).await;
        let err = result.unwrap_err();
        assert!(err.contains("GitHubGetRepo"));
        assert!(err.contains("not available in the standalone REPL"));
    }

    #[test]
    fn test_plan_mode_guard_denies_non_plan_writes() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = crate::storage::state_store::StateStore::for_workspace(tmp.path()).unwrap();
        let outcome = store
            .apply_write("plan", &serde_json::json!({ "active": true }))
            .unwrap();
        store.write_domain("plan", &outcome.stored).unwrap();
        let plan_path = outcome.stored["path"].as_str().unwrap().to_string();
        let denied = plan_mode_guard(&store, "write", &serde_json::json!({ "path": "other.txt" }))
            .unwrap();
        assert!(denied.contains("Plan mode is active"));
        assert!(denied.contains(&plan_path));
        assert!(plan_mode_guard(&store, "edit", &serde_json::json!({ "path": "other.txt" })).is_some());
        assert!(plan_mode_guard(&store, "read", &serde_json::json!({ "path": "other.txt" })).is_none());
    }

    #[test]
    fn test_plan_mode_guard_allows_plan_file_write() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = crate::storage::state_store::StateStore::for_workspace(tmp.path()).unwrap();
        let outcome = store
            .apply_write("plan", &serde_json::json!({ "active": true }))
            .unwrap();
        store.write_domain("plan", &outcome.stored).unwrap();
        let plan_path = outcome.stored["path"].as_str().unwrap().to_string();
        assert!(plan_mode_guard(&store, "write", &serde_json::json!({ "path": plan_path })).is_none());
        let workspace = store.state_dir().parent().unwrap();
        let relative = std::path::Path::new(&plan_path)
            .strip_prefix(workspace)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(plan_mode_guard(&store, "edit", &serde_json::json!({ "path": relative })).is_none());
    }

    #[test]
    fn test_plan_mode_guard_denies_task_stop() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = crate::storage::state_store::StateStore::for_workspace(tmp.path()).unwrap();
        let outcome = store
            .apply_write("plan", &serde_json::json!({ "active": true }))
            .unwrap();
        store.write_domain("plan", &outcome.stored).unwrap();
        let denied = plan_mode_guard(&store, "taskstop", &serde_json::json!({ "id": "t1" })).unwrap();
        assert!(denied.contains("TaskStop is not available in plan mode"));
    }
}
