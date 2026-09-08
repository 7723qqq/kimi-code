//! Binary integration test for the ACP stdio surface.
//!
//! Spawns the built `kimi-agent-cli` binary with `--acp`, points it at an empty
//! config (so no native LLM is resolved and the canned prompt path runs), and
//! drives the JSON-RPC stream over stdin/stdout:
//!   1. `initialize` answers the ACP spec handshake shape
//!   2. a notification (no `id`) never produces an output line
//!   3. `session/new` → `session/prompt` (`ContentBlock[]`) → `session/load`
//!      round-trips a session
//!   4. an unknown method yields -32601
//!
//! Requires the binary (`cargo test --features cli` builds it); the tests skip
//! with a passing assertion when it is absent, so a skipped run proves nothing.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// Find the kimi-agent binary, preferring the most recently built one.
fn find_binary() -> Option<std::path::PathBuf> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let candidates = [
        format!("target/debug/kimi-agent-cli{ext}"),
        format!("target/release/kimi-agent-cli{ext}"),
    ];
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for candidate in candidates {
        let path = std::path::Path::new(manifest_dir).join(candidate);
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if newest.as_ref().is_none_or(|(best, _)| modified > *best) {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}

struct AcpClient {
    child: Child,
    stdout: BufReader<std::process::ChildStdout>,
    next_id: AtomicU32,
    data_dir: std::path::PathBuf,
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

impl AcpClient {
    /// Start the binary in ACP mode with an empty config (no native LLM).
    fn start() -> Option<Self> {
        let binary = find_binary()?;
        let data_dir = std::env::temp_dir().join(format!(
            "kimi_acp_it_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&data_dir).ok()?;
        let config_path = data_dir.join("config.toml");
        std::fs::write(&config_path, "").ok()?;

        let mut child = Command::new(&binary)
            .arg("--acp")
            .arg("--data-dir")
            .arg(&data_dir)
            .arg("--config")
            .arg(&config_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;
        let stdout = BufReader::new(child.stdout.take()?);
        Some(Self {
            child,
            stdout,
            next_id: AtomicU32::new(1),
            data_dir,
        })
    }

    fn write_line(&mut self, value: &serde_json::Value) -> Option<()> {
        let line = serde_json::to_string(value).ok()? + "\n";
        let stdin = self.child.stdin.as_mut()?;
        stdin.write_all(line.as_bytes()).ok()?;
        stdin.flush().ok()?;
        Some(())
    }

    /// Read the next non-empty stdout line, bounded by a deadline.
    fn read_line(&mut self, timeout: Duration) -> Option<serde_json::Value> {
        let deadline = Instant::now() + timeout;
        let mut buf = String::new();
        loop {
            if Instant::now() > deadline {
                return None;
            }
            buf.clear();
            let n = self.stdout.read_line(&mut buf).ok()?;
            if n == 0 {
                return None;
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            return serde_json::from_str(trimmed).ok();
        }
    }

    /// Send a request and read its response.
    fn request(&mut self, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.write_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        let response = self.read_line(Duration::from_secs(10))?;
        assert_eq!(
            response["id"],
            serde_json::json!(id),
            "unexpected response for {method}: {response}"
        );
        Some(response)
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) -> Option<()> {
        self.write_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }
}

#[test]
fn acp_initialize_returns_spec_handshake() {
    let Some(mut client) = AcpClient::start() else {
        return;
    };
    let response = client
        .request(
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": true } },
                "clientInfo": { "name": "zed", "version": "1.0.0" }
            }),
        )
        .expect("initialize must answer");
    assert!(response["error"].is_null(), "unexpected error: {response}");
    let result = &response["result"];
    assert_eq!(result["protocolVersion"], 1);
    assert!(result.get("protocol_version").is_none());
    assert_eq!(result["agentCapabilities"]["loadSession"], true);
    assert_eq!(result["authMethods"][0]["id"], "login");
    assert_eq!(result["authMethods"][0]["type"], "terminal");
    assert_eq!(result["agentInfo"]["name"], "kimi-agent-rust");
}

/// A notification must not produce an output line: the next line on stdout is
/// the answer to the *following* request.
#[test]
fn acp_notification_is_not_answered_on_stdio() {
    let Some(mut client) = AcpClient::start() else {
        return;
    };
    client
        .notify("session/cancel", serde_json::json!({ "sessionId": "sess-1" }))
        .expect("cancel notification must be accepted");

    let id = client.next_id.fetch_add(1, Ordering::SeqCst);
    client
        .write_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "ping",
            "params": {}
        }))
        .expect("ping must be accepted");

    let next = client
        .read_line(Duration::from_secs(10))
        .expect("ping must answer");
    assert_eq!(
        next["id"],
        serde_json::json!(id),
        "the first line after the notification must be the ping response, got {next}"
    );
    assert_eq!(next["result"], "pong");
}

#[test]
fn acp_session_round_trip_with_content_blocks() {
    let Some(mut client) = AcpClient::start() else {
        return;
    };
    let response = client
        .request("session/new", serde_json::json!({ "cwd": "/tmp" }))
        .expect("session/new must answer");
    let session_id = response["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();
    assert_eq!(response["result"]["modes"]["currentModeId"], "default");
    assert_eq!(
        response["result"]["modes"]["availableModes"]
            .as_array()
            .expect("available modes")
            .len(),
        4
    );

    let response = client
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": session_id,
                "prompt": [
                    { "type": "text", "text": "hello" },
                    { "type": "image", "mimeType": "image/png", "data": "AAAA" }
                ]
            }),
        )
        .expect("session/prompt must answer");
    assert!(response["error"].is_null(), "unexpected error: {response}");
    assert_eq!(response["result"]["stopReason"], "end_turn");

    // `session/load` replays the stored history as `session/update` chunks and
    // answers with the mode state (v2 `loadSession`).
    let id = client.next_id.fetch_add(1, Ordering::SeqCst);
    client
        .write_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/load",
            "params": { "sessionId": session_id }
        }))
        .expect("session/load must be accepted");

    let mut replayed = Vec::new();
    let response = loop {
        let line = client
            .read_line(Duration::from_secs(10))
            .expect("session/load must answer");
        if line.get("method").is_some() {
            replayed.push(line);
            continue;
        }
        break line;
    };
    assert_eq!(response["id"], serde_json::json!(id));
    assert_eq!(response["result"]["modes"]["currentModeId"], "default");

    let user_chunk = replayed
        .iter()
        .find(|line| {
            line["params"]["update"]["sessionUpdate"] == serde_json::json!("user_message_chunk")
        })
        .expect("the stored user prompt must replay");
    assert_eq!(user_chunk["params"]["update"]["content"]["text"], "hello");
}

/// A response line (the client's answer to a server-initiated request) is
/// routed to the back channel, never parsed as a client request.
#[test]
fn acp_response_line_is_not_treated_as_a_request() {
    let Some(mut client) = AcpClient::start() else {
        return;
    };
    client
        .write_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 999,
            "result": { "outcome": { "outcome": "cancelled" } }
        }))
        .expect("response line must be accepted");

    let id = client.next_id.fetch_add(1, Ordering::SeqCst);
    client
        .write_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "ping",
            "params": {}
        }))
        .expect("ping must be accepted");
    let next = client
        .read_line(Duration::from_secs(10))
        .expect("ping must answer");
    assert_eq!(
        next["id"],
        serde_json::json!(id),
        "the response line must not produce a parse error, got {next}"
    );
    assert_eq!(next["result"], "pong");
}

/// `session/set_mode` answers *and* pushes `current_mode_update`; the two
/// lines may arrive in either order, so the test sorts them out by shape.
#[test]
fn acp_set_mode_notifies_on_stdio() {
    let Some(mut client) = AcpClient::start() else {
        return;
    };
    let response = client
        .request("session/new", serde_json::json!({}))
        .expect("session/new must answer");
    let session_id = response["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let id = client.next_id.fetch_add(1, Ordering::SeqCst);
    client
        .write_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/set_mode",
            "params": { "sessionId": session_id, "modeId": "auto" }
        }))
        .expect("set_mode must be accepted");

    let first = client
        .read_line(Duration::from_secs(10))
        .expect("first line");
    let second = client
        .read_line(Duration::from_secs(10))
        .expect("second line");
    let (notification, response) = if first.get("method").is_some() {
        (first, second)
    } else {
        (second, first)
    };

    assert_eq!(notification["method"], "session/update");
    assert_eq!(
        notification["params"]["update"]["sessionUpdate"],
        "current_mode_update"
    );
    assert_eq!(notification["params"]["update"]["currentModeId"], "auto");
    assert_eq!(notification["params"]["sessionId"], session_id);

    assert_eq!(response["id"], serde_json::json!(id));
    assert_eq!(response["result"]["modeId"], "auto");
}

/// `session/resume` answers with the mode state and `session/fork` mints a
/// new session id (v2 `resumeSession` / `forkSession`).
#[test]
fn acp_resume_and_fork_on_stdio() {
    let Some(mut client) = AcpClient::start() else {
        return;
    };
    let response = client
        .request("session/new", serde_json::json!({}))
        .expect("session/new must answer");
    let session_id = response["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let response = client
        .request(
            "session/resume",
            serde_json::json!({ "sessionId": session_id }),
        )
        .expect("session/resume must answer");
    assert!(response["error"].is_null(), "unexpected error: {response}");
    assert_eq!(response["result"]["modes"]["currentModeId"], "default");

    let response = client
        .request(
            "session/fork",
            serde_json::json!({ "sessionId": session_id }),
        )
        .expect("session/fork must answer");
    let forked = response["result"]["sessionId"]
        .as_str()
        .expect("forked session id");
    assert_ne!(forked, session_id);
    assert_eq!(response["result"]["modes"]["availableModes"].as_array().unwrap().len(), 4);
}

#[test]
fn acp_unknown_method_returns_method_not_found() {
    let Some(mut client) = AcpClient::start() else {
        return;
    };
    let response = client
        .request("no/such/method", serde_json::json!({}))
        .expect("unknown method must answer");
    assert_eq!(response["error"]["code"], -32601);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Method not found")
    );
}
