//! Binary integration test: spawn the `kimi-agent` binary and verify the
//! stdio JSON-RPC round-trip works end-to-end.
//!
//! This test exercises the full IPC path:
//!   1. Spawn the built binary (debug or release, whichever is newer)
//!   2. Send a JSON-RPC request on stdin
//!   3. Read the JSON-RPC response on stdout
//!   4. Assert the response matches the protocol
//!
//! Tests included:
//!   - `health_check_round_trip`: agent/health returns {"status":"ok","version":"0.1.0"}
//!   - `shutdown_round_trip`: agent/shutdown terminates the process cleanly
//!   - `unknown_method_returns_error`: an unknown method yields a -32601 error
//!   - `run_turn_with_host_callbacks`: run_turn drives host/llm_chat + host/execute_tool
//!
//! These tests require the binary to be built (`cargo test --features cli`
//! builds it; so do `cargo build --features cli` and `cargo build --release
//! --features cli`). They are skipped (with a passing assertion) when the
//! binary is absent, so `cargo test` still works without a prior build step —
//! note that a skipped test proves nothing, so CI builds the binary first.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// Find the kimi-agent binary, preferring the most recently built one.
///
/// Ordering by mtime rather than by profile matters: the `cli` binary sits
/// behind `required-features`, so a plain `cargo test` never rebuilds it and a
/// stale artifact in the preferred directory becomes the thing under test.
/// Prefer `cargo test --features cli` so the binary is rebuilt in this profile.
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
        let Ok(metadata) = path.metadata() else { continue };
        let Ok(modified) = metadata.modified() else { continue };
        if newest.as_ref().is_none_or(|(best, _)| modified > *best) {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}

/// A simple RPC client driving the child process stdio.
struct RpcClient {
    child: Child,
    stdout: std::io::BufReader<std::process::ChildStdout>,
    next_id: AtomicU32,
}

impl RpcClient {
    fn start() -> Option<Self> {
        let binary = find_binary()?;
        let mut child = Command::new(&binary)
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
        })
    }

    /// Send a JSON-RPC request and read the matching response.
    /// Returns `None` on timeout or IO error.
    fn request(&mut self, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&req).ok()? + "\n";
        let stdin = self.child.stdin.as_mut()?;
        stdin.write_all(line.as_bytes()).ok()?;
        stdin.flush().ok()?;

        // Read lines until we find a response with matching id.
        let deadline = Instant::now() + Duration::from_secs(10);
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
            let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // A response carries no `method` field.
            if parsed.get("method").is_some() {
                continue;
            }
            if parsed.get("id") == Some(&serde_json::json!(id)) {
                return Some(parsed);
            }
        }
    }

    /// Send a raw line on stdin (used for notifications or raw protocol tests).
    fn send_raw(&mut self, line: &str) -> Option<()> {
        let stdin = self.child.stdin.as_mut()?;
        stdin.write_all(line.as_bytes()).ok()?;
        stdin.write_all(b"\n").ok()?;
        stdin.flush().ok()?;
        Some(())
    }

    fn shutdown(&mut self) {
        let _ = self.request("agent/shutdown", serde_json::json!({}));
        // Give the process a moment to exit.
        std::thread::sleep(Duration::from_millis(100));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Skip the test if the binary is not built.
macro_rules! require_binary {
    ($client:expr) => {
        if $client.is_none() {
            eprintln!("Skipping test: kimi-agent binary not built. Run `cargo build --release`.");
            return;
        }
    };
}

#[test]
fn health_check_round_trip() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    let resp = client.request("agent/health", serde_json::json!({}));
    let resp = resp.expect("health response within 10s");

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    assert_eq!(resp["result"]["status"], "ok");
    assert_eq!(resp["result"]["version"], "0.1.0");

    client.shutdown();
}

#[test]
fn unknown_method_returns_error() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    let resp = client.request("agent/nonexistent", serde_json::json!({}));
    let resp = resp.expect("response within 10s");

    assert_eq!(resp["jsonrpc"], "2.0");
    let err = resp.get("error").expect("expected error field");
    assert_eq!(err["code"], -32601);
    assert!(err["message"]
        .as_str()
        .unwrap_or("")
        .contains("Method not found"));

    client.shutdown();
}

#[test]
fn shutdown_round_trip_terminates_process() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // agent/shutdown calls std::process::exit(0) — we expect the process to
    // terminate. The response may or may not flush before exit, so we just
    // verify the process exits within a short window.
    client.send_raw(
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "agent/shutdown",
            "params": {},
        })
        .to_string(),
    );

    // Wait for the child to exit.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if Instant::now() > deadline {
            // Force-kill and fail.
            let _ = client.child.kill();
            panic!("process did not exit after agent/shutdown");
        }
        match client.child.try_wait() {
            Ok(Some(status)) => {
                assert!(status.success() || status.code() == Some(0));
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
}

/// Full run_turn round-trip with host callbacks.
///
/// The Rust engine calls back into the host (this test process) for
/// `host/llm_chat` and `host/execute_tool`. We respond with a canned LLM
/// that emits one tool call on step 0 and stops on step 1, plus a tool
/// handler returning a known result.
#[test]
fn run_turn_with_host_callbacks() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping test: kimi-agent binary not built.");
            return;
        }
    };

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn kimi-agent");

    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    let llm_step = std::sync::Arc::new(AtomicU32::new(0));

    // Build the agent/run_turn request.
    let run_turn_id: u32 = 1;
    let run_turn_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": run_turn_id,
        "method": "agent/run_turn",
        "params": {
            "turn_id": "integration-test-turn",
            "system_prompt": "You are a test assistant.",
            "model_name": "test-model",
            "messages": [{"role": "user", "content": "read a file"}],
            "tools": [{"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}],
            "max_steps": 5
        }
    });

    // Send agent/run_turn.
    writeln!(stdin, "{}", run_turn_req).unwrap();
    stdin.flush().unwrap();

    let llm_step_for_thread = llm_step.clone();
    let run_turn_id_for_thread = run_turn_id;

    let handler = std::thread::spawn(move || -> Result<serde_json::Value, String> {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);

        loop {
            if Instant::now() > deadline {
                return Err("timed out waiting for agent/run_turn response".into());
            }
            buf.clear();
            let n = stdout.read_line(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("stdout closed before run_turn response".into());
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // If this is the agent/run_turn response, return it.
            if msg.get("method").is_none()
                && msg.get("id") == Some(&serde_json::json!(run_turn_id_for_thread))
            {
                return Ok(msg);
            }

            // Otherwise it's a host request — handle it.
            let method = match msg.get("method").and_then(|m| m.as_str()) {
                Some(m) => m,
                None => continue,
            };
            let req_id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);

            let response = if method == "host/llm_chat" {
                let step = llm_step_for_thread.fetch_add(1, Ordering::SeqCst);
                let tool_calls = if step == 0 {
                    serde_json::json!([{
                        "id": "call-1",
                        "name": "read",
                        "arguments": {"path": "/tmp/test.txt"}
                    }])
                } else {
                    serde_json::json!([])
                };
                let finish_reason = if step == 0 { "tool_calls" } else { "stop" };
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tool_calls": tool_calls,
                        "finish_reason": finish_reason,
                        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
                    }
                })
            } else if method == "host/execute_tool" {
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": "file content from host",
                        "is_error": false
                    }
                })
            } else {
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": format!("unknown method: {method}")}
                })
            };

            writeln!(stdin, "{}", response).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
    });

    let result = handler.join().expect("handler thread panicked");
    let resp = result.expect("agent/run_turn response");

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "agent/run_turn returned error: {resp}"
    );
    let result_obj = &resp["result"];
    assert!(
        result_obj["steps"].as_u64() >= Some(2),
        "expected at least 2 steps, got: {result_obj}"
    );
    let stop_reason = result_obj["stop_reason"]
        .as_str()
        .unwrap_or("");
    assert!(
        stop_reason.contains("EndTurn") || stop_reason.contains("End"),
        "expected EndTurn stop reason, got: {stop_reason}"
    );
    let usage = &result_obj["usage"];
    assert!(usage["input_tokens"].as_u64() >= Some(10));
    assert!(usage["output_tokens"].as_u64() >= Some(5));

    // Verify the LLM was called at least twice (step 0 with tool call,
    // step 1 with stop).
    let steps = llm_step.load(Ordering::SeqCst);
    assert!(steps >= 2, "expected at least 2 LLM calls, got {steps}");

    let _ = child.kill();
    let _ = child.wait();
}

/// Verify that a malformed JSON line on stdin produces a parse error
/// response, not a crash.
#[test]
fn malformed_line_does_not_crash() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Send garbage.
    client.send_raw("this is not json at all");

    // Send a valid health check — the server should still be alive.
    let resp = client.request("agent/health", serde_json::json!({}));
    let resp = resp.expect("health response after malformed line");
    assert_eq!(resp["result"]["status"], "ok");

    client.shutdown();
}

/// Verify that a notification (no id) is handled without a response.
#[test]
fn notification_does_not_get_response() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Send a notification — no response expected.
    client.send_raw(
        &serde_json::json!({
            "jsonrpc": "2.0",
            "method": "agent/notify",
            "params": {"event": "test"}
        })
        .to_string(),
    );

    // Now send a real request — we should get its response, not a stray
    // notification response.
    let resp = client.request("agent/health", serde_json::json!({}));
    let resp = resp.expect("health response");
    assert_eq!(resp["result"]["status"], "ok");

    client.shutdown();
}
// ── Native tool permission round-trip (host/check_permission) ───────────

/// Locate a bash for native-Bash tests; `None` skips them (Windows CI
/// without Git Bash keeps the host-fallback contract anyway).
fn find_bash_for_test() -> Option<String> {
    for candidate in [
        "bash",
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\msys64\\usr\\bin\\bash.exe",
    ] {
        let ok = std::process::Command::new(candidate)
            .arg("-c")
            .arg("exit 0")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(candidate.to_string());
        }
    }
    None
}

/// What the host side observed while driving one native turn.
#[derive(Default)]
struct NativeTurnObservation {
    permission_requests: Vec<serde_json::Value>,
    execute_tool_requests: usize,
    events: Vec<serde_json::Value>,
    run_turn_response: Option<serde_json::Value>,
}

/// Run one `agent/run_turn` with native tools enabled. The host side scripts
/// a single tool call on step 0 and `stop` on step 1, answers
/// `host/check_permission` with `permission_decision`, and records everything
/// it sees. `tool_arguments` is the LLM's tool-call arguments for step 0.
fn drive_native_turn(
    workspace_root: &std::path::Path,
    shell_path: Option<&str>,
    tool_name: &str,
    tool_arguments: serde_json::Value,
    permission_decision: serde_json::Value,
) -> NativeTurnObservation {
    let binary = match find_binary() {
        Some(b) => b,
        None => return NativeTurnObservation::default(),
    };

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn kimi-agent");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");

    let run_turn_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "agent/run_turn",
        "params": {
            "turn_id": "native-permission-turn",
            "system_prompt": "You are a test assistant.",
            "model_name": "test-model",
            "messages": [{"role": "user", "content": "run the tool"}],
            "tools": [{
                "name": tool_name,
                "description": "test tool",
                "input_schema": {"type": "object"}
            }],
            "max_steps": 5,
            "workspace_root": workspace_root.to_string_lossy(),
            "native_tools": true,
            "shell_path": shell_path
        }
    });
    writeln!(stdin, "{}", run_turn_req).unwrap();
    stdin.flush().unwrap();

    let mut reader = BufReader::new(stdout);
    let mut observation = NativeTurnObservation::default();
    let mut llm_step = 0u32;
    let deadline = Instant::now() + Duration::from_secs(30);

    loop {
        if Instant::now() > deadline {
            panic!("timed out driving native turn");
        }
        let mut buf = String::new();
        let n = reader.read_line(&mut buf).expect("read stdout");
        if n == 0 {
            panic!("stdout closed before agent/run_turn response");
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        if method.is_empty() {
            if msg.get("id") == Some(&serde_json::json!(1)) {
                observation.run_turn_response = Some(msg);
                break;
            }
            continue;
        }

        let req_id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let response = match method {
            "host/llm_chat" => {
                let step = llm_step;
                llm_step += 1;
                let tool_calls = if step == 0 {
                    serde_json::json!([{
                        "id": "call-1",
                        "name": tool_name,
                        "arguments": tool_arguments
                    }])
                } else {
                    serde_json::json!([])
                };
                let finish_reason = if step == 0 { "tool_calls" } else { "stop" };
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tool_calls": tool_calls,
                        "finish_reason": finish_reason,
                        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
                    }
                })
            }
            "host/check_permission" => {
                observation
                    .permission_requests
                    .push(msg.get("params").cloned().unwrap_or(serde_json::Value::Null));
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": permission_decision
                })
            }
            "host/execute_tool" => {
                observation.execute_tool_requests += 1;
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"content": "HOST-PATH-EXECUTED", "is_error": false}
                })
            }
            "host/event" => {
                observation
                    .events
                    .push(msg.get("params").cloned().unwrap_or(serde_json::Value::Null));
                continue;
            }
            _ => serde_json::json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": format!("unknown method: {method}")}
            }),
        };

        writeln!(stdin, "{}", response).expect("write host response");
        stdin.flush().unwrap();
    }

    let _ = child.kill();
    let _ = child.wait();
    observation
}

fn require_observation(obs: &NativeTurnObservation) -> Option<&serde_json::Value> {
    match obs.run_turn_response.as_ref() {
        Some(resp) => Some(resp),
        None => {
            eprintln!(
                "Skipping test: kimi-agent binary not built. Run `cargo build --release --features cli`."
            );
            None
        }
    }
}

fn native_events_of(obs: &NativeTurnObservation) -> Vec<&serde_json::Value> {
    obs.events
        .iter()
        .filter(|e| e["type"] == "tool.native")
        .collect()
}

/// A natively-enabled Write call that the host allows must execute inside
/// the Rust process: the file lands on disk, the host hears about it via a
/// `tool.native` event, and the host execute path is never touched.
#[test]
fn run_turn_native_write_permission_round_trip() {
    let dir = std::env::temp_dir().join(format!("kimi-native-write-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");

    let observation = drive_native_turn(
        &dir,
        None,
        "write",
        serde_json::json!({"path": "native.txt", "content": "written natively"}),
        serde_json::json!({"decision": "allow"}),
    );
    let Some(resp) = require_observation(&observation) else { return; };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    let target = dir.join("native.txt");
    assert_eq!(
        std::fs::read_to_string(&target).expect("native write landed").as_str(),
        "written natively"
    );
    assert_eq!(observation.execute_tool_requests, 0, "host execute path must be untouched");
    assert_eq!(observation.permission_requests.len(), 1, "exactly one permission round-trip");
    let req = &observation.permission_requests[0];
    assert_eq!(req["tool_name"], "write");
    assert_eq!(req["arguments"]["path"], "native.txt");
    let native_events = native_events_of(&observation);
    assert_eq!(native_events.len(), 1, "one tool.native report expected");
    assert_eq!(native_events[0]["content"], "Wrote 16 bytes to native.txt");

    let _ = std::fs::remove_dir_all(&dir);
}

/// A host deny verdict is final: the refusal text becomes the tool result,
/// nothing executes natively or on the host, and no second prompt happens.
#[test]
fn run_turn_native_permission_deny_is_final() {
    let dir = std::env::temp_dir().join(format!("kimi-native-deny-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");

    let observation = drive_native_turn(
        &dir,
        None,
        "write",
        serde_json::json!({"path": "denied.txt", "content": "should not exist"}),
        serde_json::json!({"decision": "deny", "reason": "denied by test policy"}),
    );
    let Some(resp) = require_observation(&observation) else { return; };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    assert!(!dir.join("denied.txt").exists(), "denied call must not write");
    assert_eq!(observation.execute_tool_requests, 0, "deny must not fall back to the host");
    let native_events = native_events_of(&observation);
    assert_eq!(native_events.len(), 1, "the refusal is the tool result");
    assert_eq!(native_events[0]["is_error"], true);
    assert_eq!(native_events[0]["content"], "denied by test policy");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Native Bash must honor the host's shell path: arithmetic evaluation is
/// bash semantics that cmd /C cannot perform.
#[test]
fn native_bash_uses_host_shell() {
    let shell = match find_bash_for_test() {
        Some(s) => s,
        None => {
            eprintln!("Skipping test: no bash on PATH.");
            return;
        }
    };
    let dir = std::env::temp_dir().join(format!("kimi-native-bash-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");

    let observation = drive_native_turn(
        &dir,
        Some(&shell),
        "bash",
        serde_json::json!({"command": "echo $((20+3))"}),
        serde_json::json!({"decision": "allow"}),
    );
    let Some(resp) = require_observation(&observation) else { return; };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    let native_events = native_events_of(&observation);
    assert_eq!(native_events.len(), 1, "bash must execute natively, not on the host");
    assert_eq!(observation.execute_tool_requests, 0);
    let content = native_events[0]["content"].as_str().unwrap_or("");
    assert!(content.contains("23"), "bash arithmetic must evaluate, got: {content}");

    let _ = std::fs::remove_dir_all(&dir);
}