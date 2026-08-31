//! Local Permission Engine for Kimi Agent (P26 批 3).
//!
//! Evaluates tool execution permissions locally in Rust based on a
//! `PolicySnapshot` injected from the host per turn.
//!
//! Mirrors the 12-policy chain in `agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts`:
//!   1. AutoModeAskUserQuestionDeny
//!   2. UserConfiguredDeny
//!   3. AutoModeApprove
//!   4. SessionApprovalHistory
//!   5. UserConfiguredAsk
//!   6. UserConfiguredAllow
//!   7. SensitiveFileAccessAsk
//!   8. GitControlPathAccessAsk
//!   9. YoloModeApprove
//!  10. DefaultToolApprove (Read-only tools)
//!  11. GitCwdWriteApprove
//!  12. FallbackAsk

use globset::Glob;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Permission mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    #[default]
    Manual,
    Auto,
    Yolo,
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

    let Some(open_idx) = trimmed.find('(') else {
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
        let glob = parsed
            .arg_pattern
            .and_then(|pat| Glob::new(&pat).ok())
            .map(|g| g.compile_matcher());
        Some(Self {
            raw_rule: raw_rule.to_string(),
            tool_lower,
            glob,
        })
    }

    #[inline]
    pub fn matches(&self, tool_lower: &str, subject: Option<&str>) -> bool {
        if self.tool_lower != "*" && self.tool_lower != tool_lower {
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

        // 3. AutoModeApprove
        if self.snapshot.mode == PermissionMode::Auto {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "AutoModeApprove".into(),
                reason: None,
            };
        }

        // 4. SessionApprovalHistory
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

        // 5. UserConfiguredAsk
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_ask, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Ask,
                policy_name: "UserConfiguredAsk".into(),
                reason: Some(format!("Approval required by user rule: {rule}")),
            };
        }

        // 6. UserConfiguredAllow
        if let Some(rule) =
            Self::matches_any_rule(&self.compiled_allow, &tool_lower, target_subject.as_deref())
        {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "UserConfiguredAllow".into(),
                reason: Some(format!("Allowed by user rule: {rule}")),
            };
        }

        // 7. SensitiveFileAccessAsk
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

        // 8. GitControlPathAccessAsk
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

        // 9. YoloModeApprove
        if self.snapshot.mode == PermissionMode::Yolo {
            return LocalPermissionVerdict {
                decision: VerdictDecision::Allow,
                policy_name: "YoloModeApprove".into(),
                reason: None,
            };
        }

        // 10. DefaultToolApprove (Read-only tools are approved by default)
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

        // 11. GitCwdWriteApprove (if git_cwd matches target path write)
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

        // 12. FallbackAsk
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

pub fn is_sensitive_path(path_str: &str) -> bool {
    let normalized = path_str.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();

    for seg in &segments {
        let lower = seg.to_ascii_lowercase();
        if lower == ".env" || lower.starts_with(".env.") {
            return true;
        }
        if lower == "id_rsa" || lower == "id_ed25519" || lower == "id_ecdsa" || lower == "id_dsa" {
            return true;
        }
        if lower.ends_with(".pem") || lower.ends_with(".key") || lower.ends_with(".pfx") {
            return true;
        }
    }
    false
}

pub fn is_git_control_path(path_str: &str) -> bool {
    let normalized = path_str.replace('\\', "/");
    normalized.contains("/.git/")
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
        let verdict = engine.evaluate("Write", &json!({ "path": "src/main.rs" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "YoloModeApprove");
    }

    #[test]
    fn test_yolo_mode_still_intercepts_sensitive_files() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            ..Default::default()
        });
        let verdict = engine.evaluate("Read", &json!({ "path": ".env" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "SensitiveFileAccessAsk");
    }

    #[test]
    fn test_user_configured_deny_overrides_yolo() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Yolo,
            deny_rules: vec!["Bash(rm -rf *)".into()],
            ..Default::default()
        });
        let verdict = engine.evaluate("Bash", &json!({ "command": "rm -rf /" }));
        assert_eq!(verdict.decision, VerdictDecision::Deny);
        assert_eq!(verdict.policy_name, "UserConfiguredDeny");
    }

    #[test]
    fn test_default_tool_approve_for_read_only() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let verdict = engine.evaluate("Read", &json!({ "path": "package.json" }));
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "DefaultToolApprove");
    }

    #[test]
    fn test_manual_mode_fallback_ask_for_write() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let verdict = engine.evaluate("Write", &json!({ "path": "package.json" }));
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");
    }

    #[test]
    fn test_readonly_github_tools_approved_by_default() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let verdict = engine.evaluate(
            "GitHubGetRepo",
            &json!({ "owner": "octocat", "repo": "hello-world" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Allow);
        assert_eq!(verdict.policy_name, "DefaultToolApprove");
    }

    #[test]
    fn test_mutating_github_tools_fall_back_to_ask() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            ..Default::default()
        });
        let verdict = engine.evaluate(
            "GitHubCreateIssue",
            &json!({ "owner": "octocat", "repo": "hello-world", "title": "t" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");
    }

    #[test]
    fn test_github_subject_rules_match() {
        let engine = PermissionEngine::new(PolicySnapshot {
            mode: PermissionMode::Manual,
            deny_rules: vec!["GitHubCreateIssue(octocat/hello-world)".into()],
            ..Default::default()
        });
        let verdict = engine.evaluate(
            "GitHubCreateIssue",
            &json!({ "owner": "octocat", "repo": "hello-world", "title": "t" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Deny);
        assert_eq!(verdict.policy_name, "UserConfiguredDeny");
        // A different repo does not match the subject-scoped rule.
        let verdict = engine.evaluate(
            "GitHubCreateIssue",
            &json!({ "owner": "other", "repo": "repo", "title": "t" }),
        );
        assert_eq!(verdict.decision, VerdictDecision::Ask);
        assert_eq!(verdict.policy_name, "FallbackAsk");
    }
}
