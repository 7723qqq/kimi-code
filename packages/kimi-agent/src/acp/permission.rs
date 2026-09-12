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
use crate::acp::types::AcpClientCapabilities;
use crate::callbacks::HostCallbacks;
use crate::rpc::types::{
    AskQuestionRequest, AskQuestionResponse, BoxFuture, LlmChatRequest, LlmChatResponse,
    PermissionCheckRequest, PermissionDecision, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::tools::ask_user_question::QUESTION_DISMISSED_MESSAGE;

/// Canonical option ids (v2 `approval.ts:8-10`).
pub const APPROVE_ONCE_OPTION_ID: &str = "approve_once";
pub const APPROVE_ALWAYS_OPTION_ID: &str = "approve_always";
pub const REJECT_OPTION_ID: &str = "reject";

fn tool_ok(content: String) -> ToolExecuteResponse {
    ToolExecuteResponse {
        delivery: None,
        stop_turn: false,
        content,
        is_error: false,
        note: None,
    }
}

fn tool_error(content: String) -> ToolExecuteResponse {
    ToolExecuteResponse {
        delivery: None,
        stop_turn: false,
        content,
        is_error: true,
        note: None,
    }
}

fn answered_question_response(answers: serde_json::Value) -> AskQuestionResponse {
    let answers = answers
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    AskQuestionResponse {
        answers,
        method: Some("enter".into()),
        note: None,
        cancelled: None,
        reason: None,
    }
}

fn dismissed_question_response() -> AskQuestionResponse {
    AskQuestionResponse {
        answers: std::collections::HashMap::new(),
        method: None,
        note: Some(QUESTION_DISMISSED_MESSAGE.to_string()),
        cancelled: None,
        reason: None,
    }
}

/// Run a Bash call on the client's terminal (`terminal/create` →
/// `wait_for_exit` → `output` → `release`). Falls back to the native Bash when
/// the client advertised a terminal but could not create one.
async fn run_bash_on_terminal(
    channel: AcpChannel,
    session_id: String,
    inner: Arc<dyn HostCallbacks>,
    fallback: ToolExecuteRequest,
    command: String,
) -> Result<ToolExecuteResponse, String> {
    #[cfg(windows)]
    let (shell, flag) = ("cmd", "/C");
    #[cfg(not(windows))]
    let (shell, flag) = ("sh", "-c");

    let terminal_id = match channel
        .create_terminal(
            &session_id,
            shell,
            &[flag.to_string(), command.clone()],
            None,
        )
        .await
    {
        Ok(id) => id,
        Err(_) => return inner.execute_tool(fallback).await,
    };

    let exit = channel
        .wait_for_terminal_exit(&session_id, &terminal_id)
        .await;
    let output = channel
        .terminal_output(&session_id, &terminal_id)
        .await
        .unwrap_or_default();
    let _ = channel.release_terminal(&session_id, &terminal_id).await;

    let exit_code = exit
        .ok()
        .and_then(|value| value.get("exitCode").and_then(serde_json::Value::as_i64));
    Ok(ToolExecuteResponse {
        delivery: None,
        stop_turn: false,
        content: output,
        is_error: exit_code.is_some_and(|code| code != 0),
        note: None,
    })
}

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
    /// The client's declared capabilities; drives whether the client owns
    /// Read/Write execution (fs reverse RPC) instead of the native sandbox.
    capabilities: Arc<std::sync::Mutex<AcpClientCapabilities>>,
}

impl AcpPermissionHost {
    pub fn new(
        inner: Arc<dyn HostCallbacks>,
        channel: AcpChannel,
        session_id: String,
        capabilities: Arc<std::sync::Mutex<AcpClientCapabilities>>,
    ) -> Self {
        Self {
            inner,
            channel,
            session_id,
            approved_tools: Arc::new(Mutex::new(HashSet::new())),
            capabilities,
        }
    }

    fn capabilities(&self) -> AcpClientCapabilities {
        self.capabilities
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn session_approved(&self, tool_name: &str) -> bool {
        self.approved_tools
            .lock()
            .map(|approved| approved.contains(tool_name))
            .unwrap_or(false)
    }

    // `remember_session_approval` deliberately does not exist as a method:
    // `check_permission` records the approval inside its `async move` closure
    // (the shared `approved_tools` handle is cloned in, since `self` cannot
    // cross the spawn boundary).
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
        let tool = request.tool_name.to_ascii_lowercase();
        if !self.owns_tool(&request.tool_name) {
            return self.inner.execute_tool(request);
        }
        let channel = self.channel.clone();
        let session_id = self.session_id.clone();
        let inner = self.inner.clone();
        if tool == "bash" {
            let fallback = request.clone();
            let command = request
                .arguments
                .get("command")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            return Box::pin(async move {
                run_bash_on_terminal(channel, session_id, inner, fallback, command).await
            });
        }
        let write = tool == "write";
        let path = request
            .arguments
            .get("path")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let content = request
            .arguments
            .get("content")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        Box::pin(async move {
            let Some(path) = path else {
                return Ok(tool_error(
                    "this tool requires a `path` argument".to_string(),
                ));
            };
            if write {
                match channel.write_text_file(&session_id, &path, &content).await {
                    Ok(()) => Ok(tool_ok(format!("Wrote {path}"))),
                    Err(error) => Ok(tool_error(error)),
                }
            } else {
                match channel.read_text_file(&session_id, &path).await {
                    Ok(text) => Ok(tool_ok(text)),
                    Err(error) => Ok(tool_error(error)),
                }
            }
        })
    }

    fn owns_tool(&self, tool_name: &str) -> bool {
        let capabilities = self.capabilities();
        match tool_name.to_ascii_lowercase().as_str() {
            "read" => capabilities.fs.read_text_file,
            "write" => capabilities.fs.write_text_file,
            "bash" => capabilities.terminal,
            _ => false,
        }
    }

    /// Bridge an `AskUserQuestion` request to the ACP client: `elicitation/create`
    /// (form mode) when the client advertises it, else the
    /// `session/request_permission` single-select bridge. Any failure resolves
    /// to the engine's canonical "user dismissed" response (v2
    /// `interaction-bridge.ts` `handleQuestion`).
    fn ask_question(
        &self,
        request: AskQuestionRequest,
    ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
        let channel = self.channel.clone();
        let session_id = self.session_id.clone();
        let elicitation_form = self.capabilities().elicitation.form;
        Box::pin(async move {
            if request.questions.is_empty() {
                return Ok(dismissed_question_response());
            }
            let tool_call_id = if request.tool_call_id.is_empty() {
                "ask-user".to_string()
            } else {
                request.tool_call_id.clone()
            };

            if elicitation_form {
                let params = crate::acp::question::question_request_to_elicitation_params(
                    &request.questions,
                    &session_id,
                    &tool_call_id,
                );
                if let Ok(response) = channel.request("elicitation/create", params).await {
                    return Ok(
                        match crate::acp::question::elicitation_response_to_question_answers(
                            &request.questions,
                            &response,
                        ) {
                            Some(answers) => answered_question_response(answers),
                            None => dismissed_question_response(),
                        },
                    );
                }
                // Fall through to the request_permission bridge.
            }

            let question = &request.questions[0];
            let params = json!({
                "sessionId": session_id,
                "options": crate::acp::question::question_item_to_permission_options(question, 0),
                "toolCall": {
                    "toolCallId": tool_call_id,
                    "title": "AskUserQuestion",
                    "content": [{
                        "type": "content",
                        "content": { "type": "text", "text": question.question },
                    }],
                },
            });
            match channel.request("session/request_permission", params).await {
                Ok(response) => Ok(
                    match crate::acp::question::outcome_to_question_answer(question, &response) {
                        Some(answers) => answered_question_response(answers),
                        None => dismissed_question_response(),
                    },
                ),
                Err(_) => Ok(dismissed_question_response()),
            }
        })
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
        let selected =
            |option: &str| json!({ "outcome": { "outcome": "selected", "optionId": option } });
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
            Arc::new(std::sync::Mutex::new(AcpClientCapabilities::default())),
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
            Arc::new(std::sync::Mutex::new(AcpClientCapabilities::default())),
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

    #[tokio::test]
    async fn fs_capabilities_route_read_and_write_through_the_client() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let capabilities = Arc::new(std::sync::Mutex::new(AcpClientCapabilities {
            fs: crate::acp::types::AcpFsCapabilities {
                read_text_file: true,
                write_text_file: true,
            },
            ..Default::default()
        }));
        let host = Arc::new(AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            channel.clone(),
            "sess-fs".into(),
            capabilities,
        ));

        assert!(host.owns_tool("Read"));
        assert!(host.owns_tool("write"));
        assert!(!host.owns_tool("Bash"), "only fs tools are host-owned");

        // Read: the client answers fs/read_text_file.
        let pending = {
            let host = host.clone();
            tokio::spawn(async move {
                host.execute_tool(ToolExecuteRequest {
                    turn_id: "t1".into(),
                    tool_call_id: "c1".into(),
                    tool_name: "Read".into(),
                    arguments: json!({ "path": "src/a.txt" }),
                })
                .await
            })
        };
        let id = match rx.recv().await.expect("one fs request") {
            crate::acp::channel::AcpOutbound::Request(request) => {
                assert_eq!(request.method, "fs/read_text_file");
                assert_eq!(request.params.as_ref().unwrap()["path"], "src/a.txt");
                request.id.unwrap().as_u64().unwrap()
            }
            other => panic!("unexpected outbound: {other:?}"),
        };
        channel.resolve(id, json!({ "content": "file body" })).await;
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.content, "file body");
        assert!(!response.is_error);

        // Write: the client answers fs/write_text_file.
        let pending = {
            let host = host.clone();
            tokio::spawn(async move {
                host.execute_tool(ToolExecuteRequest {
                    turn_id: "t1".into(),
                    tool_call_id: "c2".into(),
                    tool_name: "Write".into(),
                    arguments: json!({ "path": "src/a.txt", "content": "new" }),
                })
                .await
            })
        };
        let id = match rx.recv().await.expect("one fs request") {
            crate::acp::channel::AcpOutbound::Request(request) => {
                assert_eq!(request.method, "fs/write_text_file");
                assert_eq!(request.params.as_ref().unwrap()["content"], "new");
                request.id.unwrap().as_u64().unwrap()
            }
            other => panic!("unexpected outbound: {other:?}"),
        };
        channel.resolve(id, json!({})).await;
        let response = pending.await.unwrap().unwrap();
        assert!(!response.is_error);
        assert!(response.content.contains("src/a.txt"));
    }

    #[test]
    fn without_fs_capabilities_the_native_tools_stay_engine_owned() {
        let host = AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            AcpChannel::new(),
            "sess-native".into(),
            Arc::new(std::sync::Mutex::new(AcpClientCapabilities::default())),
        );
        assert!(!host.owns_tool("Read"));
        assert!(!host.owns_tool("Write"));
        assert!(!host.owns_tool("Bash"));
    }

    #[tokio::test]
    async fn terminal_capability_routes_bash_through_the_client() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let capabilities = Arc::new(std::sync::Mutex::new(AcpClientCapabilities {
            fs: Default::default(),
            terminal: true,
            ..Default::default()
        }));
        let host = Arc::new(AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            channel.clone(),
            "sess-term".into(),
            capabilities,
        ));
        assert!(host.owns_tool("Bash"));

        let pending = {
            let host = host.clone();
            tokio::spawn(async move {
                host.execute_tool(ToolExecuteRequest {
                    turn_id: "t".into(),
                    tool_call_id: "c".into(),
                    tool_name: "Bash".into(),
                    arguments: json!({ "command": "echo hi" }),
                })
                .await
            })
        };

        let mut methods = Vec::new();
        for answer in [
            json!({ "terminalId": "term-1" }),
            json!({ "exitCode": 0 }),
            json!({ "output": "hi\n" }),
            json!({}),
        ] {
            let id = match rx.recv().await.expect("a terminal request") {
                crate::acp::channel::AcpOutbound::Request(request) => {
                    methods.push(request.method.clone());
                    request.id.unwrap().as_u64().unwrap()
                }
                other => panic!("unexpected outbound: {other:?}"),
            };
            channel.resolve(id, answer).await;
        }
        assert_eq!(
            methods,
            vec![
                "terminal/create",
                "terminal/wait_for_exit",
                "terminal/output",
                "terminal/release",
            ]
        );

        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.content, "hi\n");
        assert!(!response.is_error);
    }

    fn ask_question_request() -> AskQuestionRequest {
        AskQuestionRequest {
            question_id: "qid".into(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            background: false,
            timeout_ms: None,
            questions: vec![crate::rpc::types::AskQuestionItem {
                question: "Which approach?".into(),
                header: Some("Approach".into()),
                options: vec![
                    crate::rpc::types::AskQuestionOption {
                        label: "Fast".into(),
                        description: None,
                    },
                    crate::rpc::types::AskQuestionOption {
                        label: "Safe".into(),
                        description: None,
                    },
                ],
                multi_select: false,
            }],
        }
    }

    #[tokio::test]
    async fn elicitation_form_bridges_questions_to_the_client() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let capabilities = Arc::new(std::sync::Mutex::new(AcpClientCapabilities {
            elicitation: crate::acp::types::AcpElicitationCapabilities { form: true },
            ..Default::default()
        }));
        let host = Arc::new(AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            channel.clone(),
            "sess-q".into(),
            capabilities,
        ));

        let pending = {
            let host = host.clone();
            tokio::spawn(async move { host.ask_question(ask_question_request()).await })
        };
        let id = match rx.recv().await.expect("one elicitation request") {
            crate::acp::channel::AcpOutbound::Request(request) => {
                assert_eq!(request.method, "elicitation/create");
                assert_eq!(request.params.as_ref().unwrap()["mode"], "form");
                request.id.unwrap().as_u64().unwrap()
            }
            other => panic!("unexpected outbound: {other:?}"),
        };
        channel
            .resolve(
                id,
                json!({ "action": "accept", "content": { "q0": "Fast" } }),
            )
            .await;
        let response = pending.await.unwrap().unwrap();
        assert_eq!(
            response.answers.get("Which approach?"),
            Some(&"Fast".to_string())
        );
    }

    #[tokio::test]
    async fn without_elicitation_questions_use_request_permission() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let capabilities = Arc::new(std::sync::Mutex::new(AcpClientCapabilities::default()));
        let host = Arc::new(AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            channel.clone(),
            "sess-q2".into(),
            capabilities,
        ));

        let pending = {
            let host = host.clone();
            tokio::spawn(async move { host.ask_question(ask_question_request()).await })
        };
        let id = match rx.recv().await.expect("one permission request") {
            crate::acp::channel::AcpOutbound::Request(request) => {
                assert_eq!(request.method, "session/request_permission");
                let params = request.params.as_ref().unwrap();
                assert_eq!(params["toolCall"]["title"], "AskUserQuestion");
                assert_eq!(params["options"][0]["optionId"], "q0_opt_0");
                request.id.unwrap().as_u64().unwrap()
            }
            other => panic!("unexpected outbound: {other:?}"),
        };
        channel
            .resolve(
                id,
                json!({ "outcome": { "outcome": "selected", "optionId": "q0_opt_1" } }),
            )
            .await;
        let response = pending.await.unwrap().unwrap();
        assert_eq!(
            response.answers.get("Which approach?"),
            Some(&"Safe".to_string())
        );

        // A dismissed question resolves to the engine's canonical note.
        let pending = {
            let host = host.clone();
            tokio::spawn(async move { host.ask_question(ask_question_request()).await })
        };
        let id = match rx.recv().await.expect("one permission request") {
            crate::acp::channel::AcpOutbound::Request(request) => {
                request.id.unwrap().as_u64().unwrap()
            }
            other => panic!("unexpected outbound: {other:?}"),
        };
        channel
            .resolve(id, json!({ "outcome": { "outcome": "cancelled" } }))
            .await;
        let response = pending.await.unwrap().unwrap();
        assert!(response.answers.is_empty());
        assert_eq!(
            response.note.as_deref(),
            Some("User dismissed the question without answering.")
        );
    }
}
