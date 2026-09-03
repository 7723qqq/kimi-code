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
pub mod static_files;
pub mod ws;
pub mod ws_protocol;

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::cron::scheduler::{CronEntry, CronScheduler};
use crate::server::auth::ServerAuth;
use crate::server::engine::ServerEngine;
use crate::server::hub::EventHub;
use crate::server::router::{HttpRequest, HttpResponse};
use crate::session::sqlite_store::SqliteSessionStore;
use crate::storage::task_runner::TaskRunner;

pub struct HttpServer {
    store: Arc<SqliteSessionStore>,
    hub: Arc<EventHub>,
    engine: Option<Arc<ServerEngine>>,
    auth: ServerAuth,
    heartbeat: Duration,
    cron_scheduler: Arc<Mutex<CronScheduler>>,
    task_runner: Arc<TaskRunner>,
    server_id: String,
    started_at: String,
    web_assets_dir: Option<PathBuf>,
}

impl HttpServer {
    /// A server over its own event hub.
    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self::with_hub(store, Arc::new(EventHub::new()))
    }

    /// A server that shares an existing [`EventHub`], so a turn driven from
    /// elsewhere and the WebSocket fan-out see one numbering per session.
    /// Unauthenticated. Fine for tests and for a loopback development run; the
    /// only product entry (`--serve`) replaces this with a real token, and
    /// [`http::serve`] refuses a non-loopback bind while it is in effect.
    pub fn with_hub(store: Arc<SqliteSessionStore>, hub: Arc<EventHub>) -> Self {
        Self {
            store,
            hub,
            engine: None,
            auth: ServerAuth::disabled(),
            heartbeat: crate::server::ws_protocol::DEFAULT_HEARTBEAT,
            cron_scheduler: Arc::new(Mutex::new(CronScheduler::new(Vec::new(), 0))),
            task_runner: Arc::new(TaskRunner::new(None)),
            server_id: format!("srv-{}", fastrand::u64(..)),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            web_assets_dir: None,
        }
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn started_at(&self) -> &str {
        &self.started_at
    }

    #[must_use]
    pub fn with_web_assets(mut self, path: impl Into<PathBuf>) -> Self {
        self.web_assets_dir = Some(path.into());
        self
    }

    pub fn web_assets_dir(&self) -> Option<&Path> {
        self.web_assets_dir.as_deref()
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

    /// Set the period of the JSON `ping` heartbeat each WebSocket connection
    /// sends. kap-server takes the same as `heartbeatIntervalMs`.
    #[must_use]
    pub fn with_heartbeat(mut self, heartbeat: Duration) -> Self {
        self.heartbeat = heartbeat;
        self
    }

    pub fn heartbeat(&self) -> Duration {
        self.heartbeat
    }

    /// Attach the turn driver, without which `POST /sessions/:id/prompt` has
    /// nothing to run a turn with and answers 503.
    pub fn with_engine(mut self, engine: ServerEngine) -> Self {
        self.engine = Some(Arc::new(engine));
        self
    }

    #[must_use]
    pub fn with_cron_scheduler(mut self, scheduler: Arc<Mutex<CronScheduler>>) -> Self {
        self.cron_scheduler = scheduler;
        self
    }

    pub fn cron_scheduler(&self) -> Arc<Mutex<CronScheduler>> {
        self.cron_scheduler.clone()
    }

    #[must_use]
    pub fn with_task_runner(mut self, task_runner: Arc<TaskRunner>) -> Self {
        self.task_runner = task_runner;
        self
    }

    pub fn task_runner(&self) -> Arc<TaskRunner> {
        self.task_runner.clone()
    }

    /// The session store, for a host that wants to read transcripts or share
    /// the same store with the engine it builds.
    pub fn store_arc(&self) -> Arc<SqliteSessionStore> {
        self.store.clone()
    }

    /// The fan-out handle connections attach to and turns publish through.
    pub fn hub(&self) -> Arc<EventHub> {
        self.hub.clone()
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

        // Static file serving and SPA fallback for non-API routes
        if !path.starts_with("/api")
            && (method == "GET" || method == "HEAD")
            && let Some(assets_dir) = &self.web_assets_dir
        {
            return static_files::serve_static_file(assets_dir, &req.path);
        }

        match (method.as_str(), path) {
            ("GET", "/api/v1/health") | ("GET", "/health") => HttpResponse::ok(&json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "engine": "kimi-agent-rust",
            })),
            ("GET", "/api/v1/meta") => {
                let dangerous_bypass_auth = self.auth.is_disabled();
                HttpResponse::ok(&json!({
                    "server_version": env!("CARGO_PKG_VERSION"),
                    "capabilities": {
                        "websocket": true,
                        "file_upload": true,
                        "fs_query": true,
                        "mcp": true,
                        "tasks": true,
                        "terminal": true,
                    },
                    "server_id": self.server_id,
                    "started_at": self.started_at,
                    "open_in_apps": [],
                    "dangerous_bypass_auth": dangerous_bypass_auth,
                    "backend": "rust",
                    "web_title": "Kimi Code",
                    "experimental_flags": {},
                }))
            }
            ("GET", "/api/v1/config") => HttpResponse::ok(&json!({
                "default_model": "kimi-latest",
                "providers": {},
                "models": {},
                "services": {},
            })),
            ("GET", "/api/v1/sessions") => match self.store.list_sessions() {
                Ok(sessions) => HttpResponse::ok(&json!({ "sessions": sessions })),
                Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
            },
            // Cron endpoints: session-scoped or global
            ("GET", p)
                if (p.starts_with("/api/v1/sessions/") && p.ends_with("/cron"))
                    || p == "/api/v1/cron" =>
            {
                if p != "/api/v1/cron" {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                }
                let scheduler = self.cron_scheduler.lock().await;
                let entries = scheduler.list_entries();
                HttpResponse::ok(&json!({ "entries": entries }))
            }
            ("POST", p)
                if (p.starts_with("/api/v1/sessions/") && p.ends_with("/cron"))
                    || p == "/api/v1/cron" =>
            {
                if p != "/api/v1/cron" {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                }
                let body: Value = match serde_json::from_slice(&req.body) {
                    Ok(v) => v,
                    Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                };
                let cron_expr = match body.get("cron").and_then(|v| v.as_str()) {
                    Some(c) if !c.trim().is_empty() => c.trim(),
                    _ => return HttpResponse::bad_request("Field 'cron' is required"),
                };
                let prompt = match body.get("prompt").and_then(|v| v.as_str()) {
                    Some(p) if !p.trim().is_empty() => p.trim(),
                    _ => return HttpResponse::bad_request("Field 'prompt' is required"),
                };
                let id = body
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("cron-{}", fastrand::u64(..)));
                let recurring = body
                    .get("recurring")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let entry = CronEntry {
                    id: id.clone(),
                    cron: cron_expr.to_string(),
                    prompt: prompt.to_string(),
                    recurring,
                };
                let mut scheduler = self.cron_scheduler.lock().await;
                if scheduler.add_entry(entry) {
                    HttpResponse::json(
                        201,
                        &json!({
                            "id": id,
                            "cron": cron_expr,
                            "prompt": prompt,
                            "recurring": recurring
                        }),
                    )
                } else {
                    HttpResponse::bad_request("Invalid cron expression")
                }
            }
            ("DELETE", p)
                if (p.starts_with("/api/v1/sessions/") && p.contains("/cron/"))
                    || p.starts_with("/api/v1/cron/") =>
            {
                let task_id = if p.starts_with("/api/v1/cron/") {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 5 {
                        return HttpResponse::not_found();
                    }
                    segments[4]
                } else {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 7 || segments[5] != "cron" {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                    segments[6]
                };
                let mut scheduler = self.cron_scheduler.lock().await;
                if scheduler.remove_entry(task_id) {
                    HttpResponse::ok(&json!({ "deleted": true, "taskId": task_id }))
                } else {
                    HttpResponse::not_found()
                }
            }

            // Tasks endpoints: session-scoped or global
            ("GET", p)
                if (p.starts_with("/api/v1/sessions/") && p.ends_with("/tasks"))
                    || p == "/api/v1/tasks" =>
            {
                if p != "/api/v1/tasks" {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                }
                let tasks = self.task_runner.list();
                HttpResponse::ok(&json!({ "tasks": tasks }))
            }
            ("GET", p)
                if (p.starts_with("/api/v1/sessions/")
                    && p.contains("/tasks/")
                    && !p.ends_with("/stop"))
                    || (p.starts_with("/api/v1/tasks/") && !p.ends_with("/stop")) =>
            {
                let task_id = if p.starts_with("/api/v1/tasks/") {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 5 {
                        return HttpResponse::not_found();
                    }
                    segments[4]
                } else {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 7 || segments[5] != "tasks" {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                    segments[6]
                };
                match self.task_runner.entry(task_id) {
                    Some(entry) => HttpResponse::ok(&json!({ "task": entry })),
                    None => HttpResponse::not_found(),
                }
            }
            ("POST", p)
                if (p.starts_with("/api/v1/sessions/")
                    && p.contains("/tasks/")
                    && p.ends_with("/stop"))
                    || (p.starts_with("/api/v1/tasks/") && p.ends_with("/stop")) =>
            {
                let task_id = if p.starts_with("/api/v1/tasks/") {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 6 {
                        return HttpResponse::not_found();
                    }
                    segments[4]
                } else {
                    let segments: Vec<&str> = p.split('/').collect();
                    if segments.len() != 8 || segments[5] != "tasks" {
                        return HttpResponse::not_found();
                    }
                    let session_id = segments[4];
                    if self.store.get_session(session_id).ok().flatten().is_none() {
                        return HttpResponse::not_found();
                    }
                    segments[6]
                };
                match self.task_runner.stop(task_id).await {
                    Ok(wire) => HttpResponse::ok(&json!({ "stopped": true, "task": wire })),
                    Err(_) => HttpResponse::not_found(),
                }
            }

            // Session sub-resources: status, abort, fork
            ("GET", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/status") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let busy = self
                    .engine
                    .as_ref()
                    .map(|e| e.is_busy(session_id))
                    .unwrap_or(false);
                let history = self
                    .store
                    .load_session_history(session_id)
                    .unwrap_or_default();
                let context_tokens: usize = history.iter().map(|m| m.content.len() / 4).sum();
                HttpResponse::ok(&json!({
                    "busy": busy,
                    "model": "kimi-latest",
                    "thinking_level": "medium",
                    "permission": "auto",
                    "plan_mode": false,
                    "swarm_mode": false,
                    "tower_mode": false,
                    "context_tokens": context_tokens,
                }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/abort") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let aborted = self
                    .engine
                    .as_ref()
                    .map(|e| e.cancel_turn(session_id))
                    .unwrap_or(false);
                HttpResponse::ok(&json!({ "aborted": aborted, "sessionId": session_id }))
            }
            ("POST", p) if p.starts_with("/api/v1/sessions/") && p.ends_with("/fork") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 6 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                if self.store.get_session(session_id).ok().flatten().is_none() {
                    return HttpResponse::not_found();
                }
                let body: Value = if req.body.is_empty() {
                    json!({})
                } else {
                    match serde_json::from_slice(&req.body) {
                        Ok(v) => v,
                        Err(_) => return HttpResponse::bad_request("Invalid JSON payload"),
                    }
                };
                let new_session_id = format!("sess-{}", fastrand::u64(..));
                let title = body.get("title").and_then(|v| v.as_str());

                match self.store.fork_session(session_id, &new_session_id, title) {
                    Ok(true) => HttpResponse::json(
                        201,
                        &json!({
                            "sessionId": new_session_id,
                            "sourceSessionId": session_id,
                            "title": title
                        }),
                    ),
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }

            ("GET", p) if p.starts_with("/api/v1/sessions/") && !p.ends_with("/prompt") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 5 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                match self.store.get_session(session_id) {
                    Ok(Some(session)) => {
                        let history = self
                            .store
                            .load_session_history(session_id)
                            .unwrap_or_default();
                        HttpResponse::ok(&json!({
                            "session": session,
                            "messages": history,
                        }))
                    }
                    Ok(None) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
            ("DELETE", p) if p.starts_with("/api/v1/sessions/") && !p.ends_with("/prompt") => {
                let segments: Vec<&str> = p.split('/').collect();
                if segments.len() != 5 {
                    return HttpResponse::not_found();
                }
                let session_id = segments[4];
                match self.store.delete_session(session_id) {
                    Ok(true) => {
                        HttpResponse::ok(&json!({ "deleted": true, "sessionId": session_id }))
                    }
                    Ok(false) => HttpResponse::not_found(),
                    Err(e) => HttpResponse::internal_error(format!("Database error: {e}")),
                }
            }
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

        // 4. Get specific session
        let req_get = HttpRequest {
            method: "GET".into(),
            path: format!("/api/v1/sessions/{sid}"),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_get = server.handle_request(&req_get).await;
        assert_eq!(res_get.status, 200);
        let val_get: Value = serde_json::from_slice(&res_get.body).unwrap();
        assert_eq!(val_get["session"]["session_id"], sid);
        assert_eq!(val_get["session"]["title"], "Web REST Test");

        // 5. Delete session
        let req_del = HttpRequest {
            method: "DELETE".into(),
            path: format!("/api/v1/sessions/{sid}"),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let res_del = server.handle_request(&req_del).await;
        assert_eq!(res_del.status, 200);
        let val_del: Value = serde_json::from_slice(&res_del.body).unwrap();
        assert_eq!(val_del["deleted"], true);

        // 6. Verify deleted
        let res_get_after = server.handle_request(&req_get).await;
        assert_eq!(res_get_after.status, 404);
    }

    fn engine_without_a_model(store: Arc<SqliteSessionStore>, hub: Arc<EventHub>) -> ServerEngine {
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
                caller_agent_id: None,
                session_id: None,
            },
            hub,
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
        let server = server.with_engine(engine_without_a_model(store, hub));

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
        let server = server.with_engine(engine_without_a_model(store, hub));

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

    #[tokio::test]
    async fn test_http_cron_endpoints() {
        let server = HttpServer::in_memory().unwrap();
        let created = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions".into(),
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "title": "cron-test" })).unwrap(),
            })
            .await;
        let sid = serde_json::from_slice::<Value>(&created.body).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        // 1. Initial list is empty
        let res_list = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{sid}/cron"),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list.status, 200);
        let val_list: Value = serde_json::from_slice(&res_list.body).unwrap();
        assert_eq!(val_list["entries"].as_array().unwrap().len(), 0);

        // 2. Add invalid cron expression -> 400 Bad Request
        let res_bad = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/cron"),
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "cron": "invalid cron",
                    "prompt": "do something"
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_bad.status, 400);

        // 3. Add valid cron entry
        let res_add = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: format!("/api/v1/sessions/{sid}/cron"),
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({
                    "id": "c1",
                    "cron": "0 9 * * *",
                    "prompt": "daily report",
                    "recurring": true
                }))
                .unwrap(),
            })
            .await;
        assert_eq!(res_add.status, 201);
        let val_add: Value = serde_json::from_slice(&res_add.body).unwrap();
        assert_eq!(val_add["id"], "c1");

        // 4. List again contains entry (test global route)
        let res_list2 = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/cron".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list2.status, 200);
        let val_list2: Value = serde_json::from_slice(&res_list2.body).unwrap();
        assert_eq!(val_list2["entries"].as_array().unwrap().len(), 1);

        // 5. Delete cron entry
        let res_del = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/sessions/{sid}/cron/c1"),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_del.status, 200);

        // 6. Delete non-existent cron entry -> 404
        let res_del_missing = server
            .handle_request(&HttpRequest {
                method: "DELETE".into(),
                path: format!("/api/v1/sessions/{sid}/cron/c1"),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_del_missing.status, 404);
    }

    #[tokio::test]
    async fn test_http_tasks_endpoints() {
        let server = HttpServer::in_memory().unwrap();
        let runner = server.task_runner();

        // Spawn a background task
        runner
            .spawn_task("task-1".into(), "test task".into(), async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                "task output".into()
            })
            .unwrap();

        // 1. List tasks
        let res_list = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/tasks".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_list.status, 200);
        let val_list: Value = serde_json::from_slice(&res_list.body).unwrap();
        let tasks = val_list["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["taskId"], "task-1");

        // 2. Get single task
        let res_get = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/tasks/task-1".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_get.status, 200);
        let val_get: Value = serde_json::from_slice(&res_get.body).unwrap();
        assert_eq!(val_get["task"]["taskId"], "task-1");

        // 3. Stop task
        let res_stop = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/tasks/task-1/stop".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_stop.status, 200);
        let val_stop: Value = serde_json::from_slice(&res_stop.body).unwrap();
        assert_eq!(val_stop["stopped"], true);

        // 4. Missing task -> 404
        let res_missing = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/tasks/non-existent".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing.status, 404);
    }

    #[tokio::test]
    async fn test_http_meta_and_config_endpoints() {
        let server = HttpServer::in_memory().unwrap();

        // 1. Meta endpoint
        let res_meta = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/meta".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_meta.status, 200);
        let val_meta: Value = serde_json::from_slice(&res_meta.body).unwrap();
        assert_eq!(val_meta["backend"], "rust");
        assert_eq!(val_meta["capabilities"]["websocket"], true);
        assert_eq!(val_meta["capabilities"]["tasks"], true);
        assert!(val_meta["server_id"].as_str().unwrap().starts_with("srv-"));
        assert!(val_meta["started_at"].as_str().is_some());

        // 2. Config endpoint
        let res_cfg = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/config".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cfg.status, 200);
        let val_cfg: Value = serde_json::from_slice(&res_cfg.body).unwrap();
        assert_eq!(val_cfg["default_model"], "kimi-latest");
        assert!(val_cfg["providers"].is_object());
    }

    #[tokio::test]
    async fn test_http_session_status_abort_and_fork() {
        let server = HttpServer::in_memory().unwrap();
        server
            .store_arc()
            .create_session("sess-test", Some("Original Session"))
            .unwrap();

        // 1. Session status
        let res_status = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/sess-test/status".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_status.status, 200);
        let val_status: Value = serde_json::from_slice(&res_status.body).unwrap();
        assert_eq!(val_status["busy"], false);
        assert_eq!(val_status["permission"], "auto");

        // 2. Abort when no active turn -> false
        let res_abort = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-test/abort".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_abort.status, 200);
        let val_abort: Value = serde_json::from_slice(&res_abort.body).unwrap();
        assert_eq!(val_abort["aborted"], false);

        // 3. Fork session
        let res_fork = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/sess-test/fork".into(),
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!({ "title": "Forked Branch" })).unwrap(),
            })
            .await;
        assert_eq!(res_fork.status, 201);
        let val_fork: Value = serde_json::from_slice(&res_fork.body).unwrap();
        let new_sid = val_fork["sessionId"].as_str().unwrap();
        assert_eq!(val_fork["sourceSessionId"], "sess-test");
        assert_eq!(val_fork["title"], "Forked Branch");

        // Forked session can be queried
        let res_forked_status = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: format!("/api/v1/sessions/{new_sid}/status"),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_forked_status.status, 200);

        // 4. Missing session on status/abort/fork -> 404
        let res_missing_status = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/sessions/non-existent/status".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_status.status, 404);

        let res_missing_abort = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/non-existent/abort".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_abort.status, 404);

        let res_missing_fork = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/sessions/non-existent/fork".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_missing_fork.status, 404);
    }

    #[tokio::test]
    async fn test_http_static_assets_and_spa_routing() {
        use std::fs::{self, File};
        use std::io::Write;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let index_path = dir.path().join("index.html");
        let mut f1 = File::create(&index_path).unwrap();
        f1.write_all(b"<!DOCTYPE html><html><body>Kimi Web UI</body></html>")
            .unwrap();

        let assets_dir = dir.path().join("assets");
        fs::create_dir(&assets_dir).unwrap();
        let js_path = assets_dir.join("index-123.js");
        let mut f2 = File::create(&js_path).unwrap();
        f2.write_all(b"console.log('web ui loaded');").unwrap();

        let server = HttpServer::in_memory().unwrap().with_web_assets(dir.path());

        // 1. Root / serves index.html
        let res_root = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_root.status, 200);
        assert_eq!(
            res_root.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            res_root.body,
            b"<!DOCTYPE html><html><body>Kimi Web UI</body></html>"
        );

        // 2. Static asset request
        let res_asset = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/assets/index-123.js".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_asset.status, 200);
        assert_eq!(
            res_asset.header("content-type"),
            Some("application/javascript; charset=utf-8")
        );
        assert_eq!(res_asset.body, b"console.log('web ui loaded');");

        // 3. SPA deep route fallback
        let res_spa = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/session/sess-abc".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_spa.status, 200);
        assert_eq!(
            res_spa.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            res_spa.body,
            b"<!DOCTYPE html><html><body>Kimi Web UI</body></html>"
        );

        // 4. API routes do not fallback to index.html
        let res_api = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/missing-route".into(),
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_api.status, 404);
    }
}
