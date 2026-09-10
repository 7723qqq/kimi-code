//! OAuth device-code flow and managed account status for the native server.
//!
//! Real HTTP implementation mirroring `packages/oauth` (src/oauth.ts): the
//! three form endpoints against the OAuth host, the pending/expired/denied
//! poll taxonomy, refresh-on-401 for managed API reads, and the
//! `~/.kimi-code/credentials/<name>.json` token persistence (storage.ts wire
//! format, shared with the TS host).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_OAUTH_HOST: &str = "https://auth.kimi.com";
const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_MANAGED_BASE_URL: &str = "https://api.kimi.com/coding/v1";
const DEVICE_AUTH_PATH: &str = "/api/oauth/device_authorization";
const TOKEN_PATH: &str = "/api/oauth/token";
const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;
const DEFAULT_FLOW_TTL_SECS: u64 = 900;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const REFRESH_MAX_ATTEMPTS: u32 = 3;
const REFRESH_RETRYABLE_STATUSES: [u16; 5] = [429, 500, 502, 503, 504];

fn oauth_host() -> String {
    std::env::var("KIMI_CODE_OAUTH_HOST")
        .or_else(|_| std::env::var("KIMI_OAUTH_HOST"))
        .unwrap_or_else(|_| DEFAULT_OAUTH_HOST.to_string())
}

fn credentials_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("KIMI_CODE_CREDENTIALS_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    Some(home.join(".kimi-code").join("credentials"))
}

/// What REST clients poll while a device login runs (kap-server contract).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthFlowSnapshot {
    pub provider: String,
    pub status: String, // "pending", "success", "expired", "denied", "cancelled", "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredToken {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    scope: String,
    token_type: String,
    expires_in: i64,
}

struct FlowState {
    snapshot: OAuthFlowSnapshot,
    device_code: String,
    interval: u64,
    ttl_secs: u64,
    /// Bumped on cancel/logout so a live poller stops instead of resurrecting
    /// a cancelled flow.
    generation: u64,
}

#[derive(Default)]
struct OAuthManagerInner {
    flows: Mutex<HashMap<String, FlowState>>,
    tokens: Mutex<HashMap<String, StoredToken>>,
    generation: AtomicU64,
}

/// Drives real device-code logins against the Kimi OAuth host.
pub struct OAuthManager {
    inner: OAuthManagerInner,
    client: reqwest::Client,
    oauth_host: String,
    managed_base_url: String,
    credentials_dir: Option<PathBuf>,
}

impl Default for OAuthManager {
    fn default() -> Self {
        Self::new()
    }
}

impl OAuthManager {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            inner: OAuthManagerInner::default(),
            client,
            oauth_host: oauth_host(),
            managed_base_url: std::env::var("KIMI_CODE_MANAGED_BASE_URL")
                .unwrap_or_else(|_| DEFAULT_MANAGED_BASE_URL.to_string()),
            credentials_dir: credentials_dir(),
        }
    }

    /// Test seam: point the flow at a local mock authorization server and a
    /// temp credentials dir.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_hosts(
        oauth_host: String,
        managed_base_url: String,
        credentials_dir: Option<PathBuf>,
    ) -> Self {
        let mut manager = Self::new();
        manager.oauth_host = oauth_host;
        manager.managed_base_url = managed_base_url;
        manager.credentials_dir = credentials_dir;
        manager
    }

    /// POST form-encoded to the OAuth host, mirroring TS `postForm`
    /// (oauth.ts:71-125): JSON-accepting, 30s timeout, and credentials are
    /// refused on non-HTTPS endpoints outside loopback.
    async fn post_form(&self, path: &str, params: &[(&str, &str)]) -> Result<(u16, Value), String> {
        if let Some(host) = self.oauth_host.strip_prefix("http://") {
            let authority = host.split('/').next().unwrap_or(host);
            let loopback = authority.starts_with("localhost")
                || authority.starts_with("127.0.0.1")
                || authority.starts_with("[::1]");
            if !loopback {
                return Err(format!(
                    "Refusing to send credentials to non-HTTPS OAuth endpoint: {}",
                    self.oauth_host
                ));
            }
        }
        let url = format!("{}{}", self.oauth_host.trim_end_matches('/'), path);
        let response = self
            .client
            .post(url)
            .header("Accept", "application/json")
            .form(params)
            .send()
            .await
            .map_err(|e| format!("OAuth request failed: {e}"))?;
        let status = response.status().as_u16();
        let data = response.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, data))
    }

    fn error_detail(data: &Value) -> String {
        data.get("error_description")
            .and_then(|v| v.as_str())
            .or_else(|| data.get("message").and_then(|v| v.as_str()))
            .or_else(|| data.get("error").and_then(|v| v.as_str()))
            .unwrap_or("unknown")
            .to_string()
    }

    fn token_from_response(data: &Value) -> Result<StoredToken, String> {
        let access_token = data
            .get("access_token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or("OAuth response missing access_token")?;
        let refresh_token = data
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or("OAuth response missing refresh_token")?;
        let expires_in = data
            .get("expires_in")
            .and_then(|v| v.as_i64())
            .filter(|v| *v > 0)
            .ok_or("OAuth response missing or invalid expires_in")?;
        Ok(StoredToken {
            access_token: access_token.to_string(),
            refresh_token: refresh_token.to_string(),
            expires_at: chrono::Utc::now().timestamp() + expires_in,
            scope: data
                .get("scope")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            token_type: data
                .get("token_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Bearer")
                .to_string(),
            expires_in,
        })
    }

    fn credentials_path(&self, provider: &str) -> Option<PathBuf> {
        let dir = self.credentials_dir.as_ref()?;
        // Guard against path traversal, mirroring storage.ts `pathFor`.
        let safe: String = provider
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if safe.is_empty() {
            return None;
        }
        Some(dir.join(format!("{safe}.json")))
    }

    fn save_token(&self, provider: &str, token: &StoredToken) {
        self.inner
            .tokens
            .lock()
            .unwrap()
            .insert(provider.to_string(), token.clone());
        let Some(path) = self.credentials_path(provider) else {
            return;
        };
        let Ok(body) = serde_json::to_string_pretty(token) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension(format!("tmp.{}", fastrand::u32(..)));
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    fn load_token(&self, provider: &str) -> Option<StoredToken> {
        if let Some(token) = self.inner.tokens.lock().unwrap().get(provider) {
            return Some(token.clone());
        }
        let path = self.credentials_path(provider)?;
        let body = std::fs::read_to_string(path).ok()?;
        let token: StoredToken = serde_json::from_str(&body).ok()?;
        self.inner
            .tokens
            .lock()
            .unwrap()
            .insert(provider.to_string(), token.clone());
        Some(token)
    }

    /// Whether a cached OAuth token exists for the provider (v2
    /// `hasCachedAccessToken`): in memory or as `<credentials dir>/<provider>.json`.
    pub fn has_cached_token(&self, provider: &str) -> bool {
        self.load_token(provider).is_some()
    }

    /// The credential names the managed Kimi Code token may live under: the
    /// Web UI signs in without a provider (the server default `kimi`), while
    /// the TS CLI basenames its `oauth/kimi-code` key to `kimi-code.json`.
    pub const MANAGED_TOKEN_NAMES: [&'static str; 2] = ["kimi", "kimi-code"];

    /// Whether any managed-token alias is stored.
    pub fn has_managed_token(&self) -> bool {
        Self::MANAGED_TOKEN_NAMES
            .iter()
            .any(|name| self.has_cached_token(name))
    }

    /// A usable managed access token under any alias, refreshing when the
    /// cached one is stale (v2 `resolveOAuthToken`).
    pub async fn managed_access_token(&self) -> Result<String, String> {
        for name in Self::MANAGED_TOKEN_NAMES {
            if let Some(token) = self.load_usable_token(name) {
                return Ok(token.access_token);
            }
            if let Some(stored) = self.load_token(name)
                && let Ok(refreshed) = self.refresh_token(name, &stored).await
            {
                return Ok(refreshed.access_token);
            }
        }
        Err("no cached managed credential; sign in first".into())
    }

    /// The managed API base URL this server is configured against.
    pub fn managed_base_url(&self) -> &str {
        &self.managed_base_url
    }

    /// Start a real device-code login: request a device authorization, then
    /// poll the token endpoint in the background until the user approves,
    /// the code expires, or the flow is cancelled.
    pub async fn start_login(
        self: Arc<Self>,
        provider: &str,
        _region: Option<&str>,
    ) -> OAuthFlowSnapshot {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (status, data) = match self
            .post_form(DEVICE_AUTH_PATH, &[("client_id", KIMI_CLIENT_ID)])
            .await
        {
            Ok(result) => result,
            Err(e) => {
                let snapshot = OAuthFlowSnapshot {
                    provider: provider.to_string(),
                    status: "error".into(),
                    user_code: None,
                    verification_uri: None,
                    verification_uri_complete: None,
                    expires_in: None,
                    error_message: Some(e),
                };
                self.inner.flows.lock().unwrap().insert(
                    provider.to_string(),
                    FlowState {
                        snapshot: snapshot.clone(),
                        device_code: String::new(),
                        interval: DEFAULT_POLL_INTERVAL_SECS,
                        ttl_secs: DEFAULT_FLOW_TTL_SECS,
                        generation,
                    },
                );
                return snapshot;
            }
        };

        let field = |name: &str| {
            data.get(name)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let user_code = field("user_code");
        let device_code = field("device_code");
        let verification_uri_complete = field("verification_uri_complete");
        if user_code.is_none() || device_code.is_none() || verification_uri_complete.is_none() {
            let snapshot = OAuthFlowSnapshot {
                provider: provider.to_string(),
                status: "error".into(),
                user_code,
                verification_uri: field("verification_uri"),
                verification_uri_complete,
                expires_in: None,
                error_message: Some(format!(
                    "Device authorization failed (HTTP {status}): {}",
                    Self::error_detail(&data)
                )),
            };
            self.inner.flows.lock().unwrap().insert(
                provider.to_string(),
                FlowState {
                    snapshot: snapshot.clone(),
                    device_code: String::new(),
                    interval: DEFAULT_POLL_INTERVAL_SECS,
                    ttl_secs: DEFAULT_FLOW_TTL_SECS,
                    generation,
                },
            );
            return snapshot;
        }

        let interval = data
            .get("interval")
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_POLL_INTERVAL_SECS);
        let expires_in = data
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_FLOW_TTL_SECS);

        let snapshot = OAuthFlowSnapshot {
            provider: provider.to_string(),
            status: "pending".into(),
            verification_uri: field("verification_uri"),
            user_code,
            verification_uri_complete,
            expires_in: Some(expires_in),
            error_message: None,
        };
        self.inner.flows.lock().unwrap().insert(
            provider.to_string(),
            FlowState {
                snapshot: snapshot.clone(),
                device_code: device_code.unwrap_or_default(),
                interval,
                ttl_secs: expires_in,
                generation,
            },
        );

        // Background poller (the TS OAuthManager drives the same loop): stop
        // on success / expiry / denial / cancellation / flow replacement.
        let manager = self.clone();
        let provider_owned = provider.to_string();
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            loop {
                let interval = manager.poll_interval(&provider_owned);
                tokio::time::sleep(Duration::from_secs(interval)).await;
                let Some(state_generation) = manager.current_generation(&provider_owned) else {
                    return;
                };
                if state_generation != generation {
                    return;
                }
                if started.elapsed().as_secs() > manager.poll_ttl(&provider_owned) {
                    manager.finish_flow(&provider_owned, generation, "expired", None);
                    return;
                }
                let device_code = manager.device_code(&provider_owned);
                match manager
                    .post_form(
                        TOKEN_PATH,
                        &[
                            ("client_id", KIMI_CLIENT_ID),
                            ("device_code", device_code.as_str()),
                            (
                                "grant_type",
                                "urn:ietf:params:oauth:grant-type:device_code",
                            ),
                        ],
                    )
                    .await
                {
                    Err(_) => continue,
                    Ok((status, data)) => {
                        if status == 200 && data.get("access_token").is_some() {
                            match Self::token_from_response(&data) {
                                Ok(token) => {
                                    manager.save_token(&provider_owned, &token);
                                    manager.finish_flow(&provider_owned, generation, "success", None);
                                }
                                Err(e) => {
                                    manager.finish_flow(&provider_owned, generation, "error", Some(&e));
                                }
                            }
                            return;
                        }
                        if status >= 500 {
                            continue;
                        }
                        match data.get("error").and_then(|v| v.as_str()).unwrap_or("") {
                            "authorization_pending" | "slow_down" => continue,
                            "expired_token" => {
                                manager.finish_flow(&provider_owned, generation, "expired", None);
                                return;
                            }
                            "access_denied" => {
                                manager.finish_flow(
                                    &provider_owned,
                                    generation,
                                    "denied",
                                    Some(&Self::error_detail(&data)),
                                );
                                return;
                            }
                            other => {
                                manager.finish_flow(
                                    &provider_owned,
                                    generation,
                                    "error",
                                    Some(&format!(
                                        "Device token polling failed (HTTP {status}): {other}"
                                    )),
                                );
                                return;
                            }
                        }
                    }
                }
            }
        });

        snapshot
    }

    fn poll_interval(&self, provider: &str) -> u64 {
        self.inner
            .flows
            .lock()
            .unwrap()
            .get(provider)
            .map(|s| s.interval)
            .unwrap_or(DEFAULT_POLL_INTERVAL_SECS)
    }

    fn poll_ttl(&self, provider: &str) -> u64 {
        self.inner
            .flows
            .lock()
            .unwrap()
            .get(provider)
            .map(|s| s.ttl_secs)
            .unwrap_or(DEFAULT_FLOW_TTL_SECS)
    }

    fn device_code(&self, provider: &str) -> String {
        self.inner
            .flows
            .lock()
            .unwrap()
            .get(provider)
            .map(|s| s.device_code.clone())
            .unwrap_or_default()
    }

    fn current_generation(&self, provider: &str) -> Option<u64> {
        self.inner
            .flows
            .lock()
            .unwrap()
            .get(provider)
            .map(|s| s.generation)
    }

    fn finish_flow(&self, provider: &str, generation: u64, status: &str, error_message: Option<&str>) {
        let mut flows = self.inner.flows.lock().unwrap();
        let Some(state) = flows.get_mut(provider) else {
            return;
        };
        if state.generation != generation {
            return;
        }
        state.snapshot.status = status.to_string();
        state.snapshot.error_message = error_message.map(str::to_string);
    }

    /// Get current login flow snapshot for polling.
    pub fn get_flow(&self, provider: &str) -> Option<OAuthFlowSnapshot> {
        self.inner
            .flows
            .lock()
            .unwrap()
            .get(provider)
            .map(|s| s.snapshot.clone())
    }

    /// Cancel current login flow.
    pub fn cancel_login(&self, provider: &str) -> bool {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut flows = self.inner.flows.lock().unwrap();
        let Some(state) = flows.get_mut(provider) else {
            return false;
        };
        state.generation = generation;
        state.snapshot.status = "cancelled".into();
        true
    }

    /// Log out the specified provider: drop the flow, the in-memory token,
    /// and the persisted credentials file.
    pub fn logout(&self, provider: &str) -> bool {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        let had_flow = self.inner.flows.lock().unwrap().remove(provider).is_some();
        let had_token = self.inner.tokens.lock().unwrap().remove(provider).is_some();
        if let Some(path) = self.credentials_path(provider) {
            let _ = std::fs::remove_file(path);
        }
        had_flow || had_token
    }

    /// Refresh the stored token via the refresh grant, mirroring TS
    /// `refreshAccessToken` (oauth.ts:246-306): unauthorized/invalid_grant
    /// drops the token, retryable statuses back off and retry.
    async fn refresh_token(
        &self,
        provider: &str,
        token: &StoredToken,
    ) -> Result<StoredToken, String> {
        let mut last_error = String::from("Token refresh failed.");
        for attempt in 0..REFRESH_MAX_ATTEMPTS {
            let (status, data) = self
                .post_form(
                    TOKEN_PATH,
                    &[
                        ("client_id", KIMI_CLIENT_ID),
                        ("grant_type", "refresh_token"),
                        ("refresh_token", token.refresh_token.as_str()),
                    ],
                )
                .await?;
            if status == 200 && data.get("access_token").is_some() {
                let refreshed = Self::token_from_response(&data)?;
                self.save_token(provider, &refreshed);
                return Ok(refreshed);
            }
            let error_code = data.get("error").and_then(|v| v.as_str()).unwrap_or("");
            if status == 401 || status == 403 || error_code == "invalid_grant" {
                self.inner.tokens.lock().unwrap().remove(provider);
                if let Some(path) = self.credentials_path(provider) {
                    let _ = std::fs::remove_file(path);
                }
                return Err("Token refresh unauthorized.".into());
            }
            last_error = format!(
                "Token refresh failed (HTTP {status}): {}",
                Self::error_detail(&data)
            );
            if REFRESH_RETRYABLE_STATUSES.contains(&status) && attempt < REFRESH_MAX_ATTEMPTS - 1 {
                tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                continue;
            }
            if !REFRESH_RETRYABLE_STATUSES.contains(&status) {
                break;
            }
        }
        Err(last_error)
    }

    fn load_usable_token(&self, provider: &str) -> Option<StoredToken> {
        let token = self.load_token(provider)?;
        // Proactively treat near-expiry tokens as stale; the caller refreshes
        // via the refresh grant (mirrors TS expires_at bookkeeping).
        if token.expires_at - 60 < chrono::Utc::now().timestamp() && !token.refresh_token.is_empty()
        {
            return None;
        }
        Some(token)
    }

    async fn managed_get(&self, provider: &str, path: &str) -> Value {
        let Some(token) = self.load_usable_token(provider) else {
            // No usable token: try a refresh path only if credentials exist.
            if let Some(stored) = self.load_token(provider) {
                if let Ok(refreshed) = self.refresh_token(provider, &stored).await {
                    return self.managed_get_with(provider, path, &refreshed).await;
                }
            }
            return json!({ "authenticated": false, "provider": provider });
        };
        self.managed_get_with(provider, path, &token).await
    }

    async fn managed_get_with(&self, provider: &str, path: &str, token: &StoredToken) -> Value {
        let url = format!("{}/{}", self.managed_base_url.trim_end_matches('/'), path);
        let mut response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token.access_token))
            .header("Accept", "application/json")
            .send()
            .await;
        // 401 → the cached token went stale; refresh once and retry.
        if let Ok(res) = &response
            && res.status().as_u16() == 401
        {
            match self.refresh_token(provider, token).await {
                Ok(refreshed) => {
                    response = self
                        .client
                        .get(&url)
                        .header("Authorization", format!("Bearer {}", refreshed.access_token))
                        .header("Accept", "application/json")
                        .send()
                        .await;
                }
                Err(e) => {
                    return json!({ "authenticated": false, "provider": provider, "error": e })
                }
            }
        }
        match response {
            Ok(res) if res.status().is_success() => res.json::<Value>().await.unwrap_or(json!({
                "authenticated": true,
                "provider": provider,
                "error": "Malformed managed API response.",
            })),
            Ok(res) => json!({
                "authenticated": true,
                "provider": provider,
                "error": format!("Managed API request failed (HTTP {})", res.status().as_u16()),
            }),
            Err(e) => json!({ "authenticated": true, "provider": provider, "error": e.to_string() }),
        }
    }

    /// Get managed usage stats from the real `/usages` endpoint.
    pub async fn get_usage(&self, provider: &str) -> Value {
        self.managed_get(provider, "usages").await
    }

    /// Get user info from the real `/me` endpoint.
    pub async fn get_user_info(&self, provider: &str) -> Value {
        self.managed_get(provider, "me").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One mock authorization server answering the three endpoints in
    /// sequence: device_authorization → pending ×2 → token success, plus
    /// /me and /usages reads. A sequential accept loop suffices — the flow
    /// issues its requests one at a time.
    async fn spawn_mock_oauth_server(deny: bool) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut token_polls = 0u32;
            async fn respond(status: &str, reason: &str, body: String) -> String {
                format!(
                    "HTTP/1.1 {status} {reason}
content-type: application/json
connection: close
content-length: {}

{body}",
                    body.len()
                )
            }
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 8192];
                let Ok(n) = sock.read(&mut buf).await else {
                    break;
                };
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let response = if request.starts_with("POST /api/oauth/device_authorization") {
                    respond(
                        "200",
                        "OK",
                        json!({
                            "user_code": "WDJB-MJHT",
                            "device_code": "dev-123",
                            "verification_uri": "https://example.test/device",
                            "verification_uri_complete": "https://example.test/device?code=WDJB-MJHT",
                            "expires_in": 900,
                            "interval": 1
                        })
                        .to_string(),
                    )
                    .await
                } else if request.starts_with("POST /api/oauth/token") {
                    token_polls += 1;
                    if deny {
                        respond(
                            "400",
                            "Bad Request",
                            json!({"error": "access_denied", "error_description": "The user denied the request"})
                                .to_string(),
                        )
                        .await
                    } else if token_polls < 3 {
                        respond(
                            "400",
                            "Bad Request",
                            json!({"error": "authorization_pending"}).to_string(),
                        )
                        .await
                    } else {
                        respond(
                            "200",
                            "OK",
                            json!({
                                "access_token": "at-real-1",
                                "refresh_token": "rt-real-1",
                                "expires_in": 3600,
                                "token_type": "Bearer",
                                "scope": "read write"
                            })
                            .to_string(),
                        )
                        .await
                    }
                } else if request.starts_with("GET /me") {
                    if request.contains("Bearer at-real-1") {
                        respond(
                            "200",
                            "OK",
                            json!({"user_id": "user-1", "name": "Mock User", "authenticated": true})
                                .to_string(),
                        )
                        .await
                    } else {
                        respond("401", "Unauthorized", String::from("{}")).await
                    }
                } else if request.starts_with("GET /usages") {
                    respond(
                        "200",
                        "OK",
                        json!({"quota_status": "ok", "usage": {"total_tokens": 42}}).to_string(),
                    )
                    .await
                } else {
                    respond("404", "Not Found", String::from("{}")).await
                };
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        addr
    }

    fn temp_credentials_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kimi-oauth-test-{tag}-{}", fastrand::u32(..)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn wait_for_terminal_status(manager: &Arc<OAuthManager>, provider: &str) -> String {
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if let Some(flow) = manager.get_flow(provider)
                && flow.status != "pending"
            {
                return flow.status;
            }
        }
        "pending".into()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn device_flow_completes_with_real_exchange_and_persists_token() {
        let addr = spawn_mock_oauth_server(false).await;
        let dir = temp_credentials_dir("success");
        let manager = Arc::new(OAuthManager::with_hosts(
            format!("http://{addr}"),
            format!("http://{addr}"),
            Some(dir.clone()),
        ));

        let snapshot = manager.clone().start_login("kimi", None).await;
        assert_eq!(snapshot.status, "pending");
        assert_eq!(snapshot.user_code.as_deref(), Some("WDJB-MJHT"));
        assert_eq!(
            snapshot.verification_uri_complete.as_deref(),
            Some("https://example.test/device?code=WDJB-MJHT")
        );

        // The poller runs at interval=1s: authorization_pending twice, then
        // the token lands on the third poll.
        let status = wait_for_terminal_status(&manager, "kimi").await;
        assert_eq!(status, "success", "flow must reach success via real exchange");

        // Token persisted to the credentials file in storage.ts wire format.
        let body = std::fs::read_to_string(dir.join("kimi.json")).expect("credentials file");
        let wire: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(wire["access_token"], "at-real-1");
        assert_eq!(wire["refresh_token"], "rt-real-1");
        assert!(wire["expires_at"].is_number());

        // Managed /me and /usages reads with the real bearer token.
        let user = manager.get_user_info("kimi").await;
        assert_eq!(user["user_id"], "user-1");
        assert_eq!(user["name"], "Mock User");
        let usage = manager.get_usage("kimi").await;
        assert_eq!(usage["usage"]["total_tokens"], 42);

        // Logout drops flow, token, and the file.
        assert!(manager.logout("kimi"));
        assert!(manager.get_flow("kimi").is_none());
        assert!(!dir.join("kimi.json").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn denied_flow_reports_denied_and_stores_nothing() {
        let addr = spawn_mock_oauth_server(true).await;
        let dir = temp_credentials_dir("denied");
        let manager = Arc::new(OAuthManager::with_hosts(
            format!("http://{addr}"),
            format!("http://{addr}"),
            Some(dir.clone()),
        ));

        manager.clone().start_login("kimi", None).await;
        let status = wait_for_terminal_status(&manager, "kimi").await;
        assert_eq!(status, "denied");
        assert!(!dir.join("kimi.json").exists(), "no token may be stored on denial");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_https_non_loopback_host_is_refused() {
        let dir = temp_credentials_dir("refused");
        let manager = Arc::new(OAuthManager::with_hosts(
            "http://auth.example.test".into(),
            "https://api.example.test".into(),
            Some(dir),
        ));
        let snapshot = manager.clone().start_login("kimi", None).await;
        assert_eq!(snapshot.status, "error");
        assert!(
            snapshot
                .error_message
                .as_deref()
                .unwrap_or_default()
                .contains("non-HTTPS"),
            "credentials must be refused on non-HTTPS remote hosts"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_stops_poller_and_marks_cancelled() {
        let addr = spawn_mock_oauth_server(false).await;
        let dir = temp_credentials_dir("cancel");
        let manager = Arc::new(OAuthManager::with_hosts(
            format!("http://{addr}"),
            format!("http://{addr}"),
            Some(dir),
        ));
        manager.clone().start_login("kimi", None).await;
        assert!(manager.cancel_login("kimi"));
        tokio::time::sleep(Duration::from_millis(1800)).await;
        let flow = manager.get_flow("kimi").unwrap();
        assert_eq!(
            flow.status, "cancelled",
            "poller must not resurrect a cancelled flow"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unauthenticated_reads_are_honest() {
        let dir = temp_credentials_dir("anon");
        let manager = OAuthManager::with_hosts(
            "https://auth.example.test".into(),
            "https://api.example.test".into(),
            Some(dir),
        );
        // No token stored → the managed reads must say so instead of
        // returning canned success payloads like the old mock did.
        let user = manager.get_user_info("kimi").await;
        assert_eq!(user["authenticated"], false);
        let usage = manager.get_usage("kimi").await;
        assert_eq!(usage["authenticated"], false);
    }
}
