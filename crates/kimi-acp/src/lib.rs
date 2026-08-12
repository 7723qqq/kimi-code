//! Kimi Code ACP adapter — serves the Agent Client Protocol over stdio
//! JSON-RPC, driving the engine through `kimi-sdk::Harness`.
//!
//! Surface (TS `retired/acp-adapter` parity where the engine offers the
//! equivalent mechanism):
//!  - initialize with protocol-version negotiation, `authMethods`
//!    (terminal-auth `login`), and `configOptions` (model/mode/thinking
//!    pickers);
//!  - the session lifecycle (new/list/load/resume/delete), `session/list`
//!    filtered by `cwd`;
//!  - `session/prompt` accepting a string or `ContentBlock[]` (text +
//!    base64/url images), slash-command interception (skills, ACP builtin
//!    commands run locally, unknown commands reported locally);
//!  - the approval bridge: engine `session.approval.requested` events are
//!    forwarded to the client as `session/request_permission` JSON-RPC
//!    requests; the client's response (or a `session/update`
//!    `permission_resolution` notification) resolves the pending engine
//!    approval via `session/approval_resolve`.
//!
//! Wire format matches the engine's stdio: one JSON-RPC request per line in,
//! one response per line out.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kimi_sdk::Harness;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

/// The ACP protocol version this adapter negotiates.
pub const ACP_PROTOCOL_VERSION: &str = "2025-03-26";

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Serve ACP requests from `reader`, writing responses to `writer`, until EOF.
///
/// The serve loop is concurrent so a running `session/prompt` turn cannot
/// starve the wire: a dedicated reader task feeds lines through a channel,
/// each request/notification is handled in its own task, and JSON-RPC
/// responses to the adapter's reverse requests (`session/request_permission`
/// approval prompts) are routed back to the waiting handler by id.
pub async fn serve<R, W>(harness: Harness, reader: R, writer: W)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>> =
        Arc::new(AsyncMutex::new(Box::new(writer)));
    let bridge = Arc::new(ApprovalBridge::new(writer.clone(), harness.clone()));
    let (inbound_tx, mut inbound_rx) = mpsc::channel::<String>(64);
    // In-flight request tasks are tracked so EOF cannot drop their responses.
    let mut tasks = tokio::task::JoinSet::new();
    // Reader task: one JSON-RPC line in per message. When it hits EOF (the
    // client closed the pipe) the sender drops and the main loop drains.
    let reader_task = tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if inbound_tx.send(line).await.is_err() {
                break;
            }
        }
    });
    while let Some(line) = inbound_rx.recv().await {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            write_json(&writer, &serde_json::json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "Parse error" },
            }))
            .await;
            continue;
        };
        // A JSON-RPC response to one of our reverse requests (no `method`,
        // an `id` we handed out) goes to the waiting approval handler.
        if value.get("method").is_none() {
            if let Some(id) = value.get("id").and_then(|v| v.as_str()).map(str::to_string) {
                if bridge.deliver_response(&id, value).await {
                    continue;
                }
            }
        }
        let harness = harness.clone();
        let bridge = bridge.clone();
        let writer = writer.clone();
        tasks.spawn(async move {
            let request = match serde_json::from_str::<kimi_protocol::rpc::JsonRpcRequest>(&line) {
                Ok(request) => request,
                Err(_) => {
                    write_json(&writer, &serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": "Parse error" },
                    }))
                    .await;
                    return;
                }
            };
            let method = request.method.clone();
            let session_id = request
                .params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let response = handle(&harness, &bridge, &request).await.map(|v| vec![v]);
            // Notifications (no response body) are processed and answered
            // with silence — the ACP/JSON-RPC convention.
            let Some(mut response) = response else {
                return;
            };
            // ACP ordering: session/update notifications precede their response.
            let mut preamble: Vec<serde_json::Value> = Vec::new();
            match method.as_str() {
                "session/new" | "session/resume" => {
                    // Advertise the slash-command palette right after the
                    // session is created/attached (TS adapter parity).
                    preamble.push(commands_update(
                        &session_id,
                        slash_commands(&harness, &session_id).await,
                    ));
                }
                "session/load" => {
                    // History replay first, then the palette.
                    let mut updates = replay_updates(&harness, &session_id).await;
                    updates.push(commands_update(
                        &session_id,
                        slash_commands(&harness, &session_id).await,
                    ));
                    preamble = updates;
                }
                "session/prompt" => {
                    // Streamed chunks (llm.delta) become chunk-granular
                    // agent_message_chunk notifications — same channel carries
                    // locally-run slash-command output; strip the internal
                    // `_deltas` marker before the wire response.
                    if let Some(response_body) = response.first_mut() {
                        let deltas: Vec<String> = response_body["result"]["_deltas"]
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|d| d.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        if !deltas.is_empty() {
                            let mut text = String::new();
                            for chunk in deltas {
                                text.push_str(&chunk);
                                preamble.push(session_update(
                                    &session_id,
                                    "agent_message_chunk",
                                    text.clone(),
                                ));
                            }
                            if let Some(obj) = response_body["result"].as_object_mut() {
                                obj.remove("_deltas");
                            }
                        }
                    }
                }
                _ => {}
            }
            let mut out: Vec<serde_json::Value> = preamble;
            out.extend(response);
            for value in out {
                if !write_json(&writer, &value).await {
                    return;
                }
            }
        });
    }
    // Drain in-flight requests before returning: the client EOF'd, but
    // responses for already-received requests must still be written before
    // the process exits (kimi acp exits right after serve returns).
    while tasks.join_next().await.is_some() {}
    reader_task.abort();
}

/// Serialize one JSON-RPC line onto the shared writer. False on write/flush
/// failure (client disconnected) — callers stop streaming.
async fn write_json(
    writer: &Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    value: &serde_json::Value,
) -> bool {
    let mut writer = writer.lock().await;
    writer.write_all(format!("{value}\n").as_bytes()).await.is_ok()
        && writer.flush().await.is_ok()
}

/// An ACP `session/update` notification (the client's live-transcript wire).
fn session_update(session_id: &str, kind: &str, text: String) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": kind,
                "content": { "type": "text", "text": text },
            },
        },
    })
}

// ── Approval bridge ──────────────────────────────────────────────────────────
// The engine's `session.approval.requested` events are answered through the
// client: the bridge forwards each event as an ACP `session/request_permission`
// JSON-RPC request (request id `acp-req-<approval_id>`), waits for the client's
// response, and maps the outcome back into the SDK `ApprovalHandler` decision
// body. The SDK's shared approval loop then resolves the pending engine
// approval via `session/approval_resolve`. A client that answers through a
// `session/update` `permission_resolution` notification (instead of a JSON-RPC
// response) is handled separately by `handle_permission_resolution`.
//
// Error policy mirrors the TS adapter: any transport failure or timeout
// resolves with `denied` — rejecting is strictly safer than approving when the
// client cannot confirm intent.

/// Canonical permission options surfaced to the ACP client (TS
/// `approval.ts` parity; `optionId` round-trips back via the response).
const APPROVE_ONCE_OPTION_ID: &str = "approve_once";
const APPROVE_ALWAYS_OPTION_ID: &str = "approve_always";
const REJECT_OPTION_ID: &str = "reject";

fn canonical_permission_options() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({ "optionId": APPROVE_ONCE_OPTION_ID, "name": "Approve once", "kind": "allow_once" }),
        serde_json::json!({ "optionId": APPROVE_ALWAYS_OPTION_ID, "name": "Approve for this session", "kind": "allow_always" }),
        serde_json::json!({ "optionId": REJECT_OPTION_ID, "name": "Reject", "kind": "reject_once" }),
    ]
}

/// Timeout for a client's approval decision (the engine's deferred tool call
/// waits on the bridge). Deny on expiry.
const APPROVAL_RESPONSE_TIMEOUT_SECS: u64 = 300;

/// Reverse-request bridge: writes `session/request_permission` lines and
/// routes JSON-RPC responses back to the waiting handler by request id.
struct ApprovalBridge {
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>,
    harness: Harness,
}

impl ApprovalBridge {
    fn new(writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>, harness: Harness) -> Self {
        Self {
            writer,
            pending: Arc::new(Mutex::new(HashMap::new())),
            harness,
        }
    }

    /// A per-session `kimi_sdk::ApprovalHandler`: forwards the engine event
    /// to the client and resolves with the mapped decision.
    fn handler(&self) -> kimi_sdk::ApprovalHandler {
        let bridge = Arc::new(self.clone_for_handler());
        Arc::new(move |event| {
            let bridge = bridge.clone();
            Box::pin(async move { bridge.handle_approval_requested(&event).await })
        })
    }

    fn clone_for_handler(&self) -> Self {
        Self {
            writer: self.writer.clone(),
            pending: self.pending.clone(),
            harness: self.harness.clone(),
        }
    }

    async fn handle_approval_requested(&self, event: &serde_json::Value) -> serde_json::Value {
        let session_id = event["session_id"].as_str().unwrap_or("");
        let approval_id = event["approval_id"].as_str().unwrap_or("");
        let tool_call_id = event["tool_call_id"].as_str().unwrap_or("");
        let tool_name = event["tool_name"].as_str().unwrap_or("");
        let approval_rule = event["approval_rule"].as_str().unwrap_or("");
        let request_id = format!("acp-req-{approval_id}");
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "options": canonical_permission_options(),
                "toolCall": {
                    "toolCallId": tool_call_id,
                    "title": tool_name,
                    "content": [
                        { "type": "content", "content": { "type": "text", "text": format!("Requesting approval to {approval_rule}") } },
                    ],
                },
            },
        });
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id.clone(), tx);
        if !write_json(&self.writer, &request).await {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            return denied_decision("client disconnected");
        }
        match tokio::time::timeout(
            std::time::Duration::from_secs(APPROVAL_RESPONSE_TIMEOUT_SECS),
            rx,
        )
        .await
        {
            Ok(Ok(response)) => map_permission_response(&response),
            Ok(Err(_)) => denied_decision("permission channel closed"),
            Err(_) => denied_decision("permission request timed out"),
        }
    }

    /// Route a JSON-RPC response line to the waiting approval handler by
    /// request id. True when the id matched a pending request.
    async fn deliver_response(&self, id: &str, body: serde_json::Value) -> bool {
        let tx = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        match tx {
            Some(tx) => {
                let _ = tx.send(body);
                true
            }
            None => false,
        }
    }

    /// The client's answer for a `session/update` `permission_resolution`
    /// notification (no request id on the wire): resolve the pending engine
    /// approval directly. Falls back to the session's unique pending approval
    /// when no approval id is carried; ambiguous or unknown states are left
    /// pending (log-free — the serve loop has no logger).
    async fn handle_permission_resolution(&self, params: &serde_json::Value) {
        let Some(outcome) = permission_resolution_outcome(params) else {
            return;
        };
        let (option_id, cancelled) = outcome;
        let allow = !cancelled && matches!(option_id.as_str(), APPROVE_ONCE_OPTION_ID | APPROVE_ALWAYS_OPTION_ID);
        let approval_id = params["update"]["content"]["approvalId"]
            .as_str()
            .or_else(|| params["update"]["content"]["approval_id"].as_str())
            .map(str::to_string);
        if let Some(id) = approval_id {
            self.resolve(&id, allow, &option_id).await;
            return;
        }
        // No id on the notification: resolve the session's sole pending
        // approval, if unambiguous.
        let session_id = params["sessionId"].as_str().unwrap_or("");
        let body = self.harness.client().approval_list(Some(session_id)).await;
        let Some(pending) = body["result"]["pending"].as_array() else {
            return;
        };
        if pending.len() == 1 {
            if let Some(id) = pending[0]["id"].as_str() {
                self.resolve(id, allow, &option_id).await;
            }
        }
    }

    async fn resolve(&self, approval_id: &str, allow: bool, option_id: &str) {
        let reason = if allow { None } else { Some(option_id) };
        let _ = self.harness.client().approval_resolve(approval_id, allow, reason).await;
    }
}

fn denied_decision(feedback: &str) -> serde_json::Value {
    serde_json::json!({ "decision": "denied", "feedback": feedback })
}

/// Map a client `RequestPermissionResponse` body (either the raw JSON-RPC
/// `result` or the notification's `outcome`) into the SDK decision body.
/// Unknown optionIds deny (rejecting is safer than approving).
fn map_permission_response(response: &serde_json::Value) -> serde_json::Value {
    let outcome = response.get("result").unwrap_or(response);
    let outcome = outcome.get("outcome").unwrap_or(outcome);
    if outcome.get("outcome").and_then(|o| o.as_str()) == Some("cancelled") {
        return denied_decision("cancelled");
    }
    let option_id = outcome.get("optionId").and_then(|o| o.as_str()).unwrap_or("");
    match option_id {
        APPROVE_ONCE_OPTION_ID | APPROVE_ALWAYS_OPTION_ID => {
            serde_json::json!({ "decision": "approved", "feedback": option_id })
        }
        _ => denied_decision(if option_id.is_empty() { "no option selected" } else { option_id }),
    }
}

/// Extract `(option_id, cancelled)` from a `permission_resolution` update.
/// Accepts both the nested `content.outcome` shape and a bare `outcome`.
fn permission_resolution_outcome(params: &serde_json::Value) -> Option<(String, bool)> {
    let update = params.get("update")?;
    if update.get("sessionUpdate").and_then(|s| s.as_str()) != Some("permission_resolution") {
        return None;
    }
    let content = update.get("content").unwrap_or(&serde_json::Value::Null);
    let outcome = content.get("outcome").unwrap_or(content);
    if outcome.get("outcome").and_then(|o| o.as_str()) == Some("cancelled") {
        return Some((String::new(), true));
    }
    let option_id = outcome.get("optionId").and_then(|o| o.as_str())?.to_string();
    Some((option_id, false))
}

/// The terminal-auth method advertised in `initialize.authMethods` (TS
/// `auth-methods.ts` parity): clients spawn `<binary> acp --login` to start
/// the device-code flow, then re-invoke `authenticate('login')`.
fn terminal_auth_method() -> serde_json::Value {
    serde_json::json!({
        "id": "login",
        "type": "terminal",
        "name": "Login with Kimi account",
        "description": "Open the device-code login flow in a terminal.",
        "args": ["--login"],
        "env": {},
    })
}

/// ACP protocol-version negotiation: accept the client's version when it is
/// one this adapter implements, otherwise return ours and let the client
/// decide whether to disconnect (TS `version.ts` `negotiateVersion` parity).
fn negotiate_protocol_version(client: &serde_json::Value) -> &'static str {
    match client.as_str() {
        Some("2025-03-26") => "2025-03-26",
        Some("2024-11-05") => "2024-11-05",
        _ => ACP_PROTOCOL_VERSION,
    }
}

/// Whether the engine has usable credentials (TS `harnessIsAuthed` parity).
/// `KIMI_ACP_ALLOW_UNAUTHED=1` skips the gate — the escape hatch for
/// harness-based tests and local setups without a configured provider.
async fn is_authed(harness: &Harness) -> bool {
    if std::env::var("KIMI_ACP_ALLOW_UNAUTHED").as_deref() == Ok("1") {
        return true;
    }
    kimi_sdk::KimiAuth::new().status(harness, None).await.unwrap_or(false)
}

/// The ACP `configOptions` advertised in `initialize` — model / mode /
/// thinking pickers (TS `config-options.ts` parity, simplified: the thinking
/// picker is the legacy off/on pair, and models come from the engine config).
async fn build_config_options(harness: &Harness) -> serde_json::Value {
    let config = harness.client().config_get().await;
    let models: Vec<serde_json::Value> = config["result"]["models"]
        .as_object()
        .map(|m| {
            m.keys()
                .map(|key| serde_json::json!({ "value": key, "name": key }))
                .collect()
        })
        .unwrap_or_default();
    let default_model = config["result"]["defaultModel"].as_str().unwrap_or("");
    serde_json::json!([
        {
            "configId": "model",
            "name": "Model",
            "description": "The model to use for this session.",
            "options": models,
            "currentValue": default_model,
        },
        {
            "configId": "mode",
            "name": "Mode",
            "description": "The permission/plan mode for this session.",
            "options": [
                { "value": "default", "name": "Default", "description": "Standard interaction mode." },
                { "value": "plan", "name": "Plan", "description": "Plan mode: review a plan before acting." },
                { "value": "auto", "name": "Auto", "description": "Auto-approve tool calls." },
                { "value": "yolo", "name": "YOLO", "description": "Skip approvals entirely." },
            ],
            "currentValue": "default",
        },
        {
            "configId": "thinking",
            "name": "Thinking",
            "description": "Reasoning effort.",
            "options": [
                { "value": "off", "name": "Off" },
                { "value": "on", "name": "On" },
            ],
            "currentValue": "off",
        },
    ])
}

// ── Slash-command interception ───────────────────────────────────────────────
// ACP clients send slash commands as plain text in `session/prompt`. Only the
// leading text block is examined (TS `detectLeadingSlashIntent` parity):
// skills route to skill activation, ACP builtins run locally, and unknown
// slash inputs are reported locally instead of being forwarded to the model.

enum SlashIntent {
    Skill { name: String, args: String },
    Builtin { name: String, args: String },
    Unknown { name: String },
    Passthrough,
}

fn detect_slash_intent(text: &str) -> SlashIntent {
    if !text.starts_with('/') {
        return SlashIntent::Passthrough;
    }
    let trimmed = text[1..].trim();
    if trimmed.is_empty() {
        return SlashIntent::Passthrough;
    }
    let (name, args) = match trimmed.find(char::is_whitespace) {
        Some(i) => (&trimmed[..i], trimmed[i + 1..].trim()),
        None => (trimmed, ""),
    };
    if name.contains('/') {
        return SlashIntent::Passthrough;
    }
    if let Some(skill) = name.strip_prefix("skill:") {
        if !skill.is_empty() {
            return SlashIntent::Skill { name: skill.to_string(), args: args.to_string() };
        }
    }
    if BUILTIN_COMMANDS.iter().any(|(n, _)| *n == name) {
        return SlashIntent::Builtin { name: name.to_string(), args: args.to_string() };
    }
    SlashIntent::Unknown { name: name.to_string() }
}

/// The leading text block of an ACP prompt (string or `ContentBlock[]`);
/// non-text leading blocks short-circuit to `None` so slash detection never
/// runs on image/resource-first prompts.
fn leading_prompt_text(prompt: &serde_json::Value) -> Option<&str> {
    if let Some(text) = prompt.as_str() {
        return Some(text);
    }
    let blocks = prompt.as_array()?;
    let first = blocks.first()?;
    if first.get("type").and_then(|t| t.as_str()) != Some("text") {
        return None;
    }
    first.get("text").and_then(|t| t.as_str())
}

/// Convert an ACP prompt (string or `ContentBlock[]`) into engine content
/// parts (`{ type: text }` / `{ type: image_url }`). Text is passed through;
/// image blocks become `data:<media_type>;base64,<data>` (or url) image_url
/// parts. Resource and unknown blocks are skipped — the adapter cannot fetch
/// resource URIs.
fn acp_prompt_to_parts(prompt: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    if let Some(text) = prompt.as_str() {
        return Ok(vec![serde_json::json!({ "type": "text", "text": text })]);
    }
    let Some(blocks) = prompt.as_array() else {
        return Err("prompt must be a string or an array of content blocks".into());
    };
    let mut parts = Vec::new();
    for block in blocks {
        let Some(kind) = block.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        match kind {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        parts.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
            }
            "image" => {
                let source = block.get("source");
                let url = source.and_then(|s| s.get("url")).and_then(|u| u.as_str());
                let base64 = source.and_then(|s| s.get("data")).and_then(|d| d.as_str());
                let media_type = source.and_then(|s| s.get("media_type")).and_then(|m| m.as_str());
                match (url, base64, media_type) {
                    (Some(url), _, _) => {
                        parts.push(serde_json::json!({ "type": "image_url", "image_url": { "url": url } }));
                    }
                    (None, Some(data), Some(media)) => {
                        parts.push(serde_json::json!({
                            "type": "image_url",
                            "image_url": { "url": format!("data:{media};base64,{data}") },
                        }));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return Err("prompt contains no usable content blocks".into());
    }
    Ok(parts)
}

/// Run a prompt with explicit content parts, capturing the `llm.delta` text
/// chunks like `Harness::run_prompt_stream` (which only takes a string). The
/// engine's `session/prompt` accepts parts directly, so the adapter reuses
/// the SDK session surface instead of flattening images to text.
async fn prompt_parts_stream(
    harness: &Harness,
    session_id: &str,
    parts: serde_json::Value,
) -> anyhow::Result<(String, Vec<String>)> {
    let fut = async {
        let mut session = harness.create_session(session_id).await?;
        let _ = session.load().await;
        let mut rx = harness.subscribe();
        let mut deltas: Vec<String> = Vec::new();
        let prompt_result = {
            let prompt_fut = session.prompt_parts(parts);
            tokio::pin!(prompt_fut);
            loop {
                tokio::select! {
                    result = &mut prompt_fut => break result,
                    event = rx.recv() => match event {
                        Ok(e) if e["type"] == "llm.delta" => {
                            if let Some(delta) = e["part"]["text"].as_str() {
                                if !delta.is_empty() {
                                    deltas.push(delta.to_string());
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(_) => break serde_json::Value::Null,
                    }
                }
            }
        };
        if let Some(error) = prompt_result.get("error") {
            anyhow::bail!("run_prompt: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        let full_text = session.transcript().await?.unwrap_or_default();
        Ok((full_text, deltas))
    };
    tokio::time::timeout(std::time::Duration::from_secs(3600), fut)
        .await
        .map_err(|_| anyhow::anyhow!("prompt timed out after 1 hour"))?
}

// ── Builtin slash-command reports (TS `session.ts` format parity) ───────────

/// Run one ACP builtin slash command locally and return the report text.
async fn run_builtin_command(
    harness: &Harness,
    session_id: &str,
    name: &str,
    args: &str,
) -> String {
    if name == "help" {
        let commands: Vec<serde_json::Value> = BUILTIN_COMMANDS
            .iter()
            .map(|(n, d)| serde_json::json!({ "name": n, "description": d }))
            .collect();
        return format_help_report(&commands);
    }
    let client = harness.client();
    let body = match name {
        "compact" => {
            let instruction = if args.is_empty() { None } else { Some(args) };
            client
                .call(
                    kimi_protocol::methods::SESSION_COMPACT,
                    serde_json::json!({ "session_id": session_id, "instruction": instruction }),
                )
                .await
        }
        "status" => client.session_get_status(session_id).await,
        "usage" => client
            .call(
                kimi_protocol::methods::SESSION_GET_USAGE,
                serde_json::json!({ "session_id": session_id }),
            )
            .await,
        "mcp" => client
            .call(
                kimi_protocol::methods::SESSION_LIST_MCP_SERVERS,
                serde_json::json!({ "session_id": session_id }),
            )
            .await,
        "tasks" => client
            .call(kimi_protocol::methods::TASK_LIST, serde_json::Value::Null)
            .await,
        _ => return format!("Unknown ACP command: /{name}. Use /help to see available commands."),
    };
    if let Some(e) = body.get("error") {
        return format!("/{name} failed: {}", e["message"].as_str().unwrap_or("unknown"));
    }
    match name {
        "compact" => "Compaction complete.".to_string(),
        "status" => format_status_report(&body["result"]),
        "usage" => format_usage_report(&body["result"]),
        "mcp" => format_mcp_report(&body["result"]),
        "tasks" => format_tasks_report(&body["result"]),
        _ => String::new(),
    }
}

fn format_status_report(status: &serde_json::Value) -> String {
    let model = status["model"].as_str().unwrap_or("(not set)");
    let thinking = status["thinking_effort"].as_str().unwrap_or("");
    let permission = status["permission"].as_str().unwrap_or("manual");
    let plan_mode = status["plan_mode"].as_bool().unwrap_or(false);
    let context = status["context_tokens"].as_u64().unwrap_or(0);
    let max = status["max_context_tokens"].as_u64().unwrap_or(0);
    format!(
        "Session status:\n- Model: {model}\n- Thinking: {thinking}\n- Permission: {permission}\n\
         - Plan mode: {}\n- Context: {context} / {max}",
        if plan_mode { "on" } else { "off" },
    )
}

fn format_usage_report(usage: &serde_json::Value) -> String {
    let mut lines = vec!["Session usage:".to_string()];
    if let Some(total) = usage["total"].as_object() {
        lines.push(format!("- Total: {}", format_token_usage(total)));
    }
    if let Some(turn) = usage["current_turn"].as_object() {
        lines.push(format!("- Current turn: {}", format_token_usage(turn)));
    }
    if let Some(by_model) = usage["by_model"].as_object() {
        for (model, model_usage) in by_model {
            if let Some(m) = model_usage.as_object() {
                lines.push(format!("- {model}: {}", format_token_usage(m)));
            }
        }
    }
    lines.join("\n")
}

fn format_token_usage(usage: &serde_json::Map<String, serde_json::Value>) -> String {
    format!(
        "input {}, output {}, total {}",
        usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        usage.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
    )
}

fn format_mcp_report(result: &serde_json::Value) -> String {
    let Some(servers) = result["servers"].as_array() else {
        return "No MCP servers are configured for this session.".to_string();
    };
    if servers.is_empty() {
        return "No MCP servers are configured for this session.".to_string();
    }
    let mut lines = vec![format!("MCP servers ({}):", servers.len())];
    for server in servers {
        let name = server["name"].as_str().unwrap_or("?");
        let status = server["status"].as_str().unwrap_or("?");
        let transport = server["transport"].as_str().unwrap_or("?");
        let tools = server["tool_count"].as_u64().unwrap_or(0);
        let base = format!("- {name}: {status} ({transport}, {tools} tools)");
        if let Some(error) = server["error"].as_str().filter(|e| !e.is_empty()) {
            lines.push(format!("{base}\n  Error: {error}"));
        } else {
            lines.push(base);
        }
    }
    lines.join("\n")
}

fn format_tasks_report(result: &serde_json::Value) -> String {
    let Some(tasks) = result.as_array() else {
        return "No background tasks for this session.".to_string();
    };
    if tasks.is_empty() {
        return "No background tasks for this session.".to_string();
    }
    let mut lines = vec![format!("Background tasks ({}):", tasks.len())];
    for task in tasks {
        let id = task["task_id"].as_str().unwrap_or("?");
        let status = task["status"].as_str().unwrap_or("?");
        let description = task["description"].as_str().unwrap_or("");
        let mut parts = vec![format!("- {id}: {status}"), description.to_string()];
        if let Some(kind) = task["kind"].as_str() {
            if kind == "process" {
                if let Some(command) = task["command"].as_str() {
                    parts.push(format!("command={command}"));
                }
            } else if kind == "agent" {
                if let Some(subagent) = task["subagent_type"].as_str() {
                    parts.push(format!("subagent={subagent}"));
                }
            }
        }
        if let Some(reason) = task["stop_reason"].as_str() {
            parts.push(format!("reason={reason}"));
        }
        lines.push(parts.join(" · "));
    }
    lines.join("\n")
}

fn format_help_report(commands: &[serde_json::Value]) -> String {
    let mut lines = vec!["Available ACP commands:".to_string()];
    for command in commands {
        let name = command["name"].as_str().unwrap_or("");
        let description = command["description"].as_str().unwrap_or("");
        lines.push(format!("- /{name} — {description}"));
    }
    lines.join("\n")
}

/// ACP builtin slash commands advertised via `available_commands_update`
/// (TS `acp-adapter/src/builtin-commands.ts` parity).
const BUILTIN_COMMANDS: &[(&str, &str)] = &[
    ("compact", "Compact the conversation context"),
    ("status", "Show current session status"),
    ("usage", "Show session token usage"),
    ("mcp", "Show MCP server status"),
    ("tasks", "List background tasks"),
    ("help", "Show available ACP commands"),
];

/// An ACP `session/update` notification carrying the slash-command palette
/// (TS `availableCommandsUpdateNotification` parity).
fn commands_update(session_id: &str, commands: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": commands,
            },
        },
    })
}

/// The session-scoped slash-command palette: builtins + user-activatable
/// skills as `skill:<name>` entries (TS `buildSkillSlashCommands` parity —
/// builtin-sourced skills keep their bare name, everything else is
/// namespaced so the `session/prompt` interceptor can route it).
async fn slash_commands(harness: &Harness, session_id: &str) -> Vec<serde_json::Value> {
    let mut commands: Vec<serde_json::Value> = BUILTIN_COMMANDS
        .iter()
        .map(|(name, description)| serde_json::json!({ "name": name, "description": description }))
        .collect();
    let body = harness
        .client()
        .call(
            kimi_protocol::methods::SESSION_LIST_SKILLS,
            serde_json::json!({ "session_id": session_id }),
        )
        .await;
    if let Some(skills) = body["result"]["skills"].as_array() {
        for skill in skills {
            let Some(name) = skill["name"].as_str() else { continue };
            let source = skill["source"].as_str().unwrap_or("");
            let command_name = if source == "builtin" {
                name.to_string()
            } else {
                format!("skill:{name}")
            };
            commands.push(serde_json::json!({
                "name": command_name,
                "description": skill["description"].as_str().unwrap_or(""),
            }));
        }
    }
    commands
}

/// Replay the persisted context as `session/update` notifications —
/// `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` —
/// mirroring the TS adapter's `session/load` replay. Empty history yields
/// no notifications.
async fn replay_updates(harness: &Harness, session_id: &str) -> Vec<serde_json::Value> {
    let body = harness.client().session_get_context(session_id).await;
    let Some(history) = body["result"]["history"].as_array() else {
        return Vec::new();
    };
    let mut updates = Vec::new();
    for message in history {
        let role = message["role"].as_str().unwrap_or("");
        let Some(parts) = message["content"].as_array() else {
            continue;
        };
        for part in parts {
            let chunk = match (role, part.get("type").and_then(|t| t.as_str())) {
                ("user", Some("text")) => {
                    Some(("user_message_chunk", part["text"].as_str().unwrap_or("")))
                }
                ("assistant", Some("text")) => {
                    Some(("agent_message_chunk", part["text"].as_str().unwrap_or("")))
                }
                ("assistant", Some("think")) => {
                    Some(("agent_thought_chunk", part["think"].as_str().unwrap_or("")))
                }
                _ => None,
            };
            if let Some((kind, text)) = chunk {
                if !text.is_empty() {
                    updates.push(session_update(session_id, kind, text.to_string()));
                }
            }
        }
    }
    updates
}

/// Install the ACP approval bridge for a session: engine
/// `session.approval.requested` events for this session are forwarded to the
/// client as `session/request_permission` prompts.
async fn register_approval_handler(harness: &Harness, bridge: &ApprovalBridge, session_id: &str) {
    harness.set_approval_handler(session_id, Some(bridge.handler())).await;
}

/// The assistant text embedded in a `session/prompt` response, if any.
/// Dispatch one ACP request through the harness. Returns `None` for
/// notifications, which must not receive a response.
async fn handle(
    harness: &Harness,
    bridge: &ApprovalBridge,
    request: &kimi_protocol::rpc::JsonRpcRequest,
) -> Option<serde_json::Value> {
    let id = &request.id;
    let error = |code: i64, message: &str| Some(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }));
    let result = |value: serde_json::Value| Some(serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": value,
    }));
    let params = request.params.clone();
    let method = request.method.as_str();
    match method {
        "initialize" => {
            // Negotiate the protocol version the client asked for, then
            // advertise the terminal-auth login method and the
            // model/mode/thinking config pickers (TS adapter parity).
            let negotiated = negotiate_protocol_version(params.get("protocolVersion").unwrap_or(&serde_json::Value::Null));
            result(serde_json::json!({
                "protocolVersion": negotiated,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                    "mcpCapabilities": { "http": true, "sse": true },
                    "sessionCapabilities": { "list": {}, "resume": {} },
                },
                "authMethods": [terminal_auth_method()],
                "configOptions": build_config_options(harness).await,
            }))
        }
        "session/new" => {
            // Login gate: without usable credentials the client must run the
            // advertised terminal-auth flow first (TS `harnessIsAuthed` gate).
            if !is_authed(harness).await {
                return error(-32000, "Authentication required");
            }
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("acp-{}", SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)));
            match harness.create_session(&session_id).await {
                Ok(_) => {
                    register_approval_handler(harness, bridge, &session_id).await;
                    result(serde_json::json!({ "sessionId": session_id }))
                }
                Err(e) => error(-32603, &format!("session/new failed: {e}")),
            }
        }
        "session/load" => {
            if !is_authed(harness).await {
                return error(-32000, "Authentication required");
            }
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/load requires sessionId");
            }
            // ACP `session/load` replays an on-disk session: create is
            // idempotent here (the runtime agent is (re)built from the
            // record), then load restores the persisted context into the
            // agent so the serve-loop replay reflects the on-disk history.
            match harness.create_session(session_id).await {
                Ok(_) => {
                    register_approval_handler(harness, bridge, session_id).await;
                    let _ = harness
                        .client()
                        .call(
                            kimi_protocol::methods::SESSION_LOAD,
                            serde_json::json!({ "session_id": session_id }),
                        )
                        .await;
                    result(serde_json::json!({ "sessionId": session_id }))
                }
                Err(e) => error(-32603, &format!("session/load failed: {e}")),
            }
        }
        "session/resume" => {
            // The lighter-weight sibling of `session/load`: attach to the
            // on-disk session without replaying message history. The runtime
            // agent is created (idempotent) the same way.
            if !is_authed(harness).await {
                return error(-32000, "Authentication required");
            }
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/resume requires sessionId");
            }
            match harness.create_session(session_id).await {
                Ok(_) => {
                    register_approval_handler(harness, bridge, session_id).await;
                    result(serde_json::json!({ "sessionId": session_id }))
                }
                Err(e) => error(-32603, &format!("session/resume failed: {e}")),
            }
        }
        "session/list" => {
            // Optional `cwd` filter (ACP ↔ engine `work_dir`), no pagination.
            let cwd = params.get("cwd").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            match harness.list_sessions(100).await {
                Ok(sessions) => {
                    let sessions: Vec<serde_json::Value> = sessions
                        .into_iter()
                        .filter(|s| cwd.is_none_or(|c| s["work_dir"].as_str() == Some(c)))
                        .map(|s| {
                            let title = s["title"].as_str().filter(|t| !t.is_empty());
                            serde_json::json!({
                                "sessionId": s["id"],
                                "cwd": s["work_dir"],
                                "title": title,
                                "updatedAt": s["updated_at"],
                            })
                        })
                        .collect();
                    result(serde_json::json!({ "sessions": sessions, "nextCursor": null }))
                }
                Err(e) => error(-32603, &format!("session/list failed: {e}")),
            }
        }
        "session/delete" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/delete requires sessionId");
            }
            match harness.delete_session(session_id).await {
                Ok(_) => result(serde_json::json!({})),
                Err(e) => error(-32603, &format!("session/delete failed: {e}")),
            }
        }
        "session/get_config" => {
            // Per-session config projection (model/mode/thinking) for the
            // ACP client. `model` falls back to the config default.
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() {
                return error(-32602, "session/get_config requires sessionId");
            }
            let client = harness.client();
            let status = client.session_get_status(session_id).await;
            if let Some(e) = status.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("status failed"));
            }
            let config = client.config_get().await;
            // The per-session model (status) wins; fall back to the config
            // default only when the session has none set.
            let model = status["result"]["model"]
                .as_str()
                .filter(|m| !m.is_empty())
                .or_else(|| config["result"]["defaultModel"].as_str())
                .unwrap_or("");
            let mode = match status["result"]["plan_mode"].as_bool().unwrap_or(false) {
                true => "plan",
                false => match status["result"]["permission"].as_str().unwrap_or("") {
                    "auto" => "auto",
                    "yolo" => "yolo",
                    _ => "default",
                },
            };
            let thinking = status["result"]["thinking_effort"].as_str().unwrap_or("");
            result(serde_json::json!({
                "sessionId": session_id,
                "config": {
                    "model": model,
                    "mode": mode,
                    "thinking": thinking,
                },
            }))
        }
        "session/set_config_option" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let config_id = params.get("configId").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").cloned().unwrap_or(serde_json::Value::Null);
            if session_id.is_empty() || config_id.is_empty() {
                return error(-32602, "session/set_config_option requires sessionId and configId");
            }
            let client = harness.client();
            let outcome = match (config_id, value.as_str()) {
                ("model", Some(model)) if !model.is_empty() => {
                    client
                        .call(
                            kimi_protocol::methods::SESSION_SET_MODEL,
                            serde_json::json!({ "session_id": session_id, "model": model }),
                        )
                        .await
                }
                ("mode", Some(mode)) if matches!(mode, "plan" | "default" | "auto" | "yolo") => {
                    // ACP 4-mode taxonomy -> plan toggle + permission mode.
                    let plan = mode == "plan";
                    let permission = match mode {
                        "auto" => "auto",
                        "yolo" => "yolo",
                        _ => "manual",
                    };
                    let first = client
                        .call(
                            kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                            serde_json::json!({ "session_id": session_id, "enabled": plan }),
                        )
                        .await;
                    if let Some(e) = first.get("error") {
                        return error(-32603, e["message"].as_str().unwrap_or("set plan mode failed"));
                    }
                    client
                        .call(
                            kimi_protocol::methods::PERMISSION_SET_MODE,
                            serde_json::json!({ "mode": permission }),
                        )
                        .await
                }
                ("thinking", Some(effort)) if !effort.is_empty() => client
                    .call(
                        kimi_protocol::methods::SESSION_SET_THINKING,
                        serde_json::json!({ "session_id": session_id, "effort": effort }),
                    )
                    .await,
                _ => {
                    return error(
                        -32602,
                        &format!("unsupported config option {config_id}={value}"),
                    );
                }
            };
            if let Some(e) = outcome.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set_config_option failed"));
            }
            result(serde_json::json!({ "sessionId": session_id }))
        }
        "session/prompt" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let prompt = params.get("prompt").cloned().unwrap_or(serde_json::Value::Null);
            if session_id.is_empty() {
                return error(-32602, "session/prompt requires sessionId and prompt");
            }
            // Slash-command interception (TS parity): skills route to skill
            // activation, ACP builtins run locally, unknown slash commands are
            // reported locally — none of them reach the model as prompt text.
            if let Some(leading) = leading_prompt_text(&prompt) {
                match detect_slash_intent(leading) {
                    SlashIntent::Skill { name, args } => {
                        let body = harness
                            .client()
                            .call(
                                kimi_protocol::methods::SESSION_ACTIVATE_SKILL,
                                serde_json::json!({
                                    "session_id": session_id,
                                    "name": name,
                                    "args": { "args": args },
                                }),
                            )
                            .await;
                        if let Some(e) = body.get("error") {
                            return error(-32603, e["message"].as_str().unwrap_or("skill activation failed"));
                        }
                        // The skill turn renders into the session context; return
                        // its final assistant text like a normal prompt result.
                        let ctx = harness.client().session_get_context(session_id).await;
                        let text = kimi_ui::last_assistant_text(&ctx["result"]).unwrap_or_default();
                        return result(serde_json::json!({
                            "stopReason": "end_turn",
                            "messages": [{
                                "role": "assistant",
                                "content": [{ "type": "text", "text": text }],
                            }],
                        }));
                    }
                    SlashIntent::Builtin { name, args } => {
                        let text = run_builtin_command(harness, session_id, &name, &args).await;
                        // The report streams as an agent_message_chunk via the
                        // `_deltas` channel (serve turns it into a preamble
                        // notification); the response carries no assistant text.
                        let mut r = serde_json::json!({ "stopReason": "end_turn" });
                        r["_deltas"] = serde_json::json!([text]);
                        return result(r);
                    }
                    SlashIntent::Unknown { name } => {
                        let text = format!(
                            "Unknown ACP command: /{name}. Use /help to see available commands."
                        );
                        let mut r = serde_json::json!({ "stopReason": "end_turn" });
                        r["_deltas"] = serde_json::json!([text]);
                        return result(r);
                    }
                    SlashIntent::Passthrough => {}
                }
            }
            let parts = match acp_prompt_to_parts(&prompt) {
                Ok(parts) => parts,
                Err(e) => return error(-32602, &e),
            };
            match prompt_parts_stream(harness, session_id, serde_json::json!(parts)).await {
                Ok((text, deltas)) => {
                    // The serve layer turns `_deltas` into session/update
                    // agent_message_chunk notifications (chunk-granular live
                    // transcript); it is stripped from the wire response.
                    let mut r = serde_json::json!({
                        "stopReason": "end_turn",
                        "messages": [{
                            "role": "assistant",
                            "content": [{ "type": "text", "text": text }],
                        }],
                    });
                    if !deltas.is_empty() {
                        r["_deltas"] = serde_json::json!(deltas);
                    }
                    result(r)
                }
                Err(e) => error(-32603, &format!("session/prompt failed: {e}")),
            }
        }
        "session/update" => {
            // ACP notification: the client's live-transcript updates. Only
            // `permission_resolution` carries an action — it answers a
            // previously sent `session/request_permission` prompt. Notifications
            // never receive a response body.
            if params["update"]["sessionUpdate"].as_str() == Some("permission_resolution") {
                bridge.handle_permission_resolution(&params).await;
            }
            None
        }
        "notifications/initialized" => None,
        "session/cancel" => {
            // ACP notification: cancel the named session's running turn.
            // Processed for its side effect; no response body.
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if !session_id.is_empty() {
                let _ = harness.client().session_cancel(session_id).await;
            }
            None
        }
        "session/set_mode" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let mode_id = params.get("modeId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() || mode_id.is_empty() {
                return error(-32602, "session/set_mode requires sessionId and modeId");
            }
            // ACP 4-mode taxonomy (parity with the TS adapter's
            // `acpModeToToggles`): default/plan -> manual permission,
            // auto/yolo -> matching gate mode; only `plan` enables plan mode.
            let (plan, permission) = match mode_id {
                "default" => (false, "manual"),
                "plan" => (true, "manual"),
                "auto" => (false, "auto"),
                "yolo" => (false, "yolo"),
                _ => return error(-32602, &format!("Unknown modeId: {mode_id}")),
            };
            let client = harness.client();
            let plan_body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                    serde_json::json!({ "session_id": session_id, "enabled": plan }),
                )
                .await;
            if let Some(e) = plan_body.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set plan mode failed"));
            }
            // The permission gate is process-wide (the engine has a single
            // gate, no session scope) — matches the engine's design.
            let perm_body = client
                .call(
                    kimi_protocol::methods::PERMISSION_SET_MODE,
                    serde_json::json!({ "mode": permission }),
                )
                .await;
            if let Some(e) = perm_body.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set mode failed"));
            }
            result(serde_json::json!({ "sessionId": session_id }))
        }
        "session/set_model" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let model_id = params.get("modelId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() || model_id.is_empty() {
                return error(-32602, "session/set_model requires sessionId and modelId");
            }
            let client = harness.client();
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_MODEL,
                    serde_json::json!({ "session_id": session_id, "model": model_id }),
                )
                .await;
            if let Some(e) = body.get("error") {
                return error(-32603, e["message"].as_str().unwrap_or("set model failed"));
            }
            result(serde_json::json!({ "sessionId": session_id }))
        }
        _ => error(-32601, &format!("Method not found: {method}")),
    }
}

#[cfg(test)]
mod tests {
    // Tests serialize on STORE_LOCK (a std Mutex) to isolate the process-global
    // KIMI_AGENT_HOME/KIMI_CODE_HOME env vars across tokio tests. Holding the
    // guard across an await is intentional serialization, not a deadlock risk.
    #![allow(clippy::await_holding_lock)]
    use super::*;
    use tokio::io::{duplex, AsyncReadExt};

    /// Serializes tests that touch `KIMI_AGENT_HOME` (process-global env var).
    static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Drive the ACP server over an in-memory duplex; `None` when the server
    /// answers with silence (notifications — the read times out instead of
    /// blocking forever).
    async fn round_trip_maybe_empty(harness: Harness, request: &str) -> Option<serde_json::Value> {
        let (server_side, mut client_side) = duplex(4096);
        let (reader, writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(harness, reader, writer).await;
        });
        client_side.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if std::time::Instant::now() > deadline {
                break; // notification: no response within the window
            }
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                client_side.read(&mut byte),
            )
            .await
            {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(_)) => {
                    buf.push(byte[0]);
                    if byte[0] == b'\n' {
                        // A line is complete: the wire response carries an
                        // `id`; preamble notifications (session/update) do
                        // not — skip them and keep reading for the response.
                        if !buf.is_empty() {
                            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buf) {
                                if value.get("id").is_some() {
                                    drop(client_side);
                                    let _ = server.await;
                                    return Some(value);
                                }
                            }
                            buf.clear();
                        }
                    }
                }
                Err(_) => {}
            }
        }
        drop(client_side);
        let _ = server.await;
        if buf.is_empty() {
            None
        } else {
            serde_json::from_slice(&buf).ok()
        }
    }

    /// Drive the ACP server over an in-memory duplex with one request.
    async fn round_trip(harness: Harness, request: &str) -> serde_json::Value {
        round_trip_maybe_empty(harness, request)
            .await
            .expect("a response")
    }

    /// Drive one request and read exactly `n` newline-terminated JSON lines
    /// (notifications precede the response for load/prompt).
    async fn round_trip_n(harness: Harness, request: &str, n: usize) -> Vec<serde_json::Value> {
        let (server_side, mut client_side) = duplex(4096);
        let (reader, writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(harness, reader, writer).await;
        });
        client_side.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut values = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while values.len() < n && std::time::Instant::now() < deadline {
            let mut byte = [0u8; 1];
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                client_side.read(&mut byte),
            )
            .await
            {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(_)) => {
                    buf.push(byte[0]);
                    if byte[0] == b'\n' {
                        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buf) {
                            values.push(value);
                        }
                        buf.clear();
                    }
                }
                Err(_) => {}
            }
        }
        drop(client_side);
        let _ = server.await;
        values
    }

    #[tokio::test]
    async fn initialize_negotiates_protocol() {
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"clientCapabilities\":{}}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "initialize: {body}");
        assert_eq!(body["result"]["protocolVersion"], ACP_PROTOCOL_VERSION);
        assert_eq!(body["result"]["agentCapabilities"]["loadSession"], true);
        // The terminal-auth login method is advertised so clients can start
        // the device-code flow themselves.
        assert_eq!(
            body["result"]["authMethods"][0]["id"], "login",
            "authMethods: {body}"
        );
        assert_eq!(
            body["result"]["authMethods"][0]["type"], "terminal",
            "authMethods: {body}"
        );
        // configOptions ships the model / mode / thinking pickers.
        let config_options = body["result"]["configOptions"].as_array().expect("configOptions");
        let ids: Vec<&str> = config_options
            .iter()
            .filter_map(|c| c["configId"].as_str())
            .collect();
        assert_eq!(ids, ["model", "mode", "thinking"], "configOptions: {body}");
    }

    #[tokio::test]
    async fn initialize_falls_back_for_unknown_client_versions() {
        let harness = Harness::embedded().expect("embedded");
        // An unknown (or missing) client protocol version falls back to ours;
        // a known older one is echoed back.
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"99.99.99\",\"clientCapabilities\":{}}}\n",
        )
        .await;
        assert_eq!(body["result"]["protocolVersion"], ACP_PROTOCOL_VERSION, "fallback: {body}");
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"clientCapabilities\":{}}}\n",
        )
        .await;
        assert_eq!(body["result"]["protocolVersion"], "2024-11-05", "known older: {body}");
    }

    #[tokio::test]
    async fn session_new_requires_authentication() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // No auth bypass, no configured provider -> auth_required (-32000).
        std::env::remove_var("KIMI_ACP_ALLOW_UNAUTHED");
        let home = std::env::temp_dir().join(format!("kimi-acp-auth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_CODE_HOME", &home);
        std::env::set_var("KIMI_AGENT_HOME", &home);

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-auth\"}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32000, "auth gate: {body}");
        assert!(body["error"]["message"].as_str().unwrap_or("").contains("Authentication"));
        // session/load and session/resume are gated the same way.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/load\",\"params\":{\"sessionId\":\"acp-auth\"}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32000, "load gate: {body}");
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/resume\",\"params\":{\"sessionId\":\"acp-auth\"}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32000, "resume gate: {body}");

        std::env::remove_var("KIMI_CODE_HOME");
    }

    #[tokio::test]
    async fn session_lifecycle_round_trip() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-s1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");
        assert_eq!(body["result"]["sessionId"], "acp-s1");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/list\",\"params\":{}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/list: {body}");
        let sessions = body["result"]["sessions"].as_array().expect("sessions");
        assert!(sessions.iter().any(|s| s["sessionId"] == "acp-s1"), "listed: {body}");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/delete\",\"params\":{\"sessionId\":\"acp-s1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/delete: {body}");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"bogus/method\",\"params\":{}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32601, "unknown method: {body}");
    }

    #[tokio::test]
    async fn notifications_are_answered_with_silence() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-notif-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        // notifications/initialized -> no response line.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip_maybe_empty(
            harness,
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        )
        .await;
        assert!(body.is_none(), "notification gets no response: {body:?}");

        // session/cancel (notification) -> no response; unknown sessions are
        // tolerated (cancel simply reports false internally).
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip_maybe_empty(
            harness,
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/cancel\",\"params\":{\"sessionId\":\"nope\"}}\n",
        )
        .await;
        assert!(body.is_none(), "cancel notification gets no response: {body:?}");
    }

    #[tokio::test]
    async fn session_resume_attaches() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/resume\",\"params\":{\"sessionId\":\"acp-resume-1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/resume: {body}");
        assert_eq!(body["result"]["sessionId"], "acp-resume-1");

        // Resuming again is idempotent.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/resume\",\"params\":{\"sessionId\":\"acp-resume-1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "second resume: {body}");

        // Missing sessionId is rejected.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/resume\",\"params\":{}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32602, "missing sessionId: {body}");
    }

    #[tokio::test]
    async fn session_config_round_trip() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        // Create, set plan mode via config option, and read it back. A single
        // shared harness keeps the in-process engine (and its live agents).
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-cfg\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");

        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/set_config_option\",\"params\":{\"sessionId\":\"acp-cfg\",\"configId\":\"mode\",\"value\":\"plan\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_config_option: {body}");

        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/get_config\",\"params\":{\"sessionId\":\"acp-cfg\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "get_config: {body}");
        assert_eq!(body["result"]["config"]["mode"], "plan", "config: {body}");
        assert!(body["result"]["config"]["model"].is_string());
    }

    #[tokio::test]
    async fn session_load_replays_updates() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-replay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let harness = Harness::embedded().expect("embedded");
        // Seed a session with context (a user message) and persist it.
        let mut session = harness
            .clone()
            .create_session("acp-replay")
            .await
            .expect("create");
        session
            .import_context("hello from import", "test")
            .await
            .expect("import");
        session.save().await.expect("save");

        // session/load replays the history as user_message_chunk
        // notifications BEFORE the response (ACP ordering), then advertises
        // the slash-command palette. The imported message carries two text
        // parts (the wrapper + the content), so two replay notifications +
        // the palette + the response precede.
        let lines = round_trip_n(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/load\",\"params\":{\"sessionId\":\"acp-replay\"}}\n",
            4,
        )
        .await;
        assert_eq!(lines.len(), 4, "2 replay + palette + response: {lines:?}");
        for line in &lines[..2] {
            assert_eq!(line["method"], "session/update", "line: {line:?}");
            assert_eq!(line["params"]["sessionId"], "acp-replay");
            assert_eq!(
                line["params"]["update"]["sessionUpdate"],
                "user_message_chunk",
                "update: {line:?}"
            );
        }
        let texts: Vec<&str> = lines[..2]
            .iter()
            .filter_map(|l| l["params"]["update"]["content"]["text"].as_str())
            .collect();
        assert!(
            texts.iter().any(|t| t.contains("hello from import")),
            "imported content replayed: {texts:?}"
        );
        // The palette notification advertises the builtin commands.
        assert_eq!(
            lines[2]["params"]["update"]["sessionUpdate"],
            "available_commands_update",
            "palette: {lines:?}"
        );
        let palette = lines[2]["params"]["update"]["availableCommands"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(
            palette.iter().any(|c| c["name"] == "compact"),
            "builtin advertised: {palette:?}"
        );
        assert!(lines[3].get("id").is_some(), "line 3 is the response: {lines:?}");
        assert_eq!(lines[3]["result"]["sessionId"], "acp-replay");
    }

    #[tokio::test]
    async fn session_set_mode_and_model_round_trip() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-mode\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");

        // `plan` -> plan mode on, manual permission.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/set_mode\",\"params\":{\"sessionId\":\"acp-mode\",\"modeId\":\"plan\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_mode plan: {body}");

        // `auto` -> plan off, auto permission; get_config reflects it.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/set_mode\",\"params\":{\"sessionId\":\"acp-mode\",\"modeId\":\"auto\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_mode auto: {body}");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"session/get_config\",\"params\":{\"sessionId\":\"acp-mode\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "get_config: {body}");
        assert_eq!(body["result"]["config"]["mode"], "auto", "config: {body}");

        // An unknown modeId is a structured invalid_params rejection.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"session/set_mode\",\"params\":{\"sessionId\":\"acp-mode\",\"modeId\":\"bogus\"}}\n",
        )
        .await;
        assert_eq!(body["error"]["code"], -32602, "unknown mode: {body}");

        // session/set_model lands on the session and get_config reports it
        // (per-session model beats the global config default).
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"session/set_model\",\"params\":{\"sessionId\":\"acp-mode\",\"modelId\":\"acp-test-model\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "set_model: {body}");
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"session/get_config\",\"params\":{\"sessionId\":\"acp-mode\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "get_config: {body}");
        assert_eq!(body["result"]["config"]["model"], "acp-test-model", "config: {body}");
    }

    #[tokio::test]
    async fn session_prompt_streams_update_notifications() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-prompt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        // A fake LLM answers one shot (host-proxy: no llm.delta, so no chunk
        // notifications; the response must carry the full text and no
        // `_deltas` residue).
        let step: kimi_server::callbacks::LlmStep = std::sync::Arc::new(
            move |_req: kimi_protocol::wire_types::LlmChatRequest| {
                Box::pin(async move {
                    Ok(kimi_protocol::wire_types::LlmChatResponse {
                        content: "acp streamed reply".into(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: kimi_protocol::wire_types::TokenUsage {
                            input_tokens: 4,
                            output_tokens: 4,
                            total_tokens: 8,
                        },
                    })
                })
            },
        );
        let harness = Harness::embedded_with_llm_step(Some(step)).expect("embedded with llm step");

        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/prompt\",\"params\":{\"sessionId\":\"acp-prompt\",\"prompt\":\"hi\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "prompt: {body}");
        // Host-proxy emits no deltas, so no preamble notifications; the wire
        // response carries the full assistant text and no `_deltas` residue.
        assert!(
            body["result"]["_deltas"].is_null(),
            "no _deltas residue: {body}"
        );
        assert_eq!(
            body["result"]["messages"][0]["content"][0]["text"], "acp streamed reply",
            "assistant text: {body}"
        );
    }

    #[tokio::test]
    async fn session_update_permission_resolution_is_silent() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-permres-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        // A `session/update` notification — including `permission_resolution`
        // — must never receive a response body (JSON-RPC notification
        // semantics; the old code answered with -32601).
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip_maybe_empty(
            harness,
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"acp-permres\",\"update\":{\"sessionUpdate\":\"permission_resolution\",\"content\":{\"outcome\":{\"outcome\":\"selected\",\"optionId\":\"reject\"}}}}}\n",
        )
        .await;
        assert!(body.is_none(), "permission_resolution notification gets no response: {body:?}");

        // Other session/update kinds are silent too.
        let harness = Harness::embedded().expect("embedded");
        let body = round_trip_maybe_empty(
            harness,
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"acp-permres\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hi\"}}}}\n",
        )
        .await;
        assert!(body.is_none(), "generic session/update gets no response: {body:?}");
    }

    #[tokio::test]
    async fn permission_outcome_mapping_is_defensive() {
        // approve_once / approve_always -> approved; reject / cancelled /
        // unknown -> denied.
        let approved = map_permission_response(&serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": "approve_once" },
        }));
        assert_eq!(approved["decision"], "approved", "{approved}");
        let approved_always = map_permission_response(&serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": "approve_always" },
        }));
        assert_eq!(approved_always["decision"], "approved", "{approved_always}");
        let rejected = map_permission_response(&serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": "reject" },
        }));
        assert_eq!(rejected["decision"], "denied", "{rejected}");
        let cancelled = map_permission_response(&serde_json::json!({
            "outcome": { "outcome": "cancelled" },
        }));
        assert_eq!(cancelled["decision"], "denied", "{cancelled}");
        let unknown = map_permission_response(&serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": "mystery" },
        }));
        assert_eq!(unknown["decision"], "denied", "{unknown}");
    }

    #[tokio::test]
    async fn approval_bridge_forwards_request_permission_and_resolves() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-bridge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let harness = Harness::embedded().expect("embedded");
        let (server_side, mut client_side) = duplex(4096);
        let (reader, writer) = tokio::io::split(server_side);
        let writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>> =
            Arc::new(AsyncMutex::new(Box::new(writer)));
        let bridge = ApprovalBridge::new(writer, harness.clone());
        // Drive the handler (as the SDK approval loop would) in a task.
        let handler = bridge.handler();
        let event = serde_json::json!({
            "type": "session.approval.requested",
            "session_id": "acp-bridge",
            "approval_id": "approval-test-7",
            "tool_call_id": "call_7",
            "tool_name": "Bash",
            "approval_rule": "Bash(echo hi)",
            "arguments": { "command": "echo hi" },
            "created_at_ms": 1,
        });
        let pending = tokio::spawn(async move { handler(event).await });
        let _ = reader; // server-side reader is unused here

        // The client sees a `session/request_permission` request carrying the
        // canonical three options and the raw engine ids.
        let mut line = String::new();
        let mut byte = [0u8; 1];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if std::time::Instant::now() > deadline {
                panic!("no request_permission line within window");
            }
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                client_side.read(&mut byte),
            )
            .await
            {
                Ok(Ok(0)) | Ok(Err(_)) => panic!("stream closed before request_permission"),
                Ok(Ok(_)) => {
                    line.push(byte[0] as char);
                    if byte[0] == b'\n' {
                        break;
                    }
                }
                Err(_) => {}
            }
        }
        let request: serde_json::Value = serde_json::from_str(&line).expect("request line");
        assert_eq!(request["method"], "session/request_permission");
        assert_eq!(request["id"], "acp-req-approval-test-7");
        assert_eq!(request["params"]["sessionId"], "acp-bridge");
        let options = request["params"]["options"].as_array().expect("options");
        assert_eq!(options.len(), 3);
        assert_eq!(options[0]["optionId"], "approve_once");
        assert_eq!(request["params"]["toolCall"]["toolCallId"], "call_7");
        assert_eq!(request["params"]["toolCall"]["title"], "Bash");

        // The client answers through the JSON-RPC response channel (the serve
        // loop routes it by id); the handler resolves approved.
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "acp-req-approval-test-7",
            "result": { "outcome": { "outcome": "selected", "optionId": "approve_once" } },
        });
        assert!(bridge.deliver_response("acp-req-approval-test-7", response).await);
        let decision = pending.await.expect("handler task");
        assert_eq!(decision["decision"], "approved", "{decision}");
    }

    #[tokio::test]
    async fn slash_builtin_commands_run_locally() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-slash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-slash\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");

        // `/status` runs locally: the report streams as an agent_message_chunk
        // preamble notification, the response is an empty end_turn.
        let lines = round_trip_n(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/prompt\",\"params\":{\"sessionId\":\"acp-slash\",\"prompt\":\"/status\"}}\n",
            2,
        )
        .await;
        assert_eq!(lines.len(), 2, "report notification + response: {lines:?}");
        assert_eq!(lines[0]["method"], "session/update");
        assert_eq!(lines[0]["params"]["update"]["sessionUpdate"], "agent_message_chunk");
        let report = lines[0]["params"]["update"]["content"]["text"]
            .as_str()
            .unwrap_or("");
        assert!(report.contains("Session status:"), "report: {report}");
        assert_eq!(lines[1]["result"]["stopReason"], "end_turn");
        assert!(lines[1]["result"].get("messages").is_none(), "local command: {lines:?}");

        // `/help` lists the palette.
        let lines = round_trip_n(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/prompt\",\"params\":{\"sessionId\":\"acp-slash\",\"prompt\":\"/help\"}}\n",
            2,
        )
        .await;
        let report = lines[0]["params"]["update"]["content"]["text"]
            .as_str()
            .unwrap_or("");
        assert!(report.contains("Available ACP commands:"), "help: {report}");
        assert!(report.contains("/compact"), "help lists builtins: {report}");

        // An unknown slash command is reported locally, not sent to the model.
        let lines = round_trip_n(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"session/prompt\",\"params\":{\"sessionId\":\"acp-slash\",\"prompt\":\"/bogus\"}}\n",
            2,
        )
        .await;
        let report = lines[0]["params"]["update"]["content"]["text"]
            .as_str()
            .unwrap_or("");
        assert!(
            report.contains("Unknown ACP command: /bogus"),
            "unknown slash: {report}"
        );
        assert_eq!(lines[1]["result"]["stopReason"], "end_turn");
    }

    #[tokio::test]
    async fn prompt_accepts_content_blocks_with_image() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-blocks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let step: kimi_server::callbacks::LlmStep = std::sync::Arc::new(
            move |_req: kimi_protocol::wire_types::LlmChatRequest| {
                Box::pin(async move {
                    Ok(kimi_protocol::wire_types::LlmChatResponse {
                        content: "saw the image".into(),
                        tool_calls: vec![],
                        finish_reason: Some("stop".into()),
                        usage: kimi_protocol::wire_types::TokenUsage {
                            input_tokens: 5,
                            output_tokens: 5,
                            total_tokens: 10,
                        },
                    })
                })
            },
        );
        let harness = Harness::embedded_with_llm_step(Some(step)).expect("embedded with llm step");
        // A base64 image block converts into an engine `image_url` part.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/prompt\",\"params\":{\"sessionId\":\"acp-blocks\",\"prompt\":[{\"type\":\"text\",\"text\":\"what is this?\"},{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"data\":\"aGVsbG8=\",\"media_type\":\"image/png\"}}]}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "block prompt: {body}");
        assert_eq!(
            body["result"]["messages"][0]["content"][0]["text"], "saw the image",
            "assistant text: {body}"
        );
        // The user turn reached the engine with both parts.
        let ctx = harness.client().session_get_context("acp-blocks").await;
        let history = ctx["result"]["history"].as_array().expect("history");
        let user = history
            .iter()
            .find(|m| m["role"] == "user")
            .expect("user message");
        let parts = user["content"].as_array().expect("user parts");
        assert!(
            parts.iter().any(|p| p["type"] == "text" && p["text"] == "what is this?"),
            "text part: {parts:?}"
        );
        assert!(
            parts.iter().any(|p| {
                p["type"] == "image_url"
                    && p["image_url"]["url"].as_str() == Some("data:image/png;base64,aGVsbG8=")
            }),
            "image part: {parts:?}"
        );
    }

    #[tokio::test]
    async fn session_list_filters_by_cwd() {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("kimi-acp-cwd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("KIMI_AGENT_HOME", &home);
        std::env::set_var("KIMI_ACP_ALLOW_UNAUTHED", "1");

        let harness = Harness::embedded().expect("embedded");
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",\"params\":{\"sessionId\":\"acp-cwd-1\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "session/new: {body}");

        // No filter -> the session is listed with the ACP summary shape.
        let body = round_trip(
            harness.clone(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/list\",\"params\":{}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "list: {body}");
        assert_eq!(body["result"]["nextCursor"], serde_json::Value::Null);
        let sessions = body["result"]["sessions"].as_array().expect("sessions");
        assert!(
            sessions.iter().any(|s| s["sessionId"] == "acp-cwd-1" && s["cwd"].is_string()),
            "ACP shape: {body}"
        );

        // A cwd that matches nothing yields an empty list.
        let body = round_trip(
            harness,
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/list\",\"params\":{\"cwd\":\"/definitely/not/a/workspace\"}}\n",
        )
        .await;
        assert!(body.get("error").is_none(), "filtered list: {body}");
        let sessions = body["result"]["sessions"].as_array().expect("sessions");
        assert!(sessions.is_empty(), "cwd filter: {body}");
    }
}
