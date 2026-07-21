//! Core types used across the agent turn processing pipeline.
//!
//! This module defines the key data structures for model interactions,
//! tool routing, turn context, and error handling.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("turn aborted")]
    TurnAborted,
    #[error("stream closed prematurely: {0}")]
    StreamClosed(String),
    #[error("invalid image detected")]
    InvalidImage,
    #[error("context window exceeded")]
    ContextWindowExceeded,
    #[error("usage limit reached: {0}")]
    UsageLimitReached(String),
    #[error("tool execution error: {0}")]
    ToolError(String),
    #[error("internal agent error: {0}")]
    Internal(String),
    #[error("retryable stream error: {0}")]
    Retryable(String),
}

impl AgentError {
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Retryable(_))
    }
}

pub type AgentResult<T> = Result<T, AgentError>;

#[derive(Clone, Debug)]
pub struct Prompt {
    pub input: Vec<ResponseItem>,
    pub tools: Vec<ToolSpec>,
    pub parallel_tool_calls: bool,
    pub base_instructions: BaseInstructions,
    pub personality: Option<String>,
    pub output_schema: Option<serde_json::Value>,
    pub output_schema_strict: bool,
}

#[derive(Clone, Debug, Default)]
pub struct BaseInstructions {
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Option<serde_json::Value>,
}

#[derive(Clone, Debug)]
pub enum ResponseItem {
    Message {
        role: String,
        content: Vec<ContentItem>,
        phase: Option<MessagePhase>,
    },
    FunctionCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    FunctionCallOutput {
        call_id: String,
        output: String,
    },
    Reasoning {
        summary: Vec<ReasoningSummary>,
        content: Vec<ReasoningContent>,
    },
    CustomToolCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    LocalShellCall {
        call_id: String,
        command: String,
    },
    Other,
}

#[derive(Clone, Debug)]
pub enum ContentItem {
    InputText { text: String },
    OutputText { text: String },
    Image { url: Option<String> },
    LocalImage { path: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessagePhase {
    Default,
    Commentary,
}

#[derive(Clone, Debug)]
pub struct ReasoningSummary {
    pub text: String,
    pub summary_index: u32,
}

#[derive(Clone, Debug)]
pub struct ReasoningContent {
    pub text: String,
    pub content_index: u32,
}

#[derive(Clone, Debug)]
pub enum TurnInput {
    UserInput {
        content: Vec<UserInputItem>,
        client_id: Option<String>,
    },
    ResponseItem(ResponseItem),
}

#[derive(Clone, Debug)]
pub enum UserInputItem {
    Text { text: String },
    Image { url: String },
    LocalImage { path: String },
}

#[derive(Debug)]
pub struct SamplingRequestResult {
    pub needs_follow_up: bool,
    pub last_agent_message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PreviousTurnSettings {
    pub model: String,
    pub comp_hash: Option<String>,
    pub realtime_active: Option<bool>,
}

pub struct TurnContext {
    pub sub_id: String,
    pub model_info: ModelInfo,
    pub comp_hash: Option<String>,
    pub cwd: PathBuf,
    pub apps_enabled: bool,
    pub plan_mode: bool,
    pub realtime_active: bool,
    pub auto_compact_token_limit_scope: AutoCompactTokenLimitScope,
    pub auto_compact_token_limit: Option<i64>,
    pub auto_compact_scope_limit: i64,
    pub current_date: Option<String>,
    pub timezone: Option<String>,
    pub cancellation_token: CancellationToken,
    pub server_model_warning_emitted: AtomicBool,
    pub model_verification_emitted: AtomicBool,
}

impl std::fmt::Debug for TurnContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnContext")
            .field("sub_id", &self.sub_id)
            .field("model_info", &self.model_info)
            .field("cwd", &self.cwd)
            .field("apps_enabled", &self.apps_enabled)
            .field("plan_mode", &self.plan_mode)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct ModelInfo {
    pub slug: String,
    pub provider: String,
    pub context_window: Option<i64>,
    pub effective_context_window_percent: i64,
    pub supports_parallel_tool_calls: bool,
    pub input_modalities: Vec<String>,
    pub supports_reasoning_summaries: bool,
    pub default_reasoning_effort: Option<String>,
}

impl ModelInfo {
    pub fn resolved_context_window(&self) -> Option<i64> {
        self.context_window.map(|cw| {
            cw.saturating_mul(self.effective_context_window_percent) / 100
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoCompactTokenLimitScope {
    Total,
    BodyAfterPrefix,
}

#[derive(Debug)]
pub struct AutoCompactTokenStatus {
    pub active_context_tokens: i64,
    pub auto_compact_scope_tokens: i64,
    pub auto_compact_scope_limit: i64,
    pub full_context_window_limit: Option<i64>,
    pub auto_compact_window_prefill_tokens: Option<i64>,
    pub full_context_window_limit_reached: bool,
    pub token_limit_reached: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactionReason {
    ContextLimit,
    CompHashChanged,
    ModelDownshift,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactionPhase {
    PreTurn,
    MidTurn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitialContextInjection {
    DoNotInject,
    BeforeLastUserMessage,
}

pub struct ToolRouter {
    specs: Vec<ToolSpec>,
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
}

impl ToolRouter {
    pub fn new() -> Self {
        Self {
            specs: Vec::new(),
            handlers: HashMap::new(),
        }
    }

    pub fn add_tool(&mut self, spec: ToolSpec, handler: Arc<dyn ToolHandler>) {
        self.specs.push(spec);
        self.handlers.insert(
            self.specs.last().unwrap().name.clone(),
            handler,
        );
    }

    pub fn model_visible_specs(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }

    pub fn handler_for(&self, name: &str) -> Option<&Arc<dyn ToolHandler>> {
        self.handlers.get(name)
    }
}

impl std::fmt::Debug for ToolRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolRouter")
            .field("specs_count", &self.specs.len())
            .finish()
    }
}

#[async_trait::async_trait]
pub trait ToolHandler: Send + Sync + std::fmt::Debug {
    async fn execute(
        &self,
        call_id: &str,
        arguments: &serde_json::Value,
        context: &TurnContext,
    ) -> AgentResult<String>;
}

#[async_trait::async_trait]
pub trait AgentSession: Send + Sync {
    async fn get_total_token_usage(&self) -> i64;
    async fn get_estimated_token_count(&self, context: &TurnContext) -> Option<i64>;
    async fn clone_history_for_prompt(&self, modalities: &[String]) -> Vec<ResponseItem>;
    async fn get_base_instructions(&self) -> BaseInstructions;
    async fn get_pending_input(&self) -> Vec<TurnInput>;
    async fn has_pending_input(&self) -> bool;
    async fn build_tools(
        &self,
        context: &TurnContext,
    ) -> AgentResult<Arc<ToolRouter>>;
    async fn record_conversation_items(
        &self,
        context: &TurnContext,
        items: &[ResponseItem],
    );
    async fn previous_turn_settings(&self) -> Option<PreviousTurnSettings>;
    async fn set_previous_turn_settings(&self, settings: Option<PreviousTurnSettings>);
    async fn emit_event(
        &self,
        context: &TurnContext,
        event: AgentEvent,
    );
    async fn record_turn_error(&self, context: &TurnContext, error: &AgentError);
    async fn auto_compact_window_snapshot(&self) -> AutoCompactWindowSnapshot;
    async fn set_total_tokens_full(&self, context: &TurnContext);
    async fn update_rate_limits(&self, context: &TurnContext, limits: RateLimits);
    async fn handle_retryable_stream_error(
        &self,
        error: AgentError,
        retry_count: &mut u32,
        max_retries: u32,
    ) -> AgentResult<()>;
    async fn run_auto_compact(
        &self,
        context: &TurnContext,
        initial_context_injection: InitialContextInjection,
        reason: CompactionReason,
        phase: CompactionPhase,
    ) -> AgentResult<()>;
    async fn has_pending_mailbox_items(&self) -> bool;
}

#[derive(Clone, Debug, Default)]
pub struct AutoCompactWindowSnapshot {
    pub prefill_input_tokens: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct RateLimits {
    pub max_requests: Option<u32>,
    pub remaining_requests: Option<u32>,
    pub reset_seconds: Option<u64>,
    pub max_tokens: Option<u64>,
    pub remaining_tokens: Option<u64>,
}

#[derive(Clone, Debug)]
pub enum AgentEvent {
    TurnStarted { turn_id: String },
    TurnComplete { turn_id: String, message: Option<String> },
    TurnAborted { turn_id: String, reason: Option<String> },
    TokenCount { total_tokens: i64, turn_tokens: i64 },
    Warning { message: String },
    Error { message: String },
    ToolCallBegin { tool_name: String, call_id: String },
    ToolCallEnd { tool_name: String, call_id: String, success: bool },
    ContentDelta { item_id: String, delta: String },
    ItemStarted { item_id: String, item_type: String },
    ItemCompleted { item_id: String },
    ContextCompacted { token_count: i64 },
}

pub fn reasoning_effort_for_tracing(
    effort: Option<&str>,
    default_level: Option<&str>,
) -> String {
    effort
        .or(default_level)
        .map(|s| s.to_string())
        .unwrap_or_else(|| "default".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_error_retryable() {
        assert!(!AgentError::TurnAborted.is_retryable());
        assert!(!AgentError::StreamClosed("test".into()).is_retryable());
        assert!(AgentError::Retryable("test".into()).is_retryable());
    }

    #[test]
    fn test_model_info_resolved_context_window() {
        let info = ModelInfo {
            slug: "test-model".into(),
            provider: "test".into(),
            context_window: Some(100_000),
            effective_context_window_percent: 80,
            supports_parallel_tool_calls: true,
            input_modalities: vec!["text".into()],
            supports_reasoning_summaries: false,
            default_reasoning_effort: None,
        };
        assert_eq!(info.resolved_context_window(), Some(80_000));
    }

    #[test]
    fn test_model_info_no_context_window() {
        let info = ModelInfo {
            slug: "test-model".into(),
            provider: "test".into(),
            context_window: None,
            effective_context_window_percent: 80,
            supports_parallel_tool_calls: false,
            input_modalities: vec!["text".into()],
            supports_reasoning_summaries: false,
            default_reasoning_effort: None,
        };
        assert_eq!(info.resolved_context_window(), None);
    }

    #[test]
    fn test_auto_compact_token_status_token_limit_reached() {
        let status = AutoCompactTokenStatus {
            active_context_tokens: 900,
            auto_compact_scope_tokens: 500,
            auto_compact_scope_limit: 500,
            full_context_window_limit: None,
            auto_compact_window_prefill_tokens: None,
            full_context_window_limit_reached: false,
            token_limit_reached: true,
        };
        assert!(status.token_limit_reached);
    }

    #[test]
    fn test_tool_router_empty() {
        let router = ToolRouter::new();
        assert!(router.model_visible_specs().is_empty());
        assert!(router.handler_for("nonexistent").is_none());
    }
}
