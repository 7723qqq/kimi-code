//! Strongly-typed event definitions for kimi-agent.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rpc::types::TokenUsage;

/// Engine lifecycle and streaming events emitted during a turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    #[serde(rename = "llm.step.begin")]
    LlmStepBegin { turn_id: String, step: u32 },
    #[serde(rename = "llm.delta")]
    LlmDelta {
        turn_id: String,
        step: u32,
        part: Value,
    },
    #[serde(rename = "llm.step.end")]
    LlmStepEnd {
        turn_id: String,
        step: u32,
        usage: Option<TokenUsage>,
    },
    #[serde(rename = "tool.native")]
    ToolNative {
        turn_id: String,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
        content: String,
        is_error: bool,
        note: Option<String>,
    },
    #[serde(rename = "goal.budget.limit_reached")]
    GoalBudgetLimitReached { turn_id: String, goal_id: String },
    #[serde(rename = "assistant.delta")]
    AssistantDelta {
        agent_id: String,
        turn_id: u64,
        delta: String,
    },
    #[serde(rename = "thinking.delta")]
    ThinkingDelta {
        agent_id: String,
        turn_id: u64,
        delta: String,
    },
    #[serde(rename = "tool.call.delta")]
    ToolCallDelta {
        agent_id: String,
        turn_id: u64,
        tool_call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments_part: Option<String>,
    },
    #[serde(rename = "tool.call.started")]
    ToolCallStarted {
        agent_id: String,
        turn_id: u64,
        tool_call_id: String,
        name: String,
        args: Value,
    },
    #[serde(rename = "tool.progress")]
    ToolProgress {
        agent_id: String,
        turn_id: u64,
        tool_call_id: String,
        update: Value,
    },
    #[serde(rename = "turn.started")]
    TurnStarted {
        agent_id: String,
        turn_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    #[serde(rename = "turn.ended")]
    TurnEnded {
        agent_id: String,
        turn_id: u64,
        reason: String,
    },
    #[serde(rename = "event.session.status_changed")]
    SessionStatusChanged {
        status: String,
        previous_status: String,
    },
    #[serde(rename = "event.session.work_changed")]
    SessionWorkChanged {
        busy: bool,
        main_turn_active: bool,
        pending_interaction: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_turn_reason: Option<String>,
    },
    #[serde(rename = "tool.call.completed")]
    ToolCallCompleted {
        agent_id: String,
        turn_id: u64,
        tool_call_id: String,
        result: Value,
    },
    #[serde(rename = "tool.call.failed")]
    ToolCallFailed {
        agent_id: String,
        turn_id: u64,
        tool_call_id: String,
        error: String,
    },
    #[serde(rename = "session.meta.updated")]
    SessionMetaUpdated {
        session_id: String,
        meta: Value,
    },
    #[serde(rename = "event.config.updated")]
    ConfigUpdated {
        config: Value,
    },
    #[serde(rename = "subagent.spawned")]
    SubagentSpawned {
        agent_id: String,
        parent_agent_id: String,
        profile_name: String,
    },
    #[serde(rename = "subagent.completed")]
    SubagentCompleted {
        agent_id: String,
        summary: String,
    },
    #[serde(rename = "subagent.failed")]
    SubagentFailed {
        agent_id: String,
        error: String,
    },
    #[serde(untagged)]
    Custom(Value),
}

impl EngineEvent {
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub fn from_json(value: Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or(EngineEvent::Custom(value))
    }

    pub fn event_type(&self) -> &str {
        match self {
            EngineEvent::LlmStepBegin { .. } => "llm.step.begin",
            EngineEvent::LlmDelta { .. } => "llm.delta",
            EngineEvent::LlmStepEnd { .. } => "llm.step.end",
            EngineEvent::ToolNative { .. } => "tool.native",
            EngineEvent::GoalBudgetLimitReached { .. } => "goal.budget.limit_reached",
            EngineEvent::AssistantDelta { .. } => "assistant.delta",
            EngineEvent::ThinkingDelta { .. } => "thinking.delta",
            EngineEvent::ToolCallDelta { .. } => "tool.call.delta",
            EngineEvent::ToolCallStarted { .. } => "tool.call.started",
            EngineEvent::ToolProgress { .. } => "tool.progress",
            EngineEvent::TurnStarted { .. } => "turn.started",
            EngineEvent::TurnEnded { .. } => "turn.ended",
            EngineEvent::SessionStatusChanged { .. } => "event.session.status_changed",
            EngineEvent::SessionWorkChanged { .. } => "event.session.work_changed",
            EngineEvent::ToolCallCompleted { .. } => "tool.call.completed",
            EngineEvent::ToolCallFailed { .. } => "tool.call.failed",
            EngineEvent::SessionMetaUpdated { .. } => "session.meta.updated",
            EngineEvent::ConfigUpdated { .. } => "event.config.updated",
            EngineEvent::SubagentSpawned { .. } => "subagent.spawned",
            EngineEvent::SubagentCompleted { .. } => "subagent.completed",
            EngineEvent::SubagentFailed { .. } => "subagent.failed",
            EngineEvent::Custom(v) => v.get("type").and_then(|t| t.as_str()).unwrap_or("custom"),
        }
    }
}
