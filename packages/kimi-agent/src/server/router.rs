//! Lightweight HTTP REST router for Kimi Agent API surface.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn query_param(&self, key: &str) -> Option<String> {
        let q = self.query.as_deref()?;
        for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
            if k == key {
                return Some(v.into_owned());
            }
        }
        None
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        let name_lower = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| k.to_ascii_lowercase() == name_lower)
            .map(|(_, v)| v.as_str())
    }

    /// Extract or generate an X-Request-ID for tracing.
    pub fn request_id(&self) -> String {
        self.header("x-request-id")
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("req_{}", fastrand::u64(..)))
    }

    /// Check if the request explicitly asks for envelope wrapping.
    pub fn wants_envelope(&self) -> bool {
        if let Some(val) = self.header("x-envelope")
            && (val.eq_ignore_ascii_case("true") || val == "1")
        {
            return true;
        }
        if let Some(val) = self.query_param("envelope")
            && (val == "1" || val.eq_ignore_ascii_case("true"))
        {
            return true;
        }
        false
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

    pub fn bytes(status: u16, content_type: impl Into<String>, body: Vec<u8>) -> Self {
        let mut headers = HashMap::new();
        headers.insert("Content-Type".into(), content_type.into());
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

    /// Construct a success envelope `{ code: 0, msg: "success", data, request_id }`.
    pub fn envelope_ok(data: &Value, request_id: &str) -> Self {
        let env = serde_json::json!({
            "code": 0,
            "msg": "success",
            "data": data,
            "request_id": request_id,
        });
        Self::json(200, &env)
    }

    /// Construct an error envelope `{ code, msg, data: null, request_id }`.
    pub fn envelope_err(status: u16, code: u32, msg: impl Into<String>, request_id: &str) -> Self {
        let msg_str = msg.into();
        let env = serde_json::json!({
            "code": code,
            "msg": msg_str,
            "data": Value::Null,
            "request_id": request_id,
        });
        Self::json(status, &env)
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
        Self::unauthorized_challenge(code, msg, format!("Bearer realm=\"{DEFAULT_AUTH_REALM}\""))
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
        resp.headers
            .insert("WWW-Authenticate".into(), challenge.into());
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
            query: None,
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
    fn test_http_request_query_param() {
        let req = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/fs:browse".into(),
            query: Some("path=%2Fhome%2Fuser&limit=10&flag".into()),
            headers: HashMap::new(),
            body: Vec::new(),
        };

        assert_eq!(req.query_param("path"), Some("/home/user".into()));
        assert_eq!(req.query_param("limit"), Some("10".into()));
        assert_eq!(req.query_param("flag"), Some("".into()));
        assert_eq!(req.query_param("other"), None);

        let req_no_query = HttpRequest {
            method: "GET".into(),
            path: "/api/v1/test".into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert_eq!(req_no_query.query_param("path"), None);
    }

    #[test]
    fn test_http_request_id_and_wants_envelope() {
        // 1. Explicit request id
        let mut headers = HashMap::new();
        headers.insert("X-Request-Id".into(), "req_explicit_456".into());
        let req_with_id = HttpRequest {
            method: "GET".into(),
            path: "/".into(),
            query: None,
            headers,
            body: Vec::new(),
        };
        assert_eq!(req_with_id.request_id(), "req_explicit_456");

        // 2. Fallback generated request id starts with req_
        let req_fallback = HttpRequest {
            method: "GET".into(),
            path: "/".into(),
            query: None,
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let gen_id = req_fallback.request_id();
        assert!(gen_id.starts_with("req_"));
        assert!(gen_id.len() > 4);

        // 3. wants_envelope via X-Envelope header ("true" / "1")
        for val in ["true", "TRUE", "True", "1"] {
            let mut h = HashMap::new();
            h.insert("X-Envelope".into(), val.into());
            let req = HttpRequest {
                method: "GET".into(),
                path: "/".into(),
                query: None,
                headers: h,
                body: Vec::new(),
            };
            assert!(req.wants_envelope(), "expected wants_envelope for header {val}");
        }

        // 4. wants_envelope via query param (?envelope=1 / ?envelope=true)
        for q in ["envelope=1", "envelope=true", "envelope=TRUE", "foo=bar&envelope=1"] {
            let req = HttpRequest {
                method: "GET".into(),
                path: "/".into(),
                query: Some(q.into()),
                headers: HashMap::new(),
                body: Vec::new(),
            };
            assert!(req.wants_envelope(), "expected wants_envelope for query {q}");
        }

        // 5. Negative wants_envelope cases
        for q in ["envelope=0", "envelope=false", "foo=bar"] {
            let req = HttpRequest {
                method: "GET".into(),
                path: "/".into(),
                query: Some(q.into()),
                headers: HashMap::new(),
                body: Vec::new(),
            };
            assert!(!req.wants_envelope(), "expected not wants_envelope for query {q}");
        }
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
    fn test_http_response_constructors_and_envelopes() {
        let resp = HttpResponse::ok(&serde_json::json!({ "status": "ok" }))
            .with_header("X-Request-Id", "req_test_123");

        assert_eq!(resp.status, 200);
        assert_eq!(resp.header("x-request-id"), Some("req_test_123"));
        assert_eq!(resp.header("content-type"), Some("application/json"));

        // envelope_ok
        let env_ok = HttpResponse::envelope_ok(&serde_json::json!({ "id": "sess-1" }), "req-99");
        assert_eq!(env_ok.status, 200);
        let ok_val: Value = serde_json::from_slice(&env_ok.body).unwrap();
        assert_eq!(ok_val["code"], 0);
        assert_eq!(ok_val["msg"], "success");
        assert_eq!(ok_val["data"]["id"], "sess-1");
        assert_eq!(ok_val["request_id"], "req-99");

        // envelope_err
        let env_err = HttpResponse::envelope_err(404, 40401, "Session not found", "req-err");
        assert_eq!(env_err.status, 404);
        let err_val: Value = serde_json::from_slice(&env_err.body).unwrap();
        assert_eq!(err_val["code"], 40401);
        assert_eq!(err_val["msg"], "Session not found");
        assert!(err_val["data"].is_null());
        assert_eq!(err_val["request_id"], "req-err");

        // not_found, bad_request, internal_error, bytes
        let nf = HttpResponse::not_found();
        assert_eq!(nf.status, 404);
        let nf_val: Value = serde_json::from_slice(&nf.body).unwrap();
        assert_eq!(nf_val["error"], "Not Found");

        let br = HttpResponse::bad_request("invalid param");
        assert_eq!(br.status, 400);
        let br_val: Value = serde_json::from_slice(&br.body).unwrap();
        assert_eq!(br_val["error"], "invalid param");

        let ie = HttpResponse::internal_error("db crash");
        assert_eq!(ie.status, 500);
        let ie_val: Value = serde_json::from_slice(&ie.body).unwrap();
        assert_eq!(ie_val["error"], "db crash");

        let custom_bytes = HttpResponse::bytes(206, "video/mp4", vec![1, 2, 3, 4]);
        assert_eq!(custom_bytes.status, 206);
        assert_eq!(custom_bytes.header("content-type"), Some("video/mp4"));
        assert_eq!(custom_bytes.body, vec![1, 2, 3, 4]);
    }
}
