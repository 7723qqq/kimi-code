//! Shared HTTP client construction and URL validation for MCP transports.

use std::time::Duration;

/// TCP + TLS connection budget for every MCP HTTP client.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-read idle timeout for ordinary request/response POST clients.
const POST_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Loose idle timeout for a long-lived SSE stream: the stream only ends when
/// the socket delivers no bytes at all for this long. A *total* timeout must
/// never bound an SSE connection — reqwest's `ClientBuilder::timeout` covers
/// the whole response body and would kill every healthy stream after a fixed
/// lifetime (legacy SSE transports stay open for the whole session).
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(300);

/// Per-request backstop when no `toolTimeoutMs` is configured, shared by the
/// stdio, HTTP and SSE transports.
///
/// v2 resolves the tool timeout as `config.toolTimeoutMs ?? defaults.toolTimeoutMs`
/// (`mcpCore/connection-manager.ts:390`) and hands the possibly-`undefined`
/// result to every transport (`mcpCore/client-shared.ts:58`), so the MCP SDK's
/// `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` applies — and that is the value the
/// user docs already promise (`docs/en/configuration/config-files.md` `[mcp]
/// tool_timeout_ms` → `60000`). Before this was shared, the remote transports
/// silently applied 30s: both v2-divergent and a doc/behavior mismatch.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Build the reqwest client used by an MCP HTTP/SSE transport.
///
/// `stream = true` selects the loose idle timeout the GET event stream needs;
/// `false` selects the tighter backstop for POST clients. No total request
/// timeout is set here — per-request deadlines wrap `send()` in the transports
/// and must cover only one round trip, never a session-long SSE stream.
pub fn build_http_client(stream: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(if stream {
            STREAM_READ_TIMEOUT
        } else {
            POST_READ_TIMEOUT
        })
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Validate that `url` is an `http`/`https` URL a remote MCP transport may
/// connect to. A bare syntax check would accept `file:`/`ftp:` and fail only
/// at the first request with a confusing error.
pub fn validate_http_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid MCP url '{url}': {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        other => Err(format!(
            "Invalid MCP url '{url}': unsupported scheme '{other}', expected http or https"
        )),
    }
}

/// One request's deadline budget: the resolved per-request duration, which the
/// timeout message reports, and the instant that duration expires.
///
/// Every leg of a call — the POST, the response body, the SSE reply — is
/// bounded by the same deadline, so `toolTimeoutMs` means "this request
/// finishes within N ms" rather than "each leg gets another N ms".
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub wait: Duration,
    pub deadline: tokio::time::Instant,
}

impl Budget {
    pub fn new(wait: Duration) -> Self {
        Self {
            wait,
            deadline: tokio::time::Instant::now() + wait,
        }
    }

    /// The budget for one request: the resolved `toolTimeoutMs`, or the shared
    /// v2 default when nothing is configured. Every transport enters here so no
    /// transport can drift to its own default again.
    pub fn for_request(configured: Option<Duration>) -> Self {
        Self::new(configured.unwrap_or(DEFAULT_REQUEST_TIMEOUT))
    }
}

/// Whether `target` shares an origin (scheme + host + port) with `base`.
///
/// An SSE `endpoint` event may hand back an absolute URL on another origin;
/// sending the configured `Authorization` header there would leak a bearer
/// token to an attacker-controlled endpoint, so cross-origin POSTs strip it.
pub fn is_same_origin(base: &str, target: &str) -> bool {
    match (url::Url::parse(base), url::Url::parse(target)) {
        (Ok(base), Ok(target)) => {
            base.scheme() == target.scheme()
                && base.host_str() == target.host_str()
                && base.port_or_known_default() == target.port_or_known_default()
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_http_url_accepts_http_and_https() {
        assert!(validate_http_url("http://127.0.0.1:0/mcp").is_ok());
        assert!(validate_http_url("https://example.test/sse").is_ok());
    }

    #[test]
    fn test_validate_http_url_rejects_non_http_schemes_and_garbage() {
        assert!(validate_http_url("file:///etc/passwd").is_err());
        assert!(validate_http_url("ftp://example.test/mcp").is_err());
        assert!(validate_http_url("not a url").is_err());
    }

    /// An unset `toolTimeoutMs` must give every transport the same 60s backstop,
    /// matching v2 leaving the value to the MCP SDK default. Changing this
    /// number is a user-visible behavior change, not a cleanup.
    #[test]
    fn test_unset_tool_timeout_falls_back_to_the_v2_default() {
        assert_eq!(Budget::for_request(None).wait, Duration::from_secs(60));
        assert_eq!(
            Budget::for_request(Some(Duration::from_millis(150))).wait,
            Duration::from_millis(150)
        );
    }

    #[test]
    fn test_same_origin_matches_scheme_host_and_port() {
        assert!(is_same_origin(
            "http://example.test/sse",
            "http://example.test/messages"
        ));
        assert!(is_same_origin(
            "https://example.test/sse",
            "https://example.test:443/messages"
        ));
        assert!(!is_same_origin(
            "http://example.test/sse",
            "http://evil.test/messages"
        ));
        assert!(!is_same_origin(
            "https://example.test/sse",
            "http://example.test/messages"
        ));
        assert!(!is_same_origin(
            "http://example.test:8080/sse",
            "http://example.test:9090/messages"
        ));
    }
}
