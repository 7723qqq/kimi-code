//! Native single-step event fold state machine (aligned with TS
//! `agent-core-v2`'s `loopEventFold.ts`, 355 lines).
//!
//! Consumes the low-level event stream (step.begin, content.part, tool.call,
//! tool.result, step.end) and strictly maintains the open-step lifecycle,
//! vacuous-empty-content dropping, Tool-immediately-after ordering, and
//! self-healing for an interrupted dangling tool.

use super::{Message, MessageRole};
use std::collections::HashSet;

pub const TOOL_INTERRUPTED_ON_RESUME_OUTPUT: &str = "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.";

/// The low-level events a recorded single-step loop emits (aligned with TS
/// `LoopRecordedEvent`)
#[derive(Debug, Clone)]
pub enum LoopRecordedEvent {
    StepBegin {
        uuid: String,
        turn_id: Option<String>,
        step: Option<u32>,
    },
    StepEnd {
        uuid: String,
        finish_reason: Option<String>,
    },
    ContentPart {
        step_uuid: String,
        text: String,
        is_vacuous: bool,
    },
    ToolCall {
        step_uuid: String,
        tool_call_id: String,
        name: String,
        arguments: Option<String>,
    },
    ToolResult {
        tool_call_id: String,
        output: String,
        is_error: bool,
        note: Option<String>,
    },
}

/// The sink interface the fold writes its output to (aligned with TS
/// `LoopEventFoldSink`)
pub trait LoopEventFoldSink {
    fn open_assistant(&mut self);
    fn append_open_content(&mut self, text: &str);
    fn append_open_tool_call(&mut self, tool_call_id: String, name: String, args: Option<String>);
    fn drop_open_assistant(&mut self);
    fn seal_open_assistant(&mut self);
    fn push_tool_message(&mut self, tool_call_id: String, output: String, is_error: bool);
    fn push_message(&mut self, role: MessageRole, content: String);
    fn clear(&mut self);
}

/// The standard sink implementation, backed by an in-memory message list
#[derive(Default)]
pub struct VectorFoldSink {
    pub messages: Vec<Message>,
    has_open_assistant: bool,
}

impl VectorFoldSink {
    pub fn new() -> Self {
        Self::default()
    }
}

impl LoopEventFoldSink for VectorFoldSink {
    fn clear(&mut self) {
        self.messages.clear();
        self.has_open_assistant = false;
    }
    fn open_assistant(&mut self) {
        self.messages.push(Message {
            role: MessageRole::Assistant,
            content: String::new(),
            blocks: serde_json::json!([]),
            tool_calls: Some(serde_json::json!([])),
            tool_call_id: None,
        });
        self.has_open_assistant = true;
    }

    fn append_open_content(&mut self, text: &str) {
        if let Some(last) = self.messages.last_mut()
            && last.role == MessageRole::Assistant
        {
            last.content.push_str(text);
        }
    }

    fn append_open_tool_call(&mut self, tool_call_id: String, name: String, args: Option<String>) {
        if let Some(last) = self.messages.last_mut()
            && last.role == MessageRole::Assistant
        {
            let call_obj = serde_json::json!({
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": args.unwrap_or_else(|| "{}".to_string()),
                }
            });
            if let Some(ref mut arr) = last.tool_calls.as_mut().and_then(|v| v.as_array_mut()) {
                arr.push(call_obj);
            }
        }
    }

    fn drop_open_assistant(&mut self) {
        if self.has_open_assistant {
            if let Some(last) = self.messages.last()
                && last.role == MessageRole::Assistant
            {
                self.messages.pop();
            }
            self.has_open_assistant = false;
        }
    }

    fn seal_open_assistant(&mut self) {
        if let Some(last) = self.messages.last_mut()
            && last.role == MessageRole::Assistant
        {
            // With no tool_calls at all, reset the field to None
            if let Some(arr) = last.tool_calls.as_ref().and_then(|v| v.as_array())
                && arr.is_empty()
            {
                last.tool_calls = None;
            }
        }
        self.has_open_assistant = false;
    }

    fn push_tool_message(&mut self, tool_call_id: String, output: String, _is_error: bool) {
        self.messages.push(Message {
            role: MessageRole::Tool,
            content: output,
            blocks: serde_json::json!([]),
            tool_calls: None,
            tool_call_id: Some(tool_call_id),
        });
    }

    fn push_message(&mut self, role: MessageRole, content: String) {
        self.messages.push(Message {
            role,
            content,
            blocks: serde_json::json!([]),
            tool_calls: None,
            tool_call_id: None,
        });
    }
}

/// Native single-step event fold state machine
pub struct LoopEventFold<S: LoopEventFoldSink> {
    sink: S,
    open_step_uuid: Option<String>,
    open_has_tool_calls: bool,
    open_vacuous: bool,
    pending: HashSet<String>,
    deferred: Vec<(MessageRole, String)>,
}

impl<S: LoopEventFoldSink> LoopEventFold<S> {
    pub fn new(sink: S) -> Self {
        Self {
            sink,
            open_step_uuid: None,
            open_has_tool_calls: false,
            open_vacuous: true,
            pending: HashSet::new(),
            deferred: Vec::new(),
        }
    }

    /// Release the deferred queue (aligned with TS `flushDeferred`)
    fn flush_deferred(&mut self) {
        if !self.pending.is_empty() || self.deferred.is_empty() {
            return;
        }
        for (role, content) in self.deferred.drain(..) {
            self.sink.push_message(role, content);
        }
    }

    /// Close and self-heal an interrupted dangling tool (aligned with TS
    /// `closePending`)
    fn close_pending(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        for tool_call_id in self.pending.drain() {
            self.sink.push_tool_message(
                tool_call_id,
                TOOL_INTERRUPTED_ON_RESUME_OUTPUT.to_string(),
                true,
            );
        }
        self.flush_deferred();
    }

    /// Settle the currently open step (aligned with TS `settleOpen`)
    pub fn settle_open(&mut self) {
        if self.open_step_uuid.is_none() {
            return;
        }
        self.close_pending();
        if !self.open_has_tool_calls && self.open_vacuous {
            self.sink.drop_open_assistant();
        } else {
            self.sink.seal_open_assistant();
        }
        self.open_step_uuid = None;
    }

    /// Whether an event for the given step is accepted (aligned with TS
    /// `acceptsOpenStep`)
    fn accepts_open_step(&mut self, step_uuid: &str) -> bool {
        match self.open_step_uuid.as_deref() {
            None => false,
            Some(active) => active == step_uuid,
        }
    }

    /// Append an externally supplied input message (a user interjection or a
    /// system injection; aligned with TS `appendMessage`)
    pub fn append_message(&mut self, role: MessageRole, content: String) {
        if !self.pending.is_empty() {
            // While waiting for a tool result, park the input in the deferred
            // queue to preserve ordering
            self.deferred.push((role, content));
            return;
        }
        self.sink.push_message(role, content);
    }

    /// Handle one streaming low-level recorded event (aligned with TS
    /// `loopEvent`)
    pub fn loop_event(&mut self, event: LoopRecordedEvent) {
        match event {
            LoopRecordedEvent::StepBegin { uuid, .. } => {
                self.settle_open();
                self.sink.open_assistant();
                self.open_step_uuid = Some(uuid);
                self.open_has_tool_calls = false;
                self.open_vacuous = true;
            }
            LoopRecordedEvent::StepEnd { finish_reason, .. } => {
                // Aligned with TS line 155: on `interrupted` or `error`,
                // openStepUuid is kept so a later resume can pick it up — no
                // settle is triggered here.
                if let Some(ref r) = finish_reason
                    && (r == "interrupted" || r == "error")
                {
                    return;
                }
                self.settle_open();
                self.flush_deferred();
            }
            LoopRecordedEvent::ContentPart {
                step_uuid,
                text,
                is_vacuous,
            } => {
                if !self.accepts_open_step(&step_uuid) {
                    return;
                }
                self.sink.append_open_content(&text);
                self.open_vacuous = self.open_vacuous && is_vacuous;
            }
            LoopRecordedEvent::ToolCall {
                step_uuid,
                tool_call_id,
                name,
                arguments,
            } => {
                if !self.accepts_open_step(&step_uuid) {
                    return;
                }
                self.sink
                    .append_open_tool_call(tool_call_id.clone(), name, arguments);
                self.pending.insert(tool_call_id);
                self.open_has_tool_calls = true;
            }
            LoopRecordedEvent::ToolResult {
                tool_call_id,
                output,
                is_error,
                ..
            } => {
                if !self.pending.remove(&tool_call_id) {
                    return;
                }
                self.sink.push_tool_message(tool_call_id, output, is_error);
                self.flush_deferred();
            }
        }
    }

    /// Wrap up at session settle time (aligned with TS `settle`)
    pub fn settle(&mut self) {
        self.settle_open();
    }

    /// Reset the state machine (aligned with TS `reset`)
    pub fn reset(&mut self) {
        self.open_step_uuid = None;
        self.open_has_tool_calls = false;
        self.open_vacuous = true;
        self.pending.clear();
        self.deferred.clear();
        self.sink.clear();
    }

    pub fn into_sink(self) -> S {
        self.sink
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loop_fold_standard_lifecycle() {
        let sink = VectorFoldSink::new();
        let mut fold = LoopEventFold::new(sink);

        // 1. The user asks a question
        fold.append_message(MessageRole::User, "Calculate 1 + 1".into());

        // 2. The step begins
        fold.loop_event(LoopRecordedEvent::StepBegin {
            uuid: "step_1".into(),
            turn_id: Some("turn_1".into()),
            step: Some(1),
        });

        // 3. The model streams text plus a tool call
        fold.loop_event(LoopRecordedEvent::ContentPart {
            step_uuid: "step_1".into(),
            text: "Let me calculate.".into(),
            is_vacuous: false,
        });
        fold.loop_event(LoopRecordedEvent::ToolCall {
            step_uuid: "step_1".into(),
            tool_call_id: "calc_call_1".into(),
            name: "calc".into(),
            arguments: Some(r#"{"expr":"1+1"}"#.into()),
        });

        // 4. The user interjects right here -> it must be deferred
        fold.append_message(MessageRole::User, "Hurry up".into());

        // 5. The tool result returns
        fold.loop_event(LoopRecordedEvent::ToolResult {
            tool_call_id: "calc_call_1".into(),
            output: "2".into(),
            is_error: false,
            note: None,
        });

        // 6. The step ends
        fold.loop_event(LoopRecordedEvent::StepEnd {
            uuid: "step_1".into(),
            finish_reason: Some("stop".into()),
        });

        fold.settle();

        let sink = fold.into_sink();
        let msgs = sink.messages;

        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0].role, MessageRole::User);
        assert_eq!(msgs[0].content, "Calculate 1 + 1");

        assert_eq!(msgs[1].role, MessageRole::Assistant);
        assert_eq!(msgs[1].content, "Let me calculate.");
        assert!(msgs[1].tool_calls.is_some());

        // The key assertion: the Tool message must follow the Assistant
        // immediately, and "Hurry up" must land after the tool result!
        assert_eq!(msgs[2].role, MessageRole::Tool);
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("calc_call_1"));
        assert_eq!(msgs[2].content, "2");

        assert_eq!(msgs[3].role, MessageRole::User);
        assert_eq!(msgs[3].content, "Hurry up");
    }

    #[test]
    fn test_loop_fold_drop_vacuous_assistant() {
        let sink = VectorFoldSink::new();
        let mut fold = LoopEventFold::new(sink);

        fold.loop_event(LoopRecordedEvent::StepBegin {
            uuid: "step_empty".into(),
            turn_id: None,
            step: None,
        });

        // Produces only blank placeholder content
        fold.loop_event(LoopRecordedEvent::ContentPart {
            step_uuid: "step_empty".into(),
            text: "".into(),
            is_vacuous: true,
        });

        fold.loop_event(LoopRecordedEvent::StepEnd {
            uuid: "step_empty".into(),
            finish_reason: Some("stop".into()),
        });

        fold.settle();
        let sink = fold.into_sink();
        // A blank message with no tool call and no content is filtered out and
        // never kept in the history
        assert!(sink.messages.is_empty());
    }

    #[test]
    fn test_loop_fold_hanging_tool_auto_recovery() {
        let sink = VectorFoldSink::new();
        let mut fold = LoopEventFold::new(sink);

        fold.loop_event(LoopRecordedEvent::StepBegin {
            uuid: "step_hang".into(),
            turn_id: None,
            step: None,
        });

        fold.loop_event(LoopRecordedEvent::ToolCall {
            step_uuid: "step_hang".into(),
            tool_call_id: "hang_call_1".into(),
            name: "bash".into(),
            arguments: Some(r#"{"cmd":"sleep 100"}"#.into()),
        });

        // An unexpected interruption, or the next step starting
        fold.settle();

        let sink = fold.into_sink();
        let msgs = sink.messages;

        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, MessageRole::Assistant);
        // The key assertion: an unresolved tool must be self-healed by
        // synthesizing an interrupted result
        assert_eq!(msgs[1].role, MessageRole::Tool);
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("hang_call_1"));
        assert!(msgs[1].content.contains("Tool execution was interrupted"));
    }
}
