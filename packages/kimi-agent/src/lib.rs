//! kimi-agent — Rust agent engine library.
//!
//! Shared library entry point for both the CLI binary (stdio JSON-RPC)
//! and the napi-rs native addon (direct Node.js integration).

pub mod callbacks;
pub mod llm;
pub mod napi_bindings;
pub mod rpc;
pub mod tool_result_truncation;
pub mod tools;
pub mod turn_loop;
