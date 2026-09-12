//! Standard JSON response envelope format and protocol error codes.
//!
//! Mirrors kap-server's `okEnvelope`, `errEnvelope`, and `ErrorCode` taxonomy.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod error_codes {
    pub const SUCCESS: u32 = 0;

    pub const VALIDATION_FAILED: u32 = 40001;
    pub const REQUEST_MALFORMED: u32 = 40002;
    pub const PROVIDER_OAUTH_MANAGED: u32 = 40003;
    pub const AUTH_TOKEN_UNAUTHORIZED: u32 = 40112;

    pub const SESSION_NOT_FOUND: u32 = 40401;
    pub const PROMPT_NOT_FOUND: u32 = 40402;
    pub const MESSAGE_NOT_FOUND: u32 = 40403;
    pub const APPROVAL_NOT_FOUND: u32 = 40404;
    pub const QUESTION_NOT_FOUND: u32 = 40405;
    pub const TASK_NOT_FOUND: u32 = 40406;
    pub const FILE_NOT_FOUND: u32 = 40407;
    pub const MCP_SERVER_NOT_FOUND: u32 = 40408;
    pub const FS_PATH_NOT_FOUND: u32 = 40409;
    pub const WORKSPACE_NOT_FOUND: u32 = 40410;
    pub const PROVIDER_NOT_FOUND: u32 = 40412;
    pub const MODEL_NOT_FOUND: u32 = 40413;
    pub const PLUGIN_NOT_FOUND: u32 = 40419;

    pub const SESSION_BUSY: u32 = 40901;
    pub const APPROVAL_ALREADY_RESOLVED: u32 = 40902;
    pub const PROMPT_ALREADY_COMPLETED: u32 = 40903;
    pub const PROMPT_ID_CONFLICT: u32 = 40904;
    pub const QUESTION_DISMISSED: u32 = 40909;
    pub const PROVIDER_ALREADY_EXISTS: u32 = 40921;

    pub const INTERNAL_ERROR: u32 = 50001;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub code: u32,
    pub msg: String,
    pub data: Option<T>,
    pub request_id: String,
}

/// Construct a success envelope `{ code: 0, msg: "success", data, request_id }`.
pub fn ok_envelope(data: &Value, request_id: &str) -> Value {
    json!({
        "code": error_codes::SUCCESS,
        "msg": "success",
        "data": data,
        "request_id": request_id,
    })
}

/// Construct an error envelope `{ code, msg, data: null, request_id }`.
pub fn err_envelope(code: u32, msg: &str, request_id: &str) -> Value {
    json!({
        "code": code,
        "msg": msg,
        "data": Value::Null,
        "request_id": request_id,
    })
}

/// Wrap one dispatcher response into the kap-server envelope the Web client's
/// REST transport unwraps:
///
/// - non-JSON bodies (static assets, media, downloads) stay untouched;
/// - a body that is already an envelope (debug routes, 401 challenges) is
///   left as-is;
/// - 2xx bodies become `code: 0` with the original body as `data`;
/// - error bodies keep an explicit non-zero `code` when they carry one,
///   otherwise the status maps onto the closest kap-server code, and the
///   message comes from `error` / `msg` / `message`.
pub fn envelope_response(
    request_id: &str,
    response: crate::server::router::HttpResponse,
) -> crate::server::router::HttpResponse {
    let crate::server::router::HttpResponse {
        status,
        headers,
        body: raw,
    } = response;
    let is_json = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("content-type") && value.to_ascii_lowercase().contains("json")
    });
    if !is_json {
        return crate::server::router::HttpResponse {
            status,
            headers,
            body: raw,
        };
    }
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return crate::server::router::HttpResponse {
            status,
            headers,
            body: raw,
        };
    };
    if is_envelope(&body) {
        return crate::server::router::HttpResponse {
            status,
            headers,
            body: raw,
        };
    }
    let wrapped = if (200..300).contains(&status) {
        ok_envelope(&body, request_id)
    } else {
        let msg = body
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| body.get("msg").and_then(Value::as_str))
            .or_else(|| body.get("message").and_then(Value::as_str))
            .unwrap_or_default();
        let code = body
            .get("code")
            .and_then(Value::as_u64)
            .map(|code| code as u32)
            .filter(|code| *code != error_codes::SUCCESS)
            .unwrap_or_else(|| code_for_status(status));
        err_envelope(code, msg, request_id)
    };
    // The original headers (auth challenge, cache policy, …) survive.
    let mut wrapped_response = crate::server::router::HttpResponse::json(status, &wrapped);
    wrapped_response.headers = headers;
    wrapped_response
}

fn is_envelope(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        ["code", "msg", "data"]
            .iter()
            .all(|key| object.contains_key(*key))
    })
}

/// The closest kap-server code for a status the dispatcher did not annotate.
fn code_for_status(status: u16) -> u32 {
    match status {
        400 | 405 | 422 => error_codes::VALIDATION_FAILED,
        401 | 403 => error_codes::AUTH_TOKEN_UNAUTHORIZED,
        404 => error_codes::SESSION_NOT_FOUND,
        409 => error_codes::SESSION_BUSY,
        500..=599 => error_codes::INTERNAL_ERROR,
        other => other as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::router::HttpResponse;

    #[test]
    fn envelope_response_wraps_json_successes() {
        let response = HttpResponse::json(200, &json!({ "items": [1, 2] }));
        let wrapped = envelope_response("req_1", response);
        assert_eq!(wrapped.status, 200);
        let body: Value = serde_json::from_slice(&wrapped.body).unwrap();
        assert_eq!(body["code"], 0);
        assert_eq!(body["msg"], "success");
        assert_eq!(body["data"]["items"], json!([1, 2]));
        assert_eq!(body["request_id"], "req_1");
    }

    #[test]
    fn envelope_response_wraps_errors_with_mapped_codes() {
        let response = HttpResponse::json(404, &json!({ "error": "Not Found" }));
        let body: Value =
            serde_json::from_slice(&envelope_response("req_2", response).body).unwrap();
        assert_eq!(body["code"], error_codes::SESSION_NOT_FOUND);
        assert_eq!(body["msg"], "Not Found");
        assert!(body["data"].is_null());

        // An explicit code wins over the status mapping.
        let coded = HttpResponse::json(
            404,
            &json!({ "code": error_codes::PROVIDER_NOT_FOUND, "msg": "provider gone" }),
        );
        let body: Value = serde_json::from_slice(&envelope_response("req_3", coded).body).unwrap();
        assert_eq!(body["code"], error_codes::PROVIDER_NOT_FOUND);
        assert_eq!(body["msg"], "provider gone");
    }

    #[test]
    fn envelope_response_keeps_headers_and_passes_existing_envelopes() {
        let response = HttpResponse::json(
            401,
            &json!({ "code": 40101, "msg": "Unauthorized", "data": null }),
        )
        .with_header("WWW-Authenticate", "Bearer realm=\"kimi-code\"");
        let wrapped = envelope_response("req_7", response);
        assert_eq!(wrapped.status, 401);
        assert_eq!(
            wrapped.header("www-authenticate"),
            Some("Bearer realm=\"kimi-code\"")
        );
        // A code+msg+data body is already an envelope and stays byte-level
        // unchanged apart from nothing — the extra keys survive.
        let body: Value = serde_json::from_slice(&wrapped.body).unwrap();
        assert_eq!(body["code"], 40101);
        assert!(body.get("request_id").is_none() || body["request_id"] == "req_7");
    }

    #[test]
    fn envelope_response_leaves_raw_and_enveloped_bodies_alone() {
        // Non-JSON (static asset / download) passes through byte-for-byte.
        let raw = HttpResponse::bytes(200, "text/html", b"<html>".to_vec());
        let wrapped = envelope_response("req_4", raw);
        assert_eq!(wrapped.body, b"<html>");

        // An existing envelope (debug routes) is not wrapped twice.
        let enveloped = HttpResponse::json(200, &ok_envelope(&json!({ "ok": true }), "req_5"));
        let wrapped = envelope_response("req_6", enveloped);
        let body: Value = serde_json::from_slice(&wrapped.body).unwrap();
        assert_eq!(body["request_id"], "req_5");
        assert_eq!(body["data"]["ok"], true);
    }

    #[test]
    fn test_ok_envelope() {
        let val = json!({ "user": "alice", "roles": ["admin", "dev"], "count": 42 });
        let env = ok_envelope(&val, "req_123");
        assert_eq!(env["code"], 0);
        assert_eq!(env["msg"], "success");
        assert_eq!(env["data"]["user"], "alice");
        assert_eq!(env["data"]["roles"], json!(["admin", "dev"]));
        assert_eq!(env["data"]["count"], 42);
        assert_eq!(env["request_id"], "req_123");

        // Envelope struct deserialization round-trip
        let typed: Envelope<serde_json::Value> = serde_json::from_value(env).unwrap();
        assert_eq!(typed.code, 0);
        assert_eq!(typed.msg, "success");
        assert_eq!(typed.request_id, "req_123");
        assert_eq!(typed.data.unwrap()["user"], "alice");
    }

    #[test]
    fn test_err_envelope() {
        let env = err_envelope(
            error_codes::SESSION_NOT_FOUND,
            "session not found",
            "req_456",
        );
        assert_eq!(env["code"], 40401);
        assert_eq!(env["msg"], "session not found");
        assert!(env["data"].is_null());
        assert_eq!(env["request_id"], "req_456");

        let typed: Envelope<String> = serde_json::from_value(env).unwrap();
        assert_eq!(typed.code, error_codes::SESSION_NOT_FOUND);
        assert_eq!(typed.msg, "session not found");
        assert_eq!(typed.request_id, "req_456");
        assert!(typed.data.is_none());
    }

    #[test]
    fn test_error_codes_taxonomy_and_envelope_edge_cases() {
        // Assert exact error codes mapped according to kap-server taxonomy
        assert_eq!(error_codes::SUCCESS, 0);
        assert_eq!(error_codes::VALIDATION_FAILED, 40001);
        assert_eq!(error_codes::REQUEST_MALFORMED, 40002);
        assert_eq!(error_codes::AUTH_TOKEN_UNAUTHORIZED, 40112);
        assert_eq!(error_codes::SESSION_NOT_FOUND, 40401);
        assert_eq!(error_codes::PROMPT_NOT_FOUND, 40402);
        assert_eq!(error_codes::MESSAGE_NOT_FOUND, 40403);
        assert_eq!(error_codes::APPROVAL_NOT_FOUND, 40404);
        assert_eq!(error_codes::QUESTION_NOT_FOUND, 40405);
        assert_eq!(error_codes::TASK_NOT_FOUND, 40406);
        assert_eq!(error_codes::FILE_NOT_FOUND, 40407);
        assert_eq!(error_codes::MCP_SERVER_NOT_FOUND, 40408);
        assert_eq!(error_codes::FS_PATH_NOT_FOUND, 40409);
        assert_eq!(error_codes::WORKSPACE_NOT_FOUND, 40410);
        assert_eq!(error_codes::PLUGIN_NOT_FOUND, 40419);
        assert_eq!(error_codes::SESSION_BUSY, 40901);
        assert_eq!(error_codes::APPROVAL_ALREADY_RESOLVED, 40902);
        assert_eq!(error_codes::QUESTION_DISMISSED, 40909);
        assert_eq!(error_codes::INTERNAL_ERROR, 50001);

        // Edge cases: null data in ok_envelope, empty request_id
        let env_null = ok_envelope(&Value::Null, "");
        assert_eq!(env_null["code"], 0);
        assert_eq!(env_null["msg"], "success");
        assert!(env_null["data"].is_null());
        assert_eq!(env_null["request_id"], "");

        // err_envelope with internal error and empty message
        let env_internal = err_envelope(error_codes::INTERNAL_ERROR, "", "req_empty");
        assert_eq!(env_internal["code"], 50001);
        assert_eq!(env_internal["msg"], "");
        assert_eq!(env_internal["request_id"], "req_empty");
    }
}
