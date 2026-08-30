//! MCP HTTP/SSE transport implementation.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::{Mutex, RwLock, oneshot};

pub struct McpSseTransport {
    post_url: Arc<RwLock<Option<String>>>,
    http_client: reqwest::Client,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
}

impl McpSseTransport {
    /// Connect to an MCP server via SSE and spawn the background event listener loop.
    pub async fn connect(sse_url: &str, headers: HashMap<String, String>) -> Result<Self, String> {
        let mut req_builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?
            .get(sse_url)
            .header("Accept", "text/event-stream");

        for (k, v) in &headers {
            req_builder = req_builder.header(k, v);
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| format!("Failed to connect to MCP SSE endpoint '{sse_url}': {e}"))?;

        if !resp.status().is_success() {
            return Err(format!(
                "MCP SSE connection failed with status HTTP {}",
                resp.status()
            ));
        }

        let post_url = Arc::new(RwLock::new(None));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let stream_post_url = post_url.clone();
        let stream_pending = pending.clone();
        let base_url = sse_url.to_string();

        // Spawn background SSE stream reader
        tokio::spawn(async move {
            let mut event_stream = resp.bytes_stream().eventsource();

            while let Some(item) = event_stream.next().await {
                match item {
                    Ok(event) => {
                        if event.event == "endpoint" {
                            // Server tells client where to POST messages
                            let endpoint_str = event.data.trim();
                            let resolved = if endpoint_str.starts_with("http://")
                                || endpoint_str.starts_with("https://")
                            {
                                endpoint_str.to_string()
                            } else if let Ok(base) = url::Url::parse(&base_url) {
                                base.join(endpoint_str)
                                    .map(|u| u.to_string())
                                    .unwrap_or_else(|_| endpoint_str.to_string())
                            } else {
                                endpoint_str.to_string()
                            };
                            let mut lock = stream_post_url.write().await;
                            *lock = Some(resolved);
                        } else if (event.event == "message" || event.event.is_empty())
                            && let Ok(parsed) = serde_json::from_str::<Value>(&event.data)
                            && let Some(id) = parsed.get("id").and_then(|v| v.as_u64())
                        {
                            let mut pend_lock = stream_pending.lock().await;
                            if let Some(sender) = pend_lock.remove(&id) {
                                let _ = sender.send(parsed);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Wait up to 5 seconds for initial 'endpoint' event or fallback to base URL
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let lock = post_url.read().await;
            if lock.is_some() {
                break;
            }
        }

        // If no explicit endpoint was received, default to sse_url
        {
            let mut lock = post_url.write().await;
            if lock.is_none() {
                *lock = Some(sse_url.to_string());
            }
        }

        Ok(Self {
            post_url,
            http_client: reqwest::Client::new(),
            pending,
            next_id: AtomicU64::new(1),
        })
    }

    /// Send a JSON-RPC request over HTTP POST and await the matching response from SSE.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let target_url = {
            let lock = self.post_url.read().await;
            lock.clone()
                .ok_or_else(|| "No target post URL configured for MCP SSE".to_string())?
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut pend = self.pending.lock().await;
            pend.insert(id, tx);
        }

        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let resp = self
            .http_client
            .post(&target_url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Failed to post to MCP message endpoint '{target_url}': {e}"))?;

        if !resp.status().is_success() {
            let mut pend = self.pending.lock().await;
            pend.remove(&id);
            return Err(format!(
                "MCP POST failed with status HTTP {}",
                resp.status()
            ));
        }

        // Await matching response from SSE event stream with 30s timeout
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(val)) => {
                if let Some(err) = val.get("error") {
                    return Err(format!("MCP Server Error: {err}"));
                }
                Ok(val.get("result").cloned().unwrap_or(Value::Null))
            }
            Ok(Err(_)) => Err("MCP response channel closed prematurely".into()),
            Err(_) => {
                let mut pend = self.pending.lock().await;
                pend.remove(&id);
                Err("MCP request timed out waiting for SSE response (30s)".into())
            }
        }
    }
}
