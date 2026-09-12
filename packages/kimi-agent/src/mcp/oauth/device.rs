//! OAuth 2.0 Device Authorization Grant for MCP servers (RFC 8628).
//!
//! Mirrors the login surface v2 exposes through `mcpCore/oauth/provider.ts`
//! and `mcpCore/oauth/service.ts`: start a device authorization, hand the user
//! code to the client, then poll the token endpoint until it answers.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::service::McpOAuthTokens;

const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// What the authorization server returns to `begin_device_login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceCodeStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_in: i64,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_interval() -> u64 {
    5
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// POST the device-authorization endpoint and return the user code plus the
/// polling parameters.
pub async fn begin_device_login(
    client: &reqwest::Client,
    device_authorization_endpoint: &str,
    client_id: &str,
) -> Result<DeviceCodeStart, String> {
    let response = client
        .post(device_authorization_endpoint)
        .form(&[("client_id", client_id)])
        .send()
        .await
        .map_err(|e| format!("device authorization request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "device authorization failed with status HTTP {}",
            response.status()
        ));
    }
    response
        .json::<DeviceCodeStart>()
        .await
        .map_err(|e| format!("device authorization response was not understood: {e}"))
}

/// What a failed poll tells the client to do (RFC 8628 §3.5).
#[derive(Debug, Clone, PartialEq, Eq)]
enum PollAction {
    Retry,
    SlowDown,
    Fail(String),
}

fn poll_action(body: &serde_json::Value, status: reqwest::StatusCode) -> PollAction {
    match body.get("error").and_then(|value| value.as_str()) {
        Some("authorization_pending") => PollAction::Retry,
        Some("slow_down") => PollAction::SlowDown,
        Some("access_denied") => PollAction::Fail("the user denied the login request".into()),
        Some("expired_token") => {
            PollAction::Fail("device code expired before the user approved".into())
        }
        Some(other) => PollAction::Fail(format!("device login failed: {other}")),
        None => PollAction::Fail(format!("device login failed with status HTTP {status}")),
    }
}

/// Poll the token endpoint until the user approves, the code expires, or the
/// request is denied. `authorization_pending` keeps polling; `slow_down` adds
/// five seconds to the interval (RFC 8628 §3.5).
pub async fn poll_device_login(
    client: &reqwest::Client,
    token_endpoint: &str,
    client_id: &str,
    start: &DeviceCodeStart,
) -> Result<McpOAuthTokens, String> {
    let deadline = now_ms() + start.expires_in.max(0) * 1000;
    let mut interval = Duration::from_secs(start.interval.max(1));

    loop {
        if now_ms() >= deadline {
            return Err("device code expired before the user approved".into());
        }
        let response = client
            .post(token_endpoint)
            .form(&[
                ("grant_type", DEVICE_CODE_GRANT),
                ("device_code", start.device_code.as_str()),
                ("client_id", client_id),
            ])
            .send()
            .await
            .map_err(|e| format!("token poll failed: {e}"))?;
        let status = response.status();
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("token response was not understood: {e}"))?;

        if status.is_success() {
            let access_token = body
                .get("access_token")
                .and_then(|value| value.as_str())
                .ok_or("token response had no access_token")?
                .to_string();
            return Ok(McpOAuthTokens {
                access_token,
                refresh_token: body
                    .get("refresh_token")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                expires_at_ms: body
                    .get("expires_in")
                    .and_then(|value| value.as_i64())
                    .map(|secs| now_ms() + secs * 1000),
                token_endpoint: Some(token_endpoint.to_string()),
                client_id: Some(client_id.to_string()),
            });
        }

        match poll_action(&body, status) {
            PollAction::Retry => {}
            PollAction::SlowDown => interval += Duration::from_secs(5),
            PollAction::Fail(message) => return Err(message),
        }
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A mock authorization server that answers with `responses` in order,
    /// repeating the last one.
    pub async fn spawn_mock_oauth_server(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, Arc<AtomicUsize>, tokio::sync::oneshot::Sender<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/oauth");
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_task = hits.clone();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break };
                        let hits = hits_task.clone();
                        let responses = responses.clone();
                        tokio::spawn(async move {
                            let mut buffer = vec![0u8; 4096];
                            let _ = socket.read(&mut buffer).await;
                            let index = hits.fetch_add(1, Ordering::SeqCst);
                            let (status, body) = responses
                                .get(index)
                                .copied()
                                .unwrap_or_else(|| *responses.last().unwrap());
                            let response = format!(
                                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\
                                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = socket.write_all(response.as_bytes()).await;
                            let _ = socket.flush().await;
                        });
                    }
                }
            }
        });
        (url, hits, shutdown_tx)
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::spawn_mock_oauth_server as spawn_server;
    use super::*;

    #[tokio::test]
    async fn test_begin_and_poll_device_login() {
        let (url, _hits, _shutdown) = spawn_server(vec![
            (
                200,
                r#"{"device_code":"dev-1","user_code":"ABCD-EFGH","verification_uri":"https://example.test/device","expires_in":60,"interval":0}"#,
            ),
            (400, r#"{"error":"authorization_pending"}"#),
            (
                200,
                r#"{"access_token":"mcp-token","refresh_token":"refresh-1","expires_in":3600}"#,
            ),
        ])
        .await;
        let client = reqwest::Client::new();

        let start = begin_device_login(&client, &url, "client-1")
            .await
            .expect("device authorization");
        assert_eq!(start.user_code, "ABCD-EFGH");
        assert_eq!(start.verification_uri, "https://example.test/device");
        assert_eq!(start.interval, 0);

        let tokens = poll_device_login(&client, &url, "client-1", &start)
            .await
            .expect("poll until approved");
        assert_eq!(tokens.access_token, "mcp-token");
        assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-1"));
        assert_eq!(tokens.token_endpoint.as_deref(), Some(url.as_str()));
        assert!(tokens.expires_at_ms.is_some());
    }

    /// The RFC 8628 error taxonomy, without the sleeps the poll loop needs.
    #[test]
    fn test_poll_action_classification() {
        let status = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(
            poll_action(
                &serde_json::json!({ "error": "authorization_pending" }),
                status
            ),
            PollAction::Retry
        );
        assert_eq!(
            poll_action(&serde_json::json!({ "error": "slow_down" }), status),
            PollAction::SlowDown
        );
        assert_eq!(
            poll_action(&serde_json::json!({ "error": "access_denied" }), status),
            PollAction::Fail("the user denied the login request".into())
        );
        assert_eq!(
            poll_action(&serde_json::json!({ "error": "expired_token" }), status),
            PollAction::Fail("device code expired before the user approved".into())
        );
        assert_eq!(
            poll_action(&serde_json::json!({}), status),
            PollAction::Fail("device login failed with status HTTP 400 Bad Request".into())
        );
    }

    #[tokio::test]
    async fn test_device_login_denied() {
        let (url, _hits, _shutdown) = spawn_server(vec![
            (
                200,
                r#"{"device_code":"dev-2","user_code":"ZZZZ","verification_uri":"https://example.test/device","expires_in":60,"interval":0}"#,
            ),
            (400, r#"{"error":"access_denied"}"#),
        ])
        .await;
        let client = reqwest::Client::new();
        let start = begin_device_login(&client, &url, "client-1").await.unwrap();
        let err = poll_device_login(&client, &url, "client-1", &start)
            .await
            .expect_err("denied login must fail");
        assert_eq!(err, "the user denied the login request");
    }

    #[tokio::test]
    async fn test_device_authorization_http_error() {
        let (url, _hits, _shutdown) = spawn_server(vec![(500, "{}")]).await;
        let client = reqwest::Client::new();
        let err = begin_device_login(&client, &url, "client-1")
            .await
            .expect_err("500 must fail");
        assert!(err.contains("HTTP 500"), "unexpected error: {err}");
    }
}
