//! Rust mirror of the upstream v3 wire protocol (`kap-server/src/protocol/messages/*.ts`).
//!
//! Every message is a flat *entity upsert*: the client folds history and live
//! traffic through one code path, so the field names, the tag literals and the
//! JSON positions of the shared bases in this file are a wire contract, not a
//! style choice. Names on the wire are already `snake_case`, so no field carries
//! `rename_all`; every `type` tag is written out per message variant instead of
//! being derived from the Rust variant name.
//!
//! Three shared bases exist upstream (`base.ts`) and are inlined literally here,
//! in the position the TypeScript spread puts them:
//!
//! - *timeline*: `session_id`, `agent_id`, `timestamp` — upserts one entity of
//!   one agent's timeline ([`TurnMessage`] … [`TodoMessage`], [`AgentStateMessage`]).
//! - *session*: `session_id`, `timestamp` — upserts a session-scoped entity
//!   ([`SessionStateMessage`]).
//! - *global*: `timestamp` — upserts a server-wide entity ([`SessionMessage`] …
//!   [`CapabilityMessage`]).
//!
//! `hello`, `ack` and `error` carry no base at all: they are connection-level
//! frames, not entity upserts.
//!
//! Two zod constructs have no exact serde counterpart and are mapped to the
//! closest faithful shape (both keep the emitted JSON identical):
//!
//! - `z.discriminatedUnion` nested *inside* a message (`system.subtype`,
//!   `interaction.kind`) becomes a discriminant field plus a typed body, because
//!   serde allows only one `tag` per enum and the outer tag is `type`.
//! - `z.unknown()` payloads that sometimes carry a known object
//!   (`system.payload` for `undo`/`clear`) become an untagged enum whose typed
//!   arm is tried first.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::entity::EntityAddressed;

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/// Wire `type` of one content part of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ContentPartType {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "think")]
    Think,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "video")]
    Video,
}

/// Lifecycle of a turn entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TurnStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
}

/// Lifecycle of a step entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum StepStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "failed")]
    Failed,
}

/// Read state of a user message entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum UserMessageStatus {
    #[serde(rename = "unread")]
    Unread,
    #[serde(rename = "read")]
    Read,
}

/// Stream state of an assistant or thinking entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum StreamStatus {
    #[serde(rename = "streaming")]
    Streaming,
    #[serde(rename = "completed")]
    Completed,
}

/// Lifecycle of a tool call entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ToolCallStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "error")]
    Error,
}

/// Channel a tool progress payload belongs to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ToolProgressKind {
    #[serde(rename = "stdout")]
    Stdout,
    #[serde(rename = "stderr")]
    Stderr,
    #[serde(rename = "progress")]
    Progress,
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "custom")]
    Custom,
}

/// Lifecycle of a todo entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TodoItemStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "in_progress")]
    InProgress,
    #[serde(rename = "done")]
    Done,
}

/// Lifecycle of an agent timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AgentStatus {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
}

/// What one agent's main loop is doing right now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AgentTurnStatus {
    #[serde(rename = "thinking")]
    Thinking,
    #[serde(rename = "retrying")]
    Retrying,
    #[serde(rename = "acting")]
    Acting,
    #[serde(rename = "aborting")]
    Aborting,
}

/// Lifecycle of a session entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SessionStatus {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "compacting")]
    Compacting,
}

/// Which kind of interaction a session is blocked on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PendingInteraction {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "approval")]
    Approval,
    #[serde(rename = "question")]
    Question,
}

/// Permission mode in force for a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PermissionMode {
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "yolo")]
    Yolo,
    #[serde(rename = "auto")]
    Auto,
}

/// Lifecycle of a session goal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GoalStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "complete")]
    Complete,
}

/// Control verb a client asks the session goal to apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GoalControl {
    #[serde(rename = "pause")]
    Pause,
    #[serde(rename = "resume")]
    Resume,
    #[serde(rename = "cancel")]
    Cancel,
}

/// Why the last turn of a session ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum LastTurnReason {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "failed")]
    Failed,
}

/// Shape of a permission rule matcher.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PermissionMatcherKind {
    #[serde(rename = "command_prefix")]
    CommandPrefix,
    #[serde(rename = "path_glob")]
    PathGlob,
    #[serde(rename = "exact_input")]
    ExactInput,
    #[serde(rename = "always")]
    Always,
}

/// Who created a permission rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PermissionRuleCreator {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "agent")]
    Agent,
}

/// Decision recorded on a permission rule; upstream only ever stores `approved`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PermissionRuleDecision {
    #[serde(rename = "approved")]
    Approved,
}

/// Why a session entity was (re)published.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SessionSubtype {
    #[serde(rename = "created")]
    Created,
    #[serde(rename = "updated")]
    Updated,
    #[serde(rename = "archived")]
    Archived,
    #[serde(rename = "deleted")]
    Deleted,
}

/// Why a workspace entity was (re)published.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WorkspaceSubtype {
    #[serde(rename = "created")]
    Created,
    #[serde(rename = "updated")]
    Updated,
    #[serde(rename = "deleted")]
    Deleted,
}

/// Lifecycle of an interaction entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InteractionStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "approved")]
    Approved,
    #[serde(rename = "rejected")]
    Rejected,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "answered")]
    Answered,
    #[serde(rename = "dismissed")]
    Dismissed,
}

/// Approval decision carried by an approval response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ApprovalDecision {
    #[serde(rename = "approved")]
    Approved,
    #[serde(rename = "rejected")]
    Rejected,
    #[serde(rename = "cancelled")]
    Cancelled,
}

/// Scope an approval was granted for; upstream only ever sends `session`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ApprovalScope {
    #[serde(rename = "session")]
    Session,
}

/// How the user answered a question.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum QuestionResponseMethod {
    #[serde(rename = "enter")]
    Enter,
    #[serde(rename = "space")]
    Space,
    #[serde(rename = "number_key")]
    NumberKey,
    #[serde(rename = "click")]
    Click,
}

/// Kind of background work a task entity tracks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TaskKind {
    #[serde(rename = "shell")]
    Shell,
    #[serde(rename = "subagent")]
    Subagent,
    #[serde(rename = "tool")]
    Tool,
    #[serde(rename = "other")]
    Other,
}

/// Lifecycle of a task entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TaskStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "timed_out")]
    TimedOut,
    #[serde(rename = "killed")]
    Killed,
    #[serde(rename = "lost")]
    Lost,
}

/// Relation between a tool call and an agent it spawned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ToolCallAgentRole {
    #[serde(rename = "child")]
    Child,
    #[serde(rename = "member")]
    Member,
}

/// Subtype of a system entity; the wire literals are dotted, not snake_case.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SystemSubtype {
    #[serde(rename = "compaction")]
    Compaction,
    #[serde(rename = "undo")]
    Undo,
    #[serde(rename = "clear")]
    Clear,
    #[serde(rename = "goal")]
    Goal,
    #[serde(rename = "plan.enter")]
    PlanEnter,
    #[serde(rename = "plan.exit")]
    PlanExit,
    #[serde(rename = "plan.revision")]
    PlanRevision,
    #[serde(rename = "swarm.enter")]
    SwarmEnter,
    #[serde(rename = "swarm.exit")]
    SwarmExit,
    #[serde(rename = "notice")]
    Notice,
    #[serde(rename = "hook")]
    Hook,
    #[serde(rename = "interruption")]
    Interruption,
}

/// Kind of an interaction entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InteractionKind {
    #[serde(rename = "approval")]
    Approval,
    #[serde(rename = "question")]
    Question,
}

// ---------------------------------------------------------------------------
// Nested discriminated unions (`kind`-tagged)
// ---------------------------------------------------------------------------

/// Origin of a turn. The `task` variant is the only one carrying data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TurnOrigin {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "cron")]
    Cron,
    #[serde(rename = "task")]
    Task {
        #[serde(rename = "task_id")]
        task_id: String,
    },
    #[serde(rename = "hook")]
    Hook,
    #[serde(rename = "compaction")]
    Compaction,
    #[serde(rename = "side")]
    Side,
    #[serde(rename = "goal")]
    Goal,
    #[serde(rename = "other")]
    Other,
}

impl TurnOrigin {
    /// The kind tag of an origin recorded in the `turns.origin` column. Only
    /// the data-free kinds are recognizable; `task` needs a task id the turn
    /// record does not carry, so it (and any unknown kind) falls back to
    /// `user` — the shape every recorded turn had before the column existed.
    pub fn from_kind(kind: &str) -> Self {
        match kind {
            "cron" => TurnOrigin::Cron,
            "hook" => TurnOrigin::Hook,
            "compaction" => TurnOrigin::Compaction,
            "side" => TurnOrigin::Side,
            "goal" => TurnOrigin::Goal,
            "other" => TurnOrigin::Other,
            _ => TurnOrigin::User,
        }
    }
}

/// Origin of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum UserMessageOrigin {
    #[serde(rename = "user")]
    User {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "cron_id")]
        cron_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schedule: Option<String>,
        /// v2 #3906 `origin.inTurn`: the user message joined a running turn
        /// (steer) instead of opening one. A client must not treat it as an
        /// undo anchor or a new turn opener.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "inTurn")]
        in_turn: Option<bool>,
    },
    #[serde(rename = "cron")]
    Cron {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "cron_id")]
        cron_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schedule: Option<String>,
    },
    #[serde(rename = "task")]
    Task {
        #[serde(rename = "task_id")]
        task_id: String,
        title: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        severity: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "type")]
        r#type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<serde_json::Value>,
    },
    #[serde(rename = "skill")]
    Skill {
        skill_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trigger: Option<String>,
    },
}

/// How an agent timeline came into existence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AgentStateOrigin {
    #[serde(rename = "btw")]
    Btw,
    #[serde(rename = "main")]
    Main,
    #[serde(rename = "tool-swarm")]
    ToolSwarm {
        tool_call_id: String,
        swarm_index: i64,
        parent_agent_id: String,
    },
    #[serde(rename = "tool-agent")]
    ToolAgent {
        tool_call_id: String,
        parent_agent_id: String,
    },
}

/// One answer to one question of a question interaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum InteractionQuestionAnswer {
    #[serde(rename = "single")]
    Single { option_id: String },
    #[serde(rename = "multi")]
    Multi { option_ids: Vec<String> },
    #[serde(rename = "other")]
    Other { text: String },
    #[serde(rename = "multi_with_other")]
    MultiWithOther {
        option_ids: Vec<String>,
        other_text: String,
    },
    #[serde(rename = "skipped")]
    Skipped,
}

/// Body of a system entity: typed where upstream types it, open elsewhere.
///
/// Upstream requires a payload for `subtype = "undo" | "clear"`
/// (`systemRemovedIdsPayloadSchema`) and leaves every other subtype opaque and
/// optional, and this models both as optional. That is the tolerance side of
/// the divergence on purpose: a parser that rejects a history record over a
/// missing payload is worse than one that accepts it, so the requirement is a
/// producer-side obligation — the projection always emits `removed_ids` for
/// those two subtypes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SystemPayload {
    /// `subtype = "undo" | "clear"` — the ids the host removed.
    RemovedIds(SystemRemovedIdsPayload),
    /// Every other subtype ships an opaque payload (often absent).
    Other(serde_json::Value),
}

/// Request body of an interaction entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InteractionRequest {
    /// `kind = "approval"` request body.
    Approval(InteractionApprovalRequest),
    /// `kind = "question"` request body.
    Question(InteractionQuestionRequest),
}

/// Response body of an interaction entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InteractionResponse {
    /// `kind = "approval"` response body.
    Approval(InteractionApprovalResponse),
    /// `kind = "question"` response body.
    Question(InteractionQuestionResponse),
}

// ---------------------------------------------------------------------------
// Nested objects
// ---------------------------------------------------------------------------

/// Token accounting of one turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<i64>,
    /// Non-integral upstream (`z.number()`): a monetary cost, not a count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

/// Token accounting of one step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepUsage {
    pub input_other: i64,
    pub output: i64,
    pub input_cache_read: i64,
    pub input_cache_creation: i64,
}

/// Latency breakdown of one step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepTiming {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_first_token_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_stream_duration_ms: Option<i64>,
}

/// Retry bookkeeping of one step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// One part of a user message body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentPart {
    #[serde(rename = "type")]
    pub r#type: ContentPartType,
    pub text: String,
    pub meta: HashMap<String, serde_json::Value>,
}

/// One skill a user message activated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillActivation {
    pub skill_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_args: Option<String>,
}

/// One agent a tool call spawned or joined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallAgentRef {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<ToolCallAgentRole>,
}

/// Progress payload inlined in a tool call and shipped standalone by `tool.progress`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolProgressPayload {
    pub kind: ToolProgressKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Non-integral upstream (`z.number()`): a completion percentage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_data: Option<serde_json::Value>,
}

/// Payload of an `undo`/`clear` system entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemRemovedIdsPayload {
    pub removed_ids: Vec<String>,
}

/// Approval request body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractionApprovalRequest {
    pub tool_name: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_input_display: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

/// Approval response body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractionApprovalResponse {
    pub decision: ApprovalDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ApprovalScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_label: Option<String>,
}

/// One selectable option of one question.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractionQuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One question of a question interaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractionQuestionItem {
    pub id: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub options: Vec<InteractionQuestionOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_other: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_description: Option<String>,
}

/// Question request body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractionQuestionRequest {
    pub questions: Vec<InteractionQuestionItem>,
}

/// Question response body; `answers` is keyed by question id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractionQuestionResponse {
    pub answers: HashMap<String, InteractionQuestionAnswer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<QuestionResponseMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Kind tag of an agent state profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentStateProfile {
    pub kind: String,
}

/// What the agent's main loop is doing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentStateTurn {
    pub status: AgentTurnStatus,
}

/// Usage roll-up of a session state entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStateUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_model: Option<HashMap<String, StepUsage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<StepUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<StepUsage>,
}

/// Goal of a session state entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStateGoal {
    pub objective: String,
    pub status: GoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_criterion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_limit: Option<i64>,
}

/// Plan-mode half of the session modes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStatePlanMode {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
}

/// Swarm-mode half of the session modes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStateSwarmMode {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
}

/// Mode flags of a session state entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStateModes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<SessionStatePlanMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm: Option<SessionStateSwarmMode>,
}

/// Session metadata: `cwd` is required, every other key is open (`catchall`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfoMetadata {
    pub cwd: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Agent configuration of a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfoAgentConfig {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tower_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tower_base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_control: Option<GoalControl>,
}

/// Usage roll-up of a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfoUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    /// Non-integral upstream (`z.number()`): money, not a count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    pub context_tokens: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<i64>,
}

/// Matcher of a permission rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfoPermissionMatcher {
    pub kind: PermissionMatcherKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// One remembered permission decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfoPermissionRule {
    pub id: String,
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<SessionInfoPermissionMatcher>,
    pub decision: PermissionRuleDecision,
    pub created_at: String,
    pub created_by: PermissionRuleCreator,
}

/// Full state of one session entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub busy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_turn_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_interaction: Option<PendingInteraction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_reason: Option<LastTurnReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_prompt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_prompt: Option<String>,
    pub metadata: SessionInfoMetadata,
    pub agent_config: SessionInfoAgentConfig,
    pub usage: SessionInfoUsage,
    pub permission_rules: Vec<SessionInfoPermissionRule>,
    pub message_count: i64,
    pub last_seq: i64,
}

/// Full state of one workspace entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub root: String,
    pub name: String,
    pub created_at: String,
    pub last_opened_at: String,
    pub session_count: i64,
}

// ---------------------------------------------------------------------------
// Server messages — one variant per entry of `serverMessageSchema`, in order
// ---------------------------------------------------------------------------

/// Upserts a turn entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub turn_id: String,
    pub ordinal: i64,
    pub status: TurnStatus,
    pub origin: TurnOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

/// Upserts a step entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub step_id: String,
    pub turn_id: String,
    pub ordinal: i64,
    pub status: StepStatus,
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

/// Upserts a user message entity of one agent timeline (timeline base, but
/// upstream declares `timestamp` optional on this message only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    pub session_id: String,
    pub agent_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub status: UserMessageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    pub text: Vec<ContentPart>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_activations: Option<Vec<SkillActivation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<UserMessageOrigin>,
}

/// Upserts an assistant message entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub message_id: String,
    pub turn_id: String,
    pub step_id: String,
    pub status: StreamStatus,
    pub text: String,
}

/// Appends to the assistant entity addressed by `message_id` (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantDeltaMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub message_id: String,
    pub text: String,
}

/// Upserts a thinking entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub message_id: String,
    pub turn_id: String,
    pub step_id: String,
    pub status: StreamStatus,
    pub text: String,
}

/// Appends to the thinking entity addressed by `message_id` (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingDeltaMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub message_id: String,
    pub text: String,
}

/// Upserts a tool call entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub tool_call_id: String,
    pub turn_id: String,
    pub step_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    pub status: ToolCallStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<ToolProgressPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_refs: Option<Vec<ToolCallAgentRef>>,
}

/// Appends to the tool call entity addressed by `tool_call_id` (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallDeltaMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub tool_call_id: String,
    pub input_text: String,
}

/// Upserts the progress of a tool call entity (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolProgressMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub tool_call_id: String,
    pub progress: ToolProgressPayload,
}

/// Upserts a system entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub system_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    pub subtype: SystemSubtype,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<SystemPayload>,
}

/// Upserts an interaction entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InteractionMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub interaction_id: String,
    pub status: InteractionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub kind: InteractionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<InteractionRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<InteractionResponse>,
}

/// Upserts a task entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub task_id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub detached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_agent_id: Option<String>,
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

/// Upserts the todo list entity of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoMessage {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: i64,
    pub todo_id: String,
    pub items: Vec<TodoItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// One entry of a todo list entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoItem {
    pub title: String,
    pub status: TodoItemStatus,
}

/// Upserts the state of one agent timeline (timeline base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentStateMessage {
    pub session_id: String,
    pub agent_id: String,
    pub profile: AgentStateProfile,
    pub timestamp: i64,
    pub origin: AgentStateOrigin,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub status: AgentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<AgentStateTurn>,
}

/// Upserts the state of one session entity (session base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStateMessage {
    pub session_id: String,
    pub timestamp: i64,
    pub status: SessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_interaction: Option<PendingInteraction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionStateUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<SessionStateGoal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionStateModes>,
}

/// Upserts one session entity (global base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMessage {
    pub timestamp: i64,
    pub subtype: SessionSubtype,
    pub session: SessionInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_fields: Option<Vec<String>>,
}

/// Upserts one workspace entity (global base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceMessage {
    pub timestamp: i64,
    pub subtype: WorkspaceSubtype,
    pub workspace: WorkspaceInfo,
}

/// Upserts the global daemon config entity (global base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigMessage {
    pub timestamp: i64,
    pub config: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_fields: Option<Vec<String>>,
}

/// Upserts the global config warning entity (global base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigWarningMessage {
    pub timestamp: i64,
    pub warnings: Vec<String>,
}

/// Bumps the global model catalog entity (global base; no payload of its own).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCatalogMessage {
    pub timestamp: i64,
}

/// Bumps the global plugin entity (global base; no payload of its own).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginMessage {
    pub timestamp: i64,
}

/// Bumps the global capability entity (global base).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityMessage {
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_id: Option<String>,
}

/// Connection handshake; not an entity upsert and carries no base.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloMessage {
    pub protocol_version: String,
    pub server_id: String,
    pub capabilities: Vec<String>,
}

/// Acknowledgement of one client frame; not an entity upsert and carries no base.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AckMessage {
    pub id: i64,
    pub code: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

/// Out-of-band error frame; not an entity upsert and carries no base.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorMessage {
    pub code: i64,
    pub msg: String,
}

/// Every frame the server can send, one variant per entry of
/// `serverMessageSchema` in `union.ts`, **in that order**.
///
/// The `type` tag literals are spelled out per variant on purpose: several are
/// dotted (`assistant.delta`, `tool.progress`, `agent.state`), so they can never
/// be derived from the Rust variant name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "turn")]
    Turn(TurnMessage),
    #[serde(rename = "step")]
    Step(StepMessage),
    #[serde(rename = "user")]
    User(UserMessage),
    #[serde(rename = "assistant")]
    Assistant(AssistantMessage),
    #[serde(rename = "assistant.delta")]
    AssistantDelta(AssistantDeltaMessage),
    #[serde(rename = "thinking")]
    Thinking(ThinkingMessage),
    #[serde(rename = "thinking.delta")]
    ThinkingDelta(ThinkingDeltaMessage),
    #[serde(rename = "tool_call")]
    ToolCall(ToolCallMessage),
    #[serde(rename = "tool_call.delta")]
    ToolCallDelta(ToolCallDeltaMessage),
    #[serde(rename = "tool.progress")]
    ToolProgress(ToolProgressMessage),
    #[serde(rename = "system")]
    System(SystemMessage),
    #[serde(rename = "interaction")]
    Interaction(InteractionMessage),
    #[serde(rename = "task")]
    Task(TaskMessage),
    #[serde(rename = "todo")]
    Todo(TodoMessage),
    #[serde(rename = "agent.state")]
    AgentState(AgentStateMessage),
    #[serde(rename = "session.state")]
    SessionState(SessionStateMessage),
    #[serde(rename = "session")]
    Session(SessionMessage),
    #[serde(rename = "workspace")]
    Workspace(WorkspaceMessage),
    #[serde(rename = "config")]
    Config(ConfigMessage),
    #[serde(rename = "config.warning")]
    ConfigWarning(ConfigWarningMessage),
    #[serde(rename = "model_catalog")]
    ModelCatalog(ModelCatalogMessage),
    #[serde(rename = "plugin")]
    Plugin(PluginMessage),
    #[serde(rename = "capability")]
    Capability(CapabilityMessage),
    #[serde(rename = "hello")]
    Hello(HelloMessage),
    #[serde(rename = "ack")]
    Ack(AckMessage),
    #[serde(rename = "error")]
    Error(ErrorMessage),
}

/// Subscribes the connection to one session's entity stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscribeMessage {
    pub id: i64,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omit: Option<Vec<String>>,
}

/// Ends a subscription previously opened by `subscribe`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnsubscribeMessage {
    pub id: i64,
    pub session_id: String,
}

/// Every frame a client can send, in `clientMessageSchema` order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "subscribe")]
    Subscribe(SubscribeMessage),
    #[serde(rename = "unsubscribe")]
    Unsubscribe(UnsubscribeMessage),
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// First candidate that is neither absent nor empty.
///
/// Upstream probes its id fields in [`super::entity::ENTITY_ID_FIELDS`] order
/// and the host emits `""` for ids it does not have, so an empty candidate must
/// not shadow a later one.
fn first_non_empty<'a>(candidates: &[Option<&'a str>]) -> Option<&'a str> {
    candidates
        .iter()
        .flatten()
        .copied()
        .find(|candidate| !candidate.is_empty())
}

impl ServerMessage {
    /// The wire `type` value of this message, exactly as it appears on the wire.
    pub fn message_type(&self) -> &'static str {
        match self {
            Self::Turn(_) => "turn",
            Self::Step(_) => "step",
            Self::User(_) => "user",
            Self::Assistant(_) => "assistant",
            Self::AssistantDelta(_) => "assistant.delta",
            Self::Thinking(_) => "thinking",
            Self::ThinkingDelta(_) => "thinking.delta",
            Self::ToolCall(_) => "tool_call",
            Self::ToolCallDelta(_) => "tool_call.delta",
            Self::ToolProgress(_) => "tool.progress",
            Self::System(_) => "system",
            Self::Interaction(_) => "interaction",
            Self::Task(_) => "task",
            Self::Todo(_) => "todo",
            Self::AgentState(_) => "agent.state",
            Self::SessionState(_) => "session.state",
            Self::Session(_) => "session",
            Self::Workspace(_) => "workspace",
            Self::Config(_) => "config",
            Self::ConfigWarning(_) => "config.warning",
            Self::ModelCatalog(_) => "model_catalog",
            Self::Plugin(_) => "plugin",
            Self::Capability(_) => "capability",
            Self::Hello(_) => "hello",
            Self::Ack(_) => "ack",
            Self::Error(_) => "error",
        }
    }
}

impl ClientMessage {
    /// The wire `type` value of this frame, exactly as it appears on the wire.
    pub fn message_type(&self) -> &'static str {
        match self {
            Self::Subscribe(_) => "subscribe",
            Self::Unsubscribe(_) => "unsubscribe",
        }
    }
}

impl EntityAddressed for ServerMessage {
    fn entity_id(&self) -> Option<&str> {
        match self {
            Self::Turn(m) => {
                first_non_empty(&[Some(m.turn_id.as_str())]).or(Some(m.agent_id.as_str()))
            }
            Self::Step(m) => first_non_empty(&[Some(m.step_id.as_str()), Some(m.turn_id.as_str())])
                .or(Some(m.agent_id.as_str())),
            Self::User(m) => first_non_empty(&[Some(m.message_id.as_str()), m.turn_id.as_deref()])
                .or(Some(m.agent_id.as_str())),
            Self::Assistant(m) => Some(m.message_id.as_str()),
            Self::AssistantDelta(m) => Some(m.message_id.as_str()),
            Self::Thinking(m) => Some(m.message_id.as_str()),
            Self::ThinkingDelta(m) => Some(m.message_id.as_str()),
            Self::ToolCall(m) => first_non_empty(&[
                Some(m.tool_call_id.as_str()),
                m.task_id.as_deref(),
                m.todo_id.as_deref(),
            ])
            .or(Some(m.agent_id.as_str())),
            Self::ToolCallDelta(m) => Some(m.tool_call_id.as_str()),
            Self::ToolProgress(m) => Some(m.tool_call_id.as_str()),
            Self::System(m) => Some(m.system_id.as_str()),
            Self::Interaction(m) => {
                first_non_empty(&[Some(m.interaction_id.as_str()), m.tool_call_id.as_deref()])
                    .or(Some(m.agent_id.as_str()))
            }
            Self::Task(m) => Some(m.task_id.as_str()),
            Self::Todo(m) => Some(m.todo_id.as_str()),
            Self::AgentState(m) => first_non_empty(&[Some(m.agent_id.as_str())]),
            Self::SessionState(_)
            | Self::Session(_)
            | Self::Workspace(_)
            | Self::Config(_)
            | Self::ConfigWarning(_)
            | Self::ModelCatalog(_)
            | Self::Plugin(_)
            | Self::Capability(_)
            | Self::Hello(_)
            | Self::Ack(_)
            | Self::Error(_) => None,
        }
    }

    fn agent_id(&self) -> Option<&str> {
        match self {
            Self::Turn(m) => Some(m.agent_id.as_str()),
            Self::Step(m) => Some(m.agent_id.as_str()),
            Self::User(m) => Some(m.agent_id.as_str()),
            Self::Assistant(m) => Some(m.agent_id.as_str()),
            Self::AssistantDelta(m) => Some(m.agent_id.as_str()),
            Self::Thinking(m) => Some(m.agent_id.as_str()),
            Self::ThinkingDelta(m) => Some(m.agent_id.as_str()),
            Self::ToolCall(m) => Some(m.agent_id.as_str()),
            Self::ToolCallDelta(m) => Some(m.agent_id.as_str()),
            Self::ToolProgress(m) => Some(m.agent_id.as_str()),
            Self::System(m) => Some(m.agent_id.as_str()),
            Self::Interaction(m) => Some(m.agent_id.as_str()),
            Self::Task(m) => Some(m.agent_id.as_str()),
            Self::Todo(m) => Some(m.agent_id.as_str()),
            Self::AgentState(m) => Some(m.agent_id.as_str()),
            Self::SessionState(_)
            | Self::Session(_)
            | Self::Workspace(_)
            | Self::Config(_)
            | Self::ConfigWarning(_)
            | Self::ModelCatalog(_)
            | Self::Plugin(_)
            | Self::Capability(_)
            | Self::Hello(_)
            | Self::Ack(_)
            | Self::Error(_) => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::v3::entity::{entity_id, entity_key, key_of};

    const SESSION: &str = "s1";
    const AGENT: &str = "a1";
    const AT: i64 = 1_700_000_000_000;

    /// The shared base a message type spreads, as `union.ts` composes it.
    fn base_of(message_type: &str) -> &'static str {
        match message_type {
            "turn" | "step" | "user" | "assistant" | "assistant.delta" | "thinking"
            | "thinking.delta" | "tool_call" | "tool_call.delta" | "tool.progress" | "system"
            | "interaction" | "task" | "todo" | "agent.state" => "timeline",
            "session.state" => "session",
            "session" | "workspace" | "config" | "config.warning" | "model_catalog" | "plugin"
            | "capability" => "global",
            _ => "none",
        }
    }

    fn sample_server_messages() -> Vec<(&'static str, ServerMessage)> {
        vec![
            (
                "turn",
                ServerMessage::Turn(TurnMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    turn_id: "t1".into(),
                    ordinal: 0,
                    status: TurnStatus::Running,
                    origin: TurnOrigin::Task {
                        task_id: "tk1".into(),
                    },
                    user_message_id: Some("m1".into()),
                    attachment_ids: Some(vec!["f1".into()]),
                    started_at: Some("2026-01-01T00:00:00.000Z".into()),
                    ended_at: Some("2026-01-01T00:00:01.000Z".into()),
                    usage: Some(TurnUsage {
                        input_tokens: Some(10),
                        output_tokens: Some(2),
                        cached_tokens: Some(1),
                        cost: Some(0.0025),
                    }),
                    duration_ms: Some(1000),
                }),
            ),
            (
                "step",
                ServerMessage::Step(StepMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    step_id: "st1".into(),
                    turn_id: "t1".into(),
                    ordinal: 1,
                    status: StepStatus::Failed,
                    started_at: Some("2026-01-01T00:00:00.000Z".into()),
                    ended_at: Some("2026-01-01T00:00:01.000Z".into()),
                    usage: Some(StepUsage {
                        input_other: 1,
                        output: 2,
                        input_cache_read: 3,
                        input_cache_creation: 4,
                    }),
                    finish_reason: Some("stop".into()),
                    timing: Some(StepTiming {
                        llm_first_token_ms: Some(120),
                        llm_stream_duration_ms: Some(400),
                    }),
                    retry: Some(StepRetry {
                        failed_attempt: 1,
                        next_attempt: 2,
                        max_attempts: 3,
                        delay_ms: 500,
                        error_name: "Overloaded".into(),
                        error_message: "slow down".into(),
                        status_code: Some(529),
                    }),
                    end_reason: Some("error".into()),
                    end_message: Some("boom".into()),
                }),
            ),
            (
                "user",
                ServerMessage::User(UserMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    message_id: "m1".into(),
                    turn_id: Some("t1".into()),
                    status: UserMessageStatus::Unread,
                    timestamp: Some(AT),
                    text: vec![ContentPart {
                        r#type: ContentPartType::Text,
                        text: "hello".into(),
                        meta: HashMap::from([("k".to_string(), serde_json::json!("v"))]),
                    }],
                    attachment_ids: Some(vec!["f1".into()]),
                    skill_activations: Some(vec![SkillActivation {
                        skill_name: "tdd".into(),
                        skill_args: Some("x".into()),
                    }]),
                    origin: Some(UserMessageOrigin::Skill {
                        skill_name: "tdd".into(),
                        args: None,
                        trigger: Some("/tdd".into()),
                    }),
                }),
            ),
            (
                "assistant",
                ServerMessage::Assistant(AssistantMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    message_id: "m2".into(),
                    turn_id: "t1".into(),
                    step_id: "st1".into(),
                    status: StreamStatus::Completed,
                    text: "hi".into(),
                }),
            ),
            (
                "assistant.delta",
                ServerMessage::AssistantDelta(AssistantDeltaMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    message_id: "m2".into(),
                    text: "h".into(),
                }),
            ),
            (
                "thinking",
                ServerMessage::Thinking(ThinkingMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    message_id: "m3".into(),
                    turn_id: "t1".into(),
                    step_id: "st1".into(),
                    status: StreamStatus::Streaming,
                    text: "hmm".into(),
                }),
            ),
            (
                "thinking.delta",
                ServerMessage::ThinkingDelta(ThinkingDeltaMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    message_id: "m3".into(),
                    text: "h".into(),
                }),
            ),
            (
                "tool_call",
                ServerMessage::ToolCall(ToolCallMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    tool_call_id: "c1".into(),
                    turn_id: "t1".into(),
                    step_id: "st1".into(),
                    name: "read".into(),
                    view: Some("file".into()),
                    status: ToolCallStatus::Error,
                    input: Some(serde_json::json!({"path": "a"})),
                    input_text: Some("{}".into()),
                    output: Some(serde_json::json!("text")),
                    display: Some(serde_json::json!({"kind": "text"})),
                    error: Some("boom".into()),
                    progress: Some(ToolProgressPayload {
                        kind: ToolProgressKind::Custom,
                        text: Some("t".into()),
                        percent: Some(12.5),
                        custom_kind: Some("x".into()),
                        custom_data: Some(serde_json::json!({"a": 1})),
                    }),
                    task_id: Some("tk1".into()),
                    approval_id: Some("ap1".into()),
                    todo_id: Some("td1".into()),
                    agent_refs: Some(vec![ToolCallAgentRef {
                        agent_id: "a2".into(),
                        role: Some(ToolCallAgentRole::Child),
                    }]),
                }),
            ),
            (
                "tool_call.delta",
                ServerMessage::ToolCallDelta(ToolCallDeltaMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    tool_call_id: "c1".into(),
                    input_text: "{\"a\"".into(),
                }),
            ),
            (
                "tool.progress",
                ServerMessage::ToolProgress(ToolProgressMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    tool_call_id: "c1".into(),
                    progress: ToolProgressPayload {
                        kind: ToolProgressKind::Stdout,
                        text: Some("line".into()),
                        percent: None,
                        custom_kind: None,
                        custom_data: None,
                    },
                }),
            ),
            (
                "system",
                ServerMessage::System(SystemMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    system_id: "sy1".into(),
                    at: Some("2026-01-01T00:00:00.000Z".into()),
                    subtype: SystemSubtype::Undo,
                    payload: Some(SystemPayload::RemovedIds(SystemRemovedIdsPayload {
                        removed_ids: vec!["m1".into()],
                    })),
                }),
            ),
            (
                "interaction",
                ServerMessage::Interaction(InteractionMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    interaction_id: "i1".into(),
                    status: InteractionStatus::Answered,
                    tool_call_id: Some("c1".into()),
                    kind: InteractionKind::Question,
                    request: Some(InteractionRequest::Question(InteractionQuestionRequest {
                        questions: vec![InteractionQuestionItem {
                            id: "q1".into(),
                            question: "which?".into(),
                            header: Some("choose".into()),
                            body: Some("body".into()),
                            options: vec![InteractionQuestionOption {
                                id: "o1".into(),
                                label: "one".into(),
                                description: Some("first".into()),
                            }],
                            multi_select: Some(true),
                            allow_other: Some(true),
                            other_label: Some("other".into()),
                            other_description: Some("free text".into()),
                        }],
                    })),
                    response: Some(InteractionResponse::Question(InteractionQuestionResponse {
                        answers: HashMap::from([(
                            "q1".to_string(),
                            InteractionQuestionAnswer::MultiWithOther {
                                option_ids: vec!["o1".into()],
                                other_text: "x".into(),
                            },
                        )]),
                        method: Some(QuestionResponseMethod::Click),
                        note: Some("done".into()),
                    })),
                }),
            ),
            (
                "task",
                ServerMessage::Task(TaskMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    task_id: "tk1".into(),
                    kind: TaskKind::Subagent,
                    status: TaskStatus::TimedOut,
                    detached: true,
                    description: Some("d".into()),
                    child_agent_id: Some("a2".into()),
                    output_tail: "tail".into(),
                    started_at: Some("2026-01-01T00:00:00.000Z".into()),
                    ended_at: Some("2026-01-01T00:00:01.000Z".into()),
                    result_summary: Some("r".into()),
                    error: Some("e".into()),
                    state_reason: Some("sr".into()),
                    usage: Some(StepUsage {
                        input_other: 0,
                        output: 1,
                        input_cache_read: 2,
                        input_cache_creation: 3,
                    }),
                    model: Some("k2".into()),
                    thinking_effort: Some("high".into()),
                }),
            ),
            (
                "todo",
                ServerMessage::Todo(TodoMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    timestamp: AT,
                    todo_id: "td1".into(),
                    items: vec![TodoItem {
                        title: "write".into(),
                        status: TodoItemStatus::InProgress,
                    }],
                    updated_at: Some("2026-01-01T00:00:00.000Z".into()),
                }),
            ),
            (
                "agent.state",
                ServerMessage::AgentState(AgentStateMessage {
                    session_id: SESSION.into(),
                    agent_id: AGENT.into(),
                    profile: AgentStateProfile {
                        kind: "main".into(),
                    },
                    timestamp: AT,
                    origin: AgentStateOrigin::ToolSwarm {
                        tool_call_id: "c1".into(),
                        swarm_index: 2,
                        parent_agent_id: "a0".into(),
                    },
                    created_at: "2026-01-01T00:00:00.000Z".into(),
                    ended_at: Some("2026-01-01T00:00:01.000Z".into()),
                    status: AgentStatus::Running,
                    turn: Some(AgentStateTurn {
                        status: AgentTurnStatus::Acting,
                    }),
                }),
            ),
            (
                "session.state",
                ServerMessage::SessionState(SessionStateMessage {
                    session_id: SESSION.into(),
                    timestamp: AT,
                    status: SessionStatus::Compacting,
                    pending_interaction: Some(PendingInteraction::Approval),
                    model: Some("k2".into()),
                    thinking_effort: Some("high".into()),
                    permission: Some(PermissionMode::Yolo),
                    usage: Some(SessionStateUsage {
                        by_model: Some(HashMap::from([(
                            "k2".to_string(),
                            StepUsage {
                                input_other: 1,
                                output: 2,
                                input_cache_read: 3,
                                input_cache_creation: 4,
                            },
                        )])),
                        current_turn: None,
                        total: Some(StepUsage {
                            input_other: 1,
                            output: 2,
                            input_cache_read: 3,
                            input_cache_creation: 4,
                        }),
                    }),
                    context_tokens: Some(10),
                    max_context_tokens: Some(100),
                    goal: Some(SessionStateGoal {
                        objective: "ship".into(),
                        status: GoalStatus::Active,
                        completion_criterion: Some("green".into()),
                        budget_used: Some(1),
                        budget_limit: Some(5),
                    }),
                    modes: Some(SessionStateModes {
                        plan: Some(SessionStatePlanMode {
                            review_path: Some("/p".into()),
                            version: Some(2),
                        }),
                        swarm: Some(SessionStateSwarmMode {
                            trigger: Some("auto".into()),
                        }),
                    }),
                }),
            ),
            (
                "session",
                ServerMessage::Session(SessionMessage {
                    timestamp: AT,
                    subtype: SessionSubtype::Updated,
                    session: sample_session_info(),
                    changed_fields: Some(vec!["title".into()]),
                }),
            ),
            (
                "workspace",
                ServerMessage::Workspace(WorkspaceMessage {
                    timestamp: AT,
                    subtype: WorkspaceSubtype::Created,
                    workspace: WorkspaceInfo {
                        id: "wd_demo_0123456789ab".into(),
                        root: "/tmp/demo".into(),
                        name: "demo".into(),
                        created_at: "2026-01-01T00:00:00.000Z".into(),
                        last_opened_at: "2026-01-01T00:00:01.000Z".into(),
                        session_count: 3,
                    },
                }),
            ),
            (
                "config",
                ServerMessage::Config(ConfigMessage {
                    timestamp: AT,
                    config: serde_json::json!({"model": "k2"}),
                    changed_fields: Some(vec!["model".into()]),
                }),
            ),
            (
                "config.warning",
                ServerMessage::ConfigWarning(ConfigWarningMessage {
                    timestamp: AT,
                    warnings: vec!["unknown key".into()],
                }),
            ),
            (
                "model_catalog",
                ServerMessage::ModelCatalog(ModelCatalogMessage { timestamp: AT }),
            ),
            (
                "plugin",
                ServerMessage::Plugin(PluginMessage { timestamp: AT }),
            ),
            (
                "capability",
                ServerMessage::Capability(CapabilityMessage {
                    timestamp: AT,
                    capability_id: Some("web".into()),
                }),
            ),
            (
                "hello",
                ServerMessage::Hello(HelloMessage {
                    protocol_version: "3".into(),
                    server_id: "srv1".into(),
                    capabilities: vec!["entities".into()],
                }),
            ),
            (
                "ack",
                ServerMessage::Ack(AckMessage {
                    id: 1,
                    code: 0,
                    msg: Some("ok".into()),
                }),
            ),
            (
                "error",
                ServerMessage::Error(ErrorMessage {
                    code: -1,
                    msg: "boom".into(),
                }),
            ),
        ]
    }

    fn sample_session_info() -> SessionInfo {
        SessionInfo {
            id: SESSION.into(),
            workspace_id: "wd_demo_0123456789ab".into(),
            title: "demo".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:01.000Z".into(),
            busy: false,
            main_turn_active: Some(true),
            pending_interaction: Some(PendingInteraction::None),
            last_turn_reason: Some(LastTurnReason::Completed),
            archived: Some(false),
            archived_at: None,
            current_prompt_id: Some("p1".into()),
            last_prompt: Some("hi".into()),
            metadata: SessionInfoMetadata {
                cwd: "/tmp/demo".into(),
                extra: HashMap::from([("scratch".to_string(), serde_json::json!(1))]),
            },
            agent_config: SessionInfoAgentConfig {
                model: "k2".into(),
                system_prompt: Some("be nice".into()),
                tools: Some(vec!["read".into()]),
                mcp_servers: Some(vec!["mcp1".into()]),
                thinking: Some("high".into()),
                permission_mode: Some(PermissionMode::Auto),
                plan_mode: Some(true),
                swarm_mode: Some(false),
                tower_mode: Some(false),
                tower_base: Some("main".into()),
                goal_objective: Some("ship".into()),
                goal_control: Some(GoalControl::Resume),
            },
            usage: SessionInfoUsage {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_creation_tokens: 4,
                total_cost_usd: Some(0.5),
                context_tokens: 5,
                context_limit: Some(100),
                turn_count: Some(1),
            },
            permission_rules: vec![SessionInfoPermissionRule {
                id: "pr1".into(),
                tool_name: "bash".into(),
                matcher: Some(SessionInfoPermissionMatcher {
                    kind: PermissionMatcherKind::CommandPrefix,
                    value: Some("git".into()),
                }),
                decision: PermissionRuleDecision::Approved,
                created_at: "2026-01-01T00:00:00.000Z".into(),
                created_by: PermissionRuleCreator::User,
            }],
            message_count: 2,
            last_seq: 7,
        }
    }

    /// Minimal but complete JSON per message type, hand-written from the TS so a
    /// wrong tag literal or a missing `#[serde(default)]` fails here.
    const MINIMAL_SERVER_JSON: &[(&str, &str)] = &[
        (
            "turn",
            r#"{"type":"turn","session_id":"s1","agent_id":"a1","timestamp":1,"turn_id":"t1","ordinal":0,"status":"running","origin":{"kind":"user"}}"#,
        ),
        (
            "turn/task-origin",
            r#"{"type":"turn","session_id":"s1","agent_id":"a1","timestamp":1,"turn_id":"t1","ordinal":0,"status":"completed","origin":{"kind":"task","task_id":"tk1"}}"#,
        ),
        (
            "step",
            r#"{"type":"step","session_id":"s1","agent_id":"a1","timestamp":2,"step_id":"st1","turn_id":"t1","ordinal":1,"status":"running"}"#,
        ),
        (
            "user",
            r#"{"type":"user","session_id":"s1","agent_id":"a1","message_id":"m1","status":"unread","text":[{"type":"text","text":"hi","meta":{}}]}"#,
        ),
        (
            "assistant",
            r#"{"type":"assistant","session_id":"s1","agent_id":"a1","timestamp":4,"message_id":"m2","turn_id":"t1","step_id":"st1","status":"streaming","text":""}"#,
        ),
        (
            "assistant.delta",
            r#"{"type":"assistant.delta","session_id":"s1","agent_id":"a1","timestamp":5,"message_id":"m2","text":"x"}"#,
        ),
        (
            "thinking",
            r#"{"type":"thinking","session_id":"s1","agent_id":"a1","timestamp":6,"message_id":"m3","turn_id":"t1","step_id":"st1","status":"completed","text":"t"}"#,
        ),
        (
            "thinking.delta",
            r#"{"type":"thinking.delta","session_id":"s1","agent_id":"a1","timestamp":7,"message_id":"m3","text":"t"}"#,
        ),
        (
            "tool_call",
            r#"{"type":"tool_call","session_id":"s1","agent_id":"a1","timestamp":8,"tool_call_id":"c1","turn_id":"t1","step_id":"st1","name":"read","status":"running"}"#,
        ),
        (
            "tool_call.delta",
            r#"{"type":"tool_call.delta","session_id":"s1","agent_id":"a1","timestamp":9,"tool_call_id":"c1","input_text":"{"}"#,
        ),
        (
            "tool.progress",
            r#"{"type":"tool.progress","session_id":"s1","agent_id":"a1","timestamp":10,"tool_call_id":"c1","progress":{"kind":"stdout"}}"#,
        ),
        (
            "system/compaction",
            r#"{"type":"system","session_id":"s1","agent_id":"a1","timestamp":11,"system_id":"sy1","subtype":"compaction"}"#,
        ),
        (
            "system/undo",
            r#"{"type":"system","session_id":"s1","agent_id":"a1","timestamp":11,"system_id":"sy1","subtype":"undo","payload":{"removed_ids":["m1"]}}"#,
        ),
        (
            "system/plan.enter",
            r#"{"type":"system","session_id":"s1","agent_id":"a1","timestamp":11,"system_id":"sy1","subtype":"plan.enter","payload":{"version":1}}"#,
        ),
        (
            "interaction/approval",
            r#"{"type":"interaction","session_id":"s1","agent_id":"a1","timestamp":12,"interaction_id":"i1","status":"pending","kind":"approval","request":{"tool_name":"bash","action":"run"}}"#,
        ),
        (
            "interaction/question",
            r#"{"type":"interaction","session_id":"s1","agent_id":"a1","timestamp":12,"interaction_id":"i2","status":"answered","kind":"question","response":{"answers":{"q1":{"kind":"single","option_id":"o1"}}}}"#,
        ),
        (
            "interaction/approval-response",
            r#"{"type":"interaction","session_id":"s1","agent_id":"a1","timestamp":12,"interaction_id":"i3","status":"approved","kind":"approval","response":{"decision":"approved","scope":"session"}}"#,
        ),
        (
            "task",
            r#"{"type":"task","session_id":"s1","agent_id":"a1","timestamp":13,"task_id":"tk1","kind":"shell","status":"running","detached":false,"output_tail":""}"#,
        ),
        (
            "todo",
            r#"{"type":"todo","session_id":"s1","agent_id":"a1","timestamp":14,"todo_id":"td1","items":[{"title":"write","status":"in_progress"}]}"#,
        ),
        (
            "agent.state",
            r#"{"type":"agent.state","session_id":"s1","agent_id":"a1","profile":{"kind":"main"},"timestamp":15,"origin":{"kind":"tool-agent","tool_call_id":"c1","parent_agent_id":"a0"},"created_at":"2026-01-01T00:00:00.000Z","status":"idle"}"#,
        ),
        (
            "session.state",
            r#"{"type":"session.state","session_id":"s1","timestamp":16,"status":"idle"}"#,
        ),
        (
            "session",
            r#"{"type":"session","timestamp":17,"subtype":"created","session":{"id":"s1","workspace_id":"wd_demo_0123456789ab","title":"t","created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","busy":false,"metadata":{"cwd":"/tmp","scratch":1},"agent_config":{"model":"k2"},"usage":{"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"context_tokens":0},"permission_rules":[],"message_count":0,"last_seq":0}}"#,
        ),
        (
            "workspace",
            r#"{"type":"workspace","timestamp":18,"subtype":"deleted","workspace":{"id":"wd_demo_0123456789ab","root":"/tmp","name":"demo","created_at":"2026-01-01T00:00:00.000Z","last_opened_at":"2026-01-01T00:00:00.000Z","session_count":0}}"#,
        ),
        ("config", r#"{"type":"config","timestamp":19,"config":{}}"#),
        (
            "config.warning",
            r#"{"type":"config.warning","timestamp":20,"warnings":[]}"#,
        ),
        (
            "model_catalog",
            r#"{"type":"model_catalog","timestamp":21}"#,
        ),
        ("plugin", r#"{"type":"plugin","timestamp":22}"#),
        ("capability", r#"{"type":"capability","timestamp":23}"#),
        (
            "hello",
            r#"{"type":"hello","protocol_version":"3","server_id":"srv1","capabilities":[]}"#,
        ),
        ("ack", r#"{"type":"ack","id":1,"code":0}"#),
        ("error", r#"{"type":"error","code":-1,"msg":"boom"}"#),
    ];

    #[test]
    fn test_server_message_round_trip_keeps_tag_and_base_fields() {
        let samples = sample_server_messages();
        assert_eq!(
            samples.len(),
            26,
            "one sample per serverMessageSchema entry"
        );

        for (message_type, message) in samples {
            assert_eq!(message.message_type(), message_type);

            let value = serde_json::to_value(&message).expect("serializes");
            assert_eq!(value["type"], serde_json::json!(message_type));

            match base_of(message_type) {
                "timeline" => {
                    for field in ["session_id", "agent_id", "timestamp"] {
                        assert!(
                            value.get(field).is_some(),
                            "{message_type} must carry timeline field {field}"
                        );
                    }
                }
                "session" => {
                    for field in ["session_id", "timestamp"] {
                        assert!(
                            value.get(field).is_some(),
                            "{message_type} must carry session field {field}"
                        );
                    }
                    assert!(
                        value.get("agent_id").is_none(),
                        "{message_type} has no agent"
                    );
                }
                "global" => {
                    assert!(
                        value.get("timestamp").is_some(),
                        "{message_type} has a timestamp"
                    );
                    assert!(
                        value.get("session_id").is_none(),
                        "{message_type} is not scoped"
                    );
                }
                _ => {
                    assert!(
                        value.get("timestamp").is_none(),
                        "{message_type} carries no base"
                    );
                }
            }

            let back: ServerMessage = serde_json::from_value(value).expect("deserializes");
            assert_eq!(back, message, "{message_type} must survive a round trip");
        }
    }

    #[test]
    fn test_client_message_round_trip() {
        let samples = [
            (
                "subscribe",
                ClientMessage::Subscribe(SubscribeMessage {
                    id: 1,
                    session_id: SESSION.into(),
                    agent_ids: Some(vec![AGENT.into()]),
                    omit: Some(vec!["assistant.delta".into()]),
                }),
            ),
            (
                "unsubscribe",
                ClientMessage::Unsubscribe(UnsubscribeMessage {
                    id: 2,
                    session_id: SESSION.into(),
                }),
            ),
        ];

        for (message_type, message) in samples {
            assert_eq!(message.message_type(), message_type);
            let value = serde_json::to_value(&message).expect("serializes");
            assert_eq!(value["type"], serde_json::json!(message_type));
            let back: ClientMessage = serde_json::from_value(value).expect("deserializes");
            assert_eq!(back, message);
        }

        let minimal = [
            (
                "subscribe",
                r#"{"type":"subscribe","id":1,"session_id":"s1"}"#,
            ),
            (
                "unsubscribe",
                r#"{"type":"unsubscribe","id":2,"session_id":"s1"}"#,
            ),
        ];
        for (message_type, json) in minimal {
            let message: ClientMessage = serde_json::from_str(json).expect("minimal client frame");
            assert_eq!(message.message_type(), message_type);
        }
    }

    #[test]
    fn test_every_server_variant_parses_hand_written_json() {
        let mut seen: Vec<&str> = Vec::new();
        for (label, json) in MINIMAL_SERVER_JSON {
            let message: ServerMessage = serde_json::from_str(json)
                .unwrap_or_else(|error| panic!("{label} must deserialize: {error}"));
            let expected = label.split('/').next().unwrap_or(label);
            assert_eq!(message.message_type(), expected, "{label} tag mismatch");
            seen.push(expected);

            // Re-serializing must reproduce the same tag, and re-parse.
            let value = serde_json::to_value(&message).expect("serializes");
            assert_eq!(value["type"], serde_json::json!(expected));
            let back: ServerMessage =
                serde_json::from_value(value).unwrap_or_else(|error| panic!("{label}: {error}"));
            assert_eq!(back, message);
        }

        for (message_type, _) in sample_server_messages() {
            assert!(
                seen.contains(&message_type),
                "{message_type} has no hand-written JSON sample"
            );
        }
    }

    #[test]
    fn test_system_undo_payload_prefers_the_typed_shape() {
        let message: ServerMessage = serde_json::from_str(
            r#"{"type":"system","session_id":"s1","agent_id":"a1","timestamp":1,"system_id":"sy1","subtype":"undo","payload":{"removed_ids":["m1"]}}"#,
        )
        .expect("deserializes");
        let ServerMessage::System(system) = message else {
            panic!("expected a system message");
        };
        assert_eq!(
            system.payload,
            Some(SystemPayload::RemovedIds(SystemRemovedIdsPayload {
                removed_ids: vec!["m1".into()],
            }))
        );

        let other: ServerMessage = serde_json::from_str(
            r#"{"type":"system","session_id":"s1","agent_id":"a1","timestamp":1,"system_id":"sy1","subtype":"goal","payload":{"objective":"x"}}"#,
        )
        .expect("deserializes");
        let ServerMessage::System(system) = other else {
            panic!("expected a system message");
        };
        assert_eq!(
            system.payload,
            Some(SystemPayload::Other(serde_json::json!({"objective": "x"})))
        );

        let absent: ServerMessage = serde_json::from_str(
            r#"{"type":"system","session_id":"s1","agent_id":"a1","timestamp":1,"system_id":"sy1","subtype":"clear"}"#,
        )
        .expect("payload is optional while deserializing");
        let ServerMessage::System(system) = absent else {
            panic!("expected a system message");
        };
        assert_eq!(system.payload, None);
    }

    #[test]
    fn test_message_type_matches_the_wire_and_identity_uses_own_ids() {
        let samples = sample_server_messages();

        // Addressed by `message_id` (first field of the probe order).
        let assistant = ServerMessage::Assistant(AssistantMessage {
            session_id: SESSION.into(),
            agent_id: AGENT.into(),
            timestamp: AT,
            message_id: "m2".into(),
            turn_id: "t1".into(),
            step_id: "st1".into(),
            status: StreamStatus::Completed,
            text: String::new(),
        });
        assert_eq!(assistant.message_type(), "assistant");
        assert_eq!(entity_id(&assistant), "m2");
        assert_eq!(
            key_of(&assistant, assistant.message_type()),
            "a1:assistant:m2"
        );

        // Addressed only by `turn_id`.
        let turn = ServerMessage::Turn(TurnMessage {
            session_id: SESSION.into(),
            agent_id: AGENT.into(),
            timestamp: AT,
            turn_id: "t1".into(),
            ordinal: 0,
            status: TurnStatus::Completed,
            origin: TurnOrigin::User,
            user_message_id: None,
            attachment_ids: None,
            started_at: None,
            ended_at: None,
            usage: None,
            duration_ms: None,
        });
        assert_eq!(entity_id(&turn), "t1");
        assert_eq!(key_of(&turn, turn.message_type()), "a1:turn:t1");

        // Session-scoped: an id, but no agent id.
        let session_state = ServerMessage::SessionState(SessionStateMessage {
            session_id: SESSION.into(),
            timestamp: AT,
            status: SessionStatus::Idle,
            pending_interaction: None,
            model: None,
            thinking_effort: None,
            permission: None,
            usage: None,
            context_tokens: None,
            max_context_tokens: None,
            goal: None,
            modes: None,
        });
        assert_eq!(session_state.message_type(), "session.state");
        assert_eq!(session_state.entity_id(), None);
        assert_eq!(session_state.agent_id(), None);
        assert_eq!(entity_id(&session_state), "");
        assert_eq!(
            key_of(&session_state, session_state.message_type()),
            ":session.state:"
        );

        // Global: neither an id nor an agent id.
        let config = ServerMessage::Config(ConfigMessage {
            timestamp: AT,
            config: serde_json::Value::Null,
            changed_fields: None,
        });
        assert_eq!(config.message_type(), "config");
        assert_eq!(config.entity_id(), None);
        assert_eq!(config.agent_id(), None);
        assert_eq!(key_of(&config, config.message_type()), ":config:");

        // The agent state fallback resolves through `agent_id` last.
        let agent_state = ServerMessage::AgentState(AgentStateMessage {
            session_id: SESSION.into(),
            agent_id: AGENT.into(),
            profile: AgentStateProfile {
                kind: "main".into(),
            },
            timestamp: AT,
            origin: AgentStateOrigin::Main,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            ended_at: None,
            status: AgentStatus::Idle,
            turn: None,
        });
        assert_eq!(entity_id(&agent_state), AGENT);
        assert_eq!(
            key_of(&agent_state, agent_state.message_type()),
            "a1:agent.state:a1"
        );

        // Every timeline message reports its agent, none of the others does.
        for (message_type, message) in samples {
            if base_of(message_type) == "timeline" {
                assert_eq!(message.agent_id(), Some(AGENT), "{message_type} agent");
                assert!(!entity_id(&message).is_empty(), "{message_type} entity id");
            } else {
                assert_eq!(message.agent_id(), None, "{message_type} has no agent");
            }
        }

        assert_eq!(
            entity_key(None, "session.state", ""),
            ":session.state:",
            "session entities keep their empty agent segment"
        );
    }

    #[test]
    fn test_optional_fields_are_skipped_and_absent_fields_default() {
        let message = ServerMessage::Turn(TurnMessage {
            session_id: SESSION.into(),
            agent_id: AGENT.into(),
            timestamp: 1,
            turn_id: "t1".into(),
            ordinal: 0,
            status: TurnStatus::Running,
            origin: TurnOrigin::User,
            user_message_id: None,
            attachment_ids: None,
            started_at: None,
            ended_at: None,
            usage: None,
            duration_ms: None,
        });
        let value = serde_json::to_value(&message).expect("serializes");
        assert!(value.get("usage").is_none(), "absent optionals stay absent");
        assert!(value.get("duration_ms").is_none());

        // Unknown fields are ignored, matching zod's strip behaviour.
        let parsed: ServerMessage = serde_json::from_str(
            r#"{"type":"turn","session_id":"s1","agent_id":"a1","timestamp":1,"turn_id":"t1","ordinal":0,"status":"running","origin":{"kind":"user"},"future_field":true}"#,
        )
        .expect("unknown fields are stripped");
        assert_eq!(parsed, message);

        // An unknown tag is rejected rather than silently dropped.
        assert!(serde_json::from_str::<ServerMessage>(r#"{"type":"nope"}"#).is_err());
    }
}
