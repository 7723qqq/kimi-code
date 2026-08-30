//! Pure Rust Model Context Protocol (MCP) Client (P29).
//!
//! Provides stdio and HTTP/SSE client implementation for connecting to
//! external MCP servers directly from the native Rust agent engine.

pub mod client;
pub mod manager;
pub mod sse;
pub mod types;

pub use client::McpClient;
pub use manager::McpManager;
pub use sse::McpSseTransport;
pub use types::{McpTool, McpToolCallResult};
