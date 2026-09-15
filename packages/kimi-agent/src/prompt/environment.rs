//! Environment disclosure and detection for system prompt generation.
//!
//! Gathers OS, shell path, working directory, and produces the 2-level
//! directory tree (`cwd_listing`) embedded in the primary prompt.

use std::path::Path;

pub const WINDOWS_NOTES: &str = "IMPORTANT: You are on Windows. The Bash tool runs through a POSIX shell (bash), not PowerShell or CMD, so use Unix shell syntax inside Bash commands — `/dev/null` not `NUL`, and forward slashes in paths. For file operations, always prefer the built-in tools (Read, Write, Edit, Glob, Grep) over Bash commands — they work reliably across all platforms.";

/// Captured environment details for prompt interpolation.
#[derive(Debug, Clone)]
pub struct EnvironmentInfo {
    pub os_kind: String,
    pub shell_name: String,
    pub shell_path: String,
    pub cwd: String,
    pub cwd_listing: String,
    pub windows_notes: String,
    pub runtime_notes: String,
}

/// One installed JavaScript runtime visible to the Bash tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsRuntimeInfo {
    pub name: String,
    pub version: String,
    pub path: String,
}

pub const BUN_STDLIB_NOTES: &str = "Bun 1.4 and newer ship built-in modules that replace common npm dependencies: `Bun.Image` (image processing), `Bun.markdown`, `Bun.Terminal` (PTY), `Bun.cron()`, `Bun.WebView` (headless browser). Before installing an npm package for one of these tasks, check whether Bun already provides it. Scripts using these APIs must be executed with the `bun` interpreter.";

/// Whether a Bun version ships the built-in stdlib that replaces common npm
/// dependencies (v2 `isBunStdlibCapable`): major > 1, or 1.x with minor >= 4.
pub fn is_bun_stdlib_capable(version: &str) -> bool {
    let mut parts = version.trim_start_matches('v').split('.');
    let major: u64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor: u64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    major > 1 || (major == 1 && minor >= 4)
}

/// Query `<binary> --version` and return the first whitespace-delimited
/// version token. `bun --version` prints a bare `1.2.3`; node prints
/// `v22.3.0`; deno prints `deno 2.1.0 (...)`.
fn runtime_version(binary: &str) -> Option<String> {
    let output = std::process::Command::new(binary)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.split_whitespace().next()?;
    if binary == "deno" {
        // `deno 2.1.0 (...)`: the version is the second token.
        stdout.split_whitespace().nth(1).map(str::to_string)
    } else {
        Some(first.to_string())
    }
}

/// Look up a binary on PATH. Returns its name and resolved path when found.
fn runtime_on_path(name: &str) -> Option<JsRuntimeInfo> {
    let found = which_binary(name)?;
    let version = runtime_version(&found).unwrap_or_else(|| "unknown".to_string());
    Some(JsRuntimeInfo {
        name: name.to_string(),
        version,
        path: found,
    })
}

fn which_binary(name: &str) -> Option<String> {
    let probe = if cfg!(windows) {
        std::process::Command::new("where")
            .arg(name)
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?
    } else {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {name}"))
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?
    };
    if !probe.status.success() {
        return None;
    }
    String::from_utf8_lossy(&probe.stdout)
        .lines()
        .next()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
}

/// Detect the JavaScript runtimes installed on PATH (v2 `jsRuntimes`): bun,
/// node and deno, in that order. Each probe is best-effort and ignores
/// failures — a runtime that cannot be versioned is simply absent.
pub fn detect_js_runtimes() -> Vec<JsRuntimeInfo> {
    ["bun", "node", "deno"]
        .into_iter()
        .filter_map(runtime_on_path)
        .collect()
}

/// Render the `## JavaScript Runtimes` prompt section (v2
/// `runtimeNotesFor`): empty when no runtime is installed.
pub fn render_runtime_notes(runtimes: &[JsRuntimeInfo]) -> String {
    if runtimes.is_empty() {
        return String::new();
    }
    let listing = runtimes
        .iter()
        .map(|runtime| {
            format!(
                "**{} {}** (`{}`)",
                runtime.name, runtime.version, runtime.path
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let capability_notes = runtimes
        .iter()
        .find(|runtime| runtime.name == "bun")
        .filter(|bun| is_bun_stdlib_capable(&bun.version))
        .map(|_| format!("\n\n{BUN_STDLIB_NOTES}"))
        .unwrap_or_default();
    format!(
        "\n\n## JavaScript Runtimes\n\nJavaScript runtimes available to Bash: {listing}.{capability_notes}\n\n"
    )
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
pub fn collect_environment(workspace_root: &Path, override_shell: Option<&str>) -> EnvironmentInfo {
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
        runtime_notes: render_runtime_notes(&detect_js_runtimes()),
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
            assert!(env.windows_notes.contains("POSIX shell (bash)"));
            assert!(env.windows_notes.contains("`/dev/null` not `NUL`"));
        } else {
            assert_eq!(env.windows_notes, "");
        }
    }

    #[test]
    fn test_bun_stdlib_capability_gate_matches_v2() {
        assert!(is_bun_stdlib_capable("1.4.0"));
        assert!(is_bun_stdlib_capable("1.5.2"));
        assert!(is_bun_stdlib_capable("2.0.0"));
        assert!(is_bun_stdlib_capable("v1.4.1"));
        assert!(!is_bun_stdlib_capable("1.3.9"));
        assert!(!is_bun_stdlib_capable("0.9.0"));
        assert!(!is_bun_stdlib_capable("unknown"));
        assert!(!is_bun_stdlib_capable(""));
    }

    #[test]
    fn test_runtime_notes_empty_without_runtimes() {
        assert_eq!(render_runtime_notes(&[]), "");
    }

    #[test]
    fn test_runtime_notes_lists_runtimes_and_bun_stdlib() {
        let runtimes = vec![
            JsRuntimeInfo {
                name: "bun".into(),
                version: "1.4.0".into(),
                path: "/usr/local/bin/bun".into(),
            },
            JsRuntimeInfo {
                name: "node".into(),
                version: "v22.3.0".into(),
                path: "/usr/local/bin/node".into(),
            },
        ];
        let notes = render_runtime_notes(&runtimes);
        assert!(notes.contains("## JavaScript Runtimes"), "{notes}");
        assert!(
            notes.contains("**bun 1.4.0** (`/usr/local/bin/bun`)"),
            "{notes}"
        );
        assert!(
            notes.contains("**node v22.3.0** (`/usr/local/bin/node`)"),
            "{notes}"
        );
        assert!(
            notes.contains("Bun 1.4 and newer ship built-in modules"),
            "{notes}"
        );
    }

    #[test]
    fn test_runtime_notes_omits_stdlib_notes_for_old_bun() {
        let runtimes = vec![JsRuntimeInfo {
            name: "bun".into(),
            version: "1.3.0".into(),
            path: "/usr/local/bin/bun".into(),
        }];
        let notes = render_runtime_notes(&runtimes);
        assert!(notes.contains("## JavaScript Runtimes"), "{notes}");
        assert!(!notes.contains("Bun 1.4 and newer"), "{notes}");
    }
}
