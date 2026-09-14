//! Engine execution configuration.
//!
//! Only [`EngineConfig::max_tokens_limit`] is read by production code: the
//! legacy `KimiEngine` facade passes it as `RunTurnInput.max_context_tokens`
//! into `crate::turn_loop::run_turn`.
//!
//! The former `TurnLoop` / `StepResult` / `stop_hook` types were removed: they
//! had no production call site (only their own tests) and advertised a
//! "consecutive 3 tool-less steps ends the turn" policy that the real loop does
//! not implement. The engine's actual stop decisions live in
//! `crate::turn_loop::run_turn` (max steps, repeat breaker, `stopTurn`
//! propagation) and `crate::turn_loop::tool_scheduler`.

/// Engine execution configuration.
#[derive(Clone)]
pub struct EngineConfig {
    /// Context-window ceiling used for compaction budgeting. Defaults to 80% of
    /// a 128k window.
    pub max_tokens_limit: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            max_tokens_limit: 102_400,
        }
    }
}
