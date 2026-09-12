use std::collections::HashMap;

use serde_json::Value;

use super::model::{
    ActivityMeta, AgentPermission, AgentStatusMeta, AttachmentSource, InteractionKind,
    InteractionState, StepState, StepUsage, TaskKind, TaskState, TextFrame, TextRole,
    ThinkingFrame, ToolCallFrame, ToolFrameProgress, ToolFrameState, ToolProgressKind,
    TranscriptAttachment, TranscriptFrame, TranscriptInteraction, TranscriptItem, TranscriptMarker,
    TranscriptMeta, TranscriptMetaMerge, TranscriptPrompt, TranscriptPromptStatus, TranscriptStep,
    TranscriptTask, TranscriptTurn, TurnOrigin, TurnState,
};
use super::ops::{
    AgentTranscriptSnapshot, AppendTarget, StepHeader, TranscriptOperation, TurnHeader,
};
use crate::events::EngineEvent;

#[derive(Debug, Clone, Copy)]
struct Cursor {
    turn: usize,
    step: usize,
    frame: Option<usize>,
}

pub struct TranscriptProjector {
    turns: Vec<TranscriptTurn>,
    turn_indices: HashMap<String, usize>,
    tasks: Vec<TranscriptTask>,
    interactions: Vec<TranscriptInteraction>,
    prompts: Vec<TranscriptPrompt>,
    attachments: Vec<TranscriptAttachment>,
    meta: TranscriptMeta,
    cursor: Option<Cursor>,
}

impl TranscriptProjector {
    pub fn new() -> Self {
        Self {
            turns: Vec::new(),
            turn_indices: HashMap::new(),
            tasks: Vec::new(),
            interactions: Vec::new(),
            prompts: Vec::new(),
            attachments: Vec::new(),
            meta: TranscriptMeta::default(),
            cursor: None,
        }
    }

    pub fn apply_event(&mut self, event: &EngineEvent) -> Vec<TranscriptOperation> {
        match event {
            EngineEvent::TurnStarted {
                turn_id, prompt, ..
            } => {
                let turn_idx = self.ensure_turn(&turn_key_u64(*turn_id));
                self.turns[turn_idx].state = TurnState::Running;
                self.turns[turn_idx].started_at = Some(now_iso());
                if let Some(prompt) = prompt
                    && !prompt.is_empty()
                {
                    self.turns[turn_idx].prompt = Some(prompt.clone());
                }
                self.cursor = Some(Cursor {
                    turn: turn_idx,
                    step: 0,
                    frame: None,
                });
                vec![TranscriptOperation::TurnUpsert {
                    turn: turn_header(&self.turns[turn_idx]),
                }]
            }
            EngineEvent::LlmStepBegin { turn_id, step } => {
                let turn_idx = self.ensure_turn(&turn_key(turn_id));
                let step_idx = self.ensure_step(turn_idx, i64::from(*step));
                self.cursor = Some(Cursor {
                    turn: turn_idx,
                    step: step_idx,
                    frame: None,
                });
                vec![TranscriptOperation::StepUpsert {
                    turn_id: self.turns[turn_idx].turn_id.clone(),
                    step: step_header(&self.turns[turn_idx].steps[step_idx]),
                }]
            }
            EngineEvent::AssistantDelta { turn_id, delta, .. } => {
                let turn_idx = self.ensure_turn(&turn_key_u64(*turn_id));
                self.push_delta(turn_idx, delta, false)
            }
            EngineEvent::ThinkingDelta { turn_id, delta, .. } => {
                let turn_idx = self.ensure_turn(&turn_key_u64(*turn_id));
                self.push_delta(turn_idx, delta, true)
            }
            EngineEvent::ToolCallStarted {
                turn_id,
                tool_call_id,
                name,
                args,
                ..
            } => {
                let turn_idx = self.ensure_turn(&turn_key_u64(*turn_id));
                if let Some((step_idx, frame_idx)) = self.find_tool_frame(turn_idx, tool_call_id) {
                    if let TranscriptFrame::Tool(frame) =
                        &mut self.turns[turn_idx].steps[step_idx].frames[frame_idx]
                    {
                        frame.name = name.clone();
                        frame.input = Some(args.clone());
                        frame.state = ToolFrameState::Running;
                    }
                    self.cursor = Some(Cursor {
                        turn: turn_idx,
                        step: step_idx,
                        frame: Some(frame_idx),
                    });
                    return vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)];
                }
                let step_idx = self.step_index_for_turn(turn_idx);
                let step_id = self.turns[turn_idx].steps[step_idx].step_id.clone();
                let frame = TranscriptFrame::Tool(ToolCallFrame {
                    frame_id: format!("{step_id}.{tool_call_id}"),
                    tool_call_id: tool_call_id.clone(),
                    name: name.clone(),
                    view: None,
                    state: ToolFrameState::Running,
                    input: Some(args.clone()),
                    output: None,
                    display: None,
                    error: None,
                    input_text: None,
                    progress: None,
                    task_id: None,
                    approval_id: None,
                    todo_id: None,
                    agent_refs: None,
                });
                self.turns[turn_idx].steps[step_idx].frames.push(frame);
                let frame_idx = self.turns[turn_idx].steps[step_idx].frames.len() - 1;
                self.cursor = Some(Cursor {
                    turn: turn_idx,
                    step: step_idx,
                    frame: Some(frame_idx),
                });
                vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)]
            }
            EngineEvent::ToolCallCompleted {
                turn_id,
                tool_call_id,
                result,
                ..
            } => {
                let Some(turn_idx) = self.resolve_turn(*turn_id) else {
                    return Vec::new();
                };
                let Some((step_idx, frame_idx)) = self.find_tool_frame(turn_idx, tool_call_id)
                else {
                    return Vec::new();
                };
                if let TranscriptFrame::Tool(frame) =
                    &mut self.turns[turn_idx].steps[step_idx].frames[frame_idx]
                {
                    frame.state = ToolFrameState::Done;
                    frame.output = Some(result.clone());
                }
                vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)]
            }
            EngineEvent::ToolCallFailed {
                turn_id,
                tool_call_id,
                error,
                ..
            } => {
                let Some(turn_idx) = self.resolve_turn(*turn_id) else {
                    return Vec::new();
                };
                let Some((step_idx, frame_idx)) = self.find_tool_frame(turn_idx, tool_call_id)
                else {
                    return Vec::new();
                };
                if let TranscriptFrame::Tool(frame) =
                    &mut self.turns[turn_idx].steps[step_idx].frames[frame_idx]
                {
                    frame.state = ToolFrameState::Error;
                    frame.error = Some(error.clone());
                }
                vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)]
            }
            EngineEvent::ToolProgress {
                turn_id,
                tool_call_id,
                update,
                ..
            } => {
                let Some(turn_idx) = self.resolve_turn(*turn_id) else {
                    return Vec::new();
                };
                let Some((step_idx, frame_idx)) = self.find_tool_frame(turn_idx, tool_call_id)
                else {
                    return Vec::new();
                };
                if let TranscriptFrame::Tool(frame) =
                    &mut self.turns[turn_idx].steps[step_idx].frames[frame_idx]
                {
                    frame.progress = Some(progress_from_update(update));
                }
                vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)]
            }
            EngineEvent::ToolNative {
                turn_id,
                tool_call_id,
                tool_name,
                arguments,
                content,
                is_error,
                ..
            } => {
                let turn_idx = self.ensure_turn(&turn_key(turn_id));
                let state = if *is_error {
                    ToolFrameState::Error
                } else {
                    ToolFrameState::Done
                };
                if let Some((step_idx, frame_idx)) = self.find_tool_frame(turn_idx, tool_call_id) {
                    if let TranscriptFrame::Tool(frame) =
                        &mut self.turns[turn_idx].steps[step_idx].frames[frame_idx]
                    {
                        frame.state = state;
                        frame.output = Some(serde_json::json!(content));
                    }
                    self.cursor = Some(Cursor {
                        turn: turn_idx,
                        step: step_idx,
                        frame: Some(frame_idx),
                    });
                    return vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)];
                }
                let step_idx = self.step_index_for_turn(turn_idx);
                let step_id = self.turns[turn_idx].steps[step_idx].step_id.clone();
                let frame = TranscriptFrame::Tool(ToolCallFrame {
                    frame_id: format!("{step_id}.{tool_call_id}"),
                    tool_call_id: tool_call_id.clone(),
                    name: tool_name.clone(),
                    view: None,
                    state,
                    input: Some(arguments.clone()),
                    output: Some(serde_json::json!(content)),
                    display: None,
                    error: None,
                    input_text: None,
                    progress: None,
                    task_id: None,
                    approval_id: None,
                    todo_id: None,
                    agent_refs: None,
                });
                self.turns[turn_idx].steps[step_idx].frames.push(frame);
                let frame_idx = self.turns[turn_idx].steps[step_idx].frames.len() - 1;
                self.cursor = Some(Cursor {
                    turn: turn_idx,
                    step: step_idx,
                    frame: Some(frame_idx),
                });
                vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)]
            }
            EngineEvent::LlmStepEnd {
                turn_id,
                step,
                usage,
            } => {
                let turn_idx = self.ensure_turn(&turn_key(turn_id));
                let step_idx = self.ensure_step(turn_idx, i64::from(*step));
                {
                    let step = &mut self.turns[turn_idx].steps[step_idx];
                    step.state = StepState::Completed;
                    step.ended_at = Some(now_iso());
                    if let Some(usage) = usage {
                        step.usage = Some(StepUsage {
                            input_other: i64::from(usage.input_tokens),
                            output: i64::from(usage.output_tokens),
                            input_cache_read: i64::from(usage.input_cache_read),
                            input_cache_creation: i64::from(usage.input_cache_creation),
                        });
                    }
                }
                vec![TranscriptOperation::StepUpsert {
                    turn_id: self.turns[turn_idx].turn_id.clone(),
                    step: step_header(&self.turns[turn_idx].steps[step_idx]),
                }]
            }
            EngineEvent::ToolCallDelta {
                tool_call_id,
                arguments_part,
                ..
            } => {
                let Some((turn_idx, step_idx, frame_idx)) = self.find_tool_frame_any(tool_call_id)
                else {
                    return Vec::new();
                };
                if let Some(part) = arguments_part
                    && let TranscriptFrame::Tool(frame) =
                        &mut self.turns[turn_idx].steps[step_idx].frames[frame_idx]
                {
                    frame
                        .input_text
                        .get_or_insert_with(String::new)
                        .push_str(part);
                }
                vec![self.tool_frame_op(turn_idx, step_idx, frame_idx)]
            }
            EngineEvent::TurnEnded {
                turn_id, reason, ..
            } => {
                let turn_idx = self.ensure_turn(&turn_key_u64(*turn_id));
                self.turns[turn_idx].state = match reason.as_str() {
                    "cancelled" | "aborted" => TurnState::Cancelled,
                    "failed" => TurnState::Failed,
                    _ => TurnState::Completed,
                };
                self.turns[turn_idx].ended_at = Some(now_iso());
                vec![TranscriptOperation::TurnUpsert {
                    turn: turn_header(&self.turns[turn_idx]),
                }]
            }
            EngineEvent::SubagentSpawned { agent_id, .. } => {
                self.subagent_task_ops(agent_id, TaskState::Running, None, None)
            }
            EngineEvent::SubagentCompleted { agent_id, summary } => {
                self.subagent_task_ops(agent_id, TaskState::Completed, Some(summary.clone()), None)
            }
            EngineEvent::SubagentFailed { agent_id, error } => {
                self.subagent_task_ops(agent_id, TaskState::Failed, None, Some(error.clone()))
            }
            EngineEvent::Custom(value) => match value.get("type").and_then(|t| t.as_str()) {
                Some("event.task.created") | Some("event.task.completed") => {
                    match task_from_event(value) {
                        Some(task) => {
                            let task = self.merge_task(task);
                            vec![TranscriptOperation::TaskUpsert { task }]
                        }
                        None => Vec::new(),
                    }
                }
                Some("event.task.progress") => {
                    let Some(task_id) = value.get("task_id").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let Some(chunk) = value.get("output_chunk").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let Some(idx) = self.tasks.iter().position(|task| task.task_id == task_id)
                    else {
                        return Vec::new();
                    };
                    let offset = self.tasks[idx].output_tail.chars().count() as u64;
                    self.tasks[idx].output_tail.push_str(chunk);
                    vec![TranscriptOperation::Append {
                        target: AppendTarget::Task {
                            task_id: task_id.to_string(),
                        },
                        offset,
                        text: chunk.to_string(),
                    }]
                }
                Some("event.assistant.delta") => {
                    let Some(delta) = value.get("delta").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let Some(cursor) = self.cursor else {
                        return Vec::new();
                    };
                    self.push_delta(cursor.turn, delta, false)
                }
                Some("event.question.requested") => {
                    let Some(id) = value.get("question_id").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let interaction = TranscriptInteraction {
                        interaction_id: id.to_string(),
                        interaction_kind: InteractionKind::Question,
                        tool_call_id: value
                            .get("tool_call_id")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        state: InteractionState::Pending,
                        request: Some(value.clone()),
                        response: None,
                    };
                    vec![self.upsert_interaction(interaction)]
                }
                Some("event.question.answered") | Some("event.question.dismissed") => {
                    let Some(id) = value.get("question_id").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let state = if value.get("type").and_then(|v| v.as_str())
                        == Some("event.question.answered")
                    {
                        InteractionState::Answered
                    } else {
                        InteractionState::Dismissed
                    };
                    self.patch_interaction(id, state, Some(value.clone()))
                        .into_iter()
                        .collect()
                }
                Some("event.approval.requested") => {
                    let Some(id) = value.get("approval_id").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let interaction = TranscriptInteraction {
                        interaction_id: id.to_string(),
                        interaction_kind: InteractionKind::Approval,
                        tool_call_id: value
                            .get("tool_call_id")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        state: InteractionState::Pending,
                        request: Some(value.clone()),
                        response: None,
                    };
                    vec![self.upsert_interaction(interaction)]
                }
                Some("event.approval.resolved") => {
                    let Some(id) = value.get("approval_id").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let state = match value.get("decision").and_then(|v| v.as_str()) {
                        Some("allow") | Some("approved") => InteractionState::Approved,
                        _ => InteractionState::Rejected,
                    };
                    self.patch_interaction(id, state, Some(value.clone()))
                        .into_iter()
                        .collect()
                }
                Some("event.approval.expired") => {
                    let Some(id) = value.get("approval_id").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    self.patch_interaction(id, InteractionState::Cancelled, None)
                        .into_iter()
                        .collect()
                }
                Some("event.message.created") => {
                    let Some(message) = value.get("message") else {
                        return Vec::new();
                    };
                    if message.get("role").and_then(|v| v.as_str()) != Some("user") {
                        return Vec::new();
                    }
                    let Some(id) = message.get("id").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let prompt = TranscriptPrompt {
                        prompt_id: id.to_string(),
                        status: TranscriptPromptStatus::Running,
                        user_message_id: Some(id.to_string()),
                        content: message.get("content").cloned(),
                        created_at: message
                            .get("created_at")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(now_iso),
                        finished_at: None,
                        steered_at: None,
                    };
                    let mut ops = vec![self.upsert_prompt(prompt)];
                    if let Some(blocks) = message.get("content").and_then(|v| v.as_array()) {
                        for block in blocks {
                            if let Some(attachment) = attachment_from_block(block) {
                                ops.push(self.upsert_attachment(attachment));
                            }
                        }
                    }
                    ops
                }
                Some("agent.status.updated") => self.merge_agent_meta(value),
                Some("event.session.work_changed") => {
                    let busy = value.get("busy").and_then(|v| v.as_bool()).unwrap_or(false);
                    self.merge_activity(busy)
                }
                Some("hook.result") => vec![TranscriptOperation::MarkerUpsert {
                    item: TranscriptMarker {
                        marker_id: format!("hook-{:016x}", fastrand::u64(..)),
                        marker: "hook".to_string(),
                        payload: Some(value.clone()),
                        at: Some(now_iso()),
                    },
                    before_turn: None,
                }],
                Some("context.compaction")
                | Some("compaction.started")
                | Some("compaction.completed") => vec![TranscriptOperation::MarkerUpsert {
                    item: TranscriptMarker {
                        marker_id: format!("compaction-{:016x}", fastrand::u64(..)),
                        marker: "compaction".to_string(),
                        payload: Some(value.clone()),
                        at: Some(now_iso()),
                    },
                    before_turn: None,
                }],
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    pub fn snapshot(&self) -> AgentTranscriptSnapshot {
        AgentTranscriptSnapshot {
            items: self
                .turns
                .iter()
                .cloned()
                .map(TranscriptItem::Turn)
                .collect(),
            tasks: self.tasks.clone(),
            interactions: self.interactions.clone(),
            attachments: self.attachments.clone(),
            todos: Vec::new(),
            prompts: self.prompts.clone(),
            meta: self.meta.clone(),
            has_more_older: None,
        }
    }

    fn upsert_interaction(&mut self, interaction: TranscriptInteraction) -> TranscriptOperation {
        if let Some(existing) = self
            .interactions
            .iter_mut()
            .find(|item| item.interaction_id == interaction.interaction_id)
        {
            *existing = interaction.clone();
        } else {
            self.interactions.push(interaction.clone());
        }
        TranscriptOperation::InteractionUpsert { interaction }
    }

    fn patch_interaction(
        &mut self,
        id: &str,
        state: InteractionState,
        response: Option<Value>,
    ) -> Option<TranscriptOperation> {
        let existing = self
            .interactions
            .iter_mut()
            .find(|item| item.interaction_id == id)?;
        existing.state = state;
        if response.is_some() {
            existing.response = response;
        }
        Some(TranscriptOperation::InteractionUpsert {
            interaction: existing.clone(),
        })
    }

    fn upsert_prompt(&mut self, prompt: TranscriptPrompt) -> TranscriptOperation {
        if let Some(existing) = self
            .prompts
            .iter_mut()
            .find(|item| item.prompt_id == prompt.prompt_id)
        {
            *existing = prompt.clone();
        } else {
            self.prompts.push(prompt.clone());
        }
        TranscriptOperation::PromptUpsert { prompt }
    }

    fn upsert_attachment(&mut self, attachment: TranscriptAttachment) -> TranscriptOperation {
        if let Some(existing) = self
            .attachments
            .iter_mut()
            .find(|item| item.attachment_id == attachment.attachment_id)
        {
            *existing = attachment.clone();
        } else {
            self.attachments.push(attachment.clone());
        }
        TranscriptOperation::AttachmentUpsert { attachment }
    }

    fn merge_agent_meta(&mut self, value: &Value) -> Vec<TranscriptOperation> {
        let model = value
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let thinking_effort = value
            .get("thinkingEffort")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let context_tokens = value.get("contextTokens").and_then(|v| v.as_i64());
        let permission =
            value
                .get("permission")
                .and_then(|v| v.as_str())
                .and_then(|mode| match mode.to_ascii_lowercase().as_str() {
                    "yolo" => Some(AgentPermission::Yolo),
                    "auto" => Some(AgentPermission::Auto),
                    "manual" => Some(AgentPermission::Manual),
                    _ => None,
                });
        if model.is_none()
            && thinking_effort.is_none()
            && context_tokens.is_none()
            && permission.is_none()
        {
            return Vec::new();
        }
        let agent = self.meta.agent.get_or_insert(AgentStatusMeta {
            model: None,
            thinking_effort: None,
            usage: None,
            context_tokens: None,
            max_context_tokens: None,
            context_usage: None,
            permission: None,
            phase: None,
        });
        if model.is_some() {
            agent.model = model;
        }
        if thinking_effort.is_some() {
            agent.thinking_effort = thinking_effort;
        }
        if context_tokens.is_some() {
            agent.context_tokens = context_tokens;
        }
        if permission.is_some() {
            agent.permission = permission;
        }
        vec![TranscriptOperation::MetaMerge {
            meta: TranscriptMetaMerge {
                agent: Some(agent.clone()),
                ..Default::default()
            },
        }]
    }

    fn merge_activity(&mut self, busy: bool) -> Vec<TranscriptOperation> {
        let activity = if busy {
            ActivityMeta::Turn
        } else {
            ActivityMeta::Idle
        };
        self.meta.activity = Some(activity);
        vec![TranscriptOperation::MetaMerge {
            meta: TranscriptMetaMerge {
                activity: Some(activity),
                ..Default::default()
            },
        }]
    }

    fn subagent_task_ops(
        &mut self,
        agent_id: &str,
        state: TaskState,
        summary: Option<String>,
        error: Option<String>,
    ) -> Vec<TranscriptOperation> {
        let task = TranscriptTask {
            task_id: agent_id.to_string(),
            kind: TaskKind::Subagent,
            state,
            detached: false,
            description: Some(agent_id.to_string()),
            agent_id: Some(agent_id.to_string()),
            output_tail: String::new(),
            started_at: Some(now_iso()),
            ended_at: if state == TaskState::Running {
                None
            } else {
                Some(now_iso())
            },
            result_summary: summary,
            error,
            state_reason: None,
            usage: None,
            model: None,
            thinking_effort: None,
        };
        let task = self.merge_task(task);
        vec![TranscriptOperation::TaskUpsert { task }]
    }

    fn ensure_turn(&mut self, key: &str) -> usize {
        if let Some(&idx) = self.turn_indices.get(key) {
            return idx;
        }
        let ordinal = self.turns.len() as i64;
        let idx = self.turns.len();
        self.turns.push(TranscriptTurn {
            turn_id: key.to_string(),
            trigger_prompt_id: None,
            ordinal,
            state: TurnState::Running,
            origin: TurnOrigin::User { payload: None },
            prompt: None,
            attachment_ids: None,
            steps: Vec::new(),
            started_at: Some(now_iso()),
            ended_at: None,
            usage: None,
            duration_ms: None,
            error: None,
        });
        self.turn_indices.insert(key.to_string(), idx);
        idx
    }

    fn ensure_step(&mut self, turn_idx: usize, ordinal: i64) -> usize {
        if let Some(idx) = self.turns[turn_idx]
            .steps
            .iter()
            .position(|step| step.ordinal == ordinal)
        {
            return idx;
        }
        let turn_id = self.turns[turn_idx].turn_id.clone();
        let idx = self.turns[turn_idx].steps.len();
        self.turns[turn_idx].steps.push(TranscriptStep {
            step_id: format!("{turn_id}.{ordinal}"),
            turn_id,
            ordinal,
            state: StepState::Running,
            frames: Vec::new(),
            started_at: Some(now_iso()),
            ended_at: None,
            usage: None,
            finish_reason: None,
            timing: None,
            retry: None,
            end_reason: None,
            end_message: None,
        });
        idx
    }

    fn step_index_for_turn(&mut self, turn_idx: usize) -> usize {
        if let Some(cursor) = self.cursor
            && cursor.turn == turn_idx
            && cursor.step < self.turns[turn_idx].steps.len()
        {
            return cursor.step;
        }
        let len = self.turns[turn_idx].steps.len();
        if len > 0 {
            len - 1
        } else {
            self.ensure_step(turn_idx, 1)
        }
    }

    fn resolve_turn(&self, turn_id: u64) -> Option<usize> {
        self.turn_indices
            .get(&turn_key_u64(turn_id))
            .copied()
            .or_else(|| self.cursor.map(|cursor| cursor.turn))
    }

    fn find_tool_frame(&self, turn_idx: usize, tool_call_id: &str) -> Option<(usize, usize)> {
        let turn = &self.turns[turn_idx];
        for (step_idx, step) in turn.steps.iter().enumerate() {
            for (frame_idx, frame) in step.frames.iter().enumerate() {
                if let TranscriptFrame::Tool(tool) = frame
                    && tool.tool_call_id == tool_call_id
                {
                    return Some((step_idx, frame_idx));
                }
            }
        }
        None
    }

    fn find_tool_frame_any(&self, tool_call_id: &str) -> Option<(usize, usize, usize)> {
        for (turn_idx, turn) in self.turns.iter().enumerate() {
            for (step_idx, step) in turn.steps.iter().enumerate() {
                for (frame_idx, frame) in step.frames.iter().enumerate() {
                    if let TranscriptFrame::Tool(tool) = frame
                        && tool.tool_call_id == tool_call_id
                    {
                        return Some((turn_idx, step_idx, frame_idx));
                    }
                }
            }
        }
        None
    }

    fn push_delta(
        &mut self,
        turn_idx: usize,
        delta: &str,
        thinking: bool,
    ) -> Vec<TranscriptOperation> {
        let step_idx = self.step_index_for_turn(turn_idx);
        let turn_id = self.turns[turn_idx].turn_id.clone();
        let step_id = self.turns[turn_idx].steps[step_idx].step_id.clone();
        let trailing = self.turns[turn_idx].steps[step_idx].frames.last();
        let cursor_frame = self
            .cursor
            .filter(|cursor| cursor.turn == turn_idx && cursor.step == step_idx)
            .and_then(|cursor| cursor.frame);
        let last_index = self.turns[turn_idx].steps[step_idx]
            .frames
            .len()
            .checked_sub(1);
        let matches_trailing = cursor_frame.is_some()
            && cursor_frame == last_index
            && match (trailing, thinking) {
                (Some(TranscriptFrame::Text(frame)), false) => frame.role == TextRole::Assistant,
                (Some(TranscriptFrame::Thinking(_)), true) => true,
                _ => false,
            };
        let mut ops = Vec::new();
        let frame_idx = if matches_trailing {
            self.turns[turn_idx].steps[step_idx].frames.len() - 1
        } else {
            let frame_id = self.next_text_frame_id(turn_idx, step_idx);
            let frame = if thinking {
                TranscriptFrame::Thinking(ThinkingFrame {
                    frame_id,
                    text: String::new(),
                })
            } else {
                TranscriptFrame::Text(TextFrame {
                    frame_id,
                    text: String::new(),
                    role: TextRole::Assistant,
                    attachment_ids: None,
                    task_id: None,
                    prompt_ids: None,
                    origin: None,
                })
            };
            self.turns[turn_idx].steps[step_idx].frames.push(frame);
            let idx = self.turns[turn_idx].steps[step_idx].frames.len() - 1;
            ops.push(TranscriptOperation::FrameUpsert {
                turn_id: turn_id.clone(),
                step_id: step_id.clone(),
                frame: self.turns[turn_idx].steps[step_idx].frames[idx].clone(),
            });
            idx
        };
        let offset = match &self.turns[turn_idx].steps[step_idx].frames[frame_idx] {
            TranscriptFrame::Text(frame) => frame.text.len() as u64,
            TranscriptFrame::Thinking(frame) => frame.text.len() as u64,
            _ => 0,
        };
        match &mut self.turns[turn_idx].steps[step_idx].frames[frame_idx] {
            TranscriptFrame::Text(frame) => frame.text.push_str(delta),
            TranscriptFrame::Thinking(frame) => frame.text.push_str(delta),
            _ => {}
        }
        let frame_id = match &self.turns[turn_idx].steps[step_idx].frames[frame_idx] {
            TranscriptFrame::Text(frame) => frame.frame_id.clone(),
            TranscriptFrame::Thinking(frame) => frame.frame_id.clone(),
            _ => String::new(),
        };
        ops.push(TranscriptOperation::Append {
            target: AppendTarget::Frame {
                turn_id,
                step_id,
                frame_id,
            },
            offset,
            text: delta.to_string(),
        });
        self.cursor = Some(Cursor {
            turn: turn_idx,
            step: step_idx,
            frame: Some(frame_idx),
        });
        ops
    }

    fn next_text_frame_id(&self, turn_idx: usize, step_idx: usize) -> String {
        let step = &self.turns[turn_idx].steps[step_idx];
        let prefix = format!("{}.f", step.step_id);
        let mut max = 0u64;
        for frame in &step.frames {
            let frame_id = match frame {
                TranscriptFrame::Text(frame) => Some(frame.frame_id.as_str()),
                TranscriptFrame::Thinking(frame) => Some(frame.frame_id.as_str()),
                _ => None,
            };
            if let Some(seq) = frame_id
                .and_then(|id| id.strip_prefix(&prefix))
                .and_then(|rest| rest.parse::<u64>().ok())
            {
                max = max.max(seq);
            }
        }
        format!("{}.f{}", step.step_id, max + 1)
    }

    fn tool_frame_op(
        &self,
        turn_idx: usize,
        step_idx: usize,
        frame_idx: usize,
    ) -> TranscriptOperation {
        let step = &self.turns[turn_idx].steps[step_idx];
        TranscriptOperation::FrameUpsert {
            turn_id: step.turn_id.clone(),
            step_id: step.step_id.clone(),
            frame: step.frames[frame_idx].clone(),
        }
    }

    fn merge_task(&mut self, incoming: TranscriptTask) -> TranscriptTask {
        if let Some(existing) = self
            .tasks
            .iter_mut()
            .find(|task| task.task_id == incoming.task_id)
        {
            existing.state = incoming.state;
            if incoming.kind != TaskKind::Other {
                existing.kind = incoming.kind;
            }
            if !incoming.output_tail.is_empty() {
                existing.output_tail = incoming.output_tail;
            }
            if incoming.description.is_some() {
                existing.description = incoming.description;
            }
            if incoming.agent_id.is_some() {
                existing.agent_id = incoming.agent_id;
            }
            if incoming.started_at.is_some() {
                existing.started_at = incoming.started_at;
            }
            if incoming.ended_at.is_some() {
                existing.ended_at = incoming.ended_at;
            }
            if incoming.result_summary.is_some() {
                existing.result_summary = incoming.result_summary;
            }
            if incoming.error.is_some() {
                existing.error = incoming.error;
            }
            if incoming.state_reason.is_some() {
                existing.state_reason = incoming.state_reason;
            }
            if incoming.usage.is_some() {
                existing.usage = incoming.usage;
            }
            if incoming.model.is_some() {
                existing.model = incoming.model;
            }
            if incoming.thinking_effort.is_some() {
                existing.thinking_effort = incoming.thinking_effort;
            }
            return existing.clone();
        }
        self.tasks.push(incoming.clone());
        incoming
    }
}

impl Default for TranscriptProjector {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn turn_header(turn: &TranscriptTurn) -> TurnHeader {
    TurnHeader {
        turn_id: turn.turn_id.clone(),
        trigger_prompt_id: turn.trigger_prompt_id.clone(),
        ordinal: turn.ordinal,
        state: turn.state,
        origin: turn.origin.clone(),
        prompt: turn.prompt.clone(),
        attachment_ids: turn.attachment_ids.clone(),
        started_at: turn.started_at.clone(),
        ended_at: turn.ended_at.clone(),
        usage: turn.usage.clone(),
        duration_ms: turn.duration_ms,
        error: turn.error.clone(),
    }
}

pub(crate) fn step_header(step: &TranscriptStep) -> StepHeader {
    StepHeader {
        step_id: step.step_id.clone(),
        turn_id: step.turn_id.clone(),
        ordinal: step.ordinal,
        state: step.state,
        started_at: step.started_at.clone(),
        ended_at: step.ended_at.clone(),
        usage: step.usage.clone(),
        finish_reason: step.finish_reason.clone(),
        timing: step.timing.clone(),
        retry: step.retry.clone(),
        end_reason: step.end_reason.clone(),
        end_message: step.end_message.clone(),
    }
}

fn turn_key(raw: &str) -> String {
    if raw.starts_with('t') {
        raw.to_string()
    } else {
        format!("t{raw}")
    }
}

fn turn_key_u64(raw: u64) -> String {
    format!("t{raw}")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn progress_from_update(update: &Value) -> ToolFrameProgress {
    if let Some(object) = update.as_object() {
        let structured = ["kind", "text", "percent", "customKind", "customData"]
            .iter()
            .any(|key| object.contains_key(*key));
        if structured {
            let kind = match object.get("kind").and_then(|v| v.as_str()) {
                Some("stdout") => ToolProgressKind::Stdout,
                Some("stderr") => ToolProgressKind::Stderr,
                Some("progress") => ToolProgressKind::Progress,
                Some("status") => ToolProgressKind::Status,
                _ => ToolProgressKind::Custom,
            };
            return ToolFrameProgress {
                kind,
                text: object
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                percent: object.get("percent").and_then(|v| v.as_f64()),
                custom_kind: object
                    .get("customKind")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                custom_data: object.get("customData").cloned(),
            };
        }
    }
    ToolFrameProgress {
        kind: ToolProgressKind::Custom,
        text: Some(update.to_string()),
        percent: None,
        custom_kind: None,
        custom_data: None,
    }
}

fn task_from_event(value: &Value) -> Option<TranscriptTask> {
    let task = value.get("task").cloned().unwrap_or(Value::Null);
    let task_id = str_field(&task, &["id", "taskId", "task_id"])
        .or_else(|| str_field(value, &["task_id", "taskId", "id"]))?;
    Some(TranscriptTask {
        task_id,
        kind: task_kind(str_field(&task, &["kind"]).as_deref()),
        state: task_state(
            str_field(&task, &["state", "status"])
                .or_else(|| str_field(value, &["status", "state"]))
                .as_deref(),
        ),
        detached: false,
        description: str_field(&task, &["description"])
            .or_else(|| str_field(value, &["description"])),
        agent_id: str_field(&task, &["agent_id", "agentId"]),
        output_tail: str_field(&task, &["output_tail", "outputTail", "output"])
            .or_else(|| str_field(value, &["output_preview", "outputPreview", "output_tail"]))
            .unwrap_or_default(),
        started_at: str_field(&task, &["started_at", "startedAt"])
            .or_else(|| str_field(value, &["started_at", "startedAt"])),
        ended_at: str_field(&task, &["ended_at", "endedAt"])
            .or_else(|| str_field(value, &["ended_at", "endedAt", "finished_at"])),
        result_summary: str_field(&task, &["result_summary", "resultSummary"])
            .or_else(|| str_field(value, &["result_summary", "resultSummary"])),
        error: str_field(&task, &["error"]).or_else(|| str_field(value, &["error"])),
        state_reason: str_field(&task, &["state_reason", "stateReason", "stop_reason"])
            .or_else(|| str_field(value, &["state_reason", "stateReason"])),
        usage: None,
        model: str_field(&task, &["model"]),
        thinking_effort: str_field(&task, &["thinking_effort", "thinkingEffort"]),
    })
}

fn task_kind(raw: Option<&str>) -> TaskKind {
    match raw {
        Some("shell") => TaskKind::Shell,
        Some("subagent") => TaskKind::Subagent,
        Some("tool") => TaskKind::Tool,
        _ => TaskKind::Other,
    }
}

fn task_state(raw: Option<&str>) -> TaskState {
    match raw {
        Some("running") => TaskState::Running,
        Some("completed") => TaskState::Completed,
        Some("failed") => TaskState::Failed,
        Some("timed_out") | Some("timedout") => TaskState::TimedOut,
        Some("killed") => TaskState::Killed,
        Some("lost") => TaskState::Lost,
        _ => TaskState::Running,
    }
}

fn str_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|v| v.as_str()).map(str::to_string))
}

/// Best-effort attachment for a media content block in a user message. The id
/// is a stable hash of the block, so a re-emitted message upserts the same
/// attachment instead of piling up duplicates.
fn attachment_from_block(block: &Value) -> Option<TranscriptAttachment> {
    let kind = block.get("type").and_then(|v| v.as_str())?;
    let url_source = || {
        block
            .get("url")
            .and_then(|v| v.as_str())
            .map(|url| AttachmentSource::Url {
                url: url.to_string(),
            })
    };
    let (media_type, source) = match kind {
        "image" => (
            block
                .get("media_type")
                .and_then(|v| v.as_str())
                .unwrap_or("image")
                .to_string(),
            None,
        ),
        "image_url" => ("image".to_string(), url_source()),
        "audio_url" => ("audio".to_string(), url_source()),
        "video_url" => ("video".to_string(), url_source()),
        _ => return None,
    };
    Some(TranscriptAttachment {
        attachment_id: format!("att-{:016x}", stable_hash(&block.to_string())),
        media_type,
        name: None,
        size: None,
        source,
        placeholder: None,
    })
}

fn stable_hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn folds_a_full_turn_into_transcript_ops() {
        let mut projector = TranscriptProjector::new();

        let ops = projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 0,
            prompt: Some("hello".into()),
        });
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], TranscriptOperation::TurnUpsert { .. }));

        let ops = projector.apply_event(&EngineEvent::LlmStepBegin {
            turn_id: "0".into(),
            step: 1,
        });
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], TranscriptOperation::StepUpsert { .. }));

        let ops = projector.apply_event(&EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: 0,
            delta: "Hello".into(),
        });
        assert_eq!(ops.len(), 2);
        assert!(matches!(ops[0], TranscriptOperation::FrameUpsert { .. }));
        match &ops[1] {
            TranscriptOperation::Append { offset, text, .. } => {
                assert_eq!(*offset, 0);
                assert_eq!(text, "Hello");
            }
            other => panic!("expected append, got {other:?}"),
        }

        let ops = projector.apply_event(&EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: 0,
            delta: " world".into(),
        });
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            TranscriptOperation::Append { offset, text, .. } => {
                assert_eq!(*offset, "Hello".len() as u64);
                assert_eq!(text, " world");
            }
            other => panic!("expected append, got {other:?}"),
        }

        let ops = projector.apply_event(&EngineEvent::ToolCallStarted {
            agent_id: "main".into(),
            turn_id: 0,
            tool_call_id: "c1".into(),
            name: "Read".into(),
            args: json!({ "path": "a.txt" }),
        });
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], TranscriptOperation::FrameUpsert { .. }));

        let ops = projector.apply_event(&EngineEvent::ToolCallCompleted {
            agent_id: "main".into(),
            turn_id: 0,
            tool_call_id: "c1".into(),
            result: json!("file contents"),
        });
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            TranscriptOperation::FrameUpsert { frame, .. } => match frame {
                TranscriptFrame::Tool(tool) => {
                    assert_eq!(tool.state, ToolFrameState::Done);
                    assert_eq!(tool.output, Some(json!("file contents")));
                }
                other => panic!("expected tool frame, got {other:?}"),
            },
            other => panic!("expected frame upsert, got {other:?}"),
        }

        let ops = projector.apply_event(&EngineEvent::TurnEnded {
            agent_id: "main".into(),
            turn_id: 0,
            reason: "completed".into(),
        });
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0], TranscriptOperation::TurnUpsert { .. }));

        let snapshot = projector.snapshot();
        assert_eq!(snapshot.items.len(), 1);
        match &snapshot.items[0] {
            TranscriptItem::Turn(turn) => {
                assert_eq!(turn.turn_id, "t0");
                assert_eq!(turn.state, TurnState::Completed);
                assert_eq!(turn.prompt.as_deref(), Some("hello"));
                let text = match &turn.steps[0].frames[0] {
                    TranscriptFrame::Text(frame) => &frame.text,
                    other => panic!("expected text frame, got {other:?}"),
                };
                assert_eq!(text, "Hello world");
            }
            other => panic!("expected turn item, got {other:?}"),
        }
    }

    #[test]
    fn step_end_tool_delta_and_task_progress_ops() {
        use crate::rpc::types::TokenUsage;

        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 0,
            prompt: None,
        });
        projector.apply_event(&EngineEvent::LlmStepBegin {
            turn_id: "t0".into(),
            step: 1,
        });
        projector.apply_event(&EngineEvent::ToolCallStarted {
            agent_id: "main".into(),
            turn_id: 0,
            tool_call_id: "c1".into(),
            name: "Read".into(),
            args: json!({}),
        });

        // A streamed tool-argument delta lands in the frame's inputText.
        let ops = projector.apply_event(&EngineEvent::ToolCallDelta {
            agent_id: "main".into(),
            turn_id: 0,
            tool_call_id: "c1".into(),
            name: None,
            arguments_part: Some("{\"path\"".into()),
        });
        match &ops[0] {
            TranscriptOperation::FrameUpsert {
                frame: TranscriptFrame::Tool(tool),
                ..
            } => assert_eq!(tool.input_text.as_deref(), Some("{\"path\"")),
            other => panic!("expected tool frame upsert, got {other:?}"),
        }

        // The step end carries usage.
        let ops = projector.apply_event(&EngineEvent::LlmStepEnd {
            turn_id: "t0".into(),
            step: 1,
            usage: Some(TokenUsage {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
                input_cache_read: 5,
                input_cache_creation: 1,
            }),
        });
        match &ops[0] {
            TranscriptOperation::StepUpsert { step, .. } => {
                let usage = step.usage.as_ref().expect("usage recorded");
                assert_eq!(usage.output, 20);
                assert_eq!(usage.input_cache_read, 5);
                assert_eq!(step.state, StepState::Completed);
            }
            other => panic!("expected step upsert, got {other:?}"),
        }

        // A background-task progress chunk appends to the task's output tail.
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.task.created",
            "task": { "id": "task_1", "kind": "bash", "status": "running", "description": "bg" }
        })));
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.task.progress",
            "task_id": "task_1",
            "output_chunk": "line1\n",
            "stream": "stdout"
        })));
        match &ops[0] {
            TranscriptOperation::Append {
                target: AppendTarget::Task { task_id },
                offset,
                text,
            } => {
                assert_eq!(task_id, "task_1");
                assert_eq!(*offset, 0);
                assert_eq!(text, "line1\n");
            }
            other => panic!("expected task append, got {other:?}"),
        }

        // `hook.result` becomes a marker.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "hook.result",
            "hook": "PreToolUse"
        })));
        match &ops[0] {
            TranscriptOperation::MarkerUpsert { item, .. } => assert_eq!(item.marker, "hook"),
            other => panic!("expected marker upsert, got {other:?}"),
        }
    }

    #[test]
    fn interaction_and_prompt_ops() {
        let mut projector = TranscriptProjector::new();

        // A user message becomes a prompt; an assistant message does not.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.message.created",
            "message": {
                "id": "m1",
                "role": "user",
                "content": [{ "type": "text", "text": "hi" }],
                "created_at": "2026-01-01T00:00:00Z"
            }
        })));
        assert!(matches!(ops[0], TranscriptOperation::PromptUpsert { .. }));
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.message.created",
            "message": { "id": "m2", "role": "assistant", "content": [] }
        })));
        assert!(ops.is_empty(), "assistant messages are not prompts");

        // Question requested -> pending; answered -> answered.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.question.requested",
            "question_id": "q1",
            "tool_call_id": "c1",
            "questions": []
        })));
        match &ops[0] {
            TranscriptOperation::InteractionUpsert { interaction } => {
                assert_eq!(interaction.interaction_kind, InteractionKind::Question);
                assert_eq!(interaction.state, InteractionState::Pending);
            }
            other => panic!("expected interaction upsert, got {other:?}"),
        }
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.question.answered",
            "question_id": "q1"
        })));
        match &ops[0] {
            TranscriptOperation::InteractionUpsert { interaction } => {
                assert_eq!(interaction.state, InteractionState::Answered);
            }
            other => panic!("expected interaction upsert, got {other:?}"),
        }

        // Approval requested -> resolved(allow) -> approved.
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.approval.requested",
            "approval_id": "a1",
            "tool_call_id": "c2"
        })));
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.approval.resolved",
            "approval_id": "a1",
            "decision": "allow"
        })));
        match &ops[0] {
            TranscriptOperation::InteractionUpsert { interaction } => {
                assert_eq!(interaction.state, InteractionState::Approved);
            }
            other => panic!("expected interaction upsert, got {other:?}"),
        }

        let snapshot = projector.snapshot();
        assert_eq!(snapshot.interactions.len(), 2);
        assert_eq!(snapshot.prompts.len(), 1);
    }

    #[test]
    fn agent_meta_subagent_and_attachment_ops() {
        let mut projector = TranscriptProjector::new();

        // The engine status payload merges model/effort/context/permission.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "agent.status.updated",
            "model": "k3",
            "thinkingEffort": "high",
            "contextTokens": 1234,
            "permission": "yolo"
        })));
        match &ops[0] {
            TranscriptOperation::MetaMerge { meta } => {
                let agent = meta.agent.as_ref().expect("agent meta");
                assert_eq!(agent.model.as_deref(), Some("k3"));
                assert_eq!(agent.context_tokens, Some(1234));
                assert_eq!(agent.permission, Some(AgentPermission::Yolo));
            }
            other => panic!("expected meta.merge, got {other:?}"),
        }
        // A phase-only activity payload carries no mergeable scalar.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "agent.status.updated",
            "phase": { "kind": "running" }
        })));
        assert!(ops.is_empty());

        // `work_changed` merges the activity state.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.session.work_changed",
            "busy": true
        })));
        match &ops[0] {
            TranscriptOperation::MetaMerge { meta } => {
                assert_eq!(meta.activity, Some(ActivityMeta::Turn));
            }
            other => panic!("expected meta.merge, got {other:?}"),
        }

        // Subagent lifecycle maps onto a transcript task.
        let ops = projector.apply_event(&EngineEvent::SubagentSpawned {
            agent_id: "sub-1".into(),
            parent_agent_id: "main".into(),
            profile_name: "research".into(),
        });
        match &ops[0] {
            TranscriptOperation::TaskUpsert { task } => {
                assert_eq!(task.task_id, "sub-1");
                assert_eq!(task.kind, TaskKind::Subagent);
                assert_eq!(task.state, TaskState::Running);
            }
            other => panic!("expected task upsert, got {other:?}"),
        }
        let ops = projector.apply_event(&EngineEvent::SubagentCompleted {
            agent_id: "sub-1".into(),
            summary: "done".into(),
        });
        match &ops[0] {
            TranscriptOperation::TaskUpsert { task } => {
                assert_eq!(task.state, TaskState::Completed);
                assert_eq!(task.result_summary.as_deref(), Some("done"));
            }
            other => panic!("expected task upsert, got {other:?}"),
        }

        // A user message with an image_url block yields a prompt + attachment.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.message.created",
            "message": {
                "id": "m1",
                "role": "user",
                "created_at": "t",
                "content": [
                    { "type": "text", "text": "see" },
                    { "type": "image_url", "url": "https://example.test/a.png" }
                ]
            }
        })));
        assert!(
            ops.iter()
                .any(|op| matches!(op, TranscriptOperation::PromptUpsert { .. }))
        );
        assert!(
            ops.iter()
                .any(|op| matches!(op, TranscriptOperation::AttachmentUpsert { .. }))
        );

        let snapshot = projector.snapshot();
        assert_eq!(snapshot.attachments.len(), 1);
        assert_eq!(snapshot.tasks.len(), 1);
        assert!(snapshot.meta.agent.is_some());
    }
}
