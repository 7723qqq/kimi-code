//! Native pseudo-terminal and process lifecycle manager (P153).
//!
//! Provides in-process shell terminal management adhering to the kap-server
//! `/api/v1/sessions/:id/terminals` REST and WebSocket contract.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
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
    next_seq: usize,
    child_pid: Option<u32>,
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
            let ps_path = std::path::Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
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

    /// Create and spawn a new terminal child process.
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

        let mut cmd = Command::new(&shell);
        cmd.current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            // Set TERM environment if needed
            cmd.env("TERM", "xterm-256color");
        }
        #[cfg(not(windows))]
        {
            cmd.env("TERM", "xterm-256color");
        }

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn shell '{shell}': {e}"))?;
        let child_pid = child.id();

        let mut child_stdin = child.stdin.take();
        let mut child_stdout = child.stdout.take();
        let mut child_stderr = child.stderr.take();

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(128);

        // Stdin forwarder
        if let Some(mut cin) = child_stdin.take() {
            tokio::spawn(async move {
                while let Some(bytes) = stdin_rx.recv().await {
                    if cin.write_all(&bytes).await.is_err() || cin.flush().await.is_err() {
                        break;
                    }
                }
            });
        }

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

        let entry = TerminalEntry {
            descriptor: descriptor.clone(),
            stdin_tx: Some(stdin_tx),
            buffer: Vec::new(),
            next_seq: 0,
            child_pid,
        };

        {
            let mut lock = self.entries.write().await;
            lock.insert(term_id.clone(), entry);
        }

        // Stdout reader
        let entries_stdout = self.entries.clone();
        let hub_stdout = self.hub.clone();
        let tid_stdout = term_id.clone();
        let sid_stdout = session_id.to_string();

        if let Some(mut cout) = child_stdout.take() {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match cout.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let mut lock = entries_stdout.write().await;
                            let out_seq;
                            if let Some(e) = lock.get_mut(&tid_stdout) {
                                e.next_seq += 1;
                                out_seq = e.next_seq;
                                if e.buffer.len() >= MAX_BUFFER_FRAMES {
                                    e.buffer.remove(0);
                                }
                                e.buffer.push(text.clone());
                            } else {
                                out_seq = 0;
                            }
                            // Contract frame shape (ws-control.ts:418-428):
                            // {type: "terminal_output", seq, session_id,
                            //  terminal_id, timestamp, payload:{data}}.
                            let out_event = json!({
                                "type": "terminal_output",
                                "session_id": sid_stdout,
                                "terminal_id": tid_stdout,
                                "seq": out_seq,
                                "data": text,
                            });
                            hub_stdout.bus_for(&sid_stdout).publish(&EngineEvent::Custom(out_event));
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // Stderr reader
        let entries_stderr = self.entries.clone();
        let hub_stderr = self.hub.clone();
        let tid_stderr = term_id.clone();
        let sid_stderr = session_id.to_string();

        if let Some(mut cerr) = child_stderr.take() {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match cerr.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let mut lock = entries_stderr.write().await;
                            let out_seq;
                            if let Some(e) = lock.get_mut(&tid_stderr) {
                                e.next_seq += 1;
                                out_seq = e.next_seq;
                                if e.buffer.len() >= MAX_BUFFER_FRAMES {
                                    e.buffer.remove(0);
                                }
                                e.buffer.push(text.clone());
                            } else {
                                out_seq = 0;
                            }
                            // Contract frame shape (ws-control.ts:418-428):
                            // {type: "terminal_output", seq, session_id,
                            //  terminal_id, timestamp, payload:{data}}.
                            let out_event = json!({
                                "type": "terminal_output",
                                "session_id": sid_stderr,
                                "terminal_id": tid_stderr,
                                "seq": out_seq,
                                "data": text,
                            });
                            hub_stderr.bus_for(&sid_stderr).publish(&EngineEvent::Custom(out_event));
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // Process exit watcher
        let entries_exit = self.entries.clone();
        let hub_exit = self.hub.clone();
        let tid_exit = term_id.clone();
        let sid_exit = session_id.to_string();

        tokio::spawn(async move {
            let status = child.wait().await;
            let exit_code = status.ok().and_then(|s| s.code());
            let exited_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

            let mut lock = entries_exit.write().await;
            if let Some(e) = lock.get_mut(&tid_exit) {
                e.descriptor.status = "exited".to_string();
                e.descriptor.exited_at = Some(exited_at.clone());
                e.descriptor.exit_code = exit_code;
                e.stdin_tx = None;
            }

            // Contract frame shape (ws-control.ts:433-441): payload.exit_code.
            let exit_event = json!({
                "type": "terminal_exit",
                "session_id": sid_exit,
                "terminal_id": tid_exit,
                "payload": { "exit_code": exit_code },
            });
            hub_exit.bus_for(&sid_exit).publish(&EngineEvent::Custom(exit_event));
        });

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
    pub async fn write(&self, session_id: &str, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let lock = self.entries.read().await;
        let entry = lock.get(terminal_id).ok_or_else(|| "Terminal not found".to_string())?;
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
    pub async fn resize(
        &self,
        session_id: &str,
        terminal_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        let mut lock = self.entries.write().await;
        let entry = lock.get_mut(terminal_id).ok_or_else(|| "Terminal not found".to_string())?;
        if entry.descriptor.session_id != session_id {
            return Err("Terminal not found in session".to_string());
        }
        entry.descriptor.cols = cols;
        entry.descriptor.rows = rows;
        Ok(())
    }

    /// Close and kill a terminal process.
    pub async fn close(&self, session_id: &str, terminal_id: &str) -> Result<(), String> {
        let mut lock = self.entries.write().await;
        let entry = lock.get_mut(terminal_id).ok_or_else(|| "Terminal not found".to_string())?;
        if entry.descriptor.session_id != session_id {
            return Err("Terminal not found in session".to_string());
        }
        if entry.descriptor.status == "running" {
            entry.descriptor.status = "exited".to_string();
            entry.descriptor.exited_at = Some(
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            );
            entry.stdin_tx = None;
            if let Some(pid) = entry.child_pid {
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .output();
                }
                #[cfg(not(windows))]
                {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
            }
        }
        Ok(())
    }

    /// Retrieve recorded terminal buffer frames.
    pub async fn output(
        &self,
        session_id: &str,
        terminal_id: &str,
        since_seq: usize,
    ) -> Result<(Vec<String>, usize), String> {
        let lock = self.entries.read().await;
        let entry = lock.get(terminal_id).ok_or_else(|| "Terminal not found".to_string())?;
        if entry.descriptor.session_id != session_id {
            return Err("Terminal not found in session".to_string());
        }
        let total = entry.buffer.len();
        if since_seq >= total {
            Ok((Vec::new(), total))
        } else {
            Ok((entry.buffer[since_seq..].to_vec(), total))
        }
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
        let desc = mgr.create("sess-1", &cwd, None, Some(80), Some(24)).await.unwrap();
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

        // 4. Resize
        mgr.resize("sess-1", &desc.id, 120, 30).await.unwrap();
        let resized = mgr.get("sess-1", &desc.id).await.unwrap();
        assert_eq!(resized.cols, 120);
        assert_eq!(resized.rows, 30);

        // Resize non-existent returns error
        assert_eq!(mgr.resize("sess-1", "term_none", 100, 20).await.unwrap_err(), "Terminal not found");

        // 5. Write input
        mgr.write("sess-1", &desc.id, b"echo test\n").await.expect("terminal write must succeed");

        // 6. Terminal output
        let (frames, total) = mgr.output("sess-1", &desc.id, 0).await.expect("output query succeeds");
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
            assert!(shell.ends_with(".exe") || shell.contains("powershell") || shell.contains("cmd") || shell.contains("bash"));
        }
    }
}
