//! Native execution of the AskUserQuestion tool (reverse interaction
//! protocol, design doc step 6).
//!
//! The engine asks the host an interactive question and waits for a human
//! answer through [`crate::callbacks::HostCallbacks::ask_question`] (the
//! `host/ask_question` RPC). The host owns the interaction runtime (pending
//! key, dismiss, turn-end cancellation); this module only maps the tool
//! arguments to the wire request and the wire response to a tool result,
//! mirroring the v2 AskUserQuestion tool's output contract.

use std::collections::HashSet;

use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{
    AskQuestionItem, AskQuestionOption, AskQuestionRequest, AskQuestionResponse,
};
use crate::turn_loop::types::ExecutableToolResult;

/// v2 `QUESTION_DISMISSED_MESSAGE`: the note the model sees when the user
/// closed the question without answering.
const QUESTION_DISMISSED_MESSAGE: &str = "User dismissed the question without answering.";

/// v2 `QUESTION_UNSUPPORTED_FAILURE_MESSAGE`: returned when the connected
/// host does not implement the interactive-question seam. The model must
/// not retry the tool — it should ask the user directly in its text
/// response instead.
const QUESTION_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.";

/// Execute the AskUserQuestion tool natively: parse the tool arguments,
/// build an [`AskQuestionRequest`], wait for the host's answer, and map the
/// response to an [`ExecutableToolResult`] matching the v2 tool's output.
pub async fn execute_ask_user_question(
    callbacks: &dyn HostCallbacks,
    args: &Value,
) -> ExecutableToolResult {
    let Some(request) = parse_request(args) else {
        return err_result(
            "Invalid AskUserQuestion arguments: expected 1-4 questions, each with 2-4 options; question texts must be unique and option labels unique within each question."
                .into(),
        );
    };

    match callbacks.ask_question(request).await {
        Ok(response) => map_response(response),
        Err(error) => {
            // The trait default and the documented JSON-RPC error both carry
            // this phrase; anything else is a transient host failure, which
            // v2 maps to a dismissed result.
            if error.contains("does not support interactive questions") {
                err_result(QUESTION_UNSUPPORTED_FAILURE_MESSAGE.into())
            } else {
                dismissed_result()
            }
        }
    }
}

/// Parse the tool arguments into an [`AskQuestionRequest`]. `None` when the
/// shape violates the v2 contract: missing or empty `questions`, more than
/// 4 questions, fewer than 2 or more than 4 options per question, duplicate
/// question texts, or duplicate option labels within a question.
fn parse_request(args: &Value) -> Option<AskQuestionRequest> {
    let questions = args.get("questions")?.as_array()?;
    if questions.is_empty() || questions.len() > 4 {
        return None;
    }
    let mut items = Vec::with_capacity(questions.len());
    let mut seen_texts = HashSet::new();
    for q in questions {
        let question = q.get("question")?.as_str()?.to_string();
        if !seen_texts.insert(question.clone()) {
            return None;
        }
        let options = q.get("options")?.as_array()?;
        if options.len() < 2 || options.len() > 4 {
            return None;
        }
        let mut parsed_options = Vec::with_capacity(options.len());
        let mut seen_labels = HashSet::new();
        for o in options {
            let label = o.get("label")?.as_str()?.to_string();
            if !seen_labels.insert(label.clone()) {
                return None;
            }
            parsed_options.push(AskQuestionOption {
                label,
                description: o
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(str::to_string),
            });
        }
        items.push(AskQuestionItem {
            question,
            header: q.get("header").and_then(|h| h.as_str()).map(str::to_string),
            options: parsed_options,
            // v2 accepts the deprecated camelCase alias too.
            multi_select: q
                .get("multi_select")
                .or_else(|| q.get("multiSelect"))
                .and_then(|m| m.as_bool())
                .unwrap_or(false),
        });
    }
    Some(AskQuestionRequest {
        question_id: format!("question_{:016x}", fastrand::u64(..)),
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
        background: args
            .get("background")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        timeout_ms: None,
        questions: items,
    })
}

/// Map the host's answer to a tool result, mirroring the v2 tool's output
/// shapes: answered (`{"answers": {...}}`), dismissed (empty answers + note),
/// cancelled (error result), and — for `background: true` — the host's
/// verbatim pass-through of the v2 background task output (design doc 3.3).
fn map_response(response: AskQuestionResponse) -> ExecutableToolResult {
    if response.cancelled == Some(true) {
        let reason = response.reason.as_deref().unwrap_or("unknown");
        return err_result(format!(
            "The question was cancelled before the user answered (reason: {reason})."
        ));
    }
    if response.answers.is_empty() {
        // A dismissed question carries the v2 constant note (or none);
        // anything else in `note` is a background task's output the host
        // passed through verbatim.
        return match response.note.as_deref() {
            Some(note) if note != QUESTION_DISMISSED_MESSAGE => ok_result(note.to_string()),
            _ => dismissed_result(),
        };
    }
    ok_result(serde_json::json!({ "answers": response.answers }).to_string())
}

/// Engine tool definition for AskUserQuestion, so the model can discover
/// and call it (used by the standalone REPL and native tool listing). The
/// schema mirrors v2 `AskUserQuestionInputSchemaWithBackground`.
pub fn ask_user_question_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "ask_user_question".into(),
        description: "Ask the user questions with structured options during execution. Use it to collect user preferences, resolve ambiguous or underspecified instructions, or let the user decide between implementation approaches. Ask 1-4 questions at a time, each with 2-4 meaningful, distinct options; keep labels concise (1-5 words, append '(Recommended)' to a recommended option) and use descriptions for trade-offs. Users always have an 'Other' option — do not create one yourself. The result is JSON with an `answers` object keyed by question text (comma-separated labels for multi_select, or the user's own words for 'Other'); empty answers with a note means the user dismissed the question — do not treat that as selecting an option, and do not re-ask the same question. Set background=true when you can keep working without the answer: the host starts a background question task and returns a task_id immediately; the answer arrives automatically in a later turn — do not poll, sleep, or fabricate the answer.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 4,
                    "description": "The questions to ask the user (1-4 questions).",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "A specific, actionable question. End with '?'."
                            },
                            "header": {
                                "type": "string",
                                "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style')."
                            },
                            "options": {
                                "type": "array",
                                "minItems": 2,
                                "maxItems": 4,
                                "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                            "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'."
                                        },
                                        "description": {
                                            "type": "string",
                                            "description": "Brief explanation of trade-offs or implications."
                                        }
                                    },
                                    "required": ["label"]
                                }
                            },
                            "multi_select": {
                                "type": "boolean",
                                "description": "Whether the user can select multiple options."
                            },
                            "multiSelect": {
                                "type": "boolean",
                                "description": "Deprecated camelCase alias of multi_select; prefer multi_select."
                            }
                        },
                        "required": ["question", "options"]
                    }
                },
                "background": {
                    "type": "boolean",
                    "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending."
                }
            },
            "required": ["questions"]
        }),
    }
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

/// v2 `dismissedQuestionResult()`: `{"answers": {}, "note": ...}`.
fn dismissed_result() -> ExecutableToolResult {
    ok_result(
        serde_json::json!({
            "answers": {},
            "note": QUESTION_DISMISSED_MESSAGE,
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    /// Scripted callbacks: records the received request and answers with a
    /// canned response.
    struct ScriptedCallbacks {
        response: Result<AskQuestionResponse, String>,
        received: Arc<std::sync::Mutex<Option<AskQuestionRequest>>>,
    }

    impl HostCallbacks for ScriptedCallbacks {
        fn llm_chat(
            &self,
            _: crate::rpc::types::LlmChatRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
        {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: crate::rpc::types::ToolExecuteRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: crate::rpc::types::PermissionCheckRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async { Ok(crate::rpc::types::PermissionDecision::allow()) })
        }

        fn ask_question(
            &self,
            request: AskQuestionRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<AskQuestionResponse, String>> {
            *self.received.lock().unwrap() = Some(request);
            let response = self.response.clone();
            Box::pin(async move { response })
        }
    }

    fn scripted(
        response: Result<AskQuestionResponse, String>,
    ) -> (
        ScriptedCallbacks,
        Arc<std::sync::Mutex<Option<AskQuestionRequest>>>,
    ) {
        let received = Arc::new(std::sync::Mutex::new(None));
        (
            ScriptedCallbacks {
                response,
                received: received.clone(),
            },
            received,
        )
    }

    fn empty_response() -> AskQuestionResponse {
        AskQuestionResponse {
            answers: HashMap::new(),
            method: None,
            note: None,
            cancelled: None,
            reason: None,
        }
    }

    fn sample_args() -> Value {
        serde_json::json!({
            "questions": [
                {
                    "question": "Which approach should I take?",
                    "header": "Style",
                    "options": [
                        { "label": "Option A (Recommended)", "description": "Fast, less flexible" },
                        { "label": "Option B", "description": "Slower, more flexible" }
                    ],
                    "multi_select": false
                }
            ],
            "background": false,
            "turn_id": "turn-42",
            "tool_call_id": "call_abc"
        })
    }

    #[tokio::test]
    async fn test_request_parsing_builds_wire_request() {
        let (callbacks, received) = scripted(Ok(empty_response()));
        let result = execute_ask_user_question(&callbacks, &sample_args()).await;
        assert!(!result.is_error);
        let request = received.lock().unwrap().clone().expect("request recorded");
        assert!(request.question_id.starts_with("question_"));
        assert_eq!(request.turn_id, "turn-42");
        assert_eq!(request.tool_call_id, "call_abc");
        assert!(!request.background);
        assert_eq!(request.questions.len(), 1);
        let item = &request.questions[0];
        assert_eq!(item.question, "Which approach should I take?");
        assert_eq!(item.header.as_deref(), Some("Style"));
        assert_eq!(item.options.len(), 2);
        assert_eq!(item.options[0].label, "Option A (Recommended)");
        assert_eq!(
            item.options[0].description.as_deref(),
            Some("Fast, less flexible")
        );
        assert!(!item.multi_select);
    }

    #[tokio::test]
    async fn test_background_and_multi_select_are_forwarded() {
        let args = serde_json::json!({
            "questions": [
                {
                    "question": "Pick languages?",
                    "options": [
                        { "label": "Rust" },
                        { "label": "TypeScript" }
                    ],
                    "multi_select": true
                }
            ],
            "background": true
        });
        let (callbacks, received) = scripted(Ok(empty_response()));
        let _ = execute_ask_user_question(&callbacks, &args).await;
        let request = received.lock().unwrap().clone().unwrap();
        assert!(request.background);
        assert!(request.questions[0].multi_select);
        assert!(request.questions[0].header.is_none());
        assert!(request.questions[0].options[1].description.is_none());
        assert_eq!(request.turn_id, "");
        assert_eq!(request.tool_call_id, "");
    }

    #[tokio::test]
    async fn test_invalid_args_return_error_without_calling_host() {
        let (callbacks, received) = scripted(Ok(empty_response()));
        for bad in [
            serde_json::json!({ "questions": [] }),
            serde_json::json!({}),
            serde_json::json!({ "questions": [{ "question": "q", "options": [{ "label": "a" }] }] }),
            serde_json::json!({
                "questions": [
                    { "question": "q", "options": [{ "label": "a" }, { "label": "b" }] },
                    { "question": "q", "options": [{ "label": "c" }, { "label": "d" }] }
                ]
            }),
            serde_json::json!({
                "questions": [
                    { "question": "q", "options": [{ "label": "a" }, { "label": "a" }] }
                ]
            }),
        ] {
            let result = execute_ask_user_question(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid AskUserQuestion arguments"));
        }
        assert!(
            received.lock().unwrap().is_none(),
            "invalid args must not reach the host"
        );
    }

    #[tokio::test]
    async fn test_answered_response_formats_answers() {
        let mut answers = HashMap::new();
        answers.insert(
            "Which approach should I take?".to_string(),
            "Option A (Recommended)".to_string(),
        );
        let (callbacks, _) = scripted(Ok(AskQuestionResponse {
            answers,
            method: Some("enter".into()),
            note: None,
            cancelled: None,
            reason: None,
        }));
        let result = execute_ask_user_question(&callbacks, &sample_args()).await;
        assert!(!result.is_error);
        let parsed: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(
            parsed["answers"]["Which approach should I take?"],
            "Option A (Recommended)"
        );
    }

    #[tokio::test]
    async fn test_dismissed_response_notes_no_answer() {
        let (callbacks, _) = scripted(Ok(AskQuestionResponse {
            answers: HashMap::new(),
            method: None,
            note: Some(QUESTION_DISMISSED_MESSAGE.into()),
            cancelled: None,
            reason: None,
        }));
        let result = execute_ask_user_question(&callbacks, &sample_args()).await;
        assert!(!result.is_error);
        let parsed: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(parsed["answers"], serde_json::json!({}));
        assert_eq!(parsed["note"], QUESTION_DISMISSED_MESSAGE);
    }

    #[tokio::test]
    async fn test_cancelled_response_is_error() {
        let (callbacks, _) = scripted(Ok(AskQuestionResponse {
            answers: HashMap::new(),
            method: None,
            note: None,
            cancelled: Some(true),
            reason: Some("turn_ended".into()),
        }));
        let result = execute_ask_user_question(&callbacks, &sample_args()).await;
        assert!(result.is_error);
        assert!(result.content.contains("cancelled"));
        assert!(result.content.contains("turn_ended"));
    }

    #[tokio::test]
    async fn test_background_output_passes_through_verbatim() {
        // Design doc 3.3: for background=true the host registers a task and
        // passes the v2 background output through verbatim (in `note`).
        let (callbacks, _) = scripted(Ok(AskQuestionResponse {
            answers: HashMap::new(),
            method: None,
            note: Some(
                "task_id: question_abc\ndescription: Which approach should I take?\nstatus: running\nautomatic_notification: true".into(),
            ),
            cancelled: None,
            reason: None,
        }));
        let result = execute_ask_user_question(&callbacks, &sample_args()).await;
        assert!(!result.is_error);
        assert!(result.content.contains("task_id: question_abc"));
        assert!(result.content.contains("status: running"));
    }

    #[tokio::test]
    async fn test_unsupported_host_returns_failure_message() {
        let (callbacks, _) = scripted(Err("host does not support interactive questions".into()));
        let result = execute_ask_user_question(&callbacks, &sample_args()).await;
        assert!(result.is_error);
        assert_eq!(result.content, QUESTION_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_other_host_error_maps_to_dismissed() {
        let (callbacks, _) = scripted(Err("connection reset".into()));
        let result = execute_ask_user_question(&callbacks, &sample_args()).await;
        assert!(!result.is_error);
        assert!(result.content.contains("dismissed"));
    }

    #[test]
    fn test_tool_def_matches_v2_schema() {
        let def = ask_user_question_tool_def();
        assert_eq!(def.name, "ask_user_question");
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["required"][0], "questions");
        assert!(def.input_schema["properties"]["questions"].is_object());
        assert!(def.input_schema["properties"]["background"].is_object());
        assert!(def.description.contains("background=true"));
    }
}
