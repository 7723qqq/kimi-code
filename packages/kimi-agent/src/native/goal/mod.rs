//! Goal state machine, token accounting, and steering prompt rendering.
//!
//! This is the napi addon layer: `native/napi_bindings.rs` exposes the
//! `native_goal_*` functions over `state` (validate / apply-update / parse) and
//! `accounting` (token deltas), while the engine itself reaches the live goal
//! through [`crate::rpc::types::GoalContext`] and renders prompt text via
//! `steering`.
//!
//! Two goal state types exist on purpose and must not be merged: the one in
//! this module is addon-facing (JSON in / JSON out, no serde derives, no
//! persistence), while [`crate::goal::GoalState`] is the engine's, serialized
//! into the `goal` domain by [`crate::storage::state_store`] with its
//! snake_case status spelling. The napi boundary converts between them.

pub mod accounting;
pub mod state;
pub mod steering;
