/// Bash tool — asynchronous process lifecycle (spawn / stream / wait / kill).
///
/// Extends `bash.rs`'s one-shot `bash_exec` with a handle-based API that lets
/// the TS side stream stdout/stderr as it is produced and kill the process
/// tree on demand — the semantics the Bash tool needs for foreground output,
/// timeouts, and user interrupts.
///
/// Lifecycle:
///   - `native_bash_spawn` starts the shell and returns `{ id, pid }`;
///     stdout/stderr are forwarded to the JS callback as `stdout`/`stderr`
///     events via a ThreadsafeFunction, and the process exits with an `exit`
///     event carrying the exit code.
///   - `native_bash_wait` resolves with the cached exit result.
///   - `native_bash_kill` takes the whole process tree down (same
///     `kill_process_tree` as `bash_exec`).
///   - `native_bash_dispose` drops the handle.
///
/// Stdin is closed at spawn (the Bash tool never writes to stdin; it only
/// ends it, which is equivalent to EOF).
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{JsFunction, Result};
use napi_derive::napi;
use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::bash::kill_process_tree;

/// Incremental UTF-8 decoder that carries an incomplete trailing sequence
/// over to the next read. Each 8 KB pipe read used to be decoded
/// independently, so a multi-byte character straddling two reads became
/// U+FFFD — garbling Chinese output and any JSON/tool payload parsed from
/// the stream.
struct Utf8DecodingBuffer {
    pending: Vec<u8>,
}

impl Utf8DecodingBuffer {
    fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// Feed the next raw chunk; returns the text it completes. A truncated
    /// sequence at the end is kept for the next call.
    fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        match std::str::from_utf8(&self.pending) {
            Ok(valid) => {
                out.push_str(valid);
                self.pending.clear();
            }
            Err(e) => {
                let valid_up_to = e.valid_up_to();
                if valid_up_to > 0 {
                    out.push_str(std::str::from_utf8(&self.pending[..valid_up_to]).unwrap());
                }
                match e.error_len() {
                    // Truncated at the end — the lead may complete on a later
                    // read, so keep it pending.
                    None => {
                        self.pending.drain(..valid_up_to);
                    }
                    // A genuine invalid sequence: replace it and keep whatever
                    // valid start may follow it.
                    Some(len) => {
                        self.pending.drain(..valid_up_to + len);
                        out.push('\u{FFFD}');
                    }
                }
            }
        }
        out
    }

    /// EOF: emit any never-completed tail lossy, matching one-shot decoding.
    fn flush(self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        String::from_utf8_lossy(&self.pending).to_string()
    }
}

/// Registry of live managed processes, keyed by the handle id.
static PROCESS_TABLE: OnceLock<Mutex<HashMap<i64, ManagedBash>>> = OnceLock::new();
static NEXT_ID: AtomicI64 = AtomicI64::new(1);

/// A managed process: the child (shared so `kill` can reach it while the
/// waiter thread polls) and the cached exit result that `wait` consumes.
struct ManagedBash {
    child: Arc<Mutex<Child>>,
    /// Set by the waiter thread when the process exits; `wait` blocks on it.
    exit_result: Arc<(Mutex<Option<NativeBashExit>>, Condvar)>,
}

fn table() -> &'static Mutex<HashMap<i64, ManagedBash>> {
    PROCESS_TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[napi(object)]
pub struct NativeSpawnConfig {
    /// Full command line: shell executable + flags + script (the Bash tool
    /// already wraps cwd and shell semantics; no shell detection here).
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    /// Wall-clock timeout in milliseconds; `None` = no timeout.
    pub timeout_ms: Option<u32>,
    pub env: Option<Vec<Vec<String>>>,
}

#[napi(object)]
pub struct NativeSpawnResult {
    pub id: i64,
    pub pid: i32,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeBashExit {
    pub exit_code: i32,
    pub timed_out: bool,
    pub error: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeBashEvent {
    /// Handle id of the emitting process (`0` for a spawn failure).
    pub id: i64,
    /// `"stdout"` | `"stderr"` | `"exit"` | `"error"`.
    pub kind: String,
    /// Chunk of output (stdout/stderr events).
    pub data: Option<String>,
    /// Exit code (exit events).
    pub exit_code: Option<i32>,
    /// Error description (error events).
    pub error: Option<String>,
}

/// Spawn a shell command and stream its output to `on_event`.
///
/// The callback receives `(err, event)`; `event.kind` is `"stdout"` /
/// `"stderr"` while the process runs, then `"exit"` with the exit code, or
/// `"error"` for spawn/IO failures. Stdin is closed at spawn.
#[napi]
pub fn native_bash_spawn(
    config: NativeSpawnConfig,
    on_event: JsFunction,
) -> Result<NativeSpawnResult> {
    let tsfn: ThreadsafeFunction<NativeBashEvent> =
        on_event.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

    if config.argv.is_empty() {
        return Err(napi::Error::from_reason(
            "native_bash_spawn: argv must contain at least the shell executable",
        ));
    }

    let mut cmd = Command::new(&config.argv[0]);
    cmd.args(&config.argv[1..]);

    if let Some(ref cwd) = config.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Non-interactive environment, mirroring `bash_exec` and the TS BashTool.
    cmd.env("NO_COLOR", "1");
    cmd.env("TERM", "dumb");
    cmd.env("SHELL", &config.argv[0]);
    if std::env::var("GIT_TERMINAL_PROMPT").is_err() {
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    if let Some(ref env) = config.env {
        for (key, value) in env.iter().filter_map(|pair| {
            if pair.len() >= 2 {
                Some((pair[0].as_str(), pair[1].as_str()))
            } else {
                None
            }
        }) {
            cmd.env(key, value);
        }
    }

    // Own process group so a kill can take the whole tree down.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = tsfn.call(
                Ok(NativeBashEvent {
                    id: 0,
                    kind: "error".to_string(),
                    data: None,
                    exit_code: None,
                    error: Some(format!("Failed to spawn process: {e}")),
                }),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
            return Err(napi::Error::from_reason(format!(
                "Failed to spawn process: {e}"
            )));
        }
    };

    let pid = child.id() as i32;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    let exit_result: Arc<(Mutex<Option<NativeBashExit>>, Condvar)> =
        Arc::new((Mutex::new(None), Condvar::new()));

    // Reader threads: forward chunks to JS as they arrive.
    if let Some(pipe) = stdout_pipe {
        let tsfn = tsfn.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buf = vec![0u8; 8192];
            let mut decoder = Utf8DecodingBuffer::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = decoder.push(&buf[..n]);
                        if data.is_empty() {
                            continue;
                        }
                        let _ = tsfn.call(
                            Ok(NativeBashEvent {
                                id,
                                kind: "stdout".to_string(),
                                data: Some(data),
                                exit_code: None,
                                error: None,
                            }),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    Err(_) => break,
                }
            }
            let tail = decoder.flush();
            if !tail.is_empty() {
                let _ = tsfn.call(
                    Ok(NativeBashEvent {
                        id,
                        kind: "stdout".to_string(),
                        data: Some(tail),
                        exit_code: None,
                        error: None,
                    }),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        });
    }
    if let Some(pipe) = stderr_pipe {
        let tsfn = tsfn.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buf = vec![0u8; 8192];
            let mut decoder = Utf8DecodingBuffer::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = decoder.push(&buf[..n]);
                        if data.is_empty() {
                            continue;
                        }
                        let _ = tsfn.call(
                            Ok(NativeBashEvent {
                                id,
                                kind: "stderr".to_string(),
                                data: Some(data),
                                exit_code: None,
                                error: None,
                            }),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    Err(_) => break,
                }
            }
            let tail = decoder.flush();
            if !tail.is_empty() {
                let _ = tsfn.call(
                    Ok(NativeBashEvent {
                        id,
                        kind: "stderr".to_string(),
                        data: Some(tail),
                        exit_code: None,
                        error: None,
                    }),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        });
    }

    // Waiter thread: poll exit with a deadline, kill the tree on timeout,
    // then cache the result for `wait` and emit the exit event.
    let wait_child = child.clone();
    let wait_exit = exit_result.clone();
    std::thread::spawn(move || {
        let deadline = config
            .timeout_ms
            .map(|ms| Instant::now() + Duration::from_millis(ms as u64));
        let mut timed_out = false;

        let exit_code = loop {
            let status = {
                let mut guard = match wait_child.lock() {
                    Ok(g) => g,
                    Err(_) => break -1,
                };
                guard.try_wait()
            };
            match status {
                Ok(Some(s)) => break s.code().unwrap_or(-1),
                Ok(None) => {
                    if let Some(d) = deadline {
                        if Instant::now() >= d {
                            let mut guard = match wait_child.lock() {
                                Ok(g) => g,
                                Err(_) => break -1,
                            };
                            kill_process_tree(&mut guard);
                            timed_out = true;
                            break -1;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    let result = NativeBashExit {
                        exit_code: -1,
                        timed_out: false,
                        error: Some(format!("Process error: {e}")),
                    };
                    {
                        let (lock, cvar) = &*wait_exit;
                        let mut guard = lock.lock().unwrap();
                        *guard = Some(result.clone());
                        cvar.notify_all();
                    }
                    let _ = tsfn.call(
                        Ok(NativeBashEvent {
                            id,
                            kind: "error".to_string(),
                            data: None,
                            exit_code: None,
                            error: result.error.clone(),
                        }),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    return;
                }
            }
        };

        let result = NativeBashExit {
            exit_code,
            timed_out,
            error: None,
        };
        {
            let (lock, cvar) = &*wait_exit;
            let mut guard = lock.lock().unwrap();
            *guard = Some(result.clone());
            cvar.notify_all();
        }
        let _ = tsfn.call(
            Ok(NativeBashEvent {
                id,
                kind: "exit".to_string(),
                data: None,
                exit_code: Some(exit_code),
                error: None,
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });

    table()
        .lock()
        .unwrap()
        .insert(id, ManagedBash { child, exit_result });

    Ok(NativeSpawnResult { id, pid })
}

/// Resolve with the cached exit result of a managed process.
#[napi]
pub async fn native_bash_wait(id: i64) -> Result<NativeBashExit> {
    let exit_result = {
        let guard = table().lock().unwrap();
        guard.get(&id).map(|m| m.exit_result.clone())
    };
    let Some(exit_result) = exit_result else {
        return Err(napi::Error::from_reason(format!(
            "Unknown bash process handle: {id}"
        )));
    };
    let result = tokio::task::spawn_blocking(move || {
        let (lock, cvar) = &*exit_result;
        let mut guard = lock.lock().unwrap();
        while guard.is_none() {
            guard = cvar.wait(guard).unwrap();
        }
        guard.clone().unwrap()
    })
    .await
    .map_err(|e| napi::Error::from_reason(format!("wait task failed: {e}")))?;
    Ok(result)
}

/// Kill a managed process tree. Returns false when the handle is unknown.
#[napi]
pub fn native_bash_kill(id: i64) -> bool {
    let mut guard = table().lock().unwrap();
    match guard.get_mut(&id) {
        Some(m) => {
            let mut child = match m.child.lock() {
                Ok(c) => c,
                Err(_) => return false,
            };
            kill_process_tree(&mut child);
            true
        }
        None => false,
    }
}

/// Drop a managed process handle. Returns false when the handle is unknown.
#[napi]
pub fn native_bash_dispose(id: i64) -> bool {
    let mut guard = table().lock().unwrap();
    match guard.remove(&id) {
        Some(m) => {
            let mut child = match m.child.lock() {
                Ok(c) => c,
                Err(_) => return true,
            };
            // Best effort: if the process is still running, take it down.
            if child.try_wait().ok().flatten().is_none() {
                kill_process_tree(&mut child);
            }
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_with_chunk_size(s: &str, chunk_size: usize) -> String {
        let bytes = s.as_bytes();
        let mut d = Utf8DecodingBuffer::new();
        let mut acc = String::new();
        for chunk in bytes.chunks(chunk_size) {
            acc.push_str(&d.push(chunk));
        }
        acc.push_str(&d.flush());
        acc
    }

    #[test]
    fn test_utf8_decoder_ascii() {
        assert_eq!(decode_with_chunk_size("hello world", 4), "hello world");
    }

    #[test]
    fn test_utf8_decoder_cjk_chunk_boundary() {
        // 3-byte chars cut into arbitrary pieces must reassemble exactly.
        let s = "中文输出测试".repeat(500);
        for chunk_size in 1..=4 {
            assert_eq!(decode_with_chunk_size(&s, chunk_size), s, "chunk {chunk_size}");
        }
    }

    #[test]
    fn test_utf8_decoder_mixed_chunk_boundary() {
        let s = "a中b文c".repeat(1000);
        for chunk_size in 1..=5 {
            assert_eq!(decode_with_chunk_size(&s, chunk_size), s, "chunk {chunk_size}");
        }
    }

    #[test]
    fn test_utf8_decoder_single_push() {
        let mut d = Utf8DecodingBuffer::new();
        assert_eq!(d.push("中文".as_bytes()), "中文");
        assert!(d.flush().is_empty());
    }

    #[test]
    fn test_utf8_decoder_truncated_tail_flushed_lossy() {
        // A genuinely truncated final sequence degrades to U+FFFD on EOF,
        // matching one-shot from_utf8_lossy semantics.
        let mut d = Utf8DecodingBuffer::new();
        assert_eq!(d.push(b"ok\xff\xfe"), "ok\u{FFFD}");
        assert_eq!(d.flush(), "\u{FFFD}");
    }

    #[test]
    fn test_utf8_decoder_leading_truncated_completes_next_chunk() {
        let mut d = Utf8DecodingBuffer::new();
        let bytes = "中".as_bytes(); // E4 B8 AD
        assert!(d.push(&bytes[..1]).is_empty());
        assert_eq!(d.push(&bytes[1..]), "中");
        assert!(d.flush().is_empty());
    }
}
