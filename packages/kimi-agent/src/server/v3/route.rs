//! The history route's request and response shapes.
//!
//! Upstream decides these in its route schema; the parts that need no request
//! live here so they can be tested on their own.
//!
//! Unlike every other route in this server, this one does not negotiate an
//! envelope: upstream always answers with one, and a bare body would be no more
//! useful when the payload is v3 entities only a v3-aware client can read. Errors
//! keep upstream's codes, but carry a real HTTP status where upstream replies
//! `200` and puts the whole failure in `code`.

use serde_json::{Value, json};

use crate::server::envelope::{err_envelope, error_codes};

use super::history::{HistoryInFlight, HistoryPage, HistoryQuery, HistoryResponse};

/// Upstream's route schema accepts a page size up to 500 and the service it calls
/// clamps to 200, so the accepted range is wider than the honoured one.
pub const MAX_REQUEST_PAGE_SIZE: usize = 500;

/// One rejected field, in the shape upstream puts in the envelope's `details`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub path: &'static str,
    pub message: String,
}

impl ValidationIssue {
    fn new(path: &'static str, message: impl Into<String>) -> Self {
        Self {
            path,
            message: message.into(),
        }
    }

    /// The error envelope, with the `details` array upstream pairs with
    /// `VALIDATION_FAILED` — the fork's `err_envelope` has no slot for it.
    pub fn envelope(&self, request_id: &str) -> Value {
        let mut envelope = err_envelope(error_codes::VALIDATION_FAILED, &self.message, request_id);
        envelope["details"] = json!([{ "path": self.path, "message": self.message.clone() }]);
        envelope
    }
}

/// Read the query of a history request.
///
/// `before_turn` and `after_step` are two cursors into one timeline, so asking
/// for both is a client bug rather than a request to merge. `agent_id` names a
/// single agent's timeline and may not look like a path: upstream rejects
/// separators and the traversal segments outright, and a present-but-empty value
/// fails its minimum length instead of reading as absent.
pub fn parse_query(
    param: impl Fn(&str) -> Option<String>,
) -> Result<HistoryQuery, ValidationIssue> {
    let before_turn = non_empty(&param, "before_turn")?;
    let after_step = non_empty(&param, "after_step")?;
    if before_turn.is_some() && after_step.is_some() {
        return Err(ValidationIssue::new(
            "before_turn",
            "before_turn and after_step are mutually exclusive",
        ));
    }

    let agent_id = non_empty(&param, "agent_id")?;
    if let Some(agent_id) = &agent_id
        && !is_plain_agent_id(agent_id)
    {
        return Err(ValidationIssue::new(
            "agent_id",
            "agent_id must be a plain agent id (no path separators)",
        ));
    }

    let page_size = match non_empty(&param, "page_size")? {
        Some(raw) => Some(
            raw.parse::<usize>()
                .ok()
                .filter(|size| (1..=MAX_REQUEST_PAGE_SIZE).contains(size))
                .ok_or_else(|| {
                    ValidationIssue::new(
                        "page_size",
                        format!(
                            "page_size must be an integer between 1 and {MAX_REQUEST_PAGE_SIZE}"
                        ),
                    )
                })?,
        ),
        None => None,
    };

    Ok(HistoryQuery {
        before_turn,
        after_step,
        page_size,
        agent_id,
    })
}

fn non_empty(
    param: &impl Fn(&str) -> Option<String>,
    name: &'static str,
) -> Result<Option<String>, ValidationIssue> {
    match param(name) {
        None => Ok(None),
        Some(value) if value.is_empty() => Err(ValidationIssue::new(
            name,
            format!("{name} must not be empty"),
        )),
        Some(value) => Ok(Some(value)),
    }
}

fn is_plain_agent_id(agent_id: &str) -> bool {
    !agent_id.contains(['/', '\\']) && agent_id != "." && agent_id != ".."
}

/// The envelope `data` for a page.
pub fn response_data(
    page: &HistoryPage<'_>,
    in_flight: Option<HistoryInFlight>,
) -> Result<Value, serde_json::Error> {
    serde_json::to_value(HistoryResponse {
        messages: page.messages,
        has_more: page.has_more,
        in_flight,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn params(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    #[test]
    fn a_full_query_parses() {
        let query = parse_query(params(&[
            ("before_turn", "7"),
            ("agent_id", "sub-1"),
            ("page_size", "500"),
        ]))
        .expect("valid");

        assert_eq!(query.before_turn.as_deref(), Some("7"));
        assert_eq!(query.agent_id.as_deref(), Some("sub-1"));
        assert_eq!(query.page_size, Some(500));
        assert_eq!(query.after_step, None);
    }

    #[test]
    fn an_empty_query_asks_for_the_newest_page() {
        let query = parse_query(params(&[])).expect("valid");
        assert_eq!(query.before_turn, None);
        assert_eq!(query.after_step, None);
        assert_eq!(query.page_size, None);
        assert_eq!(query.agent_id, None);
    }

    #[test]
    fn the_two_cursors_are_mutually_exclusive() {
        let issue = parse_query(params(&[("before_turn", "7"), ("after_step", "7.1")]))
            .expect_err("two cursors");
        assert_eq!(issue.path, "before_turn");
    }

    #[test]
    fn agent_ids_that_look_like_paths_are_rejected() {
        for agent_id in ["a/b", "a\\b", ".", "..", ""] {
            let issue =
                parse_query(params(&[("agent_id", agent_id)])).expect_err("path-like agent id");
            assert_eq!(issue.path, "agent_id", "{agent_id}");
        }
    }

    #[test]
    fn page_size_outside_the_accepted_range_is_rejected() {
        for page_size in ["0", "501", "abc", "2.5", "-1"] {
            let issue = parse_query(params(&[("page_size", page_size)])).expect_err("out of range");
            assert_eq!(issue.path, "page_size", "{page_size}");
        }
        for page_size in ["1", "200", "500"] {
            assert!(parse_query(params(&[("page_size", page_size)])).is_ok());
        }
    }

    #[test]
    fn a_rejected_field_keeps_upstreams_code_and_details() {
        let issue = parse_query(params(&[("page_size", "0")])).expect_err("out of range");
        let envelope = issue.envelope("req-1");

        assert_eq!(envelope["code"], error_codes::VALIDATION_FAILED);
        assert_eq!(envelope["request_id"], "req-1");
        assert!(envelope["data"].is_null());
        assert_eq!(envelope["details"][0]["path"], "page_size");
    }

    #[test]
    fn the_payload_only_carries_the_live_position_when_there_is_one() {
        let empty: Vec<super::super::messages::ServerMessage> = Vec::new();
        let page = HistoryPage {
            messages: &empty,
            has_more: false,
        };

        let data = response_data(&page, None).expect("serializes");
        assert_eq!(data["has_more"], false);
        assert!(
            data.get("in_flight").is_none(),
            "an idle session must not claim a streaming position"
        );

        let in_flight = HistoryInFlight {
            turn_id: "3".into(),
            step_id: "3.1".into(),
        };
        let data = response_data(&page, Some(in_flight)).expect("serializes");
        assert_eq!(data["in_flight"]["turn_id"], "3");
        assert_eq!(data["in_flight"]["step_id"], "3.1");
    }
}
