//! `Workflow` tool: the model-facing entry to the native workflow engine.
//!
//! Ported from the retired `agent-core-v2` `WorkflowTool`; `run` starts a
//! background workflow and returns a run id, with `status` / `wait` / `cancel`
//! managing the run, plus a `list` extension for the `/workflow list` hint.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::turn_loop::types::ToolInfo;
use crate::workflow::{
    WorkflowHost, WorkflowRunResult, WorkflowService, WorkflowStatus, get_builtin,
    resolve_user_workflow,
};

pub const WORKFLOW_TOOL_DESCRIPTION: &str = include_str!("workflow_tool.md");

pub fn workflow_tool_def() -> ToolInfo {
    ToolInfo {
        name: "Workflow".into(),
        description: WORKFLOW_TOOL_DESCRIPTION.into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["run", "status", "wait", "cancel", "list"],
                    "description": "The workflow operation to perform."
                },
                "name": {
                    "type": "string",
                    "description": "Built-in or user workflow name (for `run`). Mutually exclusive with `script`."
                },
                "script": {
                    "type": "string",
                    "description": "Inline workflow script (for `run`). Mutually exclusive with `name`."
                },
                "args": {
                    "type": "string",
                    "description": "Arguments to pass to the workflow (for `run`)."
                },
                "run_id": {
                    "type": "string",
                    "description": "Workflow run ID (for `status`, `wait`, `cancel`)."
                },
                "timeout_ms": {
                    "type": "number",
                    "description": "Timeout in milliseconds (for `wait`)."
                }
            },
            "required": ["operation"]
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowToolOutcome {
    pub content: String,
    pub is_error: bool,
    pub stop_turn: bool,
}

impl WorkflowToolOutcome {
    fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
            stop_turn: false,
        }
    }

    fn err(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
            stop_turn: false,
        }
    }
}

/// Execute one `Workflow` tool call. `host` is only required for `run`; the
/// read/control operations work without a subagent runtime attached.
pub async fn run_workflow_tool(
    service: &WorkflowService,
    host: Option<Arc<dyn WorkflowHost>>,
    home: Option<&Path>,
    input: &Value,
) -> WorkflowToolOutcome {
    let operation = input
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match operation {
        "run" => {
            let Some(host) = host else {
                return WorkflowToolOutcome::err(
                    "Workflow is unavailable: no subagent runtime is attached.",
                );
            };
            handle_run(service, host, home, input)
        }
        "list" => handle_list(service),
        "status" => match required_run_id(input) {
            Ok(run_id) => match service.status(&run_id) {
                Some(result) => WorkflowToolOutcome::ok(format_status(&result)),
                None => WorkflowToolOutcome::ok(format!("Workflow run not found: {run_id}")),
            },
            Err(outcome) => outcome,
        },
        "wait" => {
            let run_id = match required_run_id(input) {
                Ok(run_id) => run_id,
                Err(outcome) => return outcome,
            };
            let timeout = input.get("timeout_ms").and_then(Value::as_u64);
            match service.wait(&run_id, timeout).await {
                Some(result) if result.status == WorkflowStatus::Completed => {
                    let rendered = match result.result.as_ref() {
                        Some(Value::String(text)) => text.clone(),
                        Some(value) => serde_json::to_string_pretty(value)
                            .unwrap_or_else(|_| value.to_string()),
                        None => String::new(),
                    };
                    let duration = ((result.finished_at.unwrap_or(result.started_at)
                        - result.started_at) as f64)
                        / 1000.0;
                    let mut outcome = WorkflowToolOutcome::ok(format!(
                        "Workflow completed.\nAgent runs: {}\nDuration: {duration:.1}s\n\nResult:\n{rendered}",
                        result.agent_count
                    ));
                    outcome.stop_turn = true;
                    outcome
                }
                Some(result) => WorkflowToolOutcome::ok(format_status(&result)),
                None => WorkflowToolOutcome::ok(format!("Workflow run not found: {run_id}")),
            }
        }
        "cancel" => match required_run_id(input) {
            Ok(run_id) => {
                service.cancel(&run_id).await;
                WorkflowToolOutcome::ok(format!("Workflow cancelled: {run_id}"))
            }
            Err(outcome) => outcome,
        },
        other => WorkflowToolOutcome::err(format!("Unknown workflow operation: {other}")),
    }
}

fn handle_list(service: &WorkflowService) -> WorkflowToolOutcome {
    let builtins = service.list_builtins();
    if builtins.is_empty() {
        return WorkflowToolOutcome::ok("No built-in workflows are registered.");
    }
    let mut lines = vec!["Available workflows:".to_string()];
    for meta in builtins {
        lines.push(format!("- {} — {}", meta.name, meta.description));
    }
    WorkflowToolOutcome::ok(lines.join("\n"))
}

fn handle_run(
    service: &WorkflowService,
    host: Arc<dyn WorkflowHost>,
    home: Option<&Path>,
    input: &Value,
) -> WorkflowToolOutcome {
    let name = input.get("name").and_then(Value::as_str);
    let script = input.get("script").and_then(Value::as_str);
    let (script, workflow_name) = match (name, script) {
        (Some(_), Some(_)) => {
            return WorkflowToolOutcome::err("`name` and `script` are mutually exclusive.");
        }
        (Some(name), None) => {
            if let Some((builtin_script, meta)) = get_builtin(name) {
                (builtin_script.to_string(), meta.name)
            } else if let Some(home) = home {
                match resolve_user_workflow(home, name) {
                    Some((user_script, meta)) => (user_script, meta.name),
                    None => {
                        return WorkflowToolOutcome::err(format!("Workflow not found: {name}"));
                    }
                }
            } else {
                return WorkflowToolOutcome::err(format!("Workflow not found: {name}"));
            }
        }
        (None, Some(script)) => (script.to_string(), "inline".to_string()),
        (None, None) => {
            return WorkflowToolOutcome::err("Either `name` or `script` is required for `run`.");
        }
    };

    let args = input.get("args").cloned();
    let run_id = service.start(script, args, host);
    WorkflowToolOutcome::ok(format!(
        "Workflow \"{workflow_name}\" started. run_id: {run_id}\nUse Workflow({{ operation: \"wait\", run_id: \"{run_id}\" }}) to block until it completes, or Workflow({{ operation: \"status\", run_id: \"{run_id}\" }}) to check progress."
    ))
}

fn required_run_id(input: &Value) -> Result<String, WorkflowToolOutcome> {
    input
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| WorkflowToolOutcome::err("`run_id` is required for this operation."))
}

fn format_status(result: &WorkflowRunResult) -> String {
    let elapsed = ((result.finished_at.unwrap_or_else(now_ms) - result.started_at) as f64) / 1000.0;
    let mut lines = vec![
        format!("run_id: {}", result.run_id),
        format!("status: {}", status_label(result.status)),
        format!("agents: {}", result.agent_count),
        format!("elapsed: {elapsed:.1}s"),
    ];
    if let Some(phase) = result.current_phase.as_deref() {
        lines.push(format!("phase: {phase}"));
    }
    if let Some(error) = result.error.as_deref() {
        lines.push(format!("error: {error}"));
    }
    lines.join("\n")
}

fn status_label(status: WorkflowStatus) -> &'static str {
    match status {
        WorkflowStatus::Running => "running",
        WorkflowStatus::Completed => "completed",
        WorkflowStatus::Failed => "failed",
        WorkflowStatus::Cancelled => "cancelled",
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{SearchHit, WorkflowAgentOpts};
    use async_trait::async_trait;

    struct MockHost;

    #[async_trait]
    impl WorkflowHost for MockHost {
        async fn spawn_agent(&self, prompt: String, _opts: WorkflowAgentOpts) -> Option<Value> {
            Some(Value::String(format!("done:{prompt}")))
        }
        async fn search(&self, _query: String, _count: usize) -> Vec<SearchHit> {
            Vec::new()
        }
        fn workspace_root(&self) -> std::path::PathBuf {
            std::env::temp_dir()
        }
        fn home_dir(&self) -> Option<std::path::PathBuf> {
            None
        }
    }

    #[tokio::test]
    async fn list_includes_the_builtins() {
        let service = WorkflowService::new();
        let outcome = run_workflow_tool(
            &service,
            None,
            None,
            &serde_json::json!({ "operation": "list" }),
        )
        .await;
        assert!(!outcome.is_error);
        assert!(outcome.content.contains("deep-research"));
    }

    #[cfg(feature = "workflow-js")]
    #[tokio::test]
    async fn run_status_wait_round_trip() {
        let service = WorkflowService::new();
        let host: Arc<dyn WorkflowHost> = Arc::new(MockHost);
        let started = run_workflow_tool(
            &service,
            Some(host.clone()),
            None,
            &serde_json::json!({
                "operation": "run",
                "script": "const a = await agent('x'); return a;",
            }),
        )
        .await;
        assert!(!started.is_error, "{}", started.content);
        let run_id = started
            .content
            .split("run_id: ")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .to_string();

        let waited = run_workflow_tool(
            &service,
            Some(host),
            None,
            &serde_json::json!({ "operation": "wait", "run_id": run_id, "timeout_ms": 5000 }),
        )
        .await;
        assert!(!waited.is_error);
        assert!(waited.content.contains("Workflow completed."));
        assert!(waited.content.contains("done:x"));
    }

    #[tokio::test]
    async fn run_requires_name_or_script() {
        let service = WorkflowService::new();
        let outcome = run_workflow_tool(
            &service,
            Some(Arc::new(MockHost) as Arc<dyn WorkflowHost>),
            None,
            &serde_json::json!({ "operation": "run" }),
        )
        .await;
        assert!(outcome.is_error);
    }
}
