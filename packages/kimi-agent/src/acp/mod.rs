//! Native ACP (Agent Client Protocol) dispatcher.
//!
//! `AcpServer::handle_message` speaks the JSON-RPC 2.0 envelope (parse error /
//! invalid request / method not found, notifications never answered) and
//! answers the ACP handshake with the spec shape: numeric `protocolVersion`,
//! `agentCapabilities`, `authMethods` (types.rs). `session/prompt` runs a real
//! turn through `ServerEngine` when one is attached and accepts both the
//! string and the ACP `ContentBlock[]` prompt form.
//!
//! Still missing (see `reports/rust-engine-*` and the ROADMAP): the outbound
//! `session/update` notification channel, the `request_permission` bridge,
//! `session/resume` / `session/fork`, `configOptions`, and replaying history
//! on `session/load`.

pub mod types;

use serde_json::json;
use std::sync::Arc;

use crate::acp::types::{
    AcpInitializeParams, JsonRpcRequest, JsonRpcResponse, acp_modes, negotiate_protocol_version,
};
use crate::session::sqlite_store::SqliteSessionStore;
use crate::turn_loop::types::LLMMessage;

pub struct AcpServer {
    store: Arc<SqliteSessionStore>,
    engine: Option<Arc<crate::server::engine::ServerEngine>>,
}

impl AcpServer {
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self {
            store,
            engine: None,
        }
    }

    pub fn with_engine(
        store: Arc<SqliteSessionStore>,
        engine: Arc<crate::server::engine::ServerEngine>,
    ) -> Self {
        Self {
            store,
            engine: Some(engine),
        }
    }

    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let store = Arc::new(SqliteSessionStore::in_memory()?);
        Ok(Self::new(store))
    }

    /// Run the ACP server reading from stdin and writing to stdout.
    pub async fn run_stdio(&self) -> Result<(), std::io::Error> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();
        let mut reader = BufReader::new(stdin).lines();

        while let Some(line) = reader.next_line().await? {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(resp) = self.handle_message(trimmed).await {
                let serialized = serde_json::to_string(&resp).map_err(|e| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
                })?;
                stdout.write_all(serialized.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
        }
        Ok(())
    }

    /// Process an incoming JSON-RPC 2.0 message and return an optional response.
    pub async fn handle_message(&self, raw: &str) -> Option<JsonRpcResponse> {
        let req: JsonRpcRequest = match serde_json::from_str(raw) {
            Ok(r) => r,
            Err(_) => {
                return Some(JsonRpcResponse::error(
                    None,
                    -32700,
                    "Parse error: invalid JSON",
                ));
            }
        };

        if req.jsonrpc != "2.0" {
            return Some(JsonRpcResponse::error(
                req.id,
                -32600,
                "Invalid Request: jsonrpc must be '2.0'",
            ));
        }

        // A message without an id is a JSON-RPC notification: run its side
        // effect, never write a response (v2 dispatches `session/cancel`
        // through `onNotification`, server.ts:717).
        let is_notification = req.id.is_none();

        let resp = match req.method.as_str() {
            "initialize" => {
                let params: AcpInitializeParams = req
                    .params
                    .as_ref()
                    .and_then(|raw| serde_json::from_value(raw.clone()).ok())
                    .unwrap_or_default();
                let protocol_version = negotiate_protocol_version(params.protocol_version);
                JsonRpcResponse::success(
                    req.id,
                    json!({
                        "protocolVersion": protocol_version,
                        "agentCapabilities": {
                            "loadSession": true,
                            // The engine's turn API takes plain text, so image
                            // and audio prompt blocks are not advertised.
                            "promptCapabilities": {
                                "image": false,
                                "audio": false,
                                "embeddedContext": true,
                            },
                            // Only the methods this server actually answers.
                            "sessionCapabilities": {
                                "list": {},
                                "close": {},
                                "delete": {},
                            },
                            "mcpCapabilities": { "http": true, "sse": true },
                            "auth": { "logout": {} },
                        },
                        "authMethods": [{
                            "id": "login",
                            "type": "terminal",
                            "name": "Login with Kimi account",
                            "description": "Open the device-code login flow in a terminal.",
                            "args": ["--login"],
                            "env": {},
                        }],
                        "agentInfo": {
                            "name": "kimi-agent-rust",
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                    }),
                )
            }
            "session/new" => {
                let session_id = format!("sess-{}", fastrand::u64(..));
                let title = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("title"))
                    .and_then(|v| v.as_str());

                match self.store.create_session(&session_id, title) {
                    Ok(_) => JsonRpcResponse::success(
                        req.id,
                        json!({
                            "sessionId": session_id,
                            "modes": {
                                "currentModeId": "default",
                                "availableModes": acp_modes(),
                            },
                        }),
                    ),
                    Err(e) => {
                        JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}"))
                    }
                }
            }
            "session/list" => match self.store.list_sessions() {
                Ok(list) => JsonRpcResponse::success(req.id, json!({ "sessions": list })),
                Err(e) => JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}")),
            },
            "session/prompt" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());
                let prompt = params
                    .and_then(|p| p.get("prompt"))
                    .and_then(acp_prompt_to_text);

                match (session_id, prompt) {
                    (Some(sid), Some(p)) => {
                        if let Some(ref engine) = self.engine {
                            let history = self.store.load_session_history(sid).unwrap_or_default();
                            let turn_number = self.store.next_turn_number(sid).unwrap_or(1);
                            match engine.run_turn(sid, turn_number, history, &p).await {
                                Ok(report) => JsonRpcResponse::success(
                                    req.id,
                                    json!({
                                        "sessionId": sid,
                                        "turnId": report.turn_id,
                                        "stopReason": report.stop_reason,
                                        "content": report.reply,
                                        "steps": report.steps,
                                        "usage": {
                                            "inputTokens": report.usage.input_tokens,
                                            "outputTokens": report.usage.output_tokens,
                                            "totalTokens": report.usage.total_tokens,
                                        }
                                    }),
                                ),
                                Err(err) => JsonRpcResponse::error(
                                    req.id,
                                    -32000,
                                    format!("Turn execution failed: {err}"),
                                ),
                            }
                        } else {
                            let turn_id = format!("turn-{}", fastrand::u64(..));
                            let msgs = vec![
                                LLMMessage::user(p.clone()),
                                LLMMessage::assistant(format!("Response to: {p}")),
                            ];
                            let _ = self.store.save_turn(sid, &turn_id, 1, &msgs, None);
                            JsonRpcResponse::success(
                                req.id,
                                json!({
                                    "sessionId": sid,
                                    "turnId": turn_id,
                                    "stopReason": "end_turn",
                                    "content": format!("Response to: {p}"),
                                }),
                            )
                        }
                    }
                    _ => JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: sessionId and prompt are required",
                    ),
                }
            }
            "session/load" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());

                match session_id {
                    Some(sid) => match self.store.load_session_history(sid) {
                        Ok(history) => JsonRpcResponse::success(
                            req.id,
                            json!({
                                "sessionId": sid,
                                "messages": history,
                            }),
                        ),
                        Err(e) => JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}")),
                    },
                    None => JsonRpcResponse::error(req.id, -32602, "Invalid params: sessionId is required"),
                }
            }
            "session/delete" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());

                match session_id {
                    Some(sid) => match self.store.delete_session(sid) {
                        Ok(deleted) => JsonRpcResponse::success(req.id, json!({ "deleted": deleted })),
                        Err(e) => JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}")),
                    },
                    None => JsonRpcResponse::error(req.id, -32602, "Invalid params: sessionId is required"),
                }
            }
            "session/close" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());

                match session_id {
                    Some(sid) => JsonRpcResponse::success(req.id, json!({ "sessionId": sid, "closed": true })),
                    None => JsonRpcResponse::error(req.id, -32602, "Invalid params: sessionId is required"),
                }
            }
            "session/cancel" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());
                if let (Some(sid), Some(engine)) = (session_id, self.engine.as_ref()) {
                    engine.cancel_turn(sid);
                }
                JsonRpcResponse::success(req.id, json!({ "cancelled": true }))
            }
            "session/set_mode" => {
                let params = req.params.as_ref();
                let mode = params
                    .and_then(|p| p.get("mode"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("auto");
                JsonRpcResponse::success(req.id, json!({ "mode": mode }))
            }
            "authenticate" => JsonRpcResponse::success(req.id, json!({ "authenticated": true })),
            "logout" => JsonRpcResponse::success(req.id, json!({ "loggedOut": true })),
            "ping" => JsonRpcResponse::success(req.id, json!("pong")),
            _ => {
                JsonRpcResponse::error(req.id, -32601, format!("Method not found: {}", req.method))
            }
        };

        if is_notification {
            return None;
        }
        Some(resp)
    }
}

/// Accept both prompt forms: the legacy plain string and the ACP
/// `ContentBlock[]` array (v2 `acpBlocksToContentParts`, convert.ts:26-78).
fn acp_prompt_to_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(blocks) => Some(acp_blocks_to_text(blocks)),
        _ => None,
    }
}

/// Flatten ACP content blocks into the plain prompt text the engine takes.
/// Text blocks pass through, text resources keep their uri provenance,
/// resource links become inline references, and audio / blob / unknown blocks
/// are dropped — the engine prompt pipeline is text-only.
fn acp_blocks_to_text(blocks: &[serde_json::Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        match block
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
        {
            "text" => {
                if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                    parts.push(text.to_string());
                }
            }
            "resource" => {
                let resource = block.get("resource").cloned().unwrap_or(serde_json::Value::Null);
                if let Some(text) = resource.get("text").and_then(|value| value.as_str()) {
                    let uri = resource
                        .get("uri")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();
                    parts.push(format!(
                        "<resource uri=\"{}\">{}</resource>",
                        escape_xml_attr(uri),
                        text
                    ));
                }
            }
            "resource_link" => {
                let uri = block
                    .get("uri")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let name = block
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                parts.push(format!(
                    "<resource_link uri=\"{}\" name=\"{}\" />",
                    escape_xml_attr(uri),
                    escape_xml_attr(name)
                ));
            }
            _ => {}
        }
    }
    parts.join("\n")
}

fn escape_xml_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_acp_initialize() {
        let server = AcpServer::in_memory().unwrap();
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": true } },
                "clientInfo": { "name": "zed", "version": "1.0.0" }
            }
        });

        let resp = server.handle_message(&req.to_string()).await.unwrap();
        assert_eq!(resp.id, Some(json!(1)));
        assert!(resp.error.is_none());
        let res = resp.result.unwrap();
        // ACP spec shape: numeric protocolVersion + camelCase capabilities.
        assert_eq!(res["protocolVersion"], 1);
        assert!(res.get("protocol_version").is_none());
        assert_eq!(res["agentCapabilities"]["loadSession"], true);
        assert_eq!(res["agentCapabilities"]["promptCapabilities"]["image"], false);
        assert_eq!(
            res["agentCapabilities"]["promptCapabilities"]["embeddedContext"],
            true
        );
        assert!(res["agentCapabilities"]["sessionCapabilities"]["list"].is_object());
        assert_eq!(res["agentCapabilities"]["mcpCapabilities"]["http"], true);
        assert_eq!(res["authMethods"][0]["id"], "login");
        assert_eq!(res["authMethods"][0]["type"], "terminal");
        assert_eq!(res["authMethods"][0]["args"], json!(["--login"]));
        assert_eq!(res["agentInfo"]["name"], "kimi-agent-rust");
    }

    /// A client below the minimum revision still receives the server's current
    /// one (v2 `negotiateVersion`, version.ts:38-41).
    #[tokio::test]
    async fn test_acp_initialize_negotiates_version() {
        let server = AcpServer::in_memory().unwrap();
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": 0 }
        });
        let resp = server.handle_message(&req.to_string()).await.unwrap();
        assert_eq!(resp.result.unwrap()["protocolVersion"], 1);
    }

    /// Notifications carry no id and must never be answered
    /// (v2 registers `session/cancel` as `onNotification`, server.ts:717).
    #[tokio::test]
    async fn test_acp_notification_is_not_answered() {
        let server = AcpServer::in_memory().unwrap();
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": "sess-1" }
        });
        assert!(server.handle_message(&notification.to_string()).await.is_none());

        // Unknown notifications are dropped silently too.
        let unknown = json!({
            "jsonrpc": "2.0",
            "method": "no/such/notification",
            "params": {}
        });
        assert!(server.handle_message(&unknown.to_string()).await.is_none());

        // The same cancel sent as a request still gets an answer.
        let request = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "session/cancel",
            "params": { "sessionId": "sess-1" }
        });
        let resp = server.handle_message(&request.to_string()).await.unwrap();
        assert_eq!(resp.id, Some(json!(9)));
    }

    /// `session/new` advertises the canonical four modes (`modes.ts:24-46`).
    #[tokio::test]
    async fn test_acp_new_session_advertises_modes() {
        let server = AcpServer::in_memory().unwrap();
        let req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "cwd": "/tmp/workspace" }
        });
        let resp = server.handle_message(&req.to_string()).await.unwrap();
        let res = resp.result.unwrap();
        assert!(res["sessionId"].is_string());
        assert_eq!(res["modes"]["currentModeId"], "default");
        let available = res["modes"]["availableModes"].as_array().unwrap();
        assert_eq!(available.len(), 4);
        assert_eq!(available[0]["id"], "default");
        assert_eq!(available[3]["id"], "yolo");
    }

    /// ACP clients send `prompt` as `ContentBlock[]`; text, text resources and
    /// resource links survive, audio/image blocks are dropped
    /// (v2 `acpBlocksToContentParts`, convert.ts:26-78).
    #[tokio::test]
    async fn test_acp_prompt_accepts_content_blocks() {
        let server = AcpServer::in_memory().unwrap();
        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let sid = server.handle_message(&new_req.to_string()).await.unwrap().result.unwrap()
            ["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let prompt_req = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/prompt",
            "params": {
                "sessionId": sid,
                "prompt": [
                    { "type": "text", "text": "look at this" },
                    {
                        "type": "resource",
                        "resource": { "uri": "file:///tmp/a.txt", "text": "body" }
                    },
                    { "type": "resource_link", "uri": "file:///tmp/b.txt", "name": "b" },
                    { "type": "image", "mimeType": "image/png", "data": "AAAA" }
                ]
            }
        });
        let resp = server
            .handle_message(&prompt_req.to_string())
            .await
            .unwrap();
        assert!(resp.error.is_none(), "prompt blocks must be accepted");

        let history = server.store.load_session_history(&sid).unwrap();
        assert_eq!(
            history[0].content,
            "look at this\n<resource uri=\"file:///tmp/a.txt\">body</resource>\n\
             <resource_link uri=\"file:///tmp/b.txt\" name=\"b\" />"
        );
    }

    #[tokio::test]
    async fn test_acp_session_flow() {
        let server = AcpServer::in_memory().unwrap();

        // 1. Create session
        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "title": "ACP Test Session" }
        });
        let resp = server.handle_message(&new_req.to_string()).await.unwrap();
        let sid = resp.result.unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        // 2. List sessions
        let list_req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/list",
        });
        let resp = server.handle_message(&list_req.to_string()).await.unwrap();
        let sessions = resp.result.unwrap()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["session_id"], sid);

        // 3. Prompt session
        let prompt_req = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/prompt",
            "params": {
                "sessionId": sid,
                "prompt": "Hello ACP"
            }
        });
        let resp = server
            .handle_message(&prompt_req.to_string())
            .await
            .unwrap();
        assert!(resp.error.is_none());
        let res = resp.result.unwrap();
        assert_eq!(res["stopReason"], "end_turn");

        // 4. Load session history
        let load_req = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "session/load",
            "params": { "sessionId": sid }
        });
        let resp = server.handle_message(&load_req.to_string()).await.unwrap();
        assert!(resp.error.is_none());
        let messages = resp.result.unwrap()["messages"].as_array().unwrap().clone();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], "Hello ACP");

        // 5. Set mode
        let mode_req = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "session/set_mode",
            "params": { "mode": "yolo" }
        });
        let resp = server.handle_message(&mode_req.to_string()).await.unwrap();
        assert_eq!(resp.result.unwrap()["mode"], "yolo");

        // 6. Delete session
        let del_req = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/delete",
            "params": { "sessionId": sid }
        });
        let resp = server.handle_message(&del_req.to_string()).await.unwrap();
        assert_eq!(resp.result.unwrap()["deleted"], true);
    }
}
