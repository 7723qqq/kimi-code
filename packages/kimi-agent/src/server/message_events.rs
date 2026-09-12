//! Assistant/user message identity for the Web event vocabulary.
//!
//! The engine's turn loop speaks in steps and deltas (`llm.delta`,
//! `llm.step.end`); the Web client speaks in messages (`event.message.created`
//! / `event.assistant.delta` / `event.message.updated`). This decorator is
//! the translation seam, applied per turn on the server path:
//!
//! - the user prompt becomes one `event.message.created` at turn start;
//! - a step's first content delta creates the step's assistant message
//!   (`event.message.created`) and every further delta rides
//!   `event.assistant.delta` with a running `content_index`;
//! - `llm.step.end` finalizes the message (`event.message.updated`) with the
//!   text block plus one `tool_use` block per requested tool call, then the
//!   next step starts a fresh message.
//!
//! Message ids are deterministic (`msg-u<turn>` / `msg-a<turn>-<step>`) so a
//! client can key them without a registry round-trip.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, CheckpointRequest, ListToolsResponse, LlmChatRequest,
    LlmChatResponse, PermissionCheckRequest, PermissionDecision, StateReadRequest,
    StateReadResponse, StateWriteRequest, StateWriteResponse, ToolExecuteRequest,
    ToolExecuteResponse,
};
use crate::server::hub::EventHub;
use crate::turn_loop::types::{GoalContext, LLMMessage};

/// The assistant message of the current step, from its first content delta.
struct AssistantMessage {
    id: String,
    /// How many deltas were already announced — the `content_index` v2
    /// carried so a client can splice chunks into its content array.
    content_index: usize,
}

struct MessageState {
    step: u32,
    current: Option<AssistantMessage>,
}

pub struct MessageCallbacks {
    pub inner: Arc<dyn HostCallbacks>,
    pub session_id: String,
    pub hub: Arc<EventHub>,
    pub turn_number: u32,
    pub prompt: String,
    state: Mutex<MessageState>,
}

impl MessageCallbacks {
    /// Build the decorator and announce the user prompt as the turn's first
    /// message (v2 folded the prompt into the transcript before the first
    /// step ran).
    pub fn new(
        inner: Arc<dyn HostCallbacks>,
        session_id: &str,
        hub: Arc<EventHub>,
        turn_number: u32,
        prompt: &str,
    ) -> Self {
        let callbacks = Self {
            inner,
            session_id: session_id.to_string(),
            hub,
            turn_number,
            prompt: prompt.to_string(),
            state: Mutex::new(MessageState {
                step: 0,
                current: None,
            }),
        };
        callbacks.publish_created(
            &format!("msg-u{turn_number}"),
            "user",
            Vec::new(),
            Some(json!([{ "type": "text", "text": prompt }])),
        );
        callbacks
    }

    fn publish_created(
        &self,
        id: &str,
        role: &str,
        content: Vec<Value>,
        fallback_content: Option<Value>,
    ) {
        self.hub
            .bus_for(&self.session_id)
            .publish(&crate::events::EngineEvent::Custom(json!({
                "type": "event.message.created",
                "message": {
                    "id": id,
                    "session_id": self.session_id,
                    "role": role,
                    "content": if content.is_empty() {
                        fallback_content.unwrap_or(Value::Array(Vec::new()))
                    } else {
                        Value::Array(content)
                    },
                    "created_at": chrono::Utc::now().to_rfc3339(),
                },
            })));
    }

    /// A content delta arrived: create the step's assistant message on first
    /// sight, then announce the chunk.
    fn on_delta(&self, part: &Value) {
        let Some(part_kind) = part.get("type").and_then(|v| v.as_str()) else {
            return;
        };
        let Some(chunk) = (match part_kind {
            "text" => part.get("text").and_then(|v| v.as_str()),
            "think" => part.get("think").and_then(|v| v.as_str()),
            _ => None,
        }) else {
            return;
        };
        let (message_id, index) = {
            let mut state = self.state.lock().unwrap();
            if state.current.is_none() {
                let id = format!("msg-a{}-{}", self.turn_number, state.step);
                state.current = Some(AssistantMessage {
                    id: id.clone(),
                    content_index: 0,
                });
                self.hub
                    .bus_for(&self.session_id)
                    .publish(&crate::events::EngineEvent::Custom(json!({
                        "type": "event.message.created",
                        "message": {
                            "id": id,
                            "session_id": self.session_id,
                            "role": "assistant",
                            "content": [],
                            "created_at": chrono::Utc::now().to_rfc3339(),
                        },
                    })));
            }
            let current = state.current.as_mut().unwrap();
            let index = current.content_index;
            current.content_index += 1;
            (current.id.clone(), index)
        };
        self.hub
            .bus_for(&self.session_id)
            .publish(&crate::events::EngineEvent::Custom(json!({
                "type": "event.assistant.delta",
                "message_id": message_id,
                "content_index": index,
                "delta": chunk,
            })));
    }

    /// The step finished: finalize the assistant message with its text plus
    /// one `tool_use` block per requested tool call.
    fn on_step_end(&self, event: &Value) {
        let mut state = self.state.lock().unwrap();
        let Some(current) = state.current.take() else {
            return;
        };
        let mut content: Vec<Value> = Vec::new();
        if let Some(text) = event
            .get("content")
            .and_then(|v| v.as_str())
            .filter(|text| !text.is_empty())
        {
            content.push(json!({ "type": "text", "text": text }));
        }
        if let Some(tool_calls) = event.get("tool_calls").and_then(|v| v.as_array()) {
            for call in tool_calls {
                content.push(json!({
                    "type": "tool_use",
                    "tool_call_id": call.get("id").cloned().unwrap_or(Value::Null),
                    "tool_name": call.get("name").cloned().unwrap_or(Value::Null),
                    "input": call.get("arguments").cloned().unwrap_or(Value::Null),
                }));
            }
        }
        self.hub
            .bus_for(&self.session_id)
            .publish(&crate::events::EngineEvent::Custom(json!({
                "type": "event.message.updated",
                "message_id": current.id,
                "content": content,
                "status": "completed",
            })));
    }
}

impl HostCallbacks for MessageCallbacks {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.inner.execute_tool(request)
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<PermissionDecision, String>> {
        self.inner.check_permission(request)
    }

    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<AskQuestionResponse, String>> {
        self.inner.ask_question(request)
    }

    fn state_read(
        &self,
        request: StateReadRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<StateReadResponse, String>> {
        self.inner.state_read(request)
    }

    fn state_write(
        &self,
        request: StateWriteRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<StateWriteResponse, String>> {
        self.inner.state_write(request)
    }

    fn checkpoint(
        &self,
        request: CheckpointRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<(), String>> {
        self.inner.checkpoint(request)
    }

    fn list_tools(
        &self,
    ) -> crate::rpc::types::BoxFuture<'static, Result<ListToolsResponse, String>> {
        self.inner.list_tools()
    }

    fn goal(&self) -> crate::rpc::types::BoxFuture<'static, Result<Option<GoalContext>, String>> {
        self.inner.goal()
    }

    fn auth_token(
        &self,
        provider: String,
        force: bool,
    ) -> crate::rpc::types::BoxFuture<'static, Result<String, String>> {
        self.inner.auth_token(provider, force)
    }

    fn drain_steers(
        &self,
    ) -> crate::rpc::types::BoxFuture<'static, Result<Vec<LLMMessage>, String>> {
        self.inner.drain_steers()
    }

    fn set_turn_goal(&self, turn_id: &str, goal_id: Option<&str>) {
        self.inner.set_turn_goal(turn_id, goal_id);
    }

    fn emit_event(&self, event: Value) {
        match event.get("type").and_then(|v| v.as_str()) {
            Some("llm.step.begin") => {
                self.state.lock().unwrap().step += 1;
            }
            Some("llm.delta") => {
                if let Some(part) = event.get("part") {
                    self.on_delta(part);
                }
            }
            Some("llm.step.end") => self.on_step_end(&event),
            _ => {}
        }
        self.inner.emit_event(event);
    }

    fn turn_event(&self, event: crate::turn_events::TurnEvent) {
        self.inner.turn_event(event);
    }

    fn telemetry(&self, event: Value) {
        self.inner.telemetry(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A no-op inner: the decorator never needs it for the message fold.
    fn inner() -> Arc<dyn HostCallbacks> {
        struct Drop;
        impl HostCallbacks for Drop {
            fn llm_chat(
                &self,
                _: LlmChatRequest,
            ) -> crate::rpc::types::BoxFuture<'static, Result<LlmChatResponse, String>>
            {
                Box::pin(async { Err("unused".into()) })
            }
            fn execute_tool(
                &self,
                _: ToolExecuteRequest,
            ) -> crate::rpc::types::BoxFuture<'static, Result<ToolExecuteResponse, String>>
            {
                Box::pin(async { Err("unused".into()) })
            }
            fn check_permission(
                &self,
                _: PermissionCheckRequest,
            ) -> crate::rpc::types::BoxFuture<'static, Result<PermissionDecision, String>>
            {
                Box::pin(async { Err("unused".into()) })
            }
        }
        Arc::new(Drop)
    }

    /// A bound event drain: the hub's subscriber queue would otherwise hang
    /// the suite on a regression that publishes one event too few.
    async fn next_event(sub: &mut crate::server::hub::WsSubscription) -> Value {
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), sub.recv())
            .await
            .expect("event within 5s")
            .expect("hub open");
        serde_json::to_value(&event.event).unwrap()
    }

    #[tokio::test]
    async fn the_turn_publishes_user_and_step_messages() {
        let hub = Arc::new(EventHub::new());
        let mut sub = hub.attach();
        let callbacks = MessageCallbacks::new(inner(), "sess-msg", hub.clone(), 4, "draw a cat");

        // The user prompt is announced at construction.
        let user = next_event(&mut sub).await;
        assert_eq!(user["type"], "event.message.created");
        assert_eq!(user["message"]["id"], "msg-u4");
        assert_eq!(user["message"]["role"], "user");
        assert_eq!(user["message"]["content"][0]["text"], "draw a cat");

        // Step 1: the first delta creates the message, both deltas stream.
        callbacks.emit_event(json!({ "type": "llm.step.begin", "model": "m" }));
        callbacks.emit_event(json!({
            "type": "llm.delta",
            "part": { "type": "text", "text": "he" },
        }));
        let created = next_event(&mut sub).await;
        assert_eq!(created["type"], "event.message.created");
        assert_eq!(created["message"]["id"], "msg-a4-1");
        assert_eq!(created["message"]["role"], "assistant");
        assert_eq!(created["message"]["content"], json!([]));

        let delta1 = next_event(&mut sub).await;
        assert_eq!(delta1["type"], "event.assistant.delta");
        assert_eq!(delta1["content_index"], 0);
        assert_eq!(delta1["delta"], "he");

        callbacks.emit_event(json!({
            "type": "llm.delta",
            "part": { "type": "text", "text": "llo" },
        }));
        let delta = next_event(&mut sub).await;
        assert_eq!(delta["type"], "event.assistant.delta");
        assert_eq!(delta["message_id"], "msg-a4-1");
        assert_eq!(delta["content_index"], 1);
        assert_eq!(delta["delta"], "llo");

        // Step end finalizes the message with text + tool_use blocks.
        callbacks.emit_event(json!({
            "type": "llm.step.end",
            "content": "hello",
            "tool_calls": [
                { "id": "c1", "name": "Read", "arguments": { "path": "a" } }
            ],
        }));
        let updated = next_event(&mut sub).await;
        assert_eq!(updated["type"], "event.message.updated");
        assert_eq!(updated["message_id"], "msg-a4-1");
        assert_eq!(updated["status"], "completed");
        assert_eq!(updated["content"][0]["type"], "text");
        assert_eq!(updated["content"][0]["text"], "hello");
        assert_eq!(updated["content"][1]["type"], "tool_use");
        assert_eq!(updated["content"][1]["tool_call_id"], "c1");
        assert_eq!(updated["content"][1]["input"]["path"], "a");

        // Step 2 starts a fresh message.
        callbacks.emit_event(json!({ "type": "llm.step.begin", "model": "m" }));
        callbacks.emit_event(json!({
            "type": "llm.delta",
            "part": { "type": "text", "text": "next" },
        }));
        let created2 = next_event(&mut sub).await;
        assert_eq!(created2["message"]["id"], "msg-a4-2");
    }

    #[tokio::test]
    async fn thinking_deltas_stream_and_empty_step_ends_are_ignored() {
        let hub = Arc::new(EventHub::new());
        let mut sub = hub.attach();
        let callbacks = MessageCallbacks::new(inner(), "sess-think", hub.clone(), 1, "hi");

        let _user = next_event(&mut sub).await;

        // A step that ends without ever streaming produces no message events.
        callbacks.emit_event(json!({ "type": "llm.step.begin", "model": "m" }));
        callbacks.emit_event(json!({ "type": "llm.step.end", "content": "", "tool_calls": [] }));

        callbacks.emit_event(json!({
            "type": "llm.delta",
            "part": { "type": "think", "think": "reasoning..." },
        }));
        let created = next_event(&mut sub).await;
        assert_eq!(created["message"]["id"], "msg-a1-1");
        let delta = next_event(&mut sub).await;
        assert_eq!(delta["type"], "event.assistant.delta");
        assert_eq!(delta["delta"], "reasoning...");
    }
}
