//! Local Permission Engine for Kimi Agent (P26 批 3).
//!
//! Evaluates tool execution permissions locally in Rust based on a
//! `PolicySnapshot` injected from the host per turn.
//!
//! Mirrors the 13-policy chain in `agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts`
//! including v2's DangerousCommandAsk mode gating (skipped under auto, and its
//! `[permission] dangerousCommandGuard` off-switch):
//!   1. AutoModeAskUserQuestionDeny
//!   2. UserConfiguredDeny
//!   3. DangerousCommandAsk (skipped in auto; a *dangerous* command asks in
//!      manual and yolo alike, an *unanalyzable* one asks except in yolo;
//!      headless sessions and `dangerousCommandGuard: false` skip the policy)
//!   4. AutoModeApprove
//!   5. SessionApprovalHistory
//!   6. UserConfiguredAsk
//!   7. UserConfiguredAllow
//!   8. SensitiveFileAccessAsk
//!   9. GitControlPathAccessAsk
//!  10. YoloModeApprove
//!  11. DefaultToolApprove (Read-only tools)
//!  12. GitCwdWriteApprove
//!  13. FallbackAsk

use globset::{Glob, GlobBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::RwLock;

use crate::i18n::{LocalizedText, i18n_params};
use crate::native::permission_engine::dangerous_command::{DangerousVerdict, analyze_bash_command};

/// The tools that run without an approval prompt in every permission mode
/// (v2 `DEFAULT_APPROVE_TOOLS`, `default-tool-approve.ts`). Both spellings of
/// each multi-word name are listed because [`PermissionEngine::evaluate`]
/// lowercases without squashing underscores, so `ReadMediaFile` and
/// `read_media_file` are different keys. The fork's own read-only extras —
/// `ListDirectory` (v2 folds directory listing into `Glob`) plus `Lsp`, the
/// memory readers and the tower readers — are appended for the same reason
/// their absence prompted: a natively executed read must not fall through to
/// `FallbackAsk`.
const DEFAULT_APPROVE_TOOLS: &[&str] = &[
    "read",
    "grep",
    "glob",
    "readmediafile",
    "read_media_file",
    "settodolist",
    "set_todo_list",
    "todolist",
    "todo_list",
    "tasklist",
    "task_list",
    "taskoutput",
    "task_output",
    "waitfor",
    "wait_for",
    "cronlist",
    "cron_list",
    "websearch",
    "web_search",
    "fetchurl",
    "fetch_url",
    "agent",
    "agentswarm",
    "agent_swarm",
    "askuserquestion",
    "ask_user_question",
    "notifyuser",
    "notify_user",
    "skill",
    "enterplanmode",
    "enter_plan_mode",
    "exitplanmode",
    "exit_plan_mode",
    "creategoal",
    "create_goal",
    "getgoal",
    "get_goal",
    "setgoalbudget",
    "set_goal_budget",
    "updategoal",
    "update_goal",
    "select_tools",
    "listdirectory",
    "list_directory",
    // Read-only tools v2's list cannot name (they do not exist upstream) but
    // which execute natively here. Leaving them out sent a pure read to
    // `FallbackAsk`, so a read-only call prompted in every non-Yolo mode —
    // the same drift `ListDirectory` above already documents.
    "lsp",
    "memoryread",
    "memory_read",
    "memorylist",
    "memory_list",
    "towerstatus",
    "tower_status",
    "towerinbox",
    "tower_inbox",
];

/// Permission mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    #[default]
    Manual,
    Auto,
    Yolo,
    /// Any mode the engine does not model (v2's `PermissionMode` is only
    /// `manual | yolo | auto`; a host that invents a fourth one — it once sent
    /// `plan` this way — lands here). Tolerant deserialization prevents an
    /// unknown mode from silently dropping the whole policy snapshot (hooks +
    /// rules) at the napi boundary: the permission chain still sees an explicit
    /// mode value, just one it treats as the manual default.
    #[serde(other)]
    Unknown,
}

/// A user-configured external hook (v2 `HookDefSchema`): an event name, an
/// optional regex `matcher` (empty = match all), the command to run, an
/// optional timeout in seconds (1-600, default 30), an optional working
/// directory, and optional extra environment variables (merged over the
/// inherited environment).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookDef {
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub matcher: String,
    pub command: String,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
}

/// Snapshot of permission configuration passed from host at step boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicySnapshot {
    #[serde(default)]
    pub mode: PermissionMode,
    #[serde(default)]
    pub deny_rules: Vec<String>,
    #[serde(default)]
    pub ask_rules: Vec<String>,
    #[serde(default)]
    pub allow_rules: Vec<String>,
    #[serde(default)]
    pub session_approvals: Vec<String>,
    #[serde(default)]
    pub git_cwd: Option<String>,
    /// The user's global `[tools]` switch (v2 `tools.enabled` /
    /// `tools.disabled`), resolved by the host from `config.toml`. The engine
    /// intersects it with the advertised tool table and enforces it again
    /// before executing a native call.
    #[serde(default)]
    pub tools_filter: Option<crate::tools::tool_policy::ToolsFilter>,
    /// User-configured external hooks (v2 `[hooks]`). The engine executes
    /// the `PreToolUse` ones before native tool calls (G-6 #6), notifies
    /// the observe-only `PostToolUse` / `PostToolUseFailure` /
    /// `UserPromptSubmit` / `PreCompact` events fire-and-forget, and lets
    /// matching `Stop` hooks veto a clean text stop once per turn.
    #[serde(default)]
    pub pre_tool_hooks: Vec<HookDef>,
    /// Why each configured rule exists, keyed by its pattern (v2
    /// `permission.rules[].reason`): echoed in the denial so a refusal can
    /// explain itself. Absent entries fall back to the pattern alone.
    #[serde(default)]
    pub rule_reasons: std::collections::HashMap<String, String>,
    /// Headless session signal (upstream bootstrap `nonInteractive`, set by
    /// `kimi -p`): a run with no human to answer an `ask` verdict skips the
    /// `DangerousCommandAsk` policy (v2 `permissionPolicyService.ts` drops it
    /// from the chain), so the remaining policies decide the command.
    #[serde(default)]
    pub non_interactive: bool,
    /// `[permission] dangerousCommandGuard` (v2
    /// `isDangerousCommandGuardEnabled`, default true): `false` disables the
    /// whole DangerousCommandAsk policy, letting the remaining policies
    /// decide every Bash call.
    #[serde(default = "crate::permission::default_true")]
    pub dangerous_command_guard: bool,
}

/// `Default` for [`PolicySnapshot`]: the guard is on unless the config
/// explicitly turns it off — matching the serde default and v2's `?? true`.
/// Handwritten (not derived) because a derived `bool` default is `false`.
impl Default for PolicySnapshot {
    fn default() -> Self {
        Self {
            mode: PermissionMode::default(),
            deny_rules: Vec::new(),
            ask_rules: Vec::new(),
            allow_rules: Vec::new(),
            session_approvals: Vec::new(),
            git_cwd: None,
            tools_filter: None,
            pre_tool_hooks: Vec::new(),
            rule_reasons: std::collections::HashMap::new(),
            non_interactive: false,
            dangerous_command_guard: true,
        }
    }
}

/// Serde default for [`PolicySnapshot::dangerous_command_guard`] — the guard
/// is on unless the config explicitly turns it off (v2's `?? true`).
fn default_true() -> bool {
    true
}

/// Verdict returned by the local permission engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalPermissionVerdict {
    pub decision: VerdictDecision,
    pub policy_name: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerdictDecision {
    Allow,
    Deny,
    Ask,
}

impl LocalPermissionVerdict {
    pub fn is_allow(&self) -> bool {
        self.decision == VerdictDecision::Allow
    }
}

/// Parsed permission rule pattern: `ToolName` or `ToolName(argPattern)`.
#[derive(Debug, Clone)]
pub struct ParsedRule {
    pub tool_name: String,
    pub arg_pattern: Option<String>,
}

/// Whether an argument pattern is negated — v2 `matchRuleSubjects` strips a
/// leading `!` and inverts the result (`Bash(!rm *)` matches every command
/// except the ones the inner pattern matches).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Negation {
    Positive,
    Negated,
}

pub fn parse_permission_pattern(pattern: &str) -> Option<ParsedRule> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return None;
    }

    let Some(open_idx) = trimmed.find('(') else {
        if trimmed.contains(')') {
            return None;
        }
        return Some(ParsedRule {
            tool_name: trimmed.to_string(),
            arg_pattern: None,
        });
    };

    if !trimmed.ends_with(')') {
        return None;
    }

    let tool_name = trimmed[..open_idx].trim().to_string();
    let arg = trimmed[open_idx + 1..trimmed.len() - 1].trim();

    if tool_name.is_empty() {
        return None;
    }

    Some(ParsedRule {
        tool_name,
        arg_pattern: if arg.is_empty() {
            None
        } else {
            Some(arg.to_string())
        },
    })
}

/// Precompiled permission rule for zero-allocation fast-path evaluation.
///
/// Mirrors v2 `matchPermissionRule` (`permissionRules/matchesRule.ts`):
/// the tool name is a glob, `*` matches every tool, and the argument pattern
/// is matched by the tool-specific strategy — here approximated by a
/// case-insensitive glob with `./` stripping (v2 `pathGlobMatch` with its
/// default `caseInsensitivePaths: true`) plus `!` negation.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub raw_rule: String,
    tool_glob: Option<globset::GlobMatcher>,
    arg_glob: Option<globset::GlobMatcher>,
    negation: Negation,
}

impl CompiledRule {
    pub fn compile(raw_rule: &str) -> Option<Self> {
        let parsed = parse_permission_pattern(raw_rule)?;
        let tool_glob = if parsed.tool_name == "*" {
            None
        } else {
            Some(compile_tool_glob(&parsed.tool_name)?)
        };
        let (arg_glob, negation) = match parsed.arg_pattern {
            None => (None, Negation::Positive),
            Some(ref pat) => {
                let (pattern, negation) = match pat.strip_prefix('!') {
                    Some(rest) => (rest, Negation::Negated),
                    None => (pat.as_str(), Negation::Positive),
                };
                (Some(compile_subject_glob(pattern)?), negation)
            }
        };
        Some(Self {
            raw_rule: raw_rule.to_string(),
            tool_glob,
            arg_glob,
            negation,
        })
    }

    #[inline]
    pub fn matches(&self, tool_name: &str, subject: Option<&str>) -> bool {
        if let Some(matcher) = &self.tool_glob
            && !matcher.is_match(tool_name.to_ascii_lowercase())
        {
            return false;
        }
        let hit = match (&self.arg_glob, subject) {
            (None, _) => true,
            (Some(matcher), Some(subj)) => {
                matcher.is_match(subj) || matcher.is_match(strip_leading_dot_slash(subj))
            }
            (Some(_), None) => false,
        };
        match self.negation {
            Negation::Positive => hit,
            Negation::Negated => !hit,
        }
    }
}

/// v2 `stripLeadingDotSlash` (`tool/rule-match.ts`): `./src/lib.rs` and
/// `src/lib.rs` are the same target for rule matching.
fn strip_leading_dot_slash(value: &str) -> &str {
    value.strip_prefix("./").unwrap_or(value)
}

/// Compile a glob the way v2 compiles rule patterns: `pathGlobMatch` defaults
/// `caseInsensitivePaths` to true, so a rule matches a differently-cased
/// subject on any platform.
fn compile_subject_glob(pattern: &str) -> Option<globset::GlobMatcher> {
    // `*` stays cross-directory, like picomatch's default in v2, so `*.rs`
    // matches `src/main.rs` in a rule and `rm -rf *` matches `rm -rf /`.
    GlobBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .ok()
        .map(|glob| glob.compile_matcher())
}

/// Compile a tool-name glob (v2 `picomatch.isMatch(toolName, parsed.toolName)`).
fn compile_tool_glob(tool_name: &str) -> Option<globset::GlobMatcher> {
    Glob::new(&tool_name.to_ascii_lowercase())
        .ok()
        .map(|glob| glob.compile_matcher())
}

/// Local permission engine evaluating tool calls against a `PolicySnapshot`.
///
/// The mode is interior-mutable ([`PermissionEngine::set_mode`]) so an
/// interactive entry can switch it live — the REPL's `/yolo`, which previously
/// only mutated config for the next restart (the M1a limitation). Everything
/// else about the snapshot (rules, hooks) stays fixed; hosts that need a
/// different rule set rebuild the engine instead.
pub struct PermissionEngine {
    snapshot: PolicySnapshot,
    mode: RwLock<PermissionMode>,
    compiled_deny: Vec<CompiledRule>,
    compiled_ask: Vec<CompiledRule>,
    compiled_allow: Vec<CompiledRule>,
    compiled_session: Vec<CompiledRule>,
    /// The session workspace root (v2 `ISessionWorkspaceContext.workDir`) and
    /// the host-authorized `additionalDirs` — `GitCwdWriteApprove`'s
    /// containment gate. Empty for an engine built without them; that policy
    /// then falls back to the snapshot's `git_cwd` alone.
    workspace_root: Option<String>,
    additional_dirs: Vec<String>,
}

impl PermissionEngine {
    pub fn new(snapshot: PolicySnapshot) -> Self {
        Self::with_workspace(snapshot, None, Vec::new())
    }

    /// Build with the host's workspace roots: `workspace_root` is the session
    /// workDir and `additional_dirs` the `/add-dir` list (`PipelineSpec`'s
    /// `workspace_root` / `extra_roots`). `GitCwdWriteApprove` is the only
    /// policy that reads them; without them it falls back to
    /// [`PolicySnapshot::git_cwd`], which the host sets to the same workDir.
    pub fn with_workspace(
        snapshot: PolicySnapshot,
        workspace_root: Option<String>,
        additional_dirs: Vec<String>,
    ) -> Self {
        let compiled_deny = snapshot
            .deny_rules
            .iter()
            .filter_map(|r| CompiledRule::compile(r))
            .collect();
        let compiled_ask = snapshot
            .ask_rules
            .iter()
            .filter_map(|r| CompiledRule::compile(r))
            .collect();
        let compiled_allow = snapshot
            .allow_rules
            .iter()
            .filter_map(|r| CompiledRule::compile(r))
            .collect();
        let compiled_session = snapshot
            .session_approvals
            .iter()
            .filter_map(|r| CompiledRule::compile(r))
            .collect();

        let mode = snapshot.mode;
        Self {
            snapshot,
            mode: RwLock::new(mode),
            compiled_deny,
            compiled_ask,
            compiled_allow,
            compiled_session,
            workspace_root,
            additional_dirs,
        }
    }

    /// Evaluate permission for a tool call.
    /// The permission mode of the snapshot (G-6 #7: the goal-start review
    /// gate reads it to decide whether CreateGoal routes to the host).
    pub fn mode(&self) -> PermissionMode {
        *self.mode.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Switch the permission mode live. The REPL's `/yolo` and `/permission`
    /// use this instead of asking the user to restart; every subsequent
    /// [`PermissionEngine::evaluate`] sees the new mode at its own chain arm.
    pub fn set_mode(&self, mode: PermissionMode) {
        *self.mode.write().unwrap_or_else(|e| e.into_inner()) = mode;
    }

    /// The workspace cwd `GitCwdWriteApprove` resolves against — v2's
    /// `ISessionWorkspaceContext.workDir`, which both `git-cwd-write-approve.ts`
    /// and its `findWorkTree(cwd)` gate read. The host-set `workspace_root`
    /// wins; the stdio entry carries only the snapshot's `git_cwd`, which the
    /// host sets to the same directory. An empty value is no cwd at all (v2's
    /// `cwd.length === 0` early return).
    fn workspace_dir(&self) -> Option<&str> {
        self.workspace_root
            .as_deref()
            .or(self.snapshot.git_cwd.as_deref())
            .filter(|dir| !dir.is_empty())
    }

    pub fn evaluate(&self, tool_name: &str, args: &Value) -> LocalPermissionVerdict {
        let tool_lower = tool_name.to_ascii_lowercase();
        let target_subject = extract_rule_subject(&tool_lower, args);
        let file_access = file_accesses(&tool_lower, args);

        // 1. AutoModeAskUserQuestionDeny
        if self.mode() == PermissionMode::Auto
            && matches!(tool_lower.as_str(), "askuserquestion" | "ask_user_question")
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Deny,
                policy_name: "AutoModeAskUserQuestionDeny".into(),
                reason: Some(
                    LocalizedText::plain(
                        "engine.permission.autoModeCannotAsk",
                        "Auto mode cannot ask interactive questions",
                    )
                    .render(),
                ),
            };
        }

        // 2. UserConfiguredDeny
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_deny, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Deny,
                policy_name: "UserConfiguredDeny".into(),
                // A declared reason explains the refusal (v2 `reason`).
                reason: Some(
                    match self
                        .snapshot
                        .rule_reasons
                        .get(rule.as_str())
                        .map(String::as_str)
                        .filter(|r| !r.trim().is_empty())
                    {
                        Some(why) => LocalizedText::fmt(
                            "engine.permission.deniedByUserRule",
                            format!("Denied by user rule: {rule}: {why}"),
                            i18n_params!["rule" => rule, "why" => why],
                        )
                        .render(),
                        None => LocalizedText::fmt(
                            "engine.permission.deniedByUserRuleNoWhy",
                            format!("Denied by user rule: {rule}"),
                            i18n_params!["rule" => rule],
                        )
                        .render(),
                    },
                ),
            };
        }

        // 3. DangerousCommandAsk (v2 `dangerous-command-ask.ts`, under
        //    `agent/permissionPolicy/policies/`). Mode gating
        //    mirrors v2 exactly, in v2's own order: the whole policy is skipped
        //    in auto (`if (mode === 'auto') return undefined` comes *before* the
        //    verdict), a **dangerous** command asks in every mode that reaches
        //    this point — yolo included — and an **unanalyzable** one asks
        //    except in yolo (v2 #3869's late `if (mode === 'yolo') return
        //    undefined`). Skipped for headless sessions (`non_interactive`,
        //    upstream `permissionPolicyService.ts` drops this ask-policy when
        //    the host cannot answer a prompt), and for
        //    `[permission] dangerousCommandGuard: false` (v2
        //    `isDangerousCommandGuardEnabled`).
        if !self.snapshot.non_interactive
            && self.snapshot.dangerous_command_guard
            && self.mode() != PermissionMode::Auto
            && tool_lower == "bash"
            && let Some(command) = target_subject.as_deref()
        {
            match analyze_bash_command(command) {
                // yolo is not an exemption for a *known* dangerous command:
                // v2 asks for it before the yolo early-return exists.
                DangerousVerdict::Dangerous(_) => {
                    return LocalPermissionVerdict {
                        decision: VerdictDecision::Ask,
                        policy_name: "DangerousCommandAsk".into(),
                        reason: Some(
                            LocalizedText::plain(
                                "engine.permission.highRiskShellCommand",
                                "High-risk shell command requires approval",
                            )
                            .render(),
                        ),
                    };
                }
                DangerousVerdict::Unanalyzable(_) if self.mode() != PermissionMode::Yolo => {
                    return LocalPermissionVerdict {
                        decision: VerdictDecision::Ask,
                        policy_name: "DangerousCommandAsk".into(),
                        reason: Some(
                            LocalizedText::plain(
                                "engine.permission.shellCommandUnanalyzable",
                                "Shell command could not be statically analyzed",
                            )
                            .render(),
                        ),
                    };
                }
                _ => {}
            }
        }

        // 4. AutoModeApprove
        if self.mode() == PermissionMode::Auto {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "AutoModeApprove".into(),
                reason: None,
            };
        }

        // 5. SessionApprovalHistory
        if let Some(rule) = Self::matches_any_rule(
            &self.compiled_session,
            &tool_lower,
            target_subject.as_deref(),
        ) {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "SessionApprovalHistory".into(),
                reason: Some(
                    LocalizedText::fmt(
                        "engine.permission.approvedBySessionHistory",
                        format!("Approved by session history rule: {rule}"),
                        i18n_params!["rule" => rule],
                    )
                    .render(),
                ),
            };
        }

        // 6. UserConfiguredAsk
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_ask, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "UserConfiguredAsk".into(),
                reason: Some(
                    LocalizedText::fmt(
                        "engine.permission.approvalRequiredByUserRule",
                        format!("Approval required by user rule: {rule}"),
                        i18n_params!["rule" => rule],
                    )
                    .render(),
                ),
            };
        }

        // 7. UserConfiguredAllow
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_allow, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "UserConfiguredAllow".into(),
                reason: Some(
                    LocalizedText::fmt(
                        "engine.permission.allowedByUserRule",
                        format!("Allowed by user rule: {rule}"),
                        i18n_params!["rule" => rule],
                    )
                    .render(),
                ),
            };
        }

        // 8. SensitiveFileAccessAsk
        if let Some(path) = file_access
            .iter()
            .find(|path| crate::native::file_type::is_sensitive_file(path))
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "SensitiveFileAccessAsk".into(),
                reason: Some(
                    LocalizedText::fmt(
                        "engine.permission.sensitiveFileAccess",
                        format!("Access to sensitive file requires approval: {path}"),
                        i18n_params!["path" => path],
                    )
                    .render(),
                ),
            };
        }

        // 9. GitControlPathAccessAsk
        if let Some(path) = file_access.iter().find(|path| is_git_control_path(path)) {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "GitControlPathAccessAsk".into(),
                reason: Some(
                    LocalizedText::fmt(
                        "engine.permission.gitControlPathAccess",
                        format!("Access to git control path requires approval: {path}"),
                        i18n_params!["path" => path],
                    )
                    .render(),
                ),
            };
        }

        // 10. YoloModeApprove
        if self.mode() == PermissionMode::Yolo {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "YoloModeApprove".into(),
                reason: None,
            };
        }

        // 11. DefaultToolApprove (v2 `DEFAULT_APPROVE_TOOLS`,
        //     default-tool-approve.ts): the tools that run without an approval
        //     prompt in every permission mode. The fork's list had drifted to
        //     the read-only file tools alone, so TodoList, the plan tools, the
        //     goal tools, Agent / Skill and the task readers all fell through
        //     to `FallbackAsk` — a prompt v2 never shows. Both spellings are
        //     listed because `evaluate` lowercases without squashing
        //     underscores, so `ReadMediaFile` and `read_media_file` differ.
        if DEFAULT_APPROVE_TOOLS.contains(&tool_lower.as_str())
            || crate::tools::github::is_readonly_tool(tool_name)
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "DefaultToolApprove".into(),
                reason: None,
            };
        }

        // 12. GitCwdWriteApprove (v2 `git-cwd-write-approve.ts`): a Write / Edit
        //     whose target lands inside the workspace runs without a prompt.
        //     v2's gates, all of them: the Write/Edit tool pair, `pathClass ===
        //     'posix'`, the target inside `{workspaceDir, additionalDirs}`, and
        //     the workspace cwd inside a git work tree. The engine has no
        //     path-class handshake, so the *workspace root's* flavour stands in
        //     for the runtime's class ([`is_posix_path`]): a win32 workspace — a
        //     local Windows session — never approves here, which is exactly what
        //     v2's `pathClass !== 'posix'` early return does, while a posix
        //     workspace (Linux/macOS, or a remote posix runtime) proceeds. The
        //     containment is component-wise ([`is_within_workspace`]), so
        //     `/repo2/x` is not inside `/repo` as the fork's prefix test read
        //     it, and the cwd must sit in a work tree ([`find_git_work_tree`],
        //     v2's `findWorkTree(cwd)`). The fork's earlier "any tool, any
        //     platform, any path under a prefix" breadth was a deviation and is
        //     gone.
        if matches!(tool_lower.as_str(), "write" | "edit")
            && let Some(path) = target_subject.as_deref()
            && let Some(dir) = self.workspace_dir()
            && is_posix_path(dir)
            && is_posix_path(path)
            && !is_git_control_path(path)
            && !crate::native::file_type::is_sensitive_file(path)
            && is_within_workspace(path, dir, &self.additional_dirs)
            && find_git_work_tree(dir).is_some()
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "GitCwdWriteApprove".into(),
                reason: None,
            };
        }

        // 13. FallbackAsk
        LocalPermissionVerdict {
            decision: VerdictDecision::Ask,
            policy_name: "FallbackAsk".into(),
            reason: Some(
                LocalizedText::fmt(
                    "engine.permission.toolExecutionRequiresApproval",
                    format!("Tool execution requires approval: {tool_name}"),
                    i18n_params!["tool_name" => tool_name],
                )
                .render(),
            ),
        }
    }

    #[inline]
    fn matches_any_rule(
        rules: &[CompiledRule],
        tool_lower: &str,
        subject: Option<&str>,
    ) -> Option<String> {
        for rule in rules {
            if rule.matches(tool_lower, subject) {
                return Some(rule.raw_rule.clone());
            }
        }
        None
    }
}

/// The file paths a call touches — v2's `fileAccesses(context)`, the input
/// `SensitiveFileAccessAsk` (#8) and `GitControlPathAccessAsk` (#9) evaluate.
///
/// v2 derives them from each tool's *declared* accesses, so a tool that
/// declares none never reaches those two policies: `bashTool.ts` exposes only
/// `approvalRule` / `matchesRule` / `execute`, and WebSearch / FetchURL take a
/// query and a URL. Feeding a Bash *command* or a search *query* to those
/// policies instead made any command that merely mentioned `/x/.env` or
/// `/repo/.git/config` prompt — in yolo too, where #8/#9 run before
/// `YoloModeApprove`.
///
/// So only tools whose `path` argument names a file contribute here. The list
/// is the path-shaped half of [`extract_rule_subject`]; `memory_read` accepts
/// an array of paths, and v2 checks every declared access, so this returns all
/// of them.
fn file_accesses(tool_lower: &str, args: &Value) -> Vec<String> {
    if !matches!(
        tool_lower,
        "read"
            | "write"
            | "edit"
            | "grep"
            | "glob"
            | "listdirectory"
            | "list_directory"
            | "lsp"
            | "memoryread"
            | "memory_read"
            | "memorywrite"
            | "memory_write"
            | "memorystrreplace"
            | "memory_str_replace"
            | "memoryappend"
            | "memory_append"
            | "memorydelete"
            | "memory_delete"
            | "readmediafile"
            | "read_media_file"
    ) {
        return Vec::new();
    }

    match args.get("path") {
        Some(Value::String(path)) => vec![path.clone()],
        Some(Value::Array(paths)) => paths
            .iter()
            .filter_map(|path| path.as_str())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn extract_rule_subject(tool_lower: &str, args: &Value) -> Option<String> {
    match tool_lower {
        "read" | "write" | "edit" => args
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        "grep" | "glob" | "listdirectory" | "list_directory" => args
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        "fetchurl" | "fetch_url" => args.get("url").and_then(|v| v.as_str()).map(str::to_string),
        "websearch" | "web_search" => args
            .get("query")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        "bash" => args
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        _ if crate::tools::github::is_github_tool(tool_lower) => {
            crate::tools::github::rule_subject(tool_lower, args)
        }
        _ => None,
    }
}

pub fn is_git_control_path(path_str: &str) -> bool {
    let normalized = path_str.replace('\\', "/").to_ascii_lowercase();
    normalized == ".git"
        || normalized.contains("/.git/")
        || normalized.ends_with("/.git")
        || normalized.starts_with(".git/")
}

/// Whether a path is written in posix form — the engine's stand-in for v2's
/// `pathClass === 'posix'` (`git-cwd-write-approve.ts`). v2 reads the class off
/// the *execution runtime's* environment, not the host OS, so deriving it from
/// the subject path keeps the policy honest in both directions: a Windows host
/// driving a posix runtime still gets the allow, and a win32-flavoured target is
/// never approved (v2's `pathClass !== 'posix'` early return).
pub fn is_posix_path(path_str: &str) -> bool {
    let normalized = path_str.replace('\\', "/");
    // `//…` is a win32 UNC root; `C:…` a drive-absolute or drive-relative path.
    if normalized.starts_with("//") {
        return false;
    }
    let mut chars = normalized.chars();
    !matches!(
        (chars.next(), chars.next()),
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic()
    )
}

/// v2 `isWithinWorkspace` (`tool/path-access.ts`): the target inside the
/// workspace dir or any host-authorized additional dir (`/add-dir`). A relative
/// target resolves against the workspace cwd first, which is what v2's
/// `canonicalizePath(path, cwd)` does before the containment test.
pub fn is_within_workspace(
    candidate: &str,
    workspace_dir: &str,
    additional_dirs: &[String],
) -> bool {
    let absolute = if candidate.starts_with('/') {
        candidate.to_string()
    } else {
        format!("{}/{}", workspace_dir.trim_end_matches('/'), candidate)
    };
    is_within_directory(&absolute, workspace_dir)
        || additional_dirs
            .iter()
            .any(|dir| is_within_directory(&absolute, dir))
}

/// v2 `isWithinDirectory`: containment on normalized path components. `.` and
/// `..` are resolved before the comparison and the base has to match on a
/// component boundary, so `/repo2/x` is *not* inside `/repo` — the fork's
/// `starts_with` prefix test approved it, and approved a `..` escape with it.
pub fn is_within_directory(candidate: &str, base: &str) -> bool {
    let candidate_parts = normalized_posix_parts(candidate);
    let base_parts = normalized_posix_parts(base);
    !base_parts.is_empty()
        && candidate_parts.len() >= base_parts.len()
        && candidate_parts[..base_parts.len()] == base_parts[..]
}

/// Split a posix-flavoured path into components, dropping `.` and resolving
/// `..`. An absolute path keeps a leading `/` component of its own, so a
/// relative path never compares equal to the absolute one it resolves to.
fn normalized_posix_parts(path: &str) -> Vec<String> {
    let unified = path.replace('\\', "/");
    let mut parts: Vec<String> = Vec::new();
    for segment in unified.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    if unified.starts_with('/') {
        parts.insert(0, "/".to_string());
    }
    parts
}

/// v2 `findGitWorkTree` (`app/git/workTree.ts`) — the `findWorkTree(cwd)` gate
/// `GitCwdWriteApprove` runs last: walk up from `cwd` for `.git`, which is a
/// directory in a normal checkout and a file carrying a `gitdir:` pointer in a
/// linked worktree or a submodule. Returns the work-tree root; `None` when the
/// walk reaches the filesystem root without finding one, which is v2's
/// `findWorkTree(cwd) === null` and takes the policy out of the chain.
pub fn find_git_work_tree(cwd: &str) -> Option<std::path::PathBuf> {
    let start = std::path::Path::new(cwd);
    if cwd.is_empty() || !start.is_absolute() {
        return None;
    }
    let mut current = start;
    loop {
        let dot_git = current.join(".git");
        if let Ok(metadata) = std::fs::metadata(&dot_git) {
            if metadata.is_dir() {
                return Some(current.to_path_buf());
            }
            if metadata.is_file()
                && std::fs::read_to_string(&dot_git)
                    .ok()
                    .is_some_and(|content| has_git_dir_pointer(&content))
            {
                return Some(current.to_path_buf());
            }
        }
        match current.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => current = parent,
            _ => return None,
        }
    }
}

/// v2 `parseGitDirPointer` (`app/git/workTree.ts`): whether a `.git` file's
/// first line carries a non-empty `gitdir:` target, BOM-tolerant. The target
/// itself is not needed here — the policy gate only asks whether a work tree
/// exists (`findWorkTree(cwd) !== null`) — so it is detected, not resolved.
fn has_git_dir_pointer(content: &str) -> bool {
    let stripped = content.strip_prefix('\u{feff}').unwrap_or(content);
    stripped
        .lines()
        .next()
        .map(str::trim)
        .and_then(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)
        .is_some_and(|target| !target.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_yolo_mode_approves_mutating_tools() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        // Write
        let verdict = engine.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");
        assert_eq!(verdict.reason, None);
        assert!(verdict.is_allow());

        // Edit
        let verdict = engine.evaluate("Edit", &json!({ "path": "README.md" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");
        assert_eq!(verdict.reason, None);
        assert!(verdict.is_allow());

        // Bash
        let verdict = engine.evaluate("Bash", &json!({ "command": "cargo check" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");
        assert_eq!(verdict.reason, None);
        assert!(verdict.is_allow());

        // Mutating GitHub tool
        let verdict = engine.evaluate(
            "GitHubCreateIssue",
            &json!({ "owner": "octocat", "repo": "hello-world", "title": "test" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");
        assert_eq!(verdict.reason, None);
        assert!(verdict.is_allow());
    }

    /// v2's Bash tool declares **no** file accesses (`bashTool.ts` exposes only
    /// `approvalRule` / `matchesRule` / `execute`), so in v2 Bash never reaches
    /// `SensitiveFileAccessAsk` or `GitControlPathAccessAsk` — both read
    /// `fileAccesses(context)` and bail out on an empty list. A command that
    /// merely *mentions* a sensitive or `.git` path must therefore keep the
    /// normal mode verdict instead of asking.
    #[test]
    fn test_bash_command_text_is_not_a_file_access() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        let verdict = engine.evaluate(
            "Bash",
            &json!({ "command": "cat /workspace/project/.git/config" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");

        let verdict = engine.evaluate("Bash", &json!({ "command": "cat /home/u/project/.env" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");

        let verdict = engine.evaluate(
            "Bash",
            &json!({ "command": "grep -n x /workspace/project/credentials" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");

        let verdict = engine.evaluate(
            "Bash",
            &json!({ "command": "git commit -F .git/CMSG9.txt" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");

        // A path tool on the same target still asks — only Bash changed.
        let verdict = engine.evaluate("Read", &json!({ "path": "/workspace/project/.git/config" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "GitControlPathAccessAsk");
    }

    /// v2's WebSearch and FetchURL declare no file access either, so a query or
    /// URL that looks like a sensitive path must not reach #8/#9.
    #[test]
    fn test_query_and_url_subjects_are_not_file_accesses() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        let verdict = engine.evaluate("WebSearch", &json!({ "query": "how to read .env" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");

        let verdict = engine.evaluate("FetchURL", &json!({ "url": "https://example.com/.env" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");
    }

    /// Every path-shaped tool contributes a file access, `memory_read`'s array
    /// form included (v2 checks every declared access, not just the first).
    #[test]
    fn test_path_shaped_tools_declare_file_accesses() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        let sensitive = "/workspace/project/.env";
        for tool in [
            "Read",
            "Write",
            "Edit",
            "Grep",
            "Glob",
            "ListDirectory",
            "Lsp",
            "memory_write",
            "memory_str_replace",
            "memory_append",
            "memory_delete",
            "ReadMediaFile",
        ] {
            let verdict = engine.evaluate(tool, &json!({ "path": sensitive }));
            assert_eq!(
                verdict.decision,
                VerdictDecision::Ask,
                "{tool} should declare a file access"
            );
            assert_eq!(verdict.policy_name, "SensitiveFileAccessAsk");
        }

        let verdict = engine.evaluate(
            "memory_read",
            &json!({ "path": ["notes.md", "/workspace/project/.env"] }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "SensitiveFileAccessAsk");
        assert_eq!(
            verdict.reason,
            Some(format!(
                "Access to sensitive file requires approval: {sensitive}"
            ))
        );
    }

    #[test]
    fn test_yolo_mode_still_intercepts_sensitive_files() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        // Read .env
        let verdict = engine.evaluate("Read", &json!({ "path": ".env" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "SensitiveFileAccessAsk");
        assert_eq!(
            verdict.reason,
            Some("Access to sensitive file requires approval: .env".into())
        );
        assert!(!verdict.is_allow());

        // Grep .env.local
        let verdict = engine.evaluate("Grep", &json!({ "path": "config/.env.local" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "SensitiveFileAccessAsk");
        assert_eq!(
            verdict.reason,
            Some("Access to sensitive file requires approval: config/.env.local".into())
        );
        assert!(!verdict.is_allow());

        // Write to private SSH key
        let verdict = engine.evaluate("Write", &json!({ "path": "~/.ssh/id_rsa" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "SensitiveFileAccessAsk");
        assert_eq!(
            verdict.reason,
            Some("Access to sensitive file requires approval: ~/.ssh/id_rsa".into())
        );
        assert!(!verdict.is_allow());

        // Edit ssl\server.key — standalone `.key` is NOT sensitive in v2
        // (only the dot-variants of `id_rsa` / `id_ed25519` / `id_ecdsa` /
        // `credentials` are). The path must not trigger SensitiveFileAccessAsk.
        let verdict = engine.evaluate("Edit", &json!({ "path": "ssl\\server.key" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
    }

    #[test]
    fn test_user_configured_deny_overrides_all_modes_and_policies() {
        // 1. Deny with argument glob overrides YOLO mode
        let engine_yolo = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            deny_rules: vec!["Bash(rm -rf *)".into()],
            ..Default::default()
        });
        let verdict = engine_yolo.evaluate("Bash", &json!({ "command": "rm -rf /" }));
        assert_eq!(verdict.decision, VerdictDecision::Deny);
        assert_eq!(verdict.policy_name, "UserConfiguredDeny");
        assert_eq!(
            verdict.reason,
            Some("Denied by user rule: Bash(rm -rf *)".into())
        );
        assert!(!verdict.is_allow());

        // Non-matching bash command in YOLO mode is allowed
        let verdict_safe = engine_yolo.evaluate("Bash", &json!({ "command": "echo hello" }));
        assert_eq!(verdict_safe.decision, VerdictDecision::Allow);
        assert_eq!(verdict_safe.policy_name, "YoloModeApprove");
        assert_eq!(verdict_safe.reason, None);

        // 2. Tool-wide deny overrides Auto mode
        let engine_auto = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            deny_rules: vec!["Write".into()],
            ..Default::default()
        });
        let verdict_auto = engine_auto.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict_auto.decision, VerdictDecision::Deny);
        assert_eq!(verdict_auto.policy_name, "UserConfiguredDeny");
        assert_eq!(
            verdict_auto.reason,
            Some("Denied by user rule: Write".into())
        );
        assert!(!verdict_auto.is_allow());

        // 3. Wildcard tool rule `*(*.secret)` denies any matching tool call
        let engine_wildcard = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            deny_rules: vec!["*(*.secret)".into()],
            ..Default::default()
        });
        let verdict_read = engine_wildcard.evaluate("Read", &json!({ "path": "app.secret" }));
        assert_eq!(verdict_read.decision, VerdictDecision::Deny);
        assert_eq!(verdict_read.policy_name, "UserConfiguredDeny");
        assert_eq!(
            verdict_read.reason,
            Some("Denied by user rule: *(*.secret)".into())
        );

        let verdict_edit = engine_wildcard.evaluate("Edit", &json!({ "path": "app.secret" }));
        assert_eq!(verdict_edit.decision, VerdictDecision::Deny);
        assert_eq!(verdict_edit.policy_name, "UserConfiguredDeny");
        assert_eq!(
            verdict_edit.reason,
            Some("Denied by user rule: *(*.secret)".into())
        );

        // 4. Deny overrides session approval history
        let engine_session = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            deny_rules: vec!["Bash(dropdb *)".into()],
            session_approvals: vec!["Bash".into()],
            ..Default::default()
        });
        let verdict_denied = engine_session.evaluate("Bash", &json!({ "command": "dropdb prod" }));
        assert_eq!(verdict_denied.decision, VerdictDecision::Deny);
        assert_eq!(verdict_denied.policy_name, "UserConfiguredDeny");
        assert_eq!(
            verdict_denied.reason,
            Some("Denied by user rule: Bash(dropdb *)".into())
        );
    }

    #[test]
    fn test_default_tool_approve_for_all_readonly_tools() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });

        let cases = [
            ("read", json!({ "path": "package.json" })),
            ("READ", json!({ "path": "src/lib.rs" })),
            ("grep", json!({ "path": "src", "pattern": "fn" })),
            ("Grep", json!({ "path": "src", "pattern": "struct" })),
            ("glob", json!({ "path": ".", "pattern": "*.ts" })),
            ("GLOB", json!({ "path": ".", "pattern": "*.rs" })),
            ("listdirectory", json!({ "path": "src" })),
            ("list_directory", json!({ "path": "src" })),
            ("fetchurl", json!({ "url": "https://example.com" })),
            ("fetch_url", json!({ "url": "https://example.com/api" })),
            ("Fetch_Url", json!({ "url": "https://example.com/docs" })),
            ("websearch", json!({ "query": "rust async" })),
            ("web_search", json!({ "query": "tokio tutorial" })),
            ("WebSearch", json!({ "query": "actix web" })),
            // Fork-original read-only tools: they execute natively, so without
            // an entry here they fell through to `FallbackAsk` and prompted in
            // every non-Yolo mode — a prompt v2's read-only policy never shows.
            ("lsp", json!({ "action": "hover", "path": "src/lib.rs" })),
            ("memory_read", json!({ "path": "style.md" })),
            ("memoryread", json!({})),
            ("memory_list", json!({})),
            ("memorylist", json!({ "cursor": "page-2" })),
            ("tower_status", json!({})),
            ("towerstatus", json!({})),
            ("tower_inbox", json!({ "limit": 10 })),
            ("towerinbox", json!({})),
        ];

        for (tool, args) in cases {
            let verdict = engine.evaluate(tool, &args);
            assert_eq!(
                verdict.decision,
                VerdictDecision::Allow,
                "Tool '{tool}' should be allowed by DefaultToolApprove"
            );
            assert_eq!(
                verdict.policy_name, "DefaultToolApprove",
                "Tool '{tool}' should trigger DefaultToolApprove"
            );
            assert_eq!(verdict.reason, None);
            assert!(verdict.is_allow());
        }
    }

    #[test]
    fn test_manual_mode_fallback_ask_for_write() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });

        // Write without git_cwd falls back to Ask
        let verdict = engine.evaluate("Write", &json!({ "path": "package.json" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");
        assert_eq!(
            verdict.reason,
            Some("Tool execution requires approval: Write".into())
        );
        assert!(!verdict.is_allow());

        // Edit without git_cwd falls back to Ask
        let verdict = engine.evaluate("Edit", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");
        assert_eq!(
            verdict.reason,
            Some("Tool execution requires approval: Edit".into())
        );

        // Unknown custom tool falls back to Ask
        let verdict = engine.evaluate("DeployTool", &json!({ "env": "staging" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");
        assert_eq!(
            verdict.reason,
            Some("Tool execution requires approval: DeployTool".into())
        );
    }

    #[test]
    fn test_readonly_github_tools_approved_by_default() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });

        // Read-only GitHub tools are approved by DefaultToolApprove
        for tool in [
            "GitHubGetRepo",
            "GitHubGetPRDiff",
            "GitHubSearchCode",
            "GitHubGetMe",
        ] {
            let verdict =
                engine.evaluate(tool, &json!({ "owner": "octocat", "repo": "hello-world" }));
            assert_eq!(
                verdict.decision,
                VerdictDecision::Allow,
                "{tool} should be allowed"
            );
            assert_eq!(verdict.policy_name, "DefaultToolApprove");
            assert_eq!(verdict.reason, None);
            assert!(verdict.is_allow());
        }
    }

    #[test]
    fn test_mutating_github_tools_fall_back_to_ask() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });

        // Mutating GitHub tools fall back to FallbackAsk
        for tool in ["GitHubCreateIssue", "GitHubMergePR", "GitHubUpdateRef"] {
            let verdict = engine.evaluate(
                tool,
                &json!({ "owner": "octocat", "repo": "hello-world", "title": "t" }),
            );
            assert_eq!(
                verdict.decision,
                VerdictDecision::Ask,
                "{tool} should require approval"
            );
            assert_eq!(verdict.policy_name, "FallbackAsk");
            assert_eq!(
                verdict.reason,
                Some(format!("Tool execution requires approval: {tool}"))
            );
            assert!(!verdict.is_allow());
        }
    }

    #[test]
    fn test_github_subject_rules_match() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            deny_rules: vec!["GitHubCreateIssue(octocat/hello-world)".into()],
            ..Default::default()
        });

        // Matching subject is denied
        let verdict = engine.evaluate(
            "GitHubCreateIssue",
            &json!({ "owner": "octocat", "repo": "hello-world", "title": "t" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Deny);
        assert_eq!(verdict.policy_name, "UserConfiguredDeny");
        assert_eq!(
            verdict.reason,
            Some("Denied by user rule: GitHubCreateIssue(octocat/hello-world)".into())
        );

        // Different repo subject falls back to FallbackAsk
        let verdict_other = engine.evaluate(
            "GitHubCreateIssue",
            &json!({ "owner": "other", "repo": "repo", "title": "t" }),
        );
        assert_eq!(verdict_other.decision, VerdictDecision::Ask);
        assert_eq!(verdict_other.policy_name, "FallbackAsk");
        assert_eq!(
            verdict_other.reason,
            Some("Tool execution requires approval: GitHubCreateIssue".into())
        );
    }

    #[test]
    fn test_auto_mode_ask_user_question_denied() {
        let engine_auto = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            ..Default::default()
        });

        // Exact PascalCase AskUserQuestion
        let verdict = engine_auto.evaluate(
            "AskUserQuestion",
            &json!({ "question": "Should I proceed with delete?" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Deny);
        assert_eq!(verdict.policy_name, "AutoModeAskUserQuestionDeny");
        assert_eq!(
            verdict.reason,
            Some("Auto mode cannot ask interactive questions".into())
        );
        assert!(!verdict.is_allow());

        // snake_case ask_user_question
        let verdict_snake = engine_auto.evaluate(
            "ask_user_question",
            &json!({ "question": "Which option do you prefer?" }),
        );
        assert_eq!(verdict_snake.decision, VerdictDecision::Deny);
        assert_eq!(verdict_snake.policy_name, "AutoModeAskUserQuestionDeny");
        assert_eq!(
            verdict_snake.reason,
            Some("Auto mode cannot ask interactive questions".into())
        );

        // In Manual mode, AskUserQuestion is approved by DefaultToolApprove —
        // v2 lists it in `DEFAULT_APPROVE_TOOLS`, so asking the user a
        // question never itself needs approval. Only Auto mode denies it
        // (AutoModeAskUserQuestionDeny runs first).
        let engine_manual = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let verdict_manual = engine_manual.evaluate("AskUserQuestion", &json!({}));
        assert_eq!(verdict_manual.decision, VerdictDecision::Allow);
        assert_eq!(verdict_manual.policy_name, "DefaultToolApprove");
        assert_eq!(verdict_manual.reason, None);

        // In Yolo mode, AskUserQuestion is allowed by YoloModeApprove
        let engine_yolo = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });
        let verdict_yolo = engine_yolo.evaluate("AskUserQuestion", &json!({}));
        assert_eq!(verdict_yolo.decision, VerdictDecision::Allow);
        assert_eq!(verdict_yolo.policy_name, "YoloModeApprove");
        assert_eq!(verdict_yolo.reason, None);
    }

    #[test]
    fn test_auto_mode_approves_safe_and_mutating() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            ..Default::default()
        });

        // Mutating tools like Write are approved in Auto mode
        let verdict = engine.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "AutoModeApprove");
        assert_eq!(verdict.reason, None);
        assert!(verdict.is_allow());

        // Edit is approved in Auto mode
        let verdict = engine.evaluate("Edit", &json!({ "path": "Cargo.toml" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "AutoModeApprove");
        assert_eq!(verdict.reason, None);

        // Mutating GitHub tool is approved in Auto mode
        let verdict = engine.evaluate(
            "GitHubCreateIssue",
            &json!({ "owner": "octocat", "repo": "hello-world", "title": "t" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "AutoModeApprove");
        assert_eq!(verdict.reason, None);
    }

    #[test]
    fn test_session_approval_history() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            session_approvals: vec!["Write(src/*.rs)".into(), "Bash(cargo test)".into()],
            ..Default::default()
        });

        // Matches session rule for Write(src/*.rs)
        let verdict = engine.evaluate("Write", &json!({ "path": "src/lib.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "SessionApprovalHistory");
        assert_eq!(
            verdict.reason,
            Some("Approved by session history rule: Write(src/*.rs)".into())
        );
        assert!(verdict.is_allow());

        // Matches session rule for Bash(cargo test)
        let verdict = engine.evaluate("Bash", &json!({ "command": "cargo test" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "SessionApprovalHistory");
        assert_eq!(
            verdict.reason,
            Some("Approved by session history rule: Bash(cargo test)".into())
        );

        // Unmatched path falls through to FallbackAsk
        let verdict_miss = engine.evaluate("Write", &json!({ "path": "tests/test.rs" }));
        assert_eq!(verdict_miss.decision, VerdictDecision::Ask);
        assert_eq!(verdict_miss.policy_name, "FallbackAsk");
        assert_eq!(
            verdict_miss.reason,
            Some("Tool execution requires approval: Write".into())
        );
    }

    #[test]
    fn test_user_configured_ask() {
        // Even in YOLO mode, an explicit user ask rule requires confirmation
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ask_rules: vec!["Write(config/*)".into(), "Bash(deploy *)".into()],
            ..Default::default()
        });

        let verdict = engine.evaluate("Write", &json!({ "path": "config/prod.json" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "UserConfiguredAsk");
        assert_eq!(
            verdict.reason,
            Some("Approval required by user rule: Write(config/*)".into())
        );
        assert!(!verdict.is_allow());

        let verdict_bash = engine.evaluate("Bash", &json!({ "command": "deploy prod" }));
        assert_eq!(verdict_bash.decision, VerdictDecision::Ask);
        assert_eq!(verdict_bash.policy_name, "UserConfiguredAsk");
        assert_eq!(
            verdict_bash.reason,
            Some("Approval required by user rule: Bash(deploy *)".into())
        );

        // Non-matching call in YOLO mode is approved
        let verdict_pass = engine.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict_pass.decision, VerdictDecision::Allow);
        assert_eq!(verdict_pass.policy_name, "YoloModeApprove");
        assert_eq!(verdict_pass.reason, None);
    }

    #[test]
    fn test_user_configured_allow() {
        // In Manual mode, explicit allow rules permit normally restricted operations
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            allow_rules: vec!["Write(tmp/*)".into(), "Bash(npm run lint)".into()],
            ..Default::default()
        });

        let verdict = engine.evaluate("Write", &json!({ "path": "tmp/cache.json" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "UserConfiguredAllow");
        assert_eq!(
            verdict.reason,
            Some("Allowed by user rule: Write(tmp/*)".into())
        );
        assert!(verdict.is_allow());

        let verdict_bash = engine.evaluate("Bash", &json!({ "command": "npm run lint" }));
        assert_eq!(verdict_bash.decision, VerdictDecision::Allow);
        assert_eq!(verdict_bash.policy_name, "UserConfiguredAllow");
        assert_eq!(
            verdict_bash.reason,
            Some("Allowed by user rule: Bash(npm run lint)".into())
        );

        // Unmatched path requires approval
        let verdict_other = engine.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict_other.decision, VerdictDecision::Ask);
        assert_eq!(verdict_other.policy_name, "FallbackAsk");
        assert_eq!(
            verdict_other.reason,
            Some("Tool execution requires approval: Write".into())
        );
    }

    #[test]
    fn test_git_control_path_access_ask() {
        let engine_manual = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let engine_yolo = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        let test_paths = [
            ".git/config",
            "repo/.git/HEAD",
            "packages/app/.git/refs/heads/main",
            "sub\\.git\\hooks\\pre-commit",
            ".git",
            "my_repo/.git",
        ];

        for path in test_paths {
            // Manual mode asks
            let verdict = engine_manual.evaluate("Write", &json!({ "path": path }));
            assert_eq!(
                verdict.decision,
                VerdictDecision::Ask,
                "Path '{path}' should require approval in Manual mode"
            );
            assert_eq!(verdict.policy_name, "GitControlPathAccessAsk");
            assert_eq!(
                verdict.reason,
                Some(format!(
                    "Access to git control path requires approval: {path}"
                ))
            );
            assert!(!verdict.is_allow());

            // YOLO mode also asks (cannot bypass git control path)
            let verdict_yolo = engine_yolo.evaluate("Read", &json!({ "path": path }));
            assert_eq!(
                verdict_yolo.decision,
                VerdictDecision::Ask,
                "Path '{path}' should require approval in YOLO mode"
            );
            assert_eq!(verdict_yolo.policy_name, "GitControlPathAccessAsk");
            assert_eq!(
                verdict_yolo.reason,
                Some(format!(
                    "Access to git control path requires approval: {path}"
                ))
            );
        }

        // Non-git control files should not be flagged as git control paths
        let verdict_gitignore = engine_manual.evaluate("Read", &json!({ "path": ".gitignore" }));
        assert_eq!(verdict_gitignore.decision, VerdictDecision::Allow);
        assert_eq!(verdict_gitignore.policy_name, "DefaultToolApprove");

        let verdict_workflow =
            engine_manual.evaluate("Read", &json!({ "path": ".github/workflows/ci.yml" }));
        assert_eq!(verdict_workflow.decision, VerdictDecision::Allow);
        assert_eq!(verdict_workflow.policy_name, "DefaultToolApprove");
    }

    /// v2 `git-cwd-write-approve.ts` end to end, against a **real** work tree:
    /// the policy needs a posix workspace root that exists on disk carrying a
    /// `.git`, so this matrix runs where temp dirs are posix paths. The gates
    /// that need no work tree are covered by
    /// `test_git_cwd_write_approve_requires_a_posix_work_tree`.
    #[cfg(unix)]
    #[test]
    fn test_git_cwd_write_approve() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let engine = PermissionEngine::with_workspace(
            PolicySnapshot {
                mode: PermissionMode::Manual,
                git_cwd: Some(root.clone()),
                ..Default::default()
            },
            Some(root.clone()),
            Vec::new(),
        );

        // 1. Write inside the work tree is approved by GitCwdWriteApprove
        let verdict = engine.evaluate("Write", &json!({ "path": format!("{root}/src/lib.rs") }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "GitCwdWriteApprove");
        assert_eq!(verdict.reason, None);
        assert!(verdict.is_allow());

        // 2. Edit inside the work tree is approved by GitCwdWriteApprove
        let verdict_edit =
            engine.evaluate("Edit", &json!({ "path": format!("{root}/Cargo.toml") }));
        assert_eq!(verdict_edit.decision, VerdictDecision::Allow);
        assert_eq!(verdict_edit.policy_name, "GitCwdWriteApprove");
        assert_eq!(verdict_edit.reason, None);

        // 3. Write outside git_cwd falls back to FallbackAsk
        let verdict_outside =
            engine.evaluate("Write", &json!({ "path": "/other/location/file.txt" }));
        assert_eq!(verdict_outside.decision, VerdictDecision::Ask);
        assert_eq!(verdict_outside.policy_name, "FallbackAsk");
        assert_eq!(
            verdict_outside.reason,
            Some("Tool execution requires approval: Write".into())
        );

        // 4. A sensitive target inside the work tree hits SensitiveFileAccessAsk
        let env_path = format!("{root}/.env");
        let verdict_sensitive = engine.evaluate("Write", &json!({ "path": env_path }));
        assert_eq!(verdict_sensitive.decision, VerdictDecision::Ask);
        assert_eq!(verdict_sensitive.policy_name, "SensitiveFileAccessAsk");
        assert_eq!(
            verdict_sensitive.reason,
            Some(format!(
                "Access to sensitive file requires approval: {env_path}"
            ))
        );

        // 5. A git control path inside the work tree hits GitControlPathAccessAsk
        let git_config = format!("{root}/.git/config");
        let verdict_git = engine.evaluate("Write", &json!({ "path": git_config }));
        assert_eq!(verdict_git.decision, VerdictDecision::Ask);
        assert_eq!(verdict_git.policy_name, "GitControlPathAccessAsk");
        assert_eq!(
            verdict_git.reason,
            Some(format!(
                "Access to git control path requires approval: {git_config}"
            ))
        );

        // 6. v2's containment gate is component-wise, so a sibling directory
        // that merely shares the prefix is *not* inside the workspace — the
        // fork's `starts_with` approved it — and neither is a `..` escape that
        // lands outside after normalization. A relative target, by contrast,
        // resolves against the workspace cwd (v2 `canonicalizePath`) and is.
        let sibling = engine.evaluate("Write", &json!({ "path": format!("{root}2/src/lib.rs") }));
        assert_eq!(sibling.decision, VerdictDecision::Ask, "prefix sibling");
        assert_eq!(sibling.policy_name, "FallbackAsk");
        let escape = engine.evaluate(
            "Write",
            &json!({ "path": format!("{root}/../elsewhere/a.rs") }),
        );
        assert_eq!(escape.decision, VerdictDecision::Ask, "`..` escape");
        assert_eq!(escape.policy_name, "FallbackAsk");
        let relative = engine.evaluate("Write", &json!({ "path": "src/relative.rs" }));
        assert_eq!(relative.decision, VerdictDecision::Allow, "relative target");
        assert_eq!(relative.policy_name, "GitCwdWriteApprove");

        // 7. An `/add-dir` root is part of the boundary (v2
        //    `{workspaceDir, additionalDirs}`): without it the target is
        //    outside and asks, with it the same target is approved.
        let elsewhere = tempfile::tempdir().unwrap();
        let other = elsewhere.path().to_string_lossy().to_string();
        let other_file = format!("{other}/notes.md");
        let narrow = engine.evaluate("Write", &json!({ "path": other_file }));
        assert_eq!(narrow.decision, VerdictDecision::Ask);
        assert_eq!(narrow.policy_name, "FallbackAsk");
        let widened = PermissionEngine::with_workspace(
            PolicySnapshot {
                mode: PermissionMode::Manual,
                git_cwd: Some(root.clone()),
                ..Default::default()
            },
            Some(root.clone()),
            vec![other.clone()],
        );
        let granted = widened.evaluate("Write", &json!({ "path": other_file }));
        assert_eq!(granted.decision, VerdictDecision::Allow);
        assert_eq!(granted.policy_name, "GitCwdWriteApprove");

        // 8. v2's tool gate: only the Write/Edit pair is eligible. Another tool
        // whose subject happens to sit inside the workspace is *not* approved
        // here — Bash carries its command as the subject, so a command that
        // looks like a path inside the workspace must not ride this policy.
        let verdict_bash = engine.evaluate(
            "Bash",
            &json!({ "command": format!("{root}/scripts/build.sh") }),
        );
        assert_eq!(verdict_bash.decision, VerdictDecision::Ask);
        assert_eq!(verdict_bash.policy_name, "FallbackAsk");

        assert!(is_posix_path("/workspace/project/src/lib.rs"));
        assert!(!is_posix_path(r"D:\repo\src\main.rs"));
        assert!(!is_posix_path("D:/repo/src/main.rs"));
        assert!(!is_posix_path(r"\\server\share\repo\a.rs"));
        assert!(!is_posix_path("C:relative.rs"));
    }

    /// The two #12 gates that need no existing posix work tree: the
    /// path-class stand-in (a win32 workspace root never approves, which is
    /// v2's `pathClass !== 'posix'` early return for a local Windows runtime)
    /// and the `findWorkTree(cwd)` requirement (a posix workspace without a
    /// `.git` anywhere up the tree is not approved either).
    #[test]
    fn test_git_cwd_write_approve_requires_a_posix_work_tree() {
        let win_engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            git_cwd: Some("D:/repo".into()),
            ..Default::default()
        });
        for path in [
            r"D:\repo\src\main.rs",
            "D:/repo/src/main.rs",
            r"\\server\share\repo\a.rs",
        ] {
            let verdict = win_engine.evaluate("Write", &json!({ "path": path }));
            assert_eq!(verdict.decision, VerdictDecision::Ask, "path: {path}");
            assert_eq!(verdict.policy_name, "FallbackAsk", "path: {path}");
        }
        // A posix-flavoured target does not rescue a win32 workspace: the
        // runtime's class is what v2 reads, not the target's flavour.
        let outside = win_engine.evaluate("Write", &json!({ "path": "/workspace/project/a.rs" }));
        assert_eq!(outside.decision, VerdictDecision::Ask);
        assert_eq!(outside.policy_name, "FallbackAsk");

        // A posix workspace root with no `.git` up the tree fails
        // `findWorkTree(cwd)` and takes the policy out of the chain.
        let no_tree = tempfile::tempdir().unwrap();
        let root = no_tree.path().to_string_lossy().to_string();
        let engine = PermissionEngine::with_workspace(
            PolicySnapshot {
                mode: PermissionMode::Manual,
                git_cwd: Some(root.clone()),
                ..Default::default()
            },
            Some(root.clone()),
            Vec::new(),
        );
        let verdict = engine.evaluate("Write", &json!({ "path": format!("{root}/a.rs") }));
        assert_eq!(verdict.decision, VerdictDecision::Ask, "no work tree");
        assert_eq!(verdict.policy_name, "FallbackAsk");

        // No workspace cwd at all (v2's `cwd.length === 0`) is no approval
        // either, whatever the target looks like.
        let bare = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let verdict = bare.evaluate("Write", &json!({ "path": "/workspace/project/a.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");
    }

    /// v2 `findGitWorkTree` (`app/git/workTree.ts`): the walk finds a `.git`
    /// directory or a `.git` *file* carrying a `gitdir:` pointer (a linked
    /// worktree / submodule), and reports nothing for a plain file or a tree
    /// without one.
    #[test]
    fn test_find_git_work_tree() {
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(
            find_git_work_tree(&plain.path().to_string_lossy()),
            None,
            "a stray temp dir is not a work tree"
        );

        let checkout = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(checkout.path().join(".git")).unwrap();
        let nested = checkout.path().join("src/deep");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            find_git_work_tree(&nested.to_string_lossy()),
            Some(checkout.path().to_path_buf()),
            "the walk starts at the cwd and finds the checkout root above it"
        );

        let linked = tempfile::tempdir().unwrap();
        std::fs::write(
            linked.path().join(".git"),
            "gitdir: /elsewhere/.git/worktrees/linked\n",
        )
        .unwrap();
        assert_eq!(
            find_git_work_tree(&linked.path().to_string_lossy()),
            Some(linked.path().to_path_buf()),
            "a `gitdir:` pointer file is a work tree too"
        );

        let broken = tempfile::tempdir().unwrap();
        std::fs::write(broken.path().join(".git"), "not a pointer\n").unwrap();
        assert_eq!(find_git_work_tree(&broken.path().to_string_lossy()), None);

        assert_eq!(find_git_work_tree(""), None, "no cwd, no work tree");
        assert_eq!(
            find_git_work_tree("relative/dir"),
            None,
            "a cwd that is not absolute has nowhere to walk up from"
        );
    }

    /// v2 `isWithinDirectory` / `isWithinWorkspace`: component-wise containment
    /// with `.` / `..` resolved, plus the `additionalDirs` union.
    #[test]
    fn test_workspace_containment_is_component_wise() {
        assert!(is_within_directory("/repo/src/lib.rs", "/repo"));
        assert!(is_within_directory("/repo", "/repo"));
        assert!(!is_within_directory("/repo2/src/lib.rs", "/repo"));
        assert!(!is_within_directory("/other/repo/x", "/repo"));
        assert!(is_within_directory("/repo/a/../b/x.rs", "/repo/b"));
        assert!(!is_within_directory("/repo/../elsewhere/x.rs", "/repo"));
        assert!(
            !is_within_directory("/repo/x", "repo"),
            "the leading `/` is its own component, so an absolute path is never \
             inside the relative base of the same name"
        );
        assert!(
            !is_within_directory("repo/src/lib.rs", "/repo"),
            "a relative candidate is not the absolute path it resolves to"
        );
        assert!(
            !is_within_directory("/repo/x", ""),
            "an empty base has no components, so nothing is inside it"
        );

        let extras = vec!["/granted".to_string()];
        assert!(is_within_workspace("/repo/x.rs", "/repo", &extras));
        assert!(
            is_within_workspace("/granted/x.rs", "/repo", &extras),
            "an /add-dir root is inside the boundary"
        );
        assert!(is_within_workspace("/granted/sub/x.rs", "/repo", &extras));
        assert!(!is_within_workspace("/granted2/x.rs", "/repo", &extras));
        assert!(
            is_within_workspace("src/lib.rs", "/repo", &extras),
            "a relative target resolves against the workspace cwd"
        );
        assert!(!is_within_workspace("/elsewhere/x.rs", "/repo", &extras));
    }

    /// Vectors the component-wise comparison must refuse. `starts_with` accepted
    /// every one of these, which is how a write escaped the workspace.
    #[test]
    fn test_workspace_containment_refuses_escape_shapes() {
        // `~` is not expanded here, so it is a literal component — a home-
        // relative path must never read as inside a workspace root.
        assert!(!is_within_directory("~/.ssh/config", "/"));
        assert!(!is_within_directory("/repo/~/x", "/repo/real"));
        // A trailing separator is a separator, not a new component: `/repo/`
        // and `/repo` are the same root, so a sibling that merely shares the
        // prefix is still outside.
        assert!(is_within_directory("/repo/x.rs", "/repo/"));
        assert!(is_within_directory("/repo/", "/repo"));
        assert!(!is_within_directory("/repo-evil/x.rs", "/repo/"));
        // Repeated separators collapse rather than creating empty components
        // that could line up with a base segment.
        assert!(is_within_directory("/repo//src//x.rs", "/repo"));
        // `..` that climbs past the root is clamped, not allowed to wrap.
        assert!(!is_within_directory("/../etc/passwd", "/repo"));
        // Backslashes are unified first, so a Windows-flavoured subject cannot
        // smuggle a separator past the component split.
        assert!(is_within_directory("\\repo\\src\\x.rs", "/repo"));
        assert!(!is_within_directory("\\repo2\\x.rs", "/repo"));
    }

    /// v2 `matchPermissionRule` (`permissionRules/matchesRule.ts`): the tool
    /// name is a **picomatch pattern**, not a literal — `Bash*` / `*` / `?`
    /// match, and `*` short-circuits before the pattern is consulted.
    #[test]
    fn test_rule_tool_name_is_a_glob_pattern() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            allow_rules: vec!["Bash*".into(), "Read*le".into()],
            ..Default::default()
        });

        let verdict = engine.evaluate("Bash", &json!({ "command": "cargo check" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "UserConfiguredAllow");

        let verdict = engine.evaluate("BashOutput", &json!({ "command": "cargo check" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "UserConfiguredAllow");

        let verdict = engine.evaluate("ReadFile", &json!({ "path": "src/lib.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "UserConfiguredAllow");

        // `?` is a single character in picomatch, so `Read?le` does not match.
        let engine_single = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            allow_rules: vec!["Read?le".into()],
            ..Default::default()
        });
        let verdict = engine_single.evaluate("ReadFile", &json!({ "path": "src/lib.rs" }));
        assert_ne!(verdict.policy_name, "UserConfiguredAllow");

        // A tool outside both patterns still asks.
        let verdict = engine.evaluate("Write", &json!({ "path": "src/lib.rs" }));
        assert_ne!(verdict.policy_name, "UserConfiguredAllow");
    }

    /// v2 `pathGlobMatch` defaults `caseInsensitivePaths` to **true**, so a
    /// path rule matches a differently-cased path on any platform.
    #[test]
    fn test_path_rules_match_case_insensitively() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            allow_rules: vec!["Write(src/**)".into()],
            ..Default::default()
        });

        let verdict = engine.evaluate("Write", &json!({ "path": "SRC/Main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "UserConfiguredAllow");
    }

    /// v2 `matchRuleSubjects`: a leading `!` negates the argument pattern, so
    /// `Bash(!rm *)` denies every command except the ones starting with `rm`.
    /// The engine used to refuse such patterns outright, which silently
    /// dropped the rule.
    #[test]
    fn test_negated_argument_pattern() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            deny_rules: vec!["Bash(!rm *)".into()],
            ..Default::default()
        });

        let verdict = engine.evaluate("Bash", &json!({ "command": "cargo check" }));
        assert_eq!(verdict.decision, VerdictDecision::Deny);
        assert_eq!(verdict.policy_name, "UserConfiguredDeny");

        let verdict = engine.evaluate("Bash", &json!({ "command": "rm -rf target" }));
        assert_ne!(verdict.policy_name, "UserConfiguredDeny");
    }

    #[test]
    fn test_policy_chain_precedence_hierarchy() {
        // A. Deny beats Allow
        let engine_deny_vs_allow = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            deny_rules: vec!["Write(src/*)".into()],
            allow_rules: vec!["Write(src/*)".into()],
            ..Default::default()
        });
        let verdict = engine_deny_vs_allow.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Deny);
        assert_eq!(verdict.policy_name, "UserConfiguredDeny");

        // B. Session history beats UserConfiguredAsk
        let engine_session_vs_ask = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            session_approvals: vec!["Write(src/*)".into()],
            ask_rules: vec!["Write(src/*)".into()],
            ..Default::default()
        });
        let verdict = engine_session_vs_ask.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "SessionApprovalHistory");

        // C. UserConfiguredAsk beats UserConfiguredAllow
        let engine_ask_vs_allow = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ask_rules: vec!["Write(src/*)".into()],
            allow_rules: vec!["Write(src/*)".into()],
            ..Default::default()
        });
        let verdict = engine_ask_vs_allow.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "UserConfiguredAsk");

        // D. UserConfiguredAllow beats SensitiveFileAccessAsk
        let engine_allow_sensitive = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            allow_rules: vec!["Read(.env)".into()],
            ..Default::default()
        });
        let verdict = engine_allow_sensitive.evaluate("Read", &json!({ "path": ".env" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "UserConfiguredAllow");
        assert_eq!(
            verdict.reason,
            Some("Allowed by user rule: Read(.env)".into())
        );

        // E. UserConfiguredAllow beats GitControlPathAccessAsk
        let engine_allow_git = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            allow_rules: vec!["Write(.git/config)".into()],
            ..Default::default()
        });
        let verdict = engine_allow_git.evaluate("Write", &json!({ "path": ".git/config" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "UserConfiguredAllow");
        assert_eq!(
            verdict.reason,
            Some("Allowed by user rule: Write(.git/config)".into())
        );
    }

    #[test]
    fn test_parse_permission_pattern() {
        // Valid patterns
        let rule = parse_permission_pattern("Write").unwrap();
        assert_eq!(rule.tool_name, "Write");
        assert_eq!(rule.arg_pattern, None);

        let rule = parse_permission_pattern("  Bash  ").unwrap();
        assert_eq!(rule.tool_name, "Bash");
        assert_eq!(rule.arg_pattern, None);

        let rule = parse_permission_pattern("Write(src/*.rs)").unwrap();
        assert_eq!(rule.tool_name, "Write");
        assert_eq!(rule.arg_pattern, Some("src/*.rs".into()));

        let rule = parse_permission_pattern("  Bash ( rm -rf * )  ").unwrap();
        assert_eq!(rule.tool_name, "Bash");
        assert_eq!(rule.arg_pattern, Some("rm -rf *".into()));

        let rule = parse_permission_pattern("Write()").unwrap();
        assert_eq!(rule.tool_name, "Write");
        assert_eq!(rule.arg_pattern, None);

        let rule = parse_permission_pattern("Write(   )").unwrap();
        assert_eq!(rule.tool_name, "Write");
        assert_eq!(rule.arg_pattern, None);

        // Invalid patterns
        assert!(parse_permission_pattern("").is_none());
        assert!(parse_permission_pattern("   ").is_none());
        assert!(parse_permission_pattern("Write(").is_none());
        assert!(parse_permission_pattern(")").is_none());
        assert!(parse_permission_pattern("(arg)").is_none());
        assert!(parse_permission_pattern("  (arg)  ").is_none());
        assert!(parse_permission_pattern("Write(arg)trailing").is_none());
    }

    #[test]
    fn test_compiled_rule_semantics() {
        // Tool-only rule
        let rule = CompiledRule::compile("Write").unwrap();
        assert!(rule.matches("write", Some("src/main.rs")));
        assert!(rule.matches("write", None));
        assert!(rule.matches("WRITE", Some("anything")));
        assert!(!rule.matches("read", Some("src/main.rs")));

        // Rule with glob pattern
        let rule = CompiledRule::compile("Write(src/*.rs)").unwrap();
        assert!(rule.matches("write", Some("src/main.rs")));
        assert!(!rule.matches("write", Some("tests/test.rs")));
        assert!(!rule.matches("write", None));
        assert!(!rule.matches("read", Some("src/main.rs")));

        // A `./`-prefixed target matches a rule written without it (v2
        // `stripLeadingDotSlash`).
        assert!(rule.matches("write", Some("./src/main.rs")));

        // Wildcard tool rule `*(*.rs)`
        let rule = CompiledRule::compile("*(*.rs)").unwrap();
        assert!(rule.matches("write", Some("src/main.rs")));
        assert!(rule.matches("read", Some("src/main.rs")));
        assert!(rule.matches("edit", Some("src/lib.rs")));
        assert!(!rule.matches("write", Some("src/main.py")));

        // `**` crosses directory boundaries; both match inside `src`.
        let rule = CompiledRule::compile("Write(src/**)").unwrap();
        assert!(rule.matches("write", Some("src/deep/nested/main.rs")));
        assert!(!rule.matches("write", Some("tests/test.rs")));

        // Invalid glob pattern should fail compilation fast (not silently match everything)
        assert!(CompiledRule::compile("Write([unclosed").is_none());

        // Empty rule fails
        assert!(CompiledRule::compile("").is_none());
    }

    #[test]
    fn test_parse_permission_pattern_keeps_negation() {
        let parsed = parse_permission_pattern("Bash(!rm *)").unwrap();
        assert_eq!(parsed.tool_name, "Bash");
        assert_eq!(parsed.arg_pattern.as_deref(), Some("!rm *"));
    }

    #[test]
    fn test_sensitive_file_rules_match_v2() {
        // Positive cases: .env variants (v2 `ENV_PREFIX` + basenames)
        assert!(crate::native::file_type::is_sensitive_file(".env"));
        assert!(crate::native::file_type::is_sensitive_file(".env.local"));
        assert!(crate::native::file_type::is_sensitive_file(
            ".env.production"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            ".env.development.local"
        ));
        assert!(crate::native::file_type::is_sensitive_file(".ENV"));
        assert!(crate::native::file_type::is_sensitive_file(".Env.Test"));
        assert!(crate::native::file_type::is_sensitive_file("config/.env"));
        assert!(crate::native::file_type::is_sensitive_file(
            "backend/.env.production"
        ));

        // Positive cases: SSH private keys (v2 `SENSITIVE_BASENAMES`)
        assert!(crate::native::file_type::is_sensitive_file("id_rsa"));
        assert!(crate::native::file_type::is_sensitive_file("id_ed25519"));
        assert!(crate::native::file_type::is_sensitive_file("id_ecdsa"));
        assert!(crate::native::file_type::is_sensitive_file("~/.ssh/id_rsa"));
        assert!(crate::native::file_type::is_sensitive_file(
            "/root/.ssh/id_ed25519"
        ));
        assert!(crate::native::file_type::is_sensitive_file("ID_RSA"));
        // v2 prefix+separator and prefix+dot-variant: id_rsa.bak, id_rsa-prod,
        // credentials_backup, credentials.old, etc.
        assert!(crate::native::file_type::is_sensitive_file("id_rsa.bak"));
        assert!(crate::native::file_type::is_sensitive_file("id_rsa-prod"));
        assert!(crate::native::file_type::is_sensitive_file(
            "id_ed25519.old"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            "credentials.bak"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            "credentials_backup"
        ));

        // Positive cases: credentials basenames + path-suffix components
        assert!(crate::native::file_type::is_sensitive_file("credentials"));
        assert!(crate::native::file_type::is_sensitive_file(
            "~/.aws/credentials"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            "/root/.gcp/credentials"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            "path/to/.aws/credentials"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            "path/to/.aws/credentials/extra"
        ));

        // Positive cases: Windows paths (backslashes normalised)
        assert!(crate::native::file_type::is_sensitive_file(
            "C:\\Users\\admin\\.ssh\\id_rsa"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            "app\\config\\.env.local"
        ));
        assert!(crate::native::file_type::is_sensitive_file(
            "C:\\path\\.aws\\credentials"
        ));

        // Negative cases: exemptions (v2 `ENV_EXEMPTIONS` + `PUBLIC_KEY_BASENAMES`)
        assert!(!crate::native::file_type::is_sensitive_file(".env.example"));
        assert!(!crate::native::file_type::is_sensitive_file(".env.sample"));
        assert!(!crate::native::file_type::is_sensitive_file(
            ".env.template"
        ));
        assert!(!crate::native::file_type::is_sensitive_file("id_rsa.pub"));
        assert!(crate::native::file_type::is_sensitive_file("id_rsa"));
        assert!(!crate::native::file_type::is_sensitive_file(
            "id_ed25519.pub"
        ));
        assert!(!crate::native::file_type::is_sensitive_file("id_ecdsa.pub"));
        assert!(!crate::native::file_type::is_sensitive_file(".ENV.example"));

        // Negative cases: safe non-sensitive files. v2 does NOT flag
        // arbitrary `.pem` / `.key` / `.pfx` — only the dot-variants of
        // `id_rsa` / `id_ed25519` / `id_ecdsa` / `credentials`.
        assert!(!crate::native::file_type::is_sensitive_file(
            "environment.ts"
        ));
        assert!(!crate::native::file_type::is_sensitive_file("dotenv.js"));
        assert!(!crate::native::file_type::is_sensitive_file(
            "environment.json"
        ));
        assert!(!crate::native::file_type::is_sensitive_file("key.txt"));
        assert!(!crate::native::file_type::is_sensitive_file("keyboard.rs"));
        assert!(!crate::native::file_type::is_sensitive_file("README.md"));
        assert!(!crate::native::file_type::is_sensitive_file("src/main.rs"));
        assert!(!crate::native::file_type::is_sensitive_file("server.key"));
        assert!(!crate::native::file_type::is_sensitive_file("cert.pem"));
        assert!(!crate::native::file_type::is_sensitive_file("identity.pfx"));
        assert!(!crate::native::file_type::is_sensitive_file("certs/ca.pem"));
        assert!(!crate::native::file_type::is_sensitive_file(
            "keys/secret.KEY"
        ));
    }

    #[test]
    fn test_is_git_control_path() {
        // Positive cases
        assert!(is_git_control_path(".git"));
        assert!(is_git_control_path(".GIT"));
        assert!(is_git_control_path(".git/config"));
        assert!(is_git_control_path(".git/HEAD"));
        assert!(is_git_control_path(".git/index"));
        assert!(is_git_control_path(".git/refs/heads/main"));
        assert!(is_git_control_path(".git/hooks/pre-commit"));
        assert!(is_git_control_path("repo/.git"));
        assert!(is_git_control_path("repo/.git/config"));
        assert!(is_git_control_path("packages/app/.git/HEAD"));
        assert!(is_git_control_path("a/b/c/.git/objects"));
        assert!(is_git_control_path("repo\\.git"));
        assert!(is_git_control_path("repo\\.git\\config"));
        assert!(is_git_control_path("C:\\repo\\.git\\HEAD"));

        // Negative cases
        assert!(!is_git_control_path(".gitignore"));
        assert!(!is_git_control_path(".gitattributes"));
        assert!(!is_git_control_path(".gitmodules"));
        assert!(!is_git_control_path(".github/workflows/ci.yml"));
        assert!(!is_git_control_path(".github/CODEOWNERS"));
        assert!(!is_git_control_path("git.rs"));
        assert!(!is_git_control_path("git_controller.ts"));
        assert!(!is_git_control_path("src/git/mod.rs"));
    }

    #[test]
    fn test_extract_rule_subject() {
        // Path-bearing tools
        assert_eq!(
            extract_rule_subject("read", &json!({ "path": "src/main.rs" })).as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(
            extract_rule_subject("write", &json!({ "path": "src/main.rs" })).as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(
            extract_rule_subject("edit", &json!({ "path": "src/main.rs" })).as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(
            extract_rule_subject("grep", &json!({ "path": "src/lib" })).as_deref(),
            Some("src/lib")
        );
        assert_eq!(
            extract_rule_subject("glob", &json!({ "path": "tests" })).as_deref(),
            Some("tests")
        );
        assert_eq!(
            extract_rule_subject("listdirectory", &json!({ "path": "dir" })).as_deref(),
            Some("dir")
        );
        assert_eq!(
            extract_rule_subject("list_directory", &json!({ "path": "dir" })).as_deref(),
            Some("dir")
        );

        // URL-bearing tools
        assert_eq!(
            extract_rule_subject("fetchurl", &json!({ "url": "https://api.test/data" })).as_deref(),
            Some("https://api.test/data")
        );
        assert_eq!(
            extract_rule_subject("fetch_url", &json!({ "url": "https://api.test/data" }))
                .as_deref(),
            Some("https://api.test/data")
        );

        // Query-bearing tools
        assert_eq!(
            extract_rule_subject("websearch", &json!({ "query": "rust docs" })).as_deref(),
            Some("rust docs")
        );
        assert_eq!(
            extract_rule_subject("web_search", &json!({ "query": "rust docs" })).as_deref(),
            Some("rust docs")
        );

        // Command-bearing tools
        assert_eq!(
            extract_rule_subject("bash", &json!({ "command": "cargo test" })).as_deref(),
            Some("cargo test")
        );

        // Missing field or non-string field returns None
        assert_eq!(extract_rule_subject("read", &json!({})), None);
        assert_eq!(extract_rule_subject("read", &json!({ "path": 123 })), None);
        assert_eq!(extract_rule_subject("read", &json!({ "path": true })), None);

        // Unknown tool returns None
        assert_eq!(
            extract_rule_subject("unknown_tool", &json!({ "path": "foo" })),
            None
        );
    }

    #[test]
    fn test_serde_and_helpers() {
        // PermissionEngine::mode()
        let engine_manual = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        assert_eq!(engine_manual.mode(), PermissionMode::Manual);

        let engine_auto = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            ..Default::default()
        });
        assert_eq!(engine_auto.mode(), PermissionMode::Auto);

        let engine_yolo = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });
        assert_eq!(engine_yolo.mode(), PermissionMode::Yolo);

        // LocalPermissionVerdict::is_allow()
        let allow_verdict = LocalPermissionVerdict {
            decision: VerdictDecision::Allow,
            policy_name: "TestPolicy".into(),
            reason: None,
        };
        assert!(allow_verdict.is_allow());

        let deny_verdict = LocalPermissionVerdict {
            decision: VerdictDecision::Deny,
            policy_name: "TestPolicy".into(),
            reason: Some("reason".into()),
        };
        assert!(!deny_verdict.is_allow());

        let ask_verdict = LocalPermissionVerdict {
            decision: VerdictDecision::Ask,
            policy_name: "TestPolicy".into(),
            reason: Some("reason".into()),
        };
        assert!(!ask_verdict.is_allow());

        // Serde roundtrips
        let mode_json = serde_json::to_string(&PermissionMode::Auto).unwrap();
        assert_eq!(mode_json, "\"auto\"");
        let parsed_mode: PermissionMode = serde_json::from_str("\"yolo\"").unwrap();
        assert_eq!(parsed_mode, PermissionMode::Yolo);

        let verdict_json = serde_json::to_string(&allow_verdict).unwrap();
        let parsed_verdict: LocalPermissionVerdict = serde_json::from_str(&verdict_json).unwrap();
        assert_eq!(parsed_verdict, allow_verdict);

        // PolicySnapshot with HookDef deserialization
        let snapshot_json = json!({
            "mode": "auto",
            "deny_rules": ["Bash(rm *)"],
            "pre_tool_hooks": [
                {
                    "event": "PreToolUse",
                    "matcher": "Bash",
                    "command": "echo check",
                    "timeout": 15
                }
            ]
        });
        let snapshot: PolicySnapshot = serde_json::from_value(snapshot_json).unwrap();
        assert_eq!(snapshot.mode, PermissionMode::Auto);
        assert_eq!(snapshot.deny_rules, vec!["Bash(rm *)"]);
        assert_eq!(snapshot.pre_tool_hooks.len(), 1);
        assert_eq!(snapshot.pre_tool_hooks[0].event, "PreToolUse");
        assert_eq!(snapshot.pre_tool_hooks[0].matcher, "Bash");
        assert_eq!(snapshot.pre_tool_hooks[0].command, "echo check");
        assert_eq!(snapshot.pre_tool_hooks[0].timeout, Some(15));
    }

    /// v2 mode gating (dangerous-command-ask.ts, under
    /// `agent/permissionPolicy/policies/`): a dangerous command asks in
    /// manual and yolo alike; auto skips the policy entirely, so AutoModeApprove
    /// decides. Benign commands are approved in auto and yolo; manual falls
    /// through to FallbackAsk.
    #[test]
    fn test_dangerous_bash_command_asks_in_manual_and_yolo() {
        let manual = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let auto = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            ..Default::default()
        });
        let yolo = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        for cmd in ["sudo reboot", "shutdown -h now", "rm -rf /", "format C: /q"] {
            // v2 asks for a *dangerous* command in manual and yolo alike: only
            // `mode === 'auto'` returns before the verdict.
            for engine in [&manual, &yolo] {
                let verdict = engine.evaluate("bash", &json!({ "command": cmd }));
                assert_eq!(verdict.decision, VerdictDecision::Ask, "cmd: {cmd}");
                assert_eq!(verdict.policy_name, "DangerousCommandAsk");
                assert_eq!(
                    verdict.reason.as_deref(),
                    Some("High-risk shell command requires approval")
                );
            }
            // Auto skipped the policy before the verdict, so AutoModeApprove
            // owns the call (v2 `if (mode === 'auto') return undefined`).
            let verdict = auto.evaluate("bash", &json!({ "command": cmd }));
            assert_eq!(verdict.decision, VerdictDecision::Allow, "cmd: {cmd}");
            assert_eq!(verdict.policy_name, "AutoModeApprove");
        }

        // A benign command is untouched by the policy: Auto/Yolo approve it
        // outright, manual falls through the rest of the chain to FallbackAsk
        // (v2 behavior: a non-dangerous, non-allow-listed Bash call asks in
        // manual).
        for engine in [&auto, &yolo] {
            let benign = engine.evaluate("bash", &json!({ "command": "git status" }));
            assert_eq!(benign.decision, VerdictDecision::Allow, "benign command");
        }
        let benign = manual.evaluate("bash", &json!({ "command": "git status" }));
        assert_eq!(benign.decision, VerdictDecision::Ask);
        assert_eq!(benign.policy_name, "FallbackAsk");
    }

    /// v2 `isDangerousCommandGuardEnabled`: `[permission]
    /// dangerousCommandGuard = false` skips the whole policy — the remaining
    /// policies decide every Bash call.
    #[test]
    fn test_dangerous_command_guard_off_skips_the_policy() {
        let guard_on = PermissionEngine::new(PolicySnapshot {
            dangerous_command_guard: true,
            ..Default::default()
        });
        let guard_off = PermissionEngine::new(PolicySnapshot {
            dangerous_command_guard: false,
            ..Default::default()
        });

        let verdict = guard_on.evaluate("bash", &json!({ "command": "sudo reboot" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "DangerousCommandAsk");

        // Guard off: the ask falls through to FallbackAsk (manual mode).
        let verdict = guard_off.evaluate("bash", &json!({ "command": "sudo reboot" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");

        // Default is on: a snapshot without the field keeps the guard.
        let default = PermissionEngine::new(PolicySnapshot::default());
        let verdict = default.evaluate("bash", &json!({ "command": "sudo reboot" }));
        assert_eq!(verdict.policy_name, "DangerousCommandAsk");
    }

    /// Upstream #3869: a command the analyzer cannot read is approved in auto and
    /// yolo, and asks in manual — v2 returns undefined for auto *before* the
    /// verdict and for yolo *after* it, asking with `unanalyzable_command`
    /// otherwise.
    #[test]
    fn test_unanalyzable_bash_command_asks_except_in_auto_and_yolo() {
        let manual = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let auto = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            ..Default::default()
        });
        let yolo = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });

        for cmd in ["echo \"unterminated", "$CMD --force"] {
            let verdict = manual.evaluate("bash", &json!({ "command": cmd }));
            assert_eq!(verdict.decision, VerdictDecision::Ask, "cmd: {cmd}");
            assert_eq!(verdict.policy_name, "DangerousCommandAsk");
            assert!(
                verdict
                    .reason
                    .as_deref()
                    .is_some_and(|r| r.contains("could not be statically analyzed")),
                "reason: {:?}",
                verdict.reason
            );
        }

        // Auto and yolo fall through to their own approve policies.
        let verdict = auto.evaluate("bash", &json!({ "command": "echo \"unterminated" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "AutoModeApprove");
        let verdict = yolo.evaluate("bash", &json!({ "command": "echo \"unterminated" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");
    }

    // Headless sessions (`kimi -p`, upstream bootstrap `nonInteractive`) skip
    // the DangerousCommandAsk policy: there is no human to answer the prompt,
    // so the remaining policies decide — Auto approves, Manual falls through
    // to the host chain (which for a headless run cannot answer, and the
    // command is denied there).
    #[test]
    fn test_non_interactive_session_skips_dangerous_command_ask() {
        let auto = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            non_interactive: true,
            ..Default::default()
        });
        let verdict = auto.evaluate("bash", &json!({ "command": "sudo reboot" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "AutoModeApprove");
    }

    /// A benign command with a quoted, non-ASCII path is allowed in auto and
    /// yolo and only asks in manual.
    ///
    /// This pins the chain's per-mode verdict for the shape behind the report
    /// "switched to yolo and still got an approval prompt". If the engine starts
    /// asking here, the regression is in the chain; while this stays green and
    /// the CLI prompts anyway, the mode never reached the engine — which is what
    /// the host-side `'plan'` mode used to do (see the snapshot test below).
    #[test]
    fn test_benign_command_verdict_tracks_permission_mode() {
        let cmd = r#"ls "D:\work\示例 项目\src\machines" 2>&1 | head -50"#;
        for (mode, policy, expected) in [
            (PermissionMode::Manual, "FallbackAsk", VerdictDecision::Ask),
            (
                PermissionMode::Auto,
                "AutoModeApprove",
                VerdictDecision::Allow,
            ),
            (
                PermissionMode::Yolo,
                "YoloModeApprove",
                VerdictDecision::Allow,
            ),
        ] {
            let engine = PermissionEngine::new(PolicySnapshot {
                mode,
                ..Default::default()
            });
            // Both spellings reach the chain: the host advertises `Bash`, while
            // the policy DSL also matches the lowercase tool name.
            for tool in ["Bash", "bash"] {
                let verdict = engine.evaluate(tool, &json!({ "command": cmd }));
                assert_eq!(verdict.decision, expected, "{mode:?} / {tool} decision");
                assert_eq!(verdict.policy_name, policy, "{mode:?} / {tool} policy");
            }
        }
    }

    /// Every shape the host's `buildPolicySnapshot` emits must deserialize.
    ///
    /// The napi boundary keeps only the parsed snapshot, so a single rejected
    /// field used to drop the rules *and* the hooks with it and leave the engine
    /// without a local chain — every tool call then round-tripped to the host's
    /// `check_permission`, which prompts in every mode.
    #[test]
    fn test_host_policy_snapshot_shapes_deserialize() {
        let full = json!({
            "mode": "yolo",
            "deny_rules": [],
            "ask_rules": ["Bash(rm *)"],
            "allow_rules": [],
            "session_approvals": [],
            "git_cwd": "/workspace",
            "tools_filter": { "enabled": [], "disabled": [] },
            "pre_tool_hooks": [
                { "event": "PreToolUse", "matcher": "", "command": "echo hi",
                  "timeout": 30, "cwd": null, "env": { "A": "1" } }
            ]
        });
        let minimal = json!({ "mode": "yolo", "deny_rules": [], "ask_rules": [],
                              "allow_rules": [], "session_approvals": [],
                              "git_cwd": null, "pre_tool_hooks": [] });
        // A mode this engine does not model must degrade to `Unknown` rather
        // than failing the whole snapshot, or a host that invents one would
        // silently cost the user their rules and hooks. `plan` is the shape
        // that used to arrive this way (the host folded plan mode into the
        // permission mode); it is not one of v2's `manual | yolo | auto` and no
        // longer sent, but the tolerance stays — an unknown mode gets the
        // manual default, never yolo's auto-approval.
        let plan = json!({ "mode": "plan", "deny_rules": [], "ask_rules": [],
                           "allow_rules": [], "session_approvals": [],
                           "git_cwd": null, "pre_tool_hooks": [] });

        for (label, value, expected) in [
            ("full", &full, PermissionMode::Yolo),
            ("minimal", &minimal, PermissionMode::Yolo),
            ("plan", &plan, PermissionMode::Unknown),
        ] {
            let snapshot: PolicySnapshot = serde_json::from_value(value.clone())
                .unwrap_or_else(|error| panic!("{label} snapshot rejected: {error}"));
            assert_eq!(snapshot.mode, expected, "{label} mode");
        }

        // Nothing else rides on the mode: rules and hooks survive the round
        // trip, so a snapshot can never cost the user their configured policy.
        let snapshot: PolicySnapshot = serde_json::from_value(full).expect("full snapshot");
        assert_eq!(snapshot.ask_rules, vec!["Bash(rm *)".to_string()]);
        assert_eq!(snapshot.pre_tool_hooks.len(), 1);
        assert_eq!(snapshot.pre_tool_hooks[0].timeout, Some(30));
        assert_eq!(
            snapshot.pre_tool_hooks[0]
                .env
                .as_ref()
                .and_then(|env| env.get("A"))
                .map(String::as_str),
            Some("1")
        );

        // An unmodelled mode must not inherit yolo's auto-approval.
        let engine = PermissionEngine::new(serde_json::from_value(plan).expect("plan snapshot"));
        let verdict = engine.evaluate("Bash", &json!({ "command": "ls -la" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask, "unknown mode asks");
    }

    #[test]
    fn test_set_mode_switches_live_verdicts() {
        // Start manual: an ordinary Bash call falls through to FallbackAsk.
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let before = engine.evaluate("Bash", &json!({ "command": "cargo check" }));
        assert_eq!(before.decision, VerdictDecision::Ask);
        assert_eq!(before.policy_name, "FallbackAsk");

        // Live switch to yolo — the same call is now approved without a
        // pipeline rebuild, so a mode change reaches the turn already running.
        engine.set_mode(PermissionMode::Yolo);
        let after = engine.evaluate("Bash", &json!({ "command": "cargo check" }));
        assert_eq!(after.decision, VerdictDecision::Allow);
        assert_eq!(after.policy_name, "YoloModeApprove");
        assert_eq!(engine.mode(), PermissionMode::Yolo);

        // Switching back to manual restores the ask verdict.
        engine.set_mode(PermissionMode::Manual);
        let again = engine.evaluate("Bash", &json!({ "command": "cargo check" }));
        assert_eq!(again.decision, VerdictDecision::Ask);

        // Auto approves outright; a dangerous command still passes (the
        // dangerous-ask policy is skipped before it runs).
        engine.set_mode(PermissionMode::Auto);
        let auto = engine.evaluate("Bash", &json!({ "command": "sudo rm -rf /" }));
        assert_eq!(auto.decision, VerdictDecision::Allow);
        assert_eq!(auto.policy_name, "AutoModeApprove");
    }
}
