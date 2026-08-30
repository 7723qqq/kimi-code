/// Bash tool — execute shell commands.
///
/// Runs commands via the system shell (bash, PowerShell, pwsh, or cmd
/// depending on host detection/configuration).
/// Supports timeouts, working directory, and output capture.
///
/// Mirrors `packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts`.
use napi_derive::napi;
use std::process::Command;
use std::time::{Duration, Instant};

/// Default timeout for foreground commands (seconds).
pub const DEFAULT_TIMEOUT_S: u64 = 60;
/// Maximum timeout for foreground commands (seconds).
pub const MAX_TIMEOUT_S: u64 = 300;

/// Result of a bash command execution.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct BashResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub error: Option<String>,
}

/// Bash command configuration.
pub struct BashConfig {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout: Option<u64>,
    pub env: Option<Vec<(String, String)>>,
}

impl Default for BashConfig {
    fn default() -> Self {
        Self {
            command: String::new(),
            cwd: None,
            timeout: Some(DEFAULT_TIMEOUT_S),
            env: None,
        }
    }
}

/// Execute a shell command.
///
/// Behavior:
///   - On Unix: runs via `/bin/bash -c <command>`.
///   - On Windows: runs via PowerShell 7 / Windows PowerShell / Git Bash or
///     MSYS2 bash / `cmd.exe` (in that order of preference), or the
///     `KIMI_SHELL_PATH` override.
///   - Captures stdout and stderr.
///   - Applies timeout (default 60s, max 300s for foreground).
///   - Returns exit code, stdout, stderr, and timeout flag.
pub fn bash_exec(config: &BashConfig) -> BashResult {
    let timeout = config
        .timeout
        .unwrap_or(DEFAULT_TIMEOUT_S)
        .min(MAX_TIMEOUT_S);

    let (shell, shell_args) = detect_shell_for(&config.command);

    let mut cmd = Command::new(&shell);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    // MSYS2 bash (unlike Git Bash) does not prepend its own /usr/bin to the
    // inherited Windows PATH in non-login mode, so common commands (ls, grep,
    // which, ...) would be "command not found". Prepend the standard POSIX
    // dirs explicitly; harmless on Git Bash / POSIX where they already exist.
    let is_bash = shell_args.len() == 1 && shell_args[0] == "-c";
    let is_powershell = shell_args.iter().any(|a| a == "-Command");
    let mut command = if cfg!(windows) && is_bash {
        format!("export PATH=\"/usr/local/bin:/usr/bin:/bin:$PATH\"; {}", config.command)
    } else {
        config.command.clone()
    };
    // PowerShell parses a statement that opens with a quoted path as a plain
    // string expression (echoes it and exits 0) instead of invoking the
    // program — so `"C:\Program Files\tool\app.exe" arg` silently does nothing.
    // The call operator forces a command invocation.
    if cfg!(windows) && is_powershell && starts_with_quote(&command) {
        command = format!("& {command}");
    }
    cmd.arg(&command);

    // Set working directory.
    if let Some(ref cwd) = config.cwd {
        cmd.current_dir(cwd);
    }

    // Close stdin.
    cmd.stdin(std::process::Stdio::null());

    // Capture stdout and stderr.
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Inject non-interactive environment variables so tools like git / node
    // don't open a pager and paints don't colour the stream. Mirrors the
    // TS BashTool's `noninteractiveEnv` block.
    cmd.env("NO_COLOR", "1");
    cmd.env("TERM", "dumb");
    cmd.env("SHELL", &shell);
    if std::env::var("GIT_TERMINAL_PROMPT").is_err() {
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }

    // Set user-supplied environment variables (override defaults above).
    if let Some(ref env) = config.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    // Run the shell in its own process group so a timeout kill can take the
    // whole tree down (a backgrounded grandchild holding stdout would
    // otherwise keep the pipes open forever and hang the sync call).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Spawn the process.
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return BashResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                error: Some(format!("Failed to spawn process: {}", e)),
            };
        }
    };

    // Drain stdout/stderr on dedicated threads from the start. Without that,
    // a child writing more than the pipe buffer (~64 KB) blocks forever while
    // the poll loop below waits for it to exit — a fake timeout with only the
    // prefix of the output recovered. The drain threads finish as soon as the
    // pipes close (normally right after the process tree is gone).
    let stdout_drain = child.stdout.take().map(drain_pipe);
    let stderr_drain = child.stderr.take().map(drain_pipe);

    let start = Instant::now();
    let timeout_duration = Duration::from_secs(timeout);

    // Wait with timeout using a polling approach.
    // This is cross-platform and doesn't require tokio.
    let mut timed_out = false;
    let mut fatal_error: Option<String> = None;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() >= timeout_duration {
                    // Kill the process tree on timeout: a bare `child.kill()`
                    // only takes the direct child, and a backgrounded
                    // grandchild still holding stdout would block the pipe
                    // read below forever.
                    kill_process_tree(&mut child);
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                kill_process_tree(&mut child);
                fatal_error = Some(format!("Process error: {e}"));
                break None;
            }
        }
    };

    // Collect what the drain threads accumulated. On the timeout/error paths
    // a backgrounded grandchild may keep the pipe open (notably MSYS bash on
    // Windows, where taskkill /T misses it), so bound the wait — blocking
    // here forever would freeze the whole napi call.
    let grace = if timed_out || fatal_error.is_some() {
        Some(POST_KILL_READ_GRACE)
    } else {
        None
    };
    let stdout = collect_pipe(stdout_drain, grace);
    let stderr = collect_pipe(stderr_drain, grace);

    let exit_code = exit_status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

    // Truncate output if too large.
    let stdout = truncate_output(&stdout, MAX_OUTPUT_BYTES);
    let stderr = truncate_output(&stderr, MAX_OUTPUT_BYTES);

    BashResult {
        exit_code,
        stdout,
        stderr,
        timed_out,
        error: fatal_error,
    }
}

/// Maximum output bytes before truncation.
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

fn truncate_output(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        s.to_string()
    } else {
        // Slice on a char boundary: cutting at `max_bytes` directly would
        // panic when it lands inside a multi-byte UTF-8 character.
        let end = s.floor_char_boundary(max_bytes);
        let truncated = &s[..end];
        format!(
            "{}\n\n... (output truncated, {} bytes total)",
            truncated,
            s.len()
        )
    }
}

/// Kill a process and its descendants.
///
/// - Unix: the child was spawned with `process_group(0)`, so signaling the
///   negative pid (the whole group) takes every descendant down.
/// - Windows: `taskkill /T` walks the tree; fall back to `child.kill()`.
pub(crate) fn kill_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Detect the shell to use for a given command.
///
/// On Windows, .bat/.cmd files must be run via `cmd.exe` because Git Bash
/// does not recognize the `.bat` extension. For all other commands, the
/// detection order is: `KIMI_SHELL_PATH` override → PowerShell 7 (`pwsh.exe`)
/// → Windows PowerShell (`powershell.exe`) → Git Bash → `cmd.exe`. PowerShell
/// is preferred over Git Bash so Windows users get native shell semantics.
///
/// Returns the shell executable and the argument prefix (before the command
/// itself). PowerShell gets `-NoProfile -NonInteractive` so user profiles are
/// skipped and nothing waits on interactive input.
pub(crate) fn detect_shell_for(command: &str) -> (String, Vec<String>) {
    #[cfg(unix)]
    {
        let _ = command;
        ("/bin/bash".to_string(), vec!["-c".to_string()])
    }
    #[cfg(windows)]
    {
        if is_bat_command(command) {
            return ("cmd.exe".to_string(), vec!["/c".to_string()]);
        }
        detect_shell()
    }
}

#[cfg(unix)]
fn detect_shell() -> (String, Vec<String>) {
    ("/bin/bash".to_string(), vec!["-c".to_string()])
}

#[cfg(windows)]
fn detect_shell() -> (String, Vec<String>) {
    // Explicit override wins.
    if let Ok(override_path) = std::env::var("KIMI_SHELL_PATH") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return (trimmed.to_string(), shell_args_for(trimmed));
        }
    }

    // PowerShell 7 first — the modern, cross-platform shell.
    if let Some(pwsh) = which("pwsh.exe") {
        return (pwsh, powershell_args());
    }
    // Windows PowerShell — always present on Windows.
    if let Some(powershell) = which("powershell.exe") {
        return (powershell, powershell_args());
    }
    // Git Bash — POSIX compatibility layer (previous default).
    if let Ok(git_bash) = which_bash() {
        return (git_bash, vec!["-c".to_string()]);
    }
    // cmd.exe — last resort, always present.
    ("cmd.exe".to_string(), vec!["/c".to_string()])
}

/// PowerShell invocation prefix: skip user profiles and never wait on
/// interactive input, mirroring the TS BashTool.
#[cfg(windows)]
fn powershell_args() -> Vec<String> {
    vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
    ]
}

/// Pick the argument style for an explicit `KIMI_SHELL_PATH` override based
/// on the executable's basename.
#[cfg(windows)]
fn shell_args_for(path: &str) -> Vec<String> {
    let base = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    if base == "pwsh.exe" || base == "pwsh" || base == "powershell.exe" || base == "powershell" {
        powershell_args()
    } else if base == "cmd.exe" || base == "cmd" {
        vec!["/c".to_string()]
    } else {
        vec!["-c".to_string()]
    }
}

/// Locate an executable on PATH (Windows).
#[cfg(windows)]
fn which(name: &str) -> Option<String> {
    if let Ok(output) = Command::new("where").arg(name).output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = stdout.lines().next() {
                let trimmed = first_line.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

/// Check if the command is invoking a .bat or .cmd file.
///
/// Extracts the first token of the command (before any whitespace or shell
/// operator) and checks if it ends with `.bat` or `.cmd` (case-insensitive).
#[cfg(windows)]
fn is_bat_command(command: &str) -> bool {
    let trimmed = command.trim_start();
    // Find the end of the first token (whitespace or shell operator).
    let first_token: &str = match trimmed.find(|c: char| {
        c.is_whitespace() || c == '|' || c == '&' || c == ';' || c == '>' || c == '<'
    }) {
        Some(idx) => &trimmed[..idx],
        None => trimmed,
    };
    if first_token.is_empty() {
        return false;
    }
    let lower = first_token.to_ascii_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

#[cfg(windows)]
fn which_bash() -> Result<String, ()> {
    // Check common Git Bash and MSYS2 locations. Mirrors the TS probe
    // (environmentProbe.ts locateWindowsGitBash): many Git for Windows
    // installs only ship `usr\bin\bash.exe`, and per-user installs live
    // under %LOCALAPPDATA%\Programs\Git.
    let mut candidates = vec![
        "C:\\Program Files\\Git\\bin\\bash.exe".to_string(),
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe".to_string(),
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe".to_string(),
        "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe".to_string(),
        "C:\\msys64\\usr\\bin\\bash.exe".to_string(),
    ];
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!("{}\\Programs\\Git\\bin\\bash.exe", local_app_data));
        candidates.push(format!("{}\\Programs\\Git\\usr\\bin\\bash.exe", local_app_data));
    }

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return Ok(candidate.clone());
        }
    }

    // Try PATH.
    if let Ok(output) = Command::new("where").arg("bash").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = stdout.lines().next() {
                return Ok(first_line.trim().to_string());
            }
        }
    }

    Err(())
}

use std::io::Read;

/// Spawn a background thread that reads a pipe to EOF and sends the decoded
/// content over a channel. Mirrors the drain behaviour of `read_pipe_to_string`
/// but runs concurrently with the exit-poll loop so the child can never block
/// on a full pipe while we wait for it.
struct PipeDrain {
    receiver: std::sync::mpsc::Receiver<String>,
}

fn drain_pipe<R: Read + Send + 'static>(reader: R) -> PipeDrain {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = read_all(reader, &mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).to_string());
    });
    PipeDrain { receiver: rx }
}

fn read_all<R: Read>(mut reader: R, buf: &mut Vec<u8>) -> std::io::Result<()> {
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

/// Join a drained pipe, optionally bounding the wait. After a timeout kill a
/// backgrounded grandchild may still hold the pipe open (notably MSYS bash on
/// Windows, where `taskkill /T` does not reliably reach it), and a hard
/// blocking wait would freeze the whole napi call. On drop, the drain thread
/// simply leaks until the pipe actually closes.
fn collect_pipe(drain: Option<PipeDrain>, grace: Option<Duration>) -> String {
    match drain {
        None => String::new(),
        Some(d) => match grace {
            Some(deadline) => match d.receiver.recv_timeout(deadline) {
                Ok(out) => out,
                Err(_) => "<output read timed out — a background process still holds the pipe>"
                    .to_string(),
            },
            None => d.receiver.recv().unwrap_or_default(),
        },
    }
}

/// True when the command's first non-whitespace token opens with a quote.
/// PowerShell would otherwise parse such a statement as a string expression.
fn starts_with_quote(command: &str) -> bool {
    matches!(command.trim_start().chars().next(), Some('"') | Some('\''))
}

/// Grace period after the timeout kill before we give up on the pipes.
const POST_KILL_READ_GRACE: Duration = Duration::from_secs(2);

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell the tests run under on this host (Windows prefers
    /// PowerShell; Unix uses bash). Test commands are written to be valid in
    /// both where possible.
    #[cfg(windows)]
    fn is_powershell() -> bool {
        let (shell, _) = detect_shell();
        let base = shell
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&shell)
            .to_ascii_lowercase();
        base == "pwsh.exe" || base == "powershell.exe"
    }

    #[cfg(not(windows))]
    fn is_powershell() -> bool {
        false
    }

    #[test]
    fn test_bash_simple_command() {
        let result = bash_exec(&BashConfig {
            command: "echo hello".to_string(),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hello"));
        assert!(!result.timed_out);
    }

    #[test]
    fn test_bash_stderr() {
        let command = if is_powershell() {
            "Write-Error error; exit 0".to_string()
        } else {
            "echo error >&2".to_string()
        };
        let result = bash_exec(&BashConfig {
            command,
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stderr.contains("error"));
    }

    #[test]
    fn test_bash_nonzero_exit() {
        // `exit 42` works in both PowerShell and POSIX shells.
        let command = "exit 42".to_string();
        let result = bash_exec(&BashConfig {
            command,
            ..Default::default()
        });
        assert_eq!(result.exit_code, 42);
    }

    #[test]
    fn test_bash_with_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let command = if is_powershell() {
            "Get-Location".to_string()
        } else {
            "pwd".to_string()
        };
        let result = bash_exec(&BashConfig {
            command,
            cwd: Some(dir.path().to_str().unwrap().to_string()),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        // On Windows, paths might differ, so just check it doesn't error.
        assert!(result.error.is_none());
    }

    #[test]
    fn test_bash_timeout() {
        let command = if is_powershell() {
            "Start-Sleep -Seconds 10".to_string()
        } else {
            "sleep 10".to_string()
        };
        let result = bash_exec(&BashConfig {
            command,
            timeout: Some(1),
            ..Default::default()
        });
        assert!(result.timed_out);
    }

    #[test]
    fn test_bash_timeout_with_background_grandchild() {
        // Regression: a backgrounded grandchild holding stdout used to keep
        // the pipe open forever after the timeout kill, hanging the sync call.
        // `sleep 30` bounds the worst case if a platform kill ever fails.
        let command = if is_powershell() {
            "Start-Job { Start-Sleep -Seconds 30 }; Start-Sleep -Seconds 30".to_string()
        } else {
            "sleep 30 & sleep 30".to_string()
        };
        let result = bash_exec(&BashConfig {
            command,
            timeout: Some(1),
            ..Default::default()
        });
        assert!(result.timed_out);
    }

    #[test]
    fn test_truncate_output_utf8_boundary() {
        // Regression: slicing at max_bytes used to panic when the boundary
        // fell inside a multi-byte UTF-8 character.
        let text = "中文输出".repeat(200_000);
        let truncated = truncate_output(&text, 512 * 1024);
        assert!(truncated.contains("output truncated"));
        assert!(truncated.starts_with("中文输出"));
    }

    #[test]
    fn test_truncate_output_short() {
        let text = "short";
        assert_eq!(truncate_output(text, 512 * 1024), text);
    }

    #[test]
    fn test_bash_multiline_output() {
        let command = if is_powershell() {
            "'line1\nline2\nline3'".to_string()
        } else {
            "echo 'line1\nline2\nline3'".to_string()
        };
        let result = bash_exec(&BashConfig {
            command,
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("line1"));
        assert!(result.stdout.contains("line2"));
        assert!(result.stdout.contains("line3"));
    }

    #[test]
    fn test_bash_large_output_no_false_timeout() {
        // Regression: output larger than the OS pipe buffer (~64 KB) used to
        // deadlock the poll loop — the child blocks writing, never exits, and
        // the call fake-timed-out at 60 s with only the prefix recovered.
        let command = if is_powershell() {
            "'x' * 300000".to_string()
        } else {
            "yes x | head -c 300000".to_string()
        };
        let result = bash_exec(&BashConfig {
            command,
            timeout: Some(10),
            ..Default::default()
        });
        assert!(!result.timed_out, "stderr: {}", result.stderr);
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout.len(), 300000);
    }

    #[cfg(windows)]
    #[test]
    fn test_bash_quoted_executable_path() {
        // Regression: PowerShell parsed `"C:\Windows\System32\cmd.exe" /c …`
        // as a string expression (echoed back, exit 0) and never ran the
        // program. The call operator must be injected for quoted paths.
        let command = "\"C:\\Windows\\System32\\cmd.exe\" /c echo quoted-path-ok".to_string();
        let result = bash_exec(&BashConfig {
            command,
            // Git Bash / MSYS would otherwise translate the bare `/c` into a
            // Windows path before cmd.exe ever sees it.
            env: Some(vec![("MSYS_NO_PATHCONV".to_string(), "1".to_string())]),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
        assert!(result.stdout.contains("quoted-path-ok"), "stdout: {}", result.stdout);
    }

    #[test]
    fn test_starts_with_quote() {
        assert!(starts_with_quote("\"C:\\app\\x.exe\" arg"));
        assert!(starts_with_quote("  'C:\\app\\x.exe'"));
        assert!(!starts_with_quote("echo hi"));
        assert!(!starts_with_quote(""));
        assert!(!starts_with_quote("   x"));
    }

    #[test]
    fn test_bash_with_env() {
        let command = if is_powershell() {
            "$env:TEST_VAR".to_string()
        } else {
            "echo $TEST_VAR".to_string()
        };
        let result = bash_exec(&BashConfig {
            command,
            env: Some(vec![("TEST_VAR".to_string(), "hello_world".to_string())]),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hello_world"));
    }

    #[test]
    fn test_bash_empty_command() {
        let result = bash_exec(&BashConfig {
            command: String::new(),
            ..Default::default()
        });
        // Empty command should succeed (bash -c '' is valid).
        assert_eq!(result.exit_code, 0);
    }

    #[cfg(windows)]
    #[test]
    fn test_is_bat_command() {
        assert!(is_bat_command("test.bat"));
        assert!(is_bat_command("build.cmd"));
        assert!(is_bat_command("TEST.BAT"));
        assert!(is_bat_command("test.bat arg1 arg2"));
        assert!(is_bat_command("./scripts/run.bat"));
        assert!(is_bat_command("C:\\path\\to\\script.bat"));
        assert!(!is_bat_command("echo hello"));
        assert!(!is_bat_command("bash script.sh"));
        assert!(!is_bat_command(""));
        assert!(!is_bat_command("test.bat.txt"));
    }
}
