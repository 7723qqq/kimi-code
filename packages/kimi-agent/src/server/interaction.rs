//! In-memory interaction manager for interactive questions and tool execution
//! approvals in the standalone HTTP/WS server.
//!
//! Mirrors kap-server's `ISessionQuestionService` and `ISessionApprovalService`,
//! bridging async engine callbacks to HTTP REST endpoints and WebSocket events.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::rpc::types::{
    AskQuestionItem, AskQuestionRequest, AskQuestionResponse, PermissionCheckRequest,
    PermissionDecision,
};

struct ActiveQuestion {
    session_id: String,
    turn_id: String,
    tool_call_id: String,
    questions: Vec<AskQuestionItem>,
    created_at_iso: String,
    tx: oneshot::Sender<AskQuestionResponse>,
}

struct ActiveApproval {
    session_id: String,
    tool_name: String,
    tool_call_id: String,
    arguments: Value,
    action: String,
    created_at_iso: String,
    tx: oneshot::Sender<PermissionDecision>,
}

/// Thread-safe manager for pending interactions within active sessions.
#[derive(Default)]
pub struct InteractionManager {
    questions: Mutex<HashMap<String, ActiveQuestion>>,
    approvals: Mutex<HashMap<String, ActiveApproval>>,
    hub: Mutex<Option<Arc<crate::server::hub::EventHub>>>,
}

impl InteractionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_hub(self, hub: Arc<crate::server::hub::EventHub>) -> Self {
        *self.hub.lock().unwrap() = Some(hub);
        self
    }

    pub fn set_hub(&self, hub: Arc<crate::server::hub::EventHub>) {
        *self.hub.lock().unwrap() = Some(hub);
    }

    fn publish_event(&self, session_id: &str, event: crate::events::EngineEvent) {
        let lock = self.hub.lock().unwrap();
        if let Some(hub) = lock.as_ref() {
            hub.bus_for(session_id).publish(&event);
        }
    }

    /// Register a pending interactive question from the engine turn loop.
    pub fn register_question(
        &self,
        session_id: &str,
        req: AskQuestionRequest,
    ) -> oneshot::Receiver<AskQuestionResponse> {
        let (tx, rx) = oneshot::channel();
        let qid = req.question_id.clone();
        let now_iso = chrono::Utc::now().to_rfc3339();

        let active = ActiveQuestion {
            session_id: session_id.to_string(),
            turn_id: req.turn_id.clone(),
            tool_call_id: req.tool_call_id.clone(),
            questions: req.questions,
            created_at_iso: now_iso.clone(),
            tx,
        };

        {
            let mut lock = self.questions.lock().unwrap();
            lock.insert(qid.clone(), active);
        }

        self.publish_event(
            session_id,
            crate::events::EngineEvent::Custom(json!({
                "type": "question.asked",
                "questionId": qid,
                "sessionId": session_id,
                "turnId": req.turn_id,
                "toolCallId": req.tool_call_id,
                "createdAt": now_iso,
            })),
        );
        self.publish_event(
            session_id,
            crate::events::EngineEvent::SessionStatusChanged {
                status: "awaiting_question".into(),
                previous_status: "running".into(),
            },
        );

        rx
    }

    /// List all currently pending questions for a session.
    pub fn list_questions(&self, session_id: &str) -> Vec<Value> {
        let lock = self.questions.lock().unwrap();
        let mut items = Vec::new();
        for (qid, q) in lock.iter() {
            if q.session_id == session_id {
                let wire_questions: Vec<Value> = q
                    .questions
                    .iter()
                    .enumerate()
                    .map(|(idx, item)| {
                        let options: Vec<Value> = item
                            .options
                            .iter()
                            .enumerate()
                            .map(|(oidx, opt)| {
                                json!({
                                    "id": format!("opt_{oidx}"),
                                    "label": opt.label,
                                    "description": opt.description,
                                })
                            })
                            .collect();
                        json!({
                            "id": format!("q_{idx}"),
                            "question": item.question,
                            "header": item.header,
                            "options": options,
                            "multi_select": item.multi_select,
                        })
                    })
                    .collect();

                items.push(json!({
                    "question_id": qid,
                    "session_id": q.session_id,
                    "turn_id": q.turn_id,
                    "tool_call_id": q.tool_call_id,
                    "questions": wire_questions,
                    "created_at": q.created_at_iso,
                }));
            }
        }
        items.sort_by(|a, b| {
            a["created_at"]
                .as_str()
                .unwrap_or_default()
                .cmp(b["created_at"].as_str().unwrap_or_default())
        });
        items
    }

    /// Resolve a pending question with human answers.
    pub fn resolve_question(
        &self,
        question_id: &str,
        answers: HashMap<String, String>,
        method: Option<String>,
    ) -> bool {
        let active = {
            let mut lock = self.questions.lock().unwrap();
            lock.remove(question_id)
        };
        if let Some(q) = active {
            let resp = AskQuestionResponse {
                answers,
                method: method.or_else(|| Some("click".into())),
                note: None,
                cancelled: None,
                reason: None,
            };
            self.publish_event(
                &q.session_id,
                crate::events::EngineEvent::Custom(json!({
                    "type": "question.resolved",
                    "questionId": question_id,
                    "sessionId": q.session_id,
                    "method": resp.method,
                })),
            );
            self.publish_event(
                &q.session_id,
                crate::events::EngineEvent::SessionStatusChanged {
                    status: "running".into(),
                    previous_status: "awaiting_question".into(),
                },
            );
            let _ = q.tx.send(resp);
            true
        } else {
            false
        }
    }

    /// Dismiss a pending question without answering.
    pub fn dismiss_question(&self, question_id: &str) -> bool {
        let active = {
            let mut lock = self.questions.lock().unwrap();
            lock.remove(question_id)
        };
        if let Some(q) = active {
            let resp = AskQuestionResponse {
                answers: HashMap::new(),
                method: None,
                note: Some("User dismissed the question without answering.".into()),
                cancelled: None,
                reason: None,
            };
            self.publish_event(
                &q.session_id,
                crate::events::EngineEvent::Custom(json!({
                    "type": "question.dismissed",
                    "questionId": question_id,
                    "sessionId": q.session_id,
                    "note": resp.note,
                })),
            );
            self.publish_event(
                &q.session_id,
                crate::events::EngineEvent::SessionStatusChanged {
                    status: "running".into(),
                    previous_status: "awaiting_question".into(),
                },
            );
            let _ = q.tx.send(resp);
            true
        } else {
            false
        }
    }

    /// Register a pending permission approval request.
    pub fn register_approval(
        &self,
        session_id: &str,
        req: PermissionCheckRequest,
        action: &str,
    ) -> (String, oneshot::Receiver<PermissionDecision>) {
        let (tx, rx) = oneshot::channel();
        let approval_id = format!("appr_{}", fastrand::u64(..));
        let now_iso = chrono::Utc::now().to_rfc3339();

        let active = ActiveApproval {
            session_id: session_id.to_string(),
            tool_name: req.tool_name.clone(),
            tool_call_id: req.tool_call_id.clone(),
            arguments: req.arguments.clone(),
            action: action.to_string(),
            created_at_iso: now_iso.clone(),
            tx,
        };

        {
            let mut lock = self.approvals.lock().unwrap();
            lock.insert(approval_id.clone(), active);
        }

        self.publish_event(
            session_id,
            crate::events::EngineEvent::Custom(json!({
                "type": "approval.requested",
                "approvalId": approval_id,
                "sessionId": session_id,
                "toolName": req.tool_name,
                "toolCallId": req.tool_call_id,
                "action": action,
                "arguments": req.arguments,
                "createdAt": now_iso,
            })),
        );
        self.publish_event(
            session_id,
            crate::events::EngineEvent::SessionStatusChanged {
                status: "awaiting_approval".into(),
                previous_status: "running".into(),
            },
        );

        (approval_id, rx)
    }

    /// List all currently pending tool approvals for a session.
    pub fn list_approvals(&self, session_id: &str) -> Vec<Value> {
        let lock = self.approvals.lock().unwrap();
        let mut items = Vec::new();
        for (aid, a) in lock.iter() {
            if a.session_id == session_id {
                items.push(json!({
                    "approval_id": aid,
                    "session_id": a.session_id,
                    "tool_name": a.tool_name,
                    "tool_call_id": a.tool_call_id,
                    "action": a.action,
                    "tool_input_display": a.arguments,
                    "created_at": a.created_at_iso,
                }));
            }
        }
        items.sort_by(|a, b| {
            a["created_at"]
                .as_str()
                .unwrap_or_default()
                .cmp(b["created_at"].as_str().unwrap_or_default())
        });
        items
    }

    /// Resolve a pending tool approval (approved or rejected).
    pub fn resolve_approval(
        &self,
        approval_id: &str,
        allowed: bool,
        reason: Option<String>,
    ) -> bool {
        let active = {
            let mut lock = self.approvals.lock().unwrap();
            lock.remove(approval_id)
        };
        if let Some(a) = active {
            let decision = if allowed {
                PermissionDecision::allow()
            } else {
                PermissionDecision::deny(
                    reason.unwrap_or_else(|| "User denied tool execution".into()),
                )
            };
            self.publish_event(
                &a.session_id,
                crate::events::EngineEvent::Custom(json!({
                    "type": "approval.resolved",
                    "approvalId": approval_id,
                    "sessionId": a.session_id,
                    "allowed": allowed,
                    "decision": decision.decision,
                    "reason": decision.reason,
                })),
            );
            self.publish_event(
                &a.session_id,
                crate::events::EngineEvent::SessionStatusChanged {
                    status: "running".into(),
                    previous_status: "awaiting_approval".into(),
                },
            );
            let _ = a.tx.send(decision);
            true
        } else {
            false
        }
    }

    /// Cancel all pending interactions when a session is aborted, deleted, or turns complete.
    pub fn cancel_session(&self, session_id: &str) {
        let mut q_lock = self.questions.lock().unwrap();
        let to_remove_q: Vec<String> = q_lock
            .iter()
            .filter(|(_, q)| q.session_id == session_id)
            .map(|(qid, _)| qid.clone())
            .collect();
        for qid in to_remove_q {
            if let Some(q) = q_lock.remove(&qid) {
                let _ = q.tx.send(AskQuestionResponse {
                    answers: HashMap::new(),
                    method: None,
                    note: None,
                    cancelled: Some(true),
                    reason: Some("session_aborted".into()),
                });
            }
        }

        let mut a_lock = self.approvals.lock().unwrap();
        let to_remove_a: Vec<String> = a_lock
            .iter()
            .filter(|(_, a)| a.session_id == session_id)
            .map(|(aid, _)| aid.clone())
            .collect();
        for aid in to_remove_a {
            if let Some(a) = a_lock.remove(&aid) {
                let _ = a.tx.send(PermissionDecision::deny("Session aborted"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::AskQuestionOption;

    #[tokio::test]
    async fn test_question_registration_and_resolution() {
        let manager = InteractionManager::new();
        let req = AskQuestionRequest {
            question_id: "q_test_1".into(),
            turn_id: "turn-1".into(),
            tool_call_id: "call_abc".into(),
            background: false,
            timeout_ms: None,
            questions: vec![AskQuestionItem {
                question: "Choose flavor?".into(),
                header: Some("Flavor".into()),
                options: vec![
                    AskQuestionOption {
                        label: "Vanilla".into(),
                        description: None,
                    },
                    AskQuestionOption {
                        label: "Chocolate".into(),
                        description: None,
                    },
                ],
                multi_select: false,
            }],
        };

        let mut rx = manager.register_question("sess-1", req);
        let list = manager.list_questions("sess-1");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["question_id"], "q_test_1");
        assert_eq!(list[0]["session_id"], "sess-1");
        assert_eq!(list[0]["turn_id"], "turn-1");
        assert_eq!(list[0]["tool_call_id"], "call_abc");
        assert_eq!(list[0]["questions"][0]["question"], "Choose flavor?");
        assert_eq!(list[0]["questions"][0]["options"][0]["label"], "Vanilla");
        assert_eq!(list[0]["questions"][0]["options"][1]["label"], "Chocolate");

        // Resolving non-existent question returns false
        assert!(!manager.resolve_question("q_non_existent", HashMap::new(), None));

        let mut answers = HashMap::new();
        answers.insert("Choose flavor?".into(), "Chocolate".into());

        let resolved = manager.resolve_question("q_test_1", answers, Some("click".into()));
        assert!(resolved);

        let resp = rx.try_recv().unwrap();
        assert_eq!(resp.answers.get("Choose flavor?").unwrap(), "Chocolate");
        assert_eq!(resp.method.as_deref(), Some("click"));
        assert!(resp.cancelled.is_none());

        // After resolving, list is empty
        assert!(manager.list_questions("sess-1").is_empty());
    }

    #[tokio::test]
    async fn test_question_dismissal() {
        let hub = Arc::new(crate::server::hub::EventHub::new());
        let manager = InteractionManager::new().with_hub(hub.clone());
        let mut sub = hub.attach();

        let req = AskQuestionRequest {
            question_id: "q_to_dismiss".into(),
            turn_id: "turn-d".into(),
            tool_call_id: "call_d".into(),
            background: false,
            timeout_ms: None,
            questions: vec![],
        };
        let mut rx = manager.register_question("sess-d", req);

        // Consume registration events
        let _ = sub.recv().await.unwrap();
        let _ = sub.recv().await.unwrap();

        // Dismiss non-existent returns false
        assert!(!manager.dismiss_question("q_non_existent"));

        // Dismiss existing question
        assert!(manager.dismiss_question("q_to_dismiss"));
        let resp = rx.try_recv().unwrap();
        assert!(resp.answers.is_empty());
        assert_eq!(
            resp.note.as_deref(),
            Some("User dismissed the question without answering.")
        );

        // Verify dismissal event broadcast
        let ev_dismissed = sub.recv().await.unwrap();
        assert_eq!(ev_dismissed.event.event_type(), "question.dismissed");
        assert_eq!(ev_dismissed.event.to_json()["type"], "question.dismissed");
        assert_eq!(
            ev_dismissed.event.to_json()["note"],
            "User dismissed the question without answering."
        );

        let ev_status = sub.recv().await.unwrap();
        assert_eq!(ev_status.event.event_type(), "event.session.status_changed");

        assert!(manager.list_questions("sess-d").is_empty());
    }

    #[tokio::test]
    async fn test_approval_registration_and_allow_and_deny() {
        let manager = InteractionManager::new();

        // 1. Approval: allowed = true
        let req_allow = PermissionCheckRequest {
            tool_name: "Read".into(),
            tool_call_id: "call_read_1".into(),
            arguments: json!({ "path": "/tmp/safe.txt" }),
        };
        let (aid_allow, mut rx_allow) =
            manager.register_approval("sess-appr", req_allow, "read file contents");
        let list = manager.list_approvals("sess-appr");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["approval_id"], aid_allow);
        assert_eq!(list[0]["tool_name"], "Read");
        assert_eq!(list[0]["action"], "read file contents");
        assert_eq!(list[0]["tool_input_display"]["path"], "/tmp/safe.txt");

        assert!(manager.resolve_approval(&aid_allow, true, None));
        let decision_allow = rx_allow.try_recv().unwrap();
        assert!(decision_allow.is_allow());
        assert_eq!(decision_allow.decision, "allow");

        // 2. Approval: allowed = false (deny with reason)
        let req_deny = PermissionCheckRequest {
            tool_name: "Bash".into(),
            tool_call_id: "call_cmd".into(),
            arguments: json!({ "command": "rm -rf /tmp/foo" }),
        };
        let (aid_deny, mut rx_deny) =
            manager.register_approval("sess-appr", req_deny, "execute bash command");

        // Resolving non-existent approval returns false
        assert!(!manager.resolve_approval("appr_non_existent", true, None));

        assert!(manager.resolve_approval(&aid_deny, false, Some("Forbidden by policy".into())));
        let decision_deny = rx_deny.try_recv().unwrap();
        assert!(!decision_deny.is_allow());
        assert_eq!(decision_deny.decision, "deny");
        assert_eq!(decision_deny.reason.as_deref(), Some("Forbidden by policy"));

        assert!(manager.list_approvals("sess-appr").is_empty());
    }

    #[tokio::test]
    async fn test_cancel_session_interaction_isolation() {
        let manager = InteractionManager::new();

        // Register in session A
        let q_a = AskQuestionRequest {
            question_id: "q_sess_a".into(),
            turn_id: "t_a".into(),
            tool_call_id: "c_a".into(),
            background: false,
            timeout_ms: None,
            questions: vec![],
        };
        let mut rx_q_a = manager.register_question("sess-A", q_a);

        let appr_a = PermissionCheckRequest {
            tool_name: "Bash".into(),
            tool_call_id: "c_appr_a".into(),
            arguments: json!({}),
        };
        let (_aid_a, mut rx_appr_a) = manager.register_approval("sess-A", appr_a, "action A");

        // Register in session B
        let q_b = AskQuestionRequest {
            question_id: "q_sess_b".into(),
            turn_id: "t_b".into(),
            tool_call_id: "c_b".into(),
            background: false,
            timeout_ms: None,
            questions: vec![],
        };
        let mut rx_q_b = manager.register_question("sess-B", q_b);

        let appr_b = PermissionCheckRequest {
            tool_name: "Bash".into(),
            tool_call_id: "c_appr_b".into(),
            arguments: json!({}),
        };
        let (_aid_b, mut rx_appr_b) = manager.register_approval("sess-B", appr_b, "action B");

        // Cancel session A only
        manager.cancel_session("sess-A");

        // Session A question cancelled
        let resp_a = rx_q_a.try_recv().unwrap();
        assert_eq!(resp_a.cancelled, Some(true));
        assert_eq!(resp_a.reason.as_deref(), Some("session_aborted"));

        // Session A approval denied
        let decision_a = rx_appr_a.try_recv().unwrap();
        assert!(!decision_a.is_allow());
        assert_eq!(decision_a.reason.as_deref(), Some("Session aborted"));

        // Session B question and approval still active and untouched
        assert!(rx_q_b.try_recv().is_err());
        assert!(rx_appr_b.try_recv().is_err());
        assert_eq!(manager.list_questions("sess-B").len(), 1);
        assert_eq!(manager.list_approvals("sess-B").len(), 1);
        assert!(manager.list_questions("sess-A").is_empty());
        assert!(manager.list_approvals("sess-A").is_empty());
    }

    #[tokio::test]
    async fn test_interaction_broadcasts_events_to_event_hub() {
        let hub = Arc::new(crate::server::hub::EventHub::new());
        let manager = InteractionManager::new().with_hub(hub.clone());

        let mut sub = hub.attach();

        // 1. Register question -> broadcasts question.asked & awaiting_question
        let q_req = AskQuestionRequest {
            question_id: "q_hub_1".into(),
            turn_id: "turn-1".into(),
            tool_call_id: "call_hub".into(),
            background: false,
            timeout_ms: None,
            questions: vec![],
        };
        let _rx_q = manager.register_question("sess-hub", q_req);

        let ev1 = sub.recv().await.unwrap();
        assert_eq!(ev1.event.event_type(), "question.asked");
        assert_eq!(ev1.event.to_json()["type"], "question.asked");

        let ev2 = sub.recv().await.unwrap();
        assert_eq!(ev2.event.event_type(), "event.session.status_changed");

        // 2. Resolve question -> broadcasts question.resolved & running
        assert!(manager.resolve_question("q_hub_1", HashMap::new(), None));

        let ev3 = sub.recv().await.unwrap();
        assert_eq!(ev3.event.event_type(), "question.resolved");
        assert_eq!(ev3.event.to_json()["type"], "question.resolved");

        let ev4 = sub.recv().await.unwrap();
        assert_eq!(ev4.event.event_type(), "event.session.status_changed");
    }
}
