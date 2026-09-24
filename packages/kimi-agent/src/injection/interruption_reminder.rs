//! The interruption reminder, ported from v2's
//! `interruptionReminder/interruptionReminderService.ts`: after a turn the
//! user cancelled, the next turn's head carries a one-shot system reminder
//! that any partial output above is incomplete.
//!
//! v2 keys the reminder off `TurnEnded { reason: 'cancelled',
//! interruptReason: 'user_cancelled' }` and dedupes by inspecting whether the
//! last comparable message is already this variant. The engine's turn loop is
//! stateless and cannot distinguish a user cancellation from a host-side
//! abort (the reason does not travel with the cancel request — see the
//! `telemetry_interrupt_reason` note), so the caller reports the aborted
//! outcome through [`RunTurnInput::previous_turn_aborted`] and the
//! history-scan baseline keeps a resumed session from re-announcing a
//! reminder that is already in the transcript.

use crate::injection::InjectionRegistry;
use crate::turn_loop::types::LLMMessage;

/// The reminder injected after a user-cancelled turn (v2
/// `interruptionReminderService.ts:15-19`, joined verbatim).
pub const INTERRUPTION_REMINDER: &str = "The previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.";

/// The reminder's opening line, used to recognize the variant in history.
const REMINDER_MARKER: &str = "The previous turn was interrupted by the user";

/// Whether the conversation already carries an interruption reminder (v2's
/// dedupe against the last comparable message's injection variant): the
/// reminder is one-shot per abort, and a resumed session must not re-announce
/// one the model was already shown.
pub fn scan_interruption_baseline(messages: &[LLMMessage]) -> bool {
    messages
        .iter()
        .rev()
        .any(|message| message.content.contains(REMINDER_MARKER))
}

/// Register the one-shot provider when the previous turn aborted and the
/// history does not already carry the reminder.
pub fn register_interruption_reminder(
    registry: &mut InjectionRegistry,
    previous_turn_aborted: bool,
    messages: &[LLMMessage],
) {
    if !previous_turn_aborted || scan_interruption_baseline(messages) {
        return;
    }
    registry.register(
        "interruption_reminder",
        Box::new(|_ctx| Some(INTERRUPTION_REMINDER.to_string())),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::injection::{is_system_reminder, wrap_system_reminder};

    fn message(content: &str) -> LLMMessage {
        LLMMessage {
            role: "user".into(),
            content: content.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn test_reminder_text_carries_the_load_bearing_lines() {
        assert!(INTERRUPTION_REMINDER.starts_with("The previous turn was interrupted by the user"));
        assert!(INTERRUPTION_REMINDER.contains("any partial output shown above is incomplete"));
        assert!(
            INTERRUPTION_REMINDER.contains("The user's next message continues the conversation.")
        );
    }

    #[test]
    fn test_baseline_detects_a_prior_reminder() {
        assert!(!scan_interruption_baseline(&[]));
        assert!(!scan_interruption_baseline(&[message("unrelated")]));
        assert!(scan_interruption_baseline(&[message(
            &wrap_system_reminder(INTERRUPTION_REMINDER)
        )]));
    }

    #[test]
    fn test_registration_gates_on_abort_and_baseline() {
        let mut registry = InjectionRegistry::new();
        register_interruption_reminder(&mut registry, false, &[]);
        assert!(registry.names().is_empty(), "no abort: no reminder");

        let history = [message(&wrap_system_reminder(INTERRUPTION_REMINDER))];
        let mut registry = InjectionRegistry::new();
        register_interruption_reminder(&mut registry, true, &history);
        assert!(
            registry.names().is_empty(),
            "already reminded: not re-announced"
        );

        let mut registry = InjectionRegistry::new();
        register_interruption_reminder(&mut registry, true, &[]);
        assert_eq!(registry.names(), vec!["interruption_reminder"]);
        let texts = registry.build_injections(true);
        assert_eq!(texts.len(), 1);
        assert!(is_system_reminder(&texts[0]));
        assert_eq!(texts[0], wrap_system_reminder(INTERRUPTION_REMINDER));
    }
}
