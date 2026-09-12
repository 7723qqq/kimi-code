//! Web-facing event aliases — the translation seam between the engine's
//! internal event names (the TUI/napi transcript contract, which must not
//! move) and the kimi-web WS vocabulary (`event.tool.*`, mappers.ts).
//!
//! [`web_event_aliases`] is applied where engine events reach the server's
//! event bus (see `CountingCallbacks::emit_event`): every alias is published
//! *alongside* the original event, so both vocabularies stay live. A private
//! bus without listeners pays nothing.

use serde_json::{Value, json};

/// The kimi-web wire event names this server emits on the `/api/v1/ws` lane.
/// Pinned against `ws-event-contract.json` (see the test below) so a rename on
/// either side fails loudly instead of silently dropping UI updates.
pub const SERVER_WEB_EVENT_TYPES: &[&str] = &[
    "event.session.created",
    "event.session.updated",
    "event.session.deleted",
    "event.session.work_changed",
    "event.session.status_changed",
    "event.session.usage_updated",
    "event.session.history_compacted",
    "event.workspace.created",
    "event.workspace.updated",
    "event.workspace.deleted",
    "event.message.created",
    "event.message.updated",
    "event.assistant.delta",
    "event.tool.output",
    "event.tool.progress",
    "event.tool.completed",
    "event.approval.requested",
    "event.approval.resolved",
    "event.approval.expired",
    "event.question.requested",
    "event.question.answered",
    "event.question.dismissed",
    "event.task.created",
    "event.task.progress",
    "event.task.completed",
    "event.config.changed",
    "event.model_catalog.changed",
];

/// The engine event types this module aliases. Anything else passes through
/// unaliased.
pub fn web_event_aliases(event: &Value) -> Vec<Value> {
    let Some(kind) = event.get("type").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    match kind {
        // Live bash output: the Web client folds `message` chunks into the
        // tool card (mappers.ts `event.tool.progress`).
        "tool.native.progress" => {
            let Some(tool_call_id) = event.get("tool_call_id").cloned() else {
                return Vec::new();
            };
            vec![json!({
                "type": "event.tool.progress",
                "tool_call_id": tool_call_id,
                "message": event.get("text").cloned().unwrap_or(Value::Null),
            })]
        }
        // A native tool result: one output chunk carrying the whole result,
        // then the completion marker. `stream` spells the output channel the
        // Web client's tool card renders under.
        "tool.native" => {
            let Some(tool_call_id) = event.get("tool_call_id").cloned() else {
                return Vec::new();
            };
            vec![
                json!({
                    "type": "event.tool.output",
                    "tool_call_id": tool_call_id,
                    "chunk": event.get("content").cloned().unwrap_or(Value::Null),
                    "stream": "stdout",
                }),
                json!({
                    "type": "event.tool.completed",
                    "tool_call_id": tool_call_id,
                    "tool_name": event.get("tool_name").cloned().unwrap_or(Value::Null),
                    "is_error": event.get("is_error").cloned().unwrap_or(Value::Null),
                }),
            ]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_events_alias_with_the_message_chunk() {
        let aliases = web_event_aliases(&json!({
            "type": "tool.native.progress",
            "turn_id": "turn-1",
            "tool_call_id": "call_1",
            "kind": "stdout",
            "text": "partial output",
        }));
        assert_eq!(aliases.len(), 1);
        assert_eq!(aliases[0]["type"], "event.tool.progress");
        assert_eq!(aliases[0]["tool_call_id"], "call_1");
        assert_eq!(aliases[0]["message"], "partial output");
    }

    #[test]
    fn tool_results_alias_to_output_and_completed() {
        let aliases = web_event_aliases(&json!({
            "type": "tool.native",
            "turn_id": "turn-1",
            "tool_call_id": "call_2",
            "tool_name": "Read",
            "content": "file body",
            "is_error": false,
        }));
        assert_eq!(aliases.len(), 2);
        assert_eq!(aliases[0]["type"], "event.tool.output");
        assert_eq!(aliases[0]["tool_call_id"], "call_2");
        assert_eq!(aliases[0]["chunk"], "file body");
        assert_eq!(aliases[0]["stream"], "stdout");
        assert_eq!(aliases[1]["type"], "event.tool.completed");
        assert_eq!(aliases[1]["tool_name"], "Read");
        assert_eq!(aliases[1]["is_error"], false);
    }

    #[test]
    fn unrelated_events_pass_through_unaliased() {
        assert!(web_event_aliases(&json!({ "type": "assistant.delta" })).is_empty());
        assert!(web_event_aliases(&json!({ "no": "type" })).is_empty());
    }

    fn strings(value: &Value, key: &str) -> Vec<String> {
        serde_json::from_value(value[key].clone()).expect("string array")
    }

    #[test]
    fn server_web_events_match_the_contract_file() {
        let contract: Value = serde_json::from_str(include_str!("../../ws-event-contract.json"))
            .expect("ws-event-contract.json must parse");
        let web = strings(&contract, "webEvents");
        let server = strings(&contract, "serverEvents");
        let protocol = strings(&contract, "protocolEvents");
        let volatile = strings(&contract, "volatileEvents");

        let mut emitted: Vec<String> = SERVER_WEB_EVENT_TYPES
            .iter()
            .map(|name| (*name).to_string())
            .collect();
        emitted.sort();
        let mut contracted = server.clone();
        contracted.sort();
        assert_eq!(
            emitted, contracted,
            "SERVER_WEB_EVENT_TYPES and ws-event-contract.json disagree — update both together"
        );

        for name in &server {
            assert!(
                web.contains(name),
                "server emits {name}, which is not part of the kimi-web wire vocabulary"
            );
        }
        for name in &volatile {
            assert!(
                protocol.contains(name),
                "volatile event {name} is missing from the protocol AgentEvent union"
            );
        }
    }
}
