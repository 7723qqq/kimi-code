//! Session-replay rendering — rebuild the transcript from the engine's
//! persisted records (`session/resume_state` → `{ agents: { main: { replay,
//! background, toolStore } } }`), TS `session-replay.ts` parity ported onto
//! the Rust record shapes (message / turn_started / turn_ended / tool_call /
//! tool_result / usage_updated / goal_updated / compaction_started /
//! compaction_completed / plan_updated / permission_updated /
//! approval_result). Pure functions over the wire JSON, so they are
//! unit-testable without a running engine.
//!
//! Two renderers coexist: `history.rs` renders the `session/get_context`
//! snapshot (the resume fallback), this module renders the richer record
//! stream (the primary resume path).

use std::collections::HashMap;

use crate::app::{
    tool_result_collapsed, ToolCallEntry, TranscriptEntry, TranscriptLine, TOOL_COLLAPSE_THRESHOLD,
};
use crate::i18n::t;
use crate::t;

/// Join the text parts of an engine message's `content` array
/// (`[{"type":"text","text":…}, …]`) — same extraction as `history.rs`.
fn text_content(message: &serde_json::Value) -> String {
    message["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| {
                    if p["type"].as_str() == Some("text") {
                        p["text"].as_str().map(str::to_string)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// The `replay` record array of a `session/resume_state` result
/// (`agents.main.replay`), or `None` when the state has no main agent.
fn replay_records(data: &serde_json::Value) -> Option<&[serde_json::Value]> {
    data.get("agents")?
        .get("main")?
        .get("replay")?
        .as_array()
        .map(|a| a.as_slice())
}

/// Render the whole `session/resume_state` result: replay records plus
/// terminal background-task status lines (TS `hydrateFromReplay` parity —
/// the snapshot's todo panel is consumed separately by `todo_items`).
pub fn render_resume_state(data: &serde_json::Value) -> Vec<TranscriptEntry> {
    let mut entries = render_replay(data);
    entries.extend(render_background(data));
    entries
}

/// Render the replay records of a `session/resume_state` result
/// (`agents.main.replay`) as transcript entries.
pub fn render_replay(data: &serde_json::Value) -> Vec<TranscriptEntry> {
    let Some(records) = replay_records(data) else {
        return Vec::new();
    };
    render_replay_records(records)
}

/// Render a typed replay record array (`[{ "type": …, … }]`) as transcript
/// entries. Pure over the wire shape so tests can feed records directly.
///
/// Messages render like the live transcript (user prompts, assistant text,
/// tool-call cards); standalone `tool_call` / `tool_result` records pair up
/// into one card (the call renders the header, the result lands on it by
/// `tool_call_id`); `goal_updated` / compaction / `plan_updated` /
/// `permission_updated` / `approval_result` records render status lines;
/// `turn_started` / `turn_ended` / `usage_updated` / unknown records are
/// skipped — the flat Rust transcript has no per-turn grouping or usage
/// line, so they only matter to the engine's bookkeeping.
pub fn render_replay_records(records: &[serde_json::Value]) -> Vec<TranscriptEntry> {
    let mut entries = Vec::new();
    // tool_call_id → index of its ToolCall card in `entries` (results land
    // on the card regardless of whether the call came from a message or a
    // standalone record).
    let mut cards: HashMap<String, usize> = HashMap::new();
    // Approving a plan (ExitPlanMode) turns plan mode off as a side effect,
    // so the following plan-off notice would be redundant — the approval
    // arms this and the next disabled `plan_updated` record consumes it (TS
    // `suppressNextPlanModeOffNotice` parity).
    let mut suppress_next_plan_off = false;
    for record in records {
        match record["type"].as_str().unwrap_or("") {
            "message" => render_message(&mut entries, &mut cards, &record["message"]),
            "tool_call" => {
                let id = record["tool_call_id"].as_str().unwrap_or("").to_string();
                let name = record["name"].as_str().unwrap_or("tool").to_string();
                let args = args_string(&record["input"]);
                push_card(&mut entries, &mut cards, &id, &name, args);
            }
            "tool_result" => {
                let id = record["tool_call_id"].as_str().unwrap_or("");
                let output = record["output"].as_str().unwrap_or("").to_string();
                let is_error = record["is_error"].as_bool().unwrap_or(false);
                patch_result(&mut entries, &mut cards, id, output, is_error);
            }
            "goal_updated" => {
                if let Some(line) = goal_status_line(&record["snapshot"]) {
                    entries.push(TranscriptEntry::Line(line));
                }
            }
            "compaction_started" => entries.push(TranscriptEntry::Line(TranscriptLine::status(
                t("tui.replay.compacting").to_string(),
            ))),
            "compaction_completed" => {
                if let Some(line) = compaction_completed_line(record) {
                    entries.push(TranscriptEntry::Line(line));
                }
            }
            "plan_updated" => {
                let enabled = record["enabled"].as_bool().unwrap_or(false);
                if !enabled && suppress_next_plan_off {
                    // Consumed by the ExitPlanMode approval that preceded it.
                    suppress_next_plan_off = false;
                } else {
                    suppress_next_plan_off = false;
                    let text = if enabled {
                        t("tui.replay.planModeOn").to_string()
                    } else {
                        t("tui.replay.planModeOff").to_string()
                    };
                    entries.push(TranscriptEntry::Line(TranscriptLine::status(text)));
                }
            }
            "permission_updated" => {
                entries.push(TranscriptEntry::Line(permission_updated_line(record)));
            }
            "approval_result" => {
                if let Some(line) = approval_result_line(record, &mut suppress_next_plan_off) {
                    entries.push(TranscriptEntry::Line(line));
                }
            }
            // turn_started / turn_ended / usage_updated / unknown → skipped.
            _ => {}
        }
    }
    entries
}

/// Render one `message` record (`{ "type":"message", "message": { role,
/// content, origin?, tool_calls? } }`) into the transcript. Mirrors the
/// live event stream's per-role rendering (TS `renderMessage` parity).
fn render_message(
    entries: &mut Vec<TranscriptEntry>,
    cards: &mut HashMap<String, usize>,
    message: &serde_json::Value,
) {
    match message["role"].as_str().unwrap_or("") {
        "user" => render_user_message(entries, message),
        "assistant" => {
            if message["origin"]["kind"].as_str() == Some("hook_result") {
                // A hook-result reply renders as an assistant markdown line,
                // like the user-side hook result (TS `renderHookResult`
                // parity).
                entries.push(TranscriptEntry::Line(hook_result_line(message)));
                return;
            }
            // Tool calls first (if any), then the assistant text — the
            // order the turn produced them in.
            if let Some(calls) = message["tool_calls"].as_array() {
                for call in calls {
                    let id = call["id"]
                        .as_str()
                        .or_else(|| call["tool_call_id"].as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = call["name"].as_str().unwrap_or("tool").to_string();
                    let args = if call.get("arguments").is_some() {
                        args_string(&call["arguments"])
                    } else {
                        args_string(&call["input"])
                    };
                    push_card(entries, cards, &id, &name, args);
                }
            }
            let text = text_content(message);
            if !text.is_empty() {
                entries.push(TranscriptEntry::Line(TranscriptLine::assistant(text)));
            }
        }
        "tool" => {
            // A tool-result message settles its card (when the call was
            // replayed) instead of adding a bare line; unmatched ones fall
            // back to the plain tool line (existing behavior).
            let id = message["toolCallId"].as_str().unwrap_or("");
            let text = text_content(message);
            if !id.is_empty() {
                let is_error = message["isError"].as_bool().unwrap_or(false);
                patch_result(entries, cards, id, text, is_error);
                return;
            }
            if !text.is_empty() {
                entries.push(TranscriptEntry::Line(TranscriptLine::tool(text)));
            }
        }
        // system and unknown roles are model framing — never rendered.
        _ => {}
    }
}

/// Render a user message, branching on its `origin.kind` (TS
/// `renderUserMessage` parity): shell-command frames become `$ cmd` +
/// output status lines, skill/plugin/hook/background/cron notices become
/// status lines (hook results are assistant markdown lines, like the live
/// stream), injections and system triggers are skipped, everything else is
/// a plain user line.
fn render_user_message(entries: &mut Vec<TranscriptEntry>, message: &serde_json::Value) {
    match message["origin"]["kind"].as_str() {
        Some("background_task") => {
            let task_id = message["origin"]["task_id"].as_str().unwrap_or("");
            let status = message["origin"]["status"].as_str().unwrap_or("");
            entries.push(TranscriptEntry::Line(TranscriptLine::status(t!(
                "tui.replay.bgTask",
                task_id,
                status
            ))));
        }
        Some("shell_command") => render_shell_command(entries, message),
        Some("injection") | Some("system_trigger") => {
            // Model-facing only; the live stream never renders them.
        }
        Some("hook_result") => {
            entries.push(TranscriptEntry::Line(hook_result_line(message)));
        }
        Some("cron_job") => {
            let text = text_content(message);
            entries.push(TranscriptEntry::Line(TranscriptLine::status(t!(
                "tui.replay.cronFired",
                extract_cron_prompt(&text)
            ))));
        }
        Some("cron_missed") => {
            let text = text_content(message);
            let mut line = t!("tui.replay.cronMissed", strip_cron_envelope(&text));
            if let Some(count) = message["origin"]["count"].as_u64() {
                line = format!("{line} {}", t!("tui.replay.cronMissedCount", count));
            }
            entries.push(TranscriptEntry::Line(TranscriptLine::status(line)));
        }
        Some("skill_activation") => {
            let name = message["origin"]["skill_name"].as_str().unwrap_or("");
            entries.push(TranscriptEntry::Line(TranscriptLine::status(t!(
                "tui.replay.skillActivated",
                name
            ))));
        }
        Some("plugin_command") => {
            let plugin = message["origin"]["plugin_id"].as_str().unwrap_or("");
            let command = message["origin"]["command_name"].as_str().unwrap_or("");
            entries.push(TranscriptEntry::Line(TranscriptLine::status(format!(
                "/{plugin}:{command}"
            ))));
        }
        // Unknown origins fall through to the plain user line.
        _ => {
            let text = text_content(message);
            if !text.is_empty() {
                entries.push(TranscriptEntry::Line(TranscriptLine::user(text)));
            }
        }
    }
}

/// A `!`-command frame (`origin.kind == "shell_command"`), unwrapped from
/// the persisted `<bash-input>` / `<bash-stdout>` / `<bash-stderr>` XML
/// tags back into the `$ cmd` + output view the live editor produced (TS
/// `extractBashTag` parity, simplified).
fn render_shell_command(entries: &mut Vec<TranscriptEntry>, message: &serde_json::Value) {
    let text = text_content(message);
    if message["origin"]["phase"].as_str() == Some("input") {
        let cmd = extract_bash_tag(&text, "bash-input")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| text.trim().to_string());
        if !cmd.is_empty() {
            entries.push(TranscriptEntry::Line(TranscriptLine::user(format!("$ {cmd}"))));
        }
    } else {
        // Output phase: stdout + stderr, tags stripped.
        let stdout = extract_bash_tag(&text, "bash-stdout");
        let stderr = extract_bash_tag(&text, "bash-stderr");
        let out = match (stdout, stderr) {
            (Some(o), Some(e)) if !o.is_empty() && !e.is_empty() => format!("{o}\n{e}"),
            (Some(o), _) => o,
            (_, Some(e)) => e,
            (None, None) => String::new(),
        };
        let out = out.trim();
        if !out.is_empty() {
            entries.push(TranscriptEntry::Line(TranscriptLine::status(out.to_string())));
        }
    }
}

/// Extract the content of `<tag>…</tag>` from `text`, unescaping the XML
/// entities the engine writes; `None` when the tag is absent.
fn extract_bash_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)?;
    let rest = &text[start + open.len()..];
    let end = rest.find(&close)?;
    Some(unescape_bash_xml(&rest[..end]))
}

fn unescape_bash_xml(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// A `hook_result` origin renders as an assistant markdown line — one
/// `*<event> hook*` title + body block per `<hook_result …>` element (TS
/// `formatHookResultMessageForTranscript` parity; assistant text is
/// markdown-rendered by the chat widget). Any non-hook text around the
/// blocks falls back to a single block over the whole message, headed by
/// the origin's event.
fn hook_result_line(message: &serde_json::Value) -> TranscriptLine {
    let text = text_content(message);
    let event = message["origin"]["event"]
        .as_str()
        .filter(|e| !e.is_empty())
        .or_else(|| extract_hook_event(&text))
        .unwrap_or("hook");
    let blocked = message["origin"]["blocked"].as_bool().unwrap_or(false);
    TranscriptLine::assistant(format_hook_result_transcript(&text, event, blocked))
}

/// Parse a hook-result message into `*<event> hook*` + body blocks: a pure
/// sequence of `<hook_result hook_event="…">…</hook_result>` elements joins
/// one block per element; interleaved non-hook text (or no elements at all)
/// renders the whole text under the fallback event instead (TS
/// `formatHookResultMessageForTranscript` parity).
fn format_hook_result_transcript(text: &str, fallback_event: &str, blocked: bool) -> String {
    let mut results: Vec<(String, String)> = Vec::new();
    let mut last_index = 0;
    for captures in hook_result_regex().captures_iter(text) {
        let whole = captures.get(0).expect("capture 0 always present");
        if !text[last_index..whole.start()].trim().is_empty() {
            return format_hook_result_block(fallback_event, text, blocked);
        }
        let (Some(event), Some(body)) = (
            captures.get(1).map(|m| m.as_str()),
            captures.get(2).map(|m| m.as_str()),
        ) else {
            return format_hook_result_block(fallback_event, text, blocked);
        };
        results.push((event.to_string(), body.to_string()));
        last_index = whole.end();
    }
    if results.is_empty() || !text[last_index..].trim().is_empty() {
        return format_hook_result_block(fallback_event, text, blocked);
    }
    results
        .iter()
        .map(|(event, body)| format_hook_result_block(event, body, blocked))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// One `*<event> hook*` title + body block, `(empty)` bodies marked as such
/// (TS `formatHookResultBlock` parity).
fn format_hook_result_block(event: &str, body: &str, blocked: bool) -> String {
    let title = if blocked {
        t!("tui.replay.hookBlocked", event)
    } else {
        t!("tui.replay.hookResult", event)
    };
    let body = body.trim();
    let body = if body.is_empty() {
        t("tui.replay.hookEmpty").to_string()
    } else {
        body.to_string()
    };
    format!("*{title}*\n\n{body}")
}

/// `<hook_result hook_event="…">…</hook_result>` elements (TS
/// `HOOK_RESULT_RE`).
fn hook_result_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r#"<hook_result\s+hook_event="([^"]+)">\n?([\s\S]*?)\n?</hook_result>"#)
            .expect("HOOK_RESULT_RE compiles")
    })
}

/// The `hook_event="…"` attribute of the first `<hook_result …>` block.
fn extract_hook_event(text: &str) -> Option<&str> {
    let attr = "hook_event=\"";
    let start = text.find(attr)? + attr.len();
    text[start..].split('"').next()
}

/// The prompt of a `cron_job` message: the `<prompt>\n…\n</prompt>` body,
/// or the envelope-stripped whole text when the tags are absent (TS
/// `extractCronPrompt` parity).
fn extract_cron_prompt(text: &str) -> String {
    const OPEN: &str = "<prompt>\n";
    const CLOSE: &str = "\n</prompt>";
    if let Some(start) = text.find(OPEN) {
        let after_open = start + OPEN.len();
        if let Some(close_rel) = text[after_open..].rfind(CLOSE) {
            return text[after_open..after_open + close_rel].to_string();
        }
    }
    strip_cron_envelope(text)
}

/// Strip the `<cron-fire …>…</cron-fire>` envelope a persisted cron prompt
/// is wrapped in (TS `stripCronEnvelope` parity).
fn strip_cron_envelope(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let enveloped = lines.len() >= 2
        && lines[0].starts_with("<cron-fire ")
        && lines[lines.len() - 1] == "</cron-fire>";
    if enveloped {
        lines[1..lines.len() - 1].join("\n")
    } else {
        text.to_string()
    }
}

/// The status line for a `permission_updated` record (TS
/// `renderPermissionUpdate` parity): yolo announces the automatic-approval
/// mode with its caution note, manual turns it off, any other mode names
/// itself.
fn permission_updated_line(record: &serde_json::Value) -> TranscriptLine {
    let mode = record["mode"].as_str().unwrap_or("");
    let text = match mode {
        "yolo" => format!(
            "{} — {}",
            t("tui.replay.yoloModeOn"),
            t("tui.replay.yoloModeOnSub")
        ),
        "manual" => t("tui.replay.yoloModeOff").to_string(),
        other => t!("tui.replay.permissionMode", other),
    };
    TranscriptLine::status(text)
}

/// The status line for an `approval_result` record, plus the ExitPlanMode
/// suppression handshake. Returns `None` when the result renders nothing —
/// an approved plan review arms the plan-off suppression instead (TS
/// `renderApprovalResult` / `renderPlanReviewResult` parity).
fn approval_result_line(
    record: &serde_json::Value,
    suppress_next_plan_off: &mut bool,
) -> Option<TranscriptLine> {
    // The typed record wraps its payload: `{ "type": "approval_result",
    // "record": { tool_name, tool_call_id, action, decision, scope?, feedback? } }`.
    let record = &record["record"];
    if record["tool_name"].as_str() == Some("ExitPlanMode") {
        return plan_review_line(record, suppress_next_plan_off);
    }
    let mut text = match record["decision"].as_str() {
        Some("approved") => {
            if record["scope"].as_str() == Some("session") {
                t("tui.replay.approvedForSession").to_string()
            } else {
                t("tui.replay.approved").to_string()
            }
        }
        Some("rejected") => t("tui.replay.rejected").to_string(),
        Some("cancelled") => t("tui.replay.cancelled").to_string(),
        _ => return None,
    };
    let action = record["action"].as_str().unwrap_or("").trim();
    if !action.is_empty() {
        text.push_str(&format!(": {action}"));
    }
    if let Some(feedback) = record["feedback"].as_str().filter(|f| !f.is_empty()) {
        text.push_str(&format!(" — \"{feedback}\""));
    }
    Some(TranscriptLine::status(text))
}

/// `ExitPlanMode` approval results render plan-review lines (TS
/// `renderPlanReviewResult` parity): an approval renders nothing and arms
/// the plan-off suppression; a rejection (with `selectedLabel` "Revise"
/// marked as sent back for revision) or cancellation renders the verdict,
/// with the feedback appended as a detail.
fn plan_review_line(
    record: &serde_json::Value,
    suppress_next_plan_off: &mut bool,
) -> Option<TranscriptLine> {
    match record["decision"].as_str() {
        Some("approved") => {
            *suppress_next_plan_off = true;
            None
        }
        Some("rejected") => {
            let base = if record["selectedLabel"].as_str() == Some("Revise") {
                t("tui.replay.planSentBackForRevision")
            } else {
                t("tui.replay.planReviewRejected")
            };
            Some(TranscriptLine::status(with_feedback(base, record)))
        }
        Some("cancelled") => Some(TranscriptLine::status(with_feedback(
            t("tui.replay.planReviewCancelled"),
            record,
        ))),
        _ => None,
    }
}

/// Append the record's feedback as a ` — Feedback: …` detail when present.
fn with_feedback(base: &str, record: &serde_json::Value) -> String {
    match record["feedback"].as_str().filter(|f| !f.is_empty()) {
        Some(feedback) => format!("{base} — {}", t!("tui.replay.feedback", feedback)),
        None => base.to_string(),
    }
}

/// Serialize a tool-call `arguments` / `input` field to the card's JSON
/// text (strings pass through, objects round-trip through serde).
fn args_string(args: &serde_json::Value) -> String {
    match args {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        _ => serde_json::to_string(args).unwrap_or_default(),
    }
}

/// Append a tool-call card for `(id, name, args)` and register it for
/// result pairing. Calls with an empty id or name are skipped (TS
/// `toolCallFromReplayMessage` parity — empty ids can't be matched later).
fn push_card(
    entries: &mut Vec<TranscriptEntry>,
    cards: &mut HashMap<String, usize>,
    id: &str,
    name: &str,
    args: String,
) {
    if id.is_empty() || name.is_empty() {
        return;
    }
    let collapsed = args.chars().count() > TOOL_COLLAPSE_THRESHOLD;
    let is_question = name == "AskUserQuestion";
    entries.push(TranscriptEntry::ToolCall(ToolCallEntry {
        tool_call_id: id.to_string(),
        tool_name: name.to_string(),
        args,
        result: None,
        is_error: false,
        is_question,
        duration: None,
        collapsed,
        image: None,
    }));
    cards.insert(id.to_string(), entries.len() - 1);
}

/// Land a tool result on its card (matched by `tool_call_id`). Unknown ids
/// and already-settled cards are no-ops — a result can arrive both as a
/// `tool_result` record and as a `role == "tool"` message.
fn patch_result(
    entries: &mut Vec<TranscriptEntry>,
    cards: &mut HashMap<String, usize>,
    id: &str,
    output: String,
    is_error: bool,
) {
    if id.is_empty() {
        return;
    }
    let Some(&index) = cards.get(id) else {
        return;
    };
    if let Some(TranscriptEntry::ToolCall(tc)) = entries.get_mut(index) {
        if tc.result.is_some() {
            return;
        }
        tc.result = Some(output);
        tc.is_error = is_error;
        if tool_result_collapsed(tc.result.as_deref().unwrap_or("")) {
            tc.collapsed = true;
        }
    }
}

/// The status line for a `goal_updated` snapshot (camelCase engine
/// `GoalStatus`; snake_case forms accepted defensively). `None` for a
/// cleared (null) or unknown snapshot — those render nothing.
fn goal_status_line(snapshot: &serde_json::Value) -> Option<TranscriptLine> {
    let status = snapshot["status"].as_str().unwrap_or("");
    let line = match status {
        "active" => t("tui.replay.goalActive"),
        "paused" => t("tui.replay.goalPaused"),
        "blocked" => t("tui.replay.goalBlocked"),
        "complete" => t("tui.replay.goalComplete"),
        "budgetLimited" | "budget_limited" => t("tui.replay.goalBudgetLimited"),
        "usageLimited" | "usage_limited" => t("tui.replay.goalUsageLimited"),
        "cancelled" | "failed" => t("tui.replay.goalEnded"),
        _ => return None,
    };
    Some(TranscriptLine::status(line.to_string()))
}

/// The status line for a `compaction_completed` record: cancelled results
/// and plain completions reuse the live compact messages, completions with
/// a summary carry it (TS `renderCompaction` parity, simplified).
fn compaction_completed_line(record: &serde_json::Value) -> Option<TranscriptLine> {
    let result = &record["result"];
    if result.as_str() == Some("cancelled") {
        return Some(TranscriptLine::status(
            t("tui.replay.compactionCancelled").to_string(),
        ));
    }
    let summary = result["summary"].as_str().unwrap_or("").trim();
    if summary.is_empty() {
        return Some(TranscriptLine::status(t("tui.compact.ok").to_string()));
    }
    let preview: String = summary.chars().take(200).collect();
    Some(TranscriptLine::status(t!(
        "tui.replay.compactedWithSummary",
        preview
    )))
}

/// Background-task statuses that ended (TS `isTerminalBackgroundTask`).
fn is_terminal_bg_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "timed_out" | "killed" | "lost")
}

/// Render the terminal background tasks of a `session/resume_state` result
/// (`agents.main.background`) as status lines: `agent` tasks show their
/// description or `agentId`, `task` tasks their description or `taskId`
/// (TS `formatBackgroundAgentTranscript` / `formatBackgroundTaskTranscript`
/// semantics, simplified). Running tasks stay silent — the live event
/// stream owns them.
pub fn render_background(data: &serde_json::Value) -> Vec<TranscriptEntry> {
    let Some(list) = data
        .get("agents")
        .and_then(|a| a.get("main"))
        .and_then(|m| m.get("background"))
        .and_then(|b| b.as_array())
    else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for info in list {
        let status = info["status"].as_str().unwrap_or("");
        if !is_terminal_bg_status(status) {
            continue;
        }
        let kind = info["kind"].as_str().unwrap_or("");
        let subject = info["description"]
            .as_str()
            .filter(|d| !d.is_empty())
            .or_else(|| {
                if kind == "agent" {
                    info["agentId"].as_str()
                } else {
                    info["taskId"].as_str()
                }
            })
            .unwrap_or("");
        let line = match status {
            "completed" => t!("tui.replay.bgCompleted", subject),
            "failed" => t!("tui.replay.bgFailed", subject),
            "timed_out" => t!("tui.replay.bgTimedOut", subject),
            "killed" => t!("tui.replay.bgStopped", subject),
            "lost" => t!("tui.replay.bgLost", subject),
            _ => continue,
        };
        entries.push(TranscriptEntry::Line(TranscriptLine::status(line)));
    }
    entries
}

/// The todo panel list of a `session/resume_state` result
/// (`agents.main.toolStore.todo`): `(title, status)` pairs. Missing or
/// non-array stores, and fully-completed lists, render empty (TS
/// `hydrateTodoPanel` parity).
pub fn todo_items(data: &serde_json::Value) -> Vec<(String, String)> {
    let Some(list) = data
        .get("agents")
        .and_then(|a| a.get("main"))
        .and_then(|m| m.get("toolStore"))
        .and_then(|s| s.get("todo"))
        .and_then(|t| t.as_array())
    else {
        return Vec::new();
    };
    parse_todo_list(list)
}

/// The todo list carried by a `session.todo.updated` event
/// (`{ todos: [{ title, status }] }`), with the same parsing + clearing as
/// resume.
pub fn todo_items_from_event(event: &serde_json::Value) -> Vec<(String, String)> {
    let Some(list) = event.get("todos").and_then(|t| t.as_array()) else {
        return Vec::new();
    };
    parse_todo_list(list)
}

/// Parse `[{title, status}]` into `(title, status)` pairs, dropping
/// malformed entries. When every entry is completed the panel clears (the
/// engine considers an all-done list finished).
fn parse_todo_list(list: &[serde_json::Value]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for item in list {
        let Some(title) = item["title"].as_str().filter(|t| !t.is_empty()) else {
            continue;
        };
        let Some(status) = item["status"].as_str() else {
            continue;
        };
        if !matches!(status, "pending" | "in_progress" | "completed") {
            continue;
        }
        out.push((title.to_string(), status.to_string()));
    }
    if !out.is_empty() && out.iter().all(|(_, s)| s == "completed") {
        return Vec::new();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{TranscriptKind, TranscriptLine};

    /// Unwrap a plain Line entry (test helper).
    fn line(entry: &TranscriptEntry) -> &TranscriptLine {
        match entry {
            TranscriptEntry::Line(l) => l,
            TranscriptEntry::ToolCall(_) | TranscriptEntry::Task(_) => {
                panic!("expected a Line entry")
            }
        }
    }

    /// Unwrap a ToolCall card (test helper).
    fn card(entry: &TranscriptEntry) -> &ToolCallEntry {
        match entry {
            TranscriptEntry::ToolCall(tc) => tc,
            TranscriptEntry::Line(_) | TranscriptEntry::Task(_) => {
                panic!("expected a ToolCall entry")
            }
        }
    }

    fn msg(role: &str, content: &str) -> serde_json::Value {
        serde_json::json!({ "type": "message", "message": {
            "role": role,
            "content": [{ "type": "text", "text": content }],
        }})
    }

    fn msg_origin(
        role: &str,
        content: &str,
        origin: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({ "type": "message", "message": {
            "role": role,
            "content": [{ "type": "text", "text": content }],
            "origin": origin,
        }})
    }

    #[test]
    fn messages_render_in_order() {
        let records = vec![
            msg("user", "hi"),
            msg("assistant", "hello"),
            msg("user", "again"),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 3, "three visible messages: {entries:?}");
        assert_eq!(line(&entries[0]).kind, TranscriptKind::User);
        assert_eq!(line(&entries[0]).text, "hi");
        assert_eq!(line(&entries[1]).kind, TranscriptKind::Assistant);
        assert_eq!(line(&entries[1]).text, "hello");
        assert_eq!(line(&entries[2]).kind, TranscriptKind::User);
        assert_eq!(line(&entries[2]).text, "again");
    }

    #[test]
    fn system_messages_and_empty_text_are_skipped() {
        let records = vec![
            serde_json::json!({ "type": "message", "message": {
                "role": "system", "content": [{ "type": "text", "text": "framing" }],
            }}),
            serde_json::json!({ "type": "message", "message": {
                "role": "user", "content": [],
            }}),
            serde_json::json!({ "type": "message", "message": {
                "role": "assistant", "content": [{ "type": "image", "url": "x" }],
            }}),
        ];
        assert!(render_replay_records(&records).is_empty());
    }

    #[test]
    fn assistant_tool_calls_render_cards_and_pair_with_results() {
        let records = vec![
            serde_json::json!({ "type": "message", "message": {
                "role": "user", "content": [{ "type": "text", "text": "run" }],
            }}),
            serde_json::json!({ "type": "message", "message": {
                "role": "assistant",
                "content": [],
                "tool_calls": [{
                    "id": "call-1",
                    "name": "Bash",
                    "arguments": { "command": "ls" },
                }],
            }}),
            serde_json::json!({ "type": "tool_result",
                "tool_call_id": "call-1", "name": "Bash",
                "output": "src\n", "is_error": false,
            }),
            msg("assistant", "done"),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 3, "user + card + assistant: {entries:?}");
        let tc = card(&entries[1]);
        assert_eq!(tc.tool_call_id, "call-1");
        assert_eq!(tc.tool_name, "Bash");
        assert!(tc.args.contains("\"command\""), "args: {}", tc.args);
        assert_eq!(tc.result.as_deref(), Some("src\n"));
        assert!(!tc.is_error);
        assert_eq!(line(&entries[2]).text, "done");
    }

    #[test]
    fn standalone_tool_records_pair_into_one_card() {
        let records = vec![
            serde_json::json!({ "type": "tool_call",
                "tool_call_id": "t1", "name": "Read",
                "input": { "path": "a.txt" },
            }),
            serde_json::json!({ "type": "tool_result",
                "tool_call_id": "t1", "name": "Read",
                "output": "contents", "is_error": true,
            }),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "one paired card: {entries:?}");
        let tc = card(&entries[0]);
        assert_eq!(tc.result.as_deref(), Some("contents"));
        assert!(tc.is_error);
    }

    #[test]
    fn tool_result_without_a_card_is_skipped() {
        let records = vec![serde_json::json!({ "type": "tool_result",
            "tool_call_id": "ghost", "name": "Bash",
            "output": "x", "is_error": false,
        })];
        assert!(render_replay_records(&records).is_empty());
    }

    #[test]
    fn long_results_start_collapsed() {
        let records = vec![
            serde_json::json!({ "type": "tool_call",
                "tool_call_id": "t1", "name": "Bash", "input": {} }),
            serde_json::json!({ "type": "tool_result",
                "tool_call_id": "t1", "name": "Bash",
                "output": "x".repeat(500), "is_error": false,
            }),
        ];
        let entries = render_replay_records(&records);
        assert!(card(&entries[0]).collapsed, "long result folds: {entries:?}");
    }

    #[test]
    fn tool_messages_settle_their_card() {
        let records = vec![
            serde_json::json!({ "type": "message", "message": {
                "role": "assistant", "content": [],
                "tool_calls": [{ "id": "c1", "name": "Bash", "arguments": {} }],
            }}),
            serde_json::json!({ "type": "message", "message": {
                "role": "tool", "toolCallId": "c1",
                "content": [{ "type": "text", "text": "output" }],
                "isError": false,
            }}),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "card only: {entries:?}");
        assert_eq!(card(&entries[0]).result.as_deref(), Some("output"));
    }

    #[test]
    fn unmatched_tool_messages_render_as_tool_lines() {
        let records = vec![serde_json::json!({ "type": "message", "message": {
            "role": "tool", "content": [{ "type": "text", "text": "ok" }],
        }})];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1);
        assert_eq!(line(&entries[0]).kind, TranscriptKind::Tool);
        assert_eq!(line(&entries[0]).text, "ok");
    }

    #[test]
    fn shell_command_frames_render_as_dollar_cmd_and_output() {
        let records = vec![
            serde_json::json!({ "type": "message", "message": {
                "role": "user",
                "content": [{ "type": "text", "text":
                    "<bash-input>echo &lt;hi&gt;</bash-input>" }],
                "origin": { "kind": "shell_command", "phase": "input" },
            }}),
            serde_json::json!({ "type": "message", "message": {
                "role": "user",
                "content": [{ "type": "text", "text":
                    "<bash-stdout>hello\nworld</bash-stdout>" }],
                "origin": { "kind": "shell_command", "phase": "output" },
            }}),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(line(&entries[0]).kind, TranscriptKind::User);
        assert_eq!(line(&entries[0]).text, "$ echo <hi>");
        assert_eq!(line(&entries[1]).kind, TranscriptKind::Status);
        assert_eq!(line(&entries[1]).text, "hello\nworld");
    }

    #[test]
    fn injection_and_system_trigger_messages_are_skipped() {
        for kind in ["injection", "system_trigger"] {
            let records = vec![serde_json::json!({ "type": "message", "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "secret prompt" }],
                "origin": { "kind": kind },
            }})];
            assert!(
                render_replay_records(&records).is_empty(),
                "origin {kind} must be skipped"
            );
        }
    }

    #[test]
    fn skill_plugin_and_background_origins_render_status_lines() {
        let records = vec![
            serde_json::json!({ "type": "message", "message": {
                "role": "user", "content": [],
                "origin": { "kind": "skill_activation", "skill_name": "code-review" },
            }}),
            serde_json::json!({ "type": "message", "message": {
                "role": "user", "content": [],
                "origin": { "kind": "plugin_command",
                    "plugin_id": "github", "command_name": "pr" },
            }}),
            serde_json::json!({ "type": "message", "message": {
                "role": "user", "content": [],
                "origin": { "kind": "background_task",
                    "task_id": "bt-1", "status": "completed" },
            }}),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 3, "{entries:?}");
        assert_eq!(line(&entries[0]).kind, TranscriptKind::Status);
        assert_eq!(line(&entries[0]).text, "skill activated: code-review");
        assert_eq!(line(&entries[1]).text, "/github:pr");
        assert_eq!(line(&entries[2]).text, "background task bt-1: completed");
    }

    #[test]
    fn hook_result_renders_assistant_markdown_line() {
        let records = vec![msg_origin(
            "user",
            "<hook_result hook_event=\"PreToolUse\">\nchecking…\n</hook_result>",
            serde_json::json!({ "kind": "hook_result" }),
        )];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "{entries:?}");
        let line = line(&entries[0]);
        assert_eq!(line.kind, TranscriptKind::Assistant, "{line:?}");
        // The event falls back to the XML attribute when origin.event is
        // absent; the body is trimmed and block title is markdown-emphasized.
        assert_eq!(line.text, "*PreToolUse hook*\n\nchecking…", "{line:?}");
    }

    #[test]
    fn hook_result_blocks_join_and_empty_bodies_mark_empty() {
        let records = vec![msg_origin(
            "assistant",
            concat!(
                "<hook_result hook_event=\"PreToolUse\">\nchecking…\n</hook_result>",
                "<hook_result hook_event=\"PostToolUse\">\n\n</hook_result>"
            ),
            serde_json::json!({ "kind": "hook_result", "event": "PreToolUse" }),
        )];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "{entries:?}");
        let text = line(&entries[0]).text.clone();
        // One `*event hook*` + body block per element; empty bodies get
        // `(empty)` (TS `formatHookResultBlock` parity).
        assert_eq!(
            text,
            "*PreToolUse hook*\n\nchecking…\n\n*PostToolUse hook*\n\n(empty)"
        );
    }

    #[test]
    fn hook_result_mixed_text_falls_back_to_one_block() {
        // Non-hook text around the block → the whole message renders under
        // the origin's event (TS formatHookResultMessageForTranscript).
        let mixed = "<hook_result hook_event=\"PreToolUse\">\nbody\n</hook_result>\ntrailing";
        let records = vec![msg_origin(
            "assistant",
            mixed,
            serde_json::json!({ "kind": "hook_result", "event": "UserPromptSubmit" }),
        )];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(
            line(&entries[0]).text,
            format!("*UserPromptSubmit hook*\n\n{mixed}")
        );
        // No block at all → same fallback over the raw text.
        let records = vec![msg_origin(
            "user",
            "plain output",
            serde_json::json!({ "kind": "hook_result", "event": "Stop" }),
        )];
        assert_eq!(
            line(&render_replay_records(&records)[0]).text,
            "*Stop hook*\n\nplain output"
        );
    }

    #[test]
    fn hook_result_blocked_marks_the_title() {
        let records = vec![msg_origin(
            "user",
            "<hook_result hook_event=\"PreToolUse\">\nno\n</hook_result>",
            serde_json::json!({ "kind": "hook_result", "blocked": true }),
        )];
        let entries = render_replay_records(&records);
        assert_eq!(line(&entries[0]).text, "*PreToolUse hook blocked*\n\nno");
    }

    #[test]
    fn cron_job_renders_fired_line_with_extracted_prompt() {
        // The `<prompt>\n…\n</prompt>` body is extracted (TS extractCronPrompt).
        let records = vec![msg_origin(
            "user",
            "<prompt>\nRun the report\n</prompt>",
            serde_json::json!({ "kind": "cron_job", "job_id": "j1", "cron": "0 9 * * *" }),
        )];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(line(&entries[0]).kind, TranscriptKind::Status);
        assert_eq!(
            line(&entries[0]).text,
            "⏰ Scheduled reminder fired: Run the report"
        );
        // Without `<prompt>` tags the cron envelope is stripped instead.
        let records = vec![msg_origin(
            "user",
            "<cron-fire job_id=\"j1\" cron=\"0 9 * * *\">\nhello\n</cron-fire>",
            serde_json::json!({ "kind": "cron_job", "job_id": "j1", "cron": "0 9 * * *" }),
        )];
        assert_eq!(
            line(&render_replay_records(&records)[0]).text,
            "⏰ Scheduled reminder fired: hello"
        );
        // Plain text passes through untouched.
        let records = vec![msg_origin(
            "user",
            "just text",
            serde_json::json!({ "kind": "cron_job", "job_id": "j1", "cron": "0 9 * * *" }),
        )];
        assert_eq!(
            line(&render_replay_records(&records)[0]).text,
            "⏰ Scheduled reminder fired: just text"
        );
    }

    #[test]
    fn cron_missed_renders_missed_line_with_count() {
        let records = vec![msg_origin(
            "user",
            "<cron-fire job_id=\"j1\">\nmissed prompt\n</cron-fire>",
            serde_json::json!({ "kind": "cron_missed", "count": 3 }),
        )];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(
            line(&entries[0]).text,
            "Missed scheduled reminders: missed prompt (3 missed)"
        );
        // Without a count the stripped content stands alone.
        let records = vec![msg_origin(
            "user",
            "<cron-fire job_id=\"j1\">\nmissed prompt\n</cron-fire>",
            serde_json::json!({ "kind": "cron_missed" }),
        )];
        assert_eq!(
            line(&render_replay_records(&records)[0]).text,
            "Missed scheduled reminders: missed prompt"
        );
    }

    #[test]
    fn plan_updated_renders_status_lines() {
        let records = vec![
            serde_json::json!({ "type": "plan_updated", "enabled": true }),
            serde_json::json!({ "type": "plan_updated", "enabled": false }),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(line(&entries[0]).kind, TranscriptKind::Status);
        assert_eq!(line(&entries[0]).text, "Plan mode: ON");
        assert_eq!(line(&entries[1]).text, "Plan mode: OFF");
    }

    #[test]
    fn permission_updated_renders_mode_lines() {
        let cases = [
            ("yolo", "YOLO mode: ON — All actions will be approved automatically. Use with caution."),
            ("manual", "YOLO mode: OFF"),
            ("auto", "Permission mode: auto"),
            ("plan", "Permission mode: plan"),
        ];
        for (mode, expected) in cases {
            let records = vec![serde_json::json!({ "type": "permission_updated", "mode": mode })];
            let entries = render_replay_records(&records);
            assert_eq!(entries.len(), 1, "mode {mode}: {entries:?}");
            assert_eq!(line(&entries[0]).kind, TranscriptKind::Status);
            assert_eq!(line(&entries[0]).text, expected, "mode {mode}");
        }
    }

    #[test]
    fn approval_result_renders_decision_lines() {
        let record = |decision: &str, scope: Option<&str>, feedback: Option<&str>| {
            let mut value = serde_json::json!({
                "type": "approval_result",
                "record": {
                    "tool_name": "Bash",
                    "tool_call_id": "c1",
                    "action": "Bash(command: ls)",
                    "decision": decision,
                },
            });
            if let Some(scope) = scope {
                value["record"]["scope"] = serde_json::json!(scope);
            }
            if let Some(feedback) = feedback {
                value["record"]["feedback"] = serde_json::json!(feedback);
            }
            value
        };
        let entries = render_replay_records(&[
            record("approved", None, None),
            record("approved", Some("session"), None),
            record("rejected", None, None),
            record("cancelled", None, Some("user gave up")),
        ]);
        assert_eq!(entries.len(), 4, "{entries:?}");
        assert_eq!(line(&entries[0]).kind, TranscriptKind::Status);
        assert_eq!(line(&entries[0]).text, "Approved: Bash(command: ls)");
        assert_eq!(line(&entries[1]).text, "Approved for session: Bash(command: ls)");
        assert_eq!(line(&entries[2]).text, "Rejected: Bash(command: ls)");
        assert_eq!(
            line(&entries[3]).text,
            "Cancelled: Bash(command: ls) — \"user gave up\""
        );
        // Unknown decisions render nothing.
        assert!(
            render_replay_records(&[record("weird", None, None)]).is_empty(),
            "unknown decision must be skipped"
        );
    }

    #[test]
    fn exit_plan_mode_approval_suppresses_plan_off_notice() {
        let records = vec![
            serde_json::json!({ "type": "approval_result", "record": {
                "tool_name": "ExitPlanMode", "tool_call_id": "c1",
                "action": "ExitPlanMode()", "decision": "approved",
            }}),
            serde_json::json!({ "type": "plan_updated", "enabled": false }),
        ];
        let entries = render_replay_records(&records);
        assert!(
            entries.is_empty(),
            "the plan-off notice after an approved plan is redundant: {entries:?}"
        );
        // The suppression is one-shot: the next disabled plan update renders.
        let records = vec![
            serde_json::json!({ "type": "approval_result", "record": {
                "tool_name": "ExitPlanMode", "tool_call_id": "c1",
                "action": "ExitPlanMode()", "decision": "approved",
            }}),
            serde_json::json!({ "type": "plan_updated", "enabled": false }),
            serde_json::json!({ "type": "plan_updated", "enabled": false }),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(line(&entries[0]).text, "Plan mode: OFF");
        // Enabling plan mode is never suppressed.
        let records = vec![
            serde_json::json!({ "type": "approval_result", "record": {
                "tool_name": "ExitPlanMode", "tool_call_id": "c1",
                "action": "ExitPlanMode()", "decision": "approved",
            }}),
            serde_json::json!({ "type": "plan_updated", "enabled": true }),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(line(&entries[0]).text, "Plan mode: ON");
    }

    #[test]
    fn exit_plan_mode_rejected_and_cancelled_render_verdicts() {
        let verdict = |decision: &str, selected_label: Option<&str>, feedback: Option<&str>| {
            let mut value = serde_json::json!({ "type": "approval_result", "record": {
                "tool_name": "ExitPlanMode", "tool_call_id": "c1",
                "action": "ExitPlanMode()", "decision": decision,
            }});
            if let Some(label) = selected_label {
                value["record"]["selectedLabel"] = serde_json::json!(label);
            }
            if let Some(feedback) = feedback {
                value["record"]["feedback"] = serde_json::json!(feedback);
            }
            value
        };
        let entries = render_replay_records(&[
            verdict("rejected", Some("Revise"), None),
            verdict("rejected", None, Some("wrong approach")),
            verdict("cancelled", None, None),
        ]);
        assert_eq!(entries.len(), 3, "{entries:?}");
        assert_eq!(line(&entries[0]).text, "Plan sent back for revision");
        assert_eq!(
            line(&entries[1]).text,
            "Plan review rejected — Feedback: wrong approach"
        );
        assert_eq!(line(&entries[2]).text, "Plan review cancelled");
    }

    #[test]
    fn unknown_origins_fall_back_to_user_lines() {
        let records = vec![serde_json::json!({ "type": "message", "message": {
            "role": "user",
            "content": [{ "type": "text", "text": "hello" }],
            "origin": { "kind": "some_future_kind" },
        }})];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 1);
        assert_eq!(line(&entries[0]).kind, TranscriptKind::User);
        assert_eq!(line(&entries[0]).text, "hello");
    }

    #[test]
    fn goal_updated_renders_status_lines() {
        let statuses = [
            ("active", "goal active"),
            ("paused", "goal paused"),
            ("blocked", "goal blocked"),
            ("complete", "goal complete"),
            ("budgetLimited", "goal stopped: budget limit reached"),
            ("usageLimited", "goal stopped: usage limit reached"),
            ("cancelled", "goal ended"),
        ];
        for (status, expected) in statuses {
            let records = vec![serde_json::json!({ "type": "goal_updated",
                "snapshot": { "status": status },
            })];
            let entries = render_replay_records(&records);
            assert_eq!(entries.len(), 1, "status {status}");
            assert_eq!(line(&entries[0]).kind, TranscriptKind::Status);
            assert_eq!(line(&entries[0]).text, expected, "status {status}");
        }
        // Cleared (null) / unknown snapshots render nothing.
        for snapshot in [serde_json::Value::Null, serde_json::json!({ "status": "weird" })] {
            let records = vec![serde_json::json!({ "type": "goal_updated",
                "snapshot": snapshot })];
            assert!(render_replay_records(&records).is_empty(), "{snapshot}");
        }
    }

    #[test]
    fn compaction_records_render_status_lines() {
        let records = vec![
            serde_json::json!({ "type": "compaction_started", "trigger": "manual" }),
            serde_json::json!({ "type": "compaction_completed",
                "result": { "summary": "did stuff", "tokens_before": 100, "tokens_after": 50 },
            }),
        ];
        let entries = render_replay_records(&records);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(line(&entries[0]).text, "compacting context…");
        assert_eq!(line(&entries[1]).text, "context compacted: did stuff");
        // Cancelled results and summary-less completions use the plain lines.
        let records = vec![serde_json::json!({ "type": "compaction_completed",
            "result": "cancelled" })];
        assert_eq!(
            line(&render_replay_records(&records)[0]).text,
            "compaction cancelled"
        );
    }

    #[test]
    fn bookkeeping_records_are_skipped() {
        let records = vec![
            serde_json::json!({ "type": "turn_started", "turn_id": "t1" }),
            serde_json::json!({ "type": "turn_ended", "turn_id": "t1" }),
            serde_json::json!({ "type": "usage_updated", "model": "kimi-k2" }),
            serde_json::json!({ "type": "what_is_this", "data": 1 }),
        ];
        assert!(render_replay_records(&records).is_empty());
    }

    #[test]
    fn render_replay_reads_agents_main() {
        let data = serde_json::json!({ "agents": { "main": {
            "replay": [msg("user", "hi")],
            "background": [],
            "toolStore": { "todo": [] },
        }}});
        assert_eq!(render_replay(&data).len(), 1);
        assert!(render_replay(&serde_json::json!({})).is_empty());
        assert!(render_replay(&serde_json::json!({ "agents": {} })).is_empty());
    }

    #[test]
    fn background_renders_terminal_tasks_only() {
        let data = serde_json::json!({ "agents": { "main": {
            "background": [
                { "taskId": "bt-1", "kind": "task", "status": "running",
                  "description": "npm test" },
                { "taskId": "bt-2", "kind": "task", "status": "completed",
                  "description": "pnpm build" },
                { "taskId": "bt-3", "kind": "task", "status": "failed",
                  "description": "cargo test" },
                { "taskId": "bt-4", "kind": "agent", "agentId": "sub-1",
                  "status": "lost", "description": "" },
                { "taskId": "bt-5", "kind": "task", "status": "timed_out",
                  "description": "" },
                { "taskId": "bt-6", "kind": "task", "status": "killed",
                  "description": "server" },
            ],
        }}});
        let entries = render_background(&data);
        let texts: Vec<&str> = entries.iter().map(|e| line(e).text.as_str()).collect();
        assert_eq!(texts, vec![
            "pnpm build completed in background",
            "cargo test failed in background",
            "sub-1 lost in background",
            "bt-5 timed out in background",
            "server stopped in background",
        ]);
        assert!(render_background(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn todo_items_parse_and_clear_when_all_done() {
        let data = |todos: serde_json::Value| serde_json::json!({ "agents": { "main": {
            "replay": [], "background": [], "toolStore": { "todo": todos },
        }}});
        let mixed = data(serde_json::json!([
            { "title": "fix bug", "status": "in_progress" },
            { "title": "write tests", "status": "pending" },
            { "title": "ship it", "status": "completed" },
        ]));
        assert_eq!(todo_items(&mixed), vec![
            ("fix bug".to_string(), "in_progress".to_string()),
            ("write tests".to_string(), "pending".to_string()),
            ("ship it".to_string(), "completed".to_string()),
        ]);
        // All completed → the panel clears (TS hydrateTodoPanel parity).
        let done = data(serde_json::json!([
            { "title": "a", "status": "completed" },
            { "title": "b", "status": "completed" },
        ]));
        assert!(todo_items(&done).is_empty());
        // Missing / malformed entries are dropped; unknown statuses too.
        let malformed = data(serde_json::json!([
            { "title": "ok", "status": "pending" },
            { "title": "", "status": "pending" },
            { "title": "weird", "status": "done" },
            { "title": "no-status" },
        ]));
        assert_eq!(todo_items(&malformed), vec![
            ("ok".to_string(), "pending".to_string())
        ]);
        assert!(todo_items(&serde_json::json!({})).is_empty());
        assert!(todo_items(&data(serde_json::Value::Null)).is_empty());
    }

    #[test]
    fn todo_events_parse_like_resume() {
        let event = serde_json::json!({ "type": "session.todo.updated",
            "session_id": "s1", "todos": [
                { "title": "a", "status": "in_progress" },
                { "title": "b", "status": "completed" },
            ],
        });
        assert_eq!(todo_items_from_event(&event), vec![
            ("a".to_string(), "in_progress".to_string()),
            ("b".to_string(), "completed".to_string()),
        ]);
        assert!(todo_items_from_event(&serde_json::json!({ "type": "x" })).is_empty());
        // All-done events clear the panel too.
        let done = serde_json::json!({ "todos": [{ "title": "a", "status": "completed" }] });
        assert!(todo_items_from_event(&done).is_empty());
    }

    #[test]
    fn render_resume_state_combines_replay_and_background() {
        let data = serde_json::json!({ "agents": { "main": {
            "replay": [msg("user", "hi")],
            "background": [
                { "taskId": "bt-2", "kind": "task", "status": "completed",
                  "description": "pnpm build" },
            ],
            "toolStore": { "todo": [] },
        }}});
        let entries = render_resume_state(&data);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(line(&entries[0]).kind, TranscriptKind::User);
        assert_eq!(line(&entries[1]).text, "pnpm build completed in background");
    }

    #[test]
    fn extract_bash_tag_unescapes_entities() {
        assert_eq!(
            extract_bash_tag("<bash-input>a &lt;b&gt; &amp; c</bash-input>", "bash-input"),
            Some("a <b> & c".to_string())
        );
        assert_eq!(extract_bash_tag("no tags", "bash-input"), None);
    }

    #[test]
    fn extract_cron_prompt_extracts_and_falls_back() {
        assert_eq!(
            extract_cron_prompt("<prompt>\nRun it\n</prompt>"),
            "Run it"
        );
        // Multiple prompt tags: the last closing tag wins (TS lastIndexOf).
        assert_eq!(
            extract_cron_prompt("<prompt>\nA\n</prompt>\n<prompt>\nB\n</prompt>"),
            "A\n</prompt>\n<prompt>\nB"
        );
        // No prompt tags → envelope-stripped text.
        assert_eq!(
            extract_cron_prompt("<cron-fire job_id=\"j1\">\nhello\n</cron-fire>"),
            "hello"
        );
        assert_eq!(extract_cron_prompt("plain"), "plain");
    }

    #[test]
    fn strip_cron_envelope_strips_only_when_wrapped() {
        assert_eq!(
            strip_cron_envelope("<cron-fire job_id=\"j1\">\nmissed\n</cron-fire>"),
            "missed"
        );
        assert_eq!(strip_cron_envelope("no envelope"), "no envelope");
        // An opening line without the closing tag is left alone.
        assert_eq!(
            strip_cron_envelope("<cron-fire job_id=\"j1\">\nmissed"),
            "<cron-fire job_id=\"j1\">\nmissed"
        );
    }
}
