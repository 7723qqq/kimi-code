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
    assert!(
        err["message"]
            .as_str()
            .unwrap_or("")
            .contains("Method not found")
    );

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
    let stop_reason = result_obj["stop_reason"].as_str().unwrap_or("");
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
    state_read_requests: Vec<serde_json::Value>,
    execute_tool_requests: usize,
    events: Vec<serde_json::Value>,
    run_turn_response: Option<serde_json::Value>,
}

/// Run one `agent/run_turn` with native tools enabled. The host side scripts
/// a single tool call on step 0 and `stop` on step 1, answers
/// `host/check_permission` with `permission_decision`, answers
/// `host/state_read` with `plan_state` (the state-bridge plan domain value),
/// and records everything it sees. `tool_arguments` is the LLM's tool-call
/// arguments for step 0.
fn drive_native_turn(
    workspace_root: &std::path::Path,
    shell_path: Option<&str>,
    tool_name: &str,
    tool_arguments: serde_json::Value,
    permission_decision: serde_json::Value,
    plan_state: serde_json::Value,
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
                observation.permission_requests.push(
                    msg.get("params")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": permission_decision
                })
            }
            "host/state_read" => {
                observation.state_read_requests.push(
                    msg.get("params")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"value": plan_state}
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
                observation.events.push(
                    msg.get("params")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
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
        serde_json::Value::Null,
    );
    let Some(resp) = require_observation(&observation) else {
        return;
    };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    let target = dir.join("native.txt");
    assert_eq!(
        std::fs::read_to_string(&target)
            .expect("native write landed")
            .as_str(),
        "written natively"
    );
    assert_eq!(
        observation.execute_tool_requests, 0,
        "host execute path must be untouched"
    );
    assert_eq!(
        observation.permission_requests.len(),
        1,
        "exactly one permission round-trip"
    );
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
        serde_json::Value::Null,
    );
    let Some(resp) = require_observation(&observation) else {
        return;
    };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    assert!(
        !dir.join("denied.txt").exists(),
        "denied call must not write"
    );
    assert_eq!(
        observation.execute_tool_requests, 0,
        "deny must not fall back to the host"
    );
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
        serde_json::Value::Null,
    );
    let Some(resp) = require_observation(&observation) else {
        return;
    };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    let native_events = native_events_of(&observation);
    assert_eq!(
        native_events.len(),
        1,
        "bash must execute natively, not on the host"
    );
    assert_eq!(observation.execute_tool_requests, 0);
    let content = native_events[0]["content"].as_str().unwrap_or("");
    assert!(
        content.contains("23"),
        "bash arithmetic must evaluate, got: {content}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Plan-mode guard (v2 `AgentPlanService.guardToolExecution`): with plan mode
/// active, a native Write outside the plan file is denied before permission —
/// the refusal is the tool result, nothing lands on disk, and the host's
/// plan state was read through the state bridge.
#[test]
fn run_turn_native_write_denied_in_plan_mode() {
    let dir = std::env::temp_dir().join(format!("kimi-native-plan-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");
    let plan_path = dir.join("plans").join("plan-1.md");
    std::fs::create_dir_all(plan_path.parent().unwrap()).expect("create plans dir");
    std::fs::write(&plan_path, "# plan").expect("seed plan file");

    let observation = drive_native_turn(
        &dir,
        None,
        "write",
        serde_json::json!({"path": "src/main.rs", "content": "should not exist"}),
        serde_json::json!({"decision": "allow"}),
        serde_json::json!({"active": true, "id": "plan-1", "path": plan_path.to_string_lossy()}),
    );
    let Some(resp) = require_observation(&observation) else {
        return;
    };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    assert!(
        !dir.join("src").exists(),
        "plan-mode write must not land on disk"
    );
    assert_eq!(
        observation.execute_tool_requests, 0,
        "denial must not fall back to the host"
    );
    assert!(
        observation.permission_requests.is_empty(),
        "the plan guard vetoes before the permission round-trip"
    );
    let read_requests = &observation.state_read_requests;
    assert_eq!(read_requests.len(), 1, "one plan-state read");
    assert_eq!(read_requests[0]["domain"], "plan");
    assert_eq!(read_requests[0]["key"], "plan");
    let native_events = native_events_of(&observation);
    assert_eq!(native_events.len(), 1, "the refusal is the tool result");
    assert_eq!(native_events[0]["is_error"], true);
    let content = native_events[0]["content"].as_str().unwrap_or("");
    assert!(
        content.contains("Plan mode is active"),
        "denial must carry the plan-mode reason, got: {content}"
    );
    assert!(content.contains(plan_path.to_string_lossy().as_ref()));

    let _ = std::fs::remove_dir_all(&dir);
}

// ── Stale-write guard (v2 `staleGuardService`, G-6 #3) ─────────────────────

/// The tool calls scripted for one turn: entry *k* is the call list returned
/// for the turn's *k*-th `host/llm_chat`; an empty list ends the turn.
struct TurnScript(Vec<Vec<(String, serde_json::Value)>>);

/// What the host observed across one or more turns on a single process.
#[derive(Default, Debug)]
struct MultiTurnObservation {
    permission_requests: Vec<serde_json::Value>,
    state_read_requests: Vec<serde_json::Value>,
    execute_tool_requests: Vec<serde_json::Value>,
    events: Vec<serde_json::Value>,
    turn_responses: Vec<serde_json::Value>,
}

fn require_multi_turn(observation: &MultiTurnObservation) -> bool {
    if observation.turn_responses.is_empty() {
        eprintln!(
            "Skipping test: kimi-agent binary not built. Run `cargo build --release --features cli`."
        );
        return false;
    }
    true
}

/// Read one JSON-RPC line from the engine, answering `host/*` requests as
/// they arrive, until a response with one of `pending_ids` shows up. `script`
/// scripts the next `host/llm_chat` (empty when the engine should stop);
/// `llm_step` advances per chat and spans multiple serve calls within a
/// turn. `before_tool_step(turn, step)` fires just before a chat response
/// carrying tool calls is scripted — the seam where a host-side mtime bump
/// lands between the previous step's executions and this step's.
#[allow(clippy::too_many_arguments)]
fn serve_until_response(
    reader: &mut BufReader<std::process::ChildStdout>,
    stdin: &mut std::process::ChildStdin,
    deadline: &Instant,
    pending_ids: &[u64],
    script: Option<(&TurnScript, usize)>,
    llm_step: &mut usize,
    before_tool_step: Option<&dyn Fn(usize, usize)>,
    permission_decision: &serde_json::Value,
    plan_state: &serde_json::Value,
    observation: &mut MultiTurnObservation,
) -> serde_json::Value {
    loop {
        if Instant::now() > *deadline {
            panic!("timed out serving RPC");
        }
        let mut buf = String::new();
        let n = reader.read_line(&mut buf).expect("read stdout");
        if n == 0 {
            panic!("stdout closed before the expected response");
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
            let id = msg.get("id").and_then(|v| v.as_u64());
            if id.is_some_and(|id| pending_ids.contains(&id)) {
                return msg;
            }
            continue;
        }

        let req_id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let response = match method {
            "host/llm_chat" => {
                if let Some(hook) = before_tool_step {
                    let turn_index = script.map(|(_, ti)| ti).unwrap_or(0);
                    hook(turn_index, *llm_step);
                }
                let calls = script
                    .map(|(s, _turn_index)| s.0.get(*llm_step).cloned().unwrap_or_default())
                    .unwrap_or_default();
                *llm_step += 1;
                let tool_calls: Vec<serde_json::Value> = calls
                    .iter()
                    .enumerate()
                    .map(|(i, (name, args))| {
                        let turn_index = script.map(|(_, ti)| ti).unwrap_or(0);
                        serde_json::json!({
                            "id": format!("call-{turn_index}-{i}"),
                            "name": name,
                            "arguments": args
                        })
                    })
                    .collect();
                let finish_reason = if tool_calls.is_empty() {
                    "stop"
                } else {
                    "tool_calls"
                };
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
                observation.permission_requests.push(
                    msg.get("params")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": permission_decision
                })
            }
            "host/state_read" => {
                observation.state_read_requests.push(
                    msg.get("params")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"value": plan_state}
                })
            }
            "host/execute_tool" => {
                observation.execute_tool_requests.push(
                    msg.get("params")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"content": "HOST-PATH-EXECUTED", "is_error": false}
                })
            }
            "host/event" => {
                observation.events.push(
                    msg.get("params")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                );
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
}

/// Run several `agent/run_turn` requests over ONE process. Each turn's
/// `host/llm_chat` is answered from its [`TurnScript`] (the `run_turn` seam
/// builds a fresh pipeline per request, so per-turn state like the
/// stale-guard table does NOT survive across these turns — cross-turn state
/// lives on the session RPC, see `drive_session_turns`).
fn drive_native_turns(
    workspace_root: &std::path::Path,
    scripts: &[TurnScript],
    permission_decision: serde_json::Value,
    plan_state: serde_json::Value,
    before_tool_step: Option<&dyn Fn(usize, usize)>,
) -> MultiTurnObservation {
    let binary = match find_binary() {
        Some(b) => b,
        None => return MultiTurnObservation::default(),
    };

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);

    let mut observation = MultiTurnObservation::default();
    let deadline = Instant::now() + Duration::from_secs(60);
    let tool_defs = serde_json::json!([
        {"name": "read", "description": "t", "input_schema": {"type": "object"}},
        {"name": "write", "description": "t", "input_schema": {"type": "object"}}
    ]);

    'turns: for (turn_index, script) in scripts.iter().enumerate() {
        let run_turn_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "agent/run_turn",
            "params": {
                "turn_id": format!("native-stale-turn-{turn_index}"),
                "system_prompt": "You are a test assistant.",
                "model_name": "test-model",
                "messages": [{"role": "user", "content": "run the tool"}],
                "tools": tool_defs,
                "max_steps": 5,
                "workspace_root": workspace_root.to_string_lossy(),
                "native_tools": true
            }
        });
        writeln!(stdin, "{}", run_turn_req).expect("write run_turn request");
        stdin.flush().unwrap();

        let mut llm_step = 0usize;
        let response = serve_until_response(
            &mut reader,
            &mut stdin,
            &deadline,
            &[1],
            Some((script, turn_index)),
            &mut llm_step,
            before_tool_step,
            &permission_decision,
            &plan_state,
            &mut observation,
        );
        observation.turn_responses.push(response);
        continue 'turns;
    }

    let _ = child.kill();
    let _ = child.wait();
    observation
}

fn multi_native_events_of(obs: &MultiTurnObservation) -> Vec<&serde_json::Value> {
    obs.events
        .iter()
        .filter(|e| e["type"] == "tool.native")
        .collect()
}

/// Drive the M1d 3b session RPC over ONE process: `session/create` once (the
/// engine pipeline — and with it the stale-guard table — is built once),
/// then per [`TurnScript`] `session/enqueue_turn` + `session/turn_outcome`,
/// answering `host/*` requests in between. `turn_responses` holds the per-
/// turn outcome results.
fn drive_session_turns(
    workspace_root: &std::path::Path,
    scripts: &[TurnScript],
    permission_decision: serde_json::Value,
    plan_state: serde_json::Value,
) -> MultiTurnObservation {
    let binary = match find_binary() {
        Some(b) => b,
        None => return MultiTurnObservation::default(),
    };

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);

    let mut observation = MultiTurnObservation::default();
    let deadline = Instant::now() + Duration::from_secs(60);
    let tool_defs = serde_json::json!([
        {"name": "read", "description": "t", "input_schema": {"type": "object"}},
        {"name": "write", "description": "t", "input_schema": {"type": "object"}}
    ]);

    // session/create → session_id (no turn runs yet, so no host requests).
    let create_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "session/create",
        "params": {
            "turn_id": "session-create",
            "system_prompt": "You are a test assistant.",
            "model_name": "test-model",
            "messages": [{"role": "user", "content": "seed"}],
            "tools": tool_defs,
            "max_steps": 5,
            "workspace_root": workspace_root.to_string_lossy(),
            "native_tools": true
        }
    });
    writeln!(stdin, "{}", create_req).expect("write session/create");
    stdin.flush().unwrap();
    let create_response = serve_until_response(
        &mut reader,
        &mut stdin,
        &deadline,
        &[1],
        None,
        &mut 0usize,
        None,
        &permission_decision,
        &plan_state,
        &mut observation,
    );
    let session_id = create_response["result"]
        .as_str()
        .expect("session/create returns a session id")
        .to_string();

    for (turn_index, script) in scripts.iter().enumerate() {
        let enqueue_id = 2 + 2 * turn_index as u64;
        let outcome_id = enqueue_id + 1;

        // The pump starts the turn as soon as enqueue is processed, so the
        // enqueue-wait loop must already answer host/* requests.
        let enqueue_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": enqueue_id,
            "method": "session/enqueue_turn",
            "params": {
                "session_id": session_id,
                "prompt": {"role": "user", "content": "run the tool"},
                "admission": "activeOrNewTurn"
            }
        });
        writeln!(stdin, "{}", enqueue_req).expect("write session/enqueue_turn");
        stdin.flush().unwrap();
        let mut llm_step = 0usize;
        let enqueue_response = serve_until_response(
            &mut reader,
            &mut stdin,
            &deadline,
            &[enqueue_id],
            Some((script, turn_index)),
            &mut llm_step,
            None,
            &permission_decision,
            &plan_state,
            &mut observation,
        );
        let turn_id = enqueue_response["result"]
            .as_u64()
            .expect("enqueue returns a turn id");

        let outcome_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": outcome_id,
            "method": "session/turn_outcome",
            "params": {"session_id": session_id, "turn_id": turn_id}
        });
        writeln!(stdin, "{}", outcome_req).expect("write session/turn_outcome");
        stdin.flush().unwrap();
        let outcome = serve_until_response(
            &mut reader,
            &mut stdin,
            &deadline,
            &[outcome_id],
            Some((script, turn_index)),
            &mut llm_step,
            None,
            &permission_decision,
            &plan_state,
            &mut observation,
        );
        observation.turn_responses.push(outcome);
    }

    let _ = child.kill();
    let _ = child.wait();
    observation
}

/// An unread existing file denies a native Write: the v2 message becomes the
/// tool result, nothing executes natively or on the host, and the file is
/// untouched.
#[test]
fn run_turn_native_write_denied_when_unread() {
    let dir = std::env::temp_dir().join(format!("kimi-stale-unread-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");
    std::fs::write(dir.join("a.txt"), "hello").expect("seed file");

    let observation = drive_native_turn(
        &dir,
        None,
        "write",
        serde_json::json!({"path": "a.txt", "content": "should not land"}),
        serde_json::json!({"decision": "allow"}),
        serde_json::Value::Null,
    );
    let Some(resp) = require_observation(&observation) else {
        return;
    };

    assert!(resp.get("error").is_none(), "run_turn errored: {resp}");
    assert_eq!(
        std::fs::read_to_string(dir.join("a.txt")).unwrap(),
        "hello",
        "the stale denial must not touch the file"
    );
    assert_eq!(
        observation.execute_tool_requests, 0,
        "stale denial must not fall back to the host"
    );
    let native_events = native_events_of(&observation);
    assert_eq!(native_events.len(), 1, "the refusal is the tool result");
    assert_eq!(native_events[0]["is_error"], true);
    let content = native_events[0]["content"].as_str().unwrap_or("");
    assert!(
        content.contains(
            "\"a.txt\" has not been read by this agent yet. Read the file before writing to it."
        ),
        "byte-exact v2 message expected, got: {content}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Read-then-write in one turn passes: the native Read records the mtime and
/// the subsequent native Write clears the guard.
#[test]
fn run_turn_native_read_then_write_passes() {
    let dir = std::env::temp_dir().join(format!("kimi-stale-rw-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");
    std::fs::write(dir.join("a.txt"), "hello").expect("seed file");

    let observation = drive_native_turns(
        &dir,
        &[TurnScript(vec![
            vec![("read".into(), serde_json::json!({"path": "a.txt"}))],
            vec![(
                "write".into(),
                serde_json::json!({"path": "a.txt", "content": "updated"}),
            )],
            vec![],
        ])],
        serde_json::json!({"decision": "allow"}),
        serde_json::Value::Null,
        None,
    );
    if !require_multi_turn(&observation) {
        return;
    }

    assert!(
        observation.turn_responses[0].get("error").is_none(),
        "run_turn errored: {observation:?}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("a.txt")).unwrap(),
        "updated",
        "the write must land after the read"
    );
    assert_eq!(
        observation.execute_tool_requests.len(),
        0,
        "both calls run natively"
    );
    let native_events = multi_native_events_of(&observation);
    assert_eq!(native_events.len(), 2, "read + write both reported");
    assert_eq!(native_events[1]["is_error"], false);
    // One plan-guard state read for the Write; the Read is not plan-guarded
    // and the stale gate never had to consult (no denial).
    assert_eq!(observation.state_read_requests.len(), 1);

    let _ = std::fs::remove_dir_all(&dir);
}

/// An external modification between the read and the write denies the write:
/// the host bumps the file while scripting the second step (after the Read
/// executed, before the Write does).
#[test]
fn run_turn_native_write_denied_after_external_modification() {
    let dir = std::env::temp_dir().join(format!("kimi-stale-mod-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");
    let target = dir.join("a.txt");
    std::fs::write(&target, "hello").expect("seed file");

    let bump_target = target.clone();
    let observation = drive_native_turns(
        &dir,
        &[TurnScript(vec![
            vec![("read".into(), serde_json::json!({"path": "a.txt"}))],
            vec![(
                "write".into(),
                serde_json::json!({"path": "a.txt", "content": "blind write"}),
            )],
            vec![],
        ])],
        serde_json::json!({"decision": "allow"}),
        serde_json::Value::Null,
        Some(&|turn, step| {
            if turn == 0 && step == 1 {
                std::fs::write(&bump_target, "externally changed").expect("bump mtime");
            }
        }),
    );
    if !require_multi_turn(&observation) {
        return;
    }

    assert!(
        observation.turn_responses[0].get("error").is_none(),
        "run_turn errored: {observation:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "externally changed",
        "the denied write must not clobber the external change"
    );
    assert_eq!(observation.execute_tool_requests.len(), 0);
    let native_events = multi_native_events_of(&observation);
    assert_eq!(native_events.len(), 2);
    assert_eq!(native_events[1]["is_error"], true);
    let content = native_events[1]["content"].as_str().unwrap_or("");
    assert!(
        content.contains(
            "\"a.txt\" has been modified on disk since this agent last read it. Read the file again before writing to it."
        ),
        "byte-exact v2 modified-message expected, got: {content}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A read the HOST served (region Read falls back for the media pipeline)
/// must also clear a later native Write — the gate observes host-forwarded
/// executions.
#[test]
fn run_turn_native_host_read_clears_native_write() {
    let dir = std::env::temp_dir().join(format!("kimi-stale-hostread-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");
    std::fs::write(dir.join("media.txt"), "hello").expect("seed file");

    let observation = drive_native_turns(
        &dir,
        &[TurnScript(vec![
            vec![(
                "read".into(),
                serde_json::json!({"path": "media.txt", "region": {"x": 0}}),
            )],
            vec![(
                "write".into(),
                serde_json::json!({"path": "media.txt", "content": "updated"}),
            )],
            vec![],
        ])],
        serde_json::json!({"decision": "allow"}),
        serde_json::Value::Null,
        None,
    );
    if !require_multi_turn(&observation) {
        return;
    }

    assert!(
        observation.turn_responses[0].get("error").is_none(),
        "run_turn errored: {observation:?}"
    );
    assert_eq!(
        observation.execute_tool_requests.len(),
        1,
        "the region read runs on the host"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("media.txt")).unwrap(),
        "updated",
        "the write must land after the host-served read"
    );
    let native_events = multi_native_events_of(&observation);
    assert_eq!(native_events.len(), 1, "only the write is native");
    assert_eq!(native_events[0]["is_error"], false);

    let _ = std::fs::remove_dir_all(&dir);
}

/// The stale table lives on the session pipeline (M1d 3b session RPC): a
/// read in turn 0 clears a write in turn 1 on the same session.
#[test]
fn run_turn_native_stale_state_survives_across_turns() {
    let dir = std::env::temp_dir().join(format!("kimi-stale-cross-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create workspace root");
    std::fs::write(dir.join("a.txt"), "hello").expect("seed file");

    let observation = drive_session_turns(
        &dir,
        &[
            TurnScript(vec![
                vec![("read".into(), serde_json::json!({"path": "a.txt"}))],
                vec![],
            ]),
            TurnScript(vec![
                vec![(
                    "write".into(),
                    serde_json::json!({"path": "a.txt", "content": "turn two"}),
                )],
                vec![],
            ]),
        ],
        serde_json::json!({"decision": "allow"}),
        serde_json::Value::Null,
    );
    if !require_multi_turn(&observation) {
        return;
    }

    assert_eq!(observation.turn_responses.len(), 2, "both turns completed");
    for resp in &observation.turn_responses {
        assert!(resp.get("error").is_none(), "session RPC errored: {resp}");
        assert_eq!(resp["result"]["status"], "ran");
        assert!(resp["result"]["result"]["stop_reason"].as_str().is_some());
    }
    assert_eq!(
        std::fs::read_to_string(dir.join("a.txt")).unwrap(),
        "turn two",
        "a turn-0 read must clear the turn-1 write"
    );
    let native_events = multi_native_events_of(&observation);
    assert_eq!(native_events.len(), 2);
    assert_eq!(native_events[1]["is_error"], false);

    let _ = std::fs::remove_dir_all(&dir);
}
