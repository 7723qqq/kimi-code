//! Pure Rust session persistence and WAL storage (P27 批 3).
//!
//! Provides durable session persistence and per-domain state storage for the
//! standalone REPL under the user's home —
//! `~/.kimi-code/engine-state/<workspace-key>/` (M4 存储位置裁决) — using
//! append-only JSONL for crash-resilient multi-turn sessions and one JSON
//! file per state domain backing the state bridge.

pub mod paths;
pub mod session_store;
pub mod state_store;
pub mod task_runner;

pub use paths::engine_state_dir;
pub use session_store::{SessionRecord, SessionStore, SessionSummary};
pub use state_store::{StateStore, StateWriteOutcome};
pub use task_runner::{TaskRunner, TaskStatus, TaskWaitResult};
