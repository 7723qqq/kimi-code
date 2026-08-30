//! Pure Rust session persistence and WAL storage (P27 批 3).
//!
//! Provides durable session persistence in `<workspace>/.kimi/sessions/`
//! using append-only JSONL format for crash-resilient multi-turn storage.

pub mod session_store;

pub use session_store::{SessionRecord, SessionStore, SessionSummary};
