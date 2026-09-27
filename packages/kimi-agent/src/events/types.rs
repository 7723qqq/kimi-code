//! Strongly-typed event definitions for kimi-agent.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rpc::types::TokenUsage;

/// Engine lifecycle and streaming events emitted during a turn.
///
/// Every event a turn produces carries the `agent_id` of the agent running it
/// (v2: `turnEvents.ts` gives `agentId` to each `TurnStartedPayload` /
/// `AssistantDeltaPayload` / `ToolCallStartedPayload`, and
/// `loopService.ts:1426-1455` fills it from `this.scopeContext.agentId`).
/// That field is what lets a host keep a subagent's events out of the main
/// transcript — v2 additionally refuses a cross-agent dispatch outright
/// (`eventDispatcherService.ts:502-510`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    #[serde(rename = "llm.step.begin")]
    LlmStepBegin {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        step: u32,
    },
    #[serde(rename = "llm.delta")]
    LlmDelta {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        step: u32,
        part: Value,
    },
    #[serde(rename = "llm.step.end")]
    LlmStepEnd {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        step: u32,
        usage: Option<TokenUsage>,
        /// Per-request LLM timing (v2 `ModelRequestTiming`, upstream #3938).
        /// Absent on the host-proxy path and from transports that do not
        /// measure.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timing: Option<crate::llm::LlmTiming>,
    },
    #[serde(rename = "tool.native")]
    ToolNative {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
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
    /// A scheduled cron entry fired (v2 `cron.fired`). The host subscribes
    /// and turns the fired prompt into a new turn or surfaces it to the user.
    /// Wire shape carries the entry id and prompt so the host can render or
    /// route without a separate fetch.
    #[serde(rename = "cron.fired")]
    CronFired { entry_id: String, prompt: String },
    #[serde(rename = "assistant.delta")]
    AssistantDelta {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        delta: String,
    },
    #[serde(rename = "thinking.delta")]
    ThinkingDelta {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        delta: String,
    },
    #[serde(rename = "tool.call.delta")]
    ToolCallDelta {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        tool_call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments_part: Option<String>,
    },
    #[serde(rename = "tool.call.started")]
    ToolCallStarted {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        tool_call_id: String,
        name: String,
        args: Value,
    },
    #[serde(rename = "tool.progress")]
    ToolProgress {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        tool_call_id: String,
        update: Value,
    },
    #[serde(rename = "turn.started")]
    TurnStarted {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    #[serde(rename = "turn.ended")]
    TurnEnded {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
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
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        tool_call_id: String,
        result: Value,
    },
    #[serde(rename = "tool.call.failed")]
    ToolCallFailed {
        #[serde(default = "crate::rpc::types::main_agent_id")]
        agent_id: String,
        turn_id: String,
        tool_call_id: String,
        error: String,
    },
    #[serde(rename = "session.meta.updated")]
    SessionMetaUpdated { session_id: String, meta: Value },
    /// A config mutation the server applied (kap-server `ConfigChangedEvent`,
    /// wire name `event.config.changed`). The payload spells
    /// `changed_fields` — snake_case, what kimi-web's mapper reads; kap-server's
    /// own zod schema says `changedFields`, so the two TS sides disagree and the
    /// live consumer wins.
    #[serde(rename = "event.config.changed")]
    ConfigChanged {
        /// The config sections the mutation touched (kap-server `changedFields`).
        changed_fields: Vec<String>,
        /// The effective config after the mutation (kap-server `ConfigResponse`).
        config: Value,
    },
    #[serde(rename = "subagent.spawned")]
    SubagentSpawned {
        subagent_id: String,
        #[serde(default)]
        subagent_name: Option<String>,
        /// The parent tool call that spawned the member (v2
        /// `SubagentSpawnedPayload.parentToolCallId`, upstream #3970) — the
        /// transcript fold keys the agent↔task association off it.
        #[serde(default)]
        parent_tool_call_id: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        run_in_background: bool,
    },
    #[serde(rename = "subagent.completed")]
    SubagentCompleted {
        subagent_id: String,
        #[serde(default)]
        result_summary: Option<String>,
        /// The member's token usage (upstream #3970): the durable record
        /// carries it and the fold restores it onto the task.
        #[serde(default)]
        usage: Option<TokenUsage>,
    },
    #[serde(rename = "subagent.failed")]
    SubagentFailed { subagent_id: String, error: String },
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
            EngineEvent::ConfigChanged { .. } => "event.config.changed",
            EngineEvent::SubagentSpawned { .. } => "subagent.spawned",
            EngineEvent::SubagentCompleted { .. } => "subagent.completed",
            EngineEvent::SubagentFailed { .. } => "subagent.failed",
            EngineEvent::CronFired { .. } => "cron.fired",
            EngineEvent::Custom(v) => v.get("type").and_then(|t| t.as_str()).unwrap_or("custom"),
        }
    }

    /// The agent that produced this event, when it names one.
    ///
    /// v2 reads the same field off the payload when filtering
    /// (`sessionEventBroadcaster.ts:1211-1214` takes `payload.agentId` and
    /// passes anything non-string through). A `Custom` event that predates
    /// the stamp has no id, and is treated the same way there.
    pub fn agent_id(&self) -> Option<&str> {
        match self {
            EngineEvent::LlmStepBegin { agent_id, .. }
            | EngineEvent::LlmDelta { agent_id, .. }
            | EngineEvent::LlmStepEnd { agent_id, .. }
            | EngineEvent::ToolNative { agent_id, .. }
            | EngineEvent::AssistantDelta { agent_id, .. }
            | EngineEvent::ThinkingDelta { agent_id, .. }
            | EngineEvent::ToolCallDelta { agent_id, .. }
            | EngineEvent::ToolCallStarted { agent_id, .. }
            | EngineEvent::ToolProgress { agent_id, .. }
            | EngineEvent::TurnStarted { agent_id, .. }
            | EngineEvent::TurnEnded { agent_id, .. }
            | EngineEvent::ToolCallCompleted { agent_id, .. }
            | EngineEvent::ToolCallFailed { agent_id, .. } => Some(agent_id.as_str()),
            EngineEvent::Custom(value) => value.get("agent_id").and_then(|v| v.as_str()),
            _ => None,
        }
    }
}
