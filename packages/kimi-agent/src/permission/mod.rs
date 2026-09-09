//! Local Permission Engine for Kimi Agent (P26 批 3).
//!
//! Evaluates tool execution permissions locally in Rust based on a
//! `PolicySnapshot` injected from the host per turn.
//!
//! Mirrors the 12-policy chain in `agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts`
//! plus a fork-only DangerousCommandAsk policy (ported from kimi-native-tools):
//!   1. AutoModeAskUserQuestionDeny
//!   2. UserConfiguredDeny
//!   3. DangerousCommandAsk (fork-only; asks even in Yolo/Auto for shutdown/reboot/rm -rf/format/sudo …)
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

use globset::Glob;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::native::permission_engine::dangerous_command::{analyze_bash_command, DangerousVerdict};

/// Permission mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    #[default]
    Manual,
    Auto,
    Yolo,
    /// Any mode the engine does not model (e.g. the host's `plan` mode).
    /// Tolerant deserialization prevents an unknown mode from silently
    /// dropping the whole policy snapshot (hooks + rules) at the napi
    /// boundary: the permission chain still sees an explicit mode value,
    /// just one it treats as the manual default.
    #[serde(other)]
    Unknown,
}

/// A user-configured external hook (v2 `HookDefSchema`): an event name, an
/// optional regex `matcher` (empty = match all), the command to run, and an
/// optional timeout in seconds (1-600, default 30).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookDef {
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub matcher: String,
    pub command: String,
    #[serde(default)]
    pub timeout: Option<u64>,
}

/// Snapshot of permission configuration passed from host at step boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// User-configured external hooks (v2 `[hooks]`). The engine executes
    /// the `PreToolUse` ones before native tool calls (G-6 #6); other
    /// events stay host-owned.
    #[serde(default)]
    pub pre_tool_hooks: Vec<HookDef>,
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

pub fn parse_permission_pattern(pattern: &str) -> Option<ParsedRule> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return None;
    }

    // v2 `matchRuleSubjects` treats a leading `!` on a rule as negation
    // ("matches when the subject does NOT match the pattern"). Our engine
    // uses separate `deny_rules` / `ask_rules` / `allow_rules` lists, so
    // the negation semantics do not apply; instead, silently compiling
    // `Bash(!rm *)` into a literal `!rm ` glob would deny almost every
    // command. Refuse such patterns so the caller gets a clear error
    // rather than a foot-gun.
    if trimmed.starts_with('!') {
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
#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub raw_rule: String,
    pub tool_lower: String,
    pub glob: Option<globset::GlobMatcher>,
}

impl CompiledRule {
    pub fn compile(raw_rule: &str) -> Option<Self> {
        let parsed = parse_permission_pattern(raw_rule)?;
        let tool_lower = parsed.tool_name.to_ascii_lowercase();
        let glob = match parsed.arg_pattern {
            Some(ref pat) => Some(Glob::new(pat).ok()?.compile_matcher()),
            None => None,
        };
        Some(Self {
            raw_rule: raw_rule.to_string(),
            tool_lower,
            glob,
        })
    }

    #[inline]
    pub fn matches(&self, tool_name: &str, subject: Option<&str>) -> bool {
        if self.tool_lower != "*" && !self.tool_lower.eq_ignore_ascii_case(tool_name) {
            return false;
        }
        match (&self.glob, subject) {
            (None, _) => true,
            (Some(matcher), Some(subj)) => matcher.is_match(subj),
            (Some(_), None) => false,
        }
    }
}

/// Local permission engine evaluating tool calls against a `PolicySnapshot`.
pub struct PermissionEngine {
    snapshot: PolicySnapshot,
    compiled_deny: Vec<CompiledRule>,
    compiled_ask: Vec<CompiledRule>,
    compiled_allow: Vec<CompiledRule>,
    compiled_session: Vec<CompiledRule>,
}

impl PermissionEngine {
    pub fn new(snapshot: PolicySnapshot) -> Self {
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

        Self {
            snapshot,
            compiled_deny,
            compiled_ask,
            compiled_allow,
            compiled_session,
        }
    }

    /// Evaluate permission for a tool call.
    /// The permission mode of the snapshot (G-6 #7: the goal-start review
    /// gate reads it to decide whether CreateGoal routes to the host).
    pub fn mode(&self) -> PermissionMode {
        self.snapshot.mode
    }

    pub fn evaluate(&self, tool_name: &str, args: &Value) -> LocalPermissionVerdict {
        let tool_lower = tool_name.to_ascii_lowercase();
        let target_subject = extract_rule_subject(&tool_lower, args);

        // 1. AutoModeAskUserQuestionDeny
        if self.snapshot.mode == PermissionMode::Auto
            && matches!(tool_lower.as_str(), "askuserquestion" | "ask_user_question")
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Deny,
                policy_name: "AutoModeAskUserQuestionDeny".into(),
                reason: Some("Auto mode cannot ask interactive questions".into()),
            };
        }

        // 2. UserConfiguredDeny
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_deny, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Deny,
                policy_name: "UserConfiguredDeny".into(),
                reason: Some(format!("Denied by user rule: {rule}")),
            };
        }

        // 3. DangerousCommandAsk: high-risk shell commands must be confirmed even
        //    under Auto/Yolo — mirrors v2 dangerous-command-ask and the native
        //    `evaluate_bash_command` gate (`sudo reboot` refused in Yolo).
        if tool_lower == "bash"
            && let Some(command) = target_subject.as_deref()
            && matches!(analyze_bash_command(command), DangerousVerdict::Dangerous(_))
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "DangerousCommandAsk".into(),
                reason: Some("High-risk shell command requires approval".into()),
            };
        }

        // 4. AutoModeApprove
        if self.snapshot.mode == PermissionMode::Auto {
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
                reason: Some(format!("Approved by session history rule: {rule}")),
            };
        }

        // 6. UserConfiguredAsk
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_ask, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "UserConfiguredAsk".into(),
                reason: Some(format!("Approval required by user rule: {rule}")),
            };
        }

        // 7. UserConfiguredAllow
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_allow, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "UserConfiguredAllow".into(),
                reason: Some(format!("Allowed by user rule: {rule}")),
            };
        }

        // 8. SensitiveFileAccessAsk
        if let Some(path) = target_subject.as_deref()
            && is_sensitive_path(path)
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "SensitiveFileAccessAsk".into(),
                reason: Some(format!(
                    "Access to sensitive file requires approval: {path}"
                )),
            };
        }

        // 9. GitControlPathAccessAsk
        if let Some(path) = target_subject.as_deref()
            && is_git_control_path(path)
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "GitControlPathAccessAsk".into(),
                reason: Some(format!(
                    "Access to git control path requires approval: {path}"
                )),
            };
        }

        // 10. YoloModeApprove
        if self.snapshot.mode == PermissionMode::Yolo {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "YoloModeApprove".into(),
                reason: None,
            };
        }

        // 11. DefaultToolApprove (Read-only tools are approved by default)
        if matches!(
            tool_lower.as_str(),
            "read"
                | "grep"
                | "glob"
                | "listdirectory"
                | "list_directory"
                | "fetchurl"
                | "fetch_url"
                | "websearch"
                | "web_search"
        ) || crate::tools::github::is_readonly_tool(tool_name)
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "DefaultToolApprove".into(),
                reason: None,
            };
        }

        // 12. GitCwdWriteApprove (if git_cwd matches target path write)
        if let Some(ref git_cwd) = self.snapshot.git_cwd
            && let Some(path) = target_subject.as_deref()
            && path.starts_with(git_cwd)
            && !is_git_control_path(path)
            && !is_sensitive_path(path)
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
            reason: Some(format!("Tool execution requires approval: {tool_name}")),
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

/// File-name suffixes that turn a credential / SSH-key basename into a
/// sensitive dot-variant (v2 `SENSITIVE_DOT_VARIANT_SUFFES`).
const SENSITIVE_DOT_VARIANT_SUFFIXES: &[&str] = &[
    "bak", "backup", "copy", "disabled", "key", "old", "orig", "pem", "save", "tmp",
];

/// Basenames that are sensitive on their own (v2 `SENSITIVE_BASENAMES`).
const SENSITIVE_BASENAMES: &[&str] = &[
    ".env", "id_rsa", "id_ed25519", "id_ecdsa", "credentials",
];

/// Basename prefixes that match when followed by `-`, `_`, or a known
/// dot-variant suffix (v2 `SENSITIVE_BASENAME_PREFIXES`).
const SENSITIVE_BASENAME_PREFIXES: &[&str] = &[
    "id_rsa", "id_ed25519", "id_ecdsa", "credentials",
];

/// Exempt basenames — these are NOT sensitive even if they look like they
/// might be (v2 `ENV_EXEMPTIONS` and `PUBLIC_KEY_BASENAMES`).
const ENV_EXEMPT_BASENAMES: &[&str] = &[
    ".env.example", ".env.sample", ".env.template",
];
const PUBLIC_KEY_BASENAMES: &[&str] = &[
    "id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub",
];

/// Path-suffix components that flag a file as sensitive when they appear as
/// a path segment (v2 `SENSITIVE_PATH_SUFFIXES`). The first component
/// carries the leading dot because on disk the directories are hidden
/// (`.aws` / `.gcp`); the join produces `.aws/credentials` and the match
/// is `comparable.contains("/.aws/credentials/")` which catches both the
/// file itself and any sibling under the credentials directory.
const SENSITIVE_PATH_SUFFIXES: &[&[&str]] = &[
    &[".aws", "credentials"],
    &[".gcp", "credentials"],
];

/// True when `path_str` matches a v2 sensitive-file pattern. Mirrors v2
/// `path-access.ts:isSensitiveFile` (the napi fast path lives in
/// `native/path_access.rs`; this is the std fallback the engine uses when
/// the napi bindings are not available).
pub fn is_sensitive_path(path_str: &str) -> bool {
    let comparable = path_str.replace('\\', "/").to_ascii_lowercase();
    let basename = comparable
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(comparable.as_str());

    // Exemptions: `.env.example`/`.sample`/`.template` and the `.pub`
    // counterparts of the SSH key basenames. v2 checks these BEFORE the
    // other branches so the dot-variant and prefix rules do not false-match.
    if ENV_EXEMPT_BASENAMES.contains(&basename) {
        return false;
    }
    if PUBLIC_KEY_BASENAMES.contains(&basename) {
        return false;
    }

    // Exact sensitive basenames.
    if SENSITIVE_BASENAMES.contains(&basename) {
        return true;
    }

    // `.env.<anything>` (`.env.local`, `.env.production`, …).
    if basename.starts_with(".env.") {
        return true;
    }

    // Prefix + separator (`id_rsa-prod`, `credentials_backup`) or
    // prefix + dot-variant (`id_rsa.bak`, `credentials.old`).
    for prefix in SENSITIVE_BASENAME_PREFIXES {
        if basename.len() > prefix.len()
            && basename.starts_with(prefix)
        {
            let suffix = &basename[prefix.len()..];
            let next = suffix.chars().next().unwrap_or('\0');
            if next == '-' || next == '_' {
                return true;
            }
            if next == '.'
                && suffix
                    .strip_prefix('.')
                    .map(|s| SENSITIVE_DOT_VARIANT_SUFFIXES.contains(&s))
                    .unwrap_or(false)
            {
                return true;
            }
        }
    }

    // Path-component suffixes: `.aws/credentials`, `.gcp/credentials` (or
    // their containing directory, e.g. `path/to/.aws/credentials/file`).
    for suffix_parts in SENSITIVE_PATH_SUFFIXES {
        let suffix = suffix_parts.join("/");
        if comparable.ends_with(&format!("/{suffix}"))
            || comparable.contains(&format!("/{suffix}/"))
        {
            return true;
        }
    }

    false
}

pub fn is_git_control_path(path_str: &str) -> bool {
    let normalized = path_str.replace('\\', "/").to_ascii_lowercase();
    normalized == ".git"
        || normalized.contains("/.git/")
        || normalized.ends_with("/.git")
        || normalized.starts_with(".git/")
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
        assert_eq!(verdict_auto.reason, Some("Denied by user rule: Write".into()));
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
        for tool in ["GitHubGetRepo", "GitHubGetPRDiff", "GitHubSearchCode", "GitHubGetMe"] {
            let verdict = engine.evaluate(tool, &json!({ "owner": "octocat", "repo": "hello-world" }));
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

        // In Manual mode, AskUserQuestion falls back to FallbackAsk (not AutoModeAskUserQuestionDeny)
        let engine_manual = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let verdict_manual = engine_manual.evaluate("AskUserQuestion", &json!({}));
        assert_eq!(verdict_manual.decision, VerdictDecision::Ask);
        assert_eq!(verdict_manual.policy_name, "FallbackAsk");
        assert_eq!(
            verdict_manual.reason,
            Some("Tool execution requires approval: AskUserQuestion".into())
        );

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
            session_approvals: vec![
                "Write(src/*.rs)".into(),
                "Bash(cargo test)".into(),
            ],
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
            ask_rules: vec![
                "Write(config/*)".into(),
                "Bash(deploy *)".into(),
            ],
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
            allow_rules: vec![
                "Write(tmp/*)".into(),
                "Bash(npm run lint)".into(),
            ],
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
                Some(format!("Access to git control path requires approval: {path}"))
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
                Some(format!("Access to git control path requires approval: {path}"))
            );
        }

        // Non-git control files should not be flagged as git control paths
        let verdict_gitignore = engine_manual.evaluate("Read", &json!({ "path": ".gitignore" }));
        assert_eq!(verdict_gitignore.decision, VerdictDecision::Allow);
        assert_eq!(verdict_gitignore.policy_name, "DefaultToolApprove");

        let verdict_workflow = engine_manual.evaluate("Read", &json!({ "path": ".github/workflows/ci.yml" }));
        assert_eq!(verdict_workflow.decision, VerdictDecision::Allow);
        assert_eq!(verdict_workflow.policy_name, "DefaultToolApprove");
    }

    #[test]
    fn test_git_cwd_write_approve() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            git_cwd: Some("/workspace/project".into()),
            ..Default::default()
        });

        // 1. Write inside git_cwd is approved by GitCwdWriteApprove
        let verdict = engine.evaluate(
            "Write",
            &json!({ "path": "/workspace/project/src/lib.rs" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "GitCwdWriteApprove");
        assert_eq!(verdict.reason, None);
        assert!(verdict.is_allow());

        // 2. Edit inside git_cwd is approved by GitCwdWriteApprove
        let verdict_edit = engine.evaluate(
            "Edit",
            &json!({ "path": "/workspace/project/Cargo.toml" }),
        );
        assert_eq!(verdict_edit.decision, VerdictDecision::Allow);
        assert_eq!(verdict_edit.policy_name, "GitCwdWriteApprove");
        assert_eq!(verdict_edit.reason, None);

        // 3. Write outside git_cwd falls back to FallbackAsk
        let verdict_outside = engine.evaluate(
            "Write",
            &json!({ "path": "/other/location/file.txt" }),
        );
        assert_eq!(verdict_outside.decision, VerdictDecision::Ask);
        assert_eq!(verdict_outside.policy_name, "FallbackAsk");
        assert_eq!(
            verdict_outside.reason,
            Some("Tool execution requires approval: Write".into())
        );

        // 4. Write inside git_cwd but targeting sensitive file hits SensitiveFileAccessAsk
        let verdict_sensitive = engine.evaluate(
            "Write",
            &json!({ "path": "/workspace/project/.env" }),
        );
        assert_eq!(verdict_sensitive.decision, VerdictDecision::Ask);
        assert_eq!(verdict_sensitive.policy_name, "SensitiveFileAccessAsk");
        assert_eq!(
            verdict_sensitive.reason,
            Some("Access to sensitive file requires approval: /workspace/project/.env".into())
        );

        // 5. Write inside git_cwd but targeting git control path hits GitControlPathAccessAsk
        let verdict_git = engine.evaluate(
            "Write",
            &json!({ "path": "/workspace/project/.git/config" }),
        );
        assert_eq!(verdict_git.decision, VerdictDecision::Ask);
        assert_eq!(verdict_git.policy_name, "GitControlPathAccessAsk");
        assert_eq!(
            verdict_git.reason,
            Some("Access to git control path requires approval: /workspace/project/.git/config".into())
        );
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
        assert_eq!(rule.tool_lower, "write");
        assert!(rule.glob.is_none());
        assert!(rule.matches("write", Some("src/main.rs")));
        assert!(rule.matches("write", None));
        assert!(rule.matches("WRITE", Some("anything")));
        assert!(!rule.matches("read", Some("src/main.rs")));

        // Rule with glob pattern
        let rule = CompiledRule::compile("Write(src/*.rs)").unwrap();
        assert_eq!(rule.tool_lower, "write");
        assert!(rule.glob.is_some());
        assert!(rule.matches("write", Some("src/main.rs")));
        assert!(!rule.matches("write", Some("tests/test.rs")));
        assert!(!rule.matches("write", None));
        assert!(!rule.matches("read", Some("src/main.rs")));

        // Wildcard tool rule `*(*.rs)`
        let rule = CompiledRule::compile("*(*.rs)").unwrap();
        assert_eq!(rule.tool_lower, "*");
        assert!(rule.matches("write", Some("src/main.rs")));
        assert!(rule.matches("read", Some("src/main.rs")));
        assert!(rule.matches("edit", Some("src/lib.rs")));
        assert!(!rule.matches("write", Some("src/main.py")));

        // Invalid glob pattern should fail compilation fast (not silently match everything)
        assert!(CompiledRule::compile("Write([unclosed").is_none());

        // Empty rule fails
        assert!(CompiledRule::compile("").is_none());
    }

    #[test]
    fn test_is_sensitive_path() {
        // Positive cases: .env variants (v2 `ENV_PREFIX` + basenames)
        assert!(is_sensitive_path(".env"));
        assert!(is_sensitive_path(".env.local"));
        assert!(is_sensitive_path(".env.production"));
        assert!(is_sensitive_path(".env.development.local"));
        assert!(is_sensitive_path(".ENV"));
        assert!(is_sensitive_path(".Env.Test"));
        assert!(is_sensitive_path("config/.env"));
        assert!(is_sensitive_path("backend/.env.production"));

        // Positive cases: SSH private keys (v2 `SENSITIVE_BASENAMES`)
        assert!(is_sensitive_path("id_rsa"));
        assert!(is_sensitive_path("id_ed25519"));
        assert!(is_sensitive_path("id_ecdsa"));
        assert!(is_sensitive_path("~/.ssh/id_rsa"));
        assert!(is_sensitive_path("/root/.ssh/id_ed25519"));
        assert!(is_sensitive_path("ID_RSA"));
        // v2 prefix+separator and prefix+dot-variant: id_rsa.bak, id_rsa-prod,
        // credentials_backup, credentials.old, etc.
        assert!(is_sensitive_path("id_rsa.bak"));
        assert!(is_sensitive_path("id_rsa-prod"));
        assert!(is_sensitive_path("id_ed25519.old"));
        assert!(is_sensitive_path("credentials.bak"));
        assert!(is_sensitive_path("credentials_backup"));

        // Positive cases: credentials basenames + path-suffix components
        assert!(is_sensitive_path("credentials"));
        assert!(is_sensitive_path("~/.aws/credentials"));
        assert!(is_sensitive_path("/root/.gcp/credentials"));
        assert!(is_sensitive_path("path/to/.aws/credentials"));
        assert!(is_sensitive_path("path/to/.aws/credentials/extra"));

        // Positive cases: Windows paths (backslashes normalised)
        assert!(is_sensitive_path("C:\\Users\\admin\\.ssh\\id_rsa"));
        assert!(is_sensitive_path("app\\config\\.env.local"));
        assert!(is_sensitive_path("C:\\path\\.aws\\credentials"));

        // Negative cases: exemptions (v2 `ENV_EXEMPTIONS` + `PUBLIC_KEY_BASENAMES`)
        assert!(!is_sensitive_path(".env.example"));
        assert!(!is_sensitive_path(".env.sample"));
        assert!(!is_sensitive_path(".env.template"));
        assert!(!is_sensitive_path("id_rsa.pub"));
        assert!(is_sensitive_path("id_rsa"));
        assert!(!is_sensitive_path("id_ed25519.pub"));
        assert!(!is_sensitive_path("id_ecdsa.pub"));
        assert!(!is_sensitive_path(".ENV.example"));

        // Negative cases: safe non-sensitive files. v2 does NOT flag
        // arbitrary `.pem` / `.key` / `.pfx` — only the dot-variants of
        // `id_rsa` / `id_ed25519` / `id_ecdsa` / `credentials`.
        assert!(!is_sensitive_path("environment.ts"));
        assert!(!is_sensitive_path("dotenv.js"));
        assert!(!is_sensitive_path("environment.json"));
        assert!(!is_sensitive_path("key.txt"));
        assert!(!is_sensitive_path("keyboard.rs"));
        assert!(!is_sensitive_path("README.md"));
        assert!(!is_sensitive_path("src/main.rs"));
        assert!(!is_sensitive_path("server.key"));
        assert!(!is_sensitive_path("cert.pem"));
        assert!(!is_sensitive_path("identity.pfx"));
        assert!(!is_sensitive_path("certs/ca.pem"));
        assert!(!is_sensitive_path("keys/secret.KEY"));
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
            extract_rule_subject("fetch_url", &json!({ "url": "https://api.test/data" })).as_deref(),
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
        assert_eq!(extract_rule_subject("unknown_tool", &json!({ "path": "foo" })), None);
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

    #[test]
    fn test_dangerous_bash_command_asks_in_yolo_and_auto() {
        let yolo = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });
        let auto = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Auto,
            ..Default::default()
        });

        for engine in [&yolo, &auto] {
            for cmd in ["sudo reboot", "shutdown -h now", "rm -rf /", "format C: /q"] {
                let verdict = engine.evaluate("bash", &json!({ "command": cmd }));
                assert_eq!(verdict.decision, VerdictDecision::Ask, "cmd: {cmd}");
                assert_eq!(verdict.policy_name, "DangerousCommandAsk");
            }

            let benign = engine.evaluate("bash", &json!({ "command": "git status" }));
            assert_eq!(benign.decision, VerdictDecision::Allow, "benign command");
        }
    }
}
