//! User-configured PreToolUse hooks — native mirror of v2
//! `agentExternalHooksService` (G-6 #6).
//!
//! The user configures `[[hooks]]` entries (event / matcher / command /
//! timeout); the engine executes the `PreToolUse` ones before every native
//! tool call, mirroring v2's `runHook` contract byte for byte: the command
//! runs through the platform shell with the snake_case payload JSON on
//! stdin, exit code 2 or a stdout JSON `permissionDecision: "deny"` blocks
//! the call, and any hook execution failure fails closed. Other hook events
//! stay host-owned.

use std::process::ExitStatus;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::permission::HookDef;
use crate::rpc::types::ToolExecuteRequest;

/// v2 `matchHooks.ts` default timeout.
const DEFAULT_HOOK_TIMEOUT_SECS: u64 = 30;
/// v2 `HookDefSchema` timeout cap.
const MAX_HOOK_TIMEOUT_SECS: u64 = 600;

/// v2 fail-closed messages (`runHook.ts`).
const FAILED_TO_SPAWN: &str = "Permission hook failed to spawn: ";
const TIMED_OUT: &str = "Permission hook timed out";
const ERRORED: &str = "Permission hook errored while running";
/// v2 `matchHooks.ts` fallback when the block reason is empty.
const DEFAULT_DENIAL: &str = "Blocked by PreToolUse hook";

/// The PreToolUse gate: holds the user-configured hooks from the policy
/// snapshot and runs the matching ones before a native tool call.
pub struct HookGuard {
    hooks: Vec<HookDef>,
}

impl HookGuard {
    pub fn new(hooks: Vec<HookDef>) -> Self {
        Self { hooks }
    }

    /// The PreToolUse denial for a native tool call, or `None` to let it
    /// through. Every matching hook runs in parallel (v2 `Promise.all`);
    /// the first block reason in hook order wins.
    pub async fn denial(&self, request: &ToolExecuteRequest) -> Option<String> {
        let mut matched: Vec<HookDef> = Vec::new();
        let mut seen_commands = std::collections::HashSet::new();
        for hook in &self.hooks {
            if hook.event != "PreToolUse" {
                continue;
            }
            if !matcher_matches(&hook.matcher, &request.tool_name) {
                continue;
            }
            // v2 dedupes by command within a single trigger.
            if !seen_commands.insert(hook.command.clone()) {
                continue;
            }
            matched.push(hook.clone());
        }
        if matched.is_empty() {
            return None;
        }
        let payload = hook_payload(request);
        let results =
            futures_util::future::join_all(matched.iter().map(|hook| run_hook(hook, &payload)))
                .await;
        results.into_iter().find_map(|result| result)
    }
}

/// The hook matcher: a regex tested against the tool name; an empty pattern
/// matches everything; an invalid regex is silently skipped (v2
/// `matchHooks.ts`).
fn matcher_matches(pattern: &str, tool_name: &str) -> bool {
    if pattern.is_empty() {
        return true;
    }
    match regex::Regex::new(pattern) {
        Ok(re) => re.is_match(tool_name),
        Err(_) => false,
    }
}

/// The snake_case stdin payload (v2 `runPreToolUse` → `toHookInputData`):
/// the fields the engine can truthfully provide. `session_title` is host
/// metadata the engine does not track (empty), and `client_type` uses the
/// node-platform spelling v2 sends.
fn hook_payload(request: &ToolExecuteRequest) -> Value {
    let tool_input = request
        .arguments
        .as_object()
        .map(|obj| Value::Object(obj.clone()))
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    serde_json::json!({
        "hook_event_name": "PreToolUse",
        "session_id": request.turn_id,
        "cwd": std::env::current_dir()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default(),
        "client_type": platform_string(),
        "session_title": "",
        "tool_name": request.tool_name,
        "tool_input": tool_input,
        "tool_call_id": request.tool_call_id,
    })
}

/// The platform string node reports (`process.platform`): win32 / darwin /
/// linux / ... — v2 sends `bootstrap.clientIdentity.platform`.
fn platform_string() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// Run one hook (v2 `runHook.ts`): platform shell, inherited cwd/env, the
/// payload JSON on stdin, timeout with kill. Returns the block reason, or
/// `None` for an allow verdict.
async fn run_hook(hook: &HookDef, payload: &Value) -> Option<String> {
    let timeout = Duration::from_secs(
        hook.timeout
            .unwrap_or(DEFAULT_HOOK_TIMEOUT_SECS)
            .clamp(1, MAX_HOOK_TIMEOUT_SECS),
    );
    let mut child = match spawn_hook_command(&hook.command) {
        Ok(child) => child,
        Err(e) => return Some(format!("{FAILED_TO_SPAWN}{e}")),
    };

    let payload_json = serde_json::to_string(payload).unwrap_or_else(|_| "{}".into());
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Some(ERRORED.into());
        }
    };
    if let Err(e) = stdin.write_all(payload_json.as_bytes()).await {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Some(format!("{ERRORED}: {e}"));
    }
    drop(stdin);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let status = tokio::select! {
        status = child.wait() => match status {
            Ok(status) => status,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Some(ERRORED.into());
            }
        },
        _ = tokio::time::sleep(timeout) => {
            // v2 sends SIGTERM then SIGKILL; Rust std exposes no SIGTERM
            // for children, so the kill is direct.
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Some(TIMED_OUT.into());
        }
    };

    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    if let Some(mut out) = stdout {
        use tokio::io::AsyncReadExt;
        let _ = out.read_to_end(&mut out_buf).await;
    }
    if let Some(mut err) = stderr {
        use tokio::io::AsyncReadExt;
        let _ = err.read_to_end(&mut err_buf).await;
    }
    let stdout_text = String::from_utf8_lossy(&out_buf);
    let stderr_text = String::from_utf8_lossy(&err_buf);
    evaluate_hook(status, &stdout_text, &stderr_text)
}

/// Spawn the hook command through the platform shell (v2 `spawn(command,
/// { shell: true })`: cmd.exe on Windows, sh elsewhere).
fn spawn_hook_command(command: &str) -> std::io::Result<tokio::process::Child> {
    let mut cmd = if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.spawn()
}

/// The veto decision (v2 `runHook.ts`): exit 2 blocks with stderr, exit 0
/// with a stdout JSON `permissionDecision: "deny"` blocks with its reason;
/// everything else allows. Empty reasons fall back to the v2 default.
fn evaluate_hook(status: ExitStatus, stdout: &str, stderr: &str) -> Option<String> {
    let code = status.code()?;
    if code == 2 {
        return Some(fallback_reason(stderr.trim()));
    }
    if code == 0
        && let Ok(value) = serde_json::from_str::<Value>(stdout)
        && value.get("permissionDecision").and_then(|v| v.as_str()) == Some("deny")
    {
        let reason = value
            .get("permissionDecisionReason")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim();
        return Some(fallback_reason(reason));
    }
    None
}

fn fallback_reason(reason: &str) -> String {
    if reason.is_empty() {
        DEFAULT_DENIAL.into()
    } else {
        reason.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(tool_name: &str) -> ToolExecuteRequest {
        ToolExecuteRequest {
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            tool_name: tool_name.into(),
            arguments: json!({ "path": "a.txt" }),
        }
    }

    fn hook(event: &str, matcher: &str, command: &str) -> HookDef {
        HookDef {
            event: event.into(),
            matcher: matcher.into(),
            command: command.into(),
            timeout: None,
        }
    }

    fn exit_two_with_stderr() -> &'static str {
        if cfg!(windows) {
            "echo denied by test hook 1>&2 & exit /b 2"
        } else {
            "echo denied by test hook >&2; exit 2"
        }
    }

    fn exit_two_silent() -> &'static str {
        if cfg!(windows) { "exit /b 2" } else { "exit 2" }
    }

    fn exit_one() -> &'static str {
        if cfg!(windows) { "exit /b 1" } else { "exit 1" }
    }

    fn sleeper() -> &'static str {
        if cfg!(windows) {
            "ping -n 3 127.0.0.1 >nul"
        } else {
            "sleep 3"
        }
    }

    /// A command that writes a JSON deny to stdout and exits 0. The JSON
    /// rides in a pre-written file (`type` / `cat`) so the command needs no
    /// quoting — cmd's `/C` re-parsing mangles embedded quotes.
    fn json_deny_command(dir: &std::path::Path) -> String {
        let json_file = dir.join("deny.json");
        std::fs::write(
            &json_file,
            r#"{"permissionDecision":"deny","permissionDecisionReason":"blocked by json"}"#,
        )
        .unwrap();
        if cfg!(windows) {
            format!("type {}", json_file.to_string_lossy())
        } else {
            format!("cat {}", json_file.to_string_lossy())
        }
    }

    /// Temp paths may contain spaces, which breaks unquoted shell redirects
    /// and `cmd /C` argument handling. Skip rather than flake.
    fn skip_if_path_has_spaces(path: &std::path::Path) -> bool {
        path.to_string_lossy().contains(' ')
    }

    #[tokio::test]
    async fn no_hooks_and_non_pretooluse_events_pass() {
        let guard = HookGuard::new(vec![
            hook("Stop", "", "exit 2"),
            hook("Notification", "", "exit 2"),
        ]);
        assert_eq!(guard.denial(&request("Read")).await, None);
        let empty = HookGuard::new(vec![]);
        assert_eq!(empty.denial(&request("Read")).await, None);
    }

    #[tokio::test]
    async fn matcher_filters_tools() {
        let guard = HookGuard::new(vec![hook("PreToolUse", "Wri", exit_two_with_stderr())]);
        assert!(
            guard.denial(&request("Write")).await.is_some(),
            "matcher hit must run the hook"
        );
        assert_eq!(
            guard.denial(&request("Read")).await,
            None,
            "matcher miss must skip the hook"
        );
    }

    #[tokio::test]
    async fn invalid_matcher_is_silently_skipped() {
        let guard = HookGuard::new(vec![hook("PreToolUse", "[", exit_two_with_stderr())]);
        assert_eq!(guard.denial(&request("Write")).await, None);
    }

    #[tokio::test]
    async fn exit_two_blocks_with_stderr_reason() {
        let guard = HookGuard::new(vec![hook("PreToolUse", "", exit_two_with_stderr())]);
        let denial = guard.denial(&request("Write")).await;
        assert_eq!(denial.as_deref(), Some("denied by test hook"));
    }

    #[tokio::test]
    async fn exit_two_with_empty_stderr_falls_back_to_default() {
        let guard = HookGuard::new(vec![hook("PreToolUse", "", exit_two_silent())]);
        assert_eq!(
            guard.denial(&request("Write")).await.as_deref(),
            Some(DEFAULT_DENIAL)
        );
    }

    #[tokio::test]
    async fn json_deny_on_stdout_blocks() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let guard = HookGuard::new(vec![hook("PreToolUse", "", &json_deny_command(dir.path()))]);
        assert_eq!(
            guard.denial(&request("Write")).await.as_deref(),
            Some("blocked by json")
        );
    }

    #[tokio::test]
    async fn other_exit_codes_allow() {
        let guard = HookGuard::new(vec![hook("PreToolUse", "", exit_one())]);
        assert_eq!(guard.denial(&request("Write")).await, None);
    }

    #[tokio::test]
    async fn timeout_fails_closed() {
        let guard = HookGuard::new(vec![HookDef {
            event: "PreToolUse".into(),
            matcher: String::new(),
            command: sleeper().into(),
            timeout: Some(1),
        }]);
        assert_eq!(
            guard.denial(&request("Write")).await.as_deref(),
            Some(TIMED_OUT)
        );
    }

    #[tokio::test]
    async fn commands_dedupe_within_one_trigger() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let marker = dir.path().join("marker.txt");
        let command = format!("echo 1 >> {}", marker.to_string_lossy());
        let guard = HookGuard::new(vec![
            hook("PreToolUse", "Wri", &command),
            hook("PreToolUse", ".*", &command),
        ]);
        let _ = guard.denial(&request("Write")).await;
        let runs = std::fs::read_to_string(&marker).unwrap_or_default();
        assert_eq!(
            runs.lines().count(),
            1,
            "identical commands must run once per trigger"
        );
    }

    #[test]
    fn payload_uses_the_snake_case_wire_shape() {
        let payload = hook_payload(&request("Write"));
        assert_eq!(payload["hook_event_name"], "PreToolUse");
        assert_eq!(payload["session_id"], "turn-1");
        assert_eq!(payload["tool_name"], "Write");
        assert_eq!(payload["tool_call_id"], "call-1");
        assert_eq!(payload["tool_input"]["path"], "a.txt");
        assert!(payload["cwd"].as_str().is_some_and(|c| !c.is_empty()));
        assert!(
            payload["client_type"]
                .as_str()
                .is_some_and(|c| !c.is_empty())
        );
        assert_eq!(payload["session_title"], "");
    }

    #[test]
    fn non_object_tool_input_falls_back_to_empty_object() {
        let req = ToolExecuteRequest {
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            tool_name: "Bash".into(),
            arguments: json!("just a string"),
        };
        assert_eq!(hook_payload(&req)["tool_input"], json!({}));
    }
}
