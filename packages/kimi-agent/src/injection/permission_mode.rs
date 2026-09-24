//! Permission-mode reminders, ported from v2's `PermissionModeInjection`
//! (`agent-core-v2/src/agent/permissionMode/injection/permissionModeInjection.ts`).
//!
//! v2 keeps the last mode in agent state (`permissionMode.lastMode`) and reads
//! the variant's injected positions from the conversation history; the Rust
//! engine has neither, so [`scan_permission_mode_baseline`] recovers both from
//! the history. A resumed session therefore does not re-announce a mode the
//! model was already told about, while a mode change that happened while the
//! session was idle still produces its reminder.

use crate::injection::InjectionContext;
use crate::permission::PermissionMode;
use crate::turn_loop::types::LLMMessage;

/// `KIMI_CODE_PERMISSION_MODE_REMINDER` (v2 #3728): the env switch that turns
/// the injection off.
pub const PERMISSION_MODE_REMINDER_ENV: &str = "KIMI_CODE_PERMISSION_MODE_REMINDER";

/// The reminder injected when auto mode becomes active (v2
/// `permission-mode-auto-enter-reminder.md`).
pub const AUTO_ENTER_REMINDER: &str = r#"Auto permission mode is active. Tool approvals will be handled automatically while this mode remains enabled.
  - Continue normally without pausing for approval prompts.
  - Do NOT call AskUserQuestion while auto mode is active; decide and continue.
  - ExitPlanMode is also approved automatically, without the user reviewing the plan. An auto-approved plan is NOT a signal from the user to start executing — follow the user's original instructions on whether to proceed."#;

/// The reminder injected when auto mode ends (v2
/// `permission-mode-auto-exit-reminder.md`).
pub const AUTO_EXIT_REMINDER: &str = r#"Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode.
  - Continue normally, but expect approval prompts or denials when a tool requires them."#;

/// The enter reminder's opening line, used to recognize the variant in history.
const AUTO_ENTER_MARKER: &str = "Auto permission mode is active.";
/// The exit reminder's opening line.
const AUTO_EXIT_MARKER: &str = "Auto permission mode is no longer active.";

/// Whether the injection is registered (v2 #3728). The switch defaults on:
/// only an explicit falsy `KIMI_CODE_PERMISSION_MODE_REMINDER` value turns it
/// off (`crate::env::env_switch_default_on`, v2 `parseBooleanEnv`).
pub fn permission_mode_reminder_enabled() -> bool {
    crate::env::env_switch_default_on(PERMISSION_MODE_REMINDER_ENV)
}

/// State machine for the permission-mode reminders (v2
/// `PermissionModeInjection.reminder`): records the last mode and whether the
/// variant already injected, and produces the enter/exit texts.
pub struct PermissionModeTracker {
    last_mode: Option<PermissionMode>,
    injected: bool,
}

impl PermissionModeTracker {
    /// Seed the tracker with the mode recovered from history. A recorded mode
    /// means the variant already injected in this conversation, so the enter
    /// reminder is not repeated at the turn head.
    pub fn with_last_mode(last_mode: Option<PermissionMode>) -> Self {
        Self {
            last_mode,
            injected: last_mode.is_some(),
        }
    }

    /// Feed the live mode; returns the reminder text to inject for this step,
    /// or `None` when nothing should be injected. The enter reminder fires on
    /// the transition into auto and again when the variant never injected;
    /// the exit reminder fires on the transition out of auto.
    pub fn step(&mut self, current: PermissionMode) -> Option<&'static str> {
        let previous = self.last_mode;
        if previous == Some(current) {
            if self.injected || current != PermissionMode::Auto {
                return None;
            }
            self.injected = true;
            return Some(AUTO_ENTER_REMINDER);
        }
        self.last_mode = Some(current);
        let reminder = if current == PermissionMode::Auto {
            Some(AUTO_ENTER_REMINDER)
        } else if previous == Some(PermissionMode::Auto) {
            Some(AUTO_EXIT_REMINDER)
        } else {
            None
        };
        self.injected |= reminder.is_some();
        reminder
    }
}

/// Provider for the permission-mode reminders. The mode is fixed for the turn,
/// so the tracker only needs to know how often it already injected — v2's
/// `injectedPositions` are this variant's own history positions, which the
/// registry's per-turn cross-variant `injected` list does not carry.
fn permission_mode_provider(
    mode: PermissionMode,
    baseline: Option<PermissionMode>,
) -> impl FnMut(&InjectionContext) -> Option<String> {
    let mut tracker = PermissionModeTracker::with_last_mode(baseline);
    move |_ctx: &InjectionContext| tracker.step(mode).map(str::to_string)
}

/// Scan prior conversation messages for the last permission-mode reminder and
/// recover the mode it recorded (v2's state-backed `permissionMode.lastMode`):
/// the enter reminder means auto, the exit reminder means some other mode.
/// `None` when the variant never injected — the enter reminder then fires on
/// the next auto turn.
pub fn scan_permission_mode_baseline(messages: &[LLMMessage]) -> Option<PermissionMode> {
    for message in messages.iter().rev() {
        let content = message.content.as_str();
        if content.contains(AUTO_ENTER_MARKER) {
            return Some(PermissionMode::Auto);
        }
        if content.contains(AUTO_EXIT_MARKER) {
            // The exit reminder proves auto ended but not which mode followed;
            // every non-auto mode behaves identically in the transition logic.
            return Some(PermissionMode::Manual);
        }
    }
    None
}

/// Register the permission-mode reminders on `registry`. `mode` is the live
/// permission mode for the turn — `None` when the host carries no policy
/// snapshot, which leaves the injection off — and `baseline` is the mode
/// recovered from the conversation history.
pub fn register_permission_mode_injection(
    registry: &mut crate::injection::InjectionRegistry,
    mode: Option<PermissionMode>,
    baseline: Option<PermissionMode>,
) {
    if !permission_mode_reminder_enabled() {
        return;
    }
    let Some(mode) = mode else {
        return;
    };
    registry.register(
        "permission_mode",
        Box::new(permission_mode_provider(mode, baseline)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::injection::{InjectionRegistry, is_system_reminder};

    fn message(content: &str) -> LLMMessage {
        LLMMessage {
            role: "user".into(),
            content: content.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn test_reminder_texts_carry_their_load_bearing_lines() {
        assert!(AUTO_ENTER_REMINDER.starts_with("Auto permission mode is active."));
        assert!(
            AUTO_ENTER_REMINDER.contains("Do NOT call AskUserQuestion while auto mode is active")
        );
        assert!(AUTO_ENTER_REMINDER.contains("ExitPlanMode is also approved automatically"));
        assert!(
            AUTO_ENTER_REMINDER.contains("An auto-approved plan is NOT a signal from the user")
        );
        assert!(AUTO_EXIT_REMINDER.starts_with("Auto permission mode is no longer active."));
        assert!(AUTO_EXIT_REMINDER.contains("expect approval prompts or denials"));
    }

    #[test]
    fn test_tracker_enters_stays_and_exits_auto() {
        let mut tracker = PermissionModeTracker::with_last_mode(None);

        assert_eq!(tracker.step(PermissionMode::Manual), None);
        assert_eq!(
            tracker.step(PermissionMode::Auto),
            Some(AUTO_ENTER_REMINDER)
        );
        assert_eq!(
            tracker.step(PermissionMode::Auto),
            None,
            "auto stays active without repeating the reminder"
        );
        assert_eq!(
            tracker.step(PermissionMode::Manual),
            Some(AUTO_EXIT_REMINDER)
        );
        assert_eq!(
            tracker.step(PermissionMode::Manual),
            None,
            "the exit reminder is not repeated"
        );
        assert_eq!(tracker.step(PermissionMode::Yolo), None);
        assert_eq!(
            tracker.step(PermissionMode::Auto),
            Some(AUTO_ENTER_REMINDER)
        );
    }

    #[test]
    fn test_tracker_reannounces_auto_when_the_reminder_is_gone() {
        let mut tracker = PermissionModeTracker::with_last_mode(None);
        assert_eq!(
            tracker.step(PermissionMode::Auto),
            Some(AUTO_ENTER_REMINDER)
        );
        assert_eq!(tracker.step(PermissionMode::Auto), None);

        let mut spliced = PermissionModeTracker::with_last_mode(None);
        assert_eq!(
            spliced.step(PermissionMode::Auto),
            Some(AUTO_ENTER_REMINDER),
            "a fresh tracker re-announces auto mode"
        );
    }

    #[test]
    fn test_tracker_baseline_suppresses_the_turn_head_repeat() {
        let mut tracker = PermissionModeTracker::with_last_mode(Some(PermissionMode::Auto));
        assert_eq!(
            tracker.step(PermissionMode::Auto),
            None,
            "a resumed auto session does not re-inject at the turn head"
        );
        assert_eq!(
            tracker.step(PermissionMode::Manual),
            Some(AUTO_EXIT_REMINDER)
        );
    }

    #[test]
    fn test_scan_permission_mode_baseline() {
        assert_eq!(scan_permission_mode_baseline(&[]), None);
        assert_eq!(scan_permission_mode_baseline(&[message("unrelated")]), None);
        assert_eq!(
            scan_permission_mode_baseline(&[message(AUTO_ENTER_REMINDER)]),
            Some(PermissionMode::Auto)
        );
        assert_eq!(
            scan_permission_mode_baseline(&[message(AUTO_EXIT_REMINDER)]),
            Some(PermissionMode::Manual)
        );
        // The latest reminder wins, regardless of kind.
        assert_eq!(
            scan_permission_mode_baseline(&[
                message(AUTO_ENTER_REMINDER),
                message("unrelated"),
                message(AUTO_EXIT_REMINDER),
            ]),
            Some(PermissionMode::Manual)
        );
        assert_eq!(
            scan_permission_mode_baseline(&[
                message(AUTO_EXIT_REMINDER),
                message(AUTO_ENTER_REMINDER),
            ]),
            Some(PermissionMode::Auto)
        );
    }

    #[test]
    fn test_registered_provider_injects_through_the_registry() {
        assert!(
            permission_mode_reminder_enabled(),
            "this test needs KIMI_CODE_PERMISSION_MODE_REMINDER unset or truthy"
        );
        let mut registry = InjectionRegistry::new();
        register_permission_mode_injection(&mut registry, Some(PermissionMode::Auto), None);
        assert_eq!(registry.names(), vec!["permission_mode"]);

        let texts = registry.build_injections(true);
        assert_eq!(texts.len(), 1);
        assert!(is_system_reminder(&texts[0]));
        assert_eq!(
            texts[0],
            crate::injection::wrap_system_reminder(AUTO_ENTER_REMINDER)
        );

        assert!(
            registry.build_injections(false).is_empty(),
            "the reminder is not repeated within the turn"
        );
    }

    #[test]
    fn test_registration_skips_unknown_mode_and_non_auto() {
        assert!(
            permission_mode_reminder_enabled(),
            "this test needs KIMI_CODE_PERMISSION_MODE_REMINDER unset or truthy"
        );
        let mut registry = InjectionRegistry::new();
        register_permission_mode_injection(&mut registry, None, None);
        assert!(registry.names().is_empty());

        let mut manual = InjectionRegistry::new();
        register_permission_mode_injection(&mut manual, Some(PermissionMode::Manual), None);
        assert!(manual.build_injections(true).is_empty());

        let mut exiting = InjectionRegistry::new();
        register_permission_mode_injection(
            &mut exiting,
            Some(PermissionMode::Manual),
            Some(PermissionMode::Auto),
        );
        assert_eq!(
            exiting.build_injections(true),
            vec![crate::injection::wrap_system_reminder(AUTO_EXIT_REMINDER)]
        );
    }
}
