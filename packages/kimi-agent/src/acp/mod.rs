//! Native ACP (Agent Client Protocol) dispatcher.
//!
//! `AcpServer::handle_message` speaks the JSON-RPC 2.0 envelope (parse error /
//! invalid request / method not found, notifications never answered) and
//! answers the ACP handshake with the spec shape: numeric `protocolVersion`,
//! `agentCapabilities`, `authMethods` (types.rs). `session/prompt` runs a real
//! turn through `ServerEngine` when one is attached and accepts both the
//! string and the ACP `ContentBlock[]` prompt form.
//!
//! Outbound traffic goes through [`AcpChannel`]: `session/update`
//! notifications while a turn runs, plus server-initiated requests
//! (`session/request_permission`, see `permission.rs`).
//!
//! Still missing: the fs/terminal reverse RPCs and the auth gate.

pub mod channel;
pub mod events_map;
pub mod permission;
pub mod question;
pub mod types;

use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::acp::types::{
    AcpClientCapabilities, AcpInitializeParams, JsonRpcRequest, JsonRpcResponse, acp_modes,
    negotiate_protocol_version,
};
use crate::events::bus::{EventBus, Subscription};
use crate::mcp::manager::{McpServerOptions, McpServerRecipe};
use crate::session::sqlite_store::SqliteSessionStore;
use crate::turn_loop::types::LLMMessage;

pub use channel::{AcpChannel, AcpOutbound};

pub struct AcpServer {
    store: Arc<SqliteSessionStore>,
    engine: Option<Arc<crate::server::engine::ServerEngine>>,
    channel: AcpChannel,
    /// Current ACP mode per session (v2 `AcpSession.currentModeId`).
    modes: Mutex<HashMap<String, String>>,
    /// Client capabilities declared on `initialize` (drives which reverse
    /// RPCs — client fs / terminal — the agent may issue). Shared with the
    /// session host so an ACP-advertised fs can own Read/Write execution.
    client_capabilities: Arc<std::sync::Mutex<AcpClientCapabilities>>,
    /// Bypass the auth gate (v2 `disableAuth`, server.ts:110-114). The Rust
    /// engine has no runtime auth state, so the gate is "authed iff an engine
    /// (model) is attached"; tests and the no-engine dev path set this true.
    disable_auth: bool,
}

impl AcpServer {
    /// Bypass the auth gate (v2 `disableAuth`). The no-engine dev/test path
    /// (canned prompt, no native LLM) calls this so sessions are not refused.
    pub fn set_disable_auth(&mut self, value: bool) {
        self.disable_auth = value;
    }

    pub fn new(store: Arc<SqliteSessionStore>) -> Self {
        Self {
            store,
            engine: None,
            channel: AcpChannel::new(),
            modes: Mutex::new(HashMap::new()),
            client_capabilities: Arc::new(std::sync::Mutex::new(AcpClientCapabilities::default())),
            disable_auth: false,
        }
    }

    pub fn with_engine(
        store: Arc<SqliteSessionStore>,
        engine: Arc<crate::server::engine::ServerEngine>,
    ) -> Self {
        // Every turn of this engine asks the ACP client before executing a
        // mutating tool (v2 `interaction-bridge.ts` + `approval.ts`), and an
        // ACP client that advertises fs capabilities owns Read/Write (their
        // execution is forwarded to the client, v2 `fs-bridge.ts`).
        let channel = AcpChannel::new();
        let capabilities = Arc::new(std::sync::Mutex::new(AcpClientCapabilities::default()));
        let factory_channel = channel.clone();
        let factory_capabilities = capabilities.clone();
        engine.set_host_factory(Arc::new(move |session_id: &str| {
            Arc::new(permission::AcpPermissionHost::new(
                Arc::new(crate::server::engine::ServerHost::standalone()),
                factory_channel.clone(),
                session_id.to_string(),
                factory_capabilities.clone(),
            ))
        }));
        Self {
            store,
            engine: Some(engine),
            channel,
            modes: Mutex::new(HashMap::new()),
            client_capabilities: capabilities,
            disable_auth: false,
        }
    }

    /// The session's current ACP mode, defaulting to `default`.
    fn current_mode(&self, session_id: &str) -> String {
        self.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| "default".to_string())
    }

    /// Snapshot the ACP `SessionModeState` for a session.
    fn mode_state(&self, session_id: &str) -> serde_json::Value {
        json!({
            "currentModeId": self.current_mode(session_id),
            "availableModes": acp_modes(),
        })
    }

    /// Build the ACP `SessionConfigOption[]` surface advertised on
    /// `session/new` / `session/load` / `session/resume` / `session/fork`
    /// (v2 `buildSessionConfigOptions`, config-options.ts). This host has no
    /// model catalog, so the `model` arm is a single row for the engine's one
    /// model (empty when no engine is attached) and the `thinking` arm is
    /// omitted 鈥?its presence depends on a catalog row we do not have, and v2
    /// omits it when the model is not `thinkingSupported`. The `mode` arm
    /// projects the canonical four modes.
    fn config_options(&self, session_id: &str) -> serde_json::Value {
        let model_name = self
            .engine
            .as_ref()
            .map(|engine| engine.model_name().to_string())
            .unwrap_or_default();
        let model_option = json!({
            "type": "select",
            "id": "model",
            "name": "Model",
            "category": "model",
            "currentValue": model_name,
            "options": if model_name.is_empty() {
                json!([])
            } else {
                json!([{ "value": model_name, "name": model_name }])
            },
        });
        let mode_option = json!({
            "type": "select",
            "id": "mode",
            "name": "Mode",
            "category": "mode",
            "currentValue": self.current_mode(session_id),
            "options": acp_modes()
                .as_array()
                .map(|modes| {
                    modes
                        .iter()
                        .map(|mode| {
                            json!({
                                "value": mode["id"],
                                "name": mode["name"],
                                "description": mode["description"],
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        });
        json!([model_option, mode_option])
    }

    /// Auth gate (v2 `ensureAuthed`, server.ts:625-646): throws `auth_required`
    /// (`-32000`) unless authed or `disable_auth`. The Rust engine has no
    /// runtime auth state, so "authed" is exactly "an engine (model) is
    /// attached" 鈥?the no-engine path cannot run turns and is refused up front.
    fn ensure_authed(&self) -> Result<(), (i64, String)> {
        if self.disable_auth || self.engine.is_some() {
            Ok(())
        } else {
            Err((-32000, "Authentication required".to_string()))
        }
    }

    /// Install the outbound channel used for notifications and back-channel
    /// requests.
    pub fn set_notification_sink(&self, sender: tokio::sync::mpsc::UnboundedSender<AcpOutbound>) {
        self.channel.set_sink(sender);
    }

    /// The outbound channel (tests drive it directly).
    pub fn channel(&self) -> AcpChannel {
        self.channel.clone()
    }

    /// Capabilities the client declared on `initialize`.
    pub fn client_capabilities(&self) -> AcpClientCapabilities {
        self.client_capabilities
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Connect the `mcpServers` a client passed on `session/new`. Without an
    /// attached engine (or its MCP manager) there is nowhere to register them,
    /// so this is a no-op.
    async fn register_session_mcp_servers(&self, servers: &[serde_json::Value]) {
        let Some(manager) = self.engine.as_ref().and_then(|engine| engine.mcp_manager()) else {
            return;
        };
        for server in servers {
            let Some(name) = server.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(recipe) = acp_mcp_recipe(server) else {
                continue;
            };
            let _ = manager
                .configure(name, recipe, McpServerOptions::default())
                .await;
        }
    }

    /// Forward one session's engine events to ACP `session/update`
    /// notifications until the returned subscription is dropped
    /// (v2 `AcpSession` subscribes the agent event stream the same way).
    pub fn forward_session_events(&self, session_id: &str, bus: &Arc<EventBus>) -> Subscription {
        let channel = self.channel.clone();
        let session = session_id.to_string();
        bus.subscribe(move |event| {
            let Some(params) = events_map::engine_event_to_session_update(&session, event) else {
                return;
            };
            channel.notify("session/update", params);
        })
    }

    /// Dispatch one raw line. A response to a server-initiated request
    /// (`{"id":N,"result"鈥`) resolves the waiting back-channel call instead
    /// of being treated as a client request.
    pub async fn handle_line(&self, raw: &str) -> Option<JsonRpcResponse> {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw)
            && let Some(id) = AcpChannel::response_id(&value)
        {
            self.channel.resolve(id, value).await;
            return None;
        }
        self.handle_message(raw).await
    }

    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let store = Arc::new(SqliteSessionStore::in_memory()?);
        let mut server = Self::new(store);
        server.disable_auth = true;
        Ok(server)
    }

    /// Run the ACP server reading from stdin and writing to stdout. Responses
    /// and server-initiated notifications share one writer so their JSON lines
    /// never interleave.
    pub async fn run_stdio(&self) -> Result<(), std::io::Error> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AcpOutbound>();
        self.set_notification_sink(tx.clone());

        let writer = tokio::spawn(async move {
            let mut stdout = tokio::io::stdout();
            while let Some(message) = rx.recv().await {
                let value = match message {
                    AcpOutbound::Response(response) => serde_json::to_value(response),
                    AcpOutbound::Notification(notification) => serde_json::to_value(notification),
                    AcpOutbound::Request(request) => serde_json::to_value(request),
                };
                let Ok(value) = value else { continue };
                if stdout
                    .write_all(value.to_string().as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
                if stdout.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdout.flush().await;
            }
        });

        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();
        while let Some(line) = reader.next_line().await? {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(resp) = self.handle_line(trimmed).await {
                let _ = tx.send(AcpOutbound::Response(resp));
            }
        }
        // Drop the sink's clone too, otherwise the writer task never ends.
        self.channel.clear_sink();
        drop(tx);
        let _ = writer.await;
        Ok(())
    }

    /// ACP `SessionInfo.cwd`: the session's workspace root, else its recorded
    /// cwd, else the empty string (v2 `sessionSummaryToSessionInfo`).
    fn session_cwd(&self, session_id: &str) -> String {
        if let Ok(Some(session)) = self.store.get_session(session_id)
            && let Some(workspace_id) = session.workspace_id.as_deref()
            && let Ok(Some(workspace)) = self.store.get_workspace(workspace_id)
        {
            return workspace.root;
        }
        self.store
            .get_state("metadata", session_id)
            .ok()
            .flatten()
            .and_then(|metadata| {
                metadata
                    .get("cwd")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default()
    }

    /// Apply an ACP session mode (v2 `setSessionMode` + `setMode` +
    /// `acpModeToToggles`): validate the session and mode id, persist the
    /// permission mode the engine reads at turn start, and notify the client
    /// with `current_mode_update`.
    ///
    /// Plan mode is not toggled here: the engine reads plan state through the
    /// host state bridge (`tools/plan_mode.rs:107-127`), which this host does
    /// not own.
    fn apply_session_mode(
        &self,
        session_id: Option<&str>,
        mode_id: Option<&str>,
    ) -> Result<String, (i64, String)> {
        let Some(session_id) = session_id else {
            return Err((-32602, "Invalid params: sessionId is required".to_string()));
        };
        let Some(mode_id) = mode_id else {
            return Err((-32602, "Invalid params: modeId is required".to_string()));
        };
        if self.store.get_session(session_id).ok().flatten().is_none() {
            return Err((-32602, format!("Unknown sessionId: {session_id}")));
        }
        if !is_acp_mode_id(mode_id) {
            return Err((-32602, format!("Unknown modeId: {mode_id}")));
        }

        let mut metadata = self
            .store
            .get_state("metadata", session_id)
            .ok()
            .flatten()
            .filter(|value| value.is_object())
            .unwrap_or_else(|| json!({}));
        if let Some(object) = metadata.as_object_mut() {
            object.insert(
                "permission_mode".into(),
                json!(acp_mode_permission(mode_id)),
            );
        }
        let _ = self.store.put_state("metadata", session_id, &metadata);
        self.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), mode_id.to_string());

        self.channel.notify(
            "session/update",
            json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "current_mode_update",
                    "currentModeId": mode_id,
                },
            }),
        );
        Ok(mode_id.to_string())
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
                *self
                    .client_capabilities
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) =
                    params.client_capabilities.clone().unwrap_or_default();
                let protocol_version = negotiate_protocol_version(params.protocol_version);
                JsonRpcResponse::success(
                    req.id,
                    json!({
                        "protocolVersion": protocol_version,
                        "agentCapabilities": {
                            "loadSession": true,
                            // The engine accepts image blocks (native media
                            // injection); audio prompt blocks stay unsupported.
                            "promptCapabilities": {
                                "image": true,
                                "audio": false,
                                "embeddedContext": true,
                            },
                            // Only the methods this server actually answers.
                            "sessionCapabilities": {
                                "list": {},
                                "resume": {},
                                "close": {},
                                "delete": {},
                                "fork": {},
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
                            "name": "Kimi Code CLI",
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                    }),
                )
            }
            "session/new" => {
                if let Err((code, message)) = self.ensure_authed() {
                    return Some(JsonRpcResponse::error(req.id, code, message));
                }
                let session_id = format!("sess-{}", fastrand::u64(..));
                let title = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("title"))
                    .and_then(|v| v.as_str());
                let cwd = req
                    .params
                    .as_ref()
                    .and_then(|params| params.get("cwd"))
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let mcp_servers = req
                    .params
                    .as_ref()
                    .and_then(|params| params.get("mcpServers"))
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();

                let created = match cwd.as_deref() {
                    Some(root) => match self.store.create_workspace(root, None) {
                        Ok(workspace) => self.store.create_session_with_workspace(
                            &session_id,
                            title,
                            Some(&workspace.id),
                        ),
                        Err(error) => Err(error),
                    },
                    None => self.store.create_session(&session_id, title),
                };

                match created {
                    Ok(_) => {
                        if let Some(root) = cwd.as_deref() {
                            let _ = self.store.put_state(
                                "metadata",
                                &session_id,
                                &json!({ "cwd": root }),
                            );
                        }
                        if !mcp_servers.is_empty() {
                            self.register_session_mcp_servers(&mcp_servers).await;
                        }
                        self.modes
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(session_id.clone(), "default".to_string());
                        JsonRpcResponse::success(
                            req.id,
                            json!({
                                "sessionId": session_id,
                                "configOptions": self.config_options(&session_id),
                                "modes": self.mode_state(&session_id),
                            }),
                        )
                    }
                    Err(e) => {
                        JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}"))
                    }
                }
            }
            "session/list" => match self.store.list_sessions() {
                Ok(list) => {
                    let requested_cwd = req
                        .params
                        .as_ref()
                        .and_then(|params| params.get("cwd"))
                        .and_then(|value| value.as_str());
                    let sessions: Vec<serde_json::Value> = list
                        .iter()
                        .filter_map(|summary| {
                            let cwd = self.session_cwd(&summary.session_id);
                            // v2 `filterSessionSummariesByCwd`: a session
                            // without a recorded cwd is always kept.
                            if let Some(requested) = requested_cwd
                                && !cwd.is_empty()
                                && cwd != requested
                            {
                                return None;
                            }
                            let title = summary.title.as_deref().filter(|title| !title.is_empty());
                            let updated_at = chrono::DateTime::from_timestamp_millis(
                                summary.updated_at,
                            )
                            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                            Some(json!({
                                "sessionId": summary.session_id,
                                "cwd": cwd,
                                "title": title,
                                "updatedAt": updated_at,
                            }))
                        })
                        .collect();
                    JsonRpcResponse::success(req.id, json!({ "sessions": sessions }))
                }
                Err(e) => JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}")),
            },
            "session/prompt" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());
                let prompt = params
                    .and_then(|p| p.get("prompt"))
                    .and_then(acp_prompt_to_parts);

                match (session_id, prompt) {
                    (Some(sid), Some((p, media))) => {
                        if let Some(ref engine) = self.engine {
                            let history = self.store.load_session_history(sid).unwrap_or_default();
                            let turn_number = self.store.next_turn_number(sid).unwrap_or(1);
                            // Stream this session's events as ACP
                            // `session/update` notifications while the turn runs.
                            let bus = engine.hub().bus_for(sid);
                            let subscription = self.forward_session_events(sid, &bus);
                            let result = engine
                                .run_turn_with_media(sid, turn_number, history, &p, media)
                                .await;
                            bus.unsubscribe(subscription);
                            match result {
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
                if let Err((code, message)) = self.ensure_authed() {
                    return Some(JsonRpcResponse::error(req.id, code, message));
                }
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());

                match session_id {
                    Some(sid) => match self.store.load_session_history(sid) {
                        Ok(history) => {
                            // Replay the persisted history as an ordered batch
                            // of `session/update` chunks, then answer with the
                            // mode state (v2 `loadSession` + `replay.ts`).
                            for message in &history {
                                // v2 `replay.ts` projects a tool result as a
                                // `tool_call_update` and the two message roles
                                // as text chunks.
                                if message.role == "tool" {
                                    let Some(tool_call_id) = message.tool_call_id.as_deref() else {
                                        continue;
                                    };
                                    self.channel.notify(
                                        "session/update",
                                        json!({
                                            "sessionId": sid,
                                            "update": {
                                                "sessionUpdate": "tool_call_update",
                                                "toolCallId": tool_call_id,
                                                "status": "completed",
                                                "rawOutput": message.content,
                                            },
                                        }),
                                    );
                                    continue;
                                }
                                let update = match message.role.as_str() {
                                    "user" => "user_message_chunk",
                                    "assistant" => "agent_message_chunk",
                                    _ => continue,
                                };
                                self.channel.notify(
                                    "session/update",
                                    json!({
                                        "sessionId": sid,
                                        "update": {
                                            "sessionUpdate": update,
                                            "content": { "type": "text", "text": message.content },
                                        },
                                    }),
                                );
                            }
                            JsonRpcResponse::success(
                                req.id,
                                json!({
                                    "configOptions": self.config_options(sid),
                                    "modes": self.mode_state(sid),
                                }),
                            )
                        }
                        Err(e) => {
                            JsonRpcResponse::error(req.id, -32000, format!("Database error: {e}"))
                        }
                    },
                    None => JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: sessionId is required",
                    ),
                }
            }
            // `session/resume` re-attaches without replaying history 鈥?that is
            // the whole difference from `session/load` (v2 `resumeSession`,
            // server.ts:312-321).
            "session/resume" => {
                if let Err((code, message)) = self.ensure_authed() {
                    return Some(JsonRpcResponse::error(req.id, code, message));
                }
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());
                match session_id {
                    Some(sid) => {
                        if self.store.get_session(sid).ok().flatten().is_none() {
                            JsonRpcResponse::error(
                                req.id,
                                -32602,
                                format!("Unknown sessionId: {sid}"),
                            )
                        } else {
                            JsonRpcResponse::success(
                                req.id,
                                json!({
                                    "configOptions": self.config_options(sid),
                                    "modes": self.mode_state(sid),
                                }),
                            )
                        }
                    }
                    None => JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: sessionId is required",
                    ),
                }
            }
            // `session/fork` (UNSTABLE in the ACP schema) copies the source
            // session's history into a new session (v2 `forkSession`,
            // server.ts:266-294).
            "session/fork" => {
                if let Err((code, message)) = self.ensure_authed() {
                    return Some(JsonRpcResponse::error(req.id, code, message));
                }
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());
                match session_id {
                    Some(source) => match self.store.get_session(source).ok().flatten() {
                        None => JsonRpcResponse::error(
                            req.id,
                            -32602,
                            format!("Unknown sessionId: {source}"),
                        ),
                        Some(_) => {
                            let forked = format!("sess-{}", fastrand::u64(..));
                            match self.store.fork_session(source, &forked, None) {
                                Ok(true) => {
                                    self.modes
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .insert(forked.clone(), "default".to_string());
                                    JsonRpcResponse::success(
                                        req.id,
                                        json!({
                                            "sessionId": forked,
                                            "configOptions": self.config_options(&forked),
                                            "modes": self.mode_state(&forked),
                                        }),
                                    )
                                }
                                Ok(false) => JsonRpcResponse::error(
                                    req.id,
                                    -32602,
                                    format!("Unknown sessionId: {source}"),
                                ),
                                Err(e) => JsonRpcResponse::error(
                                    req.id,
                                    -32000,
                                    format!("Database error: {e}"),
                                ),
                            }
                        }
                    },
                    None => JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: sessionId is required",
                    ),
                }
            }
            "session/delete" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());

                match session_id {
                    Some(sid) => {
                        // v2 rejects an unknown id with invalid params instead
                        // of answering `{deleted:false}` (server.ts:350-377).
                        if self.store.get_session(sid).ok().flatten().is_none() {
                            JsonRpcResponse::error(
                                req.id,
                                -32602,
                                format!("Unknown sessionId: {sid}"),
                            )
                        } else {
                            match self.store.delete_session(sid) {
                                Ok(_) => JsonRpcResponse::success(req.id, json!({})),
                                Err(e) => JsonRpcResponse::error(
                                    req.id,
                                    -32000,
                                    format!("Database error: {e}"),
                                ),
                            }
                        }
                    }
                    None => JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: sessionId is required",
                    ),
                }
            }
            "session/close" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
                    .and_then(|v| v.as_str());

                match session_id {
                    Some(sid) => {
                        if self.store.get_session(sid).ok().flatten().is_none() {
                            JsonRpcResponse::error(
                                req.id,
                                -32602,
                                format!("Unknown sessionId: {sid}"),
                            )
                        } else {
                            // Best-effort teardown: cancel any in-flight turn and
                            // drop the session's local mode (v2 `closeSession`,
                            // server.ts:332-348).
                            if let Some(ref engine) = self.engine {
                                engine.cancel_turn(sid);
                            }
                            self.modes
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .remove(sid);
                            JsonRpcResponse::success(req.id, json!({}))
                        }
                    }
                    None => JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: sessionId is required",
                    ),
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
                let session_id = params
                    .and_then(|p| p.get("sessionId"))
                    .and_then(|v| v.as_str());
                let mode_id = params
                    .and_then(|p| p.get("modeId").or_else(|| p.get("mode")))
                    .and_then(|v| v.as_str());
                match self.apply_session_mode(session_id, mode_id) {
                    Ok(mode) => JsonRpcResponse::success(req.id, json!({ "modeId": mode })),
                    Err((code, message)) => JsonRpcResponse::error(req.id, code, message),
                }
            }
            // The `mode` arm of `session/set_config_option` funnels into the
            // same path (v2 `setSessionConfigOption`, server.ts:471-513).
            "session/set_config_option" => {
                let params = req.params.as_ref();
                let session_id = params
                    .and_then(|p| p.get("sessionId"))
                    .and_then(|v| v.as_str());
                let config_id = params
                    .and_then(|p| p.get("configId"))
                    .and_then(|v| v.as_str());
                let value = params.and_then(|p| p.get("value")).and_then(|v| v.as_str());
                if config_id != Some("mode") {
                    JsonRpcResponse::error(
                        req.id,
                        -32602,
                        format!("Unsupported configId: {}", config_id.unwrap_or_default()),
                    )
                } else {
                    match self.apply_session_mode(session_id, value) {
                        Ok(mode) => JsonRpcResponse::success(req.id, json!({ "modeId": mode })),
                        Err((code, message)) => JsonRpcResponse::error(req.id, code, message),
                    }
                }
            }
            // `authenticate` re-checks the gate after the client runs the
            // terminal-auth login flow (v2 `authenticate`, server.ts:380-390).
            // The Rust engine has no managed token to drop, so `logout` is a
            // no-op success (v2 `logout`, server.ts:392-399).
            "authenticate" => {
                let method_id = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("methodId"))
                    .and_then(|v| v.as_str());
                if method_id != Some("login") {
                    JsonRpcResponse::error(
                        req.id,
                        -32602,
                        "Invalid params: methodId must be 'login'",
                    )
                } else {
                    match self.ensure_authed() {
                        Ok(()) => JsonRpcResponse::success(req.id, json!({})),
                        Err((code, message)) => JsonRpcResponse::error(req.id, code, message),
                    }
                }
            }
            "logout" => JsonRpcResponse::success(req.id, json!({})),
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

/// The four wire-level mode ids this host understands (v2 `isAcpModeId`,
/// modes.ts).
fn is_acp_mode_id(mode: &str) -> bool {
    matches!(mode, "default" | "plan" | "auto" | "yolo")
}

/// v2 `acpModeToToggles`: the permission mode each ACP mode maps to.
fn acp_mode_permission(mode: &str) -> &'static str {
    match mode {
        "auto" => "auto",
        "yolo" => "yolo",
        _ => "manual",
    }
}

/// Accept both prompt forms: the legacy plain string and the ACP
/// `ContentBlock[]` array (v2 `acpBlocksToContentParts`, convert.ts:26-78).
fn acp_prompt_to_parts(
    value: &serde_json::Value,
) -> Option<(String, Vec<crate::rpc::types::ContentBlock>)> {
    match value {
        serde_json::Value::String(text) => Some((text.clone(), Vec::new())),
        serde_json::Value::Array(blocks) => {
            Some((acp_blocks_to_text(blocks), acp_blocks_to_media(blocks)))
        }
        _ => None,
    }
}

/// ACP `image` content blocks (`{type:"image", mimeType, data}`) become native
/// media blocks; every other block type is flattened to text by
/// [`acp_blocks_to_text`].
fn acp_blocks_to_media(blocks: &[serde_json::Value]) -> Vec<crate::rpc::types::ContentBlock> {
    use crate::rpc::types::ContentBlock;
    let mut media = Vec::new();
    for block in blocks {
        if block.get("type").and_then(|value| value.as_str()) != Some("image") {
            continue;
        }
        let media_type = block
            .get("mimeType")
            .and_then(|value| value.as_str())
            .unwrap_or("image/png");
        let name = block
            .get("name")
            .and_then(|value| value.as_str())
            .map(|s| s.to_string());
        if let Some(data) = block.get("data").and_then(|value| value.as_str()) {
            media.push(ContentBlock::Image {
                media_type: media_type.to_string(),
                data: data.to_string(),
                name,
            });
        }
    }
    media
}

/// Flatten ACP content blocks into the plain prompt text the engine takes.
/// Text blocks pass through, text resources keep their uri provenance,
/// resource links become inline references, and audio / blob / unknown blocks
/// are dropped 鈥?the engine prompt pipeline is text-only.
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
                let resource = block
                    .get("resource")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
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

/// Convert one ACP `McpServer` entry (`NewSessionRequest.mcpServers`) into an
/// engine recipe: a `command` entry is stdio, a `url` entry is http (or sse
/// when `type` says so).
fn acp_mcp_recipe(server: &serde_json::Value) -> Option<McpServerRecipe> {
    let string_map = |value: Option<&serde_json::Value>| {
        value
            .and_then(|value| value.as_object())
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|text| (key.clone(), text.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };

    if let Some(url) = server.get("url").and_then(|value| value.as_str()) {
        let headers = string_map(server.get("headers"));
        let bearer_token_env_var = server
            .get("bearerTokenEnvVar")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        return Some(match server.get("type").and_then(|value| value.as_str()) {
            Some("sse") => McpServerRecipe::Sse {
                url: url.to_string(),
                headers,
                bearer_token_env_var,
            },
            _ => McpServerRecipe::Http {
                url: url.to_string(),
                headers,
                bearer_token_env_var,
            },
        });
    }

    let command = server.get("command").and_then(|value| value.as_str())?;
    let args = server
        .get("args")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Some(McpServerRecipe::Stdio {
        command: command.to_string(),
        args,
        env: string_map(server.get("env")),
        cwd: server
            .get("cwd")
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
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
        assert_eq!(
            res["agentCapabilities"]["promptCapabilities"]["image"],
            true
        );
        assert_eq!(
            res["agentCapabilities"]["promptCapabilities"]["embeddedContext"],
            true
        );
        assert!(res["agentCapabilities"]["sessionCapabilities"]["list"].is_object());
        assert!(res["agentCapabilities"]["sessionCapabilities"]["resume"].is_object());
        assert!(res["agentCapabilities"]["sessionCapabilities"]["fork"].is_object());
        assert_eq!(res["agentCapabilities"]["mcpCapabilities"]["http"], true);
        assert_eq!(res["authMethods"][0]["id"], "login");
        assert_eq!(res["authMethods"][0]["type"], "terminal");
        assert_eq!(res["authMethods"][0]["args"], json!(["--login"]));
        assert_eq!(res["agentInfo"]["name"], "Kimi Code CLI");
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
        assert!(
            server
                .handle_message(&notification.to_string())
                .await
                .is_none()
        );

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

    /// `session/new` binds the requested `cwd` to a workspace and records it
    /// in metadata, so `session/list`'s cwd filter and the engine's workspace
    /// root both resolve it.
    #[tokio::test]
    async fn test_acp_new_session_records_cwd_workspace() {
        let server = AcpServer::in_memory().unwrap();
        let req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/new",
            "params": { "cwd": "/tmp/acp-work", "title": "ACP Work" }
        });
        let resp = server.handle_message(&req.to_string()).await.unwrap();
        let session_id = resp.result.unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let summary = server.store.get_session(&session_id).unwrap().unwrap();
        assert!(
            summary.workspace_id.is_some(),
            "a cwd must associate a workspace"
        );
        assert_eq!(server.session_cwd(&session_id), "/tmp/acp-work");
        let workspace = server
            .store
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.root == "/tmp/acp-work")
            .expect("the cwd workspace is registered");
        assert_eq!(summary.workspace_id.as_deref(), Some(workspace.id.as_str()));
    }

    #[test]
    fn test_acp_mcp_recipe_transports() {
        let stdio = acp_mcp_recipe(&json!({
            "name": "fs",
            "command": "npx",
            "args": ["-y", "server-files"],
            "env": { "TOKEN": "x" }
        }))
        .expect("stdio recipe");
        match stdio {
            McpServerRecipe::Stdio {
                command, args, env, ..
            } => {
                assert_eq!(command, "npx");
                assert_eq!(args, vec!["-y", "server-files"]);
                assert_eq!(env.get("TOKEN").map(String::as_str), Some("x"));
            }
            other => panic!("expected stdio, got {other:?}"),
        }

        let http = acp_mcp_recipe(&json!({
            "name": "web",
            "type": "http",
            "url": "https://example.test/mcp",
            "headers": { "X-Auth": "y" }
        }))
        .expect("http recipe");
        match http {
            McpServerRecipe::Http { url, headers, .. } => {
                assert_eq!(url, "https://example.test/mcp");
                assert_eq!(headers.get("X-Auth").map(String::as_str), Some("y"));
            }
            other => panic!("expected http, got {other:?}"),
        }

        let sse = acp_mcp_recipe(&json!({
            "name": "stream",
            "type": "sse",
            "url": "https://example.test/sse"
        }))
        .expect("sse recipe");
        assert!(matches!(sse, McpServerRecipe::Sse { .. }));
        assert!(acp_mcp_recipe(&json!({ "name": "empty" })).is_none());
    }

    /// `session/new` advertises `configOptions` = `[model, mode]` with the
    /// canonical four-mode `mode` arm and a single-row `model` arm (no model
    /// catalog, v2 `buildSessionConfigOptions`, config-options.ts). The
    /// `thinking` arm is omitted because no catalog row declares thinking
    /// support.
    #[tokio::test]
    async fn test_acp_new_session_advertises_config_options() {
        let server = AcpServer::in_memory().unwrap();
        let req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let resp = server.handle_message(&req.to_string()).await.unwrap();
        let res = resp.result.unwrap();
        let options = res["configOptions"].as_array().unwrap();
        assert_eq!(
            options.len(),
            2,
            "model + mode, no thinking arm without a catalog"
        );

        let model = &options[0];
        assert_eq!(model["type"], "select");
        assert_eq!(model["id"], "model");
        assert_eq!(model["category"], "model");
        // No engine attached 鈫?the model arm is honest: empty currentValue and
        // no rows (v2 keeps the unbound defaults).
        assert_eq!(model["currentValue"], "");
        assert_eq!(model["options"].as_array().unwrap().len(), 0);

        let mode = &options[1];
        assert_eq!(mode["id"], "mode");
        assert_eq!(mode["category"], "mode");
        assert_eq!(mode["currentValue"], "default");
        let mode_options = mode["options"].as_array().unwrap();
        assert_eq!(mode_options.len(), 4);
        assert_eq!(mode_options[0]["value"], "default");
        assert_eq!(mode_options[0]["name"], "Default");
        assert_eq!(mode_options[3]["value"], "yolo");
    }

    /// With an engine attached, the `model` arm carries the engine's single
    /// model as both `currentValue` and the one selectable row.
    #[tokio::test]
    async fn test_acp_config_options_model_arm_from_engine() {
        use crate::pipeline::PipelineSpec;
        use crate::server::engine::ServerEngine;

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let engine = ServerEngine::new(
            PipelineSpec {
                system_prompt: "sys".into(),
                model_name: "kimi-k2".into(),
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
                todo_tool_veto: None,
                tower_worktree_root: None,
                sandbox_mode: None,
                sandbox_policy: None,
                caller_agent_id: None,
                session_id: None,
                secondary_model: None,
                image_read_byte_budget: None,
                image_max_edge_px: None,
                model_capabilities: None,
                skill_dirs: Vec::new(),
                background: crate::storage::BackgroundLimits::default(),
            },
            Arc::new(crate::server::hub::EventHub::new()),
            store.clone(),
        );
        let server = AcpServer::with_engine(store, Arc::new(engine));
        let req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let resp = server.handle_message(&req.to_string()).await.unwrap();
        let res = resp.result.unwrap();
        let model = &res["configOptions"][0];
        assert_eq!(model["currentValue"], "kimi-k2");
        let rows = model["options"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["value"], "kimi-k2");
        assert_eq!(rows[0]["name"], "kimi-k2");
    }

    /// The auth gate refuses `session/new` with `auth_required` (`-32000`)
    /// when no engine (model) is attached and auth is not disabled
    /// (v2 `ensureAuthed`, server.ts:625-646).
    #[tokio::test]
    async fn test_acp_auth_gate_blocks_session_new_without_engine() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = AcpServer::new(store); // disable_auth = false, no engine
        let req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let resp = server.handle_message(&req.to_string()).await.unwrap();
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32000);
        assert!(err.message.contains("Authentication required"));
    }

    /// `authenticate` validates `methodId` and re-checks the gate
    /// (v2 `authenticate`, server.ts:380-390).
    #[tokio::test]
    async fn test_acp_authenticate_validates_method_and_gate() {
        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let server = AcpServer::new(store);

        // Wrong methodId 鈫?invalid params.
        let bad = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "authenticate",
            "params": { "methodId": "oauth" }
        });
        let resp = server.handle_message(&bad.to_string()).await.unwrap();
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32602);

        // Correct methodId but no engine 鈫?auth_required.
        let good = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "authenticate",
            "params": { "methodId": "login" }
        });
        let resp = server.handle_message(&good.to_string()).await.unwrap();
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32000);
    }

    /// With an engine attached, `authenticate('login')` succeeds and `logout`
    /// is a no-op success (the Rust engine has no managed token to drop).
    #[tokio::test]
    async fn test_acp_authenticate_succeeds_with_engine() {
        use crate::pipeline::PipelineSpec;
        use crate::server::engine::ServerEngine;

        let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
        let engine = ServerEngine::new(
            PipelineSpec {
                system_prompt: "sys".into(),
                model_name: "kimi-k2".into(),
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
                todo_tool_veto: None,
                tower_worktree_root: None,
                sandbox_mode: None,
                sandbox_policy: None,
                caller_agent_id: None,
                session_id: None,
                secondary_model: None,
                image_read_byte_budget: None,
                image_max_edge_px: None,
                model_capabilities: None,
                skill_dirs: Vec::new(),
                background: crate::storage::BackgroundLimits::default(),
            },
            Arc::new(crate::server::hub::EventHub::new()),
            store.clone(),
        );
        let server = AcpServer::with_engine(store, Arc::new(engine));

        let auth = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "authenticate",
            "params": { "methodId": "login" }
        });
        let resp = server.handle_message(&auth.to_string()).await.unwrap();
        assert!(resp.error.is_none(), "engine attached 鈫?authed");

        let logout = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "logout",
            "params": {}
        });
        let resp = server.handle_message(&logout.to_string()).await.unwrap();
        assert!(resp.error.is_none(), "logout is a no-op success");
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
        let sid = server
            .handle_message(&new_req.to_string())
            .await
            .unwrap()
            .result
            .unwrap()["sessionId"]
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

    /// ACP image blocks become native media blocks; the text projection keeps
    /// only the textual blocks.
    #[test]
    fn test_acp_blocks_to_media_extracts_images() {
        let blocks = vec![
            json!({ "type": "text", "text": "look" }),
            json!({ "type": "image", "mimeType": "image/jpeg", "data": "AAAB" }),
            json!({ "type": "resource_link", "uri": "file:///b", "name": "b" }),
            json!({ "type": "image", "mimeType": "image/png", "data": "CCCC" }),
        ];
        let media = acp_blocks_to_media(&blocks);
        assert_eq!(media.len(), 2);
        match &media[0] {
            crate::rpc::types::ContentBlock::Image { media_type, data, .. } => {
                assert_eq!(media_type, "image/jpeg");
                assert_eq!(data, "AAAB");
            }
            other => panic!("expected image, got {other:?}"),
        }
        let (text, media) = acp_prompt_to_parts(&json!([
            { "type": "text", "text": "look" },
            { "type": "image", "mimeType": "image/png", "data": "CCCC" },
        ]))
        .unwrap();
        assert_eq!(text, "look");
        assert_eq!(media.len(), 1);
        assert!(acp_prompt_to_parts(&json!("plain")).is_some());
        assert!(acp_prompt_to_parts(&json!(42)).is_none());
    }

    /// `initialize` records the client's reverse-RPC capabilities.
    #[tokio::test]
    async fn test_acp_initialize_records_client_capabilities() {
        let server = AcpServer::in_memory().unwrap();
        assert!(!server.client_capabilities().fs.read_text_file);
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": true,
                },
            }
        });
        server.handle_message(&req.to_string()).await.unwrap();
        let capabilities = server.client_capabilities();
        assert!(capabilities.fs.read_text_file);
        assert!(capabilities.fs.write_text_file);
        assert!(capabilities.terminal);
    }

    /// `session/set_mode` validates the mode id, persists the permission mode
    /// the engine reads at turn start, and pushes `current_mode_update`
    /// (v2 `setSessionMode` + `acpModeToToggles`).
    #[tokio::test]
    async fn test_acp_set_mode_persists_permission_and_notifies() {
        let server = AcpServer::in_memory().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AcpOutbound>();
        server.set_notification_sink(tx);

        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let sid = server
            .handle_message(&new_req.to_string())
            .await
            .unwrap()
            .result
            .unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let set_req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_mode",
            "params": { "sessionId": sid, "modeId": "yolo" }
        });
        let resp = server.handle_message(&set_req.to_string()).await.unwrap();
        assert!(resp.error.is_none(), "unexpected error: {resp:?}");
        assert_eq!(resp.result.unwrap()["modeId"], "yolo");

        let metadata = server.store.get_state("metadata", &sid).unwrap().unwrap();
        assert_eq!(metadata["permission_mode"], "yolo");

        match rx.try_recv().expect("current_mode_update") {
            AcpOutbound::Notification(note) => {
                assert_eq!(note.method, "session/update");
                let params = note.params.unwrap();
                assert_eq!(params["sessionId"], sid);
                assert_eq!(params["update"]["sessionUpdate"], "current_mode_update");
                assert_eq!(params["update"]["currentModeId"], "yolo");
            }
            other => panic!("unexpected outbound message: {other:?}"),
        }
    }

    /// Unknown ids are rejected with the v2 messages (server.ts:452-469).
    #[tokio::test]
    async fn test_acp_set_mode_rejects_unknown_ids() {
        let server = AcpServer::in_memory().unwrap();
        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let sid = server
            .handle_message(&new_req.to_string())
            .await
            .unwrap()
            .result
            .unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let unknown_mode = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_mode",
            "params": { "sessionId": sid, "modeId": "turbo" }
        });
        let resp = server
            .handle_message(&unknown_mode.to_string())
            .await
            .unwrap();
        assert_eq!(resp.error.as_ref().unwrap().code, -32602);
        assert_eq!(resp.error.unwrap().message, "Unknown modeId: turbo");

        let unknown_session = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/set_mode",
            "params": { "sessionId": "sess-nope", "modeId": "auto" }
        });
        let resp = server
            .handle_message(&unknown_session.to_string())
            .await
            .unwrap();
        assert_eq!(resp.error.unwrap().message, "Unknown sessionId: sess-nope");
    }

    /// `session/set_config_option` routes the `mode` arm to the same handler.
    #[tokio::test]
    async fn test_acp_set_config_option_mode_arm() {
        let server = AcpServer::in_memory().unwrap();
        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let sid = server
            .handle_message(&new_req.to_string())
            .await
            .unwrap()
            .result
            .unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let mode_req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_config_option",
            "params": { "sessionId": sid, "configId": "mode", "value": "auto" }
        });
        let resp = server.handle_message(&mode_req.to_string()).await.unwrap();
        assert_eq!(resp.result.unwrap()["modeId"], "auto");
        assert_eq!(
            server.store.get_state("metadata", &sid).unwrap().unwrap()["permission_mode"],
            "auto"
        );

        let model_req = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/set_config_option",
            "params": { "sessionId": sid, "configId": "model", "value": "kimi-k2" }
        });
        let resp = server.handle_message(&model_req.to_string()).await.unwrap();
        assert_eq!(resp.error.unwrap().message, "Unsupported configId: model");
    }

    /// Engine events reach the client as `session/update` notifications while
    /// a turn runs, and stop once the subscription is dropped.
    #[tokio::test]
    async fn test_session_update_notifications_are_forwarded() {
        use crate::events::types::EngineEvent;

        let server = AcpServer::in_memory().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AcpOutbound>();
        server.set_notification_sink(tx);

        let bus = Arc::new(EventBus::new());
        let subscription = server.forward_session_events("sess-1", &bus);

        bus.publish(&EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: 3,
            delta: "hi".into(),
        });
        bus.publish(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 3,
            prompt: None,
        });

        match rx.try_recv().expect("one notification") {
            AcpOutbound::Notification(note) => {
                assert_eq!(note.method, "session/update");
                let params = note.params.expect("notification params");
                assert_eq!(params["sessionId"], "sess-1");
                assert_eq!(params["update"]["sessionUpdate"], "agent_message_chunk");
                assert_eq!(params["update"]["content"]["text"], "hi");
            }
            other => panic!("unexpected outbound message: {other:?}"),
        }
        assert!(rx.try_recv().is_err(), "unmapped events must not notify");

        bus.unsubscribe(subscription);
        bus.publish(&EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: 3,
            delta: "again".into(),
        });
        assert!(
            rx.try_recv().is_err(),
            "a dropped subscription stops forwarding"
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
        assert_eq!(sessions[0]["sessionId"], sid);
        assert_eq!(sessions[0]["cwd"], "");
        assert_eq!(sessions[0]["title"], "ACP Test Session");
        assert!(sessions[0]["updatedAt"].is_string());

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

        // 4. Load session history 鈥?replayed as `session/update` chunks, the
        // response carries the mode state (v2 `loadSession`).
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AcpOutbound>();
        server.set_notification_sink(tx);
        let load_req = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "session/load",
            "params": { "sessionId": sid }
        });
        let resp = server.handle_message(&load_req.to_string()).await.unwrap();
        assert!(resp.error.is_none());
        assert_eq!(resp.result.unwrap()["modes"]["currentModeId"], "default");
        let mut replayed = Vec::new();
        while let Ok(message) = rx.try_recv() {
            if let AcpOutbound::Notification(note) = message {
                replayed.push(note.params.unwrap());
            }
        }
        assert_eq!(replayed.len(), 2, "user + assistant chunks");
        assert_eq!(replayed[0]["update"]["sessionUpdate"], "user_message_chunk");
        assert_eq!(replayed[0]["update"]["content"]["text"], "Hello ACP");
        assert_eq!(
            replayed[1]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );

        // 5. Set mode (ACP wire name `modeId`; the legacy `mode` still parses)
        let mode_req = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "session/set_mode",
            "params": { "sessionId": sid, "modeId": "yolo" }
        });
        let resp = server.handle_message(&mode_req.to_string()).await.unwrap();
        assert_eq!(resp.result.unwrap()["modeId"], "yolo");

        // 6. Delete session
        let del_req = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/delete",
            "params": { "sessionId": sid }
        });
        let resp = server.handle_message(&del_req.to_string()).await.unwrap();
        assert!(resp.error.is_none(), "unexpected error: {resp:?}");
        assert_eq!(resp.result.unwrap(), json!({}));

        // 7. Deleting an unknown session is invalid params, not a false answer.
        let del_missing = json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "session/delete",
            "params": { "sessionId": "sess-nope" }
        });
        let resp = server
            .handle_message(&del_missing.to_string())
            .await
            .unwrap();
        assert_eq!(resp.error.unwrap().message, "Unknown sessionId: sess-nope");
    }

    /// A stored tool result replays as `tool_call_update` (v2 `replay.ts`).
    #[tokio::test]
    async fn test_acp_load_replays_tool_results() {
        let server = AcpServer::in_memory().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AcpOutbound>();
        server.set_notification_sink(tx);
        server.store.create_session("sess-tools", None).unwrap();
        let messages = vec![
            crate::turn_loop::types::LLMMessage::user("run it"),
            crate::turn_loop::types::LLMMessage::assistant("ok"),
            crate::turn_loop::types::LLMMessage {
                role: "tool".into(),
                content: "tool output".into(),
                tool_call_id: Some("call-1".into()),
                ..Default::default()
            },
        ];
        server
            .store
            .save_turn("sess-tools", "t1", 1, &messages, None)
            .unwrap();

        let load = json!({
            "jsonrpc": "2.0", "id": 1, "method": "session/load",
            "params": { "sessionId": "sess-tools" }
        });
        server.handle_message(&load.to_string()).await.unwrap();

        let mut updates = Vec::new();
        while let Ok(message) = rx.try_recv() {
            if let AcpOutbound::Notification(note) = message {
                updates.push(note.params.unwrap());
            }
        }
        assert_eq!(updates.len(), 3);
        assert_eq!(updates[2]["update"]["sessionUpdate"], "tool_call_update");
        assert_eq!(updates[2]["update"]["toolCallId"], "call-1");
        assert_eq!(updates[2]["update"]["status"], "completed");
        assert_eq!(updates[2]["update"]["rawOutput"], "tool output");
    }

    /// `session/list` projects storage rows into the ACP `SessionInfo` shape,
    /// resolves `cwd` from the session metadata, and keeps cwd-less sessions
    /// when the request filters by cwd (v2 `sessionSummaryToSessionInfo` +
    /// `filterSessionSummariesByCwd`).
    #[tokio::test]
    async fn test_acp_session_list_shape_and_cwd_filter() {
        let server = AcpServer::in_memory().unwrap();
        server.store.create_session("sess-a", Some("A")).unwrap();
        server.store.create_session("sess-b", Some("B")).unwrap();
        server
            .store
            .put_state("metadata", "sess-b", &json!({ "cwd": "/tmp/ws" }))
            .unwrap();

        let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "session/list", "params": {} });
        let resp = server.handle_message(&list.to_string()).await.unwrap();
        let sessions = resp.result.unwrap()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 2);
        let session_b = sessions
            .iter()
            .find(|session| session["sessionId"] == "sess-b")
            .expect("sess-b listed");
        assert_eq!(session_b["cwd"], "/tmp/ws");
        assert_eq!(session_b["title"], "B");
        assert!(session_b["updatedAt"].is_string());

        let matching = json!({
            "jsonrpc": "2.0", "id": 2, "method": "session/list",
            "params": { "cwd": "/tmp/ws" }
        });
        let resp = server.handle_message(&matching.to_string()).await.unwrap();
        let sessions = resp.result.unwrap()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 2, "a cwd-less session is always kept");

        let other = json!({
            "jsonrpc": "2.0", "id": 3, "method": "session/list",
            "params": { "cwd": "/tmp/other" }
        });
        let resp = server.handle_message(&other.to_string()).await.unwrap();
        let sessions = resp.result.unwrap()["sessions"].as_array().unwrap().clone();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["sessionId"], "sess-a");
    }

    /// `session/resume` re-attaches without replay; `session/fork` copies the
    /// source history into a new session (v2 `resumeSession` / `forkSession`).
    #[tokio::test]
    async fn test_acp_resume_and_fork() {
        let server = AcpServer::in_memory().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AcpOutbound>();
        server.set_notification_sink(tx);

        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let sid = server
            .handle_message(&new_req.to_string())
            .await
            .unwrap()
            .result
            .unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let prompt_req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": { "sessionId": sid, "prompt": "hi" }
        });
        server
            .handle_message(&prompt_req.to_string())
            .await
            .unwrap();

        // resume: mode state only, no replayed chunks.
        let resume_req = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/resume",
            "params": { "sessionId": sid }
        });
        let resp = server
            .handle_message(&resume_req.to_string())
            .await
            .unwrap();
        assert_eq!(resp.result.unwrap()["modes"]["currentModeId"], "default");
        assert!(
            rx.try_recv().is_err(),
            "resume must not replay history (that is session/load)"
        );

        // fork: new id, copied history.
        let fork_req = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "session/fork",
            "params": { "sessionId": sid }
        });
        let resp = server.handle_message(&fork_req.to_string()).await.unwrap();
        let forked = resp.result.unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(forked, sid);
        assert_eq!(
            server.store.load_session_history(&forked).unwrap()[0].content,
            "hi"
        );

        let unknown_fork = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "session/fork",
            "params": { "sessionId": "sess-nope" }
        });
        assert_eq!(
            server
                .handle_message(&unknown_fork.to_string())
                .await
                .unwrap()
                .error
                .unwrap()
                .message,
            "Unknown sessionId: sess-nope"
        );

        let unknown_resume = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/resume",
            "params": { "sessionId": "sess-nope" }
        });
        assert_eq!(
            server
                .handle_message(&unknown_resume.to_string())
                .await
                .unwrap()
                .error
                .unwrap()
                .message,
            "Unknown sessionId: sess-nope"
        );
    }

    /// `session/close` tears the session down best-effort and clears its local
    /// mode; an unknown session is rejected (v2 `closeSession`).
    #[tokio::test]
    async fn test_acp_close_session_clears_mode() {
        let server = AcpServer::in_memory().unwrap();
        let new_req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {}
        });
        let sid = server
            .handle_message(&new_req.to_string())
            .await
            .unwrap()
            .result
            .unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let set_req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/set_mode",
            "params": { "sessionId": sid, "modeId": "plan" }
        });
        server.handle_message(&set_req.to_string()).await.unwrap();
        assert_eq!(server.current_mode(&sid), "plan");

        let close_req = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/close",
            "params": { "sessionId": sid }
        });
        let resp = server.handle_message(&close_req.to_string()).await.unwrap();
        assert!(resp.error.is_none(), "unexpected error: {resp:?}");
        assert_eq!(resp.result.unwrap(), json!({}));
        assert_eq!(server.current_mode(&sid), "default");

        let unknown = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "session/close",
            "params": { "sessionId": "sess-nope" }
        });
        let resp = server.handle_message(&unknown.to_string()).await.unwrap();
        assert_eq!(resp.error.unwrap().message, "Unknown sessionId: sess-nope");
    }
}
