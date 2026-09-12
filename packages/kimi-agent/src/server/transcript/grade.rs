use serde::{Deserialize, Serialize};

use super::model::TranscriptItem;
use super::ops::{AgentTranscriptSnapshot, TranscriptOperation};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptGrade {
    Off,
    Turn,
    Block,
    Delta,
}

pub const GRADE_RANK_OFF: u8 = 0;
pub const GRADE_RANK_TURN: u8 = 1;
pub const GRADE_RANK_BLOCK: u8 = 2;
pub const GRADE_RANK_DELTA: u8 = 3;

impl TranscriptGrade {
    pub fn rank(self) -> u8 {
        match self {
            TranscriptGrade::Off => GRADE_RANK_OFF,
            TranscriptGrade::Turn => GRADE_RANK_TURN,
            TranscriptGrade::Block => GRADE_RANK_BLOCK,
            TranscriptGrade::Delta => GRADE_RANK_DELTA,
        }
    }
}

pub fn needs_reset_on_transition(prev: TranscriptGrade, next: TranscriptGrade) -> bool {
    next.rank() > prev.rank()
}

pub fn filter_ops_for_grade(
    grade: TranscriptGrade,
    ops: &[TranscriptOperation],
) -> Vec<TranscriptOperation> {
    if grade.rank() == 0 {
        return Vec::new();
    }
    ops.iter().filter(|op| admits(grade, op)).cloned().collect()
}

fn admits(grade: TranscriptGrade, op: &TranscriptOperation) -> bool {
    match op {
        TranscriptOperation::Append { .. } => grade.rank() >= TranscriptGrade::Delta.rank(),
        TranscriptOperation::StepUpsert { .. } | TranscriptOperation::FrameUpsert { .. } => {
            grade.rank() >= TranscriptGrade::Block.rank()
        }
        _ => true,
    }
}

pub fn redact_snapshot_for_grade(
    grade: TranscriptGrade,
    mut snapshot: AgentTranscriptSnapshot,
) -> AgentTranscriptSnapshot {
    if grade.rank() >= TranscriptGrade::Block.rank() {
        return snapshot;
    }
    for item in &mut snapshot.items {
        if let TranscriptItem::Turn(turn) = item {
            turn.steps.clear();
        }
    }
    snapshot
}
