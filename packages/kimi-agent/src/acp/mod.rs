//! Native ACP (Agent Client Protocol) types and request dispatch — a
//! transport-free scaffold, not a servable ACP endpoint.
//!
//! `AcpServer::handle_message` speaks the JSON-RPC 2.0 envelope (parse
//! error / invalid request / method not found) and answers `initialize`,
//! `session/new`, `session/list` and `ping` against `SqliteSessionStore`.
//! What it does not do: `session/prompt` returns a canned
//! `Response to: {prompt}` and never runs a turn; the advertised
//! capabilities are constants with no notification path behind them; no
//! stdio or TCP loop owns this dispatcher; and nothing outside this file's
//! tests constructs it. The ACP surface the CLI actually serves is still
//! the TypeScript `@moonshot-ai/acp-server`
//! (`apps/kimi-code/src/cli/sub/acp-native.ts:63`).

pub mod types;

use std::sync::Arc;
use serde_json::json;

use crate::acp::types::{
    AcpAgentInfo, AcpCapabilities, AcpInitializeResult, JsonRpcRequest, JsonRpcResponse,
};
use crate::session::sqlite_store::SqliteSessionStore;
use crate::turn_loop::types::LLMMessage;

pub struct AcpServer {
    store: Arc<SqliteSessionStore>,
}

impl AcpServer {
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self { store }
    }

    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let store = Arc::new(SqliteSessionStore::in_memory()?);
        Ok(Self::new(store))
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

        let resp = match req.method.as_str() {
            "initialize" => {
                let res = AcpInitializeResult {
                    protocol_version: "0.1.0".into(),
                    agent_info: AcpAgentInfo {
                        name: "kimi-agent-rust".into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                    },
                    capabilities: AcpCapabilities {
                        sessions: true,
                        tools: true,
                        streaming: true,
                    },
                };
                JsonRpcResponse::success(req.id, json!(res))
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
                        json!({ "sessionId": session_id, "title": title }),
                    ),
                    Err(e) => JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}")),
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
                    .and_then(|v| v.as_str());

                match (session_id, prompt) {
                    (Some(sid), Some(p)) => {
                        let turn_id = format!("turn-{}", fastrand::u64(..));
                        let msgs = vec![
                            LLMMessage::user(p),
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
                    _ => JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: sessionId and prompt are required",
                    ),
                }
            }
            "ping" => JsonRpcResponse::success(req.id, json!("pong")),
            _ => JsonRpcResponse::error(
                req.id,
                -32601,
                format!("Method not found: {}", req.method),
            ),
        };

        Some(resp)
    }
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
                "protocol_version": "0.1.0",
                "client_info": { "name": "zed", "version": "1.0.0" }
            }
        });

        let resp = server.handle_message(&req.to_string()).await.unwrap();
        assert_eq!(resp.id, Some(json!(1)));
        assert!(resp.error.is_none());
        let res = resp.result.unwrap();
        assert_eq!(res["agent_info"]["name"], "kimi-agent-rust");
        assert_eq!(res["capabilities"]["streaming"], true);
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
        let sid = resp.result.unwrap()["sessionId"].as_str().unwrap().to_string();

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
        let resp = server.handle_message(&prompt_req.to_string()).await.unwrap();
        assert!(resp.error.is_none());
        let res = resp.result.unwrap();
        assert_eq!(res["stopReason"], "end_turn");
    }
}
