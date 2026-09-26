//! Pure Rust session persistence and WAL storage (P27 批 3).
//!
//! Provides durable session persistence and per-domain state storage for the
//! standalone REPL under the user's home —
//! `~/.kimi-code/engine-state/<workspace-key>/` (M4 存储位置裁决) — using
//! one JSON file per state domain backing the state bridge.
//!
//! **Session turns are not stored here.** [`SessionStore`] is the original
//! append-only JSONL transcript store from P27; since P75 the engine persists
//! every session turn through [`crate::session::sqlite_store::SqliteSessionStore`]
//! (all production callers — `main.rs`, `napi_bindings.rs`, `server/`, `rpc/` —
//! use the SQLite one). It stays exported for its own tests and for hosts that
//! want a dependency-free transcript; nothing in the engine writes through it,
//! so its unsynchronised `append_turn` is not on any live path. New code should
//! use `SqliteSessionStore`.

pub mod paths;
pub mod session_store;
pub mod state_store;
pub mod task_runner;

pub use paths::engine_state_dir;
pub use session_store::{SessionRecord, SessionStore, SessionSummary};
pub use state_store::{StateStore, StateWriteOutcome};
pub use task_runner::{
    BackgroundLimits, TaskEventSink, TaskNotification, TaskRunner, TaskSpawnMeta, TaskStatus,
    TaskWaitResult, scan_previous_session_reminders,
};
