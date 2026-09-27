//! Swarm mode — swarm's own identity as a feature, not "a kind of Agent".
//!
//! Port of v2 `features/swarm/agent/swarm.ts`, `agent/swarmService.ts` and
//! `swarmOps.ts`.
//!
//! `mode_mutex.rs` documents the gap this closes: it notes that "the native
//! engine has no tower/swarm mode flags ... and swarm is a one-shot batch
//! tool". In v2 swarm is a *mode* the agent enters and exits
//! (`SwarmModeTrigger`), with durable `swarm_mode.enter` / `swarm_mode.exit`
//! events, and a gate that vetoes a model response issuing `AgentSwarm`
//! alongside anything else.
//!
//! The mode is per-agent: each agent scope owns its own trigger.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Why the agent entered swarm mode (v2 `SwarmModeTrigger`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwarmModeTrigger {
    /// The user asked for a swarm.
    Manual,
    /// A task/goal dispatch opened the swarm.
    Task,
    /// The model called `AgentSwarm`.
    Tool,
}

impl SwarmModeTrigger {
    /// v2 wire spelling (`swarmOps.ts` schema values).
    pub fn as_str(self) -> &'static str {
        match self {
            SwarmModeTrigger::Manual => "manual",
            SwarmModeTrigger::Task => "task",
            SwarmModeTrigger::Tool => "tool",
        }
    }

    /// v2 `shouldAutoExit`: a swarm opened by a task or by the tool closes
    /// itself at turn end; one the user opened stays until they leave.
    pub fn auto_exits_at_turn_end(self) -> bool {
        matches!(self, SwarmModeTrigger::Task | SwarmModeTrigger::Tool)
    }
}

/// A per-agent swarm-mode registry (v2 `AgentSwarmService` keyed by agent id).
#[derive(Clone, Default)]
pub struct SwarmModeRegistry {
    active: Arc<Mutex<HashMap<String, SwarmModeTrigger>>>,
}

impl SwarmModeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// v2 `AgentSwarmService.isActive`.
    pub fn is_active(&self, agent_id: &str) -> bool {
        let guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        guard.contains_key(agent_id)
    }

    pub fn trigger(&self, agent_id: &str) -> Option<SwarmModeTrigger> {
        let guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(agent_id).copied()
    }

    /// v2 `enter`: a no-op when already active — the first trigger wins.
    pub fn enter(&self, agent_id: &str, trigger: SwarmModeTrigger) -> bool {
        let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if guard.contains_key(agent_id) {
            return false;
        }
        guard.insert(agent_id.to_string(), trigger);
        true
    }

    /// v2 `exit`. Returns the trigger that was active, if any.
    pub fn exit(&self, agent_id: &str) -> Option<SwarmModeTrigger> {
        let mut guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(agent_id)
    }
}

/// The process-wide swarm-mode registry.
///
/// v2 holds the mode per agent scope (a scoped service). The native engine has
/// no DI scopes, so the equivalent is one registry keyed by agent id, shared
/// the same way `CANCEL_MAP` / `BTW_CANCEL_MAP` are shared.
pub fn swarm_mode_registry() -> &'static SwarmModeRegistry {
    static REGISTRY: std::sync::OnceLock<SwarmModeRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(SwarmModeRegistry::new)
}

/// v2 `AgentSwarmTool.execution` opens the mode with the `tool` trigger before
/// running the batch (`agentSwarmTool.ts:128`).
pub fn enter_tool_swarm(callbacks: &dyn crate::callbacks::HostCallbacks, agent_id: &str) -> bool {
    set_swarm_mode(callbacks, agent_id, Some(SwarmModeTrigger::Tool))
}

/// v2 `AgentSwarmService`'s `TurnEnded` subscription: a swarm opened by the
/// tool or by a task closes itself at turn end.
pub fn exit_tool_swarm_at_turn_end(
    callbacks: &dyn crate::callbacks::HostCallbacks,
    agent_id: &str,
) -> bool {
    let Some(trigger) = swarm_mode_registry().trigger(agent_id) else {
        return false;
    };
    if !trigger.auto_exits_at_turn_end() {
        return false;
    }
    set_swarm_mode(callbacks, agent_id, None)
}

/// The single writer of swarm-mode state.
///
/// v2 keeps the mode in the per-agent `swarmKey` state, and the two reducers
/// on it (`swarmOps.ts:40-47`) are the only things that ever change it: they
/// emit the durable record *and* the `AgentStatusUpdated` the host folds. This
/// is that pair, with the state itself held in [`swarm_mode_registry`] because
/// the native engine has no per-agent DI scope.
///
/// `desired = None` exits. A no-op change (already in the target state) emits
/// nothing — v2's `enter` returns early on an active mode and its `exit`
/// returns early on an inactive one, so the transition events are edge
/// triggered on both ends. Returns whether the mode actually changed.
pub fn set_swarm_mode(
    callbacks: &dyn crate::callbacks::HostCallbacks,
    agent_id: &str,
    desired: Option<SwarmModeTrigger>,
) -> bool {
    match desired {
        Some(trigger) => {
            if !swarm_mode_registry().enter(agent_id, trigger) {
                return false;
            }
            callbacks.emit_event(swarm_mode_enter_event(agent_id, trigger));
            callbacks.emit_event(swarm_mode_status_event(agent_id, true));
            true
        }
        None => {
            if swarm_mode_registry().exit(agent_id).is_none() {
                return false;
            }
            callbacks.emit_event(swarm_mode_exit_event(agent_id));
            callbacks.emit_event(swarm_mode_status_event(agent_id, false));
            true
        }
    }
}

/// The durable mode events v2 emits (`swarmOps.ts`). The host replays these
/// to rebuild mode state, so they carry the agent id and the trigger.
pub fn swarm_mode_enter_event(agent_id: &str, trigger: SwarmModeTrigger) -> serde_json::Value {
    serde_json::json!({
        "type": "swarm_mode.enter",
        "agentId": agent_id,
        "trigger": trigger.as_str(),
    })
}

/// v2 `swarmModeExitSchema` is `z.object({ agentId: z.string() })` — the exit
/// record carries no trigger; the *enter* record is where it is recorded.
pub fn swarm_mode_exit_event(agent_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "swarm_mode.exit",
        "agentId": agent_id,
    })
}

/// The `AgentStatusUpdated` v2's state reducer emits alongside each mode event
/// (`swarmOps.ts:41,45`). It is edge triggered, not a full status snapshot:
/// the host folds `swarmMode` onto its own state and leaves every other field
/// it already knows alone.
pub fn swarm_mode_status_event(agent_id: &str, active: bool) -> serde_json::Value {
    serde_json::json!({
        "type": "agent.status.updated",
        "agentId": agent_id,
        "swarmMode": active,
    })
}

/// Why a model response's tool-call batch is refused (v2
/// `AgentSwarmService.onBeforeExecuteTool`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwarmVeto {
    /// More than one `AgentSwarm` in a single response.
    MultipleSwarms {
        /// Whether the batch also carried other tools.
        with_other_tools: bool,
    },
    /// Exactly one `AgentSwarm`, but mixed with other tool calls.
    MixedWithOtherTools,
}

/// The gate itself: pure over the batch's tool names, so it is testable
/// without a turn loop.
///
/// v2 only vetoes when the batch actually conflicts: a lone `AgentSwarm`
/// (with or without nothing else) is fine, and a batch with no
/// `AgentSwarm` is untouched.
pub fn veto_swarm_batch(tool_names: &[&str]) -> Option<SwarmVeto> {
    // Accept both the canonical and the snake_case spelling the tool
    // dispatcher matches on (`tools/mod.rs` lowercases and strips `_`).
    let is_swarm = |name: &str| {
        let normalized = name.to_ascii_lowercase().replace('_', "");
        normalized == "agentswarm"
    };
    let swarm_count = tool_names.iter().filter(|n| is_swarm(n)).count();
    if swarm_count == 0 {
        return None;
    }
    let others = tool_names.len() - swarm_count;
    if swarm_count > 1 {
        return Some(SwarmVeto::MultipleSwarms {
            with_other_tools: others > 0,
        });
    }
    if others > 0 {
        return Some(SwarmVeto::MixedWithOtherTools);
    }
    None
}

/// The refusal text the model sees, mirroring v2's two messages.
pub fn veto_message(veto: SwarmVeto) -> String {
    match veto {
        SwarmVeto::MultipleSwarms { with_other_tools } => {
            let suffix = if with_other_tools {
                " AgentSwarm also must not be combined with other tools in the same response."
            } else {
                ""
            };
            format!(
                "AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are \
                 not forbidden, but issue them sequentially: call one AgentSwarm, wait for its \
                 result, then call the next; or merge the work into a single AgentSwarm when \
                 one swarm can cover it.{suffix}"
            )
        }
        SwarmVeto::MixedWithOtherTools => {
            "AgentSwarm must be the only tool call in a model response. Retry with a single \
             AgentSwarm call by itself, then call any other tools after it returns."
                .to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{
        BoxFuture, LlmChatRequest, LlmChatResponse, PermissionCheckRequest, PermissionDecision,
        StateReadRequest, StateReadResponse, StateWriteRequest, StateWriteResponse,
        ToolExecuteRequest, ToolExecuteResponse,
    };
    use std::sync::Mutex as StdMutex;

    /// Records every `emit_event` so the mode transition's two events can be
    /// asserted in order.
    struct EventProbe(StdMutex<Vec<serde_json::Value>>);

    impl EventProbe {
        fn new() -> Self {
            Self(StdMutex::new(Vec::new()))
        }

        fn events(&self) -> Vec<serde_json::Value> {
            self.0.lock().unwrap().clone()
        }
    }

    impl crate::callbacks::HostCallbacks for EventProbe {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn state_read(
            &self,
            _: StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn state_write(
            &self,
            _: StateWriteRequest,
        ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn emit_event(&self, event: serde_json::Value) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[test]
    fn a_lone_swarm_call_is_allowed() {
        assert_eq!(veto_swarm_batch(&["AgentSwarm"]), None);
    }

    #[test]
    fn a_batch_without_swarm_is_untouched() {
        assert_eq!(veto_swarm_batch(&["Bash", "Read"]), None);
        assert_eq!(veto_swarm_batch(&[]), None);
    }

    #[test]
    fn two_swarms_are_vetoed() {
        assert_eq!(
            veto_swarm_batch(&["AgentSwarm", "AgentSwarm"]),
            Some(SwarmVeto::MultipleSwarms {
                with_other_tools: false
            })
        );
    }

    #[test]
    fn a_swarm_mixed_with_other_tools_is_vetoed() {
        assert_eq!(
            veto_swarm_batch(&["AgentSwarm", "Bash"]),
            Some(SwarmVeto::MixedWithOtherTools)
        );
    }

    #[test]
    fn two_swarms_plus_others_reports_the_mix() {
        assert_eq!(
            veto_swarm_batch(&["AgentSwarm", "AgentSwarm", "Read"]),
            Some(SwarmVeto::MultipleSwarms {
                with_other_tools: true
            })
        );
    }

    #[test]
    fn the_snake_case_spelling_is_recognized() {
        assert_eq!(
            veto_swarm_batch(&["agent_swarm", "Bash"]),
            Some(SwarmVeto::MixedWithOtherTools)
        );
    }

    #[test]
    fn mode_is_per_agent_and_first_trigger_wins() {
        let reg = SwarmModeRegistry::new();
        assert!(!reg.is_active("main"));
        assert!(reg.enter("main", SwarmModeTrigger::Tool));
        // Already active: the second enter is a no-op and does not re-trigger.
        assert!(!reg.enter("main", SwarmModeTrigger::Manual));
        assert_eq!(reg.trigger("main"), Some(SwarmModeTrigger::Tool));
        // A different agent has its own mode.
        assert!(!reg.is_active("subagent-1"));
        assert_eq!(reg.exit("main"), Some(SwarmModeTrigger::Tool));
        assert!(!reg.is_active("main"));
    }

    #[test]
    fn trigger_wire_names_match_v2() {
        assert_eq!(SwarmModeTrigger::Manual.as_str(), "manual");
        assert_eq!(SwarmModeTrigger::Task.as_str(), "task");
        assert_eq!(SwarmModeTrigger::Tool.as_str(), "tool");
    }

    /// The two wiring entry points (`enter_tool_swarm` /
    /// `exit_tool_swarm_at_turn_end`) must round-trip through the shared
    /// registry *and* announce both edges — the tool opens the mode, turn end
    /// closes it, and the host learns about each from the emitted events.
    #[test]
    fn the_tool_trigger_opens_and_turn_end_closes_the_mode() {
        let agent = "wiring-test-agent";
        // Start from a known state: a previous test may have left it open.
        swarm_mode_registry().exit(agent);
        let probe = EventProbe::new();

        assert!(!swarm_mode_registry().is_active(agent));
        assert!(enter_tool_swarm(&probe, agent));
        assert_eq!(
            swarm_mode_registry().trigger(agent),
            Some(SwarmModeTrigger::Tool)
        );
        assert_eq!(
            probe.events(),
            vec![
                serde_json::json!({
                    "type": "swarm_mode.enter",
                    "agentId": agent,
                    "trigger": "tool",
                }),
                serde_json::json!({
                    "type": "agent.status.updated",
                    "agentId": agent,
                    "swarmMode": true,
                }),
            ],
            "opening the mode emits the durable record then the status the host folds"
        );

        // Turn end closes a tool-opened swarm.
        probe.0.lock().unwrap().clear();
        assert!(exit_tool_swarm_at_turn_end(&probe, agent));
        assert!(!swarm_mode_registry().is_active(agent));
        assert_eq!(
            probe.events(),
            vec![
                serde_json::json!({ "type": "swarm_mode.exit", "agentId": agent }),
                serde_json::json!({
                    "type": "agent.status.updated",
                    "agentId": agent,
                    "swarmMode": false,
                }),
            ],
            "closing the mode emits the same pair with swarmMode false"
        );
    }

    /// A manually opened swarm must survive turn end — that is the whole point
    /// of `shouldAutoExit`. Nothing is emitted either, so the host is not told
    /// about a transition that did not happen.
    #[test]
    fn a_manual_swarm_survives_turn_end() {
        let agent = "manual-wiring-test-agent";
        swarm_mode_registry().exit(agent);
        let probe = EventProbe::new();

        assert!(set_swarm_mode(
            &probe,
            agent,
            Some(SwarmModeTrigger::Manual)
        ));
        probe.0.lock().unwrap().clear();
        assert!(!exit_tool_swarm_at_turn_end(&probe, agent));
        assert!(
            probe.events().is_empty(),
            "a manual swarm stays open, so no exit event is emitted"
        );
        assert!(
            swarm_mode_registry().is_active(agent),
            "a manual swarm stays open across turn end"
        );
        swarm_mode_registry().exit(agent);
    }

    /// Both edges are edge triggered (v2 `enter` returns early on an active
    /// mode, `exit` on an inactive one), so a redundant call stays silent.
    #[test]
    fn a_redundant_mode_change_emits_nothing() {
        let agent = "edge-trigger-agent";
        swarm_mode_registry().exit(agent);
        let probe = EventProbe::new();

        assert!(set_swarm_mode(
            &probe,
            agent,
            Some(SwarmModeTrigger::Manual)
        ));
        probe.0.lock().unwrap().clear();

        assert!(!set_swarm_mode(&probe, agent, Some(SwarmModeTrigger::Task)));
        assert!(probe.events().is_empty(), "re-entering emits nothing");

        assert!(set_swarm_mode(&probe, agent, None));
        probe.0.lock().unwrap().clear();

        assert!(!set_swarm_mode(&probe, agent, None));
        assert!(probe.events().is_empty(), "re-exiting emits nothing");
    }

    /// v2's exit record is `z.object({ agentId })` — carrying the trigger on it
    /// would not match the schema the host's cold fold validates against.
    #[test]
    fn the_exit_record_carries_no_trigger() {
        let event = swarm_mode_exit_event("main");
        assert_eq!(event["type"], "swarm_mode.exit");
        assert_eq!(event["agentId"], "main");
        assert!(
            event.get("trigger").is_none(),
            "v2's swarmModeExitSchema declares only agentId"
        );
    }
}
