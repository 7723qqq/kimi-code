//! Structured description of what a tool is about to do, rendered by hosts as
//! a rich card instead of a raw argument string.
//!
//! Ported from v2 `packages/agent-core-v2/src/tool/toolInputDisplay.ts` —
//! the discriminated union of 12 variants, field for field. v2 hangs it off
//! `RunnableToolExecution.display` (declared before execution) and
//! `ToolResult.display` (settled after); both exist here, and a client that
//! knows the union can render the same card v2 clients do.
//!
//! The `kind` tag is the wire name, exactly as in v2, because hosts switch on
//! it (`acp/events_map.rs` maps `todo_list` to an ACP `plan` update).
//!
//! Optional fields are `None` rather than an empty string so a host can tell
//! "absent" from "present but empty" — v2's `?: T | undefined` says the same
//! thing and `skip_serializing_if` keeps the absent case off the wire.

use serde::{Deserialize, Serialize};

use serde_json::Value;

/// One entry of a `todo_list` display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoListItem {
    pub title: String,
    pub status: String,
}

/// The label/description pair offered by a `plan_review`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanReviewOption {
    pub label: String,
    pub description: String,
}

/// What a tool is about to do (v2 `ToolInputDisplay`).
///
/// Every variant's field names and optionality mirror the TS union; the enum
/// tag serializes as `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolInputDisplay {
    /// A shell command the tool will run.
    Command {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        /// v2 types this `'bash' | undefined`; kept as the literal so a host
        /// cannot be handed a language this engine never emitted.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
    /// A file operation (read / write / edit / glob / grep).
    FileIo {
        operation: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
    },
    /// A unified diff of a change.
    Diff {
        path: String,
        before: String,
        after: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hunks: Option<u32>,
    },
    /// A search the tool will run.
    Search {
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    /// A URL the tool will fetch.
    UrlFetch {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        method: Option<String>,
    },
    /// A delegation to a subagent.
    AgentCall {
        agent_name: String,
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background: Option<bool>,
    },

    /// A skill invocation.
    SkillCall {
        skill_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<String>,
    },
    /// The todo list the tool is about to write (v2 `TodoList`).
    TodoList { items: Vec<TodoListItem> },
    /// A background task the tool will start or inspect.
    Task {
        task_id: String,
        status: String,
        description: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_kind: Option<String>,
    },
    /// A background task being stopped.
    TaskStop {
        task_id: String,
        task_description: String,
    },
    /// A plan submitted for the user to review.
    PlanReview {
        plan: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        options: Option<Vec<PlanReviewOption>>,
    },
    /// A goal the agent is starting.
    GoalStart {
        objective: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion_criterion: Option<String>,
        /// v2 narrows this to `'manual' | 'yolo'`; kept as the literal pair the
        /// engine can actually be in rather than an open string.
        mode: String,
    },
    /// The fallback when no richer variant applies.
    Generic {
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<Value>,
    },
}

impl ToolInputDisplay {
    /// The wire `kind` tag, without serializing the whole block.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Command { .. } => "command",
            Self::FileIo { .. } => "file_io",
            Self::Diff { .. } => "diff",
            Self::Search { .. } => "search",
            Self::UrlFetch { .. } => "url_fetch",
            Self::AgentCall { .. } => "agent_call",
            Self::SkillCall { .. } => "skill_call",
            Self::TodoList { .. } => "todo_list",
            Self::Task { .. } => "task",
            Self::TaskStop { .. } => "task_stop",
            Self::PlanReview { .. } => "plan_review",
            Self::GoalStart { .. } => "goal_start",
            Self::Generic { .. } => "generic",
        }
    }

    /// The `todo_list` items, if this is a todo-list block (v2's
    /// `planFromDisplayBlock` guard is `display.kind !== 'todo_list'`).
    pub fn todo_items(&self) -> Option<&[TodoListItem]> {
        match self {
            Self::TodoList { items } => Some(items),
            _ => None,
        }
    }
}
