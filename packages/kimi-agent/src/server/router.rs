//! Lightweight HTTP REST router for Kimi Agent API surface.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn json(status: u16, value: &Value) -> Self {
        let mut headers = HashMap::new();
        headers.insert("Content-Type".into(), "application/json".into());
        let body = serde_json::to_vec(value).unwrap_or_default();
        Self {
            status,
            headers,
            body,
        }
    }

    pub fn ok(value: &Value) -> Self {
        Self::json(200, value)
    }

    pub fn not_found() -> Self {
        Self::json(404, &serde_json::json!({ "error": "Not Found" }))
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::json(400, &serde_json::json!({ "error": msg.into() }))
    }

    pub fn internal_error(msg: impl Into<String>) -> Self {
        Self::json(500, &serde_json::json!({ "error": msg.into() }))
    }
}
