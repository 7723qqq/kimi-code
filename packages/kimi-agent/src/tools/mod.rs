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

/// Hard wall-clock cap for native Bash (host may configure less).
const BASH_MAX_SECONDS: u64 = 300;
/// Default timeout for a background Bash task when neither
/// `[background].bash_task_timeout_s` nor the call's own `timeout` sets one.
/// A foreground command that migrates to the background on timeout is
/// re-armed with the same bound.
const BASH_TASK_DEFAULT_TIMEOUT_S: u64 = 600;
/// Ceiling for a background Bash task's timeout (`[background]
/// bash_task_timeout_s` and per-call `timeout` are both clamped to it).
const BASH_TASK_MAX_SECONDS: u64 = 86_400;
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
pub mod kaos;
pub mod knowledge_tool;
pub mod list_directory;
pub mod lsp_tool;
pub mod memory_filing;
pub mod memory_paths;
pub mod memory_store;
pub mod memory_tool;
pub mod mode_mutex;
pub mod moonshot_service;
pub mod plan_mode;
pub mod read_media;
pub mod sandbox;
pub mod select_tools;
pub mod skill;
pub mod stale_guard;
pub mod subagent_tools;
pub mod swarm_tool;
pub mod task_format;
pub mod task_tools;
pub mod team_tool;
pub mod todo_item;
pub mod todo_list;
pub mod tool_dedupe;
pub mod tool_policy;
pub mod tower;
pub mod web_search;
pub mod workflow;

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
    // Lsp has an execution arm (`Self::execute_tool`) and a tool definition in
    // `all_native_tool_defs()`, which `GET /api/v1/tools` reports as an active
    // builtin. Leaving it out of this list made `handles()` false, so a host
    // that advertised Lsp had every call forwarded to a host with no tool
    // runtime — the call could only fail.
    "lsp",
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
    // Memory tools: the def names are the snake spellings the memory section
    // documents (`memory_read`), so the squashed twins are the aliases here.
    "memoryread",
    "memory_read",
    "memorywrite",
    "memory_write",
    "memorystrreplace",
    "memory_str_replace",
    "memoryappend",
    "memory_append",
    "memorylist",
    "memory_list",
    "memorydelete",
    "memory_delete",
    "team",
    "workflow",
    "notifyuser",
    "notify_user",
    "agent",
    "agentswarm",
    "agent_swarm",
    "waitfor",
    "wait_for",
    "towerinit",
    "tower_init",
    "towerplan",
    "tower_plan",
    "towerspawn",
    "tower_spawn",
    "towermerge",
    "tower_merge",
    "towerteardown",
    "tower_teardown",
    "towersend",
    "tower_send",
    "towerinbox",
    "tower_inbox",
    "towerfinding",
    "tower_finding",
    "towerreview",
    "tower_review",
    "towermission",
    "tower_mission",
    "towerstatus",
    "tower_status",
    // Progressive tool disclosure: native in this fork (v2 kept it on the
    // host); without the entry the dedup guard would let a repeated call
    // re-execute instead of replaying the cached announcement.
    "select_tools",
];

/// The static half of [`NativeToolset::handles`] without an instance: the
/// contracted native name list plus the dynamic GitHub family. The dedup
/// guard in `run_turn` uses it to scope engine-side dedup to calls that can
/// execute natively — host-forwarded calls stay under the host's own
/// `toolDedupeService`, so a repeated call is never deduped twice.
pub fn is_native_tool_name(tool_name: &str) -> bool {
    let lowered = tool_name.to_ascii_lowercase();
    NATIVE_TOOL_NAMES.contains(&lowered.as_str())
        || github::is_github_tool(tool_name)
        || tool_name.starts_with("mcp__")
}

tokio::task_local! {
    /// The id of the agent executing the current turn — "main" for the root
    /// agent, a spawned subagent's id for its own turns. Scoped by the
    /// subagent turn runner ([`crate::subagent::SubagentManager`]); the native
    /// tower tools read it to attribute a call to the right roster agent and to
    /// enforce the main-agent-only gate on the orchestration tools. Each
    /// subagent turn runs in its own task, so concurrent workers carry
    /// independent values with no shared-mutable race. When unset (a direct
    /// toolset call, e.g. in a test), [`NativeToolset::effective_caller_agent_id`]
    /// falls back to the construction-time `caller_agent_id`.
    pub static CALLER_AGENT_ID: String;
    /// Live snapshot of the current conversation history for the running turn,
    /// used by `Agent(fork: true)` and `AgentSwarm(fork: true)` to inherit context.
    pub static CURRENT_CONVERSATION_HISTORY: std::sync::Arc<std::sync::Mutex<Vec<crate::turn_loop::types::LLMMessage>>>;
}

/// The set of directories a native tool call may touch.
///
/// `primary` is the workspace root (canonicalized by [`NativeToolset::new`]).
/// `extra` holds the host-authorized additional directories — the `/add-dir`
/// list the host hands over as `additionalDirs`. A path that canonicalizes
/// under any of them is served natively instead of being handed back to a
/// host that has no tool runtime to serve it with.
#[derive(Debug, Clone)]
pub struct Sandbox {
    primary: PathBuf,
    extra: Vec<PathBuf>,
}

impl Sandbox {
    pub fn new(primary: PathBuf) -> Self {
        Self {
            primary,
            extra: Vec::new(),
        }
    }

    /// Add host-authorized roots. Each is canonicalized here; entries that do
    /// not exist, are not directories, or are already covered by an existing
    /// root are dropped rather than failing the whole sandbox.
    pub fn with_extra(mut self, extra: impl IntoIterator<Item = PathBuf>) -> Self {
        for root in extra {
            let Ok(root) = std::fs::canonicalize(&root) else {
                continue;
            };
            if !root.is_dir() || self.contains(&root) {
                continue;
            }
            self.extra.push(root);
        }
        self
    }

    pub fn primary(&self) -> &Path {
        &self.primary
    }

    /// The extra roots, deduplicated and canonicalized by [`Self::with_extra`].
    pub fn extra(&self) -> &[PathBuf] {
        &self.extra
    }

    /// Every root, primary first.
    pub fn roots(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.primary.as_path()).chain(self.extra.iter().map(PathBuf::as_path))
    }

    /// Whether an already-canonicalized path lies inside any root.
    pub fn contains(&self, path: &Path) -> bool {
        path.starts_with(&self.primary) || self.extra.iter().any(|root| path.starts_with(root))
    }
}

/// Sandboxed native executor, rooted at the workspace.
pub struct NativeToolset {
    root: PathBuf,
    /// Host-authorized extra roots (`additionalDirs`). Already canonicalized;
    /// see [`Sandbox::with_extra`].
    extra_roots: Vec<PathBuf>,
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
    caller_agent_id: Option<String>,
    session_id: Option<String>,
    task_runner: Option<std::sync::Arc<crate::storage::TaskRunner>>,
    /// Native file-history capture (v2 `fileHistoryService`): when set,
    /// mutating file tools (`write` / `edit`) record a row into
    /// `session_file_history` for each successful change. Shared so the host
    /// can install it per turn through
    /// [`crate::callbacks::HostCallbacks::set_file_history`] after the toolset
    /// has been moved into the callbacks wrapper.
    file_history: Arc<std::sync::Mutex<Option<FileHistoryCtx>>>,
    /// Turn number attributed to recorded file-history rows. Carried on the
    /// toolset (not a thread-local) because mutating tools run on tokio's
    /// blocking pool: a thread-local set on the async thread is invisible
    /// there, which is why the previous `scope_turn_id` helper was dead.
    /// Shared + atomic so it can be refreshed per turn after construction.
    turn_id: Arc<std::sync::atomic::AtomicUsize>,
    /// Names the model has loaded through `select_tools`. Shared (`Arc`) so the
    /// toolset can hand a `&mut` view to the loader while `execute` keeps its
    /// `&self` signature; persists for the pipeline's lifetime, so
    /// `already_available` is meaningful across turns.
    loaded_tools: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// The user's global `[tools]` enable/disable lists (v2 tool policy):
    /// applied to the advertised table and enforced again before execution.
    tools_filter: Option<tool_policy::ToolsFilter>,
    /// `[secondary_model]`: the subagent model pool the `Agent` / `AgentSwarm`
    /// tools advertise and bind. `None` = subagents inherit the caller's model.
    secondary_model: Option<std::sync::Arc<crate::subagent::secondary::SecondaryModelRuntime>>,
    /// `[image].read_byte_budget` (v2 `resolveReadImageByteBudget`) for
    /// model-initiated image reads; `None` keeps the 256KB default.
    image_read_byte_budget: Option<u64>,
    /// `[image].max_edge_px` for model-initiated image reads; `None` keeps
    /// the 2000px default.
    image_max_edge_px: Option<u32>,
    /// The session model's declared capabilities. `None`/empty means unknown,
    /// and an image read is allowed (v2 `isUnknownCapability`); a declared
    /// set without `image_in` refuses it.
    model_capabilities: Option<Vec<String>>,
    /// `[background].bash_auto_background_on_timeout`: migrate a timed-out
    /// foreground Bash call to the background instead of killing it.
    /// Defaults to `true`.
    bash_auto_background: bool,
    /// `[background].bash_task_timeout_s`: default timeout for background
    /// Bash tasks (also re-arms a foreground command migrated to the
    /// background on timeout). `None` keeps the built-in 600s; `Some(0)`
    /// means "no timeout".
    bash_task_timeout_s: Option<u64>,
    /// Bound provider type (e.g. "kimi").
    provider: Option<String>,
}

/// Bundle the native file-history recorder needs: the store handle plus
/// the session to attribute the change to. `turn_id` is read from the
/// `TURN_ID` task-local at record time, which the turn runner scopes per
/// turn (REPL callers that don't scope it record under turn 0).
#[derive(Clone)]
struct FileHistoryCtx {
    store: std::sync::Arc<crate::session::sqlite_store::SqliteSessionStore>,
    session_id: String,
}

thread_local! {
    /// Per-call file-history context installed by
    /// `run_mutating_file_tool_on_blocking_pool` so the static `write` /
    /// `edit` fns can reach the recorder without changing their signature.
    static FILE_HISTORY: std::cell::RefCell<Option<FileHistoryCtx>> =
        const { std::cell::RefCell::new(None) };

    /// Turn number the current mutating-file call belongs to. Installed in the
    /// same blocking closure as `FILE_HISTORY` (see
    /// [`NativeToolset::spawn_mutating_file_tool`]); the mutating file tools
    /// read it when recording the file-history row.
    static TURN_ID: std::cell::RefCell<usize> =
        const { std::cell::RefCell::new(0) };
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
            // Windows without an explicit shell path resolves the `[shell]`
            // preference / auto-detected shell (pwsh → powershell → Git Bash →
            // cmd), mirroring the v2 native bash engine.
            shell_path
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty())
                .or_else(|| Some(crate::native::shell::resolve_shell(None).program))
        } else {
            Some(
                shell_path
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("bash")
                    .to_string(),
            )
        };
        Some(Self {
            root,
            extra_roots: Vec::new(),
            shell,
            subagent_manager: None,
            mcp_manager: None,
            subagent_timeout_ms: None,
            parent_cancel: None,
            parent_cancel_slot: None,
            callbacks: None,
            github_credentials: None,
            caller_agent_id: None,
            session_id: None,
            task_runner: None,
            file_history: Arc::new(std::sync::Mutex::new(None)),
            turn_id: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            loaded_tools: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            tools_filter: None,
            secondary_model: None,
            image_read_byte_budget: None,
            image_max_edge_px: None,
            model_capabilities: None,
            bash_auto_background: true,
            bash_task_timeout_s: None,
            provider: None,
        })
    }

    /// Host-authorized extra roots (`additionalDirs`): directories outside the
    /// workspace root that this session may still read and write natively.
    pub fn with_extra_roots(mut self, extra: Vec<String>) -> Self {
        let roots: Vec<PathBuf> = extra
            .into_iter()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .collect();
        self.extra_roots = Sandbox::new(self.root.clone())
            .with_extra(roots)
            .extra()
            .to_vec();
        self
    }

    /// The sandbox this toolset executes inside. Roots were canonicalized when
    /// [`Self::with_extra_roots`] ran, so this is a cheap clone per call.
    fn sandbox(&self) -> Sandbox {
        Sandbox {
            primary: self.root.clone(),
            extra: self.extra_roots.clone(),
        }
    }

    /// Apply the host-resolved `[image]` limits for model-initiated reads
    /// (v2 `resolveReadImageByteBudget` / `resolveMaxImageEdgePx`).
    pub fn with_image_limits(
        mut self,
        read_byte_budget: Option<u64>,
        max_edge_px: Option<u32>,
    ) -> Self {
        self.image_read_byte_budget = read_byte_budget;
        self.image_max_edge_px = max_edge_px;
        self
    }

    /// Apply the session model's declared capabilities (v2 model catalog
    /// `capabilities`); an empty/`None` set stays unknown.
    pub fn with_model_capabilities(mut self, capabilities: Option<Vec<String>>) -> Self {
        self.model_capabilities = capabilities.filter(|caps| !caps.is_empty());
        self
    }

    /// `[background].bash_auto_background_on_timeout`: whether a timed-out
    /// foreground Bash call migrates to the background. `None` keeps the
    /// default (`true`).
    #[must_use]
    pub fn with_bash_auto_background(mut self, auto_background: Option<bool>) -> Self {
        self.bash_auto_background = auto_background.unwrap_or(true);
        self
    }

    /// `[background].bash_task_timeout_s`: the default timeout for background
    /// Bash tasks. `None` keeps the built-in 600s; `Some(0)` means "no
    /// timeout".
    #[must_use]
    pub fn with_bash_task_timeout(mut self, timeout_s: Option<u64>) -> Self {
        self.bash_task_timeout_s = timeout_s;
        self
    }

    /// The effective bound for a background Bash task: the call's own
    /// `timeout` wins over `[background].bash_task_timeout_s`, which wins over
    /// the built-in 600s. `disable_timeout` and a resolved `0` mean "no
    /// timeout"; anything else is clamped to 24h.
    fn background_bash_timeout(&self, args: &Value) -> Option<Duration> {
        if args
            .get("disable_timeout")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return None;
        }
        let seconds = args
            .get("timeout")
            .and_then(Value::as_u64)
            .or(self.bash_task_timeout_s)
            .unwrap_or(BASH_TASK_DEFAULT_TIMEOUT_S);
        if seconds == 0 {
            return None;
        }
        Some(Duration::from_secs(seconds.min(BASH_TASK_MAX_SECONDS)))
    }

    fn read_media_limits(&self) -> read_media::ReadMediaLimits {
        let capability = |name: &str| {
            self.model_capabilities
                .as_deref()
                .map(|caps| caps.iter().any(|cap| cap == name))
        };
        read_media::ReadMediaLimits {
            read_byte_budget: self.image_read_byte_budget,
            max_edge_px: self.image_max_edge_px,
            image_in: capability("image_in"),
            video_in: capability("video_in"),
            provider: self.provider.clone(),
        }
    }

    /// Set the bound provider type (e.g. "kimi").
    pub fn with_provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = Some(provider.into());
        self
    }

    /// Attach a TaskRunner for native background tasks and inspection.
    pub fn with_task_runner(mut self, runner: std::sync::Arc<crate::storage::TaskRunner>) -> Self {
        self.task_runner = Some(runner);
        self
    }

    pub fn with_caller_agent_id(mut self, agent_id: impl Into<String>) -> Self {
        self.caller_agent_id = Some(agent_id.into());
        self
    }

    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// Enable native file-history capture for mutating file tools (`write` /
    /// `edit`). Each successful mutation records a `session_file_history`
    /// row (v2 `fileHistoryService.onWillExecuteTool` capture, plus the
    /// post-image diff) so `undo {revert_files:true}` and the
    /// `/file-history/*` endpoints have real data.
    ///
    /// `turn_id` is attributed on the toolset ([`Self::with_turn_id`], default
    /// 0) and installed alongside the recorder inside the blocking call, so it
    /// is visible to the tool regardless of which pool thread runs it.
    pub fn with_file_history(
        self,
        store: std::sync::Arc<crate::session::sqlite_store::SqliteSessionStore>,
        session_id: impl Into<String>,
    ) -> Self {
        self.set_file_history(store, session_id, self.effective_turn_id());
        self
    }

    /// Turn number attributed to file-history rows recorded by this toolset.
    #[must_use]
    pub fn with_turn_id(self, turn_id: usize) -> Self {
        self.set_turn_id(turn_id);
        self
    }

    /// Install/refresh the file-history recorder. Takes `&self` so a host can
    /// arm capture on a toolset already moved into the callbacks wrapper — the
    /// reason this is not builder-only.
    pub fn set_file_history(
        &self,
        store: std::sync::Arc<crate::session::sqlite_store::SqliteSessionStore>,
        session_id: impl Into<String>,
        turn_id: usize,
    ) {
        *self
            .file_history
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(FileHistoryCtx {
            store,
            session_id: session_id.into(),
        });
        self.set_turn_id(turn_id);
    }

    /// Refresh only the turn number (the recorder stays as installed).
    pub fn set_turn_id(&self, turn_id: usize) {
        self.turn_id
            .store(turn_id, std::sync::atomic::Ordering::SeqCst);
    }

    fn effective_turn_id(&self) -> usize {
        self.turn_id.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The agent id executing the current turn: the [`CALLER_AGENT_ID`]
    /// task-local when the turn runner scoped one (a subagent's id), else the
    /// construction-time `caller_agent_id`, else `"main"`. The tower tools use
    /// this so a worker's calls are attributed to the worker rather than to the
    /// main agent, and the main-agent-only gate actually denies workers.
    fn effective_caller_agent_id(&self) -> String {
        CALLER_AGENT_ID
            .try_with(|id| id.clone())
            .unwrap_or_else(|_| {
                self.caller_agent_id
                    .clone()
                    .unwrap_or_else(|| "main".to_string())
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

    /// Get the attached McpManager if any.
    pub fn mcp_manager(&self) -> Option<&std::sync::Arc<crate::mcp::McpManager>> {
        self.mcp_manager.as_ref()
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

    /// Attach the user's global `[tools]` switch; every native call must
    /// survive it even when the model calls a disabled tool from memory.
    pub fn with_tools_filter(mut self, filter: Option<tool_policy::ToolsFilter>) -> Self {
        self.tools_filter = filter;
        self
    }

    /// The user's global `[tools]` switch, if configured.
    pub fn tools_filter(&self) -> Option<&tool_policy::ToolsFilter> {
        self.tools_filter.as_ref()
    }

    /// Host-resolved `[github]` credentials, when the session has any.
    pub fn github_credentials(&self) -> Option<&github::GitHubCredentials> {
        self.github_credentials.as_ref()
    }

    /// Attach the `[secondary_model]` subagent model pool.
    pub fn with_secondary_model(
        mut self,
        pool: Option<std::sync::Arc<crate::subagent::secondary::SecondaryModelRuntime>>,
    ) -> Self {
        self.secondary_model = pool;
        self
    }

    /// The subagent model pool, when `[secondary_model]` is configured.
    pub fn secondary_model(
        &self,
    ) -> Option<&std::sync::Arc<crate::subagent::secondary::SecondaryModelRuntime>> {
        self.secondary_model.as_ref()
    }

    /// Execute a read-only tool natively when supported and inside the
    /// sandbox. `None` means "not handled here — send it to the host".
    pub fn execute(&self, tool_name: &str, args: &Value) -> Option<ExecutableToolResult> {
        let sandbox = self.sandbox();
        match tool_name.to_ascii_lowercase().as_str() {
            "read" => self.read_media(args).or_else(|| Self::read(&sandbox, args)),
            "grep" => Self::grep(&sandbox, args),
            "glob" => Self::glob(&sandbox, args),
            "listdirectory" | "list_directory" => {
                list_directory::execute_list_directory(&self.root, &self.extra_roots, args)
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
        // BTW side-channel veto (v2 `onBeforeExecuteTool` in `SessionBtwService`):
        // all tool calls from a side-channel agent are denied with TOOL_CALL_DISABLED_MESSAGE.
        let caller = self.effective_caller_agent_id();
        if let Some(denial) = crate::subagent::check_btw_tool_denial(Some(caller.as_str())) {
            return Some(denial);
        }

        // Global `[tools]` switch (v2 tool policy): enforced again before
        // execution so a disabled tool is refused even when the model calls
        // it from memory instead of reading the advertised table.
        if let Some(filter) = &self.tools_filter
            && filter.blocks_call(tool_name)
        {
            return Some(ExecutableToolResult {
                delivery: None,
                stop_turn: false,
                content: format!(
                    "Tool '{tool_name}' is disabled by the [tools] configuration and cannot run."
                ),
                is_error: true,
                note: Some("tool_policy".into()),
            });
        }

        match tool_name.to_ascii_lowercase().as_str() {
            "read" => {
                // An image read is delivered to the model as media (v2
                // `executeMediaRead`), `region` / `full_resolution` included.
                // Text files and plain binary reads fall through to the text
                // read.
                if let Some(result) = self.read_media_on_blocking_pool(args).await {
                    return Some(result);
                }
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
                list_directory::execute_list_directory(&self.root, &self.extra_roots, args)
            }
            "fetchurl" | "fetch_url" => fetch_url::execute_fetch_url(args, tool_call_id).await,
            "websearch" | "web_search" => web_search::execute_web_search(args, tool_call_id).await,
            "lsp" => lsp_tool::execute_lsp_tool(&self.root, args).await,
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
                let mut result = plan_mode::execute_enter_plan_mode(callbacks, args).await;
                // Mode mutex (v2 `PlanModeEnter` → tower exit), main agent
                // only: a subagent's plan entry is scoped to that subagent, so
                // it must not touch the main agent's tower (v2's modeMutex is
                // Agent-scoped and `tower.isActive` is main-only).
                if !result.is_error && self.effective_caller_agent_id() == "main" {
                    let paused =
                        mode_mutex::pause_tower_for_mode_enter(&self.root, "plan mode entered")
                            .await;
                    if !paused.is_empty() {
                        result
                            .content
                            .push_str(&mode_mutex::tower_paused_note(&paused));
                    }
                }
                Some(result)
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
            "taskwait" | "task_wait" | "waitfor" | "wait_for" => {
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
                Some(skill::execute_skill(callbacks, self.session_id.as_deref(), args).await)
            }
            "notifyuser" | "notify_user" => {
                let message = args.get("message").and_then(Value::as_str).unwrap_or("");
                if message.trim().is_empty() {
                    Some(ExecutableToolResult {
                        delivery: None,
                        stop_turn: false,
                        content: "message must not be empty.".to_string(),
                        is_error: true,
                        note: None,
                    })
                } else {
                    Some(ExecutableToolResult {
                        delivery: None,
                        stop_turn: false,
                        content: "Update shown to the user.".to_string(),
                        is_error: false,
                        note: None,
                    })
                }
            }
            "select_tools" | "selecttools" => {
                let callbacks = self.callbacks.as_deref()?;
                // A failed enumeration is not an empty catalogue. Collapsing it
                // to an empty set made every requested name look like a typo the
                // model had made, hiding the RPC failure behind "unknown tool".
                let available: std::collections::HashSet<String> = match callbacks
                    .list_tools()
                    .await
                {
                    Ok(resp) => resp.tools.into_iter().map(|t| t.name).collect(),
                    Err(error) => {
                        return Some(ExecutableToolResult {
                            delivery: None,
                            stop_turn: false,
                            content: format!(
                                "Could not enumerate the connected tools ({error}). No tools were selected; retry once the connection is healthy."
                            ),
                            is_error: true,
                            note: None,
                        });
                    }
                };
                // The loaded set is the toolset's shared, session-scoped one:
                // a fresh set per call made `already_available` unreachable and
                // reported every requested tool as newly loaded.
                let mut loaded = self
                    .loaded_tools
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                Some(select_tools::execute_select_tools(
                    args,
                    &available,
                    &mut loaded,
                ))
            }
            "team" => {
                let mgr = self.subagent_manager.as_ref()?;
                let cancel = self.effective_parent_cancel();
                Some(team_tool::execute_team(mgr, args, cancel.as_ref()).await)
            }
            "agent" => {
                let mgr = self.subagent_manager.as_ref()?;
                agent_tool::execute_agent(
                    mgr,
                    args,
                    self.subagent_timeout_ms,
                    self.effective_parent_cancel().as_ref(),
                    tool_call_id,
                    self.secondary_model.as_deref(),
                )
                .await
            }
            "agentswarm" | "agent_swarm" => {
                let mgr = self.subagent_manager.as_ref()?;
                // Mode mutex (v2 `SwarmModeEnter` → tower exit): v2 enters
                // swarm mode *before* the batch runs, so pause tower here too
                // — pausing after the batch would let a sibling tool call race
                // worker writes against the not-yet-paused state. Main agent
                // only (v2 swarm mode is Agent-scoped).
                let paused = if self.effective_caller_agent_id() == "main" {
                    mode_mutex::pause_tower_for_mode_enter(&self.root, "AgentSwarm dispatched")
                        .await
                } else {
                    Vec::new()
                };
                let result = swarm_tool::execute_agent_swarm(
                    mgr,
                    args,
                    self.subagent_timeout_ms,
                    self.effective_parent_cancel().as_ref(),
                    tool_call_id,
                    self.secondary_model.as_deref(),
                )
                .await;
                match result {
                    Some(mut r) => {
                        // The pause already happened (v2 enters swarm mode
                        // before execution), so report it even when the batch
                        // itself failed — the state change is real either way.
                        if !paused.is_empty() {
                            r.content.push_str(&mode_mutex::tower_paused_note(&paused));
                        }
                        Some(r)
                    }
                    None => None,
                }
            }
            "knowledge" => Some(knowledge_tool::execute_knowledge(&self.root, args)),
            "memoryread" | "memory_read" => {
                Some(memory_tool::execute_memory_read(&self.root, args))
            }
            "memorywrite" | "memory_write" => {
                Some(memory_tool::execute_memory_write(&self.root, args))
            }
            "memorystrreplace" | "memory_str_replace" => {
                Some(memory_tool::execute_memory_str_replace(&self.root, args))
            }
            "memoryappend" | "memory_append" => {
                Some(memory_tool::execute_memory_append(&self.root, args))
            }
            "memorylist" | "memory_list" => {
                Some(memory_tool::execute_memory_list(&self.root, args))
            }
            "memorydelete" | "memory_delete" => {
                Some(memory_tool::execute_memory_delete(&self.root, args))
            }
            "workflow" => {
                let home = crate::workflow::kimi_home();
                let host: Option<std::sync::Arc<dyn crate::workflow::WorkflowHost>> =
                    self.subagent_manager.clone().map(|manager| {
                        // `search()` backend: without a provider the workflow
                        // primitive returned an empty list with no error, so a
                        // script's web lookup silently found nothing. Bound to
                        // the native DuckDuckGo search (the same engine the
                        // WebSearch tool uses). The host trait takes a sync
                        // provider, so this call blocks its executor thread for
                        // the search timeout — bounded by `timeout_ms` and only
                        // reached from a workflow script.
                        let search: std::sync::Arc<crate::workflow::host::SearchProvider> =
                            std::sync::Arc::new(|query: String, count: usize| {
                                let config = crate::native::web_search::WebSearchConfig {
                                    query,
                                    max_results: count.clamp(1, 10),
                                    ..Default::default()
                                };
                                crate::native::web_search::web_search(&config)
                                    .results
                                    .into_iter()
                                    .map(|hit| crate::workflow::SearchHit {
                                        title: hit.title,
                                        url: hit.url,
                                        snippet: hit.snippet,
                                    })
                                    .collect()
                            });
                        std::sync::Arc::new(
                            crate::workflow::host::SubagentWorkflowHost::new(
                                manager,
                                self.root.clone(),
                                home.clone(),
                            )
                            .with_search(search),
                        )
                            as std::sync::Arc<dyn crate::workflow::WorkflowHost>
                    });
                let outcome = crate::tools::workflow::run_workflow_tool(
                    crate::workflow::global_service(),
                    host,
                    home.as_deref(),
                    args,
                )
                .await;
                Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: outcome.stop_turn,
                    content: outcome.content,
                    is_error: outcome.is_error,
                    note: None,
                })
            }
            "towerinit" | "tower_init" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                let session = self.session_id.as_deref().unwrap_or("session-main");
                let mut result =
                    tower::execute_tower_init(&self.root, caller, session, &args.to_string()).await;
                // Mode mutex (v2 `TowerModeEnter` → plan exit): a tower
                // starting under plan mode would split the brain — main turns
                // stay plan-guarded while workers run free — so exit plan
                // once the tower actually entered. Ordered after init because
                // v2 exits plan on the entry event: a refused or failed init
                // never entered tower mode, so it must not drop plan mode.
                // (Swarm needs no exit: AgentSwarm is call-scoped.) Main
                // agent only, matching v2's Agent-scoped mutex.
                if caller == "main"
                    && !result.is_error
                    && let Some(callbacks) = self.callbacks.as_deref()
                    && mode_mutex::exit_plan_for_tower_enter(callbacks).await
                {
                    result.content =
                        format!("{}\n\n{}", mode_mutex::plan_exited_note(), result.content);
                }
                Some(result)
            }
            "towerplan" | "tower_plan" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_plan(&self.root, caller, &args.to_string()).await)
            }
            "towerspawn" | "tower_spawn" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                let session = self.session_id.as_deref().unwrap_or("session-main");
                tower::execute_tower_spawn(
                    &self.root,
                    caller,
                    session,
                    self.subagent_manager.as_ref(),
                    tool_call_id,
                    self.effective_parent_cancel().as_ref(),
                    &args.to_string(),
                )
                .await
            }
            "towermerge" | "tower_merge" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_merge(&self.root, caller, &args.to_string()).await)
            }
            "towerteardown" | "tower_teardown" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                let session = self.session_id.as_deref().unwrap_or("session-main");
                Some(
                    tower::execute_tower_teardown(&self.root, caller, session, &args.to_string())
                        .await,
                )
            }
            "towersend" | "tower_send" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_send(&self.root, caller, &args.to_string()).await)
            }
            "towerinbox" | "tower_inbox" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_inbox(&self.root, caller, &args.to_string()).await)
            }
            "towerfinding" | "tower_finding" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_finding(&self.root, caller, &args.to_string()).await)
            }
            "towerreview" | "tower_review" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_review(&self.root, caller, &args.to_string()).await)
            }
            "towermission" | "tower_mission" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_mission(&self.root, caller, &args.to_string()).await)
            }
            "towerstatus" | "tower_status" => {
                let caller = self.effective_caller_agent_id();
                let caller = caller.as_str();
                Some(tower::execute_tower_status(&self.root, caller).await)
            }
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
        tool: fn(&Sandbox, &Value) -> Option<ExecutableToolResult>,
    ) -> Option<ExecutableToolResult> {
        match Self::spawn_file_tool(self.sandbox(), args.clone(), tool).await {
            Ok(result) => result,
            Err(e) => blocking_pool_failure(false, e.to_string()),
        }
    }

    /// The native Read media path (v2 `executeMediaRead`): an image the model
    /// asked to read is delivered to the conversation as media, honoring
    /// `region` and `full_resolution`. `None` = not a media read (a text file
    /// without those args), so the caller runs the text read instead.
    fn read_media(&self, args: &Value) -> Option<ExecutableToolResult> {
        let request = match read_media::ReadMediaRequest::from_args(args) {
            Ok(request) => request,
            Err(message) => return Some(err_result(message)),
        };
        let path = args.get("path")?.as_str()?;
        let resolved = Self::resolve(&self.sandbox(), path)?;
        read_media::read_image_media(&resolved, &request, &self.read_media_limits())
    }

    /// [`Self::read_media`] on the blocking pool: decoding, cropping and
    /// re-encoding a large image would otherwise pin the tokio workers that
    /// carry the LLM streams, bash output pumps and steer queue.
    async fn read_media_on_blocking_pool(&self, args: &Value) -> Option<ExecutableToolResult> {
        let request = match read_media::ReadMediaRequest::from_args(args) {
            Ok(request) => request,
            Err(message) => return Some(err_result(message)),
        };
        let path = args.get("path")?.as_str()?;
        let resolved = Self::resolve(&self.sandbox(), path)?;
        let limits = self.read_media_limits();
        match tokio::task::spawn_blocking(move || {
            read_media::read_image_media(&resolved, &request, &limits)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => blocking_pool_failure(false, error.to_string()),
        }
    }

    async fn spawn_file_tool(
        sandbox: Sandbox,
        args: Value,
        tool: fn(&Sandbox, &Value) -> Option<ExecutableToolResult>,
    ) -> Result<Option<ExecutableToolResult>, tokio::task::JoinError> {
        tokio::task::spawn_blocking(move || tool(&sandbox, &args)).await
    }

    /// Run a synchronous mutating file-I/O tool (`write` / `edit`) on tokio's
    /// blocking pool. Same ownership rules as the read-only variant, but a
    /// `JoinError` becomes an error result rather than a `None` host fallback:
    /// the call was already permission-granted and may have partially applied,
    /// so letting the host re-run it could double-apply the change.
    async fn run_mutating_file_tool_on_blocking_pool(
        &self,
        args: &Value,
        tool: fn(&Sandbox, &Value) -> Option<ExecutableToolResult>,
    ) -> Option<ExecutableToolResult> {
        let ctx = self
            .file_history
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let turn_id = self.effective_turn_id();
        match Self::spawn_mutating_file_tool(self.sandbox(), args.clone(), tool, ctx, turn_id).await
        {
            Ok(result) => result,
            Err(e) => blocking_pool_failure(true, e.to_string()),
        }
    }

    async fn spawn_mutating_file_tool(
        sandbox: Sandbox,
        args: Value,
        tool: fn(&Sandbox, &Value) -> Option<ExecutableToolResult>,
        ctx: Option<FileHistoryCtx>,
        turn_id: usize,
    ) -> Result<Option<ExecutableToolResult>, tokio::task::JoinError> {
        tokio::task::spawn_blocking(move || {
            // Install the recorder and the turn number for the duration of this
            // blocking call; `write` / `edit` read both back out to record the
            // change. Thread-locals must be set *here* — the blocking pool runs
            // on another thread, so a value installed on the async thread would
            // be invisible. `ctx` is `None` for callers without
            // `with_file_history`, in which case nothing is recorded.
            FILE_HISTORY.with(|cell| *cell.borrow_mut() = ctx);
            TURN_ID.with(|cell| *cell.borrow_mut() = turn_id);
            let result = tool(&sandbox, &args);
            FILE_HISTORY.with(|cell| *cell.borrow_mut() = None);
            TURN_ID.with(|cell| *cell.borrow_mut() = 0);
            result
        })
        .await
    }

    /// Resolve a path argument inside the sandbox. `None` when the path
    /// escapes every authorized root or does not exist.
    fn resolve(sandbox: &Sandbox, path: &str) -> Option<PathBuf> {
        // Reads are not path-gated: v2's sandbox only covers writes
        // (`sandboxWriteGuard`), and gating reads here turned every
        // out-of-workspace read into a silent host fallback — the host has no
        // file-tool runtime, so the read simply vanished.
        let candidate = Self::candidate_path(sandbox.primary(), path);
        std::fs::canonicalize(&candidate).ok()
    }

    /// Like [`resolve`] but tolerates a not-yet-existing target: walks up to
    /// the nearest existing ancestor, canonicalizes it (resolving any
    /// symlink escapes), then rejoins the missing tail. `None` when the
    /// existing ancestor lies outside the sandbox.
    fn resolve_for_write(sandbox: &Sandbox, path: &str) -> Option<PathBuf> {
        // Write confinement belongs to the SandboxMode gateway
        // (`SandboxExecutionPolicy::sandbox_write_guard`, Off by default —
        // mirroring v2), not to this resolver: an unconditional root check here
        // also blocked writes the configured mode had already allowed.
        let candidate = Self::candidate_path(sandbox.primary(), path);
        if let Ok(resolved) = std::fs::canonicalize(&candidate) {
            return Some(resolved);
        }
        let mut missing: Vec<std::ffi::OsString> = Vec::new();
        let mut cursor = candidate.as_path();
        loop {
            match std::fs::canonicalize(cursor) {
                Ok(existing) => {
                    let mut resolved = existing;
                    for segment in missing.iter().rev() {
                        resolved = resolved.join(segment);
                    }
                    return Some(resolved);
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

    fn read(sandbox: &Sandbox, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        // The dispatcher's media path owns `region` / `full_resolution` and
        // is consulted before every call that reaches this text read; decline
        // them here anyway so a direct caller cannot half-handle an image.
        if args.get("region").is_some_and(|v| !v.is_null())
            || args
                .get("full_resolution")
                .is_some_and(|v| v.as_bool() == Some(true))
        {
            return None;
        }
        // Negative offsets are tail reads implemented natively: -N starts
        // N lines from the end of the file (schema: -1000..=-1).
        let (line_offset, tail_lines) = match args.get("line_offset") {
            None | Some(Value::Null) => (1i64, 0usize),
            Some(v) => {
                let n = v.as_i64()?;
                if n == 0 {
                    return None;
                }
                (n, n.unsigned_abs() as usize)
            }
        };
        let mut offset = if line_offset > 0 {
            line_offset as usize
        } else {
            // Resolved below once the line count is known; 0 is a sentinel
            // that is always replaced before use.
            0
        };
        let column_offset = match args.get("column_offset") {
            None | Some(Value::Null) => 0usize,
            Some(v) => v.as_u64().unwrap_or(0) as usize,
        };
        let max_chars = match args.get("max_chars") {
            None | Some(Value::Null) => 100_000usize,
            Some(v) => (v.as_u64().unwrap_or(100_000) as usize).clamp(1, 500_000),
        };
        let n_lines = match args.get("n_lines") {
            None | Some(Value::Null) => READ_MAX_LINES,
            Some(v) => (v.as_u64()? as usize).min(READ_MAX_LINES),
        };

        let resolved = Self::resolve(sandbox, path)?;
        let meta = std::fs::metadata(&resolved).ok()?;
        if !meta.is_file() {
            return None;
        }

        // Encoding detection needs only the first bytes — reads are ranged
        // (v2 #3645), so a 30MB+ file must never load whole just to be read.
        let mut file = std::fs::File::open(&resolved).ok()?;
        let sample_len = (meta.len() as usize).min(encoding::ENCODING_DETECTION_SAMPLE_BYTES);
        let mut header = vec![0u8; sample_len];
        if sample_len > 0 {
            std::io::Read::read_exact(&mut file, &mut header).ok()?;
            // The sample consumed the handle's position: rewind so the line
            // stream starts at line 1, not after the header.
            std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0)).ok()?;
        }
        let detection = encoding::detect_text_encoding(&header);
        if detection.seems_binary {
            return None;
        }

        // Tail reads on UTF-8/ASCII files: count lines in a streaming pass
        // (no storage), then collect the window in a second pass from the
        // top, so large files are never loaded whole. The probe over-reads
        // into its buffer, so rewind explicitly afterwards.
        if tail_lines > 0 && detection.encoding == encoding::UtfTextEncoding::Utf8 {
            let counted = {
                use std::io::BufRead;
                let mut probe = std::io::BufReader::new(&mut file);
                let mut buf = Vec::new();
                let mut count = 0usize;
                loop {
                    buf.clear();
                    let n = probe.read_until(b'\n', &mut buf).ok()?;
                    if n == 0 {
                        break;
                    }
                    count += 1;
                }
                count
            };
            std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0)).ok()?;
            offset = counted.saturating_sub(tail_lines) + 1;
        }

        // Non-UTF-8 text (UTF-16/GBK) requires whole-file transcoding; the
        // transcode cap applies there. UTF-8/ASCII files stream line by line:
        // only the rendered window is held in memory, so file size is not a
        // constraint (the old whole-file load + READ_MAX_BYTES cap declined
        // every large text file before this).
        let (mut all, encoding_note, total_lines): (
            Vec<String>,
            Option<encoding::UtfTextEncoding>,
            usize,
        ) = if detection.encoding != encoding::UtfTextEncoding::Utf8 {
            if meta.len() > READ_MAX_BYTES {
                return None;
            }
            let bytes = std::fs::read(&resolved).ok()?;
            let text = encoding::decode_utf_text(&bytes, detection.encoding);
            let text_lines: Vec<String> = text.split('\n').map(|l| l.to_string()).collect();
            let total = text_lines.len();
            // Tail reads slice from the loaded lines. A trailing newline
            // leaves a phantom empty segment that the streaming counter
            // never sees, so exclude it from the tail math (the reported
            // total keeps the historical count).
            let windowed: Vec<String> = if tail_lines > 0 {
                let mut count = total;
                if count > 0 && text_lines.last().is_some_and(|l| l.is_empty()) {
                    count -= 1;
                }
                let start = count.saturating_sub(tail_lines).min(total);
                offset = start + 1;
                text_lines.into_iter().skip(start).collect()
            } else {
                text_lines
            };
            (windowed, Some(detection.encoding), total)
        } else {
            use std::io::BufRead;
            let mut reader = std::io::BufReader::new(file);
            let mut raw: Vec<u8> = Vec::new();
            let mut all: Vec<String> = Vec::new();
            let mut total: usize = 0;
            loop {
                raw.clear();
                let n = reader.read_until(b'\n', &mut raw).ok()?;
                if n == 0 {
                    break;
                }
                total += 1;
                if total < offset || all.len() >= n_lines {
                    continue;
                }
                if raw.contains(&0) {
                    return None;
                }
                let mut l = raw.clone();
                if l.last() == Some(&b'\n') {
                    l.pop();
                }
                match std::str::from_utf8(&l) {
                    Ok(text) => all.push(text.to_string()),
                    Err(_) => return None,
                }
            }
            (all, None, total)
        };

        // A leading UTF-8 BOM is stripped like TextDecoder does.
        if let Some(first) = all.first_mut()
            && let Some(stripped) = first.strip_prefix('\u{FEFF}')
        {
            *first = stripped.to_string();
        }
        // Re-attach the '\n' separators: the style detector distinguishes
        // CRLF from lone CR by what follows the '\r'.
        let window_bytes: Vec<u8> = all
            .iter()
            .flat_map(|l| {
                let mut b = l.as_bytes().to_vec();
                b.push(b'\n');
                b
            })
            .collect();
        let style = encoding::detect_line_ending_style(&window_bytes);

        if total_lines > 0 && offset > total_lines {
            return Some(err_result(format!(
                "line_offset {offset} is past the end of {path} ({total_lines} lines)"
            )));
        }
        let start = 0usize;
        let end = all.len();
        // Line rendering mirrors the host Read tool: `${lineNo}\t${content}`,
        // CRLF-style trailing CRs stripped, per-line truncation to
        // READ_MAX_LINE_LENGTH characters with a `...` marker, lone CRs made
        // visible as `\r` on mixed files, and a READ_MAX_OUTPUT_BYTES / max_chars budget.
        let mut out = String::new();
        let mut truncated_lines: Vec<usize> = Vec::new();
        let mut rendered_bytes = 0usize;
        let mut max_bytes_reached = false;
        let mut max_chars_reached = false;
        let mut rendered_count = 0usize;
        let mut resume_continuation: Option<(usize, usize)> = None;

        for (i, raw) in all[start..end].iter().enumerate() {
            let mut rendered: String = (*raw).to_string();
            let mut was_truncated = false;
            if style == encoding::LineEndingStyle::CrLf && rendered.ends_with('\r') {
                rendered.pop();
            }
            if i == 0 && column_offset > 0 {
                let char_count = rendered.chars().count();
                if column_offset >= char_count {
                    rendered.clear();
                } else {
                    rendered = rendered.chars().skip(column_offset).collect();
                }
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
            let current_line_num = offset + i;
            let rendered_line = format!("{}\t{}", current_line_num, rendered);
            // Check max_chars budget
            if !out.is_empty()
                && out.chars().count() + rendered_line.chars().count() + 1 > max_chars
            {
                max_chars_reached = true;
                let available_chars = max_chars.saturating_sub(out.chars().count() + 1);
                if available_chars > 8 {
                    let partial: String = rendered_line.chars().take(available_chars).collect();
                    out.push_str(&partial);
                    out.push('\n');
                    resume_continuation = Some((
                        current_line_num,
                        column_offset
                            + available_chars
                                .saturating_sub(format!("{current_line_num}\t").chars().count()),
                    ));
                } else {
                    resume_continuation = Some((current_line_num, 0));
                }
                break;
            }
            // The separator byte between rendered lines counts toward the
            // budget (host renderedLineBytes accounting).
            let line_bytes = rendered_line.len() + usize::from(!out.is_empty());
            if !out.is_empty() && rendered_bytes + line_bytes > READ_MAX_OUTPUT_BYTES {
                max_bytes_reached = true;
                resume_continuation = Some((current_line_num, 0));
                break;
            }
            if was_truncated {
                truncated_lines.push(current_line_num);
            }
            out.push_str(&rendered_line);
            out.push('\n');
            rendered_count += 1;
            rendered_bytes += line_bytes;
            if rendered_bytes >= READ_MAX_OUTPUT_BYTES {
                max_bytes_reached = true;
                if start + i + 1 < end {
                    resume_continuation = Some((offset + i + 1, 0));
                }
                break;
            }
        }
        // Host-faithful `<system>` note (finishMessage in readTool.ts).
        let mut parts: Vec<String> = Vec::new();
        if rendered_count > 0 {
            if column_offset > 0 {
                parts.push(format!(
                    "{rendered_count} {} read from file starting from line {offset}, column {column_offset}.",
                    if rendered_count == 1 { "line" } else { "lines" }
                ));
            } else {
                parts.push(format!(
                    "{rendered_count} {} read from file starting from line {offset}.",
                    if rendered_count == 1 { "line" } else { "lines" }
                ));
            }
        } else {
            parts.push("No lines read from file.".into());
        }
        parts.push(format!("Total lines in file: {total_lines}."));
        let max_lines_reached = n_lines >= READ_MAX_LINES
            && rendered_count == n_lines
            && offset + all.len() <= total_lines;
        if max_lines_reached {
            parts.push(format!("Max {READ_MAX_LINES} lines reached."));
        } else if max_chars_reached {
            parts.push(format!("Max {max_chars} characters reached."));
        } else if max_bytes_reached {
            parts.push(format!("Max {READ_MAX_OUTPUT_BYTES} bytes reached."));
        } else if rendered_count < n_lines {
            parts.push("End of file reached.".into());
        }
        if let Some((next_line, next_col)) = resume_continuation {
            parts.push(format!(
                "To resume reading, call Read with line_offset={next_line}, column_offset={next_col}."
            ));
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
    fn grep(sandbox: &Sandbox, args: &Value) -> Option<ExecutableToolResult> {
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
            None | Some(Value::Null) => sandbox.primary().to_path_buf(),
            Some(value) => Self::resolve(sandbox, value.as_str()?)?,
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
            sandbox.primary(),
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

    fn glob(sandbox: &Sandbox, args: &Value) -> Option<ExecutableToolResult> {
        let pattern = args.get("pattern")?.as_str()?;
        let include_ignored = args
            .get("include_ignored")
            .is_some_and(|v| v.as_bool() == Some(true));
        let head_limit = match args.get("head_limit").and_then(Value::as_u64) {
            Some(0) => usize::MAX,
            Some(n) => n as usize,
            None => 100,
        };
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let glob = build_glob(pattern)?;
        let search_root = match args.get("path").and_then(|p| p.as_str()) {
            Some(p) => Self::resolve(sandbox, p)?,
            None => sandbox.primary().to_path_buf(),
        };

        let mut results: Vec<String> = Vec::new();
        let mut filtered_sensitive: usize = 0;

        let mut builder = ignore::WalkBuilder::new(&search_root);
        builder.hidden(false);
        if include_ignored {
            builder
                .ignore(false)
                .git_ignore(false)
                .git_global(false)
                .git_exclude(false)
                .parents(false);
        }
        let walker = builder.build();
        for entry in walker.flatten() {
            let path = entry.path();
            // Judge VCS metadata only *below the search root*: a workspace
            // rooted at e.g. `/home/u/.git-configs/proj` or a `.tower/worktrees/…`
            // checkout carries those names in its own prefix, and matching the
            // absolute path would silently exclude every result.
            let relative = path.strip_prefix(&search_root).unwrap_or(path);
            if relative.components().any(|c| {
                matches!(
                    c.as_os_str().to_str(),
                    Some(name) if VCS_DIRECTORIES_TO_EXCLUDE.contains(&name)
                )
            }) {
                continue;
            }
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if glob.is_match(relative) || glob.is_match(path) {
                if is_sensitive_file(&path.to_string_lossy()) {
                    filtered_sensitive += 1;
                    continue;
                }
                let display = path.strip_prefix(sandbox.primary()).unwrap_or(path);
                results.push(display.display().to_string());
            }
        }
        results.sort();

        let total = results.len();
        let paged: Vec<String> = results.into_iter().skip(offset).take(head_limit).collect();
        let count = paged.len();
        let truncated = offset + count < total;

        let mut lines: Vec<String> = Vec::new();
        let mut footer: Vec<String> = Vec::new();

        if count == 0 {
            if total > 0 {
                lines.push(format!(
                    "No more matches at offset={offset} in the current result set ({total} matches)."
                ));
            } else if filtered_sensitive > 0 {
                lines.push(format!(
                    "No non-sensitive matches found ({filtered_sensitive} sensitive file(s) filtered)."
                ));
            } else {
                lines.push(format!("No files matched pattern: {pattern}"));
            }
        } else {
            if truncated || offset > 0 {
                lines.push(format!(
                    "Showing matches {}–{} of {total}.",
                    offset + 1,
                    offset + count
                ));
            }
            lines.extend(paged);
            if truncated {
                lines.push(format!(
                    "Continue with the same search arguments and offset={}.",
                    offset + count
                ));
                lines.push(
                    "To remove the match-count limit, omit offset and use head_limit=0.".into(),
                );
            }
        }
        if filtered_sensitive > 0 && total > 0 {
            footer.push(format!("Filtered {filtered_sensitive} sensitive file(s)."));
        }

        let out = [lines, footer].concat().join("\n");
        Some(ok_result(out))
    }

    // ── Write ──────────────────────────────────────────────────────────

    /// Record a successful mutating-file change into the session file-history
    /// table when a recorder is installed (v2 `fileHistoryService.onWillExecuteTool`
    /// plus post-image diff). Reads `turn_id` from the `TURN_ID` task-local so
    /// multi-turn pipelines attribute changes per turn. A failure to record
    /// never affects the tool result — the change itself already landed.
    fn record_file_history(resolved: &Path, before: Option<&str>, after: Option<&str>) {
        let Some(ctx) = FILE_HISTORY.with(|cell| cell.borrow().clone()) else {
            return;
        };
        let turn_id = TURN_ID.with(|cell| *cell.borrow());
        if let Err(e) = ctx.store.record_file_change(
            &ctx.session_id,
            turn_id,
            &resolved.display().to_string(),
            before,
            after,
        ) {
            tracing::debug!(
                session = %ctx.session_id,
                turn_id,
                path = %resolved.display(),
                error = %e,
                "file-history record failed"
            );
        }
    }

    fn write(sandbox: &Sandbox, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let content = args.get("content")?.as_str()?;
        let mode = match args.get("mode") {
            None | Some(Value::Null) => "overwrite",
            Some(v) => v.as_str()?,
        };
        let resolved = Self::resolve_for_write(sandbox, path)?;
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        // Snapshot the pre-image before the write so the recorder can store
        // the diff (v2 `fileHistoryService.onWillExecuteTool` capture).
        let pre_image = if resolved.is_file() {
            std::fs::read_to_string(&resolved).ok()
        } else {
            None
        };
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
        Self::record_file_history(&resolved, pre_image.as_deref(), Some(content));
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

    fn edit(sandbox: &Sandbox, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let old = args.get("old_string")?.as_str()?;
        let new = args.get("new_string")?.as_str()?;
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let resolved = Self::resolve_for_write(sandbox, path)?;

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
        // `text` is the pre-image; capture the diff before writing.
        Self::record_file_history(&resolved, Some(text.as_str()), Some(updated.as_str()));
        std::fs::write(&resolved, updated).ok()?;
        let display = resolved
            .strip_prefix(sandbox.primary())
            .unwrap_or(&resolved)
            .display();
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
        // Working directory defaults to the sandbox root; explicit cwd must
        // stay inside it. Returns `None` (host fallback) on escape — the
        // host applies its own cwd policy there.
        let working_dir = match args.get("cwd").and_then(|c| c.as_str()) {
            Some(cwd) => Self::resolve(&self.sandbox(), cwd)?,
            None => self.root.clone(),
        };

        // Background tasks: if TaskRunner is present, spawn natively and return task info;
        // otherwise hand back to host fallback.
        if args.get("run_in_background").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(runner) = &self.task_runner {
                let task_id = format!("task_{}", fastrand::u64(..));
                let desc = args
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or(command)
                    .to_string();
                let shell_cmd = self.shell.as_ref()?.clone();
                let shell_args =
                    crate::native::shell::ShellFlavor::from_path(&shell_cmd).args_prefix();
                let cmd_str = command.to_string();
                let work_dir = working_dir.clone();
                // `[background].bash_task_timeout_s` (per-call `timeout` wins,
                // `disable_timeout` opts out).
                let bg_timeout = self.background_bash_timeout(args);
                let progress_runner = runner.clone();
                let progress_task_id = task_id.clone();

                let bg_fut = async move {
                    use tokio::io::AsyncReadExt;
                    let mut cmd = tokio::process::Command::new(&shell_cmd);
                    for arg in &shell_args {
                        cmd.arg(arg);
                    }
                    cmd.arg(&cmd_str)
                        .current_dir(&work_dir)
                        .env("NO_COLOR", "1")
                        .env("TERM", "dumb")
                        .env("GIT_TERMINAL_PROMPT", "0")
                        .env("SHELL", &shell_cmd)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        // Killing on drop takes the process down if this future
                        // is abandoned.
                        .kill_on_drop(true);
                    let mut child = match cmd.spawn() {
                        Ok(child) => child,
                        Err(e) => return format!("Command execution failed: {e}"),
                    };
                    let mut stdout_pipe = child.stdout.take();
                    let mut stderr_pipe = child.stderr.take();
                    // Stream output and report it as `event.task.progress`, so
                    // the Web task card updates live instead of only at settle.
                    // Throttled the same way foreground Bash is.
                    let last_emit = std::sync::Mutex::new(
                        std::time::Instant::now() - Duration::from_millis(PROGRESS_MIN_INTERVAL_MS),
                    );
                    let emit = |stream: &str, chunk: &[u8]| {
                        let Ok(mut last) = last_emit.lock() else {
                            return;
                        };
                        if last.elapsed().as_millis() >= PROGRESS_MIN_INTERVAL_MS as u128 {
                            *last = std::time::Instant::now();
                            progress_runner.emit_progress(
                                &progress_task_id,
                                &String::from_utf8_lossy(chunk),
                                stream,
                            );
                        }
                    };
                    let collect = async {
                        tokio::join!(
                            async {
                                let mut buf = Vec::new();
                                if let Some(pipe) = stdout_pipe.as_mut() {
                                    let mut chunk = [0u8; 8192];
                                    loop {
                                        match pipe.read(&mut chunk).await {
                                            Ok(0) | Err(_) => break,
                                            Ok(n) => {
                                                emit("stdout", &chunk[..n]);
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
                                                emit("stderr", &chunk[..n]);
                                                buf.extend_from_slice(&chunk[..n]);
                                            }
                                        }
                                    }
                                }
                                buf
                            },
                            child.wait(),
                        )
                    };
                    let (out, err, _status) = match bg_timeout {
                        Some(limit) => match tokio::time::timeout(limit, collect).await {
                            Ok(result) => result,
                            Err(_) => {
                                let _ = child.kill().await;
                                let _ = child.wait().await;
                                return format!(
                                    "Background command timed out after {}s and was stopped.",
                                    limit.as_secs()
                                );
                            }
                        },
                        None => collect.await,
                    };
                    let mut s = String::from_utf8_lossy(&out).into_owned();
                    let err_text = String::from_utf8_lossy(&err);
                    if !err_text.trim().is_empty() {
                        if !s.is_empty() && !s.ends_with('\n') {
                            s.push('\n');
                        }
                        s.push_str(err_text.trim_end());
                    }
                    s
                };

                if runner
                    .spawn_task_with_meta(
                        crate::storage::TaskSpawnMeta {
                            session_id: self.session_id.as_deref(),
                            kind: "bash",
                            subagent_type: None,
                        },
                        task_id.clone(),
                        desc.clone(),
                        bg_fut,
                    )
                    .is_ok()
                {
                    return Some(ok_result(format!(
                        "Background task started (task_id: {task_id}).\ncommand: {command}\ndescription: {desc}\nUse TaskList or TaskOutput to inspect progress."
                    )));
                }
            }
            return None;
        }
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
        let mut command_builder = tokio::process::Command::new(shell);
        for arg in crate::native::shell::ShellFlavor::from_path(shell).args_prefix() {
            command_builder.arg(arg);
        }
        let mut child = command_builder
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
            // timeout or wait failure: if TaskRunner is available, migrate to background task!
            _ => {
                // `[background].bash_auto_background_on_timeout` (default
                // on): a timed-out foreground command migrates to the
                // background; when the user turns it off the command is
                // killed instead.
                if self.bash_auto_background
                    && let Some(runner) = &self.task_runner
                {
                    let task_id = format!("task_{}", fastrand::u64(..));
                    let desc = format!("Timed out: {command}");
                    // The migrated task is re-armed with the *background*
                    // bounds (600s unless the call or
                    // `[background].bash_task_timeout_s` says otherwise) — the
                    // 60s/300s foreground budget was computed separately.
                    let bg_timeout = self.background_bash_timeout(args);
                    let bg_fut = async move {
                        match bg_timeout {
                            Some(limit) => match tokio::time::timeout(limit, child.wait()).await {
                                Ok(_) => "Background command execution finished".to_string(),
                                Err(_) => {
                                    let _ = child.kill().await;
                                    let _ = child.wait().await;
                                    format!(
                                        "Background command timed out after {}s and was stopped.",
                                        limit.as_secs()
                                    )
                                }
                            },
                            None => {
                                let _ = child.wait().await;
                                "Background command execution finished".to_string()
                            }
                        }
                    };
                    let _ = runner.spawn_task_with_meta(
                        crate::storage::TaskSpawnMeta {
                            session_id: self.session_id.as_deref(),
                            kind: "bash",
                            subagent_type: None,
                        },
                        task_id.clone(),
                        desc,
                        bg_fut,
                    );
                    return Some(ok_result(format!(
                        "Command timed out after {}s and was moved to the background (task_id: {task_id}).\nUse TaskList to check status or TaskOutput to view output.",
                        timeout_s
                    )));
                }
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
    let search_root_owned = search_root.to_path_buf();

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
        let walk_root = search_root_owned.clone();
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
            // Judge VCS metadata only *below the search root* (see the Glob
            // walk): a workspace rooted under a path that itself contains
            // `.git`/`.hg`/… would otherwise exclude every hit.
            let relative = path.strip_prefix(&walk_root).unwrap_or(path);
            if relative.components().any(|c| {
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
        delivery: None,
        stop_turn: false,
        content,
        is_error: false,
        note: None,
    }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        delivery: None,
        stop_turn: false,
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

    /// Minimal host that answers only `list_tools` — enough to drive
    /// `select_tools` through the toolset.
    struct ToolTableHost(Vec<crate::turn_loop::types::ToolInfo>);

    impl crate::callbacks::HostCallbacks for ToolTableHost {
        fn llm_chat(
            &self,
            _request: crate::rpc::types::LlmChatRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
        {
            Box::pin(async { Err("unused".into()) })
        }

        fn execute_tool(
            &self,
            _request: crate::rpc::types::ToolExecuteRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async { Err("unused".into()) })
        }

        fn check_permission(
            &self,
            _request: crate::rpc::types::PermissionCheckRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async { Ok(crate::rpc::types::PermissionDecision::allow()) })
        }

        fn list_tools(
            &self,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::ListToolsResponse, String>>
        {
            let tools = self.0.clone();
            Box::pin(async move { Ok(crate::rpc::types::ListToolsResponse { tools }) })
        }
    }

    fn tool_info(name: &str) -> crate::turn_loop::types::ToolInfo {
        crate::turn_loop::types::ToolInfo {
            name: name.to_string(),
            description: format!("{name} tool"),
            input_schema: json!({ "type": "object" }),
        }
    }

    /// `select_tools` remembers what it loaded: the loaded set lives on the
    /// toolset, so a second call reports `already available` instead of
    /// re-claiming the load (a fresh set per call made that branch dead), and
    /// the announcement reaches the model through `delivery`.
    #[tokio::test]
    async fn select_tools_remembers_loaded_names_and_announces_them() {
        let (_dir, ts) = setup();
        let ts = ts.with_callbacks(std::sync::Arc::new(ToolTableHost(vec![
            tool_info("Read"),
            tool_info("mcp__github__search"),
        ])));

        let first = ts
            .execute_tool(
                "select_tools",
                &json!({ "names": ["mcp__github__search"] }),
            )
            .await
            .expect("select_tools is a native tool");
        assert!(!first.is_error, "{}", first.content);
        assert!(
            first.content.contains("Loaded: mcp__github__search"),
            "{}",
            first.content
        );
        let delivery = first.delivery.expect("announcement is delivered");
        let announced = delivery
            .blocks
            .iter()
            .find_map(|b| match b {
                crate::rpc::types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .expect("a text block");
        assert!(announced.contains("<tools_added>"), "{announced}");
        assert!(announced.contains("mcp__github__search"), "{announced}");

        // Second call for the same name: remembered, not re-loaded.
        let second = ts
            .execute_tool(
                "select_tools",
                &json!({ "names": ["mcp__github__search"] }),
            )
            .await
            .expect("select_tools is a native tool");
        assert!(
            second
                .content
                .contains("Already available: mcp__github__search"),
            "{}",
            second.content
        );
        assert!(
            second.delivery.is_none(),
            "nothing new was loaded, so no announcement"
        );
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
    fn read_region_on_a_text_file_is_refused() {
        let (_dir, ts) = setup();
        let result = ts
            .execute(
                "Read",
                &json!({ "path": "a.txt", "region": { "x": 0, "y": 0, "width": 1, "height": 1 } }),
            )
            .expect("the media path owns an explicit region call");
        assert!(result.is_error);
        assert!(result.content.contains("is a text file"));
    }

    #[test]
    fn read_crops_an_image_region() {
        let (dir, ts) = setup();
        let mut image = image::RgbaImage::new(200, 120);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
        }
        let mut png = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("encode png");
        std::fs::write(dir.path().join("shot.png"), png.into_inner()).unwrap();

        let result = ts
            .execute(
                "Read",
                &json!({
                    "path": "shot.png",
                    "region": { "x": 10, "y": 20, "width": 40, "height": 30 }
                }),
            )
            .expect("media result");
        assert!(!result.is_error, "content: {}", result.content);
        let note = result.note.expect("note");
        assert!(
            note.contains("Showing region (x=10, y=20, width=40, height=30)"),
            "note: {note}"
        );
        let delivery = result.delivery.expect("delivery");
        assert!(matches!(
            delivery.blocks.as_slice(),
            [crate::rpc::types::ContentBlock::Image { .. }]
        ));
    }

    #[test]
    fn read_full_resolution_sends_the_original_bytes() {
        let (dir, ts) = setup();
        let bytes = {
            let mut image = image::RgbaImage::new(48, 48);
            for (x, y, pixel) in image.enumerate_pixels_mut() {
                *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
            }
            let mut png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut png, image::ImageFormat::Png)
                .expect("encode png");
            png.into_inner()
        };
        std::fs::write(dir.path().join("shot.png"), &bytes).unwrap();

        let result = ts
            .execute(
                "Read",
                &json!({ "path": "shot.png", "full_resolution": true }),
            )
            .expect("media result");
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result
                .note
                .expect("note")
                .contains("Shown at native resolution; no downscaling applied.")
        );
        let delivery = result.delivery.expect("delivery");
        match &delivery.blocks[0] {
            crate::rpc::types::ContentBlock::Image { data, .. } => {
                use base64::prelude::*;
                assert_eq!(*data, BASE64_STANDARD.encode(&bytes));
            }
            other => panic!("expected an image block, got {other:?}"),
        }
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

    /// The file-history chain end to end: a native `Write` records a
    /// `session_file_history` row, and `revert_turn_file_changes` can then undo
    /// it. Before this was wired `with_file_history` had no caller, so
    /// `/file-history/*` was always empty and `undo {revert_files:true}`
    /// reported success while restoring nothing.
    #[tokio::test]
    async fn write_records_file_history_and_revert_restores_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            Arc::new(crate::session::sqlite_store::SqliteSessionStore::in_memory().unwrap());
        let sid = "sess-file-history";
        store.create_session(sid, Some("fh")).unwrap();

        // Pre-existing file, so the revert path restores the pre-image rather
        // than exercising only the "added file" branch.
        std::fs::write(dir.path().join("kept.txt"), "original").unwrap();

        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None)
            .unwrap()
            .with_file_history(store.clone(), sid)
            .with_turn_id(1);

        let overwritten = ts
            .execute_mutating("Write", &json!({ "path": "kept.txt", "content": "changed" }))
            .await
            .expect("write executes natively");
        assert!(!overwritten.is_error, "{}", overwritten.content);
        let created = ts
            .execute_mutating("Write", &json!({ "path": "fresh.txt", "content": "new" }))
            .await
            .expect("write executes natively");
        assert!(!created.is_error, "{}", created.content);

        // Both writes are attributed to the turn `with_turn_id` installed.
        // `record_file_history` stores the canonicalized absolute path (that is
        // what the mutating tools resolve), so match on the file name.
        let (changes, _) = store.get_file_history_changes(sid, Some(1)).unwrap();
        assert_eq!(changes.len(), 2, "one row per write: {changes:?}");
        let named = |suffix: &str| {
            changes
                .iter()
                .any(|c| c.path.replace('\\', "/").ends_with(suffix))
        };
        assert!(named("kept.txt"), "{changes:?}");
        assert!(named("fresh.txt"), "{changes:?}");

        // A different turn number sees nothing.
        let (other_turn, _) = store.get_file_history_changes(sid, Some(2)).unwrap();
        assert!(other_turn.is_empty(), "{other_turn:?}");

        // The pre-image was captured, so undo can actually restore the file.
        let reverted = store.revert_turn_file_changes(sid, 1, dir.path()).unwrap();
        assert_eq!(reverted.len(), 2, "{reverted:?}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("kept.txt")).unwrap(),
            "original"
        );
        assert!(
            !dir.path().join("fresh.txt").exists(),
            "a file the turn added is removed by the revert"
        );
    }

    /// Without `with_file_history` nothing is recorded — the chain is opt-in,
    /// not incidentally broken.
    #[tokio::test]
    async fn write_without_recorder_records_nothing() {
        let (_dir, ts) = setup();
        let result = ts
            .execute_mutating("Write", &json!({ "path": "plain.txt", "content": "x" }))
            .await
            .unwrap();
        assert!(!result.is_error, "{}", result.content);
    }

    #[test]
    fn background_bash_timeout_follows_call_then_config() {
        let (_dir, ts) = setup();
        // Built-in default when neither the config nor the call sets one.
        assert_eq!(
            ts.background_bash_timeout(&json!({})),
            Some(Duration::from_secs(BASH_TASK_DEFAULT_TIMEOUT_S))
        );
        // `[background].bash_task_timeout_s` wins over the built-in...
        let configured = ts.with_bash_task_timeout(Some(1200));
        assert_eq!(
            configured.background_bash_timeout(&json!({})),
            Some(Duration::from_secs(1200))
        );
        // ...and the call's own `timeout` wins over the config.
        assert_eq!(
            configured.background_bash_timeout(&json!({ "timeout": 30 })),
            Some(Duration::from_secs(30))
        );
        // `0` from either source means "no timeout".
        assert_eq!(
            configured.background_bash_timeout(&json!({ "timeout": 0 })),
            None
        );
        let (_dir2, unset) = setup();
        assert_eq!(
            unset
                .with_bash_task_timeout(Some(0))
                .background_bash_timeout(&json!({})),
            None
        );
        // `disable_timeout` is an explicit opt-out.
        assert_eq!(
            configured.background_bash_timeout(&json!({ "timeout": 30, "disable_timeout": true })),
            None
        );
        // The 24h ceiling clamps both sources.
        assert_eq!(
            configured.background_bash_timeout(&json!({ "timeout": BASH_TASK_MAX_SECONDS + 1 })),
            Some(Duration::from_secs(BASH_TASK_MAX_SECONDS))
        );
        let clamped = configured.with_bash_task_timeout(Some(BASH_TASK_MAX_SECONDS + 1));
        assert_eq!(
            clamped.background_bash_timeout(&json!({})),
            Some(Duration::from_secs(BASH_TASK_MAX_SECONDS))
        );
    }

    #[test]
    fn bash_auto_background_defaults_on_and_is_overridable() {
        let (_dir, ts) = setup();
        assert!(ts.bash_auto_background);
        // Unset keeps the default; an explicit value overrides it.
        let unset = ts.with_bash_auto_background(None);
        assert!(unset.bash_auto_background);
        // The builder consumes `self`, so rebind for the second override.
        let off = unset.with_bash_auto_background(Some(false));
        assert!(!off.bash_auto_background);
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

    /// Reads are not path-gated: v2's sandbox (`sandboxWriteGuard`) covers
    /// writes only, so an out-of-workspace read is served in-process — the
    /// host has no file-tool runtime to fall back to.
    #[test]
    fn read_outside_workspace_is_served_natively() {
        let (_dir, ts) = setup();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        let escaped = outside.path().join("secret.txt");
        let result = ts
            .execute("Read", &json!({ "path": escaped.to_str().unwrap() }))
            .expect("reads must not be declined for lying outside the workspace");
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("nope"),
            "content: {}",
            result.content
        );
    }

    #[test]
    fn read_negative_offset_reads_tail_natively() {
        let (_dir, ts) = setup();
        // a.txt is 3 lines; -2 serves the last two with correct numbers.
        let tail = ts
            .execute("Read", &json!({ "path": "a.txt", "line_offset": -2 }))
            .expect("tail reads must be served natively, not declined");
        assert!(!tail.is_error, "content: {}", tail.content);
        assert!(
            tail.content.contains("2\tbeta") && tail.content.contains("3\tgamma"),
            "content: {}",
            tail.content
        );
        assert!(
            !tail.content.contains("1\talpha"),
            "content: {}",
            tail.content
        );

        // A tail larger than the file serves the whole file from line 1.
        let whole = ts
            .execute("Read", &json!({ "path": "a.txt", "line_offset": -100 }))
            .expect("oversized tail must clamp to the file start");
        assert!(
            whole.content.contains("1\talpha"),
            "content: {}",
            whole.content
        );
    }

    #[test]
    fn read_negative_offset_respects_n_lines_window() {
        let (dir, ts) = setup();
        let body: String = (1..=10).map(|i| format!("line{i}\n")).collect();
        std::fs::write(dir.path().join("ten.txt"), body).unwrap();
        // Last 3 lines, capped to 2 by n_lines: lines 8-9.
        let result = ts
            .execute(
                "Read",
                &json!({ "path": "ten.txt", "line_offset": -3, "n_lines": 2 }),
            )
            .expect("tail reads must be served natively");
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("8\tline8") && result.content.contains("9\tline9"),
            "content: {}",
            result.content
        );
        assert!(
            !result.content.contains("10\tline10"),
            "n_lines must cap the tail window: {}",
            result.content
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
        let result = ts
            .execute("Read", &json!({ "path": "wide.txt", "max_chars": 500_000 }))
            .unwrap();
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
    fn read_output_character_budget_reports_max_chars() {
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
        assert!(
            note.contains("Max 100000 characters reached."),
            "note: {note}"
        );
        assert!(note.contains("To resume reading, call Read with line_offset="));
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

    /// A 10MB single-line file is served natively: reads stream, so file size
    /// is no longer a constraint (the old READ_MAX_BYTES cap declined every
    /// large text file). Output is still bounded by the line renderer.
    #[test]
    fn read_large_single_line_file_is_served_natively() {
        let (_dir, ts) = setup();
        std::fs::write(
            _dir.path().join("big.txt"),
            vec![b'a'; 10 * 1024 * 1024 + 1],
        )
        .unwrap();
        let result = ts
            .execute("Read", &json!({ "path": "big.txt" }))
            .expect("large files stream; they are not declined");
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("1\t"),
            "content: {}",
            result.content
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

    #[test]
    fn glob_judges_vcs_exclusion_below_the_search_root_only() {
        let dir = tempfile::tempdir().unwrap();
        // The search root sits *under* a VCS-named directory. The exclusion must
        // judge only the path relative to the search root, or the `.hg` in the
        // root's own prefix would drop every result.
        let proj = dir.path().join(".hg").join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("keep.txt"), "hello\n").unwrap();
        let ts = NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();
        let result = ts
            .execute(
                "Glob",
                &json!({ "pattern": "**/*.txt", "path": ".hg/proj" }),
            )
            .unwrap();
        assert!(
            result.content.contains("keep.txt"),
            "a search root under a VCS-named dir must still yield results: {}",
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

    /// v2's sandbox defaults to `off`, so an out-of-workspace write is served
    /// in-process when no SandboxMode policy is wired; confinement belongs to
    /// `SandboxExecutionPolicy::sandbox_write_guard` at the callbacks layer.
    #[tokio::test]
    async fn write_outside_workspace_is_served_without_a_mode() {
        let (_dir, ts) = setup();
        let outside = tempfile::tempdir().unwrap();
        let escaped = outside.path().join("written.txt");
        let result = ts
            .execute_mutating(
                "Write",
                &json!({ "path": escaped.to_str().unwrap(), "content": "x" }),
            )
            .await
            .expect("with no SandboxMode policy writes are not confined");
        assert!(!result.is_error, "content: {}", result.content);
        assert!(escaped.exists());
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

    /// Same as the write case: with no SandboxMode policy wired, Bash runs
    /// with whatever cwd the caller passes — confinement is the
    /// `sandbox_code_execution_guard`'s job at the callbacks layer.
    #[tokio::test]
    async fn bash_cwd_outside_workspace_runs_without_a_mode() {
        let (_dir, ts) = setup();
        let outside = tempfile::tempdir().unwrap();
        let result = ts
            .execute_mutating(
                "Bash",
                &json!({ "command": "echo hi", "cwd": outside.path().to_str().unwrap() }),
            )
            .await
            .expect("with no SandboxMode policy the cwd is not confined");
        assert!(!result.is_error, "content: {}", result.content);
        assert!(result.content.contains("hi"), "content: {}", result.content);
    }

    /// Temporary benchmark: large inputs (20MB file / 300-file grep / 2000-file glob).
    #[test]
    fn bench_large_inputs() {
        use std::time::Instant;
        let dir = tempfile::tempdir().unwrap();
        let line = "the quick brown fox jumps over the lazy dog 0123456789\n";
        let big = dir.path().join("huge.txt");
        let mut content = String::with_capacity(line.len() * 500_000);
        for i in 0..500_000 {
            content.push_str(&format!("line {i}: {line}"));
        }
        std::fs::write(&big, &content).unwrap();
        println!("[large] file = {:.1} MB", content.len() as f64 / 1048576.0);
        let ts = NativeToolset::new(&dir.path().to_string_lossy(), None).unwrap();

        let show = |label: &str, r: Option<ExecutableToolResult>, t: std::time::Instant| match r {
            Some(res) => println!(
                "[large] {:28} {:6.1}ms  is_error={} len={}",
                label,
                t.elapsed().as_secs_f64() * 1000.0,
                res.is_error,
                res.content.len()
            ),
            None => println!("[large] {:28}  declined (None)", label),
        };

        let full = json!({ "path": big.to_string_lossy() });
        let t = Instant::now();
        let r = ts.execute("Read", &full);
        show("Read full 32MB", r, t);

        let deep = json!({ "path": big.to_string_lossy(), "line_offset": 400_000 });
        let t = Instant::now();
        let r = ts.execute("Read", &deep);
        show("Read offset@400k", r, t);

        for i in 0..300 {
            let p = dir.path().join(format!("g{i}.txt"));
            let body: String = (0..300)
                .map(|j| {
                    if j == 5 {
                        format!("needle {i}\n")
                    } else {
                        format!("fill {j}\n")
                    }
                })
                .collect();
            std::fs::write(&p, body).unwrap();
        }
        for i in 0..2000 {
            let p = dir.path().join(format!("w{i}.txt"));
            std::fs::write(&p, "x\n").unwrap();
        }
        let grep_arg = json!({ "pattern": "needle", "path": dir.path().to_string_lossy() });
        ts.execute("Grep", &grep_arg).unwrap();
        let t = Instant::now();
        let r = ts.execute("Grep", &grep_arg).unwrap();
        println!(
            "[large] Grep 300files/90k行 {:.1}ms (hits={})",
            t.elapsed().as_secs_f64() * 1000.0,
            r.content.matches("needle").count()
        );

        let glob_arg = json!({ "pattern": "w*.txt", "path": dir.path().to_string_lossy() });
        ts.execute("Glob", &glob_arg).unwrap();
        let t = Instant::now();
        ts.execute("Glob", &glob_arg).unwrap();
        println!(
            "[large] Glob 2000files      {:.1}ms",
            t.elapsed().as_secs_f64() * 1000.0
        );
    }

    /// Temporary benchmark: native basic-tool latency floor (10 runs each).
    #[test]
    fn bench_basic_tools_latency() {
        use std::time::Instant;
        let dir = tempfile::tempdir().unwrap();
        let mut file = dir.path().join("big.txt");
        let content: String = (0..1200)
            .map(|i| format!("line {i}: the quick brown fox jumps\n"))
            .collect::<Vec<_>>()
            .join("");
        std::fs::write(&file, &content).unwrap();
        for i in 0..5 {
            let p = dir.path().join(format!("m{i}.txt"));
            let _ = std::fs::write(&p, format!("needle {i}\nsecond line\n"));
        }
        let ts = NativeToolset::new(&dir.path().to_string_lossy(), None).unwrap();
        let read_arg = json!({ "path": file.to_string_lossy() });
        let grep_arg = json!({ "pattern": "needle", "path": dir.path().to_string_lossy() });
        let glob_arg = json!({ "pattern": "*.txt", "path": dir.path().to_string_lossy() });

        // warmup
        let _ = ts.execute("Read", &read_arg).unwrap();
        let _ = ts.execute("Grep", &grep_arg).unwrap();
        let _ = ts.execute("Glob", &glob_arg).unwrap();

        let t = Instant::now();
        for _ in 0..10 {
            ts.execute("Read", &read_arg).unwrap();
        }
        println!(
            "[tool-bench] Read        avg {:.2}ms",
            t.elapsed().as_secs_f64() * 1000.0 / 10.0
        );

        let t = Instant::now();
        for _ in 0..10 {
            ts.execute("Grep", &grep_arg).unwrap();
        }
        println!(
            "[tool-bench] Grep        avg {:.2}ms",
            t.elapsed().as_secs_f64() * 1000.0 / 10.0
        );

        let t = Instant::now();
        for _ in 0..10 {
            ts.execute("Glob", &glob_arg).unwrap();
        }
        println!(
            "[tool-bench] Glob        avg {:.2}ms",
            t.elapsed().as_secs_f64() * 1000.0 / 10.0
        );

        if let Some(bash) = find_bash() {
            let (_, _ts) = setup_with_shell(Some(&bash));
        }
        let _ = (&mut file,);
    }

    /// The six memory tools are wired into the dispatch table. A name the
    /// toolset does not handle returns `None` (the call is forwarded to a host
    /// that has no memory runtime), so `Some` here is the wiring assertion.
    /// Every arm is driven with a path outside the memory store, which is
    /// refused before any file is touched — a test never writes to the real
    /// memory root.
    #[tokio::test]
    async fn memory_tools_dispatch_through_the_toolset() {
        let (_dir, ts) = setup();
        let refused = [
            ("memory_read", json!({ "path": "../escape.md" })),
            (
                "memory_write",
                json!({ "path": "../escape.md", "content": "x", "if_version": "new" }),
            ),
            (
                "memory_str_replace",
                json!({
                    "path": "../escape.md",
                    "old_str": "a",
                    "new_str": "b",
                    "if_version": "new"
                }),
            ),
            (
                "memory_append",
                json!({ "path": "../escape.md", "content": "x", "if_version": "new" }),
            ),
            (
                "memory_delete",
                json!({ "path": "../escape.md", "if_version": "new" }),
            ),
        ];
        for (name, args) in refused {
            let result = ts
                .execute_tool(name, &args)
                .await
                .unwrap_or_else(|| panic!("{name} is not handled by the toolset"));
            assert!(result.is_error, "{name}: {}", result.content);
        }
        // `memory_list` is read-only, so it may succeed against the real root.
        assert!(
            ts.execute_tool("memory_list", &json!({})).await.is_some(),
            "memory_list is not handled by the toolset"
        );
        // The squashed twins reach the same arms.
        for name in [
            "MemoryRead",
            "MemoryWrite",
            "MemoryStrReplace",
            "MemoryAppend",
            "MemoryList",
            "MemoryDelete",
        ] {
            assert!(ts.handles(name), "{name} is not a native tool name");
        }
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
    fn panicking_tool(_sandbox: &Sandbox, _args: &Value) -> Option<ExecutableToolResult> {
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

    #[test]
    fn test_glob_finds_hidden_and_filters_vcs_and_sensitive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Create files in hidden folder
        let github_dir = root.join(".github").join("workflows");
        std::fs::create_dir_all(&github_dir).unwrap();
        std::fs::write(github_dir.join("ci.yml"), "name: CI").unwrap();

        // Create file in VCS folder (.git)
        let git_dir = root.join(".git").join("hooks");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("ci.yml"), "hook").unwrap();

        // Create sensitive file
        std::fs::write(root.join(".env"), "SECRET=123").unwrap();

        // Create normal file
        std::fs::write(root.join("hello.txt"), "world").unwrap();

        // Canonicalized the way `NativeToolset::new` canonicalizes the
        // workspace root: `resolve` compares canonical paths, so a raw
        // `dir.path()` would not match on Windows.
        let sandbox = Sandbox::new(std::fs::canonicalize(root).unwrap());

        // 1. Glob for ci.yml: should find .github/workflows/ci.yml, NOT .git/hooks/ci.yml
        let res = NativeToolset::glob(&sandbox, &json!({ "pattern": "**/ci.yml" })).unwrap();
        assert!(res.content.contains("ci.yml"));
        assert!(res.content.contains(".github"));
        assert!(!res.content.contains("hooks"));
        for line in res.content.lines() {
            assert!(!line.contains(".git/") && !line.contains(".git\\"));
        }

        // 2. Glob for sensitive file: should filter it out and report filtered
        let res = NativeToolset::glob(&sandbox, &json!({ "pattern": "**/.env" })).unwrap();
        assert!(
            res.content
                .contains("No non-sensitive matches found (1 sensitive file(s) filtered)")
        );

        // 3. Glob matching both normal and sensitive file:
        let res = NativeToolset::glob(&sandbox, &json!({ "pattern": "**/*" })).unwrap();
        assert!(res.content.contains("hello.txt"));
        assert!(res.content.contains("Filtered 1 sensitive file(s)."));
    }

    // ── Multi-root sandbox (`/add-dir` → `additionalDirs`) ──────────────

    /// A path outside `workspace_root` used to be unservable: the toolset
    /// declined it and the call went to the host `execute_tool` seam, which
    /// has no tool runtime. Authorized extra roots must be served natively.
    #[test]
    fn reads_are_not_path_gated() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("note.txt");
        std::fs::write(&outside_file, "hello from outside").unwrap();
        let arg = outside_file.to_string_lossy().into_owned();

        let ts = NativeToolset::new(&workspace.path().to_string_lossy(), None).unwrap();
        let result = ts
            .execute("read", &json!({ "path": arg }))
            .expect("reads must not be declined for lying outside the workspace");
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("hello from outside"),
            "content: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn test_native_bash_background_task_runner() {
        let Some(bash) = find_bash() else {
            return;
        };
        let (_dir, ts) = setup_with_shell(Some(&bash));
        let runner = std::sync::Arc::new(crate::storage::TaskRunner::new(None));
        let ts = ts.with_task_runner(runner.clone());

        let res = ts
            .bash_with(
                &json!({ "command": "echo 'bg hello'", "run_in_background": true, "description": "echo task" }),
                None,
            )
            .await
            .unwrap();

        assert!(!res.is_error);
        assert!(res.content.contains("Background task started"));
        assert!(res.content.contains("task_id:"));

        let line = res
            .content
            .lines()
            .find(|l| l.contains("task_id:"))
            .unwrap();
        let task_id = line
            .split("task_id: ")
            .nth(1)
            .unwrap()
            .trim()
            .trim_end_matches(['.', ')']);

        // 10s, not 2s: this wait races a real shell spawn, and on a loaded
        // machine (parallel builds, ConPTY tests spawning powershells) 2s
        // intermittently expired before the task finished — a flake, not a
        // regression. The happy path still returns in milliseconds.
        let wait_res = runner.wait(task_id, 10_000).await;
        assert!(matches!(
            wait_res,
            crate::storage::TaskWaitResult::Completed(_)
        ));
    }

    #[tokio::test]
    async fn workflow_tool_lists_without_a_subagent_runtime() {
        let (_dir, toolset) = setup();
        assert!(toolset.handles("Workflow"), "Workflow is a native tool");
        let result = toolset
            .execute_tool("Workflow", &serde_json::json!({ "operation": "list" }))
            .await
            .expect("Workflow is handled natively");
        assert!(!result.is_error, "{}", result.content);
        assert!(result.content.contains("deep-research"));

        let run = toolset
            .execute_tool(
                "Workflow",
                &serde_json::json!({ "operation": "run", "script": "return 1;" }),
            )
            .await
            .expect("Workflow is handled natively");
        assert!(run.is_error);
        assert!(run.content.contains("no subagent runtime"));
    }

    /// The mode-mutex dispatch wiring end to end: the real
    /// `execute_tool` arms (`EnterPlanMode` / `TowerInit`), the real
    /// `TowerSpawn` / `TowerMerge` gates, and a real git repository.
    /// Unit tests of the helpers live in `mode_mutex.rs`; this module covers
    /// the wiring those helpers are attached to.
    mod mode_mutex_dispatch {
        use std::path::Path;
        use std::process::Command;
        use std::sync::{Arc, Mutex as StdMutex};

        use serde_json::{Value, json};

        use crate::callbacks::HostCallbacks;
        use crate::rpc::types::{
            BoxFuture, LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision,
            StateReadRequest, StateReadResponse, StateWriteRequest, StateWriteResponse,
            ToolExecuteRequest, ToolExecuteResponse,
        };
        use crate::tools::NativeToolset;
        use crate::tools::tower::store::TowerStore;
        use crate::tools::tower::types::{TowerMissionStatus, TowerState};

        fn run_git(dir: &Path, args: &[&str]) {
            let output = Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "test")
                .env("GIT_AUTHOR_EMAIL", "test@example.test")
                .env("GIT_COMMITTER_NAME", "test")
                .env("GIT_COMMITTER_EMAIL", "test@example.test")
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        /// A real repository with one commit on `main`.
        fn init_repo() -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            run_git(dir.path(), &["init", "-b", "main"]);
            std::fs::write(dir.path().join("README.md"), "seed\n").unwrap();
            run_git(dir.path(), &["add", "."]);
            run_git(dir.path(), &["commit", "-m", "seed"]);
            dir
        }

        /// State-bridge host: plan reads answer `active`, writes are
        /// recorded.
        struct StateHost {
            plan_active: bool,
            writes: Arc<StdMutex<Vec<Value>>>,
        }

        impl HostCallbacks for StateHost {
            fn llm_chat(
                &self,
                _: LlmChatRequest,
            ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
                Box::pin(async { Err("not used".into()) })
            }

            fn execute_tool(
                &self,
                _: ToolExecuteRequest,
            ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
                Box::pin(async { Err("not used".into()) })
            }

            fn check_permission(
                &self,
                _: PermissionCheckRequest,
            ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
                Box::pin(async {
                    Ok(PermissionDecision {
                        decision: "allow".into(),
                        reason: None,
                    })
                })
            }

            fn emit_event(&self, _: Value) {}

            fn state_read(
                &self,
                _: StateReadRequest,
            ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
                let active = self.plan_active;
                Box::pin(async move {
                    Ok(StateReadResponse {
                        value: json!({ "active": active }),
                    })
                })
            }

            fn state_write(
                &self,
                request: StateWriteRequest,
            ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
                self.writes.lock().unwrap().push(request.value.clone());
                let value = request.value;
                Box::pin(async move { Ok(StateWriteResponse { ok: true, value }) })
            }
        }

        fn host(plan_active: bool) -> (Arc<dyn HostCallbacks>, Arc<StdMutex<Vec<Value>>>) {
            let writes = Arc::new(StdMutex::new(Vec::new()));
            (
                Arc::new(StateHost {
                    plan_active,
                    writes: writes.clone(),
                }),
                writes,
            )
        }

        /// A live tower with one open mission `M1`, planned through the real
        /// `TowerPlan` tool so the branch/worktree fields match production.
        async fn repo_with_open_mission(dir: &Path, toolset: &NativeToolset) {
            let init = toolset
                .execute_tool("TowerInit", &json!({}))
                .await
                .expect("TowerInit is native");
            assert!(!init.is_error, "{}", init.content);
            let plan = toolset
                .execute_tool(
                    "TowerPlan",
                    &json!({ "missions": [{ "title": "gate probe", "scope": ["probe/"] }] }),
                )
                .await
                .expect("TowerPlan is native");
            assert!(!plan.is_error, "{}", plan.content);
            let store = TowerStore::new(dir.to_path_buf());
            let state = store.load().await.unwrap();
            assert_eq!(state.missions.len(), 1);
            assert_eq!(state.missions[0].id, "M1");
        }

        fn status_of(state: &TowerState, id: &str) -> Option<TowerMissionStatus> {
            state.missions.iter().find(|m| m.id == id).map(|m| m.status)
        }

        /// The real bug this guards: entering plan mode through the toolset
        /// dispatch must pause open tower missions, with the pause visible in
        /// the persisted state (not just mentioned in the tool result).
        #[tokio::test]
        async fn enter_plan_mode_through_dispatch_pauses_open_tower_missions() {
            let dir = init_repo();
            let (callbacks, writes) = host(false);
            let toolset = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(callbacks);
            repo_with_open_mission(dir.path(), &toolset).await;

            let result = toolset
                .execute_tool("EnterPlanMode", &json!({}))
                .await
                .expect("EnterPlanMode is native");
            assert!(!result.is_error, "{}", result.content);
            assert!(
                result.content.contains("paused 1 open tower mission")
                    && result.content.contains("M1"),
                "{}",
                result.content
            );
            // The state bridge saw the plan activation.
            assert_eq!(writes.lock().unwrap().len(), 1);

            let state = TowerStore::new(dir.path().to_path_buf())
                .load()
                .await
                .unwrap();
            assert_eq!(status_of(&state, "M1"), Some(TowerMissionStatus::Paused));
        }

        /// TowerSpawn-worker on a paused mission must be refused by the real
        /// dispatch path (no worktree is created, no worker is spawned).
        #[tokio::test]
        async fn tower_spawn_worker_refuses_paused_mission() {
            let dir = init_repo();
            let (callbacks, _) = host(false);
            let toolset = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(callbacks);
            repo_with_open_mission(dir.path(), &toolset).await;

            // Pause M1 via the mutex (the same call the plan-enter arm makes).
            let paused =
                crate::tools::mode_mutex::pause_tower_for_mode_enter(dir.path(), "test").await;
            assert_eq!(paused, vec!["M1".to_string()]);

            let result = toolset
                .execute_tool(
                    "TowerSpawn",
                    &json!({ "name": "w1", "kind": "worker", "mission_id": "M1" }),
                )
                .await
                .expect("TowerSpawn is native");
            assert!(result.is_error, "{}", result.content);
            assert!(
                result.content.contains("paused") && result.content.contains("status=active"),
                "{}",
                result.content
            );
            // The refusal happens before the worktree is created.
            assert!(!dir.path().join(".tower/worktrees/wt-1").exists());
        }

        /// TowerMerge on a paused mission's branch must be refused even though
        /// every other gate (review, deps) would also matter — the mutex gate
        /// runs first and names the mission.
        #[tokio::test]
        async fn tower_merge_refuses_paused_mission_branch() {
            let dir = init_repo();
            let (callbacks, _) = host(false);
            let toolset = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(callbacks);
            repo_with_open_mission(dir.path(), &toolset).await;

            let state = TowerStore::new(dir.path().to_path_buf())
                .load()
                .await
                .unwrap();
            let branch = state.missions[0].branch.clone();

            let paused =
                crate::tools::mode_mutex::pause_tower_for_mode_enter(dir.path(), "test").await;
            assert_eq!(paused.len(), 1);

            let result = toolset
                .execute_tool("TowerMerge", &json!({ "branch": branch }))
                .await
                .expect("TowerMerge is native");
            assert!(result.is_error, "{}", result.content);
            assert!(
                result.content.contains("paused") && result.content.contains("M1"),
                "{}",
                result.content
            );
        }

        /// TowerInit while plan mode is active exits plan through the state
        /// bridge (main agent path), and the tool result says so.
        #[tokio::test]
        async fn tower_init_through_dispatch_exits_plan_mode() {
            let dir = init_repo();
            let (callbacks, writes) = host(true);
            let toolset = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(callbacks);

            let result = toolset
                .execute_tool("TowerInit", &json!({}))
                .await
                .expect("TowerInit is native");
            assert!(!result.is_error, "{}", result.content);
            assert!(
                result
                    .content
                    .contains("plan mode was active, so it was exited"),
                "{}",
                result.content
            );
            let writes = writes.lock().unwrap();
            assert_eq!(writes.len(), 1, "one plan deactivation write");
            assert_eq!(writes[0], json!({ "active": false }));
        }

        /// A subagent's EnterPlanMode (non-main caller) must not touch the
        /// main agent's tower (v2's modeMutex is Agent-scoped and
        /// `tower.isActive` is main-only).
        #[tokio::test]
        async fn subagent_enter_plan_does_not_pause_tower() {
            let dir = init_repo();
            // The tower is created by the main agent's toolset (TowerInit is
            // main-only); the subagent call runs through a second toolset.
            let (main_callbacks, _) = host(false);
            let main = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(main_callbacks);
            repo_with_open_mission(dir.path(), &main).await;

            let (sub_callbacks, _) = host(false);
            let subagent = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(sub_callbacks)
                .with_caller_agent_id("subagent-42");

            let result = subagent
                .execute_tool("EnterPlanMode", &json!({}))
                .await
                .expect("EnterPlanMode is native");
            assert!(!result.is_error, "{}", result.content);
            assert!(
                !result.content.contains("paused"),
                "a subagent plan entry must not pause main's tower: {}",
                result.content
            );
            let state = TowerStore::new(dir.path().to_path_buf())
                .load()
                .await
                .unwrap();
            assert_eq!(status_of(&state, "M1"), Some(TowerMissionStatus::Planned));
        }

        /// A subagent's TowerInit is refused (main-only) and must not exit
        /// main's plan mode as a side effect of the mutex arm running anyway.
        #[tokio::test]
        async fn subagent_tower_init_refused_and_plan_untouched() {
            let dir = init_repo();
            let (callbacks, writes) = host(true);
            let toolset = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(callbacks)
                .with_caller_agent_id("subagent-42");

            let result = toolset
                .execute_tool("TowerInit", &json!({}))
                .await
                .expect("TowerInit is native");
            assert!(result.is_error, "{}", result.content);
            assert!(
                writes.lock().unwrap().is_empty(),
                "a refused subagent init must not deactivate main's plan mode"
            );
        }

        /// A failed TowerInit (no git repo) must not exit plan mode: v2 exits
        /// plan on the entry event, and no tower mode was entered here.
        #[tokio::test]
        async fn failed_tower_init_does_not_exit_plan_mode() {
            let dir = tempfile::tempdir().unwrap();
            let (callbacks, writes) = host(true);
            let toolset = NativeToolset::new(dir.path().to_str().unwrap(), None)
                .unwrap()
                .with_callbacks(callbacks);

            let result = toolset
                .execute_tool("TowerInit", &json!({}))
                .await
                .expect("TowerInit is native");
            assert!(result.is_error, "{}", result.content);
            assert!(
                writes.lock().unwrap().is_empty(),
                "plan mode must survive a failed tower init"
            );
        }
    }
}
