//! Native Sandbox Guard Policy (parity with agent-core-v2 sandbox).
//!
//! Provides fail-closed boundary enforcement for mutating tools (`Write`, `Edit`)
//! and code execution according to the active `SandboxMode`:
//! - `Off`: Confinement disabled;
//! - `ReadOnly`: Blocks all writes and code execution;
//! - `WorkspaceWrite`: Allows file writes inside `workspace_root`, blocks writes outside.

use serde::{Deserialize, Serialize};

/// File-effect modes for confined executions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    #[default]
    Off,
    ReadOnly,
    WorkspaceWrite,
}

impl SandboxMode {
    /// Parses a string into `SandboxMode`. Returns `SandboxMode::Off` for unknown values.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "read-only" | "readonly" => SandboxMode::ReadOnly,
            "workspace-write" | "workspacewrite" => SandboxMode::WorkspaceWrite,
            _ => SandboxMode::Off,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            SandboxMode::Off => "off",
            SandboxMode::ReadOnly => "read-only",
            SandboxMode::WorkspaceWrite => "workspace-write",
        }
    }
}

/// Execution policy defining the sandbox mode and allowed workspace boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxExecutionPolicy {
    pub mode: SandboxMode,
    pub workspace_root: String,
}

impl SandboxExecutionPolicy {
    pub fn new(mode: SandboxMode, workspace_root: impl Into<String>) -> Self {
        Self {
            mode,
            workspace_root: workspace_root.into(),
        }
    }

    pub fn off(workspace_root: impl Into<String>) -> Self {
        Self::new(SandboxMode::Off, workspace_root)
    }

    pub fn read_only(workspace_root: impl Into<String>) -> Self {
        Self::new(SandboxMode::ReadOnly, workspace_root)
    }

    pub fn workspace_write(workspace_root: impl Into<String>) -> Self {
        Self::new(SandboxMode::WorkspaceWrite, workspace_root)
    }

    /// Fail-closed guard for tool paths that write to the filesystem (`Write`, `Edit`).
    /// Returns an error explanation when the configured sandbox mode blocks the operation,
    /// or `None` when it is allowed.
    pub fn sandbox_write_guard(&self, target_path: &str) -> Option<String> {
        if self.mode == SandboxMode::Off {
            return None;
        }

        if self.mode == SandboxMode::ReadOnly {
            return Some(format!(
                "Sandbox mode \"{}\" blocks writes to the filesystem. Set `[sandbox] mode = \"off\"` (or \"workspace-write\") to allow writes.",
                self.mode.as_str()
            ));
        }

        if !is_path_within_workspace(target_path, &self.workspace_root) {
            return Some(format!(
                "Sandbox mode \"{}\" blocks writes outside the workspace root \"{}\". Target path \"{}\" is outside it.",
                self.mode.as_str(),
                self.workspace_root,
                target_path
            ));
        }

        None
    }

    /// Guard for code execution (e.g. run_code / bash execution checks).
    pub fn sandbox_code_execution_guard(&self) -> Option<String> {
        if self.mode == SandboxMode::ReadOnly {
            return Some(format!(
                "Sandbox mode \"{}\" blocks code execution (run_code / Bash). Set `[sandbox] mode = \"off\"` to allow it.",
                self.mode.as_str()
            ));
        }
        None
    }
}

/// Normalizes path for boundary comparison:
/// Replaces backslashes with slashes, strips trailing slashes,
/// and on Windows drives (`^[a-zA-Z]:/`) normalizes drive letter to lowercase.
pub fn normalize_path_for_comparison(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    let has_leading_slash = replaced.starts_with('/');

    // Handle Windows drive prefix like C: or c:
    let (prefix, rest) = if replaced.len() >= 2
        && replaced.as_bytes()[0].is_ascii_alphabetic()
        && replaced.as_bytes()[1] == b':'
    {
        let drive = (replaced.as_bytes()[0] as char).to_ascii_lowercase();
        (format!("{drive}:"), &replaced[2..])
    } else {
        (String::new(), replaced.as_str())
    };

    let mut segments = Vec::new();
    for part in rest.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            segments.pop();
        } else {
            segments.push(part);
        }
    }

    let joined = segments.join("/");
    if !prefix.is_empty() {
        if joined.is_empty() {
            prefix
        } else {
            format!("{prefix}/{joined}")
        }
    } else if has_leading_slash {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Checks whether `target_path` is located within or equals `workspace_root`.
pub fn is_path_within_workspace(target_path: &str, workspace_root: &str) -> bool {
    let norm_target = normalize_path_for_comparison(target_path);
    let norm_root = normalize_path_for_comparison(workspace_root);
    if norm_root.is_empty() {
        return false;
    }
    if norm_target == norm_root {
        return true;
    }
    let prefix = format!("{}/", norm_root);
    norm_target.starts_with(&prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_mode_parsing() {
        assert_eq!(SandboxMode::parse("off"), SandboxMode::Off);
        assert_eq!(SandboxMode::parse("read-only"), SandboxMode::ReadOnly);
        assert_eq!(SandboxMode::parse("readonly"), SandboxMode::ReadOnly);
        assert_eq!(SandboxMode::parse("workspace-write"), SandboxMode::WorkspaceWrite);
        assert_eq!(SandboxMode::parse("workspacewrite"), SandboxMode::WorkspaceWrite);
        assert_eq!(SandboxMode::parse("unknown"), SandboxMode::Off);
    }

    #[test]
    fn test_sandbox_write_guard_modes() {
        let root = "/home/user/project";
        let off_policy = SandboxExecutionPolicy::off(root);
        assert!(off_policy.sandbox_write_guard("/home/user/project/file.txt").is_none());
        assert!(off_policy.sandbox_write_guard("/etc/passwd").is_none());

        let ro_policy = SandboxExecutionPolicy::read_only(root);
        let ro_err = ro_policy.sandbox_write_guard("/home/user/project/file.txt");
        assert_eq!(
            ro_err.as_deref(),
            Some("Sandbox mode \"read-only\" blocks writes to the filesystem. Set `[sandbox] mode = \"off\"` (or \"workspace-write\") to allow writes.")
        );

        let ww_policy = SandboxExecutionPolicy::workspace_write(root);
        assert!(ww_policy.sandbox_write_guard("/home/user/project/file.txt").is_none());
        assert!(ww_policy.sandbox_write_guard("/home/user/project/sub/file.txt").is_none());

        let out_err = ww_policy.sandbox_write_guard("/etc/passwd");
        assert_eq!(
            out_err.as_deref(),
            Some("Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"/home/user/project\". Target path \"/etc/passwd\" is outside it.")
        );

        // Sibling dir check
        let sibling_err = ww_policy.sandbox_write_guard("/home/user/project2/file.txt");
        assert_eq!(
            sibling_err.as_deref(),
            Some("Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"/home/user/project\". Target path \"/home/user/project2/file.txt\" is outside it.")
        );

        // Path traversal / escape check
        let traversal_err = ww_policy.sandbox_write_guard("/home/user/project/../sibling.txt");
        assert_eq!(
            traversal_err.as_deref(),
            Some("Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"/home/user/project\". Target path \"/home/user/project/../sibling.txt\" is outside it.")
        );
    }

    #[test]
    fn test_windows_drive_case_normalization() {
        let ww_policy = SandboxExecutionPolicy::workspace_write("C:/workspace/root");
        assert!(ww_policy.sandbox_write_guard("c:/workspace/root/src/main.rs").is_none());
        assert!(ww_policy.sandbox_write_guard("C:\\workspace\\root\\src\\lib.rs").is_none());
        let d_err = ww_policy.sandbox_write_guard("D:/other/file.txt");
        assert_eq!(
            d_err.as_deref(),
            Some("Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"C:/workspace/root\". Target path \"D:/other/file.txt\" is outside it.")
        );
    }
}
