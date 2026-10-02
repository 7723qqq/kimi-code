//! User-configured external hooks — native mirror of v2
//! `agentExternalHooksService` (G-6 #6).
//!
//! The user configures `[[hooks]]` entries (event / matcher / command /
//! timeout); the engine executes them directly: `PreToolUse` gates every
//! native tool call (mirroring v2's `runHook` contract byte for byte: the
//! command runs through the platform shell with the snake_case payload JSON
//! on stdin, exit code 2 or a stdout JSON `permissionDecision: "deny"`
//! blocks the call, and any hook execution failure fails closed),
//! `PostToolUse` / `PostToolUseFailure`, `UserPromptSubmit` /
//! `PreCompact` / `PostCompact`, `PermissionRequest` / `PermissionResult`,
//! `TurnStarted` / `StopFailure` / `Interrupt` / `UserPromptQueued`,
//! `TaskStarted` / `Notification`, `SubagentStart` / `SubagentStop` and
//! `SessionHeartbeat` fire observe-only notifications, and `Stop` hooks
//! can veto a clean text stop once per turn (v2 `runStop`,
//! agentExternalHooksService.ts:412). Together with `SessionStart` /
//! `SessionEnd` and the gating `PreToolUse`, that covers all 20 of v2's
//! `HOOK_EVENT_TYPES`.

use std::process::ExitStatus;
use std::sync::Arc;
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

/// A hook whose matcher failed to compile: the hook never matches.
/// Recorded (and warn-logged) at construction so a typo'd guardrail is
/// discoverable instead of silently off. Callers that own a user-visible
/// surface should report [`HookGuard::invalid_matchers`].
#[derive(Debug, Clone)]
pub struct InvalidMatcher {
    pub event: String,
    pub matcher: String,
    pub error: String,
}

/// The PreToolUse gate: holds the user-configured hooks from the policy
/// snapshot and runs the matching ones before a native tool call.
pub struct HookGuard {
    hooks: Vec<HookDef>,
    /// The hook matchers, compiled once at construction: an empty pattern
    /// matches everything, an invalid one never matches (v2 `matchHooks.ts`).
    /// Compiling per tool call would re-parse every hook's regex every time.
    matchers: Vec<Matcher>,
    invalid: Vec<InvalidMatcher>,
    /// Server-side usage telemetry (v2 #3897 `external_hook_resolved`).
    /// Set once after construction — the pipeline assembles callbacks below
    /// the guard — and never overwritten. Fire-and-forget: emission must
    /// never affect the hook verdict.
    telemetry: std::sync::OnceLock<TelemetrySink>,
    /// Host-facing `hook.result` sink (v2's hook-result event): the hook's
    /// stdout and whether it blocked. Set once after construction; emission is
    /// fire-and-forget and must never affect the verdict.
    hook_result: std::sync::OnceLock<HookResultSink>,
}

pub type TelemetrySink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// `(hook_event, content, blocked)` — one entry per hook run, so the host can
/// render what the hook said and whether it vetoed.
pub type HookResultSink = Arc<dyn Fn(&str, &str, bool) + Send + Sync>;

enum Matcher {
    All,
    Regex(regex::Regex),
    Never,
}

impl Matcher {
    fn matches(&self, target: &str) -> bool {
        match self {
            Matcher::All => true,
            Matcher::Regex(re) => re.is_match(target),
            Matcher::Never => false,
        }
    }
}

impl HookGuard {
    pub fn new(hooks: Vec<HookDef>) -> Self {
        let mut invalid = Vec::new();
        let matchers = hooks
            .iter()
            .map(|hook| {
                if hook.matcher.is_empty() {
                    Matcher::All
                } else {
                    match regex::Regex::new(&hook.matcher) {
                        Ok(re) => Matcher::Regex(re),
                        Err(error) => {
                            // Silently disabling is the wrong failure mode for a
                            // guard: a typo in a PreToolUse matcher switched the
                            // hook off with no signal anywhere, so the user kept
                            // believing a guardrail was in force.
                            tracing::warn!(
                                event = %hook.event,
                                matcher = %hook.matcher,
                                %error,
                                "external hook matcher is not a valid regex; the hook will never match"
                            );
                            invalid.push(InvalidMatcher {
                                event: hook.event.clone(),
                                matcher: hook.matcher.clone(),
                                error: error.to_string(),
                            });
                            Matcher::Never
                        }
                    }
                }
            })
            .collect();
        Self {
            hooks,
            matchers,
            invalid,
            telemetry: std::sync::OnceLock::new(),
            hook_result: std::sync::OnceLock::new(),
        }
    }

    /// Install the usage-telemetry sink (v2 #3897
    /// `external_hook_resolved`). The pipeline calls this once after the
    /// callbacks exist; later calls are ignored, so a double install can
    /// never duplicate an event.
    pub fn with_telemetry(self: &Arc<Self>, sink: TelemetrySink) {
        let _ = self.telemetry.set(sink);
    }

    /// Install the host-facing `hook.result` sink. Same single-install rule as
    /// [`Self::with_telemetry`]; without it the hook output is dropped.
    pub fn with_hook_result(self: &Arc<Self>, sink: HookResultSink) {
        let _ = self.hook_result.set(sink);
    }

    /// Hooks whose matcher failed to compile (and therefore never match).
    /// Empty in the healthy case.
    pub fn invalid_matchers(&self) -> &[InvalidMatcher] {
        &self.invalid
    }

    /// Hooks matching an event + tool-name target, deduped by command
    /// within a single trigger (v2 `matchHooks` dedups on cwd + command).
    fn matched_hooks(&self, event: &str, target: &str) -> Vec<HookDef> {
        let mut matched: Vec<HookDef> = Vec::new();
        let mut seen_commands = std::collections::HashSet::new();
        for (hook, matcher) in self.hooks.iter().zip(self.matchers.iter()) {
            if hook.event != event {
                continue;
            }
            if !matcher.matches(target) {
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
        // Host-facing `hook.result`: one event per hook run, carrying its
        // stdout and whether it vetoed.
        if let Some(sink) = self.hook_result.get() {
            for (reason, stdout) in &results {
                sink("PreToolUse", stdout, reason.is_some());
            }
        }
        // v2 #3897 `external_hook_resolved`: one usage event per trigger, with
        // the resolve action and the per-hook failure counts. The verdict below
        // is unchanged — the event only observes it.
        let matched_count = results.len();
        let failed_count = results
            .iter()
            .filter(|(reason, _)| {
                matches!(
                    reason.as_deref(),
                    Some(text)
                        if text.starts_with(TIMED_OUT) || text.starts_with(ERRORED)
                )
            })
            .count();
        if let Some(sink) = self.telemetry.get() {
            let action = if results.iter().any(|(reason, _)| reason.is_some()) {
                "block"
            } else {
                "allow"
            };
            sink(
                "external_hook_resolved",
                serde_json::json!({
                    "hook_event": "PreToolUse",
                    "action": action,
                    "matched_count": matched_count,
                    "failed_count": failed_count,
                }),
            );
        }
        results.into_iter().find_map(|(reason, _)| reason)
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
        spawn_hooks(
            "PostToolUse",
            matched,
            payload,
            self.hook_result.get().cloned(),
        );
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
        spawn_hooks(
            "UserPromptSubmit",
            matched,
            payload,
            self.hook_result.get().cloned(),
        );
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
        spawn_hooks(
            "PreCompact",
            matched,
            payload,
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `SessionStart` / `SessionEnd` hooks (v2
    /// `sessionExternalHooksService.triggerSessionStart/End`). Observational:
    /// v2 fires these through `runner.trigger` and discards the verdicts —
    /// a hook can log but cannot block the lifecycle transition.
    /// `matcher` is the create source (`startup` | `resume`; `fork` never
    /// triggers upstream) or the close reason (`exit` | `archive`).
    pub async fn notify_session_lifecycle(&self, event: &str, matcher: &str, payload: Value) {
        let matched = self.matched_hooks(event, matcher);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(event, matched, payload, self.hook_result.get().cloned());
    }

    /// Whether any configured hook listens for `event` — the agent-side
    /// equivalent of v2 `runner.hasHooksFor`, used to gate the
    /// heartbeat timer instead of ticking for no listener.
    pub fn has_hooks_for(&self, event: &str) -> bool {
        self.hooks.iter().any(|hook| hook.event == event)
    }

    /// Notify user-configured `PermissionRequest` hooks (v2
    /// `agentExternalHooksService`, from `PermissionApprovalRequested`).
    /// Fire-and-forget: the verdict is already assembling. `reason` is the
    /// local policy's explanation, when one exists; the upstream payload's
    /// `id` / `sessionId` / `agentId` / `action` / `display` are host-owned
    /// metadata the engine does not track.
    pub async fn notify_permission_request(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        turn_id: &str,
        tool_input: &Value,
        reason: Option<&str>,
    ) {
        let matched = self.matched_hooks("PermissionRequest", tool_name);
        if matched.is_empty() {
            return;
        }
        let mut payload = serde_json::json!({
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "turn_id": turn_id,
            "tool_input": tool_input,
        });
        if let Some(reason) = reason {
            payload["reason"] = Value::String(reason.to_string());
        }
        spawn_hooks(
            "PermissionRequest",
            matched,
            payload,
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `PermissionResult` hooks (v2
    /// `PermissionApprovalResolved`). `decision` is `"approved"` or
    /// `"rejected"`; `feedback` is the host's rejection explanation, when one
    /// was given. Fire-and-forget, like [`Self::notify_permission_request`].
    pub async fn notify_permission_result(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        turn_id: &str,
        tool_input: &Value,
        decision: &str,
        feedback: Option<&str>,
    ) {
        let matched = self.matched_hooks("PermissionResult", tool_name);
        if matched.is_empty() {
            return;
        }
        let mut payload = serde_json::json!({
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "turn_id": turn_id,
            "tool_input": tool_input,
            "decision": decision,
        });
        if let Some(feedback) = feedback {
            payload["feedback"] = Value::String(feedback.to_string());
        }
        spawn_hooks(
            "PermissionResult",
            matched,
            payload,
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `TurnStarted` hooks (v2 event of the same
    /// name). Fire-and-forget; hooks match against the prompt's origin kind
    /// (`user` / `system_trigger` / …), as in v2.
    pub async fn notify_turn_started(&self, turn_id: u64, origin: &Value, prompt: &str) {
        let origin_kind = origin
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let matched = self.matched_hooks("TurnStarted", origin_kind);
        if matched.is_empty() {
            return;
        }
        let mut payload = serde_json::json!({
            "turn_id": turn_id,
            "origin_kind": origin_kind,
            "prompt": prompt,
        });
        if let Some(name) = origin.get("name").and_then(Value::as_str) {
            payload["origin_name"] = Value::String(name.to_string());
        }
        spawn_hooks(
            "TurnStarted",
            matched,
            payload,
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `Interrupt` hooks (v2: fired when a turn ends
    /// with `reason: "cancelled"`). Matching carries no value in v2, so the
    /// matcher here is empty.
    pub async fn notify_interrupt(&self, turn_id: u64) {
        let matched = self.matched_hooks("Interrupt", "");
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "Interrupt",
            matched,
            serde_json::json!({ "turn_id": turn_id, "reason": "cancelled" }),
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `StopFailure` hooks (v2: fired when a turn
    /// ends with `reason: "failed"`). Hooks match against the error type
    /// (the protocol error code, e.g. `provider.api_error`), as upstream
    /// matches against the error's class name.
    pub async fn notify_stop_failure(&self, error_type: &str, error_message: &str) {
        let matched = self.matched_hooks("StopFailure", error_type);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "StopFailure",
            matched,
            serde_json::json!({
                "error_type": error_type,
                "error_message": error_message,
            }),
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `UserPromptQueued` hooks (v2: a tracked user
    /// prompt submitted while a turn is active, parked, or the machine
    /// paused). Hooks match against the prompt text, as in v2.
    pub async fn notify_user_prompt_queued(
        &self,
        prompt_id: u64,
        prompt: &str,
        queue_length: usize,
    ) {
        let matched = self.matched_hooks("UserPromptQueued", prompt);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "UserPromptQueued",
            matched,
            serde_json::json!({
                "prompt_id": prompt_id,
                "prompt": prompt,
                "queue_length": queue_length,
            }),
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `PostCompact` hooks (v2
    /// `fullCompaction.hooks.onWillCompact` → result). Fire-and-forget;
    /// hooks match against the compaction trigger, as in v2. `turn_id` is
    /// carried since, unlike v2's, the fork's payload lacks agent context.
    pub async fn notify_post_compact(
        &self,
        turn_id: &str,
        trigger: &str,
        estimated_token_count: u64,
    ) {
        let matched = self.matched_hooks("PostCompact", trigger);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "PostCompact",
            matched,
            serde_json::json!({
                "turn_id": turn_id,
                "trigger": trigger,
                "estimated_token_count": estimated_token_count,
            }),
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `TaskStarted` hooks (v2 `TaskStarted` event).
    /// Hooks match against the task kind (`subagent` / `bash` / `tool`).
    pub async fn notify_task_started(
        &self,
        task_id: &str,
        kind: &str,
        description: &str,
        status: &str,
        started_at: u64,
    ) {
        let matched = self.matched_hooks("TaskStarted", kind);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "TaskStarted",
            matched,
            serde_json::json!({
                "task_id": task_id,
                "kind": kind,
                "description": description,
                "status": status,
                "started_at": started_at,
            }),
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `Notification` hooks (v2 `TaskNotified`
    /// delivered to the conversation). Hooks match against the terminal
    /// status (`completed` / `failed` / `killed`); v2's distinct
    /// notification-type vocabulary is carried here by the status string.
    pub async fn notify_task_notification(
        &self,
        task_id: &str,
        description: &str,
        status: &str,
        started_at: u64,
        ended_at: u64,
    ) {
        let matched = self.matched_hooks("Notification", status);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "Notification",
            matched,
            serde_json::json!({
                "sink": "context",
                "task_id": task_id,
                "description": description,
                "status": status,
                "started_at": started_at,
                "ended_at": ended_at,
            }),
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `SubagentStart` hooks (v2 session-level
    /// `subagent` hook). Hooks match against the subagent's profile name.
    pub async fn notify_subagent_start(&self, agent_name: &str, prompt: &str) {
        let matched = self.matched_hooks("SubagentStart", agent_name);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "SubagentStart",
            matched,
            serde_json::json!({
                "agent_name": agent_name,
                "prompt": prompt,
                "session_title": "",
            }),
            self.hook_result.get().cloned(),
        );
    }

    /// Notify user-configured `SubagentStop` hooks (v2
    /// `subagents.onDidStopAgentTask`). Hooks match against the subagent's
    /// profile name. `response` is the final assistant text for a completed
    /// run, the error text for a failed one, and the empty string for a
    /// cancelled one.
    pub async fn notify_subagent_stop(&self, agent_name: &str, response: &str) {
        let matched = self.matched_hooks("SubagentStop", agent_name);
        if matched.is_empty() {
            return;
        }
        spawn_hooks(
            "SubagentStop",
            matched,
            serde_json::json!({
                "agent_name": agent_name,
                "response": response,
                "session_title": "",
            }),
            self.hook_result.get().cloned(),
        );
    }

    /// Run matching `Stop` hooks when a turn is about to end (v2
    /// `agentExternalHooksService`'s step-finish registration,
    /// agentExternalHooksService.ts:239-258, calling its private `runStop` at
    /// :412).
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
        if let Some(sink) = self.hook_result.get() {
            for (reason, stdout) in &results {
                sink("Stop", stdout, reason.is_some());
            }
        }
        // Block reasons never come back empty (`fallback_reason` fills the
        // v2 default), so the first veto wins.
        results.into_iter().filter_map(|(reason, _)| reason).next()
    }
}

/// Fire-and-forget hook executions sharing one payload: observe-only
/// notifies whose outcome the turn never reads. The payload gains the
/// `hook_event_name` field (v2 `toHookInputData` always carries it, and
/// hook scripts commonly switch on it).
fn spawn_hooks(event: &str, matched: Vec<HookDef>, payload: Value, sink: Option<HookResultSink>) {
    for hook in matched {
        let mut p = payload.clone();
        if let Some(obj) = p.as_object_mut() {
            obj.insert("hook_event_name".into(), Value::String(event.to_string()));
        }
        let sink = sink.clone();
        let event = event.to_string();
        tokio::spawn(async move {
            let (reason, stdout) = run_pre_tool_use_hook(&hook, &p).await;
            // Host-facing `hook.result`: the observe-only notifies still report
            // what the hook printed (v2 emits it for every run).
            if let Some(sink) = sink {
                sink(&event, &stdout, reason.is_some());
            }
        });
    }
}

/// Run a Stop hook and resolve the continuation message, or `None` to let
/// the stop proceed. v2 `runHook.ts` + `runStop`
/// (`agentExternalHooksService.ts:412`): exit code 2 blocks with the
/// trimmed stderr, exit 0 with a stdout JSON `permissionDecision: "deny"`
/// blocks with its reason, spawn/timeout failures fail closed; anything
/// else (including plain-text stdout) allows. Empty reasons fall back to
/// the v2 `Blocked by {event} hook` default.
/// `(block reason, stdout)` — the reason gates the call, the stdout feeds the
/// host's `hook.result` event.
type HookOutcome = (Option<String>, String);

async fn run_stop_hook(hook: &HookDef, payload: &Value) -> HookOutcome {
    run_hook_with_denial(hook, payload, "Stop").await
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
async fn run_pre_tool_use_hook(hook: &HookDef, payload: &Value) -> HookOutcome {
    run_hook_with_denial(hook, payload, "PreToolUse").await
}

/// [`run_pre_tool_use_hook`] with the v2 `matchHooks.ts` fallback for the triggering
/// event: an empty block reason becomes `Blocked by {event} hook`.
async fn run_hook_with_denial(hook: &HookDef, payload: &Value, event: &str) -> HookOutcome {
    let timeout = Duration::from_secs(
        hook.timeout
            .unwrap_or(DEFAULT_HOOK_TIMEOUT_SECS)
            .clamp(1, MAX_HOOK_TIMEOUT_SECS),
    );
    let mut child = match spawn_hook_command(&hook.command, hook.cwd.as_deref(), hook.env.as_ref())
    {
        Ok(child) => child,
        Err(e) => return (Some(format!("{FAILED_TO_SPAWN}{e}")), String::new()),
    };

    let payload_json = serde_json::to_string(payload).unwrap_or_else(|_| "{}".into());
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return (Some(ERRORED.into()), String::new());
        }
    };
    // v2 attaches an empty 'error' handler to the hook's stdin and ends the
    // stream: a hook that exits without reading its input (EPIPE) must still
    // have its exit code and stderr honored, so the write is best-effort.
    let _ = stdin.write_all(payload_json.as_bytes()).await;
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
                return (Some(ERRORED.into()), String::new());
            }
        },
        _ = tokio::time::sleep(timeout) => {
            // v2 sends SIGTERM then SIGKILL; Rust std exposes no SIGTERM
            // for children, so the kill is direct.
            let _ = child.kill().await;
            let _ = child.wait().await;
            return (Some(TIMED_OUT.into()), String::new());
        }
    };

    let out_buf = out_drain.await.unwrap_or_default();
    let err_buf = err_drain.await.unwrap_or_default();
    let stdout_text = String::from_utf8_lossy(&out_buf);
    let stderr_text = String::from_utf8_lossy(&err_buf);
    (
        evaluate_hook(event, status, &stdout_text, &stderr_text),
        stdout_text.to_string(),
    )
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
        // v2 `windowsHide: true` — hook shells must not flash a console window.
        // (tokio's `Command` carries an inherent `creation_flags` on Windows;
        // the std `CommandExt` trait is not involved.)
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        // v2 `detached` (non-Windows): hooks run in their own process group
        // so terminal signals don't reach them directly. Timeout/cancel
        // still kills the direct child, as in v2.
        // (tokio's `Command` has an inherent `process_group`; the std
        // `CommandExt` trait import is redundant and trips unused-imports.)
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

/// Shared test support for any test that asserts on the payload a hook
/// received on stdin: a shell-safe temp dir, capture-file hooks, and a wait
/// for the fire-and-forget write to land.
#[cfg(test)]
pub(crate) mod capture {
    use serde_json::Value;

    use crate::permission::HookDef;

    /// A temp dir safe for shell redirection — a path with spaces breaks the
    /// capture command, so `None` means skip the test.
    pub fn dir() -> Option<tempfile::TempDir> {
        let dir = tempfile::tempdir().ok()?;
        if dir.path().to_string_lossy().contains(' ') {
            return None;
        }
        Some(dir)
    }

    /// A hook whose command copies its stdin payload to `target` (`more`
    /// reads the pipe to EOF on cmd, `cat` elsewhere).
    pub fn hook(event: &str, matcher: &str, target: &std::path::Path) -> HookDef {
        let command = if cfg!(windows) {
            format!("more > {}", target.to_string_lossy())
        } else {
            format!("cat > {}", target.to_string_lossy())
        };
        HookDef {
            event: event.into(),
            matcher: matcher.into(),
            command,
            timeout: None,
            cwd: None,
            env: None,
        }
    }

    /// Wait for the hook's capture file to become non-empty (or the deadline
    /// to pass), then parse the payload.
    pub async fn wait(target: &std::path::Path) -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let content = loop {
            let content = std::fs::read_to_string(target).unwrap_or_default();
            if !content.is_empty() || std::time::Instant::now() >= deadline {
                break content;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        serde_json::from_str(&content).expect("the hook received a JSON payload")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(tool_name: &str) -> ToolExecuteRequest {
        ToolExecuteRequest {
            agent_id: crate::callbacks::MAIN_AGENT_ID.to_string(),
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

    /// v2 #3897 `external_hook_resolved`: one event per trigger carrying the
    /// resolve action and the per-hook failure counts. The verdict itself is
    /// unchanged by whether a sink is installed.
    #[tokio::test]
    async fn denial_emits_the_usage_event_with_counts() {
        let events = Arc::new(std::sync::Mutex::new(
            Vec::<(String, serde_json::Value)>::new(),
        ));
        let log = events.clone();
        // Two distinct commands (v2 dedupes same-command hooks within one
        // trigger, so identical commands would fold to a single match).
        let guard = Arc::new(HookGuard::new(vec![
            hook("PreToolUse", "", exit_two_with_stderr()),
            hook("PreToolUse", "", exit_two_silent()),
        ]));
        guard.with_telemetry(Arc::new(move |event, payload| {
            log.lock().unwrap().push((event.to_string(), payload));
        }));

        let denial = guard.denial(&request("Write")).await;
        assert!(denial.is_some(), "the hooks still block");

        let log = events.lock().unwrap();
        assert_eq!(log.len(), 1, "one event per trigger");
        let (event, payload) = &log[0];
        assert_eq!(event, "external_hook_resolved");
        assert_eq!(payload["hook_event"], "PreToolUse");
        assert_eq!(payload["action"], "block");
        assert_eq!(payload["matched_count"], 2);
        // Both hooks exit 2 — v2 counts a non-2 exit code as failure, exit 2 as
        // a deliberate block, so failed_count is 0 here.
        assert_eq!(payload["failed_count"], 0);
    }

    /// The host-facing `hook.result`: one event per hook run carrying its
    /// stdout and whether it vetoed. Before this sink existed the hook ran and
    /// its output was discarded.
    #[tokio::test]
    async fn denial_emits_a_hook_result_per_hook() {
        let results = Arc::new(std::sync::Mutex::new(Vec::<(String, String, bool)>::new()));
        let log = results.clone();
        let stdout_cmd = "echo hook says hi";
        let guard = Arc::new(HookGuard::new(vec![
            hook("PreToolUse", "", exit_two_with_stderr()),
            hook("PreToolUse", "", stdout_cmd),
        ]));
        guard.with_hook_result(Arc::new(move |event, content, blocked| {
            log.lock()
                .unwrap()
                .push((event.to_string(), content.to_string(), blocked));
        }));

        let denial = guard.denial(&request("Write")).await;
        assert!(denial.is_some(), "the first hook still blocks");

        let log = results.lock().unwrap();
        assert_eq!(log.len(), 2, "one hook.result per hook run");
        assert!(log.iter().all(|(event, _, _)| event == "PreToolUse"));
        assert!(
            log.iter()
                .any(|(_, content, _)| content.contains("hook says hi")),
            "the hook's stdout reaches the host"
        );
        assert!(
            log.iter().any(|(_, _, blocked)| *blocked),
            "the blocking hook reports blocked"
        );
    }

    /// No sink installed (every entry point before wiring): the verdict is
    /// identical and nothing panics.
    #[tokio::test]
    async fn denial_without_a_sink_is_verdict_identical() {
        let guard = HookGuard::new(vec![hook("PreToolUse", "", exit_two_with_stderr())]);
        assert_eq!(
            guard.denial(&request("Write")).await.as_deref(),
            Some("denied by test hook")
        );
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
    async fn invalid_matcher_never_matches_but_is_reported() {
        let guard = HookGuard::new(vec![hook("PreToolUse", "[", exit_two_with_stderr())]);
        assert_eq!(guard.denial(&request("Write")).await, None);
        // The hook is off, but the typo must be discoverable: recorded for
        // user-visible surfaces (and warn-logged at construction).
        let invalid = guard.invalid_matchers();
        assert_eq!(invalid.len(), 1);
        assert_eq!(invalid[0].event, "PreToolUse");
        assert_eq!(invalid[0].matcher, "[");
        assert!(!invalid[0].error.is_empty());

        let healthy = HookGuard::new(vec![hook("PreToolUse", "Wri", exit_two_with_stderr())]);
        assert!(healthy.invalid_matchers().is_empty());
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
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir_a.path()) || skip_if_path_has_spaces(dir_b.path()) {
            return;
        }
        // Same command, different cwd: v2 dedups on cwd + command, so both run.
        // Each hook writes a marker relative to its own cwd so the two runs
        // never contend on one file (Windows `cmd >>` seeks instead of
        // appending atomically).
        let command = "echo 1 >> marker.txt".to_string();
        let guard = HookGuard::new(vec![
            HookDef {
                event: "PreToolUse".into(),
                matcher: String::new(),
                command: command.clone(),
                timeout: None,
                cwd: Some(dir_a.path().to_string_lossy().to_string()),
                env: None,
            },
            HookDef {
                event: "PreToolUse".into(),
                matcher: String::new(),
                command,
                timeout: None,
                cwd: Some(dir_b.path().to_string_lossy().to_string()),
                env: None,
            },
        ]);
        let _ = guard.denial(&request("Write")).await;
        let runs_a = std::fs::read_to_string(dir_a.path().join("marker.txt")).unwrap_or_default();
        let runs_b = std::fs::read_to_string(dir_b.path().join("marker.txt")).unwrap_or_default();
        assert_eq!(runs_a.lines().count(), 1, "first cwd runs once");
        assert_eq!(runs_b.lines().count(), 1, "second cwd runs once");
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
            agent_id: crate::callbacks::MAIN_AGENT_ID.to_string(),
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

    /// A command that copies its stdin payload to a file (`more` reads the
    /// pipe to EOF on cmd; `cat` elsewhere), so the test can assert on the
    /// exact JSON the hook received.
    fn capture_stdin_command(target: &std::path::Path) -> String {
        if cfg!(windows) {
            format!("more > {}", target.to_string_lossy())
        } else {
            format!("cat > {}", target.to_string_lossy())
        }
    }

    /// Wait for a fire-and-forget hook to finish writing its capture file.
    async fn wait_for_capture(path: &std::path::Path) -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let content = std::fs::read_to_string(path).unwrap_or_default();
            if !content.is_empty() || std::time::Instant::now() >= deadline {
                return content;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn session_start_matches_on_the_create_source_and_carries_the_event_name() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let captured = dir.path().join("session-start.json");
        let guard = HookGuard::new(vec![hook(
            "SessionStart",
            "startup",
            &capture_stdin_command(&captured),
        )]);

        // A `resume` session does not match a `startup` hook: no file.
        guard
            .notify_session_lifecycle(
                "SessionStart",
                "resume",
                json!({ "source": "resume", "session_title": "" }),
            )
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(
            !captured.exists(),
            "the resume source must not match a startup hook"
        );

        // The `startup` source matches, and the stdin payload carries the
        // v2 `hook_event_name` + `source` fields.
        guard
            .notify_session_lifecycle(
                "SessionStart",
                "startup",
                json!({ "source": "startup", "session_title": "" }),
            )
            .await;
        let payload: Value = serde_json::from_str(&wait_for_capture(&captured).await)
            .expect("the hook received a JSON payload");
        assert_eq!(payload["hook_event_name"], "SessionStart");
        assert_eq!(payload["source"], "startup");
    }

    #[tokio::test]
    async fn session_end_hooks_fire_observationally() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let captured = dir.path().join("session-end.json");
        // SessionEnd is observational: even an exit-2 hook must not block
        // the caller (the notify resolves and the reason is dropped).
        let veto = hook("SessionEnd", "archive", exit_two_with_stderr());
        let guard = HookGuard::new(vec![
            veto,
            hook("SessionEnd", "archive", &capture_stdin_command(&captured)),
        ]);
        guard
            .notify_session_lifecycle(
                "SessionEnd",
                "archive",
                json!({ "reason": "archive", "session_title": "" }),
            )
            .await;

        let payload: Value = serde_json::from_str(&wait_for_capture(&captured).await)
            .expect("the hook received a JSON payload");
        assert_eq!(payload["hook_event_name"], "SessionEnd");
        assert_eq!(payload["reason"], "archive");
    }

    #[tokio::test]
    async fn turn_started_matches_the_origin_kind_and_only_carries_origin_name_when_present() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let captured = dir.path().join("turn-started.json");
        let guard = HookGuard::new(vec![hook(
            "TurnStarted",
            "system_trigger",
            &capture_stdin_command(&captured),
        )]);

        // A `user` origin does not match a `system_trigger` hook: no file.
        guard
            .notify_turn_started(7, &json!({ "kind": "user" }), "hello")
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!captured.exists());

        guard
            .notify_turn_started(
                7,
                &json!({ "kind": "system_trigger", "name": "cron" }),
                "tick",
            )
            .await;
        let payload: Value = serde_json::from_str(&wait_for_capture(&captured).await)
            .expect("the hook received a JSON payload");
        assert_eq!(payload["hook_event_name"], "TurnStarted");
        assert_eq!(payload["turn_id"], 7);
        assert_eq!(payload["origin_kind"], "system_trigger");
        assert_eq!(payload["origin_name"], "cron");
        assert_eq!(payload["prompt"], "tick");
    }

    #[tokio::test]
    async fn stop_failure_matches_against_the_error_type() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let captured = dir.path().join("stop-failure.json");
        let guard = HookGuard::new(vec![hook(
            "StopFailure",
            "provider.api_error",
            &capture_stdin_command(&captured),
        )]);

        // A different error type does not match.
        guard.notify_stop_failure("permission.denied", "nope").await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!captured.exists());

        guard
            .notify_stop_failure("provider.api_error", "boom")
            .await;
        let payload: Value = serde_json::from_str(&wait_for_capture(&captured).await)
            .expect("the hook received a JSON payload");
        assert_eq!(payload["hook_event_name"], "StopFailure");
        assert_eq!(payload["error_type"], "provider.api_error");
        assert_eq!(payload["error_message"], "boom");
    }

    #[tokio::test]
    async fn user_prompt_queued_carries_the_queue_length_and_matches_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let captured = dir.path().join("prompt-queued.json");
        let guard = HookGuard::new(vec![hook(
            "UserPromptQueued",
            "second thought",
            &capture_stdin_command(&captured),
        )]);

        guard.notify_user_prompt_queued(9, "unrelated", 2).await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!captured.exists());

        guard
            .notify_user_prompt_queued(9, "a second thought", 2)
            .await;
        let payload: Value = serde_json::from_str(&wait_for_capture(&captured).await)
            .expect("the hook received a JSON payload");
        assert_eq!(payload["hook_event_name"], "UserPromptQueued");
        assert_eq!(payload["prompt_id"], 9);
        assert_eq!(payload["queue_length"], 2);
        assert_eq!(payload["prompt"], "a second thought");
    }

    #[tokio::test]
    async fn permission_events_match_the_tool_and_carry_the_decision() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let request = dir.path().join("permission-request.json");
        let result = dir.path().join("permission-result.json");
        let guard = HookGuard::new(vec![
            hook(
                "PermissionRequest",
                "Bash",
                &capture_stdin_command(&request),
            ),
            hook("PermissionResult", "Bash", &capture_stdin_command(&result)),
        ]);
        let input = json!({ "command": "rm -rf /tmp/x" });

        guard
            .notify_permission_request("Bash", "c1", "t1", &input, Some("DangerousCommandAsk"))
            .await;
        guard
            .notify_permission_result("Bash", "c1", "t1", &input, "rejected", Some("not today"))
            .await;

        let request_payload: Value = serde_json::from_str(&wait_for_capture(&request).await)
            .expect("the request hook received a JSON payload");
        assert_eq!(request_payload["hook_event_name"], "PermissionRequest");
        assert_eq!(request_payload["tool_name"], "Bash");
        assert_eq!(request_payload["reason"], "DangerousCommandAsk");

        let result_payload: Value = serde_json::from_str(&wait_for_capture(&result).await)
            .expect("the result hook received a JSON payload");
        assert_eq!(result_payload["hook_event_name"], "PermissionResult");
        assert_eq!(result_payload["decision"], "rejected");
        assert_eq!(result_payload["feedback"], "not today");
    }

    #[tokio::test]
    async fn subagent_hooks_match_the_profile_name() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let started = dir.path().join("subagent-start.json");
        let stopped = dir.path().join("subagent-stop.json");
        let guard = HookGuard::new(vec![
            hook("SubagentStart", "explore", &capture_stdin_command(&started)),
            hook("SubagentStop", "explore", &capture_stdin_command(&stopped)),
        ]);

        guard.notify_subagent_start("general", "wrong prompt").await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!started.exists());

        guard
            .notify_subagent_start("explore", "list the files")
            .await;
        guard.notify_subagent_stop("explore", "done").await;

        let start_payload: Value = serde_json::from_str(&wait_for_capture(&started).await)
            .expect("the start hook received a JSON payload");
        assert_eq!(start_payload["hook_event_name"], "SubagentStart");
        assert_eq!(start_payload["agent_name"], "explore");
        assert_eq!(start_payload["prompt"], "list the files");

        let stop_payload: Value = serde_json::from_str(&wait_for_capture(&stopped).await)
            .expect("the stop hook received a JSON payload");
        assert_eq!(stop_payload["hook_event_name"], "SubagentStop");
        assert_eq!(stop_payload["response"], "done");
    }

    #[tokio::test]
    async fn task_and_compaction_events_match_on_kind_and_trigger() {
        let dir = tempfile::tempdir().unwrap();
        if skip_if_path_has_spaces(dir.path()) {
            return;
        }
        let task = dir.path().join("task-started.json");
        let notify = dir.path().join("task-notification.json");
        let post = dir.path().join("post-compact.json");
        let guard = HookGuard::new(vec![
            hook("TaskStarted", "subagent", &capture_stdin_command(&task)),
            hook("Notification", "completed", &capture_stdin_command(&notify)),
            hook("PostCompact", "auto", &capture_stdin_command(&post)),
        ]);

        // A `bash` task does not match a `subagent` matcher: no file.
        guard
            .notify_task_started("t0", "bash", "other", "running", 99)
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!task.exists());

        guard
            .notify_task_started("t1", "subagent", "run a helper", "running", 100)
            .await;
        guard
            .notify_task_notification("t1", "run a helper", "completed", 100, 200)
            .await;
        guard.notify_post_compact("turn-1", "auto", 42_000).await;

        let task_payload: Value = serde_json::from_str(&wait_for_capture(&task).await)
            .expect("the task hook received a JSON payload");
        assert_eq!(task_payload["hook_event_name"], "TaskStarted");
        assert_eq!(task_payload["kind"], "subagent");

        let notify_payload: Value = serde_json::from_str(&wait_for_capture(&notify).await)
            .expect("the notification hook received a JSON payload");
        assert_eq!(notify_payload["hook_event_name"], "Notification");
        assert_eq!(notify_payload["sink"], "context");
        assert_eq!(notify_payload["status"], "completed");

        let post_payload: Value = serde_json::from_str(&wait_for_capture(&post).await)
            .expect("the post-compact hook received a JSON payload");
        assert_eq!(post_payload["hook_event_name"], "PostCompact");
        assert_eq!(post_payload["trigger"], "auto");
        assert_eq!(post_payload["estimated_token_count"], 42_000);
    }

    #[tokio::test]
    async fn interrupt_matches_empty_and_stop_failure_error_type() {
        let guard = HookGuard::new(vec![
            hook("Interrupt", "", exit_two_silent()),
            hook("StopFailure", "permission.denied", exit_two_silent()),
        ]);
        // Both fire observationally — an exit-2 hook changes nothing here.
        guard.notify_interrupt(3).await;
        guard.notify_stop_failure("permission.denied", "nope").await;
        // `has_hooks_for` reports listener presence for the heartbeat gate.
        assert!(guard.has_hooks_for("Interrupt"));
        assert!(!guard.has_hooks_for("SessionHeartbeat"));
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
