//! Engine event → ACP `session/update` mapping.
//!
//! Ports the subset of v2 `packages/acp-server/src/events-map.ts` that the
//! native engine can produce today: assistant/thinking deltas and the tool
//! call lifecycle. `plan`, `usage_update`, `available_commands_update`,
//! `current_mode_update`, `config_option_update` and `session_info_update`
//! have no native source yet and stay unmapped.

use serde_json::{Value, json};

use crate::events::types::EngineEvent;

/// ACP `toolCallId` is namespaced by turn (`${turnId}:${toolCallId}`, v2
/// `acpToolCallId`, events-map.ts).
pub fn acp_tool_call_id(turn_id: u64, tool_call_id: &str) -> String {
    format!("{turn_id}:{tool_call_id}")
}

/// Heuristic tool-name → ACP `ToolKind` (v2 `inferToolKind`); unknown names
/// degrade to `other` so streaming never blocks on an unrecognized tool.
pub fn infer_tool_kind(name: &str) -> &'static str {
    match name {
        "Read" | "Glob" | "Grep" => "read",
        "Write" | "Edit" => "edit",
        "Bash" | "Terminal" => "execute",
        // `WebFetch` is the v2 name; the native toolset calls it `FetchURL`.
        "WebFetch" | "FetchURL" | "WebSearch" => "fetch",
        "Think" => "think",
        _ => "other",
    }
}

/// Best-effort JSON stringification for tool args (v2 `stringifyArgs`): a
/// streaming push must never fail.
fn stringify_args(args: &Value) -> String {
    serde_json::to_string(args).unwrap_or_default()
}

/// Project one engine event onto ACP `session/update` params, or `None` when
/// the event has no ACP projection.
pub fn engine_event_to_session_update(session_id: &str, event: &EngineEvent) -> Option<Value> {
    match event {
        EngineEvent::AssistantDelta { delta, .. } => Some(json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": delta },
            },
        })),
        EngineEvent::ThinkingDelta { delta, .. } => Some(json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": delta },
            },
        })),
        EngineEvent::ToolCallStarted {
            turn_id,
            tool_call_id,
            name,
            args,
            ..
        } => Some(json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": acp_tool_call_id(*turn_id, tool_call_id),
                "title": name,
                "kind": infer_tool_kind(name),
                "status": "in_progress",
                "rawInput": args,
                "content": [{ "type": "text", "text": stringify_args(args) }],
            },
        })),
        EngineEvent::ToolCallCompleted {
            turn_id,
            tool_call_id,
            result,
            ..
        } => Some(json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": acp_tool_call_id(*turn_id, tool_call_id),
                "status": "completed",
                "rawOutput": result,
            },
        })),
        EngineEvent::ToolCallFailed {
            turn_id,
            tool_call_id,
            error,
            ..
        } => Some(json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": acp_tool_call_id(*turn_id, tool_call_id),
                "status": "failed",
                "rawOutput": error,
            },
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acp_tool_call_id_namespaces_by_turn() {
        assert_eq!(acp_tool_call_id(3, "call_1"), "3:call_1");
    }

    #[test]
    fn test_infer_tool_kind() {
        assert_eq!(infer_tool_kind("Read"), "read");
        assert_eq!(infer_tool_kind("Glob"), "read");
        assert_eq!(infer_tool_kind("Grep"), "read");
        assert_eq!(infer_tool_kind("Write"), "edit");
        assert_eq!(infer_tool_kind("Edit"), "edit");
        assert_eq!(infer_tool_kind("Bash"), "execute");
        assert_eq!(infer_tool_kind("WebFetch"), "fetch");
        assert_eq!(infer_tool_kind("FetchURL"), "fetch");
        assert_eq!(infer_tool_kind("Think"), "think");
        assert_eq!(infer_tool_kind("mcp__github__search"), "other");
    }

    #[test]
    fn test_assistant_delta_maps_to_agent_message_chunk() {
        let event = EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: 7,
            delta: "hello".into(),
        };
        assert_eq!(
            engine_event_to_session_update("sess-1", &event),
            Some(json!({
                "sessionId": "sess-1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hello" },
                },
            }))
        );
    }

    #[test]
    fn test_thinking_delta_maps_to_agent_thought_chunk() {
        let event = EngineEvent::ThinkingDelta {
            agent_id: "main".into(),
            turn_id: 7,
            delta: "hmm".into(),
        };
        assert_eq!(
            engine_event_to_session_update("sess-1", &event),
            Some(json!({
                "sessionId": "sess-1",
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "hmm" },
                },
            }))
        );
    }

    #[test]
    fn test_tool_call_lifecycle_maps_with_turn_namespaced_id() {
        let started = EngineEvent::ToolCallStarted {
            agent_id: "main".into(),
            turn_id: 7,
            tool_call_id: "call_1".into(),
            name: "Read".into(),
            args: json!({ "path": "src/main.rs" }),
        };
        let update = engine_event_to_session_update("sess-1", &started).expect("started maps");
        assert_eq!(update["update"]["sessionUpdate"], "tool_call");
        assert_eq!(update["update"]["toolCallId"], "7:call_1");
        assert_eq!(update["update"]["title"], "Read");
        assert_eq!(update["update"]["kind"], "read");
        assert_eq!(update["update"]["status"], "in_progress");
        assert_eq!(update["update"]["rawInput"]["path"], "src/main.rs");
        assert_eq!(
            update["update"]["content"][0]["text"],
            "{\"path\":\"src/main.rs\"}"
        );

        let completed = EngineEvent::ToolCallCompleted {
            agent_id: "main".into(),
            turn_id: 7,
            tool_call_id: "call_1".into(),
            result: json!({ "content": "ok" }),
        };
        let update = engine_event_to_session_update("sess-1", &completed).expect("completed maps");
        assert_eq!(update["update"]["sessionUpdate"], "tool_call_update");
        assert_eq!(update["update"]["toolCallId"], "7:call_1");
        assert_eq!(update["update"]["status"], "completed");
        assert_eq!(update["update"]["rawOutput"]["content"], "ok");

        let failed = EngineEvent::ToolCallFailed {
            agent_id: "main".into(),
            turn_id: 7,
            tool_call_id: "call_1".into(),
            error: "boom".into(),
        };
        let update = engine_event_to_session_update("sess-1", &failed).expect("failed maps");
        assert_eq!(update["update"]["status"], "failed");
        assert_eq!(update["update"]["rawOutput"], "boom");
    }

    /// Events without an ACP projection stay unmapped rather than emitting a
    /// half-formed update.
    #[test]
    fn test_unmapped_events_are_skipped() {
        let event = EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 7,
            prompt: Some("hi".into()),
        };
        assert!(engine_event_to_session_update("sess-1", &event).is_none());
    }
}
