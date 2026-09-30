//! Native execution of the `AgentSwarm` orchestration tool.
//!
//! Direct native port of `agent-core-v2`'s `AgentSwarmTool` (swarm feature).
//!
//! This module is deliberately thin: it parses and validates the tool's
//! arguments, builds the task list, and renders the result XML. Everything
//! that *owns* the run — member spawn/resume/retry, cancellation, lifecycle
//! events — lives in the swarm layer ([`crate::swarm::service`]), mirroring
//! v2 where `AgentSwarmTool` delegates to `ISessionSwarmService`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::i18n::{LocalizedText, i18n_params};
use crate::subagent::SubagentManager;
use crate::subagent::types::ParentCancel;
use crate::swarm::agent_run_batch::{
    AbortReason, AbortSignal, AgentRunResult, AgentRunState, AgentRunStatus, AgentRunTask,
    AgentRunTaskKind, SubagentSpawnPlan,
};
use crate::swarm::service::SwarmLauncher;
use crate::turn_loop::types::{ExecutableToolResult, LoopTurnStopReason, ToolInfo};

/// The v2 default profile name (`DEFAULT_PROFILE_NAME`).
const DEFAULT_SUBAGENT_TYPE: &str = "coder";

/// The swarm timeout default (v2 `DEFAULT_SWARM_TIMEOUT_MS`: 2h). Swarms
/// resolve only this knob — never the subagent timeout (whose default lives
/// on `agent_tool::DEFAULT_SUBAGENT_TIMEOUT_MS`).
const DEFAULT_SWARM_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000;

/// Placeholder for subagent prompts (`PROMPT_TEMPLATE_PLACEHOLDER`).
const PROMPT_TEMPLATE_PLACEHOLDER: &str = "{{item}}";

/// Maximum number of subagents in a single swarm call (`MAX_AGENT_SWARM_SUBAGENTS`).
const MAX_AGENT_SWARM_SUBAGENTS: usize = 128;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct AgentSwarmToolInput {
    description: Option<String>,
    subagent_type: Option<String>,
    prompt_template: Option<String>,
    items: Option<Vec<String>>,
    resume_agent_ids: Option<HashMap<String, String>>,
    fork: Option<bool>,
    model: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SwarmTaskSpec {
    pub index: usize,
    pub item: Option<String>,
    pub is_resume: bool,
}

fn err_result(msg: impl Into<String>) -> ExecutableToolResult {
    ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: msg.into(),
        is_error: true,
        note: None,
        display: None,
    }
}

/// The launch-shape rejections, as engine-owned text (v2 raises the same five
/// `VALIDATION_FAILED` errors, verbatim in English, at
/// `agentSwarmTool.ts:225-275`).
///
/// Localized because they are the tool's result and land in the transcript
/// where a user reads them. The *tool description* and the model-facing
/// exclusivity refusal stay English: both are model input rather than a
/// failure surface.
fn invalid_args(reason: &str) -> String {
    LocalizedText::with_params(
        "engine.tools.agentSwarm.invalidArgs",
        i18n_params!["reason" => reason],
    )
    .render()
}

fn description_required() -> String {
    LocalizedText::new("engine.tools.agentSwarm.descriptionRequired").render()
}

fn min_inputs() -> String {
    LocalizedText::new("engine.tools.agentSwarm.minInputs").render()
}

fn max_subagents(max: usize) -> String {
    LocalizedText::with_params(
        "engine.tools.agentSwarm.maxSubagents",
        i18n_params!["max" => max.to_string()],
    )
    .render()
}

fn prompt_template_required() -> String {
    LocalizedText::new("engine.tools.agentSwarm.promptTemplateRequired").render()
}

fn placeholder_required(placeholder: &str) -> String {
    LocalizedText::with_params(
        "engine.tools.agentSwarm.placeholderRequired",
        i18n_params!["placeholder" => placeholder],
    )
    .render()
}

fn duplicate_prompts(previous: usize, current: usize) -> String {
    LocalizedText::with_params(
        "engine.tools.agentSwarm.duplicatePrompts",
        i18n_params![
            "previous" => previous.to_string(),
            "current" => current.to_string()
        ],
    )
    .render()
}

fn ok_result(msg: impl Into<String>) -> ExecutableToolResult {
    ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: msg.into(),
        is_error: false,
        note: None,
        display: None,
    }
}

fn escape_xml_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render_swarm_summary(completed: usize, failed: usize, aborted: usize) -> String {
    let mut parts = Vec::new();
    if completed > 0 {
        parts.push(format!("completed: {completed}"));
    }
    if failed > 0 {
        parts.push(format!("failed: {failed}"));
    }
    if aborted > 0 {
        parts.push(format!("aborted: {aborted}"));
    }
    if parts.is_empty() {
        "completed: 0".into()
    } else {
        parts.join(", ")
    }
}

fn render_swarm_results(results: &[AgentRunResult<SwarmTaskSpec>]) -> String {
    let completed = results
        .iter()
        .filter(|r| r.status == AgentRunStatus::Completed)
        .count();
    let failed = results
        .iter()
        .filter(|r| r.status == AgentRunStatus::Failed)
        .count();
    let aborted = results
        .iter()
        .filter(|r| r.status == AgentRunStatus::Aborted)
        .count();

    // A member that stopped for a budget, a breaker or a pause has *partial*
    // output, so the batch as a whole is unfinished even though every task
    // carries `Completed`. v2 offers the resume hint on exactly this
    // condition (`stopReason !== undefined`).
    let should_render_resume_hint = (results
        .iter()
        .any(|r| r.status != AgentRunStatus::Completed)
        || results.iter().any(|r| r.stop_reason.is_some()))
        && results.iter().any(|r| r.agent_id.is_some());

    let mut lines = Vec::new();
    lines.push("<agent_swarm_result>".to_string());
    lines.push(format!(
        "<summary>{}</summary>",
        render_swarm_summary(completed, failed, aborted)
    ));

    if should_render_resume_hint {
        lines.push(
            "<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>".to_string(),
        );
    }

    for res in results {
        let agent_id_attr = match &res.agent_id {
            Some(id) if !id.is_empty() => format!(" agent_id=\"{}\"", escape_xml_attribute(id)),
            _ => String::new(),
        };
        let mode_attr = if res.task.data.is_resume {
            " mode=\"resume\""
        } else {
            ""
        };
        let item_attr = match &res.task.data.item {
            Some(item) => format!(" item=\"{}\"", escape_xml_attribute(item)),
            None => String::new(),
        };
        let state_attr = match res.state {
            Some(AgentRunState::Started) => " state=\"started\"",
            Some(AgentRunState::NotStarted) => " state=\"not_started\"",
            None => "",
        };
        let outcome = match res.status {
            AgentRunStatus::Completed => "completed",
            AgentRunStatus::Failed => "failed",
            AgentRunStatus::Aborted => "aborted",
        };
        // The stop reason is what separates "the model answered" from "the
        // model was cut off mid-answer". Without it the model reads a partial
        // result as a finished one and moves on.
        let stop_reason_attr = match res.stop_reason.as_ref() {
            Some(reason) => format!(" stop_reason=\"{}\"", stop_reason_wire_name(reason)),
            None => String::new(),
        };
        // Escape the body's XML tags: a subagent's result (or an error string)
        // is untrusted text, and a literal `</subagent>` in it would otherwise
        // close the element early and corrupt the whole result block.
        let body =
            crate::tools::skill::escape_xml_tags(if res.status == AgentRunStatus::Completed {
                res.result.as_deref().unwrap_or("")
            } else {
                res.error.as_deref().unwrap_or("unknown error")
            });

        lines.push(format!(
            "<subagent{mode_attr}{agent_id_attr}{item_attr}{state_attr}{stop_reason_attr} outcome=\"{outcome}\">{body}</subagent>"
        ));
    }

    lines.push("</agent_swarm_result>".to_string());
    lines.join("\n")
}

/// The stable wire spelling of a stop reason, matching the `LoopTurnStopReason`
/// variant names the engine already uses on the wire (v2 renders the same
/// camelCase tokens).
fn stop_reason_wire_name(reason: &LoopTurnStopReason) -> &'static str {
    match reason {
        LoopTurnStopReason::EndTurn => "end_turn",
        LoopTurnStopReason::MaxTokens => "max_tokens",
        LoopTurnStopReason::Filtered => "filtered",
        LoopTurnStopReason::Paused => "paused",
        LoopTurnStopReason::Unknown => "unknown",
        LoopTurnStopReason::Aborted => "aborted",
        LoopTurnStopReason::BudgetLimited => "budget_limited",
        LoopTurnStopReason::RepeatBreaker => "repeat_breaker",
        LoopTurnStopReason::MaxSteps => "max_steps",
    }
}

/// Execute the `AgentSwarm` tool natively.
///
/// Returns `None` if the call should fall back to the host runtime
/// (e.g. unknown subagent profiles, or a turn without an injected runtime).
/// `_timeout_ms` is the dispatch's `Agent` timeout, kept for call-site
/// symmetry but ignored: swarms resolve only the host swarm timeout
/// (v2 `resolveSwarmTimeoutMs`), never the subagent timeout.
pub async fn execute_agent_swarm(
    manager: &Arc<SubagentManager>,
    args: &Value,
    _timeout_ms: Option<u64>,
    parent_cancel: Option<&ParentCancel>,
    tool_call_id: Option<&str>,
    pool: Option<&crate::subagent::secondary::SecondaryModelRuntime>,
) -> Option<ExecutableToolResult> {
    // The engine absorbs the `model` parameter with or without a pool: with
    // one it binds the requested alias, without one only `primary` (or no
    // model) is legal — anything else is the v2 no-pool error.
    let requested = args.get("model").and_then(|value| value.as_str());
    let runtime = manager.runtime().await?;
    let item_llm = match pool {
        Some(pool) => match pool.resolve(&runtime.llm, requested) {
            Ok(binding) => Some(binding.llm),
            Err(message) => return Some(err_result(message)),
        },
        None => {
            if let Err(message) =
                crate::subagent::secondary::SecondaryModelRuntime::resolve_without_pool(requested)
            {
                return Some(err_result(message));
            }
            None
        }
    };

    let input: AgentSwarmToolInput = match serde_json::from_value(args.clone()) {
        Ok(parsed) => parsed,
        Err(e) => return Some(err_result(invalid_args(&e.to_string()))),
    };

    let description = match input.description {
        Some(d) if !d.trim().is_empty() => d.trim().to_string(),
        _ => return Some(err_result(description_required())),
    };

    let resume_entries: Vec<(String, String)> = input
        .resume_agent_ids
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .filter(|(k, v)| !k.is_empty() && !v.is_empty())
        .collect();

    let items: Vec<String> = input
        .items
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let resume_count = resume_entries.len();
    let item_count = items.len();

    let subagent_type = input
        .subagent_type
        .as_deref()
        .unwrap_or(DEFAULT_SUBAGENT_TYPE)
        .trim();
    if item_count > 0
        && subagent_type != "self"
        && manager.get_definition(subagent_type).await.is_none()
    {
        // Unknown profile: fall back to host so plugin-defined profiles work.
        return None;
    }
    let total_count = resume_count + item_count;

    if resume_count == 0 && item_count < 2 {
        return Some(err_result(min_inputs()));
    }

    if total_count > MAX_AGENT_SWARM_SUBAGENTS {
        return Some(err_result(max_subagents(MAX_AGENT_SWARM_SUBAGENTS)));
    }

    let prompt_template = input
        .prompt_template
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if item_count > 0 && prompt_template.is_none() {
        return Some(err_result(prompt_template_required()));
    }

    if let Some(template) = &prompt_template
        && !template.contains(PROMPT_TEMPLATE_PLACEHOLDER)
    {
        return Some(err_result(placeholder_required(
            PROMPT_TEMPLATE_PLACEHOLDER,
        )));
    }

    let mut seen_prompts: HashMap<String, usize> = HashMap::new();
    let mut tasks: Vec<AgentRunTask<SwarmTaskSpec>> = Vec::new();
    let parent_tool_call_id = tool_call_id.unwrap_or("swarm").to_string();

    // v2 `AgentSwarmTool.execution` opens swarm mode with the `tool` trigger
    // before running the batch (`agentSwarmTool.ts:128`). The mode is what
    // makes the swarm a feature the agent is *in*, rather than one more tool
    // it called; the turn-end hook in `run_turn` closes it again. Entering
    // emits the mode event pair, so the host's indicator tracks it.
    let caller_agent_id = crate::tools::CALLER_AGENT_ID
        .try_with(|id| id.clone())
        .unwrap_or_else(|_| crate::callbacks::MAIN_AGENT_ID.to_string());
    crate::swarm::mode::enter_tool_swarm(runtime.callbacks.as_ref(), &caller_agent_id);
    // Host-resolved swarm timeout (v2 `resolveSwarmTimeoutMs`): a dedicated
    // knob — unlike `Agent` turns, swarms never inherit the subagent
    // timeout. `0` = "no timeout armed" (v2 `taskService`), so it maps to
    // the never-expiring sentinel rather than the 2h default.
    let timeout = Some(Duration::from_millis(match manager.swarm_timeout_ms() {
        Some(0) => u64::MAX,
        Some(ms) => ms,
        None => DEFAULT_SWARM_TIMEOUT_MS,
    }));

    let batch_signal = AbortSignal::new();
    if let Some(parent) = parent_cancel {
        let parent = parent.clone();
        let signal_clone = batch_signal.clone();
        tokio::spawn(async move {
            parent.wait().await;
            signal_clone.abort(Some(AbortReason::UserCancellation));
        });
    }

    for (agent_id, prompt) in resume_entries {
        let idx = tasks.len() + 1;
        // v2 `getSwarmItem`: recover the `{{item}}` this member was spawned
        // for, so a resumed row is labelled with the work it continues.
        // Best-effort, exactly as v2: an id that is not one of this caller's
        // subagents simply has no item here — the ownership refusal happens in
        // the swarm service when the batch resumes it.
        let item = manager
            .parent_of(&agent_id)
            .await
            .filter(|parent| parent.agent_id == caller_agent_id)
            .and_then(|parent| parent.swarm_item);
        tasks.push(AgentRunTask {
            data: SwarmTaskSpec {
                index: idx,
                item: item.clone(),
                is_resume: true,
            },
            kind: AgentRunTaskKind::Resume {
                resume_agent_id: agent_id,
            },
            profile_name: "subagent".into(),
            parent_tool_call_id: parent_tool_call_id.clone(),
            parent_tool_call_uuid: None,
            prompt,
            description: format!("{description} #{idx} (resume)"),
            swarm_index: Some(idx),
            swarm_item: item,
            run_in_background: false,
            timeout,
            signal: Some(batch_signal.clone()),
            plan: None,
        });
    }

    let is_fork = input.fork.unwrap_or(false);
    if is_fork {
        // v2 refuses `fork` outright when the flag is off
        // (`FORK_EXPERIMENTAL_UNAVAILABLE`); the flag defaults ON here (see
        // `subagent::fork::subagent_fork_enabled`), so this is the opt-out
        // path rather than the default.
        if !crate::subagent::fork::subagent_fork_enabled() {
            return Some(err_result(
                crate::subagent::fork::FORK_EXPERIMENTAL_UNAVAILABLE,
            ));
        }
        // v2 `AgentSwarmTool.runSwarm` runs the same `forkIncompatibility` gate
        // the `Agent` tool runs: a fork inherits the caller's profile and model
        // so the prompt prefix cache is reused, so asking for a different
        // `subagent_type`/`model` is a contradiction, not a preference. Resumed
        // subagents are never forked, so a non-empty resume is refused outright
        // (v2 `FORK_WITH_RESUME_UNAVAILABLE`).
        if resume_count > 0 {
            return Some(err_result(
                crate::subagent::fork::FORK_WITH_RESUME_UNAVAILABLE,
            ));
        }
        if let Some(err) = crate::subagent::fork_incompatibility(
            None,
            input.subagent_type.as_deref(),
            requested,
            DEFAULT_SUBAGENT_TYPE,
            None,
        ) {
            return Some(err_result(err));
        }
    }
    let inherited_history = if is_fork {
        crate::tools::CURRENT_CONVERSATION_HISTORY
            .try_with(|slot| slot.lock().unwrap().clone())
            .ok()
            .or_else(|| {
                crate::tools::CALLER_AGENT_ID
                    .try_with(|id| manager.get_foreground_history(id))
                    .ok()
                    .flatten()
            })
    } else {
        None
    };

    if let Some(template) = prompt_template {
        for (idx_offset, item) in items.into_iter().enumerate() {
            let prompt = template.replace(PROMPT_TEMPLATE_PLACEHOLDER, &item);
            let item_num = idx_offset + 1;
            if let Some(prev) = seen_prompts.get(&prompt) {
                return Some(err_result(duplicate_prompts(*prev, item_num)));
            }
            seen_prompts.insert(prompt.clone(), item_num);

            let idx = tasks.len() + 1;
            tasks.push(AgentRunTask {
                data: SwarmTaskSpec {
                    index: idx,
                    item: Some(item.clone()),
                    is_resume: false,
                },
                kind: AgentRunTaskKind::Spawn,
                profile_name: subagent_type.to_string(),
                parent_tool_call_id: parent_tool_call_id.clone(),
                parent_tool_call_uuid: None,
                prompt,
                description: format!("{description} #{idx} ({subagent_type})"),
                swarm_index: Some(idx),
                swarm_item: Some(item),
                run_in_background: false,
                timeout,
                signal: Some(batch_signal.clone()),
                plan: Some(SubagentSpawnPlan {
                    profile_name: subagent_type.to_string(),
                    model: String::new(),
                    thinking: None,
                    fork: is_fork,
                }),
            });
        }
    }

    // The swarm layer owns the run: the tool hands it a launcher and the
    // task list, and gets per-member results back (v2: `AgentSwarmTool`
    // delegates to `ISessionSwarmService.run`).
    let launcher = Arc::new(SwarmLauncher {
        manager: manager.clone(),
        parent_cancel: parent_cancel.cloned(),
        inherited_history,
        llm: item_llm,
        callbacks: runtime.callbacks.clone(),
        caller_agent_id: caller_agent_id.clone(),
        // One sink for the whole batch, so the terminalizer it holds is
        // per-run: a member that is rate-limited and retried reports one
        // terminal event, not one per attempt.
        sink: Arc::new(crate::swarm::service::CallbackSink::new(
            runtime.callbacks.clone(),
        )),
    });

    let results = crate::swarm::service::SwarmRun::new(launcher, tasks, batch_signal, None)
        .run()
        .await;

    let results = match results {
        Ok(r) => r,
        Err(e) => return Some(err_result(e)),
    };
    Some(ok_result(render_swarm_results(&results)))
}

/// Tool definition for `AgentSwarm`.
pub fn agent_swarm_tool_def(
    pool: Option<&crate::subagent::secondary::SecondaryModelRuntime>,
) -> ToolInfo {
    // v2 `tools/agent-swarm/agent-swarm.md`, verbatim: the description the
    // model reads.
    let mut description = r#"Launch multiple subagents from one prompt template, existing agent resumes, or both.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly `{{item}}`. For example, with `prompt_template` set to `Review {{item}} for likely regressions.` and `items` set to `["src/a.ts", "src/b.ts"]`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate `Agent` calls in one message instead.

Use `resume_agent_ids` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually `continue` if no extra information is needed). You may combine `resume_agent_ids` with `items` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in `items`.

Each of these is enforced — a violation is rejected before any subagent starts: provide at least 2 `items` unless you pass `resume_agent_ids`; whenever `items` are present, `prompt_template` is required and must contain `{{item}}`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).

Use enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.

If `AgentSwarm` is called, that call must be the only tool call in the response."#
        .to_string();
    // v2 `buildSubagentModelDescriptions`: a forced pool exposes no choice,
    // so it appends neither the listing nor (below) the `model` parameter.
    if let Some(pool) = pool
        && pool.exposes_choice()
    {
        description.push_str("\n\n");
        description.push_str(&pool.description());
    }
    let mut input_schema = serde_json::json!({
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Short description for the whole swarm."
            },
            "subagent_type": {
                "type": "string",
                "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted."
            },
            "prompt_template": {
                "type": "string",
                "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value."
            },
            "items": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Values used to fill {{item}}. Each item launches one new subagent."
            },
            "resume_agent_ids": {
                "type": "object",
                "additionalProperties": { "type": "string" },
                "description": "Flat object: keys are existing subagent agent_id strings, values are continuation prompts."
            },
            "fork": {
                "type": "boolean",
                "description": "When true, start each item-spawned subagent from a snapshot of the calling agent's completed conversation history."
            }
        },
        "required": ["description"]
    });
    if let Some(pool) = pool
        && pool.exposes_choice()
        && let Some(properties) = input_schema
            .get_mut("properties")
            .and_then(|properties| properties.as_object_mut())
    {
        properties.insert(
            "model".into(),
            serde_json::json!({
                "type": "string",
                "description": "Which model to run the item-spawned subagents on: one of the aliases listed under \"Available models\" in this tool description, or \"primary\" for the main model you are running on. When omitted, the configured default model is used."
            }),
        );
    }
    // v2 `stripSubagentForkParameter`: the parameter is hidden from the model
    // while the flag is off, so it is never offered. On by default here, so
    // this only bites an explicit opt-out.
    if !crate::subagent::fork::subagent_fork_enabled()
        && let Some(properties) = input_schema
            .get_mut("properties")
            .and_then(|properties| properties.as_object_mut())
    {
        properties.remove("fork");
    }
    ToolInfo {
        name: "AgentSwarm".into(),
        description,
        input_schema,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The tests drive the launcher and the batch types directly, so they need
    // the scheduler surface the tool body no longer imports.
    use crate::rpc::types::BoxFuture;
    use crate::swarm::agent_run_batch::{
        AgentRunAttemptOptions, AgentRunBatchLauncher, AgentSpawnAttemptOptions,
    };

    #[test]
    fn test_swarm_tool_def_shape() {
        let def = agent_swarm_tool_def(None);
        assert_eq!(def.name, "AgentSwarm");
        assert!(def.description.contains("{{item}}"));
        assert!(def.input_schema.get("properties").is_some());
    }

    #[test]
    fn test_swarm_def_advertises_the_pool_only_when_a_choice_is_offered() {
        fn pool(force: bool) -> crate::subagent::secondary::SecondaryModelRuntime {
            crate::subagent::secondary::SecondaryModelRuntime::new(
                crate::rpc::types::SecondaryModelPool {
                    force,
                    default_model: "fast".into(),
                    caller_model_alias: None,
                    models: vec![crate::rpc::types::SecondaryModelEntry {
                        alias: "fast".into(),
                        hint: String::new(),
                        llm: Default::default(),
                    }],
                },
                std::collections::HashMap::new(),
            )
        }

        let offered = agent_swarm_tool_def(Some(&pool(false)));
        assert!(
            offered
                .description
                .contains("Available models (pass via model):")
        );
        assert!(
            offered
                .input_schema
                .get("properties")
                .and_then(|properties| properties.get("model"))
                .is_some()
        );

        let forced = agent_swarm_tool_def(Some(&pool(true)));
        assert!(
            !forced.description.contains("Available models"),
            "{}",
            forced.description
        );
        assert!(
            forced
                .input_schema
                .get("properties")
                .and_then(|properties| properties.get("model"))
                .is_none()
        );

        let bare = agent_swarm_tool_def(None);
        assert!(!bare.description.contains("Available models"));
        assert!(
            bare.input_schema
                .get("properties")
                .and_then(|properties| properties.get("model"))
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_swarm_rejects_an_explicit_model_without_a_pool() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "model override",
            "items": ["a", "b"],
            "prompt_template": "check {{item}}",
            "model": "k3"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, None, None)
            .await
            .expect("no-pool model overrides are error results, not host fallbacks");
        assert!(res.is_error);
        assert!(
            res.content.contains("no [secondary_model.models] pool"),
            "{}",
            res.content
        );
    }

    #[test]
    fn test_render_swarm_results() {
        let results = vec![
            AgentRunResult {
                task: AgentRunTask {
                    data: SwarmTaskSpec {
                        index: 1,
                        item: Some("fileA.rs".into()),
                        is_resume: false,
                    },
                    kind: AgentRunTaskKind::Spawn,
                    profile_name: "coder".into(),
                    parent_tool_call_id: "tc-1".into(),
                    parent_tool_call_uuid: None,
                    prompt: "check fileA.rs".into(),
                    description: "desc #1".into(),
                    swarm_index: Some(1),
                    swarm_item: Some("fileA.rs".into()),
                    run_in_background: false,
                    timeout: None,
                    signal: None,
                    plan: None,
                },
                agent_id: Some("subagent-1".into()),
                status: AgentRunStatus::Completed,
                state: Some(AgentRunState::Started),
                result: Some("checked fileA.rs OK".into()),
                usage: None,
                error: None,
                stop_reason: None,
            },
            AgentRunResult {
                task: AgentRunTask {
                    data: SwarmTaskSpec {
                        index: 2,
                        item: Some("fileB.rs".into()),
                        is_resume: false,
                    },
                    kind: AgentRunTaskKind::Spawn,
                    profile_name: "coder".into(),
                    parent_tool_call_id: "tc-1".into(),
                    parent_tool_call_uuid: None,
                    prompt: "check fileB.rs".into(),
                    description: "desc #2".into(),
                    swarm_index: Some(2),
                    swarm_item: Some("fileB.rs".into()),
                    run_in_background: false,
                    timeout: None,
                    signal: None,
                    plan: None,
                },
                agent_id: Some("subagent-2".into()),
                status: AgentRunStatus::Failed,
                state: Some(AgentRunState::Started),
                result: None,
                usage: None,
                error: Some("syntax error".into()),
                stop_reason: None,
            },
        ];

        let xml = render_swarm_results(&results);
        assert!(xml.contains("<agent_swarm_result>"));
        assert!(xml.contains("<summary>completed: 1, failed: 1</summary>"));
        assert!(xml.contains("<resume_hint>"));
        assert!(xml.contains(r#"<subagent agent_id="subagent-1" item="fileA.rs" state="started" outcome="completed">checked fileA.rs OK</subagent>"#));
        assert!(xml.contains(r#"<subagent agent_id="subagent-2" item="fileB.rs" state="started" outcome="failed">syntax error</subagent>"#));
        assert!(xml.contains("</agent_swarm_result>"));
    }

    /// A worker stopped by a budget or a breaker carries partial output. The
    /// XML has to say so, and the batch has to offer a resume — otherwise the
    /// model reads a truncated answer as finished work and stops there.
    #[test]
    fn render_marks_a_budget_stopped_member_as_unfinished() {
        let results = vec![AgentRunResult {
            task: AgentRunTask {
                data: SwarmTaskSpec {
                    index: 1,
                    item: Some("fileA.rs".into()),
                    is_resume: false,
                },
                kind: AgentRunTaskKind::Spawn,
                profile_name: "coder".into(),
                parent_tool_call_id: "tc-1".into(),
                parent_tool_call_uuid: None,
                prompt: "check fileA.rs".into(),
                description: "desc #1".into(),
                swarm_index: Some(1),
                swarm_item: Some("fileA.rs".into()),
                run_in_background: false,
                timeout: None,
                signal: None,
                plan: None,
            },
            agent_id: Some("subagent-1".into()),
            status: AgentRunStatus::Completed,
            state: Some(AgentRunState::Started),
            result: Some("partial: got through the first f".into()),
            usage: None,
            error: None,
            stop_reason: Some(LoopTurnStopReason::MaxSteps),
        }];

        let xml = render_swarm_results(&results);
        assert!(
            xml.contains(r#"stop_reason="max_steps""#),
            "the stop reason must reach the model: {xml}"
        );
        assert!(
            xml.contains("<resume_hint>"),
            "an early stop leaves the batch unfinished, so it must offer a resume: {xml}"
        );
    }

    use crate::callbacks::HostCallbacks;
    use crate::rpc::types::{
        AskQuestionRequest, AskQuestionResponse, ListToolsResponse, LlmChatRequest,
        LlmChatResponse, PermissionCheckRequest, PermissionDecision, TokenUsage,
        ToolExecuteRequest, ToolExecuteResponse,
    };
    use crate::turn_loop::types::{LLM, LLMChatParams, LLMChatResponse as TurnChatResponse};

    struct TestSummaryLlm;
    impl LLM for TestSummaryLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "test-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            Box::pin(async {
                Ok(TurnChatResponse {
                    content: "findings: reviewed OK".into(),
                    thinking: vec![],
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                    timing: None,
                })
            })
        }
    }

    struct TestNoopCallbacks;
    impl HostCallbacks for TestNoopCallbacks {
        fn llm_chat(
            &self,
            _: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn execute_tool(
            &self,
            _: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async {
                Ok(ToolExecuteResponse {
                    delivery: None,
                    stop_turn: false,
                    content: "ok".into(),
                    is_error: false,
                    note: None,
                })
            })
        }
        fn check_permission(
            &self,
            _: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }
        fn ask_question(
            &self,
            _: AskQuestionRequest,
        ) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
            Box::pin(async { Ok(ListToolsResponse { tools: vec![] }) })
        }
    }

    async fn manager_with_runtime() -> Arc<SubagentManager> {
        let mgr = Arc::new(SubagentManager::new());
        mgr.register_definition(crate::subagent::types::SubagentDefinition {
            name: "coder".into(),
            description: "Default coder subagent".into(),
            system_prompt: "You are coder.".into(),
            tools: vec![],
            disallowed_tools: vec![],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        })
        .await;
        mgr.set_runtime(Arc::new(TestSummaryLlm), Arc::new(TestNoopCallbacks), None)
            .await;
        mgr
    }

    /// Two profiles, so a test can ask for one that differs from the caller's
    /// default (`coder`) and reach the fork compatibility gate.
    async fn manager_with_runtime_with_profiles() -> Arc<SubagentManager> {
        let mgr = manager_with_runtime().await;
        mgr.register_definition(crate::subagent::types::SubagentDefinition {
            name: "reviewer".into(),
            description: "Reviewer subagent".into(),
            system_prompt: "You review.".into(),
            tools: vec![],
            disallowed_tools: vec![],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        })
        .await;
        mgr
    }

    /// A swarm worker's tool call must reach the host attributed to the
    /// worker, not to the main agent.
    ///
    /// The host drops any event whose `agentId` is not `main` into the worker's
    /// own card (`routeChildAgentEvent`); an event that arrives as `main` is
    /// announced in the main transcript instead, where its card ends the main
    /// agent's reasoning mid-sentence. `AgentSwarm` was the reported trigger,
    /// so drive the real launcher rather than the manager directly.
    #[tokio::test]
    async fn a_swarm_workers_tool_event_names_the_worker() {
        use std::sync::atomic::{AtomicU32, Ordering};

        struct ToolCallingWorkerLlm {
            /// The first step calls the tool; every later step stops, so the
            /// turn ends instead of looping into compaction.
            calls: Arc<AtomicU32>,
        }
        impl LLM for ToolCallingWorkerLlm {
            fn system_prompt(&self) -> &str {
                "worker"
            }
            fn model_name(&self) -> &str {
                "worker-llm"
            }
            fn is_retryable_error(&self, _: &str) -> bool {
                false
            }
            fn chat(
                &self,
                _params: LLMChatParams,
            ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
            {
                let first = self.calls.fetch_add(1, Ordering::Relaxed) == 0;
                Box::pin(async move {
                    Ok(TurnChatResponse {
                        content: if first {
                            String::new()
                        } else {
                            "worker done".into()
                        },
                        thinking: vec![],
                        tool_calls: if first {
                            vec![crate::turn_loop::types::ToolCall {
                                id: "worker_call_1".into(),
                                name: "probe_tool".into(),
                                arguments: serde_json::json!({}),
                                extras: None,
                            }]
                        } else {
                            vec![]
                        },
                        finish_reason: Some(if first { "tool_calls" } else { "stop" }.into()),
                        usage: TokenUsage::default(),
                        timing: None,
                    })
                })
            }
        }

        #[derive(Clone)]
        struct Recorder {
            events: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
            spawned: Arc<AtomicU32>,
        }
        impl HostCallbacks for Recorder {
            fn llm_chat(
                &self,
                _: LlmChatRequest,
            ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
                Box::pin(async { Err("not used".into()) })
            }
            fn execute_tool(
                &self,
                req: ToolExecuteRequest,
            ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
                assert_eq!(req.tool_name, "probe_tool");
                Box::pin(async {
                    Ok(ToolExecuteResponse {
                        content: "worker output".into(),
                        is_error: false,
                        note: None,
                        stop_turn: false,
                        delivery: None,
                    })
                })
            }
            fn check_permission(
                &self,
                _: PermissionCheckRequest,
            ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
                Box::pin(async { Ok(PermissionDecision::allow()) })
            }
            fn list_tools(&self) -> BoxFuture<'static, Result<ListToolsResponse, String>> {
                Box::pin(async {
                    Ok(ListToolsResponse {
                        tools: vec![crate::rpc::types::ToolInfo {
                            name: "probe_tool".into(),
                            description: "probe".into(),
                            input_schema: serde_json::json!({ "type": "object" }),
                        }],
                    })
                })
            }
            fn emit_event(&self, event: serde_json::Value) {
                if event.get("type").and_then(|t| t.as_str()) == Some("subagent.spawned") {
                    self.spawned.fetch_add(1, Ordering::Relaxed);
                }
                self.events.lock().unwrap().push(event);
            }
        }

        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let spawned = Arc::new(AtomicU32::new(0));
        let mgr = Arc::new(SubagentManager::new());
        mgr.register_definition(crate::subagent::types::SubagentDefinition {
            name: "coder".into(),
            description: "coder".into(),
            system_prompt: "You are coder.".into(),
            tools: vec!["probe_tool".into()],
            disallowed_tools: vec![],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        })
        .await;
        mgr.set_runtime(
            Arc::new(ToolCallingWorkerLlm {
                calls: Arc::new(AtomicU32::new(0)),
            }),
            Arc::new(Recorder {
                events: events.clone(),
                spawned: spawned.clone(),
            }),
            None,
        )
        .await;

        let recorder = Arc::new(Recorder {
            events: events.clone(),
            spawned: spawned.clone(),
        });
        let launcher = SwarmLauncher {
            manager: mgr.clone(),
            parent_cancel: None,
            inherited_history: None,
            llm: None,
            callbacks: recorder.clone(),
            caller_agent_id: "test-caller".into(),
            sink: Arc::new(crate::swarm::service::CallbackSink::new(recorder)),
        };

        let handle = AgentRunBatchLauncher::<SwarmTaskSpec>::spawn(
            &launcher,
            AgentSpawnAttemptOptions {
                profile_name: "coder".into(),
                swarm_item: None,
                plan: SubagentSpawnPlan {
                    profile_name: "coder".into(),
                    model: "worker-llm".into(),
                    thinking: None,
                    fork: false,
                },
                run: AgentRunAttemptOptions {
                    parent_tool_call_id: "swarm_tc_1".into(),
                    parent_tool_call_uuid: None,
                    prompt: "call probe_tool".into(),
                    description: "probe".into(),
                    swarm_index: Some(0),
                    run_in_background: false,
                    signal: AbortSignal::new(),
                    on_ready: None,
                    suppress_rate_limit_failure_event: false,
                },
            },
        )
        .await
        .expect("worker spawns");
        handle.completion.await.expect("worker completes");

        assert_eq!(
            spawned.load(Ordering::Relaxed),
            1,
            "the worker announced itself"
        );

        let recorded = events.lock().unwrap();
        let tool_events: Vec<_> = recorded
            .iter()
            .filter(|e| {
                e.get("type")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| t.starts_with("tool."))
            })
            .collect();
        assert!(
            !tool_events.is_empty(),
            "the worker's tool call must surface a tool event, got: {recorded:?}"
        );
        let worker_id = handle.agent_id.clone();
        for event in &tool_events {
            assert_eq!(
                event.get("agent_id").and_then(|v| v.as_str()),
                Some(worker_id.as_str()),
                "a swarm worker's tool event must name the worker — the host reads \
                 an anonymous event as `main` and announces it in the main \
                 transcript, cutting the main agent's reasoning. Event: {event:?}"
            );
        }

        // The member reaches a terminal state (v2 `mirrorAgentRun`'s
        // `emitTerminal`). Without it the TUI's swarm progress row keeps the
        // worker "running" — it has no other way to leave that state — and the
        // user sees nothing until the whole batch returns one XML blob.
        let terminals: Vec<_> = recorded
            .iter()
            .filter(|e| {
                matches!(
                    e.get("type").and_then(|t| t.as_str()),
                    Some("subagent.completed")
                        | Some("subagent.failed")
                        | Some("subagent.cancelled")
                )
            })
            .collect();
        assert_eq!(
            terminals.len(),
            1,
            "exactly one terminal event per member: {recorded:?}"
        );
        assert_eq!(
            terminals[0]["type"], "subagent.completed",
            "a member that ran to the end completes: {recorded:?}"
        );
        assert_eq!(terminals[0]["subagent_id"], worker_id.as_str());
    }

    #[tokio::test]
    async fn test_fallback_when_no_runtime() {
        let mgr = Arc::new(SubagentManager::new());
        let args = serde_json::json!({
            "description": "swarm",
            "items": ["a", "b"],
            "prompt_template": "check {{item}}"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, None, None).await;
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn test_validation_requires_description() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "items": ["a", "b"],
            "prompt_template": "check {{item}}"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, None, None)
            .await
            .unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("'description' is required"));
    }

    #[tokio::test]
    async fn test_validation_requires_at_least_two_items() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "single item",
            "items": ["a"],
            "prompt_template": "check {{item}}"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, None, None)
            .await
            .unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("at least 2 items"));
    }

    #[tokio::test]
    async fn test_validation_requires_prompt_template_when_items() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "missing template",
            "items": ["a", "b"]
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, None, None)
            .await
            .unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("prompt_template is required"));
    }

    #[tokio::test]
    async fn test_validation_requires_placeholder() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "missing placeholder",
            "items": ["a", "b"],
            "prompt_template": "check all items"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, None, None)
            .await
            .unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("{{item}}"));
    }

    #[tokio::test]
    async fn test_validation_rejects_duplicate_prompts() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "duplicate prompts",
            "items": ["a", "a"],
            "prompt_template": "check {{item}}"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, None, None)
            .await
            .unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("Duplicate subagent prompts"));
    }

    #[tokio::test]
    async fn test_execute_agent_swarm_native_success() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "code review",
            "items": ["src/main.rs", "src/lib.rs"],
            "prompt_template": "review {{item}}"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-1"), None)
            .await
            .unwrap();
        assert!(!res.is_error, "Swarm execution failed: {}", res.content);
        assert!(res.content.contains("<agent_swarm_result>"));
        assert!(res.content.contains("<summary>completed: 2</summary>"));
        assert!(res.content.contains(r#"item="src/main.rs""#));
        assert!(res.content.contains(r#"item="src/lib.rs""#));
        assert!(res.content.contains("findings: reviewed OK"));
    }

    #[tokio::test]
    async fn test_execute_agent_swarm_allows_single_resume() {
        let mgr = manager_with_runtime().await;
        // A member is always spawned by an agent, which is what makes it
        // resumable by that agent and nobody else.
        let agent_id = crate::tools::CALLER_AGENT_ID
            .scope(
                crate::callbacks::MAIN_AGENT_ID.to_string(),
                mgr.spawn("coder", "Initial worker"),
            )
            .await
            .unwrap();
        let _ = mgr
            .run_foreground_turn(&agent_id, "initial prompt", None)
            .await
            .unwrap();

        // With resume_agent_ids, a single item or no items is allowed
        let mut resumes = serde_json::Map::new();
        resumes.insert(
            agent_id.clone(),
            serde_json::Value::String("continue checking".into()),
        );
        let args = serde_json::json!({
            "description": "resuming work",
            "resume_agent_ids": resumes
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-2"), None)
            .await
            .unwrap();
        assert!(!res.is_error, "Resume swarm failed: {}", res.content);
        assert!(res.content.contains("<agent_swarm_result>"));
        assert!(res.content.contains("<summary>completed: 1</summary>"));
        assert!(res.content.contains(r#"mode="resume""#));
        assert!(res.content.contains(&format!(r#"agent_id="{agent_id}""#)));
    }

    /// v2 `requireOwnedSubagent`: a swarm may only resume its own members. A
    /// subagent belonging to another parent is refused before its conversation
    /// is touched, and the refusal comes back as the member's result.
    #[tokio::test]
    async fn a_swarm_cannot_resume_another_parents_subagent() {
        let mgr = manager_with_runtime().await;
        let foreign = crate::tools::CALLER_AGENT_ID
            .scope(
                "other-agent".to_string(),
                mgr.spawn("coder", "Someone else's worker"),
            )
            .await
            .unwrap();
        let _ = mgr
            .run_foreground_turn(&foreign, "their prompt", None)
            .await
            .unwrap();

        let args = serde_json::json!({
            "description": "reaching for another agent's worker",
            "resume_agent_ids": { foreign.clone(): "continue" }
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-x"), None)
            .await
            .unwrap();
        // v2 shape: the gate throws inside the launcher's resume, which the
        // batch catches into a *failed member*, so the tool call itself still
        // succeeds and the refusal arrives as that member's result.
        assert!(!res.is_error, "{}", res.content);
        assert!(
            res.content.contains("does not belong to this parent agent"),
            "{}",
            res.content
        );
        assert!(
            res.content.contains(r#"outcome="failed""#),
            "the member is reported failed: {}",
            res.content
        );
    }

    /// v2 `AGENT_NOT_A_SUBAGENT`: the main agent is not a subagent, so naming it
    /// in `resume_agent_ids` is refused as the other error, not as "not yours".
    #[tokio::test]
    async fn a_swarm_cannot_resume_the_main_agent() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "reaching for the main agent",
            "resume_agent_ids": { crate::callbacks::MAIN_AGENT_ID: "continue" }
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-y"), None)
            .await
            .unwrap();
        assert!(!res.is_error, "{}", res.content);
        assert!(
            res.content.contains("is not a subagent"),
            "the main agent is not a subagent, which is a different refusal: {}",
            res.content
        );
    }

    /// v2 `requireIdleSubagent`, through the whole tool: a member that is
    /// still running its own turn must come back as a failed member, not be
    /// driven into a second concurrent turn. This is the wiring assertion —
    /// the unit tests on `require_idle_subagent` only prove its logic.
    #[tokio::test]
    async fn a_swarm_cannot_resume_a_member_that_is_already_running() {
        let mgr = manager_with_runtime().await;
        let agent_id = crate::tools::CALLER_AGENT_ID
            .scope(
                crate::callbacks::MAIN_AGENT_ID.to_string(),
                mgr.spawn("coder", "Busy worker"),
            )
            .await
            .unwrap();
        // Left in Running: no foreground turn ever completes it.
        mgr.update_state(
            &agent_id,
            crate::subagent::types::SubagentState::Running,
            None,
        )
        .await;

        let args = serde_json::json!({
            "description": "resuming a busy member",
            "resume_agent_ids": { agent_id.clone(): "continue" }
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-busy"), None)
            .await
            .unwrap();
        assert!(
            !res.is_error,
            "the call itself still succeeds: {}",
            res.content
        );
        assert!(
            res.content
                .contains("already running and cannot run concurrently"),
            "the busy member is refused: {}",
            res.content
        );
        assert!(
            res.content.contains(r#"outcome="failed""#),
            "…reported as a failed member: {}",
            res.content
        );
    }

    /// v2 `getSwarmItem`: a resumed member is labelled with the `{{item}}` it
    /// was spawned for, so the row says which work it continues.
    #[tokio::test]
    async fn a_resumed_member_keeps_its_swarm_item() {
        let mgr = manager_with_runtime().await;
        let agent_id = crate::tools::CALLER_AGENT_ID
            .scope(
                crate::callbacks::MAIN_AGENT_ID.to_string(),
                mgr.spawn("coder", "Initial worker"),
            )
            .await
            .unwrap();
        mgr.set_swarm_item(&agent_id, Some("src/main.rs".into()))
            .await;
        let _ = mgr
            .run_foreground_turn(&agent_id, "initial prompt", None)
            .await
            .unwrap();

        let args = serde_json::json!({
            "description": "resuming work",
            "resume_agent_ids": { agent_id: "continue" }
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-z"), None)
            .await
            .unwrap();
        assert!(!res.is_error, "{}", res.content);
        assert!(
            res.content.contains(r#"item="src/main.rs""#),
            "the resumed row keeps its item: {}",
            res.content
        );
    }

    /// v2 `AgentSwarmTool.runSwarm`: `fork` shares the caller's profile and
    /// model so the prompt prefix cache is reused, so naming a different
    /// `subagent_type` is a contradiction the tool refuses. The single-agent
    /// `Agent` tool already runs this gate; the swarm has to run it too.
    #[tokio::test]
    async fn fork_rejects_a_different_subagent_type() {
        let mgr = manager_with_runtime_with_profiles().await;
        let args = serde_json::json!({
            "description": "forked review",
            "items": ["src/a.rs", "src/b.rs"],
            "prompt_template": "review {{item}}",
            "fork": true,
            "subagent_type": "reviewer"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-f1"), None)
            .await
            .unwrap();
        assert!(res.is_error, "fork must not take a different profile");
        assert!(
            res.content
                .contains("Cannot set a different subagent_type when forking"),
            "{}",
            res.content
        );
    }

    /// The same gate for the model: a fork runs on the caller's model, so
    /// asking for a different one (other than `primary`) is refused. The model
    /// has to be a real pool alias, because the engine resolves `model` before
    /// the fork gate runs.
    #[tokio::test]
    async fn fork_rejects_a_different_model() {
        let mgr = manager_with_runtime().await;
        let pool = crate::subagent::secondary::SecondaryModelRuntime::new(
            crate::rpc::types::SecondaryModelPool {
                force: false,
                default_model: "fast".into(),
                caller_model_alias: None,
                models: vec![crate::rpc::types::SecondaryModelEntry {
                    alias: "fast".into(),
                    hint: String::new(),
                    llm: Default::default(),
                }],
            },
            // The pool binds an alias only when a live LLM is registered for
            // it, so the model has to resolve before the fork gate is reached.
            std::collections::HashMap::from([(
                "fast".to_string(),
                Arc::new(TestSummaryLlm) as Arc<dyn crate::turn_loop::types::LLM>,
            )]),
        );
        let args = serde_json::json!({
            "description": "forked review",
            "items": ["src/a.rs", "src/b.rs"],
            "prompt_template": "review {{item}}",
            "fork": true,
            "model": "fast"
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-f2"), Some(&pool))
            .await
            .unwrap();
        assert!(res.is_error, "fork must not switch model: {}", res.content);
        assert!(
            res.content
                .contains("Cannot override the model when forking"),
            "{}",
            res.content
        );
    }

    /// v2 `FORK_WITH_RESUME_UNAVAILABLE`: resumed subagents are never forked, so
    /// combining the two is refused as a whole call.
    #[tokio::test]
    async fn fork_rejects_a_non_empty_resume() {
        let mgr = manager_with_runtime().await;
        let agent_id = crate::tools::CALLER_AGENT_ID
            .scope(
                crate::callbacks::MAIN_AGENT_ID.to_string(),
                mgr.spawn("coder", "Initial worker"),
            )
            .await
            .unwrap();
        let _ = mgr
            .run_foreground_turn(&agent_id, "initial prompt", None)
            .await
            .unwrap();

        let args = serde_json::json!({
            "description": "fork and resume",
            "resume_agent_ids": { agent_id: "continue" },
            "fork": true
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-f3"), None)
            .await
            .unwrap();
        assert!(res.is_error, "fork cannot be combined with a resume");
        assert!(
            res.content
                .contains("Cannot set resume when forking the current context."),
            "{}",
            res.content
        );
    }

    /// A plain fork with no type/model override is still allowed, so the gate
    /// is not simply refusing every `fork`.
    #[tokio::test]
    async fn a_plain_fork_is_allowed() {
        let mgr = manager_with_runtime().await;
        let args = serde_json::json!({
            "description": "forked review",
            "items": ["src/a.rs", "src/b.rs"],
            "prompt_template": "review {{item}}",
            "fork": true
        });
        let res = execute_agent_swarm(&mgr, &args, None, None, Some("call-f4"), None)
            .await
            .unwrap();
        assert!(!res.is_error, "a plain fork must run: {}", res.content);
        assert!(res.content.contains("<summary>completed: 2</summary>"));
    }
}
