//! 原生单步事件折叠状态机（对齐 TS agent-core-v2 loopEventFold.ts 341行）。
//!
//! 负责消费底层事件流（step.begin, content.part, tool.call, tool.result, step.end），
//! 严格维护开放步生命周期、Vacuous 空内容丢弃、Tool 紧随保序与悬挂中断自愈。

use std::collections::HashSet;
use super::{Message, MessageRole};

pub const TOOL_INTERRUPTED_ON_RESUME_OUTPUT: &str =
    "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.";

/// 录制的单步循环底层事件定义（对齐 TS LoopRecordedEvent）
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

/// 折叠输出接收器接口（对齐 TS LoopEventFoldSink）
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

/// 基于内存消息列表的标准接收器实现
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
        if let Some(last) = self.messages.last_mut() {
            if last.role == MessageRole::Assistant {
                last.content.push_str(text);
            }
        }
    }

    fn append_open_tool_call(&mut self, tool_call_id: String, name: String, args: Option<String>) {
        if let Some(last) = self.messages.last_mut() {
            if last.role == MessageRole::Assistant {
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
    }

    fn drop_open_assistant(&mut self) {
        if self.has_open_assistant {
            if let Some(last) = self.messages.last() {
                if last.role == MessageRole::Assistant {
                    self.messages.pop();
                }
            }
            self.has_open_assistant = false;
        }
    }

    fn seal_open_assistant(&mut self) {
        if let Some(last) = self.messages.last_mut() {
            if last.role == MessageRole::Assistant {
                // 如果没有任何 tool_calls，将字段重置为 None
                if let Some(arr) = last.tool_calls.as_ref().and_then(|v| v.as_array()) {
                    if arr.is_empty() {
                        last.tool_calls = None;
                    }
                }
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

/// 原生单步事件折叠状态机
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

    /// 释放暂存队列（对齐 TS flushDeferred）
    fn flush_deferred(&mut self) {
        if !self.pending.is_empty() || self.deferred.is_empty() {
            return;
        }
        for (role, content) in self.deferred.drain(..) {
            self.sink.push_message(role, content);
        }
    }

    /// 悬挂工具中断关闭自愈（对齐 TS closePending）
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

    /// 结算当前开放步（对齐 TS settleOpen）
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

    /// 校验是否接受指定 step 的事件（对齐 TS acceptsOpenStep）
    fn accepts_open_step(&mut self, step_uuid: &str) -> bool {
        match self.open_step_uuid.as_deref() {
            None => false,
            Some(active) => active == step_uuid,
        }
    }

    /// 追加外部输入消息（如用户插话或系统注入，对齐 TS appendMessage）
    pub fn append_message(&mut self, role: MessageRole, content: String) {
        if !self.pending.is_empty() {
            // 处于等待工具返回期间，暂存进入 deferred 队列保序
            self.deferred.push((role, content));
            return;
        }
        self.sink.push_message(role, content);
    }

    /// 处理流式底层录制事件（对齐 TS loopEvent）
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
                // 对齐 TS 第 155 行：interrupted 或 error 时保留 openStepUuid，等待后续恢复，不触发结算
                if let Some(ref r) = finish_reason {
                    if r == "interrupted" || r == "error" {
                        return;
                    }
                }
                self.settle_open();
                self.flush_deferred();
            }
            LoopRecordedEvent::ContentPart { step_uuid, text, is_vacuous } => {
                if !self.accepts_open_step(&step_uuid) {
                    return;
                }
                self.sink.append_open_content(&text);
                self.open_vacuous = self.open_vacuous && is_vacuous;
            }
            LoopRecordedEvent::ToolCall { step_uuid, tool_call_id, name, arguments } => {
                if !self.accepts_open_step(&step_uuid) {
                    return;
                }
                self.sink.append_open_tool_call(tool_call_id.clone(), name, arguments);
                self.pending.insert(tool_call_id);
                self.open_has_tool_calls = true;
            }
            LoopRecordedEvent::ToolResult { tool_call_id, output, is_error, .. } => {
                if !self.pending.remove(&tool_call_id) {
                    return;
                }
                self.sink.push_tool_message(tool_call_id, output, is_error);
                self.flush_deferred();
            }
        }
    }

    /// 会话结算收尾（对齐 TS settle）
    pub fn settle(&mut self) {
        self.settle_open();
    }

    /// 重置状态机（对齐 TS reset）
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

        // 1. 用户提问
        fold.append_message(MessageRole::User, "Calculate 1 + 1".into());

        // 2. 步骤开始
        fold.loop_event(LoopRecordedEvent::StepBegin {
            uuid: "step_1".into(),
            turn_id: Some("turn_1".into()),
            step: Some(1),
        });

        // 3. 模型流式输出文字 + 工具调用
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

        // 4. 用户在此刻插话 -> 必须被暂存
        fold.append_message(MessageRole::User, "Hurry up".into());

        // 5. 工具结果返回
        fold.loop_event(LoopRecordedEvent::ToolResult {
            tool_call_id: "calc_call_1".into(),
            output: "2".into(),
            is_error: false,
            note: None,
        });

        // 6. 步骤结束
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

        // 关键断言：Tool 消息必须紧跟 Assistant，Hurry up 必须在工具结果之后！
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

        // 仅产生空白占位内容
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
        // 无工具调用且内容为空的空白消息会被过滤丢弃，不保留在历史中
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

        // 意外打断或开始下一个 step
        fold.settle();

        let sink = fold.into_sink();
        let msgs = sink.messages;

        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, MessageRole::Assistant);
        // 关键断言：未决工具必须自动合成中断自愈结果
        assert_eq!(msgs[1].role, MessageRole::Tool);
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("hang_call_1"));
        assert!(msgs[1].content.contains("Tool execution was interrupted"));
    }
}
