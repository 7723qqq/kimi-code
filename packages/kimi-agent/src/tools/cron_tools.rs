//! Native execution of the cron tool family (CronList / CronCreate /
//! CronDelete) over the state bridge protocol (design doc milestone 7,
//! batch 7).
//!
//! The host stays the cron authority: it owns the task registry, the
//! scheduler, jitter, and the local timezone. The engine reads the task
//! list through `host/state_read {domain: "cron"}` and submits
//! action-shaped writes (`{action: "create" | "delete", ...}`) through
//! `host/state_write`. Rendering mirrors the v2 tools; timezone-dependent
//! values (`nextFireAt`) arrive pre-formatted from the host, which owns
//! the local-time ISO rendering and the post-jitter fire time.

use serde::Deserialize;
use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{StateReadRequest, StateWriteRequest};
use crate::turn_loop::types::ExecutableToolResult;

/// v2 `PROMPT_PREVIEW_BYTES`: CronList truncates long prompts to 200 UTF-8
/// bytes (at a character boundary) before JSON-encoding them.
const PROMPT_PREVIEW_BYTES: usize = 200;
/// v2 `MS_PER_DAY`, used for the `ageDays` rendering.
const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot manage cron
/// jobs for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot manage cron jobs.";

/// Wire shape of one cron task as returned by the host (v2 `CronTask` plus
/// the host-computed rendering fields). `nextFireAt` is a pre-formatted
/// local ISO string or `null` — the host owns the timezone and jitter;
/// `stale` is the host's staleness verdict (it owns the `noStale` config).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronTaskWire {
    id: String,
    cron: String,
    prompt: String,
    created_at: u64,
    #[serde(default = "default_true")]
    recurring: bool,
    #[serde(default)]
    next_fire_at: Option<String>,
    #[serde(default)]
    stale: bool,
}

fn default_true() -> bool {
    true
}

/// Execute the CronList tool natively: `state_read` the cron domain and
/// render the v2-aligned list (header, `---`-separated records, empty
/// message).
pub async fn execute_cron_list(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let request = StateReadRequest {
        domain: "cron".into(),
        key: "cron".into(),
        turn_id: args
            .get("turn_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        tool_call_id: args
            .get("tool_call_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    };
    match callbacks.state_read(request).await {
        Ok(response) => render_cron_list(&response.value, now_ms()),
        Err(error) => map_state_error(error),
    }
}

/// Render the host's cron wire value (an array of tasks) as the v2
/// `CronList` output: `cron_jobs: N` header, records joined by a lone
/// `---` line, and the dedicated empty message.
fn render_cron_list(value: &Value, now_ms: i64) -> ExecutableToolResult {
    let tasks: Vec<CronTaskWire> = match serde_json::from_value(value.clone()) {
        Ok(tasks) => tasks,
        Err(_) => {
            return err_result(
                "Invalid cron state from host: expected an array of cron tasks.".into(),
            );
        }
    };
    let header = format!("cron_jobs: {}", tasks.len());
    if tasks.is_empty() {
        return ok_result(format!("{header}\nNo cron jobs scheduled."));
    }
    let records: Vec<String> = tasks.iter().map(|t| render_record(t, now_ms)).collect();
    ok_result(format!("{header}\n{}", records.join("\n---\n")))
}

/// Render one task record, mirroring v2 `CronListTool.renderRecord`: the
/// human schedule is computed from the expression (falling back to the raw
/// expression on parse failure, like the v2 try/catch), the prompt preview
/// is JSON-encoded, and `nextFireAt` passes through from the host.
fn render_record(task: &CronTaskWire, now_ms: i64) -> String {
    let human_schedule = match crate::cron::parse(&task.cron) {
        Ok(parsed) => crate::cron::to_human(&parsed),
        Err(_) => task.cron.clone(),
    };
    let next_fire_at = task.next_fire_at.as_deref().unwrap_or("null");
    let age_days = (now_ms - task.created_at as i64) as f64 / MS_PER_DAY;
    format!(
        "id: {}\ncron: {}\nhumanSchedule: {}\nprompt: {}\nnextFireAt: {}\nrecurring: {}\nageDays: {:.2}\nstale: {}",
        task.id,
        task.cron,
        human_schedule,
        json_string(&preview_prompt(&task.prompt)),
        next_fire_at,
        task.recurring,
        age_days,
        task.stale
    )
}

/// Execute the CronCreate tool natively: validate the arguments with the
/// ported cron pure functions, then `state_write` an action-shaped create
/// and render the v2-aligned output (id, cron, humanSchedule, recurring,
/// nextFireAt).
pub async fn execute_cron_create(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let Some(cron) = args.get("cron").and_then(|c| c.as_str()) else {
        return err_result("Invalid CronCreate arguments: `cron` must be a string.".into());
    };
    let Some(prompt) = args.get("prompt").and_then(|p| p.as_str()) else {
        return err_result("Invalid CronCreate arguments: `prompt` must be a string.".into());
    };
    if prompt.is_empty() {
        return err_result("Invalid CronCreate arguments: `prompt` must not be empty.".into());
    }
    let recurring = match args.get("recurring") {
        None | Some(Value::Null) => true,
        Some(value) => match value.as_bool() {
            Some(recurring) => recurring,
            None => {
                return err_result(
                    "Invalid CronCreate arguments: `recurring` must be a boolean.".into(),
                );
            }
        },
    };
    // v2 normalizes the expression: trim + collapse internal whitespace.
    let normalized = cron.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Err(message) = validate_create(&normalized, prompt, recurring, now_ms()) {
        return err_result(message);
    }
    let request = StateWriteRequest {
        domain: "cron".into(),
        key: "cron".into(),
        value: serde_json::json!({
            "action": "create",
            "cron": normalized,
            "prompt": prompt,
            "recurring": recurring,
        }),
        undoable: false,
        turn_id: args
            .get("turn_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        tool_call_id: args
            .get("tool_call_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    };
    match callbacks.state_write(request).await {
        Ok(response) => render_cron_create(&response.value),
        Err(error) => map_state_error(error),
    }
}

/// v2 `CronCreateTool` validation, in order: expression parse, 5-year fire
/// window, prompt byte cap, and the one-shot cap. The timezone offset is
/// unknown to the engine, so the time-dependent checks run in UTC — the
/// host re-validates authoritatively and may reject with its own message.
fn validate_create(
    normalized: &str,
    prompt: &str,
    recurring: bool,
    now_ms: i64,
) -> Result<(), String> {
    let parsed = match crate::cron::parse(normalized) {
        Ok(parsed) => parsed,
        Err(error) => return Err(format!("Invalid cron expression: {}", error.0)),
    };
    if !crate::cron::has_fire_within_years(&parsed, 5, now_ms, 0) {
        return Err(format!(
            "Cron expression {} has no fire within 5 years; refusing to schedule.",
            json_string(normalized)
        ));
    }
    if let Err(error) = crate::cron::validate_prompt_bytes(prompt, crate::cron::MAX_PROMPT_BYTES) {
        return Err(error.0);
    }
    if !recurring && let Err(error) = crate::cron::validate_one_shot(&parsed, now_ms, 0) {
        return Err(error.0);
    }
    Ok(())
}

/// Render the host's create response (the created task) as the v2
/// `CronCreate` output.
fn render_cron_create(value: &Value) -> ExecutableToolResult {
    let task: CronTaskWire = match serde_json::from_value(value.clone()) {
        Ok(task) => task,
        Err(_) => {
            return err_result(
                "Invalid cron state from host: expected the created cron task.".into(),
            );
        }
    };
    let human_schedule = match crate::cron::parse(&task.cron) {
        Ok(parsed) => crate::cron::to_human(&parsed),
        Err(_) => task.cron.clone(),
    };
    let next_fire_at = task.next_fire_at.as_deref().unwrap_or("null");
    ok_result(format!(
        "id: {}\ncron: {}\nhumanSchedule: {}\nrecurring: {}\nnextFireAt: {}",
        task.id, task.cron, human_schedule, task.recurring, next_fire_at
    ))
}

/// Execute the CronDelete tool natively: validate the id shape, then
/// `state_write` an action-shaped delete and render the v2 output. A
/// not-found id is the host's rejection (it owns the registry) and its
/// error passes through.
pub async fn execute_cron_delete(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let Some(id) = args.get("id").and_then(|i| i.as_str()) else {
        return err_result("Invalid CronDelete arguments: `id` must be a string.".into());
    };
    if !is_valid_cron_id(id) {
        return err_result(format!(
            "Invalid cron job id {} — must be a ULID.",
            json_string(id)
        ));
    }
    let request = StateWriteRequest {
        domain: "cron".into(),
        key: "cron".into(),
        value: serde_json::json!({ "action": "delete", "id": id }),
        undoable: false,
        turn_id: args
            .get("turn_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        tool_call_id: args
            .get("tool_call_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    };
    match callbacks.state_write(request).await {
        Ok(_) => ok_result(format!("Deleted cron job {id}.")),
        Err(error) => map_state_error(error),
    }
}

/// v2 `ID_PATTERN`: an 8-hex-digit id or a 26-character Crockford base32
/// ULID (case-insensitive; Crockford excludes I, L, O, U).
fn is_valid_cron_id(id: &str) -> bool {
    let is_hex8 = id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit());
    let is_ulid26 = id.len() == 26
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'I' | b'L' | b'O' | b'U'));
    is_hex8 || is_ulid26
}

/// v2 `previewPrompt`: truncate to 200 UTF-8 bytes at a character boundary,
/// appending `…(truncated)`.
fn preview_prompt(prompt: &str) -> String {
    if prompt.len() <= PROMPT_PREVIEW_BYTES {
        return prompt.to_string();
    }
    let bytes = prompt.as_bytes();
    let mut end = PROMPT_PREVIEW_BYTES;
    while end > 0 && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
    }
    format!("{}…(truncated)", &prompt[..end])
}

/// JSON-encode a string like `JSON.stringify` (used for the prompt preview
/// and for quoting values in error messages).
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// Map a state bridge error to a tool result: an unwired host (message
/// carries the `does not support state bridge` phrase) gets the dedicated
/// failure message; everything else is passed through verbatim — the engine
/// never retries a failed state write.
fn map_state_error(error: String) -> ExecutableToolResult {
    if error.contains("does not support state bridge") {
        err_result(STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE.into())
    } else {
        err_result(error)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ok_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: false,
        note: None,
    }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: true,
        note: None,
    }
}

/// Engine tool definition for CronList, so the model can discover and call
/// it (used by the standalone REPL and native tool listing). The schema
/// mirrors v2 `CronListInputSchema` (strict empty object).
pub fn cron_list_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "CronList".into(),
        description: r#"List all cron jobs currently scheduled in this session.

Use this tool to see every pending cron task — both recurring jobs and
one-shot reminders — that you (or the user) have scheduled with
`CronCreate`. The output is the entry point for inspecting scheduled
work: it returns a stable id, the original cron expression, a human
rendering, the next post-jitter fire time, the recurring flag, the
task's age in days, and a stale indicator.

Each record carries:

- `id` — the task id (a ULID). Pass this to `CronDelete` to remove the
  task, or quote it in user-facing messages when asking for
  confirmation.
- `cron` — the verbatim 5-field cron expression as scheduled.
- `humanSchedule` — plain-English rendering (e.g. `every 5 minutes`).
- `prompt` — the scheduled prompt text, JSON-encoded so embedded
  newlines stay on one line. Truncated to 200 UTF-8 bytes with
  `…(truncated)` if longer. Use this to recall what a task is for
  after a context compaction, and as the source for the
  `CronCreate` refresh ritual.
- `nextFireAt` — local ISO timestamp with an explicit numeric offset
  for the next fire **after jitter has been applied**. The actual fire
  may land slightly before or after a round `:00` / `:30` minute mark
  due to herd-avoidance jitter; this is the value the scheduler will
  compare against, so it reflects what will really happen. `null` if
  the expression has no fire in the next 5 years (should not happen
  for tasks created through `CronCreate`, which validates).
- `recurring` — `true` for cadenced jobs, `false` for one-shots.
- `ageDays` — `(now - createdAt) / day`, two decimal places. Useful
  when deciding whether a long-running cron is still relevant.
- `stale` — `true` when a recurring task is older than 7 days. The
  system **auto-deletes the task after this fire** to bound session
  lifetime; the `stale: true` flag is the model's notice that this is
  the final delivery. To resume the same schedule, call `CronCreate`
  again with the original `cron` and `prompt` (the `prompt` row above
  carries it for exactly this purpose). One-shots are never marked
  stale — they fire at most once by construction.

Guidelines:

- This tool is read-only and never mutates state, so it is always
  safe to call (including in plan mode).
- Users cannot directly manage cron tasks themselves; if they want to
  cancel or modify a schedule, route the request through the model
  (i.e. call `CronDelete` or `CronCreate` on their behalf).
- The empty case returns `cron_jobs: 0\nNo cron jobs scheduled.`. Cron
  tasks survive a resume of the same session but do not bleed into new
  sessions.
- After a context compaction, or whenever you are unsure which cron
  jobs are live, call this tool to re-enumerate them rather than
  guessing ids from earlier in the conversation.
- Records are separated by a line containing just `---`, in the
  insertion order they were scheduled."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    }
}

/// Engine tool definition for CronCreate, mirroring v2 `CronCreateTool` and
/// `CronCreateInputSchema`.
pub fn cron_create_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "CronCreate".into(),
        description: r#"Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. `0 9 * * *` means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

One-shots are best for near-term reminders. A task only fires while its session is still alive (see Session lifetime below), so favor near times — within hours or a few days — rather than scheduling weeks or months ahead.

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets `0 9`, and every user who asks for "hourly" gets `0 *` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

## Coalesce semantics

Fires are delivered only while the session is idle: a fire that comes due during an active turn is held and delivered at the next idle moment, never injected mid-turn.

If the scheduler slept past multiple ideal fire times (laptop closed, long-running turn, etc.), only **one** fire is delivered when it wakes up. The origin carries `coalescedCount` showing how many ideal fires were collapsed into this single delivery. You should treat `coalescedCount > 1` as "I missed some checks; only the latest state matters" rather than running the prompt that many times.

## Cron-fire envelope

When a cron task fires, the prompt you scheduled is re-injected wrapped in an XML envelope that exposes the fire context:

```
<cron-fire jobId="..." cron="..." recurring="true|false" coalescedCount="N" stale="true|false">
<prompt>
your original prompt text, verbatim
</prompt>
</cron-fire>
```

The envelope is parseable. Use `coalescedCount > 1` to know multiple ideal fires were collapsed into a single delivery (treat as "only the latest state matters"), and `stale="true"` as a cue that the task is past its 7-day threshold.

## 7-day stale behavior

Recurring tasks that have been alive for more than 7 days fire one
final time with `stale: true` on the envelope, and the system then
auto-deletes the task. The flag is the model's notice that this is
the last delivery. If the schedule is still wanted, call `CronCreate`
again with the same `cron` and `prompt` — that resets `createdAt` and
starts a fresh 7-day window. One-shot tasks are never marked stale.

## Jitter behavior

Anti-herd jitter is applied deterministically per task id:
  - Recurring: ideal fire time is shifted **forward** by an offset ≤ min(10% of the cron period, 15 minutes). A `*/5 * * * *` task can drift up to 30s; a `0 9 * * *` task can drift up to 15 minutes.
  - One-shot: only when the ideal fire lands on `:00` or `:30` of the hour, the fire is pulled **earlier** by ≤ 90 seconds. Other minutes pass through unchanged.

## One-shot vs recurring — when to pick which

Use `recurring: false` for "remind me at X" style requests, single deadlines, "in N minutes do Y", and any task that should not repeat. Use `recurring: true` for periodic polling (CI status, build watchers, scheduled reports), workday rituals, and anything the user explicitly described as recurring.

## Session lifetime

Cron tasks live in the current session. When you exit, they
are persisted under the session homedir; resuming the same session
reloads them and the scheduler resumes from each task's `createdAt`. Fire times that fell during the offline window are
collapsed into a single delivery via `coalescedCount` (and recurring
tasks past their 7-day window arrive with `stale: true` as their final
delivery).

Tasks do **not** carry over into a brand-new session — they are scoped
to the resumed session id, not to the working directory.

## Limits

A session holds at most 50 live cron tasks; creating one beyond that is rejected. (The `prompt` body is also capped — see its parameter description.) Expressions that never fire within the next 5 years (e.g. `0 0 31 2 *`, an impossible date) are rejected at create time.

## Returned fields

`id` (ULID), `cron` (the normalized expression), `humanSchedule` (English summary), `recurring`,
`nextFireAt` (local ISO timestamp with numeric offset, or null). `id` is needed by `CronDelete`.

## Tell the user how to cancel or modify

After successfully creating a task, proactively tell the user how they can cancel or modify it later. Users have no direct `/cron` command or self-service UI to manage reminders themselves; they must ask the model to make changes (e.g. "cancel my 9am reminder" or "change my daily check to 10am"). Include the task `id` in your message so the user can reference it."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "cron": {
                    "type": "string",
                    "description": "5-field cron expression in local time: \"M H DoM Mon DoW\" (e.g. \"*/5 * * * *\" = every 5 minutes; \"30 14 28 2 *\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)."
                },
                "prompt": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 8192,
                    "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)."
                },
                "recurring": {
                    "type": "boolean",
                    "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \"remind me at X\" one-shot requests with pinned minute/hour/dom/month."
                }
            },
            "required": ["cron", "prompt"],
            "additionalProperties": false
        }),
    }
}

/// Engine tool definition for CronDelete, mirroring v2 `CronDeleteTool` and
/// `CronDeleteInputSchema`.
pub fn cron_delete_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "CronDelete".into(),
        description: r#"Cancel a scheduled cron job by id.

Use this tool to remove a cron task previously scheduled with
`CronCreate`. The `id` is the ULID value returned by `CronCreate`, or
shown in the `id:` column of `CronList` — quote it verbatim, no
prefix.

Behaviour by task kind:

- **Recurring task** (`recurring: true`): stops all future fires
  immediately. The scheduler picks up the deletion on its next tick.
- **One-shot task** (`recurring: false`): cancels the pending fire if
  it has not happened yet. One-shots that have already fired
  auto-delete themselves, so calling `CronDelete` on a fired one-shot
  returns "no cron job with id ...".

Not-found is reported as an error (not a silent no-op) so you can
correct yourself — typically by calling `CronList` to see which ids
are actually live, rather than re-trying with the same stale id.

Refresh pattern (use when you want a stale recurring schedule to
continue):

Stale recurring tasks are auto-deleted by the system after their final
fire — there is nothing for `CronDelete` to remove at that point. To
keep the schedule running, just call `CronCreate` with the same `cron`
and `prompt`. Use `CronList`'s `prompt` field to recall the original
text after a context compaction.

`CronDelete` remains the right call when you want to cancel a task
that is still live (recurring not yet stale, or a one-shot still
pending).

Guidelines:

- Users have no direct `/cron` command or self-service UI to delete
  tasks themselves; they must ask the model to cancel a reminder.
  When deleting on behalf of a user, confirm the action and report
  the result plainly.
- Cron deletion is irreversible — there is no undo. If you delete the
  wrong task, you must re-create it with `CronCreate`.
- If the model is unsure which id is current (e.g. after a context
  compaction), call `CronList` first rather than guessing."#
            .into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "The cron job id (ULID) returned by CronCreate / CronList."
                }
            },
            "required": ["id"],
            "additionalProperties": false
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{BoxFuture, PermissionDecision, StateReadResponse, StateWriteResponse};
    use std::sync::Arc;

    /// Scripted callbacks: records the received state requests and answers
    /// with canned responses.
    struct ScriptedCallbacks {
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
        read_received: Arc<std::sync::Mutex<Option<StateReadRequest>>>,
        write_received: Arc<std::sync::Mutex<Option<StateWriteRequest>>>,
    }

    impl HostCallbacks for ScriptedCallbacks {
        fn llm_chat(
            &self,
            _: crate::rpc::types::LlmChatRequest,
        ) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: crate::rpc::types::ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<crate::rpc::types::ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: crate::rpc::types::PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }

        fn state_read(
            &self,
            request: StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
            *self.read_received.lock().unwrap() = Some(request);
            let response = self.read_response.clone();
            Box::pin(async move { response })
        }

        fn state_write(
            &self,
            request: StateWriteRequest,
        ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
            *self.write_received.lock().unwrap() = Some(request);
            let response = self.write_response.clone();
            Box::pin(async move { response })
        }
    }

    #[allow(clippy::type_complexity)]
    fn scripted(
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
    ) -> (
        ScriptedCallbacks,
        Arc<std::sync::Mutex<Option<StateReadRequest>>>,
        Arc<std::sync::Mutex<Option<StateWriteRequest>>>,
    ) {
        let read_received = Arc::new(std::sync::Mutex::new(None));
        let write_received = Arc::new(std::sync::Mutex::new(None));
        (
            ScriptedCallbacks {
                read_response,
                write_response,
                read_received: read_received.clone(),
                write_received: write_received.clone(),
            },
            read_received,
            write_received,
        )
    }

    fn read_ok(value: Value) -> Result<StateReadResponse, String> {
        Ok(StateReadResponse { value })
    }

    fn write_ok(value: Value) -> Result<StateWriteResponse, String> {
        Ok(StateWriteResponse { ok: true, value })
    }

    fn sample_task() -> Value {
        serde_json::json!({
            "id": "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ",
            "cron": "*/5 * * * *",
            "prompt": "check the deploy",
            "createdAt": 1700000000000u64,
            "recurring": true,
            "nextFireAt": "2024-06-01T14:30:45.123+08:00",
            "stale": false
        })
    }

    #[tokio::test]
    async fn test_list_renders_header_and_records() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(serde_json::json!([
                sample_task(),
                {
                    "id": "01HZZZZZZZZZZZZZZZZZZZZZZZZ",
                    "cron": "0 9 * * 1-5",
                    "prompt": "morning standup",
                    "createdAt": 1699990000000u64,
                    "recurring": true,
                    "nextFireAt": null,
                    "stale": true
                }
            ])),
            write_ok(Value::Null),
        );
        let result = execute_cron_list(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        let lines: Vec<&str> = result.content.lines().collect();
        assert_eq!(lines[0], "cron_jobs: 2");
        // Records are joined by a lone `---` line; the header is followed
        // directly by the first record.
        assert!(lines[1].starts_with("id: "));
        assert!(lines.contains(&"---"));
        assert!(result.content.contains("id: 01H0Z8X7YJ3K5Q9R2T4V6W8XAZ"));
        assert!(result.content.contains("cron: */5 * * * *"));
        assert!(result.content.contains("humanSchedule: every 5 minutes"));
        assert!(result.content.contains("prompt: \"check the deploy\""));
        assert!(
            result
                .content
                .contains("nextFireAt: 2024-06-01T14:30:45.123+08:00")
        );
        assert!(result.content.contains("recurring: true"));
        assert!(result.content.contains("stale: false"));
        assert!(
            result
                .content
                .contains("humanSchedule: at 09:00 on weekdays")
        );
        assert!(result.content.contains("nextFireAt: null"));
        assert!(result.content.contains("stale: true"));
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "cron");
        assert_eq!(request.key, "cron");
        assert_eq!(request.turn_id, "");
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_list_empty_renders_empty_message() {
        let (callbacks, _, _) = scripted(read_ok(serde_json::json!([])), write_ok(Value::Null));
        let result = execute_cron_list(&callbacks, &serde_json::json!({})).await;
        assert!(!result.is_error);
        assert_eq!(result.content, "cron_jobs: 0\nNo cron jobs scheduled.");
    }

    #[test]
    fn test_render_record_age_days_and_preview() {
        let now = 1_700_172_800_000i64; // 2 days after createdAt 1700000000000
        let task: CronTaskWire = serde_json::from_value(sample_task()).unwrap();
        let rendered = render_record(&task, now);
        assert!(rendered.contains("ageDays: 2.00"), "rendered: {rendered}");

        let long_prompt = "x".repeat(250);
        let mut task = task;
        task.prompt = long_prompt;
        let rendered = render_record(&task, now);
        assert!(
            rendered.contains("prompt: \"") && rendered.contains("…(truncated)\""),
            "rendered: {rendered}"
        );
    }

    #[test]
    fn test_preview_prompt_truncates_at_char_boundary() {
        assert_eq!(preview_prompt("short"), "short");
        let long = "x".repeat(200);
        assert_eq!(preview_prompt(&long), long);
        // 201 ASCII bytes: truncated to 200 + marker.
        let over = "x".repeat(201);
        assert_eq!(
            preview_prompt(&over),
            format!("{}…(truncated)", "x".repeat(200))
        );
        // Multi-byte boundary: 199 ASCII bytes + a 3-byte char = 202 bytes;
        // the cut at 200 lands inside the char and must back up to 199.
        let mixed = format!("{}你", "x".repeat(199));
        assert_eq!(
            preview_prompt(&mixed),
            format!("{}…(truncated)", "x".repeat(199))
        );
    }

    #[test]
    fn test_render_record_falls_back_to_raw_cron() {
        let now = 1_700_000_000_000i64;
        let task: CronTaskWire = serde_json::from_value(serde_json::json!({
            "id": "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ",
            "cron": "5,10 9 * * *",
            "prompt": "p",
            "createdAt": 1700000000000u64
        }))
        .unwrap();
        let rendered = render_record(&task, now);
        assert!(rendered.contains("humanSchedule: 5,10 9 * * *"));
        assert!(rendered.contains("recurring: true"));
        assert!(rendered.contains("nextFireAt: null"));
        assert!(rendered.contains("stale: false"));
    }

    #[tokio::test]
    async fn test_list_invalid_wire_shape_returns_error() {
        let (callbacks, _, _) = scripted(
            read_ok(serde_json::json!({ "tasks": [] })),
            write_ok(Value::Null),
        );
        let result = execute_cron_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid cron state from host"));
    }

    #[tokio::test]
    async fn test_list_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            Err("host does not support state bridge".into()),
            write_ok(Value::Null),
        );
        let result = execute_cron_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_list_other_host_error_passes_through() {
        let (callbacks, _, _) = scripted(
            Err("State read error: [-32001] unknown domain: cron".into()),
            write_ok(Value::Null),
        );
        let result = execute_cron_list(&callbacks, &serde_json::json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("-32001"));
        assert!(result.content.contains("unknown domain"));
    }

    #[tokio::test]
    async fn test_list_turn_and_tool_call_ids_are_forwarded() {
        let (callbacks, read_received, _) =
            scripted(read_ok(serde_json::json!([])), write_ok(Value::Null));
        let result = execute_cron_list(
            &callbacks,
            &serde_json::json!({ "turn_id": "turn-42", "tool_call_id": "call_abc" }),
        )
        .await;
        assert!(!result.is_error);
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.turn_id, "turn-42");
        assert_eq!(request.tool_call_id, "call_abc");
    }

    #[tokio::test]
    async fn test_create_sends_action_and_renders() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!({
                "id": "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ",
                "cron": "*/5 * * * *",
                "prompt": "check the deploy",
                "createdAt": 1700000000000u64,
                "recurring": true,
                "nextFireAt": "2024-06-01T14:30:45.123+08:00"
            })),
        );
        let result = execute_cron_create(
            &callbacks,
            &serde_json::json!({
                "cron": " */5   * * * * ",
                "prompt": "check the deploy",
            }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "id: 01H0Z8X7YJ3K5Q9R2T4V6W8XAZ\ncron: */5 * * * *\nhumanSchedule: every 5 minutes\nrecurring: true\nnextFireAt: 2024-06-01T14:30:45.123+08:00"
        );
        assert!(read_received.lock().unwrap().is_none());
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "cron");
        assert_eq!(request.key, "cron");
        assert!(!request.undoable);
        // The expression is normalized and `recurring` defaults to true.
        assert_eq!(request.value["action"], "create");
        assert_eq!(request.value["cron"], "*/5 * * * *");
        assert_eq!(request.value["prompt"], "check the deploy");
        assert_eq!(request.value["recurring"], true);
    }

    #[tokio::test]
    async fn test_create_one_shot_passes_recurring_false() {
        let (callbacks, _, write_received) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!({
                "id": "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ",
                "cron": "30 14 28 2 *",
                "prompt": "remind me",
                "createdAt": 1700000000000u64,
                "recurring": false,
                "nextFireAt": null
            })),
        );
        let result = execute_cron_create(
            &callbacks,
            &serde_json::json!({
                "cron": "30 14 28 2 *",
                "prompt": "remind me",
                "recurring": false
            }),
        )
        .await;
        assert!(!result.is_error);
        assert!(result.content.contains("recurring: false"));
        assert!(result.content.contains("nextFireAt: null"));
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.value["recurring"], false);
    }

    #[test]
    fn test_validate_create_rejects_bad_expression() {
        let err = validate_create("not a cron", "p", true, 0).unwrap_err();
        assert_eq!(
            err,
            "Invalid cron expression: cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got 3"
        );
    }

    #[test]
    fn test_validate_create_rejects_never_firing() {
        let err = validate_create("0 0 30 2 *", "p", true, 0).unwrap_err();
        assert_eq!(
            err,
            "Cron expression \"0 0 30 2 *\" has no fire within 5 years; refusing to schedule."
        );
    }

    #[test]
    fn test_validate_create_rejects_oversized_prompt() {
        let err = validate_create("* * * * *", &"x".repeat(8193), true, 0).unwrap_err();
        assert_eq!(err, "Prompt exceeds 8192 bytes (got 8193).");
    }

    #[test]
    fn test_validate_create_rejects_far_one_shot() {
        // From 2024-01-01 the next Jan 1 is 366 days out (> 350): refused.
        let err = validate_create("0 0 1 1 *", "p", false, 1_704_067_200_000).unwrap_err();
        assert!(err.starts_with(
            "One-shot cron \"0 0 1 1 *\" would not fire until 2025-01-01T00:00:00.000+00:00"
        ));
        // Recurring jobs are not subject to the one-shot cap.
        assert!(validate_create("0 0 1 1 *", "p", true, 1_704_067_200_000).is_ok());
    }

    #[tokio::test]
    async fn test_create_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, write_received) =
            scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "cron": "* * * * *" }),
            serde_json::json!({ "cron": "* * * * *", "prompt": "" }),
            serde_json::json!({ "cron": 42, "prompt": "p" }),
            serde_json::json!({ "cron": "* * * * *", "prompt": "p", "recurring": "yes" }),
        ] {
            let result = execute_cron_create(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid CronCreate arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
        assert!(write_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_create_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32603] host does not support state bridge".into()),
        );
        let result = execute_cron_create(
            &callbacks,
            &serde_json::json!({ "cron": "* * * * *", "prompt": "p" }),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_create_host_rejection_passes_through() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("State write error: [-32004] Cron job cap reached (max 50 per session).".into()),
        );
        let result = execute_cron_create(
            &callbacks,
            &serde_json::json!({ "cron": "* * * * *", "prompt": "p" }),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("-32004"));
        assert!(result.content.contains("Cron job cap reached"));
    }

    #[tokio::test]
    async fn test_delete_sends_action_and_renders() {
        let (callbacks, read_received, write_received) = scripted(
            read_ok(Value::Null),
            write_ok(serde_json::json!({ "deleted": true })),
        );
        let result = execute_cron_delete(
            &callbacks,
            &serde_json::json!({ "id": "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ" }),
        )
        .await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Deleted cron job 01H0Z8X7YJ3K5Q9R2T4V6W8XAZ."
        );
        assert!(read_received.lock().unwrap().is_none());
        let request = write_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "cron");
        assert_eq!(request.key, "cron");
        assert!(!request.undoable);
        assert_eq!(request.value["action"], "delete");
        assert_eq!(request.value["id"], "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ");
    }

    #[tokio::test]
    async fn test_delete_invalid_id_returns_error_without_calling_host() {
        let (callbacks, _, write_received) = scripted(read_ok(Value::Null), write_ok(Value::Null));
        for bad in [
            "abc",
            "not-a-ulid-0123456789",
            "01H123456789ABCDEFGHIJKLMNOP",
        ] {
            let result = execute_cron_delete(&callbacks, &serde_json::json!({ "id": bad })).await;
            assert!(result.is_error, "id: {bad}");
            assert_eq!(
                result.content,
                format!("Invalid cron job id \"{bad}\" — must be a ULID.")
            );
        }
        assert!(write_received.lock().unwrap().is_none());
    }

    #[test]
    fn test_is_valid_cron_id() {
        assert!(is_valid_cron_id("01H0Z8X7YJ3K5Q9R2T4V6W8XAZ"));
        assert!(is_valid_cron_id("01h0z8x7yj3k5q9r2t4v6w8xaz"));
        assert!(is_valid_cron_id("01234567"));
        assert!(is_valid_cron_id("abcdefAB"));
        assert!(!is_valid_cron_id("01H123456789ABCDEFGHIJKLMNO")); // I and O excluded
        assert!(!is_valid_cron_id("01H123456789ABCDEFGHJKLMN")); // too short
        assert!(!is_valid_cron_id(""));
    }

    #[tokio::test]
    async fn test_delete_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err("host does not support state bridge".into()),
        );
        let result = execute_cron_delete(
            &callbacks,
            &serde_json::json!({ "id": "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ" }),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_delete_not_found_passes_through() {
        let (callbacks, _, _) = scripted(
            read_ok(Value::Null),
            Err(
                "State write error: [-32004] No cron job with id 01H0Z8X7YJ3K5Q9R2T4V6W8XAZ."
                    .into(),
            ),
        );
        let result = execute_cron_delete(
            &callbacks,
            &serde_json::json!({ "id": "01H0Z8X7YJ3K5Q9R2T4V6W8XAZ" }),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("No cron job with id"));
    }

    #[test]
    fn test_tool_defs_match_v2_schema() {
        let list = cron_list_tool_def();
        assert_eq!(list.name, "CronList");
        assert_eq!(list.input_schema["type"], "object");
        assert_eq!(list.input_schema["additionalProperties"], false);
        assert!(list.input_schema["properties"].is_object());
        assert!(list.description.contains("cron_jobs: 0"));

        let create = cron_create_tool_def();
        assert_eq!(create.name, "CronCreate");
        assert_eq!(create.input_schema["required"][0], "cron");
        assert_eq!(create.input_schema["required"][1], "prompt");
        assert_eq!(
            create.input_schema["properties"]["prompt"]["maxLength"],
            8192
        );
        assert_eq!(create.input_schema["properties"]["prompt"]["minLength"], 1);
        assert_eq!(
            create.input_schema["properties"]["recurring"]["type"],
            "boolean"
        );
        assert_eq!(create.input_schema["additionalProperties"], false);
        assert!(create.description.contains("5-field cron"));

        let delete = cron_delete_tool_def();
        assert_eq!(delete.name, "CronDelete");
        assert_eq!(delete.input_schema["required"][0], "id");
        assert_eq!(delete.input_schema["properties"]["id"]["type"], "string");
        assert_eq!(delete.input_schema["additionalProperties"], false);
        assert!(delete.description.contains("ULID"));
    }
}
