//! Swarm-mode reminders, ported from v2's `SwarmInjection`
//! (`agent-core-v2/src/features/swarm/agent/injection/swarmInjection.ts`).
//!
//! v2 registers a `swarm_mode` reminder variant whose provider asks the swarm
//! service for the current trigger and injects an enter or exit reminder when
//! the rendered state changes. The Rust side mirrors that: the provider reads
//! [`crate::swarm::mode::swarm_mode_registry`] and compares against the last
//! state disclosed in the conversation history.

use crate::injection::InjectionContext;
use crate::swarm::mode::{SwarmModeTrigger, swarm_mode_registry};
use crate::turn_loop::types::LLMMessage;

/// The reminder injected when swarm mode becomes active — v2
/// `features/swarm/agent/enter-reminder.md`, verbatim.
pub const SWARM_MODE_ENTER_REMINDER: &str = r#"## Swarm Mode

You are now in "agent swarm" mode. The user may send tasks that require a large number of parallel subagents.

## Workflow

You do not need to use TodoList to record this workflow.

1. First, you may need to do a small amount of exploratory work before deciding how to divide the task across subagents. You may not need subagents during this exploratory phase.

2. After exploring, if you are convinced no subagent is needed to complete the task, tell the user why and wait for further instructions; otherwise, continue with the appropriate delegation.

3. Once you have enough context, do not handle the main work yourself. Use AgentSwarm with a `prompt_template` containing the `{{item}}` placeholder and an `items` array for the requested or appropriate number of subagents, partitioning the problem so each item gives one subagent a distinct part of the work. Pass `subagent_type` when the whole swarm should use a non-default subagent profile.

## Coordination

- Give each subagent a distinct scope of work.
- Avoid duplicating work across subagents.
- Avoid assigning conflicting changes or responsibilities to different subagents.
- Remember that subagents have your full capabilities. Do not overload their prompts with excessive detail; only describe the necessary background and each subagent's specific task.
- Unless the user explicitly specifies a lower limit, do not try to conserve the number of agents. AgentSwarm supports up to 128 subagents and queues launches automatically, so decompose work as finely as possible while keeping subagent responsibilities non-conflicting; combine tasks only when they are genuinely inseparable. If the subagents only need to read, inspect, or report back without making changes, their scopes may overlap slightly."#;

/// The reminder injected when swarm mode ends — v2
/// `features/swarm/agent/exit-reminder.md`, verbatim.
pub const SWARM_MODE_EXIT_REMINDER: &str = r#"## Swarm Mode Ended

Swarm Mode has ended. You are no longer required to follow the Swarm Mode workflow.

The user's next request is likely to be a regular request that does not need AgentSwarm. If the request still benefits from parallel subagents, you may call the AgentSwarm tool, but decide from the new request itself rather than the ended Swarm Mode workflow."#;

/// The enter reminder's heading, used to recognize the variant in history.
const ENTER_MARKER: &str = "## Swarm Mode\n";
/// The exit reminder's heading.
const EXIT_MARKER: &str = "## Swarm Mode Ended";

/// Register the `swarm_mode` variant (v2 `SwarmInjection`'s
/// `injector.register(SWARM_MODE_INJECTION_VARIANT, …)`).
///
/// `agent_id` scopes the mode lookup: v2's service is per agent scope, and the
/// native engine keys the shared registry by agent id.
pub fn register_swarm_mode_injection(
    registry: &mut crate::injection::InjectionRegistry,
    agent_id: String,
    baseline: Option<bool>,
) {
    let mut disclosed = baseline;
    registry.register(
        "swarm_mode",
        Box::new(move |_ctx: &InjectionContext| {
            // v2 `reminder()`: the mode counts as active only for a trigger
            // other than `tool` — a swarm the model just called is already
            // evident from the tool call itself, so it is not announced.
            let trigger = swarm_mode_registry().trigger(&agent_id);
            let active = trigger.is_some_and(|t| t != SwarmModeTrigger::Tool);

            match (active, disclosed) {
                // Already rendered in this state: nothing to announce.
                (true, Some(true)) | (false, Some(false)) | (false, None) => None,
                (true, _) => {
                    disclosed = Some(true);
                    Some(SWARM_MODE_ENTER_REMINDER.to_string())
                }
                (false, Some(true)) => {
                    disclosed = Some(false);
                    Some(SWARM_MODE_EXIT_REMINDER.to_string())
                }
            }
        }),
    );
}

/// The last swarm-mode state disclosed in the conversation history (v2
/// `renderedState`): the enter/exit reminders must fire on a change only,
/// not on every step.
pub fn scan_swarm_mode_baseline(messages: &[LLMMessage]) -> Option<bool> {
    for message in messages.iter().rev() {
        let content = message.content.as_str();
        if content.contains(ENTER_MARKER) {
            return Some(true);
        }
        if content.contains(EXIT_MARKER) {
            return Some(false);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::injection::{InjectionRegistry, wrap_system_reminder};

    #[test]
    fn a_manual_swarm_injects_the_enter_reminder_once() {
        let agent = "swarm-injection-manual";
        swarm_mode_registry().exit(agent);
        swarm_mode_registry().enter(agent, SwarmModeTrigger::Manual);

        let mut registry = InjectionRegistry::new();
        register_swarm_mode_injection(&mut registry, agent.to_string(), None);

        let first = registry.build_injections(true);
        assert_eq!(
            first,
            vec![wrap_system_reminder(SWARM_MODE_ENTER_REMINDER)],
            "a manual swarm announces the mode"
        );
        // State unchanged: no repeat.
        assert!(
            registry.build_injections(false).is_empty(),
            "the reminder must not repeat while the state holds"
        );

        swarm_mode_registry().exit(agent);
    }

    #[test]
    fn a_tool_opened_swarm_is_not_announced() {
        let agent = "swarm-injection-tool";
        swarm_mode_registry().exit(agent);
        swarm_mode_registry().enter(agent, SwarmModeTrigger::Tool);

        let mut registry = InjectionRegistry::new();
        register_swarm_mode_injection(&mut registry, agent.to_string(), None);
        assert!(
            registry.build_injections(true).is_empty(),
            "a swarm the model just called is already evident from the tool call"
        );

        swarm_mode_registry().exit(agent);
    }

    /// Leaving the mode after it was announced injects the exit reminder once.
    #[test]
    fn leaving_an_announced_swarm_injects_the_exit_reminder_once() {
        let agent = "swarm-injection-exit";
        swarm_mode_registry().exit(agent);
        swarm_mode_registry().enter(agent, SwarmModeTrigger::Manual);

        let mut registry = InjectionRegistry::new();
        register_swarm_mode_injection(&mut registry, agent.to_string(), None);
        assert_eq!(
            registry.build_injections(true),
            vec![wrap_system_reminder(SWARM_MODE_ENTER_REMINDER)]
        );

        // The mode closes: the exit reminder fires, and only once.
        swarm_mode_registry().exit(agent);
        assert_eq!(
            registry.build_injections(false),
            vec![wrap_system_reminder(SWARM_MODE_EXIT_REMINDER)]
        );
        assert!(
            registry.build_injections(false).is_empty(),
            "the exit reminder must not repeat"
        );
    }

    /// A session resumed with the enter reminder already in history must not
    /// re-announce the mode.
    #[test]
    fn a_baseline_from_history_suppresses_a_repeat_announcement() {
        let agent = "swarm-injection-baseline";
        swarm_mode_registry().exit(agent);
        swarm_mode_registry().enter(agent, SwarmModeTrigger::Manual);

        let mut registry = InjectionRegistry::new();
        register_swarm_mode_injection(&mut registry, agent.to_string(), Some(true));
        assert!(
            registry.build_injections(true).is_empty(),
            "already disclosed in history: no repeat"
        );

        swarm_mode_registry().exit(agent);
    }

    #[test]
    fn no_mode_means_no_reminder() {
        let agent = "swarm-injection-none";
        swarm_mode_registry().exit(agent);
        let mut registry = InjectionRegistry::new();
        register_swarm_mode_injection(&mut registry, agent.to_string(), None);
        assert!(registry.build_injections(true).is_empty());
    }

    #[test]
    fn scan_baseline_reads_the_last_disclosure() {
        let msg = |content: &str| LLMMessage {
            role: "user".into(),
            content: content.to_string(),
            ..Default::default()
        };
        assert_eq!(scan_swarm_mode_baseline(&[]), None);
        assert_eq!(
            scan_swarm_mode_baseline(&[msg(SWARM_MODE_ENTER_REMINDER)]),
            Some(true)
        );
        assert_eq!(
            scan_swarm_mode_baseline(&[msg(SWARM_MODE_EXIT_REMINDER)]),
            Some(false)
        );
        // Latest wins.
        assert_eq!(
            scan_swarm_mode_baseline(&[
                msg(SWARM_MODE_ENTER_REMINDER),
                msg(SWARM_MODE_EXIT_REMINDER)
            ]),
            Some(false)
        );
    }
}
