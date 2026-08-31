//! kimi-agent — Rust agent engine library.
//!
//! Shared library entry point for both the CLI binary (stdio JSON-RPC)
//! and the napi-rs native addon (direct Node.js integration).

pub mod callbacks;
pub mod compaction;
pub mod config;
pub mod cron;
pub mod events;
pub mod goal;
pub mod injection;
pub mod knowledge;
pub mod llm;
pub mod mcp;
pub mod napi_bindings;
pub mod permission;
pub mod repl;
pub mod rpc;
pub mod session;
pub mod storage;
pub mod subagent;
pub mod swarm;
pub mod team;
pub mod tool_result_truncation;
pub mod tools;
pub mod turn_loop;
