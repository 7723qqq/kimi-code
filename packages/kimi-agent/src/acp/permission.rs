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
use crate::i18n::LocalizedText;
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

/// Cap on the output the client's terminal retains (v2 `OUTPUT_BYTE_LIMIT`,
/// acpTerminalRunner.ts:22).
const TERMINAL_OUTPUT_BYTE_LIMIT: usize = 4 * 1024 * 1024;
/// Foreground Bash budget, mirroring the native tool's own bounds
/// (`BASH_MAX_SECONDS` and the 60s default in `tools/mod.rs`).
const BASH_DEFAULT_TIMEOUT_S: u64 = 60;
const BASH_MAX_TIMEOUT_S: u64 = 300;

/// The environment the native Bash spawn sets (`tools/mod.rs`): colors and
/// prompts corrupt output parsing, and git must never hang on a credential
/// prompt. The client's terminal is a separate process tree, so these travel
/// with `terminal/create` instead of being inherited.
fn bash_terminal_env(shell: &str) -> Vec<(String, String)> {
    vec![
        ("NO_COLOR".to_string(), "1".to_string()),
        ("TERM".to_string(), "dumb".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("SHELL".to_string(), shell.to_string()),
    ]
}

/// Run a Bash call on the client's terminal (`terminal/create` →
/// `wait_for_exit` → `output` → `release`). Falls back to the native Bash when
/// the client advertised a terminal but could not create one.
async fn run_bash_on_terminal(
    channel: AcpChannel,
    session_id: String,
    session_cwd: String,
    inner: Arc<dyn HostCallbacks>,
    fallback: ToolExecuteRequest,
    command: String,
) -> Result<ToolExecuteResponse, String> {
    // The engine resolves the shell the same way the native Bash tool does
    // (`NativeToolset::new` falls back to `resolve_shell(None)`), so the
    // client's terminal runs the flavor this session is configured for
    // instead of a hardcoded `sh -c` / `cmd /C`.
    let shell = crate::native::shell::resolve_shell(None);
    let mut args = shell.args_prefix();
    args.push(command.clone());
    // The tool's own `cwd` wins; otherwise the command runs in the session's
    // working directory, not the client terminal's default one.
    let cwd = fallback
        .arguments
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| Some(session_cwd).filter(|value| !value.is_empty()));
    let timeout_s = fallback
        .arguments
        .get("timeout")
        .and_then(|value| value.as_u64())
        .unwrap_or(BASH_DEFAULT_TIMEOUT_S)
        .clamp(1, BASH_MAX_TIMEOUT_S);

    let terminal_id = match channel
        .create_terminal(
            &session_id,
            &shell.program,
            &args,
            cwd.as_deref(),
            &bash_terminal_env(&shell.program),
            TERMINAL_OUTPUT_BYTE_LIMIT,
        )
        .await
    {
        Ok(id) => id,
        Err(_) => return inner.execute_tool(fallback).await,
    };

    let exit = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_s),
        channel.wait_for_terminal_exit(&session_id, &terminal_id),
    )
    .await;
    let output = channel
        .terminal_output(&session_id, &terminal_id)
        .await
        .unwrap_or_default();
    let timed_out = exit.is_err();
    if timed_out {
        // A hung command has to be terminated, not merely abandoned: without
        // `terminal/kill` it keeps running in the client's terminal long after
        // the tool call has failed.
        let _ = channel.kill_terminal(&session_id, &terminal_id).await;
    }
    let _ = channel.release_terminal(&session_id, &terminal_id).await;

    if timed_out {
        return Ok(tool_error(format!(
            "Command killed by timeout ({timeout_s}s)"
        )));
    }
    let exit_code = exit
        .ok()
        .and_then(Result::ok)
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
///
/// The labels follow the host locale; the `optionId` / `kind` pairs stay fixed
/// because [`decision_from_response`] matches on them, so a translation can
/// never change which button a click resolves to.
pub fn permission_options() -> Value {
    json!([
        {
            "optionId": APPROVE_ONCE_OPTION_ID,
            "name": LocalizedText::plain("engine.permission.approveOnce", "Approve once").render(),
            "kind": "allow_once"
        },
        {
            "optionId": APPROVE_ALWAYS_OPTION_ID,
            "name": LocalizedText::plain(
                "engine.permission.approveForSession",
                "Approve for this session"
            )
            .render(),
            "kind": "allow_always"
        },
        {
            "optionId": REJECT_OPTION_ID,
            "name": LocalizedText::plain("engine.permission.reject", "Reject").render(),
            "kind": "reject_once"
        },
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
    /// The session's working directory, used as the reverse Bash path's cwd
    /// when the tool call does not name one.
    session_cwd: String,
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
        session_cwd: String,
    ) -> Self {
        Self {
            inner,
            channel,
            session_id,
            session_cwd,
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
        let session_cwd = self.session_cwd.clone();
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
                run_bash_on_terminal(channel, session_id, session_cwd, inner, fallback, command)
                    .await
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
            // v2 `buildPermissionToolCallUpdate`: the approval prompt names the
            // same `${turnId}:${rawId}` wire id the tool card was created
            // under, so the client attaches the prompt to that card. A request
            // without a turn id (an older host) falls back to the raw id.
            let tool_call_id = if request.turn_id.is_empty() {
                request.tool_call_id.clone()
            } else {
                crate::acp::events_map::acp_tool_call_id(&request.turn_id, &request.tool_call_id)
            };
            let params = json!({
                "sessionId": session_id,
                "toolCall": {
                    "toolCallId": tool_call_id,
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
            "/work".into(),
        ));
        let request = PermissionCheckRequest {
            tool_name: "Write".into(),
            tool_call_id: "call_1".into(),
            turn_id: "turn-1".into(),
            arguments: json!({ "path": "a.txt" }),
            reason: None,
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
                // v2 `buildPermissionToolCallUpdate`: the prompt names the same
                // `${turnId}:${rawId}` wire id the tool card was created under.
                assert_eq!(params["toolCall"]["toolCallId"], "turn-1:call_1");
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
                json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "selected", "optionId": APPROVE_ALWAYS_OPTION_ID } } })
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
            "/work".into(),
        ));
        let request = PermissionCheckRequest {
            tool_name: "Bash".into(),
            tool_call_id: "call_2".into(),
            turn_id: "turn-1".into(),
            arguments: json!({ "command": "rm -rf /" }),
            reason: None,
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
            .resolve(id, json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "cancelled" } } }))
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
            "/work".into(),
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
        channel
            .resolve(
                id,
                json!({ "jsonrpc": "2.0", "id": id, "result": { "content": "file body" } }),
            )
            .await;
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
        channel
            .resolve(id, json!({ "jsonrpc": "2.0", "id": id, "result": {} }))
            .await;
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
            "/work".into(),
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
            "/work".into(),
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
        let mut create_params = serde_json::Value::Null;
        for answer in [
            json!({ "terminalId": "term-1" }),
            json!({ "exitCode": 0 }),
            json!({ "output": "hi\n" }),
            json!({}),
        ] {
            let id = match rx.recv().await.expect("a terminal request") {
                crate::acp::channel::AcpOutbound::Request(request) => {
                    if request.method == "terminal/create" {
                        create_params = request.params.clone().unwrap_or_default();
                    }
                    methods.push(request.method.clone());
                    request.id.unwrap().as_u64().unwrap()
                }
                other => panic!("unexpected outbound: {other:?}"),
            };
            channel
                .resolve(id, json!({ "jsonrpc": "2.0", "id": id, "result": answer }))
                .await;
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
        // The command runs in the session's cwd, with the engine's spawn env
        // and the 4 MiB output budget — not in the client terminal's default
        // directory with no env at all.
        assert_eq!(create_params["cwd"], "/work");
        assert_eq!(create_params["outputByteLimit"], 4 * 1024 * 1024);
        let env = create_params["env"].as_array().expect("env array");
        assert!(
            env.iter()
                .any(|entry| entry["name"] == "NO_COLOR" && entry["value"] == "1")
        );
        assert!(
            env.iter()
                .any(|entry| entry["name"] == "GIT_TERMINAL_PROMPT" && entry["value"] == "0")
        );
        // The shell is the engine's resolved one, not a hardcoded `sh -c`.
        let shell = crate::native::shell::resolve_shell(None);
        assert_eq!(create_params["command"], shell.program);
        assert_eq!(
            create_params["args"].as_array().unwrap().len(),
            shell.args_prefix().len() + 1,
            "the shell prefix plus the command text"
        );
        assert_eq!(
            create_params["args"].as_array().unwrap().last().unwrap(),
            "echo hi"
        );

        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.content, "hi\n");
        assert!(!response.is_error);
    }

    /// The tool call's own `cwd` wins over the session's, and a command that
    /// outlives its timeout is killed through `terminal/kill` before the
    /// terminal is released.
    #[tokio::test]
    async fn bash_timeout_kills_the_client_terminal() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let capabilities = Arc::new(std::sync::Mutex::new(AcpClientCapabilities {
            terminal: true,
            ..Default::default()
        }));
        let host = Arc::new(AcpPermissionHost::new(
            Arc::new(crate::server::engine::ServerHost::standalone()),
            channel.clone(),
            "sess-timeout".into(),
            capabilities,
            "/work".into(),
        ));

        let pending = {
            let host = host.clone();
            tokio::spawn(async move {
                host.execute_tool(ToolExecuteRequest {
                    turn_id: "t".into(),
                    tool_call_id: "c".into(),
                    tool_name: "Bash".into(),
                    arguments: json!({ "command": "sleep 999", "cwd": "/elsewhere", "timeout": 1 }),
                })
                .await
            })
        };

        let mut methods = Vec::new();
        let mut create_params = serde_json::Value::Null;
        let mut hanging_wait: Option<u64> = None;
        // `terminal/wait_for_exit` is deliberately left unanswered: the
        // command hangs, so the tool's own timeout has to fire. Every other
        // request is answered — an unanswered one would block the tool
        // forever, since `AcpChannel::request` has no timeout of its own.
        while methods.len() < 5 {
            let id = match rx.recv().await.expect("a terminal request") {
                crate::acp::channel::AcpOutbound::Request(request) => {
                    if request.method == "terminal/create" {
                        create_params = request.params.clone().unwrap_or_default();
                    }
                    methods.push(request.method.clone());
                    request.id.unwrap().as_u64().unwrap()
                }
                other => panic!("unexpected outbound: {other:?}"),
            };
            match methods.last().map(String::as_str) {
                Some("terminal/create") => {
                    channel
                        .resolve(id, json!({ "jsonrpc": "2.0", "id": id, "result": { "terminalId": "term-hang" } }))
                        .await;
                }
                Some("terminal/wait_for_exit") => hanging_wait = Some(id),
                Some("terminal/output") => {
                    channel.resolve(id, json!({ "jsonrpc": "2.0", "id": id, "result": { "output": "partial\n" } })).await;
                }
                _ => {
                    channel
                        .resolve(id, json!({ "jsonrpc": "2.0", "id": id, "result": {} }))
                        .await;
                }
            }
        }
        assert_eq!(create_params["cwd"], "/elsewhere");
        assert!(
            hanging_wait.is_some(),
            "the hanging wait must stay unanswered for the timeout to fire"
        );

        let response = pending.await.unwrap().unwrap();
        assert!(
            response.is_error,
            "a timed-out command is a failed tool call"
        );
        assert_eq!(response.content, "Command killed by timeout (1s)");
        assert_eq!(
            methods,
            vec![
                "terminal/create",
                "terminal/wait_for_exit",
                "terminal/output",
                "terminal/kill",
                "terminal/release",
            ]
        );
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
            "/work".into(),
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
                json!({ "jsonrpc": "2.0", "id": id, "result": { "action": "accept", "content": { "q0": "Fast" } } }),
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
            "/work".into(),
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
                json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "selected", "optionId": "q0_opt_1" } } }),
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
            .resolve(id, json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "cancelled" } } }))
            .await;
        let response = pending.await.unwrap().unwrap();
        assert!(response.answers.is_empty());
        assert_eq!(
            response.note.as_deref(),
            Some("User dismissed the question without answering.")
        );
    }
}
