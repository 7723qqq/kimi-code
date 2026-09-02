//! Subagent lifecycle and concurrency manager.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::RwLock;

use crate::subagent::types::*;

type InstanceEntry = (SubagentInstance, Arc<AtomicBool>);
type InstanceMap = Arc<RwLock<HashMap<String, InstanceEntry>>>;
type DefinitionMap = Arc<RwLock<HashMap<String, SubagentDefinition>>>;
type PersistentMap = Arc<RwLock<HashMap<String, PersistentInstance>>>;

/// The last non-empty assistant text of a turn — the subagent's summary
/// the `Agent` tool reports to the caller (v2 `r.summary`).
pub(crate) fn final_assistant_summary(messages: &[crate::turn_loop::types::LLMMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant" && !message.content.is_empty())
        .map(|message| message.content.clone())
        .unwrap_or_default()
}

/// A profile's tool policy (v2 `resolveActiveToolNames` subset semantics):
/// an explicit allowlist wins; an empty allowlist means every tool except
/// the disallowed names.
#[derive(Clone)]
pub struct ToolPolicyFilter {
    allowlist: Vec<String>,
    disallowed: Vec<String>,
}

impl ToolPolicyFilter {
    pub fn from_definition(def: &SubagentDefinition) -> Self {
        Self {
            allowlist: def.tools.clone(),
            disallowed: def.disallowed_tools.clone(),
        }
    }

    pub fn allows(&self, tool_name: &str) -> bool {
        if !self.allowlist.is_empty() {
            return self
                .allowlist
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(tool_name));
        }
        !self
            .disallowed
            .iter()
            .any(|denied| denied.eq_ignore_ascii_case(tool_name))
    }
}

/// [`crate::callbacks::HostCallbacks`] decorator that narrows the tool
/// table a subagent's turn sees to its profile policy (`list_tools`
/// filter); every other seam passes through untouched.
struct ToolFilterCallbacks {
    inner: Arc<dyn crate::callbacks::HostCallbacks>,
    filter: ToolPolicyFilter,
}

impl crate::callbacks::HostCallbacks for ToolFilterCallbacks {
    fn llm_chat(
        &self,
        request: crate::rpc::types::LlmChatRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
    {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: crate::rpc::types::ToolExecuteRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::ToolExecuteResponse, String>>
    {
        self.inner.execute_tool(request)
    }

    fn check_permission(
        &self,
        request: crate::rpc::types::PermissionCheckRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::PermissionDecision, String>>
    {
        self.inner.check_permission(request)
    }

    fn ask_question(
        &self,
        request: crate::rpc::types::AskQuestionRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::AskQuestionResponse, String>>
    {
        self.inner.ask_question(request)
    }

    fn state_read(
        &self,
        request: crate::rpc::types::StateReadRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::StateReadResponse, String>>
    {
        self.inner.state_read(request)
    }

    fn state_write(
        &self,
        request: crate::rpc::types::StateWriteRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::StateWriteResponse, String>>
    {
        self.inner.state_write(request)
    }

    fn list_tools(
        &self,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::ListToolsResponse, String>>
    {
        let inner = self.inner.clone();
        let filter = self.filter.clone();
        Box::pin(async move {
            let mut response = inner.list_tools().await?;
            response.tools.retain(|tool| filter.allows(&tool.name));
            Ok(response)
        })
    }

    fn goal(
        &self,
    ) -> crate::rpc::types::BoxFuture<
        'static,
        Result<Option<crate::turn_loop::types::GoalContext>, String>,
    > {
        self.inner.goal()
    }

    fn drain_steers(
        &self,
    ) -> crate::rpc::types::BoxFuture<
        'static,
        Result<Vec<crate::turn_loop::types::LLMMessage>, String>,
    > {
        self.inner.drain_steers()
    }

    fn set_turn_goal(&self, turn_id: &str, goal_id: Option<&str>) {
        self.inner.set_turn_goal(turn_id, goal_id);
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

    fn cancel_llm_chat(&self, request_id: &str) {
        self.inner.cancel_llm_chat(request_id);
    }
}

/// State of a persistent subagent instance: message history, cumulative
/// usage, and the running guard that rejects concurrent turns.
pub struct PersistentInstance {
    /// Spawn-time execution context, recorded for the instance's lifetime.
    pub llm: Arc<dyn crate::turn_loop::types::LLM>,
    pub callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    /// Definition system prompt, inlined into the first turn's prompt.
    pub system_prompt: String,
    /// Conversation history accumulated across turns.
    pub messages: Vec<crate::turn_loop::types::LLMMessage>,
    /// Cumulative token usage across all turns.
    pub usage: crate::rpc::types::TokenUsage,
    /// True while a turn is running; concurrent turns are rejected.
    pub running: bool,
    /// Shared with the instance-map entry so `kill` aborts running turns.
    pub cancelled: Arc<AtomicBool>,
}

/// Execution runtime injected by the host so subagents can run real turns.
pub struct SubagentRuntime {
    pub llm: Arc<dyn crate::turn_loop::types::LLM>,
    pub callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
}

pub struct SubagentManager {
    definitions: DefinitionMap,
    instances: InstanceMap,
    persistent: PersistentMap,
    runtime: RwLock<Option<Arc<SubagentRuntime>>>,
    /// P55: accumulated conversation history per foreground agent id, so a
    /// `resume` call continues the same subagent natively (v2 persistent
    /// scopes). Written on foreground completion; read by `resume` calls.
    foreground_histories: Arc<Mutex<HashMap<String, ForegroundResume>>>,
}

/// A foreground subagent's resume record (P55).
#[derive(Clone)]
struct ForegroundResume {
    profile_name: String,
    role: String,
    messages: Vec<crate::turn_loop::types::LLMMessage>,
}

impl Default for SubagentManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome of a foreground subagent run (v2 `Agent` tool).
pub enum ForegroundTurnOutcome {
    /// The turn — including any summary-distillation continuations — ran
    /// to completion.
    Completed(crate::turn_loop::types::TurnResult),
    /// The parent turn was cancelled; the subagent run was aborted
    /// immediately at its current await point.
    ParentCancelled,
}

/// Why a foreground run ended without a [`ForegroundTurnOutcome::Completed`].
enum RunExit {
    ParentCancelled,
    Failed(String),
}

/// UTF-16 code-unit length (v2 `String.length`): the summary adequacy
/// floor counts characters the same way the JS policy does.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// v2 `classifyTurnResult` mirror: a max-token-truncated subagent turn
/// fails the run with the verbatim v2 error text.
pub const SUBAGENT_MAX_TOKENS_ERROR: &str =
    "Subagent turn failed before completing its final summary: reason=max_tokens";

/// v2 `distillSummary` (P51): while the final assistant text is shorter
/// than the policy floor, re-prompt with the continuation prompt and adopt
/// the newer non-empty assistant text (`final_assistant_summary` keeps the
/// previous one when the continuation answers empty, same as v2). Usage is
/// accumulated across continuation turns.
async fn distill_continuations(
    runtime: &SubagentRuntime,
    callbacks: &Arc<dyn crate::callbacks::HostCallbacks>,
    tool_defs: Vec<crate::turn_loop::types::ToolInfo>,
    cancel_flag: &Arc<AtomicBool>,
    parent_cancel: Option<&crate::subagent::types::ParentCancel>,
    mut turn: crate::turn_loop::types::TurnResult,
    policy: &crate::subagent::types::SummaryPolicy,
) -> Result<crate::turn_loop::types::TurnResult, RunExit> {
    let mut usage_total = turn.usage.clone();
    let mut attempts = 0u32;
    while utf16_len(final_assistant_summary(&turn.messages).trim()) < policy.min_chars
        && attempts < policy.retries
    {
        attempts += 1;
        let mut history = turn.messages.clone();
        history.push(crate::turn_loop::types::LLMMessage {
            role: "user".into(),
            content: policy.continuation_prompt.clone(),
            ..Default::default()
        });
        turn = run_one(
            runtime,
            callbacks,
            history,
            tool_defs.clone(),
            cancel_flag,
            parent_cancel,
        )
        .await?;
        usage_total = add_usage(&usage_total, &turn.usage);
    }
    turn.usage = usage_total;
    Ok(turn)
}

/// Run one `run_turn` for the foreground subagent, aborting immediately
/// when the parent cancels: dropping the run future interrupts the
/// subagent at its current await point (in-flight LLM call / tool wait,
/// the v2 AbortSignal semantics the step-top flag checks cannot reach);
/// the instance flag also flips so the scheduler's own cancellation
/// checks observe it.
async fn run_one(
    runtime: &SubagentRuntime,
    callbacks: &Arc<dyn crate::callbacks::HostCallbacks>,
    messages: Vec<crate::turn_loop::types::LLMMessage>,
    tool_defs: Vec<crate::turn_loop::types::ToolInfo>,
    cancel_flag: &Arc<AtomicBool>,
    parent_cancel: Option<&crate::subagent::types::ParentCancel>,
) -> Result<crate::turn_loop::types::TurnResult, RunExit> {
    let run_input = crate::turn_loop::types::RunTurnInput {
        turn_id: format!("subturn-{}", fastrand::u64(..)),
        llm: runtime.llm.as_ref(),
        messages,
        tools: &[],
        tool_defs,
        // Foreground subagents run until done — the caller owns the
        // timeout (v2 `resolveSubagentTimeoutMs`), not a step cap.
        max_steps: u32::MAX,
        max_context_tokens: None,
        goal: None,
        cancellation: Some(cancel_flag.clone()),
    };
    let run_future = crate::turn_loop::run_turn::run_turn(run_input, callbacks);
    tokio::pin!(run_future);
    match parent_cancel {
        Some(signal) => {
            tokio::select! {
                result = &mut run_future => {
                    result.map_err(|err| RunExit::Failed(err.to_string()))
                }
                () = signal.wait() => Err(RunExit::ParentCancelled),
            }
        }
        None => run_future
            .await
            .map_err(|err| RunExit::Failed(err.to_string())),
    }
}

impl SubagentManager {
    pub fn new() -> Self {
        let mut defs = HashMap::new();
        // Built-in research subagent
        defs.insert(
            "research".into(),
            SubagentDefinition {
                name: "research".into(),
                description: "Research subagent with read-only tools for exploring codebase and fetching web info.".into(),
                system_prompt: "You are a specialized research subagent. Use read, grep, glob, fetch_url, and web_search to find information and report concise findings.".into(),
                tools: vec![
                    "read".into(),
                    "grep".into(),
                    "glob".into(),
                    "fetch_url".into(),
                    "web_search".into(),
                    "list_directory".into(),
                ],
                disallowed_tools: Vec::new(),
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            },
        );

        Self {
            definitions: Arc::new(RwLock::new(defs)),
            instances: Arc::new(RwLock::new(HashMap::new())),
            persistent: Arc::new(RwLock::new(HashMap::new())),
            runtime: RwLock::new(None),
            foreground_histories: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Inject the execution runtime (LLM + callbacks) so subagents can run
    /// autonomous turns. Called after the callback pipeline is assembled.
    pub async fn set_runtime(
        &self,
        llm: Arc<dyn crate::turn_loop::types::LLM>,
        callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    ) {
        *self.runtime.write().await = Some(Arc::new(SubagentRuntime { llm, callbacks }));
    }

    /// Current execution runtime, if injected.
    pub async fn runtime(&self) -> Option<Arc<SubagentRuntime>> {
        self.runtime.read().await.clone()
    }

    /// Register or update a subagent definition.
    pub async fn register_definition(&self, def: SubagentDefinition) {
        let mut defs = self.definitions.write().await;
        defs.insert(def.name.clone(), def);
    }

    /// Register the host-pushed profile catalog snapshot (P46). Called per
    /// turn with the session's profiles; same-name entries overwrite, so
    /// the freshest snapshot wins (session-level snapshot semantics, same
    /// as the policy snapshot).
    pub async fn register_profile_snapshot(
        &self,
        profiles: &[crate::rpc::types::SubagentProfileWire],
    ) {
        for profile in profiles {
            self.register_definition(SubagentDefinition {
                name: profile.name.clone(),
                description: profile.description.clone(),
                system_prompt: profile.system_prompt.clone(),
                tools: profile.tools.clone(),
                disallowed_tools: profile.disallowed_tools.clone(),
                prompt_prefix: profile.prompt_prefix.clone(),
                summary_policy: profile.summary_policy.clone(),
                model: None,
            })
            .await;
        }
    }

    /// Get a registered definition by name.
    pub async fn get_definition(&self, name: &str) -> Option<SubagentDefinition> {
        let defs = self.definitions.read().await;
        defs.get(name).cloned()
    }

    /// Spawn a new subagent instance.
    pub async fn spawn(&self, type_name: &str, role: &str) -> Result<String, String> {
        let defs = self.definitions.read().await;
        if !defs.contains_key(type_name) && type_name != "self" {
            return Err(format!("Unknown subagent type: '{type_name}'"));
        }

        let id = format!("subagent-{}", fastrand::u64(..));
        let cancellation = Arc::new(AtomicBool::new(false));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let instance = SubagentInstance {
            id: id.clone(),
            type_name: type_name.to_string(),
            role: role.to_string(),
            state: SubagentState::Running,
            created_at_ms: now_ms,
            last_result: None,
        };

        let mut instances = self.instances.write().await;
        instances.insert(id.clone(), (instance, cancellation));

        Ok(id)
    }

    /// Spawn a new subagent and launch an autonomous background execution loop.
    pub async fn spawn_and_run(
        self: &Arc<Self>,
        type_name: &str,
        role: &str,
        prompt: &str,
        llm: Arc<dyn crate::turn_loop::types::LLM>,
        callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    ) -> Result<String, String> {
        let id = self.spawn(type_name, role).await?;
        let def = self
            .get_definition(type_name)
            .await
            .unwrap_or_else(|| SubagentDefinition {
                name: type_name.to_string(),
                description: format!("Dynamic subagent for {role}"),
                system_prompt: format!("You are {role}. Complete the user's task accurately."),
                tools: vec![
                    "read".into(),
                    "grep".into(),
                    "glob".into(),
                    "fetch_url".into(),
                    "web_search".into(),
                    "list_directory".into(),
                ],
                disallowed_tools: Vec::new(),
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            });

        let mgr = self.clone();
        let subagent_id = id.clone();
        let prompt_str = prompt.to_string();
        let subagent_role = role.to_string();

        let cancel_flag = {
            let instances = mgr.instances.read().await;
            instances.get(&subagent_id).map(|(_, c)| c.clone())
        };

        tokio::spawn(async move {
            let turn_id = format!("subturn-{}", fastrand::u64(..));
            let messages = vec![crate::turn_loop::types::LLMMessage {
                role: "user".into(),
                content: format!("{}\n\nTask: {}", def.system_prompt, prompt_str),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }];

            let run_input = crate::turn_loop::types::RunTurnInput {
                turn_id,
                llm: llm.as_ref(),
                messages,
                tools: &[],
                tool_defs: Vec::new(),
                max_steps: 15,
                max_context_tokens: None,
                goal: None,
                cancellation: cancel_flag,
            };

            let run_result = crate::turn_loop::run_turn::run_turn(run_input, &callbacks)
                .await
                .map_err(|e| e.to_string());

            match run_result {
                Ok(turn_res) => {
                    let result_text = format!(
                        "Subagent '{}' finished in {} steps (Tokens: {}).",
                        subagent_role, turn_res.steps, turn_res.usage.total_tokens
                    );
                    mgr.update_state(&subagent_id, SubagentState::Completed, Some(result_text))
                        .await;
                }
                Err(err_msg) => {
                    mgr.update_state(
                        &subagent_id,
                        SubagentState::Failed,
                        Some(format!("Error: {err_msg}")),
                    )
                    .await;
                }
            }
        });

        Ok(id)
    }

    /// Run one foreground subagent turn inline (v2 `Agent` tool foreground
    /// semantics): the caller awaits the full turn and formats the result.
    /// The instance must already exist (see [`Self::spawn`]). Cancellation
    /// is event-driven (P51) — see [`run_one`]; a parent cancel that lands
    /// between awaits degrades to the engine's step-boundary abort.
    pub async fn run_foreground_turn(
        &self,
        id: &str,
        prompt: &str,
        parent_cancel: Option<&crate::subagent::types::ParentCancel>,
    ) -> Result<ForegroundTurnOutcome, String> {
        let (cancel_flag, type_name, role) = {
            let instances = self.instances.read().await;
            let (instance, flag) = instances
                .get(id)
                .ok_or_else(|| format!("Unknown subagent instance: '{id}'"))?;
            (
                flag.clone(),
                instance.type_name.clone(),
                instance.role.clone(),
            )
        };
        if parent_cancel.is_some_and(|signal| signal.triggered()) {
            let _ = self.kill(id).await;
            return Ok(ForegroundTurnOutcome::ParentCancelled);
        }
        let runtime = self
            .runtime()
            .await
            .ok_or_else(|| "no subagent runtime injected".to_string())?;
        let def = self.definition_for(&type_name, &role).await;

        // The subagent sees the host table narrowed by its profile policy
        // (v2 `resolveActiveToolNames` subset): an explicit allowlist wins,
        // otherwise every tool except the disallowed names. Effective on
        // native transports; host-proxy rebuilds the table host-side.
        let filter = ToolPolicyFilter::from_definition(&def);
        let tool_defs = match runtime.callbacks.list_tools().await {
            Ok(response) => response
                .tools
                .into_iter()
                .filter(|tool| filter.allows(&tool.name))
                .collect(),
            Err(_) => Vec::new(),
        };
        let callbacks: Arc<dyn crate::callbacks::HostCallbacks> = Arc::new(ToolFilterCallbacks {
            inner: runtime.callbacks.clone(),
            filter,
        });

        // v2 `applyProfilePromptPrefix`: the prefix rides ahead of the
        // prompt as `{prefix}\n\n{prompt}`.
        let prompt = match def.prompt_prefix.as_deref() {
            Some(prefix) if !prefix.trim().is_empty() => format!("{prefix}\n\n{prompt}"),
            _ => prompt.to_string(),
        };

        let messages = vec![crate::turn_loop::types::LLMMessage {
            role: "user".into(),
            content: format!("{}\n\nTask: {}", def.system_prompt, prompt),
            blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }];

        let outcome: Result<crate::turn_loop::types::TurnResult, RunExit> = async {
            let turn_res = run_one(
                &runtime,
                &callbacks,
                messages.clone(),
                tool_defs.clone(),
                &cancel_flag,
                parent_cancel,
            )
            .await?;
            // v2 `classifyTurnResult`: a max-token-truncated turn fails the
            // run before any distillation attempt.
            if matches!(
                turn_res.stop_reason,
                crate::turn_loop::types::LoopTurnStopReason::MaxTokens
            ) {
                return Err(RunExit::Failed(SUBAGENT_MAX_TOKENS_ERROR.into()));
            }
            match &def.summary_policy {
                Some(policy) => {
                    distill_continuations(
                        &runtime,
                        &callbacks,
                        tool_defs.clone(),
                        &cancel_flag,
                        parent_cancel,
                        turn_res,
                        policy,
                    )
                    .await
                }
                None => Ok(turn_res),
            }
        }
        .await;

        match outcome {
            Ok(turn_res) => {
                let summary = final_assistant_summary(&turn_res.messages);
                self.update_state(id, SubagentState::Completed, Some(summary))
                    .await;
                // P55: keep the conversation for native `resume` calls.
                self.foreground_histories
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        id.to_string(),
                        ForegroundResume {
                            profile_name: type_name.clone(),
                            role: role.clone(),
                            messages: turn_res.messages.clone(),
                        },
                    );
                Ok(ForegroundTurnOutcome::Completed(turn_res))
            }
            Err(RunExit::ParentCancelled) => {
                let _ = self.kill(id).await;
                Ok(ForegroundTurnOutcome::ParentCancelled)
            }
            Err(RunExit::Failed(message)) => {
                self.update_state(id, SubagentState::Failed, Some(format!("Error: {message}")))
                    .await;
                Err(message)
            }
        }
    }

    /// Native `resume` (P55): continue a previously foreground-completed
    /// subagent conversation. The resume appends the prompt to the stored
    /// history and runs one more turn under the same profile policy. Unknown
    /// ids answer `None` — the caller falls back to the host, which owns the
    /// v2 persistent-scope resume semantics.
    pub async fn resume_foreground_turn(
        &self,
        id: &str,
        prompt: &str,
        parent_cancel: Option<&crate::subagent::types::ParentCancel>,
    ) -> Option<Result<ForegroundTurnOutcome, String>> {
        let record = {
            let histories = self
                .foreground_histories
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            histories.get(id).cloned()?
        };
        let runtime = self.runtime().await?;
        let def = self
            .definition_for(&record.profile_name, &record.role)
            .await;
        let filter = ToolPolicyFilter::from_definition(&def);
        let tool_defs = match runtime.callbacks.list_tools().await {
            Ok(response) => response
                .tools
                .into_iter()
                .filter(|tool| filter.allows(&tool.name))
                .collect(),
            Err(_) => Vec::new(),
        };
        let callbacks: Arc<dyn crate::callbacks::HostCallbacks> = Arc::new(ToolFilterCallbacks {
            inner: runtime.callbacks.clone(),
            filter,
        });

        let messages = {
            let mut history = record.messages.clone();
            history.push(crate::turn_loop::types::LLMMessage {
                role: "user".into(),
                content: prompt.to_string(),
                ..Default::default()
            });
            history
        };
        let turn_res = match run_one(
            &runtime,
            &callbacks,
            messages.clone(),
            tool_defs.clone(),
            &Arc::new(AtomicBool::new(false)),
            parent_cancel,
        )
        .await
        {
            Ok(turn) => turn,
            // The parent-cancelled outcome flows through verbatim so the
            // tool result carries the v2 user-interruption message.
            Err(RunExit::ParentCancelled) => {
                return Some(Ok(ForegroundTurnOutcome::ParentCancelled));
            }
            Err(RunExit::Failed(message)) => return Some(Err(message)),
        };
        if matches!(
            turn_res.stop_reason,
            crate::turn_loop::types::LoopTurnStopReason::MaxTokens
        ) {
            return Some(Err(SUBAGENT_MAX_TOKENS_ERROR.to_string()));
        }
        // P60: resume turns distill under the same policy as the initial
        // run (v2 runs every subagent turn through `distillSummary`).
        let turn_res = match &def.summary_policy {
            Some(policy) => {
                let distilled = distill_continuations(
                    &runtime,
                    &callbacks,
                    tool_defs,
                    &Arc::new(AtomicBool::new(false)),
                    parent_cancel,
                    turn_res,
                    policy,
                )
                .await;
                match distilled {
                    Ok(turn) => turn,
                    Err(RunExit::ParentCancelled) => {
                        return Some(Ok(ForegroundTurnOutcome::ParentCancelled));
                    }
                    Err(RunExit::Failed(message)) => return Some(Err(message)),
                }
            }
            None => turn_res,
        };

        let summary = final_assistant_summary(&turn_res.messages);
        self.update_state(id, SubagentState::Completed, Some(summary.clone()))
            .await;
        self.foreground_histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.to_string(),
                ForegroundResume {
                    profile_name: record.profile_name.clone(),
                    role: record.role.clone(),
                    messages: turn_res.messages.clone(),
                },
            );
        Some(Ok(ForegroundTurnOutcome::Completed(turn_res)))
    }

    /// The profile a native resume record was spawned under (for the v2
    /// `actual_subagent_type` line in the resume result).
    pub async fn resume_profile(&self, id: &str) -> Option<String> {
        self.foreground_histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|record| record.profile_name.clone())
    }

    /// Spawn a persistent subagent instance that keeps its message history
    /// across turns. The instance is registered in the instance map with its
    /// own cancellation flag, so the existing `kill` mechanism aborts any
    /// running turn and blocks further ones.
    pub async fn spawn_persistent(
        &self,
        type_name: &str,
        role: &str,
        llm: Arc<dyn crate::turn_loop::types::LLM>,
        callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    ) -> Result<String, String> {
        let defs = self.definitions.read().await;
        if !defs.contains_key(type_name) && type_name != "self" {
            return Err(format!("Unknown subagent type: '{type_name}'"));
        }
        drop(defs);

        let def = self.definition_for(type_name, role).await;
        let id = format!("subagent-{}", fastrand::u64(..));
        let cancellation = Arc::new(AtomicBool::new(false));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let instance = SubagentInstance {
            id: id.clone(),
            type_name: type_name.to_string(),
            role: role.to_string(),
            state: SubagentState::Running,
            created_at_ms: now_ms,
            last_result: None,
        };

        {
            let mut instances = self.instances.write().await;
            instances.insert(id.clone(), (instance, cancellation.clone()));
        }
        {
            let mut persistent = self.persistent.write().await;
            persistent.insert(
                id.clone(),
                PersistentInstance {
                    llm,
                    callbacks,
                    system_prompt: def.system_prompt,
                    messages: Vec::new(),
                    usage: crate::rpc::types::TokenUsage::default(),
                    running: false,
                    cancelled: cancellation,
                },
            );
        }

        Ok(id)
    }

    /// Run one turn on a persistent instance: append the prompt to the
    /// instance's message history and execute a full `run_turn` with that
    /// history. The turn runs with the caller-supplied LLM and callbacks;
    /// the instance's spawn-time context is recorded in
    /// [`PersistentInstance`]. Concurrent turns on the same instance are
    /// rejected, and a `kill` that lands mid-turn aborts the loop.
    pub async fn run_persistent_turn(
        &self,
        id: &str,
        prompt: &str,
        llm: Arc<dyn crate::turn_loop::types::LLM>,
        callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    ) -> Result<crate::turn_loop::types::TurnResult, String> {
        // Claim the instance before any work starts: unknown ids, concurrent
        // turns, and terminated instances are rejected up front.
        let (cancel_flag, system_prompt, history) = {
            let mut persistent = self.persistent.write().await;
            let entry = persistent
                .get_mut(id)
                .ok_or_else(|| format!("Unknown persistent subagent: '{id}'"))?;
            if entry.running {
                return Err(format!(
                    "Persistent subagent '{id}' is already running a turn"
                ));
            }
            if entry.cancelled.load(Ordering::SeqCst) {
                return Err(format!("Persistent subagent '{id}' has been terminated"));
            }
            entry.running = true;
            (
                entry.cancelled.clone(),
                entry.system_prompt.clone(),
                entry.messages.clone(),
            )
        };
        self.update_state(id, SubagentState::Running, None).await;

        // The first turn carries the definition's system prompt; later turns
        // append the raw prompt so the role text is not repeated.
        let user_content = if history.is_empty() && !system_prompt.is_empty() {
            format!("{system_prompt}\n\n{prompt}")
        } else {
            prompt.to_string()
        };
        let mut messages = history;
        messages.push(crate::turn_loop::types::LLMMessage {
            role: "user".into(),
            content: user_content.clone(),
            ..Default::default()
        });

        // Wrap the LLM so the final assistant response can be appended to
        // the instance history after the turn (TurnResult carries no content).
        let recording = RecordingLlm::new(llm);
        let turn_id = format!("subturn-{}", fastrand::u64(..));
        let run_input = crate::turn_loop::types::RunTurnInput {
            turn_id,
            llm: &recording,
            messages,
            tools: &[],
            tool_defs: Vec::new(),
            max_steps: 15,
            max_context_tokens: None,
            goal: None,
            cancellation: Some(cancel_flag.clone()),
        };
        let run_result = crate::turn_loop::run_turn::run_turn(run_input, &callbacks)
            .await
            .map_err(|e| e.to_string());

        match run_result {
            Ok(turn) => {
                let assistant_content = recording.last_content();
                {
                    let mut persistent = self.persistent.write().await;
                    if let Some(entry) = persistent.get_mut(id) {
                        entry.running = false;
                        entry.usage = add_usage(&entry.usage, &turn.usage);
                        entry.messages.push(crate::turn_loop::types::LLMMessage {
                            role: "user".into(),
                            content: user_content,
                            ..Default::default()
                        });
                        if let Some(content) = assistant_content {
                            entry.messages.push(crate::turn_loop::types::LLMMessage {
                                role: "assistant".into(),
                                content,
                                ..Default::default()
                            });
                        }
                    }
                }
                // A kill that landed mid-turn keeps the Terminated state.
                if !cancel_flag.load(Ordering::SeqCst) {
                    let summary = format!(
                        "Turn finished in {} steps (Tokens: {}).",
                        turn.steps, turn.usage.total_tokens
                    );
                    self.update_state(id, SubagentState::Idle, Some(summary))
                        .await;
                }
                Ok(turn)
            }
            Err(err_msg) => {
                {
                    let mut persistent = self.persistent.write().await;
                    if let Some(entry) = persistent.get_mut(id) {
                        entry.running = false;
                    }
                }
                self.update_state(id, SubagentState::Failed, Some(format!("Error: {err_msg}")))
                    .await;
                Err(err_msg)
            }
        }
    }

    /// Cumulative token usage of a persistent instance across all turns.
    /// Unknown ids report zero usage.
    pub async fn get_persistent_usage(&self, id: &str) -> crate::rpc::types::TokenUsage {
        let persistent = self.persistent.read().await;
        persistent
            .get(id)
            .map(|entry| entry.usage.clone())
            .unwrap_or_default()
    }

    /// Terminate and remove a persistent instance: sets its cancellation
    /// flag (aborting any running turn) and drops it from both the instance
    /// map and the persistent map. Returns true if the instance existed.
    pub async fn destroy_persistent(&self, id: &str) -> bool {
        let removed = {
            let mut persistent = self.persistent.write().await;
            match persistent.remove(id) {
                Some(entry) => {
                    entry.cancelled.store(true, Ordering::SeqCst);
                    true
                }
                None => false,
            }
        };
        if removed {
            let mut instances = self.instances.write().await;
            instances.remove(id);
        }
        removed
    }

    /// Resolve a definition by name, falling back to a dynamic definition
    /// for ad-hoc types (e.g. `self`), mirroring `spawn_and_run`.
    async fn definition_for(&self, type_name: &str, role: &str) -> SubagentDefinition {
        self.get_definition(type_name)
            .await
            .unwrap_or_else(|| SubagentDefinition {
                name: type_name.to_string(),
                description: format!("Dynamic subagent for {role}"),
                system_prompt: format!("You are {role}. Complete the user's task accurately."),
                tools: vec![
                    "read".into(),
                    "grep".into(),
                    "glob".into(),
                    "fetch_url".into(),
                    "web_search".into(),
                    "list_directory".into(),
                ],
                disallowed_tools: Vec::new(),
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
    }

    /// Retrieve an instance snapshot by ID.
    pub async fn get_instance(&self, id: &str) -> Option<SubagentInstance> {
        let instances = self.instances.read().await;
        instances.get(id).map(|(inst, _)| inst.clone())
    }

    /// Update the state of a subagent instance.
    pub async fn update_state(&self, id: &str, state: SubagentState, result: Option<String>) {
        let mut instances = self.instances.write().await;
        if let Some((inst, _)) = instances.get_mut(id) {
            inst.state = state;
            if result.is_some() {
                inst.last_result = result;
            }
        }
    }

    /// Terminate a running subagent by setting its cancellation flag.
    pub async fn kill(&self, id: &str) -> Result<bool, String> {
        let mut instances = self.instances.write().await;
        if let Some((inst, cancel_flag)) = instances.get_mut(id) {
            cancel_flag.store(true, Ordering::SeqCst);
            inst.state = SubagentState::Terminated;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// List summaries of all subagent instances.
    pub async fn list(&self) -> Vec<SubagentSummary> {
        let instances = self.instances.read().await;
        let mut list: Vec<SubagentSummary> = instances
            .values()
            .map(|(inst, _)| SubagentSummary {
                id: inst.id.clone(),
                type_name: inst.type_name.clone(),
                role: inst.role.clone(),
                state: inst.state,
                created_at_ms: inst.created_at_ms,
            })
            .collect();
        list.sort_by_key(|s| std::cmp::Reverse(s.created_at_ms));
        list
    }
}

/// LLM wrapper that records the content of the final assistant response so
/// a persistent instance can append it to its message history after a turn.
struct RecordingLlm {
    inner: Arc<dyn crate::turn_loop::types::LLM>,
    last_content: Arc<Mutex<Option<String>>>,
}

impl RecordingLlm {
    fn new(inner: Arc<dyn crate::turn_loop::types::LLM>) -> Self {
        Self {
            inner,
            last_content: Arc::new(Mutex::new(None)),
        }
    }

    fn last_content(&self) -> Option<String> {
        self.last_content.lock().unwrap().clone()
    }
}

impl crate::turn_loop::types::LLM for RecordingLlm {
    fn system_prompt(&self) -> &str {
        self.inner.system_prompt()
    }

    fn model_name(&self) -> &str {
        self.inner.model_name()
    }

    fn is_retryable_error(&self, error: &str) -> bool {
        self.inner.is_retryable_error(error)
    }

    fn transport(&self) -> &'static str {
        self.inner.transport()
    }

    fn chat(
        &self,
        params: crate::turn_loop::types::LLMChatParams,
    ) -> crate::rpc::types::BoxFuture<
        '_,
        Result<crate::turn_loop::types::LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>,
    > {
        let inner = self.inner.clone();
        let last_content = self.last_content.clone();
        Box::pin(async move {
            let response = inner.chat(params).await?;
            if !response.content.is_empty() {
                *last_content.lock().unwrap() = Some(response.content.clone());
            }
            Ok(response)
        })
    }
}

/// Sum two token usage records field by field.
fn add_usage(
    a: &crate::rpc::types::TokenUsage,
    b: &crate::rpc::types::TokenUsage,
) -> crate::rpc::types::TokenUsage {
    crate::rpc::types::TokenUsage {
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        total_tokens: a.total_tokens + b.total_tokens,
        input_cache_read: a.input_cache_read + b.input_cache_read,
        input_cache_creation: a.input_cache_creation + b.input_cache_creation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use tokio::sync::Notify;

    #[tokio::test]
    async fn test_subagent_lifecycle() {
        let manager = SubagentManager::new();

        // Check built-in research definition
        let def = manager.get_definition("research").await.unwrap();
        assert_eq!(def.name, "research");
        assert!(def.tools.contains(&"fetch_url".to_string()));

        // Spawn a research subagent
        let id = manager
            .spawn("research", "Documentation Researcher")
            .await
            .unwrap();

        let list = manager.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].state, SubagentState::Running);

        // Update state
        manager
            .update_state(&id, SubagentState::Completed, Some("Found 5 docs".into()))
            .await;

        let list = manager.list().await;
        assert_eq!(list[0].state, SubagentState::Completed);

        // Kill subagent
        assert!(manager.kill(&id).await.unwrap());
        let list = manager.list().await;
        assert_eq!(list[0].state, SubagentState::Terminated);
    }

    struct MockSubagentLlm;
    impl crate::turn_loop::types::LLM for MockSubagentLlm {
        fn system_prompt(&self) -> &str {
            "mock system prompt"
        }
        fn model_name(&self) -> &str {
            "mock-subagent-model"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<
            '_,
            Result<
                crate::turn_loop::types::LLMChatResponse,
                Box<dyn std::error::Error + Send + Sync>,
            >,
        > {
            Box::pin(async {
                Ok(crate::turn_loop::types::LLMChatResponse {
                    content: "Autonomous research result complete.".into(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: crate::rpc::types::TokenUsage {
                        input_tokens: 10,
                        output_tokens: 15,
                        total_tokens: 25,
                        input_cache_read: 0,
                        input_cache_creation: 0,
                    },
                })
            })
        }
    }

    struct MockCallbacks;
    impl crate::callbacks::HostCallbacks for MockCallbacks {
        fn llm_chat(
            &self,
            _req: crate::rpc::types::LlmChatRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::LlmChatResponse, String>,
        > {
            Box::pin(async { Err("Not needed in mock".into()) })
        }
        fn execute_tool(
            &self,
            _req: crate::rpc::types::ToolExecuteRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async { Err("Not needed in mock".into()) })
        }
        fn check_permission(
            &self,
            _req: crate::rpc::types::PermissionCheckRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async { Ok(crate::rpc::types::PermissionDecision::allow()) })
        }
    }

    #[tokio::test]
    async fn test_subagent_spawn_and_run() {
        let manager = Arc::new(SubagentManager::new());
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);

        let id = manager
            .spawn_and_run(
                "research",
                "Automated Codebase Scanner",
                "Investigate main loop architecture",
                llm,
                callbacks,
            )
            .await
            .unwrap();

        // Allow background Tokio task to execute run_turn
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if let Some(inst) = manager.get_instance(&id).await
                && inst.state == SubagentState::Completed
            {
                assert!(inst.last_result.is_some());
                assert!(inst.last_result.unwrap().contains("finished in"));
                return;
            }
        }

        panic!("Subagent did not reach Completed state within timeout");
    }

    #[tokio::test]
    async fn test_subagent_runtime_injection() {
        let manager = Arc::new(SubagentManager::new());
        assert!(manager.runtime().await.is_none());

        let llm: Arc<dyn crate::turn_loop::types::LLM> = Arc::new(MockSubagentLlm);
        let callbacks: Arc<dyn crate::callbacks::HostCallbacks> = Arc::new(MockCallbacks);
        manager.set_runtime(llm.clone(), callbacks.clone()).await;

        let runtime = manager.runtime().await.expect("runtime injected");
        assert!(Arc::ptr_eq(&runtime.llm, &llm));
        assert!(Arc::ptr_eq(&runtime.callbacks, &callbacks));
    }

    /// Mock LLM that records how many messages each chat call received, so
    /// tests can assert that persistent turns reuse the instance history.
    struct RecordingMockLlm {
        counts: Arc<Mutex<Vec<usize>>>,
    }

    impl RecordingMockLlm {
        fn new() -> Self {
            Self {
                counts: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn message_counts(&self) -> Vec<usize> {
            self.counts.lock().unwrap().clone()
        }
    }

    impl crate::turn_loop::types::LLM for RecordingMockLlm {
        fn system_prompt(&self) -> &str {
            "mock system prompt"
        }
        fn model_name(&self) -> &str {
            "mock-subagent-model"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<
            '_,
            Result<
                crate::turn_loop::types::LLMChatResponse,
                Box<dyn std::error::Error + Send + Sync>,
            >,
        > {
            let counts = self.counts.clone();
            Box::pin(async move {
                counts.lock().unwrap().push(params.messages.len());
                Ok(crate::turn_loop::types::LLMChatResponse {
                    content: "Autonomous research result complete.".into(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: crate::rpc::types::TokenUsage {
                        input_tokens: 10,
                        output_tokens: 15,
                        total_tokens: 25,
                        input_cache_read: 0,
                        input_cache_creation: 0,
                    },
                })
            })
        }
    }

    /// Mock LLM whose first chat call blocks until released, so tests can
    /// hold a turn open while asserting on the concurrent-turn guard.
    struct BlockingLlm {
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    impl crate::turn_loop::types::LLM for BlockingLlm {
        fn system_prompt(&self) -> &str {
            "mock system prompt"
        }
        fn model_name(&self) -> &str {
            "mock-subagent-model"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<
            '_,
            Result<
                crate::turn_loop::types::LLMChatResponse,
                Box<dyn std::error::Error + Send + Sync>,
            >,
        > {
            let entered = self.entered.clone();
            let release = self.release.clone();
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                Ok(crate::turn_loop::types::LLMChatResponse {
                    content: "done".into(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: crate::rpc::types::TokenUsage {
                        input_tokens: 5,
                        output_tokens: 5,
                        total_tokens: 10,
                        input_cache_read: 0,
                        input_cache_creation: 0,
                    },
                })
            })
        }
    }

    /// Mock LLM that returns a tool call on its first chat, then blocks on
    /// the second — so a kill landing mid-turn is observed at the next step
    /// head instead of being masked by a completing response.
    struct ToolThenBlockLlm {
        calls: AtomicU32,
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    impl crate::turn_loop::types::LLM for ToolThenBlockLlm {
        fn system_prompt(&self) -> &str {
            "mock system prompt"
        }
        fn model_name(&self) -> &str {
            "mock-subagent-model"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<
            '_,
            Result<
                crate::turn_loop::types::LLMChatResponse,
                Box<dyn std::error::Error + Send + Sync>,
            >,
        > {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let entered = self.entered.clone();
            let release = self.release.clone();
            Box::pin(async move {
                if call == 0 {
                    Ok(crate::turn_loop::types::LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![crate::turn_loop::types::ToolCall {
                            id: "tc1".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({ "path": "/a.txt" }),
                        }],
                        finish_reason: Some("tool_calls".into()),
                        usage: crate::rpc::types::TokenUsage {
                            input_tokens: 10,
                            output_tokens: 5,
                            total_tokens: 15,
                            input_cache_read: 0,
                            input_cache_creation: 0,
                        },
                    })
                } else {
                    entered.notify_one();
                    release.notified().await;
                    Ok(crate::turn_loop::types::LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![crate::turn_loop::types::ToolCall {
                            id: "tc2".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({ "path": "/b.txt" }),
                        }],
                        finish_reason: Some("tool_calls".into()),
                        usage: crate::rpc::types::TokenUsage {
                            input_tokens: 5,
                            output_tokens: 5,
                            total_tokens: 10,
                            input_cache_read: 0,
                            input_cache_creation: 0,
                        },
                    })
                }
            })
        }
    }

    /// Callbacks whose tool executions always succeed, for tests that need
    /// the loop to survive a tool-call step.
    struct OkToolCallbacks;

    impl crate::callbacks::HostCallbacks for OkToolCallbacks {
        fn llm_chat(
            &self,
            _req: crate::rpc::types::LlmChatRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::LlmChatResponse, String>,
        > {
            Box::pin(async { Err("Not needed in mock".into()) })
        }
        fn execute_tool(
            &self,
            _req: crate::rpc::types::ToolExecuteRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async {
                Ok(crate::rpc::types::ToolExecuteResponse {
                    content: "ok".into(),
                    is_error: false,
                    note: None,
                })
            })
        }
        fn check_permission(
            &self,
            _req: crate::rpc::types::PermissionCheckRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async { Ok(crate::rpc::types::PermissionDecision::allow()) })
        }
    }

    #[tokio::test]
    async fn test_persistent_spawn_multi_turn_and_usage() {
        let manager = Arc::new(SubagentManager::new());
        let llm = Arc::new(RecordingMockLlm::new());
        let callbacks = Arc::new(MockCallbacks);

        let id = manager
            .spawn_persistent("research", "Researcher", llm.clone(), callbacks.clone())
            .await
            .unwrap();

        let turn1 = manager
            .run_persistent_turn(&id, "First question", llm.clone(), callbacks.clone())
            .await
            .unwrap();
        assert_eq!(turn1.usage.total_tokens, 25);

        let turn2 = manager
            .run_persistent_turn(&id, "Second question", llm.clone(), callbacks.clone())
            .await
            .unwrap();
        assert_eq!(turn2.usage.total_tokens, 25);

        // Usage aggregates across turns.
        let usage = manager.get_persistent_usage(&id).await;
        assert_eq!(usage.input_tokens, 20);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.total_tokens, 50);

        // History reuse: turn 1 saw system+user+injection (3 messages), turn 2
        // saw system+user+assistant+user+injection (5 messages). The
        // injection message is the turn-level date reminder.
        assert_eq!(llm.message_counts(), vec![3, 5]);

        // The instance is idle between turns and still listed.
        let inst = manager.get_instance(&id).await.unwrap();
        assert_eq!(inst.state, SubagentState::Idle);
        assert_eq!(manager.list().await.len(), 1);
    }

    #[tokio::test]
    async fn test_persistent_destroy() {
        let manager = Arc::new(SubagentManager::new());
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);

        let id = manager
            .spawn_persistent("research", "Researcher", llm.clone(), callbacks.clone())
            .await
            .unwrap();

        assert!(manager.destroy_persistent(&id).await);
        // Destroy is idempotent: a second call reports nothing to remove.
        assert!(!manager.destroy_persistent(&id).await);

        assert!(manager.get_instance(&id).await.is_none());
        assert_eq!(manager.list().await.len(), 0);
        assert_eq!(manager.get_persistent_usage(&id).await.total_tokens, 0);

        let err = manager
            .run_persistent_turn(&id, "hi", llm.clone(), callbacks.clone())
            .await
            .unwrap_err();
        assert!(err.contains("Unknown persistent subagent"));
    }

    #[tokio::test]
    async fn test_persistent_kill_blocks_further_turns() {
        let manager = Arc::new(SubagentManager::new());
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);

        let id = manager
            .spawn_persistent("research", "Researcher", llm.clone(), callbacks.clone())
            .await
            .unwrap();

        assert!(manager.kill(&id).await.unwrap());
        let inst = manager.get_instance(&id).await.unwrap();
        assert_eq!(inst.state, SubagentState::Terminated);

        let err = manager
            .run_persistent_turn(&id, "hi", llm.clone(), callbacks.clone())
            .await
            .unwrap_err();
        assert!(err.contains("terminated"));
    }

    #[tokio::test]
    async fn test_persistent_kill_aborts_running_turn() {
        let manager = Arc::new(SubagentManager::new());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let llm = Arc::new(ToolThenBlockLlm {
            calls: AtomicU32::new(0),
            entered: entered.clone(),
            release: release.clone(),
        });
        let callbacks = Arc::new(OkToolCallbacks);

        let id = manager
            .spawn_persistent("research", "Researcher", llm.clone(), callbacks.clone())
            .await
            .unwrap();

        let mgr = manager.clone();
        let turn_id = id.clone();
        let turn_llm = llm.clone();
        let turn_callbacks = callbacks.clone();
        let task = tokio::spawn(async move {
            mgr.run_persistent_turn(&turn_id, "long turn", turn_llm, turn_callbacks)
                .await
        });

        // Wait until the second LLM call is in flight, then kill mid-turn.
        entered.notified().await;
        assert!(manager.kill(&id).await.unwrap());
        release.notify_one();

        let turn = task.await.unwrap().unwrap();
        assert!(matches!(
            turn.stop_reason,
            crate::turn_loop::types::LoopTurnStopReason::Aborted
        ));

        // Usage from the completed steps is still aggregated.
        assert_eq!(manager.get_persistent_usage(&id).await.total_tokens, 25);

        // The kill's Terminated state is not overwritten by turn cleanup.
        let inst = manager.get_instance(&id).await.unwrap();
        assert_eq!(inst.state, SubagentState::Terminated);
    }

    #[tokio::test]
    async fn test_persistent_rejects_concurrent_turns() {
        let manager = Arc::new(SubagentManager::new());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let llm = Arc::new(BlockingLlm {
            entered: entered.clone(),
            release: release.clone(),
        });
        let callbacks = Arc::new(MockCallbacks);

        let id = manager
            .spawn_persistent("research", "Researcher", llm.clone(), callbacks.clone())
            .await
            .unwrap();

        let mgr = manager.clone();
        let turn_id = id.clone();
        let turn_llm = llm.clone();
        let turn_callbacks = callbacks.clone();
        let task = tokio::spawn(async move {
            mgr.run_persistent_turn(&turn_id, "first", turn_llm, turn_callbacks)
                .await
        });

        // Hold the first turn open and verify the second is rejected.
        entered.notified().await;
        let err = manager
            .run_persistent_turn(&id, "second", llm.clone(), callbacks.clone())
            .await
            .unwrap_err();
        assert!(err.contains("already running"));

        release.notify_one();
        let turn = task.await.unwrap().unwrap();
        assert!(matches!(
            turn.stop_reason,
            crate::turn_loop::types::LoopTurnStopReason::EndTurn
        ));

        let inst = manager.get_instance(&id).await.unwrap();
        assert_eq!(inst.state, SubagentState::Idle);
    }
}
