//! Native HTTP REST request dispatcher for the Kimi Agent API surface.
//!
//! `HttpServer::handle_request` maps a handful of paths (`/health`,
//! `/api/v1/sessions`, `POST /api/v1/sessions/:id/prompt`) onto
//! `SqliteSessionStore`, and [`http::serve`] binds them to a real TCP listener.
//! The one product entry is `kimi-agent --serve <ADDR>`, which builds the store,
//! the engine and the [`ServerAuth`] credential and hands them to
//! [`http::serve`].
//!
//! What is still missing before this replaces `packages/kap-server`'s `/api/v1`:
//!
//! - the WebSocket connection fans out events but speaks no kap-server
//!   `/api/v1/ws` message schema, so a client written against that schema cannot
//!   drive it;
//! - responses are bare objects, not kap-server's `{code, msg, data, request_id}`
//!   envelope — the 401 is the only envelope-shaped route.
//!
//! The `/api/v1` surface the app actually serves is still `packages/kap-server`.

pub mod auth;
pub mod engine;
pub mod http;
pub mod hub;
pub mod router;
pub mod ws;

use serde_json::{Value, json};
use std::sync::Arc;

use crate::events::EventBus;
use crate::server::auth::ServerAuth;
use crate::server::engine::ServerEngine;
use crate::server::hub::EventHub;
use crate::server::router::{HttpRequest, HttpResponse};
use crate::session::sqlite_store::SqliteSessionStore;

pub struct HttpServer {
    store: Arc<SqliteSessionStore>,
    bus: Arc<EventBus>,
    engine: Option<Arc<ServerEngine>>,
    auth: ServerAuth,
}

impl HttpServer {
    /// A server over its own event bus.
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self::with_bus(store, Arc::new(EventBus::new()))
    }

    /// A server that publishes onto an existing bus, so a pipeline built
    /// elsewhere and the WebSocket fan-out share one event source.
    /// Unauthenticated. Fine for tests and for a loopback development run; the
    /// only product entry (`--serve`) replaces this with a real token, and
    /// [`http::serve`] refuses a non-loopback bind while it is in effect.
    pub fn with_bus(store: Arc<SqliteSessionStore>, bus: Arc<EventBus>) -> Self {
        Self {
            store,
            bus,
            engine: None,
            auth: ServerAuth::disabled(),
        }
    }

    /// Require `Authorization: Bearer <token>` (and the WebSocket subprotocol
    /// equivalent) on every non-bypassed route.
    #[must_use]
    pub fn with_auth(mut self, auth: ServerAuth) -> Self {
        self.auth = auth;
        self
    }

    pub fn auth(&self) -> &ServerAuth {
        &self.auth
    }

    /// Attach the turn driver, without which `POST /sessions/:id/prompt` has
    /// nothing to run a turn with and answers 503.
    pub fn with_engine(mut self, engine: ServerEngine) -> Self {
        self.engine = Some(Arc::new(engine));
        self
    }

    /// The session store, for a host that wants to read transcripts or share
    /// the same store with the engine it builds.
    pub fn store_arc(&self) -> Arc<SqliteSessionStore> {
        self.store.clone()
    }

    /// The fan-out handle connections attach to.
    pub fn hub(&self) -> EventHub {
        EventHub::new(self.bus.clone())
    }

    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let store = Arc::new(SqliteSessionStore::in_memory()?);
        Ok(Self::new(store))
    }

    /// Dispatch an incoming HTTP request to the appropriate route handler.
    pub async fn handle_request(&self, req: &HttpRequest) -> HttpResponse {
        let path = req.path.trim_end_matches('/');
        let method = req.method.to_uppercase();

        // The one REST authority: health and the schema documents answer
        // unauthenticated, matching kap-server, and everything that can read or
        // mutate state does not.
        if !ServerAuth::is_bypassed(&method, path) {
            let decision = self.auth.check_bearer(req.header("authorization"));
            if !decision.is_allowed() {
                return HttpResponse::unauthorized("Unauthorized");
            }
        }

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
                    Ok(_) => {
                        HttpResponse::json(201, &json!({ "sessionId": session_id, "title": title }))
                    }
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

                let Some(engine) = self.engine.as_ref() else {
                    // No engine attached. Refusing is the honest answer: this
                    // route used to reply `Processed: {prompt}` without running
                    // anything, which a client cannot tell from a real turn.
                    return HttpResponse::json(
                        503,
                        &json!({ "error": "no engine configured for this server" }),
                    );
                };

                let known = self
                    .store
                    .list_sessions()
                    .map(|sessions| sessions.iter().any(|s| s.session_id == session_id))
                    .unwrap_or(false);
                if !known {
                    return HttpResponse::not_found();
                }

                let history = match self.store.load_session_history(session_id) {
                    Ok(messages) => messages,
                    Err(error) => return HttpResponse::internal_error(error.to_string()),
                };
                let turn_number = match self.store.next_turn_number(session_id) {
                    Ok(number) => number,
                    Err(error) => return HttpResponse::internal_error(error.to_string()),
                };

                match engine
                    .run_turn(session_id, turn_number, history, prompt)
                    .await
                {
                    Ok(report) => HttpResponse::ok(&json!({
                        "sessionId": session_id,
                        "turnId": report.turn_id,
                        "turnNumber": turn_number,
                        "status": "completed",
                        "stopReason": report.stop_reason,
                        "content": report.reply,
                        "steps": report.steps,
                        "llmTransport": report.llm_transport,
                        "eventsEmitted": report.events_emitted,
                        "nativeToolCalls": report.native_tool_calls,
                        "usage": report.usage,
                    })),
                    Err(error) => HttpResponse::internal_error(error.to_string()),
                }
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
        // No engine attached: refuse. This route used to answer
        // `Processed: {prompt}` with status 200, which a client could not tell
        // apart from a real turn.
        let res_prompt = server.handle_request(&req_prompt).await;
        assert_eq!(res_prompt.status, 503);
        let val_prompt: Value = serde_json::from_slice(&res_prompt.body).unwrap();
        assert!(
            val_prompt["error"]
                .as_str()
                .unwrap_or_default()
                .contains("no engine"),
            "{val_prompt}"
        );
        assert!(
            !String::from_utf8_lossy(&res_prompt.body).contains("Processed:"),
            "the canned reply is still being served"
        );
    }

    fn engine_without_a_model(store: Arc<SqliteSessionStore>, hub: &EventHub) -> ServerEngine {
        ServerEngine::new(
            crate::pipeline::PipelineSpec {
                system_prompt: "sys".into(),
                model_name: "test-model".into(),
                providers: Vec::new(),
                native_llm: None,
                workspace_root: None,
                native_tools: false,
                rust_self_contained: false,
                shell_path: None,
                policy_snapshot: None,
                github_token: None,
                github_base_url: None,
                subagent_timeout_ms: None,
                agent_tool_veto: None,
                tools_veto: None,
            },
            hub.clone(),
            store,
        )
    }

    async fn prompt(server: &HttpServer, session_id: &str) -> HttpResponse {
        server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{session_id}/prompt"),
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "prompt": "Hello REST" })).unwrap(),
            })
            .await
    }

    #[tokio::test]
    async fn the_prompt_route_reaches_the_engine_and_reports_its_failure() {
        let server = HttpServer::in_memory().unwrap();
        let sid = {
            let created = server
                .handle_request(&HttpRequest {
                    method: "POST".into(),
                    path: "/api/v1/sessions".into(),
                    headers: HashMap::new(),
                    body: serde_json::to_vec(&json!({ "title": "wired" })).unwrap(),
                })
                .await;
            let body: Value = serde_json::from_slice(&created.body).unwrap();
            body["sessionId"].as_str().unwrap().to_string()
        };

        let hub = server.hub();
        let store = server.store_arc();
        let server = server.with_engine(engine_without_a_model(store, &hub));

        // No providers and no native_llm: the pipeline refuses to build, which
        // must surface as a server error naming the cause — not a fake 200.
        let response = prompt(&server, &sid).await;
        let body = String::from_utf8_lossy(&response.body).into_owned();
        assert_eq!(response.status, 500, "{body}");
        assert!(body.contains("rustSelfContained"), "{body}");
    }

    #[tokio::test]
    async fn an_unknown_session_gets_404_rather_than_a_turn() {
        let server = HttpServer::in_memory().unwrap();
        let hub = server.hub();
        let store = server.store_arc();
        let server = server.with_engine(engine_without_a_model(store, &hub));

        let response = prompt(&server, "sess-does-not-exist").await;
        assert_eq!(response.status, 404);
    }

    #[tokio::test]
    async fn turn_numbers_advance_from_the_stored_turns() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        store.create_session("s1", None).unwrap();
        assert_eq!(store.next_turn_number("s1").unwrap(), 1);
        store
            .save_turn(
                "s1",
                "t1",
                1,
                &[crate::turn_loop::types::LLMMessage::user("hi")],
                None,
            )
            .unwrap();
        assert_eq!(store.next_turn_number("s1").unwrap(), 2);
        assert_eq!(store.next_turn_number("missing").unwrap(), 1);
    }
}
