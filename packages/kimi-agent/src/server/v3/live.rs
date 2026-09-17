//! Live engine events as v3 entities.
//!
//! The live lane's counterpart of [`super::projection`], and it has to answer the
//! same question: what is this entity *called*? The derivation is the same one —
//! turn numbers and step ordinals — because a client keys entities by
//! `agent_id:type:entity_id`, so a replayed turn that arrived under a different
//! name would be rendered beside its live twin instead of over it.
//!
//! Two facts about this engine's live vocabulary shape the code.
//!
//! The streaming frames name no step: `assistant.delta` carries a turn and a
//! delta, `thinking.delta` the same, so the step a delta belongs to exists only in
//! the reader's head. This translator keeps it. A step opens on the first text
//! after a turn starts — or after a tool round ends, since one assistant message
//! per step is what history folds — and closes when a tool call starts.
//!
//! The vocabulary also carries two kinds of turn id: `turn.*`,
//! `assistant.delta`, `thinking.delta` and `tool.call.*` use the numeric counter
//! the activity tracker keeps, while `llm.*` uses a string. The ordinal here comes
//! from the numeric one, and `llm.*` is only allowed to *open* a step: its own
//! `step` field is not used as an entity ordinal, because history numbers steps by
//! position and the two must agree. For the same reason the counter and the stored
//! position agree only until something removes turns (a compaction, an undo) —
//! reconciling that is recorded in the roadmap.
//!
//! Three gaps are deliberate. `tool.progress` carries an opaque `Value`, so it is
//! re-emitted as a `custom` progress payload rather than mapped onto a shape it
//! does not have. `subagent.message` — how a subagent's own timeline is persisted
//! — is left alone, because it belongs to the child's timeline, which has its own
//! subscription. And `config.changed`, `session.meta.updated`, `cron.fired` and a
//! goal budget notice have no session-scoped entity to become: they are global or
//! host-level state, which the hub's global lane owns.

use serde_json::Value;

use crate::events::EngineEvent;

use super::history::HistoryInFlight;
use super::messages::{
    AssistantDeltaMessage, AssistantMessage, ContentPart, ContentPartType, PendingInteraction,
    ServerMessage, SessionStateMessage, SessionStatus, StepMessage, StepStatus, StreamStatus,
    TaskKind, TaskMessage, TaskStatus, ThinkingDeltaMessage, ToolCallDeltaMessage, ToolCallMessage,
    ToolCallStatus, ToolProgressKind, ToolProgressPayload, TurnMessage, TurnOrigin, TurnStatus,
    UserMessage, UserMessageStatus,
};
use super::projection::{
    assistant_entity_id, iso, step_entity_id, thinking_entity_id, turn_entity_id, user_entity_id,
};

/// Folds one agent's live events into v3 entities.
///
/// Its state is the position a streaming frame cannot name for itself: the open
/// turn, the open step, and when the turn started.
#[derive(Debug, Clone)]
pub struct LiveTranslator {
    session_id: String,
    agent_id: String,
    turn: i64,
    step: i64,
    started_at: Option<i64>,
    /// Set when a tool round begins, so the text that follows opens the next step
    /// instead of extending the one the tool call belonged to.
    step_closed: bool,
}

impl LiveTranslator {
    pub fn new(session_id: impl Into<String>, agent_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            agent_id: agent_id.into(),
            turn: 0,
            step: 0,
            started_at: None,
            step_closed: false,
        }
    }

    /// Where streaming has reached, for the history route's `in_flight` — the same
    /// pair of entity ids the live stream is writing under.
    pub fn in_flight(&self) -> Option<HistoryInFlight> {
        (self.turn > 0 && self.step > 0).then(|| HistoryInFlight {
            turn_id: turn_entity_id(self.turn),
            step_id: step_entity_id(self.turn, self.step),
        })
    }

    /// Fold one event into the entities it changes.
    pub fn translate(&mut self, event: &EngineEvent, now: i64) -> Vec<ServerMessage> {
        match event {
            EngineEvent::TurnStarted {
                agent_id,
                turn_id,
                prompt,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.open_turn(*turn_id as i64, now);
                let user_message_id = prompt.as_ref().map(|_| user_entity_id(self.turn));
                let mut entities = vec![ServerMessage::Turn(self.turn_snapshot(
                    TurnStatus::Running,
                    user_message_id,
                    now,
                    None,
                ))];
                if let Some(prompt) = prompt {
                    entities.push(ServerMessage::User(self.user_message(prompt, now)));
                }
                entities
            }

            EngineEvent::TurnEnded {
                agent_id,
                turn_id,
                reason,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                let started_at = self.started_at.unwrap_or(now);
                let mut entities = vec![ServerMessage::Turn(self.turn_snapshot(
                    TurnStatus::Completed,
                    None,
                    started_at,
                    Some(now),
                ))];
                if self.step > 0 {
                    entities.push(ServerMessage::Step(self.step_snapshot(
                        StepStatus::Completed,
                        now,
                        Some(reason.clone()),
                    )));
                }
                self.step_closed = true;
                entities
            }

            EngineEvent::AssistantDelta {
                agent_id,
                turn_id,
                delta,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                self.begin_step();
                vec![ServerMessage::AssistantDelta(AssistantDeltaMessage {
                    session_id: self.session_id.clone(),
                    agent_id: self.agent_id.clone(),
                    timestamp: now,
                    message_id: assistant_entity_id(self.turn, self.step),
                    text: delta.clone(),
                })]
            }

            EngineEvent::ThinkingDelta {
                agent_id,
                turn_id,
                delta,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                self.begin_step();
                vec![ServerMessage::ThinkingDelta(ThinkingDeltaMessage {
                    session_id: self.session_id.clone(),
                    agent_id: self.agent_id.clone(),
                    timestamp: now,
                    message_id: thinking_entity_id(self.turn, self.step),
                    text: delta.clone(),
                })]
            }

            EngineEvent::ToolCallStarted {
                agent_id,
                turn_id,
                tool_call_id,
                name,
                args,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                self.begin_step();
                // The text of this step is finished; whatever the model says after
                // the tool result belongs to the next one.
                self.step_closed = true;
                let mut call = self.tool_call(tool_call_id, name, ToolCallStatus::Running, now);
                call.input = Some(args.clone());
                vec![ServerMessage::ToolCall(call)]
            }

            EngineEvent::ToolCallDelta {
                agent_id,
                turn_id,
                tool_call_id,
                arguments_part,
                ..
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                self.begin_step();
                vec![ServerMessage::ToolCallDelta(ToolCallDeltaMessage {
                    session_id: self.session_id.clone(),
                    agent_id: self.agent_id.clone(),
                    timestamp: now,
                    tool_call_id: tool_call_id.clone(),
                    input_text: arguments_part.clone().unwrap_or_default(),
                })]
            }

            EngineEvent::ToolCallCompleted {
                agent_id,
                turn_id,
                tool_call_id,
                result,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                let mut call = self.tool_call(tool_call_id, "", ToolCallStatus::Done, now);
                call.output = Some(result.clone());
                vec![ServerMessage::ToolCall(call)]
            }

            EngineEvent::ToolCallFailed {
                agent_id,
                turn_id,
                tool_call_id,
                error,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                let mut call = self.tool_call(tool_call_id, "", ToolCallStatus::Error, now);
                call.error = Some(error.clone());
                vec![ServerMessage::ToolCall(call)]
            }

            EngineEvent::ToolProgress {
                agent_id,
                turn_id,
                tool_call_id,
                update,
            } => {
                if !self.is_my_agent(agent_id) {
                    return Vec::new();
                }
                self.turn = *turn_id as i64;
                let mut call = self.tool_call(tool_call_id, "", ToolCallStatus::Running, now);
                call.progress = Some(ToolProgressPayload {
                    kind: ToolProgressKind::Custom,
                    // The live payload has no agreed shape, so it is carried whole
                    // rather than picked apart into fields it may not have.
                    text: update
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    percent: update.get("percent").and_then(Value::as_f64),
                    custom_kind: update
                        .get("kind")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    custom_data: Some(update.clone()),
                });
                vec![ServerMessage::ToolCall(call)]
            }

            EngineEvent::ToolNative {
                turn_id,
                tool_call_id,
                tool_name,
                arguments,
                content,
                is_error,
                ..
            } => {
                self.turn = parse_turn(turn_id, self.turn);
                self.begin_step();
                let status = if *is_error {
                    ToolCallStatus::Error
                } else {
                    ToolCallStatus::Done
                };
                let mut call = self.tool_call(tool_call_id, tool_name, status, now);
                call.input = Some(arguments.clone());
                if *is_error {
                    call.error = Some(content.clone());
                } else {
                    call.output = Some(Value::String(content.clone()));
                }
                vec![ServerMessage::ToolCall(call)]
            }

            EngineEvent::SubagentSpawned {
                agent_id,
                profile_name,
                ..
            } => {
                let mut task = self.task(agent_id, TaskStatus::Running, now);
                task.description = Some(profile_name.clone());
                vec![ServerMessage::Task(task)]
            }

            EngineEvent::SubagentCompleted { agent_id, summary } => {
                let mut task = self.task(agent_id, TaskStatus::Completed, now);
                task.ended_at = iso(now);
                task.result_summary = Some(summary.clone());
                vec![ServerMessage::Task(task)]
            }

            EngineEvent::SubagentFailed { agent_id, error } => {
                let mut task = self.task(agent_id, TaskStatus::Failed, now);
                task.ended_at = iso(now);
                task.error = Some(error.clone());
                vec![ServerMessage::Task(task)]
            }

            EngineEvent::SessionWorkChanged {
                busy,
                main_turn_active,
                pending_interaction,
                ..
            } => {
                let status = if *busy || *main_turn_active {
                    SessionStatus::Running
                } else {
                    SessionStatus::Idle
                };
                vec![ServerMessage::SessionState(self.session_state(
                    status,
                    Some(pending_interaction_of(pending_interaction)),
                    now,
                ))]
            }

            EngineEvent::SessionStatusChanged { status, .. } => {
                vec![ServerMessage::SessionState(self.session_state(
                    session_status_of(status),
                    None,
                    now,
                ))]
            }

            EngineEvent::LlmStepBegin { .. } => {
                // The other producer's step boundary: it only says a step begins,
                // and the ordinal has to stay ours.
                self.step_closed = true;
                Vec::new()
            }

            EngineEvent::LlmDelta { part, .. } => {
                self.begin_step();
                // A streamed argument fragment addresses the tool-call entity,
                // not the assistant text entity: without this arm the fragment
                // would project as an assistant delta with empty text.
                if part.get("type").and_then(Value::as_str) == Some("tool_call") {
                    let tool_call_id = part
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let input_text = part
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    vec![ServerMessage::ToolCallDelta(ToolCallDeltaMessage {
                        session_id: self.session_id.clone(),
                        agent_id: self.agent_id.clone(),
                        timestamp: now,
                        tool_call_id,
                        input_text,
                    })]
                } else {
                    let message_id = match part.get("type").and_then(Value::as_str) {
                        Some("thinking") => thinking_entity_id(self.turn, self.step),
                        _ => assistant_entity_id(self.turn, self.step),
                    };
                    let text = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    vec![ServerMessage::AssistantDelta(AssistantDeltaMessage {
                        session_id: self.session_id.clone(),
                        agent_id: self.agent_id.clone(),
                        timestamp: now,
                        message_id,
                        text,
                    })]
                }
            }

            EngineEvent::LlmStepEnd { .. } => {
                vec![ServerMessage::Step(self.step_snapshot(
                    StepStatus::Completed,
                    now,
                    None,
                ))]
            }

            // Host- and session-level state with no session-scoped entity of its
            // own: the hub's global lane owns these.
            EngineEvent::GoalBudgetLimitReached { .. }
            | EngineEvent::CronFired { .. }
            | EngineEvent::SessionMetaUpdated { .. }
            | EngineEvent::ConfigChanged { .. } => Vec::new(),

            EngineEvent::Custom(value) => self.translate_wire_event(value, now),
        }
    }

    /// The persisted wire vocabulary, which reaches the live lane as opaque JSON.
    fn translate_wire_event(&mut self, value: &Value, now: i64) -> Vec<ServerMessage> {
        match value.get("type").and_then(Value::as_str) {
            Some("message.user") => {
                // Without an open turn there is no turn number to name this
                // message after, and guessing one would put the message under an
                // id `turn.started` will never agree with.
                if self.turn == 0 {
                    return Vec::new();
                }
                let content = value
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                vec![ServerMessage::User(self.user_message(content, now))]
            }
            Some("message.assistant") => {
                if self.turn == 0 {
                    return Vec::new();
                }
                let content = value
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mut entities = Vec::new();
                if !content.is_empty() {
                    entities.push(ServerMessage::Assistant(AssistantMessage {
                        session_id: self.session_id.clone(),
                        agent_id: self.agent_id.clone(),
                        timestamp: now,
                        message_id: assistant_entity_id(self.turn, self.step.max(1)),
                        turn_id: turn_entity_id(self.turn),
                        step_id: step_entity_id(self.turn, self.step.max(1)),
                        status: StreamStatus::Completed,
                        text: content.to_string(),
                    }));
                }
                for call in value
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                {
                    let Some(tool_call_id) = call.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let name = call
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let mut entity =
                        self.tool_call(tool_call_id, &name, ToolCallStatus::Running, now);
                    entity.input = call.get("arguments").cloned();
                    entities.push(ServerMessage::ToolCall(entity));
                }
                entities
            }
            Some("tool.result") => {
                let Some(tool_call_id) = value.get("tool_call_id").and_then(Value::as_str) else {
                    return Vec::new();
                };
                let mut call = self.tool_call(tool_call_id, "", ToolCallStatus::Done, now);
                call.output = value.get("content").cloned();
                vec![ServerMessage::ToolCall(call)]
            }
            _ => Vec::new(),
        }
    }

    fn is_my_agent(&self, agent_id: &str) -> bool {
        agent_id == self.agent_id
    }

    fn open_turn(&mut self, turn: i64, now: i64) {
        self.turn = turn;
        self.step = 0;
        self.step_closed = false;
        self.started_at = Some(now);
    }

    /// Give the following text a step to belong to, opening one if the turn has
    /// none yet or the last one ended with a tool round.
    fn begin_step(&mut self) {
        if self.turn == 0 {
            return;
        }
        if self.step == 0 || self.step_closed {
            self.step += 1;
            self.step_closed = false;
        }
    }

    fn turn_snapshot(
        &self,
        status: TurnStatus,
        user_message_id: Option<String>,
        started_at: i64,
        ended_at: Option<i64>,
    ) -> TurnMessage {
        TurnMessage {
            session_id: self.session_id.clone(),
            agent_id: self.agent_id.clone(),
            timestamp: started_at,
            turn_id: turn_entity_id(self.turn),
            ordinal: self.turn,
            status,
            // The live events carry no origin; only the stored compaction turn is
            // known to be something other than a user turn.
            origin: TurnOrigin::User,
            user_message_id,
            attachment_ids: None,
            started_at: iso(started_at),
            ended_at: ended_at.and_then(iso),
            usage: None,
            duration_ms: ended_at.map(|end| (end - started_at).max(0)),
        }
    }

    fn step_snapshot(
        &self,
        status: StepStatus,
        now: i64,
        end_reason: Option<String>,
    ) -> StepMessage {
        StepMessage {
            session_id: self.session_id.clone(),
            agent_id: self.agent_id.clone(),
            timestamp: now,
            step_id: step_entity_id(self.turn, self.step),
            turn_id: turn_entity_id(self.turn),
            ordinal: self.step,
            status,
            started_at: None,
            ended_at: None,
            usage: None,
            finish_reason: None,
            timing: None,
            retry: None,
            end_reason,
            // The end message is the text the client already has as its own
            // entity; repeating it here would be a second source of truth.
            end_message: None,
        }
    }

    fn user_message(&self, content: &str, now: i64) -> UserMessage {
        UserMessage {
            session_id: self.session_id.clone(),
            agent_id: self.agent_id.clone(),
            message_id: user_entity_id(self.turn),
            turn_id: Some(turn_entity_id(self.turn)),
            status: UserMessageStatus::Read,
            timestamp: Some(now),
            text: vec![ContentPart {
                r#type: ContentPartType::Text,
                text: content.to_string(),
                meta: std::collections::HashMap::new(),
            }],
            attachment_ids: None,
            skill_activations: None,
            origin: None,
        }
    }

    fn tool_call(
        &self,
        tool_call_id: &str,
        name: &str,
        status: ToolCallStatus,
        now: i64,
    ) -> ToolCallMessage {
        ToolCallMessage {
            session_id: self.session_id.clone(),
            agent_id: self.agent_id.clone(),
            timestamp: now,
            tool_call_id: tool_call_id.to_string(),
            turn_id: turn_entity_id(self.turn),
            step_id: step_entity_id(self.turn, self.step.max(1)),
            name: name.to_string(),
            view: None,
            status,
            input: None,
            input_text: None,
            output: None,
            display: None,
            error: None,
            progress: None,
            task_id: None,
            approval_id: None,
            todo_id: None,
            agent_refs: None,
        }
    }

    /// A subagent's task. The fork's subagent events carry neither a task id nor a
    /// kind, so the child's own agent id keys the entity — stable, unique per
    /// subagent, and the identity the parent's tool call refers to.
    fn task(&self, agent_id: &str, status: TaskStatus, now: i64) -> TaskMessage {
        TaskMessage {
            session_id: self.session_id.clone(),
            agent_id: self.agent_id.clone(),
            timestamp: now,
            task_id: agent_id.to_string(),
            kind: TaskKind::Subagent,
            status,
            detached: true,
            description: None,
            child_agent_id: Some(agent_id.to_string()),
            output_tail: String::new(),
            started_at: iso(now),
            ended_at: None,
            result_summary: None,
            error: None,
            state_reason: None,
            usage: None,
            model: None,
            thinking_effort: None,
        }
    }

    fn session_state(
        &self,
        status: SessionStatus,
        pending_interaction: Option<PendingInteraction>,
        now: i64,
    ) -> SessionStateMessage {
        SessionStateMessage {
            session_id: self.session_id.clone(),
            timestamp: now,
            status,
            pending_interaction,
            model: None,
            thinking_effort: None,
            permission: None,
            usage: None,
            context_tokens: None,
            max_context_tokens: None,
            goal: None,
            modes: None,
        }
    }
}

fn parse_turn(turn_id: &str, fallback: i64) -> i64 {
    turn_id.parse().unwrap_or(fallback)
}

fn session_status_of(status: &str) -> SessionStatus {
    match status {
        "running" => SessionStatus::Running,
        "compacting" => SessionStatus::Compacting,
        _ => SessionStatus::Idle,
    }
}

fn pending_interaction_of(pending: &str) -> PendingInteraction {
    match pending {
        "approval" => PendingInteraction::Approval,
        "question" => PendingInteraction::Question,
        _ => PendingInteraction::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_700_000_000_000;

    fn ids(entities: &[ServerMessage]) -> Vec<String> {
        entities
            .iter()
            .map(|entity| match entity {
                ServerMessage::Turn(turn) => format!("turn:{}", turn.turn_id),
                ServerMessage::User(user) => format!("user:{}", user.message_id),
                ServerMessage::Step(step) => format!("step:{}", step.step_id),
                ServerMessage::Assistant(text) => format!("assistant:{}", text.message_id),
                ServerMessage::AssistantDelta(text) => {
                    format!("assistant.delta:{}", text.message_id)
                }
                ServerMessage::ThinkingDelta(text) => format!("thinking.delta:{}", text.message_id),
                ServerMessage::ToolCall(call) => format!("tool:{}", call.tool_call_id),
                ServerMessage::ToolCallDelta(call) => format!("tool.delta:{}", call.tool_call_id),
                ServerMessage::Task(task) => format!("task:{}", task.task_id),
                ServerMessage::SessionState(_) => "session.state".to_string(),
                other => panic!("unexpected entity {other:?}"),
            })
            .collect()
    }

    fn started(turn: u64, prompt: Option<&str>) -> EngineEvent {
        EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: turn,
            prompt: prompt.map(str::to_string),
        }
    }

    fn assistant_delta(turn: u64, text: &str) -> EngineEvent {
        EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: turn,
            delta: text.into(),
        }
    }

    #[test]
    fn a_turn_start_names_the_turn_and_its_user_message() {
        let mut translator = LiveTranslator::new("s1", "main");
        let entities = translator.translate(&started(3, Some("go")), NOW);

        assert_eq!(ids(&entities), ["turn:3", "user:3.user"]);
        let ServerMessage::Turn(turn) = &entities[0] else {
            panic!("expected a turn");
        };
        assert_eq!(turn.ordinal, 3);
        assert_eq!(turn.status, TurnStatus::Running);
        assert_eq!(turn.user_message_id.as_deref(), Some("3.user"));
        assert_eq!(turn.started_at.as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(translator.in_flight(), None, "no step is open yet");
    }

    #[test]
    fn deltas_share_one_step_and_report_it_as_the_live_position() {
        let mut translator = LiveTranslator::new("s1", "main");
        translator.translate(&started(3, None), NOW);

        let first = translator.translate(&assistant_delta(3, "he"), NOW);
        let second = translator.translate(&assistant_delta(3, "llo"), NOW + 5);

        assert_eq!(ids(&first), ["assistant.delta:3.1.assistant"]);
        assert_eq!(
            ids(&second),
            ["assistant.delta:3.1.assistant"],
            "a delta extends the step's message, it does not open a new one"
        );
        assert_eq!(
            translator.in_flight(),
            Some(HistoryInFlight {
                turn_id: "3".into(),
                step_id: "3.1".into(),
            })
        );
    }

    #[test]
    fn a_tool_round_closes_the_step_so_the_next_text_opens_a_new_one() {
        let mut translator = LiveTranslator::new("s1", "main");
        translator.translate(&started(3, None), NOW);
        translator.translate(&assistant_delta(3, "reading"), NOW);
        translator.translate(
            &EngineEvent::ToolCallStarted {
                agent_id: "main".into(),
                turn_id: 3,
                tool_call_id: "call-a".into(),
                name: "read".into(),
                args: json!({ "path": "a" }),
            },
            NOW,
        );

        let after = translator.translate(&assistant_delta(3, "done"), NOW);

        assert_eq!(ids(&after), ["assistant.delta:3.2.assistant"]);
        assert_eq!(translator.in_flight().unwrap().step_id, "3.2");
    }

    #[test]
    fn tool_calls_keep_the_providers_id_and_carry_their_state() {
        let mut translator = LiveTranslator::new("s1", "main");
        translator.translate(&started(3, None), NOW);

        let started_call = translator.translate(
            &EngineEvent::ToolCallStarted {
                agent_id: "main".into(),
                turn_id: 3,
                tool_call_id: "call-a".into(),
                name: "read".into(),
                args: json!({ "path": "a" }),
            },
            NOW,
        );
        let ServerMessage::ToolCall(call) = &started_call[0] else {
            panic!("expected a tool call");
        };
        assert_eq!(call.tool_call_id, "call-a");
        assert_eq!(call.status, ToolCallStatus::Running);
        assert_eq!(call.input, Some(json!({ "path": "a" })));
        assert_eq!(call.name, "read");

        let delta = translator.translate(
            &EngineEvent::ToolCallDelta {
                agent_id: "main".into(),
                turn_id: 3,
                tool_call_id: "call-a".into(),
                name: None,
                arguments_part: Some("{\"pa".into()),
            },
            NOW,
        );
        assert_eq!(ids(&delta), ["tool.delta:call-a"]);

        let done = translator.translate(
            &EngineEvent::ToolCallCompleted {
                agent_id: "main".into(),
                turn_id: 3,
                tool_call_id: "call-a".into(),
                result: json!("body"),
            },
            NOW,
        );
        let ServerMessage::ToolCall(call) = &done[0] else {
            panic!("expected a tool call");
        };
        assert_eq!(call.status, ToolCallStatus::Done);
        assert_eq!(call.output, Some(json!("body")));

        let failed = translator.translate(
            &EngineEvent::ToolCallFailed {
                agent_id: "main".into(),
                turn_id: 3,
                tool_call_id: "call-b".into(),
                error: "no such file".into(),
            },
            NOW,
        );
        let ServerMessage::ToolCall(call) = &failed[0] else {
            panic!("expected a tool call");
        };
        assert_eq!(call.status, ToolCallStatus::Error);
        assert_eq!(call.error.as_deref(), Some("no such file"));
    }

    #[test]
    fn a_turn_end_completes_the_turn_and_the_open_step() {
        let mut translator = LiveTranslator::new("s1", "main");
        translator.translate(&started(3, Some("go")), NOW);
        translator.translate(&assistant_delta(3, "answer"), NOW);

        let entities = translator.translate(
            &EngineEvent::TurnEnded {
                agent_id: "main".into(),
                turn_id: 3,
                reason: "completed".into(),
            },
            NOW + 2_500,
        );

        assert_eq!(ids(&entities), ["turn:3", "step:3.1"]);
        let ServerMessage::Turn(turn) = &entities[0] else {
            panic!("expected a turn");
        };
        assert_eq!(turn.status, TurnStatus::Completed);
        assert_eq!(turn.duration_ms, Some(2_500));
        assert_eq!(turn.ended_at.as_deref(), Some("2023-11-14T22:13:22.500Z"));
        let ServerMessage::Step(step) = &entities[1] else {
            panic!("expected a step");
        };
        assert_eq!(step.status, StepStatus::Completed);
        assert_eq!(step.end_reason.as_deref(), Some("completed"));
    }

    #[test]
    fn subagent_events_become_task_entities() {
        let mut translator = LiveTranslator::new("s1", "main");

        let spawned = translator.translate(
            &EngineEvent::SubagentSpawned {
                agent_id: "sub-1".into(),
                parent_agent_id: "main".into(),
                profile_name: "explore".into(),
            },
            NOW,
        );
        let ServerMessage::Task(task) = &spawned[0] else {
            panic!("expected a task");
        };
        assert_eq!(task.task_id, "sub-1");
        assert_eq!(task.kind, TaskKind::Subagent);
        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.child_agent_id.as_deref(), Some("sub-1"));
        assert_eq!(task.description.as_deref(), Some("explore"));

        let completed = translator.translate(
            &EngineEvent::SubagentCompleted {
                agent_id: "sub-1".into(),
                summary: "found it".into(),
            },
            NOW + 1_000,
        );
        let ServerMessage::Task(task) = &completed[0] else {
            panic!("expected a task");
        };
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.result_summary.as_deref(), Some("found it"));
        assert!(task.ended_at.is_some());

        let failed = translator.translate(
            &EngineEvent::SubagentFailed {
                agent_id: "sub-2".into(),
                error: "died".into(),
            },
            NOW,
        );
        let ServerMessage::Task(task) = &failed[0] else {
            panic!("expected a task");
        };
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.error.as_deref(), Some("died"));
    }

    #[test]
    fn another_agents_transcript_events_are_ignored() {
        let mut translator = LiveTranslator::new("s1", "main");
        let entities = translator.translate(
            &EngineEvent::AssistantDelta {
                agent_id: "sub-1".into(),
                turn_id: 3,
                delta: "not mine".into(),
            },
            NOW,
        );

        assert!(entities.is_empty());
        assert_eq!(translator.in_flight(), None);
    }

    #[test]
    fn session_work_changes_become_the_session_state_entity() {
        let mut translator = LiveTranslator::new("s1", "main");

        let busy = translator.translate(
            &EngineEvent::SessionWorkChanged {
                busy: true,
                main_turn_active: true,
                pending_interaction: "approval".into(),
                last_turn_reason: None,
            },
            NOW,
        );
        let ServerMessage::SessionState(state) = &busy[0] else {
            panic!("expected session state");
        };
        assert_eq!(state.status, SessionStatus::Running);
        assert_eq!(
            state.pending_interaction,
            Some(PendingInteraction::Approval)
        );

        let idle = translator.translate(
            &EngineEvent::SessionWorkChanged {
                busy: false,
                main_turn_active: false,
                pending_interaction: "none".into(),
                last_turn_reason: None,
            },
            NOW,
        );
        let ServerMessage::SessionState(state) = &idle[0] else {
            panic!("expected session state");
        };
        assert_eq!(state.status, SessionStatus::Idle);
        assert_eq!(state.pending_interaction, Some(PendingInteraction::None));

        let compacting = translator.translate(
            &EngineEvent::SessionStatusChanged {
                status: "compacting".into(),
                previous_status: "running".into(),
            },
            NOW,
        );
        let ServerMessage::SessionState(state) = &compacting[0] else {
            panic!("expected session state");
        };
        assert_eq!(state.status, SessionStatus::Compacting);
    }

    #[test]
    fn the_production_wire_events_fold_into_user_and_assistant_entities() {
        let mut translator = LiveTranslator::new("s1", "main");
        translator.translate(&started(3, None), NOW);

        let user = translator.translate(
            &EngineEvent::Custom(json!({ "type": "message.user", "content": "hi" })),
            NOW,
        );
        assert_eq!(ids(&user), ["user:3.user"]);

        let assistant = translator.translate(
            &EngineEvent::Custom(json!({
                "type": "message.assistant",
                "content": "answer",
                "tool_calls": [{ "id": "call-a", "name": "read", "arguments": { "path": "a" } }],
            })),
            NOW,
        );
        assert_eq!(ids(&assistant), ["assistant:3.1.assistant", "tool:call-a"]);

        let result = translator.translate(
            &EngineEvent::Custom(json!({
                "type": "tool.result",
                "content": "body",
                "tool_call_id": "call-a",
            })),
            NOW,
        );
        assert_eq!(ids(&result), ["tool:call-a"]);
    }

    #[test]
    fn a_wire_message_without_an_open_turn_is_dropped() {
        let mut translator = LiveTranslator::new("s1", "main");
        let entities = translator.translate(
            &EngineEvent::Custom(json!({ "type": "message.user", "content": "hi" })),
            NOW,
        );

        assert!(
            entities.is_empty(),
            "there is no turn number to name the message after"
        );
    }
}
