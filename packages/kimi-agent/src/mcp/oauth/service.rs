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
}

impl McpOAuthTokens {
    fn is_expired(&self, now_ms: i64) -> bool {
        match self.expires_at_ms {
            Some(expiry) => now_ms + REFRESH_SKEW_MS >= expiry,
            None => false,
        }
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
        assert_eq!(hits.load(Ordering::SeqCst), 1, "refresh must be single-flight");
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
                },
            )
            .unwrap();
        let service = McpOAuthService::new(store);
        assert_eq!(service.access_token("srv").await, None);
    }
}
