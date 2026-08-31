//! JSON-RPC 2.0 protocol types for kimi-agent stdio communication.
//!
//! The agent process speaks JSON-RPC 2.0 over stdio:
//! - Reads JSON-RPC requests from stdin
//! - Writes JSON-RPC responses (and notifications) to stdout
//! - Uses stderr for logging/diagnostics

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

/// A boxed future type alias for async handlers.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ── JSON-RPC 2.0 base types ────────────────────────────────────────────────

/// Unique identifier for a JSON-RPC request.
pub type RequestId = serde_json::Value;

/// A JSON-RPC 2.0 request.
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A JSON-RPC 2.0 response (success).
#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    pub result: serde_json::Value,
}

/// A JSON-RPC 2.0 error response.
#[derive(Debug, Serialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    pub error: JsonRpcError,
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for JsonRpcError {}

/// A JSON-RPC 2.0 notification (no response expected).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

// ── Agent RPC method names ─────────────────────────────────────────────────

/// RPC method names for the kimi-agent protocol.
pub mod methods {
    /// Run a single turn. Corresponds to `runTurn()` in the JS loop.
    pub const RUN_TURN: &str = "agent/run_turn";

    /// Cancel a running turn.
    pub const CANCEL_TURN: &str = "agent/cancel_turn";

    /// Health check.
    pub const HEALTH: &str = "agent/health";

    /// Shutdown the agent process.
    pub const SHUTDOWN: &str = "agent/shutdown";

    /// LLM chat request (Rust → JS host proxy).
    pub const HOST_LLM_CHAT: &str = "host/llm_chat";

    /// Execute a tool call (Rust → JS host proxy).
    pub const HOST_EXECUTE_TOOL: &str = "host/execute_tool";

    /// Permission check for native execution of a mutating tool
    /// (Rust → JS host). The host stays the permission authority; a deny
    /// answer makes the engine return the denial as the tool result
    /// instead of executing (natively or via the host).
    pub const HOST_CHECK_PERMISSION: &str = "host/check_permission";

    /// Finalize a natively-executed tool result (Rust → JS host). The host
    /// applies its own result policy — truncation and spill-to-disk — and
    /// returns what the model should see.
    pub const HOST_FINALIZE_TOOL_RESULT: &str = "host/finalize_tool_result";

    /// Release queued mid-turn steering to the engine (Rust → JS host). The
    /// host owns the turn's step-request queue, so without this call a prompt
    /// the user injected during a turn would only reach the model after the
    /// engine's turn ended. The host records each steer and returns the
    /// messages the engine should append to its own history.
    pub const HOST_DRAIN_STEERS: &str = "host/drain_steers";

    /// Fire-and-forget event notification (Rust → JS host).
    /// Used by the native LLM / native tool paths to report step
    /// boundaries, streaming deltas, and natively-executed tool results
    /// so the host can record them in the transcript.
    pub const HOST_EVENT: &str = "host/event";

    /// Ask the host an interactive question and wait for a human answer
    /// (Rust → JS host). The host owns the interaction runtime — pending
    /// key, dismiss, turn-end cancellation — and answers with the v2
    /// `QuestionResult` three states (answered / dismissed / cancelled).
    pub const HOST_ASK_QUESTION: &str = "host/ask_question";

    /// Read host-owned durable state (Rust → JS host). The engine's native
    /// todo/plan tools read through this seam; the host stays the
    /// persistence and undo authority.
    pub const HOST_STATE_READ: &str = "host/state_read";

    /// Write host-owned durable state (Rust → JS host). The host applies
    /// its domain semantics (re-normalization, undoable events) and returns
    /// the resulting state.
    pub const HOST_STATE_WRITE: &str = "host/state_write";
}

/// Permission check for a mutating tool call the engine wants to execute
/// natively. Sent to the host before running the tool; the host applies its
/// full permission machinery (mode, rules, policies, interactive approval).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionCheckRequest {
    pub tool_name: String,
    pub tool_call_id: String,
    pub arguments: serde_json::Value,
}

/// A tool result the engine executed in-process, handed to the host for
/// finalization before it enters the model context. The host owns result
/// truncation and spill-to-disk, so a large native result must go through the
/// same policy a host-executed result does; the response is what the model
/// actually sees.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFinalizeRequest {
    pub tool_name: String,
    pub tool_call_id: String,
    pub content: String,
    pub is_error: bool,
    #[serde(default)]
    pub note: Option<String>,
}

/// The host's permission verdict for a [`PermissionCheckRequest`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDecision {
    /// `"allow"` or `"deny"`.
    pub decision: String,
    #[serde(default)]
    pub reason: Option<String>,
}

impl PermissionDecision {
    pub fn allow() -> Self {
        Self {
            decision: "allow".into(),
            reason: None,
        }
    }

    pub fn is_allow(&self) -> bool {
        self.decision.eq_ignore_ascii_case("allow")
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            decision: "deny".into(),
            reason: Some(reason.into()),
        }
    }
}

// ── Reverse interaction types (Rust → JS host) ─────────────────────────────

/// An interactive question the engine asks the host, answered by a human.
/// Mirrors the v2 `QuestionItem` shape: 1–4 questions, each with 2–4
/// options and an optional multi-select flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskQuestionRequest {
    /// Engine-generated unique id (`question_<uuid>`); the host keys its
    /// pending interaction on it and echoes it back in the response.
    pub question_id: String,
    /// Turn the question belongs to; the host cancels pending questions by
    /// turn when the turn ends.
    pub turn_id: String,
    /// Tool call the question answers; lets the UI associate it with the
    /// tool card.
    pub tool_call_id: String,
    /// `true` = background question: the host registers a background task
    /// and returns its task_id immediately instead of waiting for a human.
    #[serde(default)]
    pub background: bool,
    /// Optional wait bound. `None` = wait indefinitely (v2 semantics, human
    /// in the loop — same as a permission check).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 1–4 questions, mirroring v2 `QuestionItem` fields.
    pub questions: Vec<AskQuestionItem>,
}

/// A single question within an [`AskQuestionRequest`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskQuestionItem {
    /// The question text; also the key under which the answer is returned.
    pub question: String,
    /// Short category label (≤12 chars in v2).
    #[serde(default)]
    pub header: Option<String>,
    /// 2–4 options; labels are unique within a question.
    pub options: Vec<AskQuestionOption>,
    /// `true` = the user may pick several options (answers are
    /// comma-separated labels).
    #[serde(default)]
    pub multi_select: bool,
}

/// A selectable option within an [`AskQuestionItem`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskQuestionOption {
    pub label: String,
    /// Optional explanatory text shown under the label.
    #[serde(default)]
    pub description: Option<String>,
}

/// The host's answer to an [`AskQuestionRequest`]. Mirrors the v2
/// `QuestionResult` three states: answered (`answers` + optional `method`),
/// dismissed (empty `answers` + `note`), or cancelled (`cancelled` +
/// `reason`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskQuestionResponse {
    /// `question text → answer` (multi-select answers are comma-separated
    /// labels; "Other" carries the user's free text).
    #[serde(default)]
    pub answers: std::collections::HashMap<String, String>,
    /// How the user answered: `"enter"` / `"space"` / `"number_key"`.
    #[serde(default)]
    pub method: Option<String>,
    /// Present when the user dismissed the question without answering.
    #[serde(default)]
    pub note: Option<String>,
    /// `true` when the interaction was cancelled (turn ended, agent closed,
    /// or timeout).
    #[serde(default)]
    pub cancelled: Option<bool>,
    /// Cancellation reason: `turn_ended` / `agent_closed` / `timeout`.
    #[serde(default)]
    pub reason: Option<String>,
}

/// A state read request (Rust → JS host). The engine's native todo/plan
/// tools read host-owned durable state through this seam; the host stays
/// the persistence and undo authority.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateReadRequest {
    /// State domain discriminator: `"todo"` / `"plan"` (future `"goal"` /
    /// `"cron"` / `"task"`). Unknown domains map to `-32001`.
    pub domain: String,
    /// Key within the domain. First version always equals the domain;
    /// unknown keys map to `-32002`.
    pub key: String,
    /// Optional provenance; the host may ignore it.
    #[serde(default)]
    pub turn_id: String,
    /// Optional provenance; the host may ignore it.
    #[serde(default)]
    pub tool_call_id: String,
}

/// The host's answer to a [`StateReadRequest`]: the domain wire value,
/// opaque JSON serialized by the host (todo: `TodoItem[]`; plan:
/// `{active, id?, path?}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateReadResponse {
    pub value: serde_json::Value,
}

/// A state write request (Rust → JS host). The engine submits a domain
/// wire value; the host re-normalizes it (authoritative) and applies its
/// domain semantics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateWriteRequest {
    /// State domain discriminator, same as [`StateReadRequest::domain`].
    pub domain: String,
    /// Key within the domain, same as [`StateReadRequest::key`].
    pub key: String,
    /// Domain wire value. todo: `TodoItem[]`; plan: `{active: true}` =
    /// enter, `{active: false}` = exit.
    pub value: serde_json::Value,
    /// The engine's undo-semantics declaration for this write. The host is
    /// authoritative and may ignore it (todo/plan are always undoable).
    pub undoable: bool,
    /// Optional provenance; the host may ignore it.
    #[serde(default)]
    pub turn_id: String,
    /// Optional provenance; the host may ignore it.
    #[serde(default)]
    pub tool_call_id: String,
}

/// The host's answer to a [`StateWriteRequest`]: `ok` plus the result
/// state after domain semantics were applied (may differ from the
/// submitted value — todo ids filled in, plan id/path attached).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateWriteResponse {
    pub ok: bool,
    pub value: serde_json::Value,
}

// ── Message content blocks (multimodal) ─────────────────────────────────

/// A single content block within a message. Text-only messages keep using
/// the plain `content` string; multimodal messages carry ordered blocks in
/// addition (blocks win over `content` when non-empty).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Plain text.
    Text { text: String },
    /// Base64-encoded image data with a MIME media type (e.g. `image/png`).
    Image { media_type: String, data: String },
    /// Image referenced by URL (https or data URL).
    ImageUrl { url: String },
    /// Audio referenced by URL, with an optional provider-side id.
    AudioUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Video referenced by URL, with an optional provider-side id.
    VideoUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
}

// ── Native LLM configuration (Rust-side HTTP transport) ───────────────────

/// Configuration for the native HTTP LLM transport. When present on
/// `RunTurnParams`, the Rust engine calls the provider directly over
/// HTTP with SSE streaming instead of proxying `llm_chat` to the JS host.
#[derive(Clone, Deserialize)]
pub struct NativeLlmConfig {
    /// Wire protocol: `"openai"` (Chat Completions) or `"anthropic"` (Messages).
    pub protocol: String,
    /// API base URL including the version segment (e.g. `https://api.example.com/v1`).
    pub base_url: String,
    /// Bearer token (OpenAI) or x-api-key (Anthropic).
    pub api_key: String,
    /// Model name sent to the provider.
    pub model: String,
    /// `max_tokens` for the Anthropic Messages API (required there).
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Extra headers sent with every request.
    #[serde(default)]
    pub custom_headers: std::collections::HashMap<String, String>,
}

/// Debug never renders the key: this struct is `{:?}`-formatted on paths that
/// reach logs and transcripts, and one accidental log line would publish the
/// credential there.
impl std::fmt::Debug for NativeLlmConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeLlmConfig")
            .field("protocol", &self.protocol)
            .field("base_url", &self.base_url)
            .field("api_key", &"[redacted]")
            .field("model", &self.model)
            .field("max_tokens", &self.max_tokens)
            .field("custom_headers", &self.custom_headers)
            .finish()
    }
}

// ── RunTurn request/response types ─────────────────────────────────────────

/// Input for a run_turn RPC call.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct RunTurnParams {
    pub turn_id: String,
    pub system_prompt: String,
    pub model_name: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
    /// Step cap for the turn loop. `None` = unbounded (JS-loop semantics).
    pub max_steps: Option<u32>,
    /// Multiple LLM providers for concurrent execution (MultiLLM).
    /// When present, overrides `system_prompt` + `model_name`.
    #[serde(default)]
    pub providers: Vec<LlmProviderDef>,
    /// Optional goal context for budget-aware execution.
    /// When present, the loop checks budgets before each step and
    /// injects steering text into the system prompt.
    #[serde(default)]
    pub goal: Option<crate::turn_loop::types::GoalContext>,
    /// Native HTTP LLM transport. When present, the Rust engine calls the
    /// provider directly (streaming) instead of proxying through the host.
    #[serde(default)]
    pub native_llm: Option<NativeLlmConfig>,
    /// Workspace root used to sandbox native tool execution.
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// When true (and `workspace_root` is set), tools the sandbox can
    /// execute (Read/Grep/Glob/Write/Edit/Bash, each gated on a host
    /// permission grant) run inside the Rust process.
    #[serde(default)]
    pub native_tools: bool,
    /// Rust engine self-contained mode. When true, the engine refuses to
    /// fall back to the host proxy for LLM calls — the caller must set
    /// `native_llm` or `providers`, or the engine returns a JSON-RPC
    /// internal error instead of routing through `host/llm_chat`. See
    /// kimi-agent ROADMAP P26 批 1.
    #[serde(default)]
    pub rust_self_contained: bool,
    /// Host shell for native Bash (bash everywhere, Git Bash on Windows).
    /// Absent on Windows → native Bash stays with the host.
    #[serde(default)]
    pub shell_path: Option<String>,
    /// Optional permission policy snapshot for local evaluation (P26 批 3).
    #[serde(default)]
    pub policy_snapshot: Option<crate::permission::PolicySnapshot>,
    /// Host-resolved `[github]` config credentials for the native GitHub
    /// tools (v2 `configSection.ts`). Env fallbacks are applied Rust-side
    /// (v2 `envOverlay.ts` semantics: config wins, env fills the gap).
    #[serde(default)]
    pub github_token: Option<String>,
    #[serde(default)]
    pub github_base_url: Option<String>,
}

/// LLM provider definition for MultiLLM.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct LlmProviderDef {
    pub name: String,
    pub model: String,
    pub system_prompt: String,
}

/// Input for a cancel_turn RPC call.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct CancelTurnParams {
    pub turn_id: String,
}

/// A message in the conversation history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    /// Optional multimodal content blocks. When non-empty, providers
    /// project these instead of the plain `content` string.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<ContentBlock>,
    /// Tool calls issued by an `assistant` message (empty otherwise).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<LlmToolCall>,
    /// For a `tool` message: the id of the tool call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Tool definition passed from the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub input_schema: serde_json::Value,
}

/// Result of a run_turn RPC call.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunTurnResult {
    pub stop_reason: String,
    pub steps: u32,
    pub usage: TokenUsage,
    /// Host-visible engine events emitted during the turn.
    #[serde(default)]
    pub events_emitted: u32,
    /// LLM retries performed during the turn (attempts beyond the first).
    #[serde(default)]
    pub llm_retries: u32,
    /// Which LLM transport served this turn: `native-http`, `host-proxy`, `multi`.
    #[serde(default)]
    pub llm_transport: String,
    /// Tool calls executed inside the engine; the rest round-tripped to the host.
    #[serde(default)]
    pub native_tool_calls: u32,
}

// ── LLM proxy types (Rust → JS host) ───────────────────────────────────────

/// Parameters for the host/llm_chat RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatRequest {
    pub system_prompt: String,
    pub model_name: String,
    pub messages: Vec<LlmChatMessage>,
    pub tools: Vec<ToolDef>,
    /// Identifies this call so the host can abort it later. Set when the
    /// request is one of several racing providers (MultiLLM); `None` for the
    /// single-provider path, where nothing can lose a race.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// A message in the LLM chat request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatMessage {
    pub role: String,
    pub content: String,
    /// Optional multimodal content blocks (see [`ContentBlock`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<ContentBlock>,
}

/// Response from the host/llm_chat RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatResponse {
    /// Assistant text content. The host proxy path may leave this empty
    /// (the host owns the transcript there); the native HTTP path fills it.
    #[serde(default)]
    pub content: String,
    pub tool_calls: Vec<LlmToolCall>,
    pub finish_reason: Option<String>,
    pub usage: TokenUsage,
}

/// A tool call from the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

// ── Tool execution proxy types (Rust → JS host) ────────────────────────────

/// Parameters for the host/execute_tool RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecuteRequest {
    pub turn_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
}

/// Response from the host/execute_tool RPC call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ToolExecuteResponse {
    pub content: String,
    pub is_error: bool,
    /// Host-notice annotation carried through to the tool result message
    /// (e.g. Read's `<system>…</system>` summary).
    #[serde(default)]
    pub note: Option<String>,
}

/// Token usage tracking.
///
/// Mirrors the host's 4-field `TokenUsage` (inputOther / output /
/// inputCacheRead / inputCacheCreation): `input_tokens` covers non-cached
/// input, and cache hits are reported separately so host-side token
/// accounting stays accurate.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: u32,
    #[serde(default)]
    pub output_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
    /// Prompt tokens served from the provider's cache.
    #[serde(default)]
    pub input_cache_read: u32,
    /// Prompt tokens written into the provider's cache by this call.
    #[serde(default)]
    pub input_cache_creation: u32,
}

/// Health check response.
#[derive(Debug, Serialize)]
pub struct HealthStatus {
    pub status: String,
    pub version: String,
}

// ── Helper functions ───────────────────────────────────────────────────────

impl JsonRpcResponse {
    pub fn ok(id: RequestId, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result,
        }
    }
}

impl JsonRpcErrorResponse {
    pub fn new(id: RequestId, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            error: JsonRpcError {
                code,
                message,
                data: None,
            },
        }
    }
}

impl JsonRpcError {
    pub fn parse_error() -> Self {
        Self {
            code: -32700,
            message: "Parse error".into(),
            data: None,
        }
    }
    pub fn invalid_request() -> Self {
        Self {
            code: -32600,
            message: "Invalid Request".into(),
            data: None,
        }
    }
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("Method not found: {method}"),
            data: None,
        }
    }
    pub fn internal_error(msg: String) -> Self {
        Self {
            code: -32603,
            message: msg,
            data: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_turn_params_serialization() {
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "system_prompt": "You are a helpful assistant.",
            "model_name": "gpt-4",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "tools": [
                {"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}
            ],
            "max_steps": 10
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.turn_id, "turn-1");
        assert_eq!(params.model_name, "gpt-4");
        assert_eq!(params.messages.len(), 1);
        assert_eq!(params.tools.len(), 1);
        assert_eq!(params.max_steps, Some(10));
        assert!(params.providers.is_empty());
    }

    #[test]
    fn test_run_turn_params_with_providers() {
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "system_prompt": "",
            "model_name": "",
            "messages": [],
            "tools": [],
            "providers": [
                {"name": "fast", "model": "gpt-4o-mini", "system_prompt": "You are fast."},
                {"name": "smart", "model": "claude-opus-4", "system_prompt": "You are smart."}
            ]
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.providers.len(), 2);
        assert_eq!(params.providers[0].name, "fast");
        assert_eq!(params.providers[0].model, "gpt-4o-mini");
        assert_eq!(params.providers[1].name, "smart");
    }

    /// Contract fixture (M0, `reports/rust-engine-contract-ownership.md`):
    /// pins the stdio wire shape of the message contract — snake_case field
    /// names, `ContentBlock` tag names, optional-field omission. The TS side
    /// (`rust-loop.ts`) must produce exactly these shapes; a round-trip
    /// mismatch here is a wire break, not a refactor.
    #[test]
    fn test_message_wire_contract_roundtrip() {
        let fixture = serde_json::json!({
            "role": "user",
            "content": "fallback text",
            "blocks": [
                {"type": "text", "text": "hello"},
                {"type": "image", "media_type": "image/png", "data": "aGk="},
                {"type": "image_url", "url": "https://example.com/a.png"},
                {"type": "audio_url", "url": "https://example.com/a.mp3", "id": "aud-1"},
                {"type": "video_url", "url": "https://example.com/a.mp4"}
            ],
            "tool_calls": [
                {"id": "call-1", "name": "Read", "arguments": {"path": "a.rs"}}
            ],
            "tool_call_id": "call-0"
        });
        let message: Message = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(message.role, "user");
        assert_eq!(message.blocks.len(), 5);
        assert_eq!(message.tool_calls.len(), 1);
        let reserialized = serde_json::to_value(&message).unwrap();
        assert_eq!(reserialized, fixture, "wire round-trip must be identity");

        // Optional fields are omitted from the wire when absent.
        let bare: Message = serde_json::from_value(serde_json::json!({
            "role": "assistant", "content": "hi"
        }))
        .unwrap();
        let wire = serde_json::to_value(&bare).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"role": "assistant", "content": "hi"})
        );

        // TokenUsage wire field names (drifted from kosong's camelCase on
        // purpose — the mapping lives in rust-loop.ts).
        let usage: TokenUsage = serde_json::from_value(serde_json::json!({
            "input_tokens": 1, "output_tokens": 2, "total_tokens": 3,
            "input_cache_read": 4, "input_cache_creation": 5
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&usage).unwrap(),
            serde_json::json!({
                "input_tokens": 1, "output_tokens": 2, "total_tokens": 3,
                "input_cache_read": 4, "input_cache_creation": 5
            })
        );
    }

    /// Stdio wire contract for the request/response types crossing the
    /// JSON-RPC boundary (M0 slice 3): snake_case field names, serde
    /// `default` / `skip_serializing_if` behavior pinned. The TS side
    /// (`rust-loop.ts` + `wire-schema.ts`) mirrors these; a round-trip
    /// mismatch here is a wire break, not a refactor.
    #[test]
    fn test_stdio_wire_contract_roundtrip() {
        // LlmChatRequest: request_id serializes only when present.
        let request = LlmChatRequest {
            system_prompt: "sp".into(),
            model_name: "m".into(),
            messages: vec![
                LlmChatMessage {
                    role: "user".into(),
                    content: "hi".into(),
                    blocks: Vec::new(),
                },
                LlmChatMessage {
                    role: "user".into(),
                    content: "see".into(),
                    blocks: vec![ContentBlock::ImageUrl {
                        url: "https://example.com/a.png".into(),
                    }],
                },
            ],
            tools: vec![ToolDef {
                name: "read".into(),
                description: "d".into(),
                input_schema: serde_json::json!({"type": "object"}),
            }],
            request_id: Some("req-1".into()),
        };
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(wire["request_id"], "req-1");
        assert_eq!(wire["messages"][1]["blocks"][0]["type"], "image_url");
        let round: LlmChatRequest = serde_json::from_value(wire).unwrap();
        assert_eq!(round.request_id.as_deref(), Some("req-1"));
        let mut no_id = request.clone();
        no_id.request_id = None;
        let wire = serde_json::to_value(&no_id).unwrap();
        assert!(
            wire.get("request_id").is_none(),
            "absent request_id must be omitted"
        );

        // LlmChatResponse: `content` defaults on deserialize; finish_reason
        // is null when absent.
        let response: LlmChatResponse = serde_json::from_value(serde_json::json!({
            "tool_calls": [{"id": "c1", "name": "Read", "arguments": {"path": "a"}}],
            "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
        }))
        .unwrap();
        assert_eq!(response.content, "");
        assert_eq!(response.finish_reason, None);
        assert_eq!(response.tool_calls.len(), 1);

        // ToolExecuteRequest / Response.
        let exec = ToolExecuteRequest {
            turn_id: "t".into(),
            tool_call_id: "c1".into(),
            tool_name: "Read".into(),
            arguments: serde_json::json!({"path": "a"}),
        };
        assert_eq!(
            serde_json::to_value(&exec).unwrap(),
            serde_json::json!({
                "turn_id": "t", "tool_call_id": "c1",
                "tool_name": "Read", "arguments": {"path": "a"}
            })
        );
        let exec_resp = ToolExecuteResponse {
            content: "out".into(),
            is_error: false,
            note: None,
        };
        let wire = serde_json::to_value(&exec_resp).unwrap();
        assert_eq!(
            wire["note"],
            serde_json::Value::Null,
            "absent note serializes as null"
        );
        let round: ToolExecuteResponse = serde_json::from_value(
            serde_json::json!({"content": "out", "is_error": true, "note": "n"}),
        )
        .unwrap();
        assert!(round.is_error);
        assert_eq!(round.note.as_deref(), Some("n"));

        // PermissionCheckRequest / Decision.
        let perm = PermissionCheckRequest {
            tool_name: "Write".into(),
            tool_call_id: "c2".into(),
            arguments: serde_json::json!({"path": "a"}),
        };
        assert_eq!(serde_json::to_value(&perm).unwrap()["tool_name"], "Write");
        let decision = PermissionDecision::deny("no");
        assert_eq!(
            serde_json::to_value(&decision).unwrap(),
            serde_json::json!({"decision": "deny", "reason": "no"})
        );

        // ToolFinalizeRequest: note defaults to null on deserialize.
        let finalize: ToolFinalizeRequest = serde_json::from_value(serde_json::json!({
            "tool_name": "Bash", "tool_call_id": "c3",
            "content": "out", "is_error": false
        }))
        .unwrap();
        assert_eq!(finalize.note, None);

        // RunTurnParams: every field round-trips; serde defaults fill the
        // optional ones the TS side may omit.
        let params: RunTurnParams = serde_json::from_value(serde_json::json!({
            "turn_id": "t1",
            "system_prompt": "sp",
            "model_name": "m",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [],
            "max_steps": 3,
            "github_token": "tok",
            "github_base_url": "https://github.example.com"
        }))
        .unwrap();
        assert_eq!(params.max_steps, Some(3));
        assert!(params.providers.is_empty());
        assert!(!params.native_tools);
        assert!(!params.rust_self_contained);
        assert_eq!(params.github_token.as_deref(), Some("tok"));
        assert!(params.goal.is_none());

        // RunTurnResult: serde-default fields serialize (never omitted).
        let result = RunTurnResult {
            stop_reason: "EndTurn".into(),
            steps: 2,
            usage: TokenUsage::default(),
            events_emitted: 0,
            llm_retries: 0,
            llm_transport: "host-proxy".into(),
            native_tool_calls: 0,
        };
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["events_emitted"], 0);
        assert_eq!(wire["llm_transport"], "host-proxy");
        let round: RunTurnResult = serde_json::from_value(serde_json::json!({
            "stop_reason": "Aborted", "steps": 1,
            "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        }))
        .unwrap();
        assert_eq!(round.events_emitted, 0);
        assert_eq!(round.llm_transport, "");
    }

    #[test]
    fn test_run_turn_result_roundtrip() {
        let result = RunTurnResult {
            stop_reason: "EndTurn".to_string(),
            steps: 3,
            usage: TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
                ..Default::default()
            },
            events_emitted: 7,
            llm_retries: 2,
            llm_transport: "native-http".to_string(),
            native_tool_calls: 4,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["stop_reason"], "EndTurn");
        assert_eq!(json["steps"], 3);
        assert_eq!(json["usage"]["input_tokens"], 100);
        assert_eq!(json["events_emitted"], 7);
        assert_eq!(json["llm_retries"], 2);
        assert_eq!(json["llm_transport"], "native-http");
        assert_eq!(json["native_tool_calls"], 4);

        let deserialized: RunTurnResult = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.stop_reason, "EndTurn");
        assert_eq!(deserialized.steps, 3);
        assert_eq!(deserialized.events_emitted, 7);
        assert_eq!(deserialized.llm_retries, 2);
    }

    /// Older adapters omit the telemetry counters; serde defaults keep the
    /// wire backward-compatible.
    #[test]
    fn test_run_turn_result_defaults_without_counters() {
        let deserialized: RunTurnResult = serde_json::from_value(serde_json::json!({
            "stop_reason": "EndTurn",
            "steps": 1,
            "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
        }))
        .unwrap();
        assert_eq!(deserialized.events_emitted, 0);
        assert_eq!(deserialized.llm_retries, 0);
        assert_eq!(deserialized.llm_transport, "");
        assert_eq!(deserialized.native_tool_calls, 0);
    }

    #[test]
    fn test_llm_chat_request_roundtrip() {
        let req = LlmChatRequest {
            system_prompt: "You are helpful.".to_string(),
            model_name: "gpt-4".to_string(),
            messages: vec![LlmChatMessage {
                role: "user".to_string(),
                content: "Hi".to_string(),
                blocks: Vec::new(),
            }],
            tools: vec![ToolDef {
                name: "read".to_string(),
                description: "Read file".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
            }],
            request_id: None,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["system_prompt"], "You are helpful.");
        assert_eq!(json["messages"][0]["role"], "user");
        // Absent rather than null: the single-provider path has nothing to cancel.
        assert!(json.get("request_id").is_none());

        let deserialized: LlmChatRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.system_prompt, req.system_prompt);
        assert_eq!(deserialized.messages.len(), 1);
        assert_eq!(deserialized.tools.len(), 1);
    }

    #[test]
    fn test_llm_chat_request_carries_request_id() {
        let req = LlmChatRequest {
            system_prompt: String::new(),
            model_name: "fast".to_string(),
            messages: vec![],
            tools: vec![],
            request_id: Some("llm-slow-7".to_string()),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["request_id"], "llm-slow-7");

        let deserialized: LlmChatRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.request_id.as_deref(), Some("llm-slow-7"));
    }

    #[test]
    fn test_llm_chat_response_roundtrip() {
        let resp = LlmChatResponse {
            content: String::new(),
            tool_calls: vec![LlmToolCall {
                id: "call_1".to_string(),
                name: "read".to_string(),
                arguments: serde_json::json!({"path": "/tmp/test.txt"}),
            }],
            finish_reason: Some("stop".to_string()),
            usage: TokenUsage {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                ..Default::default()
            },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["tool_calls"][0]["name"], "read");
        assert_eq!(json["finish_reason"], "stop");

        let deserialized: LlmChatResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.tool_calls.len(), 1);
        assert_eq!(deserialized.tool_calls[0].id, "call_1");
        assert_eq!(deserialized.finish_reason, Some("stop".to_string()));
    }

    #[test]
    fn test_tool_execute_request_roundtrip() {
        let req = ToolExecuteRequest {
            turn_id: "turn-1".to_string(),
            tool_call_id: "call_1".to_string(),
            tool_name: "read".to_string(),
            arguments: serde_json::json!({"path": "/tmp/test.txt", "line_offset": 1}),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["tool_name"], "read");
        assert_eq!(json["arguments"]["path"], "/tmp/test.txt");

        let deserialized: ToolExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.turn_id, "turn-1");
        assert_eq!(deserialized.tool_name, "read");
    }

    #[test]
    fn test_tool_execute_request_defaults() {
        // force_precise was removed with the prediction framework; the
        // legacy field must now deserialize as absent without error.
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "tool_call_id": "call_1",
            "tool_name": "read",
            "arguments": {"path": "/tmp/test.txt"}
        });
        let req: ToolExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.turn_id, "turn-1");
    }

    #[test]
    fn test_tool_execute_response_roundtrip() {
        let resp = ToolExecuteResponse {
            content: "file content here".to_string(),
            is_error: false,
            note: Some("<system>1 line read.</system>".to_string()),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["content"], "file content here");
        assert!(!json["is_error"].as_bool().unwrap());
        assert_eq!(json["note"], "<system>1 line read.</system>");

        let deserialized: ToolExecuteResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.content, "file content here");
        assert!(!deserialized.is_error);
        assert_eq!(
            deserialized.note.as_deref(),
            Some("<system>1 line read.</system>")
        );
    }

    #[test]
    fn test_tool_execute_response_error() {
        let resp = ToolExecuteResponse {
            content: "File not found".to_string(),
            is_error: true,
            note: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["is_error"].as_bool().unwrap());

        let deserialized: ToolExecuteResponse = serde_json::from_value(json).unwrap();
        assert!(deserialized.is_error);
    }

    #[test]
    fn test_health_status() {
        let status = HealthStatus {
            status: "ok".to_string(),
            version: "0.1.0".to_string(),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["version"], "0.1.0");
    }

    #[test]
    fn test_message_roundtrip() {
        let msg = Message {
            role: "user".to_string(),
            content: "Hello world".to_string(),
            blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["role"], "user");

        let deserialized: Message = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.role, "user");
        assert_eq!(deserialized.content, "Hello world");
    }

    #[test]
    fn test_tool_def_roundtrip() {
        let def = ToolDef {
            name: "grep".to_string(),
            description: "Search text".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"}
                }
            }),
        };
        let json = serde_json::to_value(&def).unwrap();
        let deserialized: ToolDef = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "grep");
        assert!(
            deserialized.input_schema["properties"]["pattern"]["type"]
                .as_str()
                .is_some()
        );
    }

    #[test]
    fn test_token_usage_default() {
        let usage = TokenUsage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
    }

    #[test]
    fn test_token_usage_roundtrip() {
        let usage = TokenUsage {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            ..Default::default()
        };
        let json = serde_json::to_value(&usage).unwrap();
        assert_eq!(json["input_tokens"], 100);
        assert_eq!(json["output_tokens"], 50);
        assert_eq!(json["total_tokens"], 150);

        let deserialized: TokenUsage = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.input_tokens, 100);
        assert_eq!(deserialized.output_tokens, 50);
    }

    #[test]
    fn test_json_rpc_request_parse() {
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "agent/run_turn",
            "params": {"key": "value"}
        });
        let req: JsonRpcRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.jsonrpc, "2.0");
        assert_eq!(req.id, 42);
        assert_eq!(req.method, "agent/run_turn");
        assert_eq!(req.params["key"], "value");
    }

    #[test]
    fn test_json_rpc_request_notification() {
        // Notification has no id
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "agent/notify",
            "params": {}
        });
        let req: JsonRpcRequest = serde_json::from_value(json).unwrap();
        assert!(req.id.is_null());
    }

    #[test]
    fn test_json_rpc_response_ok() {
        let resp = JsonRpcResponse::ok(serde_json::json!(1), serde_json::json!({"result": "ok"}));
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["jsonrpc"], "2.0");
        assert_eq!(json["id"], 1);
        assert_eq!(json["result"]["result"], "ok");
    }

    #[test]
    fn test_json_rpc_error_response() {
        let err =
            JsonRpcErrorResponse::new(serde_json::json!(null), -32700, "Parse error".to_string());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["error"]["code"], -32700);
        assert_eq!(json["error"]["message"], "Parse error");
        assert!(json["error"].get("data").is_none());
    }

    #[test]
    fn test_json_rpc_error_with_data() {
        let err = JsonRpcError {
            code: -32000,
            message: "Custom error".to_string(),
            data: Some(serde_json::json!({"detail": "something broke"})),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], -32000);
        assert_eq!(json["data"]["detail"], "something broke");
    }

    #[test]
    fn test_methods_constants() {
        assert_eq!(methods::RUN_TURN, "agent/run_turn");
        assert_eq!(methods::CANCEL_TURN, "agent/cancel_turn");
        assert_eq!(methods::HEALTH, "agent/health");
        assert_eq!(methods::SHUTDOWN, "agent/shutdown");
        assert_eq!(methods::HOST_LLM_CHAT, "host/llm_chat");
        assert_eq!(methods::HOST_EXECUTE_TOOL, "host/execute_tool");
        assert_eq!(methods::HOST_ASK_QUESTION, "host/ask_question");
        assert_eq!(methods::HOST_STATE_READ, "host/state_read");
        assert_eq!(methods::HOST_STATE_WRITE, "host/state_write");
    }

    #[test]
    fn test_llm_provider_def_deserialize() {
        let json = serde_json::json!({
            "name": "fast-llm",
            "model": "gpt-4o-mini",
            "system_prompt": "You are fast."
        });
        let def: LlmProviderDef = serde_json::from_value(json).unwrap();
        assert_eq!(def.name, "fast-llm");
        assert_eq!(def.model, "gpt-4o-mini");
        assert_eq!(def.system_prompt, "You are fast.");
    }

    #[test]
    fn test_notification_parse() {
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "host/event",
            "params": {"type": "progress"}
        });
        let notif: JsonRpcNotification = serde_json::from_value(json).unwrap();
        assert_eq!(notif.jsonrpc, "2.0");
        assert_eq!(notif.method, "host/event");
        assert_eq!(notif.params["type"], "progress");
    }

    #[test]
    fn test_llm_tool_call_roundtrip() {
        let tc = LlmToolCall {
            id: "call_abc".to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({"path": "/tmp/x.txt"}),
        };
        let json = serde_json::to_value(&tc).unwrap();
        let deserialized: LlmToolCall = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.id, "call_abc");
        assert_eq!(deserialized.name, "read_file");
    }

    #[test]
    fn test_empty_providers_default() {
        let json = serde_json::json!({
            "turn_id": "t1",
            "system_prompt": "hi",
            "model_name": "m",
            "messages": [],
            "tools": []
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert!(params.providers.is_empty());
    }

    #[test]
    fn test_tool_def_empty_schema() {
        let def = ToolDef {
            name: "bash".to_string(),
            description: "Run shell".to_string(),
            input_schema: serde_json::Value::Object(Default::default()),
        };
        let json = serde_json::to_value(&def).unwrap();
        let deserialized: ToolDef = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "bash");
        assert!(deserialized.input_schema.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_ask_question_request_roundtrip() {
        let req = AskQuestionRequest {
            question_id: "question_9f2c".to_string(),
            turn_id: "turn-42".to_string(),
            tool_call_id: "call_abc".to_string(),
            background: false,
            timeout_ms: None,
            questions: vec![AskQuestionItem {
                question: "Which approach should I take?".to_string(),
                header: Some("Style".to_string()),
                options: vec![
                    AskQuestionOption {
                        label: "Option A (Recommended)".to_string(),
                        description: Some("Fast, less flexible".to_string()),
                    },
                    AskQuestionOption {
                        label: "Option B".to_string(),
                        description: None,
                    },
                ],
                multi_select: false,
            }],
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["question_id"], "question_9f2c");
        assert_eq!(json["turn_id"], "turn-42");
        assert_eq!(json["tool_call_id"], "call_abc");
        assert_eq!(json["background"], false);
        assert!(json["timeout_ms"].is_null());
        assert_eq!(
            json["questions"][0]["question"],
            "Which approach should I take?"
        );
        assert_eq!(json["questions"][0]["header"], "Style");
        assert_eq!(
            json["questions"][0]["options"][0]["label"],
            "Option A (Recommended)"
        );
        assert_eq!(
            json["questions"][0]["options"][0]["description"],
            "Fast, less flexible"
        );
        assert!(json["questions"][0]["options"][1]["description"].is_null());
        assert_eq!(json["questions"][0]["multi_select"], false);

        let deserialized: AskQuestionRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.question_id, req.question_id);
        assert_eq!(deserialized.turn_id, "turn-42");
        assert_eq!(deserialized.questions.len(), 1);
        assert_eq!(deserialized.questions[0].options.len(), 2);
        assert_eq!(deserialized.questions[0].options[1].description, None);
        assert_eq!(deserialized.timeout_ms, None);
    }

    #[test]
    fn test_ask_question_request_background_and_timeout() {
        let req = AskQuestionRequest {
            question_id: "question_1".to_string(),
            turn_id: "turn-1".to_string(),
            tool_call_id: "call_1".to_string(),
            background: true,
            timeout_ms: Some(30_000),
            questions: vec![],
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["background"], true);
        assert_eq!(json["timeout_ms"], 30_000);

        let deserialized: AskQuestionRequest = serde_json::from_value(json).unwrap();
        assert!(deserialized.background);
        assert_eq!(deserialized.timeout_ms, Some(30_000));
    }

    #[test]
    fn test_ask_question_response_answered_roundtrip() {
        let resp = AskQuestionResponse {
            answers: std::collections::HashMap::from([(
                "Which approach should I take?".to_string(),
                "Option A (Recommended)".to_string(),
            )]),
            method: Some("enter".to_string()),
            note: None,
            cancelled: None,
            reason: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(
            json["answers"]["Which approach should I take?"],
            "Option A (Recommended)"
        );
        assert_eq!(json["method"], "enter");

        let deserialized: AskQuestionResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.answers.len(), 1);
        assert_eq!(
            deserialized
                .answers
                .get("Which approach should I take?")
                .map(String::as_str),
            Some("Option A (Recommended)")
        );
        assert_eq!(deserialized.method.as_deref(), Some("enter"));
        assert_eq!(deserialized.cancelled, None);
        assert_eq!(deserialized.reason, None);
    }

    #[test]
    fn test_ask_question_response_dismissed_and_cancelled() {
        // Dismissed: empty answers + note.
        let dismissed: AskQuestionResponse = serde_json::from_value(serde_json::json!({
            "answers": {},
            "note": "User dismissed the question without answering."
        }))
        .unwrap();
        assert!(dismissed.answers.is_empty());
        assert_eq!(
            dismissed.note.as_deref(),
            Some("User dismissed the question without answering.")
        );
        assert_eq!(dismissed.cancelled, None);

        // Cancelled: {cancelled: true, reason} — answers default to empty.
        let cancelled: AskQuestionResponse = serde_json::from_value(serde_json::json!({
            "cancelled": true,
            "reason": "turn_ended"
        }))
        .unwrap();
        assert_eq!(cancelled.cancelled, Some(true));
        assert_eq!(cancelled.reason.as_deref(), Some("turn_ended"));
        assert!(cancelled.answers.is_empty());
        assert_eq!(cancelled.method, None);
    }

    #[test]
    fn test_state_read_request_roundtrip() {
        let req = StateReadRequest {
            domain: "todo".to_string(),
            key: "todo".to_string(),
            turn_id: "turn-42".to_string(),
            tool_call_id: "call_abc".to_string(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["domain"], "todo");
        assert_eq!(json["key"], "todo");
        assert_eq!(json["turn_id"], "turn-42");
        assert_eq!(json["tool_call_id"], "call_abc");

        let deserialized: StateReadRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.domain, "todo");
        assert_eq!(deserialized.key, "todo");
        assert_eq!(deserialized.turn_id, "turn-42");
        assert_eq!(deserialized.tool_call_id, "call_abc");
    }

    #[test]
    fn test_state_read_request_defaults() {
        // Provenance fields are optional on the wire; serde defaults keep
        // older adapters backward-compatible.
        let req: StateReadRequest = serde_json::from_value(serde_json::json!({
            "domain": "plan",
            "key": "plan",
        }))
        .unwrap();
        assert_eq!(req.domain, "plan");
        assert_eq!(req.key, "plan");
        assert_eq!(req.turn_id, "");
        assert_eq!(req.tool_call_id, "");
    }

    #[test]
    fn test_state_read_response_opaque_value() {
        // `value` is an opaque host-serialized domain wire value; it must
        // round-trip verbatim.
        let resp = StateReadResponse {
            value: serde_json::json!([
                {"id": "T1", "parentId": null, "kind": "task", "title": "Read session-control.ts", "status": "in_progress", "progress": 40},
                {"id": "M1", "parentId": null, "kind": "milestone", "title": "Phase 1", "status": "pending"}
            ]),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["value"][0]["id"], "T1");
        assert_eq!(json["value"][0]["progress"], 40);
        assert_eq!(json["value"][1]["kind"], "milestone");

        let deserialized: StateReadResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.value[0]["title"], "Read session-control.ts");
        assert_eq!(deserialized.value[1]["status"], "pending");
    }

    #[test]
    fn test_state_write_request_roundtrip() {
        let req = StateWriteRequest {
            domain: "todo".to_string(),
            key: "todo".to_string(),
            value: serde_json::json!([
                {"title": "Read session-control.ts", "status": "in_progress"}
            ]),
            undoable: true,
            turn_id: "turn-42".to_string(),
            tool_call_id: "call_abc".to_string(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["domain"], "todo");
        assert_eq!(json["undoable"], true);
        assert_eq!(json["value"][0]["title"], "Read session-control.ts");
        assert_eq!(json["turn_id"], "turn-42");
        assert_eq!(json["tool_call_id"], "call_abc");

        let deserialized: StateWriteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.domain, "todo");
        assert!(deserialized.undoable);
        assert_eq!(deserialized.value[0]["status"], "in_progress");
        assert_eq!(deserialized.turn_id, "turn-42");
        assert_eq!(deserialized.tool_call_id, "call_abc");
    }

    #[test]
    fn test_state_write_request_defaults() {
        let req: StateWriteRequest = serde_json::from_value(serde_json::json!({
            "domain": "plan",
            "key": "plan",
            "value": {"active": true},
            "undoable": true,
        }))
        .unwrap();
        assert_eq!(req.domain, "plan");
        assert!(req.undoable);
        assert_eq!(req.value["active"], true);
        assert_eq!(req.turn_id, "");
        assert_eq!(req.tool_call_id, "");
    }

    #[test]
    fn test_state_write_response_roundtrip() {
        let resp = StateWriteResponse {
            ok: true,
            value: serde_json::json!({
                "active": true,
                "id": "plan-7f3a",
                "path": "<sessionDir>/agents/agent-1/plans/plan-7f3a.md"
            }),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["value"]["id"], "plan-7f3a");

        let deserialized: StateWriteResponse = serde_json::from_value(json).unwrap();
        assert!(deserialized.ok);
        assert_eq!(
            deserialized.value["path"],
            "<sessionDir>/agents/agent-1/plans/plan-7f3a.md"
        );
    }
}
