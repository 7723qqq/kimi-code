//! ACP `session/request_permission` bridge.
//!
//! The engine's [`HostCallbacks::check_permission`] seam is answered by asking
//! the ACP client, mirroring v2 `packages/acp-server/src/approval.ts`: the
//! canonical option set, the `outcome` mapping, and the session-scoped
//! `approve_always` memory.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::acp::channel::AcpChannel;
use crate::acp::events_map::infer_tool_kind;
use crate::callbacks::HostCallbacks;
use crate::rpc::types::{
    BoxFuture, LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision,
    ToolExecuteRequest, ToolExecuteResponse,
};

/// Canonical option ids (v2 `approval.ts:8-10`).
pub const APPROVE_ONCE_OPTION_ID: &str = "approve_once";
pub const APPROVE_ALWAYS_OPTION_ID: &str = "approve_always";
pub const REJECT_OPTION_ID: &str = "reject";

/// The option set offered to the client: allow-once is the primary action,
/// allow-always the secondary, reject last (v2 `buildApprovalOptions`).
pub fn permission_options() -> Value {
    json!([
        { "optionId": APPROVE_ONCE_OPTION_ID, "name": "Approve once", "kind": "allow_once" },
        {
            "optionId": APPROVE_ALWAYS_OPTION_ID,
            "name": "Approve for this session",
            "kind": "allow_always",
        },
        { "optionId": REJECT_OPTION_ID, "name": "Reject", "kind": "reject_once" },
    ])
}

/// Map an ACP `RequestPermissionResponse` onto the engine verdict
/// (v2 `approvalResponseToDecision`): a `cancelled` outcome or an unknown
/// option id rejects — rejecting is strictly safer than approving.
pub fn decision_from_response(response: &Value) -> PermissionDecision {
    let outcome = response.get("outcome").cloned().unwrap_or(Value::Null);
    let outcome_kind = outcome
        .get("outcome")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if outcome_kind == "cancelled" {
        return PermissionDecision::deny("cancelled by user");
    }
    match outcome
        .get("optionId")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
    {
        // The legacy Python kimi-cli ids map like their modern counterparts.
        APPROVE_ONCE_OPTION_ID | "approve" => PermissionDecision::allow(),
        APPROVE_ALWAYS_OPTION_ID | "approve_for_session" => PermissionDecision::allow(),
        _ => PermissionDecision::deny("rejected by user"),
    }
}

/// Whether the answer should be remembered for the rest of the session.
pub fn response_grants_session_scope(response: &Value) -> bool {
    matches!(
        response
            .get("outcome")
            .and_then(|outcome| outcome.get("optionId"))
            .and_then(|option| option.as_str()),
        Some(APPROVE_ALWAYS_OPTION_ID) | Some("approve_for_session")
    )
}

/// Host callbacks that answer permission checks through the ACP client and
/// delegate everything else to an inner host.
pub struct AcpPermissionHost {
    inner: Arc<dyn HostCallbacks>,
    channel: AcpChannel,
    session_id: String,
    /// Tools the user approved with `approve_always` in this session.
    approved_tools: Arc<Mutex<HashSet<String>>>,
}

impl AcpPermissionHost {
    pub fn new(inner: Arc<dyn HostCallbacks>, channel: AcpChannel, session_id: String) -> Self {
        Self {
            inner,
            channel,
            session_id,
            approved_tools: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn session_approved(&self, tool_name: &str) -> bool {
        self.approved_tools
            .lock()
            .map(|approved| approved.contains(tool_name))
            .unwrap_or(false)
    }

    fn remember_session_approval(&self, tool_name: &str) {
        if let Ok(mut approved) = self.approved_tools.lock() {
            approved.insert(tool_name.to_string());
        }
    }
}

impl HostCallbacks for AcpPermissionHost {
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        self.inner.execute_tool(request)
    }

    fn check_permission(
        &self,
        request: PermissionCheckRequest,
    ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
        if self.session_approved(&request.tool_name) {
            return Box::pin(async { Ok(PermissionDecision::allow()) });
        }

        let channel = self.channel.clone();
        let session_id = self.session_id.clone();
        let approved_tools = self.approved_tools.clone();
        Box::pin(async move {
            let tool_name = request.tool_name.clone();
            let params = json!({
                "sessionId": session_id,
                "toolCall": {
                    "toolCallId": request.tool_call_id,
                    "title": request.tool_name,
                    "kind": infer_tool_kind(&request.tool_name),
                    "status": "pending",
                    "rawInput": request.arguments,
                },
                "options": permission_options(),
            });
            let response = channel
                .request("session/request_permission", params)
                .await?;
            if response_grants_session_scope(&response)
                && let Ok(mut approved) = approved_tools.lock()
            {
                approved.insert(tool_name);
            }
            Ok(decision_from_response(&response))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_permission_options_match_v2() {
        assert_eq!(
            permission_options(),
            json!([
                { "optionId": "approve_once", "name": "Approve once", "kind": "allow_once" },
                {
                    "optionId": "approve_always",
                    "name": "Approve for this session",
                    "kind": "allow_always",
                },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
            ])
        );
    }

    #[test]
    fn test_decision_mapping() {
        let selected = |option: &str| json!({ "outcome": { "outcome": "selected", "optionId": option } });
        assert!(decision_from_response(&selected("approve_once")).is_allow());
        assert!(decision_from_response(&selected("approve_always")).is_allow());
        // Legacy python kimi-cli ids.
        assert!(decision_from_response(&selected("approve")).is_allow());
        assert!(decision_from_response(&selected("approve_for_session")).is_allow());
        assert!(!decision_from_response(&selected("reject")).is_allow());
        // Unknown ids reject defensively.
        assert!(!decision_from_response(&selected("plan_approve")).is_allow());
        let cancelled = json!({ "outcome": { "outcome": "cancelled" } });
        assert!(!decision_from_response(&cancelled).is_allow());
        assert_eq!(
            decision_from_response(&cancelled).reason.as_deref(),
            Some("cancelled by user")
        );
    }

    #[test]
    fn test_session_scope_only_for_approve_always() {
        assert!(response_grants_session_scope(
            &json!({ "outcome": { "outcome": "selected", "optionId": "approve_always" } })
        ));
        assert!(!response_grants_session_scope(
            &json!({ "outcome": { "outcome": "selected", "optionId": "approve_once" } })
        ));
        assert!(!response_grants_session_scope(
            &json!({ "outcome": { "outcome": "cancelled" } })
        ));
    }

    /// The bridge asks the client over the channel, maps the answer, and
    /// remembers `approve_always` for the rest of the session.
    #[tokio::test]
    async fn test_permission_bridge_round_trip() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);

        let host = Arc::new(AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            channel.clone(),
            "sess-1".into(),
        ));
        let request = PermissionCheckRequest {
            tool_name: "Write".into(),
            tool_call_id: "call_1".into(),
            arguments: json!({ "path": "a.txt" }),
        };

        // The check blocks on the client, so run it in a task and play the
        // client here.
        let pending = {
            let host = host.clone();
            let request = request.clone();
            tokio::spawn(async move { host.check_permission(request).await })
        };

        let outbound = rx.recv().await.expect("one permission request");
        let id = match outbound {
            crate::acp::channel::AcpOutbound::Request(acp_request) => {
                assert_eq!(acp_request.method, "session/request_permission");
                let params = acp_request.params.clone().expect("params");
                assert_eq!(params["sessionId"], "sess-1");
                assert_eq!(params["toolCall"]["title"], "Write");
                assert_eq!(params["toolCall"]["kind"], "edit");
                assert_eq!(params["toolCall"]["status"], "pending");
                assert_eq!(params["toolCall"]["rawInput"]["path"], "a.txt");
                assert_eq!(params["options"][0]["optionId"], APPROVE_ONCE_OPTION_ID);
                acp_request.id.as_ref().unwrap().as_u64().unwrap()
            }
            other => panic!("unexpected outbound message: {other:?}"),
        };
        assert!(channel
            .resolve(
                id,
                json!({ "outcome": { "outcome": "selected", "optionId": APPROVE_ALWAYS_OPTION_ID } })
            )
            .await);

        let decision = pending.await.unwrap().expect("decision");
        assert!(decision.is_allow());

        // `approve_always` covers later calls without prompting again.
        let second = host.check_permission(request).await.expect("decision");
        assert!(second.is_allow());
        assert!(
            rx.try_recv().is_err(),
            "a session-scoped approval must not prompt again"
        );
    }

    /// A cancelled outcome denies without remembering anything.
    #[tokio::test]
    async fn test_permission_bridge_cancelled_denies() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let host = Arc::new(AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            channel.clone(),
            "sess-1".into(),
        ));
        let request = PermissionCheckRequest {
            tool_name: "Bash".into(),
            tool_call_id: "call_2".into(),
            arguments: json!({ "command": "rm -rf /" }),
        };

        let pending = {
            let host = host.clone();
            let request = request.clone();
            tokio::spawn(async move { host.check_permission(request).await })
        };
        let id = match rx.recv().await.expect("one permission request") {
            crate::acp::channel::AcpOutbound::Request(acp_request) => {
                acp_request.id.as_ref().unwrap().as_u64().unwrap()
            }
            other => panic!("unexpected outbound message: {other:?}"),
        };
        channel
            .resolve(id, json!({ "outcome": { "outcome": "cancelled" } }))
            .await;

        let decision = pending.await.unwrap().expect("decision");
        assert!(!decision.is_allow());
        assert_eq!(decision.reason.as_deref(), Some("cancelled by user"));
    }
}
