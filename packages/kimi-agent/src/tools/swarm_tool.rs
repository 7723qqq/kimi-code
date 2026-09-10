//! Native execution of the `AgentSwarm` orchestration tool.
//!
//! Direct native port of `agent-core-v2`'s `AgentSwarmTool` (swarm feature):
//! drives batch subagent execution through the [`AgentRunBatch`] scheduler with
//! concurrency limits, rate-limit backoff, timeout handling, and cancellation.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::rpc::types::BoxFuture;
use crate::subagent::SubagentManager;
use crate::subagent::manager::ForegroundTurnOutcome;
use crate::subagent::types::ParentCancel;
use crate::swarm::agent_run_batch::{
    AbortReason, AbortSignal, AgentRunAttemptHandle, AgentRunAttemptOptions, AgentRunBatch,
    AgentRunBatchLauncher, AgentRunBatchOptions, AgentRunBatchTiming, AgentRunCompletion,
    AgentRunError, AgentRunResult, AgentRunState, AgentRunStatus, AgentRunTask, AgentRunTaskKind,
    AgentSpawnAttemptOptions, SubagentSpawnPlan, resolve_swarm_max_concurrency,
};
use crate::turn_loop::types::{ExecutableToolResult, LoopTurnStopReason, ToolInfo};

/// The v2 default profile name (`DEFAULT_PROFILE_NAME`).
const DEFAULT_SUBAGENT_TYPE: &str = "coder";

/// The default foreground timeout (v2 `DEFAULT_SUBAGENT_TIMEOUT_MS`: 2h).
const DEFAULT_SUBAGENT_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000;
/// The swarm timeout default (v2 `DEFAULT_SWARM_TIMEOUT_MS`: 2h). Swarms
/// resolve only this knob — never the subagent timeout.
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

fn is_rate_limit_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
        || lower.contains("resource exhausted")
}

struct SubagentSwarmLauncher {
    manager: Arc<SubagentManager>,
    parent_cancel: Option<ParentCancel>,
    inherited_history: Option<Vec<crate::turn_loop::types::LLMMessage>>,
    /// `[secondary_model]` binding for item-spawned subagents; `None` inherits
    /// the session model.
    llm: Option<Arc<dyn crate::turn_loop::types::LLM>>,
}

impl AgentRunBatchLauncher<SwarmTaskSpec> for SubagentSwarmLauncher {
    fn spawn(
        &self,
        options: AgentSpawnAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
        let manager = self.manager.clone();
        let parent_cancel = self.parent_cancel.clone();
        let item_llm = self.llm.clone();
        let fork_history = if options.plan.fork {
            self.inherited_history.clone()
        } else {
            None
        };
        Box::pin(async move {
            let role = format!("Swarm worker for {}", options.run.description);
            let agent_id = manager.spawn(&options.profile_name, &role).await?;
            if let Some(llm) = item_llm.clone() {
                manager.set_instance_llm(&agent_id, llm).await;
            }
            let prompt = options.run.prompt;
            let signal = options.run.signal;
            let handle_id = agent_id.clone();
            let target_id = agent_id.clone();

            let completion: BoxFuture<'static, Result<AgentRunCompletion, AgentRunError>> =
                Box::pin(async move {
                    let run_fut = manager.run_foreground_turn_with_history(
                        &target_id,
                        &prompt,
                        fork_history,
                        parent_cancel.as_ref(),
                    );
                    tokio::select! {
                        res = run_fut => {
                            match res {
                                Ok(ForegroundTurnOutcome::Completed(turn)) => {
                                    if matches!(turn.stop_reason, LoopTurnStopReason::Aborted) {
                                        Err(AgentRunError {
                                            message: "The subagent was stopped before it finished.".into(),
                                            is_rate_limit: false,
                                        })
                                    } else {
                                        let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
                                        Ok(AgentRunCompletion {
                                            result: summary,
                                            usage: Some(turn.usage),
                                        })
                                    }
                                }
                                Ok(ForegroundTurnOutcome::ParentCancelled) => {
                                    Err(AgentRunError {
                                        message: "The subagent was stopped before it finished by user.".into(),
                                        is_rate_limit: false,
                                    })
                                }
                                Err(err) => {
                                    let is_rate_limit = is_rate_limit_error(&err);
                                    Err(AgentRunError {
                                        message: err,
                                        is_rate_limit,
                                    })
                                }
                            }
                        }
                        _ = signal.wait() => {
                            let _ = manager.kill(&target_id).await;
                            Err(AgentRunError {
                                message: "The subagent was stopped before it finished.".into(),
                                is_rate_limit: false,
                            })
                        }
                    }
                });

            Ok(AgentRunAttemptHandle {
                agent_id: handle_id,
                completion,
            })
        })
    }

    fn resume(
        &self,
        agent_id: String,
        options: AgentRunAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
        let manager = self.manager.clone();
        let parent_cancel = self.parent_cancel.clone();
        Box::pin(async move {
            let prompt = options.prompt;
            let signal = options.signal;
            let handle_id = agent_id.clone();
            let target_id = agent_id.clone();

            let completion: BoxFuture<'static, Result<AgentRunCompletion, AgentRunError>> =
                Box::pin(async move {
                    let run_fut = async {
                        if let Some(res) = manager
                            .resume_foreground_turn(&target_id, &prompt, parent_cancel.as_ref())
                            .await
                        {
                            res
                        } else {
                            manager
                                .run_foreground_turn(&target_id, &prompt, parent_cancel.as_ref())
                                .await
                        }
                    };
                    tokio::select! {
                        res = run_fut => {
                            match res {
                                Ok(ForegroundTurnOutcome::Completed(turn)) => {
                                    if matches!(turn.stop_reason, LoopTurnStopReason::Aborted) {
                                        Err(AgentRunError {
                                            message: "The subagent was stopped before it finished.".into(),
                                            is_rate_limit: false,
                                        })
                                    } else {
                                        let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
                                        Ok(AgentRunCompletion {
                                            result: summary,
                                            usage: Some(turn.usage),
                                        })
                                    }
                                }
                                Ok(ForegroundTurnOutcome::ParentCancelled) => {
                                    Err(AgentRunError {
                                        message: "The subagent was stopped before it finished by user.".into(),
                                        is_rate_limit: false,
                                    })
                                }
                                Err(err) => {
                                    let is_rate_limit = is_rate_limit_error(&err);
                                    Err(AgentRunError {
                                        message: err,
                                        is_rate_limit,
                                    })
                                }
                            }
                        }
                        _ = signal.wait() => {
                            let _ = manager.kill(&target_id).await;
                            Err(AgentRunError {
                                message: "The subagent was stopped before it finished.".into(),
                                is_rate_limit: false,
                            })
                        }
                    }
                });

            Ok(AgentRunAttemptHandle {
                agent_id: handle_id,
                completion,
            })
        })
    }

    fn retry(
        &self,
        agent_id: String,
        options: AgentRunAttemptOptions,
    ) -> BoxFuture<'static, Result<AgentRunAttemptHandle, String>> {
        self.resume(agent_id, options)
    }
}

fn err_result(msg: impl Into<String>) -> ExecutableToolResult {
    ExecutableToolResult {
        stop_turn: false,
        content: msg.into(),
        is_error: true,
        note: None,
    }
}

fn ok_result(msg: impl Into<String>) -> ExecutableToolResult {
    ExecutableToolResult {
        stop_turn: false,
        content: msg.into(),
        is_error: false,
        note: None,
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

    let should_render_resume_hint = results
        .iter()
        .any(|r| r.status != AgentRunStatus::Completed)
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
            "<subagent{mode_attr}{agent_id_attr}{item_attr}{state_attr} outcome=\"{outcome}\">{body}</subagent>"
        ));
    }

    lines.push("</agent_swarm_result>".to_string());
    lines.join("\n")
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
        Err(e) => return Some(err_result(format!("Invalid AgentSwarm arguments: {e}"))),
    };

    let description = match input.description {
        Some(d) if !d.trim().is_empty() => d.trim().to_string(),
        _ => {
            return Some(err_result(
                "Invalid AgentSwarm arguments: 'description' is required.",
            ));
        }
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
        return Some(err_result(
            "AgentSwarm requires at least 2 items unless resume_agent_ids is provided.",
        ));
    }

    if total_count > MAX_AGENT_SWARM_SUBAGENTS {
        return Some(err_result(format!(
            "AgentSwarm supports at most {MAX_AGENT_SWARM_SUBAGENTS} subagents."
        )));
    }

    let prompt_template = input
        .prompt_template
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if item_count > 0 && prompt_template.is_none() {
        return Some(err_result(
            "prompt_template is required when items are provided.",
        ));
    }

    if let Some(template) = &prompt_template
        && !template.contains(PROMPT_TEMPLATE_PLACEHOLDER)
    {
        return Some(err_result(format!(
            "prompt_template must include the {PROMPT_TEMPLATE_PLACEHOLDER} placeholder."
        )));
    }

    let mut seen_prompts: HashMap<String, usize> = HashMap::new();
    let mut tasks: Vec<AgentRunTask<SwarmTaskSpec>> = Vec::new();
    let parent_tool_call_id = tool_call_id.unwrap_or("swarm").to_string();
    // Host-resolved swarm timeout (v2 `resolveSwarmTimeoutMs`): a dedicated
    // knob — unlike `Agent` turns, swarms never inherit the subagent
    // timeout, so only the override (or the 2h swarm default) applies.
    let timeout = Some(Duration::from_millis(
        manager
            .swarm_timeout_ms()
            .filter(|t| *t > 0)
            .unwrap_or(DEFAULT_SWARM_TIMEOUT_MS),
    ));

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
        tasks.push(AgentRunTask {
            data: SwarmTaskSpec {
                index: idx,
                item: None,
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
            swarm_item: None,
            run_in_background: false,
            timeout,
            signal: Some(batch_signal.clone()),
            plan: None,
        });
    }

    let is_fork = input.fork.unwrap_or(false);
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
                return Some(err_result(format!(
                    "Duplicate subagent prompts from items {prev} and {item_num}. AgentSwarm requires distinct subagents."
                )));
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

    let launcher = Arc::new(SubagentSwarmLauncher {
        manager: manager.clone(),
        parent_cancel: parent_cancel.cloned(),
        inherited_history,
        llm: item_llm,
    });

    let env_map: HashMap<String, String> = std::env::vars().collect();
    let max_concurrency = resolve_swarm_max_concurrency(&env_map).unwrap_or(None);
    let batch = AgentRunBatch::new(
        launcher,
        tasks,
        AgentRunBatchOptions {
            max_concurrency,
            timing: AgentRunBatchTiming::default(),
        },
    );

    let results = match batch.run().await {
        Ok(r) => r,
        Err(e) => return Some(err_result(e)),
    };
    Some(ok_result(render_swarm_results(&results)))
}

/// Tool definition for `AgentSwarm`.
pub fn agent_swarm_tool_def(
    pool: Option<&crate::subagent::secondary::SecondaryModelRuntime>,
) -> ToolInfo {
    let mut description = "Launch multiple subagents from one prompt template, existing agent resumes, or both. Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly `{{item}}`.".to_string();
    // v2 `buildSubagentModelDescriptions`: a forced pool exposes no choice,
    // so it appends neither the listing nor (below) the `model` parameter.
    if let Some(pool) = pool && pool.exposes_choice() {
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
    ToolInfo {
        name: "AgentSwarm".into(),
        description,
        input_schema,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(offered.description.contains("Available models (pass via model):"));
        assert!(
            offered
                .input_schema
                .get("properties")
                .and_then(|properties| properties.get("model"))
                .is_some()
        );

        let forced = agent_swarm_tool_def(Some(&pool(true)));
        assert!(!forced.description.contains("Available models"), "{}", forced.description);
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
            bare
                .input_schema
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
        mgr.set_runtime(Arc::new(TestSummaryLlm), Arc::new(TestNoopCallbacks))
            .await;
        mgr
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
        let agent_id = mgr.spawn("coder", "Initial worker").await.unwrap();
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
}
