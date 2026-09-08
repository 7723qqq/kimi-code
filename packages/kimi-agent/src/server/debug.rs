//! Debug RPC and reflection surface for Kimi Agent (/api/v1/debug/*).
//!
//! Provides service reflection, business snapshot endpoints, and dynamic RPC dispatch
//! for `apps/kimi-inspect` and developer introspection tools.

use serde_json::{Value, json};

use crate::server::HttpServer;
use crate::server::router::{HttpRequest, HttpResponse};

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
                { "name": "recentEvents", "kind": "method", "arity": 0, "params": "()" }
            ]
        },
        {
            "name": "debugGraphService",
            "scope": "app",
            "domain": "debug",
            "methods": [
                { "name": "nodes", "kind": "method", "arity": 0, "params": "()" },
                { "name": "edges", "kind": "method", "arity": 0, "params": "()" }
            ]
        },
        {
            "name": "debugCascadeService",
            "scope": "app",
            "domain": "debug",
            "methods": [
                { "name": "inspect", "kind": "method", "arity": 0, "params": "()" }
            ]
        },
        {
            "name": "debugLedgerService",
            "scope": "app",
            "domain": "debug",
            "methods": [
                { "name": "inspect", "kind": "method", "arity": 0, "params": "()" }
            ]
        }
    ])
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
        return Some(HttpResponse::envelope_ok(&json!({ "workspaces": list }), &req_id));
    }

    if let Some(rest) = path.strip_prefix("/api/v1/debug/workspace/") {
        if let Some(ws_id) = rest.strip_suffix("/snapshot") {
            let ws = server.store().get_workspace(ws_id).ok().flatten();
            let sessions = server.store().list_sessions().unwrap_or_default();
            let matching_sessions: Vec<_> = sessions
                .into_iter()
                .filter(|s| s.workspace_id.as_deref() == Some(ws_id))
                .collect();
            return Some(HttpResponse::envelope_ok(
                &json!({
                    "workspace": ws,
                    "sessions": matching_sessions,
                }),
                &req_id,
            ));
        }
    }

    if let Some(rest) = path.strip_prefix("/api/v1/debug/session/") {
        if let Some(session_id) = rest.strip_suffix("/association") {
            let session = server.store().get_session(session_id).ok().flatten();
            return Some(HttpResponse::envelope_ok(
                &json!({
                    "session_id": session_id,
                    "workspace_id": session.and_then(|s| s.workspace_id),
                }),
                &req_id,
            ));
        }

        if let Some((session_id, rest)) = rest.split_once("/agent/") {
            if let Some((agent_id, "runtime-binding")) = rest.split_once('/') {
                let default_model = server
                    .engine()
                    .map(|e| e.model_name().to_string())
                    .unwrap_or_else(|| "kimi-latest".to_string());
                return Some(HttpResponse::envelope_ok(
                    &json!({
                        "sessionId": session_id,
                        "agentId": agent_id,
                        "runtimeId": "local",
                        "profile": "coder",
                        "model": default_model,
                    }),
                    &req_id,
                ));
            }
        }
    }

    // 3. Dynamic service dispatcher:
    // /api/v1/debug[/session/:sid[/agent/:aid]]/:service/:method
    let subpath = path.strip_prefix("/api/v1/debug/")?;
    let segments: Vec<&str> = subpath.split('/').collect();
    let (service, method) = match segments.as_slice() {
        [service, method] => (*service, *method),
        ["session", _sid, service, method] => (*service, *method),
        ["session", _sid, "agent", _aid, service, method] => (*service, *method),
        ["workspace", _wid, service, method] => (*service, *method),
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
            let section = body.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or("");
            json!({ "section": section, "userValue": Value::Null, "defaultValue": Value::Null })
        }
        ("sessionIndex", "list") => {
            let sessions = server.store().list_sessions().unwrap_or_default();
            json!(sessions)
        }
        ("sessionIndex", "get") => {
            let session_id = body.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or("");
            let session = server.store().get_session(session_id).ok().flatten();
            json!(session)
        }
        ("modelCatalog", "listModels") => {
            let default_model = server
                .engine()
                .map(|e| e.model_name().to_string())
                .unwrap_or_else(|| "kimi-latest".to_string());
            json!([
                {
                    "id": default_model,
                    "model": default_model,
                    "display_name": format!("Active Model ({default_model})"),
                    "provider": "default",
                    "max_context_size": 262144,
                    "capabilities": ["tools", "thinking", "multimodal"],
                    "default": true
                }
            ])
        }
        ("modelCatalog", "listProviders") => {
            json!([
                { "id": "kimi", "name": "Moonshot / Kimi", "type": "kimi" },
                { "id": "openai", "name": "OpenAI", "type": "openai" },
                { "id": "anthropic", "name": "Anthropic", "type": "anthropic" },
                { "id": "google-genai", "name": "Google Gemini", "type": "google-genai" }
            ])
        }
        ("agentLoopService", "getModel") => {
            let model = server
                .engine()
                .map(|e| e.model_name().to_string())
                .unwrap_or_else(|| "kimi-latest".to_string());
            json!(model)
        }
        ("agentLoopService", "status") => {
            json!({ "status": "idle" })
        }
        ("debugEventsService", "recentEvents") => {
            json!([])
        }
        ("debugGraphService", "nodes") | ("debugGraphService", "edges") => {
            json!([])
        }
        ("debugCascadeService", "inspect") | ("debugLedgerService", "inspect") => {
            json!({ "tiers": 4, "active": true })
        }
        _ => {
            json!({ "service": service, "method": method, "status": "ok" })
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
        assert!(val_models["data"].as_array().unwrap().len() >= 1);

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
}
