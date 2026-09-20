//! Folding persisted session records into v3 flat entities.
//!
//! v3 hands a client entities addressed by `agent_id:type:entity_id` and serves
//! the same shapes from the live stream and from history, so a client that
//! rendered a turn live must not render it a second time when it loads that
//! turn's history. That only holds if both sides derive the same entity id from
//! the same inputs — and the fork's two sides do not start from the same ids:
//!
//! - the live stream reports a numeric `turnId` and `step` ordinal
//!   (`server/activity.rs`, `AgentPhase`) and never populates its `stepId`
//!   string; each tool round advances the step counter;
//! - the store keys a turn by `turns.turn_id`, which `server/engine.rs` writes
//!   as `turn-{random}`, and persists messages with no turn grouping at all.
//!
//! Neither side can use the id it happens to hold. Every id here is therefore
//! derived from the pair both sides *do* have — the turn number and the step
//! ordinal, both 1-based — and this module is the one place that defines them:
//!
//! | entity    | id                                         |
//! |-----------|--------------------------------------------|
//! | turn      | `{turn_number}`                            |
//! | user      | `{turn_number}.user`                       |
//! | step      | `{turn_number}.{step_ordinal}`             |
//! | assistant | `{turn_number}.{step_ordinal}.assistant`   |
//! | thinking  | `{turn_number}.{step_ordinal}.thinking`    |
//! | tool_call | the provider's own `tool_call_id`          |
//!
//! The number is the turn's position in the retained history, not the store's
//! `turn_number` counter: after a compaction or an undo the two differ, and the
//! position is the one a reader of this history can also compute.

use serde_json::Value;

use crate::rpc::types::{ContentBlock, MediaKind, TokenUsage};
use crate::session::sqlite_store::{COMPACT_TURN_ID, StoredMessage, TurnRecord};
use crate::turn_loop::types::LLMMessage;

use super::messages::{
    AssistantMessage, ContentPart, ContentPartType, ServerMessage, StepMessage, StepStatus,
    StreamStatus, TaskKind, TaskMessage, TaskStatus, ThinkingMessage, TodoItem, TodoItemStatus,
    TodoMessage, ToolCallMessage, ToolCallStatus, TurnMessage, TurnOrigin, TurnStatus, TurnUsage,
    UserMessage, UserMessageOrigin, UserMessageStatus,
};

/// Identity of a turn entity: the number both the live stream and a reader of
/// this history can compute.
pub fn turn_entity_id(turn_number: i64) -> String {
    turn_number.to_string()
}

/// Identity of the user message that opened a turn.
pub fn user_entity_id(turn_number: i64) -> String {
    format!("{turn_number}.user")
}

/// Identity of one step within a turn.
pub fn step_entity_id(turn_number: i64, step_ordinal: i64) -> String {
    format!("{turn_number}.{step_ordinal}")
}

/// Identity of the step's assistant text.
pub fn assistant_entity_id(turn_number: i64, step_ordinal: i64) -> String {
    format!("{turn_number}.{step_ordinal}.assistant")
}

/// Identity of the step's thinking text.
pub fn thinking_entity_id(turn_number: i64, step_ordinal: i64) -> String {
    format!("{turn_number}.{step_ordinal}.thinking")
}

/// What one turn's entities need from its record, already normalized to v3.
struct TurnContext {
    number: i64,
    timestamp: i64,
    status: TurnStatus,
    origin: TurnOrigin,
    started_at: Option<String>,
    ended_at: Option<String>,
    duration_ms: Option<i64>,
    usage: Option<TurnUsage>,
}

impl TurnContext {
    fn new(number: i64, record: Option<&TurnRecord>, fallback_timestamp: i64) -> Self {
        let started = record.map(|r| r.started_at).unwrap_or(fallback_timestamp);
        let completed = record.and_then(|r| r.completed_at);
        Self {
            number,
            timestamp: started,
            status: record
                .map(|r| match r.status.as_str() {
                    "running" => TurnStatus::Running,
                    _ => TurnStatus::Completed,
                })
                .unwrap_or(TurnStatus::Completed),
            // The persisted origin (v2 `PromptOrigin`) decides the kind; a
            // turn recorded before the column existed, or by a path that
            // carries none (fork/compaction helpers), falls back to the old
            // shape: compaction by its sentinel id, everything else `user`.
            origin: match record.map(|r| r.turn_id.as_str()) {
                Some(COMPACT_TURN_ID) => TurnOrigin::Compaction,
                _ => match record.and_then(|r| r.origin.as_ref()) {
                    Some(origin) => origin
                        .get("kind")
                        .and_then(|kind| kind.as_str())
                        .map(TurnOrigin::from_kind)
                        .unwrap_or(TurnOrigin::User),
                    None => TurnOrigin::User,
                },
            },
            started_at: iso(started),
            ended_at: completed.and_then(iso),
            duration_ms: completed.map(|end| (end - started).max(0)),
            usage: record.and_then(|r| r.usage.as_ref()).map(turn_usage),
        }
    }

    fn turn_message(
        &self,
        session_id: &str,
        agent_id: &str,
        user_message_id: Option<String>,
    ) -> TurnMessage {
        TurnMessage {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            timestamp: self.timestamp,
            turn_id: turn_entity_id(self.number),
            ordinal: self.number,
            status: self.status.clone(),
            origin: self.origin.clone(),
            user_message_id,
            attachment_ids: None,
            started_at: self.started_at.clone(),
            ended_at: self.ended_at.clone(),
            usage: self.usage.clone(),
            duration_ms: self.duration_ms,
        }
    }
}

/// Project one session's stored turns and messages into v3 entities, in the
/// order a client should apply them.
///
/// `turns` is matched to history by number, not by position, so a record whose
/// turn is no longer in the retained history is simply unused.
pub fn project_history(
    session_id: &str,
    agent_id: &str,
    turns: &[TurnRecord],
    messages: &[StoredMessage],
) -> Vec<ServerMessage> {
    let mut out: Vec<ServerMessage> = Vec::new();
    let mut current: Option<TurnContext> = None;
    let mut step_ordinal = 0i64;

    for stored in messages {
        match stored.message.role.as_str() {
            "system" => continue,
            "user" => {
                // v2 #3906: a steered message (it carries a `prompt_id` and its
                // role is not the turn's first user message) stays *inside* the
                // current turn with its prompt's identity, instead of minting a
                // turn of its own — the shape that made cancel echo the text
                // twice and left the host prompt un-undoable.
                let is_steered = stored.message.prompt_id.is_some() && current.is_some();
                if is_steered {
                    let context = current.as_ref().expect("checked above");
                    out.push(ServerMessage::User(UserMessage {
                        session_id: session_id.to_string(),
                        agent_id: agent_id.to_string(),
                        // The prompt's own id is the entity id, so a client can
                        // address the steered message by the prompt it came
                        // from (v2 `userMessageId: promptId`).
                        message_id: stored
                            .message
                            .prompt_id
                            .clone()
                            .unwrap_or_else(|| user_entity_id(context.number)),
                        turn_id: Some(turn_entity_id(context.number)),
                        status: UserMessageStatus::Read,
                        timestamp: Some(stored.created_at),
                        text: user_text(&stored.message),
                        attachment_ids: None,
                        skill_activations: None,
                        // `inTurn: true` is the non-anchor marker: undo of the
                        // host turn keeps the steered text from being treated
                        // as a second turn opener (v2 `markInTurnOrigin`).
                        origin: Some(UserMessageOrigin::User {
                            cron_id: None,
                            schedule: None,
                            in_turn: Some(true),
                        }),
                    }));
                    continue;
                }
                let number = match &current {
                    Some(context) => context.number + 1,
                    None => 1,
                };
                let context = TurnContext::new(
                    number,
                    turns.iter().find(|r| i64::from(r.turn_number) == number),
                    stored.created_at,
                );
                let user_id = user_entity_id(number);
                out.push(ServerMessage::Turn(context.turn_message(
                    session_id,
                    agent_id,
                    Some(user_id.clone()),
                )));
                out.push(ServerMessage::User(UserMessage {
                    session_id: session_id.to_string(),
                    agent_id: agent_id.to_string(),
                    message_id: user_id,
                    turn_id: Some(turn_entity_id(number)),
                    status: UserMessageStatus::Read,
                    timestamp: Some(stored.created_at),
                    text: user_text(&stored.message),
                    attachment_ids: None,
                    skill_activations: None,
                    origin: None,
                }));
                step_ordinal = 0;
                current = Some(context);
            }
            "assistant" => {
                if current.is_none() {
                    // A retained history can begin mid-turn (truncation, an
                    // undone prompt); the assistant text still needs a turn to
                    // hang off, so open one without a user entity.
                    let context = TurnContext::new(
                        1,
                        turns.iter().find(|r| r.turn_number == 1),
                        stored.created_at,
                    );
                    out.push(ServerMessage::Turn(
                        context.turn_message(session_id, agent_id, None),
                    ));
                    step_ordinal = 0;
                    current = Some(context);
                }
                let context = current.as_ref().expect("context ensured above");
                step_ordinal += 1;

                out.push(ServerMessage::Step(StepMessage {
                    session_id: session_id.to_string(),
                    agent_id: agent_id.to_string(),
                    timestamp: context.timestamp,
                    step_id: step_entity_id(context.number, step_ordinal),
                    turn_id: turn_entity_id(context.number),
                    ordinal: step_ordinal,
                    // History only retains finished steps.
                    status: StepStatus::Completed,
                    started_at: None,
                    ended_at: None,
                    usage: None,
                    finish_reason: None,
                    timing: None,
                    retry: None,
                    end_reason: None,
                    end_message: None,
                }));

                let thinking: String = stored
                    .message
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Think { think, .. } => Some(think.as_str()),
                        _ => None,
                    })
                    .collect();
                if !thinking.is_empty() {
                    out.push(ServerMessage::Thinking(ThinkingMessage {
                        session_id: session_id.to_string(),
                        agent_id: agent_id.to_string(),
                        timestamp: context.timestamp,
                        message_id: thinking_entity_id(context.number, step_ordinal),
                        turn_id: turn_entity_id(context.number),
                        step_id: step_entity_id(context.number, step_ordinal),
                        status: StreamStatus::Completed,
                        text: thinking,
                    }));
                }

                if !stored.message.content.is_empty() {
                    out.push(ServerMessage::Assistant(AssistantMessage {
                        session_id: session_id.to_string(),
                        agent_id: agent_id.to_string(),
                        timestamp: context.timestamp,
                        message_id: assistant_entity_id(context.number, step_ordinal),
                        turn_id: turn_entity_id(context.number),
                        step_id: step_entity_id(context.number, step_ordinal),
                        status: StreamStatus::Completed,
                        text: stored.message.content.clone(),
                    }));
                }

                for call in &stored.message.tool_calls {
                    // `call.extras` — provider round-trip state such as a
                    // Gemini thought signature — has no v3 field and is not
                    // display state, so only the input crosses over.
                    out.push(ServerMessage::ToolCall(ToolCallMessage {
                        session_id: session_id.to_string(),
                        agent_id: agent_id.to_string(),
                        timestamp: context.timestamp,
                        tool_call_id: call.id.clone(),
                        turn_id: turn_entity_id(context.number),
                        step_id: step_entity_id(context.number, step_ordinal),
                        name: call.name.clone(),
                        view: None,
                        // Flipped to `done` when the answering tool message
                        // shows up; a call whose result was never retained
                        // stays running, which is what the client should show.
                        status: ToolCallStatus::Running,
                        input: Some(call.arguments.clone()),
                        input_text: None,
                        output: None,
                        display: None,
                        error: None,
                        progress: None,
                        task_id: None,
                        approval_id: None,
                        todo_id: None,
                        agent_refs: None,
                    }));
                }
            }
            "tool" => {
                let Some(tool_call_id) = stored.message.tool_call_id.as_deref() else {
                    continue;
                };
                for entity in out.iter_mut().rev() {
                    if let ServerMessage::ToolCall(call) = entity
                        && call.tool_call_id == tool_call_id
                    {
                        call.status = ToolCallStatus::Done;
                        call.output = Some(Value::String(stored.message.content.clone()));
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    out
}

/// Project the stored `todo` domain into a v3 todo entity.
///
/// The fork keeps one todo tree — items carry `parentId`, `kind` and `progress`
/// — while upstream's item is only `{title, status}`. The tree is flattened in
/// depth-first order and the fields upstream has no home for are dropped, not
/// smuggled into `title`.
///
/// `todo_id` is the session the list is served to, because the fork scopes this
/// state per workspace and a session-scoped entity has no other list identity to
/// carry.
pub fn project_todo(
    session_id: &str,
    agent_id: &str,
    timestamp: i64,
    state: &Value,
) -> Option<TodoMessage> {
    let items = state.as_array()?;
    let mut flattened = Vec::new();
    let mut emitted = std::collections::HashSet::new();
    collect_todo_items(items, None, &mut flattened, &mut emitted);
    // Items inside a `parentId` cycle are reachable from no root at all; take
    // them in file order instead of losing them.
    for (index, item) in items.iter().enumerate() {
        if emitted.contains(&index) {
            continue;
        }
        emitted.insert(index);
        push_todo_item(item, &mut flattened);
    }
    Some(TodoMessage {
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        timestamp,
        todo_id: session_id.to_string(),
        items: flattened,
        updated_at: None,
    })
}

/// Flatten one level of the todo tree, then recurse into each item's children.
///
/// An item whose declared parent is not in the list counts as top level rather
/// than disappearing. Everything is tracked by *position*, so one pass emits
/// each item exactly once even when the file repeats ids or omits them.
fn collect_todo_items(
    items: &[Value],
    parent: Option<usize>,
    out: &mut Vec<TodoItem>,
    emitted: &mut std::collections::HashSet<usize>,
) {
    for (index, item) in items.iter().enumerate() {
        let parent_index = item
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|declared| {
                items
                    .iter()
                    .position(|candidate| has_id(candidate, declared))
            });
        let belongs = match parent {
            None => parent_index.is_none(),
            Some(parent) => parent_index == Some(parent),
        };
        if !belongs || !emitted.insert(index) {
            continue;
        }
        push_todo_item(item, out);
        collect_todo_items(items, Some(index), out, emitted);
    }
}

fn push_todo_item(item: &Value, out: &mut Vec<TodoItem>) {
    if let Some(title) = item.get("title").and_then(Value::as_str) {
        out.push(TodoItem {
            title: title.to_string(),
            status: todo_status(item.get("status").and_then(Value::as_str)),
        });
    }
}

fn has_id(item: &Value, id: &str) -> bool {
    item.get("id").and_then(Value::as_str) == Some(id)
}

/// Upstream's item status has three values; a status this fork stores beyond
/// them reads as `pending`, which is the state a client will act on anyway.
fn todo_status(status: Option<&str>) -> TodoItemStatus {
    match status {
        Some("in_progress") => TodoItemStatus::InProgress,
        Some("done") => TodoItemStatus::Done,
        _ => TodoItemStatus::Pending,
    }
}

/// Project the stored `task` domain into v3 task entities.
///
/// The stored entry is the fork's v2 shape — `taskId`, `description`, `status`,
/// `startedAt`, `endedAt`, `stopReason` — plus the output snapshot when the
/// caller merged one in, the way `StateStore::read_state` does for a single
/// task; the domain itself never holds the output log.
///
/// Two v3 fields have no stored source, so history answers them by
/// construction: `kind` is only carried by the live events, and everything in
/// this domain is a background task, so `detached` is true.
pub fn project_tasks(
    session_id: &str,
    agent_id: &str,
    timestamp: i64,
    state: &Value,
) -> Vec<TaskMessage> {
    state
        .as_array()
        .map(|tasks| {
            tasks
                .iter()
                .filter_map(|task| task_entity(session_id, agent_id, timestamp, task))
                .collect()
        })
        .unwrap_or_default()
}

fn task_entity(
    session_id: &str,
    agent_id: &str,
    timestamp: i64,
    task: &Value,
) -> Option<TaskMessage> {
    Some(TaskMessage {
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        timestamp,
        task_id: task.get("taskId").and_then(Value::as_str)?.to_string(),
        kind: TaskKind::Other,
        status: task_status(task.get("status").and_then(Value::as_str)),
        detached: true,
        description: text(task, "description"),
        child_agent_id: None,
        output_tail: text(task, "output").unwrap_or_default(),
        started_at: task.get("startedAt").and_then(Value::as_i64).and_then(iso),
        ended_at: task.get("endedAt").and_then(Value::as_i64).and_then(iso),
        result_summary: None,
        error: None,
        state_reason: text(task, "stopReason"),
        usage: None,
        model: None,
        thinking_effort: None,
    })
}

/// The runner writes three of upstream's six statuses. A fourth value — or a
/// missing one — is reported as `lost` rather than `failed`, because "this is
/// not one of the states I know" is not the same claim as "this task failed".
fn task_status(status: Option<&str>) -> TaskStatus {
    match status {
        Some("running") => TaskStatus::Running,
        Some("completed") => TaskStatus::Completed,
        Some("killed") => TaskStatus::Killed,
        _ => TaskStatus::Lost,
    }
}

/// The state-domain entities a history page ends with: the workspace's todo
/// list and this session's background tasks.
///
/// Upstream derives the todo entity from the folded tool-call stream (the
/// last completed `TodoList` write) and the task entities from task
/// lifecycle records; the fork's authority for both is the workspace state
/// store, so the projections read it directly. Stored task entries carry the
/// spawning session (`sessionId` on the wire), so the task list filters to
/// the requested session; entries written before that field existed — and
/// todo state, which is workspace-scoped with no session of its own — are
/// served unfiltered rather than lost.
///
/// `now` stamps the entities — history has no better clock than "when the
/// page was served".
pub fn project_state_domains(
    store: &crate::storage::StateStore,
    session_id: &str,
    agent_id: &str,
    now: i64,
) -> Vec<ServerMessage> {
    let mut entities = Vec::new();
    if let Some(todos) = store.read_domain("todo")
        && let Some(todo) = project_todo(session_id, agent_id, now, &todos)
    {
        entities.push(ServerMessage::Todo(todo));
    }
    if let Some(tasks) = store
        .read_domain("task")
        .and_then(|v| v.as_array().cloned())
    {
        entities.extend(
            tasks
                .iter()
                .filter(|task| {
                    task.get("sessionId")
                        .and_then(Value::as_str)
                        .is_none_or(|sid| sid == session_id)
                })
                .filter_map(|task| task_entity(session_id, agent_id, now, task))
                .map(ServerMessage::Task)
                .collect::<Vec<_>>(),
        );
    }
    entities
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A user message's body as v3 content parts.
///
/// Upstream's part is `{type, text, meta}` with a host-defined `meta`, and this
/// fork has no host that packs v3 parts, so the payload goes in `text` — the
/// URL for a linked medium, a `data:` URL for an inlined image — and `meta`
/// stays empty rather than inventing keys for names and provider ids that
/// nothing would read back.
fn user_text(message: &LLMMessage) -> Vec<ContentPart> {
    let part = |kind: ContentPartType, text: String| ContentPart {
        r#type: kind,
        text,
        meta: std::collections::HashMap::new(),
    };

    // The HTTP prompt path stores the body separately from media-only blocks.
    // Explicit text blocks still take precedence over the plain-text fallback.
    let needs_text = !message.content.is_empty()
        && !message
            .blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::Text { .. }));
    let mut parts = Vec::with_capacity(message.blocks.len() + usize::from(needs_text));
    if needs_text {
        parts.push(part(ContentPartType::Text, message.content.clone()));
    }

    parts.extend(message.blocks.iter().map(|block| match block {
        ContentBlock::Text { text } => part(ContentPartType::Text, text.clone()),
        ContentBlock::Think { think, .. } => part(ContentPartType::Think, think.clone()),
        ContentBlock::Image {
            media_type, data, ..
        } => part(
            ContentPartType::Image,
            format!("data:{media_type};base64,{data}"),
        ),
        ContentBlock::ImageUrl { url, .. } => part(ContentPartType::Image, url.clone()),
        ContentBlock::AudioUrl { url, .. } => part(ContentPartType::Audio, url.clone()),
        ContentBlock::VideoUrl { url, .. } => part(ContentPartType::Video, url.clone()),
        // The transcript shows the reference, not the bytes: the client
        // fetches it from the daemon's file store by id.
        ContentBlock::MediaRef { file_id, kind } => {
            let kind = match kind {
                MediaKind::Image => ContentPartType::Image,
                MediaKind::Video => ContentPartType::Video,
                MediaKind::Audio => ContentPartType::Audio,
            };
            part(kind, format!("kimi-file://{file_id}"))
        }
    }));
    parts
}

/// Upstream's timestamps are ISO strings; the store keeps milliseconds.
pub(super) fn iso(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// The store records no monetary cost, and v3 has no field for cache writes, so
/// `cached_tokens` carries the cache *reads* and the write count is dropped.
fn turn_usage(usage: &TokenUsage) -> TurnUsage {
    TurnUsage {
        input_tokens: Some(i64::from(usage.input_tokens)),
        output_tokens: Some(i64::from(usage.output_tokens)),
        cached_tokens: Some(i64::from(usage.input_cache_read)),
        cost: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::v3::entity::{entity_key, key_of};
    use crate::turn_loop::types::ToolCall;
    use serde_json::json;

    fn stored(role: &str, content: &str, created_at: i64) -> StoredMessage {
        StoredMessage {
            message: LLMMessage {
                role: role.to_string(),
                content: content.to_string(),
                ..Default::default()
            },
            created_at,
            turn_id: "turn-test".to_string(),
        }
    }

    fn steered(prompt_id: &str, content: &str, created_at: i64) -> StoredMessage {
        StoredMessage {
            message: LLMMessage {
                role: "user".to_string(),
                content: content.to_string(),
                prompt_id: Some(prompt_id.to_string()),
                ..Default::default()
            },
            created_at,
            turn_id: "turn-test".to_string(),
        }
    }

    fn record(number: u32, started: i64, completed: Option<i64>) -> TurnRecord {
        TurnRecord {
            turn_id: format!("turn-{}", 9_000 + number),
            turn_number: number,
            status: "completed".to_string(),
            started_at: started,
            completed_at: completed,
            usage: None,
            origin: None,
        }
    }

    fn turn_of(entity: &ServerMessage) -> &TurnMessage {
        match entity {
            ServerMessage::Turn(turn) => turn,
            other => panic!("expected a turn entity, got {other:?}"),
        }
    }

    #[test]
    fn entity_ids_are_derived_from_turn_and_step_numbers() {
        let turns = [
            record(1, 1_700_000_000_000, None),
            record(2, 1_700_000_001_000, None),
        ];
        let mut answering = stored("assistant", "two", 1_700_000_000_100);
        answering.message.tool_calls.push(ToolCall {
            id: "call-a".into(),
            name: "read".into(),
            arguments: json!({"path": "a"}),
            extras: None,
        });
        let messages = [
            stored("user", "one", 1_700_000_000_000),
            answering,
            stored("user", "three", 1_700_000_001_000),
            stored("assistant", "four", 1_700_000_001_100),
        ];

        let entities = project_history("s1", "main", &turns, &messages);
        let ids: Vec<String> = entities
            .iter()
            .map(|entity| match entity {
                ServerMessage::Turn(turn) => format!("turn:{}", turn.turn_id),
                ServerMessage::User(user) => format!("user:{}", user.message_id),
                ServerMessage::Step(step) => format!("step:{}", step.step_id),
                ServerMessage::Assistant(text) => format!("assistant:{}", text.message_id),
                ServerMessage::ToolCall(call) => format!("tool:{}", call.tool_call_id),
                other => panic!("unexpected entity {other:?}"),
            })
            .collect();

        assert_eq!(
            ids,
            [
                "turn:1",
                "user:1.user",
                "step:1.1",
                "assistant:1.1.assistant",
                "tool:call-a",
                "turn:2",
                "user:2.user",
                "step:2.1",
                "assistant:2.1.assistant",
            ]
        );

        // The store's own row key is generated per session and unreproducible,
        // so leaking it into an entity id would make history and live disagree
        // on every turn.
        let serialized = serde_json::to_string(&entities).unwrap();
        assert!(!serialized.contains("turn-9001"), "{serialized}");

        assert_eq!(
            key_of(&entities[0], "turn"),
            entity_key(Some("main"), "turn", "1")
        );
    }

    #[test]
    fn folds_blocks_tools_and_results_into_entities() {
        let mut assistant = stored("assistant", "answer", 1_700_000_000_100);
        assistant.message.blocks = vec![
            ContentBlock::Think {
                think: "weighing it".into(),
                encrypted: None,
            },
            ContentBlock::Think {
                think: String::new(),
                encrypted: None,
            },
        ];
        assistant.message.tool_calls.push(ToolCall {
            id: "call-a".into(),
            name: "read".into(),
            arguments: json!({"path": "a"}),
            extras: None,
        });
        assistant.message.tool_calls.push(ToolCall {
            id: "call-b".into(),
            name: "bash".into(),
            arguments: json!({"command": "ls"}),
            extras: None,
        });
        let mut result = stored("tool", "file body", 1_700_000_000_200);
        result.message.tool_call_id = Some("call-a".into());
        let messages = [stored("user", "go", 1_700_000_000_000), assistant, result];

        let entities = project_history(
            "s1",
            "main",
            &[record(1, 1_700_000_000_000, None)],
            &messages,
        );

        let thinking: Vec<&String> = entities
            .iter()
            .filter_map(|entity| match entity {
                ServerMessage::Thinking(text) => Some(&text.text),
                _ => None,
            })
            .collect();
        assert_eq!(
            thinking,
            ["weighing it"],
            "an empty think block is not an entity"
        );

        let calls: Vec<(&String, &ToolCallStatus, &Option<Value>)> = entities
            .iter()
            .filter_map(|entity| match entity {
                ServerMessage::ToolCall(call) => {
                    Some((&call.tool_call_id, &call.status, &call.output))
                }
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].1,
            &ToolCallStatus::Done,
            "the answered call is done"
        );
        assert_eq!(calls[0].2, &Some(json!("file body")));
        assert_eq!(calls[1].0, "call-b");
        assert_eq!(
            calls[1].1,
            &ToolCallStatus::Running,
            "an unanswered call stays running"
        );
        assert_eq!(calls[1].2, &None);
    }

    #[test]
    fn multiple_thinking_blocks_form_one_complete_step_entity() {
        let mut assistant = stored("assistant", "answer", 2);
        assistant.message.blocks = vec![
            ContentBlock::Think {
                think: "first ".into(),
                encrypted: None,
            },
            ContentBlock::Think {
                think: String::new(),
                encrypted: None,
            },
            ContentBlock::Think {
                think: "second".into(),
                encrypted: None,
            },
        ];
        let messages = [stored("user", "go", 1), assistant];
        let entities = project_history("s1", "main", &[], &messages);
        let thinking: Vec<_> = entities
            .iter()
            .filter_map(|entity| match entity {
                ServerMessage::Thinking(text) => {
                    Some((text.message_id.as_str(), text.text.as_str(), &text.status))
                }
                _ => None,
            })
            .collect();

        assert_eq!(
            thinking,
            [("1.1.thinking", "first second", &StreamStatus::Completed)],
            "one upsert must retain all thinking that the live deltas appended"
        );
    }

    #[test]
    fn turn_metadata_comes_from_the_record() {
        let usage = TokenUsage {
            input_tokens: 1_200,
            output_tokens: 34,
            total_tokens: 1_234,
            input_cache_read: 900,
            input_cache_creation: 0,
        };
        let turns = [TurnRecord {
            turn_id: "turn-1".into(),
            turn_number: 1,
            status: "running".into(),
            started_at: 1_700_000_000_000,
            completed_at: Some(1_700_000_002_500),
            usage: Some(usage),
            origin: None,
        }];
        let messages = [stored("user", "go", 1_700_000_000_000)];

        let entities = project_history("s1", "main", &turns, &messages);
        let turn = turn_of(&entities[0]);

        assert_eq!(turn.status, TurnStatus::Running);
        assert_eq!(turn.origin, TurnOrigin::User);
        assert_eq!(turn.duration_ms, Some(2_500));
        assert_eq!(turn.started_at.as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(turn.ended_at.as_deref(), Some("2023-11-14T22:13:22.500Z"));
        assert_eq!(
            turn.usage,
            Some(TurnUsage {
                input_tokens: Some(1_200),
                output_tokens: Some(34),
                cached_tokens: Some(900),
                cost: None,
            })
        );
    }

    #[test]
    fn a_compaction_turn_keeps_its_origin() {
        let turns = [TurnRecord {
            turn_id: COMPACT_TURN_ID.into(),
            turn_number: 1,
            status: "completed".into(),
            started_at: 1_700_000_000_000,
            completed_at: None,
            usage: None,
            origin: None,
        }];
        let entities = project_history("s1", "main", &turns, &[stored("user", "summary", 1)]);
        assert_eq!(turn_of(&entities[0]).origin, TurnOrigin::Compaction);
    }

    #[test]
    fn history_without_records_still_projects() {
        let messages = [
            stored("user", "one", 1_700_000_000_000),
            stored("assistant", "two", 1_700_000_000_100),
            stored("user", "three", 1_700_000_001_000),
        ];

        let entities = project_history("s1", "main", &[], &messages);
        let numbers: Vec<i64> = entities
            .iter()
            .filter_map(|entity| match entity {
                ServerMessage::Turn(turn) => Some(turn.ordinal),
                _ => None,
            })
            .collect();
        assert_eq!(
            numbers,
            [1, 2],
            "turns are numbered by their place in the history"
        );

        let turn = turn_of(&entities[0]);
        assert_eq!(turn.timestamp, 1_700_000_000_000);
        assert_eq!(turn.usage, None);
        assert_eq!(turn.started_at.as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(turn.ended_at, None);
        assert_eq!(turn.duration_ms, None);
    }

    #[test]
    fn an_assistant_first_history_opens_its_own_turn() {
        let messages = [
            stored("assistant", "resumed", 1_700_000_000_100),
            stored("user", "next", 1_700_000_001_000),
        ];

        let entities = project_history("s1", "main", &[], &messages);
        let turns: Vec<(&String, &Option<String>)> = entities
            .iter()
            .filter_map(|entity| match entity {
                ServerMessage::Turn(turn) => Some((&turn.turn_id, &turn.user_message_id)),
                _ => None,
            })
            .collect();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].0, "1");
        assert_eq!(turns[0].1, &None, "a synthetic turn has no user entity");
        assert_eq!(turns[1].0, "2");
        assert_eq!(turns[1].1, &Some("2.user".to_string()));
    }

    #[test]
    fn history_keeps_user_text_stored_separately_from_media_blocks() {
        let mut user = stored("user", "describe the attachment", 1);
        user.message.blocks = vec![ContentBlock::ImageUrl {
            url: "https://example.test/attachment.png".into(),
            id: None,
            name: None,
        }];
        let entities = project_history("s1", "main", &[], &[user]);
        let ServerMessage::User(user) = &entities[1] else {
            panic!("expected the opening user message");
        };
        let parts: Vec<_> = user
            .text
            .iter()
            .map(|part| (&part.r#type, part.text.as_str()))
            .collect();

        assert_eq!(
            parts,
            [
                (&ContentPartType::Text, "describe the attachment"),
                (
                    &ContentPartType::Image,
                    "https://example.test/attachment.png"
                ),
            ],
            "history must retain both the prompt body and its attachment"
        );
    }

    /// v2 #3906/#3891: a steered user message keeps its prompt's id, stays
    /// inside the host turn, and carries an in-turn origin — it is not a turn
    /// opener, so undo targets the host turn and cancel cannot echo the text
    /// twice.
    #[test]
    fn steered_user_messages_stay_in_the_host_turn() {
        let history = vec![
            stored("user", "original question", 1_000),
            stored("assistant", "working…", 1_100),
            steered("prompt-1", "actually use python", 1_200),
            stored("assistant", "done", 1_300),
        ];
        let messages = project_history("s", "main", &[], &history);

        let users: Vec<&UserMessage> = messages
            .iter()
            .filter_map(|message| match message {
                ServerMessage::User(user) => Some(user),
                _ => None,
            })
            .collect();

        assert_eq!(
            users.len(),
            2,
            "the steer must not mint a second turn opener"
        );

        // The turn opener keeps the positional id.
        assert_eq!(users[0].message_id, "1.user");
        assert!(users[0].origin.is_none());

        // The steer keeps the prompt's id and is marked in-turn.
        assert_eq!(users[1].message_id, "prompt-1");
        assert_eq!(users[1].turn_id.as_deref(), Some("1"));
        match &users[1].origin {
            Some(UserMessageOrigin::User { in_turn, .. }) => {
                assert_eq!(in_turn, &Some(true), "the steer is a non-anchor origin");
            }
            other => panic!("expected a user origin, got {other:?}"),
        }
    }

    /// A steered message at the very front of a retained history has no host
    /// turn to hang off; the positional fallback must not panic.
    #[test]
    fn a_steered_message_without_a_preceding_turn_falls_back() {
        let history = vec![steered("prompt-9", "orphan steer", 500)];
        let messages = project_history("s", "main", &[], &history);
        // Falls through to the plain turn-opener path: `prompt_id` only marks
        // a message steered when a host turn is actually open.
        let users: Vec<&UserMessage> = messages
            .iter()
            .filter_map(|message| match message {
                ServerMessage::User(user) => Some(user),
                _ => None,
            })
            .collect();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].message_id, "1.user");
    }

    #[test]
    fn user_parts_carry_their_payload_without_inventing_meta() {
        let mut message = LLMMessage {
            role: "user".into(),
            content: "text only".into(),
            ..Default::default()
        };
        assert_eq!(user_text(&message)[0].text, "text only");

        message.blocks = vec![
            ContentBlock::Text { text: "hi".into() },
            ContentBlock::Image {
                media_type: "image/png".into(),
                data: "aGk=".into(),
                name: Some("shot.png".into()),
            },
            ContentBlock::ImageUrl {
                url: "https://example.test/a.png".into(),
                id: None,
                name: None,
            },
            ContentBlock::AudioUrl {
                url: "https://example.test/a.mp3".into(),
                id: None,
                name: None,
            },
            ContentBlock::VideoUrl {
                url: "https://example.test/a.mp4".into(),
                id: None,
                name: None,
            },
        ];

        let parts = user_text(&message);
        let kinds: Vec<&ContentPartType> = parts.iter().map(|part| &part.r#type).collect();
        assert_eq!(
            kinds,
            [
                &ContentPartType::Text,
                &ContentPartType::Image,
                &ContentPartType::Image,
                &ContentPartType::Audio,
                &ContentPartType::Video,
            ]
        );
        assert_eq!(parts[1].text, "data:image/png;base64,aGk=");
        assert_eq!(parts[2].text, "https://example.test/a.png");
        assert!(parts.iter().all(|part| part.meta.is_empty()));
    }

    #[test]
    fn todo_trees_are_flattened_in_order() {
        let state = json!([
            { "id": "T1", "parentId": null, "kind": "task", "title": "Read", "status": "in_progress", "progress": 40 },
            { "id": "T2", "parentId": "T1", "kind": "task", "title": "Child", "status": "done" },
            { "id": "T3", "parentId": null, "kind": "task", "title": "Write", "status": "pending" },
        ]);

        let todo = project_todo("s1", "main", 7, &state).expect("an array projects");
        let titles: Vec<&str> = todo.items.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Read", "Child", "Write"],
            "a child follows its parent"
        );
        assert_eq!(todo.items[0].status, TodoItemStatus::InProgress);
        assert_eq!(todo.items[1].status, TodoItemStatus::Done);
        assert_eq!(todo.items[2].status, TodoItemStatus::Pending);
        assert_eq!(todo.todo_id, "s1");
        assert_eq!(todo.timestamp, 7);
    }

    #[test]
    fn todo_orphans_are_promoted_and_cycles_reach_the_wire() {
        let state = json!([
            { "id": "T1", "parentId": "T9", "title": "Orphan" },
            { "id": "T2", "parentId": "T3", "title": "Loop a" },
            { "id": "T3", "parentId": "T2", "title": "Loop b" },
        ]);

        let todo = project_todo("s1", "main", 1, &state).expect("an array projects");
        let titles: Vec<&str> = todo.items.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Orphan", "Loop a", "Loop b"],
            "an unreachable item is still reported, in file order"
        );
    }

    #[test]
    fn a_non_array_todo_state_is_not_an_entity() {
        assert!(project_todo("s1", "main", 1, &json!({ "active": false })).is_none());
    }

    #[test]
    fn state_domains_serve_the_todo_list_and_only_this_sessions_tasks() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = crate::storage::StateStore::for_dir(dir.path().to_path_buf()).unwrap();
        store
            .write_domain(
                "todo",
                &json!([{ "title": "Wire the fold", "status": "done" }]),
            )
            .unwrap();
        store
            .write_domain(
                "task",
                &json!([
                    { "taskId": "task-a", "description": "mine", "status": "completed", "sessionId": "s1" },
                    { "taskId": "task-b", "description": "another session's", "status": "running", "sessionId": "s2" },
                    { "taskId": "task-c", "description": "pre-sessionId", "status": "killed" },
                ]),
            )
            .unwrap();

        let entities = project_state_domains(&store, "s1", "main", 42);
        let ids: Vec<String> = entities
            .iter()
            .map(|e| match e {
                ServerMessage::Todo(_) => "todo".to_string(),
                ServerMessage::Task(t) => format!("task:{}", t.task_id),
                other => format!("unexpected:{:?}", other.message_type()),
            })
            .collect();
        assert_eq!(ids, ["todo", "task:task-a", "task:task-c"]);
        let first = match &entities[0] {
            ServerMessage::Todo(todo) => todo,
            other => panic!("expected the todo entity first, got {other:?}"),
        };
        assert_eq!(first.items[0].title, "Wire the fold");
        assert_eq!(first.items[0].status, TodoItemStatus::Done);
        assert_eq!(first.timestamp, 42);
    }

    #[test]
    fn empty_state_domains_serve_nothing() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = crate::storage::StateStore::for_dir(dir.path().to_path_buf()).unwrap();
        assert!(project_state_domains(&store, "s1", "main", 1).is_empty());
    }

    #[test]
    fn tasks_carry_what_the_domain_stores() {
        let state = json!([
            {
                "taskId": "task-1",
                "description": "run the suite",
                "status": "running",
                "startedAt": 1_700_000_000_000i64,
                "stopReason": "user",
            },
            {
                "taskId": "task-2",
                "description": "old",
                "status": "killed",
                "startedAt": 1_700_000_000_000i64,
                "endedAt": 1_700_000_003_000i64,
            },
            { "description": "no id" },
        ]);

        let tasks = project_tasks("s1", "main", 1, &state);
        assert_eq!(tasks.len(), 2, "an entry without a task id is skipped");

        assert_eq!(tasks[0].task_id, "task-1");
        assert_eq!(tasks[0].status, TaskStatus::Running);
        assert!(tasks[0].detached);
        assert_eq!(tasks[0].kind, TaskKind::Other);
        assert_eq!(tasks[0].state_reason.as_deref(), Some("user"));
        assert_eq!(tasks[0].ended_at, None);
        assert_eq!(
            tasks[0].output_tail, "",
            "the domain never holds the output log"
        );
        assert_eq!(
            tasks[1].started_at.as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(
            tasks[1].ended_at.as_deref(),
            Some("2023-11-14T22:13:23.000Z")
        );
    }

    #[test]
    fn an_unknown_task_status_reads_as_lost() {
        assert_eq!(task_status(Some("timed_out")), TaskStatus::Lost);
        assert_eq!(task_status(None), TaskStatus::Lost);
        assert_eq!(task_status(Some("completed")), TaskStatus::Completed);
    }
}
