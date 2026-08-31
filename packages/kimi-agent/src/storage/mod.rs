//! Pure Rust session persistence and WAL storage (P27 批 3).
//!
//! Provides durable session persistence in `<workspace>/.kimi/sessions/`
//! using append-only JSONL format for crash-resilient multi-turn storage,
//! plus per-domain state storage in `<workspace>/.kimi/state/` (P32 批 1)
//! backing the state bridge for the standalone REPL.

pub mod session_store;
pub mod state_store;

pub use session_store::{SessionRecord, SessionStore, SessionSummary};
pub use state_store::{StateStore, StateWriteOutcome};
