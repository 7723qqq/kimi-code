//! MCP OAuth token access with single-flight refresh.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::store::McpOAuthFileStore;

/// Refresh this long before the recorded expiry so a token cannot lapse
/// mid-request.
const REFRESH_SKEW_MS: i64 = 60_000;

/// One server's OAuth credentials (v2 keeps the SDK `OAuthTokens` plus the
/// provider it came from in the same document).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpOAuthTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    /// Token endpoint used to refresh; recorded when the login flow completes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// When this grant was obtained, stamped on write. Two consumers: the
    /// concurrent-grant window ([`is_concurrent_grant`]) and the
    /// compare-and-clear in [`McpOAuthService::clear_tokens_if_current`]
    /// (v2 `StoredMcpOAuthTokens.obtained_at`, oauth/service.ts:680-688).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtained_at_ms: Option<i64>,
}

impl McpOAuthTokens {
    fn is_expired(&self, now_ms: i64) -> bool {
        match self.expires_at_ms {
            Some(expiry) => now_ms + REFRESH_SKEW_MS >= expiry,
            None => false,
        }
    }

    /// Whether two records describe the same grant. `obtained_at_ms` is
    /// deliberately excluded: it records when the record was written, not
    /// which credential it holds, so a re-stamp must not defeat the
    /// compare-and-clear below.
    fn same_grant(&self, other: &Self) -> bool {
        self.access_token == other.access_token
            && self.refresh_token == other.refresh_token
            && self.expires_at_ms == other.expires_at_ms
    }
}

/// How recently a grant must have been obtained to count as a login landing
/// concurrently with the connection that reports a 401 (v2
/// `CONCURRENT_GRANT_GRACE_MS`, oauth/service.ts:681).
const CONCURRENT_GRANT_GRACE_MS: i64 = 10_000;

/// A grant obtained within the grace window — and at or after the connection
/// that is now reporting a 401 — is another login landing concurrently, not
/// the credential this call was rejected with, so it must not be flipped to
/// `needs-auth` or invalidated (v2 `isConcurrentGrant`, oauth/service.ts:683-688).
/// A future timestamp (negative age) fails the window: the clock moved, and
/// trusting it would protect a credential that never worked.
fn is_concurrent_grant(tokens: &McpOAuthTokens, now: i64, connected_at_ms: Option<i64>) -> bool {
    let Some(obtained_at) = tokens.obtained_at_ms else {
        return false;
    };
    let age = now - obtained_at;
    if !(0..CONCURRENT_GRANT_GRACE_MS).contains(&age) {
        return false;
    }
    match connected_at_ms {
        Some(connected_at) => obtained_at >= connected_at,
        None => true,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Reads credentials from the encrypted store and refreshes them on demand.
///
/// Concurrent callers for the same key share one refresh: the first takes the
/// per-key lock and refreshes, the rest wait and then re-read the store
/// (v2 `IMcpOAuthService`'s single-flight refresh).
pub struct McpOAuthService {
    store: Arc<McpOAuthFileStore>,
    client: reqwest::Client,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl McpOAuthService {
    pub fn new(store: Arc<McpOAuthFileStore>) -> Self {
        Self {
            store,
            client: reqwest::Client::new(),
            locks: Mutex::new(HashMap::new()),
        }
    }

    /// Whether the store holds credentials for this key.
    pub fn has_tokens(&self, key: &str) -> bool {
        self.store.read::<McpOAuthTokens>(key).is_some()
    }

    /// Every credential key the store holds (the `auth-statuses` surface).
    pub fn list_keys(&self) -> Vec<String> {
        self.store.list(None)
    }

    /// Persist freshly obtained credentials (login completion). The grant is
    /// stamped with its obtain time unless the caller already recorded one.
    pub fn store_tokens(&self, key: &str, tokens: &McpOAuthTokens) -> Result<(), String> {
        let mut stamped = tokens.clone();
        if stamped.obtained_at_ms.is_none() {
            stamped.obtained_at_ms = Some(now_ms());
        }
        self.store.write(key, &stamped)
    }

    /// The clock the concurrent-grant window compares against (v2 `now()`,
    /// oauth/service.ts:520-522).
    pub fn now(&self) -> i64 {
        now_ms()
    }

    /// The stored grant for this key, plus whether it looks like a login that
    /// landed concurrently with the connection reporting a 401 (v2
    /// `peekRejectedGrant`, oauth/service.ts:511-523).
    pub fn peek_rejected_grant(
        &self,
        key: &str,
        connected_at_ms: Option<i64>,
    ) -> Option<(McpOAuthTokens, bool)> {
        let tokens = self.store.read::<McpOAuthTokens>(key)?;
        let concurrent = is_concurrent_grant(&tokens, now_ms(), connected_at_ms);
        Some((tokens, concurrent))
    }

    /// Drop the stored grant only while it is still the rejected one, so a
    /// login that landed after the 401 survives (v2 `clearTokensIfCurrent`,
    /// oauth/provider.ts:264-269). Missing credentials, or a grant that has
    /// since changed, report `false` without touching the store.
    pub fn clear_tokens_if_current(
        &self,
        key: &str,
        expected: &McpOAuthTokens,
    ) -> Result<bool, String> {
        let Some(stored) = self.store.read::<McpOAuthTokens>(key) else {
            return Ok(false);
        };
        if !stored.same_grant(expected) {
            return Ok(false);
        }
        self.store.remove(key)
    }

    /// Drop one server's credentials (`auth:cancel` / `auth:reset`).
    pub fn remove(&self, key: &str) -> Result<bool, String> {
        self.store.remove(key)
    }

    /// The access token for this key, refreshing it when expired. `None` means
    /// the server must be treated as needing authentication.
    pub async fn access_token(&self, key: &str) -> Option<String> {
        let tokens = self.store.read::<McpOAuthTokens>(key)?;
        if !tokens.is_expired(now_ms()) {
            return Some(tokens.access_token);
        }

        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        // Another caller may have refreshed while we waited for the lock.
        let tokens = self.store.read::<McpOAuthTokens>(key)?;
        if !tokens.is_expired(now_ms()) {
            return Some(tokens.access_token);
        }

        let refreshed = self.refresh(&tokens).await?;
        let _ = self.store.write(key, &refreshed);
        Some(refreshed.access_token)
    }

    async fn refresh(&self, tokens: &McpOAuthTokens) -> Option<McpOAuthTokens> {
        let endpoint = tokens.token_endpoint.as_deref()?;
        let refresh_token = tokens.refresh_token.as_deref()?;
        let client_id = tokens.client_id.clone().unwrap_or_default();
        let mut form: Vec<(&str, &str)> = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ];
        if !client_id.is_empty() {
            form.push(("client_id", &client_id));
        }

        let response = self.client.post(endpoint).form(&form).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: serde_json::Value = response.json().await.ok()?;
        let access_token = body.get("access_token")?.as_str()?.to_string();
        let expires_in = body.get("expires_in").and_then(|value| value.as_i64());
        Some(McpOAuthTokens {
            access_token,
            refresh_token: body
                .get("refresh_token")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .or_else(|| tokens.refresh_token.clone()),
            expires_at_ms: expires_in.map(|secs| now_ms() + secs * 1000),
            token_endpoint: tokens.token_endpoint.clone(),
            client_id: tokens.client_id.clone(),
            obtained_at_ms: Some(now_ms()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Minimal token endpoint: counts requests and answers with `body`.
    async fn spawn_token_endpoint(
        body: &'static str,
    ) -> (String, Arc<AtomicUsize>, tokio::sync::oneshot::Sender<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/token");
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
                        tokio::spawn(async move {
                            let mut buffer = vec![0u8; 4096];
                            let _ = socket.read(&mut buffer).await;
                            hits.fetch_add(1, Ordering::SeqCst);
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
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

    fn expired_tokens(endpoint: &str) -> McpOAuthTokens {
        McpOAuthTokens {
            access_token: "stale".into(),
            refresh_token: Some("refresh-1".into()),
            expires_at_ms: Some(now_ms() - 1_000),
            token_endpoint: Some(endpoint.into()),
            client_id: Some("client-1".into()),
            obtained_at_ms: None,
        }
    }

    #[tokio::test]
    async fn test_valid_token_is_returned_without_refreshing() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(McpOAuthFileStore::new(dir.path()));
        let service = McpOAuthService::new(store.clone());
        store
            .write(
                "srv",
                &McpOAuthTokens {
                    access_token: "fresh".into(),
                    refresh_token: Some("r".into()),
                    expires_at_ms: Some(now_ms() + 3_600_000),
                    token_endpoint: None,
                    client_id: None,
                    obtained_at_ms: None,
                },
            )
            .unwrap();

        assert!(service.has_tokens("srv"));
        assert_eq!(service.access_token("srv").await.as_deref(), Some("fresh"));
        assert!(!service.has_tokens("missing"));
        assert_eq!(service.access_token("missing").await, None);
    }

    #[tokio::test]
    async fn test_expired_token_refreshes_and_persists() {
        let (url, hits, _shutdown) =
            spawn_token_endpoint(r#"{"access_token":"new-token","expires_in":3600}"#).await;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(McpOAuthFileStore::new(dir.path()));
        store.write("srv", &expired_tokens(&url)).unwrap();
        let service = McpOAuthService::new(store.clone());

        assert_eq!(
            service.access_token("srv").await.as_deref(),
            Some("new-token")
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // The refreshed credentials were persisted, so the next call is served
        // from the store without another round trip.
        assert_eq!(
            service.access_token("srv").await.as_deref(),
            Some("new-token")
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let stored = store.read::<McpOAuthTokens>("srv").unwrap();
        assert_eq!(stored.access_token, "new-token");
        assert_eq!(stored.refresh_token.as_deref(), Some("refresh-1"));
    }

    /// Two callers that race on an expired token share one refresh
    /// (v2's single-flight refresh).
    #[tokio::test]
    async fn test_concurrent_callers_share_one_refresh() {
        let (url, hits, _shutdown) =
            spawn_token_endpoint(r#"{"access_token":"shared","expires_in":3600}"#).await;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(McpOAuthFileStore::new(dir.path()));
        store.write("srv", &expired_tokens(&url)).unwrap();
        let service = Arc::new(McpOAuthService::new(store));

        let first = {
            let service = service.clone();
            tokio::spawn(async move { service.access_token("srv").await })
        };
        let second = {
            let service = service.clone();
            tokio::spawn(async move { service.access_token("srv").await })
        };

        assert_eq!(first.await.unwrap().as_deref(), Some("shared"));
        assert_eq!(second.await.unwrap().as_deref(), Some("shared"));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "refresh must be single-flight"
        );
    }

    /// A refresh without a refresh token or endpoint fails closed.
    #[tokio::test]
    async fn test_refresh_without_material_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(McpOAuthFileStore::new(dir.path()));
        store
            .write(
                "srv",
                &McpOAuthTokens {
                    access_token: "stale".into(),
                    refresh_token: None,
                    expires_at_ms: Some(now_ms() - 1_000),
                    token_endpoint: None,
                    client_id: None,
                    obtained_at_ms: None,
                },
            )
            .unwrap();
        let service = McpOAuthService::new(store);
        assert_eq!(service.access_token("srv").await, None);
    }

    fn grant(access_token: &str, obtained_at_ms: Option<i64>) -> McpOAuthTokens {
        McpOAuthTokens {
            access_token: access_token.into(),
            refresh_token: None,
            expires_at_ms: None,
            token_endpoint: None,
            client_id: None,
            obtained_at_ms,
        }
    }

    /// The store stamps the obtain time on write, so the concurrency window
    /// has something to compare (v2 `StoredMcpOAuthTokens.obtained_at`).
    #[test]
    fn test_store_tokens_stamps_obtained_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(McpOAuthFileStore::new(dir.path()));
        let service = McpOAuthService::new(store.clone());

        service.store_tokens("srv", &grant("a", None)).unwrap();
        let stamped = store.read::<McpOAuthTokens>("srv").unwrap();
        let obtained = stamped.obtained_at_ms.expect("write must stamp a grant");
        assert!((now_ms() - obtained).abs() < 5_000);

        // An explicit stamp is preserved: the login flow records the moment
        // the provider issued the grant, not the moment it was persisted.
        let earlier = now_ms() - 30_000;
        service
            .store_tokens("srv", &grant("b", Some(earlier)))
            .unwrap();
        assert_eq!(
            store.read::<McpOAuthTokens>("srv").unwrap().obtained_at_ms,
            Some(earlier)
        );
    }

    /// v2 `isConcurrentGrant` (oauth/service.ts:683-688): a grant is
    /// concurrent only inside the grace window, never in the future, and never
    /// when it predates the connection that is reporting the 401.
    #[test]
    fn test_concurrent_grant_window() {
        let now = now_ms();
        // Inside the window and after the connection → concurrent.
        assert!(is_concurrent_grant(
            &grant("a", Some(now - 5_000)),
            now,
            Some(now - 20_000)
        ));
        // Inside the window with no recorded connection time → concurrent.
        assert!(is_concurrent_grant(
            &grant("a", Some(now - 5_000)),
            now,
            None
        ));
        // Outside the window → the credential the call was rejected with.
        assert!(!is_concurrent_grant(
            &grant("a", Some(now - 60_000)),
            now,
            Some(now - 120_000)
        ));
        // Obtained before the connection it would protect → not concurrent.
        assert!(!is_concurrent_grant(
            &grant("a", Some(now - 5_000)),
            now,
            Some(now - 1_000)
        ));
        // A future stamp fails the window: the clock moved.
        assert!(!is_concurrent_grant(
            &grant("a", Some(now + 5_000)),
            now,
            Some(now - 1_000)
        ));
        // No stamp at all → nothing to protect.
        assert!(!is_concurrent_grant(&grant("a", None), now, None));
    }

    /// v2 `clearTokensIfCurrent` (oauth/provider.ts:264-269): only the grant
    /// that was rejected is dropped, so a login landing after the 401 owns the
    /// store and survives.
    #[test]
    fn test_clear_tokens_if_current() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(McpOAuthFileStore::new(dir.path()));
        let service = McpOAuthService::new(store.clone());
        service
            .store_tokens("srv", &grant("rejected", Some(now_ms() - 60_000)))
            .unwrap();
        let rejected = store.read::<McpOAuthTokens>("srv").unwrap();

        // A newer login replaced the record between the 401 and the cleanup.
        service
            .store_tokens("srv", &grant("renewed", None))
            .unwrap();
        assert!(!service.clear_tokens_if_current("srv", &rejected).unwrap());
        assert_eq!(
            store.read::<McpOAuthTokens>("srv").unwrap().access_token,
            "renewed"
        );

        // Matching the stored record drops it, and a second attempt is a no-op
        // rather than an error.
        let stored = store.read::<McpOAuthTokens>("srv").unwrap();
        assert!(service.clear_tokens_if_current("srv", &stored).unwrap());
        assert!(!service.has_tokens("srv"));
        assert!(!service.clear_tokens_if_current("srv", &stored).unwrap());
    }

    /// The rejected-grant peek reports the stored record together with its
    /// concurrency verdict (v2 `peekRejectedGrant`).
    #[test]
    fn test_peek_rejected_grant() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(McpOAuthFileStore::new(dir.path()));
        let service = McpOAuthService::new(store.clone());
        assert!(service.peek_rejected_grant("srv", None).is_none());

        service.store_tokens("srv", &grant("fresh", None)).unwrap();
        let now = now_ms();
        // Obtained after the connection → a login landing concurrently with it.
        let (tokens, concurrent) = service
            .peek_rejected_grant("srv", Some(now - 1_000))
            .unwrap();
        assert_eq!(tokens.access_token, "fresh");
        assert!(concurrent);

        // Inside the window but older than the connection → the credential
        // that connection was built with, not a concurrent login.
        service
            .store_tokens("srv", &grant("old", Some(now - 5_000)))
            .unwrap();
        let (_, concurrent) = service
            .peek_rejected_grant("srv", Some(now - 1_000))
            .unwrap();
        assert!(!concurrent);
    }
}
