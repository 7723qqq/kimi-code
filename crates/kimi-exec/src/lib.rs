//! Kimi Code non-interactive execution — the `-p`/print path, ported from
//! `apps/kimi-code/src/cli/run-prompt.ts`. Uses the host protocol client
//! (in-process or remote) and shares the engine exactly like the TUI does;
//! only the output handling differs (plain text / JSONL).

use kimi_server_client::AppServerClient;

/// Optional pre-prompt setup applied to the session between create and prompt.
#[derive(Debug, Default, Clone)]
pub struct PromptSetup {
    /// Model alias/id to set on the session (`session/set_model`).
    pub model: Option<String>,
    /// Enable plan mode before prompting (`session/set_plan_mode`).
    pub plan: bool,
    /// Create a goal on the session before prompting (goal mode). Created
    /// AFTER the session create (and any resume load) so neither rebuilds
    /// the agent over it.
    pub goal: Option<String>,
    /// Swap an existing goal instead of failing when one is active (TS
    /// `/goal replace <objective>` parity — `goal_create` with `replace`).
    pub goal_replace: bool,
    /// Resume a persisted session: `session/load` after create so the
    /// on-disk context + goal are restored before the setup/prompt.
    pub resume: bool,
    /// Set the permission gate to auto before prompting (`--yolo`/`--auto`
    /// parity — a headless run must not stall on tool approvals).
    pub permission_auto: bool,
    /// Host-supplied skill metadata (`--skills-dir` parity): flat records
    /// registered on the session at create, like the TUI host hands the
    /// engine. Empty = no custom skills.
    pub skills: Vec<serde_json::Value>,
}

/// Run one prompt: create a session, prompt it, return the wire result.
/// When no native_llm is supplied, the engine config (`KIMI_MODEL_*` env /
/// config.toml) is self-read so the standalone binary needs no host LLM.
pub async fn run_prompt(
    client: &mut AppServerClient,
    session_id: &str,
    prompt: &str,
    native_llm: Option<kimi_protocol::wire_types::NativeLlmConfig>,
) -> serde_json::Value {
    run_prompt_with_setup(client, session_id, prompt, native_llm, &PromptSetup::default()).await
}

/// `run_prompt` with a setup step (model / plan mode) applied right after
/// the (idempotent) create, before the prompt. Setup failures surface in the
/// returned body like create failures do.
pub async fn run_prompt_with_setup(
    client: &mut AppServerClient,
    session_id: &str,
    prompt: &str,
    native_llm: Option<kimi_protocol::wire_types::NativeLlmConfig>,
    setup: &PromptSetup,
) -> serde_json::Value {
    let mut create_params = serde_json::json!({ "session_id": session_id });
    if let Ok(cwd) = std::env::current_dir() {
        // Record the workspace on the record so `--continue` can resume
        // within the same directory (TS `listSessions({ workDir })` parity).
        create_params["work_dir"] = serde_json::json!(cwd);
    }
    if !setup.skills.is_empty() {
        create_params["skills"] = serde_json::to_value(&setup.skills).unwrap_or_default();
    }
    if let Some(nllm) = native_llm {
        create_params["native_llm"] = serde_json::to_value(&nllm).unwrap_or_default();
    }
    let created = client.call(kimi_protocol::methods::SESSION_CREATE, create_params).await;
    if created.get("error").is_some() {
        return created;
    }
    if setup.resume {
        // Restore the persisted context + goal before any setup overrides.
        let body = client
            .call(
                kimi_protocol::methods::SESSION_LOAD,
                serde_json::json!({ "session_id": session_id }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    if let Some(model) = &setup.model {
        let body = client
            .call(
                kimi_protocol::methods::SESSION_SET_MODEL,
                serde_json::json!({ "session_id": session_id, "model": model }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    if setup.plan {
        let body = client
            .call(
                kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                serde_json::json!({ "session_id": session_id, "enabled": true }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    if setup.permission_auto {
        // Headless runs must not stall on tool approvals (TS `--yolo`/`--auto`
        // parity): force the permission gate to auto before the prompt.
        let body = client
            .call(
                kimi_protocol::methods::PERMISSION_SET_MODE,
                serde_json::json!({ "session_id": session_id, "mode": "auto" }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    if let Some(objective) = &setup.goal {
        let body = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_CREATE,
                serde_json::json!({
                    "session_id": session_id,
                    "objective": objective,
                    "replace": setup.goal_replace,
                }),
            )
            .await;
        if body.get("error").is_some() {
            return body;
        }
    }
    client
        .call(
            kimi_protocol::methods::SESSION_PROMPT,
            serde_json::json!({
                "session_id": session_id,
                "input": [{ "type": "text", "text": prompt }],
            }),
        )
        .await
}

/// Self-read the engine's native LLM config (config.toml + `KIMI_MODEL_*`).
pub fn native_llm_from_config() -> Option<kimi_protocol::wire_types::NativeLlmConfig> {
    kimi_agent::config::native_llm::load_native_llm_from_config()
}

/// Run one prompt against a freshly built in-process server (convenience for
/// tests / embedded hosts).
pub async fn run_prompt_in_process(prompt: &str) -> anyhow::Result<serde_json::Value> {
    let server = kimi_server::Server::build()?;
    let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
    Ok(run_prompt(&mut client, "kimi-exec", prompt, native_llm_from_config()).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes tests that pin the engine home via process-global env vars
    /// (`KIMI_AGENT_HOME` / `KIMI_CODE_HOME` / `HOME`): cargo runs tests in
    /// parallel but the process env is global, so every test here — each
    /// boots an in-process server that reads the engine config + session
    /// store from the env-pointed home — would read the others' files. The
    /// lock is held for the whole test (home must stay pinned while the
    /// server reads it), matching the kimi-acp `STORE_LOCK` pattern.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII restore of a process env var — drop-safe: the previous value is
    /// put back even when the test panics mid-flight, so a failed assertion
    /// cannot leave the home pinned for other parallel tests (same pattern
    /// as `kimi-server-transport/tests/http_e2e.rs::EnvGuard`).
    struct EnvGuard {
        name: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(name: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(name);
            std::env::set_var(name, value);
            Self { name, previous }
        }

        fn remove(name: &'static str) -> Self {
            let previous = std::env::var_os(name);
            std::env::remove_var(name);
            Self { name, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(previous) => std::env::set_var(self.name, previous),
                None => std::env::remove_var(self.name),
            }
        }
    }

    /// Point the engine at an empty temp home and strip the ambient LLM env
    /// surface, so the "no LLM -> engine error" assertions hold regardless of
    /// the developer's real `~/.kimi-code` config (mirrors the temp-home
    /// pattern of `kimi-cli/tests/cli.rs`). Env vars are restored and the
    /// temp dir removed on drop.
    struct TestHome {
        /// Restored before the lock is released (see `Drop`; field drop
        /// order keeps the lock last).
        envs: Vec<EnvGuard>,
        _lock: std::sync::MutexGuard<'static, ()>,
        path: std::path::PathBuf,
    }

    impl TestHome {
        fn new(tag: &str) -> Self {
            let _lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let path = std::env::temp_dir().join(format!("kimi-exec-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("mkdir");
            // Neutralize the config/LLM env surface that could leak a real
            // provider into the engine: `KIMI_CONFIG_PATH` is the highest
            // config priority, `KIMI_MODEL_*` synthesizes a native LLM
            // without any config file, and `KIMI_AGENT_HOME`/`KIMI_CODE_HOME`/
            // `HOME` point the session store + user config at the temp dir.
            let envs = vec![
                EnvGuard::set("KIMI_AGENT_HOME", &path),
                EnvGuard::set("KIMI_CODE_HOME", &path),
                EnvGuard::set("HOME", &path),
                EnvGuard::remove("KIMI_CONFIG_PATH"),
                EnvGuard::remove("KIMI_MODEL"),
                EnvGuard::remove("KIMI_MODEL_NAME"),
                EnvGuard::remove("KIMI_MODEL_API_KEY"),
                EnvGuard::remove("KIMI_MODEL_BASE_URL"),
            ];
            Self { envs, _lock, path }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            // Restore env vars before the lock is released — a lock-first
            // drop would let a waiting test set the home, then get clobbered
            // by this restore. The lock releases via the field drop order
            // (`envs` declared first).
            self.envs.clear();
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn run_prompt_creates_then_prompts() {
        let _home = TestHome::new("creates-then-prompts");
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let result = run_prompt(&mut client, "s-exec", "hello", native_llm_from_config()).await;
        // Create succeeded; prompt fails with not-configured LLM (no
        // native_llm) — the pipeline (create -> prompt) is exercised.
        assert!(result.get("error").is_some(), "expected engine error without LLM: {result}");
        let msg = result["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("run_prompt failed") || msg.contains("LLM"),
            "unexpected error: {msg}"
        );
    }

    #[tokio::test]
    async fn run_prompt_in_process_builds_server() {
        let _home = TestHome::new("in-process-builds-server");
        let result = run_prompt_in_process("hi").await.expect("run");
        assert!(result.get("error").is_some(), "no LLM -> engine error expected");
    }

    #[tokio::test]
    async fn run_prompt_with_setup_applies_model_and_plan() {
        let _home = TestHome::new("setup-applies-model-and-plan");
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let setup = PromptSetup {
            model: Some("setup-test-model".into()),
            plan: true,
            goal: Some("setup goal".into()),
            goal_replace: false,
            resume: false,
            permission_auto: false,
            skills: vec![],
        };
        let result =
            run_prompt_with_setup(&mut client, "s-setup", "hello", native_llm_from_config(), &setup).await;
        // The pipeline runs create -> set_model -> set_plan_mode -> goal ->
        // prompt; the prompt itself fails (no reachable LLM) but setup landed
        // first.
        assert!(result.get("error").is_some(), "no LLM -> prompt errors: {result}");
        let status = client
            .call(
                kimi_protocol::methods::SESSION_GET_STATUS,
                serde_json::json!({ "session_id": "s-setup" }),
            )
            .await;
        assert_eq!(status["result"]["plan_mode"], true, "plan mode set: {status}");
        assert_eq!(status["result"]["model"], "setup-test-model", "model set: {status}");
        // The goal survived the create (created after it, so the agent
        // rebuild could not wipe it).
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_GET,
                serde_json::json!({ "session_id": "s-setup" }),
            )
            .await;
        assert_eq!(goal["result"]["goal"]["objective"], "setup goal", "goal set: {goal}");
    }

    #[tokio::test]
    async fn run_prompt_resume_restores_persisted_goal() {
        let _home = TestHome::new("resume-restores-persisted-goal");
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        // Seed a persisted session with a goal.
        let created = client.session_create("s-resume").await;
        assert!(created.get("error").is_none(), "create: {created}");
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_CREATE,
                serde_json::json!({ "session_id": "s-resume", "objective": "persisted goal" }),
            )
            .await;
        assert!(goal.get("error").is_none(), "goal: {goal}");
        client
            .call(
                kimi_protocol::methods::SESSION_SAVE,
                serde_json::json!({ "session_id": "s-resume" }),
            )
            .await;

        // A resume (create -> load -> prompt) must restore the persisted goal
        // even though the prompt itself fails without an LLM.
        let setup = PromptSetup { resume: true, ..Default::default() };
        let result =
            run_prompt_with_setup(&mut client, "s-resume", "hi", native_llm_from_config(), &setup).await;
        assert!(result.get("error").is_some(), "no LLM -> prompt errors: {result}");
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_GET,
                serde_json::json!({ "session_id": "s-resume" }),
            )
            .await;
        assert_eq!(
            goal["result"]["goal"]["objective"], "persisted goal",
            "resume restores the persisted goal: {goal}"
        );
    }

    #[tokio::test]
    async fn goal_create_without_replace_rejects_existing_goal() {
        let _home = TestHome::new("goal-create-without-replace");
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let created = client.session_create("s-no-replace").await;
        assert!(created.get("error").is_none(), "create: {created}");
        // An active goal already exists on the session; persist it so a
        // resume load restores it AFTER the (agent-rebuilding) create inside
        // run_prompt_with_setup.
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_CREATE,
                serde_json::json!({ "session_id": "s-no-replace", "objective": "goal one" }),
            )
            .await;
        assert!(goal.get("error").is_none(), "seed goal: {goal}");
        client
            .call(
                kimi_protocol::methods::SESSION_SAVE,
                serde_json::json!({ "session_id": "s-no-replace" }),
            )
            .await;

        // `goal_replace: false` (the default) must NOT swap the active goal —
        // the engine rejects the duplicate create and the setup surfaces it.
        let setup = PromptSetup {
            resume: true,
            goal: Some("goal two".into()),
            ..Default::default()
        };
        let result = run_prompt_with_setup(
            &mut client,
            "s-no-replace",
            "hi",
            native_llm_from_config(),
            &setup,
        )
        .await;
        let error = result["error"]["message"].as_str().unwrap_or("");
        assert!(
            error.contains("already exists"),
            "duplicate goal create must fail without replace: {error}"
        );
        // The original goal is untouched.
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_GET,
                serde_json::json!({ "session_id": "s-no-replace" }),
            )
            .await;
        assert_eq!(
            goal["result"]["goal"]["objective"], "goal one",
            "original goal survives: {goal}"
        );
    }

    #[tokio::test]
    async fn goal_create_with_replace_swaps_existing_goal() {
        let _home = TestHome::new("goal-create-with-replace");
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let created = client.session_create("s-replace").await;
        assert!(created.get("error").is_none(), "create: {created}");
        // An active goal already exists on the session; persist it so a
        // resume load restores it AFTER the (agent-rebuilding) create inside
        // run_prompt_with_setup.
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_CREATE,
                serde_json::json!({ "session_id": "s-replace", "objective": "goal one" }),
            )
            .await;
        assert!(goal.get("error").is_none(), "seed goal: {goal}");
        client
            .call(
                kimi_protocol::methods::SESSION_SAVE,
                serde_json::json!({ "session_id": "s-replace" }),
            )
            .await;

        // `goal_replace: true` swaps the active goal (TS `/goal replace`
        // parity). The setup continues to the prompt; the goal must read back
        // the replacement regardless of the prompt outcome.
        let setup = PromptSetup {
            resume: true,
            goal: Some("goal two".into()),
            goal_replace: true,
            ..Default::default()
        };
        let result = run_prompt_with_setup(
            &mut client,
            "s-replace",
            "hi",
            native_llm_from_config(),
            &setup,
        )
        .await;
        assert!(
            result.get("error").is_some(),
            "setup reaches the prompt which fails without LLM: {result}"
        );
        let goal = client
            .call(
                kimi_protocol::methods::SESSION_GOAL_GET,
                serde_json::json!({ "session_id": "s-replace" }),
            )
            .await;
        assert_eq!(
            goal["result"]["goal"]["objective"], "goal two",
            "replace swapped the goal: {goal}"
        );
    }
}
