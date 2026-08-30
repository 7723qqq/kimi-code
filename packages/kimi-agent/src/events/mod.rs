//! Event bus and strongly-typed engine events for `kimi-agent` (P26 批 5).
//!
//! Replaces direct host-only `emit_event` calls with an in-process pub-sub
//! architecture. Subsystems (telemetry, local transcript, metrics, debug tap)
//! subscribe in-process; an optional UI sink forwards events to the host.

pub mod bus;
pub mod types;

pub use bus::{EventBus, Subscription};
pub use types::EngineEvent;
