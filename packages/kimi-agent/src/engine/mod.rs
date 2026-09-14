//! Engine execution configuration.
//!
//! The only live item here is [`step_hooks::EngineConfig`], and only its
//! `max_tokens_limit` field — `lib.rs` passes it as
//! `RunTurnInput.max_context_tokens` to the real turn loop.
//!
//! The former `TurnLoop` / `StepResult` / `stop_hook` scaffolding was removed
//! (2026-09-14): it had zero production call sites and described a stop policy
//! the engine does not implement. The real loop's stop decisions are in
//! `crate::turn_loop::run_turn` and `crate::turn_loop::tool_scheduler`.

pub mod step_hooks;

pub use step_hooks::EngineConfig;
