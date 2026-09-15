//! Native terminal and process lifecycle manager (P153).
//!
//! Provides in-process shell terminal management adhering to the kap-server
//! `/api/v1/sessions/:id/terminals` REST and WebSocket contract.
//!
//! **Implemented on top of [`portable_pty`] (wezterm).** Each terminal is a
//! real pseudo-terminal: on Windows this is a ConPTY (`conpty.dll` /
//! `kernel32!CreatePseudoConsole`), on Unix a `fork`/`openpty` pty. The child
//! therefore has a controlling terminal, so Ctrl-C, job control, `isatty`
//! tests and full-screen TUI programs behave like a normal terminal.
//!
//! [`TerminalManager::resize`] now forwards the new geometry to the child
//! through the pty: [`portable_pty::MasterPty::resize`] drives
//! `TIOCSWINSZ` (Unix) / `ResizePseudoConsole` (Windows), and the running
//! process is notified and re-lays out its screen.
//!
//! **Windows requirements:** ConPTY needs Windows 10 1809 (build 17763) or
//! newer. On older Windows `native_pty_system()` will fail to load conpty and
//! [`TerminalManager::create`] returns an error.

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{RwLock, mpsc};

use crate::events::EngineEvent;
use crate::server::hub::EventHub;

const DEFAULT_COLS: u32 = 80;
const DEFAULT_ROWS: u32 = 24;
const MAX_BUFFER_FRAMES: usize = 1000;

/// Descriptor representing terminal state conforming to protocol terminalSchema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalDescriptor {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
    pub cols: u32,
    pub rows: u32,
    pub status: String, // "running" | "exited"
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// Managed entry for an active or completed terminal process.
struct TerminalEntry {
    descriptor: TerminalDescriptor,
    stdin_tx: Option<mpsc::Sender<Vec<u8>>>,
    buffer: Vec<String>,
    /// Absolute sequence of the newest buffered frame.
    next_seq: usize,
    /// Frames evicted from the front once `buffer` hit `MAX_BUFFER_FRAMES`.
    /// `next_seq - dropped == buffer.len()`, which is what lets a caller's
    /// absolute `since_seq` be mapped onto a buffer index.
    dropped: usize,
    /// The pty master end. Held so [`TerminalManager::resize`] can deliver a
    /// real window-size change to the child. `MasterPty` is `Send` but not
    /// `Sync`, so it is wrapped in a `Mutex` to keep the entry `Sync` enough
    /// for the shared `RwLock`.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// Cloneable handle used by [`TerminalManager::close`] to terminate the
    /// child independently of the exit-watcher thread that owns the `Child`.
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    /// Process id of the pty child, retained only as a best-effort fallback
    /// for the Windows `taskkill /T` tree kill (see [`TerminalManager::close`]).
    child_pid: Option<u32>,
    /// Set once the child has actually exited; lets the reader thread stop
    /// promptly even if the pty read end does not report EOF immediately.
    dead: Arc<AtomicBool>,
}

/// Central manager orchestrating session-scoped terminals.
#[derive(Clone)]
pub struct TerminalManager {
    entries: Arc<RwLock<HashMap<String, TerminalEntry>>>,
    hub: Arc<EventHub>,
}

impl TerminalManager {
    pub fn new(hub: Arc<EventHub>) -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
            hub,
        }
    }

    /// Determine the platform-appropriate default shell.
    pub fn default_shell() -> String {
        if let Ok(shell) = std::env::var("KIMI_SHELL_PATH")
            && !shell.trim().is_empty()
        {
            return shell.trim().to_string();
        }
        #[cfg(windows)]
        {
            let ps_path = std::path::Path::new(
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            );
            if ps_path.exists() {
                return ps_path.to_string_lossy().to_string();
            }
            "powershell.exe".to_string()
        }
        #[cfg(not(windows))]
        {
            if let Ok(shell) = std::env::var("SHELL")
                && !shell.trim().is_empty()
            {
                return shell.trim().to_string();
            }
            "/bin/sh".to_string()
        }
    }

    /// Create and spawn a new terminal child process inside a real pty.
    pub async fn create(
        &self,
        session_id: &str,
        cwd: &str,
        shell_opt: Option<&str>,
        cols_opt: Option<u32>,
        rows_opt: Option<u32>,
    ) -> Result<TerminalDescriptor, String> {
        let term_id = format!("term_{}", fastrand::u64(..));
        let shell = shell_opt
            .map(|s| s.to_string())
            .unwrap_or_else(Self::default_shell);
        let cols = cols_opt.unwrap_or(DEFAULT_COLS);
        let rows = rows_opt.unwrap_or(DEFAULT_ROWS);
        let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        // Open a native pty with the requested geometry.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows as u16,
                cols: cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open pty for '{shell}': {e}"))?;

        // Build the child command to run inside the pty.
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(Path::new(cwd));
        // Inherit the base environment (computed by portable_pty from the
        // process env / registry); just make sure TERM is set for TUIs.
        cmd.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell '{shell}': {e}"))?;
        let child_pid = child.process_id();
        // A cloneable killer that can signal the process without holding the
        // `Child` (which is handed to the exit-watcher thread below).
        let killer = child.clone_killer();

        // Take the master's writer (stdin) and a readable clone (stdout/stderr
        // are merged into the single pty stream).
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take pty writer: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to take pty reader: {e}"))?;
        // Keep the master so resize() can reconfigure the window later.
        let master: Box<dyn MasterPty + Send> = pair.master;

        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(128);

        let descriptor = TerminalDescriptor {
            id: term_id.clone(),
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            shell,
            cols,
            rows,
            status: "running".to_string(),
            created_at,
            exited_at: None,
            exit_code: None,
        };

        let dead = Arc::new(AtomicBool::new(false));

        let entry = TerminalEntry {
            descriptor: descriptor.clone(),
            stdin_tx: Some(stdin_tx),
            buffer: Vec::new(),
            next_seq: 0,
            dropped: 0,
            master: Mutex::new(Some(master)),
            killer: Mutex::new(Some(killer)),
            child_pid,
            dead: dead.clone(),
        };

        {
            let mut lock = self.entries.write().await;
            lock.insert(term_id.clone(), entry);
        }

        // --- Stdin forwarder thread -------------------------------------------
        // Consumes the mpsc channel and writes into the pty master. Dropping
        // the writer (when the channel closes on close/kill) sends EOF to the
        // child, so this thread ends naturally once no more input is expected.
        {
            let mut writer = writer;
            let mut stdin_rx = stdin_rx;
            std::thread::spawn(move || {
                while let Some(bytes) = stdin_rx.blocking_recv() {
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                        break;
                    }
                }
                // `writer` is dropped here, signalling EOF to the child's stdin.
            });
        }

        // --- Output reader thread ---------------------------------------------
        // Reads the merged pty output stream and appends each chunk to the
        // ring buffer, broadcasting it on the session bus. Exits when the child
        // closes the pty (EOF) or when `dead` flips, so it never leaks.
        {
            let entries_out = self.entries.clone();
            let hub_out = self.hub.clone();
            let tid = term_id.clone();
            let sid = session_id.to_string();
            let dead_out = dead.clone();
            let mut reader = reader;
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    if dead_out.load(Ordering::SeqCst) {
                        break;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => break, // child closed the pty: EOF
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let out_seq = {
                                let mut lock = entries_out.blocking_write();
                                if let Some(e) = lock.get_mut(&tid) {
                                    e.next_seq += 1;
                                    let seq = e.next_seq;
                                    if e.buffer.len() >= MAX_BUFFER_FRAMES {
                                        e.buffer.remove(0);
                                        e.dropped += 1;
                                    }
                                    e.buffer.push(text.clone());
                                    seq
                                } else {
                                    0
                                }
                            };
                            // Contract frame shape (ws-control.ts:418-428):
                            // {type: "terminal_output", seq, session_id,
                            //  terminal_id, timestamp, payload:{data}}.
                            let out_event = json!({
                                "type": "terminal_output",
                                "session_id": sid,
                                "terminal_id": tid,
                                "seq": out_seq,
                                "data": text,
                            });
                            hub_out
                                .bus_for(&sid)
                                .publish(&EngineEvent::Custom(out_event));
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // --- Process exit watcher thread --------------------------------------
        // Owns the `Child` so its blocking `wait()` runs off the async runtime.
        // On exit it records the status and broadcasts `terminal_exit`.
        {
            let entries_exit = self.entries.clone();
            let hub_exit = self.hub.clone();
            let tid = term_id.clone();
            let sid = session_id.to_string();
            let dead_exit = dead.clone();
            std::thread::spawn(move || {
                let status = child.wait();
                let exit_code = status.ok().map(|s| s.exit_code() as i32);
                dead_exit.store(true, Ordering::SeqCst);
                let exited_at =
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

                {
                    let mut lock = entries_exit.blocking_write();
                    if let Some(e) = lock.get_mut(&tid) {
                        e.descriptor.status = "exited".to_string();
                        e.descriptor.exited_at = Some(exited_at.clone());
                        e.descriptor.exit_code = exit_code;
                        e.stdin_tx = None;
                    }
                }

                // Contract frame shape (ws-control.ts:433-441): payload.exit_code.
                let exit_event = json!({
                    "type": "terminal_exit",
                    "session_id": sid,
                    "terminal_id": tid,
                    "payload": { "exit_code": exit_code },
                });
                hub_exit
                    .bus_for(&sid)
                    .publish(&EngineEvent::Custom(exit_event));
            });
        }

        Ok(descriptor)
    }

    /// List all terminals for a session.
    pub async fn list(&self, session_id: &str) -> Vec<TerminalDescriptor> {
        let lock = self.entries.read().await;
        lock.values()
            .filter(|e| e.descriptor.session_id == session_id)
            .map(|e| e.descriptor.clone())
            .collect()
    }

    /// Get a terminal by ID for a session.
    pub async fn get(&self, session_id: &str, terminal_id: &str) -> Option<TerminalDescriptor> {
        let lock = self.entries.read().await;
        let entry = lock.get(terminal_id)?;
        if entry.descriptor.session_id == session_id {
            Some(entry.descriptor.clone())
        } else {
            None
        }
    }

    /// Send input bytes to terminal stdin.
    pub async fn write(
        &self,
        session_id: &str,
        terminal_id: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let lock = self.entries.read().await;
        let entry = lock
            .get(terminal_id)
            .ok_or_else(|| "Terminal not found".to_string())?;
        if entry.descriptor.session_id != session_id {
            return Err("Terminal not found in session".to_string());
        }
        if let Some(ref tx) = entry.stdin_tx {
            tx.send(data.to_vec())
                .await
                .map_err(|e| format!("Failed to send input: {e}"))?;
            Ok(())
        } else {
            Err("Terminal is not running".to_string())
        }
    }

    /// Resize terminal geometry (cols, rows).
    ///
    /// Unlike the old piped implementation, this now delivers the new window
    /// size to the running child through the pty: [`portable_pty::MasterPty::resize`]
    /// performs `TIOCSWINSZ` (Unix) / `ResizePseudoConsole` (Windows), and the
    /// child receives `SIGWINCH` / a console resize event and re-lays out.
    pub async fn resize(
        &self,
        session_id: &str,
        terminal_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        let mut lock = self.entries.write().await;
        let entry = lock
            .get_mut(terminal_id)
            .ok_or_else(|| "Terminal not found".to_string())?;
        if entry.descriptor.session_id != session_id {
            return Err("Terminal not found in session".to_string());
        }
        // Best-effort: forward the real resize to the child. If the pty is
        // already gone we still record the requested geometry on the descriptor.
        if let Some(ref mut master) = *entry.master.lock().unwrap() {
            let _ = master.resize(PtySize {
                rows: rows as u16,
                cols: cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        entry.descriptor.cols = cols;
        entry.descriptor.rows = rows;
        Ok(())
    }

    /// Close and kill a terminal process.
    pub async fn close(&self, session_id: &str, terminal_id: &str) -> Result<(), String> {
        let mut lock = self.entries.write().await;
        let entry = lock
            .get_mut(terminal_id)
            .ok_or_else(|| "Terminal not found".to_string())?;
        if entry.descriptor.session_id != session_id {
            return Err("Terminal not found in session".to_string());
        }
        if entry.descriptor.status == "running" {
            entry.descriptor.status = "exited".to_string();
            entry.descriptor.exited_at =
                Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            // Drop the stdin sender: the forwarder thread's channel closes and
            // it exits, dropping the master writer (EOF to the child's stdin).
            entry.stdin_tx = None;

            // Terminate the child via portable-pty's killer (TerminateProcess on
            // Windows, SIGHUP+kill on Unix). Dropping the writer already sent
            // stdin EOF; this guarantees the process tree is reaped.
            let killer = entry.killer.lock().unwrap().take();
            let pid = entry.child_pid;
            // Flip the `dead` flag so the reader thread stops even if its read
            // end does not observe EOF promptly after the kill.
            entry.dead.store(true, Ordering::SeqCst);
            drop(lock);

            if let Some(mut k) = killer {
                let _ = k.kill();
            }
            // Windows fallback: ConPTY's TerminateProcess cascades to the
            // conhost, but a stubborn child tree (e.g. a shell that spawned
            // grandchildren) is cleaned up by a tree kill. Best-effort only.
            #[cfg(windows)]
            if let Some(pid) = pid {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output();
            }
        }
        Ok(())
    }

    /// Retrieve recorded terminal buffer frames.
    ///
    /// `since_seq` is an absolute frame sequence, but `buffer` only retains the
    /// newest `MAX_BUFFER_FRAMES` frames — after the first eviction the absolute
    /// sequence and the buffer index diverge. Slicing by absolute sequence
    /// therefore returned the wrong frames (and, in the WebSocket replay path,
    /// mislabelled every replayed frame's `seq`).
    ///
    /// Returns the requested frames plus the absolute sequence of the newest
    /// buffered frame, which is what a client resumes from.
    pub async fn output(
        &self,
        session_id: &str,
        terminal_id: &str,
        since_seq: usize,
    ) -> Result<(Vec<String>, usize), String> {
        let lock = self.entries.read().await;
        let entry = lock
            .get(terminal_id)
            .ok_or_else(|| "Terminal not found".to_string())?;
        if entry.descriptor.session_id != session_id {
            return Err("Terminal not found in session".to_string());
        }
        // Frames `1..=dropped` are gone; buffer[i] is absolute sequence
        // `dropped + i + 1`. Ask for everything strictly after `since_seq`.
        let start = since_seq.saturating_sub(entry.dropped);
        let start = start.min(entry.buffer.len());
        Ok((entry.buffer[start..].to_vec(), entry.next_seq))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_terminal_manager_lifecycle() {
        let hub = Arc::new(EventHub::new());
        let mgr = TerminalManager::new(hub);
        let temp_dir = tempfile::tempdir().unwrap();
        let cwd = temp_dir.path().to_string_lossy().to_string();

        // 1. Create terminal
        let desc = mgr
            .create("sess-1", &cwd, None, Some(80), Some(24))
            .await
            .unwrap();
        assert_eq!(desc.session_id, "sess-1");
        assert_eq!(desc.status, "running");
        assert_eq!(desc.cols, 80);
        assert_eq!(desc.rows, 24);
        assert!(desc.id.starts_with("term_"));

        // 2. List terminals
        let list = mgr.list("sess-1").await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, desc.id);

        // List for different session is empty
        assert!(mgr.list("sess-other").await.is_empty());

        // 3. Get terminal
        let fetched = mgr.get("sess-1", &desc.id).await.unwrap();
        assert_eq!(fetched.id, desc.id);

        // Get non-existent terminal returns None
        assert!(mgr.get("sess-1", "term_none").await.is_none());
        // Get with mismatched session returns None
        assert!(mgr.get("sess-wrong", &desc.id).await.is_none());

        // 4. Resize — now delivered to the real pty, not just the descriptor.
        mgr.resize("sess-1", &desc.id, 120, 30).await.unwrap();
        let resized = mgr.get("sess-1", &desc.id).await.unwrap();
        assert_eq!(resized.cols, 120);
        assert_eq!(resized.rows, 30);

        // Resize non-existent returns error
        assert_eq!(
            mgr.resize("sess-1", "term_none", 100, 20)
                .await
                .unwrap_err(),
            "Terminal not found"
        );

        // 5. Write input
        mgr.write("sess-1", &desc.id, b"echo test\n")
            .await
            .expect("terminal write must succeed");

        // 6. Terminal output
        let (frames, total) = mgr
            .output("sess-1", &desc.id, 0)
            .await
            .expect("output query succeeds");
        assert!(total >= frames.len());

        // Query beyond total frames returns empty slice
        let (empty_frames, total2) = mgr.output("sess-1", &desc.id, 100_000).await.unwrap();
        assert!(empty_frames.is_empty());
        assert_eq!(total, total2);

        // Output with invalid terminal or session returns error
        assert!(mgr.output("sess-1", "term_none", 0).await.is_err());
        assert!(mgr.output("sess-wrong", &desc.id, 0).await.is_err());

        // 7. Close terminal
        mgr.close("sess-1", &desc.id).await.unwrap();
        let closed = mgr.get("sess-1", &desc.id).await.unwrap();
        assert_eq!(closed.status, "exited");
        assert!(closed.exited_at.is_some());

        // Writing to exited terminal must fail
        assert_eq!(
            mgr.write("sess-1", &desc.id, b"ls\n").await.unwrap_err(),
            "Terminal is not running"
        );
    }

    #[test]
    fn test_terminal_default_shell_resolution() {
        let shell = TerminalManager::default_shell();
        assert!(!shell.trim().is_empty());
        #[cfg(windows)]
        {
            assert!(
                shell.ends_with(".exe")
                    || shell.contains("powershell")
                    || shell.contains("cmd")
                    || shell.contains("bash")
            );
        }
    }
}
