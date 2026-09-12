use serde::{Deserialize, Serialize};

use super::model::{
    AgentId, AttachmentId, FrameId, StepId, StepRetry, StepState, StepTiming, StepUsage, TaskId,
    TranscriptAttachment, TranscriptFrame, TranscriptInteraction, TranscriptItem, TranscriptMarker,
    TranscriptMeta, TranscriptMetaMerge, TranscriptPrompt, TranscriptTask, TranscriptTaskRef,
    TranscriptTodo, TranscriptUsage, TurnId, TurnOrigin, TurnState,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnHeader {
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
pub struct StepHeader {
    pub step_id: StepId,
    pub turn_id: TurnId,
    pub ordinal: i64,
    pub state: StepState,
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
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppendTarget {
    Frame {
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        #[serde(rename = "stepId")]
        step_id: StepId,
        #[serde(rename = "frameId")]
        frame_id: FrameId,
    },
    Task {
        #[serde(rename = "taskId")]
        task_id: TaskId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptSnapshot {
    pub items: Vec<TranscriptItem>,
    pub tasks: Vec<TranscriptTask>,
    #[serde(default)]
    pub interactions: Vec<TranscriptInteraction>,
    #[serde(default)]
    pub attachments: Vec<TranscriptAttachment>,
    #[serde(default)]
    pub todos: Vec<TranscriptTodo>,
    #[serde(default)]
    pub prompts: Vec<TranscriptPrompt>,
    pub meta: TranscriptMeta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more_older: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptOpBatch {
    pub agent_id: AgentId,
    pub ops: Vec<TranscriptOperation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum TranscriptOperation {
    #[serde(rename = "reset")]
    Reset {
        #[serde(rename = "agentId")]
        agent_id: AgentId,
        snapshot: AgentTranscriptSnapshot,
    },
    #[serde(rename = "turn.upsert")]
    TurnUpsert { turn: TurnHeader },
    #[serde(rename = "step.upsert")]
    StepUpsert {
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        step: StepHeader,
    },
    #[serde(rename = "frame.upsert")]
    FrameUpsert {
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        #[serde(rename = "stepId")]
        step_id: StepId,
        frame: TranscriptFrame,
    },
    #[serde(rename = "append")]
    Append {
        target: AppendTarget,
        offset: u64,
        text: String,
    },
    #[serde(rename = "marker.upsert")]
    MarkerUpsert {
        item: TranscriptMarker,
        #[serde(
            rename = "beforeTurn",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        before_turn: Option<i64>,
    },
    #[serde(rename = "taskref.upsert")]
    TaskRefUpsert {
        item: TranscriptTaskRef,
        #[serde(
            rename = "beforeTurn",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        before_turn: Option<i64>,
    },
    #[serde(rename = "task.upsert")]
    TaskUpsert { task: TranscriptTask },
    #[serde(rename = "interaction.upsert")]
    InteractionUpsert { interaction: TranscriptInteraction },
    #[serde(rename = "attachment.upsert")]
    AttachmentUpsert { attachment: TranscriptAttachment },
    #[serde(rename = "todo.upsert")]
    TodoUpsert { todo: TranscriptTodo },
    #[serde(rename = "prompt.upsert")]
    PromptUpsert { prompt: TranscriptPrompt },
    #[serde(rename = "meta.merge")]
    MetaMerge { meta: TranscriptMetaMerge },
    #[serde(rename = "items.remove")]
    ItemsRemove { ids: Vec<String> },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dotted_ops_and_nested_targets_round_trip() {
        let value = json!({
            "op": "append",
            "target": {
                "type": "frame",
                "turnId": "t0",
                "stepId": "t0.1",
                "frameId": "t0.1.f1"
            },
            "offset": 3,
            "text": "abc"
        });
        let op: TranscriptOperation = serde_json::from_value(value).expect("deserialize append");
        let round = serde_json::to_value(&op).expect("serialize append");
        assert_eq!(round["op"], "append");
        assert_eq!(round["target"]["type"], "frame");
        assert_eq!(round["target"]["frameId"], "t0.1.f1");
        assert_eq!(
            op,
            serde_json::from_value(round).expect("round-trip append")
        );

        let upsert: TranscriptOperation = serde_json::from_value(json!({
            "op": "turn.upsert",
            "turn": {
                "turnId": "t0",
                "ordinal": 0,
                "state": "running",
                "origin": { "kind": "task", "taskId": "task_1" }
            }
        }))
        .expect("deserialize turn.upsert");
        let round = serde_json::to_value(&upsert).expect("serialize turn.upsert");
        assert_eq!(round["op"], "turn.upsert");
        assert_eq!(round["turn"]["origin"]["kind"], "task");
        assert_eq!(round["turn"]["origin"]["taskId"], "task_1");

        let remove: TranscriptOperation = serde_json::from_value(json!({
            "op": "items.remove",
            "ids": ["t0", "m1"]
        }))
        .expect("deserialize items.remove");
        assert_eq!(
            serde_json::to_value(&remove).expect("serialize items.remove")["op"],
            "items.remove"
        );
    }
}
