//! Structured MCP transport/protocol errors.
//!
//! Replaces plain-string error propagation at the transport boundary so the
//! `needs-auth` transition reads the real HTTP 401 status instead of sniffing
//! message text (which false-matched on any message containing "401"). The
//! `Display` rendering intentionally keeps the exact wording the previous
//! string errors used, so status panels and tests are unaffected.

use std::fmt;

#[derive(Debug, Clone)]
pub enum McpError {
    /// The remote answered the HTTP request with a non-2xx status.
    HttpStatus { status: u16, message: String },
    /// The server replied with a JSON-RPC error object.
    JsonRpc { message: String },
    /// A request exceeded its resolved deadline.
    Timeout(String),
    /// The transport (child stdout, SSE stream, response channel) closed.
    Closed(String),
    /// Spawn failure, I/O failure, malformed wire data, or any other
    /// transport-level problem without a more specific classification.
    Transport(String),
}

impl McpError {
    pub fn http_status(status: u16, message: impl Into<String>) -> Self {
        McpError::HttpStatus {
            status,
            message: message.into(),
        }
    }

    pub fn json_rpc(message: impl Into<String>) -> Self {
        McpError::JsonRpc {
            message: message.into(),
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        McpError::Timeout(message.into())
    }

    pub fn closed(message: impl Into<String>) -> Self {
        McpError::Closed(message.into())
    }

    pub fn transport(message: impl Into<String>) -> Self {
        McpError::Transport(message.into())
    }

    /// Whether this failure is an HTTP 401, i.e. the rejected-call signal that
    /// flips a remote server into `needs-auth` (v2 `isUnauthorizedLikeError`,
    /// but classified from the status code rather than the message text).
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, McpError::HttpStatus { status: 401, .. })
    }
}

impl fmt::Display for McpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            McpError::HttpStatus { message, .. }
            | McpError::JsonRpc { message }
            | McpError::Timeout(message)
            | McpError::Closed(message)
            | McpError::Transport(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for McpError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_401_is_unauthorized() {
        assert!(
            McpError::http_status(401, "MCP POST failed with status HTTP 401").is_unauthorized()
        );
        assert!(!McpError::http_status(403, "forbidden").is_unauthorized());
        assert!(!McpError::http_status(500, "boom").is_unauthorized());
    }

    #[test]
    fn test_non_http_errors_are_never_unauthorized() {
        assert!(!McpError::json_rpc("MCP Server Error: 401").is_unauthorized());
        assert!(!McpError::transport("connection 401 gone").is_unauthorized());
        assert!(!McpError::timeout("MCP request timed out after 401ms").is_unauthorized());
        assert!(!McpError::closed("401").is_unauthorized());
    }

    #[test]
    fn test_display_keeps_the_contained_message() {
        assert_eq!(
            McpError::http_status(503, "MCP POST failed with status HTTP 503").to_string(),
            "MCP POST failed with status HTTP 503"
        );
        assert_eq!(McpError::closed("stream ended").to_string(), "stream ended");
    }
}
