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

    // ── Reverse RPC: agent → client (fs / terminal) ─────────────────────
    //
    // These mirror the ACP spec's client-side methods. They are thin wrappers
    // over [`Self::request`]; the caller decides whether the client advertised
    // the matching capability (see `AcpClientCapabilities`).

    /// `fs/read_text_file`: the client reads the file on the agent's behalf.
    pub async fn read_text_file(&self, session_id: &str, path: &str) -> Result<String, String> {
        let result = self
            .request(
                "fs/read_text_file",
                serde_json::json!({ "sessionId": session_id, "path": path }),
            )
            .await?;
        result
            .get("content")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "fs/read_text_file: response is missing `content`".to_string())
    }

    /// `fs/write_text_file`: the client writes the file on the agent's behalf.
    pub async fn write_text_file(
        &self,
        session_id: &str,
        path: &str,
        content: &str,
    ) -> Result<(), String> {
        self.request(
            "fs/write_text_file",
            serde_json::json!({
                "sessionId": session_id,
                "path": path,
                "content": content,
            }),
        )
        .await
        .map(|_| ())
    }

    /// `terminal/create`: the client spawns the terminal and returns its id.
    pub async fn create_terminal(
        &self,
        session_id: &str,
        command: &str,
        args: &[String],
        cwd: Option<&str>,
    ) -> Result<String, String> {
        let result = self
            .request(
                "terminal/create",
                serde_json::json!({
                    "sessionId": session_id,
                    "command": command,
                    "args": args,
                    "cwd": cwd,
                }),
            )
            .await?;
        result
            .get("terminalId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "terminal/create: response is missing `terminalId`".to_string())
    }

    /// `terminal/output`: the terminal's buffered output so far.
    pub async fn terminal_output(
        &self,
        session_id: &str,
        terminal_id: &str,
    ) -> Result<String, String> {
        let result = self
            .request(
                "terminal/output",
                serde_json::json!({
                    "sessionId": session_id,
                    "terminalId": terminal_id,
                }),
            )
            .await?;
        Ok(result
            .get("output")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    /// `terminal/wait_for_exit`: blocks until the terminal exits.
    pub async fn wait_for_terminal_exit(
        &self,
        session_id: &str,
        terminal_id: &str,
    ) -> Result<serde_json::Value, String> {
        self.request(
            "terminal/wait_for_exit",
            serde_json::json!({
                "sessionId": session_id,
                "terminalId": terminal_id,
            }),
        )
        .await
    }

    /// `terminal/kill`: terminate the terminal's command.
    pub async fn kill_terminal(&self, session_id: &str, terminal_id: &str) -> Result<(), String> {
        self.request(
            "terminal/kill",
            serde_json::json!({
                "sessionId": session_id,
                "terminalId": terminal_id,
            }),
        )
        .await
        .map(|_| ())
    }

    /// `terminal/release`: let the client reclaim the terminal.
    pub async fn release_terminal(
        &self,
        session_id: &str,
        terminal_id: &str,
    ) -> Result<(), String> {
        self.request(
            "terminal/release",
            serde_json::json!({
                "sessionId": session_id,
                "terminalId": terminal_id,
            }),
        )
        .await
        .map(|_| ())
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
        assert!(
            channel
                .resolve(
                    id,
                    serde_json::json!({ "outcome": { "outcome": "cancelled" } })
                )
                .await
        );

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

    async fn answer_next(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<AcpOutbound>,
        channel: &AcpChannel,
        answer: serde_json::Value,
    ) -> (String, serde_json::Value) {
        let outbound = rx.recv().await.expect("one outbound request");
        match outbound {
            AcpOutbound::Request(request) => {
                let id = request.id.unwrap().as_u64().unwrap();
                assert!(channel.resolve(id, answer).await);
                (request.method, request.params.unwrap_or_default())
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_read_text_file_reverse_rpc() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let pending = {
            let channel = channel.clone();
            tokio::spawn(async move { channel.read_text_file("s1", "/work/a.txt").await })
        };
        let (method, params) =
            answer_next(&mut rx, &channel, serde_json::json!({ "content": "alpha" })).await;
        assert_eq!(method, "fs/read_text_file");
        assert_eq!(params["sessionId"], "s1");
        assert_eq!(params["path"], "/work/a.txt");
        assert_eq!(pending.await.unwrap().unwrap(), "alpha");
    }

    #[tokio::test]
    async fn test_create_terminal_reverse_rpc() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let pending = {
            let channel = channel.clone();
            tokio::spawn(async move {
                channel
                    .create_terminal("s1", "bash", &["-lc".to_string(), "ls".to_string()], None)
                    .await
            })
        };
        let (method, params) = answer_next(
            &mut rx,
            &channel,
            serde_json::json!({ "terminalId": "term-7" }),
        )
        .await;
        assert_eq!(method, "terminal/create");
        assert_eq!(params["command"], "bash");
        assert_eq!(params["args"][1], "ls");
        assert_eq!(pending.await.unwrap().unwrap(), "term-7");
    }

    #[tokio::test]
    async fn test_read_text_file_requires_content() {
        let channel = AcpChannel::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        channel.set_sink(tx);
        let pending = {
            let channel = channel.clone();
            tokio::spawn(async move { channel.read_text_file("s1", "a").await })
        };
        answer_next(&mut rx, &channel, serde_json::json!({})).await;
        assert!(pending.await.unwrap().is_err());
    }
}
