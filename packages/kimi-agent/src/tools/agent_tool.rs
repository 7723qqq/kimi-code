//! Native `Agent` tool — the foreground core of v2's `SubagentTool` (P46).
//!
//! Scope (deliberately narrow): a foreground `Agent` call with a known
//! profile runs an inline subagent turn through the same native pipeline
//! (permission gate, stale/plan/dedup guards, truncation) and reports the
//! v2-shaped result. Everything the v2 tool supports beyond that stays
//! host-owned by falling back (returning `None`):
//! - profiles missing from the pushed snapshot (plugin sources, external
//!   backends like claude-code/codex)
//! - a turn without an injected subagent runtime
//!
//! `resume` (P55), `run_in_background` (P58), `fork` and the explicit
//! `model` override started out on that list and are native now.
//!
//! The host keeps its `Agent` tool registered either way, so a fallback is
//! a routing decision, never a capability loss.

use std::sync::Arc;

use crate::subagent::SubagentManager;
use crate::subagent::manager::ForegroundTurnOutcome;
use crate::subagent::types::ParentCancel;
use crate::turn_loop::types::{ExecutableToolResult, LoopTurnStopReason};

/// The v2 default profile name (`DEFAULT_PROFILE_NAME`).
pub const DEFAULT_PROFILE_NAME: &str = "coder";

/// The default foreground timeout (v2 `DEFAULT_SUBAGENT_TIMEOUT_MS`: 2h).
pub const DEFAULT_SUBAGENT_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000;

/// The v2 stopped messages (`agent/tools/agent/agent.ts`), byte-identical.
const SUBAGENT_STOPPED_MESSAGE: &str = "The subagent was stopped before it finished.";
const USER_INTERRUPTED_SUBAGENT_MESSAGE: &str =
    "The subagent was stopped before it finished by user.";

/// The v2 timeout resume hint (`formatForegroundAgentFailure`), verbatim.
fn timeout_resume_hint(agent_id: &str) -> String {
    format!(
        "resume_hint: Continue with Agent(resume=\"{agent_id}\", prompt=\"continue\"). \
Use agent_id only; do not set subagent_type. The subagent retains its prior context; \
redo any unfinished tool call if its result was lost."
    )
}

/// The v2 timeout duration rendering (`formatSubagentTimeoutDescription`).
pub fn format_timeout_description(ms: u64) -> String {
    const HOUR: u64 = 60 * 60 * 1000;
    const MINUTE: u64 = 60 * 1000;
    if ms.is_multiple_of(HOUR) {
        let h = ms / HOUR;
        return format!("{h} hour{}", if h == 1 { "" } else { "s" });
    }
    if ms.is_multiple_of(MINUTE) {
        let m = ms / MINUTE;
        return format!("{m} minute{}", if m == 1 { "" } else { "s" });
    }
    if ms.is_multiple_of(1000) {
        let s = ms / 1000;
        return format!("{s} second{}", if s == 1 { "" } else { "s" });
    }
    format!("{ms} ms")
}

fn string_arg(args: &serde_json::Value, name: &str) -> Option<String> {
    args.get(name)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The v2 `SubagentTool` description body (condensed from
/// `agent-core-v2/src/agent/tools/agent/agent*.md`), with the profile list
/// appended at definition time.
const AGENT_TOOL_DESCRIPTION: &str = "\
Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its `resume` id) over spawning a fresh instance — the resumed agent keeps its prior context.
- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.
- Subagents use a fixed 2-hour timeout. If one times out, resume the same agent instead of starting over.
- When `run_in_background=true`, the subagent runs detached from this turn. The completion arrives in a later turn as a synthetic user-role message containing its result — you do not need to poll, sleep, or check on its progress. Default to a foreground subagent when your next step needs its result.
- Context forking: when the task builds on this conversation, pass `fork: true` instead of briefing from scratch — the subagent then starts with a snapshot of your completed history (inheriting your own agent type, tool set, and model), so the prompt only needs the task itself.

When NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually.";

/// The `Agent` tool definition (v2 `SubagentTool`): the subagent spawn /
/// resume surface. The optional `model` parameter is added only when a
/// `[secondary_model]` pool advertises a choice; without one the parameter is
/// not advertised, matching v2's `stripSubagentModelParameter`.
/// The v2 `resolveActiveToolNames` listing for one profile: `all` when no
/// allowlist is declared, `none` when the allowlist admits nothing, else the
/// comma-separated names (MCP globs included verbatim — `mcp__*` reads as
/// "every MCP tool").
fn profile_tools_listing(profile: &crate::prompt::profiles::AgentProfile) -> String {
    if profile.tools.is_empty() {
        return "all".to_string();
    }
    let active: Vec<&str> = profile
        .tools
        .iter()
        .filter(|name| {
            crate::subagent::manager::ToolPolicyFilter::from_allowlist(&profile.tools).allows(name)
        })
        .map(|name| name.as_str())
        .collect();
    if active.is_empty() {
        "none".to_string()
    } else {
        active.join(", ")
    }
}

pub fn agent_tool_def(
    pool: Option<&crate::subagent::secondary::SecondaryModelRuntime>,
) -> crate::turn_loop::types::ToolInfo {
    let catalog = crate::prompt::profiles::ProfileCatalog::with_builtins();
    let mut available = String::new();
    for profile in catalog.list() {
        available.push_str(&format!("- {}: {}\n", profile.name, profile.description));
        // v2 `buildSubagentTypeDescriptions` / `resolveActiveToolNames`: the
        // listing advertises each type's tool scope so the model can pick a
        // subagent by what it is actually allowed to do.
        available.push_str(&format!("  Tools: {}\n", profile_tools_listing(profile)));
    }
    let mut description = format!(
        "{AGENT_TOOL_DESCRIPTION}\n\nAvailable agent types:\n{}",
        available.trim_end()
    );
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
            "prompt": {
                "type": "string",
                "description": "Full task prompt for the subagent"
            },
            "description": {
                "type": "string",
                "description": "Short task description (3-5 words) for UI display"
            },
            "subagent_type": {
                "type": "string",
                "description": "One of the available agent types (see \"Available agent types\" in this tool description). Defaults to \"coder\" when omitted."
            },
            "resume": {
                "type": "string",
                "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected."
            },
            "run_in_background": {
                "type": "boolean",
                "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting."
            },
            "fork": {
                "type": "boolean",
                "description": "Fork the current context: the subagent starts with a snapshot of this agent's completed conversation history instead of zero context, inheriting this agent's agent type, tool set, and model. A non-empty resume is rejected. If subagent_type is provided, it must match this agent's type."
            }
        },
        "required": ["prompt", "description"]
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
                "description": "Which model to run the subagent on: one of the aliases listed under \"Available models\" in this tool description, or \"primary\" for the main model you are running on (for hard, quality-sensitive tasks). When omitted, the configured default model is used. Ignored when resuming — resumed subagents keep their own model."
            }),
        );
    }
    crate::turn_loop::types::ToolInfo {
        name: "Agent".into(),
        description,
        input_schema,
    }
}

/// The v2 success shape (`formatForegroundAgentSuccess`).
fn format_success(agent_id: &str, profile: &str, summary: &str) -> String {
    format!(
        "agent_id: {agent_id}\nactual_subagent_type: {profile}\nstatus: completed\n\n[summary]\n{summary}"
    )
}

/// The v2 failure shape (`formatForegroundAgentFailure`); the timeout case
/// appends the resume hint.
fn format_failure(agent_id: &str, profile: &str, message: &str, timed_out: bool) -> String {
    let mut text = format!(
        "agent_id: {agent_id}\nactual_subagent_type: {profile}\nstatus: failed\n\nsubagent error: {message}"
    );
    if timed_out {
        text.push('\n');
        text.push_str(&timeout_resume_hint(agent_id));
    }
    text
}

/// Fire-and-forget subagent lifecycle event to the host (v2
/// `mirrorAgentRun` event surface: `SubagentSpawned` / `SubagentStarted` /
/// `SubagentCompleted` / `SubagentFailed`; the adapter maps them onto the
/// host's event dispatcher).
fn emit_subagent_event(callbacks: &dyn crate::callbacks::HostCallbacks, event: serde_json::Value) {
    callbacks.emit_event(event);
}

/// The spawned + started event pair (P59 extraction: identical at all four
/// launch sites — foreground, resume, background).
pub(crate) fn emit_spawned_started(
    callbacks: &dyn crate::callbacks::HostCallbacks,
    agent_id: &str,
    profile_name: &str,
    tool_call_id: Option<&str>,
    description: Option<&str>,
    run_in_background: bool,
) {
    emit_subagent_event(
        callbacks,
        serde_json::json!({
            "type": "subagent.spawned",
            "subagent_id": agent_id,
            "subagent_name": profile_name,
            "parent_tool_call_id": tool_call_id,
            "description": description,
            "run_in_background": run_in_background,
        }),
    );
    emit_subagent_event(
        callbacks,
        serde_json::json!({ "type": "subagent.started", "subagent_id": agent_id }),
    );
}

fn emit_completed(
    callbacks: &dyn crate::callbacks::HostCallbacks,
    agent_id: &str,
    summary: &str,
    usage: &crate::rpc::types::TokenUsage,
) {
    emit_subagent_event(
        callbacks,
        serde_json::json!({
            "type": "subagent.completed",
            "subagent_id": agent_id,
            "result_summary": summary,
            "usage": usage_json(usage),
        }),
    );
}

fn emit_failed(callbacks: &dyn crate::callbacks::HostCallbacks, agent_id: &str, error: &str) {
    emit_subagent_event(
        callbacks,
        serde_json::json!({
            "type": "subagent.failed",
            "subagent_id": agent_id,
            "error": error,
        }),
    );
}

pub(crate) fn usage_json(usage: &crate::rpc::types::TokenUsage) -> serde_json::Value {
    serde_json::json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "input_cache_read": usage.input_cache_read,
        "input_cache_creation": usage.input_cache_creation,
    })
}

/// Execute a native `resume`: continue a conversation the manager still
/// holds. Returns `None` when the id is unknown (host-owned persistent
/// scopes) so the call falls back verbatim.
async fn execute_resume(
    manager: &Arc<SubagentManager>,
    args: &serde_json::Value,
    resume_id: &str,
    timeout_ms: Option<u64>,
    parent_cancel: Option<&ParentCancel>,
    tool_call_id: Option<&str>,
) -> Option<ExecutableToolResult> {
    let profile_name = manager.resume_profile(resume_id).await?;
    let runtime = manager.runtime().await?;
    let prompt = string_arg(args, "prompt").unwrap_or_default();

    emit_spawned_started(
        runtime.callbacks.as_ref(),
        resume_id,
        &profile_name,
        tool_call_id,
        None,
        false,
    );

    // v2 `taskService` arms the timeout only when `timeoutMs > 0` — an
    // explicit `0` means "no timeout", not the 2h default.
    let timeout = match timeout_ms {
        Some(0) => u64::MAX,
        Some(ms) => ms,
        None => DEFAULT_SUBAGENT_TIMEOUT_MS,
    };
    let run = tokio::time::timeout(
        std::time::Duration::from_millis(timeout),
        manager.resume_foreground_turn(resume_id, &prompt, parent_cancel),
    )
    .await;

    let run = match run {
        // The manager answered `None` only if its runtime vanished mid-call;
        // surface it as a regular failure instead of a fallback.
        Ok(None) => Ok(Some(Err("resume state was lost".to_string()))),
        other => other,
    };

    let (content, is_error) = match run {
        Ok(Some(Ok(ForegroundTurnOutcome::Completed(turn)))) => {
            let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
            emit_completed(runtime.callbacks.as_ref(), resume_id, &summary, &turn.usage);
            (format_success(resume_id, &profile_name, &summary), false)
        }
        Ok(Some(Ok(ForegroundTurnOutcome::ParentCancelled))) => (
            format_failure(
                resume_id,
                &profile_name,
                USER_INTERRUPTED_SUBAGENT_MESSAGE,
                false,
            ),
            true,
        ),
        Ok(Some(Err(message))) => {
            emit_subagent_event(
                runtime.callbacks.as_ref(),
                serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": resume_id,
                    "error": message,
                }),
            );
            (
                format_failure(resume_id, &profile_name, &message, false),
                true,
            )
        }
        Ok(None) => {
            // Runtime vanished mid-call; surface it as a regular failure.
            let message = "resume state was lost".to_string();
            emit_subagent_event(
                runtime.callbacks.as_ref(),
                serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": resume_id,
                    "error": message,
                }),
            );
            (
                format_failure(resume_id, &profile_name, &message, false),
                true,
            )
        }
        Err(_elapsed) => {
            let _ = manager.kill(resume_id).await;
            let message = format!(
                "Agent timed out after {}.",
                format_timeout_description(timeout)
            );
            emit_subagent_event(
                runtime.callbacks.as_ref(),
                serde_json::json!({
                    "type": "subagent.failed",
                    "subagent_id": resume_id,
                    "error": message,
                }),
            );
            (
                format_failure(resume_id, &profile_name, &message, true),
                true,
            )
        }
    };
    Some(ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content,
        is_error,
        note: None,
    })
}

/// Execute the `Agent` tool natively (foreground core). Returns `None`
/// when the call must fall back to the host — see the module docs.
pub async fn execute_agent(
    manager: &Arc<SubagentManager>,
    args: &serde_json::Value,
    timeout_ms: Option<u64>,
    parent_cancel: Option<&ParentCancel>,
    tool_call_id: Option<&str>,
    pool: Option<&crate::subagent::secondary::SecondaryModelRuntime>,
) -> Option<ExecutableToolResult> {
    // Without a `[secondary_model]` pool the engine still absorbs the `model`
    // parameter: `primary` (or omitting it) inherits the caller's model, any
    // other value is the v2 no-pool error — the host no longer owns subagent
    // model routing.
    let requested_model = string_arg(args, "model");
    // Native resume (P55): a `resume` for an agent whose conversation we
    // hold continues natively; unknown ids stay host-owned (v2 persistent
    // scopes live there).
    if let Some(resume_id) = string_arg(args, "resume") {
        return execute_resume(
            manager,
            args,
            &resume_id,
            timeout_ms,
            parent_cancel,
            tool_call_id,
        )
        .await;
    }

    // The pool binding applies to the spawn, not to resumes (a resumed agent
    // keeps its own model, v2 `stripSubagentModelParameter` note).
    let binding_llm = match pool {
        Some(pool) => {
            let runtime = manager.runtime().await?;
            match pool.resolve(&runtime.llm, requested_model.as_deref()) {
                Ok(binding) => Some(binding.llm),
                Err(message) => {
                    return Some(ExecutableToolResult {
                        delivery: None,
                        stop_turn: false,
                        content: message,
                        is_error: true,
                        note: None,
                    });
                }
            }
        }
        None => {
            if let Err(message) =
                crate::subagent::secondary::SecondaryModelRuntime::resolve_without_pool(
                    requested_model.as_deref(),
                )
            {
                return Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: message,
                    is_error: true,
                    note: None,
                });
            }
            None
        }
    };
    let is_fork = args.get("fork").and_then(|v| v.as_bool()).unwrap_or(false);
    let profile_name =
        string_arg(args, "subagent_type").unwrap_or_else(|| DEFAULT_PROFILE_NAME.into());

    if is_fork {
        let resume = string_arg(args, "resume");
        let subagent_type = string_arg(args, "subagent_type");
        let model = string_arg(args, "model");
        if let Some(err) = crate::subagent::fork_incompatibility(
            resume.as_deref(),
            subagent_type.as_deref(),
            model.as_deref(),
            &profile_name,
            None,
        ) {
            return Some(ExecutableToolResult {
                delivery: None,
                stop_turn: false,
                content: err.to_string(),
                is_error: true,
                note: None,
            });
        }
    }

    // Unknown profiles stay host-owned: plugin sources and external
    // backends never reach the pushed snapshot.
    manager.get_definition(&profile_name).await?;
    // No injected runtime (unwired transport) — the host tool still works.
    let runtime = manager.runtime().await?;

    let prompt = string_arg(args, "prompt").unwrap_or_default();
    let description = string_arg(args, "description").unwrap_or_default();

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

    // P58: background execution — spawn, register in TaskRunner if present,
    // launch detached, return the v2 running shape immediately. Completion flows
    // back through the `subagent.completed` / `subagent.failed` lifecycle events,
    // which the host turns into the usual synthetic notification turn.
    if args.get("run_in_background").and_then(|v| v.as_bool()) == Some(true) {
        let agent_id = manager.spawn(&profile_name, &description).await.ok()?;
        if let Some(llm) = binding_llm.as_ref() {
            manager.set_instance_llm(&agent_id, llm.clone()).await;
        }
        emit_spawned_started(
            runtime.callbacks.as_ref(),
            &agent_id,
            &profile_name,
            tool_call_id,
            Some(&description),
            true,
        );
        let mgr = manager.clone();
        let cb = runtime.callbacks.clone();
        let agent = agent_id.clone();
        let bg_history = inherited_history.clone();
        let prompt_clone = prompt.clone();
        let task_desc = if description.is_empty() {
            format!("Subagent {profile_name}: {prompt_clone}")
        } else {
            description.clone()
        };
        let task_runner = manager.get_task_runner().await;

        let bg_future = async move {
            let outcome = mgr
                .run_foreground_turn_with_history(&agent, &prompt_clone, bg_history, None)
                .await;
            match outcome {
                Ok(ForegroundTurnOutcome::Completed(turn)) => {
                    if matches!(turn.stop_reason, LoopTurnStopReason::Aborted) {
                        cb.emit_event(serde_json::json!({
                            "type": "subagent.failed",
                            "subagent_id": agent,
                            "error": SUBAGENT_STOPPED_MESSAGE,
                        }));
                        SUBAGENT_STOPPED_MESSAGE.to_string()
                    } else {
                        let summary =
                            crate::subagent::manager::final_assistant_summary(&turn.messages);
                        cb.emit_event(serde_json::json!({
                            "type": "subagent.completed",
                            "subagent_id": agent,
                            "result_summary": summary,
                            "usage": usage_json(&turn.usage),
                        }));
                        summary
                    }
                }
                Ok(ForegroundTurnOutcome::ParentCancelled) => {
                    cb.emit_event(serde_json::json!({
                        "type": "subagent.failed",
                        "subagent_id": agent,
                        "error": USER_INTERRUPTED_SUBAGENT_MESSAGE,
                    }));
                    USER_INTERRUPTED_SUBAGENT_MESSAGE.to_string()
                }
                Err(err_msg) => {
                    cb.emit_event(serde_json::json!({
                        "type": "subagent.failed",
                        "subagent_id": agent,
                        "error": err_msg.clone(),
                    }));
                    format!("Error: {err_msg}")
                }
            }
        };

        if let Some(runner) = task_runner {
            // Session attribution rides the runtime the pipeline built for
            // this turn — background task events land on the right lane.
            let session_id = manager
                .runtime()
                .await
                .and_then(|r| r.session_id.clone())
                .filter(|session| !session.is_empty());
            let _ = runner.spawn_task_with_meta(
                crate::storage::TaskSpawnMeta {
                    session_id: session_id.as_deref(),
                    kind: "subagent",
                    subagent_type: Some(&profile_name),
                },
                agent_id.clone(),
                task_desc,
                bg_future,
            );
        } else {
            tokio::spawn(async move {
                let _ = bg_future.await;
            });
        }
        let content = [
            format!("task_id: {agent_id}"),
            "status: running".into(),
            format!("agent_id: {agent_id}"),
            format!("actual_subagent_type: {profile_name}"),
            "automatic_notification: true".into(),
            String::new(),
            format!("description: {description}"),
            String::new(),
            "next_step: The completion arrives automatically in a later turn — do NOT wait, \
             poll, or call TaskOutput on it; continue with other work or hand back to the user. \
             (If you have nothing to do until it finishes, run such tasks in the foreground next time.)"
                .into(),
            format!(
                "resume_hint: To continue or recover this same subagent later, call \
                 Agent(resume=\"{agent_id}\", prompt=\"...\"). The parameter is agent_id \
                 (\"{agent_id}\"), NOT task_id."
            ),
        ]
        .join("\n");
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content,
            is_error: false,
            note: None,
        });
    }

    // Spawn first so the id exists even if the run times out (the failure
    // text carries it, matching v2).
    let agent_id = manager.spawn(&profile_name, &description).await.ok()?;
    if let Some(llm) = binding_llm.as_ref() {
        manager.set_instance_llm(&agent_id, llm.clone()).await;
    }

    // v2 `emitAgentRunSpawned` + `mirrorAgentRun`'s SubagentStarted: the
    // host dispatches the same lifecycle events the host-side subagent
    // path does, keyed by the parent tool call id.
    emit_spawned_started(
        runtime.callbacks.as_ref(),
        &agent_id,
        &profile_name,
        tool_call_id,
        Some(&description),
        false,
    );

    // v2 `taskService` arms the timeout only when `timeoutMs > 0` — an
    // explicit `0` means "no timeout", not the 2h default.
    let timeout = match timeout_ms {
        Some(0) => u64::MAX,
        Some(ms) => ms,
        None => DEFAULT_SUBAGENT_TIMEOUT_MS,
    };

    let run = tokio::time::timeout(
        std::time::Duration::from_millis(timeout),
        manager.run_foreground_turn_with_history(
            &agent_id,
            &prompt,
            inherited_history,
            parent_cancel,
        ),
    )
    .await;

    let (content, is_error) = match run {
        Ok(Ok(ForegroundTurnOutcome::Completed(turn))) => {
            if matches!(turn.stop_reason, LoopTurnStopReason::Aborted) {
                let interrupted = parent_cancel.is_some_and(|signal| signal.triggered());
                let message = if interrupted {
                    USER_INTERRUPTED_SUBAGENT_MESSAGE
                } else {
                    SUBAGENT_STOPPED_MESSAGE
                };
                (
                    format_failure(&agent_id, &profile_name, message, false),
                    true,
                )
            } else {
                let summary = crate::subagent::manager::final_assistant_summary(&turn.messages);
                emit_subagent_event(
                    runtime.callbacks.as_ref(),
                    serde_json::json!({
                        "type": "subagent.completed",
                        "subagent_id": agent_id,
                        "result_summary": summary,
                        "usage": usage_json(&turn.usage),
                    }),
                );
                (format_success(&agent_id, &profile_name, &summary), false)
            }
        }
        Ok(Ok(ForegroundTurnOutcome::ParentCancelled)) => {
            // v2 suppresses the failure event for aborts; the user-interruption
            // message still becomes the tool result.
            (
                format_failure(
                    &agent_id,
                    &profile_name,
                    USER_INTERRUPTED_SUBAGENT_MESSAGE,
                    false,
                ),
                true,
            )
        }
        Ok(Err(message)) => {
            emit_failed(runtime.callbacks.as_ref(), &agent_id, &message);
            (
                format_failure(&agent_id, &profile_name, &message, false),
                true,
            )
        }
        Err(_elapsed) => {
            let _ = manager.kill(&agent_id).await;
            let message = format!(
                "Agent timed out after {}.",
                format_timeout_description(timeout)
            );
            emit_failed(runtime.callbacks.as_ref(), &agent_id, &message);
            (
                format_failure(&agent_id, &profile_name, &message, true),
                true,
            )
        }
    };
    Some(ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content,
        is_error,
        note: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::callbacks::HostCallbacks;
    use crate::rpc::types::{
        AskQuestionRequest, AskQuestionResponse, BoxFuture, ListToolsResponse, LlmChatRequest,
        LlmChatResponse, PermissionCheckRequest, PermissionDecision, TokenUsage,
        ToolExecuteRequest, ToolExecuteResponse,
    };
    use crate::subagent::types::SummaryPolicy;
    use crate::turn_loop::types::{
        LLM, LLMChatParams, LLMChatResponse as TurnChatResponse, ToolCall, ToolInfo,
    };
    use std::sync::Mutex;

    /// LLM that answers with one assistant text on the first call, then
    /// stops (a subagent that "summarizes" immediately).
    struct SummaryLlm;
    impl LLM for SummaryLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "summary-llm"
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
                    content: "findings: the loop is in run_turn.rs".into(),
                    thinking: vec![],
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    /// LLM whose every answer is one tool call, forcing a long loop for
    /// timeout tests.
    struct ToolForeverLlm;
    impl LLM for ToolForeverLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "tool-forever-llm"
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
                    content: String::new(),
                    thinking: vec![],
                    tool_calls: vec![ToolCall {
                        id: format!("tc-{}", fastrand::u64(..)),
                        name: "echo".into(),
                        arguments: serde_json::json!({}),
                        extras: None,
                    }],
                    finish_reason: Some("tool_calls".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    struct NoopCallbacks;
    impl HostCallbacks for NoopCallbacks {
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
            // A real table so tool-looping LLMs actually schedule calls
            // (the default error seam empties the table and ends the turn).
            Box::pin(async {
                Ok(ListToolsResponse {
                    tools: vec![ToolInfo {
                        name: "echo".into(),
                        description: "echo".into(),
                        input_schema: serde_json::json!({}),
                    }],
                })
            })
        }
    }

    async fn manager_with(llm: Arc<dyn LLM>) -> Arc<SubagentManager> {
        let manager = Arc::new(SubagentManager::new());
        manager
            .set_runtime(llm, Arc::new(NoopCallbacks), None)
            .await;
        manager
    }

    /// Register a profile without an allowlist so the looping LLM's `echo`
    /// tool survives the profile filter.
    async fn register_looper(manager: &SubagentManager) {
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "looper".into(),
                description: "loops".into(),
                system_prompt: "You loop.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
    }

    #[tokio::test]
    async fn resume_continues_a_completed_foreground_conversation() {
        let recorder = Arc::new(EventRecorder::new());
        let llm = Arc::new(RecordingPromptLlm::new(vec![
            "first pass findings".into(),
            "follow-up answer".into(),
        ]));
        let manager = manager_with_callbacks(llm.clone(), recorder.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let first = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "research", "prompt": "go" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("first turn runs natively");
        assert!(!first.is_error);
        let agent_id = recorder.events.lock().unwrap()[0]["subagent_id"]
            .as_str()
            .unwrap()
            .to_string();

        let second = execute_agent(
            &manager,
            &serde_json::json!({ "resume": agent_id, "prompt": "continue" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("native resume for a held conversation");
        assert!(!second.is_error);
        assert!(second.content.contains("follow-up answer"));
        assert_eq!(llm.call_count(), 2);
        // The resume turn saw the full prior conversation.
        let second_messages = llm.prompts.lock().unwrap().len();
        assert_eq!(second_messages, 2);
    }

    #[tokio::test]
    async fn unknown_resume_ids_stay_host_owned() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "resume": "agent-unknown", "prompt": "x" }),
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_none(), "unknown resume ids fall back to the host");
    }

    /// A finish_reason of `length` maps to a MaxTokens stop — v2 fails the
    /// subagent run with a verbatim error instead of reporting a summary.
    struct MaxTokensLlm;
    impl LLM for MaxTokensLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "max-tokens-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _: LLMChatParams,
        ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            Box::pin(async {
                Ok(TurnChatResponse {
                    content: "partial".into(),
                    thinking: vec![],
                    tool_calls: vec![],
                    finish_reason: Some("length".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    #[tokio::test]
    async fn max_tokens_truncation_fails_the_subagent_run() {
        let manager = manager_with(Arc::new(MaxTokensLlm)).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "research", "prompt": "go" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("truncation is a native outcome, not a fallback");
        assert!(result.is_error);
        assert!(
            result
                .content
                .contains("Subagent turn failed before completing its final summary"),
            "v2 max_tokens error text: {}",
            result.content
        );
    }

    #[tokio::test]
    async fn resume_turns_distill_under_the_same_policy() {
        let recorder = Arc::new(EventRecorder::new());
        let llm = Arc::new(RecordingPromptLlm::new(vec![
            "first pass summary that is long enough".into(),
            "short".into(),
            "follow-up answer with plenty of detail".into(),
        ]));
        let manager = manager_with_callbacks(llm.clone(), recorder.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: Some(SummaryPolicy {
                    min_chars: 20,
                    continuation_prompt: "Summarize fully.".into(),
                    retries: 1,
                }),
                model: None,
            })
            .await;
        let first = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "research", "prompt": "go" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("first turn runs natively");
        assert!(!first.is_error);
        let agent_id = recorder.events.lock().unwrap()[0]["subagent_id"]
            .as_str()
            .unwrap()
            .to_string();

        let second = execute_agent(
            &manager,
            &serde_json::json!({ "resume": agent_id, "prompt": "more" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("resume runs natively");
        assert!(!second.is_error);
        // three LLM calls: initial, resume turn, distillation continuation
        assert_eq!(llm.call_count(), 3);
        assert!(
            second
                .content
                .contains("follow-up answer with plenty of detail"),
            "the distilled continuation becomes the resume summary: {}",
            second.content
        );
    }

    #[test]
    fn timeout_description_mirrors_v2() {
        assert_eq!(format_timeout_description(2 * 60 * 60 * 1000), "2 hours");
        assert_eq!(format_timeout_description(60 * 60 * 1000), "1 hour");
        assert_eq!(format_timeout_description(5 * 60 * 1000), "5 minutes");
        assert_eq!(format_timeout_description(90 * 1000), "90 seconds");
        assert_eq!(format_timeout_description(1500), "1500 ms");
    }

    #[tokio::test]
    async fn foreground_success_formats_v2_shape() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "research",
                "prompt": "find the loop",
                "description": "Loop finder"
            }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("foreground call must run natively");
        assert!(!result.is_error);
        let content = result.content;
        assert!(content.contains("actual_subagent_type: research"));
        assert!(content.contains("status: completed"));
        assert!(content.contains("[summary]\nfindings: the loop is in run_turn.rs"));
        assert!(content.starts_with("agent_id: subagent-"));
    }

    #[tokio::test]
    async fn default_profile_is_coder() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        // The snapshot pushes `coder`; untyped calls must resolve to it.
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "coder".into(),
                description: "default".into(),
                system_prompt: "You code.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "prompt": "do it", "description": "x" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("untyped call resolves to the coder profile");
        assert!(result.content.contains("actual_subagent_type: coder"));
    }

    #[tokio::test]
    async fn unknown_profile_falls_back_to_host() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "plugin-reviewer", "prompt": "x" }),
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_none(), "unknown profiles stay host-owned");
    }

    #[tokio::test]
    async fn extended_features_fall_back_to_host() {
        let manager = manager_with(Arc::new(SummaryLlm)).await;
        // Unknown resume ids stay host-owned (P55 native resume only covers
        // agents whose conversation we hold; unknown ids fall back so the
        // host's persistent scopes can resolve them).
        assert!(
            execute_agent(
                &manager,
                &serde_json::json!({ "resume": "agent-9", "prompt": "x" }),
                None,
                None,
                None,
                None,
            )
            .await
            .is_none(),
            "unknown resume ids must fall back to the host"
        );
        // Note: `run_in_background` (P58), `resume`, `fork` and the explicit
        // `model` override are all native; the spawn paths cover them.
    }

    #[tokio::test]
    async fn timeout_reports_v2_failure_shape() {
        let manager = manager_with(Arc::new(ToolForeverLlm)).await;
        register_looper(&manager).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "looper", "prompt": "loop forever" }),
            Some(300),
            None,
            None,
            None,
        )
        .await
        .expect("timeout is a native outcome, not a fallback");
        assert!(result.is_error);
        assert!(result.content.contains("status: failed"));
        assert!(result.content.contains("Agent timed out after 300 ms."));
        assert!(result.content.contains("resume_hint:"));
    }

    /// An LLM that stalls briefly before answering, so a `timeout_ms` of
    /// `0` misread as "expire immediately" would fail the turn.
    struct SleepyLlm;
    impl LLM for SleepyLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "sleepy-llm"
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
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                Ok(TurnChatResponse {
                    content: "finished after the stall".into(),
                    thinking: vec![],
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    #[tokio::test]
    async fn zero_timeout_means_no_timeout() {
        // v2 `taskService` arms the timeout only when `timeoutMs > 0`:
        // an explicit `0` disables it (it must neither expire immediately
        // nor fold into the 2h default's timeout error path).
        let manager = manager_with(Arc::new(SleepyLlm)).await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "research", "prompt": "go" }),
            Some(0),
            None,
            None,
            None,
        )
        .await
        .expect("the run completes");
        assert!(
            !result.is_error,
            "timeout 0 must not kill the run: {}",
            result.content
        );
        assert!(result.content.contains("finished after the stall"));
    }

    #[tokio::test]
    async fn parent_cancellation_interrupts_the_subagent() {
        let manager = manager_with(Arc::new(ToolForeverLlm)).await;
        register_looper(&manager).await;
        let parent_cancel = ParentCancel::new();
        let signal = parent_cancel.clone();
        let abort_task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            signal.trigger();
        });
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "looper", "prompt": "loop until aborted" }),
            Some(60_000),
            Some(&parent_cancel),
            None,
            None,
        )
        .await
        .expect("abort is a native outcome, not a fallback");
        abort_task.await.unwrap();
        assert!(result.is_error);
        assert!(
            result.content.contains(USER_INTERRUPTED_SUBAGENT_MESSAGE),
            "parent abort reports the user-interrupted message: {}",
            result.content
        );
    }

    #[test]
    fn tool_policy_filter_allowlist_and_disallowed() {
        use crate::subagent::manager::ToolPolicyFilter;
        use crate::subagent::types::SubagentDefinition;
        let allow = ToolPolicyFilter::from_definition(&SubagentDefinition {
            name: "a".into(),
            description: String::new(),
            system_prompt: String::new(),
            tools: vec!["read".into(), "grep".into()],
            disallowed_tools: vec![],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        });
        assert!(allow.allows("Read"));
        assert!(allow.allows("grep"));
        assert!(!allow.allows("bash"));

        let deny = ToolPolicyFilter::from_definition(&SubagentDefinition {
            name: "b".into(),
            description: String::new(),
            system_prompt: String::new(),
            tools: vec![],
            disallowed_tools: vec!["Bash".into()],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        });
        assert!(deny.allows("read"));
        assert!(!deny.allows("bash"));
    }

    /// LLM that records the user content of every chat call, so tests can
    /// assert the prompt prefix and the continuation turn reached the model.
    struct RecordingPromptLlm {
        prompts: Mutex<Vec<String>>,
        messages_sent: Mutex<Vec<Vec<crate::turn_loop::types::LLMMessage>>>,
        /// Content returned per call (cycled on the last entry).
        responses: Vec<String>,
        calls: Mutex<usize>,
    }

    impl RecordingPromptLlm {
        fn new(responses: Vec<String>) -> Self {
            Self {
                prompts: Mutex::new(Vec::new()),
                messages_sent: Mutex::new(Vec::new()),
                responses,
                calls: Mutex::new(0),
            }
        }

        fn call_count(&self) -> usize {
            *self.calls.lock().unwrap()
        }

        fn first_prompt(&self) -> String {
            self.prompts.lock().unwrap()[0].clone()
        }
    }

    impl LLM for RecordingPromptLlm {
        fn system_prompt(&self) -> &str {
            "test"
        }
        fn model_name(&self) -> &str {
            "recording-prompt-llm"
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }
        fn chat(
            &self,
            params: LLMChatParams,
        ) -> BoxFuture<'_, Result<TurnChatResponse, Box<dyn std::error::Error + Send + Sync>>>
        {
            let mut prompts = self.prompts.lock().unwrap();
            self.messages_sent
                .lock()
                .unwrap()
                .push(params.messages.to_vec());
            if let Some(last_user) = params
                .messages
                .iter()
                .rev()
                .find(|m| m.role == "user" && !m.content.starts_with("<system-reminder>"))
            {
                prompts.push(last_user.content.clone());
            }
            drop(prompts);
            let mut calls = self.calls.lock().unwrap();
            let index = (*calls).min(self.responses.len() - 1);
            *calls += 1;
            let content = self.responses[index].clone();
            drop(calls);
            Box::pin(async move {
                Ok(TurnChatResponse {
                    content,
                    thinking: vec![],
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage::default(),
                })
            })
        }
    }

    /// [`NoopCallbacks`] that records the `emit_event` payloads.
    struct EventRecorder {
        inner: NoopCallbacks,
        events: Mutex<Vec<serde_json::Value>>,
    }

    impl EventRecorder {
        fn new() -> Self {
            Self {
                inner: NoopCallbacks,
                events: Mutex::new(Vec::new()),
            }
        }

        fn types(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| event.get("type").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        }
    }

    impl HostCallbacks for EventRecorder {
        fn llm_chat(
            &self,
            request: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            self.inner.llm_chat(request)
        }
        fn execute_tool(
            &self,
            request: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.inner.execute_tool(request)
        }
        fn check_permission(
            &self,
            request: PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            self.inner.check_permission(request)
        }
        fn emit_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event);
        }
    }

    async fn manager_with_callbacks(
        llm: Arc<dyn LLM>,
        callbacks: Arc<dyn HostCallbacks>,
    ) -> Arc<SubagentManager> {
        let manager = Arc::new(SubagentManager::new());
        manager.set_runtime(llm, callbacks, None).await;
        manager
    }

    #[tokio::test]
    async fn prompt_prefix_rides_ahead_of_the_prompt() {
        let llm = Arc::new(RecordingPromptLlm::new(vec!["done".into()]));
        let manager = manager_with(llm.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "explore".into(),
                description: "d".into(),
                system_prompt: "You explore.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: Some("<git-context>".into()),
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "explore", "prompt": "scan it" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("prefix profile runs natively");
        assert!(!result.is_error);
        let prompt = llm.first_prompt();
        assert!(
            prompt.contains("<git-context>\n\nscan it"),
            "prefix rides ahead of the prompt as {{prefix}}\\n\\n{{prompt}}: {prompt}"
        );
        assert_eq!(llm.call_count(), 1, "no policy: no continuation turns");
    }

    #[tokio::test]
    async fn summary_policy_distills_through_continuation_turns() {
        let llm = Arc::new(RecordingPromptLlm::new(vec![
            "too short".into(),
            "a much longer final summary that clearly clears the floor".into(),
        ]));
        let manager = manager_with(llm.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "coder".into(),
                description: "d".into(),
                system_prompt: "You code.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: Some(SummaryPolicy {
                    min_chars: 20,
                    continuation_prompt: "Summarize fully.".into(),
                    retries: 2,
                }),
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "coder", "prompt": "do it" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("distill runs natively");
        assert!(!result.is_error);
        assert!(
            result
                .content
                .contains("[summary]\na much longer final summary that clearly clears the floor"),
            "the adequate continuation text becomes the summary: {}",
            result.content
        );
        assert_eq!(llm.call_count(), 2, "one continuation turn");
        let second_prompt = llm.prompts.lock().unwrap()[1].clone();
        assert_eq!(second_prompt, "Summarize fully.");
    }

    #[tokio::test]
    async fn adequate_summary_skips_distillation() {
        let long = "x".repeat(200);
        let llm = Arc::new(RecordingPromptLlm::new(vec![long.clone()]));
        let manager = manager_with(llm.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "coder".into(),
                description: "d".into(),
                system_prompt: "You code.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: Some(SummaryPolicy {
                    min_chars: 100,
                    continuation_prompt: "continue".into(),
                    retries: 1,
                }),
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({ "subagent_type": "coder", "prompt": "do it" }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("runs natively");
        assert!(!result.is_error);
        assert_eq!(llm.call_count(), 1, "adequate summary: no re-prompt");
        assert!(result.content.contains(&long));
    }

    #[tokio::test]
    async fn lifecycle_events_mirror_the_v2_surface() {
        let llm = Arc::new(RecordingPromptLlm::new(vec!["findings: all done".into()]));
        let recorder = Arc::new(EventRecorder::new());
        let manager = manager_with_callbacks(llm, recorder.clone()).await;
        manager
            .register_definition(crate::subagent::types::SubagentDefinition {
                name: "research".into(),
                description: "d".into(),
                system_prompt: "You research.".into(),
                tools: vec![],
                disallowed_tools: vec![],
                prompt_prefix: None,
                summary_policy: None,
                model: None,
            })
            .await;
        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "research",
                "prompt": "go",
                "description": "Scout"
            }),
            None,
            None,
            Some("tool-call-7"),
            None,
        )
        .await
        .expect("runs natively");
        assert!(!result.is_error);
        assert_eq!(
            recorder.types(),
            vec![
                "subagent.spawned".to_string(),
                "subagent.started".to_string(),
                "subagent.completed".to_string(),
            ]
        );
        let events = recorder.events.lock().unwrap();
        let spawned = &events[0];
        assert_eq!(spawned["subagent_name"], "research");
        assert_eq!(spawned["parent_tool_call_id"], "tool-call-7");
        assert_eq!(spawned["description"], "Scout");
        assert_eq!(spawned["run_in_background"], false);
        let agent_id = spawned["subagent_id"].as_str().unwrap();
        assert!(agent_id.starts_with("subagent-"));
        assert_eq!(events[1]["subagent_id"], spawned["subagent_id"]);
        assert_eq!(events[2]["result_summary"], "findings: all done");
        assert!(events[2]["usage"]["total_tokens"].is_number());
    }

    #[tokio::test]
    async fn fork_inherits_conversation_history_and_runs_natively() {
        let recorder = Arc::new(EventRecorder::new());
        let llm = Arc::new(RecordingPromptLlm::new(vec![
            "forked agent response".into(),
        ]));
        let manager = manager_with_callbacks(llm.clone(), recorder.clone()).await;
        manager.register_builtin_profiles().await;

        let parent_history = Arc::new(std::sync::Mutex::new(vec![
            crate::turn_loop::types::LLMMessage::new("user", "parent prompt"),
            crate::turn_loop::types::LLMMessage {
                role: "assistant".into(),
                content: "I will call a tool".into(),
                blocks: Vec::new(),
                tool_calls: vec![crate::turn_loop::types::ToolCall {
                    id: "call-1".into(),
                    name: "Agent".into(),
                    arguments: serde_json::json!({ "prompt": "child task", "fork": true }),
                    extras: None,
                }],
                tool_call_id: None,
            },
        ]));

        let result = crate::tools::CURRENT_CONVERSATION_HISTORY
            .scope(parent_history, async {
                execute_agent(
                    &manager,
                    &serde_json::json!({
                        "prompt": "continue from fork",
                        "description": "forked child",
                        "fork": true,
                    }),
                    None,
                    None,
                    Some("call-1"),
                    None,
                )
                .await
            })
            .await;

        assert!(
            result.is_some(),
            "fork must execute natively, not fall back to host"
        );
        let res = result.unwrap();
        assert!(
            !res.is_error,
            "fork execution must succeed: {}",
            res.content
        );
        assert!(res.content.contains("status: completed"));
        assert!(res.content.contains("forked agent response"));

        let messages_sent = llm.messages_sent.lock().unwrap();
        assert_eq!(messages_sent.len(), 1);
        let sent_messages = &messages_sent[0];
        // sent_messages has: system message (from run_turn), then the 4 forked messages
        let user_idx = sent_messages
            .iter()
            .position(|m| m.content == "parent prompt")
            .expect("parent prompt must be present");
        assert_eq!(sent_messages[user_idx].role, "user");
        assert_eq!(sent_messages[user_idx + 1].role, "assistant");
        assert_eq!(sent_messages[user_idx + 1].content, "I will call a tool");
        assert_eq!(sent_messages[user_idx + 2].role, "tool");
        assert_eq!(
            sent_messages[user_idx + 2].tool_call_id.as_deref(),
            Some("call-1")
        );
        assert_eq!(
            sent_messages[user_idx + 2].content,
            crate::subagent::INHERITED_IN_FLIGHT_TOOL_OUTPUT
        );
        assert_eq!(sent_messages[user_idx + 3].role, "user");
        assert!(
            sent_messages[user_idx + 3]
                .content
                .contains("continue from fork")
        );
    }

    #[tokio::test]
    async fn run_in_background_registers_in_task_runner() {
        let recorder = Arc::new(EventRecorder::new());
        let llm = Arc::new(SummaryLlm);
        let manager = manager_with_callbacks(llm, recorder.clone()).await;
        manager.register_builtin_profiles().await;
        let runner = Arc::new(crate::storage::TaskRunner::new(None));
        manager.set_task_runner(runner.clone()).await;

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "run_in_background": true,
                "prompt": "background work",
                "description": "Scout background",
                "subagent_type": "coder",
            }),
            None,
            None,
            Some("call-bg-1"),
            None,
        )
        .await
        .expect("must execute natively");

        assert!(!result.is_error);
        assert!(result.content.contains("status: running"));
        assert!(result.content.contains("task_id: subagent-"));

        let agent_id = result
            .content
            .lines()
            .find(|l| l.starts_with("task_id: "))
            .unwrap()
            .strip_prefix("task_id: ")
            .unwrap();

        let wait_res = runner.wait(agent_id, 3000).await;
        assert!(matches!(
            wait_res,
            crate::storage::TaskWaitResult::Completed(_)
        ));

        let output = runner.get_output(agent_id);
        assert_eq!(
            output.as_deref(),
            Some("findings: the loop is in run_turn.rs")
        );

        let entry = runner.entry(agent_id).expect("entry must exist");
        assert_eq!(entry["status"], "completed");
        assert_eq!(entry["description"], "Scout background");
    }

    #[tokio::test]
    async fn run_in_background_cooperative_stop_via_task_runner() {
        let recorder = Arc::new(EventRecorder::new());
        let llm = Arc::new(ToolForeverLlm);
        let manager = manager_with_callbacks(llm, recorder.clone()).await;
        register_looper(&manager).await;
        let runner = Arc::new(crate::storage::TaskRunner::new(None));
        manager.set_task_runner(runner.clone()).await;

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "run_in_background": true,
                "prompt": "loop in background",
                "description": "Background looper",
                "subagent_type": "looper",
            }),
            None,
            None,
            Some("call-bg-2"),
            None,
        )
        .await
        .expect("must execute natively");

        let agent_id = result
            .content
            .lines()
            .find(|l| l.starts_with("task_id: "))
            .unwrap()
            .strip_prefix("task_id: ")
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let stop_res = runner
            .stop(agent_id, None)
            .await
            .expect("stop should succeed");
        assert_eq!(stop_res["status"], "killed");
        assert_eq!(stop_res["stopReason"], "Stopped by TaskStop");
    }

    // ── [secondary_model] pool ─────────────────────────────────────────────

    use crate::rpc::types::{SecondaryModelEntry, SecondaryModelPool};
    use crate::subagent::secondary::{PRIMARY_MODEL_CHOICE, SecondaryModelRuntime};

    /// Build a pool runtime whose `strong` alias binds `alias_llm`.
    fn pool_runtime(alias_llm: Arc<RecordingPromptLlm>, force: bool) -> SecondaryModelRuntime {
        let config = SecondaryModelPool {
            force,
            default_model: "strong".into(),
            caller_model_alias: Some("main-model".into()),
            models: vec![SecondaryModelEntry {
                alias: "strong".into(),
                hint: "Pick this for hard problems.".into(),
                llm: Default::default(),
            }],
        };
        SecondaryModelRuntime::new(
            config,
            [(
                "strong".to_string(),
                alias_llm as Arc<dyn crate::turn_loop::types::LLM>,
            )]
            .into_iter()
            .collect(),
        )
    }

    #[tokio::test]
    async fn agent_with_a_pool_alias_runs_on_the_pool_llm() {
        let recorder = Arc::new(EventRecorder::new());
        let session_llm = Arc::new(RecordingPromptLlm::new(vec!["session answer".into()]));
        let alias_llm = Arc::new(RecordingPromptLlm::new(vec!["pool answer".into()]));
        let manager = manager_with_callbacks(session_llm.clone(), recorder.clone()).await;
        let pool = pool_runtime(alias_llm.clone(), false);

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "coder",
                "prompt": "hard task",
                "model": "strong",
            }),
            None,
            None,
            None,
            Some(&pool),
        )
        .await
        .expect("pool aliases run natively");

        assert!(!result.is_error, "{}", result.content);
        assert_eq!(alias_llm.call_count(), 1, "the pool alias served the turn");
        assert_eq!(session_llm.call_count(), 0, "the session model stayed idle");
    }

    #[tokio::test]
    async fn agent_primary_binds_the_session_model() {
        let recorder = Arc::new(EventRecorder::new());
        let session_llm = Arc::new(RecordingPromptLlm::new(vec!["session answer".into()]));
        let alias_llm = Arc::new(RecordingPromptLlm::new(vec!["pool answer".into()]));
        let manager = manager_with_callbacks(session_llm.clone(), recorder.clone()).await;
        let pool = pool_runtime(alias_llm.clone(), false);

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "coder",
                "prompt": "quality task",
                "model": PRIMARY_MODEL_CHOICE,
            }),
            None,
            None,
            None,
            Some(&pool),
        )
        .await
        .expect("primary runs natively");

        assert!(!result.is_error, "{}", result.content);
        assert_eq!(
            session_llm.call_count(),
            1,
            "primary bound the session model"
        );
        assert_eq!(alias_llm.call_count(), 0);
    }

    #[tokio::test]
    async fn agent_invalid_pool_alias_lists_the_choices() {
        let recorder = Arc::new(EventRecorder::new());
        let session_llm = Arc::new(RecordingPromptLlm::new(vec!["session answer".into()]));
        let manager = manager_with_callbacks(session_llm.clone(), recorder.clone()).await;
        let pool = pool_runtime(Arc::new(RecordingPromptLlm::new(vec![])), false);

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "coder",
                "prompt": "task",
                "model": "nope",
            }),
            None,
            None,
            None,
            Some(&pool),
        )
        .await
        .expect("invalid aliases resolve to an error result, not a host fallback");

        assert!(result.is_error);
        assert!(
            result.content.contains("Invalid model \"nope\""),
            "{}",
            result.content
        );
        assert!(
            result.content.contains("strong, primary"),
            "{}",
            result.content
        );
        assert_eq!(session_llm.call_count(), 0, "no turn ran");
    }

    #[tokio::test]
    async fn agent_force_rejects_an_explicit_model() {
        let recorder = Arc::new(EventRecorder::new());
        let session_llm = Arc::new(RecordingPromptLlm::new(vec!["session answer".into()]));
        let manager = manager_with_callbacks(session_llm.clone(), recorder.clone()).await;
        let pool = pool_runtime(Arc::new(RecordingPromptLlm::new(vec![])), true);

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "coder",
                "prompt": "task",
                "model": "strong",
            }),
            None,
            None,
            None,
            Some(&pool),
        )
        .await
        .expect("force rejections are error results");

        assert!(result.is_error);
        assert!(
            result.content.contains("[secondary_model].force"),
            "{}",
            result.content
        );
    }

    #[tokio::test]
    async fn agent_without_a_pool_rejects_an_explicit_model() {
        let recorder = Arc::new(EventRecorder::new());
        let session_llm = Arc::new(RecordingPromptLlm::new(vec!["session answer".into()]));
        let manager = manager_with_callbacks(session_llm.clone(), recorder.clone()).await;

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "coder",
                "prompt": "task",
                "model": "strong",
            }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("no-pool model overrides are error results, not host fallbacks");

        assert!(result.is_error);
        assert!(
            result.content.contains("no [secondary_model.models] pool"),
            "{}",
            result.content
        );
        assert_eq!(session_llm.call_count(), 0, "no turn ran");
    }

    #[tokio::test]
    async fn agent_without_a_pool_accepts_primary() {
        let recorder = Arc::new(EventRecorder::new());
        let session_llm = Arc::new(RecordingPromptLlm::new(vec!["session answer".into()]));
        let manager = manager_with_callbacks(session_llm.clone(), recorder.clone()).await;

        let result = execute_agent(
            &manager,
            &serde_json::json!({
                "subagent_type": "coder",
                "prompt": "task",
                "model": PRIMARY_MODEL_CHOICE,
            }),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("primary without a pool inherits the caller's model");

        assert!(!result.is_error, "{}", result.content);
        assert_eq!(
            session_llm.call_count(),
            1,
            "the session model served the turn"
        );
    }

    #[test]
    fn agent_def_lists_each_type_tool_scope() {
        // v2 `buildSubagentTypeDescriptions` + `resolveActiveToolNames`: the
        // model picks a subagent by what it is allowed to do, so every
        // advertised type carries its tool scope (MCP globs included).
        let def = agent_tool_def(None);
        let listing = def
            .description
            .split("Available agent types:")
            .nth(1)
            .expect("the description advertises the available types");
        for line in listing.lines() {
            if !line.starts_with("- ") {
                continue;
            }
            let name = line
                .trim_start_matches("- ")
                .split(':')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            let catalog = crate::prompt::profiles::ProfileCatalog::with_builtins();
            let profile = catalog
                .list()
                .iter()
                .find(|p| p.name == name)
                .unwrap_or_else(|| panic!("advertised type {name} has no profile"));
            let expected = format!("  Tools: {}", profile_tools_listing(profile));
            assert!(
                def.description.contains(&format!("- {name}")),
                "type {name} must be advertised"
            );
            assert!(
                def.description.contains(&expected),
                "type {name} must advertise its tool scope: {expected}\n{}",
                def.description
            );
        }
        // The built-in `explore` profile advertises its read-only scope.
        let explore_scope = listing
            .lines()
            .skip_while(|line| !line.starts_with("- explore"))
            .nth(1)
            .unwrap_or_default()
            .to_string();
        assert!(explore_scope.starts_with("  Tools: "), "{explore_scope}");
    }

    #[test]
    fn profile_tools_listing_matches_v2_wording() {
        let profile = crate::prompt::profiles::AgentProfile {
            name: "t".into(),
            description: "d".into(),
            role_additional: String::new(),
            tools: vec!["Read".into(), "mcp__*".into()],
        };
        assert_eq!(profile_tools_listing(&profile), "Read, mcp__*");
        let unrestricted = crate::prompt::profiles::AgentProfile {
            name: "t".into(),
            description: "d".into(),
            role_additional: String::new(),
            tools: vec![],
        };
        assert_eq!(profile_tools_listing(&unrestricted), "all");
    }

    #[test]
    fn agent_def_advertises_the_pool_only_when_a_choice_is_offered() {
        let llm = Arc::new(RecordingPromptLlm::new(vec![]));
        let offered = agent_tool_def(Some(&pool_runtime(llm.clone(), false)));
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

        let forced = agent_tool_def(Some(&pool_runtime(llm, true)));
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

        let bare = agent_tool_def(None);
        assert!(!bare.description.contains("Available models"));
        assert!(
            bare.input_schema
                .get("properties")
                .and_then(|properties| properties.get("model"))
                .is_none()
        );
    }
}
