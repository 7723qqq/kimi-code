//! Kimi OAuth — the device flow against the kimi auth server, ported from
//! `kimi-code-oauth` (`requestDeviceAuthorization` / `pollDeviceToken` /
//! `refreshAccessToken`). Form POSTs to `{oauthHost}/api/oauth/*`.

use serde::{Deserialize, Serialize};

/// Total HTTP request timeout for all OAuth requests (mirrors the TS client's
/// 30s default).
const DEFAULT_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Number of refresh attempts (1 initial + 2 retries), matching the TS
/// client's `maxRetries: 3`.
const DEFAULT_MAX_RETRIES: u32 = 3;

/// Build a reqwest client with a total request timeout.
fn http_client(timeout: std::time::Duration) -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(timeout).build()?)
}

/// Default exponential backoff for refresh retries: 1s, 2s, 4s, … (`2^attempt`).
fn default_backoff(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(1 << attempt)
}

/// Endpoints of the kimi OAuth server (defaults from `KIMI_CODE_FLOW_CONFIG`).
#[derive(Debug, Clone)]
pub struct OAuthFlowConfig {
    pub oauth_host: String,
    pub client_id: String,
}

impl OAuthFlowConfig {
    /// The production kimi flow config.
    pub fn kimi() -> Self {
        Self {
            oauth_host: "https://kimi.moonshot.cn".to_string(),
            client_id: "kimicode-cli".to_string(),
        }
    }
}

/// Response of `POST /api/oauth/device_authorization`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub interval: Option<u64>,
}

/// Outcome of one token poll.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DevicePollResult {
    /// The user has not approved yet.
    Pending,
    /// The token was granted.
    Success {
        access_token: String,
        refresh_token: Option<String>,
        #[serde(default)]
        expires_in: Option<u64>,
    },
    /// The device code expired before approval.
    Expired,
    /// The request was denied.
    Denied,
}

/// A granted token pair from a completed device flow or a refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceToken {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

/// Request a device authorization (user opens `verification_uri` and enters
/// `user_code`).
pub async fn request_device_authorization(
    config: &OAuthFlowConfig,
) -> anyhow::Result<DeviceAuthorization> {
    let url = format!(
        "{}/api/oauth/device_authorization",
        config.oauth_host.trim_end_matches('/')
    );
    let client = http_client(DEFAULT_HTTP_TIMEOUT)?;
    let body = client
        .post(&url)
        .form(&[("client_id", config.client_id.as_str())])
        .send()
        .await?
        .error_for_status()?;
    Ok(body.json().await?)
}

/// Poll the token endpoint; callers retry on `Pending` with the configured
/// (or default 5s) interval.
///
/// Error responses are classified by the OAuth `error` code:
/// `authorization_pending` / `slow_down` → `Pending`, `expired_token` →
/// `Expired`, `access_denied` → `Denied`. Any other code (including unknown
/// ones) is an immediate error — a hard rejection must never be swallowed as
/// `Pending`, which would spin the caller into an endless poll loop.
pub async fn poll_device_token(
    config: &OAuthFlowConfig,
    device_code: &str,
) -> anyhow::Result<DevicePollResult> {
    poll_device_token_inner(config, device_code, DEFAULT_HTTP_TIMEOUT).await
}

async fn poll_device_token_inner(
    config: &OAuthFlowConfig,
    device_code: &str,
    timeout: std::time::Duration,
) -> anyhow::Result<DevicePollResult> {
    let url = format!("{}/api/oauth/token", config.oauth_host.trim_end_matches('/'));
    let client = http_client(timeout)?;
    let resp = client
        .post(&url)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        // A success response must carry a non-empty access_token; anything
        // else is a malformed response, not a pending state.
        if let Some(token) = value.get("access_token").and_then(|v| v.as_str()) {
            if !token.is_empty() {
                return Ok(DevicePollResult::Success {
                    access_token: token.to_string(),
                    refresh_token: value
                        .get("refresh_token")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    expires_in: value.get("expires_in").and_then(|v| v.as_u64()),
                });
            }
        }
        anyhow::bail!("token poll returned HTTP 200 without a non-empty access_token: {text}");
    }
    if status.as_u16() >= 500 {
        anyhow::bail!("token poll failed: server error (HTTP {status}): {text}");
    }
    let error_code = value
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown_error");
    match error_code {
        "authorization_pending" | "slow_down" => Ok(DevicePollResult::Pending),
        "expired_token" => Ok(DevicePollResult::Expired),
        "access_denied" => Ok(DevicePollResult::Denied),
        _ => anyhow::bail!(
            "token poll failed: unexpected error `{error_code}` (HTTP {status}): {text}"
        ),
    }
}

/// Refresh an access token with a refresh token.
///
/// Transient failures — transport errors (DNS, refused, timeout) and HTTP
/// 429/5xx — are retried up to `DEFAULT_MAX_RETRIES` attempts with exponential
/// backoff; 401/403 and `invalid_grant` fail immediately without retrying. The
/// refreshed pair is returned: the server may rotate `refresh_token`, and
/// `expires_in` (seconds) is surfaced when provided.
pub async fn refresh_access_token(
    config: &OAuthFlowConfig,
    refresh_token: &str,
) -> anyhow::Result<DeviceToken> {
    refresh_access_token_inner(config, refresh_token, DEFAULT_MAX_RETRIES, default_backoff).await
}

async fn refresh_access_token_inner(
    config: &OAuthFlowConfig,
    refresh_token: &str,
    max_retries: u32,
    backoff: impl Fn(u32) -> std::time::Duration,
) -> anyhow::Result<DeviceToken> {
    let url = format!("{}/api/oauth/token", config.oauth_host.trim_end_matches('/'));
    let client = http_client(DEFAULT_HTTP_TIMEOUT)?;
    let mut last_error: Option<anyhow::Error> = None;
    for attempt in 0..max_retries {
        let resp = match client
            .post(&url)
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(error) => {
                // Transport-level failure (DNS, connection refused, timeout) —
                // retryable, matching the TS client's transport-error handling.
                if attempt + 1 < max_retries {
                    last_error = Some(
                        anyhow::Error::new(error).context("token refresh request failed"),
                    );
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                return Err(anyhow::Error::new(error).context("token refresh request failed"));
            }
        };
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let value: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);

        if status.is_success() {
            if let Some(token) = value.get("access_token").and_then(|v| v.as_str()) {
                if !token.is_empty() {
                    return Ok(DeviceToken {
                        access_token: token.to_string(),
                        refresh_token: value
                            .get("refresh_token")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        expires_in: value.get("expires_in").and_then(|v| v.as_u64()),
                    });
                }
            }
            anyhow::bail!(
                "token refresh returned HTTP 200 without a non-empty access_token: {text}"
            );
        }

        let error_code = value.get("error").and_then(|v| v.as_str()).unwrap_or("");
        if status.as_u16() == 401 || status.as_u16() == 403 || error_code == "invalid_grant" {
            anyhow::bail!("token refresh unauthorized (HTTP {status}): {text}");
        }
        let retryable = status.as_u16() == 429 || status.as_u16() >= 500;
        if retryable {
            last_error = Some(anyhow::anyhow!(
                "token refresh retryable failure (HTTP {status}): {text}"
            ));
            if attempt + 1 < max_retries {
                tokio::time::sleep(backoff(attempt)).await;
                continue;
            }
        } else {
            anyhow::bail!("token refresh failed (HTTP {status}): {text}");
        }
    }
    Err(last_error
        .unwrap_or_else(|| anyhow::anyhow!("token refresh failed after {max_retries} attempts")))
}

/// Run the full device authorization flow: request a device code, surface the
/// verification info via `on_prompt`, then poll until the user approves (or
/// `max_polls` is exhausted). Returns the granted token pair.
pub async fn run_device_flow(
    config: &OAuthFlowConfig,
    max_polls: Option<u32>,
    on_prompt: &mut impl FnMut(&DeviceAuthorization),
) -> anyhow::Result<DeviceToken> {
    let auth = request_device_authorization(config).await?;
    on_prompt(&auth);
    let interval = auth.interval.unwrap_or(5);
    let polls = max_polls.unwrap_or(u32::MAX);
    for _ in 0..polls {
        match poll_device_token(config, &auth.device_code).await? {
            DevicePollResult::Success {
                access_token,
                refresh_token,
                expires_in,
            } => {
                return Ok(DeviceToken {
                    access_token,
                    refresh_token,
                    expires_in,
                });
            }
            DevicePollResult::Pending => {
                tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            }
            DevicePollResult::Expired => anyhow::bail!("device code expired before approval"),
            DevicePollResult::Denied => anyhow::bail!("authorization denied by the user"),
        }
    }
    anyhow::bail!("device flow timed out after {polls} polls")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serve canned responses on a local port, one per incoming request. A
    /// `None` entry closes the connection without responding (simulates a
    /// transport-level failure). Returns the host URL and a hit counter.
    async fn mock_server_sequence(
        responses: Vec<Option<(&'static str, u16)>>,
    ) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_task = hits.clone();
        tokio::spawn(async move {
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await.unwrap();
                hits_for_task.fetch_add(1, Ordering::SeqCst);
                let Some((body, status)) = response else {
                    continue;
                };
                let resp = format!(
                    "HTTP/1.1 {status} OK
Content-Type: application/json
Content-Length: {}
Connection: close

{}",
                    body.len(),
                    body
                );
                socket.write_all(resp.as_bytes()).await.unwrap();
            }
        });
        (format!("http://127.0.0.1:{port}"), hits)
    }

    /// Serve one canned response on a local port. The server task is
    /// detached (no await-before-request deadlock on the current-thread test
    /// runtime).
    async fn mock_server(response: &'static str, status: u16) -> String {
        mock_server_sequence(vec![Some((response, status))]).await.0
    }

    fn test_config(host: String) -> OAuthFlowConfig {
        OAuthFlowConfig { oauth_host: host, client_id: "test-client".into() }
    }

    #[tokio::test]
    async fn device_authorization_parses() {
        let json = r#"{"device_code":"dc-1","user_code":"ABCD-EFGH","verification_uri":"https://kimi.moonshot.cn/device","verification_uri_complete":"https://kimi.moonshot.cn/device?code=ABCD-EFGH","expires_in":600,"interval":5}"#;
        let host = mock_server(json, 200).await;
        let config = test_config(host);
        let auth = request_device_authorization(&config).await.unwrap();
        assert_eq!(auth.device_code, "dc-1");
        assert_eq!(auth.user_code, "ABCD-EFGH");
        assert_eq!(auth.verification_uri, "https://kimi.moonshot.cn/device");
        assert_eq!(auth.expires_in, Some(600));
        assert_eq!(auth.interval, Some(5));
    }

    #[tokio::test]
    async fn token_poll_success() {
        let host = mock_server(
            r#"{"access_token":"tok-1","refresh_token":"ref-1","expires_in":3600}"#,
            200,
        )
        .await;
        let config = test_config(host);
        match poll_device_token(&config, "dc-1").await.unwrap() {
            DevicePollResult::Success {
                access_token,
                refresh_token,
                expires_in,
            } => {
                assert_eq!(access_token, "tok-1");
                assert_eq!(refresh_token.as_deref(), Some("ref-1"));
                assert_eq!(expires_in, Some(3600));
            }
            other => panic!("expected success, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn token_poll_pending_error_codes() {
        for body in [
            r#"{"error":"authorization_pending"}"#,
            r#"{"error":"slow_down"}"#,
        ] {
            let host = mock_server(body, 400).await;
            let config = test_config(host);
            match poll_device_token(&config, "dc-1").await.unwrap() {
                DevicePollResult::Pending => {}
                other => panic!("expected pending for {body}, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn token_poll_expired_and_denied() {
        let host = mock_server(r#"{"error":"expired_token"}"#, 400).await;
        let config = test_config(host);
        match poll_device_token(&config, "dc-1").await.unwrap() {
            DevicePollResult::Expired => {}
            other => panic!("expected expired, got {other:?}"),
        }

        let host = mock_server(r#"{"error":"access_denied"}"#, 400).await;
        let config = test_config(host);
        match poll_device_token(&config, "dc-1").await.unwrap() {
            DevicePollResult::Denied => {}
            other => panic!("expected denied, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn token_poll_unknown_error_code_is_fatal() {
        let host = mock_server(r#"{"error":"unexpected_error_code"}"#, 400).await;
        let config = test_config(host);
        let error = poll_device_token(&config, "dc-1").await.unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("unexpected_error_code"), "unexpected error: {message}");
        assert!(message.contains("400"), "unexpected error: {message}");
    }

    #[tokio::test]
    async fn token_poll_server_error_is_fatal() {
        let host = mock_server(r#"{"error":"internal"}"#, 503).await;
        let config = test_config(host);
        let error = poll_device_token(&config, "dc-1").await.unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("503"), "unexpected error: {message}");
    }

    #[tokio::test]
    async fn token_poll_success_missing_access_token_is_fatal() {
        let host = mock_server(r#"{"refresh_token":"ref-1","expires_in":3600}"#, 200).await;
        let config = test_config(host);
        let error = poll_device_token(&config, "dc-1").await.unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("access_token"), "unexpected error: {message}");
    }

    #[tokio::test]
    async fn token_poll_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            // Hold the connection open without responding so the client hits
            // its request timeout.
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        let config = test_config(format!("http://127.0.0.1:{port}"));
        let error =
            poll_device_token_inner(&config, "dc-1", Duration::from_millis(200)).await.unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("timed out"), "unexpected error: {message}");
    }

    #[tokio::test]
    async fn refresh_exchanges_token() {
        let host = mock_server(
            r#"{"access_token":"tok-2","refresh_token":"ref-2","expires_in":3600}"#,
            200,
        )
        .await;
        let config = test_config(host);
        let token = refresh_access_token(&config, "ref-1").await.unwrap();
        assert_eq!(token.access_token, "tok-2");
        // A rotated refresh token from the server is surfaced to the caller.
        assert_eq!(token.refresh_token.as_deref(), Some("ref-2"));
        assert_eq!(token.expires_in, Some(3600));
    }

    #[tokio::test]
    async fn refresh_retries_transient_http_errors() {
        let (host, hits) = mock_server_sequence(vec![
            Some((r#"{"error":"temporarily_unavailable"}"#, 429)),
            Some((r#"{"error":"internal"}"#, 500)),
            Some((r#"{"access_token":"tok-3","expires_in":1800}"#, 200)),
        ])
        .await;
        let config = test_config(host);
        let token =
            refresh_access_token_inner(&config, "ref-1", 3, |_| Duration::ZERO).await.unwrap();
        assert_eq!(token.access_token, "tok-3");
        assert_eq!(token.expires_in, Some(1800));
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn refresh_retries_transport_errors() {
        let (host, hits) = mock_server_sequence(vec![
            None, // connection closed without a response
            Some((r#"{"access_token":"tok-4"}"#, 200)),
        ])
        .await;
        let config = test_config(host);
        let token =
            refresh_access_token_inner(&config, "ref-1", 3, |_| Duration::ZERO).await.unwrap();
        assert_eq!(token.access_token, "tok-4");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn refresh_unauthorized_is_not_retried() {
        for (body, status) in [
            (r#"{"error":"invalid_grant"}"#, 400u16),
            (r#"{"error":"invalid_token"}"#, 401u16),
            (r#"{"error":"forbidden"}"#, 403u16),
        ] {
            let (host, hits) = mock_server_sequence(vec![
                Some((body, status)),
                Some((r#"{"access_token":"should-not-happen"}"#, 200)),
            ])
            .await;
            let config = test_config(host);
            let error =
                refresh_access_token_inner(&config, "ref-1", 3, |_| Duration::ZERO).await.unwrap_err();
            let message = format!("{error:#}");
            assert!(message.contains("unauthorized"), "unexpected error: {message}");
            // Unauthorized must fail immediately — no retry.
            assert_eq!(hits.load(Ordering::SeqCst), 1, "unauthorized must not be retried");
        }
    }

    #[tokio::test]
    async fn refresh_retries_exhausted() {
        let (host, hits) = mock_server_sequence(vec![
            Some((r#"{"error":"internal"}"#, 500)),
            Some((r#"{"error":"internal"}"#, 500)),
            Some((r#"{"error":"internal"}"#, 500)),
        ])
        .await;
        let config = test_config(host);
        let error =
            refresh_access_token_inner(&config, "ref-1", 3, |_| Duration::ZERO).await.unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("500"), "unexpected error: {message}");
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn refresh_success_missing_access_token_is_fatal() {
        let host = mock_server(r#"{"expires_in":3600}"#, 200).await;
        let config = test_config(host);
        let error = refresh_access_token(&config, "ref-1").await.unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("access_token"), "unexpected error: {message}");
    }
}
