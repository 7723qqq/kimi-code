//! Native tool execution inside the Rust engine.
//!
//! Read-only tools (`Read` / `Grep` / `Glob`) execute directly in this
//! process instead of round-tripping to the JS host; mutating tools
//! (`Write` / `Edit` / `Bash`) do too, but only after the host granted
//! permission for the specific call (see
//! [`crate::callbacks::HostCallbacks::check_permission`]). Execution is
//! sandboxed to the workspace root; anything outside it (or any argument
//! shape this module does not understand) returns `None`, which makes the
//! caller fall back to the host path — the host then applies its full
//! permission system.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

/// P57: mid-execution output stream callback (bash stdout/stderr chunks).
pub type OutputUpdate<'a> = &'a (dyn Fn(&str, &str) + Send + Sync);

use crate::turn_loop::types::ExecutableToolResult;

/// Maximum number of lines a native Read returns (host Read cap).
const READ_MAX_LINES: usize = 1000;
/// Maximum rendered length of a single Read line (host Read cap).
const READ_MAX_LINE_LENGTH: usize = 2000;
/// Maximum rendered output bytes for a native Read (host/addon MAX_BYTES).
const READ_MAX_OUTPUT_BYTES: usize = 100 * 1024;
/// Maximum file size a native Read serves (addon TRANSCODE_MAX_BYTES; larger
/// files fall back to the host, which streams them).
const READ_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Grep caps: scanned files, and wall-clock budget (host/addon
/// DEFAULT_TIMEOUT_MS = 20s).
const GREP_MAX_FILES: usize = 5000;
/// Soft memory guard for the parallel walk. Aggregated `content`-mode windows
/// are held in memory until the caller sorts and truncates them, and one
/// matching file can contribute nearly [`GREP_MAX_FILE_BYTES`] of rendered
/// lines, so workers stop scanning (best-effort, like the deadline) once twice
/// the hard cap has been visited. The hard cap is still applied exactly — but
/// only after sorting, so what survives it is deterministic.
const GREP_WALK_SCAN_CAP: usize = GREP_MAX_FILES * 2;
/// Worker threads for one parallel grep walk. `ignore`'s `WalkParallel`
/// defaults to one worker per CPU, which multiplies with tokio's blocking pool
/// (`spawn_blocking` × `MAX_PARALLEL_TOOLS` concurrent native calls): a 16-core
/// box would peak at ~272 threads for grep alone. The walk is syscall-bound
/// rather than CPU-bound, so four workers keep the fan-out benefit while
/// bounding the worst case to 64 extra threads.
const GREP_WALK_THREADS: usize = 4;
const GREP_TIME_BUDGET: Duration = Duration::from_secs(20);
/// Largest file native Grep will pull into memory (matches the Read cap).
/// Bigger ones are skipped and reported as truncation rather than risking a
/// multi-gigabyte allocation per matching file.
const GREP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Cap on rendered Grep output bytes. This is the engine's own memory guard,
/// deliberately tighter than the host's rg stdout buffer
/// (`runRg.ts` `MAX_OUTPUT_BYTES` = 10 MiB): the host streams rg's output and
/// pages it, whereas the engine builds the whole rendered result in process
/// before paging, so context lines across thousands of files would otherwise be
/// materialised in full. Paging itself matches the host
/// ([`GREP_HEAD_LIMIT`] = `DEFAULT_HEAD_LIMIT`).
const GREP_MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// Default result cap for native Grep (host DEFAULT_HEAD_LIMIT).
const GREP_HEAD_LIMIT: usize = 250;
/// VCS metadata directories excluded from every grep walk, regardless of
/// `.gitignore` (mirrors the host `VCS_DIRECTORIES_TO_EXCLUDE`).
const VCS_DIRECTORIES_TO_EXCLUDE: [&str; 6] = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
/// Maximum number of Glob results returned.
const GLOB_MAX_RESULTS: usize = 500;

/// Hard wall-clock cap for native Bash (host may configure less).
const BASH_MAX_SECONDS: u64 = 300;
/// P57: minimum spacing between `tool.native.progress` events (one event
/// per interval; intervening chunks are dropped from the UI stream only —
/// the final result always carries the full output).
const PROGRESS_MIN_INTERVAL_MS: u64 = 50;
/// Cap on captured Bash output (matches the JS tool's truncation scale).
const BASH_MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub mod agent_tool;
pub mod ask_user_question;
pub mod core_tool_defs;
pub mod create_goal;
pub mod cron_tools;
pub mod encoding;
pub mod exit_plan_mode;
pub mod external_hooks;
pub mod fetch_url;
pub mod get_goal;
pub mod github;
pub mod goal_guard;
pub mod goal_tools;
pub mod knowledge_tool;
pub mod list_directory;
pub mod memory_paths;
pub mod plan_mode;
pub mod skill;
pub mod stale_guard;
pub mod subagent_tools;
pub mod task_format;
pub mod task_tools;
pub mod team_tool;
pub mod todo_item;
pub mod todo_list;
pub mod tool_dedupe;
pub mod web_search;

mod grep_types;

/// Tools whose native execution requires a host permission grant first.
pub fn is_mutating_tool(tool_name: &str) -> bool {
    matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "write" | "edit" | "bash"
    )
}

/// Every lowercase tool name [`NativeToolset::handles`] accepts, in one
/// place. The set is pinned by `tool-name-contract.json` (see the
/// `native_tool_names_match_the_contract_file` test): adding or removing a
/// spelling must update that file in the same change, and the v2-side test
/// (`agent-core-v2/test/agent/toolRegistry/toolNameContract.test.ts`) fails
/// when a v2 tool name loses its classification. GitHub tool names are a
/// dynamic family (`github::is_github_tool`), not part of this list.
pub const NATIVE_TOOL_NAMES: &[&str] = &[
    "read",
    "grep",
    "glob",
    "write",
    "edit",
    "bash",
    "fetchurl",
    "fetch_url",
    "websearch",
    "web_search",
    "listdirectory",
    "list_directory",
    "invokesubagent",
    "invoke_subagent",
    "managesubagents",
    "manage_subagents",
    "definesubagent",
    "define_subagent",
    "askuserquestion",
    "ask_user_question",
    "getgoal",
    "get_goal",
    "todolist",
    "todo_list",
    "enterplanmode",
    "enter_plan_mode",
    "cronlist",
    "cron_list",
    "croncreate",
    "cron_create",
    "crondelete",
    "cron_delete",
    "updategoal",
    "update_goal",
    "setgoalbudget",
    "set_goal_budget",
    "tasklist",
    "task_list",
    "taskoutput",
    "task_output",
    "taskstop",
    "task_stop",
    "taskwait",
    "task_wait",
    "exitplanmode",
    "exit_plan_mode",
    "creategoal",
    "create_goal",
    "skill",
    "knowledge",
    "team",
    "agent",
];

/// The static half of [`NativeToolset::handles`] without an instance: the
/// contracted native name list plus the dynamic GitHub family. The dedup
/// guard in `run_turn` uses it to scope engine-side dedup to calls that can
/// execute natively — host-forwarded calls stay under the host's own
/// `toolDedupeService`, so a repeated call is never deduped twice.
pub fn is_native_tool_name(tool_name: &str) -> bool {
    let lowered = tool_name.to_ascii_lowercase();
    NATIVE_TOOL_NAMES.contains(&lowered.as_str()) || github::is_github_tool(tool_name)
}

/// Sandboxed native executor, rooted at the workspace.
pub struct NativeToolset {
    root: PathBuf,
    /// Host shell for Bash (the host always uses bash, including Git Bash on
    /// Windows). `None` on Windows means "host owns Bash" — native Bash would
    /// otherwise run commands under a different shell than the tool's
    /// documented contract.
    shell: Option<String>,
    subagent_manager: Option<std::sync::Arc<crate::subagent::SubagentManager>>,
    mcp_manager: Option<std::sync::Arc<crate::mcp::McpManager>>,
    /// Foreground `Agent` tool turn context (P46): the timeout the host
    /// resolved (`resolveSubagentTimeoutMs`) and the parent turn's
    /// cancellation signal. Both `None` outside a wired turn (the tool then
    /// runs with the 2h default and no parent abort).
    subagent_timeout_ms: Option<u64>,
    parent_cancel: Option<crate::subagent::types::ParentCancel>,
    /// P55: session-wide slot (shared with the session pump) holding the
    /// current turn's [`ParentCancel`]. Takes precedence over the static
    /// `parent_cancel`; lets a session-built toolset see per-turn signals.
    parent_cancel_slot: Option<Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>>,
    /// Host callbacks for interactive tools (AskUserQuestion). `None` means
    /// the tool falls back to the host path, which owns the interaction
    /// runtime anyway.
    callbacks: Option<std::sync::Arc<dyn crate::callbacks::HostCallbacks>>,
    /// Host-resolved `[github]` config credentials for the native GitHub
    /// tools (v2 `configSection.ts`). Env fallbacks live in the github
    /// module itself (v2 `envOverlay.ts` semantics).
    github_credentials: Option<github::GitHubCredentials>,
}

impl NativeToolset {
    /// Build a toolset rooted at `workspace_root`. Returns `None` when the
    /// root does not exist or cannot be canonicalized (no sandbox — no
    /// native execution).
    pub fn new(workspace_root: &str, shell_path: Option<&str>) -> Option<Self> {
        let root = std::fs::canonicalize(workspace_root).ok()?;
        if !root.is_dir() {
            return None;
        }
        let shell = if cfg!(windows) {
            // Windows without an explicit Git Bash path: Bash stays with the
            // host, which locates Git Bash and would otherwise diverge.
            shell_path
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty())
        } else {
            // POSIX hosts always have /bin/sh-family shells on PATH; the
            // host default is /bin/bash.
            Some(
                shell_path
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("bash")
                    .to_string(),
            )
        };
        Some(Self {
            root,
            shell,
            subagent_manager: None,
            mcp_manager: None,
            subagent_timeout_ms: None,
            parent_cancel: None,
            parent_cancel_slot: None,
            callbacks: None,
            github_credentials: None,
        })
    }

    /// Attach a SubagentManager for in-process multi-agent collaboration.
    pub fn with_subagents(
        mut self,
        manager: std::sync::Arc<crate::subagent::SubagentManager>,
    ) -> Self {
        self.subagent_manager = Some(manager);
        self
    }

    /// Attach an McpManager for external MCP server tools.
    pub fn with_mcp(mut self, manager: std::sync::Arc<crate::mcp::McpManager>) -> Self {
        self.mcp_manager = Some(manager);
        self
    }

    /// Attach the foreground `Agent` tool's turn context (P46): the host's
    /// resolved subagent timeout and the parent turn's cancellation signal
    /// (P51: flag + notify, so the subagent abort is event-driven).
    pub fn with_agent_context(
        mut self,
        timeout_ms: Option<u64>,
        parent_cancel: Option<crate::subagent::types::ParentCancel>,
    ) -> Self {
        self.subagent_timeout_ms = timeout_ms;
        self.parent_cancel = parent_cancel;
        self
    }

    /// Attach the P55 session-wide cancel slot (session-built toolsets).
    pub fn with_parent_cancel_slot(
        mut self,
        slot: Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>,
    ) -> Self {
        self.parent_cancel_slot = Some(slot);
        self
    }

    /// [`Self::with_parent_cancel_slot`] for optional slots.
    pub fn with_parent_cancel_slot_if(
        mut self,
        slot: Option<Arc<std::sync::Mutex<Option<crate::subagent::types::ParentCancel>>>>,
    ) -> Self {
        self.parent_cancel_slot = slot;
        self
    }

    /// The live parent cancel signal: the session slot wins (per-turn
    /// refresh), the static value is the per-turn-wired fallback.
    fn effective_parent_cancel(&self) -> Option<crate::subagent::types::ParentCancel> {
        if let Some(slot) = &self.parent_cancel_slot {
            let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(signal) = guard.as_ref() {
                return Some(signal.clone());
            }
        }
        self.parent_cancel.clone()
    }

    /// Attach the host callbacks for interactive tools (AskUserQuestion).
    pub fn with_callbacks(
        mut self,
        callbacks: std::sync::Arc<dyn crate::callbacks::HostCallbacks>,
    ) -> Self {
        self.callbacks = Some(callbacks);
        self
    }

    /// Attach host-resolved `[github]` config credentials for the native
    /// GitHub tools.
    pub fn with_github_credentials(mut self, credentials: github::GitHubCredentials) -> Self {
        self.github_credentials = Some(credentials);
        self
    }

    /// Execute a read-only tool natively when supported and inside the
    /// sandbox. `None` means "not handled here — send it to the host".
    pub fn execute(&self, tool_name: &str, args: &Value) -> Option<ExecutableToolResult> {
        match tool_name.to_ascii_lowercase().as_str() {
            "read" => Self::read(&self.root, args),
            "grep" => Self::grep(&self.root, args),
            "glob" => Self::glob(&self.root, args),
            "listdirectory" | "list_directory" => {
                list_directory::execute_list_directory(&self.root, args)
            }
            _ => None,
        }
    }

    /// Whether the sandbox knows how to execute this tool natively (subject
    /// to a host permission grant and sandbox confinement).
    pub fn handles(&self, tool_name: &str) -> bool {
        is_native_tool_name(tool_name)
    }

    /// Execute a tool natively (async).
    ///
    /// The file-I/O tools (`read` / `grep` / `glob` / `write` / `edit`)
    /// delegate to [`Self::run_readonly_file_tool_on_blocking_pool`] /
    /// [`Self::run_mutating_file_tool_on_blocking_pool`]: their bodies
    /// are synchronous syscalls, and with up to `MAX_PARALLEL_TOOLS` calls
    /// in flight per step they would otherwise pin tokio worker threads,
    /// starving the Bash output pumps, LLM streams, and steer queue on the
    /// same runtime.
    pub async fn execute_tool(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> Option<ExecutableToolResult> {
        self.execute_tool_ext(None, tool_name, args).await
    }

    /// [`Self::execute_tool`] with the caller's tool-call id, so the
    /// foreground `Agent` tool can key its lifecycle events onto the right
    /// transcript card (v2 `parentToolCallId`).
    pub async fn execute_tool_ext(
        &self,
        tool_call_id: Option<&str>,
        tool_name: &str,
        args: &Value,
    ) -> Option<ExecutableToolResult> {
        self.execute_tool_streaming(tool_call_id, tool_name, args, None)
            .await
    }

    /// [`Self::execute_tool_ext`] with a mid-execution output stream
    /// (P57): bash's stdout/stderr chunks are handed to `on_update` so the
    /// host can drive live `tool.progress` cards.
    pub async fn execute_tool_streaming(
        &self,
        tool_call_id: Option<&str>,
        tool_name: &str,
        args: &Value,
        on_update: Option<OutputUpdate<'_>>,
    ) -> Option<ExecutableToolResult> {
        match tool_name.to_ascii_lowercase().as_str() {
            "read" => {
                self.run_readonly_file_tool_on_blocking_pool(args, Self::read)
                    .await
            }
            "grep" => {
                self.run_readonly_file_tool_on_blocking_pool(args, Self::grep)
                    .await
            }
            "glob" => {
                self.run_readonly_file_tool_on_blocking_pool(args, Self::glob)
                    .await
            }
            "listdirectory" | "list_directory" => {
                list_directory::execute_list_directory(&self.root, args)
            }
            "fetchurl" | "fetch_url" => fetch_url::execute_fetch_url(args).await,
            "websearch" | "web_search" => web_search::execute_web_search(args).await,
            "invokesubagent" | "invoke_subagent" => {
                let mgr = self.subagent_manager.as_ref()?;
                Some(subagent_tools::execute_invoke_subagent(mgr, args).await)
            }
            "managesubagents" | "manage_subagents" => {
                let mgr = self.subagent_manager.as_deref()?;
                Some(subagent_tools::execute_manage_subagents(mgr, args).await)
            }
            "definesubagent" | "define_subagent" => {
                let mgr = self.subagent_manager.as_deref()?;
                Some(subagent_tools::execute_define_subagent(mgr, args).await)
            }
            "askuserquestion" | "ask_user_question" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(ask_user_question::execute_ask_user_question(callbacks, args).await)
            }
            "getgoal" | "get_goal" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(get_goal::execute_get_goal(callbacks, args).await)
            }
            "todolist" | "todo_list" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(todo_list::execute_todo_list(callbacks, args).await)
            }
            "enterplanmode" | "enter_plan_mode" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(plan_mode::execute_enter_plan_mode(callbacks, args).await)
            }
            "cronlist" | "cron_list" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(cron_tools::execute_cron_list(callbacks, args).await)
            }
            "croncreate" | "cron_create" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(cron_tools::execute_cron_create(callbacks, args).await)
            }
            "crondelete" | "cron_delete" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(cron_tools::execute_cron_delete(callbacks, args).await)
            }
            "updategoal" | "update_goal" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(goal_tools::execute_update_goal(callbacks, args).await)
            }
            "setgoalbudget" | "set_goal_budget" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(goal_tools::execute_set_goal_budget(callbacks, args).await)
            }
            "tasklist" | "task_list" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(task_tools::execute_task_list(callbacks, args).await)
            }
            "taskoutput" | "task_output" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(task_tools::execute_task_output(callbacks, args).await)
            }
            "taskstop" | "task_stop" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(task_tools::execute_task_stop(callbacks, args).await)
            }
            "taskwait" | "task_wait" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(task_tools::execute_task_wait(callbacks, args).await)
            }
            "exitplanmode" | "exit_plan_mode" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(exit_plan_mode::execute_exit_plan_mode(callbacks, args).await)
            }
            "creategoal" | "create_goal" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(create_goal::execute_create_goal(callbacks, args).await)
            }
            "skill" => {
                let callbacks = self.callbacks.as_deref()?;
                Some(skill::execute_skill(callbacks, args).await)
            }
            "team" => {
                let mgr = self.subagent_manager.as_ref()?;
                Some(team_tool::execute_team(mgr, args).await)
            }
            "agent" => {
                let mgr = self.subagent_manager.as_ref()?;
                agent_tool::execute_agent(
                    mgr,
                    args,
                    self.subagent_timeout_ms,
                    self.effective_parent_cancel().as_ref(),
                    tool_call_id,
                )
                .await
            }
            "knowledge" => Some(knowledge_tool::execute_knowledge(&self.root, args)),
            "write" => {
                self.run_mutating_file_tool_on_blocking_pool(args, Self::write)
                    .await
            }
            "edit" => {
                self.run_mutating_file_tool_on_blocking_pool(args, Self::edit)
                    .await
            }
            "bash" => self.bash_with(args, on_update).await,
            _ if github::is_github_tool(tool_name) => {
                github::execute_github_tool(tool_name, args, self.github_credentials.as_ref()).await
            }
            _ => {
                if let Some(ref mcp) = self.mcp_manager
                    && mcp.handles(tool_name).await
                {
                    return mcp.call_tool(tool_name, args).await;
                }
                None
            }
        }
    }

    /// Execute a mutating tool natively. Callers must have obtained a
    /// permission grant from the host for this exact call first.
    pub async fn execute_mutating(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> Option<ExecutableToolResult> {
        match tool_name.to_ascii_lowercase().as_str() {
            "write" => {
                self.run_mutating_file_tool_on_blocking_pool(args, Self::write)
                    .await
            }
            "edit" => {
                self.run_mutating_file_tool_on_blocking_pool(args, Self::edit)
                    .await
            }
            "bash" => self.bash_with(args, None).await,
            _ => None,
        }
    }

    /// Run a synchronous read-only file-I/O tool (`read` / `grep` / `glob`) on
    /// tokio's blocking pool instead of the async worker thread. The closure
    /// must be `Send + 'static`, so only owned state crosses over: a clone of
    /// the sandbox root and of the JSON arguments (both cheap relative to the
    /// I/O the tool does). No other `NativeToolset` field is needed — these
    /// tools depend solely on the root.
    ///
    /// A `JoinError` (panic / runtime shutdown) returns `None`, which hands the
    /// call to the host: read-only tools are idempotent, so re-running one
    /// there is always safe, and a task lost to the runtime must not reach the
    /// model as a tool failure.
    async fn run_readonly_file_tool_on_blocking_pool(
        &self,
        args: &Value,
        tool: fn(&Path, &Value) -> Option<ExecutableToolResult>,
    ) -> Option<ExecutableToolResult> {
        match Self::spawn_file_tool(self.root.clone(), args.clone(), tool).await {
            Ok(result) => result,
            Err(e) => blocking_pool_failure(false, e.to_string()),
        }
    }

    /// Run a synchronous mutating file-I/O tool (`write` / `edit`) on tokio's
    /// blocking pool. Same ownership rules as the read-only variant, but a
    /// `JoinError` becomes an error result rather than a `None` host fallback:
    /// the call was already permission-granted and may have partially applied,
    /// so letting the host re-run it could double-apply the change.
    async fn run_mutating_file_tool_on_blocking_pool(
        &self,
        args: &Value,
        tool: fn(&Path, &Value) -> Option<ExecutableToolResult>,
    ) -> Option<ExecutableToolResult> {
        match Self::spawn_file_tool(self.root.clone(), args.clone(), tool).await {
            Ok(result) => result,
            Err(e) => blocking_pool_failure(true, e.to_string()),
        }
    }

    async fn spawn_file_tool(
        root: PathBuf,
        args: Value,
        tool: fn(&Path, &Value) -> Option<ExecutableToolResult>,
    ) -> Result<Option<ExecutableToolResult>, tokio::task::JoinError> {
        tokio::task::spawn_blocking(move || tool(&root, &args)).await
    }

    /// Resolve a path argument inside the workspace. `None` when the path
    /// escapes the sandbox or does not exist.
    fn resolve(root: &Path, path: &str) -> Option<PathBuf> {
        let candidate = Self::candidate_path(root, path);
        let resolved = std::fs::canonicalize(&candidate).ok()?;
        resolved.starts_with(root).then_some(resolved)
    }

    /// Like [`resolve`] but tolerates a not-yet-existing target: walks up to
    /// the nearest existing ancestor, canonicalizes it (resolving any
    /// symlink escapes), then rejoins the missing tail. `None` when the
    /// existing ancestor lies outside the sandbox.
    fn resolve_for_write(root: &Path, path: &str) -> Option<PathBuf> {
        let candidate = Self::candidate_path(root, path);
        if let Ok(resolved) = std::fs::canonicalize(&candidate) {
            return resolved.starts_with(root).then_some(resolved);
        }
        let mut missing: Vec<std::ffi::OsString> = Vec::new();
        let mut cursor = candidate.as_path();
        loop {
            match std::fs::canonicalize(cursor) {
                Ok(existing) => {
                    if !existing.starts_with(root) {
                        return None;
                    }
                    let mut resolved = existing;
                    for segment in missing.iter().rev() {
                        resolved = resolved.join(segment);
                    }
                    return resolved.starts_with(root).then_some(resolved);
                }
                Err(_) => {
                    missing.push(cursor.file_name()?.to_os_string());
                    cursor = cursor.parent()?;
                }
            }
        }
    }

    fn candidate_path(root: &Path, path: &str) -> PathBuf {
        if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        }
    }

    // ── Read ───────────────────────────────────────────────────────────

    fn read(root: &Path, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        // Image crop / full-resolution rendering lives on the host (media
        // pipeline) — never half-handle it here.
        if args.get("region").is_some_and(|v| !v.is_null())
            || args
                .get("full_resolution")
                .is_some_and(|v| v.as_bool() == Some(true))
        {
            return None;
        }
        // Negative offsets (tail reads) keep their host semantics.
        let offset = match args.get("line_offset") {
            None | Some(Value::Null) => 1,
            Some(v) => {
                let n = v.as_i64()?;
                if n < 1 {
                    return None;
                }
                n as usize
            }
        };
        let n_lines = match args.get("n_lines") {
            None | Some(Value::Null) => READ_MAX_LINES,
            Some(v) => (v.as_u64()? as usize).min(READ_MAX_LINES),
        };

        let resolved = Self::resolve(root, path)?;
        let meta = std::fs::metadata(&resolved).ok()?;
        if !meta.is_file() || meta.len() > READ_MAX_BYTES {
            return None;
        }
        let bytes = std::fs::read(&resolved).ok()?;

        // Encoding detection mirrors the host Read tool: BOM first, then the
        // zero-byte parity heuristic. UTF-16 payloads are transcoded whole;
        // binary-looking headers and invalid UTF-8 fall back to the host,
        // which owns the media pipeline and the full error contract.
        let header = &bytes[..bytes.len().min(encoding::ENCODING_DETECTION_SAMPLE_BYTES)];
        let detection = encoding::detect_text_encoding(header);
        let (text, encoding_note) =
            if !detection.seems_binary && detection.encoding != encoding::UtfTextEncoding::Utf8 {
                let decoded = encoding::decode_utf_text(&bytes, detection.encoding);
                (decoded, Some(detection.encoding))
            } else if detection.seems_binary {
                return None;
            } else {
                // Strict UTF-8: NUL bytes and malformed sequences are the host's
                // verdict (binary / not-UTF-8 errors), not a lossy native read.
                if bytes.contains(&0) {
                    return None;
                }
                let text = std::str::from_utf8(&bytes).ok()?.to_string();
                // A leading UTF-8 BOM is stripped like TextDecoder does.
                let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string();
                (text, None)
            };

        // Split keeping a trailing `\r` per line — the style-aware renderer
        // decides whether to strip it (pure CRLF) or make it visible (mixed).
        // A final newline does not produce a phantom empty line.
        let mut all: Vec<&str> = text.split('\n').collect();
        if all.last().is_some_and(|l| l.is_empty()) {
            all.pop();
        }
        let style = encoding::detect_line_ending_style(text.as_bytes());

        if offset > all.len() && !all.is_empty() {
            return Some(err_result(format!(
                "line_offset {offset} is past the end of {path} ({} lines)",
                all.len()
            )));
        }
        let start = (offset - 1).min(all.len());
        let end = (start + n_lines).min(all.len());
        // Line rendering mirrors the host Read tool: `${lineNo}\t${content}`,
        // CRLF-style trailing CRs stripped, per-line truncation to
        // READ_MAX_LINE_LENGTH characters with a `...` marker, lone CRs made
        // visible as `\r` on mixed files, and a READ_MAX_OUTPUT_BYTES budget.
        let mut out = String::new();
        let mut truncated_lines: Vec<usize> = Vec::new();
        let mut rendered_bytes = 0usize;
        let mut max_bytes_reached = false;
        let mut rendered_count = 0usize;
        for (i, raw) in all[start..end].iter().enumerate() {
            let mut rendered: String = (*raw).to_string();
            let mut was_truncated = false;
            if style == encoding::LineEndingStyle::CrLf && rendered.ends_with('\r') {
                rendered.pop();
            }
            if rendered.chars().count() > READ_MAX_LINE_LENGTH {
                const MARKER: &str = "...";
                let keep = READ_MAX_LINE_LENGTH - MARKER.len();
                rendered = rendered.chars().take(keep).collect();
                rendered.push_str(MARKER);
                was_truncated = true;
            }
            if style == encoding::LineEndingStyle::Mixed {
                rendered = encoding::make_carriage_returns_visible(&rendered);
            }
            let rendered_line = format!("{}\t{}", offset + i, rendered);
            // The separator byte between rendered lines counts toward the
            // budget (host renderedLineBytes accounting).
            let line_bytes = rendered_line.len() + usize::from(!out.is_empty());
            if !out.is_empty() && rendered_bytes + line_bytes > READ_MAX_OUTPUT_BYTES {
                max_bytes_reached = true;
                break;
            }
            if was_truncated {
                truncated_lines.push(offset + i);
            }
            out.push_str(&rendered_line);
            out.push('\n');
            rendered_count += 1;
            rendered_bytes += line_bytes;
            if rendered_bytes >= READ_MAX_OUTPUT_BYTES {
                max_bytes_reached = true;
                break;
            }
        }
        // Host-faithful `<system>` note (finishMessage in readTool.ts).
        let mut parts: Vec<String> = Vec::new();
        if rendered_count > 0 {
            parts.push(format!(
                "{rendered_count} {} read from file starting from line {offset}.",
                if rendered_count == 1 { "line" } else { "lines" }
            ));
        } else {
            parts.push("No lines read from file.".into());
        }
        parts.push(format!("Total lines in file: {}.", all.len()));
        let max_lines_reached =
            n_lines >= READ_MAX_LINES && rendered_count == n_lines && end < all.len();
        if max_lines_reached {
            parts.push(format!("Max {READ_MAX_LINES} lines reached."));
        } else if max_bytes_reached {
            parts.push(format!("Max {READ_MAX_OUTPUT_BYTES} bytes reached."));
        } else if rendered_count < n_lines {
            parts.push("End of file reached.".into());
        }
        if !truncated_lines.is_empty() {
            let list = truncated_lines
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            parts.push(format!(
                "Lines [{list}] were truncated to {READ_MAX_LINE_LENGTH} characters; use Bash (e.g. cut or sed) to read the elided content of those lines."
            ));
        }
        if style == encoding::LineEndingStyle::Mixed {
            parts.push(
                "Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.".into(),
            );
        }
        if let Some(enc) = encoding_note {
            parts.push(format!(
                "Detected file encoding: {}; content transcoded to UTF-8 for display. Edit and Write expect UTF-8 — convert the file's encoding first (e.g. `iconv` via Bash).",
                enc.display_name()
            ));
        }
        let mut result = ok_result(out);
        result.note = Some(format!("<system>{}</system>", parts.join(" ")));
        Some(result)
    }

    // ── Grep ───────────────────────────────────────────────────────────

    /// Native Grep mirroring the host tool's public contract: default mode
    /// `files_with_matches` (most-recently-modified first), `content` with
    /// `-n`/`-A`/`-B`/`-C` context, `count_matches` with an aggregate
    /// summary, case-insensitive matching, offset/head_limit paging, plus the
    /// `type` / `include_ignored` / `multiline` ripgrep features the host
    /// otherwise owns. Each maps to the exact host rg flag: `type` -> `--type`,
    /// `include_ignored` -> `--no-ignore`, `multiline` -> `-U
    /// --multiline-dotall`.
    fn grep(root: &Path, args: &Value) -> Option<ExecutableToolResult> {
        // Argument typing is strict on purpose: the engine short-circuits ahead
        // of the host's zod validation, so a present-but-mistyped argument has
        // to return `None` (host fallback, which reports the schema error)
        // instead of being silently dropped and reported as a successful
        // search. Absent and explicit `null` both mean "the schema default".
        let pattern = args.get("pattern")?.as_str()?;
        // `type` -> rg `--type NAME`: restrict the walk to files whose basename
        // matches the type's globs. [`grep_types::RG_FILE_TYPES`] is only a
        // fast path transcribed from one rg release — the host runs whatever rg
        // is on PATH and honours user `--type-add` definitions (`.ripgreprc`),
        // so an unknown name falls back rather than synthesising rg's error.
        let type_filter = match args.get("type") {
            None | Some(Value::Null) => None,
            Some(value) => Some(build_type_glob(grep_types::rg_type_globs(
                value.as_str()?,
            )?)?),
        };
        // `multiline` -> rg `-U --multiline-dotall`: the pattern may span
        // newlines and `.` also matches `\n`. Matching crosses line boundaries,
        // so the scan buffers the whole file (a separate path, still bounded by
        // GREP_MAX_FILE_BYTES and the binary-skip contract).
        let multiline = bool_arg(args, "multiline", false)?;
        // `include_ignored` -> rg `--no-ignore`: don't respect ignore files
        // (.gitignore/.ignore/.rgignore and friends). VCS metadata dirs and
        // sensitive files stay filtered regardless.
        let include_ignored = bool_arg(args, "include_ignored", false)?;
        let case_insensitive = bool_arg(args, "-i", false)?;
        let line_numbers = bool_arg(args, "-n", true)?;
        let output_mode = match args.get("output_mode") {
            None | Some(Value::Null) => "files_with_matches",
            Some(value) => match value.as_str()? {
                mode @ ("files_with_matches" | "content" | "count_matches") => mode,
                _ => return None,
            },
        };
        let context_both = u64_arg(args, "-C", 0)? as usize;
        let context_after = (u64_arg(args, "-A", 0)? as usize).max(context_both);
        let context_before = (u64_arg(args, "-B", 0)? as usize).max(context_both);
        let head_limit = u64_arg(args, "head_limit", GREP_HEAD_LIMIT as u64)? as usize;
        let page_offset = u64_arg(args, "offset", 0)? as usize;

        let mut builder = regex::RegexBuilder::new(pattern);
        builder.case_insensitive(case_insensitive);
        // rg `--multiline-dotall` makes `.` match `\n` (only meaningful with
        // `-U`, which the multiline scan path provides).
        builder.dot_matches_new_line(multiline);
        // rg also keeps `^`/`$` anchored per line in `-U` mode (ripgrep 15.0.0:
        // `rg -U --count-matches '^'` on "a\nb\n" reports 2), while the
        // streaming path anchors per line by construction.
        builder.multi_line(multiline);
        let regex = match builder.build() {
            Ok(r) => r,
            Err(e) => return Some(err_result(format!("invalid regex: {e}"))),
        };
        let glob_filter = match args.get("glob") {
            None | Some(Value::Null) => None,
            Some(value) => Some(build_glob(value.as_str()?)?),
        };

        let search_root = match args.get("path") {
            None | Some(Value::Null) => root.to_path_buf(),
            Some(value) => Self::resolve(root, value.as_str()?)?,
        };

        let mode = match output_mode {
            "files_with_matches" => GrepMode::FilesWithMatches,
            "count_matches" => GrepMode::CountMatches,
            _ => GrepMode::Content,
        };
        let scan_cfg = GrepScanConfig {
            regex: &regex,
            mode,
            context_before,
            context_after,
            line_numbers,
            multiline,
        };
        // The wall-clock budget becomes a deadline instant the parallel
        // workers compare against (replacing the old serial `elapsed()` check).
        let deadline = Instant::now() + GREP_TIME_BUDGET;
        let GrepCollected {
            mut per_file,
            mut filtered_sensitive,
            timed_out,
            mut file_cap_truncated,
        } = grep_collect(
            &search_root,
            root,
            &scan_cfg,
            glob_filter.as_ref(),
            type_filter.as_ref(),
            include_ignored,
            GrepWalkLimits {
                deadline,
                scan_cap: GREP_WALK_SCAN_CAP,
            },
        );
        // The walk is unordered; make the sensitive-file notice deterministic.
        filtered_sensitive.sort();
        // Ordering first, hard file cap second: the parallel walk cannot stop
        // at an exact global count, so truncating the unordered aggregate would
        // keep a scheduling-dependent subset — and `head_limit` then pages over
        // whatever that subset happened to be.
        file_cap_truncated |= grep_sort_and_cap(&mut per_file, mode, GREP_MAX_FILES);

        // Rendered output lines, then offset/head_limit paging (host order).
        let mut rendered: Vec<String> = Vec::new();
        match mode {
            GrepMode::FilesWithMatches => {
                for file in &per_file {
                    rendered.push(file.display.clone());
                }
            }
            GrepMode::CountMatches => {
                for file in &per_file {
                    rendered.push(format!("{}:{}", file.display, file.total_matches));
                }
            }
            GrepMode::Content => {
                // Each file's merged `-A`/`-B`/`-C` windows and `--` cluster
                // separators were rendered during the parallel scan; splice
                // them together in the deterministic file order.
                for file in &per_file {
                    rendered.extend(file.rendered.iter().cloned());
                }
            }
        }

        let mut output_truncated = false;
        if rendered.iter().map(|l| l.len() + 1).sum::<usize>() > GREP_MAX_OUTPUT_BYTES {
            let mut bytes = 0usize;
            let mut keep = 0usize;
            for line in &rendered {
                let line_bytes = line.len() + 1; // trailing \n separator
                if bytes + line_bytes > GREP_MAX_OUTPUT_BYTES {
                    break;
                }
                bytes += line_bytes;
                keep += 1;
            }
            rendered.truncate(keep);
            output_truncated = true;
        }

        let after_offset: Vec<String> = if page_offset > 0 {
            rendered.into_iter().skip(page_offset).collect()
        } else {
            rendered
        };
        let limited: Vec<String> = if head_limit > 0 {
            after_offset.iter().take(head_limit).cloned().collect()
        } else {
            after_offset.clone()
        };
        let pagination_truncated = head_limit > 0 && after_offset.len() > head_limit;

        let mut out = if limited.is_empty() {
            if !filtered_sensitive.is_empty() {
                "No non-sensitive matches found".to_string()
            } else {
                format!("No matches found for pattern: {pattern}")
            }
        } else {
            limited.join("\n")
        };

        let mut headers: Vec<String> = Vec::new();
        let mut messages: Vec<String> = Vec::new();
        if output_mode == "count_matches" && !per_file.is_empty() {
            let total_occurrences: usize = per_file.iter().map(|f| f.total_matches).sum();
            let occurrence_word = if total_occurrences == 1 {
                "occurrence"
            } else {
                "occurrences"
            };
            let file_word = if per_file.len() == 1 { "file" } else { "files" };
            let scope = if filtered_sensitive.is_empty() {
                "total"
            } else {
                "total non-sensitive"
            };
            headers.push(format!(
                "Found {total_occurrences} {scope} {occurrence_word} across {} {file_word}.",
                per_file.len()
            ));
        }
        if pagination_truncated {
            let total = after_offset.len() + page_offset;
            let next_offset = page_offset + head_limit;
            let notice = format!(
                "Results truncated to {head_limit} lines (total: {total}). Use offset={next_offset} to see more."
            );
            if output_mode == "count_matches" {
                headers.push(notice);
            } else {
                messages.push(notice);
            }
        }
        if output_truncated {
            messages.push(format!(
                "[Output truncated at {GREP_MAX_OUTPUT_BYTES} bytes — the result set is incomplete. Narrow the pattern, path, or glob filters and re-run to recover complete results.]"
            ));
        }
        if timed_out {
            messages.push(format!(
                "Grep timed out after {}s; partial results returned. Narrow the path, glob, or pattern and retry for complete results.",
                GREP_TIME_BUDGET.as_secs()
            ));
        }
        if !filtered_sensitive.is_empty() {
            messages.push(format!(
                "Filtered {} sensitive file(s): {}",
                filtered_sensitive.len(),
                filtered_sensitive.join(", ")
            ));
        }

        if !headers.is_empty() {
            out = format!("{}\n{out}", headers.join("\n"));
        }
        if !messages.is_empty() {
            out.push_str(&format!("\n\n{}", messages.join("\n")));
        }
        if file_cap_truncated {
            out.push_str("\n\n[truncated — refine the pattern or scope to see more]");
        }
        Some(ok_result(out))
    }

    // ── Glob ───────────────────────────────────────────────────────────

    fn glob(root: &Path, args: &Value) -> Option<ExecutableToolResult> {
        let pattern = args.get("pattern")?.as_str()?;
        // include_ignored changes walker semantics — let the host handle it.
        if args
            .get("include_ignored")
            .is_some_and(|v| v.as_bool() == Some(true))
        {
            return None;
        }
        let glob = build_glob(pattern)?;
        let search_root = match args.get("path").and_then(|p| p.as_str()) {
            Some(p) => Self::resolve(root, p)?,
            None => root.to_path_buf(),
        };

        let mut results: Vec<String> = Vec::new();
        let mut truncated = false;
        let walker = ignore::WalkBuilder::new(&search_root).build();
        for entry in walker.flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let path = entry.path();
            let relative = path.strip_prefix(&search_root).unwrap_or(path);
            if glob.is_match(relative) || glob.is_match(path) {
                let display = path.strip_prefix(root).unwrap_or(path);
                results.push(display.display().to_string());
                if results.len() >= GLOB_MAX_RESULTS {
                    truncated = true;
                    break;
                }
            }
        }
        results.sort();

        let mut out = if results.is_empty() {
            format!("No files matched pattern: {pattern}")
        } else {
            results.join("\n")
        };
        if truncated {
            out.push_str("\n\n[truncated — narrow the pattern to see more]");
        }
        Some(ok_result(out))
    }

    // ── Write ──────────────────────────────────────────────────────────

    fn write(root: &Path, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let content = args.get("content")?.as_str()?;
        let mode = match args.get("mode") {
            None | Some(Value::Null) => "overwrite",
            Some(v) => v.as_str()?,
        };
        let resolved = Self::resolve_for_write(root, path)?;
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        let bytes_written = match mode {
            "overwrite" => std::fs::write(&resolved, content)
                .ok()
                .map(|_| content.len()),
            "append" => {
                use std::io::Write;
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&resolved)
                    .ok()
                    .and_then(|mut f| f.write_all(content.as_bytes()).ok().map(|_| content.len()))
            }
            // Unknown mode — the host validates the enum; be safe.
            _ => return None,
        }?;
        // Output format mirrors the host Write tool.
        Some(ok_result(format!(
            "{} {bytes_written} bytes to {path}",
            if mode == "append" {
                "Appended"
            } else {
                "Wrote"
            }
        )))
    }

    // ── Edit ───────────────────────────────────────────────────────────

    fn edit(root: &Path, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let old = args.get("old_string")?.as_str()?;
        let new = args.get("new_string")?.as_str()?;
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let resolved = Self::resolve_for_write(root, path)?;

        let bytes = std::fs::read(&resolved).ok()?;
        if bytes.contains(&0) {
            return None; // binary files are the host's job
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let occurrence_count = text.matches(old).count();
        let updated = if replace_all {
            if occurrence_count == 0 {
                return Some(err_result(format!("old_string not found in {path}")));
            }
            text.replace(old, new)
        } else {
            if occurrence_count != 1 {
                return Some(err_result(format!(
                    "old_string matched {occurrence_count} times in {path} (expected exactly 1; widen the string or pass replace_all)"
                )));
            }
            text.replacen(old, new, 1)
        };
        std::fs::write(&resolved, updated).ok()?;
        let display = resolved.strip_prefix(root).unwrap_or(&resolved).display();
        Some(ok_result(format!("Edited {display}")))
    }

    // ── Bash ───────────────────────────────────────────────────────────

    /// [`Self::bash`] with a mid-execution output stream (P57): every chunk
    /// the child writes is handed to `on_update(kind, text)` so the host can
    /// drive live `tool.progress` cards. Chunks are throttled to one event
    /// per [`PROGRESS_MIN_INTERVAL_MS`] — a chatty command can write tens of
    /// MiBs per second, and flooding the host event line would slow the very
    /// turn the progress card is decorating. The model still receives the
    /// full output through the final result.
    async fn bash_with(
        &self,
        args: &Value,
        on_update: Option<OutputUpdate<'_>>,
    ) -> Option<ExecutableToolResult> {
        let command = args.get("command")?.as_str()?;
        // Background tasks (output persistence, task panel, notifications)
        // are host-owned — hand the call back untouched.
        if args.get("run_in_background").and_then(|v| v.as_bool()) == Some(true) {
            return None;
        }
        // Working directory defaults to the sandbox root; explicit cwd must
        // stay inside it. Returns `None` (host fallback) on escape — the
        // host applies its own cwd policy there.
        let working_dir = match args.get("cwd").and_then(|c| c.as_str()) {
            Some(cwd) => Self::resolve(&self.root, cwd)?,
            None => self.root.clone(),
        };
        // Timeout semantics mirror the host Bash tool: seconds, default 60,
        // capped at 300 for foreground commands.
        let timeout_s = args
            .get("timeout")
            .and_then(|v| v.as_u64())
            .unwrap_or(60)
            .min(BASH_MAX_SECONDS);
        let timeout = Duration::from_secs(timeout_s.max(1));

        // The host Bash contract is bash everywhere (Git Bash on Windows);
        // without the host's shell path on Windows there is no faithful
        // native execution, so `None` sends the call back to the host.
        let shell = self.shell.as_ref()?;
        // Mirror the host's non-interactive env: colors and prompts corrupt
        // output parsing, and git must never hang on a credential prompt.
        let mut child = tokio::process::Command::new(shell)
            .arg("-c")
            .arg(command)
            .current_dir(&working_dir)
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("SHELL", shell)
            // The engine's own stdin is the host RPC transport. Inheriting it
            // would let any stdin-reading command (`cat`, `read`, `git`,
            // `npm init`) swallow host traffic and corrupt the protocol; on
            // Windows the inherited pipe also keeps Git Bash from exiting,
            // which hangs the turn. Commands get an empty stdin instead.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .ok()?;
        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        // The command is already running here, so a timeout must be reported
        // as a killed command — never fall back to the host, which would
        // re-execute it.
        use tokio::io::AsyncReadExt;
        let last_emit = std::sync::Mutex::new(
            std::time::Instant::now() - Duration::from_millis(PROGRESS_MIN_INTERVAL_MS),
        );
        let emit = |kind: &str, text: &str| {
            let Ok(mut last) = last_emit.lock() else {
                return;
            };
            if last.elapsed().as_millis() >= PROGRESS_MIN_INTERVAL_MS as u128 {
                *last = std::time::Instant::now();
                if let Some(cb) = on_update {
                    cb(kind, text);
                }
            }
        };
        let waited = tokio::time::timeout(timeout, async {
            let (out, err, status) = tokio::join!(
                async {
                    let mut buf = Vec::new();
                    if let Some(pipe) = stdout_pipe.as_mut() {
                        let mut chunk = [0u8; 8192];
                        loop {
                            match pipe.read(&mut chunk).await {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    emit("stdout", &String::from_utf8_lossy(&chunk[..n]));
                                    buf.extend_from_slice(&chunk[..n]);
                                }
                            }
                        }
                    }
                    buf
                },
                async {
                    let mut buf = Vec::new();
                    if let Some(pipe) = stderr_pipe.as_mut() {
                        let mut chunk = [0u8; 8192];
                        loop {
                            match pipe.read(&mut chunk).await {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    emit("stderr", &String::from_utf8_lossy(&chunk[..n]));
                                    buf.extend_from_slice(&chunk[..n]);
                                }
                            }
                        }
                    }
                    buf
                },
                child.wait(),
            );
            (out, err, status)
        })
        .await;
        let (stdout_bytes, stderr_bytes, exit_code) = match waited {
            Ok((out, err, Ok(status))) => (out, err, status.code().unwrap_or(-1)),
            // timeout or wait failure: kill and report
            _ => {
                let _ = child.kill().await;
                // Reap it. Killing leaves the child a zombie until it is
                // waited on, and this loop can hit the timeout repeatedly
                // within one turn.
                let _ = child.wait().await;
                return Some(err_result(format!(
                    "Command killed by timeout ({}s)",
                    timeout_s
                )));
            }
        };

        let mut text = String::from_utf8_lossy(&stdout_bytes).into_owned();
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        if !stderr.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(stderr.trim_end());
        }
        if text.len() > BASH_MAX_OUTPUT_BYTES {
            let mut cut = BASH_MAX_OUTPUT_BYTES;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str("\n[output truncated]");
        }

        if exit_code == 0 {
            let mut out = text;
            if out.trim().is_empty() {
                out = "Command executed successfully (no output).".into();
            }
            Some(ok_result(out))
        } else {
            Some(err_result(format!(
                "{text}\nCommand failed with exit code: {exit_code}."
            )))
        }
    }
}

// ── Grep parallel-scan helpers ───────────────────────────────────────────

/// Boolean tool argument: absent or explicit `null` yields `default`; a value
/// that is present but not a boolean yields `None`, which the caller turns into
/// a host fallback so the host's zod schema reports the malformed input instead
/// of the engine silently ignoring it.
fn bool_arg(args: &Value, key: &str, default: bool) -> Option<bool> {
    match args.get(key) {
        None | Some(Value::Null) => Some(default),
        Some(value) => value.as_bool(),
    }
}

/// Non-negative integer tool argument, with the same absent/null versus
/// mistyped distinction as [`bool_arg`] (the host schema is
/// `z.number().int().nonnegative()`).
fn u64_arg(args: &Value, key: &str, default: u64) -> Option<u64> {
    match args.get(key) {
        None | Some(Value::Null) => Some(default),
        Some(value) => value.as_u64(),
    }
}

/// Which native Grep output shape a scan produces; drives how much per-file
/// state the streaming scan retains.
#[derive(Clone, Copy, PartialEq, Eq)]
enum GrepMode {
    FilesWithMatches,
    CountMatches,
    Content,
}

/// Everything a streaming Grep scan needs, shared by reference across the
/// parallel walker's worker threads.
#[derive(Clone, Copy)]
struct GrepScanConfig<'a> {
    regex: &'a regex::Regex,
    mode: GrepMode,
    context_before: usize,
    context_after: usize,
    line_numbers: bool,
    /// rg `-U`: matches may span newlines, so the scan buffers the whole file
    /// and reports every physical line a match covers.
    multiline: bool,
}

/// A matching file's aggregated scan result. `rendered` is populated only in
/// `content` mode (the file's already-formatted context windows); the other
/// modes keep just the display path, mtime, and occurrence count, so a match
/// never drags whole-file line storage behind it.
struct FileScan {
    display: String,
    /// Modification time in whole seconds since the UNIX epoch, `0` when the
    /// platform cannot report one. Whole seconds are the host's granularity
    /// (`Math.trunc(mtimeMs / 1000)`); matching it exactly is what keeps the
    /// engine and the host in the same order for the same-second files a `git
    /// checkout` or `clone` leaves behind.
    mtime: u64,
    total_matches: usize,
    rendered: Vec<String>,
}

/// [`FileScan::mtime`] source: whole seconds since the UNIX epoch, `0` on any
/// failure (the host's stat-failure fallback).
fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Impose the mode's deterministic ordering on the aggregated walk results,
/// then apply the hard scanned-file cap. Sorting runs BEFORE truncation so the
/// survivors are the top-N of the contract order instead of a
/// scheduling-dependent slice of the unordered parallel walk. Returns `true`
/// when entries were dropped.
///
/// Ordering contract — identical on both sides (the host applies it in
/// `GrepTool.sortFilesWithMatchesByMtime`):
/// * `files_with_matches`: whole-second mtime DESC, ties broken by display path
///   ASC;
/// * `content` / `count_matches`: display path ASC (rg's own output order is
///   walk order, which the parallel walk deliberately does not reproduce).
fn grep_sort_and_cap(per_file: &mut Vec<FileScan>, mode: GrepMode, max_files: usize) -> bool {
    match mode {
        GrepMode::FilesWithMatches => per_file.sort_by(|a, b| {
            b.mtime
                .cmp(&a.mtime)
                .then_with(|| a.display.cmp(&b.display))
        }),
        GrepMode::CountMatches | GrepMode::Content => {
            per_file.sort_by(|a, b| a.display.cmp(&b.display));
        }
    }
    if per_file.len() > max_files {
        per_file.truncate(max_files);
        return true;
    }
    false
}

/// Worker threads for one parallel grep walk: [`GREP_WALK_THREADS`] capped by
/// the machine's own parallelism (never 0 — `ignore` treats that as "serial").
fn grep_walk_threads() -> usize {
    std::thread::available_parallelism()
        .map(|cpus| cpus.get())
        .unwrap_or(1)
        .clamp(1, GREP_WALK_THREADS)
}

/// Outcome of scanning one candidate file.
enum ScanOutcome {
    /// Not a match, binary, unreadable, or otherwise skipped silently.
    Skip,
    /// Larger than [`GREP_MAX_FILE_BYTES`]: skipped, but flips the caller's
    /// truncation notice.
    Oversized,
    /// A match, with the per-file aggregate.
    Match(FileScan),
}

/// Aggregated result of the parallel walk, before mode-specific rendering.
struct GrepCollected {
    per_file: Vec<FileScan>,
    filtered_sensitive: Vec<String>,
    timed_out: bool,
    file_cap_truncated: bool,
}

/// Walk-level bounds every worker shares. Kept in one `Copy` struct so the
/// walker's signature stays within the argument budget and so both guards are
/// documented together: they are the two best-effort stop conditions (a worker
/// that trips either one quits, and the aggregate is flagged as partial).
#[derive(Clone, Copy)]
struct GrepWalkLimits {
    /// Wall-clock cutoff ([`GREP_TIME_BUDGET`] from the call's start).
    deadline: Instant,
    /// Soft memory guard ([`GREP_WALK_SCAN_CAP`]): how many files the walk may
    /// visit before workers stop scanning.
    scan_cap: usize,
}

/// Fan the walk out across a bounded worker pool using `ignore`'s own
/// work-stealing `WalkParallel` (no extra runtime dependency — `ignore` already
/// pulls in `crossbeam-deque` for this). Each worker streams its files
/// line-by-line and pushes only the output window it needs, and stops scanning
/// once `limits.scan_cap` files have been visited, so peak memory stays bounded
/// regardless of repo size. The walk is intentionally unordered; the caller
/// imposes the mode's deterministic ordering afterwards.
fn grep_collect(
    search_root: &Path,
    root: &Path,
    cfg: &GrepScanConfig,
    glob_filter: Option<&globset::GlobSet>,
    type_filter: Option<&globset::GlobSet>,
    include_ignored: bool,
    limits: GrepWalkLimits,
) -> GrepCollected {
    use ignore::WalkState;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    let collected: Arc<Mutex<Vec<FileScan>>> = Arc::new(Mutex::new(Vec::new()));
    let sensitive: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let timed_out = Arc::new(AtomicBool::new(false));
    let oversized = Arc::new(AtomicBool::new(false));
    let scanned = Arc::new(AtomicUsize::new(0));

    let collected_walk = Arc::clone(&collected);
    let sensitive_walk = Arc::clone(&sensitive);
    let timed_walk = Arc::clone(&timed_out);
    let oversized_walk = Arc::clone(&oversized);
    let scanned_walk = Arc::clone(&scanned);
    let cfg_copy = *cfg;

    // rg `--no-ignore` (include_ignored) turns off every ignore source: repo
    // .gitignore, .git/info/exclude, the global gitignore, .ignore/.rgignore,
    // and parent-directory ignore files. Hidden files stay searched either way
    // (rg `--hidden`), and the walk closure still drops VCS dirs + sensitive
    // files below.
    let mut builder = ignore::WalkBuilder::new(search_root);
    builder.hidden(false);
    builder.threads(grep_walk_threads());
    if include_ignored {
        builder
            .ignore(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .parents(false);
    }
    builder.build_parallel().run(move || {
        let collected = Arc::clone(&collected_walk);
        let sensitive = Arc::clone(&sensitive_walk);
        let timed_out = Arc::clone(&timed_walk);
        let oversized = Arc::clone(&oversized_walk);
        let scanned = Arc::clone(&scanned_walk);
        Box::new(move |entry: Result<ignore::DirEntry, ignore::Error>| {
            // The wall-clock budget is an atomic flag every worker can
            // check; hitting it flips `timed_out` and asks the walk to
            // stop (Quit is best-effort, so a few stragglers may land).
            if Instant::now() >= limits.deadline {
                timed_out.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let path = entry.path();
            if path.components().any(|c| {
                matches!(
                    c.as_os_str().to_str(),
                    Some(name) if VCS_DIRECTORIES_TO_EXCLUDE.contains(&name)
                )
            }) {
                return WalkState::Continue;
            }
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            if let Some(gs) = glob_filter
                && !gs.is_match(path)
            {
                return WalkState::Continue;
            }
            // rg `--type` matches the type globs against the file NAME, so
            // an exact glob like `BUILD` still matches `nested/BUILD`.
            if let Some(ts) = type_filter
                && !path.file_name().is_some_and(|name| ts.is_match(name))
            {
                return WalkState::Continue;
            }
            // Mirror the host Grep tool: matches inside sensitive files
            // (.env, keys, credentials, ...) are never reported.
            if is_sensitive_file(&path.to_string_lossy()) {
                let display = path.strip_prefix(root).unwrap_or(path);
                sensitive
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(display.display().to_string());
                return WalkState::Continue;
            }
            // Soft memory guard: every scanned file may contribute nearly
            // GREP_MAX_FILE_BYTES of rendered windows that stay live until the
            // caller sorts and truncates them. A parallel walk cannot stop at
            // an exact global count, so workers quit past the soft cap
            // (best-effort, exactly like the deadline above) and flag the
            // result as truncated.
            if scanned.fetch_add(1, Ordering::Relaxed) >= limits.scan_cap {
                oversized.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let outcome = if cfg_copy.multiline {
                scan_grep_file_multiline(path, root, &cfg_copy)
            } else {
                scan_grep_file(path, root, &cfg_copy)
            };
            match outcome {
                ScanOutcome::Oversized => oversized.store(true, Ordering::Relaxed),
                ScanOutcome::Match(file) => collected
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(file),
                ScanOutcome::Skip => {}
            }
            WalkState::Continue
        })
    });

    GrepCollected {
        per_file: collected
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect(),
        filtered_sensitive: sensitive
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect(),
        timed_out: timed_out.load(Ordering::Relaxed),
        file_cap_truncated: oversized.load(Ordering::Relaxed),
    }
}

/// Stream one file line-by-line (never buffering the whole file), applying
/// the host Grep contract: skip binary files (any NUL byte), skip files with
/// no match, count occurrences per line like `rg --count-matches`, and — in
/// `content` mode — retain only the merged `-A`/`-B`/`-C` context windows
/// (clusters separated by `--`), not every line of the file.
fn scan_grep_file(path: &Path, root: &Path, cfg: &GrepScanConfig) -> ScanOutcome {
    let Ok(file) = std::fs::File::open(path) else {
        return ScanOutcome::Skip;
    };
    // One metadata call serves both the size cap and the mtime (the previous
    // implementation stat'd the file twice).
    let Ok(meta) = file.metadata() else {
        return ScanOutcome::Skip;
    };
    if meta.len() > GREP_MAX_FILE_BYTES {
        return ScanOutcome::Oversized;
    }
    let mtime = mtime_secs(&meta);
    let display = path
        .strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string();
    scan_grep_lines(std::io::BufReader::new(file), cfg, display, mtime)
}

/// Streaming body of [`scan_grep_file`], split out over a generic line source
/// so the read-error contract is testable without a failing filesystem: an I/O
/// error part-way through drops the WHOLE file (`ScanOutcome::Skip`) instead of
/// reporting the already-read prefix as a complete result.
fn scan_grep_lines<R: std::io::BufRead>(
    mut reader: R,
    cfg: &GrepScanConfig,
    display: String,
    mtime: u64,
) -> ScanOutcome {
    let content = cfg.mode == GrepMode::Content;
    // `files_with_matches` only needs "has at least one match"; once found, the
    // regex is skipped for the rest of the file (still scanned for NUL so the
    // binary-skip contract holds).
    let only_need_presence = cfg.mode == GrepMode::FilesWithMatches;

    let mut buf: Vec<u8> = Vec::new();
    let mut total_matches = 0usize;
    let mut has_match = false;
    let mut idx = 0usize;

    // content-mode cluster state, bounded by one active cluster plus a
    // `context_before` lookback rather than the whole file.
    let mut lookback: std::collections::VecDeque<(usize, usize, String, bool)> =
        std::collections::VecDeque::new();
    let mut cluster: Vec<(usize, usize, String, bool)> = Vec::new();
    let mut cluster_hi = 0usize;
    let mut active = false;
    let mut rendered: Vec<String> = Vec::new();

    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            // `read_until` already retries interrupted reads, so any error here
            // is a real I/O failure: the rest of the file is unknown, and a
            // partial result would be indistinguishable from a complete one.
            Err(_) => return ScanOutcome::Skip,
        }
        let terminated = buf.last() == Some(&b'\n');
        if terminated {
            buf.pop();
        }
        // Mirror the host: any NUL byte marks the file binary and skips it
        // entirely. Breaking early is safe — the whole file would have been
        // discarded anyway.
        if buf.contains(&0) {
            return ScanOutcome::Skip;
        }
        // Emulate `str::lines()`: a terminated segment loses one trailing
        // `\r` (the `\r\n` case), then the explicit `strip_suffix('\r')` the
        // previous implementation applied.
        if terminated && buf.last() == Some(&b'\r') {
            buf.pop();
        }
        let seg = String::from_utf8_lossy(&buf);
        let trimmed: &str = seg.strip_suffix('\r').unwrap_or(&seg);
        let lineno = idx + 1;
        let matches_in_line = if only_need_presence && has_match {
            0
        } else {
            cfg.regex.find_iter(trimmed).count()
        };
        if matches_in_line > 0 {
            total_matches += matches_in_line;
            has_match = true;
        }
        let is_match = matches_in_line > 0;

        if content {
            if is_match {
                let lo = idx.saturating_sub(cfg.context_before);
                let hi = idx + cfg.context_after;
                if active && lo <= cluster_hi + 1 {
                    // Merge into the current cluster, filling the context gap
                    // between the last buffered line and this match from the
                    // lookback.
                    let cluster_end = cluster.last().map_or(lo, |c| c.0);
                    for lb in &lookback {
                        if lb.0 > cluster_end && lb.0 < idx {
                            cluster.push(lb.clone());
                        }
                    }
                    cluster.push((idx, lineno, trimmed.to_string(), true));
                    if hi > cluster_hi {
                        cluster_hi = hi;
                    }
                } else {
                    if active {
                        flush_grep_cluster(&mut rendered, &cluster, &display, cfg.line_numbers);
                        rendered.push("--".into());
                        cluster.clear();
                    }
                    active = true;
                    for lb in &lookback {
                        if lb.0 >= lo {
                            cluster.push(lb.clone());
                        }
                    }
                    cluster.push((idx, lineno, trimmed.to_string(), true));
                    cluster_hi = hi;
                }
            } else if active && idx <= cluster_hi {
                cluster.push((idx, lineno, trimmed.to_string(), false));
            }
            // Maintain the before-context lookback (only when it can pull
            // prior lines in).
            if cfg.context_before > 0 {
                lookback.push_back((idx, lineno, trimmed.to_string(), is_match));
                while lookback.len() > cfg.context_before {
                    lookback.pop_front();
                }
            }
        }
        idx += 1;
    }

    if !has_match {
        return ScanOutcome::Skip;
    }
    if content && active {
        flush_grep_cluster(&mut rendered, &cluster, &display, cfg.line_numbers);
    }
    ScanOutcome::Match(FileScan {
        display,
        mtime,
        total_matches,
        rendered,
    })
}

/// Multiline scan (rg `-U --multiline-dotall`). Cross-line matching cannot
/// stream, so the whole file is buffered — still bounded by
/// [`GREP_MAX_FILE_BYTES`] and the binary (NUL) skip contract. The regex runs
/// once over the full text; each match marks every physical line it spans as a
/// match line, then the same cluster/context renderer as the single-line path
/// produces byte-identical `-A`/`-B`/`-C` output. `count_matches` counts rg
/// matches (not spanned lines), matching `rg --count-matches -U`.
fn scan_grep_file_multiline(path: &Path, root: &Path, cfg: &GrepScanConfig) -> ScanOutcome {
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(path) else {
        return ScanOutcome::Skip;
    };
    let Ok(meta) = file.metadata() else {
        return ScanOutcome::Skip;
    };
    if meta.len() > GREP_MAX_FILE_BYTES {
        return ScanOutcome::Oversized;
    }
    let mtime = mtime_secs(&meta);
    let display = path
        .strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string();

    let mut raw: Vec<u8> = Vec::with_capacity(meta.len() as usize);
    if file.read_to_end(&mut raw).is_err() {
        return ScanOutcome::Skip;
    }
    // Mirror the host: any NUL byte marks the file binary and skips it whole.
    if raw.contains(&0) {
        return ScanOutcome::Skip;
    }
    let content = String::from_utf8_lossy(&raw);

    // Split into display lines (each loses one trailing `\r`, mirroring the
    // host's per-line `stripTrailingCarriageReturn`). A trailing newline does
    // not create a final empty line — same count as the streaming path.
    let mut lines: Vec<&str> = Vec::new();
    let mut seg_start = 0usize;
    for (i, &b) in content.as_bytes().iter().enumerate() {
        if b == b'\n' {
            let seg = &content[seg_start..i];
            lines.push(seg.strip_suffix('\r').unwrap_or(seg));
            seg_start = i + 1;
        }
    }
    if seg_start < content.len() {
        let seg = &content[seg_start..];
        lines.push(seg.strip_suffix('\r').unwrap_or(seg));
    }

    let only_need_presence = cfg.mode == GrepMode::FilesWithMatches;
    let mark_lines = cfg.mode == GrepMode::Content;
    let mut is_match_line = vec![false; lines.len()];
    let last_idx = lines.len().saturating_sub(1);

    // find_iter yields non-overlapping matches in increasing order, so both
    // `start` and `end-1` advance monotonically; a single newline cursor maps
    // byte offsets to line indices in O(file) total rather than O(file*matches).
    let bytes = content.as_bytes();
    let mut cursor = 0usize;
    let mut nl = 0usize;
    let mut line_at = |off: usize| -> usize {
        let target = off.min(bytes.len());
        while cursor < target {
            if bytes[cursor] == b'\n' {
                nl += 1;
            }
            cursor += 1;
        }
        nl
    };

    // Which lines a match covers, and the `--count-matches` number, are
    // pinned against ripgrep 15.0.0 (`rg -U --multiline-dotall`):
    //
    // * A zero-width match sitting on a `\n` byte also marks the line *after*
    //   that terminator (`$` on "a\nb" prints both lines but counts 1).
    // * A zero-width match at the very end of the buffer is normally dropped:
    //   `x*` counts `len` matches, not `len + 1`, and `\z` finds nothing in a
    //   file that ends with `\n`. The one exception rg keeps is a pattern whose
    //   *only* match is that EOF position in a file with no trailing newline
    //   (`\z` on "ab" counts 1 and prints the last line) — dropping it there
    //   would lose the file from `files_with_matches` entirely.
    //
    // The regex crate's own `find_iter` already applies rg's empty-match
    // dedup (an empty match at the previous match's end is skipped), so only
    // the EOF cases need handling here.
    let line_count = lines.len();
    let mut total_matches = 0usize;
    for m in cfg.regex.find_iter(&content) {
        if m.start() == m.end() && m.start() >= content.len() {
            let sole_match = total_matches == 0;
            let dangling_last_line = !content.is_empty() && !content.ends_with('\n');
            if !sole_match || !dangling_last_line {
                continue;
            }
            total_matches += 1;
            if mark_lines && line_count > 0 {
                is_match_line[last_idx] = true;
            }
            continue;
        }
        total_matches += 1;
        if only_need_presence {
            break;
        }
        if mark_lines && line_count > 0 {
            let start_line = line_at(m.start()).min(last_idx);
            let end_line = if m.end() > m.start() {
                line_at(m.end() - 1)
            } else if bytes.get(m.start()) == Some(&b'\n') {
                start_line + 1
            } else {
                start_line
            }
            .min(last_idx);
            for slot in is_match_line.iter_mut().take(end_line + 1).skip(start_line) {
                *slot = true;
            }
        }
    }
    if total_matches == 0 {
        return ScanOutcome::Skip;
    }

    let mut rendered: Vec<String> = Vec::new();
    if mark_lines {
        let mut lookback: std::collections::VecDeque<(usize, usize, String, bool)> =
            std::collections::VecDeque::new();
        let mut cluster: Vec<(usize, usize, String, bool)> = Vec::new();
        let mut cluster_hi = 0usize;
        let mut active = false;
        for (idx, text) in lines.iter().enumerate() {
            let lineno = idx + 1;
            let is_match = is_match_line[idx];
            if is_match {
                let lo = idx.saturating_sub(cfg.context_before);
                let hi = idx + cfg.context_after;
                if active && lo <= cluster_hi + 1 {
                    let cluster_end = cluster.last().map_or(lo, |c| c.0);
                    for lb in &lookback {
                        if lb.0 > cluster_end && lb.0 < idx {
                            cluster.push(lb.clone());
                        }
                    }
                    cluster.push((idx, lineno, (*text).to_string(), true));
                    if hi > cluster_hi {
                        cluster_hi = hi;
                    }
                } else {
                    if active {
                        flush_grep_cluster(&mut rendered, &cluster, &display, cfg.line_numbers);
                        rendered.push("--".into());
                        cluster.clear();
                    }
                    active = true;
                    for lb in &lookback {
                        if lb.0 >= lo {
                            cluster.push(lb.clone());
                        }
                    }
                    cluster.push((idx, lineno, (*text).to_string(), true));
                    cluster_hi = hi;
                }
            } else if active && idx <= cluster_hi {
                cluster.push((idx, lineno, (*text).to_string(), false));
            }
            if cfg.context_before > 0 {
                lookback.push_back((idx, lineno, (*text).to_string(), is_match));
                while lookback.len() > cfg.context_before {
                    lookback.pop_front();
                }
            }
        }
        if active {
            flush_grep_cluster(&mut rendered, &cluster, &display, cfg.line_numbers);
        }
    }

    ScanOutcome::Match(FileScan {
        display,
        mtime,
        total_matches,
        rendered,
    })
}

/// Render one merged context cluster: match lines use `:`, context lines use
/// `-`, with the display path prefix and (optionally) the line number, exactly
/// as the host `content` mode does.
fn flush_grep_cluster(
    rendered: &mut Vec<String>,
    cluster: &[(usize, usize, String, bool)],
    display: &str,
    line_numbers: bool,
) {
    for (_, lineno, text, is_match) in cluster {
        let sep = if *is_match { ':' } else { '-' };
        if line_numbers {
            rendered.push(format!("{display}{sep}{lineno}{sep}{text}"));
        } else {
            rendered.push(format!("{display}{sep}{text}"));
        }
    }
}

/// Compile a glob, auto-prefixing bare patterns with `**/` the way the JS
/// Glob tool does, so `*.rs` matches at any depth.
fn build_glob(pattern: &str) -> Option<globset::GlobSet> {
    let mut builder = globset::GlobSetBuilder::new();
    builder.add(globset::Glob::new(pattern).ok()?);
    if !pattern.starts_with("**/") && !pattern.contains('/') && !pattern.contains('\\') {
        builder.add(globset::Glob::new(&format!("**/{pattern}")).ok()?);
    }
    builder.build().ok()
}

/// Compile a ripgrep file type's globs into a set matched against the file
/// NAME (rg `--type` semantics). Unlike [`build_glob`], no `**/` prefix is
/// added: type globs are basename patterns and rg matches them on the file
/// name alone. Returns `None` if any glob fails to compile, which falls back
/// to the host (rg's own table always compiles, so this is defensive only).
fn build_type_glob(globs: &[&str]) -> Option<globset::GlobSet> {
    let mut builder = globset::GlobSetBuilder::new();
    for g in globs {
        builder.add(globset::Glob::new(g).ok()?);
    }
    builder.build().ok()
}

/// Map a blocking-pool `JoinError` onto the tool's mutability: read-only tools
/// (`read` / `grep` / `glob`) are idempotent, so `None` sends the call back to
/// the host instead of failing it; mutating tools (`write` / `edit`) hold a
/// permission grant and may have partially applied, so the failure is reported
/// rather than risking a double write through the host path.
fn blocking_pool_failure(mutating: bool, message: String) -> Option<ExecutableToolResult> {
    if mutating {
        Some(err_result(format!("native tool task failed: {message}")))
    } else {
        None
    }
}

fn ok_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: false,
        note: None,
    }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: true,
        note: None,
    }
}

// ── Sensitive file detection (port of host path-access.ts) ────────────────

const SENSITIVE_BASENAMES: [&str; 5] = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "credentials"];
const SENSITIVE_PATH_SUFFIXES: [&str; 2] = [".aws/credentials", ".gcp/credentials"];
const ENV_PREFIX: &str = ".env.";
const ENV_EXEMPTIONS: [&str; 3] = [".env.example", ".env.sample", ".env.template"];
const SENSITIVE_BASENAME_PREFIXES: [&str; 4] = ["id_rsa", "id_ed25519", "id_ecdsa", "credentials"];
const PUBLIC_KEY_BASENAMES: [&str; 3] = ["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"];
const SENSITIVE_DOT_VARIANT_SUFFIXES: [&str; 10] = [
    ".bak",
    ".backup",
    ".copy",
    ".disabled",
    ".key",
    ".old",
    ".orig",
    ".pem",
    ".save",
    ".tmp",
];

/// Mirror of the host's `isSensitiveFile` (path-access.ts), including the
/// native fast path's separator equivalence (both `/` and `\` match).
fn is_sensitive_file(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let comparable_name = name.to_ascii_lowercase();
    let comparable_path = path.to_ascii_lowercase().replace('\\', "/");

    if ENV_EXEMPTIONS.contains(&comparable_name.as_str()) {
        return false;
    }
    if PUBLIC_KEY_BASENAMES.contains(&comparable_name.as_str()) {
        return false;
    }
    if SENSITIVE_BASENAMES.contains(&comparable_name.as_str()) {
        return true;
    }
    if comparable_name.starts_with(ENV_PREFIX) {
        return true;
    }

    for prefix in SENSITIVE_BASENAME_PREFIXES {
        if comparable_name == prefix {
            return true;
        }
        if comparable_name.len() > prefix.len() && comparable_name.starts_with(prefix) {
            let suffix = &comparable_name[prefix.len()..];
            let next = suffix.chars().next();
            if next == Some('-') || next == Some('_') {
                return true;
            }
            if next == Some('.') && SENSITIVE_DOT_VARIANT_SUFFIXES.contains(&suffix) {
                return true;
            }
        }
    }

    for suffix in SENSITIVE_PATH_SUFFIXES {
        if comparable_path.ends_with(&format!("/{suffix}")) {
            return true;
        }
        if comparable_path.contains(&format!("/{suffix}/")) {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, NativeToolset) {
        setup_with_shell(None)
    }

    fn setup_with_shell(shell: Option<&str>) -> (tempfile::TempDir, NativeToolset) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/lib.rs"),
            "fn main() {}\n// beta marker\n",
        )
        .unwrap();
        let toolset = NativeToolset::new(dir.path().to_str().unwrap(), shell).unwrap();
        (dir, toolset)
    }

    /// Locate a bash for native-Bash tests; `None` skips them (Windows CI
    /// without Git Bash on PATH keeps the host fallback contract anyway).
    fn find_bash() -> Option<String> {
        for candidate in ["bash", "C:\\Program Files\\Git\\bin\\bash.exe"] {
            let ok = std::process::Command::new(candidate)
                .arg("-c")
                .arg("exit 0")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if ok {
                return Some(candidate.to_string());
            }
        }
        None
    }

    #[test]
    fn new_rejects_missing_root() {
        assert!(NativeToolset::new("/definitely/not/a/real/dir", None).is_none());
    }

    #[test]
    fn read_returns_numbered_lines() {
        let (_dir, ts) = setup();
        let result = ts.execute("Read", &json!({ "path": "a.txt" })).unwrap();
        assert!(!result.is_error);
        // Host Read line format: `${lineNo}	${content}`.
        assert!(
            result.content.contains("1	alpha"),
            "content: {}",
            result.content
        );
        assert!(result.content.contains("3	gamma"));
    }

    #[test]
    fn read_respects_offset_and_count() {
        let (_dir, ts) = setup();
        let result = ts
            .execute(
                "read",
                &json!({ "path": "a.txt", "line_offset": 2, "n_lines": 1 }),
            )
            .unwrap();
        assert!(result.content.contains("2	beta"));
        assert!(!result.content.contains("alpha"));
        assert!(!result.content.contains("3	gamma"));
    }

    #[test]
    fn read_image_region_args_fall_back() {
        let (_dir, ts) = setup();
        assert!(
            ts.execute(
                "Read",
                &json!({ "path": "a.txt", "region": { "x": 0, "y": 0, "width": 1, "height": 1 } })
            )
            .is_none()
        );
    }

    #[test]
    fn grep_filters_sensitive_files() {
        let (_dir, ts) = setup();
        std::fs::write(
            _dir.path().join(".env"),
            "SECRET=leaked
",
        )
        .unwrap();
        std::fs::write(
            _dir.path().join("app.rs"),
            "SECRET=name
",
        )
        .unwrap();
        let result = ts.execute("Grep", &json!({ "pattern": "SECRET" })).unwrap();
        assert!(
            result.content.contains("app.rs"),
            "content: {}",
            result.content
        );
        assert!(
            !result.content.contains("leaked"),
            "sensitive content must be filtered"
        );
        assert!(result.content.contains("Filtered 1 sensitive file(s)"));
    }

    #[tokio::test]
    async fn write_append_mode_appends() {
        let (_dir, ts) = setup();
        ts.execute_mutating("Write", &json!({ "path": "log.txt", "content": "one" }))
            .await
            .unwrap();
        let result = ts
            .execute_mutating(
                "Write",
                &json!({ "path": "log.txt", "content": "two", "mode": "append" }),
            )
            .await
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(result.content.starts_with("Appended"));
        assert_eq!(
            std::fs::read_to_string(_dir.path().join("log.txt")).unwrap(),
            "onetwo"
        );
    }

    #[test]
    fn write_unknown_mode_falls_back() {
        let (_dir, ts) = setup();
        assert!(
            ts.execute(
                "Write",
                &json!({ "path": "a.txt", "content": "x", "mode": "truncate-half" })
            )
            .is_none()
        );
    }

    #[test]
    fn is_sensitive_file_matches_host_list() {
        assert!(is_sensitive_file(".env"));
        assert!(is_sensitive_file("config/.env"));
        assert!(is_sensitive_file("keys/id_rsa"));
        assert!(is_sensitive_file("id_rsa.pem"));
        assert!(is_sensitive_file(".aws/credentials"));
        assert!(is_sensitive_file("C:/repo/.env.local"));
        assert!(!is_sensitive_file(".env.example"));
        assert!(!is_sensitive_file("id_rsa.pub"));
        assert!(!is_sensitive_file("src/main.rs"));
    }

    #[test]
    fn read_outside_workspace_falls_back() {
        let (_dir, ts) = setup();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        let escaped = outside.path().join("secret.txt");
        assert!(
            ts.execute("Read", &json!({ "path": escaped.to_str().unwrap() }))
                .is_none()
        );
    }

    #[test]
    fn read_negative_offset_falls_back_to_host() {
        let (_dir, ts) = setup();
        assert!(
            ts.execute("Read", &json!({ "path": "a.txt", "line_offset": -5 }))
                .is_none()
        );
    }

    fn utf16le_bytes(text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    fn utf16be_bytes(text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        out
    }

    #[test]
    fn read_transcodes_utf16le_bom() {
        let (_dir, ts) = setup();
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend_from_slice(&utf16le_bytes("alpha\nbeta\n"));
        std::fs::write(_dir.path().join("u16.txt"), bytes).unwrap();
        let result = ts.execute("Read", &json!({ "path": "u16.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("1\talpha"),
            "content: {}",
            result.content
        );
        assert!(
            result.content.contains("2\tbeta"),
            "content: {}",
            result.content
        );
        let note = result.note.unwrap();
        assert!(
            note.contains("Detected file encoding: UTF-16 LE"),
            "note: {note}"
        );
    }

    #[test]
    fn read_transcodes_utf16be_bom() {
        let (_dir, ts) = setup();
        let mut bytes = vec![0xfe, 0xff];
        bytes.extend_from_slice(&utf16be_bytes("alpha\nbeta\n"));
        std::fs::write(_dir.path().join("u16.txt"), bytes).unwrap();
        let result = ts.execute("Read", &json!({ "path": "u16.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("1\talpha"),
            "content: {}",
            result.content
        );
        let note = result.note.unwrap();
        assert!(
            note.contains("Detected file encoding: UTF-16 BE"),
            "note: {note}"
        );
    }

    #[test]
    fn read_transcodes_bomless_utf16le() {
        let (_dir, ts) = setup();
        // Zero-byte parity heuristic: no BOM, zeros at odd indices.
        std::fs::write(_dir.path().join("u16.txt"), utf16le_bytes("alpha\n")).unwrap();
        let result = ts.execute("Read", &json!({ "path": "u16.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("1\talpha"),
            "content: {}",
            result.content
        );
    }

    #[test]
    fn read_binary_nul_falls_back_to_host() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("bin.dat"), b"plain prefix\x00\x01").unwrap();
        assert!(
            ts.execute("Read", &json!({ "path": "bin.dat" })).is_none(),
            "binary files stay on the host"
        );
    }

    #[test]
    fn read_invalid_utf8_falls_back_to_host() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("bad.txt"), b"a\xffb").unwrap();
        assert!(
            ts.execute("Read", &json!({ "path": "bad.txt" })).is_none(),
            "non-UTF-8 text stays on the host (full error contract)"
        );
    }

    #[test]
    fn read_strips_utf8_bom() {
        let (_dir, ts) = setup();
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(b"alpha\n");
        std::fs::write(_dir.path().join("bom.txt"), bytes).unwrap();
        let result = ts.execute("Read", &json!({ "path": "bom.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("1\talpha"),
            "content: {}",
            result.content
        );
        assert!(
            !result.content.contains('\u{FEFF}'),
            "BOM must be stripped: {}",
            result.content
        );
    }

    #[test]
    fn read_pure_crlf_normalized() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("crlf.txt"), b"alpha\r\nbeta\r\n").unwrap();
        let result = ts.execute("Read", &json!({ "path": "crlf.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("1\talpha"),
            "content: {}",
            result.content
        );
        assert!(
            !result.content.contains('\r'),
            "pure CRLF renders without CRs: {}",
            result.content
        );
        let note = result.note.unwrap();
        assert!(
            !note.contains("carriage-return"),
            "pure CRLF must not report mixed endings: {note}"
        );
    }

    #[test]
    fn read_mixed_line_endings_make_cr_visible() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("mixed.txt"), b"a\nb\r\n").unwrap();
        let result = ts.execute("Read", &json!({ "path": "mixed.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("2\tb\\r"),
            "content: {}",
            result.content
        );
        let note = result.note.unwrap();
        assert!(
            note.contains("carriage-return"),
            "mixed endings must be reported: {note}"
        );
    }

    #[test]
    fn read_truncates_long_lines_with_marker() {
        let (_dir, ts) = setup();
        let long_line = "a".repeat(3000);
        std::fs::write(
            _dir.path().join("long.txt"),
            format!("{long_line}\nshort\n"),
        )
        .unwrap();
        let result = ts.execute("Read", &json!({ "path": "long.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        let first = result.content.split('\n').next().unwrap();
        let text = first.strip_prefix("1\t").unwrap();
        assert!(text.ends_with("..."), "line: {text}");
        assert_eq!(text.chars().count(), 2000);
        let note = result.note.unwrap();
        assert!(
            note.contains("Lines [1] were truncated to 2000 characters"),
            "note: {note}"
        );
    }

    #[test]
    fn read_output_byte_budget_reports_max_bytes() {
        let (_dir, ts) = setup();
        let mut content = String::new();
        for _ in 0..100 {
            content.push_str(&"x".repeat(1100));
            content.push('\n');
        }
        std::fs::write(_dir.path().join("wide.txt"), content).unwrap();
        let result = ts.execute("Read", &json!({ "path": "wide.txt" })).unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        let note = result.note.unwrap();
        assert!(note.contains("Max 102400 bytes reached."), "note: {note}");
        assert!(
            !result.content.contains("100\t"),
            "byte budget must stop rendering early: {}",
            result.content
        );
    }

    #[test]
    fn read_empty_file_with_offset_does_not_panic() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("empty.txt"), b"").unwrap();
        let result = ts
            .execute("Read", &json!({ "path": "empty.txt", "line_offset": 5 }))
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(result.content.is_empty(), "content: {}", result.content);
        let note = result.note.unwrap();
        assert!(note.contains("No lines read from file"), "note: {note}");
        assert!(note.contains("Total lines in file: 0."), "note: {note}");
    }

    #[test]
    fn read_large_file_falls_back_to_host() {
        let (_dir, ts) = setup();
        std::fs::write(
            _dir.path().join("big.txt"),
            vec![b'a'; 10 * 1024 * 1024 + 1],
        )
        .unwrap();
        assert!(
            ts.execute("Read", &json!({ "path": "big.txt" })).is_none(),
            "files beyond the transcode budget stay on the host"
        );
    }

    #[tokio::test]
    async fn grep_finds_matches_across_files() {
        let (_dir, ts) = setup();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "beta", "output_mode": "content" }),
            )
            .unwrap();
        assert!(!result.is_error);
        assert!(
            result.content.contains("a.txt:2"),
            "content: {}",
            result.content
        );
        assert!(
            result.content.contains("lib.rs:2"),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn grep_default_mode_lists_files_by_recency() {
        let (dir, ts) = setup();
        // Make a.txt the most recently modified file.
        std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
        let result = ts.execute("Grep", &json!({ "pattern": "beta" })).unwrap();
        assert!(!result.is_error);
        let lines: Vec<&str> = result.content.lines().collect();
        let lib_rs = if cfg!(windows) {
            "src\\lib.rs"
        } else {
            "src/lib.rs"
        };
        assert_eq!(lines, vec!["a.txt", lib_rs], "content: {}", result.content);
    }

    #[tokio::test]
    async fn grep_with_glob_filter() {
        let (_dir, ts) = setup();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "beta", "glob": "*.rs", "output_mode": "content" }),
            )
            .unwrap();
        assert!(result.content.contains("lib.rs"));
        assert!(!result.content.contains("a.txt:"));
    }

    #[tokio::test]
    async fn grep_case_insensitive_flag() {
        let (_dir, ts) = setup();
        let sensitive = ts
            .execute(
                "Grep",
                &json!({ "pattern": "BETA", "output_mode": "content" }),
            )
            .unwrap();
        assert!(
            sensitive.content.contains("No matches"),
            "content: {}",
            sensitive.content
        );
        let insensitive = ts
            .execute(
                "Grep",
                &json!({ "pattern": "BETA", "-i": true, "output_mode": "content" }),
            )
            .unwrap();
        assert!(
            insensitive.content.contains("beta"),
            "content: {}",
            insensitive.content
        );
    }

    #[tokio::test]
    async fn grep_content_context_lines() {
        let (_dir, ts) = setup();
        let result = ts
            .execute(
                "Grep",
                &json!({
                    "pattern": "beta",
                    "output_mode": "content",
                    "-C": 1,
                }),
            )
            .unwrap();
        // Context lines use `-` separators; matches use `:`. A single window
        // covering lines 1-3 has no `--` cluster separator.
        assert!(
            result.content.contains("a.txt-1-alpha"),
            "content: {}",
            result.content
        );
        assert!(
            result.content.contains("a.txt:2:beta"),
            "content: {}",
            result.content
        );
        assert!(
            result.content.contains("a.txt-3-gamma"),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn grep_context_clusters_separated_by_dash_dash() {
        let (_dir, ts) = setup();
        // Two matches five lines apart produce two disjoint clusters.
        std::fs::write(
            _dir.path().join("spread.txt"),
            "m1




m2
",
        )
        .unwrap();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "m[12]", "output_mode": "content", "-A": 1, "-B": 1 }),
            )
            .unwrap();
        assert!(result.content.contains("--"), "content: {}", result.content);
    }

    #[tokio::test]
    async fn grep_count_matches_with_summary() {
        let (_dir, ts) = setup();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "beta", "output_mode": "count_matches" }),
            )
            .unwrap();
        let count_line = if cfg!(windows) {
            "src\\lib.rs:1"
        } else {
            "src/lib.rs:1"
        };
        assert!(
            result.content.contains(count_line),
            "content: {}",
            result.content
        );
        assert!(
            result
                .content
                .contains("Found 2 total occurrences across 2 files."),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn grep_head_limit_paginates() {
        let (_dir, ts) = setup();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "beta", "output_mode": "content", "head_limit": 1 }),
            )
            .unwrap();
        let first_line = result.content.lines().next().unwrap();
        assert!(first_line.contains("beta"), "content: {}", result.content);
        assert!(
            result.content.contains("Results truncated to 1 lines"),
            "content: {}",
            result.content
        );
    }

    #[test]
    fn grep_invalid_regex_is_an_error_result() {
        let (_dir, ts) = setup();
        let result = ts
            .execute("Grep", &json!({ "pattern": "([unclosed" }))
            .unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("invalid regex"));
    }

    #[tokio::test]
    async fn grep_with_type_filter_matches_natively() {
        let (_dir, ts) = setup();
        // `type: rust` (rg `--type rust` = `*.rs`) keeps only src/lib.rs.
        let rust = ts
            .execute(
                "Grep",
                &json!({ "pattern": "beta", "type": "rust", "output_mode": "content" }),
            )
            .unwrap();
        assert!(!rust.is_error, "content: {}", rust.content);
        assert!(
            rust.content.contains("lib.rs:2"),
            "content: {}",
            rust.content
        );
        assert!(
            !rust.content.contains("a.txt:"),
            "type=rust must exclude a.txt: {}",
            rust.content
        );
        // `type: txt` (rg `--type txt` = `*.txt`) keeps only a.txt.
        let txt = ts
            .execute(
                "Grep",
                &json!({ "pattern": "beta", "type": "txt", "output_mode": "content" }),
            )
            .unwrap();
        assert!(
            txt.content.contains("a.txt:2:beta"),
            "content: {}",
            txt.content
        );
        assert!(
            !txt.content.contains("lib.rs"),
            "type=txt must exclude lib.rs: {}",
            txt.content
        );
    }

    #[test]
    fn grep_with_unknown_type_falls_back_to_the_host() {
        let (_dir, ts) = setup();
        // The static type table only covers one rg release, while the host runs
        // whatever rg is on PATH and also honours user `--type-add` definitions
        // from `.ripgreprc`. An unknown name therefore hands the call back to
        // the host instead of synthesising rg's "unrecognized file type" error.
        assert!(
            ts.execute("Grep", &json!({ "pattern": "x", "type": "kimiunknown" }))
                .is_none(),
            "unknown type must fall back to the host"
        );
        // A known type is still served natively (the table is a fast path).
        assert!(
            ts.execute("Grep", &json!({ "pattern": "x", "type": "rust" }))
                .is_some(),
            "known type must stay native"
        );
        // A mistyped `type` argument is a schema error the host owns.
        assert!(
            ts.execute("Grep", &json!({ "pattern": "x", "type": 7 }))
                .is_none(),
            "non-string type must fall back to the host"
        );
    }

    #[tokio::test]
    async fn grep_include_ignored_searches_gitignored_files() {
        let dir = tempfile::tempdir().unwrap();
        // Mark the temp dir as a git repo so `.gitignore` is honored by
        // default (rg / the `ignore` crate require a git context).
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "needle ignored\n").unwrap();
        std::fs::write(dir.path().join("kept.txt"), "needle kept\n").unwrap();
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();

        let default = ts.execute("Grep", &json!({ "pattern": "needle" })).unwrap();
        assert!(
            default.content.contains("kept.txt"),
            "content: {}",
            default.content
        );
        assert!(
            !default.content.contains("ignored.txt"),
            "gitignored file must be skipped by default: {}",
            default.content
        );

        // rg `--no-ignore` surfaces the gitignored file.
        let with_ignored = ts
            .execute(
                "Grep",
                &json!({ "pattern": "needle", "include_ignored": true }),
            )
            .unwrap();
        assert!(
            with_ignored.content.contains("kept.txt"),
            "content: {}",
            with_ignored.content
        );
        assert!(
            with_ignored.content.contains("ignored.txt"),
            "include_ignored must surface the gitignored file: {}",
            with_ignored.content
        );
    }

    #[tokio::test]
    async fn grep_multiline_spans_lines_with_per_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("span.txt"),
            "alpha\nstart MATCH\nmiddle\nend MATCH\ntail\nbeta\n",
        )
        .unwrap();
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        let result = ts
            .execute(
                "Grep",
                &json!({
                    "pattern": "start MATCH.*?end MATCH",
                    "output_mode": "content",
                    "multiline": true,
                }),
            )
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        // rg `-U` reports every physical line the match spans, each with its
        // own line number and the `:` match separator.
        let lines: Vec<&str> = result.content.lines().collect();
        assert_eq!(
            lines,
            vec![
                "span.txt:2:start MATCH",
                "span.txt:3:middle",
                "span.txt:4:end MATCH",
            ],
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn grep_multiline_count_matches_counts_matches_not_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("span.txt"),
            "alpha\nstart MATCH\nmiddle\nend MATCH\ntail\nbeta\n",
        )
        .unwrap();
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        let result = ts
            .execute(
                "Grep",
                &json!({
                    "pattern": "start MATCH.*?end MATCH",
                    "output_mode": "count_matches",
                    "multiline": true,
                }),
            )
            .unwrap();
        // One match spanning three lines counts as 1 (rg `--count-matches -U`).
        assert!(
            result.content.contains("span.txt:1"),
            "content: {}",
            result.content
        );
        assert!(
            result
                .content
                .contains("Found 1 total occurrence across 1 file."),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn grep_multiline_context_and_cluster_separator() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("span.txt"),
            "alpha\nstart MATCH\nmiddle\nend MATCH\ntail\nbeta\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("multi.txt"),
            "x1\nA\nB\ny1\ny2\ny3\nA\nB\nz1\n",
        )
        .unwrap();
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        // -C1 window around the single multiline match in span.txt.
        let span = ts
            .execute(
                "Grep",
                &json!({
                    "pattern": "start MATCH.*?end MATCH",
                    "output_mode": "content",
                    "multiline": true,
                    "-C": 1,
                    "path": "span.txt",
                }),
            )
            .unwrap();
        let span_lines: Vec<&str> = span.content.lines().collect();
        assert_eq!(
            span_lines,
            vec![
                "span.txt-1-alpha",
                "span.txt:2:start MATCH",
                "span.txt:3:middle",
                "span.txt:4:end MATCH",
                "span.txt-5-tail",
            ],
            "content: {}",
            span.content
        );
        // Two disjoint `A\nB` matches with -C1 produce a `--` cluster break.
        let multi = ts
            .execute(
                "Grep",
                &json!({
                    "pattern": "A\nB",
                    "output_mode": "content",
                    "multiline": true,
                    "-C": 1,
                    "path": "multi.txt",
                }),
            )
            .unwrap();
        let multi_lines: Vec<&str> = multi.content.lines().collect();
        assert_eq!(
            multi_lines,
            vec![
                "multi.txt-1-x1",
                "multi.txt:2:A",
                "multi.txt:3:B",
                "multi.txt-4-y1",
                "--",
                "multi.txt-6-y3",
                "multi.txt:7:A",
                "multi.txt:8:B",
                "multi.txt-9-z1",
            ],
            "content: {}",
            multi.content
        );
    }

    #[tokio::test]
    async fn grep_type_include_ignored_multiline_combine() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "combo.ts\n").unwrap();
        std::fs::write(
            dir.path().join("combo.ts"),
            "head\nstart MATCH\nmid\nend MATCH\ntail\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("combo.txt"), "start MATCH\nend MATCH\n").unwrap();
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        // include_ignored surfaces the gitignored combo.ts, type=ts drops
        // combo.txt, and multiline spans the match across lines 2-4.
        let result = ts
            .execute(
                "Grep",
                &json!({
                    "pattern": "start MATCH.*?end MATCH",
                    "output_mode": "content",
                    "type": "ts",
                    "include_ignored": true,
                    "multiline": true,
                }),
            )
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("combo.ts:2:start MATCH"),
            "content: {}",
            result.content
        );
        assert!(
            result.content.contains("combo.ts:4:end MATCH"),
            "content: {}",
            result.content
        );
        assert!(
            !result.content.contains("combo.txt"),
            "type=ts must exclude combo.txt: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn grep_skips_vcs_directories() {
        let (_dir, ts) = setup();
        std::fs::create_dir_all(_dir.path().join(".git")).unwrap();
        std::fs::write(_dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(_dir.path().join("notes.txt"), "ref: something\n").unwrap();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "ref:", "output_mode": "content" }),
            )
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("notes.txt"),
            "content: {}",
            result.content
        );
        assert!(
            !result.content.contains(".git"),
            "VCS metadata must be excluded: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn grep_count_matches_counts_occurrences() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("multi.txt"), "beta beta beta\n").unwrap();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "beta", "output_mode": "count_matches" }),
            )
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("multi.txt:3"),
            "content: {}",
            result.content
        );
        // setup() also writes a.txt ("beta" once) and src/lib.rs ("beta"
        // once), so the whole-workspace count is 5 across 3 files.
        assert!(
            result
                .content
                .contains("Found 5 total occurrences across 3 files."),
            "content: {}",
            result.content
        );
    }

    /// Build a wider fixture tree so the parallel walker has real fan-out.
    fn build_parallel_tree(root: &std::path::Path, files: usize) {
        for i in 0..files {
            let dir = root.join(format!("d{:02}", i % 12));
            std::fs::create_dir_all(&dir).unwrap();
            let body = if i % 3 == 0 {
                format!("filler\nneedle_{i} here\nfiller\n")
            } else {
                "filler line one\nno match here\nfiller\n".to_string()
            };
            std::fs::write(dir.join(format!("f{i:04}.txt")), body).unwrap();
        }
    }

    #[tokio::test]
    async fn grep_parallel_walk_is_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        build_parallel_tree(dir.path(), 120);
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();

        // The walk fans out unordered, but the aggregate is re-sorted, so two
        // runs over the same tree must be byte-identical in every mode.
        for mode in ["files_with_matches", "content", "count_matches"] {
            let args = json!({ "pattern": "needle_", "output_mode": mode });
            let first = ts.execute("Grep", &args).unwrap();
            let second = ts.execute("Grep", &args).unwrap();
            assert!(
                first.content == second.content,
                "mode {mode} drifted between parallel runs\nfirst:\n{}\nsecond:\n{}",
                first.content,
                second.content
            );
            assert!(
                !first.content.is_empty() && !first.content.contains("No matches found"),
                "mode {mode} found nothing:\n{}",
                first.content
            );
        }
    }

    #[tokio::test]
    async fn grep_content_clusters_and_merging_are_byte_stable() {
        let dir = tempfile::tempdir().unwrap();
        // One merged cluster: the windows around lines 3 and 5 overlap, so no
        // `--` separator appears inside this file.
        std::fs::write(dir.path().join("merged.txt"), "a\nb\nmatch\nd\nmatch2\nf\n").unwrap();
        // Two disjoint clusters separated by `--`.
        std::fs::write(dir.path().join("split.txt"), "match1\nx\ny\nz\nmatch2\n").unwrap();
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        let result = ts
            .execute(
                "Grep",
                &json!({ "pattern": "match", "output_mode": "content", "-C": 1 }),
            )
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        let lines: Vec<&str> = result.content.lines().collect();
        assert_eq!(
            lines,
            vec![
                "merged.txt-2-b",
                "merged.txt:3:match",
                "merged.txt-4-d",
                "merged.txt:5:match2",
                "merged.txt-6-f",
                "split.txt:1:match1",
                "split.txt-2-x",
                "--",
                "split.txt-4-z",
                "split.txt:5:match2",
            ],
            "content: {}",
            result.content
        );
        // Re-running yields the same bytes (path-ordered aggregation).
        let again = ts
            .execute(
                "Grep",
                &json!({ "pattern": "match", "output_mode": "content", "-C": 1 }),
            )
            .unwrap();
        assert_eq!(again.content, result.content);
    }

    #[tokio::test]
    async fn grep_head_limit_offset_are_stable_under_parallelism() {
        let dir = tempfile::tempdir().unwrap();
        build_parallel_tree(dir.path(), 60);
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        let args = json!({
            "pattern": "needle_",
            "output_mode": "content",
            "head_limit": 5,
            "offset": 0,
        });
        let first = ts.execute("Grep", &args).unwrap();
        let second = ts.execute("Grep", &args).unwrap();
        assert_eq!(first.content, second.content);
        assert!(
            first.content.contains("Results truncated to 5 lines"),
            "content: {}",
            first.content
        );
        // Exactly head_limit result lines precede the truncation notice.
        let body = first.content.split("\n\n").next().unwrap();
        assert_eq!(body.lines().count(), 5, "content: {}", first.content);
    }

    #[test]
    fn grep_expired_deadline_sets_the_atomic_timeout() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("needle.txt"), "needle\n").unwrap();
        let regex = regex::Regex::new("needle").unwrap();
        let cfg = GrepScanConfig {
            regex: &regex,
            mode: GrepMode::FilesWithMatches,
            context_before: 0,
            context_after: 0,
            line_numbers: true,
            multiline: false,
        };
        // A deadline already in the past: the first visited entry must trip
        // the atomic timeout flag and abort the walk with no results.
        let collected = grep_collect(
            dir.path(),
            dir.path(),
            &cfg,
            None,
            None,
            false,
            GrepWalkLimits {
                deadline: std::time::Instant::now(),
                scan_cap: GREP_WALK_SCAN_CAP,
            },
        );
        assert!(collected.timed_out);
        assert!(collected.per_file.is_empty());
    }

    #[test]
    fn glob_matches_at_any_depth() {
        let (_dir, ts) = setup();
        let result = ts.execute("Glob", &json!({ "pattern": "*.rs" })).unwrap();
        assert!(
            result.content.contains("lib.rs"),
            "content: {}",
            result.content
        );
        assert!(!result.content.contains("a.txt"));
    }

    #[test]
    fn glob_no_matches_reports_cleanly() {
        let (_dir, ts) = setup();
        let result = ts.execute("Glob", &json!({ "pattern": "*.xyz" })).unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("No files matched"));
    }

    #[test]
    fn read_only_path_stays_on_execute() {
        let (_dir, ts) = setup();
        // The read-only entry point never handles mutating tools.
        assert!(
            ts.execute("Write", &json!({ "path": "a.txt", "content": "x" }))
                .is_none()
        );
        assert!(ts.execute("Edit", &json!({ "path": "a.txt" })).is_none());
        assert!(
            ts.execute("Bash", &json!({ "command": "rm -rf /" }))
                .is_none()
        );
    }

    #[tokio::test]
    async fn write_creates_file_inside_sandbox() {
        let (_dir, ts) = setup();
        let result = ts
            .execute_mutating(
                "Write",
                &json!({ "path": "out/new.txt", "content": "hello\n" }),
            )
            .await
            .expect("native write handled");
        assert!(!result.is_error, "content: {}", result.content);
        let written = std::fs::read_to_string(_dir.path().join("out/new.txt")).unwrap();
        assert_eq!(written, "hello\n");
    }

    #[tokio::test]
    async fn write_outside_sandbox_falls_back() {
        let (_dir, ts) = setup();
        let outside = tempfile::tempdir().unwrap();
        let escaped = outside.path().join("evil.txt");
        assert!(
            ts.execute_mutating(
                "Write",
                &json!({ "path": escaped.to_str().unwrap(), "content": "x" })
            )
            .await
            .is_none(),
            "sandbox escape must fall back to the host"
        );
        assert!(!escaped.exists());
    }

    #[tokio::test]
    async fn edit_replaces_unique_match() {
        let (_dir, ts) = setup();
        let result = ts
            .execute_mutating(
                "Edit",
                &json!({ "path": "a.txt", "old_string": "beta", "new_string": "BETA" }),
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        let content = std::fs::read_to_string(_dir.path().join("a.txt")).unwrap();
        assert_eq!(content, "alpha\nBETA\ngamma\n");
    }

    #[tokio::test]
    async fn edit_ambiguous_match_is_an_error() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("dup.txt"), "x\nx\n").unwrap();
        let result = ts
            .execute_mutating(
                "Edit",
                &json!({ "path": "dup.txt", "old_string": "x", "new_string": "y" }),
            )
            .await
            .unwrap();
        assert!(result.is_error, "content: {}", result.content);
        assert!(result.content.contains("matched 2 times"));
        // The file must be untouched.
        assert_eq!(
            std::fs::read_to_string(_dir.path().join("dup.txt")).unwrap(),
            "x\nx\n"
        );
    }

    #[tokio::test]
    async fn edit_replace_all_replaces_every_occurrence() {
        let (_dir, ts) = setup();
        std::fs::write(_dir.path().join("dup.txt"), "x\nx\n").unwrap();
        let result = ts
            .execute_mutating(
                "Edit",
                &json!({ "path": "dup.txt", "old_string": "x", "new_string": "y", "replace_all": true }),
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        assert_eq!(
            std::fs::read_to_string(_dir.path().join("dup.txt")).unwrap(),
            "y\ny\n"
        );
    }

    #[tokio::test]
    async fn bash_runs_inside_sandbox_and_reports_exit_code() {
        let Some(shell) = find_bash() else { return };
        let (_dir, ts) = setup_with_shell(Some(&shell));
        let result = ts
            .execute_mutating("Bash", &json!({ "command": "echo native-bash" }))
            .await
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("native-bash"),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn bash_streams_output_chunks_to_the_progress_callback() {
        let Some(shell) = find_bash() else { return };
        let (_dir, ts) = setup_with_shell(Some(&shell));
        let chunks = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = chunks.clone();
        let emit = move |kind: &str, text: &str| {
            seen.lock()
                .unwrap()
                .push((kind.to_string(), text.to_string()));
        };
        let result = ts
            .execute_tool_streaming(
                Some("pc1"),
                "Bash",
                &json!({ "command": "echo hello-stream" }),
                Some(&emit),
            )
            .await
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("hello-stream"),
            "full output intact"
        );
        let seen = chunks.lock().unwrap();
        assert!(
            seen.iter()
                .any(|(kind, text)| kind == "stdout" && text.contains("hello-stream")),
            "at least one stdout chunk carries the output: {seen:?}"
        );
    }

    #[tokio::test]
    async fn bash_uses_bash_semantics_not_cmd() {
        let Some(shell) = find_bash() else { return };
        let (_dir, ts) = setup_with_shell(Some(&shell));
        // Arithmetic expansion only exists in bash — this documents that the
        // native path honors the tool's bash contract instead of cmd.exe.
        let result = ts
            .execute_mutating("Bash", &json!({ "command": "echo $((20 + 3))" }))
            .await
            .unwrap();
        assert!(!result.is_error, "content: {}", result.content);
        assert!(result.content.contains("23"), "content: {}", result.content);
    }

    #[tokio::test]
    async fn bash_reports_failure_exit_code() {
        let Some(shell) = find_bash() else { return };
        let (_dir, ts) = setup_with_shell(Some(&shell));
        // The native Bash contract is bash everywhere, so the exit syntax is
        // POSIX even on Windows.
        let result = ts
            .execute_mutating("Bash", &json!({ "command": "exit 3" }))
            .await
            .unwrap();
        assert!(result.is_error);
        assert!(
            result.content.contains("exit code: 3"),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn bash_run_in_background_falls_back_to_host() {
        let (_dir, ts) = setup();
        assert!(
            ts.execute_mutating(
                "Bash",
                &json!({ "command": "echo hi", "run_in_background": true }),
            )
            .await
            .is_none(),
            "background tasks are host-owned"
        );
    }

    #[tokio::test]
    async fn bash_timeout_kills_and_reports_without_falling_back() {
        let Some(shell) = find_bash() else { return };
        let (_dir, ts) = setup_with_shell(Some(&shell));
        // `sleep`-style command that outlives a 1s timeout. On timeout the
        // command must be killed and reported — never re-run by the host.
        let command = if cfg!(windows) {
            "ping -n 6 127.0.0.1 >nul"
        } else {
            "sleep 5"
        };
        let result = ts
            .execute_mutating("Bash", &json!({ "command": command, "timeout": 1 }))
            .await
            .expect("timeout must be reported, not handed to the host");
        assert!(result.is_error);
        assert!(
            result.content.contains("killed by timeout"),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn bash_cwd_escape_falls_back() {
        let (_dir, ts) = setup();
        let outside = tempfile::tempdir().unwrap();
        assert!(
            ts.execute_mutating(
                "Bash",
                &json!({ "command": "echo hi", "cwd": outside.path().to_str().unwrap() })
            )
            .await
            .is_none(),
            "cwd outside the sandbox must fall back to the host"
        );
    }

    /// The name contract between the v2 host and this engine, pinned on both
    /// sides: this test fails when `NATIVE_TOOL_NAMES` and
    /// `tool-name-contract.json` drift apart, and the v2-side test
    /// (`toolNameContract.test.ts`) fails when a v2 tool name loses its
    /// classification. See the contract file's `notes` for the P34
    /// corrections this pinning surfaced (WaitFor, list_directory,
    /// ReadMediaFile).
    #[test]
    fn native_tool_names_match_the_contract_file() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../tool-name-contract.json"))
                .expect("tool-name-contract.json must parse");
        let v2_native: Vec<String> = serde_json::from_value(contract["v2Native"].clone()).unwrap();
        let v2_host: Vec<String> = serde_json::from_value(contract["v2Host"].clone()).unwrap();
        let repl_only: Vec<String> =
            serde_json::from_value(contract["replOnlyNative"].clone()).unwrap();
        let v2_github: Vec<String> = serde_json::from_value(contract["v2Github"].clone()).unwrap();
        let unloaded: Vec<String> =
            serde_json::from_value(contract["unloadedInV2"].clone()).unwrap();
        let aliases: std::collections::BTreeMap<String, String> =
            serde_json::from_value(contract["aliases"].clone()).unwrap();

        let (_dir, toolset) = setup();
        for name in &v2_native {
            assert!(
                toolset.handles(name),
                "contract says {name} executes natively but handles() rejects it"
            );
        }
        for name in &v2_host {
            assert!(
                !toolset.handles(name),
                "contract says {name} is host-owned but handles() accepts it"
            );
        }
        for name in &repl_only {
            assert!(
                toolset.handles(name),
                "contract says {name} is a REPL-only native tool but handles() rejects it"
            );
        }
        for name in &v2_github {
            assert!(
                github::is_github_tool(name),
                "contract says {name} is a native GitHub tool but is_github_tool rejects it — add it to github.rs SPECS or fix the contract"
            );
        }
        for name in &unloaded {
            assert!(
                !toolset.handles(name),
                "contract says {name} is unloaded from v2 but handles() accepts it — promote it to v2Native or drop the native arm"
            );
        }

        let mut contracted = std::collections::BTreeSet::new();
        for name in v2_native.iter().chain(repl_only.iter()) {
            contracted.insert(name.to_ascii_lowercase());
        }
        contracted.extend(aliases.into_keys());
        let accepted: std::collections::BTreeSet<String> =
            NATIVE_TOOL_NAMES.iter().map(|s| (*s).to_string()).collect();
        assert_eq!(
            accepted, contracted,
            "NATIVE_TOOL_NAMES and tool-name-contract.json disagree — update both together"
        );
    }

    // ── Ordering contract: sort before the hard cap ─────────────────────

    fn scan(display: &str, mtime: u64, total_matches: usize) -> FileScan {
        FileScan {
            display: display.to_string(),
            mtime,
            total_matches,
            rendered: Vec::new(),
        }
    }

    fn displays(per_file: &[FileScan]) -> Vec<&str> {
        per_file.iter().map(|f| f.display.as_str()).collect()
    }

    #[test]
    fn grep_file_cap_keeps_the_sorted_prefix_not_the_walk_order() {
        // The parallel walk yields files in scheduling order. Truncating before
        // sorting kept a nondeterministic subset, which `head_limit` then paged
        // over — so the cap is parameterised here and applied after the sort.
        let mut per_file = vec![
            scan("zeta.txt", 10, 1),
            scan("alpha.txt", 30, 1),
            scan("mid.txt", 20, 1),
            scan("beta.txt", 30, 1),
        ];
        assert!(grep_sort_and_cap(
            &mut per_file,
            GrepMode::FilesWithMatches,
            2
        ));
        // mtime DESC, ties broken by display path ASC: alpha(30) outranks
        // beta(30) on the path, and both outrank mid(20) / zeta(10).
        assert_eq!(displays(&per_file), vec!["alpha.txt", "beta.txt"]);
    }

    #[test]
    fn grep_file_cap_is_inert_below_the_limit() {
        // Nothing is dropped, and each mode's own ordering still applies.
        let mut per_file = vec![scan("b.txt", 9, 1), scan("a.txt", 1, 2)];
        assert!(!grep_sort_and_cap(
            &mut per_file,
            GrepMode::FilesWithMatches,
            5
        ));
        assert_eq!(displays(&per_file), vec!["b.txt", "a.txt"], "mtime DESC");
        // `content` / `count_matches` ignore mtime entirely: path ASC.
        let mut per_file = vec![scan("b.txt", 9, 1), scan("a.txt", 1, 2)];
        assert!(!grep_sort_and_cap(&mut per_file, GrepMode::CountMatches, 5));
        assert_eq!(displays(&per_file), vec!["a.txt", "b.txt"], "path ASC");
        assert_eq!(
            per_file[1].total_matches, 1,
            "entries must not be reordered"
        );
    }

    #[test]
    fn grep_same_second_files_order_by_path_in_every_run() {
        // The engine and the host both quantise mtime to whole seconds
        // (`duration_since(UNIX_EPOCH).as_secs()` vs `Math.trunc(mtimeMs/1000)`),
        // so the files a `git checkout` leaves with identical mtimes are ordered
        // by path — never by walk order or by rg's output index.
        let dir = tempfile::tempdir().unwrap();
        let names = ["delta.txt", "alpha.txt", "charlie.txt", "bravo.txt"];
        for name in names {
            std::fs::write(dir.path().join(name), "needle\n").unwrap();
        }
        let mtimes: Vec<u64> = names
            .iter()
            .map(|name| mtime_secs(&std::fs::metadata(dir.path().join(name)).unwrap()))
            .collect();
        if mtimes.windows(2).any(|pair| pair[0] != pair[1]) {
            eprintln!("skipping: fixture files straddled a second boundary ({mtimes:?})");
            return;
        }
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        let args = json!({ "pattern": "needle" });
        let first = ts.execute("Grep", &args).unwrap();
        let second = ts.execute("Grep", &args).unwrap();
        assert_eq!(first.content, second.content, "parallel runs drifted");
        assert_eq!(
            first.content.lines().collect::<Vec<_>>(),
            vec!["alpha.txt", "bravo.txt", "charlie.txt", "delta.txt"]
        );
    }

    #[test]
    fn mtime_secs_reports_whole_seconds_since_the_epoch() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("m.txt"), "x\n").unwrap();
        let meta = std::fs::metadata(dir.path().join("m.txt")).unwrap();
        let elapsed = meta
            .modified()
            .unwrap()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap();
        // The host quantises with `Math.trunc(mtimeMs / 1000)`; the engine has
        // to land on the same integer or same-second files order differently.
        assert_eq!(mtime_secs(&meta), elapsed.as_secs());
        assert_eq!(mtime_secs(&meta), elapsed.as_millis() as u64 / 1000);
    }

    // ── Walk resource bounds ────────────────────────────────────────────

    #[test]
    fn grep_walk_worker_count_is_explicitly_bounded() {
        // `ignore` defaults to one worker per CPU, which multiplies with
        // `spawn_blocking` × MAX_PARALLEL_TOOLS concurrent native calls.
        let threads = grep_walk_threads();
        assert!(threads >= 1, "`ignore` treats 0 workers as serial");
        assert!(
            threads <= GREP_WALK_THREADS,
            "walk workers {threads} exceed the cap {GREP_WALK_THREADS}"
        );
        assert_eq!(
            GREP_WALK_SCAN_CAP,
            GREP_MAX_FILES * 2,
            "the soft walk cap must stay a small multiple of the hard cap"
        );
    }

    #[test]
    fn grep_walk_scan_cap_stops_the_parallel_walk() {
        let dir = tempfile::tempdir().unwrap();
        build_parallel_tree(dir.path(), 12);
        let regex = regex::Regex::new("needle_").unwrap();
        let cfg = GrepScanConfig {
            regex: &regex,
            mode: GrepMode::Content,
            context_before: 0,
            context_after: 0,
            line_numbers: true,
            multiline: false,
        };
        let collect = |scan_cap: usize| {
            grep_collect(
                dir.path(),
                dir.path(),
                &cfg,
                None,
                None,
                false,
                GrepWalkLimits {
                    deadline: Instant::now() + GREP_TIME_BUDGET,
                    scan_cap,
                },
            )
        };
        // A cap of 0 trips on the very first visited entry: nothing is scanned
        // and the result is flagged truncated rather than silently empty.
        let capped = collect(0);
        assert!(capped.file_cap_truncated, "scan cap must flag truncation");
        assert!(capped.per_file.is_empty(), "no file may be scanned");
        // The production cap leaves the walk untouched.
        let uncapped = collect(GREP_WALK_SCAN_CAP);
        assert!(!uncapped.file_cap_truncated);
        assert!(!uncapped.timed_out);
        assert_eq!(uncapped.per_file.len(), 4, "every 3rd of 12 files matches");
    }

    // ── JoinError split by mutability ───────────────────────────────────

    /// A panic inside `spawn_blocking` surfaces to the awaiting task as a real
    /// `JoinError`, which is exactly the failure mode the split has to handle.
    fn panicking_tool(_root: &Path, _args: &Value) -> Option<ExecutableToolResult> {
        panic!("synthetic blocking-pool failure");
    }

    #[tokio::test]
    async fn readonly_tool_join_error_falls_back_to_the_host() {
        let (_dir, ts) = setup();
        // read/grep/glob are idempotent: re-running one on the host is always
        // safe, and a task lost to the runtime must not reach the model as a
        // tool failure.
        assert!(
            ts.run_readonly_file_tool_on_blocking_pool(&json!({ "path": "a.txt" }), panicking_tool)
                .await
                .is_none(),
            "a read-only JoinError must fall back to the host"
        );
    }

    #[tokio::test]
    async fn mutating_tool_join_error_becomes_an_error_result() {
        let (_dir, ts) = setup();
        // write/edit already hold a permission grant and may have partially
        // applied, so the host must not be allowed to re-run them.
        let result = ts
            .run_mutating_file_tool_on_blocking_pool(&json!({ "path": "a.txt" }), panicking_tool)
            .await
            .expect("a mutating JoinError must not fall back to the host");
        assert!(result.is_error);
        assert!(
            result.content.contains("native tool task failed"),
            "content: {}",
            result.content
        );
    }

    #[test]
    fn blocking_pool_failure_splits_on_mutability() {
        assert!(blocking_pool_failure(false, "boom".to_string()).is_none());
        let result = blocking_pool_failure(true, "boom".to_string()).unwrap();
        assert!(result.is_error);
        assert!(
            result.content.contains("boom"),
            "content: {}",
            result.content
        );
    }

    // ── Malformed arguments belong to the host's zod schema ─────────────

    #[test]
    fn grep_rejects_mistyped_arguments_instead_of_ignoring_them() {
        let (_dir, ts) = setup();
        // The engine short-circuits ahead of the host's zod validation, so a
        // present-but-mistyped argument has to fall back; coercing it would
        // report a successful search that ignored what the model asked for
        // (`{"multiline":"true"}` silently meaning `false`).
        let malformed = [
            json!({ "pattern": "beta", "multiline": "true" }),
            json!({ "pattern": "beta", "include_ignored": 1 }),
            json!({ "pattern": "beta", "-i": "yes" }),
            json!({ "pattern": "beta", "-n": 0 }),
            json!({ "pattern": "beta", "-C": "2" }),
            json!({ "pattern": "beta", "-A": -1 }),
            json!({ "pattern": "beta", "-B": 1.5 }),
            json!({ "pattern": "beta", "head_limit": "10" }),
            json!({ "pattern": "beta", "offset": true }),
            json!({ "pattern": "beta", "output_mode": "matches" }),
            json!({ "pattern": "beta", "output_mode": 3 }),
            json!({ "pattern": "beta", "glob": 7 }),
            json!({ "pattern": "beta", "path": ["a.txt"] }),
            json!({ "pattern": "beta", "type": true }),
            json!({ "pattern": 7 }),
            json!({}),
        ];
        for args in malformed {
            assert!(
                ts.execute("Grep", &args).is_none(),
                "malformed args must fall back to the host: {args}"
            );
        }
    }

    #[test]
    fn grep_treats_absent_and_null_arguments_as_schema_defaults() {
        let (_dir, ts) = setup();
        let baseline = ts.execute("Grep", &json!({ "pattern": "beta" })).unwrap();
        let defaults = [
            json!({ "pattern": "beta", "multiline": null }),
            json!({ "pattern": "beta", "include_ignored": null }),
            json!({ "pattern": "beta", "type": null, "glob": null, "path": null }),
            json!({ "pattern": "beta", "output_mode": null }),
            json!({ "pattern": "beta", "head_limit": null, "offset": null }),
            json!({ "pattern": "beta", "-i": null, "-n": null, "-A": null, "-B": null, "-C": null }),
        ];
        for args in defaults {
            let result = match ts.execute("Grep", &args) {
                Some(result) => result,
                None => panic!("absent/null must mean the schema default: {args}"),
            };
            assert_eq!(result.content, baseline.content, "args: {args}");
        }
    }

    // ── Read errors drop the whole file ─────────────────────────────────

    /// A line source that serves `lines` copies of one matching line and then
    /// either ends cleanly or fails, standing in for the two ways a file read
    /// can stop. Injecting it keeps the read-error contract testable without a
    /// filesystem that fails on demand.
    struct ScriptedReader {
        lines: usize,
        fail_after: bool,
    }

    impl std::io::Read for ScriptedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.lines == 0 {
                return if self.fail_after {
                    Err(std::io::Error::other("synthetic read failure"))
                } else {
                    Ok(0)
                };
            }
            self.lines -= 1;
            let payload = b"needle line\n";
            let n = payload.len().min(buf.len());
            buf[..n].copy_from_slice(&payload[..n]);
            Ok(n)
        }
    }

    #[test]
    fn grep_read_error_skips_the_whole_file() {
        let regex = regex::Regex::new("needle").unwrap();
        let cfg = GrepScanConfig {
            regex: &regex,
            mode: GrepMode::Content,
            context_before: 0,
            context_after: 0,
            line_numbers: true,
            multiline: false,
        };
        // `Ok(0) | Err(_) => break` used to report the prefix read so far as a
        // complete result; a partially readable file must not masquerade as one.
        let reader = std::io::BufReader::new(ScriptedReader {
            lines: 1,
            fail_after: true,
        });
        assert!(
            matches!(
                scan_grep_lines(reader, &cfg, "broken.txt".to_string(), 7),
                ScanOutcome::Skip
            ),
            "an I/O error must drop the file"
        );
    }

    #[test]
    fn grep_clean_eof_keeps_the_scanned_matches() {
        let regex = regex::Regex::new("needle").unwrap();
        let cfg = GrepScanConfig {
            regex: &regex,
            mode: GrepMode::Content,
            context_before: 0,
            context_after: 0,
            line_numbers: true,
            multiline: false,
        };
        // The happy path is pinned alongside it: a clean EOF must still yield
        // everything that was read, so the error branch cannot be "always skip".
        let reader = std::io::BufReader::new(ScriptedReader {
            lines: 3,
            fail_after: false,
        });
        match scan_grep_lines(reader, &cfg, "ok.txt".to_string(), 1234) {
            ScanOutcome::Match(scan) => {
                assert_eq!(scan.display, "ok.txt");
                assert_eq!(scan.mtime, 1234);
                assert_eq!(scan.total_matches, 3);
                assert_eq!(
                    scan.rendered,
                    vec![
                        "ok.txt:1:needle line",
                        "ok.txt:2:needle line",
                        "ok.txt:3:needle line"
                    ]
                );
            }
            ScanOutcome::Skip => panic!("a fully served file must not be skipped"),
            ScanOutcome::Oversized => panic!("a tiny file must not be oversized"),
        }
    }

    // ── Multiline zero-width / EOF semantics (pinned against rg 15.0.0) ──

    fn multiline_regex(pattern: &str) -> regex::Regex {
        // rg `-U --multiline-dotall`: `.` matches `\n`, and `^`/`$` stay
        // anchored per line.
        regex::RegexBuilder::new(pattern)
            .multi_line(true)
            .dot_matches_new_line(true)
            .build()
            .unwrap()
    }

    fn scan_multiline(
        dir: &Path,
        name: &str,
        body: &str,
        pattern: &str,
        mode: GrepMode,
    ) -> ScanOutcome {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let regex = multiline_regex(pattern);
        let cfg = GrepScanConfig {
            regex: &regex,
            mode,
            context_before: 0,
            context_after: 0,
            line_numbers: true,
            multiline: true,
        };
        scan_grep_file_multiline(&path, dir, &cfg)
    }

    fn matched_scan(outcome: ScanOutcome, what: &str) -> FileScan {
        match outcome {
            ScanOutcome::Match(scan) => scan,
            ScanOutcome::Skip => panic!("{what}: expected a match, the file was skipped"),
            ScanOutcome::Oversized => panic!("{what}: expected a match, the file was oversized"),
        }
    }

    #[test]
    fn multiline_eof_zero_width_match_is_not_counted_or_marked() {
        let dir = tempfile::tempdir().unwrap();
        // rg -U --count-matches '$' over "a\nb\n" reports 2 (offsets 1 and 3);
        // the third zero-width match sits at EOF, where `line_at(content.len())`
        // is out of range and clamping it would wrongly re-mark the last line.
        let scan = matched_scan(
            scan_multiline(dir.path(), "withnl.txt", "a\nb\n", "$", GrepMode::Content),
            "$ over \"a\\nb\\n\"",
        );
        assert_eq!(scan.total_matches, 2, "rg --count-matches reports 2");
        assert_eq!(scan.rendered, vec!["withnl.txt:1:a", "withnl.txt:2:b"]);
        // `x*` matches at every offset: rg counts `len` (4), not `len + 1` (5).
        let scan = matched_scan(
            scan_multiline(
                dir.path(),
                "withnl2.txt",
                "a\nb\n",
                "x*",
                GrepMode::CountMatches,
            ),
            "x* over \"a\\nb\\n\"",
        );
        assert_eq!(scan.total_matches, 4, "rg --count-matches reports 4");
        // `\z` needs a buffer end that is not a line boundary.
        assert!(
            matches!(
                scan_multiline(
                    dir.path(),
                    "withnl3.txt",
                    "a\nb\n",
                    r"\z",
                    GrepMode::CountMatches
                ),
                ScanOutcome::Skip
            ),
            "rg finds nothing for `\\z` in a newline-terminated file"
        );
        // An empty file has no line to attribute any match to.
        assert!(
            matches!(
                scan_multiline(
                    dir.path(),
                    "empty.txt",
                    "",
                    "x*",
                    GrepMode::FilesWithMatches
                ),
                ScanOutcome::Skip
            ),
            "rg exits 1 on an empty file"
        );
    }

    #[test]
    fn multiline_zero_width_match_on_a_newline_spans_into_the_next_line() {
        let dir = tempfile::tempdir().unwrap();
        // rg -U -n '$' over "a\nb" prints BOTH lines while counting 1: the
        // zero-width match sits on the '\n' byte and rg spans the line it
        // terminates plus the one after it.
        let scan = matched_scan(
            scan_multiline(dir.path(), "nonl.txt", "a\nb", "$", GrepMode::Content),
            "$ over \"a\\nb\"",
        );
        assert_eq!(scan.total_matches, 1, "rg --count-matches reports 1");
        assert_eq!(scan.rendered, vec!["nonl.txt:1:a", "nonl.txt:2:b"]);
        // Same rule for a non-`$` zero-width pattern: `\b` over "a\nb" counts 3
        // (the EOF boundary is dropped) and still prints both lines.
        let scan = matched_scan(
            scan_multiline(dir.path(), "nonl2.txt", "a\nb", r"\b", GrepMode::Content),
            "\\b over a\\nb",
        );
        assert_eq!(scan.total_matches, 3, "rg --count-matches reports 3");
        assert_eq!(scan.rendered, vec!["nonl2.txt:1:a", "nonl2.txt:2:b"]);
    }

    #[test]
    fn multiline_sole_eof_match_in_a_dangling_last_line_survives() {
        let dir = tempfile::tempdir().unwrap();
        // rg -U --count-matches '\z' over "xy" reports 1 and prints line 1: the
        // only match is at EOF, and dropping it would remove the file from
        // `files_with_matches` entirely — a false negative, which is worse than
        // an off-by-one count.
        let scan = matched_scan(
            scan_multiline(dir.path(), "xy.txt", "xy", r"\z", GrepMode::Content),
            "\\z over xy",
        );
        assert_eq!(scan.total_matches, 1, "rg --count-matches reports 1");
        assert_eq!(scan.rendered, vec!["xy.txt:1:xy"]);
        // Once another match exists, rg drops the EOF one again: `\b|\z` over
        // "xy" counts 1, not 2.
        let scan = matched_scan(
            scan_multiline(
                dir.path(),
                "xy2.txt",
                "xy",
                r"\b|\z",
                GrepMode::CountMatches,
            ),
            "\\b|\\z over xy",
        );
        assert_eq!(scan.total_matches, 1, "rg --count-matches reports 1");
    }

    #[test]
    fn multiline_anchors_stay_per_line_like_ripgrep() {
        let dir = tempfile::tempdir().unwrap();
        // rg -U keeps `^` anchored per line, so multi_line(true) is required:
        // over "a\nb\nc" it reports 3, over "ab\ncd\n" 2 (the EOF `^` is dropped).
        let scan = matched_scan(
            scan_multiline(
                dir.path(),
                "abc.txt",
                "a\nb\nc",
                "^",
                GrepMode::CountMatches,
            ),
            "^ over \"a\\nb\\nc\"",
        );
        assert_eq!(scan.total_matches, 3, "rg --count-matches reports 3");
        let scan = matched_scan(
            scan_multiline(
                dir.path(),
                "abcd.txt",
                "ab\ncd\n",
                "^",
                GrepMode::CountMatches,
            ),
            "^ over \"ab\\ncd\\n\"",
        );
        assert_eq!(scan.total_matches, 2, "rg --count-matches reports 2");
    }
}
