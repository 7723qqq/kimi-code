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
            EngineEvent::Custom(v) => v.get("type").and_then(|t| t.as_str()).unwrap_or("custom"),
        }
    }
}
