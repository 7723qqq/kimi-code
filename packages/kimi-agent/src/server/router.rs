//! Lightweight HTTP REST router for Kimi Agent API surface.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name_lower = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| k.to_ascii_lowercase() == name_lower)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Standard authentication error code used across kap-server and protocol envelope.
pub const AUTH_ERROR_CODE: u32 = 40101;

/// Default WWW-Authenticate realm for Kimi Code authentication challenge.
pub const DEFAULT_AUTH_REALM: &str = "kimi-code";

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

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        let name_lower = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| k.to_ascii_lowercase() == name_lower)
            .map(|(_, v)| v.as_str())
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

    /// Construct a 401 Unauthorized response adhering to standard RFC 9110 / RFC 6750
    /// Bearer authentication challenge and kap-server envelope conventions.
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::unauthorized_with_code(AUTH_ERROR_CODE, msg)
    }

    /// Construct a 401 Unauthorized response with a specific error code,
    /// setting `WWW-Authenticate: Bearer realm="kimi-code"`.
    pub fn unauthorized_with_code(code: u32, msg: impl Into<String>) -> Self {
        Self::unauthorized_challenge(
            code,
            msg,
            format!("Bearer realm=\"{DEFAULT_AUTH_REALM}\""),
        )
    }

    /// Construct a 401 Unauthorized response with an explicit `WWW-Authenticate` challenge header
    /// and normalized JSON envelope (`code`, `msg`, `message`, `error`, `data: null`).
    pub fn unauthorized_challenge(
        code: u32,
        msg: impl Into<String>,
        challenge: impl Into<String>,
    ) -> Self {
        let msg_str = msg.into();
        let mut resp = Self::json(
            401,
            &serde_json::json!({
                "code": code,
                "msg": msg_str,
                "message": msg_str,
                "error": msg_str,
                "data": null,
            }),
        );
        resp.headers.insert("WWW-Authenticate".into(), challenge.into());
        resp
    }

    pub fn internal_error(msg: impl Into<String>) -> Self {
        Self::json(500, &serde_json::json!({ "error": msg.into() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_request_header_case_insensitive() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".into(), "Bearer secret-token".into());
        headers.insert("Content-Type".into(), "application/json".into());

        let req = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/sessions".into(),
            headers,
            body: Vec::new(),
        };

        assert_eq!(req.header("authorization"), Some("Bearer secret-token"));
        assert_eq!(req.header("AUTHORIZATION"), Some("Bearer secret-token"));
        assert_eq!(req.header("Authorization"), Some("Bearer secret-token"));
        assert_eq!(req.header("content-type"), Some("application/json"));
        assert_eq!(req.header("non-existent"), None);
    }

    #[test]
    fn test_unauthorized_default_envelope_and_headers() {
        let resp = HttpResponse::unauthorized("Unauthorized access");
        assert_eq!(resp.status, 401);
        assert_eq!(resp.header("content-type"), Some("application/json"));
        assert_eq!(
            resp.header("www-authenticate"),
            Some("Bearer realm=\"kimi-code\"")
        );

        let json: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
        assert_eq!(json["code"], 40101);
        assert_eq!(json["msg"], "Unauthorized access");
        assert_eq!(json["message"], "Unauthorized access");
        assert_eq!(json["error"], "Unauthorized access");
        assert!(json["data"].is_null());
    }

    #[test]
    fn test_unauthorized_challenge_and_custom_code() {
        let resp = HttpResponse::unauthorized_challenge(
            40110,
            "Invalid token",
            "Bearer error=\"invalid_token\", error_description=\"The access token expired\"",
        );
        assert_eq!(resp.status, 401);
        assert_eq!(
            resp.header("www-authenticate"),
            Some("Bearer error=\"invalid_token\", error_description=\"The access token expired\"")
        );

        let json: serde_json::Value = serde_json::from_slice(&resp.body).unwrap();
        assert_eq!(json["code"], 40110);
        assert_eq!(json["msg"], "Invalid token");
        assert_eq!(json["message"], "Invalid token");
    }

    #[test]
    fn test_http_response_with_header() {
        let resp = HttpResponse::ok(&serde_json::json!({ "status": "ok" }))
            .with_header("X-Request-Id", "req_test_123");

        assert_eq!(resp.status, 200);
        assert_eq!(resp.header("x-request-id"), Some("req_test_123"));
        assert_eq!(resp.header("content-type"), Some("application/json"));
    }
}
