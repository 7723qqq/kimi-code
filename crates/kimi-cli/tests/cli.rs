//! kimi-cli integration tests — drive the built `kimi` binary end-to-end
//! (stage C verification). Each test runs in its own temp home + cwd so the
//! engine's config lookup (project `.kimi-code/config.toml`, user config)
//! never leaks real settings in.

use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::process::{Command, Output};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_kimi")
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kimi-cli-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    dir
}

/// Unique cwd per `run` invocation — tests share one process id, and two
/// tests running `run()` in parallel must not delete each other's cwd.
static CWD_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn run(home: &Path, args: &[&str]) -> Output {
    let n = CWD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let cwd = temp_dir(&format!("cwd{n}"));
    Command::new(binary())
        .args(args)
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", home)
        .env("KIMI_CODE_HOME", home)
        .env("HOME", home)
        .env_remove("KIMI_MODEL")
        .env_remove("KIMI_MODEL_API_KEY")
        .env_remove("KIMI_UPGRADE_REGISTRY")
        .output()
        .expect("spawn kimi")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

#[test]
fn health_reports_ok() {
    let home = temp_dir("health");
    let output = run(&home, &["health"]);
    assert!(output.status.success(), "health exited {}", output.status);
    assert_eq!(stdout(&output).trim(), "ok");
}

#[test]
fn sessions_empty_home_is_empty() {
    let home = temp_dir("sessions");
    let output = run(&home, &["sessions"]);
    assert!(output.status.success(), "sessions exited {}", output.status);
    assert_eq!(stdout(&output), "", "no sessions -> no output");

    // `--json` prints a valid empty array instead.
    let output = run(&home, &["sessions", "--json"]);
    assert!(output.status.success());
    assert_eq!(stdout(&output).trim(), "[]");
}

#[test]
fn export_without_id_and_without_yes_errors() {
    let home = temp_dir("export-noarg");
    let output = run(&home, &["export"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("No previous session"),
        "stderr should explain there is nothing to export: {}",
        stderr(&output)
    );
}

#[test]
fn export_yes_with_no_sessions_errors() {
    let home = temp_dir("export-none");
    let output = run(&home, &["export", "-y"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("No previous session"),
        "stderr should say there are no sessions: {}",
        stderr(&output)
    );
}

#[test]
fn config_prints_without_errors() {
    let home = temp_dir("config");
    let output = run(&home, &["config"]);
    assert!(output.status.success(), "config exited {}", output.status);
    // The config snapshot is valid JSON (defaults at minimum).
    let value: serde_json::Value = serde_json::from_str(stdout(&output).trim())
        .expect("config output is valid JSON");
    assert!(value.is_object());
}

/// The built `kimi-server-serve` binary lives next to `kimi` in target/debug.
fn serve_bin() -> Option<std::path::PathBuf> {
    let kimi = std::path::Path::new(binary());
    let dir = kimi.parent()?;
    let exe = if cfg!(windows) { "kimi-server-serve.exe" } else { "kimi-server-serve" };
    let bin = dir.join(exe);
    bin.exists().then_some(bin)
}

#[test]
fn server_mode_health_ok() {
    // Drive a separate server process over stdio (`--server <bin>`).
    let Some(serve) = serve_bin() else {
        eprintln!("skipping: kimi-server-serve binary not built");
        return;
    };
    let home = temp_dir("server-health");
    let output = run(&home, &["--server", serve.to_str().unwrap(), "health"]);
    assert!(
        output.status.success(),
        "server-mode health exited {}: {}",
        output.status,
        stderr(&output)
    );
    assert_eq!(stdout(&output).trim(), "ok");
}

#[test]
fn server_mode_sessions_empty() {
    let Some(serve) = serve_bin() else {
        eprintln!("skipping: kimi-server-serve binary not built");
        return;
    };
    let home = temp_dir("server-sessions");
    let output = run(&home, &["--server", serve.to_str().unwrap(), "sessions"]);
    assert!(output.status.success(), "server-mode sessions exited {}", output.status);
    assert_eq!(stdout(&output), "", "no sessions -> no output");
}

#[test]
fn doctor_reports_health_and_config_files() {
    let home = temp_dir("doctor");
    let output = run(&home, &["doctor"]);
    assert!(output.status.success(), "doctor exited {}", output.status);
    let out = stdout(&output);
    assert!(out.contains("Kimi doctor"), "title: {out}");
    assert!(out.contains("health: ok"), "health line: {out}");
    assert!(
        out.contains("OK   config.toml") || out.contains("SKIP config.toml"),
        "config check present: {out}"
    );
    assert!(out.contains("tui.toml"), "tui check present: {out}");
    assert!(
        out.contains("All checked config files are valid."),
        "verdict line: {out}"
    );
}

#[test]
fn doctor_config_validates_specific_file() {
    let home = temp_dir("doctor-config");
    let good = home.join("good.toml");
    std::fs::write(
        &good,
        "[providers.mock]\ntype = \"openai\"\nbaseUrl = \"http://localhost:9999/v1\"\n",
    )
    .expect("write");
    let output = run(&home, &["doctor", "config", good.to_str().unwrap()]);
    assert!(output.status.success(), "good config should pass: {}", stderr(&output));
    assert!(stdout(&output).contains("OK"), "OK line: {}", stdout(&output));

    let bad = home.join("bad.toml");
    std::fs::write(&bad, "[model]\nname = \"x\"\n").expect("write");
    let output = run(&home, &["doctor", "config", bad.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1), "bad config should fail");
    // TS parity: a failing doctor report lands on stderr, never stdout.
    assert!(
        stderr(&output).contains("ERROR"),
        "ERROR line on stderr: {}",
        stderr(&output)
    );
    assert!(
        !stdout(&output).contains("ERROR"),
        "stdout stays clean on failure: {}",
        stdout(&output)
    );

    let output = run(&home, &["doctor", "config", home.join("nope.toml").to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1), "missing file should fail");
    assert!(stderr(&output).contains("File does not exist."));
}

#[test]
fn config_set_writes_and_persists() {
    // --set writes `.kimi-code/config.toml` under the cwd; both invocations
    // must share the cwd (unlike the `run` helper which mints a fresh one).
    let home = temp_dir("config-set");
    let cwd = temp_dir("config-set-cwd");
    let run_here = |args: &[&str]| {
        Command::new(binary())
            .args(args)
            .current_dir(&cwd)
            .env("KIMI_AGENT_HOME", &home)
            .env("KIMI_CODE_HOME", &home)
            .env("HOME", &home)
            .env_remove("KIMI_MODEL")
            .env_remove("KIMI_MODEL_API_KEY")
            .output()
            .expect("spawn kimi")
    };
    let output = run_here(&[
        "config",
        "--set",
        "defaultModel=test-model",
        "--set",
        "providers.mock.apiKey=sk-test",
    ]);
    assert!(output.status.success(), "config --set failed: {}", stderr(&output));
    assert!(stdout(&output).contains("\"ok\": true"), "result: {}", stdout(&output));
    assert!(
        home.join("config.toml").exists(),
        "config file written to the user-level config dir"
    );

    let output = run_here(&["config"]);
    assert!(output.status.success());
    let value: serde_json::Value =
        serde_json::from_str(stdout(&output).trim()).expect("config JSON");
    assert_eq!(value["defaultModel"], "test-model");
    assert_eq!(value["providers"]["mock"]["apiKey"], "sk-test");
}

#[test]
fn bare_invocation_prints_help_and_stage_d_hint() {
    let home = temp_dir("bare");
    let output = run(&home, &[]);
    assert!(output.status.success(), "bare kimi exits 0: {}", output.status);
    let out = stdout(&output);
    assert!(out.contains("Usage:"), "help printed: {out}");
    assert!(
        out.contains("needs a terminal") && out.contains("kimi chat"),
        "non-TTY hint present: {out}"
    );
}

#[test]
fn config_set_rejects_malformed_key() {
    let home = temp_dir("config-set-bad");
    let output = run(&home, &["config", "--set", "no-equals-sign"]);
    assert_eq!(output.status.code(), Some(1), "malformed KEY=VALUE should fail");
    assert!(stderr(&output).contains("KEY=VALUE"), "hint: {}", stderr(&output));
}

#[test]
fn chat_with_closed_stdin_exits_cleanly() {
    // No stdin (output() pipes null) -> the REPL reads EOF and exits without
    // ever touching the LLM.
    let home = temp_dir("chat");
    let output = run(&home, &["chat"]);
    assert!(
        output.status.success(),
        "chat exits 0 on EOF: {} — {}",
        output.status,
        stderr(&output)
    );
}

#[test]
fn every_subcommand_help_renders() {
    let home = temp_dir("help-all");
    for sub in ["print", "sessions", "resume", "config", "doctor", "health", "export", "chat", "acp"] {
        let output = run(&home, &[sub, "--help"]);
        assert!(
            output.status.success(),
            "{sub} --help exits 0: {} — {}",
            output.status,
            stderr(&output)
        );
        assert!(
            !stdout(&output).trim().is_empty(),
            "{sub} --help prints a description"
        );
    }
}

#[test]
fn chat_quit_command_exits() {
    let home = temp_dir("chat-quit");
    let cwd = temp_dir("chat-cwd");
    let mut child = Command::new(binary())
        .args(["chat"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/quit\n").expect("write");
    }
    let status = child.wait().expect("wait");
    assert!(status.success(), "chat /quit exits 0: {status}");
}

#[test]
fn chat_help_then_quit() {
    let home = temp_dir("chat-help");
    let cwd = temp_dir("chat-help-cwd");
    let mut child = Command::new(binary())
        .args(["chat"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/help\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("/resume") && out.contains("/compact"), "help list: {out}");
}

#[test]
fn chat_export_writes_zip() {
    // `kimi chat -s <id>` + `/export` writes <id>.zip in the cwd. The shared
    // store needs KIMI_AGENT_HOME so session/export finds the created session.
    let home = temp_dir("chat-export");
    let cwd = temp_dir("chat-export-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-export"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/export\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("exported to"), "export line: {out}");
    assert!(cwd.join("s-chat-export.zip").exists(), "zip written to cwd");
}

#[test]
fn chat_sessions_lists_persisted() {
    // `kimi chat -s <id>` persists the session at create; `/sessions` lists
    // it. KIMI_AGENT_HOME keeps the store shared within the process.
    let home = temp_dir("chat-sessions");
    let cwd = temp_dir("chat-sessions-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-list"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/sessions\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("s-chat-list"), "session listed: {out}");
}

#[test]
fn chat_session_shows_id_and_renames() {
    // `/session` shows the active session id; `/session set <title>` renames
    // it via session/rename (kimi-server processor).
    let home = temp_dir("chat-session-rename");
    let cwd = temp_dir("chat-session-rename-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-rename-me"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/session\n/session set my title\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("s-rename-me"), "session id shown: {out}");
    assert!(out.contains("my title"), "title shown after rename: {out}");
}

#[test]
fn chat_plugins_empty_home_lists_none() {
    // `/plugins` with an empty home lists no installed plugins (the engine
    // reports an empty array rather than failing).
    let home = temp_dir("chat-plugins");
    let cwd = temp_dir("chat-plugins-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-plugins"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/plugins\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("no plugins installed"), "empty plugins listed: {out}");
}

#[test]
fn acp_initialize_handshake() {
    // `kimi acp` speaks ACP over stdio: initialize -> protocolVersion.
    let home = temp_dir("acp");
    let cwd = temp_dir("acp-cwd");
    let mut child = Command::new(binary())
        .args(["acp"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi acp");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"clientCapabilities\":{}}}\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "kimi acp exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    let line = out.lines().next().expect("a response line");
    let body: serde_json::Value = serde_json::from_str(line).expect("JSON response");
    assert!(body.get("error").is_none(), "initialize: {body}");
    assert!(
        body["result"]["protocolVersion"].as_str().is_some_and(|v| !v.is_empty()),
        "negotiated protocol version: {body}"
    );
}

#[test]
fn chat_goal_lifecycle() {
    // `/goal` is a pure state op (no LLM): create -> status -> cancel.
    let home = temp_dir("chat-goal");
    let cwd = temp_dir("chat-goal-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-goal"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"/goal do the thing\n/goal-pause\n/goal-resume\n/goal-status\n/goal-cancel\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("objective"), "goal create snapshot: {out}");
    assert!(out.contains("goal paused") && out.contains("goal resumed"), "pause/resume: {out}");
    assert!(out.contains("goal cancelled"), "cancel line: {out}");
}

#[test]
fn upgrade_and_frontend_commands_are_recognized() {
    // Stage-C "待" surface: the Rust CLI recognizes TS-owned commands instead
    // of erroring "unknown subcommand". `web` now launches the in-process
    // server (spawned separately below); the live `upgrade` command checks a
    // registry (exercised against a mock in the `upgrade_*` tests below), so
    // here help-level recognition is asserted; `vis` keeps the error.
    let home = temp_dir("recognized");
    let out = run(&home, &["--help"]);
    assert!(out.status.success(), "help exits 0: {}", out.status);
    let text = stdout(&out);
    assert!(text.contains("upgrade"), "help lists upgrade: {text}");
    let out = run(&home, &["migrate"]);
    assert!(out.status.success(), "migrate exits 0: {}", out.status);
    let text = stdout(&out);
    assert!(text.contains("no longer provided"), "migrate hint: {text}");
    let out = run(&home, &["vis"]);
    assert!(!out.status.success(), "vis exits non-zero");
    let err = stderr(&out);
    assert!(err.contains("not bundled"), "vis: {err}");
    // `kimi web --no-open --port <ephemeral>` serves the API: probe /health,
    // then let Ctrl-C-less shutdown via killing the child.
    let mut child = Command::new(binary())
        .args(["web", "--no-open", "--port", "28627"])
        .current_dir(&home)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn kimi web");
    let mut ok = false;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Ok(mut stream) =
            std::net::TcpStream::connect(("127.0.0.1", 28627))
        {
            use std::io::{Read, Write};
            let _ = stream.write_all(
                b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            let mut buf = [0u8; 512];
            let _ = stream.read(&mut buf);
            if String::from_utf8_lossy(&buf).contains("200") {
                ok = true;
                break;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(ok, "kimi web serves /api/v1/health");
}

#[test]
fn print_resume_rejects_cross_directory() {
    // TS `resolvePromptSession` parity: `-S <id>` refuses to resume a
    // session created under a different directory (hint + error on stderr).
    let home = temp_dir("print-session-dir");
    let cwd_a = temp_dir("print-session-dir-a");
    let cwd_b = temp_dir("print-session-dir-b");
    // Seed a session recorded under cwd_a via the chat REPL.
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-cross-dir"])
        .current_dir(&cwd_a)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .env_remove("KIMI_MODEL")
        .env_remove("KIMI_MODEL_API_KEY")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/quit\n").expect("write");
    }
    assert!(child.wait().expect("wait").success(), "chat seeds the session");

    let run_in = |cwd: &Path| {
        Command::new(binary())
            .args(["-p", "hi", "-S", "s-cross-dir"])
            .current_dir(cwd)
            .env("KIMI_AGENT_HOME", &home)
            .env("KIMI_CODE_HOME", &home)
            .env("HOME", &home)
            .env_remove("KIMI_MODEL")
            .env_remove("KIMI_MODEL_API_KEY")
            .output()
            .expect("spawn kimi -p -S")
    };
    // From another directory: rejected before any prompt runs (no LLM needed).
    let output = run_in(&cwd_b);
    assert_eq!(output.status.code(), Some(1), "cross-dir resume rejected");
    let err = stderr(&output);
    assert!(
        err.contains("created under a different directory"),
        "error names the mismatch: {err}"
    );
    assert!(
        err.contains("cd") && err.contains("s-cross-dir"),
        "hint suggests the cd command: {err}"
    );
    // From the recorded directory: the guard passes and the run proceeds to
    // the (LLM-less) engine error — never the directory mismatch.
    let output = run_in(&cwd_a);
    assert_eq!(output.status.code(), Some(1), "LLM-less prompt still fails");
    assert!(
        !stderr(&output).contains("different directory"),
        "same-dir resume must not be rejected: {}",
        stderr(&output)
    );
}

#[test]
fn web_refuses_non_loopback_without_tls_opt_in() {
    // TS `--insecure-no-tls` parity: a non-loopback bind without the opt-in
    // fails fast (serve-binary refusal), instead of binding open.
    let home = temp_dir("web-tls");
    let output = run(
        &home,
        &["web", "--no-open", "--host", "0.0.0.0", "--port", "28628", "--no-insecure-no-tls"],
    );
    assert_eq!(output.status.code(), Some(1), "non-loopback bind refused");
    assert!(
        stderr(&output).contains("refusing to bind"),
        "refusal message: {}",
        stderr(&output)
    );
}

#[test]
fn web_log_level_is_validated_then_rejected() {
    // TS `--log-level` parity: invalid values fail like TS; valid values are
    // not silently ignored — the Rust server has no log-level capability.
    let home = temp_dir("web-loglevel");
    let output = run(&home, &["web", "--no-open", "--log-level", "info", "--port", "28629"]);
    assert_eq!(output.status.code(), Some(1), "valid level rejected clearly");
    assert!(
        stderr(&output).contains("not supported"),
        "clear not-supported error: {}",
        stderr(&output)
    );
    let output = run(&home, &["web", "--no-open", "--log-level", "bogus", "--port", "28629"]);
    assert_eq!(output.status.code(), Some(1), "invalid level rejected");
    assert!(
        stderr(&output).contains("invalid log level"),
        "TS-style invalid-level error: {}",
        stderr(&output)
    );
}

#[test]
fn web_allow_remote_shutdown_route_stops_server() {
    // TS `--allow-remote-shutdown` parity: `POST /api/v1/shutdown` stops the
    // server gracefully on a loopback bind (always allowed there).
    let home = temp_dir("web-shutdown");
    let mut child = Command::new(binary())
        .args(["web", "--no-open", "--port", "28630", "--allow-remote-shutdown", "--dangerous-bypass-auth"])
        .current_dir(&home)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn kimi web");
    let mut healthy = false;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 28630)) {
            use std::io::{Read, Write};
            let _ = stream.write_all(
                b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            let mut buf = [0u8; 512];
            let _ = stream.read(&mut buf);
            if String::from_utf8_lossy(&buf).contains("200") {
                healthy = true;
                break;
            }
        }
    }
    assert!(healthy, "kimi web serves /api/v1/health");
    let _ = std::net::TcpStream::connect(("127.0.0.1", 28630)).map(|mut stream| {
        use std::io::{Read, Write};
        let _ = stream.write_all(
            b"POST /api/v1/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let mut buf = [0u8; 512];
        let _ = stream.read(&mut buf);
    });
    let mut exited = false;
    for _ in 0..40 {
        if child.try_wait().expect("try_wait").is_some() {
            exited = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    if !exited {
        let _ = child.kill();
    }
    let status = child.wait().expect("wait");
    assert!(exited, "shutdown route stopped the server");
    assert!(status.success(), "graceful shutdown exits 0: {status}");
}

/// Serve fixed `latest`-manifest JSON on an ephemeral local listener. The
/// thread answers one request (the upgrade command sends exactly one) and
/// exits; returns the registry URL plus the thread handle.
fn mock_registry(body: &str) -> (String, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock registry");
    let addr = listener.local_addr().expect("mock registry addr");
    let body = body.to_string();
    let handle = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Drain the request line + headers before replying (a plain
            // write-on-accept reply is not reliably consumed by the client).
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (format!("http://{addr}/"), handle)
}

/// `run()` plus a `KIMI_UPGRADE_REGISTRY` override — upgrade tests must
/// never hit the real npm registry.
fn run_with_registry(home: &Path, registry: &str, args: &[&str]) -> Output {
    let n = CWD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let cwd = temp_dir(&format!("cwd{n}"));
    Command::new(binary())
        .args(args)
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", home)
        .env("KIMI_CODE_HOME", home)
        .env("HOME", home)
        .env("KIMI_UPGRADE_REGISTRY", registry)
        .env_remove("KIMI_MODEL")
        .env_remove("KIMI_MODEL_API_KEY")
        .output()
        .expect("spawn kimi")
}

#[test]
fn upgrade_reports_new_version_and_install_command() {
    let home = temp_dir("upgrade-new");
    let (url, server) =
        mock_registry(r#"{"name":"@moonshot-ai/kimi-code","version":"9.9.9"}"#);
    let out = run_with_registry(&home, &url, &["upgrade"]);
    let _ = server.join();
    assert!(out.status.success(), "upgrade exits 0: {}", out.status);
    let text = stdout(&out);
    assert!(text.contains("9.9.9"), "latest version shown: {text}");
    assert!(
        text.contains("npm i -g @moonshot-ai/kimi-code@latest"),
        "install command shown: {text}"
    );
}

#[test]
fn upgrade_reports_up_to_date() {
    let home = temp_dir("upgrade-current");
    // 0.0.0 < the local crate version (0.1.0 in dev/test builds).
    let (url, server) = mock_registry(r#"{"version":"0.0.0"}"#);
    let out = run_with_registry(&home, &url, &["upgrade"]);
    let _ = server.join();
    assert!(out.status.success(), "upgrade exits 0: {}", out.status);
    assert!(stdout(&out).contains("up to date"), "stdout: {}", stdout(&out));
}

#[test]
fn upgrade_suggests_install_command_per_package_manager() {
    // codex CODEX_MANAGED_BY_* parity: the npm wrapper injects a single
    // KIMI_MANAGED_BY_* var; pnpm/bun installs get the matching command.
    // Each invocation gets its own mock registry (one request per server).
    let home = temp_dir("upgrade-manager");

    let run_with_manager = |manager: &str| {
        let (url, server) = mock_registry(r#"{"version":"9.9.9"}"#);
        let n = CWD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cwd = temp_dir(&format!("cwd{n}"));
        let out = Command::new(binary())
            .args(["upgrade"])
            .current_dir(&cwd)
            .env("KIMI_AGENT_HOME", &home)
            .env("KIMI_CODE_HOME", &home)
            .env("HOME", &home)
            .env("KIMI_UPGRADE_REGISTRY", &url)
            .env(format!("KIMI_MANAGED_BY_{manager}"), "1")
            .env_remove("KIMI_MODEL")
            .env_remove("KIMI_MODEL_API_KEY")
            .output()
            .expect("spawn kimi");
        let _ = server.join();
        out
    };

    let pnpm = run_with_manager("PNPM");
    assert!(
        stdout(&pnpm).contains("pnpm add -g @moonshot-ai/kimi-code@latest"),
        "pnpm command: {}",
        stdout(&pnpm)
    );
    let bun = run_with_manager("BUN");
    assert!(
        stdout(&bun).contains("bun install -g @moonshot-ai/kimi-code@latest"),
        "bun command: {}",
        stdout(&bun)
    );
    let npm = run_with_manager("NPM");
    assert!(
        stdout(&npm).contains("npm i -g @moonshot-ai/kimi-code@latest"),
        "npm command: {}",
        stdout(&npm)
    );
}

#[test]
fn upgrade_network_failure_is_friendly() {
    let home = temp_dir("upgrade-fail");
    // Bind an ephemeral port, then drop the listener: the child's request is
    // refused, which must surface as a friendly error — not a panic.
    let dead = std::net::TcpListener::bind("127.0.0.1:0").expect("bind dead port");
    let url = format!("http://{}/", dead.local_addr().unwrap());
    drop(dead);
    let out = run_with_registry(&home, &url, &["upgrade"]);
    assert_eq!(out.status.code(), Some(1), "upgrade exits 1 on failure");
    assert!(
        stderr(&out).contains("upgrade check failed"),
        "friendly error: {}",
        stderr(&out)
    );
}

#[test]
fn print_accepts_model_and_plan_flags() {
    // --model/--plan are accepted and run the create->setup->prompt pipeline
    // (setup semantics are asserted in kimi-exec's unit test); with no LLM
    // configured the prompt itself errors fast.
    let home = temp_dir("print-flags");
    let out = run(&home, &["print", "--plan", "--model", "flag-test-model", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    let err = stderr(&out);
    assert!(err.contains("error"), "stderr: {err}");
}

#[test]
fn print_dash_p_alias_runs_the_print_subcommand() {
    // TS parity: the documented headless form `kimi -p "..."` must resolve to
    // the `print` subcommand (clap matches the plain alias on the first token
    // before option parsing).
    let home = temp_dir("print-dash-p");
    let out = run(&home, &["-p", "--plan", "--model", "flag-test-model", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    let err = stderr(&out);
    assert!(err.contains("error"), "stderr: {err}");
    let out = run(&home, &["-p", ""]);
    assert!(!out.status.success(), "empty prompt must fail");
    assert!(stderr(&out).contains("cannot be empty"), "stderr: {}", stderr(&out));
}

#[test]
fn print_long_prompt_and_attached_value_match_the_subcommand() {
    // TS parity: `kimi --prompt "..."` (documented long form) and the
    // attached `-p<value>` shape both route into the `print` flow.
    let home = temp_dir("print-long-prompt");
    let out = run(&home, &["--prompt", ""]);
    assert!(!out.status.success(), "empty prompt must fail");
    assert!(stderr(&out).contains("cannot be empty"), "stderr: {}", stderr(&out));
    let out = run(&home, &["--prompt", "--model", "flag-test-model", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    assert!(stderr(&out).contains("error"), "stderr: {}", stderr(&out));
    let out = run(&home, &["-phello"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    assert!(stderr(&out).contains("error"), "stderr: {}", stderr(&out));
}

#[test]
fn print_resumes_explicit_session() {
    // TS parity: `-p x -S <id>` (or `print -S <id>`) resumes the named
    // session for the prompt. An unknown id is rejected up front (TS
    // "session not found") — it must NOT be silently created — and a
    // persisted session under the same directory is resumed.
    let home = temp_dir("print-resume-session");
    // Unknown session: rejected before any prompt (no LLM needed).
    let out = run(&home, &["print", "-S", "resume-me", "hi"]);
    assert_eq!(out.status.code(), Some(1), "unknown session rejected");
    assert!(
        stderr(&out).contains("not found"),
        "not-found error: {}",
        stderr(&out)
    );
    let list = run(&home, &["sessions", "--json"]);
    assert!(
        !stdout(&list).contains("resume-me"),
        "unknown session must not be created: {}",
        stdout(&list)
    );

    // Known session (seeded under the same cwd): resume proceeds and the
    // prompt fails only on the missing LLM.
    let cwd = temp_dir("print-resume-session-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "resume-me"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        child.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    assert!(child.wait().expect("wait").success(), "chat seeds the session");
    let out = Command::new(binary())
        .args(["print", "-S", "resume-me", "hi"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .env_remove("KIMI_MODEL")
        .env_remove("KIMI_MODEL_API_KEY")
        .output()
        .expect("spawn kimi print");
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    assert!(
        !stderr(&out).contains("different directory"),
        "same-dir resume must pass the guard: {}",
        stderr(&out)
    );
    let list = run(&home, &["sessions", "--json"]);
    assert!(stdout(&list).contains("resume-me"), "session listed: {}", stdout(&list));
}

#[test]
fn print_continue_resumes_latest_session() {
    // `print --continue` reuses the most recently updated session instead of
    // creating the default kimi-exec session.
    let home = temp_dir("print-continue");
    let cwd = temp_dir("print-continue-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "continue-me"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        child.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    let out = child.wait_with_output().expect("wait");
    assert!(out.status.success(), "chat exits 0: {}", out.status);

    let child = Command::new(binary())
        .args(["print", "--continue", "hi"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .output()
        .expect("spawn kimi print");
    assert!(!child.status.success(), "no LLM -> print errors: {}", child.status);
    let list = run(&home, &["sessions", "--json"]);
    let text = stdout(&list);
    assert!(text.contains("continue-me"), "resumed session listed: {text}");
    assert!(!text.contains("\"id\": \"kimi-exec"), "no fresh session created: {text}");
}

#[test]
fn print_continue_empty_home_falls_back_to_default_session() {
    // No persisted sessions: --continue must fall back to the default
    // kimi-exec session id instead of failing or crashing (the create step
    // is idempotent, so the prompt still runs and errors fast without LLM).
    let home = temp_dir("print-continue-empty");
    let out = run(&home, &["print", "--continue", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    let err = stderr(&out);
    assert!(err.contains("error"), "stderr: {err}");
    let list = run(&home, &["sessions", "--json"]);
    let text = stdout(&list);
    assert!(text.contains("kimi-exec"), "default session id used: {text}");
}

#[test]
fn doctor_tui_validates_specific_file() {
    // `doctor tui <path>` (TS parity): valid TOML + valid field types -> OK;
    // a type error in a known field or a syntax error -> ERROR + exit 1.
    let home = temp_dir("doctor-tui");
    let valid = home.join("tui-valid.toml");
    std::fs::write(
        &valid,
        "theme = \"dark\"\nlocale = \"zh\"\ndisable_paste_burst = true\n[notifications]\nenabled = false\n",
    )
    .expect("write valid");
    let out = run(&home, &["doctor", "tui", valid.to_str().expect("path")]);
    assert!(out.status.success(), "valid tui exits 0: {}", out.status);
    assert!(stdout(&out).contains("OK tui.toml"), "stdout: {}", stdout(&out));

    // Unknown fields are ignored (TS Zod strip), including the old
    // `[theme]`-table shape's accent key when theme is a plain string.
    let unknown = home.join("tui-unknown.toml");
    std::fs::write(&unknown, "theme = \"auto\"\nunknown_key = 123\n").expect("write");
    let out = run(&home, &["doctor", "tui", unknown.to_str().expect("path")]);
    assert!(out.status.success(), "unknown fields are stripped: {}", stderr(&out));

    // Known-field type error (TS `TuiConfigFileSchema`): `theme` must be a
    // string — a `[theme]` table is a type error, not valid config.
    let semantic = home.join("tui-semantic.toml");
    std::fs::write(&semantic, "[theme]\naccent = \"#ff0000\"\n").expect("write semantic");
    let out = run(&home, &["doctor", "tui", semantic.to_str().expect("path")]);
    assert!(!out.status.success(), "semantic error exits 1");
    assert!(
        stderr(&out).contains("field `theme`: expected a string"),
        "stderr names the bad field: {}",
        stderr(&out)
    );

    let locale_bad = home.join("tui-locale.toml");
    std::fs::write(&locale_bad, "locale = \"fr\"\n").expect("write locale");
    let out = run(&home, &["doctor", "tui", locale_bad.to_str().expect("path")]);
    assert!(!out.status.success(), "bad locale exits 1");
    assert!(
        stderr(&out).contains("field `locale`: expected \"en\" or \"zh\""),
        "locale issue: {}",
        stderr(&out)
    );

    let invalid = home.join("tui-invalid.toml");
    std::fs::write(&invalid, "theme = { accent = }\n").expect("write invalid");
    let out = run(&home, &["doctor", "tui", invalid.to_str().expect("path")]);
    assert!(!out.status.success(), "invalid tui exits 1");
    // TS parity: the failing report lands on stderr, not stdout.
    assert!(stderr(&out).contains("ERROR tui.toml"), "stderr: {}", stderr(&out));
    assert!(!stdout(&out).contains("ERROR"), "stdout stays clean: {}", stdout(&out));

    let missing = home.join("tui-missing.toml");
    let out = run(&home, &["doctor", "tui", missing.to_str().expect("path")]);
    assert!(!out.status.success(), "missing tui exits 1");
    assert!(stderr(&out).contains("ERROR tui.toml"), "stderr: {}", stderr(&out));
}

#[test]
fn logout_removes_kimi_provider() {
    // `kimi logout` null-patches the kimi provider out of the engine config
    // (offline-safe; an empty config is a no-op deletion).
    let home = temp_dir("logout");
    let out = run(&home, &["logout"]);
    assert!(out.status.success(), "logout exits 0: {}", out.status);
    assert!(stdout(&out).contains("logged out"), "stdout: {}", stdout(&out));
    // The config file still parses afterwards and has no kimi provider.
    let out = run(&home, &["config"]);
    assert!(out.status.success(), "config after logout: {}", out.status);
    let config: serde_json::Value =
        serde_json::from_str(stdout(&out).trim()).expect("config JSON");
    assert!(
        config["providers"].get("kimi").is_none(),
        "no kimi provider left: {}",
        config["providers"]
    );
}

#[test]
fn config_delete_removes_section_entry() {
    // `--set providers.acme.apiKey=…` then `--delete providers.acme` round
    // trips through the engine's section-scoped null delete.
    let home = temp_dir("config-del");
    let out = run(&home, &["config", "--set", "providers.acme.apiKey=sk-test"]);
    assert!(out.status.success(), "set: {}", out.status);
    let out = run(&home, &["config", "--delete", "providers.acme"]);
    assert!(out.status.success(), "delete: {}", out.status);
    assert!(stdout(&out).contains("\"ok\": true"), "delete result: {}", stdout(&out));
    let out = run(&home, &["config"]);
    let config: serde_json::Value = serde_json::from_str(stdout(&out).trim()).expect("config JSON");
    assert!(
        config["providers"].get("acme").is_none(),
        "provider removed: {}",
        config["providers"]
    );
}

#[test]
fn provider_remove_deletes_config_entry() {
    // `kimi provider remove <id>` null-patches providers.<id> out of the
    // engine config (offline-safe; an absent provider is a no-op deletion).
    let home = temp_dir("provider-remove");
    let out = run(&home, &["config", "--set", "providers.acme.apiKey=sk-test"]);
    assert!(out.status.success(), "set: {}", out.status);
    let out = run(&home, &["provider", "remove", "acme"]);
    assert!(out.status.success(), "remove: {}", out.status);
    assert!(stdout(&out).contains("Removed provider"), "remove output: {}", stdout(&out));
    let out = run(&home, &["config"]);
    let config: serde_json::Value = serde_json::from_str(stdout(&out).trim()).expect("config JSON");
    assert!(
        config["providers"].get("acme").is_none(),
        "provider removed: {}",
        config["providers"]
    );
}

#[test]
fn provider_remove_unknown_provider_errors() {
    // TS parity: removing a provider that is not configured is an error, not
    // a silent no-op.
    let home = temp_dir("provider-remove-unknown");
    let output = run(&home, &["provider", "remove", "nope"]);
    assert!(!output.status.success(), "unknown provider must fail");
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn print_json_and_stream_json_are_mutually_exclusive() {
    let home = temp_dir("print-json-conflict");
    let output = run(
        &home,
        &["print", "--json", "--output-format", "stream-json", "hi"],
    );
    assert!(!output.status.success(), "conflict must fail");
    assert!(
        stderr(&output).contains("mutually exclusive"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn print_rejects_empty_prompt_and_model() {
    let home = temp_dir("print-empty");
    let out = run(&home, &["print", ""]);
    assert!(!out.status.success(), "empty prompt must fail");
    assert!(stderr(&out).contains("cannot be empty"), "stderr: {}", stderr(&out));
    let out = run(&home, &["print", "--model", "", "hi"]);
    assert!(!out.status.success(), "empty model must fail");
    assert!(stderr(&out).contains("cannot be empty"), "stderr: {}", stderr(&out));
}

#[test]
fn print_continue_conflicts_with_session_flag() {
    // TS parity: `--continue` and `-S <id>` are mutually exclusive.
    let home = temp_dir("print-continue-conflict");
    let out = run(&home, &["print", "--continue", "-S", "some-session", "hi"]);
    assert!(!out.status.success(), "conflict must fail");
    assert!(
        stderr(&out).contains("cannot be used with"),
        "stderr: {}",
        stderr(&out)
    );
}

#[test]
fn chat_undo_and_fork_offline() {
    // /undo (empty history errors cleanly) + /fork (creates a new session)
    // are pure state ops — no LLM needed.
    let home = temp_dir("chat-undo-fork");
    let cwd = temp_dir("chat-undo-fork-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-undo-fork"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"/undo\n/fork s-undo-fork-2\n/import some prior context\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("forked to s-undo-fork-2"), "fork line: {out}");
    assert!(out.contains("imported 18 chars"), "import line: {out}");

    // The fork is a persisted session.
    let list = run(&home, &["sessions", "--json"]);
    assert!(stdout(&list).contains("s-undo-fork-2"), "fork listed: {}", stdout(&list));
}

#[test]
fn print_goal_mode_creates_goal() {
    // print --goal runs create -> goal_create -> prompt; the prompt errors
    // without an LLM but the goal persists on the session. The session is
    // seeded under the same cwd first (-S resumes, it does not create).
    let home = temp_dir("print-goal");
    let cwd = temp_dir("print-goal-cwd");
    let mut seed = Command::new(binary())
        .args(["chat", "-s", "goal-test-session"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        seed.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    assert!(seed.wait().expect("wait").success(), "chat seeds the session");

    let out = Command::new(binary())
        .args(["print", "-S", "goal-test-session", "--goal", "do the thing", "hi"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .env_remove("KIMI_MODEL")
        .env_remove("KIMI_MODEL_API_KEY")
        .output()
        .expect("spawn kimi print");
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);

    // The goal is readable back on the same session via chat /goal-status.
    let cwd = temp_dir("print-goal-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "goal-test-session"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/goal-status\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("do the thing"), "goal persisted on session: {out}");
}

#[test]
fn chat_continue_reuses_latest_session() {
    // chat --continue must reuse the most recent session instead of creating
    // a fresh chat-<pid> one.
    let home = temp_dir("chat-continue");
    let cwd = temp_dir("chat-continue-cwd");

    // Seed a session.
    let mut child = Command::new(binary())
        .args(["chat", "-s", "continue-me"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        child.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    assert!(child.wait_with_output().expect("wait").status.success());

    // --continue picks it up; no fresh chat-* session is created.
    let mut child = Command::new(binary())
        .args(["chat", "--continue"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        child.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    assert!(child.wait_with_output().expect("wait").status.success());

    let list = run(&home, &["sessions", "--json"]);
    let text = stdout(&list);
    assert!(text.contains("continue-me"), "seeded session listed: {text}");
    assert!(!text.contains("\"id\": \"chat-"), "no fresh chat session created: {text}");
}

#[test]
fn export_with_session_id_writes_zip() {
    // The success path (explicit session id) was untested — only the error
    // branches were covered.
    let home = temp_dir("export-id");
    let cwd = temp_dir("export-id-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "export-me"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        child.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    assert!(child.wait_with_output().expect("wait").status.success());

    let out = run(&home, &["export", "export-me"]);
    assert!(out.status.success(), "export exits 0: {}", out.status);
    // TS parity: the default zip name is `kimi-debug-<shortId>-<timestamp>.zip`
    // (first 8 id chars) rather than `<id>.zip`.
    let printed = stdout(&out);
    assert!(
        printed.trim().starts_with("kimi-debug-export-m-") && printed.trim().ends_with(".zip"),
        "default zip name: {printed}"
    );
    assert!(!printed.contains("export-me.zip"), "no fixed <id>.zip name: {printed}");
}

#[test]
fn print_add_dir_flag_attaches_before_prompt() {
    // `print --add-dir <dir>` (TS parity): the dirs are attached in the
    // setup step, before the prompt. The prompt itself fails fast without an
    // LLM, but the run must reach it — i.e. the flag is accepted, the session
    // is created and add_dir succeeds before the missing-LLM error surfaces.
    let home = temp_dir("print-add-dir");
    let cwd = temp_dir("print-add-dir-cwd");
    let extra = temp_dir("print-add-dir-extra");
    let out = Command::new(binary())
        .args(["--add-dir", extra.to_str().unwrap(), "-p", "hi"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .env_remove("KIMI_MODEL")
        .env_remove("KIMI_MODEL_API_KEY")
        .output()
        .expect("spawn kimi print");
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    assert!(stderr(&out).contains("error"), "stderr: {}", stderr(&out));
    // The session was created (and the add-dir applied before the prompt
    // failed) — the engine error must not mention the add-dir itself.
    assert!(
        !stderr(&out).contains("add_dir"),
        "add_dir applied before the prompt error: {}",
        stderr(&out)
    );
    let list = run(&home, &["sessions", "--json"]);
    assert!(
        stdout(&list).contains("kimi-exec"),
        "default session created: {}",
        stdout(&list)
    );
}

#[test]
fn export_auto_pick_filters_work_dir_and_confirms_on_eof() {
    // TS parity: auto-picking the previous session filters by the cwd, and a
    // non-TTY stdin EOF confirms the export (default yes) instead of erroring.
    let home = temp_dir("export-workdir");
    let cwd_a = temp_dir("export-workdir-a");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "export-a"])
        .current_dir(&cwd_a)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        child.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    assert!(child.wait_with_output().expect("wait").status.success());

    // From the same directory, no id + no -y: stdin EOF defaults to yes and
    // the most recent session under THIS cwd is exported.
    let out = Command::new(binary())
        .args(["export"])
        .current_dir(&cwd_a)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .output()
        .expect("spawn kimi export");
    assert!(
        out.status.success(),
        "EOF confirm exports: {} — {}",
        out.status,
        stderr(&out)
    );
    assert!(
        stdout(&out).trim().starts_with("kimi-debug-export-a-"),
        "exported the cwd-matching session: {}",
        stdout(&out)
    );

    // From a different directory the session is filtered out: no previous
    // session (TS `listSessions({ workDir })` parity).
    let cwd_b = temp_dir("export-workdir-b");
    let out = Command::new(binary())
        .args(["export", "-y"])
        .current_dir(&cwd_b)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .output()
        .expect("spawn kimi export");
    assert_eq!(out.status.code(), Some(1), "other-dir export finds nothing");
    assert!(
        stderr(&out).contains("No previous session"),
        "stderr explains the filter: {}",
        stderr(&out)
    );
}

#[test]
fn chat_approval_commands_offline_safe() {
    // /approvals + /approve|/deny are pure state ops (no LLM): an empty store
    // lists nothing and unknown ids resolve to "not found" without erroring.
    let home = temp_dir("chat-approvals");
    let cwd = temp_dir("chat-approvals-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-approvals"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"/help\n/approvals\n/approve nope\n/deny nope\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("no pending approvals"), "approvals list: {out}");
    assert!(out.contains("approval not found"), "unknown id resolve: {out}");
    assert!(out.contains("/approvals") && out.contains("/approve"), "help lists commands: {out}");
}

#[test]
fn chat_plan_mode_toggle() {
    // `/plan on` is a pure state op: no LLM, exit 0.
    let home = temp_dir("chat-plan");
    let cwd = temp_dir("chat-plan-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-plan"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"/models\n/plan on\n/plan off\n/swarm on\n/swarm off\n/thinking high\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    // /models is config-driven; it must be handled (no crash) and the rest of
    // the mode controls must report their toggles.
    assert!(out.contains("plan mode on") && out.contains("plan mode off"), "plan toggles: {out}");
    assert!(out.contains("swarm mode on") && out.contains("swarm mode off"), "swarm toggles: {out}");
    assert!(out.contains("thinking effort set to high"), "thinking: {out}");
}

#[test]
fn completions_generate_scripts() {
    let home = temp_dir("completions");
    for shell in ["bash", "zsh", "fish"] {
        let output = run(&home, &["completions", shell]);
        assert!(
            output.status.success(),
            "completions {shell} exits 0: {}",
            output.status
        );
        assert!(
            !stdout(&output).trim().is_empty(),
            "completions {shell} prints a script"
        );
    }
}

#[test]
fn provider_catalog_list_from_catalog() {
    let home = temp_dir("provider");
    // `provider catalog list --json` (the catalog browse surface); `provider
    // list` itself now lists *configured* providers.
    let output = run(&home, &["provider", "catalog", "list", "--json"]);
    // Network-dependent: on success the raw catalog JSON is printed; on a
    // blocked network the command reports the fetch error without panicking.
    if output.status.success() {
        let value: serde_json::Value =
            serde_json::from_str(stdout(&output).trim()).expect("catalog JSON");
        assert!(value.is_object(), "catalog is an object of providers");
    } else {
        assert!(
            stderr(&output).contains("catalog fetch failed"),
            "graceful fetch error: {}",
            stderr(&output)
        );
    }
}

#[test]
fn provider_list_lists_configured_providers() {
    let home = temp_dir("provider-list");
    // Fresh home: no configured providers -> the TS "No providers
    // configured." hint (exit 0).
    let output = run(&home, &["provider", "list"]);
    assert!(output.status.success(), "provider list exits 0: {}", output.status);
    assert_eq!(
        stdout(&output).trim(),
        "No providers configured.",
        "empty hint: {}",
        stdout(&output)
    );
    // A configured provider shows up with TS's `type=`/`models=`/`source=`
    // fields and never leaks the raw apiKey.
    let cfg = home.join("config.toml");
    std::fs::write(
        &cfg,
        "[providers.mock]\ntype = \"openai\"\nbaseUrl = \"http://localhost:9999/v1\"\napiKey = \"sk-test\"\n",
    )
    .expect("write config");
    let output = run(&home, &["provider", "list"]);
    assert!(output.status.success(), "provider list exits 0: {}", output.status);
    let out = stdout(&output);
    assert!(out.contains("mock"), "listed provider: {out}");
    assert!(out.contains("type=openai"), "type field: {out}");
    assert!(out.contains("models=0"), "model count: {out}");
    assert!(out.contains("source=inline"), "source label: {out}");
    assert!(!out.contains("sk-test"), "raw apiKey must not leak: {out}");

    // `--json` emits `{providers, models}` with apiKey stripped entirely
    // (TS parity) rather than masked.
    let output = run(&home, &["provider", "list", "--json"]);
    assert!(output.status.success(), "provider list --json exits 0: {}", output.status);
    let value: serde_json::Value =
        serde_json::from_str(stdout(&output).trim()).expect("provider JSON");
    assert!(value["providers"]["mock"].is_object(), "providers key: {value}");
    assert!(value["providers"]["mock"].get("apiKey").is_none(), "apiKey stripped: {value}");
    assert!(value["models"].is_object(), "models key: {value}");
    assert!(!stdout(&output).contains("sk-test"), "json must not leak: {}", stdout(&output));
}

#[test]
fn server_mode_verbose_emits_events() {
    // `--verbose` over the Remote path: the serve binary fans engine events
    // to stderr (session.turn.started fires before the LLM call, so it lands
    // even when the LLM is unreachable). Read stderr until the event appears,
    // then kill the CLI (its prompt may hang on an offline LLM afterwards).
    let Some(serve) = serve_bin() else {
        eprintln!("skipping: kimi-server-serve binary not built");
        return;
    };
    let home = temp_dir("server-verbose");
    let cwd = temp_dir("cwd");
    let mut child = Command::new(binary())
        .args([
            "--server",
            serve.to_str().unwrap(),
            "print",
            "hello",
            "--verbose",
        ])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .env("HOME", &home)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn kimi");
    let stderr = child.stderr.take().expect("stderr");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut seen = false;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            // The CLI renders engine events into progress lines ("turn 0
            // started (session …)") rather than raw "[event] {json}".
            Ok(line) if line.contains("turn ") && line.contains(" started") => {
                seen = true;
                break;
            }
            Ok(_) => {}
            Err(_) => {}
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(seen, "expected a rendered progress line on stderr");
}

#[test]
fn provider_catalog_add_imports_models_and_sets_default() {
    use std::io::{Read, Write};
    // A one-shot local fixture catalog server (no network dependency).
    let fixture = r#"{
      "acme": {
        "id": "acme",
        "name": "Acme",
        "api": "https://acme.example/v1",
        "env": ["ACME_API_KEY"],
        "models": {
          "acme-1": { "id": "acme-1", "name": "Acme 1", "status": "active",
            "limit": { "context": 128000, "input": 100000, "output": 8192 },
            "tool_call": true, "reasoning": true,
            "modalities": { "input": ["text", "image"], "output": ["text"] },
            "reasoning_options": [{ "type": "effort", "values": ["low", "high", "none"] }] },
          "old": { "id": "old", "name": "Old", "status": "deprecated",
            "limit": { "context": 8000 },
            "modalities": { "input": ["text"], "output": ["text"] } }
        }
      }
    }"#;
    let body = fixture.to_string();
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => panic!("fixture bind: {e}"),
    };
    let addr = listener.local_addr().expect("addr");
    std::thread::spawn(move || {
        match listener.accept() {
            Ok((mut stream, _peer)) => {
                // Consume the request first: dropping a TcpStream with
                // unread data sends RST on Windows, which surfaces in the
                // client as "error sending request".
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
                // Drain until the client closes so the drop never RSTs.
                let mut drain = [0u8; 1024];
                let _ = stream.read(&mut drain);
            }
            Err(e) => eprintln!("fixture: accept error: {e}"),
        }
    });

    let home = temp_dir("provider-add");
    let url = format!("http://{addr}");
    std::thread::sleep(std::time::Duration::from_millis(500));
    let output = run(
        &home,
        &[
            "provider", "catalog", "add", "acme", "--api-key", "sk-test", "--default-model",
            "acme-1", "--url", &url,
        ],
    );
    assert!(output.status.success(), "add: {}", stderr(&output));
    assert!(
        stdout(&output).contains("default model acme/acme-1"),
        "stdout: {}",
        stdout(&output)
    );

    // Read the config back and verify the full import shape.
    let cfg = run(&home, &["config"]);
    assert!(cfg.status.success(), "config: {}", stderr(&cfg));
    let value: serde_json::Value =
        serde_json::from_str(stdout(&cfg).trim()).expect("config JSON");
    assert_eq!(value["providers"]["acme"]["type"], "openai");
    assert_eq!(value["providers"]["acme"]["apiKey"], "sk-test");
    assert_eq!(value["providers"]["acme"]["baseUrl"], "https://acme.example/v1");
    assert_eq!(value["defaultModel"], "acme/acme-1");
    assert_eq!(value["models"]["acme/acme-1"]["model"], "acme-1");
    assert_eq!(value["models"]["acme/acme-1"]["max_tokens"], 128000);
    assert!(
        value["models"].get("acme/old").is_none(),
        "deprecated model must not be imported"
    );
    // Note: the engine has no global `[thinking]` config domain (thinking is
    // session-level); `apply_catalog_provider` still accepts the flag for
    // node-sdk parity, and the engine's serde simply ignores it on merge.
}

#[test]
fn provider_catalog_add_requires_base_url_when_catalog_has_none() {
    use std::io::{Read, Write};
    // A provider with no `api` and a non-official npm needs an explicit
    // base URL (the fallback default would point at the wrong host).
    let fixture = r#"{
      "gateway": {
        "id": "gateway",
        "name": "Gateway",
        "npm": "acme-gateway-sdk",
        "models": {
          "g-1": { "id": "g-1", "name": "G 1", "status": "active",
            "limit": { "context": 64000 },
            "modalities": { "input": ["text"], "output": ["text"] } }
        }
      }
    }"#;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let body = fixture.to_string();
    std::thread::spawn(move || {
        // The test drives two imports against the same fixture.
        for _ in 0..2 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let mut drain = [0u8; 1024];
                let _ = stream.read(&mut drain);
            }
        }
    });
    let url = format!("http://{addr}");

    // Without --base-url the import refuses with a hint (an API key alone is
    // not enough — the catalog entry has no endpoint).
    let home = temp_dir("provider-add-nourl");
    let output = run(
        &home,
        &["provider", "catalog", "add", "gateway", "--api-key", "sk-test", "--url", &url],
    );
    assert!(!output.status.success(), "must refuse: {}", stdout(&output));
    assert!(
        stderr(&output).contains("--base-url"),
        "hint: {}",
        stderr(&output)
    );

    // With --base-url and an API key the import proceeds (provider-only — the
    // gateway entry's model carries no context limit, so no aliases are
    // written). TS parity: catalog add requires an API key (--api-key or
    // KIMI_REGISTRY_API_KEY).
    let home2 = temp_dir("provider-add-url");
    let output = run(
        &home2,
        &[
            "provider", "catalog", "add", "gateway", "--base-url",
            "https://gateway.example/v1", "--url", &url, "--api-key", "sk-test",
        ],
    );
    assert!(output.status.success(), "add: {}", stderr(&output));
    let cfg = run(&home2, &["config"]);
    let value: serde_json::Value =
        serde_json::from_str(stdout(&cfg).trim()).expect("config JSON");
    assert_eq!(value["providers"]["gateway"]["type"], "openai");
    assert_eq!(value["providers"]["gateway"]["baseUrl"], "https://gateway.example/v1");
}

/// One-shot fixture catalog server (no network dependency), mirroring the
/// accept loop used by the provider-add tests above. Serves up to `accepts`
/// requests.
fn fixture_catalog_server(body: &'static str, accepts: usize) -> String {
    use std::io::{Read, Write};
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => panic!("fixture bind: {e}"),
    };
    let addr = listener.local_addr().expect("addr");
    std::thread::spawn(move || {
        for _ in 0..accepts {
            if let Ok((mut stream, _peer)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let mut drain = [0u8; 1024];
                let _ = stream.read(&mut drain);
            }
        }
    });
    std::thread::sleep(std::time::Duration::from_millis(500));
    format!("http://{addr}")
}

#[test]
fn top_level_hidden_aliases_are_accepted() {
    // TS `commands.ts` parity: hidden `-C` (continue) and `--yes` /
    // `--auto-approve` (yolo) parse on the top level — a non-TTY bare
    // invocation prints help + the interactive hint and exits 0.
    let home = temp_dir("hidden-aliases");
    for args in [&["-C"][..], &["--yes"][..], &["--auto-approve"][..]] {
        let out = run(&home, args);
        assert!(out.status.success(), "{args:?} exits 0: {}", out.status);
        assert!(stdout(&out).contains("Usage:"), "{args:?} prints help");
    }
}

#[test]
fn top_level_option_conflicts_are_rejected() {
    // TS `validateOptions` parity for the top-level surface (the `print`
    // subcommand keeps its own clap-level conflicts).
    let home = temp_dir("opts-conflicts");
    let cases: &[(&[&str], &str)] = &[
        (&["-c", "-S", "s1"], "Cannot combine --continue, --session."),
        (&["-C", "-S", "s1"], "Cannot combine --continue, --session."),
        (&["-y", "--auto"], "Cannot combine --yolo with --auto."),
        (&["--yes", "--auto"], "Cannot combine --yolo with --auto."),
        (&["--prompt", "hi", "--plan"], "Cannot combine --prompt with --plan."),
        (&["--prompt", "hi", "-y"], "Cannot combine --prompt with --yolo."),
        (
            &["--output-format", "text"],
            "Output format is only supported in prompt mode.",
        ),
        (&["--model", ""], "Model cannot be empty."),
    ];
    for (args, expected) in cases {
        let out = run(&home, args);
        assert!(!out.status.success(), "{args:?} must fail: {}", out.status);
        assert!(
            stderr(&out).contains(expected),
            "{args:?}: expected {expected:?} in stderr: {}",
            stderr(&out)
        );
    }
}

#[test]
fn print_output_format_env_is_validated() {
    // TS `resolveOutputFormat` parity: KIMI_MODEL_OUTPUT_FORMAT drives the
    // -p output format; an invalid value fails fast before any engine work.
    let home = temp_dir("print-env-fmt");
    let cwd = temp_dir("print-env-fmt-cwd");
    for args in [&["print", "hi"][..], &["--prompt", "hi"]] {
        let out = Command::new(binary())
            .args(args)
            .current_dir(&cwd)
            .env("KIMI_AGENT_HOME", &home)
            .env("KIMI_CODE_HOME", &home)
            .env("HOME", &home)
            .env("KIMI_MODEL_OUTPUT_FORMAT", "nope")
            .output()
            .expect("spawn kimi");
        assert!(!out.status.success(), "{args:?} invalid env must fail");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("Invalid KIMI_MODEL_OUTPUT_FORMAT value \"nope\""),
            "{args:?} stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn web_rotate_token_rewrites_server_token() {
    let home = temp_dir("web-rotate");
    let out = run(&home, &["web", "rotate-token"]);
    assert!(out.status.success(), "rotate-token exits 0: {}", out.status);
    assert!(
        stdout(&out).contains("New server token:"),
        "stdout: {}",
        stdout(&out)
    );
    let token = home.join("server.token");
    assert!(token.exists(), "server.token written");
    let first = std::fs::read_to_string(&token).expect("read token");
    assert!(!first.trim().is_empty(), "token non-empty");
    // Rotation invalidates the previous value.
    let out = run(&home, &["web", "rotate-token"]);
    assert!(out.status.success(), "second rotate exits 0: {}", out.status);
    let second = std::fs::read_to_string(&token).expect("read token");
    assert_ne!(first, second, "token rotated");
}

#[test]
fn server_command_prints_deprecation_notice() {
    // TS `DEPRECATED_SERVER_NOTICE` parity: bare `kimi server` and legacy
    // invocations exit 1 with the notice (not a clap parse error).
    let home = temp_dir("server-deprecated");
    for args in [
        &["server"][..],
        &["server", "kill"][..],
        &["server", "--port", "1234"][..],
    ] {
        let out = run(&home, args);
        assert_eq!(out.status.code(), Some(1), "{args:?} exits 1: {}", out.status);
        assert!(
            stderr(&out).contains("`kimi server` has been deprecated"),
            "{args:?} notice: {}",
            stderr(&out)
        );
    }
}

#[test]
fn provider_catalog_add_requires_api_key() {
    // TS parity: catalog add needs an API key (--api-key or
    // KIMI_REGISTRY_API_KEY), checked before any fetch.
    let home = temp_dir("provider-cat-key");
    let out = run(&home, &["provider", "catalog", "add", "acme"]);
    assert!(!out.status.success(), "must fail without a key");
    assert!(stderr(&out).contains("Missing API key"), "stderr: {}", stderr(&out));
}

#[test]
fn provider_catalog_add_rejects_unknown_default_model() {
    // TS parity: `--default-model` must name an importable model of the
    // provider.
    let fixture = r#"{
      "acme": {
        "id": "acme",
        "name": "Acme",
        "api": "https://acme.example/v1",
        "env": ["ACME_API_KEY"],
        "models": {
          "acme-1": { "id": "acme-1", "name": "Acme 1", "status": "active",
            "limit": { "context": 128000 },
            "modalities": { "input": ["text"], "output": ["text"] } }
        }
      }
    }"#;
    let url = fixture_catalog_server(fixture, 1);
    let home = temp_dir("provider-cat-dm");
    let out = run(
        &home,
        &[
            "provider", "catalog", "add", "acme", "--api-key", "sk-test",
            "--default-model", "nope", "--url", &url,
        ],
    );
    assert!(!out.status.success(), "unknown default model must fail");
    assert!(
        stderr(&out).contains("Model \"nope\" is not in provider \"acme\""),
        "stderr: {}",
        stderr(&out)
    );
}

#[test]
fn provider_catalog_list_no_match_prints_message() {
    // TS parity: an empty filter match prints a message instead of nothing.
    let fixture = r#"{
      "acme": {
        "id": "acme",
        "name": "Acme",
        "api": "https://acme.example/v1",
        "models": { }
      }
    }"#;
    let url = fixture_catalog_server(fixture, 2);
    let home = temp_dir("provider-cat-nomatch");
    let out = run(&home, &["provider", "catalog", "list", "--filter", "zzzz", "--url", &url]);
    assert!(out.status.success(), "no-match exits 0: {}", out.status);
    assert_eq!(stdout(&out).trim(), "No providers in catalog match \"zzzz\".");
    // A drill into an unknown provider exits 1 with the TS message.
    let out = run(&home, &["provider", "catalog", "list", "nope", "--url", &url]);
    assert!(!out.status.success(), "unknown provider must fail");
    assert!(
        stderr(&out).contains("Provider \"nope\" not found in catalog at"),
        "stderr: {}",
        stderr(&out)
    );
}
