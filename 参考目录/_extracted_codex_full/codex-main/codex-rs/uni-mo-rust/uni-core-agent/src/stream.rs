//! Stream processing utilities for the agent turn loop.
//!
//! Handles parsing of streaming model output, including assistant text deltas,
//! plan-mode segments, reasoning content, and tool call argument diffs.

use crate::types::{
    AgentError, AgentEvent, AgentResult, AgentSession, ContentItem,
    MessagePhase, ResponseItem, SamplingRequestResult, TurnContext,
};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tracing::{instrument, trace};

#[derive(Clone, Debug)]
pub enum StreamEvent {
    Created,
    OutputItemAdded(ResponseItem),
    OutputItemDone(ResponseItem),
    OutputTextDelta(String),
    ToolCallInputDelta {
        item_id: Option<String>,
        call_id: Option<String>,
        delta: String,
    },
    ReasoningSummaryDelta {
        delta: String,
        summary_index: u32,
    },
    ReasoningSummaryPartAdded { summary_index: u32 },
    ReasoningContentDelta {
        delta: String,
        content_index: u32,
    },
    Completed {
        token_usage: Option<TokenUsage>,
        end_turn: Option<bool>,
    },
    RateLimits(crate::types::RateLimits),
    ServerModel(String),
    ModelVerifications(Vec<String>),
    TurnModerationMetadata(String),
    ServerReasoningIncluded(bool),
    ModelsEtag(String),
}

#[derive(Clone, Debug, Default)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: Option<i64>,
    pub reasoning_output_tokens: Option<i64>,
}
