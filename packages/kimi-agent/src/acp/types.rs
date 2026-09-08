//! ACP (Agent Client Protocol) data structures and JSON-RPC 2.0 schemas.
//!
//! Wire shapes follow the ACP specification (protocol revision 1, camelCase
//! field names). The former snake_case `protocol_version: "0.1.0"` handshake
//! was invented and no real client accepted it.

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

/// Highest ACP protocol revision this server implements (v2
/// `CURRENT_VERSION.protocolVersion`, version.ts:22-26).
pub const ACP_PROTOCOL_VERSION: u32 = 1;

/// Every revision this server can answer with.
const SUPPORTED_PROTOCOL_VERSIONS: &[u32] = &[ACP_PROTOCOL_VERSION];

/// ACP `initialize` request parameters (spec `InitializeRequest`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AcpInitializeParams {
    /// Negotiation integer; the current spec revision is 1.
    #[serde(rename = "protocolVersion", default)]
    pub protocol_version: Option<u32>,
    #[serde(rename = "clientCapabilities", default)]
    pub client_capabilities: Option<Value>,
    #[serde(rename = "clientInfo", default)]
    pub client_info: Option<AcpClientInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpClientInfo {
    pub name: String,
    pub version: String,
}

/// Pick the highest supported revision that does not exceed the client's; a
/// client below the minimum still receives the server's current revision so
/// it can decide whether to disconnect (v2 `negotiateVersion`,
/// version.ts:37-49).
pub fn negotiate_protocol_version(client_version: Option<u32>) -> u32 {
    let requested = client_version.unwrap_or(0);
    SUPPORTED_PROTOCOL_VERSIONS
        .iter()
        .copied()
        .filter(|version| *version <= requested)
        .max()
        .unwrap_or(ACP_PROTOCOL_VERSION)
}

/// The canonical four session modes advertised by `session/new`
/// (`modes.ts:24-46`); order is rendered as-is, so `default` stays first.
pub fn acp_modes() -> Value {
    serde_json::json!([
        {
            "id": "default",
            "name": "Default",
            "description": "Manual approvals; tools execute normally."
        },
        {
            "id": "plan",
            "name": "Plan",
            "description": "Read-only planning; no tool execution."
        },
        {
            "id": "auto",
            "name": "Auto",
            "description": "Auto-approve safe operations."
        },
        {
            "id": "yolo",
            "name": "YOLO",
            "description": "Auto-approve everything."
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v2 `negotiateVersion`: a client below the minimum gets the server's
    /// current revision, an equal or newer client gets the highest mutual one.
    #[test]
    fn test_negotiate_protocol_version() {
        assert_eq!(negotiate_protocol_version(Some(0)), ACP_PROTOCOL_VERSION);
        assert_eq!(negotiate_protocol_version(Some(1)), ACP_PROTOCOL_VERSION);
        assert_eq!(negotiate_protocol_version(Some(99)), ACP_PROTOCOL_VERSION);
        assert_eq!(negotiate_protocol_version(None), ACP_PROTOCOL_VERSION);
    }

    #[test]
    fn test_acp_modes_order_and_ids() {
        let modes = acp_modes();
        let ids: Vec<&str> = modes
            .as_array()
            .expect("modes must be an array")
            .iter()
            .map(|mode| mode["id"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(ids, vec!["default", "plan", "auto", "yolo"]);
    }

    #[test]
    fn test_initialize_params_parse_camel_case() {
        let params: AcpInitializeParams = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": true } },
            "clientInfo": { "name": "zed", "version": "1.0.0" }
        }))
        .expect("ACP params must parse");
        assert_eq!(params.protocol_version, Some(1));
        assert_eq!(
            params.client_capabilities.as_ref().unwrap()["fs"]["readTextFile"],
            true
        );
        assert_eq!(params.client_info.as_ref().unwrap().name, "zed");
    }
}
