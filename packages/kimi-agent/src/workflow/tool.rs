//! Native `Workflow` tool — run built-in orchestrator workflows in the
//! background with `run` / `list` / `status` / `wait` / `cancel` operations.
//!
//! Corresponds to `packages/agent-core-v2/src/app/workflow/tools/workflow.ts`.
//!
//! The TS tool ran user-supplied JS scripts in a `vm` sandbox; the native
//! engine is data-driven instead: `run` accepts a built-in workflow `name`
//! and drives it with native subagents (see [`super::builtin`]). Runs execute
//! on a background task; `run` returns immediately with a `run_id`, and
//! `status` / `wait` / `cancel` observe the shared run entry. The run
//! registry lives on the `Agent` so runs survive across turns (mirrors the
//! App-scoped TS `WorkflowService`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::callbacks::HostCallbacks;
use crate::permission::gate::PermissionGate;
use crate::rpc::types::{BoxFuture, NativeLlmConfig, ToolExecuteRequest, ToolExecuteResponse};

use super::builtin::{BUILTINS, ExecutorParams, WorkflowSpec, execute_workflow};
use super::types::{WorkflowRunEntry, WorkflowRunStatus, format_status};

/// Model-facing tool name (mirrors the TS `WorkflowTool.name`).
pub(crate) const WORKFLOW_TOOL_NAME: &str = "Workflow";

/// Poll interval for `wait` (mirrors the TS service's 500ms poll).
const WAIT_POLL_MS: u64 = 500;
/// Default `wait` timeout when `timeout_ms` is omitted (60s).
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 60_000;

/// Shared registry of workflow runs, keyed by run id. Lives on the `Agent`
/// (interior-mutable) so runs persist across turns.
#[derive(Default)]
pub(crate) struct WorkflowRegistry {
    runs: HashMap<String, Arc<Mutex<WorkflowRunEntry>>>,
    counter: u64,
}

impl WorkflowRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Register a new run and return its id plus the shared run entry.
    fn insert(&mut self, workflow_name: &str) -> (String, Arc<Mutex<WorkflowRunEntry>>) {
        self.counter += 1;
        let run_id = format!("wf_{}", self.counter);
        let entry = Arc::new(Mutex::new(WorkflowRunEntry::new(
            run_id.clone(),
            workflow_name.to_string(),
        )));
        self.runs.insert(run_id.clone(), entry.clone());
        (run_id, entry)
    }

    fn get(&self, run_id: &str) -> Option<Arc<Mutex<WorkflowRunEntry>>> {
        self.runs.get(run_id).cloned()
    }
}

/// Intercepts the `Workflow` tool and runs built-in workflows natively.
pub(crate) struct WorkflowToolInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    /// Raw host callbacks handed to workflow child agents (not the per-turn
    /// interceptor chain), so their own native chain sits on top of the host.
    pub host: Arc<dyn HostCallbacks>,
    pub homedir: Option<String>,
    pub native_llm: Option<NativeLlmConfig>,
    pub permission: PermissionGate,
    pub system_prompt: String,
    pub max_steps_per_turn: u32,
    /// Parent agent's subagent depth; workflow children run at `depth + 1`.
    pub depth: u32,
    pub hooks: Option<Arc<crate::hooks::external::HookManager>>,
    pub record_store: Option<std::sync::Arc<crate::persistence::RecordStore>>,
    /// Shared run registry (persists across turns).
    pub registry: Arc<Mutex<WorkflowRegistry>>,
}

impl WorkflowToolInterceptor {
    fn error(content: String) -> ToolExecuteResponse {
        ToolExecuteResponse {
            content,
            is_error: true,
            is_prediction: false,
            stop_turn: false,
            media: Vec::new(),
        }
    }

    fn response(content: String, stop_turn: bool) -> ToolExecuteResponse {
        ToolExecuteResponse {
            content,
            is_error: false,
            is_prediction: false,
            stop_turn,
            media: Vec::new(),
        }
    }

    /// Build the params the workflow executors use to spawn native children.
    fn executor_params(&self) -> ExecutorParams {
        ExecutorParams {
            host: self.host.clone(),
            homedir: self.homedir.clone(),
            native_llm: self.native_llm.clone(),
            permission: self.permission.clone(),
            system_prompt: self.system_prompt.clone(),
            max_steps: self.max_steps_per_turn,
            depth: self.depth,
            hooks: self.hooks.clone(),
            record_store: self.record_store.clone(),
        }
    }

    fn find_builtin(name: &str) -> Option<&'static WorkflowSpec> {
        BUILTINS.iter().find(|spec| spec.name == name)
    }

    /// Transition a run entry to its terminal state once the executor
    /// returns. Cancellation wins over the executor's own result; otherwise
    /// `Ok` → completed (with the result) and `Err` → failed (with the error).
    /// Kept as a free function so the finalization logic is unit-testable
    /// without driving a real background run.
    fn finalize_run(entry: &Arc<Mutex<WorkflowRunEntry>>, result: Result<String, String>) {
        if let Ok(mut e) = entry.lock() {
            let cancelled = e.is_cancelled();
            if cancelled {
                e.status = WorkflowRunStatus::Cancelled;
                e.error = Some("cancelled by user".into());
            } else {
                match result {
                    Ok(text) => {
                        e.status = WorkflowRunStatus::Completed;
                        e.result = Some(text);
                    }
                    Err(err) => {
                        e.status = WorkflowRunStatus::Failed;
                        e.error = Some(err);
                    }
                }
            }
            e.finished_at = Some(Instant::now());
        }
    }
}

impl HostCallbacks for WorkflowToolInterceptor {
    fn supports_tool_lifecycle(&self) -> bool {
        self.inner.supports_tool_lifecycle()
    }
    fn llm_chat(
        &self,
        r: crate::rpc::types::LlmChatRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
        self.inner.llm_chat(r)
    }
    fn execute_tool(
        &self,
        req: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if !req.tool_name.eq_ignore_ascii_case(WORKFLOW_TOOL_NAME) {
            return self.inner.execute_tool(req);
        }
        let operation = req
            .arguments
            .get("operation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        match operation.as_str() {
            "run" => self.handle_run(&req.arguments),
            "list" => self.handle_list(),
            "status" => self.handle_status(&req.arguments),
            "wait" => self.handle_wait(&req.arguments),
            "cancel" => self.handle_cancel(&req.arguments),
            _ => Box::pin(async move {
                Ok(Self::error(format!("Unknown workflow operation: {operation}")))
            }),
        }
    }
    fn emit_event(&self, e: serde_json::Value) {
        self.inner.emit_event(e);
    }
    fn prepare_tool_execution(
        &self,
        r: crate::rpc::types::PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> {
        self.inner.prepare_tool_execution(r)
    }
    fn authorize_tool_execution(
        &self,
        r: crate::rpc::types::AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> {
        self.inner.authorize_tool_execution(r)
    }
    fn finalize_tool_result(
        &self,
        r: crate::rpc::types::FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> {
        self.inner.finalize_tool_result(r)
    }
}

impl WorkflowToolInterceptor {
    /// `run` — start a built-in workflow on a background task and return its
    /// run id immediately. Inline `script` and unknown `name` are rejected.
    fn handle_run(&self, args: &serde_json::Value) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let script = args
            .get("script")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        if name.is_empty() && script.is_empty() {
            return Box::pin(async move {
                Ok(Self::error("Either `name` or `script` is required for `run`.".into()))
            });
        }
        if !name.is_empty() && !script.is_empty() {
            return Box::pin(async move {
                Ok(Self::error("`name` and `script` are mutually exclusive.".into()))
            });
        }
        if !script.is_empty() {
            return Box::pin(async move {
                Ok(Self::error(
                    "Inline `script` workflows are not supported by the native engine; \
                     pass a built-in `name` instead."
                        .into(),
                ))
            });
        }
        let Some(spec) = Self::find_builtin(&name) else {
            return Box::pin(async move {
                Ok(Self::error(format!("Workflow not found: {name}")))
            });
        };
        let args_text = args
            .get("args")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let (run_id, entry) = {
            let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            registry.insert(spec.name)
        };
        // Fork the run — do not await. The background task finalizes the
        // entry's status/result when the executor returns.
        let params = self.executor_params();
        tokio::spawn(async move {
            let result = execute_workflow(params, spec, &args_text, &entry).await;
            Self::finalize_run(&entry, result);
        });
        let run_id_for_msg = run_id.clone();
        Box::pin(async move {
            Ok(Self::response(
                format!(
                    "Workflow \"{name}\" started. run_id: {run_id}\nUse Workflow({{\"operation\": \"wait\", \"run_id\": \"{run_id_for_msg}\"}}) to block until it completes, or Workflow({{\"operation\": \"status\", \"run_id\": \"{run_id_for_msg}\"}}) to check progress."
                ),
                false,
            ))
        })
    }

    /// `list` — show the built-in workflow catalog.
    fn handle_list(&self) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let mut lines = vec!["Available workflows:".to_string()];
        for spec in BUILTINS {
            lines.push(format!(
                "- {name}: {description}\n  when_to_use: {when}\n  phases: {phases}",
                name = spec.name,
                description = spec.description,
                when = spec.when_to_use,
                phases = spec.phases.join(" → "),
            ));
        }
        Box::pin(async move { Ok(Self::response(lines.join("\n"), false)) })
    }

    /// `status` — render the current state of a run.
    fn handle_status(&self, args: &serde_json::Value) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let run_id = args
            .get("run_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        if run_id.is_empty() {
            return Box::pin(async move {
                Ok(Self::error("`run_id` is required for `status`.".into()))
            });
        }
        let entry = self
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&run_id);
        match entry {
            None => Box::pin(async move {
                Ok(Self::response(format!("Workflow run not found: {run_id}"), false))
            }),
            Some(entry) => Box::pin(async move {
                let status = entry.lock().map(|e| format_status(&e)).unwrap_or_else(|_| {
                    "status: failed\nerror: run entry lock poisoned".to_string()
                });
                Ok(Self::response(status, false))
            }),
        }
    }

    /// `wait` — poll until the run reaches a terminal state or the timeout.
    async fn wait_operation(
        run_id: &str,
        timeout_ms: u64,
        registry: Arc<Mutex<WorkflowRegistry>>,
    ) -> Result<ToolExecuteResponse, String> {
        if run_id.is_empty() {
            return Ok(Self::error("`run_id` is required for `wait`.".into()));
        }
        let entry = registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id);
        let Some(entry) = entry else {
            return Ok(Self::response(format!("Workflow run not found: {run_id}"), false));
        };
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let status = entry.lock().map(|e| e.status).unwrap_or(WorkflowRunStatus::Failed);
            if status != WorkflowRunStatus::Running || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(WAIT_POLL_MS)).await;
        }
        let (status, agent_count, started_at, finished_at, result, current_phase, error) = {
            let e = entry.lock().unwrap_or_else(|e| e.into_inner());
            (
                e.status,
                e.agent_count,
                e.started_at,
                e.finished_at,
                e.result.clone(),
                e.current_phase.clone(),
                e.error.clone(),
            )
        };
        if status == WorkflowRunStatus::Completed {
            let duration = finished_at
                .map(|f| f.duration_since(started_at).as_secs_f64())
                .unwrap_or(0.0);
            Ok(Self::response(
                format!(
                    "Workflow completed.\nAgent runs: {agent_count}\nDuration: {duration:.1}s\n\nResult:\n{}",
                    result.unwrap_or_default()
                ),
                true,
            ))
        } else {
            let mut lines = vec![
                format!("run_id: {run_id}"),
                format!("status: {}", status.as_str()),
                format!("agents: {agent_count}"),
            ];
            if let Some(phase) = current_phase {
                lines.push(format!("phase: {phase}"));
            }
            if let Some(err) = error {
                lines.push(format!("error: {err}"));
            }
            Ok(Self::response(lines.join("\n"), false))
        }
    }

    fn handle_wait(&self, args: &serde_json::Value) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let registry = self.registry.clone();
        let run_id = args
            .get("run_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
        Box::pin(async move { Self::wait_operation(&run_id, timeout_ms, registry).await })
    }

    /// `cancel` — request cancellation of a run (checked between phases).
    fn handle_cancel(&self, args: &serde_json::Value) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let run_id = args
            .get("run_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        if run_id.is_empty() {
            return Box::pin(async move {
                Ok(Self::error("`run_id` is required for `cancel`.".into()))
            });
        }
        let entry = self
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&run_id);
        if let Some(entry) = entry {
            let mut e = entry.lock().unwrap_or_else(|e| e.into_inner());
            if e.status == WorkflowRunStatus::Running {
                e.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                e.status = WorkflowRunStatus::Cancelled;
                e.finished_at = Some(Instant::now());
            }
        }
        Box::pin(async move {
            Ok(Self::response(format!("Workflow cancelled: {run_id}"), false))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{LlmChatRequest, LlmChatResponse, TokenUsage};

    /// Host that records requests and completes every turn in one step.
    struct CompletingHost {
        calls: Arc<Mutex<Vec<LlmChatRequest>>>,
    }

    impl HostCallbacks for CompletingHost {
        fn supports_tool_lifecycle(&self) -> bool { true }
        fn llm_chat(
            &self,
            r: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            let calls = self.calls.clone();
            Box::pin(async move {
                calls.lock().unwrap().push(r);
                Ok(LlmChatResponse {
                    content: "final answer".into(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage {
                        input_tokens: 1,
                        output_tokens: 1,
                        total_tokens: 2,
                    },
                })
            })
        }
        fn execute_tool(
            &self,
            _req: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async move {
                Ok(ToolExecuteResponse {
                    content: "inner".into(),
                    is_error: false,
                    is_prediction: false,
                    stop_turn: false,
                    media: Vec::new(),
                })
            })
        }
        fn emit_event(&self, _e: serde_json::Value) {}
        fn prepare_tool_execution(
            &self,
            _r: crate::rpc::types::PrepareToolRequest,
        ) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> {
            Box::pin(async { Ok(None) })
        }
        fn authorize_tool_execution(
            &self,
            _r: crate::rpc::types::AuthorizeToolRequest,
        ) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> {
            Box::pin(async { Ok(None) })
        }
        fn finalize_tool_result(
            &self,
            _r: crate::rpc::types::FinalizeToolRequest,
        ) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> {
            Box::pin(async { Ok(None) })
        }
    }

    /// A unique temp dir per test so persisted child sessions never collide
    /// across parallel tests (mirrors `swarm_tool.rs`).
    fn temp_test_homedir() -> String {
        unsafe { std::env::remove_var("KIMI_AGENT_HOME") };
        let dir =
            std::env::temp_dir().join(format!("kimi-agent-workflow-test-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn interceptor(inner: Arc<dyn HostCallbacks>) -> WorkflowToolInterceptor {
        WorkflowToolInterceptor {
            inner: inner.clone(),
            host: inner,
            homedir: None,
            native_llm: None,
            permission: crate::permission::gate::PermissionGate::from_env(),
            system_prompt: "parent".into(),
            max_steps_per_turn: 3,
            depth: 0,
            hooks: None,
            record_store: None,
            registry: Arc::new(Mutex::new(WorkflowRegistry::new())),
        }
    }

    fn run_tool(
        interceptor: &WorkflowToolInterceptor,
        args: serde_json::Value,
    ) -> ToolExecuteResponse {
        let rt = tokio::runtime::Runtime::new().unwrap();
        run_tool_on(&rt, interceptor, args)
    }

    /// Like `run_tool`, but runs on a caller-owned runtime so a background
    /// workflow task spawned by a `run` call stays alive across subsequent
    /// `wait` / `status` / `cancel` calls.
    fn run_tool_on(
        rt: &tokio::runtime::Runtime,
        interceptor: &WorkflowToolInterceptor,
        args: serde_json::Value,
    ) -> ToolExecuteResponse {
        rt.block_on(async {
            interceptor
                .execute_tool(ToolExecuteRequest {
                    session_id: None,
                    turn_id: "t".into(),
                    tool_call_id: "c1".into(),
                    tool_name: WORKFLOW_TOOL_NAME.into(),
                    arguments: args,
                    force_precise: false,
                })
                .await
                .unwrap()
        })
    }

    fn wf_args(operation: &str) -> serde_json::Value {
        serde_json::json!({ "operation": operation })
    }

    #[test]
    fn non_workflow_tools_pass_through() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner.clone());
        let rt = tokio::runtime::Runtime::new().unwrap();
        let resp = rt.block_on(async {
            i.execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({}),
                force_precise: false,
            })
            .await
            .unwrap()
        });
        assert_eq!(resp.content, "inner");
    }

    #[test]
    fn unknown_operation_is_an_error() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let resp = run_tool(&i, wf_args("frobnicate"));
        assert!(resp.is_error);
        assert!(resp.content.contains("Unknown workflow operation"));
    }

    #[test]
    fn run_requires_name_or_script() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let resp = run_tool(&i, wf_args("run"));
        assert!(resp.is_error);
        assert!(resp.content.contains("required"));
    }

    #[test]
    fn run_rejects_inline_script() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let resp = run_tool(&i, serde_json::json!({ "operation": "run", "script": "await agent('x')" }));
        assert!(resp.is_error);
        assert!(resp.content.contains("not supported by the native engine"));
    }

    #[test]
    fn run_rejects_unknown_name() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let resp = run_tool(&i, serde_json::json!({ "operation": "run", "name": "nope" }));
        assert!(resp.is_error);
        assert!(resp.content.contains("Workflow not found: nope"));
    }

    #[test]
    fn list_renders_all_builtins() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let resp = run_tool(&i, wf_args("list"));
        assert!(!resp.is_error, "{}", resp.content);
        for name in [
            "deep-research",
            "code-review",
            "test-generator",
            "refactor-planner",
            "bug-triage",
            "pr-description",
            "architecture-review",
            "security-audit",
            "migration-planner",
        ] {
            assert!(resp.content.contains(name), "missing {name}: {}", resp.content);
        }
    }

    #[test]
    fn status_of_unknown_run_reports_not_found() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let resp = run_tool(&i, serde_json::json!({ "operation": "status", "run_id": "wf_999" }));
        assert!(!resp.is_error, "{}", resp.content);
        assert!(resp.content.contains("Workflow run not found"));
    }

    #[test]
    fn run_starts_and_wait_completes() {
        // A real orchestrator run: the child completes against the mock host,
        // so `wait` returns the completed result with stop_turn.
        let calls: Arc<Mutex<Vec<LlmChatRequest>>> = Default::default();
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost { calls });
        let homedir = temp_test_homedir();
        let mut i = interceptor(inner);
        i.homedir = Some(homedir);
        // One runtime for the whole test: the background workflow task is
        // spawned by `run` and must stay alive until `wait` observes it.
        let rt = tokio::runtime::Runtime::new().unwrap();

        let resp = run_tool_on(&rt, &i, serde_json::json!({ "operation": "run", "name": "pr-description", "args": "summarize the diff" }));
        assert!(!resp.is_error, "{}", resp.content);
        assert!(resp.content.contains("run_id: wf_1"), "{}", resp.content);

        let wait_resp = run_tool_on(&rt, &i, serde_json::json!({ "operation": "wait", "run_id": "wf_1", "timeout_ms": 10_000 }));
        assert!(!wait_resp.is_error, "{}", wait_resp.content);
        assert!(wait_resp.stop_turn, "completed wait must stop the turn");
        assert!(wait_resp.content.contains("Workflow completed."), "{}", wait_resp.content);
        assert!(wait_resp.content.contains("Result:\nfinal answer"), "{}", wait_resp.content);
    }

    #[test]
    fn finalize_run_marks_completed_with_result() {
        let entry = Arc::new(Mutex::new(WorkflowRunEntry::new("wf_1".into(), "code-review".into())));
        WorkflowToolInterceptor::finalize_run(&entry, Ok("all good".into()));
        let e = entry.lock().unwrap();
        assert_eq!(e.status, WorkflowRunStatus::Completed);
        assert_eq!(e.result.as_deref(), Some("all good"));
        assert!(e.finished_at.is_some());
    }

    #[test]
    fn finalize_run_marks_failed_with_error() {
        let entry = Arc::new(Mutex::new(WorkflowRunEntry::new("wf_1".into(), "code-review".into())));
        WorkflowToolInterceptor::finalize_run(&entry, Err("boom".into()));
        let e = entry.lock().unwrap();
        assert_eq!(e.status, WorkflowRunStatus::Failed);
        assert_eq!(e.error.as_deref(), Some("boom"));
        assert!(e.finished_at.is_some());
    }

    #[test]
    fn finalize_run_cancellation_wins_over_result() {
        // A cancelled run reports cancelled even if the executor returned Ok.
        let entry = Arc::new(Mutex::new(WorkflowRunEntry::new("wf_1".into(), "bug-triage".into())));
        entry.lock().unwrap().cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        WorkflowToolInterceptor::finalize_run(&entry, Ok("ignored".into()));
        let e = entry.lock().unwrap();
        assert_eq!(e.status, WorkflowRunStatus::Cancelled);
        assert_eq!(e.error.as_deref(), Some("cancelled by user"));
    }

    #[test]
    fn cancelled_run_wait_reports_cancelled() {
        // Integration: run → cancel → wait surfaces the cancelled status
        // deterministically (no real model involved).
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let rt = tokio::runtime::Runtime::new().unwrap();

        let resp = run_tool_on(&rt, &i, serde_json::json!({ "operation": "run", "name": "bug-triage", "args": "fix the crash" }));
        assert!(!resp.is_error, "{}", resp.content);
        assert!(resp.content.contains("run_id: wf_1"));

        let resp2 = run_tool_on(&rt, &i, serde_json::json!({ "operation": "cancel", "run_id": "wf_1" }));
        assert!(!resp2.is_error, "{}", resp2.content);

        let resp3 = run_tool_on(&rt, &i, serde_json::json!({ "operation": "wait", "run_id": "wf_1", "timeout_ms": 5_000 }));
        assert!(resp3.content.contains("status: cancelled"), "{}", resp3.content);
    }

    #[test]
    fn cancel_marks_running_run_as_cancelled() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost {
            calls: Default::default(),
        });
        let i = interceptor(inner);
        let resp = run_tool(&i, serde_json::json!({ "operation": "run", "name": "bug-triage", "args": "fix the crash" }));
        assert!(!resp.is_error, "{}", resp.content);

        let resp2 = run_tool(&i, serde_json::json!({ "operation": "cancel", "run_id": "wf_1" }));
        assert!(!resp2.is_error, "{}", resp2.content);
        assert!(resp2.content.contains("Workflow cancelled"));

        let resp3 = run_tool(&i, serde_json::json!({ "operation": "status", "run_id": "wf_1" }));
        assert!(
            resp3.content.contains("status: cancelled") || resp3.content.contains("status: completed"),
            "after cancel the run must no longer be running: {}",
            resp3.content
        );
    }
}
