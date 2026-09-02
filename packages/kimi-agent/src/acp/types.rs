//! ACP (Agent Client Protocol) data structures and JSON-RPC 2.0 schemas.
//!
//! Provides types for Zed, JetBrains, and other standard ACP IDE clients.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Standard JSON-RPC 2.0 Request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

/// Standard JSON-RPC 2.0 Response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<Value>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<Value>, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }

    pub fn notification(method: impl Into<String>, params: Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: method.into(),
            params: Some(params),
        }
    }
}

/// JSON-RPC 2.0 Error object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// ACP `initialize` Request parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpInitializeParams {
    #[serde(default)]
    pub protocol_version: Option<String>,
    #[serde(default)]
    pub client_info: Option<AcpClientInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpClientInfo {
    pub name: String,
    pub version: String,
}

/// ACP `initialize` Response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpInitializeResult {
    pub protocol_version: String,
    pub agent_info: AcpAgentInfo,
    pub capabilities: AcpCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpAgentInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpCapabilities {
    pub sessions: bool,
    pub tools: bool,
    pub streaming: bool,
}

/// ACP `session/new` Request parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpNewSessionParams {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
}

/// ACP `session/prompt` Request parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpPromptParams {
    pub session_id: String,
    pub prompt: String,
    #[serde(default)]
    pub stream: Option<bool>,
}
