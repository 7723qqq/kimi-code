//! Engine → host turn lifecycle events (M1b: `host/turn_event`).
//!
//! Each variant serializes to exactly the payload of the matching v2 `Event2`
//! class, minus `agentId` — the host owns agent identity and stamps it in.
//! `turn.prompt` / `turn.cancel` / `turn.ended` are durable (the host appends
//! them to the log and folds them into `turnKey`); `turn.started` is
//! observable-only.
//!
//! Display fields (`prompt`, `promptAttachments`) are deliberately absent from
//! `turn.started`: v2 derives them from the prompt's `input` + `origin` via
//! `turnPromptText` / `turnPromptAttachments`, and the engine has no view of
//! skill-activation block packing or daemon file ids. The host derives them
//! from the same `input` it received, so the two engines cannot disagree.

use serde::{Deserialize, Serialize};

/// Why a turn ended. Mirrors v2 `TurnEndReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEndReason {
    Completed,
    Cancelled,
    Failed,
    Blocked,
}

/// Which side of the queue a cancellation hit. Mirrors v2 `TurnCancel.target`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnCancelTarget {
    Active,
    Queued,
}

/// Why a turn was cancelled. Mirrors v2 `TurnCancel.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnCancelReason {
    UserCancelled,
    Aborted,
}

/// One engine → host turn lifecycle event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TurnEvent {
    /// A turn has been claimed from the queue and is about to run. Durable:
    /// the host appends `turn.prompt` and advances its turn clock.
    #[serde(rename = "turn.prompt")]
    Prompt {
        #[serde(rename = "turnId")]
        turn_id: u64,
        /// The prompt as a `ContentPart[]` JSON array, echoed back verbatim
        /// from what the host handed the engine.
        input: serde_json::Value,
        /// `PromptOrigin` JSON, echoed back verbatim. The host maps it to its
        /// own origin type — the engine does not model origin variants.
        origin: serde_json::Value,
    },
    /// A turn's first step has begun. Observable only.
    #[serde(rename = "turn.started")]
    Started {
        #[serde(rename = "turnId")]
        turn_id: u64,
        origin: serde_json::Value,
    },
    /// An active or queued turn was cancelled. Durable. `turn_id = None`
    /// means "cancel whatever is active".
    #[serde(rename = "turn.cancel")]
    Cancel {
        #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
        turn_id: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<TurnCancelTarget>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<TurnCancelReason>,
    },
    /// A turn has finished. Durable.
    #[serde(rename = "turn.ended")]
    Ended {
        #[serde(rename = "turnId")]
        turn_id: u64,
        reason: TurnEndReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<serde_json::Value>,
        #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(event: &TurnEvent, expected: serde_json::Value) {
        let serialized = serde_json::to_value(event).unwrap();
        assert_eq!(serialized, expected, "wire shape drifted");
        let parsed: TurnEvent = serde_json::from_value(serialized).unwrap();
        assert_eq!(&parsed, event, "round trip lost information");
    }

    #[test]
    fn turn_prompt_wire_shape() {
        round_trip(
            &TurnEvent::Prompt {
                turn_id: 7,
                input: json!([{"type": "text", "text": "hello"}]),
                origin: json!({"kind": "user"}),
            },
            json!({
                "type": "turn.prompt",
                "turnId": 7,
                "input": [{"type": "text", "text": "hello"}],
                "origin": {"kind": "user"},
            }),
        );
    }

    #[test]
    fn turn_started_wire_shape() {
        round_trip(
            &TurnEvent::Started {
                turn_id: 7,
                origin: json!({"kind": "user"}),
            },
            json!({
                "type": "turn.started",
                "turnId": 7,
                "origin": {"kind": "user"},
            }),
        );
    }

    #[test]
    fn turn_cancel_wire_shapes() {
        round_trip(
            &TurnEvent::Cancel {
                turn_id: Some(3),
                target: Some(TurnCancelTarget::Queued),
                reason: Some(TurnCancelReason::UserCancelled),
            },
            json!({
                "type": "turn.cancel",
                "turnId": 3,
                "target": "queued",
                "reason": "user_cancelled",
            }),
        );
        round_trip(
            &TurnEvent::Cancel {
                turn_id: None,
                target: Some(TurnCancelTarget::Active),
                reason: Some(TurnCancelReason::Aborted),
            },
            json!({
                "type": "turn.cancel",
                "target": "active",
                "reason": "aborted",
            }),
        );
    }

    #[test]
    fn turn_ended_wire_shapes() {
        round_trip(
            &TurnEvent::Ended {
                turn_id: 7,
                reason: TurnEndReason::Completed,
                error: None,
                duration_ms: Some(1234),
            },
            json!({
                "type": "turn.ended",
                "turnId": 7,
                "reason": "completed",
                "durationMs": 1234,
            }),
        );
        round_trip(
            &TurnEvent::Ended {
                turn_id: 7,
                reason: TurnEndReason::Failed,
                error: Some(json!({"code": "provider_error"})),
                duration_ms: None,
            },
            json!({
                "type": "turn.ended",
                "turnId": 7,
                "reason": "failed",
                "error": {"code": "provider_error"},
            }),
        );
    }

    #[test]
    fn every_variant_carries_a_dotted_type_tag() {
        let events = vec![
            TurnEvent::Prompt {
                turn_id: 0,
                input: json!([]),
                origin: json!(null),
            },
            TurnEvent::Started {
                turn_id: 0,
                origin: json!(null),
            },
            TurnEvent::Cancel {
                turn_id: None,
                target: None,
                reason: None,
            },
            TurnEvent::Ended {
                turn_id: 0,
                reason: TurnEndReason::Blocked,
                error: None,
                duration_ms: None,
            },
        ];
        let types: Vec<String> = events
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            types,
            vec!["turn.prompt", "turn.started", "turn.cancel", "turn.ended",]
        );
    }
}
