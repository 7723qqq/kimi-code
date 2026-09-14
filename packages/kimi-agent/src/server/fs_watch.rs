//! Workspace file watching for the native server (upstream #3502).
//!
//! `watch_fs_add` / `watch_fs_remove` register paths through
//! [`FsWatchManager`]; a polling task observes them and publishes
//! `event.fs.changed` onto the session lane — the event the removed
//! kap-server `fsWatchBridge` used to emit and `kimi-web` listens for.
//!
//! **Implementation note — polling, not inotify.** The crate has no
//! `notify`/inotify/ReadDirectoryChanges dependency, and adding one would pull
//! platform backends into a build that currently avoids them. A bounded mtime
//! poll covers the contract (change notification with a session-scoped event)
//! at the cost of latency equal to the poll interval and mtime granularity.
//! That limit is stated here rather than silently claimed as an OS watcher;
//! swap in an OS backend behind the same manager if latency ever matters.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use crate::events::EngineEvent;
use crate::server::hub::EventHub;

/// Cap on tracked `(session, path)` targets so a client cannot grow the
/// watcher without bound.
const MAX_WATCH_TARGETS: usize = 4096;

/// Watch key: the session the registration came in on plus the path string
/// exactly as the client sent it. No canonicalization — the event echoes the
/// path back, and rewriting it would surprise a client matching on what it sent.
type WatchKey = (String, String);

#[derive(Debug, Default)]
struct WatchState {
    /// Last observed mtime in epoch ms; `None` until the first successful
    /// observation. The first poll records a baseline instead of emitting, so
    /// subscribing never produces a spurious burst of "changes".
    last_mtime_ms: Option<i64>,
    /// Whether the path existed at the last poll — a path that disappears is a
    /// change too.
    last_exists: bool,
}

/// Tracks watched `(session, path)` targets and publishes changes onto the
/// session lane.
pub struct FsWatchManager {
    hub: Arc<EventHub>,
    targets: Mutex<HashMap<WatchKey, WatchState>>,
}

impl FsWatchManager {
    pub fn new(hub: Arc<EventHub>) -> Self {
        Self {
            hub,
            targets: Mutex::new(HashMap::new()),
        }
    }

    /// Register paths for a session. Idempotent per `(session, path)`; returns
    /// how many of the requested paths are now watched (0 when the target cap
    /// is reached).
    pub fn add(&self, session_id: &str, paths: &[String]) -> usize {
        let mut targets = self.targets.lock().unwrap_or_else(|e| e.into_inner());
        let mut registered = 0;
        for path in paths {
            if path.trim().is_empty() {
                continue;
            }
            let key = (session_id.to_string(), path.clone());
            if targets.contains_key(&key) {
                registered += 1;
                continue;
            }
            if targets.len() >= MAX_WATCH_TARGETS {
                break;
            }
            targets.insert(key, WatchState::default());
            registered += 1;
        }
        registered
    }

    /// Drop paths for a session. Safe to call for paths that were never added.
    pub fn remove(&self, session_id: &str, paths: &[String]) {
        let mut targets = self.targets.lock().unwrap_or_else(|e| e.into_inner());
        for path in paths {
            targets.remove(&(session_id.to_string(), path.clone()));
        }
    }

    /// Number of tracked `(session, path)` targets.
    pub fn watch_count(&self) -> usize {
        self.targets.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// One poll pass over every watched target: emits `event.fs.changed` for
    /// paths whose mtime appeared / changed / disappeared. Returns the number
    /// of emitted events. Public so tests can drive a pass deterministically.
    pub async fn poll_once(&self) -> usize {
        // Snapshot the keys first: the metadata awaits below must not hold the
        // lock, or a concurrent add/remove could deadlock the poll.
        let keys: Vec<WatchKey> = {
            let targets = self.targets.lock().unwrap_or_else(|e| e.into_inner());
            targets.keys().cloned().collect()
        };

        let mut emitted = 0;
        for (session_id, path) in keys {
            let metadata = tokio::fs::metadata(&path).await.ok();
            let exists = metadata.is_some();
            let mtime_ms = metadata
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);

            let changed = {
                let mut targets = self.targets.lock().unwrap_or_else(|e| e.into_inner());
                let Some(state) = targets.get_mut(&(session_id.clone(), path.clone())) else {
                    // Deregistered while polling: nothing to report.
                    continue;
                };
                let changed = match state.last_mtime_ms {
                    // First observation: baseline only.
                    None => false,
                    Some(prev) => {
                        if exists {
                            mtime_ms != Some(prev)
                        } else {
                            // It existed last poll and is gone now.
                            state.last_exists
                        }
                    }
                };
                if changed {
                    emitted += 1;
                }
                state.last_exists = exists;
                state.last_mtime_ms = mtime_ms;
                changed
            };

            if changed {
                self.hub.bus_for(&session_id).publish(&EngineEvent::Custom(
                    json!({
                        "type": "event.fs.changed",
                        "sessionId": session_id,
                        "path": path,
                    }),
                ));
            }
        }
        emitted
    }
}

/// Runs [`FsWatchManager::poll_once`] on an interval for the lifetime of the
/// server. Spawned by `run_serve` (the one place that is guaranteed to be
/// inside the runtime); returns when the runtime shuts down.
pub async fn run_poll_loop(manager: Arc<FsWatchManager>, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        manager.poll_once().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> (
        tempfile::TempDir,
        Arc<FsWatchManager>,
        Arc<EventHub>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let hub = Arc::new(EventHub::new());
        let mgr = Arc::new(FsWatchManager::new(hub.clone()));
        (dir, mgr, hub)
    }

    #[tokio::test]
    async fn first_poll_is_a_baseline_and_a_later_mtime_emits_once() {
        let (dir, mgr, hub) = manager();
        let file = dir.path().join("watched.txt");
        std::fs::write(&file, "v1").unwrap();

        mgr.add("sess-fs", &[file.to_string_lossy().into_owned()]);

        // Baseline pass records the initial mtime and emits nothing.
        assert_eq!(mgr.poll_once().await, 0);

        // Touch the file with a fresh mtime.
        std::fs::write(&file, "v2").unwrap();

        let mut sub = hub.attach();
        // The subscriber attaches after the baseline, so the change arrives live.
        assert_eq!(mgr.poll_once().await, 1);
        let event = sub.recv().await.unwrap();
        assert_eq!(event.event.event_type(), "event.fs.changed");
        let path = event.event.to_json()["path"].as_str().unwrap().to_string();
        assert_eq!(path, file.to_string_lossy());

        // No further change: the next pass is quiet.
        assert_eq!(mgr.poll_once().await, 0);
    }

    #[tokio::test]
    async fn disappearance_is_a_change_and_add_is_idempotent() {
        let (dir, mgr, hub) = manager();
        let file = dir.path().join("gone.txt");
        std::fs::write(&file, "bye").unwrap();
        let path = file.to_string_lossy().into_owned();

        assert_eq!(mgr.add("sess-fs", &[path.clone()]), 1);
        // A duplicate registration of the same (session, path) is collapsed.
        assert_eq!(mgr.add("sess-fs", &[path.clone()]), 1);
        assert_eq!(mgr.watch_count(), 1);

        assert_eq!(mgr.poll_once().await, 0, "baseline");
        std::fs::remove_file(&file).unwrap();

        let mut sub = hub.attach();
        assert_eq!(mgr.poll_once().await, 1, "disappearance emits once");
        let event = sub.recv().await.unwrap();
        assert_eq!(event.event.event_type(), "event.fs.changed");

        // Removing an unknown path is fine, and removal really stops watching.
        mgr.remove("sess-fs", &[path.clone(), "never-added".into()]);
        assert_eq!(mgr.watch_count(), 0);
        assert_eq!(mgr.poll_once().await, 0);
    }

    #[tokio::test]
    async fn empty_paths_are_ignored() {
        let (_dir, mgr, _hub) = manager();
        assert_eq!(mgr.add("sess-fs", &["".to_string(), "   ".to_string()]), 0);
        assert_eq!(mgr.watch_count(), 0);
    }
}
