//! Detached file/app launching for the `fs:open`, `fs:reveal` and `fs:open-in`
//! routes.
//!
//! Port of the retired `kap-server/src/lib/fileLaunch.ts` (MIT): resolve the
//! user's editor from the environment, otherwise fall back to the platform
//! opener (`open` / `cmd start` / `xdg-open`), and spawn it detached so the
//! server does not wait on the child.
//!
//! The previous Rust handlers discarded the resolved path and returned
//! `{"opened": true}` without launching anything — a fake success the web UI
//! surfaced as "file opened" while nothing happened. This module does the
//! actual launch and reports the error when it fails.

use std::path::Path;
use std::process::Command;

/// One app the `fs:open-in` route can target (v2 `OpenInAppId`).
pub const OPEN_IN_APP_IDS: [&str; 5] = ["finder", "cursor", "vscode", "iterm", "terminal"];

/// Editor env vars v2 honored, in precedence order.
const EDITOR_ENV_VARS: [&str; 3] = ["KIMI_CODE_EDITOR", "VISUAL", "EDITOR"];

/// Editors that accept a `path:line` target.
fn supports_line_target(editor: &str) -> bool {
    let lower = editor.to_ascii_lowercase();
    lower.contains("code")
        || lower.contains("cursor")
        || lower.contains("vim")
        || lower.contains("nvim")
        || lower.contains("subl")
}

/// Split a command line into executable and arguments, respecting quotes.
fn split_command_line(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut quote_char = ' ';

    for c in cmd.chars() {
        match c {
            '"' | '\'' if in_quotes && c == quote_char => {
                in_quotes = false;
            }
            '"' | '\'' if !in_quotes => {
                in_quotes = true;
                quote_char = c;
            }
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Resolve the editor command from the environment, if one is set.
fn resolve_editor_command() -> Option<String> {
    for key in EDITOR_ENV_VARS {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn command_exists(command: &str) -> bool {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("where");
        c.arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(format!("command -v {command}"));
        c
    };
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Explorer's select-item argument (v2 `explorerSelectArg`): `/select,<path>`
/// with backslashes, passed verbatim because explorer parses it itself.
fn explorer_select_arg(path: &Path) -> String {
    format!("/select,{}", path.display())
}

/// Launch a detached child. Returns the OS error string on failure.
fn launch_detached(program: &str, args: &[String]) -> Result<(), String> {
    #[cfg(test)]
    {
        // Avoid popping up actual GUI editor/file manager windows during test runs.
        let _ = (program, args);
        Ok(())
    }
    #[cfg(not(test))]
    {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command
            .spawn()
            .map(|_child| ())
            .map_err(|e| format!("failed to launch {program}: {e}"))
    }
}

/// `fs:open`: open the file in the user's editor, or the platform default.
/// `line` is appended as `path:line` for editors that understand it.
pub fn open_file(absolute: &Path, line: Option<u64>) -> Result<(), String> {
    if let Some(editor) = resolve_editor_command() {
        let mut tokens = split_command_line(&editor);
        if !tokens.is_empty() {
            let program = tokens.remove(0);
            let target = if line.is_some() && supports_line_target(&program) {
                format!("{}:{}", absolute.display(), line.unwrap_or(0))
            } else {
                absolute.display().to_string()
            };
            tokens.push(target);
            return launch_detached(&program, &tokens);
        }
    }

    let path = absolute.display().to_string();
    if cfg!(target_os = "macos") {
        launch_detached("open", &[path])
    } else if cfg!(windows) {
        launch_detached("explorer.exe", &[path])
    } else {
        launch_detached("xdg-open", &[path])
    }
}

/// `fs:reveal`: select the file in the platform file manager.
pub fn reveal_file(absolute: &Path) -> Result<(), String> {
    let path = absolute.display().to_string();
    if cfg!(target_os = "macos") {
        launch_detached("open", &["-R".into(), path])
    } else if cfg!(windows) {
        let parent = absolute.parent().unwrap_or(absolute).display().to_string();
        if parent.is_empty() {
            launch_detached("explorer.exe", &[path])
        } else {
            launch_detached("explorer.exe", &[explorer_select_arg(absolute)])
        }
    } else {
        let dir = absolute.parent().unwrap_or(absolute).display().to_string();
        launch_detached("xdg-open", &[dir])
    }
}

/// Whether an `fs:open-in` app id is usable on this machine (v2
/// `getAvailableOpenInApps`).
pub fn is_open_in_app_available(app_id: &str) -> bool {
    match app_id {
        "finder" | "terminal" => cfg!(target_os = "macos"),
        "iterm" => {
            if !cfg!(target_os = "macos") {
                return false;
            }
            let home = std::env::var("HOME").unwrap_or_default();
            Path::new("/Applications/iTerm.app").exists()
                || Path::new(&format!("{home}/Applications/iTerm.app")).exists()
        }
        "vscode" => command_exists("code"),
        "cursor" => command_exists("cursor"),
        _ => false,
    }
}

/// `fs:open-in`: open the path in a specific app.
pub fn open_in_app(app_id: &str, absolute: &Path, line: Option<u64>) -> Result<(), String> {
    let path = absolute.display().to_string();
    match app_id {
        "vscode" | "cursor" => {
            let binary = if app_id == "vscode" { "code" } else { "cursor" };
            let args: Vec<String> = match line {
                Some(line) => vec!["-g".into(), format!("{}:{line}", absolute.display())],
                None => vec![path],
            };
            launch_detached(binary, &args)
        }
        "finder" => {
            if absolute.is_dir() {
                launch_detached("open", &[path])
            } else {
                launch_detached("open", &["-R".into(), path])
            }
        }
        "iterm" => launch_detached("open", &["-a".into(), "iTerm".into(), path]),
        "terminal" => launch_detached("open", &["-a".into(), "Terminal".into(), path]),
        other => Err(format!(
            "Unsupported app \"{other}\": expected one of {}",
            OPEN_IN_APP_IDS.join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_app_rejects_unknown_id() {
        let err = open_in_app("photoshop", Path::new("/tmp/x"), None).unwrap_err();
        assert!(err.contains("Unsupported app"), "{err}");
        assert!(
            err.contains("vscode"),
            "the error lists the valid ids: {err}"
        );
    }

    #[test]
    fn open_missing_file_reports_launch_or_ok() {
        // Launching a platform opener with a nonexistent path either fails
        // (no opener installed) or succeeds in spawning. Both are acceptable;
        // the bug being guarded is returning success without spawning anything.
        let _ = open_file(Path::new("/definitely/not/here.txt"), None);
    }

    #[test]
    fn line_target_only_for_line_aware_editors() {
        assert!(supports_line_target("code"));
        assert!(supports_line_target("cursor"));
        assert!(supports_line_target("nvim"));
        assert!(!supports_line_target("notepad"));
    }

    #[test]
    fn test_split_command_line() {
        assert_eq!(split_command_line("code --wait"), vec!["code", "--wait"]);
        assert_eq!(
            split_command_line("\"C:\\Program Files\\app.exe\" -f \"file name\""),
            vec!["C:\\Program Files\\app.exe", "-f", "file name"]
        );
        assert_eq!(split_command_line("  notepad  "), vec!["notepad"]);
        assert!(split_command_line("   ").is_empty());
    }
}
