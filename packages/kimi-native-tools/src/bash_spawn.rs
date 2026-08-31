//! Managed bash processes — spawn / wait / kill / dispose lifecycle.
//!
//! Implements the `nativeBashSpawn` family: a process is spawned from a full
//! argv (no shell detection — the caller passes the shell as `argv[0]`), its
//! stdout/stderr are streamed to the host as incremental UTF-8 events, and the
//! process tree can be killed on demand or on wall-clock timeout.
//!
//! The napi layer (`napi_bindings.rs`) only adapts the event callback to a
//! ThreadsafeFunction; all logic here is plain Rust so it is unit-testable
//! without a Node runtime.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::bash::kill_process_tree;

/// Interval between exit-status polls.
pub const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Bound on how long the watcher keeps polling after a timeout kill before
/// it gives up and reports `-1` (a failed kill would otherwise spin forever).
const POST_KILL_EXIT_GRACE: Duration = Duration::from_secs(5);
/// Bound on how long the watcher waits for the pipe readers to drain after
/// the child exits, so every output event precedes the `exit` event.
const PIPE_DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BashSpawnEventKind {
    Stdout,
    Stderr,
    Exit,
    /// Reserved for the wire contract; the native side reports spawn failures
    /// by throwing synchronously so the host can fall back, so this variant
    /// is never emitted here.
    #[allow(dead_code)]
    Error,
}

impl BashSpawnEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BashSpawnEventKind::Stdout => "stdout",
            BashSpawnEventKind::Stderr => "stderr",
            BashSpawnEventKind::Exit => "exit",
            BashSpawnEventKind::Error => "error",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BashSpawnEvent {
    pub id: u32,
    pub kind: BashSpawnEventKind,
    pub data: Option<String>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

/// Final exit verdict, cached in the registry when the child settles.
#[derive(Debug, Clone)]
pub struct BashExitOutcome {
    pub exit_code: i32,
    pub timed_out: bool,
    pub error: Option<String>,
}

struct ManagedBash {
    child: Child,
    exit: Option<BashExitOutcome>,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static REGISTRY: once_cell::sync::Lazy<Mutex<HashMap<u32, ManagedBash>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn registry() -> MutexGuard<'static, HashMap<u32, ManagedBash>> {
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn take_registry_entry(id: u32) -> Option<ManagedBash> {
    registry().remove(&id)
}

/// Spawn a process from a full argv (argv[0] is the program, no shell
/// detection), close its stdin, and stream stdout/stderr to `on_event`.
/// Returns `(handle id, pid)`. A spawn failure returns `Err` so the host can
/// fall back to its own spawn path.
pub fn spawn_managed(
    argv: &[String],
    cwd: Option<&str>,
    timeout_ms: Option<i64>,
    env: Option<&[(String, String)]>,
    on_event: Arc<dyn Fn(BashSpawnEvent) + Send + Sync>,
) -> Result<(u32, u32), String> {
    if argv.is_empty() {
        return Err("argv must not be empty".to_string());
    }
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if let Some(env) = env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }
    // Own process group so a timeout/kill takes the whole tree down.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn process: {e}"))?;
    let pid = child.id();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    registry().insert(
        id,
        ManagedBash {
            child,
            exit: None,
        },
    );

    let (stdout_done, stdout_rx) = mpsc_channel();
    let (stderr_done, stderr_rx) = mpsc_channel();
    if let Some(pipe) = stdout_pipe {
        spawn_pipe_reader(pipe, id, BashSpawnEventKind::Stdout, on_event.clone(), stdout_done);
    }
    if let Some(pipe) = stderr_pipe {
        spawn_pipe_reader(pipe, id, BashSpawnEventKind::Stderr, on_event.clone(), stderr_done);
    }

    std::thread::spawn(move || {
        watch_process(id, timeout_ms, on_event, stdout_rx, stderr_rx);
    });

    Ok((id, pid))
}

fn mpsc_channel() -> (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>) {
    std::sync::mpsc::channel()
}

/// Watch the child until it exits (killing the tree on wall-clock timeout),
/// cache the exit outcome for `wait_managed`, then emit the `exit` event
/// after the pipe readers drained (bounded) so output ordering holds.
fn watch_process(
    id: u32,
    timeout_ms: Option<i64>,
    on_event: Arc<dyn Fn(BashSpawnEvent) + Send + Sync>,
    stdout_done: std::sync::mpsc::Receiver<()>,
    stderr_done: std::sync::mpsc::Receiver<()>,
) {
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms.max(0) as u64));
    let mut timed_out = false;
    let mut post_kill_deadline: Option<Instant> = None;
    let outcome = loop {
        let poll = {
            let mut reg = registry();
            match reg.get_mut(&id) {
                Some(entry) => entry.child.try_wait(),
                // Handle disposed while running: the watcher just retires.
                None => return,
            }
        };
        match poll {
            Ok(Some(status)) => {
                break BashExitOutcome {
                    exit_code: status.code().unwrap_or(-1),
                    timed_out,
                    error: None,
                };
            }
            Ok(None) => {}
            Err(e) => {
                kill_managed(id);
                break BashExitOutcome {
                    exit_code: -1,
                    timed_out,
                    error: Some(format!("Process error: {e}")),
                };
            }
        }
        let now = Instant::now();
        if !timed_out {
            if let Some(d) = deadline {
                if now >= d {
                    timed_out = true;
                    kill_managed(id);
                    post_kill_deadline = Some(now + POST_KILL_EXIT_GRACE);
                }
            }
        } else if let Some(kd) = post_kill_deadline {
            if now >= kd {
                break BashExitOutcome {
                    exit_code: -1,
                    timed_out: true,
                    error: Some("process did not exit after kill".to_string()),
                };
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    if let Some(entry) = registry().get_mut(&id) {
        entry.exit = Some(outcome.clone());
    }

    // Give the pipe readers a bounded window so all stdout/stderr events are
    // enqueued before the exit event (a backgrounded grandchild holding the
    // pipe must not hang the exit delivery — same trade-off as bash_exec).
    let drain_deadline = Instant::now() + PIPE_DRAIN_GRACE;
    for rx in [&stdout_done, &stderr_done] {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        let _ = rx.recv_timeout(remaining);
    }

    on_event(BashSpawnEvent {
        id,
        kind: BashSpawnEventKind::Exit,
        data: None,
        exit_code: Some(outcome.exit_code),
        error: outcome.error.clone(),
    });
}

/// Cached exit verdict of a managed process, or `None` while running or when
/// the handle is unknown/disposed.
pub fn exit_snapshot(id: u32) -> Option<BashExitOutcome> {
    let reg = registry();
    reg.get(&id).and_then(|entry| entry.exit.clone())
}

/// Whether a handle is currently registered (spawned, not yet disposed).
pub fn is_managed(id: u32) -> bool {
    registry().contains_key(&id)
}

/// Kill the process tree of a managed process. `false` when the handle is
/// unknown (never spawned, already exited and disposed, or disposed).
pub fn kill_managed(id: u32) -> bool {
    let mut reg = registry();
    match reg.get_mut(&id) {
        Some(entry) => {
            kill_process_tree(&mut entry.child);
            true
        }
        None => false,
    }
}

/// Drop a managed handle, killing the process tree first if it is still
/// running. `false` when the handle is unknown.
pub fn dispose_managed(id: u32) -> bool {
    match take_registry_entry(id) {
        Some(mut entry) => {
            if entry.exit.is_none() {
                kill_process_tree(&mut entry.child);
            }
            true
        }
        None => false,
    }
}

/// Incremental UTF-8 decoder: decodes complete sequences per read chunk and
/// holds back the trailing incomplete sequence, so multi-byte characters are
/// never split across event payloads.
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) => e.valid_up_to(),
        };
        let text = String::from_utf8_lossy(&self.pending[..valid]).to_string();
        self.pending.drain(..valid);
        text
    }

    /// Decode whatever is left (incomplete tail) lossily at end of stream.
    fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        text
    }
}

fn spawn_pipe_reader<R: Read + Send + 'static>(
    reader: R,
    id: u32,
    kind: BashSpawnEventKind,
    on_event: Arc<dyn Fn(BashSpawnEvent) + Send + Sync>,
    done: std::sync::mpsc::Sender<()>,
) {
    std::thread::spawn(move || {
        let mut decoder = Utf8StreamDecoder::new();
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decoder.push(&buf[..n]);
                    if !text.is_empty() {
                        on_event(BashSpawnEvent {
                            id,
                            kind,
                            data: Some(text),
                            exit_code: None,
                            error: None,
                        });
                    }
                }
                Err(_) => break,
            }
        }
        let tail = decoder.finish();
        if !tail.is_empty() {
            on_event(BashSpawnEvent {
                id,
                kind,
                data: Some(tail),
                exit_code: None,
                error: None,
            });
        }
        let _ = done.send(());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn platform_echo_command(text: &str) -> Vec<String> {
        if cfg!(windows) {
            vec!["cmd".to_string(), "/c".to_string(), "echo".to_string(), text.to_string()]
        } else {
            vec!["sh".to_string(), "-c".to_string(), format!("echo {text}")]
        }
    }

    fn platform_sleep_command(seconds: u32) -> Vec<String> {
        if cfg!(windows) {
            // `timeout` refuses redirected stdin; ping is the reliable sleeper.
            vec![
                "cmd".to_string(),
                "/c".to_string(),
                "ping".to_string(),
                "-n".to_string(),
                (seconds + 1).to_string(),
                "127.0.0.1".to_string(),
            ]
        } else {
            vec!["sleep".to_string(), seconds.to_string()]
        }
    }

    /// Collects events into a shared vec and signals when the exit arrives.
    struct EventCollector {
        events: Arc<Mutex<Vec<BashSpawnEvent>>>,
        exit_rx: mpsc::Receiver<()>,
        callback: Arc<dyn Fn(BashSpawnEvent) + Send + Sync>,
    }

    impl EventCollector {
        fn new() -> Self {
            let events = Arc::new(Mutex::new(Vec::new()));
            let (tx, rx) = mpsc::channel();
            let sink = events.clone();
            let callback: Arc<dyn Fn(BashSpawnEvent) + Send + Sync> = Arc::new(move |event| {
                let is_exit = event.kind == BashSpawnEventKind::Exit;
                sink.lock().unwrap().push(event);
                if is_exit {
                    let _ = tx.send(());
                }
            });
            Self {
                events,
                exit_rx: rx,
                callback,
            }
        }

        fn wait_exit(&self, timeout: Duration) -> Vec<BashSpawnEvent> {
            let _ = self.exit_rx.recv_timeout(timeout);
            self.events.lock().unwrap().clone()
        }
    }

    #[test]
    fn test_spawn_rejects_empty_argv() {
        let collector = EventCollector::new();
        assert!(spawn_managed(&[], None, None, None, collector.callback.clone()).is_err());
    }

    #[test]
    fn test_spawn_unknown_handles() {
        assert!(exit_snapshot(9_999_999).is_none());
        assert!(!kill_managed(9_999_999));
        assert!(!dispose_managed(9_999_999));
    }

    #[test]
    fn test_spawn_streams_stdout_and_exit_code() {
        let collector = EventCollector::new();
        let (id, _pid) = spawn_managed(
            &platform_echo_command("hello"),
            None,
            None,
            None,
            collector.callback.clone(),
        )
        .unwrap();

        let events = collector.wait_exit(Duration::from_secs(10));
        let stdout: String = events
            .iter()
            .filter(|e| e.kind == BashSpawnEventKind::Stdout)
            .filter_map(|e| e.data.clone())
            .collect();
        assert!(stdout.contains("hello"), "stdout events: {stdout:?}");
        // All output events precede the exit event in the event list.
        let exit_pos = events
            .iter()
            .position(|e| e.kind == BashSpawnEventKind::Exit)
            .expect("exit event must be emitted");
        assert!(events[..exit_pos]
            .iter()
            .any(|e| e.kind == BashSpawnEventKind::Stdout && e.data.as_deref().unwrap_or("").contains("hello")));

        let exit = events[exit_pos].clone();
        assert_eq!(exit.exit_code, Some(0));

        // wait_managed resolves with the cached outcome.
        let outcome = exit_snapshot(id).expect("exit must be cached");
        assert_eq!(outcome.exit_code, 0);
        assert!(!outcome.timed_out);
        assert!(outcome.error.is_none());

        // Cleanup.
        assert!(dispose_managed(id));
    }

    #[test]
    fn test_spawn_stderr_streaming() {
        let collector = EventCollector::new();
        let argv = if cfg!(windows) {
            vec!["cmd".to_string(), "/c".to_string(), "echo err-out 1>&2".to_string()]
        } else {
            vec!["sh".to_string(), "-c".to_string(), "echo err-out >&2".to_string()]
        };
        let (id, _pid) = spawn_managed(&argv, None, None, None, collector.callback.clone()).unwrap();
        let events = collector.wait_exit(Duration::from_secs(10));
        let stderr: String = events
            .iter()
            .filter(|e| e.kind == BashSpawnEventKind::Stderr)
            .filter_map(|e| e.data.clone())
            .collect();
        assert!(stderr.contains("err-out"), "stderr events: {stderr:?}");
        assert!(dispose_managed(id));
    }

    #[test]
    fn test_spawn_timeout_kills_tree() {
        let collector = EventCollector::new();
        let (id, _pid) = spawn_managed(
            &platform_sleep_command(30),
            None,
            Some(500),
            None,
            collector.callback.clone(),
        )
        .unwrap();

        let events = collector.wait_exit(Duration::from_secs(15));
        let exit = events
            .iter()
            .find(|e| e.kind == BashSpawnEventKind::Exit)
            .expect("exit event must be emitted");
        assert!(exit.exit_code.is_some());
        // Timely kill: the exit event must have arrived well before the 30 s
        // sleep would have ended.
        let outcome = exit_snapshot(id).expect("exit must be cached");
        assert!(outcome.timed_out, "outcome: {outcome:?}");
        assert!(dispose_managed(id));
    }

    #[test]
    fn test_kill_managed_process() {
        let collector = EventCollector::new();
        let (id, _pid) = spawn_managed(
            &platform_sleep_command(30),
            None,
            None,
            None,
            collector.callback.clone(),
        )
        .unwrap();

        std::thread::sleep(Duration::from_millis(200));
        assert!(kill_managed(id));
        let events = collector.wait_exit(Duration::from_secs(10));
        assert!(events
            .iter()
            .any(|e| e.kind == BashSpawnEventKind::Exit && e.exit_code.is_some()));
        assert!(dispose_managed(id));
    }

    #[test]
    fn test_dispose_kills_running_process() {
        let collector = EventCollector::new();
        let (id, _pid) = spawn_managed(
            &platform_sleep_command(30),
            None,
            None,
            None,
            collector.callback.clone(),
        )
        .unwrap();

        std::thread::sleep(Duration::from_millis(200));
        assert!(dispose_managed(id));
        assert!(!dispose_managed(id), "second dispose is a no-op");
        assert!(!kill_managed(id), "handle is gone after dispose");
        // The watcher thread retires without emitting an exit event; give it
        // a moment and make sure nothing panics.
        std::thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn test_spawn_cwd_and_env() {
        let dir = tempfile::tempdir().unwrap();
        let collector = EventCollector::new();
        let argv = if cfg!(windows) {
            vec!["cmd".to_string(), "/c".to_string(), "cd".to_string()]
        } else {
            vec!["pwd".to_string()]
        };
        let env = vec![("KIMI_SPAWN_TEST_VAR".to_string(), "spawn-env-ok".to_string())];
        let (id, _pid) = spawn_managed(
            &argv,
            Some(dir.path().to_str().unwrap()),
            None,
            Some(&env),
            collector.callback.clone(),
        )
        .unwrap();
        let events = collector.wait_exit(Duration::from_secs(10));
        let stdout: String = events
            .iter()
            .filter(|e| e.kind == BashSpawnEventKind::Stdout)
            .filter_map(|e| e.data.clone())
            .collect();
        assert!(!stdout.trim().is_empty(), "cwd output: {stdout:?}");
        let exit = events.iter().find(|e| e.kind == BashSpawnEventKind::Exit).unwrap();
        assert_eq!(exit.exit_code, Some(0));
        assert!(dispose_managed(id));
    }

    #[test]
    fn test_spawn_env_override_visible_to_child() {
        let collector = EventCollector::new();
        let argv = if cfg!(windows) {
            vec!["cmd".to_string(), "/c".to_string(), "echo".to_string(), "%KIMI_SPAWN_TEST_VAR%".to_string()]
        } else {
            vec!["sh".to_string(), "-c".to_string(), "echo $KIMI_SPAWN_TEST_VAR".to_string()]
        };
        let env = vec![("KIMI_SPAWN_TEST_VAR".to_string(), "spawn-env-ok".to_string())];
        let (id, _pid) = spawn_managed(&argv, None, None, Some(&env), collector.callback.clone()).unwrap();
        let events = collector.wait_exit(Duration::from_secs(10));
        let stdout: String = events
            .iter()
            .filter(|e| e.kind == BashSpawnEventKind::Stdout)
            .filter_map(|e| e.data.clone())
            .collect();
        assert!(stdout.contains("spawn-env-ok"), "stdout: {stdout:?}");
        assert!(dispose_managed(id));
    }

    #[test]
    fn test_utf8_decoder_splits_multibyte_across_chunks() {
        let mut decoder = Utf8StreamDecoder::new();
        let bytes = "中文输出".as_bytes();
        // Split inside the first multi-byte sequence.
        let head = decoder.push(&bytes[..2]);
        assert!(head.is_empty(), "incomplete sequence must be held back");
        let rest = decoder.push(&bytes[2..]);
        let combined = format!("{head}{rest}");
        assert_eq!(combined, "中文输出");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn test_utf8_decoder_finish_lossy() {
        let mut decoder = Utf8StreamDecoder::new();
        let head = decoder.push(&[0xe4, 0xb8]); // incomplete 中
        assert!(head.is_empty());
        let tail = decoder.finish();
        assert!(!tail.is_empty(), "incomplete tail is decoded lossily");
    }
}
