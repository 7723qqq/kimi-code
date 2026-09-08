/// Bash process helpers shared by the managed-shell path.
///
/// The one-shot command execution primitives lived here alongside the
/// managed shell; they are served by `bash_spawn.rs` now. What remains is
/// the shared timeout ceiling (surfaced to JS as napi constants) and the
/// cross-platform process-tree kill.
use std::process::Command;

/// Default timeout for foreground commands (seconds).
pub const DEFAULT_TIMEOUT_S: u64 = 60;
/// Maximum timeout for foreground commands (seconds).
pub const MAX_TIMEOUT_S: u64 = 300;

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
