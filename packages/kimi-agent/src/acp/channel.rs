//! Outbound ACP messages and the server→client request back-channel.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{Mutex, oneshot};

use crate::acp::types::{JsonRpcRequest, JsonRpcResponse};

/// One outbound JSON-RPC message.
#[derive(Debug, Clone)]
pub enum AcpOutbound {
    /// Answer to a client request.
    Response(JsonRpcResponse),
    /// Server-initiated notification (`session/update`).
    Notification(JsonRpcRequest),
    /// Server-initiated request (`session/request_permission`); the client's
    /// answer returns through [`AcpChannel::resolve`].
    Request(JsonRpcRequest),
}

type Sink = Arc<std::sync::RwLock<Option<tokio::sync::mpsc::UnboundedSender<AcpOutbound>>>>;

/// Outbound channel shared by the dispatcher, the stdio writer loop and the
/// permission bridge.
#[derive(Clone, Default)]
pub struct AcpChannel {
    sink: Sink,
    next_id: Arc<AtomicU64>,
    waiters: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
}

impl AcpChannel {
    pub fn new() -> Self {
        Self {
            sink: Arc::new(std::sync::RwLock::new(None)),
            next_id: Arc::new(AtomicU64::new(1)),
            waiters: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Install the writer sink.
    pub fn set_sink(&self, sender: tokio::sync::mpsc::UnboundedSender<AcpOutbound>) {
        *self.sink.write().unwrap_or_else(|e| e.into_inner()) = Some(sender);
    }

    /// Drop the writer sink so the writer loop can end.
    pub fn clear_sink(&self) {
        *self.sink.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn send(&self, message: AcpOutbound) -> bool {
        let guard = self.sink.read().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(sender) => sender.send(message).is_ok(),
            None => false,
        }
    }

    /// Fire-and-forget notification.
    pub fn notify(&self, method: &str, params: serde_json::Value) {
        self.send(AcpOutbound::Notification(JsonRpcResponse::notification(
            method, params,
        )));
    }

    /// Send a request and wait for the client's response. Never times out —
    /// like a permission check it waits on a human — but resolves with an
    /// error when the client is gone.
    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().await.insert(id, tx);
        let sent = self.send(AcpOutbound::Request(JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(id)),
            method: method.to_string(),
            params: Some(params),
        }));
        if !sent {
            self.waiters.lock().await.remove(&id);
            return Err("ACP client is not connected".into());
        }
        match rx.await {
            Ok(value) => Ok(value),
            Err(_) => Err("ACP client disconnected before answering".into()),
        }
    }

    /// Resolve a pending server→client request; returns false for an unknown
    /// or already-resolved id.
    pub async fn resolve(&self, id: u64, value: serde_json::Value) -> bool {
        let waiter = { self.waiters.lock().await.remove(&id) };
        match waiter {
            Some(tx) => tx.send(value).is_ok(),
            None => false,
        }
    }

    /// Extract the id of a client response line (`{"id":N,"result"|"error":…}`).
    pub fn response_id(value: &serde_json::Value) -> Option<u64> {
        if value.get("method").is_some() {
            return None;
        }
        value.get("id").and_then(|id| id.as_u64())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_request_resolves_with_client_answer() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);

        let pending = {
            let channel = channel.clone();
            tokio::spawn(async move {
                channel
                    .request(
                        "session/request_permission",
                        serde_json::json!({ "sessionId": "s1" }),
                    )
                    .await
            })
        };

        let outbound = rx.recv().await.expect("one outbound message");
        let id = match outbound {
            AcpOutbound::Request(request) => request.id.unwrap().as_u64().unwrap(),
            other => panic!("unexpected message: {other:?}"),
        };
        assert!(channel
            .resolve(id, serde_json::json!({ "outcome": { "outcome": "cancelled" } }))
            .await);

        let answer = pending.await.unwrap().expect("request resolves");
        assert_eq!(answer["outcome"]["outcome"], "cancelled");
        assert!(!channel.resolve(id, serde_json::json!({})).await);
    }

    #[tokio::test]
    async fn test_request_without_client_errors() {
        let channel = AcpChannel::new();
        let err = channel
            .request("session/request_permission", serde_json::json!({}))
            .await
            .expect_err("no sink means no client");
        assert_eq!(err, "ACP client is not connected");
    }

    #[test]
    fn test_response_id_ignores_requests_and_notifications() {
        assert_eq!(
            AcpChannel::response_id(&serde_json::json!({ "id": 4, "result": {} })),
            Some(4)
        );
        assert_eq!(
            AcpChannel::response_id(&serde_json::json!({ "id": 4, "method": "ping" })),
            None
        );
        assert_eq!(
            AcpChannel::response_id(&serde_json::json!({ "method": "session/cancel" })),
            None
        );
    }
}
