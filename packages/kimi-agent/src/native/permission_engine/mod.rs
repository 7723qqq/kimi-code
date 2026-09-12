//! 权限策略判定引擎。
//!
//! 实现工具调用权限决策流程，支持读取 `.kimi/permissions.json` 规则，
//! 并在非自动批准模式下支持终端交互式确认。

pub mod dangerous_command;

use dangerous_command::{DangerousVerdict, analyze_bash_command};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// 权限判定决议
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Deny,
    AskUser,
}

/// 权限配置映射
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionConfig {
    pub deny_patterns: Vec<String>,
    pub allow_patterns: Vec<String>,
    pub yolo_mode: bool,
}

/// 会话级临时审批历史（记忆用户在本次会话中手动放行的操作）
#[derive(Debug, Default)]
pub struct SessionApprovalHistory {
    approved_targets: RwLock<HashSet<(String, PathBuf)>>,
    approved_tools: RwLock<HashSet<String>>,
}

impl SessionApprovalHistory {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录批准针对特定路径的工具操作
    pub fn record_approval(&self, tool_name: &str, path: Option<&Path>) {
        if let Some(p) = path {
            if let Ok(mut set) = self.approved_targets.write() {
                set.insert((tool_name.to_lowercase(), p.to_path_buf()));
            }
        } else if let Ok(mut set) = self.approved_tools.write() {
            set.insert(tool_name.to_lowercase());
        }
    }

    /// 检查是否在本次会话中已有批准历史
    pub fn is_approved(&self, tool_name: &str, path: Option<&Path>) -> bool {
        let tool_lower = tool_name.to_lowercase();
        if let Some(p) = path
            && let Ok(set) = self.approved_targets.read()
            && set.contains(&(tool_lower.clone(), p.to_path_buf()))
        {
            return true;
        }
        if let Ok(set) = self.approved_tools.read()
            && set.contains(&tool_lower)
        {
            return true;
        }
        false
    }

    /// 清空会话审批记录（会话重置或切出时调用）
    pub fn clear(&self) {
        if let Ok(mut set) = self.approved_targets.write() {
            set.clear();
        }
        if let Ok(mut set) = self.approved_tools.write() {
            set.clear();
        }
    }
}

/// 原生权限决策评估器
pub struct PermissionEngine {
    config: PermissionConfig,
    deny_matcher: GlobSet,
    workspace_root: PathBuf,
    approval_history: SessionApprovalHistory,
}

impl PermissionEngine {
    /// 构造权限引擎，并载入工作区配置
    pub fn new<P: AsRef<Path>>(
        workspace_root: P,
        config_path: Option<P>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let config: PermissionConfig = if let Some(path) = config_path {
            if path.as_ref().exists() {
                let content = fs::read_to_string(path)?;
                serde_json::from_str(&content)?
            } else {
                Self::default_config()
            }
        } else {
            Self::default_config()
        };

        let mut builder = GlobSetBuilder::new();
        for pattern in &config.deny_patterns {
            builder.add(Glob::new(pattern)?);
        }
        let deny_matcher = builder.build()?;

        Ok(Self {
            config,
            deny_matcher,
            workspace_root: workspace_root.as_ref().to_path_buf(),
            approval_history: SessionApprovalHistory::new(),
        })
    }

    /// 默认基础安全配置（用户未显式配置时规则为空，系统级保护由 is_sensitive_file 与 .git 拦截兜底）
    fn default_config() -> PermissionConfig {
        PermissionConfig {
            deny_patterns: vec![],
            allow_patterns: vec![],
            yolo_mode: false,
        }
    }

    /// 获取会话审批历史记录引用
    pub fn approval_history(&self) -> &SessionApprovalHistory {
        &self.approval_history
    }

    /// 严格按照策略链顺序评估工具调用
    pub fn evaluate_tool_call(
        &self,
        tool_name: &str,
        target_path: Option<&Path>,
    ) -> PermissionDecision {
        // 1. 优先检查环境变量覆盖
        if std::env::var("KIMI_AUTO_APPROVE")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false)
        {
            return PermissionDecision::Allow;
        }

        // 2. 路径判定（若为 None，直接跳过路径判定，走默认 AskUser）
        if let Some(path) = target_path {
            // 工作区越界逃逸检测
            if !path.starts_with(&self.workspace_root) {
                return PermissionDecision::Deny;
            }

            // Deny 规则匹配拦截
            if self.deny_matcher.is_match(path) {
                return PermissionDecision::Deny;
            }

            // .git 核心控制目录防篡改
            if path.components().any(|c| c.as_os_str() == ".git")
                && (tool_name == "write" || tool_name == "edit" || tool_name == "bash")
            {
                return PermissionDecision::Deny;
            }

            let path_str = path.to_string_lossy();
            // 敏感文件防护（对齐 TS SensitiveFileAccessAsk 策略）
            if crate::native::path_access::is_sensitive_file(&path_str) {
                if tool_name == "write" || tool_name == "edit" || tool_name == "bash" {
                    return PermissionDecision::Deny;
                } else {
                    // 读敏感文件强制人工审批（Yolo 模式前拦截）
                    return PermissionDecision::AskUser;
                }
            }
        }

        // 3. 检查会话级历史审批记忆（已放行的同类安全操作无需重复弹窗确认）
        if self.approval_history.is_approved(tool_name, target_path) {
            return PermissionDecision::Allow;
        }

        // 4. Yolo 模式分支
        if self.config.yolo_mode {
            return PermissionDecision::Allow;
        }

        // 5. 默认策略分支：只读及回合启动放行，写操作交互确认
        match tool_name {
            "read" | "grep" | "glob" | "agent_turn" => PermissionDecision::Allow,
            "write" | "edit" | "bash" => PermissionDecision::AskUser,
            _ => PermissionDecision::AskUser,
        }
    }

    /// 评估 Bash 命令执行权限，集成高危命令识别与 Yolo 模式安全底线兜底
    pub fn evaluate_bash_command(&self, command: &str) -> PermissionDecision {
        // 1. 优先进行高危系统命令词法检测（关机、格式化、dd覆写等）
        if let DangerousVerdict::Dangerous(_cmd) = analyze_bash_command(command) {
            // 高危系统指令不适用于 Yolo 模式自动放行，返回 AskUser 要求人工确认
            return PermissionDecision::AskUser;
        }

        // 2. 检查环境变量自动放行覆盖（非高危指令）
        if std::env::var("KIMI_AUTO_APPROVE")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false)
        {
            return PermissionDecision::Allow;
        }

        // 3. 检查会话级全局 Bash 授权记忆
        if self.approval_history.is_approved("bash", None) {
            return PermissionDecision::Allow;
        }

        // 4. Yolo 模式放行常规 Bash 命令
        if self.config.yolo_mode {
            return PermissionDecision::Allow;
        }

        // 5. 默认策略：Bash 命令执行需人工确认
        PermissionDecision::AskUser
    }

    /// 执行审批评估并在必要时通过终端 CLI 阻塞询问用户
    pub fn prompt_user_if_needed(&self, tool_name: &str, path: Option<&Path>) -> bool {
        match self.evaluate_tool_call(tool_name, path) {
            PermissionDecision::Allow => true,
            PermissionDecision::Deny => false,
            PermissionDecision::AskUser => {
                let prompt = format!(
                    "Tool '{}' requests action on '{:?}'. Approve execution?",
                    tool_name,
                    path.unwrap_or_else(|| Path::new("N/A"))
                );
                let approved = dialoguer::Confirm::new()
                    .with_prompt(prompt)
                    .default(false)
                    .interact()
                    .unwrap_or(false);
                if approved {
                    self.approval_history.record_approval(tool_name, path);
                }
                approved
            }
        }
    }

    /// 获取工作区根目录路径
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_git_config_write_denied() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let engine =
            PermissionEngine::new(&root, None).expect("PermissionEngine should initialize");

        let git_config_path = root.join(".git").join("config");
        let verdict = engine.evaluate_tool_call("write", Some(&git_config_path));
        assert_eq!(verdict, PermissionDecision::Deny);

        let git_edit_verdict = engine.evaluate_tool_call("edit", Some(&git_config_path));
        assert_eq!(git_edit_verdict, PermissionDecision::Deny);
    }

    #[test]
    fn test_yolo_mode_refuses_dangerous_reboot() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let mut engine =
            PermissionEngine::new(&root, None).expect("PermissionEngine should initialize");
        engine.config.yolo_mode = true;

        // 常规安全命令在 Yolo 下直接放行
        assert_eq!(
            engine.evaluate_bash_command("git status"),
            PermissionDecision::Allow
        );
        assert_eq!(
            engine.evaluate_bash_command("cargo check"),
            PermissionDecision::Allow
        );

        // 断言：高危系统命令在 Yolo 模式下依然返回 AskUser 进行人工确认
        assert_eq!(
            engine.evaluate_bash_command("sudo reboot"),
            PermissionDecision::AskUser
        );
        assert_eq!(
            engine.evaluate_bash_command("shutdown -h now"),
            PermissionDecision::AskUser
        );
        assert_eq!(
            engine.evaluate_bash_command("format C: /q"),
            PermissionDecision::AskUser
        );
    }

    #[test]
    fn test_sensitive_file_read_ask_and_write_deny() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let engine =
            PermissionEngine::new(&root, None).expect("PermissionEngine should initialize");

        // 1. .env.example 白名单豁免，read 正常允许
        let example_path = root.join(".env.example");
        assert_eq!(
            engine.evaluate_tool_call("read", Some(&example_path)),
            PermissionDecision::Allow
        );

        // 2. .env 敏感文件读取必须拦截为 AskUser
        let env_path = root.join(".env");
        assert_eq!(
            engine.evaluate_tool_call("read", Some(&env_path)),
            PermissionDecision::AskUser
        );

        // 3. .env 敏感文件写入强制拦截为 Deny
        assert_eq!(
            engine.evaluate_tool_call("write", Some(&env_path)),
            PermissionDecision::Deny
        );
    }

    #[test]
    fn test_session_approval_history_memory() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let engine =
            PermissionEngine::new(&root, None).expect("PermissionEngine should initialize");

        let target_file = root.join("src").join("index.ts");

        // 初始状态下，write 操作需要 AskUser
        assert_eq!(
            engine.evaluate_tool_call("write", Some(&target_file)),
            PermissionDecision::AskUser
        );

        // 模拟用户在当前会话中批准该路径的 write 操作
        engine
            .approval_history()
            .record_approval("write", Some(&target_file));

        // 再次评估相同工具和路径，应当自动通过会话记忆放行
        assert_eq!(
            engine.evaluate_tool_call("write", Some(&target_file)),
            PermissionDecision::Allow
        );

        // 评估未批准的其他路径，依然需要 AskUser
        let other_file = root.join("src").join("other.ts");
        assert_eq!(
            engine.evaluate_tool_call("write", Some(&other_file)),
            PermissionDecision::AskUser
        );

        // 会话记忆无法绕过安全底线：如敏感文件 write 依然被 Deny
        let env_path = root.join(".env");
        engine
            .approval_history()
            .record_approval("write", Some(&env_path));
        assert_eq!(
            engine.evaluate_tool_call("write", Some(&env_path)),
            PermissionDecision::Deny
        );

        // 清空会话记忆后，再次变为 AskUser
        engine.approval_history().clear();
        assert_eq!(
            engine.evaluate_tool_call("write", Some(&target_file)),
            PermissionDecision::AskUser
        );
    }
}
