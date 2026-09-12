use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn deserialize_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

pub type TurnId = String;
pub type StepId = String;
pub type FrameId = String;
pub type MarkerId = String;
pub type TaskRefId = String;
pub type TaskId = String;
pub type AgentId = String;
pub type InteractionId = String;
pub type AttachmentId = String;
pub type TodoId = String;
pub type PromptId = String;
pub type ItemId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Running,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolFrameState {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolProgressKind {
    Stdout,
    Stderr,
    Progress,
    Status,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextRole {
    Assistant,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserOriginKind {
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRefRole {
    Child,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    Approval,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionState {
    Pending,
    Approved,
    Rejected,
    Cancelled,
    Answered,
    Dismissed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Shell,
    Subagent,
    Tool,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Running,
    Completed,
    Failed,
    TimedOut,
    Killed,
    Lost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoKind {
    Milestone,
    Task,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptPromptStatus {
    Running,
    Queued,
    Blocked,
    Completed,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityMeta {
    Idle,
    Turn,
    Disposing,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Complete,
    BudgetLimited,
    UsageLimited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPermission {
    Manual,
    Yolo,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStream {
    Assistant,
    Thinking,
    ToolCall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterruptReason {
    Aborted,
    MaxSteps,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEndReason {
    Completed,
    Cancelled,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnOrigin {
    User {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
    },
    Cron {
        #[serde(rename = "taskId", default, skip_serializing_if = "Option::is_none")]
        task_id: Option<TaskId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
    },
    Task {
        #[serde(rename = "taskId")]
        task_id: TaskId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
    },
    Hook {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
    },
    Compaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
    },
    Side {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
    },
    Other {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepUsage {
    pub input_other: i64,
    pub output: i64,
    pub input_cache_read: i64,
    pub input_cache_creation: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepTiming {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_first_token_latency_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_stream_duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_request_build_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_server_first_token_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_server_decode_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_client_consume_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRetry {
    pub failed_attempt: i64,
    pub next_attempt: i64,
    pub max_attempts: i64,
    pub delay_ms: i64,
    pub error_name: String,
    pub error_message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSkillActivation {
    pub skill_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_args: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUserOrigin {
    pub kind: UserOriginKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_activations: Option<Vec<TranscriptSkillActivation>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFrame {
    pub frame_id: FrameId,
    pub text: String,
    pub role: TextRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<AttachmentId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<TranscriptUserOrigin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingFrame {
    pub frame_id: FrameId,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFrameProgress {
    pub kind: ToolProgressKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub agent_id: AgentId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<AgentRefRole>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallFrame {
    pub frame_id: FrameId,
    pub tool_call_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    pub state: ToolFrameState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<ToolFrameProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<InteractionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo_id: Option<TodoId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_refs: Option<Vec<AgentRef>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeFrame {
    pub frame_id: FrameId,
    pub level: NoticeLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranscriptFrame {
    Text(TextFrame),
    Thinking(ThinkingFrame),
    Tool(ToolCallFrame),
    Notice(NoticeFrame),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptStep {
    pub step_id: StepId,
    pub turn_id: TurnId,
    pub ordinal: i64,
    pub state: StepState,
    pub frames: Vec<TranscriptFrame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<StepUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<StepTiming>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<StepRetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurn {
    pub turn_id: TurnId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_prompt_id: Option<String>,
    pub ordinal: i64,
    pub state: TurnState,
    pub origin: TurnOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<AttachmentId>>,
    pub steps: Vec<TranscriptStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TranscriptUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMarker {
    pub marker_id: MarkerId,
    pub marker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTaskRef {
    pub ref_id: TaskRefId,
    pub task_id: TaskId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranscriptItem {
    Turn(TranscriptTurn),
    Marker(TranscriptMarker),
    TaskRef(TranscriptTaskRef),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTask {
    pub task_id: TaskId,
    pub kind: TaskKind,
    pub state: TaskState,
    pub detached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    pub output_tail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<StepUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptInteraction {
    pub interaction_id: InteractionId,
    pub interaction_kind: InteractionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub state: InteractionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentSource {
    Url {
        url: String,
    },
    File {
        #[serde(rename = "fileId")]
        file_id: String,
    },
    SessionMedia {
        #[serde(rename = "fileId")]
        file_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAttachment {
    pub attachment_id: AttachmentId,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AttachmentSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(
        rename = "parentId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_nullable"
    )]
    pub parent_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<TodoKind>,
    pub title: String,
    pub status: TodoStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTodo {
    pub todo_id: TodoId,
    pub items: Vec<TodoItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPrompt {
    pub prompt_id: PromptId,
    pub status: TranscriptPromptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steered_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalMeta {
    pub objective: String,
    pub status: GoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_criterion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_used: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_limit: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TowerMeta {}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModesMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<PlanMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm: Option<SwarmMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tower: Option<TowerMeta>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModesMetaMerge {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_nullable"
    )]
    pub plan: Option<Option<PlanMeta>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_nullable"
    )]
    pub swarm: Option<Option<SwarmMeta>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_nullable"
    )]
    pub tower: Option<Option<TowerMeta>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_model: Option<HashMap<String, StepUsage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<StepUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<StepUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentPhaseMeta {
    Idle,
    Running {
        #[serde(rename = "turnId")]
        turn_id: i64,
        step: i64,
        #[serde(rename = "stepId")]
        step_id: String,
        since: i64,
    },
    Streaming {
        #[serde(rename = "turnId")]
        turn_id: i64,
        step: i64,
        #[serde(rename = "stepId")]
        step_id: String,
        stream: AgentStream,
        #[serde(
            rename = "toolCallId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        tool_call_id: Option<String>,
        #[serde(rename = "toolName", default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        since: i64,
    },
    ToolCall {
        #[serde(rename = "turnId")]
        turn_id: i64,
        step: i64,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        name: String,
        since: i64,
    },
    Retrying {
        #[serde(rename = "turnId")]
        turn_id: i64,
        step: i64,
        #[serde(rename = "stepId")]
        step_id: String,
        #[serde(rename = "failedAttempt")]
        failed_attempt: i64,
        #[serde(rename = "nextAttempt")]
        next_attempt: i64,
        #[serde(rename = "maxAttempts")]
        max_attempts: i64,
        #[serde(rename = "delayMs")]
        delay_ms: i64,
        #[serde(rename = "errorName", default, skip_serializing_if = "Option::is_none")]
        error_name: Option<String>,
        #[serde(
            rename = "statusCode",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        status_code: Option<i64>,
        since: i64,
    },
    AwaitingApproval {
        #[serde(rename = "turnId")]
        turn_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        approval: Option<Value>,
        since: i64,
    },
    Interrupted {
        #[serde(rename = "turnId")]
        turn_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<i64>,
        reason: InterruptReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        at: i64,
    },
    Ended {
        #[serde(rename = "turnId")]
        turn_id: i64,
        reason: TurnEndReason,
        #[serde(
            rename = "durationMs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        duration_ms: Option<i64>,
        at: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AgentUsageMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<AgentPermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<AgentPhaseMeta>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<GoalMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<ModesMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<ActivityMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentStatusMeta>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMetaMerge {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_nullable"
    )]
    pub goal: Option<Option<GoalMeta>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<ModesMetaMerge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<ActivityMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentStatusMeta>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn item_and_frame_unions_match_wire_shape() {
        let value = json!({
            "kind": "turn",
            "turnId": "t0",
            "ordinal": 0,
            "state": "completed",
            "origin": { "kind": "user" },
            "steps": [{
                "kind": "step",
                "stepId": "t0.1",
                "turnId": "t0",
                "ordinal": 1,
                "state": "completed",
                "frames": [
                    { "kind": "text", "frameId": "t0.1.f1", "role": "assistant", "text": "hi" },
                    { "kind": "thinking", "frameId": "t0.1.f2", "text": "hmm" },
                    {
                        "kind": "tool",
                        "frameId": "t0.1.c1",
                        "toolCallId": "c1",
                        "name": "Read",
                        "state": "done",
                        "output": "x"
                    },
                    {
                        "kind": "notice",
                        "frameId": "t0.1.n1",
                        "level": "info",
                        "message": "m"
                    }
                ]
            }]
        });
        let item: TranscriptItem = serde_json::from_value(value).expect("deserialize turn");
        let round = serde_json::to_value(&item).expect("serialize turn");
        assert_eq!(round["kind"], "turn");
        assert_eq!(round["steps"][0]["frames"][0]["kind"], "text");
        assert_eq!(round["steps"][0]["frames"][1]["kind"], "thinking");
        assert_eq!(round["steps"][0]["frames"][2]["toolCallId"], "c1");
        assert_eq!(round["steps"][0]["frames"][3]["kind"], "notice");
        assert_eq!(
            item,
            serde_json::from_value(round).expect("round-trip turn")
        );
    }

    #[test]
    fn nullable_parent_id_distinguishes_absent_and_null() {
        let item: TodoItem = serde_json::from_value(json!({
            "title": "t",
            "status": "pending",
            "parentId": null
        }))
        .expect("deserialize todo item");
        assert_eq!(item.parent_id, Some(None));
        let absent: TodoItem = serde_json::from_value(json!({
            "title": "t",
            "status": "pending"
        }))
        .expect("deserialize todo item");
        assert_eq!(absent.parent_id, None);
    }
}
