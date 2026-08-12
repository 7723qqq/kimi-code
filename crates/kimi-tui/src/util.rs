//! Free-standing helpers extracted from `app.rs`: terminal setup/teardown,
//! command aliasing, `/discuss` argument parsing, markdown export, clipboard
//! copy, and the interrupt-action mapping. No `App` state dependency.

use std::io;

use crossterm::event::{KeyCode, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::app::{TranscriptEntry, TranscriptKind};

/// An interrupt a running turn should react to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InterruptAction {
    /// Abort the current turn via the session cancel flag.
    CancelTurn,
}


/// Generate a fresh session id for `/new` (timestamp-based, unique enough for
/// an interactive session).
pub(crate) fn fresh_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis:x}")
}


/// Map a pressed key to an interrupt action (pure, tested).
pub(crate) fn interrupt_action(code: KeyCode, modifiers: KeyModifiers) -> Option<InterruptAction> {
    match code {
        KeyCode::Esc => Some(InterruptAction::CancelTurn),
        KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
            Some(InterruptAction::CancelTurn)
        }
        _ => None,
    }
}


/// Alias resolution (TS registry aliases parity).
pub(crate) fn resolve_alias(cmd: &str) -> &str {
    match cmd {
        "/yes" => "/yolo",
        "/h" | "/?" => "/help",
        "/q" => "/quit",
        "/rename" => "/title",
        "/task" => "/tasks",
        "/effort" => "/thinking",
        "/providers" => "/provider",
        "/disconnect" => "/logout",
        _ => cmd,
    }
}

/// Parsed `/discuss` arguments.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DiscussArgs {
    pub(crate) topic: String,
    pub(crate) roles: Vec<String>,
    pub(crate) debate: bool,
}


/// Parse `/discuss <topic> [with <r1>,<r2>,...] [--debate]` (TS
/// `parseDiscussArgs` parity, simplified — no role stances). Defaults to
/// the researcher/architect/engineer trio when no roles are given.
pub(crate) fn parse_discuss(args: &str) -> Result<DiscussArgs, &'static str> {
    let trimmed = args.trim();
    if trimmed.is_empty() {
        return Err("usage");
    }
    let (debate, remaining) = match trimmed.strip_prefix("--debate") {
        Some(rest) => (true, rest.trim_start()),
        None => (false, trimmed),
    };
    let with_re = regex::Regex::new(r"(?i)\s+with\s+").expect("valid with-regex");
    let mut parts = with_re.splitn(remaining, 2);
    let topic = parts.next().unwrap_or("").trim();
    let roles_raw = parts.next().unwrap_or("");
    if topic.is_empty() {
        return Err("need-topic");
    }
    let roles: Vec<String> = if roles_raw.is_empty() {
        vec!["researcher".into(), "architect".into(), "engineer".into()]
    } else {
        roles_raw
            .split(',')
            .map(|r| r.trim())
            .filter(|r| !r.is_empty())
            .map(str::to_string)
            .collect()
    };
    if roles.len() < 2 {
        return Err("need-roles");
    }
    Ok(DiscussArgs {
        topic: topic.to_string(),
        roles,
        debate,
    })
}


/// The newest assistant reply's text (TS `findLastAssistantText` parity):
/// sourced from the rendered transcript so it survives compaction.
pub(crate) fn find_last_assistant_text(transcript: &[TranscriptEntry]) -> Option<String> {
    transcript.iter().rev().find_map(|entry| match entry {
        TranscriptEntry::Line(line) if line.kind == TranscriptKind::Assistant => {
            let text = line.text.trim();
            (!text.is_empty()).then(|| line.text.clone())
        }
        _ => None,
    })
}


/// Copy text to the system clipboard.
///
/// Backends: PowerShell `Set-Clipboard` on Windows; `pbcopy` on macOS; on
/// Linux (and other Unix) the first available of `xclip` (with
/// `-selection clipboard`, since it defaults to PRIMARY), `wl-copy` and
/// `pbcopy`. Only when every backend is missing or fails is an error
/// raised.
pub(crate) fn copy_to_clipboard(text: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        // Single-quote escaping: `''` is a literal quote inside a PS string.
        let escaped = text.replace('\'', "''");
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                &format!("Set-Clipboard -Value '{}'", escaped),
            ])
            .status()?;
        if !status.success() {
            anyhow::bail!("Set-Clipboard exited with {status}");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        copy_to_clipboard_unix(text)
    }
}

/// The ordered clipboard backends for this platform (only those found in
/// `$PATH`). On macOS `pbcopy` is the only candidate; on Linux/other Unix
/// X11's `xclip` is preferred over Wayland's `wl-copy`, with `pbcopy` as a
/// final fallback.
#[cfg(not(windows))]
fn clipboard_backends() -> Vec<&'static str> {
    #[cfg(target_os = "macos")]
    {
        vec!["pbcopy"]
    }
    #[cfg(not(target_os = "macos"))]
    {
        ["xclip", "wl-copy", "pbcopy"]
            .into_iter()
            .filter(|name| find_in_path(name).is_some())
            .collect()
    }
}

#[cfg(not(windows))]
fn copy_to_clipboard_unix(text: &str) -> anyhow::Result<()> {
    let mut tried: Vec<&'static str> = Vec::new();
    for backend in clipboard_backends() {
        tried.push(backend);
        if copy_via_backend(backend, text).is_ok() {
            return Ok(());
        }
    }
    anyhow::bail!(
        "no clipboard backend succeeded (tried: {}); install xclip or wl-copy and retry",
        tried.join(", ")
    )
}

/// Feed `text` to a clipboard tool on stdin and wait for it to succeed.
#[cfg(not(windows))]
fn copy_via_backend(backend: &str, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let mut cmd = std::process::Command::new(backend);
    // xclip defaults to the PRIMARY selection; terminal paste reads the
    // CLIPBOARD selection, so target it explicitly.
    if backend == "xclip" {
        cmd.args(["-selection", "clipboard"]);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    // A broken pipe here just means the tool already exited (e.g. wl-copy
    // daemonizing); the exit status below is authoritative.
    let _ = child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(text.as_bytes());
    let status = child.wait()?;
    if !status.success() {
        anyhow::bail!("{backend} exited with {status}");
    }
    Ok(())
}

/// Locate `program` in `$PATH` (None when absent).
#[cfg(not(windows))]
fn find_in_path(program: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}


/// Render the visible transcript as Markdown (simplified `/export-md`).
pub(crate) fn transcript_to_markdown(transcript: &[TranscriptEntry]) -> String {
    let mut md = String::new();
    for entry in transcript {
        match entry {
            TranscriptEntry::Line(line) => match line.kind {
                TranscriptKind::User => md.push_str(&format!("## User\n\n{}\n\n", line.text)),
                TranscriptKind::Assistant | TranscriptKind::Streaming => {
                    md.push_str(&format!("## Assistant\n\n{}\n\n", line.text))
                }
                TranscriptKind::Tool => md.push_str(&format!("```\n{}\n```\n\n", line.text)),
                _ => {}
            },
            TranscriptEntry::ToolCall(tc) => {
                md.push_str(&format!("## Tool: {}\n\n```\n", tc.tool_name));
                if let Some(result) = &tc.result {
                    md.push_str(result);
                }
                md.push_str("\n```\n\n");
            }
            TranscriptEntry::Task(task) => {
                let status = if task.ended { task.status.as_str() } else { "running" };
                let description = if task.description.is_empty() {
                    task.task_id.clone()
                } else {
                    task.description.clone()
                };
                md.push_str(&format!("## Task: {description} ({status})\n\n"));
            }
        }
    }
    md
}


pub(crate) fn init_terminal() -> anyhow::Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    crossterm::execute!(
        stdout,
        EnterAlternateScreen,
        crossterm::event::EnableBracketedPaste
    )?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}


pub(crate) fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> anyhow::Result<()> {
    disable_raw_mode()?;
    crossterm::execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        crossterm::event::DisableBracketedPaste
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupt_action_maps_esc_and_ctrl_c() {
        assert_eq!(
            interrupt_action(KeyCode::Esc, KeyModifiers::empty()),
            Some(InterruptAction::CancelTurn)
        );
        assert_eq!(
            interrupt_action(KeyCode::Char('c'), KeyModifiers::CONTROL),
            Some(InterruptAction::CancelTurn)
        );
        assert_eq!(
            interrupt_action(KeyCode::Char('c'), KeyModifiers::empty()),
            None
        );
    }

    #[test]
    fn alias_resolution_matches_registry() {
        assert_eq!(resolve_alias("/yes"), "/yolo");
        assert_eq!(resolve_alias("/h"), "/help");
        assert_eq!(resolve_alias("/providers"), "/provider");
        assert_eq!(resolve_alias("/unknown"), "/unknown");
    }

    // Clipboard tests shell out to fake backend scripts, so they only run
    // on Unix (Windows uses PowerShell and cannot be mocked cheaply).
    #[cfg(not(windows))]
    mod clipboard {
        use super::*;
        use std::path::{Path, PathBuf};

        /// A scratch dir with fake `xclip`/`wl-copy`/`pbcopy` scripts on the
        /// PATH. Each script appends its argv to `$FAKE_ARGS_FILE` and its
        /// stdin to `$FAKE_OUT_FILE`, or exits 1 when `$FAKE_FAIL` is "1".
        struct FakeBackends {
            dir: PathBuf,
            _guard: EnvGuard,
        }

        struct EnvGuard {
            vars: Vec<(&'static str, Option<std::ffi::OsString>)>,
        }

        impl EnvGuard {
            fn set_all(entries: &[(&'static str, &str)]) -> Self {
                let vars: Vec<(&'static str, Option<std::ffi::OsString>)> = entries
                    .iter()
                    .map(|(name, value)| {
                        let old = std::env::var_os(name);
                        std::env::set_var(name, value);
                        (*name, old)
                    })
                    .collect();
                Self { vars }
            }
        }

        impl Drop for EnvGuard {
            fn drop(&mut self) {
                for (name, old) in &self.vars {
                    match old {
                        Some(value) => std::env::set_var(name, value),
                        None => std::env::remove_var(name),
                    }
                }
            }
        }

        fn install_fake(dir: &Path, name: &str) {
            // Fails exactly once when $FAKE_FAIL_ONCE_FILE exists (then
            // removes it), so the first backend can fail and the next one
            // succeed.
            let script = "#!/bin/sh\n\
if [ -f \"$FAKE_FAIL_ONCE_FILE\" ]; then rm -f \"$FAKE_FAIL_ONCE_FILE\"; exit 1; fi\n\
printf '%s' \"$*\" > \"$FAKE_ARGS_FILE\"\n\
cat > \"$FAKE_OUT_FILE\"\n";
            let path = dir.join(name);
            std::fs::write(&path, script).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&path).unwrap().permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&path, perms).unwrap();
            }
        }

        fn fake_env(backends: &[&str]) -> FakeBackends {
            let dir = std::env::temp_dir().join(format!("kimi-tui-clip-{}", std::process::id()));
            let bin = dir.join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            for name in backends {
                install_fake(&bin, name);
            }
            let args_file = dir.join("args.txt");
            let out_file = dir.join("out.txt");
            let fail_file = dir.join("fail-once");
            let guard = EnvGuard::set_all(&[
                ("PATH", bin.to_str().unwrap()),
                ("FAKE_ARGS_FILE", args_file.to_str().unwrap()),
                ("FAKE_OUT_FILE", out_file.to_str().unwrap()),
                ("FAKE_FAIL_ONCE_FILE", fail_file.to_str().unwrap()),
            ]);
            FakeBackends { dir, _guard: guard }
        }

        fn read(path: &Path) -> String {
            std::fs::read_to_string(path).unwrap_or_default()
        }

        #[cfg(not(target_os = "macos"))]
        #[test]
        fn backend_detection_orders_xclip_then_wl_copy() {
            let _env = fake_env(&["wl-copy", "xclip"]);
            assert_eq!(clipboard_backends(), vec!["xclip", "wl-copy"]);
            let _env2 = fake_env(&["wl-copy"]);
            assert_eq!(clipboard_backends(), vec!["wl-copy"]);
            let _env3 = fake_env(&[]);
            assert!(clipboard_backends().is_empty());
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn macos_hardcodes_pbcopy() {
            let _env = fake_env(&["xclip"]);
            assert_eq!(clipboard_backends(), vec!["pbcopy"]);
        }

        #[test]
        fn copy_feeds_stdin_and_waits_for_success() {
            #[cfg(target_os = "macos")]
            let env = fake_env(&["pbcopy"]);
            #[cfg(not(target_os = "macos"))]
            let env = fake_env(&["xclip"]);
            copy_to_clipboard("hello world").unwrap();
            assert_eq!(read(&env.dir.join("out.txt")), "hello world");
        }

        #[cfg(not(target_os = "macos"))]
        #[test]
        fn xclip_targets_the_clipboard_selection() {
            let env = fake_env(&["xclip"]);
            copy_to_clipboard("x").unwrap();
            let args = read(&env.dir.join("args.txt"));
            assert!(
                args.contains("-selection clipboard"),
                "xclip targets CLIPBOARD, got: {args}"
            );
        }

        #[cfg(not(target_os = "macos"))]
        #[test]
        fn copy_falls_back_when_the_first_backend_fails() {
            let env = fake_env(&["xclip", "wl-copy"]);
            // Let xclip fail once; the copy must fall through to wl-copy.
            std::fs::write(env.dir.join("fail-once"), b"").unwrap();
            copy_to_clipboard("text").unwrap();
            assert_eq!(read(&env.dir.join("out.txt")), "text");
            assert_eq!(read(&env.dir.join("args.txt")), "", "xclip failed first");
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn macos_copy_fails_when_pbcopy_fails() {
            let env = fake_env(&["pbcopy"]);
            std::fs::write(env.dir.join("fail-once"), b"").unwrap();
            let err = copy_to_clipboard("text").unwrap_err();
            let msg = format!("{err:#}");
            assert!(msg.contains("no clipboard backend succeeded"), "msg: {msg}");
        }

        #[test]
        fn copy_errors_when_no_backend_is_available() {
            let env = fake_env(&[]);
            let err = copy_to_clipboard("text").unwrap_err();
            let msg = format!("{err:#}");
            assert!(msg.contains("no clipboard backend succeeded"), "msg: {msg}");
        }
    }
}