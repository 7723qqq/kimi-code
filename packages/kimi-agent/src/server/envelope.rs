//! Standard JSON response envelope format and protocol error codes.
//!
//! Mirrors kap-server's `okEnvelope`, `errEnvelope`, and `ErrorCode` taxonomy.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod error_codes {
    pub const SUCCESS: u32 = 0;

    pub const VALIDATION_FAILED: u32 = 40001;
    pub const REQUEST_MALFORMED: u32 = 40002;
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
    pub const PLUGIN_NOT_FOUND: u32 = 40419;

    pub const SESSION_BUSY: u32 = 40901;
    pub const APPROVAL_ALREADY_RESOLVED: u32 = 40902;
    pub const QUESTION_DISMISSED: u32 = 40909;

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

#[cfg(test)]
mod tests {
    use super::*;

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
