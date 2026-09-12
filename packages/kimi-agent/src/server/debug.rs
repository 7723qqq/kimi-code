//! Debug RPC and reflection surface for Kimi Agent (/api/v1/debug/*).
//!
//! Provides service reflection, business snapshot endpoints, and dynamic RPC dispatch
//! for `apps/kimi-inspect` and developer introspection tools.

use serde_json::{Value, json};

use crate::server::HttpServer;
use crate::server::router::{HttpRequest, HttpResponse};
use crate::session::sqlite_store::{SqliteSessionStore, encode_workdir_key};

fn iso_to_millis(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn session_cwd(store: &SqliteSessionStore, session_id: &str) -> String {
    store
        .get_state("metadata", session_id)
        .ok()
        .flatten()
        .and_then(|m| m.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        })
}

/// The live engine -> workspace -> session graph for the debug graph service.
fn debug_graph(server: &HttpServer) -> (Vec<Value>, Vec<Value>) {
    let mut nodes = vec![json!({ "id": "engine", "kind": "engine", "label": "kimi-agent" })];
    let mut edges = Vec::new();
    for workspace in server.store().list_workspaces().unwrap_or_default() {
        nodes.push(json!({
            "id": format!("workspace:{}", workspace.id),
            "kind": "workspace",
            "label": workspace.name,
        }));
        edges.push(json!({
            "from": "engine",
            "to": format!("workspace:{}", workspace.id),
            "kind": "owns",
        }));
    }
    for session in server.store().list_sessions().unwrap_or_default() {
        let node_id = format!("session:{}", session.session_id);
        nodes.push(json!({
            "id": node_id,
            "kind": "session",
            "label": session.title.clone().unwrap_or_default(),
        }));
        let from = match &session.workspace_id {
            Some(workspace_id) => format!("workspace:{workspace_id}"),
            None => "engine".to_string(),
        };
        edges.push(json!({ "from": from, "to": node_id, "kind": "contains" }));
    }
    (nodes, edges)
}

/// Describe wire channels matching `ChannelDescriptor` in `apps/kimi-inspect`.
pub fn describe_all_channels() -> Value {
    json!([
        {
            "name": "configService",
            "scope": "app",
            "domain": "config",
            "methods": [
                { "name": "getConfig", "kind": "method", "arity": 0, "params": "()" },
                { "name": "inspect", "kind": "method", "arity": 1, "params": "(section)" },
                { "name": "replace", "kind": "method", "arity": 2, "params": "(section, value)" }
            ]
        },
        {
            "name": "sessionIndex",
            "scope": "app",
            "domain": "session",
            "methods": [
                { "name": "list", "kind": "method", "arity": 0, "params": "()" },
                { "name": "get", "kind": "method", "arity": 1, "params": "(sessionId)" },
                { "name": "archive", "kind": "method", "arity": 1, "params": "(sessionId)" },
                { "name": "restore", "kind": "method", "arity": 1, "params": "(sessionId)" }
            ]
        },
        {
            "name": "modelCatalog",
            "scope": "app",
            "domain": "model",
            "methods": [
                { "name": "listModels", "kind": "method", "arity": 0, "params": "()" },
                { "name": "listProviders", "kind": "method", "arity": 0, "params": "()" },
                { "name": "setDefaultModel", "kind": "method", "arity": 1, "params": "(model)" }
            ]
        },
        {
            "name": "workspaceService",
            "scope": "workspace",
            "domain": "workspace",
            "methods": [
                { "name": "list", "kind": "method", "arity": 0, "params": "()" },
                { "name": "get", "kind": "method", "arity": 1, "params": "(workspaceId)" },
                { "name": "update", "kind": "method", "arity": 2, "params": "(workspaceId, patch)" }
            ]
        },
        {
            "name": "agentLoopService",
            "scope": "agent",
            "domain": "loop",
            "methods": [
                { "name": "getModel", "kind": "method", "arity": 0, "params": "()" },
                { "name": "status", "kind": "method", "arity": 0, "params": "()" }
            ]
        },
        {
            "name": "debugEventsService",
            "scope": "app",
            "domain": "debug",
            "methods": [
                { "name": "recentEvents", "kind": "method", "arity": 0, "params": "()" },
                { "name": "subscriptions", "kind": "method", "arity": 0, "params": "()" }
            ]
        },
        {
            "name": "debugGraphService",
            "scope": "app",
            "domain": "debug",
            "methods": [
                { "name": "nodes", "kind": "method", "arity": 0, "params": "()" },
                { "name": "edges", "kind": "method", "arity": 0, "params": "()" },
                { "name": "graph", "kind": "method", "arity": 0, "params": "()" }
            ]
        },
        {
            "name": "debugCascadeService",
            "scope": "app",
            "domain": "debug",
            "methods": [
                { "name": "inspect", "kind": "method", "arity": 0, "params": "()" },
                { "name": "history", "kind": "method", "arity": 0, "params": "()" },
                { "name": "pending", "kind": "method", "arity": 0, "params": "()" }
            ]
        },
        {
            "name": "debugLedgerService",
            "scope": "app",
            "domain": "debug",
            "methods": [
                { "name": "inspect", "kind": "method", "arity": 0, "params": "()" },
                { "name": "tree", "kind": "method", "arity": 0, "params": "()" }
            ]
        }
    ])
}

/// The engine's scope depth: app -> workspace -> session. The DI surface reports
/// it as the cascade "tier" count.
const SCOPE_TIER_COUNT: usize = 3;

/// The live scope tree the DI view renders: the app scope owns one unit per
/// registered service, workspaces own their sessions.
fn build_ledger_tree(server: &HttpServer) -> Value {
    let mut service_units: Vec<Value> = Vec::new();
    if let Some(services) = describe_all_channels().as_array() {
        for (index, service) in services.iter().enumerate() {
            service_units.push(json!({
                "token": service["name"].as_str().unwrap_or("service"),
                "uid": index as u64 + 1,
                "state": "Active",
                "everActive": true,
            }));
        }
    }

    let sessions = server.store().list_sessions().unwrap_or_default();
    let workspaces = server.store().list_workspaces().unwrap_or_default();

    let mut by_workspace: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    let mut ungrouped: Vec<Value> = Vec::new();
    for session in &sessions {
        let node = json!({
            "path": format!("session:{}", session.session_id),
            "label": session.title.clone().unwrap_or_else(|| session.session_id.clone()),
            "units": [],
            "ledger": [],
            "children": [],
        });
        match &session.workspace_id {
            Some(workspace_id) => by_workspace
                .entry(workspace_id.clone())
                .or_default()
                .push(node),
            None => ungrouped.push(node),
        }
    }

    let mut children: Vec<Value> = Vec::new();
    for workspace in &workspaces {
        let owned = by_workspace.remove(&workspace.id).unwrap_or_default();
        children.push(json!({
            "path": format!("workspace:{}", workspace.id),
            "label": workspace.name,
            "units": [],
            "ledger": [],
            "children": owned,
        }));
    }
    // A session whose workspace row is gone still belongs to the tree.
    for (_, owned) in by_workspace {
        children.extend(owned);
    }
    children.extend(ungrouped);

    json!({
        "path": "",
        "label": "engine",
        "units": service_units,
        "ledger": [],
        "children": children,
    })
}

/// Scope-lifecycle history derived from the persisted sessions: each session is
/// a scope provided on creation (and unprovided when archived). The Rust engine
/// has no DI cascade journal, so this is the real persisted lifecycle, not a
/// fabricated teardown trace.
fn session_lifecycle_history(server: &HttpServer) -> Value {
    let mut entries: Vec<Value> = Vec::new();
    for (seq, session) in server
        .store()
        .list_sessions()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
    {
        let scope_path = format!("session:{}", session.session_id);
        entries.push(json!({
            "scopePath": scope_path.clone(),
            "seq": seq as u64 + 1,
            "reason": "created",
            "changes": [{ "token": "session", "action": "provide" }],
            "affected": [],
            "tornDown": [],
            "rebuilt": [],
            "failed": [],
            "abortWaited": false,
            "abortTimedOut": false,
            "durationMs": 0,
        }));
        if session.archived {
            entries.push(json!({
                "scopePath": scope_path,
                "seq": seq as u64 + 1,
                "reason": "archived",
                "changes": [{ "token": "session", "action": "unprovide" }],
                "affected": [],
                "tornDown": [],
                "rebuilt": [],
                "failed": [],
                "abortWaited": false,
                "abortTimedOut": false,
                "durationMs": 0,
            }));
        }
    }
    json!(entries)
}

/// Sessions blocked on a live interaction: each pending question/approval is a
/// unit waiting for its missing input.
fn pending_cascade_groups(server: &HttpServer) -> Value {
    let interactions = server.interaction_manager();
    let mut groups: Vec<Value> = Vec::new();
    for session in server.store().list_sessions().unwrap_or_default() {
        let mut waiting: Vec<Value> = Vec::new();
        for question in interactions.list_questions(&session.session_id) {
            let token = question
                .get("question_id")
                .and_then(|v| v.as_str())
                .unwrap_or("question");
            waiting.push(json!({ "token": token, "missing": ["answer"] }));
        }
        for approval in interactions.list_approvals(&session.session_id) {
            let token = approval
                .get("approval_id")
                .and_then(|v| v.as_str())
                .unwrap_or("approval");
            waiting.push(json!({ "token": token, "missing": ["decision"] }));
        }
        if waiting.is_empty() {
            continue;
        }
        groups.push(json!({
            "scopePath": format!("session:{}", session.session_id),
            "waiting": waiting,
            "failed": [],
        }));
    }
    json!(groups)
}

/// Handle `/api/v1/debug/*` routes.
pub async fn handle_debug_route(server: &HttpServer, req: &HttpRequest) -> Option<HttpResponse> {
    let path = req.path.trim_end_matches('/');
    let req_id = req.request_id();

    // 1. Channel descriptor listing
    if path == "/api/v1/debug/channels" {
        return Some(HttpResponse::envelope_ok(&describe_all_channels(), &req_id));
    }

    // 2. Business snapshot routes
    if path == "/api/v1/debug/workspaces" {
        let list = server.store().list_workspaces().unwrap_or_default();
        return Some(HttpResponse::envelope_ok(
            &json!({ "workspaces": list }),
            &req_id,
        ));
    }

    if let Some(rest) = path.strip_prefix("/api/v1/debug/workspace/")
        && let Some(ws_id) = rest.strip_suffix("/snapshot")
    {
        let Some(ws) = server.store().get_workspace(ws_id).ok().flatten() else {
            return Some(HttpResponse::envelope_err(
                404,
                40400,
                format!("workspace not found: {ws_id}"),
                &req_id,
            ));
        };
        let sessions = server.store().list_sessions().unwrap_or_default();
        let matching_sessions: Vec<_> = sessions
            .into_iter()
            .filter(|s| s.workspace_id.as_deref() == Some(ws_id))
            .collect();
        return Some(HttpResponse::envelope_ok(
            &json!({
                "metadata": {
                    "id": ws.id,
                    "root": ws.root,
                    "name": ws.name,
                    "createdAt": iso_to_millis(&ws.created_at),
                    "lastOpenedAt": iso_to_millis(&ws.last_opened_at),
                },
                "lifecycle": "active",
                "program": Value::Null,
                "runtimes": [],
                "sessions": matching_sessions,
            }),
            &req_id,
        ));
    }

    if let Some(rest) = path.strip_prefix("/api/v1/debug/session/") {
        if let Some(session_id) = rest.strip_suffix("/association") {
            let Some(session) = server.store().get_session(session_id).ok().flatten() else {
                return Some(HttpResponse::envelope_err(
                    404,
                    40400,
                    format!("session not found: {session_id}"),
                    &req_id,
                ));
            };
            let cwd = session_cwd(server.store(), session_id);
            let workspace_id = session
                .workspace_id
                .clone()
                .unwrap_or_else(|| encode_workdir_key(&cwd));
            return Some(HttpResponse::envelope_ok(
                &json!({
                    "sessionId": session_id,
                    "workspaceId": workspace_id,
                    "cwd": cwd,
                }),
                &req_id,
            ));
        }

        if let Some((session_id, rest)) = rest.split_once("/agent/")
            && let Some((agent_id, "runtime-binding")) = rest.split_once('/')
        {
            let Some(session) = server.store().get_session(session_id).ok().flatten() else {
                return Some(HttpResponse::envelope_err(
                    404,
                    40400,
                    format!("session not found: {session_id}"),
                    &req_id,
                ));
            };
            let cwd = session_cwd(server.store(), session_id);
            let workspace_id = session
                .workspace_id
                .clone()
                .unwrap_or_else(|| encode_workdir_key(&cwd));
            let available = server.engine().is_some();
            return Some(HttpResponse::envelope_ok(
                &json!({
                    "sessionId": session_id,
                    "agentId": agent_id,
                    "binding": {
                        "workspaceId": workspace_id,
                        "runtimeId": "local",
                    },
                    "available": available,
                    "runtime": {
                        "runtimeId": "local",
                        "generation": 1,
                        "status": if available { "ready" } else { "unavailable" },
                        "capabilities": ["process", "filesystem", "terminal", "mcp"],
                    },
                }),
                &req_id,
            ));
        }
    }

    // 3. Dynamic service dispatcher:
    // /api/v1/debug[/session/:sid[/agent/:aid]]/:service/:method
    let subpath = path.strip_prefix("/api/v1/debug/")?;
    let segments: Vec<&str> = subpath.split('/').collect();
    let (service, method, session_id) = match segments.as_slice() {
        [service, method] => (*service, *method, None),
        ["session", sid, service, method] => (*service, *method, Some(*sid)),
        ["session", sid, "agent", _aid, service, method] => (*service, *method, Some(*sid)),
        ["workspace", _wid, service, method] => (*service, *method, None),
        _ => return None,
    };

    let body: Value = if req.body.is_empty() {
        json!([])
    } else {
        serde_json::from_slice(&req.body).unwrap_or(json!([]))
    };

    let result = match (service, method) {
        ("configService", "getConfig") => {
            let config = server.config().await;
            crate::server::format_config_response(&config)
        }
        ("configService", "inspect") => {
            let section = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let config = server.config().await;
            // `userValue` is the configured section (or the whole document for
            // an empty section); there is no separate "default" tier to report.
            let user_value = match section {
                "" => serde_json::to_value(&config).unwrap_or(Value::Null),
                "agent" => serde_json::to_value(&config.agent).unwrap_or(Value::Null),
                "shell" => serde_json::to_value(&config.shell).unwrap_or(Value::Null),
                "thinking" => serde_json::to_value(&config.thinking).unwrap_or(Value::Null),
                "permission" => serde_json::to_value(&config.permission).unwrap_or(Value::Null),
                "loop_control" | "loopControl" => {
                    serde_json::to_value(&config.loop_control).unwrap_or(Value::Null)
                }
                "background" => serde_json::to_value(&config.background).unwrap_or(Value::Null),
                "tools" => serde_json::to_value(&config.tools).unwrap_or(Value::Null),
                "mcp" => serde_json::to_value(&config.mcp).unwrap_or(Value::Null),
                "model_catalog" | "modelCatalog" => {
                    serde_json::to_value(&config.model_catalog).unwrap_or(Value::Null)
                }
                _ => Value::Null,
            };
            json!({ "section": section, "userValue": user_value, "defaultValue": Value::Null })
        }
        ("sessionIndex", "list") => {
            let sessions = server.store().list_sessions().unwrap_or_default();
            json!(sessions)
        }
        ("sessionIndex", "get") => {
            let session_id = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let session = server.store().get_session(session_id).ok().flatten();
            json!(session)
        }
        ("modelCatalog", "listModels") => {
            let config = server.config().await;
            let default_model = config.default_model.clone();
            let mut models: Vec<Value> = config
                .models
                .iter()
                .map(|(name, alias)| {
                    json!({
                        "id": name,
                        "model": alias.model.clone().unwrap_or_else(|| name.clone()),
                        "display_name": alias.display_name.clone().unwrap_or_else(|| name.clone()),
                        "provider": alias.provider,
                        "max_context_size": alias
                            .max_context_size
                            .or(alias.max_input_size)
                            .unwrap_or(262_144),
                        "capabilities": alias.capabilities.clone().unwrap_or_default(),
                        "default": default_model.as_deref() == Some(name.as_str()),
                    })
                })
                .collect();
            if models.is_empty() {
                // No `[models]` aliases: report the active engine model so the
                // inspector still has something real to show.
                let active = server
                    .engine()
                    .map(|e| e.model_name().to_string())
                    .unwrap_or_else(|| "kimi-latest".to_string());
                models.push(json!({
                    "id": active,
                    "model": active,
                    "display_name": active,
                    "provider": "default",
                    "max_context_size": 262_144,
                    "capabilities": ["tools", "thinking", "multimodal"],
                    "default": true
                }));
            }
            json!(models)
        }
        ("modelCatalog", "listProviders") => {
            let config = server.config().await;
            let providers: Vec<Value> = config
                .providers
                .iter()
                .map(|(name, provider)| {
                    json!({
                        "id": name,
                        "name": name,
                        "type": provider
                            .provider_type
                            .clone()
                            .unwrap_or_else(|| "openai".to_string()),
                        "base_url": provider.base_url,
                        "oauth": provider.oauth.is_some(),
                    })
                })
                .collect();
            json!(providers)
        }
        ("agentLoopService", "getModel") => {
            let model = session_id
                .and_then(|sid| server.store().get_state("agent_config", sid).ok().flatten())
                .and_then(|c| c.get("model").and_then(|m| m.as_str()).map(str::to_string))
                .or_else(|| server.engine().map(|e| e.model_name().to_string()))
                .unwrap_or_else(|| "kimi-latest".to_string());
            json!(model)
        }
        ("agentLoopService", "status") => {
            let busy = session_id
                .and_then(|sid| server.engine().map(|e| e.is_busy(sid)))
                .unwrap_or(false);
            json!({ "status": if busy { "running" } else { "idle" } })
        }
        ("debugEventsService", "recentEvents") => {
            let events: Vec<Value> = match session_id {
                Some(sid) => server
                    .hub()
                    .replay_for(sid, 0)
                    .into_iter()
                    .rev()
                    .take(100)
                    .map(|event| {
                        json!({
                            "seq": event.seq,
                            "session_id": &*event.session_id,
                            "epoch": &*event.epoch,
                            "type": event.event.event_type(),
                        })
                    })
                    .collect(),
                None => Vec::new(),
            };
            json!({ "subscriptions": [], "buses": [], "events": events })
        }
        ("debugEventsService", "subscriptions") => {
            let hub = server.hub();
            let buses: Vec<Value> = hub
                .lane_session_ids()
                .into_iter()
                .map(|sid| {
                    let (all, per_type) = hub.bus_for(&sid).subscriber_snapshot();
                    json!({ "scopePath": sid, "all": all, "perType": per_type })
                })
                .collect();
            // A live WS connection is the subscriber behind every lane it
            // registered; `unit`/`label` name that connection.
            let subscriptions: Vec<Value> = hub
                .connections()
                .into_iter()
                .flat_map(|conn| {
                    let id = conn.id;
                    conn.subscriptions
                        .into_iter()
                        .map(move |lane| {
                            json!({
                                "scopePath": lane,
                                "unit": format!("ws#{id}"),
                                "label": format!("connection {id}"),
                                "kind": "ws",
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .collect();
            json!({
                "subscriptions": subscriptions,
                "buses": buses,
                "globalListeners": hub.subscriber_count(),
            })
        }
        ("debugGraphService", "nodes") => {
            let (nodes, _) = debug_graph(server);
            json!(nodes)
        }
        ("debugGraphService", "edges") => {
            let (_, edges) = debug_graph(server);
            json!(edges)
        }
        ("debugGraphService", "graph") => {
            let (nodes, edges) = debug_graph(server);
            json!({ "nodes": nodes, "edges": edges })
        }
        ("debugCascadeService", "inspect") => {
            let sessions = server.store().list_sessions().unwrap_or_default();
            let active = sessions.iter().any(|session| {
                server
                    .engine()
                    .map(|engine| engine.is_busy(&session.session_id))
                    .unwrap_or(false)
            });
            json!({ "tiers": SCOPE_TIER_COUNT, "active": active })
        }
        ("debugLedgerService", "inspect") => {
            let services = describe_all_channels()
                .as_array()
                .map(|list| list.len())
                .unwrap_or(0);
            let sessions = server.store().list_sessions().unwrap_or_default().len();
            json!({
                "tiers": SCOPE_TIER_COUNT,
                "active": true,
                "services": services,
                "sessions": sessions,
            })
        }
        ("debugCascadeService", "history") => session_lifecycle_history(server),
        ("debugCascadeService", "pending") => pending_cascade_groups(server),
        ("debugLedgerService", "tree") => build_ledger_tree(server),
        ("configService", "replace") => {
            let section = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let value = body
                .as_array()
                .and_then(|a| a.get(1))
                .cloned()
                .unwrap_or(Value::Null);
            let mut config = server.config().await;
            let applied = match section {
                "agent" => serde_json::from_value(value)
                    .map(|v| config.agent = v)
                    .is_ok(),
                "shell" => serde_json::from_value(value)
                    .map(|v| config.shell = v)
                    .is_ok(),
                "thinking" => serde_json::from_value(value)
                    .map(|v| config.thinking = v)
                    .is_ok(),
                "permission" => serde_json::from_value(value)
                    .map(|v| config.permission = v)
                    .is_ok(),
                "loop_control" | "loopControl" => serde_json::from_value(value)
                    .map(|v| config.loop_control = v)
                    .is_ok(),
                "background" => serde_json::from_value(value)
                    .map(|v| config.background = v)
                    .is_ok(),
                "tools" => serde_json::from_value(value)
                    .map(|v| config.tools = v)
                    .is_ok(),
                "mcp" => serde_json::from_value(value)
                    .map(|v| config.mcp = v)
                    .is_ok(),
                "model_catalog" | "modelCatalog" => serde_json::from_value(value)
                    .map(|v| config.model_catalog = v)
                    .is_ok(),
                _ => false,
            };
            if !applied {
                return Some(HttpResponse::envelope_err(
                    400,
                    40000,
                    format!("cannot replace config section: {section}"),
                    &req_id,
                ));
            }
            *server.config_override.lock().await = Some(config);
            Value::Null
        }
        ("sessionIndex", "archive") => {
            let session_id = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match server.store().archive_session(session_id) {
                Ok(changed) => json!({ "archived": changed }),
                Err(e) => {
                    return Some(HttpResponse::envelope_err(
                        500,
                        50000,
                        format!("Database error: {e}"),
                        &req_id,
                    ));
                }
            }
        }
        ("sessionIndex", "restore") => {
            let session_id = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match server.store().restore_session(session_id) {
                Ok(changed) => json!({ "restored": changed }),
                Err(e) => {
                    return Some(HttpResponse::envelope_err(
                        500,
                        50000,
                        format!("Database error: {e}"),
                        &req_id,
                    ));
                }
            }
        }
        ("modelCatalog", "setDefaultModel") => {
            let model = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut config = server.config().await;
            config.default_model = Some(model.to_string());
            *server.config_override.lock().await = Some(config);
            json!({ "model": model })
        }
        ("workspaceService", "list") => {
            let list = server.store().list_workspaces().unwrap_or_default();
            json!(list)
        }
        ("workspaceService", "get") => {
            let workspace_id = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let workspace = server.store().get_workspace(workspace_id).ok().flatten();
            json!(workspace)
        }
        ("workspaceService", "update") => {
            let workspace_id = body
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let patch = body
                .as_array()
                .and_then(|a| a.get(1))
                .cloned()
                .unwrap_or(Value::Null);
            let name = patch.get("name").and_then(|v| v.as_str()).unwrap_or("");
            match server.store().update_workspace_name(workspace_id, name) {
                Ok(updated) => json!({ "workspace": updated }),
                Err(e) => {
                    return Some(HttpResponse::envelope_err(
                        500,
                        50000,
                        format!("Database error: {e}"),
                        &req_id,
                    ));
                }
            }
        }
        _ => {
            return Some(HttpResponse::envelope_err(
                404,
                40400,
                format!("unknown debug method: {service}.{method}"),
                &req_id,
            ));
        }
    };

    Some(HttpResponse::envelope_ok(&result, &req_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_debug_surface_endpoints() {
        let server = HttpServer::in_memory().unwrap();

        // 1. GET /api/v1/debug/channels
        let res_channels = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/debug/channels".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_channels.status, 200);
        let val_channels: Value = serde_json::from_slice(&res_channels.body).unwrap();
        assert_eq!(val_channels["code"], 0);
        let data = val_channels["data"].as_array().unwrap();
        assert!(data.iter().any(|c| c["name"] == "configService"));
        assert!(data.iter().any(|c| c["name"] == "sessionIndex"));
        assert!(data.iter().any(|c| c["name"] == "debugEventsService"));

        // 2. GET /api/v1/debug/workspaces
        let res_ws = server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: "/api/v1/debug/workspaces".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_ws.status, 200);
        let val_ws: Value = serde_json::from_slice(&res_ws.body).unwrap();
        assert_eq!(val_ws["code"], 0);
        assert!(val_ws["data"]["workspaces"].is_array());

        // 3. POST /api/v1/debug/configService/getConfig
        let res_cfg = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/configService/getConfig".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_cfg.status, 200);
        let val_cfg: Value = serde_json::from_slice(&res_cfg.body).unwrap();
        assert_eq!(val_cfg["code"], 0);

        // 4. POST /api/v1/debug/modelCatalog/listModels
        let res_models = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/modelCatalog/listModels".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_models.status, 200);
        let val_models: Value = serde_json::from_slice(&res_models.body).unwrap();
        assert_eq!(val_models["code"], 0);
        assert!(!val_models["data"].as_array().unwrap().is_empty());

        // 5. POST /api/v1/debug/session/s1/agent/main/agentLoopService/status
        let res_agent = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/session/s1/agent/main/agentLoopService/status".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res_agent.status, 200);
        let val_agent: Value = serde_json::from_slice(&res_agent.body).unwrap();
        assert_eq!(val_agent["code"], 0);
        assert_eq!(val_agent["data"]["status"], "idle");
    }

    /// The channel descriptor is the wire protocol kimi-inspect loads before
    /// it can call anything: every advertised `(service, method)` must dispatch,
    /// and every dispatched method must be advertised. Drift in either
    /// direction silently breaks the inspector's panels, so this is the gate.
    #[tokio::test]
    async fn debug_channel_descriptor_matches_dispatch() {
        let server = HttpServer::in_memory().unwrap();
        let channels = describe_all_channels();
        let mut advertised: Vec<(String, String)> = Vec::new();
        for service in channels.as_array().unwrap() {
            let name = service["name"].as_str().unwrap().to_string();
            for method in service["methods"].as_array().unwrap() {
                advertised.push((name.clone(), method["name"].as_str().unwrap().to_string()));
            }
        }

        // Advertised => must dispatch (a 404 is the "unknown debug method" 404).
        for (service, method) in &advertised {
            let res = server
                .handle_request(&HttpRequest {
                    method: "POST".into(),
                    path: format!("/api/v1/debug/{service}/{method}"),
                    query: None,
                    headers: HashMap::new(),
                    body: Vec::new(),
                })
                .await;
            assert_ne!(
                res.status, 404,
                "advertised but not dispatched: {service}.{method}"
            );
        }

        // Dispatched => must be advertised. Mirrors the match arms in
        // `handle_debug_route`; keep this list in sync with them.
        let dispatched: &[(&str, &str)] = &[
            ("configService", "getConfig"),
            ("configService", "inspect"),
            ("configService", "replace"),
            ("sessionIndex", "list"),
            ("sessionIndex", "get"),
            ("sessionIndex", "archive"),
            ("sessionIndex", "restore"),
            ("modelCatalog", "listModels"),
            ("modelCatalog", "listProviders"),
            ("modelCatalog", "setDefaultModel"),
            ("workspaceService", "list"),
            ("workspaceService", "get"),
            ("workspaceService", "update"),
            ("agentLoopService", "getModel"),
            ("agentLoopService", "status"),
            ("debugEventsService", "recentEvents"),
            ("debugEventsService", "subscriptions"),
            ("debugGraphService", "nodes"),
            ("debugGraphService", "edges"),
            ("debugGraphService", "graph"),
            ("debugCascadeService", "inspect"),
            ("debugCascadeService", "history"),
            ("debugCascadeService", "pending"),
            ("debugLedgerService", "inspect"),
            ("debugLedgerService", "tree"),
        ];
        for (service, method) in dispatched {
            assert!(
                advertised.iter().any(|(s, m)| s == service && m == method),
                "dispatched but not advertised: {service}.{method}"
            );
        }
    }

    /// `debugEventsService.subscriptions` must report the live hub, not an
    /// empty placeholder: a lane with a bus subscriber shows up in `buses`,
    /// and a live WS connection bumps `globalListeners`.
    #[tokio::test]
    async fn debug_event_subscriptions_reflect_live_hub() {
        let server = HttpServer::in_memory().unwrap();
        let _bus_sub = server.hub().bus_for("sess-live").subscribe(|_| {});
        let _conn = server.hub().attach();

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/debugEventsService/subscriptions".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        let data = &val["data"];
        assert!(data["globalListeners"].as_u64().unwrap() >= 1);
        let buses = data["buses"].as_array().unwrap();
        let lane = buses
            .iter()
            .find(|b| b["scopePath"] == "sess-live")
            .expect("sess-live bus present");
        assert!(lane["all"].as_u64().unwrap() >= 1);
    }

    /// `debugLedgerService.tree` reflects the live scopes: the app scope lists
    /// the registered services and a created session appears as a child node.
    #[tokio::test]
    async fn debug_ledger_tree_reflects_live_scopes() {
        let server = HttpServer::in_memory().unwrap();
        server
            .store()
            .create_session("sess-tree", Some("Tree session"))
            .unwrap();

        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/debugLedgerService/tree".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(res.status, 200);
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        let tree = &val["data"];
        assert!(!tree["units"].as_array().unwrap().is_empty());
        let has_session = tree["children"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["path"] == "session:sess-tree");
        assert!(has_session, "session node missing from ledger tree: {tree}");
    }

    /// `debugCascadeService.history` reports the real persisted scope lifecycle
    /// and `pending` reports a live waiting question.
    #[tokio::test]
    async fn debug_cascade_history_and_pending_are_real() {
        let server = HttpServer::in_memory().unwrap();
        server.store().create_session("sess-cas", None).unwrap();
        server.interaction_manager().register_question(
            "sess-cas",
            crate::rpc::types::AskQuestionRequest {
                question_id: "q-cas".into(),
                turn_id: "1".into(),
                tool_call_id: "call-1".into(),
                background: false,
                timeout_ms: None,
                questions: vec![crate::rpc::types::AskQuestionItem {
                    question: "Continue?".into(),
                    header: Some("Confirm".into()),
                    options: vec![],
                    multi_select: false,
                }],
            },
        );

        let history = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/debugCascadeService/history".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let history_val: Value = serde_json::from_slice(&history.body).unwrap();
        let entries = history_val["data"].as_array().unwrap();
        assert!(
            entries
                .iter()
                .any(|entry| entry["scopePath"] == "session:sess-cas"),
            "cascade history missing the session scope: {history_val}"
        );

        let pending = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/debugCascadeService/pending".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let pending_val: Value = serde_json::from_slice(&pending.body).unwrap();
        let group = pending_val["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["scopePath"] == "session:sess-cas")
            .expect("pending group present");
        assert_eq!(group["waiting"][0]["token"], "q-cas");
    }

    #[tokio::test]
    async fn debug_inspect_and_catalog_reflect_configured_values() {
        let server = HttpServer::in_memory().unwrap();
        let mut config = crate::config::KimiConfig::default();
        config.thinking.effort = Some("high".into());
        config.providers.insert(
            "acme".into(),
            crate::config::ProviderConfig {
                default_model: None,
                provider_type: Some("openai".into()),
                api_key: Some("k".into()),
                base_url: Some("https://api.example.test/v1".into()),
                max_tokens: None,
                oauth: None,
                custom_headers: None,
            },
        );
        *server.config_override.lock().await = Some(config);

        // `configService.inspect` returns the configured section, not null.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/configService/inspect".into(),
                query: None,
                headers: HashMap::new(),
                body: serde_json::to_vec(&json!(["thinking"])).unwrap(),
            })
            .await;
        assert_eq!(res.status, 200);
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        assert_eq!(val["data"]["userValue"]["effort"], "high");

        // `modelCatalog.listProviders` lists the configured provider.
        let res = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/modelCatalog/listProviders".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        let val: Value = serde_json::from_slice(&res.body).unwrap();
        assert!(
            val["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == "acme"),
            "configured provider must appear: {val}"
        );
    }

    async fn get(server: &HttpServer, path: &str) -> HttpResponse {
        server
            .handle_request(&HttpRequest {
                method: "GET".into(),
                path: path.into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await
    }

    #[tokio::test]
    async fn test_debug_inspect_snapshots_and_unknown_404() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path().to_string_lossy().to_string();
        let server = HttpServer::in_memory().unwrap();

        let ws = server
            .store()
            .create_workspace(&root, Some("Inspect WS"))
            .unwrap();
        server
            .store()
            .create_session_with_workspace("s1", Some("Inspect Session"), Some(&ws.id))
            .unwrap();
        server
            .store()
            .put_state("metadata", "s1", &json!({ "cwd": root }))
            .unwrap();

        // Session workspace association carries camelCase ids and cwd.
        let assoc = get(&server, "/api/v1/debug/session/s1/association").await;
        assert_eq!(assoc.status, 200);
        let assoc_val: Value = serde_json::from_slice(&assoc.body).unwrap();
        assert_eq!(assoc_val["code"], 0);
        assert_eq!(assoc_val["data"]["sessionId"], "s1");
        assert_eq!(assoc_val["data"]["workspaceId"], ws.id);
        assert_eq!(assoc_val["data"]["cwd"], root);

        // Agent runtime binding exposes the binding + runtime descriptor.
        let binding = get(
            &server,
            "/api/v1/debug/session/s1/agent/main/runtime-binding",
        )
        .await;
        assert_eq!(binding.status, 200);
        let binding_val: Value = serde_json::from_slice(&binding.body).unwrap();
        assert_eq!(binding_val["code"], 0);
        assert_eq!(binding_val["data"]["binding"]["runtimeId"], "local");
        assert!(binding_val["data"]["available"].is_boolean());
        assert!(binding_val["data"]["runtime"]["generation"].is_number());
        assert!(binding_val["data"]["runtime"]["capabilities"].is_array());

        // Workspace snapshot follows the WorkspaceInstanceSnapshot shape.
        let snapshot = get(
            &server,
            &format!("/api/v1/debug/workspace/{}/snapshot", ws.id),
        )
        .await;
        assert_eq!(snapshot.status, 200);
        let snapshot_val: Value = serde_json::from_slice(&snapshot.body).unwrap();
        assert_eq!(snapshot_val["data"]["metadata"]["id"], ws.id);
        assert_eq!(snapshot_val["data"]["lifecycle"], "active");
        assert!(snapshot_val["data"]["sessions"].is_array());

        // Missing session/workspace are honest 404s, not fake successes.
        let missing_session = get(&server, "/api/v1/debug/session/nope/association").await;
        assert_eq!(missing_session.status, 404);
        let missing_session_val: Value = serde_json::from_slice(&missing_session.body).unwrap();
        assert_ne!(missing_session_val["code"], 0);

        let missing_ws = get(&server, "/api/v1/debug/workspace/nope/snapshot").await;
        assert_eq!(missing_ws.status, 404);

        // Unknown RPC methods are 404s (no more fake `{status:"ok"}`).
        let unknown = server
            .handle_request(&HttpRequest {
                method: "POST".into(),
                path: "/api/v1/debug/noSuchService/noSuchMethod".into(),
                query: None,
                headers: HashMap::new(),
                body: Vec::new(),
            })
            .await;
        assert_eq!(unknown.status, 404);
        let unknown_val: Value = serde_json::from_slice(&unknown.body).unwrap();
        assert_ne!(unknown_val["code"], 0);
    }
}
