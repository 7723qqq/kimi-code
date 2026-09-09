//! User-configured external hooks — native mirror of v2
//! `agentExternalHooksService` (G-6 #6).
//!
//! The user configures `[[hooks]]` entries (event / matcher / command /
//! timeout); the engine executes them directly: `PreToolUse` gates every
//! native tool call (mirroring v2's `runHook` contract byte for byte: the
//! command runs through the platform shell with the snake_case payload JSON
//! on stdin, exit code 2 or a stdout JSON `permissionDecision: "deny"`
//! blocks the call, and any hook execution failure fails closed),
//! `PostToolUse` / `PostToolUseFailure` and `UserPromptSubmit` /
//! `PreCompact` fire observe-only notifications, and `Stop` hooks can veto
//! a clean text stop once per turn (v2 `runStopHooks`).

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

/// The PreToolUse gate: holds the user-configured hooks from the policy
/// snapshot and runs the matching ones before a native tool call.
pub struct HookGuard {
    hooks: Vec<HookDef>,
}

impl HookGuard {
    pub fn new(hooks: Vec<HookDef>) -> Self {
        Self { hooks }
    }

    /// Hooks matching an event + tool-name target, deduped by command
    /// within a single trigger (v2 `matchHooks` dedups on cwd + command).
    fn matched_hooks(&self, event: &str, target: &str) -> Vec<HookDef> {
        let mut matched: Vec<HookDef> = Vec::new();
        let mut seen_commands = std::collections::HashSet::new();
        for hook in &self.hooks {
            if hook.event != event {
                continue;
            }
            if !matcher_matches(&hook.matcher, target) {
                continue;
            }
            // v2 dedupes by command within a single trigger.
            if !seen_commands.insert((hook.cwd.clone(), hook.command.clone())) {
                continue;
            }
            matched.push(hook.clone());
        }
        matched
    }

    /// The PreToolUse denial for a native tool call, or `None` to let it
    /// through. Every matching hook runs in parallel (v2 `Promise.all`);
    /// the first block reason in hook order wins.
    pub async fn denial(&self, request: &ToolExecuteRequest) -> Option<String> {
        let matched = self.matched_hooks("PreToolUse", &request.tool_name);
        if matched.is_empty() {
            return None;
        }
        let payload = hook_payload(request);
        let results = futures_util::future::join_all(
            matched
                .iter()
                .map(|hook| run_pre_tool_use_hook(hook, &payload)),
        )
        .await;
        results.into_iter().find_map(|result| result)
    }

    /// Notify user-configured `PostToolUse` and `PostToolUseFailure` hooks
    /// (v2 `agentExternalHooksService` notifyPostToolUse).
    pub async fn notify_post_tool_use(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        args: &Value,
        content: &str,
        is_error: bool,
    ) {
        let event_type = if is_error {
            "PostToolUseFailure"
        } else {
            "PostToolUse"
        };
        let matched = self.matched_hooks(event_type, tool_name);
        if matched.is_empty() {
            return;
        }
        // v2 slices the first 2000 chars (`output.slice(0, 2000)`): count
        // chars, not bytes, so CJK text keeps the same window.
        let output_slice: String = content.chars().take(2000).collect();
        let payload = serde_json::json!({
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "tool_input": args,
            "is_error": is_error,
            "tool_output": if !is_error { Some(output_slice) } else { None },
            "error": if is_error { Some(content) } else { None },
        });
        // Fire-and-forget: spawn matching hooks concurrently
        spawn_hooks(matched, payload);
    }

    /// Notify user-configured `UserPromptSubmit` hooks (v2
    /// `agentExternalHooksService.runPromptSubmitHook`). Fire-and-forget
    /// at the head of a turn; hooks can log / observe but do not block
    /// the prompt. Hooks match against the submitted prompt text, as in v2.
    /// Known partial parity: v2 additionally honors block (skips the model
    /// call) and append (context text) outcomes; the engine currently only
    /// fires the observe path.
    pub async fn notify_user_prompt_submit(&self, turn_id: &str, prompt: &str) {
        let matched = self.matched_hooks("UserPromptSubmit", prompt);
        if matched.is_empty() {
            return;
        }
        let payload = serde_json::json!({
            "turn_id": turn_id,
            "prompt": prompt,
        });
        spawn_hooks(matched, payload);
    }

    /// Notify user-configured `PreCompact` hooks (v2
    /// `agentExternalHooksService.runPreCompact`). Fire-and-forget
    /// before each compaction; the hook receives the would-be-compacted
    /// message count so it can log / observe the turn-trim event. The
    /// engine only trims mid-turn (`auto`; manual compaction is host-side),
    /// so hooks match against `"auto"`, as in v2.
    /// Known partial parity: v2 also reports token counts; the engine
    /// reports the message count.
    pub async fn notify_pre_compact(&self, turn_id: &str, message_count: usize) {
        let matched = self.matched_hooks("PreCompact", "auto");
        if matched.is_empty() {
            return;
        }
        let payload = serde_json::json!({
            "turn_id": turn_id,
            "message_count": message_count,
        });
        spawn_hooks(matched, payload);
    }

    /// Run matching `Stop` hooks when a turn is about to end (v2
    /// `agentExternalHooksService.runStopHooks` / `agentExternalHooksService.ts:239-263`).
    /// A hook vetoes the stop by exiting 2 (reason: trimmed stderr) or by
    /// printing a stdout JSON `hookSpecificOutput.permissionDecision: "deny"`
    /// (reason: its `permissionDecisionReason`); the veto text is returned
    /// as the user message to re-prompt with. `None` means no matching hook
    /// asked to continue — the stop proceeds. Built-in turn drivers consume
    /// the veto transparently via `run_turn_continued` (at most one
    /// continuation per turn, mirroring v2's `stopHookContinuationUsed`).
    pub async fn notify_stop(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        reason: &str,
    ) -> Option<String> {
        let matched = self.matched_hooks("Stop", tool_name);
        if matched.is_empty() {
            return None;
        }
        let payload = serde_json::json!({
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "stop_reason": reason,
        });
        let results = futures_util::future::join_all(
            matched.iter().map(|hook| run_stop_hook(hook, &payload)),
        )
        .await;
        // Block reasons never come back empty (`fallback_reason` fills the
        // v2 default), so the first veto wins.
        results.into_iter().flatten().next()
    }
}

/// Fire-and-forget hook executions sharing one payload: observe-only
/// notifies whose outcome the turn never reads.
fn spawn_hooks(matched: Vec<HookDef>, payload: Value) {
    for hook in matched {
        let p = payload.clone();
        tokio::spawn(async move {
            let _ = run_pre_tool_use_hook(&hook, &p).await;
        });
    }
}

/// Run a Stop hook and resolve the continuation message, or `None` to let
/// the stop proceed. v2 `runHook.ts` + `runStopHooks`
/// (`agentExternalHooksService.ts:239-263`): exit code 2 blocks with the
/// trimmed stderr, exit 0 with a stdout JSON `permissionDecision: "deny"`
/// blocks with its reason, spawn/timeout failures fail closed; anything
/// else (including plain-text stdout) allows. Empty reasons fall back to
/// the v2 `Blocked by {event} hook` default.
async fn run_stop_hook(hook: &HookDef, payload: &Value) -> Option<String> {
    run_hook_with_denial(hook, payload, "Stop").await
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
/// `None` for an allow verdict. Named for its callers: every path through
/// here reports a `PreToolUse`-shaped verdict, including the observe-only
/// notifies (which discard it) — pass an explicit event only via
/// [`run_hook_with_denial`].
async fn run_pre_tool_use_hook(hook: &HookDef, payload: &Value) -> Option<String> {
    run_hook_with_denial(hook, payload, "PreToolUse").await
}

/// [`run_pre_tool_use_hook`] with the v2 `matchHooks.ts` fallback for the triggering
/// event: an empty block reason becomes `Blocked by {event} hook`.
async fn run_hook_with_denial(hook: &HookDef, payload: &Value, event: &str) -> Option<String> {
    let timeout = Duration::from_secs(
        hook.timeout
            .unwrap_or(DEFAULT_HOOK_TIMEOUT_SECS)
            .clamp(1, MAX_HOOK_TIMEOUT_SECS),
    );
    let mut child = match spawn_hook_command(&hook.command, hook.cwd.as_deref(), hook.env.as_ref())
    {
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
    // Drain both pipes while the child runs: waiting first and reading
    // after can deadlock once a pipe buffer fills (the child blocks on
    // write while we block on wait). Hook output is small, but the
    // ordering costs nothing.
    let out_drain = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout {
            use tokio::io::AsyncReadExt;
            let _ = out.read_to_end(&mut buf).await;
        }
        buf
    });
    let err_drain = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr {
            use tokio::io::AsyncReadExt;
            let _ = err.read_to_end(&mut buf).await;
        }
        buf
    });
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

    let out_buf = out_drain.await.unwrap_or_default();
    let err_buf = err_drain.await.unwrap_or_default();
    let stdout_text = String::from_utf8_lossy(&out_buf);
    let stderr_text = String::from_utf8_lossy(&err_buf);
    evaluate_hook(event, status, &stdout_text, &stderr_text)
}

/// Spawn the hook command through the platform shell (v2 `spawn(command,
/// { shell: true })`: cmd.exe on Windows, sh elsewhere). `cwd` overrides
/// the working directory; `env` entries merge over the inherited
/// environment (v2 spreads `process.env` first).
fn spawn_hook_command(
    command: &str,
    cwd: Option<&str>,
    env: Option<&std::collections::HashMap<String, String>>,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    };
    if let Some(dir) = cwd.filter(|dir| !dir.is_empty()) {
        cmd.current_dir(dir);
    }
    if let Some(vars) = env {
        cmd.envs(vars);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // v2 `windowsHide: true` — hook shells must not flash a console window.
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // v2 `detached` (non-Windows): hooks run in their own process group
        // so terminal signals don't reach them directly. Timeout/cancel
        // still kills the direct child, as in v2.
        cmd.process_group(0);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.spawn()
}

/// The veto decision (v2 `runHook.ts`): exit 2 blocks with stderr, exit 0
/// with a stdout JSON `hookSpecificOutput.permissionDecision: "deny"`
/// blocks with its `permissionDecisionReason`; everything else allows. A
/// top-level `permissionDecision` does NOT block — v2 reads only the nested
/// form. Empty reasons fall back to the v2 default for the triggering event.
fn evaluate_hook(event: &str, status: ExitStatus, stdout: &str, stderr: &str) -> Option<String> {
    // A signal kill yields no exit code. Node reports the same case as a
    // null exit code, which v2's `resultFromExitCode` allows — mirror that
    // (spawn/timeout/wait failures still fail closed above).
    let code = status.code()?;
    if code == 2 {
        return Some(fallback_reason(event, stderr.trim()));
    }
    if code == 0
        && let Some(reason) = json_deny_reason(stdout)
    {
        return Some(fallback_reason(event, &reason));
    }
    None
}

/// The stdout JSON veto (v2 `structuredOutput`, exit 0 only).
fn json_deny_reason(stdout: &str) -> Option<String> {
    let value: Value = serde_json::from_str(stdout.trim()).ok()?;
    let specific = value.get("hookSpecificOutput")?;
    if specific.get("permissionDecision").and_then(|v| v.as_str()) != Some("deny") {
        return None;
    }
    Some(
        specific
            .get("permissionDecisionReason")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string(),
    )
}

fn fallback_reason(event: &str, reason: &str) -> String {
    if reason.is_empty() {
        format!("Blocked by {event} hook")
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
            cwd: None,
            env: None,
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
    /// quoting — cmd's `/C` re-parsing mangles embedded quotes. Shaped like
    /// v2's `hookSpecificOutput` veto (a top-level `permissionDecision`
    /// does NOT block — see the test below).
    fn json_deny_command(dir: &std::path::Path) -> String {
        let json_file = dir.join("deny.json");
        std::fs::write(
            &json_file,
            r#"{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked by json"}}"#,
        )
        .unwrap();
        if cfg!(windows) {
            format!("type {}", json_file.to_string_lossy())
        } else {
            format!("cat {}", json_file.to_string_lossy())
        }
    }

    /// A top-level `permissionDecision` (outside `hookSpecificOutput`) —
    /// v2 ignores it, so the hook allows.
    fn json_top_level_deny_command(dir: &std::path::Path) -> String {
        let json_file = dir.join("top-deny.json");
        std::fs::write(
            &json_file,
            r#"{"permissionDecision":"deny","permissionDecisionReason":"must not win"}"#,
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
            Some("Blocked by PreToolUse hook")
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
    async fn top_level_permission_decision_does_not_block() {
        // v2 reads only the nested `hookSpecificOutput.permissionDecision`.
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let guard = HookGuard::new(vec![hook(
            "PreToolUse",
            "",
            &json_top_level_deny_command(dir.path()),
        )]);
        assert_eq!(guard.denial(&request("Write")).await, None);
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
            cwd: None,
            env: None,
        }]);
        assert_eq!(
            guard.denial(&request("Write")).await.as_deref(),
            Some(TIMED_OUT)
        );
    }

    /// A command that exits 2 with the child's working directory on
    /// stderr — proves `cwd` reaches the child (v2 `cwd` option).
    fn cwd_report_command() -> &'static str {
        if cfg!(windows) {
            "echo %CD% 1>&2 & exit /b 2"
        } else {
            "echo $PWD >&2; exit 2"
        }
    }

    /// A command that exits 2 with a custom env value on stderr — proves
    /// `env` reaches the child (v2 `env` option, merged over inheritance).
    fn env_report_command() -> &'static str {
        if cfg!(windows) {
            "echo %KIMI_HOOK_TEST_VALUE% 1>&2 & exit /b 2"
        } else {
            "echo $KIMI_HOOK_TEST_VALUE >&2; exit 2"
        }
    }

    #[tokio::test]
    async fn hook_cwd_reaches_the_child() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let guard = HookGuard::new(vec![HookDef {
            event: "PreToolUse".into(),
            matcher: String::new(),
            command: cwd_report_command().into(),
            timeout: None,
            cwd: Some(dir.path().to_string_lossy().to_string()),
            env: None,
        }]);
        let denial = guard.denial(&request("Write")).await;
        // The denial reason is the child's reported cwd. Compare only the
        // dir name: canonicalization (symlinked /tmp, short names) can
        // respell the full path.
        let name = dir.path().file_name().unwrap().to_string_lossy();
        assert!(
            denial
                .as_deref()
                .is_some_and(|reason| reason.contains(name.as_ref())),
            "cwd not observed in hook stderr: {denial:?}"
        );
    }

    #[tokio::test]
    async fn hook_env_reaches_the_child() {
        let guard = HookGuard::new(vec![HookDef {
            event: "PreToolUse".into(),
            matcher: String::new(),
            command: env_report_command().into(),
            timeout: None,
            cwd: None,
            env: Some(
                [(
                    "KIMI_HOOK_TEST_VALUE".to_string(),
                    "hook-env-ok".to_string(),
                )]
                .into_iter()
                .collect(),
            ),
        }]);
        assert_eq!(
            guard.denial(&request("Write")).await.as_deref(),
            Some("hook-env-ok")
        );
    }

    #[tokio::test]
    async fn commands_dedupe_accounts_for_cwd() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let marker = dir.path().join("marker.txt");
        let command = format!("echo 1 >> {}", marker.to_string_lossy());
        // Same command, different cwd: v2 dedups on cwd + command, so both run.
        let guard = HookGuard::new(vec![
            HookDef {
                event: "PreToolUse".into(),
                matcher: String::new(),
                command: command.clone(),
                timeout: None,
                cwd: None,
                env: None,
            },
            HookDef {
                event: "PreToolUse".into(),
                matcher: String::new(),
                command,
                timeout: None,
                cwd: Some(dir.path().to_string_lossy().to_string()),
                env: None,
            },
        ]);
        let _ = guard.denial(&request("Write")).await;
        let runs = std::fs::read_to_string(&marker).unwrap_or_default();
        assert_eq!(
            runs.lines().count(),
            2,
            "same command in different cwds must run once each"
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

    #[tokio::test]
    async fn test_post_tool_use_hook_triggers() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let marker = dir.path().join("post_marker.txt");
        let command = format!("echo done >> {}", marker.to_string_lossy());
        let guard = HookGuard::new(vec![hook("PostToolUse", "Write", &command)]);
        guard
            .notify_post_tool_use("Write", "c1", &serde_json::json!({}), "content", false)
            .await;
        // The hook runs fire-and-forget; poll for the marker instead of
        // sleeping a fixed window so the test stays stable under load.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let content = loop {
            let content = std::fs::read_to_string(&marker).unwrap_or_default();
            if content.contains("done") || std::time::Instant::now() >= deadline {
                break content;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        assert!(content.contains("done"));
    }

    /// A command that writes plain text to stdout and exits 0 — v2 allows
    /// it (only exit 2 or a stdout JSON deny blocks).
    fn echo_reason_command(reason: &str) -> String {
        if cfg!(windows) {
            format!("echo {reason}")
        } else {
            format!("echo '{reason}'", reason = reason.replace('\'', "'\\''"))
        }
    }

    /// A command that exits 2 with a known reason on stderr — the Stop-hook
    /// continuation contract (v2 `agentExternalHooksService.ts:239-263`).
    fn exit_two_with_reason(reason: &str) -> String {
        if cfg!(windows) {
            format!("echo {reason} 1>&2 & exit /b 2")
        } else {
            format!(
                "echo '{reason}' >&2; exit 2",
                reason = reason.replace('\'', "'\\''")
            )
        }
    }

    #[tokio::test]
    async fn stop_hook_exit_two_continues_with_stderr_reason() {
        let guard = HookGuard::new(vec![hook(
            "Stop",
            "",
            &exit_two_with_reason("user asked to keep going"),
        )]);
        let reason = guard.notify_stop("", "", "stop").await;
        assert_eq!(reason.as_deref(), Some("user asked to keep going"));
    }

    #[tokio::test]
    async fn stop_hook_exit_two_empty_stderr_falls_back_to_default() {
        let guard = HookGuard::new(vec![hook("Stop", "", exit_two_silent())]);
        let reason = guard.notify_stop("", "", "stop").await;
        assert_eq!(reason.as_deref(), Some("Blocked by Stop hook"));
    }

    #[tokio::test]
    async fn stop_hook_plain_stdout_does_not_continue() {
        // `echo` exits 0 with unstructured stdout — v2 allows (only exit 2
        // or a stdout JSON deny blocks), so the stop proceeds.
        let guard = HookGuard::new(vec![hook("Stop", "", &echo_reason_command("keep going"))]);
        let reason = guard.notify_stop("", "", "stop").await;
        assert!(reason.is_none());
    }

    #[tokio::test]
    async fn stop_hook_json_deny_continues() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let guard = HookGuard::new(vec![hook("Stop", "", &json_deny_command(dir.path()))]);
        let reason = guard.notify_stop("", "", "stop").await;
        assert_eq!(reason.as_deref(), Some("blocked by json"));
    }

    #[tokio::test]
    async fn stop_hook_filters_by_event_and_matcher() {
        // PreToolUse hook should never run for Stop dispatch.
        let guard = HookGuard::new(vec![
            hook("PreToolUse", "", &exit_two_with_reason("pretool")),
            hook("Stop", "Bash", &exit_two_with_reason("bash-only")),
        ]);
        // At a clean text stop the matcher runs against "": the Bash-scoped
        // hook does not hit.
        assert!(guard.notify_stop("", "", "stop").await.is_none());
        // A matcher hit vetoes with its reason.
        assert_eq!(
            guard.notify_stop("Bash", "c2", "stop").await.as_deref(),
            Some("bash-only")
        );
    }
}
