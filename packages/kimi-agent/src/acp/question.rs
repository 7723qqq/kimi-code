//! Ask-user question mapping for the ACP bridge.
//!
//! Ported from the retired `agent-core-v2` `acp-server/src/question.ts`.
//! Questions reach a form-capable client through `elicitation/create` and
//! everyone else through `session/request_permission` (the `q{n}_*` option-id
//! namespace). Both are pure mappers so the round-trip stays unit-testable.

use serde_json::{Map, Value, json};

use crate::rpc::types::AskQuestionItem;

fn option_id(question_index: usize, option_index: usize) -> String {
    format!("q{question_index}_opt_{option_index}")
}

fn skip_option_id(question_index: usize) -> String {
    format!("q{question_index}_skip")
}

/// One `allow_once` option per question option plus a trailing `reject_once`
/// "Skip" (v2 `questionItemToPermissionOptions`).
pub fn question_item_to_permission_options(
    question: &AskQuestionItem,
    question_index: usize,
) -> Vec<Value> {
    let mut options: Vec<Value> = question
        .options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            json!({
                "optionId": option_id(question_index, index),
                "name": option.label,
                "kind": "allow_once",
            })
        })
        .collect();
    options.push(json!({
        "optionId": skip_option_id(question_index),
        "name": "Skip",
        "kind": "reject_once",
    }));
    options
}

/// Reverse-map a `session/request_permission` response into one answer; `None`
/// when the user dismissed (skip / cancel) or selected an unknown option
/// (v2 `outcomeToQuestionAnswer`).
pub fn outcome_to_question_answer(question: &AskQuestionItem, response: &Value) -> Option<Value> {
    let outcome = response.get("outcome")?;
    if outcome.get("outcome").and_then(Value::as_str) == Some("cancelled") {
        return None;
    }
    let id = outcome.get("optionId").and_then(Value::as_str)?;
    if id == skip_option_id(0) {
        return None;
    }
    let index: usize = id.strip_prefix("q0_opt_")?.parse().ok()?;
    let selected = question.options.get(index)?;
    Some(json!({ &question.question: selected.label }))
}

fn enum_options(question: &AskQuestionItem) -> Vec<Value> {
    question
        .options
        .iter()
        .map(|option| {
            let mut entry = json!({ "const": option.label, "title": option.label });
            if let Some(description) = option.description.as_deref() {
                entry["description"] = json!(description);
            }
            entry
        })
        .collect()
}

/// Map the question set into an `elicitation/create` form request (v2
/// `questionRequestToElicitationParams`): single-select → `string` + `oneOf`,
/// multi-select → `array` + `items.anyOf`.
pub fn question_request_to_elicitation_params(
    questions: &[AskQuestionItem],
    session_id: &str,
    tool_call_id: &str,
) -> Value {
    let mut properties = Map::new();
    let mut required: Vec<Value> = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let key = format!("q{index}");
        required.push(json!(key));
        let title = question
            .header
            .clone()
            .unwrap_or_else(|| question.question.clone());
        let options = enum_options(question);
        let schema = if question.multi_select {
            json!({
                "type": "array",
                "title": title,
                "minItems": 1,
                "items": { "anyOf": options },
            })
        } else {
            json!({
                "type": "string",
                "title": title,
                "oneOf": options,
            })
        };
        properties.insert(key, schema);
    }
    json!({
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "mode": "form",
        "message": questions
            .iter()
            .map(|question| question.question.clone())
            .collect::<Vec<_>>()
            .join("\n"),
        "requestedSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    })
}

/// Reverse-map an `elicitation/create` response into answers; `None` for a
/// decline / cancel / empty accept. Multi-select joins with `', '` in declared
/// option order (v2 `elicitationResponseToQuestionAnswers`).
pub fn elicitation_response_to_question_answers(
    questions: &[AskQuestionItem],
    response: &Value,
) -> Option<Value> {
    if response.get("action").and_then(Value::as_str) != Some("accept") {
        return None;
    }
    let content = response.get("content").and_then(Value::as_object)?;
    let mut answers = Map::new();
    for (index, question) in questions.iter().enumerate() {
        let Some(value) = content.get(&format!("q{index}")) else {
            continue;
        };
        if question.multi_select {
            let Some(values) = value.as_array() else {
                continue;
            };
            let picked: Vec<String> = question
                .options
                .iter()
                .filter(|option| {
                    values
                        .iter()
                        .any(|item| item.as_str() == Some(option.label.as_str()))
                })
                .map(|option| option.label.clone())
                .collect();
            if !picked.is_empty() {
                answers.insert(question.question.clone(), json!(picked.join(", ")));
            }
        } else if let Some(selected) = value.as_str()
            && question
                .options
                .iter()
                .any(|option| option.label == selected)
        {
            answers.insert(question.question.clone(), json!(selected));
        }
    }
    if answers.is_empty() {
        None
    } else {
        Some(Value::Object(answers))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::AskQuestionOption;

    fn question(multi_select: bool) -> AskQuestionItem {
        AskQuestionItem {
            question: "Which approach?".into(),
            header: Some("Approach".into()),
            options: vec![
                AskQuestionOption {
                    label: "Fast".into(),
                    description: Some("quick".into()),
                },
                AskQuestionOption {
                    label: "Safe".into(),
                    description: None,
                },
            ],
            multi_select,
        }
    }

    #[test]
    fn permission_options_and_outcome_mapping() {
        let item = question(false);
        let options = question_item_to_permission_options(&item, 0);
        assert_eq!(options[0]["optionId"], "q0_opt_0");
        assert_eq!(options[2]["kind"], "reject_once");

        let selected = json!({ "outcome": { "outcome": "selected", "optionId": "q0_opt_1" } });
        assert_eq!(
            outcome_to_question_answer(&item, &selected),
            Some(json!({ "Which approach?": "Safe" }))
        );
        let skip = json!({ "outcome": { "outcome": "selected", "optionId": "q0_skip" } });
        assert!(outcome_to_question_answer(&item, &skip).is_none());
        let cancelled = json!({ "outcome": { "outcome": "cancelled" } });
        assert!(outcome_to_question_answer(&item, &cancelled).is_none());
    }

    #[test]
    fn elicitation_form_and_response_mapping() {
        let item = question(false);
        let params =
            question_request_to_elicitation_params(std::slice::from_ref(&item), "s1", "c1");
        assert_eq!(params["mode"], "form");
        assert_eq!(
            params["requestedSchema"]["properties"]["q0"]["type"],
            "string"
        );
        assert_eq!(params["requestedSchema"]["required"][0], "q0");

        let accepted = json!({ "action": "accept", "content": { "q0": "Fast" } });
        assert_eq!(
            elicitation_response_to_question_answers(std::slice::from_ref(&item), &accepted),
            Some(json!({ "Which approach?": "Fast" }))
        );
        assert!(
            elicitation_response_to_question_answers(
                std::slice::from_ref(&item),
                &json!({ "action": "decline" })
            )
            .is_none()
        );
        assert!(
            elicitation_response_to_question_answers(
                &[item],
                &json!({ "action": "accept", "content": { "q0": "Bogus" } })
            )
            .is_none()
        );
    }

    #[test]
    fn multi_select_joins_in_declared_order() {
        let item = question(true);
        let params =
            question_request_to_elicitation_params(std::slice::from_ref(&item), "s1", "c1");
        assert_eq!(
            params["requestedSchema"]["properties"]["q0"]["type"],
            "array"
        );
        let response = json!({ "action": "accept", "content": { "q0": ["Safe", "Fast"] } });
        assert_eq!(
            elicitation_response_to_question_answers(&[item], &response),
            Some(json!({ "Which approach?": "Fast, Safe" }))
        );
    }
}
