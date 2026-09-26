use std::collections::HashMap;

use serde_json::Value;

use super::model::{
    ActivityMeta, AgentPermission, AgentStatusMeta, AttachmentSource, InteractionKind,
    InteractionState, StepState, StepTiming, StepUsage, TaskKind, TaskState, TextFrame, TextRole,
    ThinkingFrame, ToolCallFrame, ToolFrameProgress, ToolFrameState, ToolProgressKind,
    TranscriptAttachment, TranscriptFrame, TranscriptInteraction, TranscriptItem, TranscriptMarker,
    TranscriptMeta, TranscriptMetaMerge, TranscriptPrompt, TranscriptPromptStatus, TranscriptStep,
    TranscriptTask, TranscriptTurn, TranscriptUserOrigin, TurnOrigin, TurnState, UserOriginKind,
};
use super::ops::{
    AgentTranscriptSnapshot, AppendTarget, StepHeader, StepKind, TranscriptOperation, TurnHeader,
    TurnKind,
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
    /// Steers folded before their step was open (v2 `pendingSteers`,
    /// coreEventMap.ts:1438): drained at the next `llm.step.begin`.
    pending_steers: Vec<PendingSteer>,
    /// agent_id → the turn that was running when its spawn folded (upstream
    /// #3970): the lost-member decision keys off the spawning turn, not the
    /// parent's current idleness.
    spawning_turns: HashMap<String, String>,
}

/// A buffered steer awaiting the step it lands in (v2 `pendingSteers`,
/// coreEventMap.ts:1438-1443). Text and prompt ids only: the fork's steer
/// payload carries no attachments on this path (ROADMAP item 34).
#[derive(Debug, Clone)]
struct PendingSteer {
    text: String,
    prompt_ids: Option<Vec<String>>,
}

/// v2 `isTerminalPromptStatus` (coreEventMap.ts:1562).
fn is_terminal_prompt_status(status: TranscriptPromptStatus) -> bool {
    matches!(
        status,
        TranscriptPromptStatus::Completed
            | TranscriptPromptStatus::Failed
            | TranscriptPromptStatus::Aborted
            | TranscriptPromptStatus::Blocked
    )
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
            pending_steers: Vec::new(),
            spawning_turns: HashMap::new(),
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
                let mut ops = vec![TranscriptOperation::StepUpsert {
                    turn_id: self.turns[turn_idx].turn_id.clone(),
                    step: step_header(&self.turns[turn_idx].steps[step_idx]),
                }];
                // v2 drains `pendingSteers` when a step starts
                // (coreEventMap.ts:568-571); the freshly ensured step is
                // empty, so the user frames land at its head.
                ops.extend(self.flush_pending_steers());
                ops
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
                timing,
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
                    // Upstream #3938: the request timing rides the step-end
                    // event into the step (v2's `turn.step.completed` carries
                    // the same fields into the context-memory fold).
                    if let Some(timing) = timing {
                        step.timing = Some(StepTiming {
                            llm_first_token_latency_ms: timing.first_token_latency_ms,
                            llm_stream_duration_ms: timing.stream_duration_ms,
                            llm_request_build_ms: timing.request_build_ms,
                            llm_server_first_token_ms: timing.server_first_token_ms,
                            llm_server_decode_ms: timing.server_decode_ms,
                            llm_client_consume_ms: timing.client_consume_ms,
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
                // Scoped by the event's own turn id, the way v2 records a single
                // `lastEnded` for one turn (turnOps.ts) — never a broadcast
                // over every running turn. The reason vocabulary is v2's
                // `turnEndReasonSchema`: completed / cancelled / failed /
                // blocked. `blocked` folds into `failed` — v2's
                // `mapTurnEndState` (coreEventMap.ts:1608) has no `blocked`
                // turn state to map onto (`transcript` contract schema.ts:63,
                // `packages/transcript` — present only in the upstream
                // checkout — is queued/running/completed/failed/cancelled), and
                // the client validates that enum.
                let turn_idx = self.ensure_turn(&turn_key_u64(*turn_id));
                let state = match reason.as_str() {
                    "cancelled" => TurnState::Cancelled,
                    "failed" | "blocked" => TurnState::Failed,
                    _ => TurnState::Completed,
                };
                // Settling the steps matters as much as the turn: the client
                // only stamps a thinking block with its `durationMs` once the
                // step it belongs to has stopped running, and a block with no
                // duration is not rendered as a finished reasoning section.
                //
                // v2 reaches `completed` on the normal path — `onStepCompleted`
                // (coreEventMap.ts:598) sets it when `turn.step.completed`
                // arrives, which is what `finalizeTurn`
                // (agentProjector.ts:733 — the v3-era projector added in
                // `64505e36e3`, reverted upstream by `2502d2157` and deleted
                // here in `86f30ecc2c`; kept only as the reference for what
                // `finalizeTurn` leaves alone) and `onTurnEnded`
                // (coreEventMap.ts:452) then leave alone. The fork's turn loop
                // publishes `llm.step.end` with the turn/step ids after every
                // step (run_turn.rs), so a step that ran to completion is
                // already `Completed` here; only a step still running when the
                // turn ends — an interrupted mid-step turn — takes its state
                // from the reason, and `finalizeTurn` maps that
                // `failed` / `blocked` → `failed`, otherwise `interrupted`.
                let step_state = match reason.as_str() {
                    "cancelled" => StepState::Interrupted,
                    "failed" | "blocked" => StepState::Failed,
                    _ => StepState::Completed,
                };
                let ended_at = now_iso();
                self.turns[turn_idx].state = state;
                self.turns[turn_idx].ended_at = Some(ended_at.clone());
                let turn_id = self.turns[turn_idx].turn_id.clone();
                let mut ops = vec![TranscriptOperation::TurnUpsert {
                    turn: turn_header(&self.turns[turn_idx]),
                }];
                for step in self.turns[turn_idx].steps.iter_mut() {
                    if step.state != StepState::Running {
                        continue;
                    }
                    step.state = step_state;
                    step.ended_at = Some(ended_at.clone());
                    ops.push(TranscriptOperation::StepUpsert {
                        turn_id: turn_id.clone(),
                        step: step_header(step),
                    });
                }
                ops
            }
            EngineEvent::SubagentSpawned { subagent_id, .. } => {
                // The fold reads the journal in order, so the turn running at
                // this moment IS the turn that spawned the member (upstream
                // #3970 keys the lost decision on it).
                if let Some(turn) = self
                    .turns
                    .iter()
                    .rev()
                    .find(|t| t.state == TurnState::Running)
                {
                    self.spawning_turns
                        .insert(subagent_id.clone(), turn.turn_id.clone());
                }
                self.subagent_task_ops(subagent_id, TaskState::Running, None, None, None)
            }
            EngineEvent::SubagentCompleted {
                subagent_id,
                result_summary,
                usage,
            } => self.subagent_task_ops(
                subagent_id,
                TaskState::Completed,
                result_summary.clone(),
                None,
                usage.clone().map(rpc_usage_as_step_usage),
            ),
            EngineEvent::SubagentFailed { subagent_id, error } => self.subagent_task_ops(
                subagent_id,
                TaskState::Failed,
                None,
                Some(error.clone()),
                None,
            ),
            // The engine publishes this as a typed event, so it never reaches
            // the string-keyed `Custom` arm below. v2 opens the turn with
            // `meta.merge { activity: 'turn' }` (coreEventMap.ts:437) and
            // settles it to `idle` when the turn ends (:504), and the client
            // reads that field to decide whether to keep working — matching
            // only the JSON spelling left it at `idle` forever, so a finished
            // turn still rendered as busy.
            EngineEvent::SessionWorkChanged { busy, .. } => self.merge_activity(*busy),
            EngineEvent::Custom(value) => match value.get("type").and_then(|t| t.as_str()) {
                Some("event.session.work_changed") => {
                    let busy = value.get("busy").and_then(|v| v.as_bool()).unwrap_or(false);
                    self.merge_activity(busy)
                }
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
                    let offset = self.tasks[idx].output_tail.encode_utf16().count() as u64;
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
                    let Some(turn_idx) = self.custom_delta_turn(value) else {
                        return Vec::new();
                    };
                    self.push_delta(turn_idx, delta, false)
                }
                // v2 keeps the reasoning stream on its own event name
                // (`thinking.delta`, events-zod.ts) rather than a flag on the
                // answer stream — the kind is data, not a boolean a consumer
                // must interpret.
                Some("event.thinking.delta") => {
                    let Some(delta) = value.get("delta").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let Some(turn_idx) = self.custom_delta_turn(value) else {
                        return Vec::new();
                    };
                    self.push_delta(turn_idx, delta, true)
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
                    let announcement_id = id.to_string();
                    let created_at = message
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(now_iso);
                    let mut ops = vec![self.upsert_prompt(id, |prev| TranscriptPrompt {
                        prompt_id: announcement_id.clone(),
                        status: TranscriptPromptStatus::Running,
                        user_message_id: Some(announcement_id.clone()),
                        content: message.get("content").cloned(),
                        // The submission may have already created this
                        // prompt with its client metadata (#3764); the
                        // announcement must not drop it (v2
                        // `onPromptStarted`, coreEventMap.ts:1342).
                        client_metadata: prev.and_then(|prev| prev.client_metadata.clone()),
                        created_at,
                        finished_at: None,
                        steered_at: None,
                    })];
                    let mut attachment_ids = Vec::new();
                    if let Some(blocks) = message.get("content").and_then(|v| v.as_array()) {
                        for block in blocks {
                            if let Some(attachment) = attachment_from_block(block) {
                                attachment_ids.push(attachment.attachment_id.clone());
                                ops.push(self.upsert_attachment(attachment));
                            }
                        }
                    }
                    // v2's cold fold puts the opening prompt's attachments on
                    // the turn (`foldTurnOpeningInput` → `turn.attachmentIds`):
                    // the link a client needs to resolve a referenced file's
                    // saved path. The message id names the turn
                    // (`msg-u{turn}`), the same key the deltas address, so the
                    // turn is opened here when no delta has yet.
                    if !attachment_ids.is_empty()
                        && let Some(turn_number) = id
                            .strip_prefix("msg-u")
                            .and_then(|digits| digits.parse::<u64>().ok())
                    {
                        let turn_idx = self.ensure_turn(&turn_key_u64(turn_number));
                        self.turns[turn_idx].attachment_ids = Some(attachment_ids);
                    }
                    ops
                }
                Some("agent.status.updated") => self.merge_agent_meta(value),
                // The prompt submission (v2 #3764): the item the route
                // admitted, with the client metadata it carried. The
                // announcement (`event.message.created`) upserts the same
                // prompt when the turn starts and carries the metadata
                // over, so a client sees one prompt entity, not two.
                Some("prompt.submitted") => {
                    let Some(prompt_id) = value.get("promptId").and_then(|v| v.as_str()) else {
                        return Vec::new();
                    };
                    let status = match value.get("status").and_then(|v| v.as_str()) {
                        Some("queued") => TranscriptPromptStatus::Queued,
                        Some("blocked") => TranscriptPromptStatus::Blocked,
                        Some("completed") => TranscriptPromptStatus::Completed,
                        Some("failed") => TranscriptPromptStatus::Failed,
                        Some("aborted") => TranscriptPromptStatus::Aborted,
                        _ => TranscriptPromptStatus::Running,
                    };
                    // The contract's `clientMetadata` is an array of
                    // records; the submission carries one object.
                    let client_metadata = value
                        .get("metadata")
                        .filter(|metadata| metadata.is_object())
                        .map(|metadata| vec![metadata.clone()]);
                    let event_created_at = value
                        .get("createdAt")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let user_message_id = value
                        .get("userMessageId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let content = value.get("content").cloned();
                    // v2 `onPromptSubmitted` (coreEventMap.ts:1328): a
                    // terminal prompt keeps its terminal status — a
                    // duplicate submission must not resurrect it — while
                    // createdAt / finishedAt / steeredAt prefer the
                    // entity's own values.
                    vec![self.upsert_prompt(prompt_id, |prev| {
                        TranscriptPrompt {
                            prompt_id: prompt_id.to_string(),
                            status: match prev {
                                Some(prev) if is_terminal_prompt_status(prev.status) => prev.status,
                                _ => status,
                            },
                            user_message_id,
                            content,
                            client_metadata: client_metadata
                                .or_else(|| prev.and_then(|prev| prev.client_metadata.clone())),
                            created_at: prev
                                .map(|prev| prev.created_at.clone())
                                .or(event_created_at)
                                .unwrap_or_else(now_iso),
                            finished_at: prev.and_then(|prev| prev.finished_at.clone()),
                            steered_at: prev.and_then(|prev| prev.steered_at.clone()),
                        }
                    })]
                }
                Some("llm.step.begin") => {
                    // An *unscoped* step boundary. The turn loop's own
                    // (`run_turn`) names the turn and takes the typed arm
                    // above, which creates the step and drains `pendingSteers`;
                    // only a malformed copy can land here, and with no cursor
                    // yet the pending steers wait for the next one.
                    self.flush_pending_steers()
                }
                Some("turn.steer") => self.fold_turn_steer(value),
                Some("prompt.steered") => self.fold_prompt_steered(value),
                Some("prompt.completed") => self.fold_prompt_completed(value),
                Some("prompt.aborted") => self.fold_prompt_aborted(value),
                // Prompt lifecycle arms fold prompt entities only: v2 keeps
                // the two entities on separate schedules (`onPromptCompleted`,
                // coreEventMap.ts:1356, emits a `prompt.upsert` and nothing
                // else). The typed `turn.ended` arm above is what ends the
                // turn.
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

    /// The task list as of a COLD rebuild (upstream #3970's lost-member
    /// rule): every loop is dead after a restart, so a member left `running`
    /// survives only while the turn that spawned it is itself still running
    /// in the rebuild — anything else settles to `lost`. The live path keeps
    /// using `snapshot()`: a background member there can legitimately outlive
    /// its spawning turn and terminalises on its own completion event.
    pub fn cold_snapshot_tasks(&self) -> Vec<TranscriptTask> {
        self.tasks
            .iter()
            .map(|task| {
                let mut task = task.clone();
                if task.kind == TaskKind::Subagent && task.state == TaskState::Running {
                    let spawning_turn_running = task
                        .agent_id
                        .as_deref()
                        .and_then(|agent_id| self.spawning_turns.get(agent_id))
                        .is_some_and(|turn_id| {
                            self.turns.iter().any(|turn| {
                                turn.turn_id == *turn_id && turn.state == TurnState::Running
                            })
                        });
                    if !spawning_turn_running {
                        task.state = TaskState::Lost;
                        task.ended_at = task.ended_at.or_else(|| Some(now_iso()));
                    }
                }
                task
            })
            .collect()
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

    /// Insert or replace a prompt, letting the caller see the previous entity
    /// first — v2's `upsertPrompt(build)` shape (coreEventMap.ts:1505), so a
    /// terminal prompt keeps the fields a later event does not carry.
    fn upsert_prompt(
        &mut self,
        prompt_id: &str,
        build: impl FnOnce(Option<&TranscriptPrompt>) -> TranscriptPrompt,
    ) -> TranscriptOperation {
        let existing = self.prompts.iter().find(|item| item.prompt_id == prompt_id);
        let prompt = build(existing);
        if let Some(slot) = self
            .prompts
            .iter_mut()
            .find(|item| item.prompt_id == prompt.prompt_id)
        {
            *slot = prompt.clone();
        } else {
            self.prompts.push(prompt.clone());
        }
        TranscriptOperation::PromptUpsert { prompt }
    }

    /// Drain buffered steers as user frames in the step under the cursor
    /// (v2's `onStepStarted` flush, coreEventMap.ts:568). The gate keeps a
    /// closed turn from collecting frames that belong to no step: with no
    /// cursor, or a cursor whose turn is not running, the pending list
    /// survives to the next step begin (ROADMAP item 34).
    fn flush_pending_steers(&mut self) -> Vec<TranscriptOperation> {
        if self.pending_steers.is_empty() {
            return Vec::new();
        }
        let Some(cursor) = self.cursor else {
            return Vec::new();
        };
        if self.turns[cursor.turn].state != TurnState::Running {
            return Vec::new();
        }
        let turn_idx = cursor.turn;
        let turn_id = self.turns[turn_idx].turn_id.clone();
        let mut ops = Vec::new();
        // `turn.started` parks the cursor at step 0 before any step exists;
        // a frame needs a step to live in, so open the first one and report it.
        let step_idx = if cursor.step < self.turns[turn_idx].steps.len() {
            cursor.step
        } else {
            let step_idx = self.ensure_step(turn_idx, 1);
            ops.push(TranscriptOperation::StepUpsert {
                turn_id: turn_id.clone(),
                step: step_header(&self.turns[turn_idx].steps[step_idx]),
            });
            step_idx
        };
        let step_id = self.turns[turn_idx].steps[step_idx].step_id.clone();
        for pending in std::mem::take(&mut self.pending_steers) {
            let frame_id = self.next_text_frame_id(turn_idx, step_idx);
            let frame = TranscriptFrame::Text(TextFrame {
                frame_id,
                text: pending.text,
                role: TextRole::User,
                attachment_ids: None,
                task_id: None,
                prompt_ids: pending.prompt_ids,
                origin: Some(TranscriptUserOrigin {
                    kind: UserOriginKind::User,
                    skill_activations: None,
                }),
            });
            self.turns[turn_idx].steps[step_idx]
                .frames
                .push(frame.clone());
            let frame_idx = self.turns[turn_idx].steps[step_idx].frames.len() - 1;
            ops.push(TranscriptOperation::FrameUpsert {
                turn_id: turn_id.clone(),
                step_id: step_id.clone(),
                frame,
            });
            // Subsequent deltas see a user frame under the cursor, so they
            // open a new assistant frame rather than appending to it.
            self.cursor = Some(Cursor {
                turn: turn_idx,
                step: step_idx,
                frame: Some(frame_idx),
            });
        }
        ops
    }

    /// v2 `onTurnSteered` (coreEventMap.ts:1413): a user or skill-activation
    /// steer with an array input becomes a user frame. The fork buffers
    /// unconditionally — the frame lands at the next step begin — where v2
    /// lands it in a running step immediately (ROADMAP item 34).
    fn fold_turn_steer(&mut self, value: &Value) -> Vec<TranscriptOperation> {
        let Some(origin) = value.get("origin") else {
            return Vec::new();
        };
        let kind = origin.get("kind").and_then(|v| v.as_str());
        if !matches!(kind, Some("user") | Some("skill_activation")) {
            return Vec::new();
        }
        let Some(input) = value.get("input").and_then(|v| v.as_array()) else {
            return Vec::new();
        };
        let text: String = input
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                    part.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect();
        let prompt_ids = value
            .get("promptIds")
            .and_then(|v| v.as_array())
            .map(|ids| {
                ids.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<String>>()
            })
            .filter(|ids| !ids.is_empty());
        self.pending_steers.push(PendingSteer { text, prompt_ids });
        Vec::new()
    }

    /// v2 `onPromptSteered` (coreEventMap.ts:1384): the active prompt stays
    /// open under the steer, each steered prompt id settles as completed at
    /// the steer's timestamp.
    fn fold_prompt_steered(&mut self, value: &Value) -> Vec<TranscriptOperation> {
        let Some(steered_at) = value.get("steeredAt").and_then(|v| v.as_str()) else {
            return Vec::new();
        };
        let steered_at = steered_at.to_string();
        let content = value.get("content").cloned();
        let prompt_ids: Vec<String> = value
            .get("promptIds")
            .and_then(|v| v.as_array())
            .map(|ids| {
                ids.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let active_prompt_id = value
            .get("activePromptId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let mut ops = Vec::new();
        // An empty `activePromptId` (the route's `unwrap_or_default`) names
        // no prompt: skip the active upsert but still settle the steered ids.
        if !active_prompt_id.is_empty() {
            let active_owned = active_prompt_id.to_string();
            let active_steered_at = steered_at.clone();
            ops.push(self.upsert_prompt(active_prompt_id, |prev| {
                TranscriptPrompt {
                    prompt_id: active_owned.clone(),
                    status: prev
                        .map(|prev| prev.status)
                        .unwrap_or(TranscriptPromptStatus::Running),
                    user_message_id: prev.and_then(|prev| prev.user_message_id.clone()),
                    content: prev
                        .and_then(|prev| prev.content.clone())
                        .or_else(|| content.clone()),
                    client_metadata: prev.and_then(|prev| prev.client_metadata.clone()),
                    created_at: prev
                        .map(|prev| prev.created_at.clone())
                        .unwrap_or_else(|| active_steered_at.clone()),
                    finished_at: prev.and_then(|prev| prev.finished_at.clone()),
                    steered_at: Some(active_steered_at.clone()),
                }
            }));
        }
        for prompt_id in &prompt_ids {
            let id_steered_at = steered_at.clone();
            ops.push(self.upsert_prompt(prompt_id, |prev| {
                TranscriptPrompt {
                    prompt_id: prompt_id.clone(),
                    status: TranscriptPromptStatus::Completed,
                    user_message_id: prev.and_then(|prev| prev.user_message_id.clone()),
                    content: prev.and_then(|prev| prev.content.clone()),
                    client_metadata: prev.and_then(|prev| prev.client_metadata.clone()),
                    created_at: prev
                        .map(|prev| prev.created_at.clone())
                        .unwrap_or_else(|| id_steered_at.clone()),
                    finished_at: Some(id_steered_at.clone()),
                    steered_at: Some(id_steered_at.clone()),
                }
            }));
        }
        ops
    }

    /// v2 `onPromptCompleted` (coreEventMap.ts:1356): reason maps to status,
    /// finishedAt settles the entity, createdAt falls back to the finish.
    fn fold_prompt_completed(&mut self, value: &Value) -> Vec<TranscriptOperation> {
        let Some(prompt_id) = value.get("promptId").and_then(|v| v.as_str()) else {
            return Vec::new();
        };
        let status = match value.get("reason").and_then(|v| v.as_str()) {
            Some("failed") => TranscriptPromptStatus::Failed,
            Some("blocked") => TranscriptPromptStatus::Blocked,
            _ => TranscriptPromptStatus::Completed,
        };
        let finished_at = value
            .get("finishedAt")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(now_iso);
        vec![self.upsert_prompt(prompt_id, |prev| {
            TranscriptPrompt {
                prompt_id: prompt_id.to_string(),
                status,
                user_message_id: prev.and_then(|prev| prev.user_message_id.clone()),
                content: prev.and_then(|prev| prev.content.clone()),
                client_metadata: prev.and_then(|prev| prev.client_metadata.clone()),
                created_at: prev
                    .map(|prev| prev.created_at.clone())
                    .unwrap_or_else(|| finished_at.clone()),
                finished_at: Some(finished_at.clone()),
                steered_at: prev.and_then(|prev| prev.steered_at.clone()),
            }
        })]
    }

    /// v2 `onPromptAborted` (coreEventMap.ts:1371): abortedAt is both the
    /// finish and the created-at fallback for an unknown entity.
    fn fold_prompt_aborted(&mut self, value: &Value) -> Vec<TranscriptOperation> {
        let Some(prompt_id) = value.get("promptId").and_then(|v| v.as_str()) else {
            return Vec::new();
        };
        let aborted_at = value
            .get("abortedAt")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(now_iso);
        vec![self.upsert_prompt(prompt_id, |prev| {
            TranscriptPrompt {
                prompt_id: prompt_id.to_string(),
                status: TranscriptPromptStatus::Aborted,
                user_message_id: prev.and_then(|prev| prev.user_message_id.clone()),
                content: prev.and_then(|prev| prev.content.clone()),
                client_metadata: prev.and_then(|prev| prev.client_metadata.clone()),
                created_at: prev
                    .map(|prev| prev.created_at.clone())
                    .unwrap_or_else(|| aborted_at.clone()),
                finished_at: Some(aborted_at.clone()),
                steered_at: prev.and_then(|prev| prev.steered_at.clone()),
            }
        })]
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

    /// The turn a custom delta addresses. The delta names its own turn (v2's
    /// `AssistantDeltaPayload` / `ThinkingDeltaPayload` carry `turnId`), so
    /// the projector needs no cursor established by an earlier lifecycle
    /// event — the server path emits no typed `TurnStarted`. A payload
    /// without a turn id still falls back to the cursor for older producers.
    fn custom_delta_turn(&mut self, value: &Value) -> Option<usize> {
        match value.get("turn_id").and_then(|v| v.as_u64()) {
            Some(turn_id) => Some(self.ensure_turn(&turn_key_u64(turn_id))),
            None => self.cursor.map(|cursor| cursor.turn),
        }
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
        usage: Option<StepUsage>,
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
            usage,
            model: None,
            thinking_effort: None,
        };
        let task = self.merge_task(task);
        vec![TranscriptOperation::TaskUpsert { task }]
    }

    /// Open (or find) the turn a `t<N>` key names. The ordinal is the key's own
    /// number, not the registry position: v2 builds the turn from the event
    /// (`onTurnStarted`, coreEventMap.ts:415, `ordinal: n`, `turnId: t${n}`)
    /// and the cold rebuild numbers by insertion order
    /// (`transcript/src/history/groupTurns.ts`), so both agree on a fresh
    /// session. A positional ordinal drifts from `turnId` as soon as a
    /// projector starts mid-session — this one is created per subscriber — and
    /// the client keys the user bubble's `daemonTurnId` off it.
    fn ensure_turn(&mut self, key: &str) -> usize {
        if let Some(&idx) = self.turn_indices.get(key) {
            return idx;
        }
        let ordinal = key
            .strip_prefix('t')
            .and_then(|digits| digits.parse::<i64>().ok())
            .unwrap_or(self.turns.len() as i64);
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
        // The append offset counts **UTF-16 code units**, the unit JS counts:
        // the client splices with `text.slice(offset)` and rejects any offset
        // past `text.length`. A byte offset looks like a gap for every
        // non-ASCII chunk — the first append of a Chinese answer reports 83
        // characters as 243, the client refuses it as a hole, falls back to
        // re-fetching the whole transcript over REST, and the text lands in
        // one block instead of streaming. `chars().count()` is not enough
        // either: an astral character (emoji, CJK ext) is one char but two
        // code units, so a char count still slices mid-surrogate-pair. The
        // task path below counts the same unit.
        let offset = match &self.turns[turn_idx].steps[step_idx].frames[frame_idx] {
            TranscriptFrame::Text(frame) => frame.text.encode_utf16().count() as u64,
            TranscriptFrame::Thinking(frame) => frame.text.encode_utf16().count() as u64,
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
        // v2 #3970 (foldFacts): a spawn published before its task was
        // registered (the Tower worker path) leaves a placeholder keyed by
        // the agent id; the later registration must ADOPT it — one task under
        // the registered id — or the duplicate would stay `running` forever
        // (no terminal event ever reaches it). The lookup matches on the
        // agent id as well so terminal subagent records still land on the
        // adopted task.
        let position = self.tasks.iter().position(|task| {
            task.task_id == incoming.task_id
                || (incoming.agent_id.is_some() && task.agent_id == incoming.agent_id)
        });
        if let Some(position) = position {
            let existing = &mut self.tasks[position];
            // The registered id wins over the agent-keyed placeholder id.
            if existing.task_id != incoming.task_id
                && incoming.agent_id.as_deref() == Some(existing.task_id.as_str())
            {
                existing.task_id = incoming.task_id.clone();
            }
            apply_task_fields(existing, &incoming);
            return existing.clone();
        }
        self.tasks.push(incoming.clone());
        incoming
    }
}

/// Field-level merge of an incoming task record into an existing one:
/// terminal state and any populated fields move over, the retained fields
/// (output tail, placeholders) survive an empty incoming record.
///
/// The state is monotonic in one direction only: a task that already reached a
/// terminal state does not go back to `running`. The journal's writers can
/// interleave — `TaskRunner` spawns the subagent future before it publishes the
/// registration, so `subagent.completed` may be persisted ahead of
/// `event.task.created(status = "running")` — and a plain last-writer-wins
/// merge turned that ordering into a task that reports `running` forever.
fn apply_task_fields(existing: &mut TranscriptTask, incoming: &TranscriptTask) {
    if !is_terminal_task_state(existing.state) {
        existing.state = incoming.state;
    } else if !is_terminal_task_state(incoming.state) && incoming.state != existing.state {
        // A terminal task keeps its outcome; the losing event may still
        // contribute the fields it carries (below), just not a new state.
        tracing::debug!(
            task_id = %existing.task_id,
            kept = ?existing.state,
            ignored = ?incoming.state,
            "ignoring a non-terminal task state for an already-settled task",
        );
    }
    if incoming.kind != TaskKind::Other {
        existing.kind = incoming.kind;
    }
    if !incoming.output_tail.is_empty() {
        existing.output_tail = incoming.output_tail.clone();
    }
    if incoming.description.is_some() {
        existing.description = incoming.description.clone();
    }
    if incoming.agent_id.is_some() {
        existing.agent_id = incoming.agent_id.clone();
    }
    if incoming.started_at.is_some() {
        existing.started_at = incoming.started_at.clone();
    }
    if incoming.ended_at.is_some() {
        existing.ended_at = incoming.ended_at.clone();
    }
    if incoming.result_summary.is_some() {
        existing.result_summary = incoming.result_summary.clone();
    }
    if incoming.error.is_some() {
        existing.error = incoming.error.clone();
    }
    if incoming.state_reason.is_some() {
        existing.state_reason = incoming.state_reason.clone();
    }
    if incoming.usage.is_some() {
        existing.usage = incoming.usage.clone();
    }
    if incoming.model.is_some() {
        existing.model = incoming.model.clone();
    }
    if incoming.thinking_effort.is_some() {
        existing.thinking_effort = incoming.thinking_effort.clone();
    }
}

/// Whether a task state is final. `running` and `queued` are not: a task in
/// either can still settle.
fn is_terminal_task_state(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Completed | TaskState::Failed | TaskState::Killed | TaskState::Lost
    )
}

/// The rpc-layer usage shape as the transcript's step usage (four counters,
/// v2 `grandTotal` vocabulary).
fn rpc_usage_as_step_usage(usage: crate::rpc::types::TokenUsage) -> StepUsage {
    StepUsage {
        input_other: i64::from(usage.input_tokens),
        output: i64::from(usage.output_tokens),
        input_cache_read: i64::from(usage.input_cache_read),
        input_cache_creation: i64::from(usage.input_cache_creation),
    }
}

impl Default for TranscriptProjector {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn turn_header(turn: &TranscriptTurn) -> TurnHeader {
    TurnHeader {
        kind: TurnKind::Turn,
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
        kind: StepKind::Step,
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

/// Normalize a producer's turn id to the canonical `t<number>` key. v2's
/// turn ids are numbers (`turnId: z.number()`); the fork's typed events
/// still carry them as strings in both `turn-1` and `t1` shapes, and a
/// projection that keyed those differently would split one turn in two.
/// An unparseable id is kept verbatim rather than silently remapped.
fn turn_key(raw: &str) -> String {
    let digits = raw
        .rsplit_once(|c: char| !c.is_ascii_digit())
        .map_or(raw, |(_, digits)| digits);
    match digits.parse::<u64>() {
        Ok(number) => turn_key_u64(number),
        Err(_) => raw.to_string(),
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
    // A daemon reference (`kimi-file://<id>`) is a file identity, not a URL
    // a client could fetch: the transcript contract's `file` source carries
    // the id, which is what lets a client resolve the saved path through the
    // daemon's file API (v2 `displayPaths` reaching the protocol surface).
    let daemon_file_source = || {
        block
            .get("url")
            .and_then(|v| v.as_str())
            .and_then(crate::llm::media_resolver::parse_daemon_file_url)
            .map(|file_id| AttachmentSource::File {
                file_id: file_id.to_string(),
            })
    };
    let (media_type, source) = match kind {
        // A stored reference is the session-owned canonical copy: the
        // contract's `session_media` source names its file id.
        "media_ref" => {
            let file_id = block.get("file_id").and_then(|v| v.as_str())?;
            (
                media_kind_label(block.get("kind").and_then(|v| v.as_str())),
                Some(AttachmentSource::SessionMedia {
                    file_id: file_id.to_string(),
                }),
            )
        }
        "image" => (
            block
                .get("media_type")
                .and_then(|v| v.as_str())
                .unwrap_or("image")
                .to_string(),
            None,
        ),
        "image_url" => (
            "image".to_string(),
            daemon_file_source().or_else(url_source),
        ),
        "audio_url" => (
            "audio".to_string(),
            daemon_file_source().or_else(url_source),
        ),
        "video_url" => (
            "video".to_string(),
            daemon_file_source().or_else(url_source),
        ),
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

/// The media family label a `MediaRef` block's `kind` names (the block
/// serializes the engine's `MediaKind`).
fn media_kind_label(kind: Option<&str>) -> String {
    match kind {
        Some("video") => "video".to_string(),
        Some("audio") => "audio".to_string(),
        _ => "image".to_string(),
    }
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
        // The turn closes and its still-running step settles with it: the
        // client stamps a thinking block's `durationMs` only once the step
        // it belongs to has stopped running.
        assert_eq!(ops.len(), 2);
        assert!(matches!(ops[0], TranscriptOperation::TurnUpsert { .. }));
        assert!(matches!(ops[1], TranscriptOperation::StepUpsert { .. }));

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
            timing: Some(crate::llm::LlmTiming::from_marks(
                0,
                Some(10),
                Some(110),
                210,
            )),
        });
        match &ops[0] {
            TranscriptOperation::StepUpsert { step, .. } => {
                let usage = step.usage.as_ref().expect("usage recorded");
                assert_eq!(usage.output, 20);
                assert_eq!(usage.input_cache_read, 5);
                assert_eq!(step.state, StepState::Completed);
                // Upstream #3938: the timing rides the event into the step.
                let timing = step.timing.as_ref().expect("timing recorded");
                assert_eq!(timing.llm_first_token_latency_ms, Some(110));
                assert_eq!(timing.llm_stream_duration_ms, Some(100));
                assert_eq!(timing.llm_request_build_ms, Some(10));
                assert_eq!(timing.llm_server_first_token_ms, Some(100));
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

    /// v2 `displayPaths` reaching the protocol surface (ROADMAP #17 ②): a
    /// stored media reference folds into an attachment that names its file,
    /// so a client can resolve the saved path through the daemon's file API
    /// instead of receiving an identity-less URL or nothing at all.
    #[test]
    fn a_stored_media_reference_folds_into_a_file_sourced_attachment() {
        let mut projector = TranscriptProjector::new();
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.message.created",
            "message": {
                "id": "msg-u2",
                "role": "user",
                "created_at": "t",
                "content": [
                    { "type": "text", "text": "see" },
                    { "type": "media_ref", "file_id": "f_att1", "kind": "image" },
                    { "type": "image_url", "url": "kimi-file://f_att2" },
                    { "type": "image_url", "url": "https://example.test/remote.png" },
                ]
            }
        })));

        let attachments: Vec<&TranscriptAttachment> = ops
            .iter()
            .filter_map(|op| match op {
                TranscriptOperation::AttachmentUpsert { attachment } => Some(attachment),
                _ => None,
            })
            .collect();
        assert_eq!(attachments.len(), 3);

        // The stored reference is the session-owned canonical copy.
        assert_eq!(
            attachments[0].source,
            Some(AttachmentSource::SessionMedia {
                file_id: "f_att1".to_string()
            })
        );
        assert_eq!(attachments[0].media_type, "image");
        // A daemon URL is a file identity, not a fetchable URL.
        assert_eq!(
            attachments[1].source,
            Some(AttachmentSource::File {
                file_id: "f_att2".to_string()
            })
        );
        // A remote URL stays a URL.
        assert_eq!(
            attachments[2].source,
            Some(AttachmentSource::Url {
                url: "https://example.test/remote.png".to_string()
            })
        );

        // The turn the prompt opened names its attachments (v2's cold-fold
        // `turn.attachmentIds`): the link a client follows to the saved path.
        let snapshot = projector.snapshot();
        let turn = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                TranscriptItem::Turn(turn) if turn.turn_id == "t2" => Some(turn),
                _ => None,
            })
            .expect("the message id names the turn");
        assert_eq!(
            turn.attachment_ids.as_deref(),
            Some(
                &[
                    attachments[0].attachment_id.clone(),
                    attachments[1].attachment_id.clone(),
                    attachments[2].attachment_id.clone(),
                ][..]
            ),
            "every media part of the opening prompt is an attachment, URL-sourced ones included"
        );
    }

    /// v2 #3764 on the v1 transcript surface: the contract's
    /// `transcriptPromptSchema` carries `clientMetadata`, and the
    /// submission's metadata object rides it as the one-element array the
    /// contract shapes. The turn's announcement upserts the same prompt
    /// and carries the metadata over rather than dropping it.
    #[test]
    fn the_prompt_entity_carries_the_submissions_client_metadata() {
        let mut projector = TranscriptProjector::new();
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.submitted",
            "promptId": "prompt-1",
            "userMessageId": "msg-prompt-1",
            "status": "running",
            "content": [{ "type": "text", "text": "hi" }],
            "createdAt": "2026-09-20T00:00:00.000Z",
            "metadata": { "surface": "web", "threadId": "abc" },
        })));
        match &ops[0] {
            TranscriptOperation::PromptUpsert { prompt } => {
                assert_eq!(prompt.prompt_id, "prompt-1");
                assert_eq!(
                    prompt.client_metadata,
                    Some(vec![json!({ "surface": "web", "threadId": "abc" })]),
                );
            }
            other => panic!("expected a prompt upsert, got {other:?}"),
        }

        // The announcement upserts the same prompt and keeps the metadata.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.message.created",
            "message": {
                "id": "msg-u1",
                "role": "user",
                "content": [{ "type": "text", "text": "hi" }],
                "created_at": "2026-09-20T00:00:01.000Z",
            },
        })));
        // The announcement's prompt id is the message id, which differs
        // from the submission's prompt id — the two entities are distinct,
        // and only the submission's carries the metadata.
        let prompts: Vec<&TranscriptPrompt> = ops
            .iter()
            .filter_map(|op| match op {
                TranscriptOperation::PromptUpsert { prompt } => Some(prompt),
                _ => None,
            })
            .collect();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].prompt_id, "msg-u1");
        assert_eq!(prompts[0].client_metadata, None);

        // A submission whose prompt id IS the message id (the steer path
        // reuses the prompt id) keeps its metadata across the announcement.
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.submitted",
            "promptId": "msg-u2",
            "status": "running",
            "content": [{ "type": "text", "text": "hi" }],
            "createdAt": "2026-09-20T00:00:00.000Z",
            "metadata": { "surface": "web" },
        })));
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.message.created",
            "message": {
                "id": "msg-u2",
                "role": "user",
                "content": [{ "type": "text", "text": "hi" }],
                "created_at": "2026-09-20T00:00:01.000Z",
            },
        })));
        match &ops[0] {
            TranscriptOperation::PromptUpsert { prompt } => {
                assert_eq!(
                    prompt.client_metadata,
                    Some(vec![json!({ "surface": "web" })]),
                    "the announcement must not drop the submission's metadata"
                );
            }
            other => panic!("expected a prompt upsert, got {other:?}"),
        }
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

        // `work_changed` merges the activity state. The engine publishes the
        // typed variant on the production path, so that spelling is the one
        // that has to work; the JSON form stays for replay-shaped input.
        let ops = projector.apply_event(&EngineEvent::SessionWorkChanged {
            busy: true,
            main_turn_active: true,
            pending_interaction: "none".into(),
            last_turn_reason: None,
        });
        match &ops[0] {
            TranscriptOperation::MetaMerge { meta } => {
                assert_eq!(meta.activity, Some(ActivityMeta::Turn));
            }
            other => panic!("expected meta.merge, got {other:?}"),
        }
        let ops = projector.apply_event(&EngineEvent::SessionWorkChanged {
            busy: false,
            main_turn_active: false,
            pending_interaction: "none".into(),
            last_turn_reason: Some("completed".into()),
        });
        match &ops[0] {
            TranscriptOperation::MetaMerge { meta } => {
                assert_eq!(
                    meta.activity,
                    Some(ActivityMeta::Idle),
                    "a finished turn must clear the activity flag the client gates on"
                );
            }
            other => panic!("expected meta.merge, got {other:?}"),
        }
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
            subagent_id: "sub-1".into(),
            subagent_name: Some("research".into()),
            parent_tool_call_id: Some("call-1".into()),
            description: None,
            run_in_background: false,
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
            subagent_id: "sub-1".into(),
            result_summary: Some("done".into()),
            usage: Some(crate::rpc::types::TokenUsage {
                input_tokens: 10,
                output_tokens: 4,
                total_tokens: 14,
                input_cache_read: 3,
                input_cache_creation: 2,
            }),
        });
        match &ops[0] {
            TranscriptOperation::TaskUpsert { task } => {
                assert_eq!(task.state, TaskState::Completed);
                assert_eq!(task.result_summary.as_deref(), Some("done"));
                // #3970: the durable record's four counters restore onto the
                // folded task.
                let usage = task.usage.as_ref().expect("usage restored");
                assert_eq!(usage.input_other, 10);
                assert_eq!(usage.output, 4);
                assert_eq!(usage.input_cache_read, 3);
                assert_eq!(usage.input_cache_creation, 2);
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

    #[test]
    fn wire_form_subagent_lifecycle_folds_with_usage() {
        // The durable wire record (snake_case JSON) must parse into the typed
        // variant and fold — previously it fell through to `Custom` and was
        // dropped wholesale, so no task ever appeared.
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.spawned",
            "subagent_id": "sub-9",
            "subagent_name": "tower-worker",
            "parent_tool_call_id": "call-42",
            "run_in_background": true
        })));
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.completed",
            "subagent_id": "sub-9",
            "result_summary": "ok",
            "usage": {
                "input_tokens": 7,
                "output_tokens": 2,
                "total_tokens": 9,
                "input_cache_read": 1,
                "input_cache_creation": 0
            }
        })));
        let tasks = projector.snapshot().tasks;
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].state, TaskState::Completed);
        assert_eq!(tasks[0].usage.as_ref().map(|u| u.input_other), Some(7));
    }

    #[test]
    fn a_task_registered_after_the_spawn_adopts_the_placeholder() {
        // #3970 (Tower worker path): spawn first, task registration later —
        // the registered id must replace the agent-keyed placeholder, and the
        // terminal record (still keyed by agent id) must reach it.
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.spawned",
            "subagent_id": "agent-7",
            "run_in_background": true
        })));
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.task.created",
            "task": {
                "id": "task-77",
                "kind": "subagent",
                "agent_id": "agent-7",
                "status": "running",
                "description": "worker"
            }
        })));
        assert_eq!(projector.snapshot().tasks.len(), 1, "no duplicate task");
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.completed",
            "subagent_id": "agent-7",
            "result_summary": "done"
        })));
        let tasks = projector.snapshot().tasks;
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_id, "task-77");
        assert_eq!(tasks[0].state, TaskState::Completed);
        assert_eq!(tasks[0].agent_id.as_deref(), Some("agent-7"));
    }

    /// The journal writers interleave: `TaskRunner` starts the subagent future
    /// before it publishes the registration, so a fast subagent's terminal event
    /// can be persisted *ahead* of `event.task.created(status = "running")`. A
    /// last-writer-wins merge turned that ordering into a task stuck at
    /// `running` forever.
    #[test]
    fn a_late_task_registration_cannot_resurrect_a_settled_task() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.spawned",
            "subagent_id": "agent-7",
            "run_in_background": true
        })));
        // Terminal first, registration second — the ordering the spawn-then-
        // publish path produces.
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.completed",
            "subagent_id": "agent-7",
            "result_summary": "done"
        })));
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.task.created",
            "task": {
                "id": "task-77",
                "kind": "subagent",
                "agent_id": "agent-7",
                "status": "running",
                "description": "worker"
            }
        })));

        let tasks = projector.snapshot().tasks;
        assert_eq!(tasks.len(), 1, "still one task");
        assert_eq!(
            tasks[0].state,
            TaskState::Completed,
            "the late registration must not reopen a finished task"
        );
        // The registration's own fields still land — only its state is refused.
        assert_eq!(tasks[0].description.as_deref(), Some("worker"));
        assert_eq!(tasks[0].task_id, "task-77");
    }

    /// A failure is a terminal outcome too: the generic task-completion event
    /// that follows a failed subagent must not report it as completed.
    #[test]
    fn a_settled_failure_is_not_overwritten_by_a_completion() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.spawned",
            "subagent_id": "agent-8"
        })));
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.failed",
            "subagent_id": "agent-8",
            "error": "boom"
        })));
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.task.completed",
            "task": {
                "id": "agent-8",
                "kind": "subagent",
                "agent_id": "agent-8",
                "status": "completed",
                "output": "partial"
            }
        })));

        let tasks = projector.snapshot().tasks;
        assert_eq!(tasks.len(), 1);
        assert_eq!(
            tasks[0].state,
            TaskState::Failed,
            "a failed subagent stays failed whatever the generic task event says"
        );
    }

    #[test]
    fn cold_snapshot_settles_members_to_lost_by_the_spawning_turn() {
        // #3970: a member left running is lost unless the turn that spawned
        // it is itself still running in the rebuild.
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 1,
            prompt: None,
        });
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.spawned",
            "subagent_id": "agent-a"
        })));
        projector.apply_event(&EngineEvent::TurnEnded {
            agent_id: "main".into(),
            turn_id: 1,
            reason: "completed".into(),
        });
        projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 2,
            prompt: None,
        });
        projector.apply_event(&EngineEvent::from_json(json!({
            "type": "subagent.spawned",
            "subagent_id": "agent-b"
        })));

        // Live: both members legitimately stay running (background members
        // outlive their spawning turn and settle on their own events).
        let live = projector.snapshot().tasks;
        assert!(live.iter().all(|t| t.state == TaskState::Running));

        // Cold: agent-a's spawning turn ended → lost; agent-b's turn (t2)
        // still runs → survives.
        let cold = projector.cold_snapshot_tasks();
        let a = cold
            .iter()
            .find(|t| t.agent_id.as_deref() == Some("agent-a"))
            .unwrap();
        let b = cold
            .iter()
            .find(|t| t.agent_id.as_deref() == Some("agent-b"))
            .unwrap();
        assert_eq!(a.state, TaskState::Lost);
        assert_eq!(b.state, TaskState::Running);
    }

    /// Reproduces the production defect: the server path publishes
    /// `event.assistant.delta` without ever emitting a typed `TurnStarted`, so
    /// the projector had no cursor and dropped every streamed chunk. The delta
    /// is self-describing (it carries `turn_id`, as v2's payload carries
    /// `turnId`), so the text now reaches the transcript lane.
    #[test]
    fn custom_assistant_delta_streams_without_a_typed_turn_start() {
        let mut projector = TranscriptProjector::new();

        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.assistant.delta",
            "turn_id": 1,
            "message_id": "msg-a1-1",
            "content_index": 0,
            "delta": "hello",
        })));

        assert!(
            ops.iter()
                .any(|op| matches!(op, TranscriptOperation::Append { .. })),
            "a streamed assistant delta must reach the transcript lane; got {ops:?}"
        );
        match &ops[0] {
            TranscriptOperation::FrameUpsert { frame, .. } => assert!(
                matches!(frame, TranscriptFrame::Text(_)),
                "a text delta must open a text frame, got {frame:?}"
            ),
            other => panic!("expected frame.upsert first, got {other:?}"),
        }
    }

    /// A thinking chunk rides its own event name — v2 keeps `thinking.delta`
    /// distinct from `assistant.delta` rather than flagging the answer stream
    /// — and opens a Thinking frame, the distinction the web client reads to
    /// render a reasoning block.
    #[test]
    fn custom_thinking_delta_opens_a_thinking_frame() {
        let mut projector = TranscriptProjector::new();

        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.thinking.delta",
            "turn_id": 1,
            "message_id": "msg-a1-1",
            "content_index": 0,
            "delta": "reasoning",
        })));

        match ops.first() {
            Some(TranscriptOperation::FrameUpsert { frame, .. }) => assert!(
                matches!(frame, TranscriptFrame::Thinking(_)),
                "a thinking delta must open a thinking frame, got {frame:?}"
            ),
            other => panic!("expected frame.upsert, got {other:?}"),
        }
    }

    /// The append offset counts UTF-16 code units, the unit JS counts: the
    /// client rejects an offset past `text.length` as a gap and re-fetches the
    /// transcript instead of splicing — so a byte offset makes every non-ASCII
    /// answer arrive in one block rather than streaming, and a char count
    /// still slices an astral character mid-surrogate-pair.
    #[test]
    fn append_offsets_count_utf16_units() {
        let mut projector = TranscriptProjector::new();

        let delta = |text: &str| {
            EngineEvent::Custom(json!({
                "type": "event.assistant.delta",
                "turn_id": 1,
                "message_id": "msg-a1-1",
                "content_index": 0,
                "delta": text,
            }))
        };

        projector.apply_event(&delta("长城"));
        let ops = projector.apply_event(&delta("的建造"));

        let append = ops
            .iter()
            .find(|op| matches!(op, TranscriptOperation::Append { .. }))
            .expect("second chunk must append");
        match append {
            TranscriptOperation::Append { offset, .. } => assert_eq!(
                *offset, 2,
                "offset must count the two characters already in the frame, \
                 not their UTF-8 byte length (6)"
            ),
            other => panic!("expected append, got {other:?}"),
        }

        // A third chunk continues from the code-unit count, so the client's
        // splice matches with no gap.
        let ops = projector.apply_event(&delta("历史"));
        match ops
            .iter()
            .find(|op| matches!(op, TranscriptOperation::Append { .. }))
            .expect("third chunk must append")
        {
            TranscriptOperation::Append { offset, .. } => assert_eq!(*offset, 5),
            other => panic!("expected append, got {other:?}"),
        }

        // An astral character is one char but two code units: the offset must
        // report 2 after a lone emoji, or the client's slice starts inside the
        // surrogate pair and the text renders corrupted.
        let mut emoji = TranscriptProjector::new();
        emoji.apply_event(&delta("😀"));
        let ops = emoji.apply_event(&delta("好"));
        match ops
            .iter()
            .find(|op| matches!(op, TranscriptOperation::Append { .. }))
            .expect("chunk after an emoji must append")
        {
            TranscriptOperation::Append { offset, .. } => assert_eq!(
                *offset, 2,
                "one emoji is two UTF-16 code units, not one char"
            ),
            other => panic!("expected append, got {other:?}"),
        }
    }

    /// A turn opened by a streamed delta is closed by the typed `turn.ended`
    /// — the event v2 assigns the turn state to — and its step settles with
    /// it: the client only stamps a thinking block's `durationMs` once the
    /// step it belongs to has stopped running.
    #[test]
    fn turn_ended_closes_the_turn_and_its_steps() {
        let mut projector = TranscriptProjector::new();

        // A turn opened by deltas, the way the server path opens one.
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.assistant.delta",
            "turn_id": 4,
            "delta": "answer",
        })));
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.thinking.delta",
            "turn_id": 4,
            "delta": "reasoning",
        })));

        let ops = projector.apply_event(&EngineEvent::TurnEnded {
            agent_id: "main".into(),
            turn_id: 4,
            reason: "completed".into(),
        });

        let turn_op = ops
            .iter()
            .find(|op| matches!(op, TranscriptOperation::TurnUpsert { .. }))
            .expect("the finished turn must be republished");
        match turn_op {
            TranscriptOperation::TurnUpsert { turn } => {
                assert_eq!(turn.state, TurnState::Completed);
                assert!(turn.ended_at.is_some(), "a closed turn carries its end");
            }
            other => panic!("expected turn.upsert, got {other:?}"),
        }
        assert!(
            ops.iter()
                .any(|op| matches!(op, TranscriptOperation::StepUpsert { .. })),
            "the turn's steps must settle too: {ops:?}"
        );

        // The snapshot agrees, which is what the client reads.
        let snapshot = projector.snapshot();
        let turn = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                TranscriptItem::Turn(turn) => Some(turn),
                _ => None,
            })
            .expect("a turn exists");
        assert_eq!(turn.state, TurnState::Completed);
        assert!(
            turn.steps.iter().all(|s| s.state == StepState::Completed),
            "a clean turn's steps must settle completed, not interrupted: {:?}",
            turn.steps.iter().map(|s| s.state).collect::<Vec<_>>()
        );
    }

    /// `prompt.completed` owns no turn state here: v2 keeps the two entities on
    /// separate schedules (`onPromptCompleted`, coreEventMap.ts:1356), so the
    /// turn stays running until the typed `turn.ended` names it. Folding the
    /// turn here would close it on the prompt's schedule instead.
    #[test]
    fn prompt_completed_does_not_close_the_turn() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.assistant.delta",
            "turn_id": 4,
            "delta": "answer",
        })));

        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.completed",
            "agentId": "main",
            "promptId": "prompt-1",
            "reason": "completed",
            "finishedAt": "2026-09-22T00:00:00Z",
        })));
        // The arm settles the prompt entity — v2 `onPromptCompleted`
        // (coreEventMap.ts:1356) emits exactly that one upsert — and folds
        // no turn state.
        match ops.as_slice() {
            [TranscriptOperation::PromptUpsert { prompt }] => {
                assert_eq!(prompt.status, TranscriptPromptStatus::Completed);
                assert!(
                    prompt.finished_at.is_some(),
                    "prompt.completed must settle finishedAt"
                );
            }
            other => panic!("expected exactly one prompt.upsert, got {other:?}"),
        }

        let snapshot = projector.snapshot();
        let turn = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                TranscriptItem::Turn(turn) => Some(turn),
                _ => None,
            })
            .expect("a turn exists");
        assert_eq!(
            turn.state,
            TurnState::Running,
            "the turn closes on turn.ended, not on prompt.completed"
        );
    }

    /// `turn.ended` closes the turn it names and leaves every other turn
    /// alone — v2's turn state records a single `lastEnded` turn id, never a
    /// broadcast over the running turns.
    #[test]
    fn turn_ended_closes_only_the_turn_it_names() {
        let mut projector = TranscriptProjector::new();
        for turn_id in [4, 5] {
            projector.apply_event(&EngineEvent::Custom(json!({
                "type": "event.assistant.delta",
                "turn_id": turn_id,
                "delta": "answer",
            })));
        }

        projector.apply_event(&EngineEvent::TurnEnded {
            agent_id: "main".into(),
            turn_id: 5,
            reason: "completed".into(),
        });

        let snapshot = projector.snapshot();
        let states: Vec<TurnState> = snapshot
            .items
            .iter()
            .filter_map(|item| match item {
                TranscriptItem::Turn(turn) => Some(turn.state),
                _ => None,
            })
            .collect();
        assert_eq!(
            states,
            vec![TurnState::Running, TurnState::Completed],
            "only the named turn may close; got {states:?}"
        );
    }

    /// A failed turn reports failure rather than success, with v2's reason
    /// vocabulary on the typed event.
    #[test]
    fn a_failed_reason_closes_the_turn_as_failed() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.assistant.delta",
            "turn_id": 7,
            "delta": "partial",
        })));

        let ops = projector.apply_event(&EngineEvent::TurnEnded {
            agent_id: "main".into(),
            turn_id: 7,
            reason: "failed".into(),
        });

        match ops.first() {
            Some(TranscriptOperation::TurnUpsert { turn }) => {
                assert_eq!(turn.state, TurnState::Failed);
            }
            other => panic!("expected turn.upsert, got {other:?}"),
        }
    }

    /// v2's `turnEndReasonSchema` (turnOps.ts:97) carries `blocked` alongside
    /// the three the fork's loop produces; a blocked turn must report failed
    /// rather than silently reporting as completed. See `mapTurnEndState`
    /// (coreEventMap.ts:1608) and the same fold in the cold rebuild
    /// (`transcript/src/history/foldFacts.ts`, `mapTurnEndReason`).
    #[test]
    fn a_blocked_reason_closes_the_turn_as_failed() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "event.assistant.delta",
            "turn_id": 8,
            "delta": "partial",
        })));

        let ops = projector.apply_event(&EngineEvent::TurnEnded {
            agent_id: "main".into(),
            turn_id: 8,
            reason: "blocked".into(),
        });

        match ops.first() {
            Some(TranscriptOperation::TurnUpsert { turn }) => {
                assert_eq!(turn.state, TurnState::Failed);
            }
            other => panic!("expected turn.upsert, got {other:?}"),
        }
    }

    /// `turn.steer` buffers without emitting, then lands as a user frame at
    /// the head of the next step — v2 `onTurnSteered` (coreEventMap.ts:1413)
    /// buffered into `pendingSteers` and drained by `onStepStarted` (:568).
    #[test]
    fn turn_steer_buffers_until_the_next_step_begin() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 4,
            prompt: Some("first".into()),
        });

        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "turn.steer",
            "agentId": "main",
            "origin": { "kind": "user" },
            "input": [{ "type": "text", "text": "also do X" }],
            "promptIds": ["prompt-2"],
        })));
        assert!(
            ops.is_empty(),
            "a steer buffers, emitting no op until a step begins; got {ops:?}"
        );

        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "llm.step.begin",
            "model": "kimi-k2",
        })));
        // The turn has no step yet: the flush opens one (StepUpsert) and the
        // user frame lands at its head (FrameUpsert).
        assert_eq!(ops.len(), 2, "step upsert + steer frame; got {ops:?}");
        assert!(matches!(ops[0], TranscriptOperation::StepUpsert { .. }));
        match &ops[1] {
            TranscriptOperation::FrameUpsert { frame, .. } => match frame {
                TranscriptFrame::Text(frame) => {
                    assert_eq!(frame.role, TextRole::User);
                    assert_eq!(frame.text, "also do X");
                    assert_eq!(frame.prompt_ids, Some(vec!["prompt-2".to_string()]));
                }
                other => panic!("expected a text frame, got {other:?}"),
            },
            other => panic!("expected frame.upsert, got {other:?}"),
        }

        // The flushed user frame sits under the cursor: the next delta opens
        // a fresh assistant frame instead of appending to it.
        projector.apply_event(&EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: 4,
            delta: "on it".into(),
        });
        let snapshot = projector.snapshot();
        let turn = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                TranscriptItem::Turn(turn) => Some(turn),
                _ => None,
            })
            .expect("the turn exists");
        let frames = &turn.steps[0].frames;
        assert_eq!(frames.len(), 2, "steer frame then assistant frame");
        match (&frames[0], &frames[1]) {
            (TranscriptFrame::Text(user), TranscriptFrame::Text(assistant)) => {
                assert_eq!(user.role, TextRole::User);
                assert_eq!(assistant.role, TextRole::Assistant);
                assert_eq!(assistant.text, "on it");
            }
            other => panic!("expected two text frames, got {other:?}"),
        }
    }

    /// The flush is gated on a running turn (ROADMAP item 34): a steer
    /// buffered after its turn ended survives the following step begin and
    /// lands in the next running turn instead of a closed one.
    #[test]
    fn the_steer_flush_waits_for_a_running_turn() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 4,
            prompt: Some("first".into()),
        });
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "llm.step.begin",
            "model": "kimi-k2",
        })));
        projector.apply_event(&EngineEvent::TurnEnded {
            agent_id: "main".into(),
            turn_id: 4,
            reason: "completed".into(),
        });

        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "turn.steer",
            "origin": { "kind": "user" },
            "input": [{ "type": "text", "text": "after the end" }],
            "promptIds": ["prompt-3"],
        })));
        assert!(ops.is_empty());

        // The cursor still points at the ended turn: no flush there.
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "llm.step.begin",
            "model": "kimi-k2",
        })));
        assert!(
            ops.is_empty(),
            "a closed turn collects no steer frames; got {ops:?}"
        );

        // The next running turn picks the buffered steer up.
        projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 5,
            prompt: Some("second".into()),
        });
        let ops = projector.apply_event(&EngineEvent::LlmStepBegin {
            turn_id: "5".into(),
            step: 1,
        });
        let frame_op = ops
            .iter()
            .find_map(|op| match op {
                TranscriptOperation::FrameUpsert { frame, .. } => Some(frame),
                _ => None,
            })
            .expect("the buffered steer lands in the running turn");
        match frame_op {
            TranscriptFrame::Text(frame) => {
                assert_eq!(frame.role, TextRole::User);
                assert_eq!(frame.text, "after the end");
            }
            other => panic!("expected a text frame, got {other:?}"),
        }

        let snapshot = projector.snapshot();
        let closed = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                TranscriptItem::Turn(turn) if turn.turn_id == "t4" => Some(turn),
                _ => None,
            })
            .expect("turn t4 exists");
        assert!(
            closed
                .steps
                .iter()
                .all(|step| step.frames.iter().all(|frame| {
                    !matches!(frame, TranscriptFrame::Text(text) if text.role == TextRole::User)
                })),
            "the closed turn must not collect the steer frame"
        );
    }

    /// Only a user or skill-activation steer with an array input folds —
    /// v2's `onTurnSteered` guard (coreEventMap.ts:1416).
    #[test]
    fn steer_folds_only_user_and_skill_activation_array_inputs() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 6,
            prompt: Some("first".into()),
        });
        for payload in [
            json!({
                "type": "turn.steer",
                "origin": { "kind": "injection" },
                "input": [{ "type": "text", "text": "not the user" }],
            }),
            json!({
                "type": "turn.steer",
                "origin": { "kind": "user" },
                "input": "not an array",
            }),
            json!({ "type": "turn.steer", "input": [] }),
        ] {
            let ops = projector.apply_event(&EngineEvent::Custom(payload));
            assert!(ops.is_empty());
        }

        let ops = projector.apply_event(&EngineEvent::LlmStepBegin {
            turn_id: "6".into(),
            step: 1,
        });
        assert_eq!(
            ops.len(),
            1,
            "only the step upsert — nothing was buffered; got {ops:?}"
        );
        assert!(matches!(ops[0], TranscriptOperation::StepUpsert { .. }));
    }

    /// v2 `onPromptSteered` (coreEventMap.ts:1384): the active prompt stays
    /// open under the steer, each steered id settles as completed at the
    /// steer's timestamp, and the submission's fields survive.
    #[test]
    fn steered_settles_the_steered_ids_and_keeps_the_active_open() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.submitted",
            "promptId": "prompt-1",
            "userMessageId": "msg-prompt-1",
            "status": "running",
            "content": [{ "type": "text", "text": "first" }],
            "createdAt": "2026-09-22T00:00:00Z",
            "metadata": { "note": "carry me" },
        })));

        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.steered",
            "activePromptId": "prompt-1",
            "promptIds": ["prompt-0"],
            "content": [{ "type": "text", "text": "follow-up" }],
            "steeredAt": "2026-09-22T00:00:01Z",
        })));
        assert_eq!(
            ops.len(),
            2,
            "active upsert + one per steered id; got {ops:?}"
        );

        let snapshot = projector.snapshot();
        assert_eq!(snapshot.prompts.len(), 2);
        let active = snapshot
            .prompts
            .iter()
            .find(|prompt| prompt.prompt_id == "prompt-1")
            .expect("the active prompt exists");
        assert_eq!(active.status, TranscriptPromptStatus::Running);
        assert_eq!(active.steered_at.as_deref(), Some("2026-09-22T00:00:01Z"));
        assert_eq!(
            active.created_at, "2026-09-22T00:00:00Z",
            "the steer must not move createdAt"
        );
        assert_eq!(
            active.client_metadata,
            Some(vec![json!({ "note": "carry me" })]),
            "the steer must not drop the client metadata"
        );
        let steered = snapshot
            .prompts
            .iter()
            .find(|prompt| prompt.prompt_id == "prompt-0")
            .expect("the steered prompt exists");
        assert_eq!(steered.status, TranscriptPromptStatus::Completed);
        assert_eq!(steered.finished_at.as_deref(), Some("2026-09-22T00:00:01Z"));
    }

    /// The route's `unwrap_or_default` can hand an empty `activePromptId`:
    /// no entity may be created under the empty key, but the steered ids
    /// still settle (ROADMAP item 34).
    #[test]
    fn steered_with_no_active_prompt_still_settles_the_ids() {
        let mut projector = TranscriptProjector::new();
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.steered",
            "activePromptId": "",
            "promptIds": ["prompt-3"],
            "content": [],
            "steeredAt": "2026-09-22T00:00:02Z",
        })));
        assert_eq!(ops.len(), 1, "only the steered id settles; got {ops:?}");

        let snapshot = projector.snapshot();
        assert_eq!(snapshot.prompts.len(), 1);
        assert_eq!(snapshot.prompts[0].prompt_id, "prompt-3");
        assert_eq!(
            snapshot.prompts[0].status,
            TranscriptPromptStatus::Completed
        );
    }

    /// v2 `onPromptAborted` (coreEventMap.ts:1371): abortedAt settles the
    /// entity, createdAt falls back to it, and a later duplicate submission
    /// must not resurrect a terminal prompt.
    #[test]
    fn prompt_aborted_settles_the_entity_and_survives_a_duplicate_submission() {
        let mut projector = TranscriptProjector::new();
        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.submitted",
            "promptId": "prompt-1",
            "userMessageId": "msg-prompt-1",
            "status": "running",
            "content": [{ "type": "text", "text": "first" }],
            "createdAt": "2026-09-22T00:00:00Z",
        })));
        let ops = projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.aborted",
            "promptId": "prompt-1",
            "abortedAt": "2026-09-22T00:00:03Z",
        })));
        assert_eq!(ops.len(), 1);

        projector.apply_event(&EngineEvent::Custom(json!({
            "type": "prompt.submitted",
            "promptId": "prompt-1",
            "userMessageId": "msg-prompt-1",
            "status": "running",
            "content": [{ "type": "text", "text": "duplicate" }],
            "createdAt": "2026-09-22T00:00:04Z",
        })));

        let snapshot = projector.snapshot();
        let prompt = snapshot
            .prompts
            .iter()
            .find(|prompt| prompt.prompt_id == "prompt-1")
            .expect("the prompt exists");
        assert_eq!(
            prompt.status,
            TranscriptPromptStatus::Aborted,
            "a duplicate submission must not resurrect a terminal prompt"
        );
        assert_eq!(prompt.finished_at.as_deref(), Some("2026-09-22T00:00:03Z"));
        assert_eq!(
            prompt.created_at, "2026-09-22T00:00:00Z",
            "createdAt stays with the entity"
        );
    }
}
