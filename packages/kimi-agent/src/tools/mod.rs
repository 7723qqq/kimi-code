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
use std::time::{Duration, Instant};

use serde_json::Value;

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
const GREP_TIME_BUDGET: Duration = Duration::from_secs(20);
/// Largest file native Grep will pull into memory (matches the Read cap).
/// Bigger ones are skipped and reported as truncation rather than risking a
/// multi-gigabyte allocation per matching file.
const GREP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Cap on rendered Grep output bytes (host/addon MAX_OUTPUT_BYTES). The whole
/// result is built before paging, so context lines across thousands of files
/// would otherwise be materialised in full.
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
/// Cap on captured Bash output (matches the JS tool's truncation scale).
const BASH_MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub mod ask_user_question;
pub mod core_tool_defs;
pub mod create_goal;
pub mod cron_tools;
pub mod encoding;
pub mod exit_plan_mode;
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
pub mod web_search;

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
];

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
            "read" => self.read(args),
            "grep" => self.grep(args),
            "glob" => self.glob(args),
            "listdirectory" | "list_directory" => {
                list_directory::execute_list_directory(&self.root, args)
            }
            _ => None,
        }
    }

    /// Whether the sandbox knows how to execute this tool natively (subject
    /// to a host permission grant and sandbox confinement).
    pub fn handles(&self, tool_name: &str) -> bool {
        let lowered = tool_name.to_ascii_lowercase();
        NATIVE_TOOL_NAMES.contains(&lowered.as_str()) || github::is_github_tool(tool_name)
    }

    /// Execute a tool natively (async).
    pub async fn execute_tool(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> Option<ExecutableToolResult> {
        match tool_name.to_ascii_lowercase().as_str() {
            "read" => self.read(args),
            "grep" => self.grep(args),
            "glob" => self.glob(args),
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
            "knowledge" => Some(knowledge_tool::execute_knowledge(&self.root, args)),
            "write" => self.write(args),
            "edit" => self.edit(args),
            "bash" => self.bash(args).await,
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
            "write" => self.write(args),
            "edit" => self.edit(args),
            "bash" => self.bash(args).await,
            _ => None,
        }
    }

    /// Resolve a path argument inside the workspace. `None` when the path
    /// escapes the sandbox or does not exist.
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let candidate = self.candidate_path(path);
        let resolved = std::fs::canonicalize(&candidate).ok()?;
        resolved.starts_with(&self.root).then_some(resolved)
    }

    /// Like [`resolve`] but tolerates a not-yet-existing target: walks up to
    /// the nearest existing ancestor, canonicalizes it (resolving any
    /// symlink escapes), then rejoins the missing tail. `None` when the
    /// existing ancestor lies outside the sandbox.
    fn resolve_for_write(&self, path: &str) -> Option<PathBuf> {
        let candidate = self.candidate_path(path);
        if let Ok(resolved) = std::fs::canonicalize(&candidate) {
            return resolved.starts_with(&self.root).then_some(resolved);
        }
        let mut missing: Vec<std::ffi::OsString> = Vec::new();
        let mut cursor = candidate.as_path();
        loop {
            match std::fs::canonicalize(cursor) {
                Ok(existing) => {
                    if !existing.starts_with(&self.root) {
                        return None;
                    }
                    let mut resolved = existing;
                    for segment in missing.iter().rev() {
                        resolved = resolved.join(segment);
                    }
                    return resolved.starts_with(&self.root).then_some(resolved);
                }
                Err(_) => {
                    missing.push(cursor.file_name()?.to_os_string());
                    cursor = cursor.parent()?;
                }
            }
        }
    }

    fn candidate_path(&self, path: &str) -> PathBuf {
        if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        }
    }

    // ── Read ───────────────────────────────────────────────────────────

    fn read(&self, args: &Value) -> Option<ExecutableToolResult> {
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

        let resolved = self.resolve(path)?;
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
    /// summary, case-insensitive matching, and offset/head_limit paging.
    /// Unsupported args (`type`, `multiline`, `include_ignored`) fall back
    /// to the host, whose ripgrep pipeline owns those features.
    fn grep(&self, args: &Value) -> Option<ExecutableToolResult> {
        let pattern = args.get("pattern")?.as_str()?;
        if args.get("type").is_some_and(|t| !t.is_null()) {
            return None;
        }
        if args
            .get("multiline")
            .is_some_and(|v| v.as_bool() == Some(true))
        {
            return None;
        }
        if args
            .get("include_ignored")
            .is_some_and(|v| v.as_bool() == Some(true))
        {
            return None;
        }
        let case_insensitive = args.get("-i").and_then(|v| v.as_bool()).unwrap_or(false);
        let line_numbers = args.get("-n").and_then(|v| v.as_bool()).unwrap_or(true);
        let output_mode = args
            .get("output_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("files_with_matches");
        if !matches!(
            output_mode,
            "files_with_matches" | "content" | "count_matches"
        ) {
            return None;
        }
        let context_after = args.get("-A").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let context_before = args.get("-B").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let context_both = args.get("-C").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let context_after = context_after.max(context_both);
        let context_before = context_before.max(context_both);
        let head_limit = args
            .get("head_limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(GREP_HEAD_LIMIT as u64) as usize;
        let page_offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

        let mut builder = regex::RegexBuilder::new(pattern);
        builder.case_insensitive(case_insensitive);
        let regex = match builder.build() {
            Ok(r) => r,
            Err(e) => return Some(err_result(format!("invalid regex: {e}"))),
        };
        let glob_filter = match args.get("glob").and_then(|g| g.as_str()) {
            Some(g) => Some(build_glob(g)?),
            None => None,
        };

        let search_root = match args.get("path").and_then(|p| p.as_str()) {
            Some(p) => self.resolve(p)?,
            None => self.root.clone(),
        };

        struct FileMatches {
            display: String,
            mtime: std::time::SystemTime,
            /// `(is_match, lineno, line)` per line of the file, in order.
            lines: Vec<(bool, usize, String)>,
            total_matches: usize,
        }

        let started = Instant::now();
        let mut per_file: Vec<FileMatches> = Vec::new();
        let mut filtered_sensitive: Vec<String> = Vec::new();
        let mut timed_out = false;
        let mut file_cap_truncated = false;

        // The host Grep searches hidden files (--hidden) and then filters
        // sensitive ones — mirror both, or .env-style content leaks. VCS
        // metadata directories are excluded like the host's `--glob !.git`
        // family.
        let walker = ignore::WalkBuilder::new(&search_root).hidden(false).build();
        for entry in walker.flatten() {
            if started.elapsed() > GREP_TIME_BUDGET {
                timed_out = true;
                break;
            }
            if per_file.len() >= GREP_MAX_FILES {
                file_cap_truncated = true;
                break;
            }
            let path = entry.path();
            if path.components().any(|c| {
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
            if let Some(ref gs) = glob_filter
                && !gs.is_match(path)
            {
                continue;
            }
            // Mirror the host Grep tool: matches inside sensitive files
            // (.env, keys, credentials, ...) are never reported.
            if is_sensitive_file(&path.to_string_lossy()) {
                let display = path.strip_prefix(&self.root).unwrap_or(path);
                filtered_sensitive.push(display.display().to_string());
                continue;
            }
            // Check the size before reading: every matching file's content
            // is held in memory until the result is rendered.
            let Ok(metadata) = std::fs::metadata(path) else {
                continue;
            };
            if metadata.len() > GREP_MAX_FILE_BYTES {
                file_cap_truncated = true;
                continue;
            }
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            if bytes.contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let mut lines: Vec<(bool, usize, String)> = Vec::new();
            let mut total_matches = 0usize;
            for (lineno, line) in text.lines().enumerate() {
                let trimmed = line.strip_suffix('\r').unwrap_or(line);
                // Occurrences per line, like rg --count-matches (the host
                // summary sums these, not matching lines).
                let matches_in_line = regex.find_iter(trimmed).count();
                if matches_in_line > 0 {
                    total_matches += matches_in_line;
                }
                lines.push((matches_in_line > 0, lineno + 1, trimmed.to_string()));
            }
            if total_matches == 0 {
                continue;
            }
            let display = path.strip_prefix(&self.root).unwrap_or(path);
            per_file.push(FileMatches {
                display: display.display().to_string(),
                mtime: std::fs::metadata(path)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                lines,
                total_matches,
            });
        }

        // files_with_matches: most-recently-modified first (host ordering).
        if output_mode == "files_with_matches" {
            per_file.sort_by_key(|f| std::cmp::Reverse(f.mtime));
        }

        // Rendered output lines, then offset/head_limit paging (host order).
        let mut rendered: Vec<String> = Vec::new();
        match output_mode {
            "files_with_matches" => {
                for file in &per_file {
                    rendered.push(file.display.clone());
                }
            }
            "count_matches" => {
                for file in &per_file {
                    rendered.push(format!("{}:{}", file.display, file.total_matches));
                }
            }
            _ => {
                for file in &per_file {
                    // Merged context windows: matching lines with `-A`/`-B`
                    // context, clusters separated by `--` like rg.
                    let mut last_rendered: Option<usize> = None;
                    for (idx, (is_match, _, _)) in file.lines.iter().enumerate() {
                        if !*is_match {
                            continue;
                        }
                        let lo = idx.saturating_sub(context_before);
                        let hi = (idx + context_after).min(file.lines.len() - 1);
                        if let Some(lr) = last_rendered
                            && lo > lr + 1
                        {
                            rendered.push("--".into());
                            last_rendered = None;
                        }
                        let start = last_rendered.map_or(lo, |lr| (lr + 1).max(lo));
                        for (offset_in_window, (is_match, lineno, line)) in
                            file.lines[start..=hi].iter().enumerate()
                        {
                            let absolute = start + offset_in_window;
                            if last_rendered.is_some() && absolute <= last_rendered.unwrap() {
                                continue;
                            }
                            let sep = if *is_match { ':' } else { '-' };
                            if line_numbers {
                                rendered.push(format!(
                                    "{}{}{}{}{}",
                                    file.display, sep, lineno, sep, line
                                ));
                            } else {
                                rendered.push(format!("{}{}{}", file.display, sep, line));
                            }
                            last_rendered = Some(absolute);
                        }
                    }
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

    fn glob(&self, args: &Value) -> Option<ExecutableToolResult> {
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
            Some(p) => self.resolve(p)?,
            None => self.root.clone(),
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
                let display = path.strip_prefix(&self.root).unwrap_or(path);
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

    fn write(&self, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let content = args.get("content")?.as_str()?;
        let mode = match args.get("mode") {
            None | Some(Value::Null) => "overwrite",
            Some(v) => v.as_str()?,
        };
        let resolved = self.resolve_for_write(path)?;
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

    fn edit(&self, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let old = args.get("old_string")?.as_str()?;
        let new = args.get("new_string")?.as_str()?;
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let resolved = self.resolve_for_write(path)?;

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
        let display = resolved
            .strip_prefix(&self.root)
            .unwrap_or(&resolved)
            .display();
        Some(ok_result(format!("Edited {display}")))
    }

    // ── Bash ───────────────────────────────────────────────────────────

    async fn bash(&self, args: &Value) -> Option<ExecutableToolResult> {
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
            Some(cwd) => self.resolve(cwd)?,
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
        let waited = tokio::time::timeout(timeout, async {
            let (out, err, status) = tokio::join!(
                async {
                    let mut buf = Vec::new();
                    if let Some(pipe) = stdout_pipe.as_mut() {
                        let _ = pipe.read_to_end(&mut buf).await;
                    }
                    buf
                },
                async {
                    let mut buf = Vec::new();
                    if let Some(pipe) = stderr_pipe.as_mut() {
                        let _ = pipe.read_to_end(&mut buf).await;
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

    #[test]
    fn grep_with_type_filter_falls_back() {
        let (_dir, ts) = setup();
        assert!(
            ts.execute("Grep", &json!({ "pattern": "x", "type": "rust" }))
                .is_none()
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
}
