//! Native HTTP REST request dispatcher for the Kimi Agent API surface.
//!
//! `HttpServer::handle_request` maps a handful of paths (`/health`,
//! `/api/v1/sessions`, `POST /api/v1/sessions/:id/prompt`) onto
//! `SqliteSessionStore`, and [`http::serve`] binds them to a real TCP listener.
//! What is still missing before this is a servable API:
//!
//! - nothing in the product calls [`http::serve`] — no CLI subcommand or host
//!   entry constructs an `HttpServer` outside this module's tests;
//! - the prompt route returns a canned `Processed: {prompt}` and runs no turn.
//!   It can now be wired for real: the host-agnostic pipeline in
//!   [`crate::pipeline`] makes an engine context constructible without the
//!   stdio or napi host;
//! - WebSocket framing exists ([`ws`]: RFC 6455 handshake, frame codec,
//!   control frames, fragmentation) but is **not reachable in product** — the
//!   HTTP listener does not route an upgrade to it, and it speaks no
//!   kap-server `/api/v1/ws` message schema yet.
//!
//! The `/api/v1` surface the app actually serves is still `packages/kap-server`.

pub mod http;
pub mod router;
pub mod ws;

use std::sync::Arc;
use serde_json::{Value, json};

use crate::server::router::{HttpRequest, HttpResponse};
use crate::session::sqlite_store::SqliteSessionStore;
use crate::turn_loop::types::LLMMessage;

pub struct HttpServer {
    store: Arc<SqliteSessionStore>,
}

impl HttpServer {
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self { store }
    }

    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let store = Arc::new(SqliteSessionStore::in_memory()?);
        Ok(Self::new(store))
    }

    /// Dispatch an incoming HTTP request to the appropriate route handler.
    pub async fn handle_request(&self, req: &HttpRequest) -> HttpResponse {
        let path = req.path.trim_end_matches('/');
        let method = req.method.to_uppercase();

        match (method.as_str(), path) {
            ("GET", "/api/v1/health") | ("GET", "/health") => HttpResponse::ok(&json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "engine": "kimi-agent-rust",
            })),
            ("GET", "/api/v1/sessions") => match self.store.list_sessions() {
                Ok(sessions) => HttpResponse::ok(&json!({ "sessions": sessions })),
                Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
            },
            ("POST", "/api/v1/sessions") => {
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let session_id = format!("sess-{}", fastrand::u64(..));
                let title = body.get("title").and_then(|v| v.as_str());

                match self.store.create_session(&session_id, title) {
                    Ok(_) => HttpResponse::json(
                        201,
                        &json!({ "sessionId": session_id, "title": title }),
                    ),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/prompt") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];

                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let prompt = match body.get("prompt").and_then(|v| v.as_str()) {
                    Some(p) => p,
                    None => return HttpResponse::bad_request("Missing 'prompt' field in payload"),
                };

                let turn_id = format!("turn-{}", fastrand::u64(..));
                let msgs = vec![
                    LLMMessage::user(prompt),
                    LLMMessage::assistant(format!("Processed: {prompt}")),
                ];
                let _ = self.store.save_turn(session_id, &turn_id, 1, &msgs, None);

                HttpResponse::ok(&json!({
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "status": "completed",
                    "content": format!("Processed: {prompt}")
                }))
            }
            _ => HttpResponse::not_found(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_http_health_endpoint() {
        let server = HttpServer::in_memory().unwrap();
        let req = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/health".into(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res = server.handle_request(&req).await;
        assert_eq!(res.status, 200);
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(val["status"], "ok");
        assert_eq!(val["engine"], "kimi-agent-rust");
    }

    #[tokio::test]
    async fn test_http_sessions_crud_and_prompt() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Create session
        let req_create = HttpRequest {
            method: "POST".into(),
            path: "/api/v1/sessions".into(),
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({ "title": "Web REST Test" })).unwrap(),
        };
        let res_create = server.handle_request(&req_create).await;
        assert_eq!(res_create.status, 201);
        let val_create: Value = serde_json::from_slice(&res_create.body).unwrap();
        let sid = val_create["sessionId"].as_str().unwrap();

        // 2. List sessions
        let req_list = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/sessions".into(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_list = server.handle_request(&req_list).await;
        assert_eq!(res_list.status, 200);
        let val_list: Value = serde_json::from_slice(&res_list.body).unwrap();
        assert_eq!(val_list["sessions"].as_array().unwrap().len(), 1);

        // 3. Prompt session
        let req_prompt = HttpRequest {
            method: "POST".into(),
            path: format!("/api/v1/sessions/{sid}/prompt"),
            headers: HashMap::new(),
            body: serde_json::to_vec(&json!({ "prompt": "Hello REST" })).unwrap(),
        };
        let res_prompt = server.handle_request(&req_prompt).await;
        assert_eq!(res_prompt.status, 200);
        let val_prompt: Value = serde_json::from_slice(&res_prompt.body).unwrap();
        assert_eq!(val_prompt["status"], "completed");
    }
}
