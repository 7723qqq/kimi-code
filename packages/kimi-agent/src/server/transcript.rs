use serde_json::{Value, json};

use crate::events::EngineEvent;
use crate::session::sqlite_store::SqliteSessionStore;
use crate::turn_loop::types::LLMMessage;

pub mod grade;
pub mod model;
pub mod ops;
pub mod project;

pub const DEFAULT_PAGE_SIZE: usize = 20;

#[derive(Clone)]
struct StepDraft {
    step_id: String,
    ordinal: usize,
    frames: Vec<Value>,
}

/// A steered follow-up buffered while grouping: it carries the queued prompt's
/// id (#3906) and lands as a user frame in the current turn's step — v2's
/// `pendingSteers` (groupTurns.ts:177), where the steer opens no turn of its
/// own.
#[derive(Clone)]
struct ColdSteer {
    text: String,
    prompt_id: String,
}

#[derive(Clone)]
struct TurnDraft {
    turn_id: String,
    ordinal: usize,
    prompt: Option<String>,
    /// The turn's origin as the protocol declares it. A turn opened by an
    /// injection carries no prompt and reports `other`, matching v2's
    /// `mapTurnOrigin` default branch — an injected reminder is not a user
    /// prompt and must not render as one.
    origin: Value,
    steps: Vec<StepDraft>,
}

impl TurnDraft {
    fn new(ordinal: usize, prompt: Option<String>, origin: Value) -> Self {
        Self {
            turn_id: format!("t{ordinal}"),
            ordinal,
            prompt,
            origin,
            steps: Vec::new(),
        }
    }

    fn to_value(&self) -> Value {
        let steps: Vec<Value> = self
            .steps
            .iter()
            .map(|step| {
                json!({
                    "kind": "step",
                    "stepId": step.step_id,
                    "turnId": self.turn_id,
                    "ordinal": step.ordinal,
                    "state": "completed",
                    "frames": step.frames,
                })
            })
            .collect();
        let mut turn = json!({
            "kind": "turn",
            "turnId": self.turn_id,
            "ordinal": self.ordinal,
            "state": "completed",
            "origin": self.origin,
            "steps": steps,
        });
        if let Some(prompt) = self.prompt.as_ref()
            && !prompt.is_empty()
        {
            turn["prompt"] = json!(prompt);
        }
        turn
    }
}

/// Land buffered steers in the last turn's last step — v2's
/// `flushSteeredLeftovers` (groupTurns.ts:177): create the step when the turn
/// has none, and a `user`-origin placeholder turn when history holds none yet.
/// Runs before a new turn opens and at end of history.
fn flush_steered_leftovers(
    turns: &mut Vec<TurnDraft>,
    next_ordinal: &mut usize,
    pending: &mut Vec<ColdSteer>,
) {
    if pending.is_empty() {
        return;
    }
    if turns.is_empty() {
        turns.push(TurnDraft::new(
            *next_ordinal,
            None,
            json!({ "kind": "user" }),
        ));
        *next_ordinal += 1;
    }
    let turn = turns.last_mut().expect("turn ensured above");
    if turn.steps.is_empty() {
        turn.steps.push(StepDraft {
            step_id: format!("{}.1", turn.turn_id),
            ordinal: 1,
            frames: Vec::new(),
        });
    }
    let step = turn.steps.last_mut().expect("step ensured above");
    for steer in pending.drain(..) {
        let frame_id = format!("{}.f{}", step.step_id, step.frames.len() + 1);
        step.frames.push(json!({
            "kind": "text",
            "frameId": frame_id,
            "role": "user",
            "text": steer.text,
            "promptIds": [steer.prompt_id],
            "origin": { "kind": "user" },
        }));
    }
}

pub fn build_items(history: &[LLMMessage]) -> Vec<Value> {
    let mut turns: Vec<TurnDraft> = Vec::new();
    let mut next_ordinal = 0usize;
    let mut pending: Vec<ColdSteer> = Vec::new();

    for message in history {
        match message.role.as_str() {
            "system" => continue,
            "user" => {
                // A steered follow-up carries the queued prompt's id (#3906):
                // it opens no turn — buffer it (v2 groupTurns.ts:252) and land
                // it as a user frame at a flush point below.
                if let Some(prompt_id) = message.prompt_id.as_deref() {
                    pending.push(ColdSteer {
                        text: message.content.clone(),
                        prompt_id: prompt_id.to_string(),
                    });
                    continue;
                }
                // A reminder the engine injected is not something the user
                // typed: v2 marks it `origin.kind === 'injection'` at append
                // time and its projector maps that to `other`, leaving the
                // turn without a prompt so no client renders a bubble. The
                // fork's messages carry no origin, so the `wrapSystemReminder`
                // envelope distinguishes them (the same classification the
                // turn loop already uses to keep them out of compaction).
                let is_injection = crate::injection::is_system_reminder(&message.content);
                let (prompt, origin) = if is_injection {
                    (None, json!({ "kind": "other" }))
                } else if message.content.is_empty() {
                    (None, json!({ "kind": "user" }))
                } else {
                    (Some(message.content.clone()), json!({ "kind": "user" }))
                };
                flush_steered_leftovers(&mut turns, &mut next_ordinal, &mut pending);
                turns.push(TurnDraft::new(next_ordinal, prompt, origin));
                next_ordinal += 1;
            }
            "assistant" => {
                if turns.is_empty() {
                    turns.push(TurnDraft::new(
                        next_ordinal,
                        None,
                        json!({ "kind": "other" }),
                    ));
                    next_ordinal += 1;
                }
                let turn = turns.last_mut().expect("turn ensured above");
                let step_ordinal = turn.steps.len() + 1;
                let step_id = format!("{}.{}", turn.turn_id, step_ordinal);
                let mut frames: Vec<Value> = Vec::new();
                let mut frame_count = 0usize;
                let mut next_frame_id = || {
                    frame_count += 1;
                    format!("{step_id}.f{frame_count}")
                };
                // Flush point (a): every assistant message opens a new step,
                // and buffered steers land at its head before the response
                // that answered them (v2 groupTurns.ts:349).
                for steer in pending.drain(..) {
                    frames.push(json!({
                        "kind": "text",
                        "frameId": next_frame_id(),
                        "role": "user",
                        "text": steer.text,
                        "promptIds": [steer.prompt_id],
                        "origin": { "kind": "user" },
                    }));
                }
                if !message.content.is_empty() {
                    frames.push(json!({
                        "kind": "text",
                        "frameId": next_frame_id(),
                        "role": "assistant",
                        "text": message.content,
                    }));
                }
                for call in &message.tool_calls {
                    frames.push(json!({
                        "kind": "tool",
                        "frameId": format!("{step_id}.{}", call.id),
                        "toolCallId": call.id,
                        "name": call.name,
                        "state": "running",
                        "input": call.arguments,
                    }));
                }
                turn.steps.push(StepDraft {
                    step_id,
                    ordinal: step_ordinal,
                    frames,
                });
            }
            "tool" => {
                let Some(turn) = turns.last_mut() else {
                    continue;
                };
                let Some(tool_call_id) = message.tool_call_id.as_deref() else {
                    continue;
                };
                patch_tool_frame(turn, tool_call_id, &message.content);
            }
            _ => {}
        }
    }

    // Flush point (c): history ending on a steer still lands it — in the last
    // turn's last step, or a `user`-origin placeholder turn when none exists
    // (v2 groupTurns.ts:199).
    flush_steered_leftovers(&mut turns, &mut next_ordinal, &mut pending);

    turns.iter().map(TurnDraft::to_value).collect()
}

/// The cold baseline's prompt entities: fold the persisted prompt-lifecycle
/// journal (`prompt.submitted` / `completed` / `aborted` / `steered`) through
/// a fresh projector — the same fold the live path runs — so a reconnecting
/// client sees settled prompts instead of an empty array. `turn.steer` is not
/// a fold arm: the steer's user frame rides `build_items` above.
pub fn cold_prompts(store: &SqliteSessionStore, session_id: &str) -> Value {
    let Ok(records) = store.prompt_wire_events(session_id) else {
        return Value::Array(Vec::new());
    };
    let mut projector = project::TranscriptProjector::new();
    for record in records {
        projector.apply_event(&EngineEvent::from_json(record.payload));
    }
    let prompts = projector.snapshot().prompts;
    serde_json::to_value(&prompts).unwrap_or(Value::Array(Vec::new()))
}

/// The cold baseline's task entities: fold the persisted task journal through
/// a fresh projector — the same fold the live path runs — so a reopened
/// session restores its task list (upstream #3970). The cold snapshot settles
/// members whose spawning turn is no longer running to `lost` (every loop is
/// dead after a restart); live members keep their recorded state.
pub fn cold_tasks(store: &SqliteSessionStore, session_id: &str) -> Value {
    let Ok(records) = store.task_wire_events(session_id) else {
        return Value::Array(Vec::new());
    };
    let mut projector = project::TranscriptProjector::new();
    for record in records {
        projector.apply_event(&EngineEvent::from_json(cold_fold_payload(record.payload)));
    }
    let tasks = projector.cold_snapshot_tasks();
    serde_json::to_value(&tasks).unwrap_or(Value::Array(Vec::new()))
}

/// The agent id a journal turn belongs to: a turn in the wire journal is the
/// main agent's, the same id the live `EngineEvent` turn events carry.
const MAIN_AGENT_ID: &str = "main";

/// The journal's own turn-event shape, normalized into the typed event the
/// projector folds.
///
/// The turn events on the wire come from `TurnEvent` (`turnId`, no
/// `agent_id`), not from the `EngineEvent` the live projector receives, so
/// feeding them to `from_json` verbatim left them `Custom` — the fold then never
/// saw a turn, `spawning_turns` stayed empty, and every member looked like it
/// had outlived its spawning turn. The main agent's id is the one the live
/// `EngineEvent::TurnStarted` / `TurnEnded` carry, and a journal turn can only
/// be the main agent's.
fn cold_fold_payload(payload: Value) -> Value {
    let mut value = payload;
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return value;
    };
    if !matches!(kind, "turn.started" | "turn.ended") {
        return value;
    }
    if let Some(object) = value.as_object_mut() {
        if let Some(turn_id) = object.remove("turnId") {
            object.entry("turn_id").or_insert(turn_id);
        }
        object
            .entry("agent_id")
            .or_insert_with(|| Value::String(MAIN_AGENT_ID.to_string()));
    }
    value
}

fn patch_tool_frame(turn: &mut TurnDraft, tool_call_id: &str, output: &str) {
    for step in turn.steps.iter_mut().rev() {
        for frame in step.frames.iter_mut().rev() {
            if frame.get("kind").and_then(|v| v.as_str()) == Some("tool")
                && frame.get("toolCallId").and_then(|v| v.as_str()) == Some(tool_call_id)
            {
                frame["state"] = json!("done");
                frame["output"] = json!(output);
                return;
            }
        }
    }
}

fn turn_ordinal(item: &Value) -> Option<i64> {
    item.get("ordinal").and_then(|v| v.as_i64())
}

pub fn paginate_turns(items: &[Value], query: &TurnPageQuery) -> (Vec<Value>, bool) {
    let page_size = query.page_size.max(1);
    let turns: Vec<&Value> = items
        .iter()
        .filter(|item| item.get("kind").and_then(|v| v.as_str()) == Some("turn"))
        .collect();
    if turns.is_empty() {
        return (Vec::new(), false);
    }

    if let Some(after) = query.after_turn.as_deref() {
        let after_ordinal = parse_turn_ordinal(after);
        let selected: Vec<&Value> = turns
            .into_iter()
            .filter(|item| match (turn_ordinal(item), after_ordinal) {
                (Some(value), Some(after)) => value > after,
                _ => false,
            })
            .take(page_size)
            .collect();
        let has_more = selected.len() == page_size;
        return (selected.into_iter().cloned().collect(), has_more);
    }

    if let Some(before) = query.before_turn.as_deref() {
        let before_ordinal = parse_turn_ordinal(before);
        let older: Vec<&Value> = turns
            .into_iter()
            .filter(|item| match (turn_ordinal(item), before_ordinal) {
                (Some(value), Some(before)) => value < before,
                _ => false,
            })
            .collect();
        let start = older.len().saturating_sub(page_size);
        let selected = older[start..].to_vec();
        let has_more = older.len() > selected.len();
        return (selected.into_iter().cloned().collect(), has_more);
    }

    let start = turns.len().saturating_sub(page_size);
    let selected = turns[start..].to_vec();
    let has_more = turns.len() > selected.len();
    (selected.into_iter().cloned().collect(), has_more)
}

fn parse_turn_ordinal(turn_id: &str) -> Option<i64> {
    turn_id
        .strip_prefix('t')
        .and_then(|rest| rest.parse::<i64>().ok())
}

pub fn project_user_messages(items: &[Value]) -> Vec<Value> {
    let mut messages = Vec::new();
    for item in items {
        if item.get("kind").and_then(|v| v.as_str()) != Some("turn") {
            continue;
        }
        let prompt = item.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
        if prompt.is_empty() {
            continue;
        }
        messages.push(json!({
            "turn_id": item.get("turnId").cloned().unwrap_or(Value::Null),
            "ordinal": item.get("ordinal").cloned().unwrap_or(json!(0)),
            "state": item.get("state").cloned().unwrap_or(json!("completed")),
            "origin": item.get("origin").cloned().unwrap_or(json!({ "kind": "user" })),
            "prompt": prompt,
        }));
    }
    messages
}

const PLAN_SAVED_TO_MARKER: &str = "Plan saved to: ";
const PLAN_BODY_MARKERS: [&str; 2] = [
    "## Approved Plan:\n",
    "## Plan (auto-approved, not user-reviewed):\n",
];

pub fn project_plans(items: &[Value], tool_call_id: Option<&str>) -> Vec<Value> {
    let mut plans = Vec::new();
    for item in items {
        if item.get("kind").and_then(|v| v.as_str()) != Some("turn") {
            continue;
        }
        let turn_id = item.get("turnId").and_then(|v| v.as_str()).unwrap_or("");
        let Some(steps) = item.get("steps").and_then(|v| v.as_array()) else {
            continue;
        };
        for step in steps {
            let Some(frames) = step.get("frames").and_then(|v| v.as_array()) else {
                continue;
            };
            for frame in frames {
                if frame.get("kind").and_then(|v| v.as_str()) != Some("tool") {
                    continue;
                }
                if frame.get("name").and_then(|v| v.as_str()) != Some("ExitPlanMode") {
                    continue;
                }
                let frame_call_id = frame
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Some(only) = tool_call_id
                    && frame_call_id != only
                {
                    continue;
                }
                let output = frame.get("output").and_then(|v| v.as_str());
                if let Some((plan, path)) = parse_plan_from_output(output) {
                    let mut entry = json!({
                        "tool_call_id": frame_call_id,
                        "turn_id": turn_id,
                        "source": "output",
                        "plan": plan,
                    });
                    if let Some(path) = path {
                        entry["path"] = json!(path);
                    }
                    plans.push(entry);
                }
            }
        }
    }
    plans
}

fn parse_plan_from_output(output: Option<&str>) -> Option<(String, Option<String>)> {
    let output = output?;
    let mut path: Option<String> = None;
    for line in output.split('\n') {
        if let Some(rest) = line.strip_prefix(PLAN_SAVED_TO_MARKER) {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                path = Some(trimmed.to_string());
            }
            break;
        }
    }
    for marker in PLAN_BODY_MARKERS {
        if let Some(index) = output.find(marker) {
            let plan = &output[index + marker.len()..];
            if !plan.trim().is_empty() {
                return Some((plan.to_string(), path));
            }
        }
    }
    None
}

pub struct TurnPageQuery {
    pub before_turn: Option<String>,
    pub after_turn: Option<String>,
    pub page_size: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_loop::types::ToolCall;

    fn user(text: &str) -> LLMMessage {
        LLMMessage::new("user", text)
    }

    fn assistant(text: &str, calls: Vec<ToolCall>) -> LLMMessage {
        let mut message = LLMMessage::new("assistant", text);
        message.tool_calls = calls;
        message
    }

    fn tool(call_id: &str, output: &str) -> LLMMessage {
        let mut message = LLMMessage::new("tool", output);
        message.tool_call_id = Some(call_id.to_string());
        message
    }

    fn call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: json!({ "path": "a.txt" }),
            extras: None,
        }
    }

    /// A steered follow-up: the queued prompt's id rides the persisted
    /// message (#3906) instead of opening a turn of its own.
    fn steer(text: &str, prompt_id: &str) -> LLMMessage {
        let mut message = LLMMessage::new("user", text);
        message.prompt_id = Some(prompt_id.to_string());
        message
    }

    /// Flush point (a): the steer lands at the head of the step that answers
    /// it — v2's `pendingNotificationFrames` drain (groupTurns.ts:349).
    #[test]
    fn a_steered_follow_up_opens_no_turn_and_lands_at_the_step_head() {
        let history = vec![
            user("first"),
            steer("also do X", "prompt-2"),
            assistant("on it", Vec::new()),
        ];
        let items = build_items(&history);
        assert_eq!(items.len(), 1, "the steer opens no turn of its own");

        let steps = items[0]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1);
        let frames = steps[0]["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 2, "steer frame then assistant frame");
        assert_eq!(frames[0]["role"], "user");
        assert_eq!(frames[0]["text"], "also do X");
        assert_eq!(frames[0]["promptIds"][0], "prompt-2");
        assert_eq!(frames[0]["origin"]["kind"], "user");
        assert_eq!(frames[1]["role"], "assistant");
        assert_eq!(frames[1]["text"], "on it");
        // The turn keeps its own prompt: the steer never rewrites it.
        assert_eq!(items[0]["prompt"], "first");
    }

    /// Flush point (b): a new user turn flushes the steers left behind into
    /// the previous turn's last step — v2 `startTurn` →
    /// `flushSteeredLeftovers` (groupTurns.ts:177).
    #[test]
    fn a_new_turn_flushes_the_steers_left_behind() {
        let history = vec![
            user("first"),
            assistant("ok", Vec::new()),
            steer("mid", "prompt-4"),
            user("second"),
            assistant("done", Vec::new()),
        ];
        let items = build_items(&history);
        assert_eq!(items.len(), 2, "neither the steer nor the flush adds turns");

        let first_steps = items[0]["steps"].as_array().unwrap();
        let last_step = first_steps.last().unwrap();
        let frames = last_step["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 2, "assistant frame then the flushed steer");
        assert_eq!(frames[1]["role"], "user");
        assert_eq!(frames[1]["text"], "mid");
        assert_eq!(frames[1]["promptIds"][0], "prompt-4");

        assert_eq!(items[1]["prompt"], "second");
    }

    /// Flush point (b) with no turn to flush into: v2 opens a `user`-origin
    /// placeholder (`turn ?? startTurn({kind:'user'})`, groupTurns.ts:199) so
    /// the steer still renders inside a turn.
    #[test]
    fn a_steer_before_any_turn_opens_a_user_placeholder() {
        let history = vec![steer("early", "prompt-5"), user("hello")];
        let items = build_items(&history);
        assert_eq!(items.len(), 2);

        assert_eq!(items[0]["origin"]["kind"], "user");
        assert!(
            items[0].get("prompt").is_none(),
            "the placeholder carries no prompt of its own"
        );
        let steps = items[0]["steps"].as_array().unwrap();
        let frames = steps[0]["frames"].as_array().unwrap();
        assert_eq!(frames[0]["role"], "user");
        assert_eq!(frames[0]["text"], "early");
        assert_eq!(frames[0]["promptIds"][0], "prompt-5");

        assert_eq!(items[1]["prompt"], "hello");
    }

    /// Flush point (c): history ending on a steer still lands it.
    #[test]
    fn a_steer_at_the_end_of_history_lands_in_the_last_step() {
        let history = vec![
            user("first"),
            assistant("ok", Vec::new()),
            steer("one more", "prompt-6"),
        ];
        let items = build_items(&history);
        assert_eq!(items.len(), 1);

        let steps = items[0]["steps"].as_array().unwrap();
        let frames = steps.last().unwrap()["frames"].as_array().unwrap();
        let last = frames.last().unwrap();
        assert_eq!(last["role"], "user");
        assert_eq!(last["text"], "one more");
        assert_eq!(last["promptIds"][0], "prompt-6");
    }

    /// A steer with no turn at all still renders: the placeholder the flush
    /// opens carries a `user` origin, matching `startTurn({kind:'user'})`.
    #[test]
    fn history_of_only_a_steer_opens_a_user_turn() {
        let items = build_items(&[steer("just a steer", "prompt-7")]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["origin"]["kind"], "user");
        let steps = items[0]["steps"].as_array().unwrap();
        let frames = steps[0]["frames"].as_array().unwrap();
        assert_eq!(frames[0]["text"], "just a steer");
    }

    /// `cold_prompts` folds the persisted prompt-lifecycle journal through
    /// the live fold: submitted → aborted stays aborted, and unrelated event
    /// types (including `turn.steer`) never reach the fold.
    #[test]
    fn cold_prompts_folds_the_persisted_lifecycle_journal() {
        use crate::native::event_store::RawWireEvent;
        use crate::session::sqlite_store::SqliteSessionStore;

        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session("sess-cold-prompts", Some("Cold"))
            .unwrap();
        let append = |event_type: &str, payload: Value| {
            store
                .append_wire_event(&RawWireEvent {
                    id: format!("evt-{event_type}"),
                    session_id: "sess-cold-prompts".into(),
                    event_type: event_type.into(),
                    payload,
                    is_checkpoint: false,
                    is_compaction: false,
                    created_at: 1_000,
                })
                .unwrap();
        };
        append(
            "prompt.submitted",
            json!({
                "type": "prompt.submitted",
                "promptId": "prompt-1",
                "userMessageId": "msg-prompt-1",
                "status": "running",
                "content": [{ "type": "text", "text": "first" }],
                "createdAt": "2026-09-22T00:00:00Z",
            }),
        );
        append(
            "event.message.created",
            json!({ "type": "event.message.created", "id": "msg-u1" }),
        );
        append(
            "prompt.aborted",
            json!({
                "type": "prompt.aborted",
                "promptId": "prompt-1",
                "abortedAt": "2026-09-22T00:00:03Z",
            }),
        );
        append(
            "turn.steer",
            json!({ "type": "turn.steer", "origin": { "kind": "user" } }),
        );

        let prompts = cold_prompts(&store, "sess-cold-prompts");
        let prompts = prompts.as_array().expect("prompts serialize to an array");
        assert_eq!(prompts.len(), 1, "only the prompt lifecycle folds");
        assert_eq!(prompts[0]["promptId"], "prompt-1");
        assert_eq!(prompts[0]["status"], "aborted");
        assert_eq!(prompts[0]["finishedAt"], "2026-09-22T00:00:03Z");
        assert_eq!(prompts[0]["createdAt"], "2026-09-22T00:00:00Z");

        // A session with no journal yields an empty array, not null.
        store.create_session("sess-cold-empty", None).unwrap();
        assert_eq!(cold_prompts(&store, "sess-cold-empty"), json!([]));
    }

    /// `cold_tasks` restores the task list from the persisted journal
    /// (#3970): the spawn→register→complete chain folds into one adopted
    /// task, and an unfinished member whose spawning turn ended settles to
    /// `lost`.
    #[test]
    fn cold_tasks_restores_tasks_and_settles_lost_members() {
        use crate::native::event_store::RawWireEvent;
        use crate::session::sqlite_store::SqliteSessionStore;

        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session("sess-cold-tasks", Some("Cold"))
            .unwrap();
        let seq = std::cell::Cell::new(0u32);
        let append = |event_type: &str, payload: Value| {
            seq.set(seq.get() + 1);
            store
                .append_wire_event(&RawWireEvent {
                    id: format!("evt-{}", seq.get()),
                    session_id: "sess-cold-tasks".into(),
                    event_type: event_type.into(),
                    payload,
                    is_checkpoint: false,
                    is_compaction: false,
                    created_at: 1_000,
                })
                .unwrap();
        };
        append(
            "turn.started",
            // The journal's own shape (`TurnEvent::Started`: `turnId`, no
            // `agent_id`), not the live `EngineEvent` shape — the fold has to
            // read what the writer actually persists.
            json!({ "type": "turn.started", "turnId": 1, "origin": Value::Null }),
        );
        // Tower-worker shape: spawn first (agent-keyed), registration after.
        append(
            "subagent.spawned",
            json!({ "type": "subagent.spawned", "subagent_id": "agent-7", "run_in_background": true }),
        );
        append(
            "event.task.created",
            json!({
                "type": "event.task.created",
                "task": {
                    "id": "task-77",
                    "kind": "subagent",
                    "agent_id": "agent-7",
                    "status": "running",
                    "description": "worker"
                }
            }),
        );
        append(
            "subagent.completed",
            json!({
                "type": "subagent.completed",
                "subagent_id": "agent-7",
                "result_summary": "done",
                "usage": { "input_tokens": 7, "output_tokens": 2, "total_tokens": 9 }
            }),
        );
        // A second member whose spawning turn ended with no completion.
        append(
            "subagent.spawned",
            json!({ "type": "subagent.spawned", "subagent_id": "agent-8" }),
        );
        append(
            "turn.ended",
            // Same journal shape as above: `turnId`, no `agent_id`.
            json!({ "type": "turn.ended", "turnId": 1, "reason": "completed" }),
        );

        let tasks = cold_tasks(&store, "sess-cold-tasks");
        let tasks = tasks.as_array().expect("tasks serialize to an array");
        assert_eq!(tasks.len(), 2, "adoption keeps a single task per member");

        let adopted = tasks.iter().find(|t| t["taskId"] == "task-77").unwrap();
        assert_eq!(adopted["state"], "completed");
        assert_eq!(adopted["agentId"], "agent-7");
        assert_eq!(adopted["usage"]["inputOther"], 7);

        // The turn was read at all: without the normalization this member would
        // have no recorded spawning turn, and the fold would have had to guess
        // it was lost. `agent-8` really did lose contact with a turn that ended.
        let lost = tasks.iter().find(|t| t["taskId"] == "agent-8").unwrap();
        assert_eq!(lost["state"], "lost");

        // A member whose spawning turn is still running keeps its recorded
        // state — that is what makes the Lost rule a *cold* one.
        store
            .create_session("sess-cold-running", Some("Running"))
            .unwrap();
        let seq = std::cell::Cell::new(100u32);
        let append_running = |event_type: &str, payload: Value| {
            seq.set(seq.get() + 1);
            store
                .append_wire_event(&RawWireEvent {
                    id: format!("evt-run-{}", seq.get()),
                    session_id: "sess-cold-running".into(),
                    event_type: event_type.into(),
                    payload,
                    is_checkpoint: false,
                    is_compaction: false,
                    created_at: 1_000,
                })
                .unwrap();
        };
        append_running(
            "turn.started",
            json!({ "type": "turn.started", "turnId": 2, "origin": Value::Null }),
        );
        append_running(
            "subagent.spawned",
            json!({ "type": "subagent.spawned", "subagent_id": "agent-9" }),
        );
        let running = cold_tasks(&store, "sess-cold-running");
        let running = running.as_array().expect("tasks serialize to an array");
        assert_eq!(running.len(), 1);
        assert_eq!(
            running[0]["state"], "running",
            "a member of a still-running turn is not lost"
        );

        // A session with no journal yields an empty array.
        store.create_session("sess-cold-tasks-empty", None).unwrap();
        assert_eq!(cold_tasks(&store, "sess-cold-tasks-empty"), json!([]));
    }

    #[test]
    fn injected_reminders_are_not_user_prompts() {
        // v2 appends reminders with `origin.kind === 'injection'` and its
        // projector maps that to `other`, leaving the turn without a prompt —
        // so no client renders a bubble for text the user never typed. The
        // fork's messages carry no origin, so the `<system-reminder>` envelope
        // is what distinguishes them here.
        let history = vec![
            user("hello"),
            assistant("hi", Vec::new()),
            LLMMessage::new(
                "user",
                crate::injection::wrap_system_reminder("Today's date is 2026-09-20."),
            ),
            assistant("acknowledged", Vec::new()),
        ];
        let items = build_items(&history);
        assert_eq!(items.len(), 2);

        assert_eq!(items[0]["prompt"], "hello");
        assert_eq!(items[0]["origin"]["kind"], "user");

        assert_eq!(items[1]["origin"]["kind"], "other");
        assert!(
            items[1].get("prompt").is_none(),
            "an injected reminder must not carry a prompt"
        );
        // The turn itself still exists: the reminder accompanies a real turn
        // rather than replacing it, matching v2's per-turn injection.
        assert_eq!(items[1]["steps"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn groups_history_into_turns_steps_and_frames() {
        let history = vec![
            user("hello"),
            assistant("hi", vec![call("c1", "Read")]),
            tool("c1", "file contents"),
        ];
        let items = build_items(&history);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "turn");
        assert_eq!(items[0]["turnId"], "t0");
        assert_eq!(items[0]["prompt"], "hello");
        let steps = items[0]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1);
        let frames = steps[0]["frames"].as_array().unwrap();
        assert_eq!(frames[0]["kind"], "text");
        assert_eq!(frames[0]["text"], "hi");
        assert_eq!(frames[1]["kind"], "tool");
        assert_eq!(frames[1]["state"], "done");
        assert_eq!(frames[1]["output"], "file contents");
    }

    #[test]
    fn multiple_turns_keep_ordinals_and_paginate() {
        let mut history = Vec::new();
        for index in 0..5 {
            history.push(user(&format!("q{index}")));
            history.push(assistant(&format!("a{index}"), Vec::new()));
        }
        let items = build_items(&history);
        assert_eq!(items.len(), 5);

        let (page, has_more) = paginate_turns(
            &items,
            &TurnPageQuery {
                before_turn: None,
                after_turn: None,
                page_size: 2,
            },
        );
        assert!(has_more);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["turnId"], "t3");
        assert_eq!(page[1]["turnId"], "t4");

        let (older, older_more) = paginate_turns(
            &items,
            &TurnPageQuery {
                before_turn: Some("t3".to_string()),
                after_turn: None,
                page_size: 10,
            },
        );
        assert!(!older_more);
        assert_eq!(older.len(), 3);
        assert_eq!(older[0]["turnId"], "t0");
    }

    #[test]
    fn projects_user_messages_and_plans() {
        let plan_output = "Done\nPlan saved to: /tmp/plan.md\n## Approved Plan:\ndo the thing";
        let history = vec![
            user("start"),
            assistant("", vec![call("c1", "ExitPlanMode")]),
            tool("c1", plan_output),
        ];
        let items = build_items(&history);
        let messages = project_user_messages(&items);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["prompt"], "start");

        let plans = project_plans(&items, Some("c1"));
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0]["path"], "/tmp/plan.md");
        assert!(plans[0]["plan"].as_str().unwrap().contains("do the thing"));

        assert!(project_plans(&items, Some("missing")).is_empty());
    }
}
