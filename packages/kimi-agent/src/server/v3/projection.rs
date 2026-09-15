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

use crate::rpc::types::{ContentBlock, TokenUsage};
use crate::session::sqlite_store::{COMPACT_TURN_ID, StoredMessage, TurnRecord};
use crate::turn_loop::types::LLMMessage;

use super::messages::{
    AssistantMessage, ContentPart, ContentPartType, ServerMessage, StepMessage, StepStatus,
    StreamStatus, ThinkingMessage, ToolCallMessage, ToolCallStatus, TurnMessage, TurnOrigin,
    TurnStatus, TurnUsage, UserMessage, UserMessageStatus,
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
            origin: match record.map(|r| r.turn_id.as_str()) {
                Some(COMPACT_TURN_ID) => TurnOrigin::Compaction,
                _ => TurnOrigin::User,
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

                for block in &stored.message.blocks {
                    if let ContentBlock::Think { think, .. } = block
                        && !think.is_empty()
                    {
                        out.push(ServerMessage::Thinking(ThinkingMessage {
                            session_id: session_id.to_string(),
                            agent_id: agent_id.to_string(),
                            timestamp: context.timestamp,
                            message_id: thinking_entity_id(context.number, step_ordinal),
                            turn_id: turn_entity_id(context.number),
                            step_id: step_entity_id(context.number, step_ordinal),
                            status: StreamStatus::Completed,
                            text: think.clone(),
                        }));
                    }
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

    if message.blocks.is_empty() {
        return (!message.content.is_empty())
            .then(|| part(ContentPartType::Text, message.content.clone()))
            .into_iter()
            .collect();
    }

    message
        .blocks
        .iter()
        .map(|block| match block {
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
        })
        .collect()
}

/// Upstream's timestamps are ISO strings; the store keeps milliseconds.
fn iso(ms: i64) -> Option<String> {
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
}
