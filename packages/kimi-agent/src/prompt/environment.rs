//! Environment disclosure and detection for system prompt generation.
//!
//! Gathers OS, shell path, working directory, and produces the 2-level
//! directory tree (`cwd_listing`) embedded in the primary prompt.

use std::path::Path;

pub const WINDOWS_NOTES: &str =
    "IMPORTANT: You are on Windows. The Bash tool runs through Git Bash, so use Unix shell syntax inside Bash commands — `/dev/null` not `NUL`, and forward slashes in paths. For file operations, always prefer the built-in tools (Read, Write, Edit, Glob, Grep) over Bash commands — they work reliably across all platforms.";

/// Captured environment details for prompt interpolation.
#[derive(Debug, Clone)]
pub struct EnvironmentInfo {
    pub os_kind: String,
    pub shell_name: String,
    pub shell_path: String,
    pub cwd: String,
    pub cwd_listing: String,
    pub windows_notes: String,
}

/// Detect the operating system name matching product conventions.
pub fn detect_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        "Unix"
    }
}

/// Detect shell name and path, honoring explicit overrides and environment variables.
pub fn detect_shell(override_shell: Option<&str>) -> (String, String) {
    if let Some(explicit) = override_shell {
        let p = Path::new(explicit);
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(explicit)
            .trim_end_matches(".exe")
            .to_string();
        return (name, explicit.to_string());
    }

    if let Ok(env_shell) = std::env::var("KIMI_SHELL_PATH")
        && !env_shell.is_empty()
    {
        let p = Path::new(&env_shell);
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&env_shell)
            .trim_end_matches(".exe")
            .to_string();
        return (name, env_shell);
    }

    #[cfg(target_os = "windows")]
    {
        // Common Windows bash locations
        let candidates = [
            "C:\\msys64\\usr\\bin\\bash.exe",
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        ];
        for candidate in candidates {
            if Path::new(candidate).exists() {
                return ("bash".to_string(), candidate.to_string());
            }
        }
        if let Ok(sh) = std::env::var("SHELL")
            && !sh.is_empty()
        {
            return ("bash".to_string(), sh);
        }
        ("bash".to_string(), "bash".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(sh) = std::env::var("SHELL")
            && !sh.is_empty()
        {
            let name = Path::new(&sh)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("sh")
                .to_string();
            return (name, sh);
        }
        ("bash".to_string(), "/bin/bash".to_string())
    }
}

/// Generate the 2-level directory tree for the given workspace path.
pub fn generate_cwd_listing(work_dir: &Path, collapse_hidden: bool) -> String {
    let path_str = work_dir.to_string_lossy().to_string();
    let res = crate::native::native_list_directory(Some(path_str), Some(collapse_hidden));
    if let Some(err) = res.error
        && res.output.is_empty()
    {
        return format!("[not readable: {err}]");
    }
    if res.output.is_empty() {
        "(empty directory)".to_string()
    } else {
        res.output
    }
}

/// Gather complete environment information for the target workspace.
pub fn collect_environment(
    workspace_root: &Path,
    override_shell: Option<&str>,
) -> EnvironmentInfo {
    let os = detect_os();
    let (shell_name, shell_path) = detect_shell(override_shell);
    let cwd = workspace_root.display().to_string().replace('\\', "/");
    let cwd_listing = generate_cwd_listing(workspace_root, true);
    let win_notes = if os == "Windows" {
        format!("\n\n{}\n\n", WINDOWS_NOTES)
    } else {
        String::new()
    };

    EnvironmentInfo {
        os_kind: os.to_string(),
        shell_name,
        shell_path,
        cwd,
        cwd_listing,
        windows_notes: win_notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_detect_os_exact() {
        let os = detect_os();
        #[cfg(target_os = "windows")]
        assert_eq!(os, "Windows");
        #[cfg(target_os = "macos")]
        assert_eq!(os, "macOS");
        #[cfg(target_os = "linux")]
        assert_eq!(os, "Linux");
        assert!(["Windows", "macOS", "Linux", "Unix"].contains(&os));
    }

    #[test]
    fn test_detect_shell_override_and_name_extraction() {
        // POSIX path
        let (name, path) = detect_shell(Some("/bin/zsh"));
        assert_eq!(name, "zsh");
        assert_eq!(path, "/bin/zsh");

        // Windows path with .exe extension: .exe must be trimmed from shell_name
        let (win_name, win_path) = detect_shell(Some("C:\\msys64\\usr\\bin\\bash.exe"));
        assert_eq!(win_name, "bash");
        assert_eq!(win_path, "C:\\msys64\\usr\\bin\\bash.exe");

        // Plain command name with .exe
        let (ps_name, ps_path) = detect_shell(Some("pwsh.exe"));
        assert_eq!(ps_name, "pwsh");
        assert_eq!(ps_path, "pwsh.exe");
    }

    #[test]
    fn test_generate_cwd_listing_empty_and_populated() {
        // Empty directory returns explicit marker
        let empty_temp = tempdir().unwrap();
        let empty_listing = generate_cwd_listing(empty_temp.path(), true);
        assert_eq!(empty_listing, "(empty directory)");

        // Populated directory shows entries
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("foo.txt"), "hello").unwrap();
        std::fs::create_dir(temp.path().join("subdir")).unwrap();
        std::fs::write(temp.path().join("subdir").join("bar.rs"), "fn main() {}").unwrap();

        let listing = generate_cwd_listing(temp.path(), true);
        assert!(listing.contains("subdir/"));
        assert!(listing.contains("foo.txt"));
        assert!(listing.contains("bar.rs"));

        // Non-existent directory returns readable error format
        let non_existent = temp.path().join("missing_directory_abc123");
        let error_listing = generate_cwd_listing(&non_existent, true);
        assert!(error_listing.starts_with("[not readable:"));
    }

    #[test]
    fn test_collect_environment() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("sample.txt"), "content").unwrap();

        let env = collect_environment(temp.path(), Some("/bin/bash"));
        assert_eq!(env.os_kind, detect_os());
        assert_eq!(env.shell_name, "bash");
        assert_eq!(env.shell_path, "/bin/bash");

        let expected_cwd = temp.path().display().to_string().replace('\\', "/");
        assert_eq!(env.cwd, expected_cwd);
        assert!(env.cwd_listing.contains("sample.txt"));

        if cfg!(target_os = "windows") {
            assert_eq!(env.windows_notes, format!("\n\n{}\n\n", WINDOWS_NOTES));
            assert!(env.windows_notes.contains("Git Bash"));
            assert!(env.windows_notes.contains("`/dev/null` not `NUL`"));
        } else {
            assert_eq!(env.windows_notes, "");
        }
    }
}
