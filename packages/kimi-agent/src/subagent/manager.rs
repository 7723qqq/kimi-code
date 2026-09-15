//! Subagent lifecycle and concurrency manager.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::session::sqlite_store::SqliteSessionStore;
use crate::subagent::types::*;

type InstanceEntry = (SubagentInstance, Arc<AtomicBool>);
type InstanceMap = Arc<RwLock<HashMap<String, InstanceEntry>>>;
type DefinitionMap = Arc<RwLock<HashMap<String, SubagentDefinition>>>;
type PersistentMap = Arc<RwLock<HashMap<String, PersistentInstance>>>;

/// How many completed subagent scopes stay resident for a fast resume
/// (v2 `SUBAGENT_SCOPE_CACHE_SIZE_ENV`).
pub const SUBAGENT_SCOPE_CACHE_SIZE_ENV: &str = "KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE";

/// Wall-clock bound on a single scope eviction
/// (v2 `SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV`).
pub const SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV: &str = "KIMI_CODE_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS";

pub const DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE: usize = 32;

pub const DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS: u64 = 15_000;

/// How often one scope may refuse eviction before it is left resident
/// (v2 `MAX_EVICT_ATTEMPTS`).
const MAX_SCOPE_EVICT_ATTEMPTS: u32 = 3;

/// Parses `KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE` (v2
/// `resolveSubagentScopeCacheSize`). Missing or blank values yield the
/// default; a negative size means "never evict"; a non-integer errors.
pub fn resolve_subagent_scope_cache_size(env: &HashMap<String, String>) -> Result<usize, String> {
    let Some(raw) = env.get(SUBAGENT_SCOPE_CACHE_SIZE_ENV) else {
        return Ok(DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE);
    }
    match trimmed.parse::<i64>() {
        Ok(value) => Ok(value.max(0) as usize),
        Err(_) => Err(format!(
            "{SUBAGENT_SCOPE_CACHE_SIZE_ENV} must be an integer, got {raw:?}."
        )),
    }
}

/// Parses `KIMI_CODE_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS` (v2
/// `resolveSubagentScopeEvictTimeoutMs`). Missing or blank values yield the
/// default; anything but a positive integer errors.
pub fn resolve_subagent_scope_evict_timeout_ms(
    env: &HashMap<String, String>,
) -> Result<u64, String> {
    let Some(raw) = env.get(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV) else {
        return Ok(DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS);
    }
    match trimmed.parse::<u64>() {
        Ok(value) if value > 0 => Ok(value),
        _ => Err(format!(
            "{SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV} must be a positive integer, got {raw:?}."
        )),
    }
}

/// Why a scope eviction did or did not happen (v2 `EvictOutcome`).
enum EvictOutcome {
    Removed,
    Missing,
    /// The scope is running again; it stays retired and is retried later.
    Deferred,
    /// The eviction did not finish inside the configured bound.
    Timeout,
}

/// Completed-scope LRU (v2 `subagentScopeCacheService`): once more than
/// `capacity` completed scopes are resident, the oldest completion is
/// evicted. Only the resident instance and its in-memory conversation are
/// dropped — the persisted resume record is left alone, so the next `resume`
/// rebuilds both from it.
struct ScopeCache {
    capacity: usize,
    evict_timeout: Duration,
    /// Completed ids in least-recently-completed order, with the eviction
    /// attempts already spent on each (v2 `retired`).
    retired: Vec<(String, u32)>,
    /// Set when the two env vars failed validation; the first spawn reports
    /// it (v2 throws when the session scope is created).
    error: Option<String>,
}

impl ScopeCache {
    fn from_env() -> Self {
        let env: HashMap<String, String> = std::env::vars().collect();
        let resolved = resolve_subagent_scope_cache_size(&env).and_then(|capacity| {
            resolve_subagent_scope_evict_timeout_ms(&env).map(|timeout_ms| (capacity, timeout_ms))
        });
        match resolved {
            Ok((capacity, timeout_ms)) => Self {
                capacity,
                evict_timeout: Duration::from_millis(timeout_ms),
                retired: Vec::new(),
                error: None,
            },
            Err(error) => Self {
                capacity: DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE,
                evict_timeout: Duration::from_millis(DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS),
                retired: Vec::new(),
                error: Some(error),
            },
        }
    }

    /// Move `id` to the most-recently-completed end (v2 `retire`).
    fn retire(&mut self, id: &str) {
        self.retired.retain(|(entry, _)| entry != id);
        self.retired.push((id.to_string(), 0));
    }

    /// Drop `id` from the LRU (v2 `revive`): a scope that is live again must
    /// not be evicted.
    fn revive(&mut self, id: &str) {
        self.retired.retain(|(entry, _)| entry != id);
    }

    /// The oldest entry still worth trying, skipping the ones this pass
    /// already failed on and the ones that exhausted their attempts
    /// (v2 `oldestCandidate`).
    fn oldest_candidate(&self, skipped: &HashSet<String>) -> Option<(String, u32)> {
        self.retired
            .iter()
            .find(|(id, attempts)| *attempts < MAX_SCOPE_EVICT_ATTEMPTS && !skipped.contains(id))
            .cloned()
    }

    fn remove(&mut self, id: &str) {
        self.retired.retain(|(entry, _)| entry != id);
    }

    fn reinsert(&mut self, id: &str, attempts: u32) {
        if !self.retired.iter().any(|(entry, _)| entry == id) {
            self.retired.push((id.to_string(), attempts));
        }
    }
}

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

    /// The allowlist-only form (v2 `resolveActiveToolNames`): evaluates a
    /// profile's declared names against that same allowlist, for rendering
    /// what the profile actually admits.
    pub fn from_allowlist(tools: &[String]) -> Self {
        Self {
            allowlist: tools.to_vec(),
            disallowed: Vec::new(),
        }
    }

    /// Whether the profile admits `tool_name` (v2 `isToolActive`): an
    /// explicit allowlist wins, otherwise every tool except the disallowed
    /// names. Tool names are matched with the same source-dependent rule as
    /// the global `[tools]` switch — MCP patterns are globs
    /// (`mcp__*` / `mcp__github__*`), built-ins match exactly and
    /// case-insensitively (the engine dispatches on the lowercase wire name
    /// while profile tables spell them `Read`).
    pub fn allows(&self, tool_name: &str) -> bool {
        let matches = |pattern: &str| {
            if pattern.starts_with("mcp__") {
                crate::tools::tool_policy::matches_tool_pattern(pattern, tool_name)
            } else {
                pattern.eq_ignore_ascii_case(tool_name)
            }
        };
        if !self.allowlist.is_empty() {
            return self.allowlist.iter().any(|pattern| matches(pattern));
        }
        !self.disallowed.iter().any(|pattern| matches(pattern))
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
    /// The parent session this runtime was built for, so background
    /// subagent tasks attribute their lifecycle events to the right lane.
    pub session_id: Option<String>,
}

pub struct SubagentManager {
    definitions: DefinitionMap,
    instances: InstanceMap,
    persistent: PersistentMap,
    runtime: RwLock<Option<Arc<SubagentRuntime>>>,
    /// Per-instance LLM bindings (`[secondary_model]` pool choices), keyed by
    /// instance id. Absent = inherit the session runtime LLM.
    instance_llms: Arc<RwLock<HashMap<String, Arc<dyn crate::turn_loop::types::LLM>>>>,
    /// P55: accumulated conversation history per foreground agent id, so a
    /// `resume` call continues the same subagent natively (v2 persistent
    /// scopes). Written on foreground completion; read by `resume` calls.
    foreground_histories: Arc<Mutex<HashMap<String, ForegroundResume>>>,
    /// Optional SQLite store for cold resume across restarts (#3478).
    session_store: RwLock<Option<Arc<SqliteSessionStore>>>,
    /// Optional TaskRunner for background subagent task management and inspection.
    task_runner: RwLock<Option<Arc<crate::storage::TaskRunner>>>,
    /// Host-resolved `[swarm] timeout_ms` (v2 `resolveSwarmTimeoutMs`; env
    /// `KIMI_CODE_SWARM_TIMEOUT_MS` wins host-side). Rides the manager because
    /// the toolset dispatch passes the `Agent` timeout to both tools — the
    /// swarm-specific value is read at `AgentSwarm` execution time.
    /// `None` keeps the previous behavior: the swarm follows the subagent
    /// timeout (or the 2h default).
    swarm_timeout_ms: Mutex<Option<u64>>,
    /// Completed-scope LRU (v2 `subagentScopeCache`), resolved once at
    /// construction.
    scope_cache: Mutex<ScopeCache>,
}

/// A foreground subagent's resume record (P55).
#[derive(Clone)]
struct ForegroundResume {
    profile_name: String,
    role: String,
    messages: Vec<crate::turn_loop::types::LLMMessage>,
}

/// Persisted state for subagent cold resume (#3478).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentPersistedState {
    pub id: String,
    pub profile_name: String,
    pub role: String,
    pub messages: Vec<crate::turn_loop::types::LLMMessage>,
    pub updated_at: i64,
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
        max_attempts: None,
        turn_id: format!("subturn-{}", fastrand::u64(..)),
        llm: runtime.llm.as_ref(),
        messages,
        tools: &[],
        tool_defs,
        // Foreground subagents run until done — the caller owns the
        // timeout (v2 `resolveSubagentTimeoutMs`), not a step cap.
        max_steps: u32::MAX,
        max_context_tokens: None,
        compaction_max_attempts: None,
        // Subagent turns carry no policy snapshot, and the reminders address
        // the main agent's user interaction (AskUserQuestion / ExitPlanMode).
        permission_mode: None,
        goal: None,
        cancellation: Some(cancel_flag.clone()),
        // Lifecycle hooks (`UserPromptSubmit` / `PreCompact` / `Stop`) are
        // main-turn scoped by design; subagent turns skip them here while
        // `PreToolUse` gating still applies through the tool callbacks.
        // Keep `run_turn` (not `run_turn_continued`) for the same reason.
        hook_guard: None,
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

        // Pre-register the standard builtin profiles (agent / coder / explore
        // / plan) so spawn lookups resolve them in every transport path. v2
        // registers these from its profile catalog; the Rust side had
        // `register_builtin_profiles` but it was only called from tests,
        // leaving TowerSpawn / AgentSwarm / Team / Agent with builtin
        // profiles to fail with "not available" on every host.
        for p in crate::prompt::ProfileCatalog::with_builtins().list() {
            defs.insert(
                p.name.clone(),
                SubagentDefinition {
                    name: p.name.clone(),
                    description: p.description.clone(),
                    system_prompt: if p.role_additional.is_empty() {
                        format!("You are {}. Complete the user's task accurately.", p.name)
                    } else {
                        p.role_additional.clone()
                    },
                    tools: p.tools.iter().map(|t| t.to_lowercase()).collect(),
                    disallowed_tools: Vec::new(),
                    prompt_prefix: None,
                    summary_policy: None,
                    model: None,
                },
            );
        }

        // Tower worker profile (v2 `TOWER_WORKER_PROFILE_DEF`):
        // executes one tower mission in its own git worktree, coordinating
        // only through Tower* tools. Without this registration, every
        // `TowerSpawn` lookup returns None and the host falls back with
        // "not available". The role overlay emphasizes the handoff: the
        // worker's final message IS the entire handoff to the parent.
        let tower_worker_tools: Vec<String> = [
            "Agent",
            "Bash",
            "TowerFinding",
            "TowerInbox",
            "TowerMission",
            "TowerReview",
            "TowerSend",
            "TowerStatus",
            "CronCreate",
            "CronDelete",
            "CronList",
            "Edit",
            "EnterPlanMode",
            "ExitPlanMode",
            "Glob",
            "Grep",
            "Read",
            "Skill",
            "TaskList",
            "TaskOutput",
            "TaskStop",
            "TodoList",
            "WaitFor",
            "WebSearch",
            "FetchURL",
            "Write",
            "mcp__*",
        ]
        .iter()
        .map(|s| s.to_lowercase())
        .collect();
        const TOWER_WORKER_ROLE_OVERLAY: &str = "\
Tower worker protocol. Your final message is the entire handoff — the parent sees nothing \
else from your run. Make it technically complete: what you changed and why, the path of every \
file you touched, how you verified the change (tests or commands run, with results), and \
anything left undone or worth follow-up. Coordinate only through the Tower* tools; treat the \
worktree root the tower assigns you as your full authority scope.";
        defs.insert(
            "tower-worker".into(),
            SubagentDefinition {
                name: "tower-worker".into(),
                description: "Tower worker/reviewer agent — executes one tower mission in its own git worktree (or reviews one branch), coordinating only through Tower* tools. Spawned via the TowerSpawn tool.".into(),
                system_prompt: format!(
                    "{}\n\n{}",
                    "You are a tower worker. Complete the assigned mission accurately.",
                    TOWER_WORKER_ROLE_OVERLAY,
                ),
                tools: tower_worker_tools,
                disallowed_tools: Vec::new(),
                prompt_prefix: None,
                summary_policy: Some(crate::subagent::types::SummaryPolicy {
                    min_chars: 200,
                    continuation_prompt: "Your summary was too brief. Expand it: what you \
                        changed and why, the path of every file you touched, how you \
                        verified the change, and anything left undone or worth follow-up."
                        .into(),
                    retries: 1,
                }),
                model: None,
            },
        );

        Self {
            definitions: Arc::new(RwLock::new(defs)),
            instances: Arc::new(RwLock::new(HashMap::new())),
            persistent: Arc::new(RwLock::new(HashMap::new())),
            runtime: RwLock::new(None),
            foreground_histories: Arc::new(Mutex::new(HashMap::new())),
            instance_llms: Arc::new(RwLock::new(HashMap::new())),
            session_store: RwLock::new(None),
            task_runner: RwLock::new(None),
            swarm_timeout_ms: Mutex::new(None),
            scope_cache: Mutex::new(ScopeCache::from_env()),
        }
    }

    /// Host-pushed `[swarm] timeout_ms` for the native `AgentSwarm` tool (v2
    /// `resolveSwarmTimeoutMs`). `None` clears the override so the swarm
    /// falls back to the 2h swarm default; swarms never inherit the
    /// subagent timeout. `Some(0)` means "explicitly no timeout" and rides
    /// through — the tool maps it to the never-expiring sentinel (v2
    /// `taskService` arms only when `timeoutMs > 0`). Set per pipeline build.
    pub fn set_swarm_timeout_ms(&self, timeout_ms: Option<u64>) {
        *self
            .swarm_timeout_ms
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = timeout_ms;
    }

    /// The host-resolved swarm timeout, if any. Read at `AgentSwarm` execution.
    pub fn swarm_timeout_ms(&self) -> Option<u64> {
        *self
            .swarm_timeout_ms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Construct with a persistent TaskRunner for background subagents.
    pub fn with_task_runner(self, runner: Arc<crate::storage::TaskRunner>) -> Self {
        *self.task_runner.try_write().unwrap() = Some(runner);
        self
    }

    /// Inject or update TaskRunner asynchronously.
    pub async fn set_task_runner(&self, runner: Arc<crate::storage::TaskRunner>) {
        *self.task_runner.write().await = Some(runner);
    }

    /// Inject or update TaskRunner synchronously if possible.
    pub fn set_task_runner_sync(&self, runner: Arc<crate::storage::TaskRunner>) {
        if let Ok(mut guard) = self.task_runner.try_write() {
            *guard = Some(runner);
        }
    }

    /// Get the attached TaskRunner if present.
    pub async fn get_task_runner(&self) -> Option<Arc<crate::storage::TaskRunner>> {
        self.task_runner.read().await.clone()
    }

    /// Synchronously get the attached TaskRunner if the lock is immediately available.
    pub fn get_task_runner_sync(&self) -> Option<Arc<crate::storage::TaskRunner>> {
        self.task_runner.try_read().ok().and_then(|g| g.clone())
    }

    /// Construct with a persistent SQLite store for cold recovery (#3478).
    pub fn with_store(store: Arc<SqliteSessionStore>) -> Self {
        let manager = Self::new();
        *manager.session_store.try_write().unwrap() = Some(store);
        manager
    }

    /// Inject or update SQLite store.
    pub async fn set_session_store(&self, store: Arc<SqliteSessionStore>) {
        *self.session_store.write().await = Some(store);
    }

    /// Register standard builtin profiles from ProfileCatalog (agent, coder, explore, plan).
    pub async fn register_builtin_profiles(&self) {
        let catalog = crate::prompt::ProfileCatalog::with_builtins();
        for p in catalog.list() {
            self.register_definition(SubagentDefinition {
                name: p.name.clone(),
                description: p.description.clone(),
                system_prompt: if p.role_additional.is_empty() {
                    format!("You are {}. Complete the user's task accurately.", p.name)
                } else {
                    p.role_additional.clone()
                },
                tools: p.tools.iter().map(|t| t.to_lowercase()).collect(),
                disallowed_tools: Vec::new(),
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        }
    }

    /// Bind one subagent instance to a specific LLM (the `[secondary_model]`
    /// pool choice). The run paths prefer this over the session runtime LLM,
    /// so concurrent subagents can run on different models; unbound instances
    /// keep inheriting the session model.
    pub async fn set_instance_llm(&self, id: &str, llm: Arc<dyn crate::turn_loop::types::LLM>) {
        self.instance_llms.write().await.insert(id.to_string(), llm);
    }

    async fn instance_llm(&self, id: &str) -> Option<Arc<dyn crate::turn_loop::types::LLM>> {
        self.instance_llms.read().await.get(id).cloned()
    }

    /// Inject the execution runtime (LLM + callbacks) so subagents can run
    /// autonomous turns. Called after the callback pipeline is assembled.
    pub async fn set_runtime(
        &self,
        llm: Arc<dyn crate::turn_loop::types::LLM>,
        callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
        session_id: Option<String>,
    ) {
        *self.runtime.write().await = Some(Arc::new(SubagentRuntime {
            llm,
            callbacks,
            session_id,
        }));
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
        let id = format!("subagent-{}", fastrand::u64(..));
        self.spawn_with_id(&id, type_name, role).await
    }

    /// Spawn a new subagent instance with an explicit identifier.
    pub async fn spawn_with_id(
        &self,
        id: &str,
        type_name: &str,
        role: &str,
    ) -> Result<String, String> {
        self.scope_cache_error()?;
        let defs = self.definitions.read().await;
        if !defs.contains_key(type_name) && type_name != "self" {
            return Err(format!("Unknown subagent type: '{type_name}'"));
        }

        let cancellation = Arc::new(AtomicBool::new(false));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let instance = SubagentInstance {
            id: id.to_string(),
            type_name: type_name.to_string(),
            role: role.to_string(),
            state: SubagentState::Running,
            created_at_ms: now_ms,
            last_result: None,
        };

        let mut instances = self.instances.write().await;
        instances.insert(id.to_string(), (instance, cancellation));
        drop(instances);
        self.revive_scope(id);

        Ok(id.to_string())
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

        let runner = { self.task_runner.read().await.clone() };
        let parent_session = self
            .runtime
            .read()
            .await
            .as_ref()
            .and_then(|r| r.session_id.clone().filter(|session| !session.is_empty()));

        let subagent_run = async move {
            let turn_id = format!("subturn-{}", fastrand::u64(..));
            let messages = vec![crate::turn_loop::types::LLMMessage {
                role: "user".into(),
                content: format!("{}\n\nTask: {}", def.system_prompt, prompt_str),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }];

            let run_input = crate::turn_loop::types::RunTurnInput {
                max_attempts: None,
                turn_id,
                llm: llm.as_ref(),
                messages,
                tools: &[],
                tool_defs: Vec::new(),
                max_steps: 15,
                max_context_tokens: None,
                compaction_max_attempts: None,
                permission_mode: None,
                goal: None,
                cancellation: cancel_flag,
                hook_guard: None,
            };

            let run_result = crate::tools::CALLER_AGENT_ID
                .scope(
                    subagent_id.clone(),
                    crate::turn_loop::run_turn::run_turn(run_input, &callbacks),
                )
                .await
                .map_err(|e| e.to_string());

            match run_result {
                Ok(turn_res) => {
                    let result_text = format!(
                        "Subagent '{}' finished in {} steps (Tokens: {}).",
                        subagent_role, turn_res.steps, turn_res.usage.total_tokens
                    );
                    mgr.update_state(
                        &subagent_id,
                        SubagentState::Completed,
                        Some(result_text.clone()),
                    )
                    .await;
                    result_text
                }
                Err(err_msg) => {
                    let err_text = format!("Error: {err_msg}");
                    mgr.update_state(&subagent_id, SubagentState::Failed, Some(err_text.clone()))
                        .await;
                    err_text
                }
            }
        };

        if let Some(task_runner) = runner {
            let description = format!("Subagent {}: {}", role, prompt);
            let _ = task_runner.spawn_task_with_meta(
                crate::storage::TaskSpawnMeta {
                    session_id: parent_session.as_deref(),
                    kind: "subagent",
                    subagent_type: Some(type_name),
                },
                id.clone(),
                description,
                subagent_run,
            );
        } else {
            tokio::spawn(subagent_run);
        }

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
        self.run_foreground_turn_with_history(id, prompt, None, parent_cancel)
            .await
    }

    /// Run one foreground subagent turn with an optional inherited conversation
    /// history (v2 `fork: true` semantics). If `inherited_history` is present,
    /// any unclosed trailing tool calls are reconciled via `close_trailing_open_tool_exchange`
    /// before prepending to the new task prompt.
    pub async fn run_foreground_turn_with_history(
        &self,
        id: &str,
        prompt: &str,
        inherited_history: Option<Vec<crate::turn_loop::types::LLMMessage>>,
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
        // A `[secondary_model]` pool binding overrides the session model for
        // this instance only; the callbacks chain is shared either way.
        let runtime = match self.instance_llm(id).await {
            Some(llm) => Arc::new(SubagentRuntime {
                llm,
                callbacks: runtime.callbacks.clone(),
                session_id: runtime.session_id.clone(),
            }),
            None => runtime,
        };
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

        let messages = if let Some(history) = inherited_history {
            let mut msgs = crate::subagent::fork::close_trailing_open_tool_exchange(&history);
            msgs.push(crate::turn_loop::types::LLMMessage {
                role: "user".into(),
                content: format!("{}\n\nTask: {}", def.system_prompt, prompt),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });
            msgs
        } else {
            vec![crate::turn_loop::types::LLMMessage {
                role: "user".into(),
                content: format!("{}\n\nTask: {}", def.system_prompt, prompt),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }]
        };

        // Attribute this turn's native tool calls to the subagent, not to the
        // main agent: the tower tools read CALLER_AGENT_ID to enforce the
        // main-agent-only gate and to resolve the caller's roster name.
        let outcome: Result<crate::turn_loop::types::TurnResult, RunExit> =
            crate::tools::CALLER_AGENT_ID
                .scope(id.to_string(), async {
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
                })
                .await;

        match outcome {
            Ok(turn_res) => {
                let summary = final_assistant_summary(&turn_res.messages);
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
                // Persist to sqlite store if available (#3478)
                if let Some(store) = self.session_store.read().await.as_ref() {
                    let state = SubagentPersistedState {
                        id: id.to_string(),
                        profile_name: type_name.clone(),
                        role: role.clone(),
                        messages: turn_res.messages.clone(),
                        updated_at: chrono::Utc::now().timestamp_millis(),
                    };
                    if let Ok(val) = serde_json::to_value(&state) {
                        let _ = store.put_state("subagent_resume", id, &val);
                    }
                }
                // Completed last: the scope may be evicted right here, and
                // only a durable resume record makes that safe.
                self.update_state(id, SubagentState::Completed, Some(summary))
                    .await;
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
        let fg_record = {
            let histories = self
                .foreground_histories
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            histories.get(id).cloned()
        };
        let record = match fg_record {
            Some(rec) => rec,
            None => {
                if let Some(p) = self.persistent.read().await.get(id) {
                    let instances = self.instances.read().await;
                    let (profile_name, role) = instances
                        .get(id)
                        .map(|(inst, _)| (inst.type_name.clone(), inst.role.clone()))
                        .unwrap_or_else(|| ("coder".to_string(), "coder".to_string()));
                    ForegroundResume {
                        profile_name,
                        role,
                        messages: p.messages.clone(),
                    }
                } else {
                    let guard = self.session_store.read().await;
                    let store = guard.as_ref()?;
                    // Cold recovery: restore from SQLite store (#3478)
                    if let Ok(Some(val)) = store.get_state("subagent_resume", id) {
                        if let Ok(state) = serde_json::from_value::<SubagentPersistedState>(val) {
                            let rec = ForegroundResume {
                                profile_name: state.profile_name,
                                role: state.role,
                                messages: state.messages,
                            };
                            self.foreground_histories
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .insert(id.to_string(), rec.clone());
                            rec
                        } else {
                            return None;
                        }
                    } else {
                        return None;
                    }
                }
            }
        };
        // v2 `rebuildSubagent`: an evicted scope is recreated from its
        // persisted record before the resumed turn runs.
        self.rebuild_instance(id, &record.profile_name, &record.role)
            .await;
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
        let turn_res = match crate::tools::CALLER_AGENT_ID
            .scope(
                id.to_string(),
                run_one(
                    &runtime,
                    &callbacks,
                    messages.clone(),
                    tool_defs.clone(),
                    &Arc::new(AtomicBool::new(false)),
                    parent_cancel,
                ),
            )
            .await
        {
            Ok(turn) => turn,
            // The parent-cancelled outcome flows through verbatim so the
            // tool result carries the v2 user-interruption message.
            Err(RunExit::ParentCancelled) => {
                let _ = self.kill(id).await;
                return Some(Ok(ForegroundTurnOutcome::ParentCancelled));
            }
            Err(RunExit::Failed(message)) => {
                self.update_state(id, SubagentState::Failed, Some(format!("Error: {message}")))
                    .await;
                return Some(Err(message));
            }
        };
        if matches!(
            turn_res.stop_reason,
            crate::turn_loop::types::LoopTurnStopReason::MaxTokens
        ) {
            self.update_state(
                id,
                SubagentState::Failed,
                Some(format!("Error: {SUBAGENT_MAX_TOKENS_ERROR}")),
            )
            .await;
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
                        let _ = self.kill(id).await;
                        return Some(Ok(ForegroundTurnOutcome::ParentCancelled));
                    }
                    Err(RunExit::Failed(message)) => {
                        self.update_state(
                            id,
                            SubagentState::Failed,
                            Some(format!("Error: {message}")),
                        )
                        .await;
                        return Some(Err(message));
                    }
                }
            }
            None => turn_res,
        };

        let summary = final_assistant_summary(&turn_res.messages);
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
        if let Some(store) = self.session_store.read().await.as_ref() {
            let state = SubagentPersistedState {
                id: id.to_string(),
                profile_name: record.profile_name.clone(),
                role: record.role.clone(),
                messages: turn_res.messages.clone(),
                updated_at: chrono::Utc::now().timestamp_millis(),
            };
            if let Ok(val) = serde_json::to_value(&state) {
                let _ = store.put_state("subagent_resume", id, &val);
            }
        }
        {
            let mut persistent = self.persistent.write().await;
            if let Some(p) = persistent.get_mut(id) {
                p.messages = turn_res.messages.clone();
                p.usage = turn_res.usage.clone();
            }
        }
        // Completed last: the scope may be evicted right here, and only a
        // durable resume record makes that safe.
        self.update_state(id, SubagentState::Completed, Some(summary))
            .await;
        Some(Ok(ForegroundTurnOutcome::Completed(turn_res)))
    }

    /// The profile a native resume record was spawned under (for the v2
    /// `actual_subagent_type` line in the resume result).
    pub async fn resume_profile(&self, id: &str) -> Option<String> {
        if let Some(name) = self
            .foreground_histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|record| record.profile_name.clone())
        {
            return Some(name);
        }
        let instances = self.instances.read().await;
        if let Some((inst, _)) = instances.get(id) {
            return Some(inst.type_name.clone());
        }
        // Cold recovery check (#3478)
        if let Some(store) = self.session_store.read().await.as_ref()
            && let Ok(Some(val)) = store.get_state("subagent_resume", id)
            && let Ok(state) = serde_json::from_value::<SubagentPersistedState>(val)
        {
            let profile_name = state.profile_name.clone();
            self.foreground_histories
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    id.to_string(),
                    ForegroundResume {
                        profile_name: state.profile_name,
                        role: state.role,
                        messages: state.messages,
                    },
                );
            return Some(profile_name);
        }
        None
    }

    /// Retrieve stored message history of a completed foreground subagent (for forking or resuming).
    pub fn get_foreground_history(
        &self,
        id: &str,
    ) -> Option<Vec<crate::turn_loop::types::LLMMessage>> {
        if let Some(msgs) = self
            .foreground_histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|record| record.messages.clone())
        {
            return Some(msgs);
        }
        // Cold recovery check (#3478)
        if let Ok(guard) = self.session_store.try_read()
            && let Some(store) = guard.as_ref()
            && let Ok(Some(val)) = store.get_state("subagent_resume", id)
            && let Ok(state) = serde_json::from_value::<SubagentPersistedState>(val)
        {
            return Some(state.messages);
        }
        None
    }

    /// Explicitly record or seed the message history for a foreground subagent.
    pub fn set_foreground_history(
        &self,
        id: &str,
        profile_name: &str,
        role: &str,
        messages: Vec<crate::turn_loop::types::LLMMessage>,
    ) {
        self.foreground_histories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.to_string(),
                ForegroundResume {
                    profile_name: profile_name.to_string(),
                    role: role.to_string(),
                    messages: messages.clone(),
                },
            );
        // Persist to store if available (#3478)
        if let Ok(guard) = self.session_store.try_read()
            && let Some(store) = guard.as_ref()
        {
            let state = SubagentPersistedState {
                id: id.to_string(),
                profile_name: profile_name.to_string(),
                role: role.to_string(),
                messages,
                updated_at: chrono::Utc::now().timestamp_millis(),
            };
            if let Ok(val) = serde_json::to_value(&state) {
                let _ = store.put_state("subagent_resume", id, &val);
            }
        }
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
        self.scope_cache_error()?;
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
        self.revive_scope(&id);

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
            max_attempts: None,
            turn_id,
            llm: &recording,
            messages,
            tools: &[],
            tool_defs: Vec::new(),
            max_steps: 15,
            max_context_tokens: None,
            compaction_max_attempts: None,
            permission_mode: None,
            goal: None,
            cancellation: Some(cancel_flag.clone()),
            hook_guard: None,
        };
        let run_result = crate::tools::CALLER_AGENT_ID
            .scope(
                id.to_string(),
                crate::turn_loop::run_turn::run_turn(run_input, &callbacks),
            )
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
            drop(instances);
            self.revive_scope(id);
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

    /// Update the state of a subagent instance. A terminal state retires the
    /// scope into the completed-scope LRU (v2 `SubagentCompleted` /
    /// `SubagentFailed` / `SubagentCancelled`).
    pub async fn update_state(&self, id: &str, state: SubagentState, result: Option<String>) {
        {
            let mut instances = self.instances.write().await;
            if let Some((inst, _)) = instances.get_mut(id) {
                inst.state = state;
                if result.is_some() {
                    inst.last_result = result;
                }
            }
        }
        if state.is_terminal() {
            self.retire_completed_scope(id).await;
        }
    }

    /// Terminate a running subagent by setting its cancellation flag and stopping its background task if registered.
    pub async fn kill(&self, id: &str) -> Result<bool, String> {
        let runner = self.task_runner.read().await.clone();
        if let Some(r) = runner {
            let _ = r.stop(id, None).await;
        }
        let killed = {
            let mut instances = self.instances.write().await;
            match instances.get_mut(id) {
                Some((inst, cancel_flag)) => {
                    cancel_flag.store(true, Ordering::SeqCst);
                    inst.state = SubagentState::Terminated;
                    true
                }
                None => false,
            }
        };
        if killed {
            self.retire_completed_scope(id).await;
        }
        Ok(killed)
    }

    /// The scope-cache env vars are validated once per manager; a bad value
    /// fails the spawn that would create the first cached scope instead of
    /// silently running without eviction.
    fn scope_cache_error(&self) -> Result<(), String> {
        let cache = self.scope_cache.lock().unwrap_or_else(|e| e.into_inner());
        match cache.error.as_ref() {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    /// Drop `id` from the LRU: a scope that is live again must not be evicted
    /// (v2 `revive`).
    fn revive_scope(&self, id: &str) {
        self.scope_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revive(id);
    }

    /// Retire a completed scope into the LRU and evict the overflow (v2
    /// `retire` → `evictOverflow`). Persistent instances are excluded — their
    /// conversation lives only in memory, so `destroy_persistent` stays their
    /// single removal path — and so is every manager without a session store:
    /// there the in-memory conversation is the only copy, so evicting it would
    /// break `resume` instead of rebuilding it.
    async fn retire_completed_scope(&self, id: &str) {
        if self.persistent.read().await.contains_key(id) {
            return;
        }
        if self.session_store.read().await.is_none() {
            return;
        }
        {
            let mut cache = self.scope_cache.lock().unwrap_or_else(|e| e.into_inner());
            if cache.capacity == 0 || cache.error.is_some() {
                return;
            }
            cache.retire(id);
        }
        self.evict_completed_scopes().await;
    }

    /// Evict completed scopes until the cache fits its capacity. A scope that
    /// refuses eviction is skipped for the rest of this pass and retried on a
    /// later one (v2 `evictOverflow`).
    async fn evict_completed_scopes(&self) {
        let mut skipped: HashSet<String> = HashSet::new();
        loop {
            let (timeout, candidate) = {
                let cache = self.scope_cache.lock().unwrap_or_else(|e| e.into_inner());
                if cache.retired.len() <= cache.capacity {
                    return;
                }
                let Some(candidate) = cache.oldest_candidate(&skipped) else {
                    return;
                };
                (cache.evict_timeout, candidate)
            };
            let (id, attempts) = candidate;
            self.scope_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            match self.evict_scope(&id, timeout).await {
                EvictOutcome::Removed | EvictOutcome::Missing => continue,
                EvictOutcome::Deferred => {
                    // Still running: keep it retired at the same attempt count
                    // and move on (v2 defers without spending an attempt).
                    skipped.insert(id.clone());
                    self.scope_cache
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .reinsert(&id, attempts);
                }
                EvictOutcome::Timeout => {
                    skipped.insert(id.clone());
                    let next_attempt = attempts + 1;
                    if next_attempt >= MAX_SCOPE_EVICT_ATTEMPTS {
                        tracing::warn!(
                            subagent = %id,
                            attempts = next_attempt,
                            "subagent scope eviction timed out; leaving it resident"
                        );
                    }
                    self.scope_cache
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .reinsert(&id, next_attempt);
                }
            }
        }
    }

    /// Drop one completed scope's resident state (v2 `evict`): the instance
    /// entry and the in-memory conversation. The persisted resume record is
    /// untouched — `resume` rebuilds both from it. The bound covers the whole
    /// removal, so a scope whose locks stay contended is skipped rather than
    /// stalling the queue.
    async fn evict_scope(&self, id: &str, timeout: Duration) -> EvictOutcome {
        {
            let instances = self.instances.read().await;
            match instances.get(id) {
                None => return EvictOutcome::Missing,
                Some((instance, _)) if instance.state == SubagentState::Running => {
                    return EvictOutcome::Deferred;
                }
                Some(_) => {}
            }
        }
        let removal = async {
            let mut instances = self.instances.write().await;
            instances.remove(id);
            self.foreground_histories
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id);
        };
        match tokio::time::timeout(timeout, removal).await {
            Ok(()) => EvictOutcome::Removed,
            Err(_) => EvictOutcome::Timeout,
        }
    }

    /// Recreate the resident instance of a scope that was evicted (v2
    /// `rebuildSubagent`): the persisted resume record carries the profile and
    /// role, so the rebuilt instance is indistinguishable from the original
    /// one for the resumed turn — and the rebuilt conversation is tracked by
    /// the LRU again instead of leaking untracked.
    async fn rebuild_instance(&self, id: &str, type_name: &str, role: &str) {
        let mut instances = self.instances.write().await;
        if instances.contains_key(id) {
            return;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        instances.insert(
            id.to_string(),
            (
                SubagentInstance {
                    id: id.to_string(),
                    type_name: type_name.to_string(),
                    role: role.to_string(),
                    state: SubagentState::Running,
                    created_at_ms: now_ms,
                    last_result: None,
                },
                Arc::new(AtomicBool::new(false)),
            ),
        );
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

    /// The swarm timeout rides host values verbatim: `0` means "explicitly no
    /// timeout" (the tool maps it to the never-expiring sentinel) and must not
    /// be folded into the 2h default the way an unset value is.
    #[test]
    fn test_swarm_timeout_zero_is_explicit_no_timeout() {
        let manager = SubagentManager::new();
        manager.set_swarm_timeout_ms(Some(0));
        assert_eq!(manager.swarm_timeout_ms(), Some(0));
        manager.set_swarm_timeout_ms(Some(60_000));
        assert_eq!(manager.swarm_timeout_ms(), Some(60_000));
        manager.set_swarm_timeout_ms(None);
        assert_eq!(manager.swarm_timeout_ms(), None);
    }

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
                    thinking: Vec::new(),
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
        manager
            .set_runtime(llm.clone(), callbacks.clone(), None)
            .await;

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
                    thinking: Vec::new(),
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
                    thinking: Vec::new(),
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
                        thinking: Vec::new(),
                        tool_calls: vec![crate::turn_loop::types::ToolCall {
                            id: "tc1".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({ "path": "/a.txt" }),
                            extras: None,
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
                        thinking: Vec::new(),
                        tool_calls: vec![crate::turn_loop::types::ToolCall {
                            id: "tc2".into(),
                            name: "read".into(),
                            arguments: serde_json::json!({ "path": "/b.txt" }),
                            extras: None,
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
                    delivery: None,
                    stop_turn: false,
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

    #[tokio::test]
    async fn test_resume_from_persistent_instance() {
        let manager = Arc::new(SubagentManager::new());
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);
        manager
            .set_runtime(llm.clone(), callbacks.clone(), None)
            .await;

        let id = manager
            .spawn_persistent("research", "Researcher", llm.clone(), callbacks.clone())
            .await
            .unwrap();

        // Check resume_profile resolves it
        let profile = manager.resume_profile(&id).await;
        assert_eq!(profile.as_deref(), Some("research"));

        // Resume foreground turn continues successfully
        let outcome = manager
            .resume_foreground_turn(&id, "continue research", None)
            .await;
        assert!(outcome.is_some());
        let res = outcome.unwrap().unwrap();
        assert!(matches!(res, ForegroundTurnOutcome::Completed(_)));
    }

    #[tokio::test]
    async fn test_cold_resume_from_sqlite_store() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let manager1 = Arc::new(SubagentManager::with_store(store.clone()));
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);
        manager1
            .set_runtime(llm.clone(), callbacks.clone(), None)
            .await;

        let agent_id = "subagent-cold-1";
        let initial_msgs = vec![
            crate::turn_loop::types::LLMMessage::new("user", "first question"),
            crate::turn_loop::types::LLMMessage::new("assistant", "first answer"),
        ];
        manager1.set_foreground_history(agent_id, "research", "Researcher", initial_msgs.clone());

        // Verify history is retrievable
        assert_eq!(manager1.get_foreground_history(agent_id).unwrap().len(), 2);
        assert_eq!(
            manager1.resume_profile(agent_id).await.as_deref(),
            Some("research")
        );

        // Now simulate a full restart: create a new SubagentManager with no in-memory state
        let manager2 = Arc::new(SubagentManager::with_store(store.clone()));
        manager2
            .set_runtime(llm.clone(), callbacks.clone(), None)
            .await;

        // In-memory histories are empty in manager2
        assert_eq!(
            manager2.resume_profile(agent_id).await.as_deref(),
            Some("research")
        );
        let history = manager2.get_foreground_history(agent_id);
        assert!(history.is_some());
        assert_eq!(history.unwrap().len(), 2);

        // Resume should work seamlessly from persisted state
        let outcome = manager2
            .resume_foreground_turn(agent_id, "second question", None)
            .await;
        assert!(outcome.is_some());
        let res = outcome.unwrap().unwrap();
        assert!(matches!(res, ForegroundTurnOutcome::Completed(_)));

        // The updated history should now have 4 messages (user, assistant, user, assistant)
        let updated_history = manager2.get_foreground_history(agent_id).unwrap();
        assert_eq!(updated_history.len(), 6);
        assert_eq!(updated_history.last().unwrap().role, "assistant");
    }

    #[tokio::test]
    async fn test_spawn_and_run_registers_in_task_runner() {
        let manager = Arc::new(SubagentManager::new());
        let runner = Arc::new(crate::storage::TaskRunner::new(None));
        manager.set_task_runner(runner.clone()).await;

        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(OkToolCallbacks);

        let id = manager
            .spawn_and_run("research", "Researcher", "investigate", llm, callbacks)
            .await
            .unwrap();

        let wait_res = runner.wait(&id, 2000).await;
        assert!(matches!(
            wait_res,
            crate::storage::TaskWaitResult::Completed(_)
        ));
    }

    #[test]
    fn profile_policy_matches_mcp_tool_names_as_globs() {
        // v2 `isToolActive`: MCP names match their patterns as globs, while
        // built-ins match exactly. The built-in profiles whitelist `mcp__*`,
        // so a server-qualified MCP tool must survive that pattern.
        let filter = ToolPolicyFilter::from_allowlist(&["mcp__*".to_string()]);
        assert!(filter.allows("mcp__github__search"));
        assert!(filter.allows("mcp__acme__do_thing"));
        assert!(!filter.allows("Read"));

        let scoped = ToolPolicyFilter::from_allowlist(&["Read".into(), "mcp__github__*".into()]);
        assert!(scoped.allows("read"), "built-ins match case-insensitively");
        assert!(scoped.allows("mcp__github__search"));
        assert!(!scoped.allows("mcp__slack__post"));

        // A denylist keeps built-ins unless named, and globs MCP names.
        let denied = ToolPolicyFilter::from_definition(&SubagentDefinition {
            name: "n".into(),
            description: "d".into(),
            system_prompt: "s".into(),
            tools: Vec::new(),
            disallowed_tools: vec!["mcp__slack__*".into()],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        });
        assert!(!denied.allows("mcp__slack__post"));
        assert!(denied.allows("mcp__github__search"));
        assert!(denied.allows("Write"));
    }

    #[tokio::test]
    async fn background_task_events_attribute_to_the_runtime_session() {
        let manager = Arc::new(SubagentManager::new());
        let runner = Arc::new(crate::storage::TaskRunner::new(None));
        manager.set_task_runner(runner.clone()).await;
        type RecordedEvents = Arc<std::sync::Mutex<Vec<(Option<String>, serde_json::Value)>>>;
        let events: RecordedEvents = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        runner.set_event_sink(Arc::new(move |session, event| {
            sink.lock()
                .unwrap()
                .push((session.map(str::to_string), event));
        }));

        manager
            .set_runtime(
                Arc::new(MockSubagentLlm),
                Arc::new(OkToolCallbacks),
                Some("sess-runtime".into()),
            )
            .await;
        let id = manager
            .spawn_and_run(
                "research",
                "Researcher",
                "investigate",
                Arc::new(MockSubagentLlm),
                Arc::new(OkToolCallbacks),
            )
            .await
            .unwrap();

        // The creation event lands on the runtime's session lane, carrying
        // the subagent identity.
        let first = events.lock().unwrap()[0].clone();
        assert_eq!(first.0.as_deref(), Some("sess-runtime"));
        assert_eq!(first.1["type"], "event.task.created");
        assert_eq!(first.1["task"]["id"], id);
        assert_eq!(first.1["task"]["kind"], "subagent");
        assert_eq!(first.1["task"]["session_id"], "sess-runtime");

        assert!(matches!(
            runner.wait(&id, 2000).await,
            crate::storage::TaskWaitResult::Completed(_)
        ));
    }

    /// A manager whose completed-scope cache uses explicit knobs instead of
    /// the process environment (which the tests must not mutate).
    fn manager_with_capacity(
        store: Arc<SqliteSessionStore>,
        capacity: usize,
    ) -> Arc<SubagentManager> {
        let manager = Arc::new(SubagentManager::with_store(store));
        *manager.scope_cache.lock().unwrap() = ScopeCache {
            capacity,
            evict_timeout: Duration::from_millis(DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS),
            retired: Vec::new(),
            error: None,
        };
        manager
    }

    #[test]
    fn test_scope_cache_env_validation() {
        let mut env = HashMap::new();
        assert_eq!(
            resolve_subagent_scope_cache_size(&env).unwrap(),
            DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE
        );
        env.insert(SUBAGENT_SCOPE_CACHE_SIZE_ENV.into(), " 4 ".into());
        assert_eq!(resolve_subagent_scope_cache_size(&env).unwrap(), 4);
        // `0` and negative sizes both mean "never evict" (v2 `Math.max(0, …)`).
        env.insert(SUBAGENT_SCOPE_CACHE_SIZE_ENV.into(), "0".into());
        assert_eq!(resolve_subagent_scope_cache_size(&env).unwrap(), 0);
        env.insert(SUBAGENT_SCOPE_CACHE_SIZE_ENV.into(), "-3".into());
        assert_eq!(resolve_subagent_scope_cache_size(&env).unwrap(), 0);
        env.insert(SUBAGENT_SCOPE_CACHE_SIZE_ENV.into(), "many".into());
        assert!(resolve_subagent_scope_cache_size(&env).is_err());

        let mut env = HashMap::new();
        assert_eq!(
            resolve_subagent_scope_evict_timeout_ms(&env).unwrap(),
            DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS
        );
        env.insert(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV.into(), "250".into());
        assert_eq!(resolve_subagent_scope_evict_timeout_ms(&env).unwrap(), 250);
        env.insert(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV.into(), "0".into());
        assert!(resolve_subagent_scope_evict_timeout_ms(&env).is_err());
        env.insert(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV.into(), "-1".into());
        assert!(resolve_subagent_scope_evict_timeout_ms(&env).is_err());
    }

    /// A rejected env value fails the spawn that would create the first
    /// cached scope instead of silently running without eviction.
    #[tokio::test]
    async fn test_invalid_scope_cache_env_fails_the_spawn() {
        let manager = Arc::new(SubagentManager::new());
        manager.scope_cache.lock().unwrap().error = Some(format!(
            "{SUBAGENT_SCOPE_CACHE_SIZE_ENV} must be an integer, got \"many\"."
        ));

        let error = manager
            .spawn_with_id("subagent-bad-env", "research", "Researcher")
            .await
            .unwrap_err();
        assert!(
            error.contains(SUBAGENT_SCOPE_CACHE_SIZE_ENV),
            "got: {error}"
        );
        assert!(manager.get_instance("subagent-bad-env").await.is_none());
    }

    /// A completed scope is evicted once the cache overflows, and the next
    /// resume rebuilds it from the persisted record instead of failing.
    #[tokio::test]
    async fn test_completed_scopes_evict_and_rebuild_on_resume() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let manager = manager_with_capacity(store, 1);
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);
        manager
            .set_runtime(llm.clone(), callbacks.clone(), None)
            .await;

        for id in ["subagent-lru-1", "subagent-lru-2"] {
            manager
                .spawn_with_id(id, "research", "Researcher")
                .await
                .unwrap();
            let outcome = manager
                .run_foreground_turn(id, "first question", None)
                .await
                .unwrap();
            assert!(matches!(outcome, ForegroundTurnOutcome::Completed(_)));
        }

        // The older completion is gone from memory; the newer one stays.
        assert!(manager.get_instance("subagent-lru-1").await.is_none());
        assert!(
            !manager
                .foreground_histories
                .lock()
                .unwrap()
                .contains_key("subagent-lru-1")
        );
        assert!(manager.get_instance("subagent-lru-2").await.is_some());

        // The persisted record survives eviction, so the resume rebuilds the
        // scope and continues the conversation.
        assert_eq!(
            manager.resume_profile("subagent-lru-1").await.as_deref(),
            Some("research")
        );
        let outcome = manager
            .resume_foreground_turn("subagent-lru-1", "second question", None)
            .await;
        assert!(outcome.is_some());
        assert!(matches!(
            outcome.unwrap().unwrap(),
            ForegroundTurnOutcome::Completed(_)
        ));
        assert!(manager.get_instance("subagent-lru-1").await.is_some());
        // The resumed scope is the most recently used one, so the other
        // completed scope is the one evicted now.
        assert!(manager.get_instance("subagent-lru-2").await.is_none());
    }

    /// Without a persisted resume record the in-memory conversation is the
    /// only copy, so nothing is evicted (the cache stays unbounded there).
    #[tokio::test]
    async fn test_completed_scopes_stay_resident_without_a_store() {
        let manager = Arc::new(SubagentManager::new());
        *manager.scope_cache.lock().unwrap() = ScopeCache {
            capacity: 1,
            evict_timeout: Duration::from_millis(DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS),
            retired: Vec::new(),
            error: None,
        };
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);
        manager
            .set_runtime(llm.clone(), callbacks.clone(), None)
            .await;

        for id in ["subagent-keep-1", "subagent-keep-2"] {
            manager
                .spawn_with_id(id, "research", "Researcher")
                .await
                .unwrap();
            let outcome = manager
                .run_foreground_turn(id, "first question", None)
                .await
                .unwrap();
            assert!(matches!(outcome, ForegroundTurnOutcome::Completed(_)));
        }

        assert!(manager.get_instance("subagent-keep-1").await.is_some());
        assert!(manager.get_instance("subagent-keep-2").await.is_some());
    }

    /// A persistent instance is never evicted: its conversation lives only in
    /// memory, so `destroy_persistent` stays its single removal path.
    #[tokio::test]
    async fn test_persistent_instances_are_never_evicted() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let manager = manager_with_capacity(store, 1);
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);
        manager
            .set_runtime(llm.clone(), callbacks.clone(), None)
            .await;

        let persistent = manager
            .spawn_persistent("research", "Researcher", llm.clone(), callbacks.clone())
            .await
            .unwrap();
        manager
            .update_state(&persistent, SubagentState::Failed, None)
            .await;
        for id in ["subagent-fg-1", "subagent-fg-2"] {
            manager
                .spawn_with_id(id, "research", "Researcher")
                .await
                .unwrap();
            manager
                .update_state(id, SubagentState::Completed, None)
                .await;
        }

        assert!(manager.get_instance(&persistent).await.is_some());
    }
}
