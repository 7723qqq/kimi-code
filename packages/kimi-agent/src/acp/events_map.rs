//! Engine event → ACP `session/update` mapping.
//!
//! Ports the subset of v2 `packages/acp-server/src/events-map.ts` the native
//! engine feeds today: model text / thinking deltas and the tool-call
//! lifecycle. The turn loop publishes *raw JSON* through
//! `HostCallbacks::emit_event` (`llm.delta`, `tool.call.*`, `tool.native`), and
//! those payloads do not deserialize into the typed `EngineEvent` variants
//! (the raw `llm.delta` carries no `turn_id`/`step`; the raw `tool.call.*`
//! carries `tool_name` and a string `turn_id`). Dispatching on the typed
//! variants therefore dropped every production event; the mapper re-serializes
//! the event and dispatches on the wire `type` tag instead.
//!
//! `plan`, `usage_update`, `available_commands_update` and
//! `session_info_update` have no source this host can read (they need a model
//! catalog / todo display block / title-change feed) and stay unmapped;
//! `current_mode_update` and `config_option_update` are pushed by `mod.rs`.

use serde_json::{Value, json};

use crate::events::types::EngineEvent;

/// ACP `toolCallId` is namespaced by turn (`${turnId}:${toolCallId}`, v2
/// `acpToolCallId`, events-map.ts). The native turn id is an opaque string
/// (`turn-<ulid>`), which namespaces exactly as well as v2's counter.
pub fn acp_tool_call_id(turn_id: &str, tool_call_id: &str) -> String {
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

/// Map the engine's `LoopTurnStopReason` (Rust `Debug` name, the vocabulary
/// `TurnReport` carries) onto the ACP `StopReason` enum (v2
/// `turnEndReasonToStopReason`, events-map.ts:61-76).
///
/// v2 collapses everything that is not a cancellation or a provider filter
/// into `end_turn` because its `TurnEndReason` is only
/// `completed`/`cancelled`/`failed`/`blocked`. The native loop distinguishes
/// the two terminal states ACP names explicitly — the token ceiling and the
/// step budget — so those keep their own variants instead of being reported
/// as a clean completion.
pub fn turn_stop_reason_to_acp(reason: &str) -> &'static str {
    match reason {
        "Aborted" => "cancelled",
        "Filtered" => "refusal",
        "MaxTokens" => "max_tokens",
        "MaxSteps" => "max_turn_requests",
        _ => "end_turn",
    }
}

/// Project one engine event onto ACP `session/update` params, or `None` when
/// the event has no ACP projection.
pub fn engine_event_to_session_update(session_id: &str, event: &EngineEvent) -> Option<Value> {
    let value = event.to_json();
    let kind = value.get("type").and_then(Value::as_str)?;
    session_update_for(session_id, kind, &value)
}

/// Map an already-serialized engine event (wire `type` tag + payload).
///
/// The turn loop emits raw JSON, so this is the entry point the live stream
/// actually exercises; [`engine_event_to_session_update`] forwards to it after
/// re-serializing a typed event.
pub fn session_update_for(session_id: &str, kind: &str, event: &Value) -> Option<Value> {
    match kind {
        // The model's streaming output. The turn loop emits `llm.delta` with a
        // `part` that is either text or thinking; the typed `assistant.delta` /
        // `thinking.delta` variants carry a plain `delta` string instead.
        "assistant.delta" | "llm.delta" => {
            if let Some(text) = part_text(event) {
                return Some(agent_message_chunk(session_id, text));
            }
            if let Some(text) = part_think(event) {
                return Some(agent_thought_chunk(session_id, text));
            }
            event
                .get("delta")
                .and_then(Value::as_str)
                .map(|text| agent_message_chunk(session_id, text))
        }
        "thinking.delta" => {
            let text = event
                .get("delta")
                .and_then(Value::as_str)
                .or_else(|| part_think(event))?;
            Some(agent_thought_chunk(session_id, text))
        }
        "tool.call.started" => Some(tool_call_started(session_id, event)),
        // The native toolset reports only the completed execution
        // (`tool.native`); `tool.call.completed` / `tool.call.failed` carry the
        // same outcome on the loop path. All three terminate the same wire
        // call, so they share one projection (v2 `toolResultToSessionUpdate`).
        "tool.native" | "tool.call.completed" | "tool.call.failed" => {
            Some(tool_call_result(session_id, event))
        }
        _ => None,
    }
}

/// The text of an `llm.delta` part, if this delta is a text part
/// (`{ "type": "text", "text": … }`); thinking parts return `None`.
fn part_text(event: &Value) -> Option<&str> {
    let part = event.get("part")?;
    if part.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    part.get("text").and_then(Value::as_str)
}

/// The thinking text of an `llm.delta` part (`{ "type": "think", "think": … }`).
fn part_think(event: &Value) -> Option<&str> {
    let part = event.get("part")?;
    if part.get("type").and_then(Value::as_str) != Some("think") {
        return None;
    }
    part.get("think").and_then(Value::as_str)
}

fn agent_message_chunk(session_id: &str, text: &str) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text },
        },
    })
}

fn agent_thought_chunk(session_id: &str, text: &str) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": text },
        },
    })
}

/// The tool name and turn id of a raw tool event (`tool_name` on the loop
/// path, `name` on the typed one).
fn tool_name(event: &Value) -> &str {
    event
        .get("tool_name")
        .or_else(|| event.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn tool_turn_id(event: &Value) -> String {
    match event.get("turn_id") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// The initial `tool_call` (v2 `toolCallStartToSessionUpdate`): args preview as
/// a `content` entry, plus `rawInput` for clients that render the structured
/// form.
fn tool_call_started(session_id: &str, event: &Value) -> Value {
    let name = tool_name(event);
    let args = event.get("args").cloned().unwrap_or(Value::Null);
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": acp_tool_call_id(&tool_turn_id(event), tool_call_id(event)),
            "title": name,
            "kind": infer_tool_kind(name),
            "status": "in_progress",
            "rawInput": args,
            "content": [{ "type": "content", "content": { "type": "text", "text": stringify_args(&args) } }],
        },
    })
}

fn tool_call_id(event: &Value) -> &str {
    event
        .get("tool_call_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// The terminal `tool_call_update` (v2 `toolResultToSessionUpdate`): `status`
/// flips on `is_error`, the textual result replaces the args preview, and
/// `rawOutput` keeps the raw payload.
///
/// `content` is emitted only when the event actually carries an output. The
/// loop emits `tool.native` (with the result text) and then
/// `tool.call.completed` (a bare outcome) for the same call; an update is a
/// partial record, so the bare one keeps the status while leaving the content
/// the earlier event installed in place instead of blanking the card.
fn tool_call_result(session_id: &str, event: &Value) -> Value {
    // `tool.call.failed` carries no `is_error` — its name is the signal.
    let is_error = event
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| event.get("type").and_then(Value::as_str) == Some("tool.call.failed"));
    let output = event
        .get("content")
        .or_else(|| event.get("result"))
        .or_else(|| event.get("error"))
        .cloned();
    let mut update = json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": acp_tool_call_id(&tool_turn_id(event), tool_call_id(event)),
        "status": if is_error { "failed" } else { "completed" },
    });
    if let Some(output) = output {
        let text = match &output {
            Value::String(text) => text.clone(),
            other => stringify_args(other),
        };
        update["content"] = json!([{
            "type": "content",
            "content": { "type": "text", "text": text },
        }]);
        update["rawOutput"] = output;
    }
    json!({ "sessionId": session_id, "update": update })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acp_tool_call_id_namespaces_by_turn() {
        assert_eq!(acp_tool_call_id("3", "call_1"), "3:call_1");
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
    fn raw_turn_events_project_to_session_updates() {
        // Exactly what the turn loop publishes (`run_turn.rs`): `llm.delta`
        // carries no turn id, and the tool events use `tool_name` with a string
        // turn id. These are the shapes that reach the live stream.
        assert_eq!(
            session_update_for(
                "sess-1",
                "llm.delta",
                &json!({ "type": "llm.delta", "part": { "type": "text", "text": "hi" } }),
            ),
            Some(json!({
                "sessionId": "sess-1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hi" },
                },
            }))
        );
        assert_eq!(
            session_update_for(
                "sess-1",
                "llm.delta",
                &json!({ "type": "llm.delta", "part": { "type": "think", "think": "hmm" } }),
            ),
            Some(json!({
                "sessionId": "sess-1",
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "hmm" },
                },
            }))
        );

        let started = session_update_for(
            "sess-1",
            "tool.call.started",
            &json!({
                "type": "tool.call.started",
                "turn_id": "turn-1",
                "tool_call_id": "call_1",
                "tool_name": "Read",
                "args": { "path": "a.txt" },
            }),
        )
        .expect("a raw tool.call.started must map");
        assert_eq!(started["update"]["sessionUpdate"], "tool_call");
        assert_eq!(started["update"]["toolCallId"], "turn-1:call_1");
        assert_eq!(started["update"]["title"], "Read");
        assert_eq!(started["update"]["kind"], "read");
        assert_eq!(started["update"]["status"], "in_progress");
        assert_eq!(started["update"]["content"][0]["type"], "content");

        // The native toolset's terminal event.
        let native = session_update_for(
            "sess-1",
            "tool.native",
            &json!({
                "type": "tool.native",
                "turn_id": "turn-1",
                "tool_call_id": "call_1",
                "tool_name": "Read",
                "arguments": { "path": "a.txt" },
                "content": "1\tfile body\n",
                "is_error": false,
                "note": null,
            }),
        )
        .expect("tool.native must map");
        assert_eq!(native["update"]["sessionUpdate"], "tool_call_update");
        assert_eq!(native["update"]["toolCallId"], "turn-1:call_1");
        assert_eq!(native["update"]["status"], "completed");
        assert_eq!(
            native["update"]["content"][0]["content"]["text"],
            "1\tfile body\n"
        );
        assert_eq!(native["update"]["rawOutput"], "1\tfile body\n");

        // The loop's own lifecycle event, carrying the same terminal outcome.
        let completed = session_update_for(
            "sess-1",
            "tool.call.completed",
            &json!({
                "type": "tool.call.completed",
                "turn_id": "turn-1",
                "tool_call_id": "call_1",
                "tool_name": "Read",
                "is_error": false,
            }),
        )
        .expect("tool.call.completed must map");
        assert_eq!(completed["update"]["toolCallId"], "turn-1:call_1");
        assert_eq!(completed["update"]["status"], "completed");

        // A failed execution flips the status and keeps the error text.
        let failed = session_update_for(
            "sess-1",
            "tool.call.failed",
            &json!({
                "type": "tool.call.failed",
                "turn_id": "turn-1",
                "tool_call_id": "call_2",
                "tool_name": "Read",
                "is_error": true,
                "error": "boom",
            }),
        )
        .expect("tool.call.failed must map");
        assert_eq!(failed["update"]["status"], "failed");
        assert_eq!(failed["update"]["rawOutput"], "boom");
    }

    /// The typed variants still project: the napi / REPL paths publish them.
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
        assert_eq!(update["update"]["content"][0]["type"], "content");
        assert_eq!(
            update["update"]["content"][0]["content"]["text"],
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

    /// Every `LoopTurnStopReason` variant reaches a real ACP `StopReason`
    /// value — a strict client parses the response, so an unmapped name would
    /// fail the whole `session/prompt` call.
    #[test]
    fn test_turn_stop_reason_maps_to_acp_enum() {
        use crate::turn_loop::types::LoopTurnStopReason;
        use crate::turn_loop::types::LoopTurnStopReason::*;
        let acp = |reason: LoopTurnStopReason| turn_stop_reason_to_acp(&format!("{reason:?}"));
        assert_eq!(acp(EndTurn), "end_turn");
        assert_eq!(acp(Aborted), "cancelled");
        assert_eq!(acp(Filtered), "refusal");
        assert_eq!(acp(MaxTokens), "max_tokens");
        assert_eq!(acp(MaxSteps), "max_turn_requests");
        assert_eq!(acp(Paused), "end_turn");
        assert_eq!(acp(Unknown), "end_turn");
        assert_eq!(acp(BudgetLimited), "end_turn");
        assert_eq!(acp(RepeatBreaker), "end_turn");
        // An unrecognized reason must still be a parseable ACP value.
        assert_eq!(turn_stop_reason_to_acp("SomethingNew"), "end_turn");
    }
}
