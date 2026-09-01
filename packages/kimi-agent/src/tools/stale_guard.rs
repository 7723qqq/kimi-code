//! Stale-write guard — native mirror of v2 `staleGuardService` (G-6 #3).
//!
//! v2 records the mtime of every file a successful Read/Edit/Write touched
//! and vetoes native Write/Edit calls when the target was never read or
//! changed on disk since. The host-side guard keeps covering host-executed
//! tools; this module closes the native path, which bypasses the host veto
//! chain entirely.
//!
//! State is a per-session in-process table (`Arc` shared by the pipeline
//! builder), mirroring v2's per-agent-scope lifetime: it survives across
//! turns and is never cleared mid-session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde_json::Value;

/// mtime as (secs, nanos) since the Unix epoch — exact comparison, no float
/// hazard. The value never crosses the wire, so it does not need to match
/// v2's `mtimeMs` float representation.
type Mtime = (i64, u32);

/// Per-session `canonical path -> mtime at last successful read/write`.
pub struct StaleGuardState {
    entries: Mutex<HashMap<PathBuf, Mtime>>,
}

impl StaleGuardState {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn record(&self, key: PathBuf, mtime: Mtime) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, mtime);
    }

    fn lookup(&self, key: &Path) -> Option<Mtime> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .copied()
    }
}

impl Default for StaleGuardState {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether the stale-write guard applies to this tool (v2 guards exactly
/// `Edit`/`Write`; both spellings are matched like the plan guard).
pub fn stale_guarded_tool(tool_name: &str) -> bool {
    matches!(tool_name.to_ascii_lowercase().as_str(), "write" | "edit")
}

fn observed_tool(tool_name: &str) -> bool {
    matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "read" | "write" | "edit"
    )
}

fn mtime_of(path: &Path) -> Option<Mtime> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let dur = meta
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?;
    Some((dur.as_secs() as i64, dur.subsec_nanos()))
}

/// Canonicalized absolute path used as the map key. `None` when the target
/// does not exist yet (new-file Write is exempt) or cannot be canonicalized.
/// Canonicalization converges symlink spellings onto one key.
fn key_path(path: &str, workspace_root: Option<&Path>) -> Option<PathBuf> {
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        workspace_root?.join(path)
    };
    std::fs::canonicalize(candidate).ok()
}

/// Record the current mtime of a successfully executed Read/Edit/Write
/// target (v2 `observeExecution`: re-stat after every successful execution,
/// so consecutive writes never trip the guard). Non-file targets and missing
/// paths are skipped.
pub fn observe_execution(
    state: &StaleGuardState,
    tool_name: &str,
    args: &Value,
    is_error: bool,
    workspace_root: Option<&Path>,
) {
    if is_error || !observed_tool(tool_name) {
        return;
    }
    let Some(raw) = args.get("path").and_then(|p| p.as_str()) else {
        return;
    };
    let Some(key) = key_path(raw, workspace_root) else {
        return;
    };
    let Some(mtime) = mtime_of(&key) else {
        return;
    };
    state.record(key, mtime);
}

/// The stale-write denial for a native Write/Edit (v2 `checkWritable`):
/// stat failure / non-regular file allows (new-file Write exemption), no
/// prior read denies, a changed mtime denies. Messages are byte-identical
/// to v2's hardcoded strings; `displayPath` is the raw `args.path`.
pub fn stale_denial(
    state: &StaleGuardState,
    tool_name: &str,
    args: &Value,
    workspace_root: Option<&Path>,
) -> Option<String> {
    if !stale_guarded_tool(tool_name) {
        return None;
    }
    let raw = args.get("path").and_then(|p| p.as_str())?;
    let key = key_path(raw, workspace_root)?;
    // stat failure / non-regular file / pre-epoch clock — the new-file
    // Write exemption (v2 `checkWritable`).
    let current = mtime_of(&key)?;
    match state.lookup(&key) {
        None => Some(format!(
            "\"{raw}\" has not been read by this agent yet. Read the file before writing to it."
        )),
        Some(recorded) if recorded != current => Some(format!(
            "\"{raw}\" has been modified on disk since this agent last read it. Read the file again before writing to it."
        )),
        Some(_) => None,
    }
}

/// Whether this Write/Edit targets the current plan file while plan mode is
/// active. v2 short-circuits its veto chain via planService `allow()` in
/// that case, so the stale guard must not fire — the host creates the plan
/// file and the model writes it without a prior read.
pub fn plan_file_write_exempt(plan: &Value, args: &Value, workspace_root: Option<&Path>) -> bool {
    if plan.get("active").and_then(|v| v.as_bool()) != Some(true) {
        return false;
    }
    let Some(plan_path) = plan.get("path").and_then(|p| p.as_str()) else {
        return false;
    };
    let Some(raw) = args.get("path").and_then(|p| p.as_str()) else {
        return false;
    };
    let resolved = if Path::new(raw).is_absolute() {
        raw.to_string()
    } else if let Some(root) = workspace_root {
        root.join(raw).to_string_lossy().into_owned()
    } else {
        raw.to_string()
    };
    // Component-wise comparison: the host's plan path and the model's
    // argument may mix separators (`/` vs `\` on Windows).
    Path::new(plan_path) == Path::new(&resolved)
}

/// The native-execution gate bundle: the per-session table plus the
/// workspace root used for path resolution. Mounted on
/// [`crate::callbacks::NativeToolCallbacks`]; observation runs on every
/// completed read/write execution, the veto runs before every native
/// Write/Edit.
pub struct StaleGate {
    pub state: Arc<StaleGuardState>,
    pub workspace_root: Option<PathBuf>,
}

impl StaleGate {
    pub fn new(workspace_root: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(StaleGuardState::new()),
            workspace_root,
        }
    }

    /// Record the mtime of a completed read/write execution target
    /// (v2 `observeExecution`: successful executions only). Call this after
    /// every completed Read/Edit/Write — native or host-forwarded — so a
    /// later native Write never trips on a read the host served.
    pub fn observe(&self, tool_name: &str, args: &Value, is_error: bool) {
        observe_execution(
            &self.state,
            tool_name,
            args,
            is_error,
            self.workspace_root.as_deref(),
        );
    }

    /// The full veto for a native Write/Edit: the stale-write denial, with
    /// the v2 plan-file short-circuit (`planService.allow()` releases the
    /// whole chain, so an unread plan-file write must go through). The plan
    /// state is only consulted when a denial would fire; a broken state
    /// bridge fails open (mirrors the plan guard's `Err(_) => None`).
    pub async fn denial(
        &self,
        inner: &dyn crate::callbacks::HostCallbacks,
        tool_name: &str,
        args: &Value,
    ) -> Option<String> {
        let denial = stale_denial(&self.state, tool_name, args, self.workspace_root.as_deref())?;
        let request = crate::rpc::types::StateReadRequest {
            domain: "plan".into(),
            key: "plan".into(),
            turn_id: String::new(),
            tool_call_id: String::new(),
        };
        match inner.state_read(request).await {
            Ok(response)
                if plan_file_write_exempt(
                    &response.value,
                    args,
                    self.workspace_root.as_deref(),
                ) =>
            {
                None
            }
            Ok(_) => Some(denial),
            Err(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn write_file(dir: &Path, name: &str, content: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn records_mtime_on_successful_read_and_allows_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let state = StaleGuardState::new();
        let args = json!({ "path": path.to_string_lossy() });

        let denial = stale_denial(&state, "Write", &args, Some(dir.path()));
        assert!(denial.unwrap().ends_with(
            "\" has not been read by this agent yet. Read the file before writing to it."
        ));

        observe_execution(&state, "Read", &args, false, Some(dir.path()));
        assert_eq!(stale_denial(&state, "Write", &args, Some(dir.path())), None);
    }

    #[test]
    fn failed_execution_is_not_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let state = StaleGuardState::new();
        let args = json!({ "path": path.to_string_lossy() });

        observe_execution(&state, "Read", &args, true, Some(dir.path()));
        let denial = stale_denial(&state, "Write", &args, Some(dir.path())).unwrap();
        assert!(denial.contains("has not been read"));
    }

    #[test]
    fn never_read_veto_message_is_byte_exact() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let state = StaleGuardState::new();
        let args = json!({ "path": path.to_string_lossy() });

        assert_eq!(
            stale_denial(&state, "Write", &args, Some(dir.path())).unwrap(),
            format!(
                "\"{}\" has not been read by this agent yet. Read the file before writing to it.",
                path.to_string_lossy()
            )
        );
    }

    #[test]
    fn mtime_change_veto_message_is_byte_exact() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let state = StaleGuardState::new();
        let args = json!({ "path": path.to_string_lossy() });
        let key = std::fs::canonicalize(&path).unwrap();

        state.record(key, (0, 0));
        assert_eq!(
            stale_denial(&state, "Edit", &args, Some(dir.path())).unwrap(),
            format!(
                "\"{}\" has been modified on disk since this agent last read it. Read the file again before writing to it.",
                path.to_string_lossy()
            )
        );
    }

    #[test]
    fn external_modification_between_read_and_write_denies() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let state = StaleGuardState::new();
        let args = json!({ "path": path.to_string_lossy() });

        observe_execution(&state, "Read", &args, false, Some(dir.path()));
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&path, "changed").unwrap();

        let denial = stale_denial(&state, "Write", &args, Some(dir.path())).unwrap();
        assert!(denial.contains("has been modified on disk"));
    }

    #[test]
    fn successful_write_refreshes_and_allows_consecutive_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let state = StaleGuardState::new();
        let args = json!({ "path": path.to_string_lossy() });

        observe_execution(&state, "Read", &args, false, Some(dir.path()));
        assert_eq!(stale_denial(&state, "Write", &args, Some(dir.path())), None);

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&path, "first").unwrap();
        observe_execution(&state, "Write", &args, false, Some(dir.path()));
        assert_eq!(stale_denial(&state, "Write", &args, Some(dir.path())), None);

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&path, "second").unwrap();
        assert!(
            stale_denial(&state, "Write", &args, Some(dir.path()))
                .unwrap()
                .contains("has been modified on disk")
        );
    }

    #[test]
    fn new_file_and_non_regular_targets_are_exempt() {
        let dir = tempfile::tempdir().unwrap();
        let state = StaleGuardState::new();

        let missing = json!({ "path": dir.path().join("new.txt").to_string_lossy() });
        assert_eq!(
            stale_denial(&state, "Write", &missing, Some(dir.path())),
            None
        );

        let directory = json!({ "path": dir.path().to_string_lossy() });
        assert_eq!(
            stale_denial(&state, "Write", &directory, Some(dir.path())),
            None
        );
    }

    #[test]
    fn relative_and_absolute_spellings_converge_on_one_key() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.txt", "hello");
        let state = StaleGuardState::new();

        observe_execution(
            &state,
            "Read",
            &json!({ "path": "a.txt" }),
            false,
            Some(dir.path()),
        );
        let absolute = json!({ "path": dir.path().join("a.txt").to_string_lossy() });
        assert_eq!(
            stale_denial(&state, "Write", &absolute, Some(dir.path())),
            None
        );
    }

    #[test]
    fn guard_applies_only_to_write_and_edit() {
        for tool in ["Write", "write", "Edit", "edit"] {
            assert!(stale_guarded_tool(tool), "tool: {tool}");
        }
        for tool in ["Read", "read", "Bash", "Grep", "ExitPlanMode"] {
            assert!(!stale_guarded_tool(tool), "tool: {tool}");
        }
    }

    #[test]
    fn plan_file_write_is_exempt_only_when_active_and_matching() {
        let dir = tempfile::tempdir().unwrap();
        let plan_file = write_file(dir.path(), "plan.md", "# Plan");
        let args = json!({ "path": plan_file.to_string_lossy() });

        let active = json!({ "active": true, "path": plan_file.to_string_lossy() });
        assert!(plan_file_write_exempt(&active, &args, Some(dir.path())));

        let inactive = json!({ "active": false, "path": plan_file.to_string_lossy() });
        assert!(!plan_file_write_exempt(&inactive, &args, Some(dir.path())));

        let no_path = json!({ "active": true });
        assert!(!plan_file_write_exempt(&no_path, &args, Some(dir.path())));

        let other =
            json!({ "active": true, "path": dir.path().join("other.md").to_string_lossy() });
        assert!(!plan_file_write_exempt(&other, &args, Some(dir.path())));

        let relative_args = json!({ "path": "plan.md" });
        assert!(plan_file_write_exempt(
            &active,
            &relative_args,
            Some(dir.path())
        ));
    }

    /// Host stub whose plan domain answers a scripted value, counting reads.
    struct PlanScriptCallbacks {
        plan: std::sync::Mutex<Option<Value>>,
        reads: std::sync::atomic::AtomicU32,
    }

    impl crate::callbacks::HostCallbacks for PlanScriptCallbacks {
        fn llm_chat(
            &self,
            _: crate::rpc::types::LlmChatRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
        {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: crate::rpc::types::ToolExecuteRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: crate::rpc::types::PermissionCheckRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async {
                Ok(crate::rpc::types::PermissionDecision {
                    decision: "allow".into(),
                    reason: None,
                })
            })
        }

        fn state_read(
            &self,
            _: crate::rpc::types::StateReadRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::StateReadResponse, String>,
        > {
            self.reads
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let value = self.plan.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Box::pin(async move {
                Ok(crate::rpc::types::StateReadResponse {
                    value: value.ok_or("no plan state")?,
                })
            })
        }
    }

    #[tokio::test]
    async fn gate_denial_consults_plan_only_when_it_would_deny() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let gate = StaleGate::new(Some(dir.path().to_path_buf()));
        let args = json!({ "path": path.to_string_lossy() });
        let host = PlanScriptCallbacks {
            plan: std::sync::Mutex::new(Some(json!({ "active": false }))),
            reads: std::sync::atomic::AtomicU32::new(0),
        };

        // No record → denial; plan inactive → denial stands.
        let denial = gate.denial(&host, "Write", &args).await.unwrap();
        assert!(denial.contains("has not been read"));
        assert_eq!(host.reads.load(std::sync::atomic::Ordering::Relaxed), 1);

        // Already-read → pass with zero plan reads (fast path).
        gate.observe("Read", &args, false);
        assert_eq!(gate.denial(&host, "Write", &args).await, None);
        assert_eq!(host.reads.load(std::sync::atomic::Ordering::Relaxed), 1);

        // Plan-mode plan-file write: exempt even without a prior read.
        let fresh = StaleGate::new(Some(dir.path().to_path_buf()));
        *host.plan.lock().unwrap() =
            Some(json!({ "active": true, "path": path.to_string_lossy() }));
        assert_eq!(fresh.denial(&host, "Write", &args).await, None);

        // Broken state bridge fails open.
        *host.plan.lock().unwrap() = None;
        let fresher = StaleGate::new(Some(dir.path().to_path_buf()));
        assert_eq!(fresher.denial(&host, "Write", &args).await, None);
    }

    #[test]
    fn gate_observe_skips_errors_and_non_file_tools() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_file(dir.path(), "a.txt", "hello");
        let gate = StaleGate::new(Some(dir.path().to_path_buf()));
        let args = json!({ "path": path.to_string_lossy() });

        gate.observe("Bash", &args, false);
        gate.observe("Read", &args, true);
        let denial = stale_denial(&gate.state, "Write", &args, Some(dir.path()));
        assert!(denial.unwrap().contains("has not been read"));

        gate.observe("Read", &args, false);
        assert_eq!(
            stale_denial(&gate.state, "Write", &args, Some(dir.path())),
            None
        );
    }
}
