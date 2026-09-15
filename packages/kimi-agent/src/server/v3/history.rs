//! Paging for the history route.
//!
//! Upstream serves history and the live stream through one entity vocabulary, so
//! a page is measured in *turns*, never split inside one: a client that paged
//! into the middle of a turn would have to reassemble a step's thinking, text and
//! tool calls from two responses. `paginate_history` therefore slices on turn
//! entity boundaries, exactly as upstream's `paginateHistory` does.
//!
//! Three cursors, mutually exclusive in pairs the route validates:
//!
//! - no cursor — the newest `page_size` turns, the shape a client opens with;
//! - `before_turn` — the `page_size` turns older than that turn, excluding the
//!   cursor turn itself, which the client already has;
//! - `after_step` — everything newer than the last entity carrying that step id,
//!   which is how a reconnecting client catches up without refetching.
//!
//! The route advertises `page_size` as "default 200, max 500" while the service
//! it calls defaults to 50 and clamps to 200; the numbers below follow the code.
//! An unknown cursor is not an error — it means the client is already current —
//! so it answers with an empty page.
//!
//! History answers with a ten-variant subset of the wire vocabulary (turn, step,
//! user, assistant, thinking, tool_call, system, interaction, task, todo), so a
//! cursor can only ever name an entity the fold actually produces: the delta
//! variants are live-only and carry no step id to match on.

use serde::Serialize;

use super::messages::ServerMessage;

/// Turns returned when the client asks for no particular size.
pub const DEFAULT_PAGE_SIZE: usize = 50;

/// Upper bound on turns per page, whatever the client asks for.
pub const MAX_PAGE_SIZE: usize = 200;

/// The parsed query of a history request. `agent_id` selects whose timeline to
/// read and does not affect paging.
#[derive(Debug, Clone, Default)]
pub struct HistoryQuery {
    pub before_turn: Option<String>,
    pub after_step: Option<String>,
    pub page_size: Option<usize>,
    pub agent_id: Option<String>,
}

/// One page of a timeline, borrowed from the folded history.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryPage<'a> {
    pub messages: &'a [ServerMessage],
    pub has_more: bool,
}

/// Where a live session's streaming has reached, as entity ids: the client uses
/// them to place the deltas that follow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryInFlight {
    pub turn_id: String,
    pub step_id: String,
}

/// The route's response body: the page, plus where a live session's streaming has
/// reached. Borrowed, so answering a request does not copy the page.
#[derive(Debug, Serialize)]
pub struct HistoryResponse<'a> {
    pub messages: &'a [ServerMessage],
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_flight: Option<HistoryInFlight>,
}

/// Slice one page out of a time-ordered timeline.
pub fn paginate_history<'a>(
    messages: &'a [ServerMessage],
    query: &HistoryQuery,
) -> HistoryPage<'a> {
    let page_size = query
        .page_size
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);

    if let Some(before_turn) = &query.before_turn {
        let Some(cursor) = messages
            .iter()
            .position(|message| is_turn(message, before_turn))
        else {
            return empty();
        };
        let anchors = turn_anchors(&messages[..cursor]);
        let start = anchors
            .len()
            .checked_sub(page_size)
            .and_then(|index| anchors.get(index).copied())
            .unwrap_or(0);
        return HistoryPage {
            messages: &messages[start..cursor],
            has_more: anchors.len() > page_size,
        };
    }

    if let Some(after_step) = &query.after_step {
        // The last match wins: a reconnect cursor names the newest position the
        // client has seen, and upstream searches backwards for the same reason.
        let Some(index) = messages
            .iter()
            .rposition(|message| step_of(message) == Some(after_step.as_str()))
        else {
            return empty();
        };
        let start = index + 1;
        let end = messages.len().min(start + page_size);
        return HistoryPage {
            messages: &messages[start..end],
            has_more: end < messages.len(),
        };
    }

    let anchors = turn_anchors(messages);
    let start = anchors
        .len()
        .checked_sub(page_size)
        .and_then(|index| anchors.get(index).copied())
        .unwrap_or(0);
    HistoryPage {
        messages: &messages[start..],
        has_more: anchors.len() > page_size,
    }
}

fn empty() -> HistoryPage<'static> {
    HistoryPage {
        messages: &[],
        has_more: false,
    }
}

fn turn_anchors(messages: &[ServerMessage]) -> Vec<usize> {
    messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| matches!(message, ServerMessage::Turn(_)).then_some(index))
        .collect()
}

fn is_turn(message: &ServerMessage, turn_id: &str) -> bool {
    matches!(message, ServerMessage::Turn(turn) if turn.turn_id == turn_id)
}

fn step_of(message: &ServerMessage) -> Option<&str> {
    match message {
        ServerMessage::Step(step) => Some(step.step_id.as_str()),
        ServerMessage::Assistant(text) => Some(text.step_id.as_str()),
        ServerMessage::Thinking(text) => Some(text.step_id.as_str()),
        ServerMessage::ToolCall(call) => Some(call.step_id.as_str()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::v3::messages::{
        AssistantMessage, StepMessage, StepStatus, StreamStatus, TurnMessage, TurnOrigin,
        TurnStatus, UserMessage, UserMessageStatus,
    };

    /// Three turns of three entities each, the minimum that can show whether a
    /// page cut a turn in half.
    fn timeline() -> Vec<ServerMessage> {
        (1..=3i64)
            .flat_map(|number| {
                [
                    ServerMessage::Turn(TurnMessage {
                        session_id: "s1".into(),
                        agent_id: "main".into(),
                        timestamp: number,
                        turn_id: number.to_string(),
                        ordinal: number,
                        status: TurnStatus::Completed,
                        origin: TurnOrigin::User,
                        user_message_id: Some(format!("{number}.user")),
                        attachment_ids: None,
                        started_at: None,
                        ended_at: None,
                        usage: None,
                        duration_ms: None,
                    }),
                    ServerMessage::User(UserMessage {
                        session_id: "s1".into(),
                        agent_id: "main".into(),
                        message_id: format!("{number}.user"),
                        turn_id: Some(number.to_string()),
                        status: UserMessageStatus::Read,
                        timestamp: Some(number),
                        text: Vec::new(),
                        attachment_ids: None,
                        skill_activations: None,
                        origin: None,
                    }),
                    ServerMessage::Assistant(AssistantMessage {
                        session_id: "s1".into(),
                        agent_id: "main".into(),
                        timestamp: number,
                        message_id: format!("{number}.1.assistant"),
                        turn_id: number.to_string(),
                        step_id: format!("{number}.1"),
                        status: StreamStatus::Completed,
                        text: format!("answer {number}"),
                    }),
                ]
            })
            .collect()
    }

    fn ids(page: &HistoryPage<'_>) -> Vec<String> {
        page.messages
            .iter()
            .map(|message| match message {
                ServerMessage::Turn(turn) => format!("turn:{}", turn.turn_id),
                ServerMessage::User(user) => format!("user:{}", user.message_id),
                ServerMessage::Assistant(text) => format!("assistant:{}", text.message_id),
                other => panic!("unexpected entity {other:?}"),
            })
            .collect()
    }

    fn query(
        before_turn: Option<&str>,
        after_step: Option<&str>,
        page_size: Option<usize>,
    ) -> HistoryQuery {
        HistoryQuery {
            before_turn: before_turn.map(str::to_string),
            after_step: after_step.map(str::to_string),
            page_size,
            agent_id: None,
        }
    }

    #[test]
    fn the_default_page_returns_the_newest_turns_whole() {
        let all = timeline();

        let page = paginate_history(&all, &query(None, None, Some(2)));
        assert_eq!(
            ids(&page),
            [
                "turn:2",
                "user:2.user",
                "assistant:2.1.assistant",
                "turn:3",
                "user:3.user",
                "assistant:3.1.assistant",
            ]
        );
        assert!(page.has_more);

        let page = paginate_history(&all, &query(None, None, Some(3)));
        assert_eq!(page.messages.len(), 9);
        assert!(!page.has_more, "the whole timeline fits");
    }

    #[test]
    fn before_turn_pages_older_and_leaves_out_the_cursor_turn() {
        let all = timeline();

        let page = paginate_history(&all, &query(Some("3"), None, Some(1)));
        assert_eq!(
            ids(&page),
            ["turn:2", "user:2.user", "assistant:2.1.assistant"]
        );
        assert!(page.has_more, "turn 1 is still older than this page");

        let page = paginate_history(&all, &query(Some("3"), None, Some(2)));
        assert_eq!(page.messages.len(), 6);
        assert!(!page.has_more);
        assert!(
            !ids(&page).contains(&"turn:3".to_string()),
            "the client already has the turn it paged from"
        );
    }

    #[test]
    fn an_unknown_cursor_is_an_empty_page_not_an_error() {
        let all = timeline();
        let page = paginate_history(&all, &query(Some("99"), None, None));
        assert!(page.messages.is_empty());
        assert!(!page.has_more);

        let page = paginate_history(&all, &query(None, Some("9.9"), None));
        assert!(page.messages.is_empty());
        assert!(!page.has_more);
    }

    #[test]
    fn after_step_returns_what_follows_the_cursor() {
        let all = timeline();

        let page = paginate_history(&all, &query(None, Some("1.1"), Some(2)));
        assert_eq!(
            ids(&page),
            ["turn:2", "user:2.user"],
            "paging resumes right after the entity carrying the step id"
        );
        assert!(page.has_more);

        let page = paginate_history(&all, &query(None, Some("3.1"), None));
        assert!(page.messages.is_empty());
        assert!(!page.has_more, "nothing newer than the last step");
    }

    #[test]
    fn page_size_is_clamped_into_range() {
        let all = timeline();

        let page = paginate_history(&all, &query(None, None, Some(0)));
        assert_eq!(
            page.messages.len(),
            3,
            "zero means one turn, not all of them"
        );
        assert!(page.has_more);

        let page = paginate_history(&all, &query(None, None, Some(10_000)));
        assert_eq!(page.messages.len(), 9);
        assert!(!page.has_more);
    }

    #[test]
    fn a_step_entity_anchors_paging_too() {
        let mut all = timeline();
        all.insert(
            3,
            ServerMessage::Step(StepMessage {
                session_id: "s1".into(),
                agent_id: "main".into(),
                timestamp: 1,
                step_id: "1.1".into(),
                turn_id: "1".into(),
                ordinal: 1,
                status: StepStatus::Completed,
                started_at: None,
                ended_at: None,
                usage: None,
                finish_reason: None,
                timing: None,
                retry: None,
                end_reason: None,
                end_message: None,
            }),
        );

        let page = paginate_history(&all, &query(None, Some("1.1"), Some(1)));
        assert_eq!(ids(&page), ["turn:2"]);
        assert!(page.has_more);
    }
}
