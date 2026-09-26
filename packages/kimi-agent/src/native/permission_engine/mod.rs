//! Dangerous-command analysis, shared with the policy chain in
//! [`crate::permission`].
//!
//! The engine's own decision logic used to live here as a second
//! `PermissionEngine`, reached only through the legacy `KimiEngine` facade in
//! `lib.rs`. That facade now calls [`crate::permission::PermissionEngine`], so
//! this module keeps just the analyzer the chain needs and the duplicate
//! engine — with its own `SessionApprovalHistory`, `PermissionConfig` and
//! prefix-based workspace test — is gone. One permission implementation, and
//! the two can no longer disagree about what a path or a command means.

pub mod dangerous_command;
