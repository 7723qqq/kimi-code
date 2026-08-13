//! Slash-command dispatch — the big `match` that routes a submitted line to
//! its handler (TS `commands/dispatch.ts` parity). Split out of `app.rs` so
//! the app shell stays thin; handlers reach the shared state through the
//! `pub(crate)` fields and helpers on `App`.

use std::io;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::app::{HelpPanel, Overlay, TranscriptLine, TranscriptVec};
use crate::i18n::t;
use crate::reports::{
    build_goal_report, build_mcp_report, build_plugins_report, build_status_report,
    build_usage_report,
};
use crate::t;
use crate::util::{
    copy_to_clipboard, find_last_assistant_text, fresh_session_id, parse_discuss, resolve_alias,
    transcript_to_markdown,
};

impl super::app::App {
    pub(crate) fn dispatch<'a>(
        &'a mut self,
        terminal: &'a mut Terminal<CrosstermBackend<io::Stdout>>,
        line: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<bool>> + 'a>> {
        Box::pin(async move {
            if line.starts_with('/') {
                let (cmd, rest) = line
                    .split_once(' ')
                    .map(|(c, r)| (c, r.trim()))
                    .unwrap_or((line, ""));
                // Alias resolution (TS registry aliases parity).
                let cmd = resolve_alias(cmd);
                match cmd {
                    "/quit" | "/help" | "/approvals" | "/approve" | "/deny" | "/status"
                    | "/info" | "/plugins" | "/skills" | "/swarm" | "/mcp" | "/tasks"
                    | "/version" | "/add-dir" | "/compact" | "/usage" | "/undo" | "/steer"
                    | "/discuss" | "/workflow" | "/exit" | "/upgrade" => {
                        return self.cmd_resource(terminal, cmd, rest).await;
                    }
                    "/session" | "/new" | "/init" | "/title" | "/resume" | "/clear" | "/fork"
                    | "/import" | "/sessions" | "/export" | "/export-debug-zip" | "/archive"
                    | "/btw" | "/endbtw" | "/copy" | "/export-md" => {
                        return self.cmd_session(terminal, cmd, rest).await;
                    }
                    "/config" | "/plan" | "/thinking" | "/permission" | "/yolo" | "/auto"
                    | "/theme" | "/models" | "/model" | "/reload" | "/reload-tui" | "/locale"
                    | "/editor" | "/settings" | "/provider" | "/experiments" | "/multi-llm"
                    | "/feedback" | "/web" => {
                        return self.cmd_config(terminal, cmd, rest).await;
                    }
                    "/goal" | "/goal-cancel" | "/goal-pause" | "/goal-resume" | "/goal-status" => {
                        return self.cmd_goal(terminal, cmd, rest).await;
                    }
                    cmd if cmd.starts_with("/skill:") => {
                        // TS parity: `/skill:<name> [args]` activates a
                        // Skill directly from the command line.
                        let name = cmd.trim_start_matches("/skill:").trim();
                        if name.is_empty() {
                            self.push_line(TranscriptLine::status(t!("tui.skills.skillUsage")));
                        } else {
                            match self
                                .session
                                .as_mut()
                                .expect("session")
                                .activate_skill(name, serde_json::json!({ "args": rest }))
                                .await
                            {
                                Ok(_) => self.push_line(TranscriptLine::status(t!(
                                    "tui.skills.activated",
                                    name
                                ))),
                                Err(e) => self
                                    .push_line(TranscriptLine::error(t!("tui.err.skillFailed", e))),
                            }
                        }
                        return Ok(false);
                    }
                    cmd if plugin_command_parts(cmd).is_some() => {
                        // TS parity: `/<pluginId>:<command> [args]` activates
                        // a plugin command on the session (TS
                        // `resolveSlashCommandInput` 'plugin-command' intent +
                        // `activatePluginCommand`). The engine expands
                        // `$ARGUMENTS` in the command body and runs it as a
                        // prompt turn; unregistered plugins / unknown
                        // commands surface an error line instead of falling
                        // through to the model.
                        return self.cmd_plugin_command(terminal, line, cmd, rest).await;
                    }
                    "/login" => {
                        // Managed kimi auth: run the device flow, surface the
                        // verification URI + code as status lines, and let
                        // Esc/Ctrl-C abandon the wait (dropping the future stops
                        // the flow before approval).
                        let already = kimi_sdk::KimiAuth::new()
                            .status(&self.harness, None)
                            .await
                            .unwrap_or(false);
                        if already {
                            self.push_line(TranscriptLine::status(t("tui.auth.already")));
                        } else {
                            let info: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
                                Default::default();
                            let info_for_cb = info.clone();
                            let harness = self.harness.clone();
                            let auth = kimi_sdk::KimiAuth::new();
                            // 240 polls * 5s interval ≈ 20 minutes before timeout.
                            let login_fut = auth.login(&harness, Some(240), move |device| {
                                let uri = device
                                    .verification_uri_complete
                                    .clone()
                                    .unwrap_or_else(|| device.verification_uri.clone());
                                if let Ok(mut lines) = info_for_cb.lock() {
                                    lines.push(t!("tui.auth.openUrl", uri, device.user_code));
                                }
                            });
                            tokio::pin!(login_fut);
                            let mut outcome = None;
                            loop {
                                // Drain the verification lines the flow produced.
                                if let Ok(mut lines) = info.lock() {
                                    for line in lines.drain(..) {
                                        self.push_line(TranscriptLine::status(line));
                                    }
                                }
                                if event::poll(std::time::Duration::from_millis(0))? {
                                    if let Event::Key(key) = event::read()? {
                                        if key.kind == KeyEventKind::Press {
                                            let cancel = match key.code {
                                                KeyCode::Esc => true,
                                                KeyCode::Char('c')
                                                    if key
                                                        .modifiers
                                                        .contains(event::KeyModifiers::CONTROL) =>
                                                {
                                                    true
                                                }
                                                _ => false,
                                            };
                                            if cancel {
                                                self.push_line(TranscriptLine::status(t(
                                                    "tui.auth.abandoned",
                                                )));
                                                break;
                                            }
                                        }
                                    }
                                }
                                tokio::select! {
                                    r = &mut login_fut => {
                                        outcome = Some(r);
                                        break;
                                    }
                                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                                }
                            }
                            match outcome {
                                Some(Ok(_)) => {
                                    self.push_line(TranscriptLine::status(t("tui.auth.ok")))
                                }
                                Some(Err(e)) => self
                                    .push_line(TranscriptLine::error(t!("tui.err.loginFailed", e))),
                                None => {}
                            }
                        }
                    }
                    "/logout" => match kimi_sdk::KimiAuth::new().logout(&self.harness).await {
                        Ok(()) => self.push_line(TranscriptLine::status(t("tui.auth.loggedOut"))),
                        Err(e) => {
                            self.push_line(TranscriptLine::error(t!("tui.err.logoutFailed", e)))
                        }
                    },
                    _other => {
                        // TS parity: an unknown `/`-prefixed line (a typo, a
                        // path like `/usr/local/bin`, or a skill/plugin
                        // command this build does not know) is sent to the
                        // model as a regular message — only builtin commands
                        // are intercepted.
                        return self.run_turn(terminal, line).await.map(|_| false);
                    }
                }
                return Ok(false);
            }
            // Bash mode: a leading `!` runs a shell command one-shot. The
            // output streams live via `session.shell.output` events (TS
            // shell-run parity); the RPC result settles the line.
            if let Some(raw) = line.strip_prefix('!') {
                let command = raw.trim();
                if !command.is_empty() {
                    self.push_line(TranscriptLine::tool(format!("! {command}")));
                    let mut session = self.session.clone().expect("session");
                    let harness = self.harness.clone();
                    let mut rx = harness.subscribe();
                    let fut = session.run_shell(command);
                    tokio::pin!(fut);
                    let mut streamed = false;
                    let result = loop {
                        tokio::select! {
                            r = &mut fut => break r,
                            ev = rx.recv() => {
                                if let Ok(ev) = ev {
                                    if ev["type"].as_str() == Some("session.shell.output") {
                                        if let Some(chunk) = ev["chunk"].as_str() {
                                            if !chunk.is_empty() {
                                                self.push_line(TranscriptLine::tool(chunk.to_string()));
                                                streamed = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    };
                    if let Some(error) = result.get("error") {
                        self.push_line(TranscriptLine::error(t!(
                            "tui.err.shellFailed",
                            error["message"].as_str().unwrap_or("unknown")
                        )));
                    } else {
                        let is_error = result["result"]["is_error"].as_bool().unwrap_or(false);
                        if !streamed {
                            let output = result["result"]["output"].as_str().unwrap_or("");
                            let line = if output.is_empty() {
                                t("tui.shell.done").to_string()
                            } else {
                                output.to_string()
                            };
                            let entry = if is_error {
                                TranscriptLine::error(line)
                            } else {
                                TranscriptLine::tool_collapsed(line)
                            };
                            self.view.transcript.push_line(entry);
                        } else if is_error {
                            self.push_line(TranscriptLine::error(t!("tui.shell.failed")));
                        }
                    }
                    return Ok(false);
                }
            }
            // A real prompt: run it and render the transcript (see
            // `run_turn`; the same path serves `/btw <question>`).
            self.run_turn(terminal, line).await?;
            Ok(false)
        })
    }
}

/// Split a `/<pluginId>:<command>` slash token into `(plugin_id, command)`.
/// Both sides must be non-empty; the split happens at the first `:` so a
/// command name may itself contain `/` (TS `parseSlashInput` parity, e.g.
/// `plugin:frontend/component`). Returns `None` for anything that is not a
/// namespaced plugin command (a bare `/path:like` line falls through to the
/// model as a regular message).
fn plugin_command_parts(cmd: &str) -> Option<(&str, &str)> {
    let rest = cmd.strip_prefix('/')?;
    let (plugin_id, command) = rest.split_once(':')?;
    if plugin_id.is_empty() || command.is_empty() {
        return None;
    }
    Some((plugin_id, command))
}

impl super::app::App {
    /// `/<pluginId>:<command> [args]` — activate a plugin command (TS
    /// `activatePluginCommand` parity). The plugin must be installed and the
    /// command must be declared by its manifest; activation expands
    /// `$ARGUMENTS` in the command body and runs it as a prompt turn on the
    /// session, streaming engine events into the transcript like a normal
    /// turn (keys keep working — Esc/Ctrl-C cancels the turn).
    async fn cmd_plugin_command(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        line: &str,
        cmd: &str,
        rest: &str,
    ) -> anyhow::Result<bool> {
        let (plugin_id, command_name) = plugin_command_parts(cmd).expect("guarded by caller");
        self.push_line(TranscriptLine::user(line.to_string()));
        // The plugin must be installed (TS registers plugin commands only
        // for installed plugins; an unregistered `plugin:command` gets an
        // explicit error instead of silently falling through).
        let plugins = match self.harness.list_plugins().await {
            Ok(plugins) => plugins,
            Err(e) => {
                self.push_line(TranscriptLine::error(t!("tui.err.pluginsFailed", e)));
                return Ok(false);
            }
        };
        if !plugins.iter().any(|p| p["id"].as_str() == Some(plugin_id)) {
            self.push_line(TranscriptLine::error(t!(
                "tui.plugin.errNotFound",
                plugin_id
            )));
            return Ok(false);
        }
        // The command must be declared by the plugin manifest (engine
        // `plugin/list_commands`; unknown commands error out before any
        // turn is sent).
        let commands = match self.harness.list_plugin_commands(plugin_id).await {
            Ok(commands) => commands,
            Err(e) => {
                self.push_line(TranscriptLine::error(t!("tui.err.pluginsFailed", e)));
                return Ok(false);
            }
        };
        if !commands.iter().any(|c| c["name"].as_str() == Some(command_name)) {
            self.push_line(TranscriptLine::error(t!(
                "tui.plugin.errUnknownCommand",
                plugin_id,
                command_name
            )));
            return Ok(false);
        }
        // Activate: the engine expands `$ARGUMENTS` in the command body and
        // sends it as a prompt turn on the session.
        let harness = self.harness.clone();
        let session_id = self.session_id.clone();
        let activation = harness.activate_plugin_command(
            &session_id,
            plugin_id,
            command_name,
            Some(rest),
        );
        tokio::pin!(activation);
        let result = loop {
            self.poll_prompt_keys(terminal).await?;
            tokio::select! {
                r = &mut activation => break r,
                _ = self.pump_one_event() => {
                    terminal.draw(|frame| self.draw_plugin_frame(frame))?;
                }
            }
        };
        match result {
            Ok(()) => {
                // Close the streamed turn: drop transient thinking, replace
                // the live line with the final transcript (same bookkeeping
                // as `run_turn`).
                crate::streaming::drop_trailing_thinking(&mut self.view.transcript);
                match self.session.as_mut().expect("session").transcript().await {
                    Ok(Some(text)) => {
                        crate::streaming::finish_stream(&mut self.view.transcript, text);
                    }
                    Ok(None) => {}
                    Err(e) => self.push_line(TranscriptLine::error(t!("tui.err.command", e))),
                }
            }
            Err(e) => self.push_line(TranscriptLine::error(t!(
                "tui.plugin.errActivate",
                plugin_id,
                command_name,
                e
            ))),
        }
        Ok(false)
    }

    /// Redraw the chat layout during a plugin-command turn. Mirrors the
    /// app-shell `draw` scroll handling but skips the overlay modals —
    /// dispatch runs with no overlay open (Enter applies/closes the
    /// completion popup before submitting, and `handle_overlay_key`
    /// consumes the others).
    fn draw_plugin_frame(&mut self, frame: &mut ratatui::Frame<'_>) {
        let pane_height = frame.area().height.saturating_sub(5);
        let max = crate::chatwidget::max_scroll(self.view.transcript.len(), pane_height);
        if self.view.follow_bottom {
            self.view.scroll = max as u16;
        } else if self.view.scroll as usize > max {
            self.view.scroll = max as u16;
        }
        let completion = match &self.overlay {
            Some(crate::app::Overlay::Completion(state)) => Some(state),
            _ => None,
        };
        let input_hint = crate::bottom_pane::argument_hint(&self.edit.text, &self.model_aliases);
        crate::chatwidget::render_frame(
            frame,
            &self.view.transcript,
            &self.edit.text,
            self.edit.cursor,
            &self.session_id,
            self.view.scroll,
            self.view.theme,
            &self.view.footer,
            completion,
            input_hint.as_deref(),
            self.tool_output_expanded,
            &self.todo_list,
        );
    }
}

impl super::app::App {
    /// `goal` command group (extracted from dispatch for readability).
    async fn cmd_goal(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        cmd: &str,
        rest: &str,
    ) -> anyhow::Result<bool> {
        match cmd {
            "/goal" => {
                // TS parity: `/goal <subcommand>` manages the goal;
                // anything else is the objective of a new goal.
                let (cmd, objective) = match rest.split_once(char::is_whitespace) {
                    Some((c, o)) => (c, o.trim()),
                    None => (rest, ""),
                };
                let session = self.session.as_mut().expect("session");
                match cmd {
                    "" => {
                        // TS parity: a bare `/goal` shows the goal status (not usage).
                        let goal = session.goal().await?;
                        let g = &goal["goal"];
                        if g.is_null() || g.as_object().is_none() {
                            self.push_line(TranscriptLine::status(t("tui.goal.none")));
                        } else {
                            for line in build_goal_report(g) {
                                self.push_line(TranscriptLine::status(line));
                            }
                        }
                    }
                    "status" if objective.is_empty() => {
                        // Full goal panel (TS goal-panel parity,
                        // simplified): objective + status + usage.
                        let goal = session.goal().await?;
                        let g = &goal["goal"];
                        if g.is_null() || g.as_object().is_none() {
                            self.push_line(TranscriptLine::status(t("tui.goal.none")));
                        } else {
                            for line in build_goal_report(g) {
                                self.push_line(TranscriptLine::status(line));
                            }
                        }
                    }
                    // TS parity: control subcommands apply only as the SOLE argument —
                    // `/goal pause do something` creates a goal whose objective starts
                    // with "pause"; `/goal pause` pauses.
                    "pause" if objective.is_empty() => {
                        session.pause_goal(None).await?;
                        self.push_line(TranscriptLine::status(t("tui.goal.paused")));
                    }
                    "resume" if objective.is_empty() => {
                        session.resume_goal(None).await?;
                        self.push_line(TranscriptLine::status(t("tui.goal.resumed")));
                    }
                    "cancel" if objective.is_empty() => {
                        session.cancel_goal().await?;
                        self.push_line(TranscriptLine::status(t("tui.goal.cancelled")));
                    }
                    "replace" => {
                        if objective.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.goal.replaceUsage")));
                        } else {
                            let snapshot = session.create_goal(objective).await?;
                            self.push_line(TranscriptLine::status(t!(
                                "tui.goal.replaced",
                                snapshot["objective"]
                            )));
                        }
                    }
                    "next" => {
                        // Goal queueing (TS `goal-queue-store` parity):
                        // a bare objective appends; subcommands manage
                        // the queue. Auto-promotion on goal completion is
                        // not wired yet.
                        let parts: Vec<&str> = objective.split_whitespace().collect();
                        match parts.first().copied() {
                            None => {
                                self.push_line(TranscriptLine::status(t("tui.goal.queueUsage")))
                            }
                            Some("manage") => {
                                // TS `GoalQueueManagerComponent` parity
                                // (simplified): interactive list → pick →
                                // move up/down / delete / back loop.
                                self.manage_goal_queue(terminal).await?;
                            }
                            Some("remove") if parts.len() >= 2 => {
                                match crate::goal_queue::remove_goal(&self.session_id, parts[1]) {
                                    Ok(true) => self.push_line(TranscriptLine::status(t!(
                                        "tui.goal.removed",
                                        parts[1]
                                    ))),
                                    _ => self.push_line(TranscriptLine::status(t!(
                                        "tui.goal.removedNotFound",
                                        parts[1]
                                    ))),
                                }
                            }
                            Some("move") if parts.len() >= 3 => {
                                let up = match parts[2] {
                                    "up" => true,
                                    "down" => false,
                                    _ => {
                                        self.push_line(TranscriptLine::status(t(
                                            "tui.goal.queueUsage",
                                        )));
                                        return Ok(false);
                                    }
                                };
                                match crate::goal_queue::move_goal(&self.session_id, parts[1], up) {
                                    Ok(true) => self.push_line(TranscriptLine::status(t!(
                                        "tui.goal.moved",
                                        parts[1]
                                    ))),
                                    _ => self.push_line(TranscriptLine::status(t!(
                                        "tui.goal.removedNotFound",
                                        parts[1]
                                    ))),
                                }
                            }
                            Some("promote") => {
                                match crate::goal_queue::promote_top(&self.session_id) {
                                    Ok(Some(g)) => {
                                        let snapshot = session.create_goal(&g.objective).await?;
                                        self.push_line(TranscriptLine::status(t!(
                                            "tui.goal.promoted",
                                            snapshot["objective"]
                                        )));
                                    }
                                    Ok(None) => self
                                        .push_line(TranscriptLine::status(t("tui.goal.noQueued"))),
                                    Err(e) => self.push_line(TranscriptLine::error(format!(
                                        "goal queue: {e}"
                                    ))),
                                }
                            }
                            Some(_) => {
                                // A bare objective queues it.
                                match crate::goal_queue::append_goal(&self.session_id, objective) {
                                    Ok(goal) => {
                                        let count = crate::goal_queue::read_queue(&self.session_id)
                                            .map(|g| g.len())
                                            .unwrap_or(0);
                                        self.push_line(TranscriptLine::status(t!(
                                            "tui.goal.queued",
                                            goal.objective,
                                            count
                                        )));
                                    }
                                    Err(e) => self.push_line(TranscriptLine::error(format!(
                                        "goal queue: {e}"
                                    ))),
                                }
                            }
                        }
                    }
                    _ => {
                        // A bare objective creates a goal and starts pursuing it
                        // immediately (TS parity: create → sendNormalUserInput, so the
                        // goal-driving turn actually runs).
                        let snapshot = session.create_goal(rest).await?;
                        self.push_line(TranscriptLine::status(t!(
                            "tui.goal.created",
                            snapshot["objective"]
                        )));
                        self.run_turn(terminal, rest).await?;
                    }
                }
            }
            "/goal-cancel" => {
                self.session
                    .as_mut()
                    .expect("session")
                    .cancel_goal()
                    .await?;
                self.push_line(TranscriptLine::status(t("tui.goal.cancelled")));
            }
            "/goal-pause" => {
                self.session
                    .as_mut()
                    .expect("session")
                    .pause_goal(Some(rest))
                    .await?;
                self.push_line(TranscriptLine::status(t("tui.goal.paused")));
            }
            "/goal-resume" => {
                self.session
                    .as_mut()
                    .expect("session")
                    .resume_goal(Some(rest))
                    .await?;
                self.push_line(TranscriptLine::status(t("tui.goal.resumed")));
            }
            "/goal-status" => {
                let goal = self.session.as_mut().expect("session").goal().await?;
                self.push_line(TranscriptLine::status(t!(
                    "tui.goal.show",
                    serde_json::to_string(&goal["goal"]).unwrap_or_default()
                )));
            }
            _ => {}
        }
        Ok(false)
    }

    /// TS `getLlmNotSetMessage` parity — refuse a command that needs a model
    /// turn when the session has no model set. Pushes the error itself and
    /// returns `false`.
    async fn ensure_model_set(&mut self) -> anyhow::Result<bool> {
        let status = self.session.as_mut().expect("session").get_status().await;
        if status["model"]
            .as_str()
            .is_none_or(|m| m.trim().is_empty())
        {
            self.push_line(TranscriptLine::error(t("tui.err.llmNotSet")));
            return Ok(false);
        }
        Ok(true)
    }

    /// `/goal next manage` interactive queue manager (TS
    /// `GoalQueueManagerComponent` parity, simplified): list the queue →
    /// pick a queued goal → move up / down / delete / back, looping until
    /// the queue is empty, `back` is picked, or Esc cancels. `edit` is not
    /// offered: the queue store has no update API (TS `updateGoalQueueItem`
    /// has no Rust counterpart yet).
    async fn manage_goal_queue(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    ) -> anyhow::Result<()> {
        loop {
            let goals = match crate::goal_queue::read_queue(&self.session_id) {
                Ok(goals) => goals,
                Err(e) => {
                    self.push_line(TranscriptLine::error(format!("goal queue: {e}")));
                    return Ok(());
                }
            };
            if goals.is_empty() {
                self.push_line(TranscriptLine::status(t("tui.goal.queueEmpty")));
                return Ok(());
            }
            // The current queue, printed on every loop (like the TS panel).
            self.push_line(TranscriptLine::status(t!("tui.goal.queueList", goals.len())));
            for g in &goals {
                self.push_line(TranscriptLine::status(t!(
                    "tui.goal.queueItem",
                    g.id,
                    g.objective
                )));
            }
            let items: Vec<crate::picker::PickerItem> = goals
                .iter()
                .map(|g| {
                    crate::picker::PickerItem::new(g.id.clone(), g.objective.clone())
                        .with_description(g.id.clone())
                })
                .collect();
            let opts = crate::picker::PickerOptions::new(t("tui.goal.manage.select")).paged(10);
            let Some(id) = crate::picker::select_picker(terminal, self.view.theme, &opts, &items)?
            else {
                return Ok(());
            };
            let actions = vec![
                crate::picker::PickerItem::new(
                    String::from("up"),
                    t("tui.goal.manage.up").to_string(),
                ),
                crate::picker::PickerItem::new(
                    String::from("down"),
                    t("tui.goal.manage.down").to_string(),
                ),
                crate::picker::PickerItem::new(
                    String::from("delete"),
                    t("tui.goal.manage.delete").to_string(),
                ),
                crate::picker::PickerItem::new(
                    String::from("back"),
                    t("tui.goal.manage.back").to_string(),
                ),
            ];
            let action_opts =
                crate::picker::PickerOptions::new(t("tui.goal.manage.action")).paged(4);
            let Some(action) =
                crate::picker::select_picker(terminal, self.view.theme, &action_opts, &actions)?
            else {
                continue;
            };
            match action.as_str() {
                "back" => return Ok(()),
                "up" | "down" => {
                    match crate::goal_queue::move_goal(&self.session_id, &id, action == "up") {
                        Ok(true) => self.push_line(TranscriptLine::status(t!(
                            "tui.goal.moved",
                            id
                        ))),
                        _ => self.push_line(TranscriptLine::status(t!(
                            "tui.goal.removedNotFound",
                            id
                        ))),
                    }
                }
                "delete" => match crate::goal_queue::remove_goal(&self.session_id, &id) {
                    Ok(true) => self.push_line(TranscriptLine::status(t!(
                        "tui.goal.removed",
                        id
                    ))),
                    _ => self.push_line(TranscriptLine::status(t!(
                        "tui.goal.removedNotFound",
                        id
                    ))),
                },
                _ => {}
            }
        }
    }
}

impl super::app::App {
    /// `session` command group (extracted from dispatch for readability).
    async fn cmd_session(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        cmd: &str,
        rest: &str,
    ) -> anyhow::Result<bool> {
        match cmd {
            "/session" => {
                let parts: Vec<&str> = rest.split_whitespace().collect();
                match parts.first().copied() {
                    Some("set") if parts.len() >= 2 => {
                        let title = parts[1..].join(" ");
                        match self.harness.rename_session(&self.session_id, &title).await {
                            Ok(()) => self.push_line(TranscriptLine::status(t!(
                                "tui.status.sessionSet",
                                title
                            ))),
                            Err(e) => self
                                .view
                                .transcript
                                .push_line(TranscriptLine::error(t!("tui.err.renameFailed", e))),
                        }
                    }
                    _ => {
                        let msg = if parts.is_empty() {
                            t!("tui.status.sessionId", self.session_id)
                        } else {
                            t("tui.usage.session").to_string()
                        };
                        self.push_line(TranscriptLine::status(msg));
                    }
                }
            }
            "/new" => {
                let fresh = format!("session-{}", fresh_session_id());
                self.switch_to_session(&fresh).await?;
            }
            "/init" => {
                // TS parity: `/init` starts a model turn, so it refuses when
                // no model is set (TS `getLlmNotSetMessage`).
                if !self.ensure_model_set().await? {
                    return Ok(false);
                }
                self.session.as_mut().expect("session").init().await?;
                self.view
                    .transcript
                    .push_line(TranscriptLine::status(t("tui.session.initialized")));
            }
            "/title" => {
                if rest.is_empty() {
                    // TS parity: a bare `/title` shows the current session title.
                    let title = self
                        .harness
                        .list_sessions(50)
                        .await
                        .ok()
                        .and_then(|sessions| {
                            sessions
                                .iter()
                                .find(|s| s["id"] == self.session_id)
                                .and_then(|s| {
                                    s["title"]
                                        .as_str()
                                        .filter(|t| !t.is_empty())
                                        .map(str::to_string)
                                })
                        })
                        .unwrap_or_else(|| t("tui.title.none").to_string());
                    self.view
                        .transcript
                        .push_line(TranscriptLine::status(t!("tui.title.current", title)));
                } else {
                    self.session.as_mut().expect("session").rename(rest).await?;
                    self.view
                        .transcript
                        .push_line(TranscriptLine::status(t!("tui.title.set", rest)));
                }
            }
            "/resume" => {
                if rest.is_empty() {
                    // TS parity: `/resume` (no arg) is the sessions alias — open the
                    // session picker instead of a usage error.
                    return self.dispatch(terminal, "/sessions").await;
                } else {
                    let mut new_session = self.harness.create_session(rest).await?;
                    // Restore the persisted state of the resumed session.
                    let _ = new_session.load().await;
                    self.session = Some(new_session);
                    self.session_id = rest.to_string();
                    self.push_line(TranscriptLine::status(t!("tui.resume.switched", rest)));
                }
            }
            "/clear" => {
                // TS parity: `/clear` is an alias of `/new` — start a fresh
                // session (TS registry: `new` has alias `clear`).
                return self.dispatch(terminal, "/new").await;
            }
            "/fork" => {
                if rest.is_empty() {
                    // TS parity: a bare `/fork` forks the current session with a
                    // "Fork: <title>" title and switches to the fork.
                    let fork_id = fresh_session_id();
                    let title = self
                        .harness
                        .list_sessions(50)
                        .await
                        .ok()
                        .and_then(|sessions| {
                            sessions
                                .iter()
                                .find(|s| s["id"] == self.session_id)
                                .and_then(|s| {
                                    s["title"]
                                        .as_str()
                                        .filter(|t| !t.is_empty())
                                        .map(|t| format!("Fork: {t}"))
                                })
                        });
                    self.session
                        .as_mut()
                        .expect("session")
                        .fork(&fork_id, title.as_deref(), None)
                        .await?;
                    self.switch_to_session(&fork_id).await?;
                    self.push_line(TranscriptLine::status(t!("tui.fork.done", fork_id)));
                } else {
                    self.session
                        .as_mut()
                        .expect("session")
                        .fork(rest, None, None)
                        .await?;
                    self.push_line(TranscriptLine::status(t!("tui.fork.done", rest)));
                }
            }
            "/import" => {
                if rest.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.import.usage")));
                } else {
                    self.session
                        .as_mut()
                        .expect("session")
                        .import_context(rest, "tui")
                        .await?;
                    self.view.transcript.push_line(TranscriptLine::status(t!(
                        "tui.import.done",
                        rest.chars().count()
                    )));
                }
            }
            "/sessions" => {
                let sessions = self.harness.list_sessions(50).await?;
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                // TS session-picker parity: the title leads the card, the detail line
                // carries id · work_dir · relative time, and the current session is
                // marked. The picker still returns the session id. Ctrl-A toggles the
                // scope between the current working directory and all sessions (TS
                // session-picker parity).
                let cwd = std::env::current_dir().ok();
                let current_session_id = self.session_id.clone();
                let mut scope_all = false;
                let build_items = move |scope_all: bool| -> Vec<crate::picker::PickerItem> {
                    sessions
                        .iter()
                        .filter(|s| {
                            scope_all
                                || cwd.as_ref().is_none_or(|cwd| {
                                    s["work_dir"]
                                        .as_str()
                                        .is_none_or(|wd| wd == cwd.to_string_lossy())
                                })
                        })
                        .filter_map(|s| {
                            let id = s["id"].as_str()?.to_string();
                            let is_current = id == current_session_id;
                            let title = s["title"]
                                .as_str()
                                .filter(|t| !t.is_empty())
                                .unwrap_or(&id)
                                .to_string();
                            let label = if is_current {
                                format!("● {title}")
                            } else {
                                title
                            };
                            let mut detail = id.clone();
                            if let Some(wd) = s["work_dir"].as_str().filter(|w| !w.is_empty()) {
                                detail.push_str(&format!(" · {wd}"));
                            }
                            if let Some(updated) = s["updated_at"].as_str() {
                                let relative =
                                    crate::reports::format_relative_time(updated, now_ms);
                                if !relative.is_empty() {
                                    detail.push_str(&format!(" · {relative}"));
                                }
                            }
                            Some(crate::picker::PickerItem::new(id, label).with_description(detail))
                        })
                        .collect()
                };
                let items = build_items(scope_all);
                if items.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.sessions.none")));
                } else {
                    let opts = crate::picker::PickerOptions::new(t("tui.picker.selectSession"))
                        .filterable()
                        .paged(10);
                    let hotkey = {
                        let build = &build_items;
                        let scope = &mut scope_all;
                        move |code: crossterm::event::KeyCode,
                              mods: crossterm::event::KeyModifiers| {
                            if code == crossterm::event::KeyCode::Char('a')
                                && mods.contains(crossterm::event::KeyModifiers::CONTROL)
                            {
                                *scope = !*scope;
                                Some(crate::picker::PickerHotkey::Rebuild(build(*scope)))
                            } else {
                                None
                            }
                        }
                    };
                    match crate::picker::select_picker_with_hotkeys(
                        terminal,
                        self.view.theme,
                        &opts,
                        &items,
                        Some(Box::new(hotkey)),
                    )? {
                        Some(id) => self.switch_to_session(&id).await?,
                        None => self
                            .view
                            .transcript
                            .push_line(TranscriptLine::status(t("tui.sessions.cancelled"))),
                    }
                }
            }
            "/export-debug-zip" => {
                // Debug ZIP export (the historical `/export` behavior): the
                // harness builds the archive engine-side and returns the
                // bytes; we persist them as `{session_id}.zip` in the cwd.
                match self.harness.export_session(&self.session_id).await {
                    Ok(zip) => {
                        let path = format!("{}.zip", self.session_id);
                        match std::fs::write(&path, &zip) {
                            Ok(()) => self.push_line(TranscriptLine::status(t!(
                                "tui.export.done",
                                path,
                                zip.len()
                            ))),
                            Err(e) => {
                                self.push_line(TranscriptLine::error(t!("tui.err.exportWrite", e)))
                            }
                        }
                    }
                    Err(e) => {
                        self.push_line(TranscriptLine::error(t!("tui.err.exportFailed", e)))
                    }
                }
            }
            "/export" => {
                // TS parity: `/export` is an alias of `/export-md` — export
                // the transcript as Markdown (TS registry: `export-md` has
                // alias `export`).
                self.export_markdown();
            }
            "/archive" => {
                let Some(session) = self.session.as_mut() else {
                    self.push_line(TranscriptLine::error(t("tui.err.archiveNoSession")));
                    return Ok(false);
                };
                match session.archive().await {
                    Ok(true) => self
                        .view
                        .transcript
                        .push_line(TranscriptLine::status(t("tui.archive.ok"))),
                    Ok(false) => self
                        .view
                        .transcript
                        .push_line(TranscriptLine::error(t("tui.err.archiveNotFound"))),
                    Err(e) => self
                        .view
                        .transcript
                        .push_line(TranscriptLine::error(t!("tui.err.archiveFailed", e))),
                }
            }
            "/btw" => {
                // TS parity: spawn a side-question agent and route the
                // prompt to it; the answer streams into the transcript
                // (`[btw]`-prefixed user line). While the agent is
                // active, every prompt routes to it until `/endbtw`.
                let question = rest.trim();
                if question.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.btw.usage")));
                } else if self.btw_agent.is_some() {
                    self.push_line(TranscriptLine::status(t("tui.btw.alreadyActive")));
                } else {
                    match self.session.as_mut().expect("session").start_btw().await {
                        Ok(id) => {
                            self.btw_agent = Some(id.clone());
                            self.push_line(TranscriptLine::status(t!("tui.btw.started", id)));
                            return self.run_turn(terminal, question).await.map(|_| false);
                        }
                        Err(e) => {
                            self.push_line(TranscriptLine::error(t!("tui.err.generic", e)));
                        }
                    }
                }
            }
            "/endbtw" => match self.session.as_mut().expect("session").end_btw().await {
                Ok(()) => {
                    self.btw_agent = None;
                    self.push_line(TranscriptLine::status(t("tui.btw.ended")));
                }
                Err(e) => {
                    self.push_line(TranscriptLine::error(t!("tui.err.generic", e)));
                }
            },
            "/copy" => {
                // Copy the last assistant reply to the clipboard (TS
                // `handleCopyCommand` parity — sourced from the rendered
                // transcript so it survives compaction).
                match find_last_assistant_text(&self.view.transcript) {
                    Some(text) => match copy_to_clipboard(&text) {
                        Ok(()) => self.push_line(TranscriptLine::status(t!(
                            "tui.copy.ok",
                            text.chars().count()
                        ))),
                        Err(e) => {
                            self.push_line(TranscriptLine::error(t!("tui.err.copyFailed", e)))
                        }
                    },
                    None => self.push_line(TranscriptLine::status(t("tui.copy.none"))),
                }
            }
            "/export-md" => {
                // TS parity: export to `kimi-export-<id8>-<timestamp>.md` in
                // the current directory (the session-scoped name keeps exports
                // from clobbering each other).
                self.export_markdown();
            }
            _ => {}
        }
        Ok(false)
    }

    /// `/export` / `/export-md` shared body: write the rendered transcript to
    /// `kimi-export-<id8>-<timestamp>.md` in the cwd (TS
    /// `handleExportMdCommand` parity).
    fn export_markdown(&mut self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let id8: String = self.session_id.chars().take(8).collect();
        let path = format!("kimi-export-{id8}-{now}.md");
        let markdown = transcript_to_markdown(&self.view.transcript);
        match std::fs::write(&path, markdown) {
            Ok(()) => self.push_line(TranscriptLine::status(t!("tui.exportMd.done", path))),
            Err(e) => {
                self.push_line(TranscriptLine::error(t!("tui.err.exportMdFailed", e)))
            }
        }
    }
}

impl super::app::App {
    /// `config` command group (extracted from dispatch for readability).
    async fn cmd_config(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        cmd: &str,
        rest: &str,
    ) -> anyhow::Result<bool> {
        match cmd {
            "/config" => {
                // TS parity: `/config` is an alias of `/settings` — open the
                // settings menu (TS registry: `settings` has alias `config`).
                return self.dispatch(terminal, "/settings").await;
            }
            "/plan" => {
                if rest == "clear" {
                    // `/plan clear` drops the current plan (TS parity).
                    self.session.as_mut().expect("session").clear_plan().await?;
                    self.push_line(TranscriptLine::status(t("tui.plan.cleared")));
                    self.refresh_status().await;
                } else {
                    // TS parity: only clear/on/off are accepted; anything else is an
                    // error instead of silently toggling off.
                    let enabled = match rest {
                        "" | "on" => true,
                        "off" => false,
                        other => {
                            self.push_line(TranscriptLine::error(t!("tui.plan.badArg", other)));
                            return Ok(false);
                        }
                    };
                    self.session
                        .as_mut()
                        .expect("session")
                        .set_plan_mode(enabled)
                        .await?;
                    self.push_line(TranscriptLine::status(t!(
                        "tui.status.plan",
                        t(if enabled {
                            "tui.status.on"
                        } else {
                            "tui.status.off"
                        })
                    )));
                    self.refresh_status().await;
                }
            }
            "/thinking" => {
                let effort = rest.trim();
                if effort.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.thinking.usage")));
                } else if !matches!(effort, "off" | "low" | "medium" | "high" | "none") {
                    // TS parity: validate the effort level before applying it.
                    self.push_line(TranscriptLine::error(t!("tui.thinking.badEffort", effort)));
                    return Ok(false);
                } else {
                    let value = if effort == "off" || effort == "none" {
                        None
                    } else {
                        Some(effort)
                    };
                    self.session
                        .as_mut()
                        .expect("session")
                        .set_thinking(value)
                        .await?;
                    self.push_line(TranscriptLine::status(t!("tui.thinking.set", effort)));
                }
            }
            "/permission" => {
                if rest.is_empty() {
                    // No arg: pick a permission mode (TS picker parity)
                    // with a mode description per row.
                    let items: Vec<crate::picker::PickerItem> = [
                        ("manual", "tui.permission.descManual"),
                        ("plan", "tui.permission.descPlan"),
                        ("auto", "tui.permission.descAuto"),
                        ("yolo", "tui.permission.descYolo"),
                    ]
                    .iter()
                    .map(|(mode, desc_key)| {
                        crate::picker::PickerItem::new(*mode, *mode).with_description(t(desc_key))
                    })
                    .collect();
                    let opts = crate::picker::PickerOptions::new(t("tui.picker.selectPermission"));
                    match crate::picker::select_picker(terminal, self.view.theme, &opts, &items)? {
                        Some(mode) => {
                            self.session
                                .as_mut()
                                .expect("session")
                                .set_permission(&mode)
                                .await?;
                            self.view
                                .transcript
                                .push_line(TranscriptLine::status(t!("tui.permission.mode", mode)));
                        }
                        None => self
                            .view
                            .transcript
                            .push_line(TranscriptLine::status(t("tui.permission.cancelled"))),
                    }
                } else {
                    let mode = rest;
                    self.session
                        .as_mut()
                        .expect("session")
                        .set_permission(mode)
                        .await?;
                    self.view
                        .transcript
                        .push_line(TranscriptLine::status(t!("tui.permission.mode", mode)));
                }
            }
            "/yolo" => {
                // TS parity: `/yolo [on|off|toggle]` — bare or `toggle` flips, `on`/`off`
                // target a state explicitly, and an already-reached target just reports
                // (it must never flip the opposite way).
                let current = self.session.as_mut().expect("session").get_status().await;
                let now_yolo = current["result"]["permission"].as_str() == Some("yolo");
                let on = match rest.trim() {
                    "" | "toggle" | "t" => !now_yolo,
                    "on" | "1" | "true" => true,
                    "off" | "0" | "false" => false,
                    other => {
                        self.push_line(TranscriptLine::error(t!("tui.usage.yolo", other)));
                        return Ok(false);
                    }
                };
                if on == now_yolo {
                    self.push_line(TranscriptLine::status(t!(if on {
                        "tui.yolo.alreadyOn"
                    } else {
                        "tui.yolo.alreadyOff"
                    })));
                    return Ok(false);
                }
                self.session
                    .as_mut()
                    .expect("session")
                    .set_permission(if on { "yolo" } else { "manual" })
                    .await?;
                self.push_line(TranscriptLine::status(t!(
                    "tui.permission.yolo",
                    t(if on {
                        "tui.status.on"
                    } else {
                        "tui.status.off"
                    })
                )));
            }
            "/auto" => {
                // TS parity: `/auto [on|off|toggle]` — see `/yolo` above.
                let current = self.session.as_mut().expect("session").get_status().await;
                let now_auto = current["result"]["permission"].as_str() == Some("auto");
                let on = match rest.trim() {
                    "" | "toggle" | "t" => !now_auto,
                    "on" | "1" | "true" => true,
                    "off" | "0" | "false" => false,
                    other => {
                        self.push_line(TranscriptLine::error(t!("tui.usage.auto", other)));
                        return Ok(false);
                    }
                };
                if on == now_auto {
                    self.push_line(TranscriptLine::status(t!(if on {
                        "tui.auto.alreadyOn"
                    } else {
                        "tui.auto.alreadyOff"
                    })));
                    return Ok(false);
                }
                self.session
                    .as_mut()
                    .expect("session")
                    .set_permission(if on { "auto" } else { "manual" })
                    .await?;
                self.push_line(TranscriptLine::status(t!(
                    "tui.permission.auto",
                    t(if on {
                        "tui.status.on"
                    } else {
                        "tui.status.off"
                    })
                )));
            }
            "/theme" => {
                // Pick dark / light / auto / a custom theme (persisted to
                // tui.toml). A bare `/theme` opens the picker (custom themes
                // from the themes directory listed after the built-ins); an
                // argument applies directly (TS theme-selector parity).
                let choice = if rest.is_empty() {
                    let mut items: Vec<(String, String)> = ["auto", "dark", "light"]
                        .iter()
                        .map(|m| (m.to_string(), String::new()))
                        .collect();
                    items.extend(
                        crate::theme::list_custom_themes()
                            .into_iter()
                            .map(|name| (name, String::new())),
                    );
                    match crate::picker::select(
                        terminal,
                        self.view.theme,
                        t("tui.picker.selectTheme"),
                        &items,
                    )? {
                        Some(choice) => choice,
                        None => {
                            self.push_line(TranscriptLine::status(t("tui.theme.cancelled")));
                            return Ok(false);
                        }
                    }
                } else {
                    rest.to_string()
                };
                // auto / dark / light apply directly; any other name is a
                // custom theme loaded from the themes directory. Failed
                // loads surface an error and are never persisted.
                match choice.as_str() {
                    "light" => {
                        self.view.theme = crate::theme::Theme::light();
                        self.view.dark_mode = false;
                    }
                    "dark" | "auto" => {
                        // auto approximates dark for now.
                        self.view.theme = crate::theme::Theme::dark();
                        self.view.dark_mode = true;
                    }
                    name => match crate::theme::load_custom_theme(name) {
                        Ok(theme) => {
                            self.view.theme = theme;
                            self.view.dark_mode = true;
                        }
                        Err(e) => {
                            self.push_line(TranscriptLine::error(t!(
                                "tui.err.themeLoadFailed",
                                e.to_string()
                            )));
                            return Ok(false);
                        }
                    },
                }
                if let Err(e) = crate::theme::set_tui_config_field(
                    "theme",
                    toml::Value::String(choice.clone()),
                ) {
                    self.push_line(TranscriptLine::error(format!("theme save failed: {e}")));
                }
                self.push_line(TranscriptLine::status(t!("tui.theme.set", choice)));
            }
            "/models" => {
                let (aliases, default_model) = self.harness.list_models().await?;
                if aliases.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.models.none")));
                }
                for alias in aliases.iter().take(20) {
                    self.push_line(TranscriptLine::status(alias.clone()));
                }
                if let Some(default_model) = default_model {
                    self.push_line(TranscriptLine::status(t!(
                        "tui.models.default",
                        default_model
                    )));
                }
            }
            "/model" => {
                if rest.is_empty() {
                    // No arg: interactively pick a model from the aliases
                    // (TS `/model` picker parity) instead of a usage error.
                    let items: Vec<crate::picker::PickerItem> = self
                        .model_aliases
                        .iter()
                        .map(|alias| crate::picker::PickerItem::new(alias.clone(), String::new()))
                        .collect();
                    if items.is_empty() {
                        self.push_line(TranscriptLine::status(t("tui.models.none")));
                    } else {
                        let opts = crate::picker::PickerOptions::new(t("tui.picker.selectModel"))
                            .filterable()
                            .paged(10);
                        match crate::picker::select_picker(
                            terminal,
                            self.view.theme,
                            &opts,
                            &items,
                        )? {
                            Some(model) => {
                                self.session
                                    .as_mut()
                                    .expect("session")
                                    .set_model(&model)
                                    .await?;
                                // TS model-selector parity: pick the thinking effort
                                // right after the model (off / low / medium / high, or
                                // keep the current setting with Esc / "keep current").
                                let effort_items = vec![
                                    crate::picker::PickerItem::new(
                                        String::from("keep"),
                                        t!("tui.effort.keep"),
                                    ),
                                    crate::picker::PickerItem::new(
                                        String::from("off"),
                                        t!("tui.effort.off"),
                                    ),
                                    crate::picker::PickerItem::new(
                                        String::from("low"),
                                        t!("tui.effort.low"),
                                    ),
                                    crate::picker::PickerItem::new(
                                        String::from("medium"),
                                        t!("tui.effort.medium"),
                                    ),
                                    crate::picker::PickerItem::new(
                                        String::from("high"),
                                        t!("tui.effort.high"),
                                    ),
                                ];
                                let effort_opts = crate::picker::PickerOptions::new(t!(
                                    "tui.picker.selectEffort"
                                ))
                                .paged(5);
                                if let Some(choice) = crate::picker::select_picker(
                                    terminal,
                                    self.view.theme,
                                    &effort_opts,
                                    &effort_items,
                                )? {
                                    if choice != "keep" {
                                        let effort = if choice == "off" {
                                            None
                                        } else {
                                            Some(choice.as_str())
                                        };
                                        self.session
                                            .as_mut()
                                            .expect("session")
                                            .set_thinking(effort)
                                            .await?;
                                    }
                                }
                                self.view
                                    .transcript
                                    .push_line(TranscriptLine::status(t!("tui.models.set", model)));
                            }
                            None => self
                                .view
                                .transcript
                                .push_line(TranscriptLine::status(t("tui.models.cancelled"))),
                        }
                    }
                } else {
                    // TS parity: validate the alias before switching (an unknown
                    // alias reports an error instead of silently setting a broken
                    // model).
                    if !self.model_aliases.iter().any(|a| a == rest) {
                        self.push_line(TranscriptLine::error(t!("tui.models.notFound", rest)));
                        return Ok(false);
                    }
                    self.session
                        .as_mut()
                        .expect("session")
                        .set_model(rest)
                        .await?;
                    self.push_line(TranscriptLine::status(t!("tui.models.set", rest)));
                }
            }
            "/reload" => {
                // Re-load the persisted session state into the live agent
                // (create already happened; load restores context + goal).
                match self.session.as_mut().expect("session").load().await {
                    Ok(()) => self.push_line(TranscriptLine::status(t("tui.reload.ok"))),
                    Err(e) => self.push_line(TranscriptLine::error(t!("tui.err.reloadFailed", e))),
                }
            }
            "/reload-tui" => {
                // Re-read tui.toml preferences (theme + locale).
                crate::i18n::reload_locale();
                self.view.theme = crate::theme::load_theme();
                self.view.dark_mode = !matches!(
                    crate::theme::tui_theme_choice(),
                    crate::theme::ThemeChoice::Light
                );
                self.push_line(TranscriptLine::status(t("tui.reloadTui.ok")));
            }
            "/locale" => {
                let locale = if rest.is_empty() {
                    // No arg: pick en/zh (TS locale-selector parity).
                    let items: Vec<(String, String)> = ["en", "zh"]
                        .iter()
                        .map(|m| (m.to_string(), String::new()))
                        .collect();
                    match crate::picker::select(
                        terminal,
                        self.view.theme,
                        t("tui.picker.selectLocale"),
                        &items,
                    )? {
                        Some(choice) => match choice.as_str() {
                            "zh" => crate::i18n::Locale::Zh,
                            _ => crate::i18n::Locale::En,
                        },
                        None => {
                            self.push_line(TranscriptLine::status(t("tui.locale.cancelled")));
                            return Ok(false);
                        }
                    }
                } else {
                    match rest {
                        "zh" => crate::i18n::Locale::Zh,
                        "en" => crate::i18n::Locale::En,
                        _ => {
                            self.push_line(TranscriptLine::status(t("tui.locale.usage")));
                            return Ok(false);
                        }
                    }
                };
                // Persist to tui.toml first, then switch the runtime locale
                // so subsequent renders use the new language immediately.
                if let Err(e) = crate::i18n::save_locale(locale) {
                    self.push_line(TranscriptLine::error(format!("locale save failed: {e}")));
                }
                crate::i18n::set_locale(locale);
                self.push_line(TranscriptLine::status(t!("tui.locale.set", rest)));
            }
            "/editor" => {
                if rest.is_empty() {
                    // Show the current editor.
                    match crate::editor::resolve_editor() {
                        Some(cmd) => {
                            self.push_line(TranscriptLine::status(t!("tui.editor.current", cmd)))
                        }
                        None => self.push_line(TranscriptLine::status(t("tui.editor.noEditor"))),
                    }
                } else {
                    match crate::editor::save_editor(rest) {
                        Ok(()) => {
                            self.push_line(TranscriptLine::status(t!("tui.editor.set", rest)))
                        }
                        Err(e) => self.push_line(TranscriptLine::error(format!("editor: {e}"))),
                    }
                }
            }
            "/settings" => {
                // Unified settings menu (TS settings-selector parity):
                // pick an entry and dispatch to the underlying command.
                // github_token / astron have no slash-command backing — they
                // are handled inline below.
                let items: Vec<(String, String)> = [
                    ("model", t("tui.settings.model")),
                    ("theme", t("tui.settings.theme")),
                    ("editor", t("tui.settings.editor")),
                    ("language", t("tui.settings.language")),
                    ("permission", t("tui.settings.permission")),
                    ("usage", t("tui.settings.usage")),
                    ("experiments", t("tui.settings.experiments")),
                    ("upgrade", t("tui.settings.upgrade")),
                    ("github_token", t("tui.settings.githubToken")),
                    ("astron", t("tui.settings.astron")),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
                match crate::picker::select(
                    terminal,
                    self.view.theme,
                    t("tui.picker.selectSetting"),
                    &items,
                )? {
                    Some(choice) => match choice.as_str() {
                        "github_token" => {
                            // TS prompts for a token and writes
                            // `experimental.github_token`; the Rust engine has
                            // no `[experimental]` section and its GitHub tools
                            // read GITHUB_TOKEN / GH_TOKEN at call time.
                            self.push_line(TranscriptLine::status(t(
                                "tui.settings.githubTokenHint",
                            )));
                        }
                        "astron" => {
                            // TS: an Astron settings panel (stream /
                            // temperature / maxTokens / searchDisable) gated
                            // behind the xunfei_coding_plan flag. The engine
                            // knows the astron provider type but ProviderConfig
                            // carries only type/apiKey/baseUrl/defaultModel/
                            // maxTokens — show the real status, note the rest.
                            match self.harness.config().await {
                                Ok(cfg) => {
                                    match cfg["providers"]["astron"].as_object() {
                                        Some(p) => {
                                            let key = if p["apiKey"]
                                                .as_str()
                                                .is_some_and(|k| !k.is_empty())
                                            {
                                                t("tui.provider.keySet")
                                            } else {
                                                t("tui.provider.keyMissing")
                                            };
                                            let base =
                                                p["baseUrl"].as_str().unwrap_or("-");
                                            let max_tokens = p["maxTokens"]
                                                .as_u64()
                                                .map(|v| v.to_string())
                                                .unwrap_or_else(|| "-".to_string());
                                            self.push_line(TranscriptLine::status(t!(
                                                "tui.settings.astronStatus",
                                                key,
                                                base,
                                                max_tokens
                                            )));
                                        }
                                        None => self.push_line(TranscriptLine::status(t(
                                            "tui.settings.astronNotConfigured",
                                        ))),
                                    }
                                    self.push_line(TranscriptLine::status(t(
                                        "tui.settings.astronHint",
                                    )));
                                }
                                Err(e) => self.push_line(TranscriptLine::error(t!(
                                    "tui.err.configFailed",
                                    e
                                ))),
                            }
                        }
                        _ => {
                            let cmd = match choice.as_str() {
                                "model" => "/model",
                                "theme" => "/theme",
                                "editor" => "/editor",
                                "language" => "/locale",
                                "permission" => "/permission",
                                "usage" => "/usage",
                                "experiments" => "/experiments",
                                "upgrade" => "/upgrade",
                                _ => return Ok(false),
                            };
                            // Re-enter dispatch with the subcommand; a quit
                            // from within propagates.
                            if self.dispatch(terminal, cmd).await? {
                                return Ok(true);
                            }
                        }
                    },
                    None => self.push_line(TranscriptLine::status(t("tui.settings.cancelled"))),
                }
            }
            "/provider" => {
                // Provider management (TS `handleProviderCommand` parity,
                // simplified): interactive picker, or list / remove /
                // add as commands.
                let parts: Vec<&str> = rest.split_whitespace().collect();
                match parts.first().copied() {
                    None => {
                        // Interactive provider browser: pick a provider
                        // to remove it (with a y/N confirm); adding is
                        // pointed at /login / config.toml.
                        match self.harness.config().await {
                            Ok(cfg) => {
                                let providers =
                                    cfg["providers"].as_object().cloned().unwrap_or_default();
                                if providers.is_empty() {
                                    self.push_line(TranscriptLine::status(t("tui.provider.none")));
                                } else {
                                    let items: Vec<crate::picker::PickerItem> = providers
                                        .iter()
                                        .map(|(name, p)| {
                                            let has_key =
                                                p["apiKey"].as_str().is_some_and(|k| !k.is_empty());
                                            let key_state = if has_key {
                                                t("tui.provider.keySet")
                                            } else {
                                                t("tui.provider.keyMissing")
                                            };
                                            let base = p["baseUrl"].as_str().unwrap_or("");
                                            crate::picker::PickerItem::new(
                                                name.clone(),
                                                format!("{name}  {key_state}"),
                                            )
                                            .with_description(base)
                                        })
                                        .collect();
                                    let opts = crate::picker::PickerOptions::new(t!(
                                        "tui.provider.select"
                                    ))
                                    .filterable()
                                    .paged(10);
                                    match crate::picker::select_picker(
                                        terminal,
                                        self.view.theme,
                                        &opts,
                                        &items,
                                    )? {
                                        Some(name) => {
                                            if self
                                                .confirm(
                                                    terminal,
                                                    &t!("tui.provider.confirmRemove", name),
                                                )
                                                .await?
                                            {
                                                return self
                                                    .dispatch(
                                                        terminal,
                                                        &format!("/provider remove {name}"),
                                                    )
                                                    .await;
                                            }
                                        }
                                        None => self.push_line(TranscriptLine::status(t(
                                            "tui.provider.cancelled",
                                        ))),
                                    }
                                }
                            }
                            Err(e) => {
                                self.push_line(TranscriptLine::error(t!("tui.err.configFailed", e)))
                            }
                        }
                    }
                    Some("list") => match self.harness.config().await {
                        Ok(cfg) => {
                            let providers =
                                cfg["providers"].as_object().cloned().unwrap_or_default();
                            if providers.is_empty() {
                                self.push_line(TranscriptLine::status(t("tui.provider.none")));
                            } else {
                                self.push_line(TranscriptLine::status(t!(
                                    "tui.provider.list",
                                    providers.len()
                                )));
                                for (name, p) in providers {
                                    let has_key =
                                        p["apiKey"].as_str().is_some_and(|k| !k.is_empty());
                                    let key_state = if has_key {
                                        t("tui.provider.keySet")
                                    } else {
                                        t("tui.provider.keyMissing")
                                    };
                                    let base = p["baseUrl"].as_str().unwrap_or("");
                                    self.push_line(TranscriptLine::status(format!(
                                        "  {name}  {key_state}  {base}"
                                    )));
                                }
                            }
                        }
                        Err(e) => {
                            self.push_line(TranscriptLine::error(t!("tui.err.configFailed", e)))
                        }
                    },
                    Some("remove") if parts.len() >= 2 => {
                        let name = parts[1];
                        match self
                            .harness
                            .set_config(serde_json::json!({ "providers": { name: null } }))
                            .await
                        {
                            Ok(_) => self.push_line(TranscriptLine::status(t!(
                                "tui.provider.removed",
                                name
                            ))),
                            Err(e) => {
                                self.push_line(TranscriptLine::error(t!("tui.err.configFailed", e)))
                            }
                        }
                    }
                    Some("add") if parts.len() >= 2 => {
                        // TS provider-add parity (catalog path): import a known
                        // provider from the models.dev catalog, pick the default
                        // model, and write providers + model aliases to config.toml.
                        // Custom registries (api.json URLs) go through the CLI:
                        // `kimi provider add <url>`.
                        let id = parts[1].to_string();
                        let api_key = parts
                            .windows(2)
                            .find(|w| w[0] == "--api-key")
                            .map(|w| w[1].to_string());
                        match kimi_sdk::catalog::fetch_catalog(
                            kimi_sdk::catalog::DEFAULT_CATALOG_URL,
                        )
                        .await
                        {
                            Ok(catalog) => {
                                let Some(provider) = catalog.get(&id) else {
                                    self.push_line(TranscriptLine::error(t!(
                                        "tui.provider.notFound",
                                        &id
                                    )));
                                    return Ok(false);
                                };
                                let resolution =
                                    kimi_sdk::catalog::resolve_catalog_import(provider, None);
                                let (wire, resolved_base_url) = match &resolution.kind {
                                    kimi_sdk::catalog::CatalogImportKind::Ok => (
                                        resolution
                                            .wire
                                            .clone()
                                            .expect("ok resolution carries a wire type"),
                                        resolution.base_url.clone(),
                                    ),
                                    kimi_sdk::catalog::CatalogImportKind::NeedsBaseUrl => {
                                        self.push_line(TranscriptLine::error(t!(
                                            "tui.provider.needsBaseUrl",
                                            &id
                                        )));
                                        return Ok(false);
                                    }
                                    kimi_sdk::catalog::CatalogImportKind::Invalid(_) => {
                                        self.push_line(TranscriptLine::error(t!(
                                            "tui.provider.notImportable",
                                            &id
                                        )));
                                        return Ok(false);
                                    }
                                };
                                let models = kimi_sdk::catalog::catalog_provider_models(provider);
                                if models.is_empty() {
                                    self.push_line(TranscriptLine::error(t!(
                                        "tui.provider.noModels",
                                        &id
                                    )));
                                    return Ok(false);
                                }
                                // Default-model picker (TS parity).
                                let items: Vec<crate::picker::PickerItem> = models
                                    .iter()
                                    .map(|m| {
                                        crate::picker::PickerItem::new(
                                            m.id.clone(),
                                            m.name.clone().unwrap_or_default(),
                                        )
                                    })
                                    .collect();
                                let opts = crate::picker::PickerOptions::new(t!(
                                    "tui.provider.selectModel"
                                ))
                                .filterable()
                                .paged(10);
                                let default_model = crate::picker::select_picker(
                                    terminal,
                                    self.view.theme,
                                    &opts,
                                    &items,
                                )?;
                                let mut config =
                                    serde_json::json!({ "providers": {}, "models": {} });
                                let _ = kimi_sdk::catalog::apply_catalog_provider(
                                    &mut config,
                                    &id,
                                    &wire,
                                    resolved_base_url.as_deref(),
                                    api_key.as_deref(),
                                    &models,
                                    default_model.as_deref(),
                                    true,
                                );
                                match self.harness.set_config(config).await {
                                    Ok(_) => {
                                        self.push_line(TranscriptLine::status(t!(
                                            "tui.provider.added",
                                            &id,
                                            models.len()
                                        )));
                                        if api_key.is_none() {
                                            self.push_line(TranscriptLine::status(t!(
                                                "tui.provider.keyMissing"
                                            )));
                                        }
                                    }
                                    Err(e) => self.push_line(TranscriptLine::error(t!(
                                        "tui.err.configFailed",
                                        e
                                    ))),
                                }
                            }
                            Err(e) => {
                                self.push_line(TranscriptLine::error(format!("catalog: {e}")))
                            }
                        }
                    }
                    _ => self.push_line(TranscriptLine::status(t("tui.provider.usage"))),
                }
            }
            "/experiments" => {
                // TS `showExperimentsPanel` parity, adapted to the Rust
                // engine's config surface: the legacy TS flag registry
                // (tool-select, native_tools, github_tools, ...) is env-gated
                // via `KIMI_CODE_EXPERIMENTAL_*` and config.toml has no
                // `[experimental]` section (the CONFIG_SET merge drops unknown
                // keys), so the one config-backed experiment is
                // `[secondary_model]` (`secondaryModel` in the RPC shape).
                let parts: Vec<&str> = rest.split_whitespace().collect();
                match parts.first().copied() {
                    None => match self.harness.config().await {
                        Ok(cfg) => {
                            let secondary = cfg["secondaryModel"].as_object();
                            // Engine gate (env, read from this process).
                            let gate = std::env::var("KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL")
                                .ok()
                                .filter(|v| !v.trim().is_empty())
                                .or_else(|| {
                                    std::env::var("KIMI_CODE_EXPERIMENTAL_FLAG")
                                        .ok()
                                        .filter(|v| !v.trim().is_empty())
                                });
                            if gate.is_some() {
                                self.push_line(TranscriptLine::status(t("tui.experiments.gateOn")));
                            } else {
                                self.push_line(TranscriptLine::status(t("tui.experiments.gateOff")));
                            }
                            let items: Vec<(String, String)> = match secondary {
                                Some(sec) => {
                                    let model = sec["model"].as_str().unwrap_or("?");
                                    let effort =
                                        sec["defaultEffort"].as_str().unwrap_or("default");
                                    vec![(
                                        String::from("secondary"),
                                        t!("tui.experiments.secondary", model, effort),
                                    )]
                                }
                                None => vec![(
                                    String::from("secondary"),
                                    t("tui.experiments.secondaryOff").to_string(),
                                )],
                            };
                            match crate::picker::select(
                                terminal,
                                self.view.theme,
                                t("tui.experiments.select"),
                                &items,
                            )? {
                                Some(_) if secondary.is_some() => {
                                    if self
                                        .confirm(terminal, t("tui.experiments.confirmOff"))
                                        .await?
                                    {
                                        match self
                                            .harness
                                            .set_config(serde_json::json!({
                                                "secondaryModel": { "model": "" }
                                            }))
                                            .await
                                        {
                                            Ok(_) => self.push_line(TranscriptLine::status(t(
                                                "tui.experiments.off",
                                            ))),
                                            Err(e) => self.push_line(TranscriptLine::error(t!(
                                                "tui.err.configFailed",
                                                e
                                            ))),
                                        }
                                    }
                                }
                                Some(_) => self.push_line(TranscriptLine::status(t(
                                    "tui.experiments.onUsage",
                                ))),
                                None => self.push_line(TranscriptLine::status(t(
                                    "tui.experiments.cancelled",
                                ))),
                            }
                            self.push_line(TranscriptLine::status(t("tui.experiments.effective")));
                            self.push_line(TranscriptLine::status(t("tui.experiments.otherFlags")));
                        }
                        Err(e) => {
                            self.push_line(TranscriptLine::error(t!("tui.err.configFailed", e)))
                        }
                    },
                    Some("secondary") => {
                        match (parts.get(1).copied(), parts.get(2).copied()) {
                            (Some("on"), Some(model)) => {
                                let patch = match parts.get(3).copied() {
                                    Some(effort) => serde_json::json!({
                                        "secondaryModel": {
                                            "model": model,
                                            "defaultEffort": effort,
                                        }
                                    }),
                                    None => serde_json::json!({
                                        "secondaryModel": { "model": model }
                                    }),
                                };
                                match self.harness.set_config(patch).await {
                                    Ok(_) => self.push_line(TranscriptLine::status(t!(
                                        "tui.experiments.on",
                                        model
                                    ))),
                                    Err(e) => self.push_line(TranscriptLine::error(t!(
                                        "tui.err.configFailed",
                                        e
                                    ))),
                                }
                            }
                            (Some("on"), None) => self.push_line(TranscriptLine::status(t(
                                "tui.experiments.onUsage",
                            ))),
                            (Some("off"), _) => {
                                match self
                                    .harness
                                    .set_config(serde_json::json!({
                                        "secondaryModel": { "model": "" }
                                    }))
                                    .await
                                {
                                    Ok(_) => self.push_line(TranscriptLine::status(t(
                                        "tui.experiments.off",
                                    ))),
                                    Err(e) => self.push_line(TranscriptLine::error(t!(
                                        "tui.err.configFailed",
                                        e
                                    ))),
                                }
                            }
                            _ => self
                                .push_line(TranscriptLine::status(t("tui.experiments.onUsage"))),
                        }
                        self.push_line(TranscriptLine::status(t("tui.experiments.effective")));
                    }
                    Some(_) => self.push_line(TranscriptLine::status(t("tui.experiments.onUsage"))),
                }
            }
            "/multi-llm" => {
                // TS `handleMultiLlmCommand` parity — but the engine has no
                // multi-LLM config surface: `agent.multiLlm` is not a
                // KimiConfig field (the CONFIG_SET merge drops it), and the
                // MultiLLM router is driven by host-supplied session params,
                // not config.toml. Show the configured providers (the
                // potential race pool) and an honest note; toggling is not
                // backed by any engine data.
                match self.harness.config().await {
                    Ok(cfg) => {
                        let providers = cfg["providers"].as_object().cloned().unwrap_or_default();
                        if providers.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.provider.none")));
                        } else {
                            self.push_line(TranscriptLine::status(t!(
                                "tui.multiLlm.pool",
                                providers.len()
                            )));
                            for name in providers.keys() {
                                self.push_line(TranscriptLine::status(format!("  {name}")));
                            }
                        }
                        self.push_line(TranscriptLine::status(t("tui.multiLlm.noDataPlane")));
                    }
                    Err(e) => {
                        self.push_line(TranscriptLine::error(t!("tui.err.configFailed", e)))
                    }
                }
            }
            "/feedback" => {
                // TS parity (constant/app.ts `FEEDBACK_ISSUE_URL`): the TS
                // client submits feedback to a backend API, falling back to
                // GitHub Issues; the Rust CLI has no feedback backend, so the
                // command opens the issues page directly.
                open_url(FEEDBACK_ISSUE_URL);
                self.push_line(TranscriptLine::status(t!("tui.feedback.hint", FEEDBACK_ISSUE_URL)));
            }
            "/web" => {
                // Spawn `kimi web` as a detached child (in-process server +
                // SPA + auto-opened browser). The child keeps serving after
                // the TUI exits; its own banner goes to null stdio, so the
                // TUI just reports the launch (TS parity: the web UI is a
                // separate process from the TUI).
                match spawn_web_process() {
                    Ok(()) => self.push_line(TranscriptLine::status(t!(
                        "tui.web.starting",
                        DEFAULT_WEB_ORIGIN
                    ))),
                    Err(e) => self.push_line(TranscriptLine::error(t!(
                        "tui.web.failed",
                        e.to_string()
                    ))),
                }
            }
            "/upgrade" => {
                // The CLI owns upgrades (`kimi upgrade`); point at it from the TUI.
                self.push_line(TranscriptLine::status(t("tui.upgrade.hint")));
            }
            _ => {}
        }
        Ok(false)
    }
}

impl super::app::App {
    /// `resource` command group (extracted from dispatch for readability).
    async fn cmd_resource(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        cmd: &str,
        rest: &str,
    ) -> anyhow::Result<bool> {
        match cmd {
            "/quit" | "/exit" => {
                return Ok(true);
            }
            "/help" => {
                if rest.is_empty() {
                    // Full help panel as a modal overlay (TS
                    // help-panel parity): shortcuts + command list.
                    self.overlay = Some(Overlay::Help(HelpPanel::new()));
                } else {
                    // `/help <command>` shows that command's description.
                    let cmd = format!("/{rest}");
                    let found = crate::bottom_pane::command_descriptions()
                        .into_iter()
                        .find(|(name, _)| *name == cmd);
                    match found {
                        Some((name, desc)) => {
                            self.push_line(TranscriptLine::status(format!("{name}  {desc}")))
                        }
                        None => self.push_line(TranscriptLine::error(t!("tui.help.unknown", cmd))),
                    }
                }
            }
            "/approvals" => {
                let items = self.harness.approvals(Some(&self.session_id)).await?;
                if items.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.approval.none")));
                }
                for item in items.iter().take(10) {
                    let id = item["id"].as_str().unwrap_or("?");
                    let tool = item["tool_name"].as_str().unwrap_or("?");
                    let rule = item["approval_rule"].as_str().unwrap_or("?");
                    self.push_line(TranscriptLine::status(t!(
                        "tui.approval.listItem",
                        id,
                        tool,
                        rule
                    )));
                }
            }
            "/approve" => {
                if rest.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.approval.approveUsage")));
                } else {
                    let resolved = self.harness.resolve_approval(rest, true, None).await?;
                    self.push_line(TranscriptLine::status(if resolved {
                        t("tui.approval.allowed")
                    } else {
                        t("tui.approval.notFound")
                    }));
                }
            }
            "/deny" => {
                if rest.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.approval.denyUsage")));
                } else {
                    let resolved = self
                        .harness
                        .resolve_approval(rest, false, Some("denied by user"))
                        .await?;
                    self.push_line(TranscriptLine::status(if resolved {
                        t("tui.approval.denied")
                    } else {
                        t("tui.approval.notFound")
                    }));
                }
            }
            "/status" => {
                let status = self.session.as_mut().expect("session").get_status().await;
                let version = self
                    .harness
                    .core_version()
                    .await
                    .unwrap_or_else(|_| "?".to_string());
                for line in build_status_report(&status["result"], &version, &self.session_id) {
                    self.push_line(TranscriptLine::status(line));
                }
                // TS status-panel parity: workdir / session title / model count.
                let work_dir = std::env::current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| "-".to_string());
                let title = self
                    .harness
                    .list_sessions(50)
                    .await
                    .ok()
                    .and_then(|sessions| {
                        sessions
                            .iter()
                            .find(|s| s["id"] == self.session_id)
                            .and_then(|s| {
                                s["title"]
                                    .as_str()
                                    .filter(|t| !t.is_empty())
                                    .map(str::to_string)
                            })
                    })
                    .unwrap_or_else(|| "-".to_string());
                self.push_line(TranscriptLine::status(t!(
                    "tui.status.reportWorkDir",
                    work_dir
                )));
                self.push_line(TranscriptLine::status(t!("tui.status.reportTitle", title)));
                self.push_line(TranscriptLine::status(t!(
                    "tui.status.reportModels",
                    self.model_aliases.len()
                )));
            }
            "/info" => match self.harness.core_version().await {
                Ok(v) => self.push_line(TranscriptLine::status(t!(
                    "tui.info.version",
                    v,
                    self.session_id
                ))),
                Err(e) => self
                    .view
                    .transcript
                    .push_line(TranscriptLine::error(t!("tui.err.infoFailed", e))),
            },
            "/plugins" => {
                let parts: Vec<&str> = rest.split_whitespace().collect();
                match parts.first().copied() {
                    None => {
                        // Interactive plugin browser (TS plugins panel
                        // parity, picker-based): pick a plugin, then an
                        // action; the action re-dispatches `/plugins
                        // <action> <id>` to reuse the command paths.
                        let plugins = self.harness.list_plugins().await?;
                        if plugins.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.plugins.none")));
                        } else {
                            let items: Vec<crate::picker::PickerItem> = plugins
                                .iter()
                                .filter_map(|p| {
                                    let id = p["id"].as_str()?.to_string();
                                    let enabled = p["enabled"].as_bool().unwrap_or(false);
                                    let state = if enabled {
                                        t("tui.status.on")
                                    } else {
                                        t("tui.status.off")
                                    };
                                    let version = p["version"].as_str().unwrap_or("");
                                    let mut item = crate::picker::PickerItem::new(
                                        id.clone(),
                                        format!("{id} [{state}]"),
                                    );
                                    if !version.is_empty() {
                                        item = item.with_description(version);
                                    }
                                    Some(item)
                                })
                                .collect();
                            let opts =
                                crate::picker::PickerOptions::new(t("tui.picker.selectPlugin"))
                                    .filterable()
                                    .paged(10);
                            match crate::picker::select_picker(
                                terminal,
                                self.view.theme,
                                &opts,
                                &items,
                            )? {
                                Some(plugin_id) => {
                                    let actions: Vec<crate::picker::PickerItem> = [
                                        ("enable", "enable"),
                                        ("disable", "disable"),
                                        ("reload", "reload"),
                                        ("remove", "remove"),
                                    ]
                                    .iter()
                                    .map(|(v, l)| crate::picker::PickerItem::new(*v, *l))
                                    .collect();
                                    let action_opts = crate::picker::PickerOptions::new(t!(
                                        "tui.picker.selectAction",
                                        plugin_id
                                    ));
                                    if let Some(action) = crate::picker::select_picker(
                                        terminal,
                                        self.view.theme,
                                        &action_opts,
                                        &actions,
                                    )? {
                                        if action == "remove"
                                            && !self
                                                .confirm(
                                                    terminal,
                                                    &t!("tui.plugins.confirmRemove", plugin_id),
                                                )
                                                .await?
                                        {
                                            return Ok(false);
                                        }
                                        return self
                                            .dispatch(
                                                terminal,
                                                &format!("/plugins {action} {plugin_id}"),
                                            )
                                            .await;
                                    }
                                }
                                None => self
                                    .push_line(TranscriptLine::status(t("tui.plugins.cancelled"))),
                            }
                        }
                    }
                    Some("list") => match self.harness.list_plugins().await {
                        Ok(plugins) => {
                            let lines = build_plugins_report(&plugins);
                            for line in lines {
                                self.push_line(TranscriptLine::status(line));
                            }
                        }
                        Err(e) => self
                            .view
                            .transcript
                            .push_line(TranscriptLine::error(t!("tui.err.pluginsFailed", e))),
                    },
                    Some(action) => {
                        let id = parts.get(1).copied().unwrap_or("");
                        let result = match action {
                            "enable" if !id.is_empty() => self
                                .harness
                                .set_plugin_enabled(id, true)
                                .await
                                .map(|_| t!("tui.plugins.enabled", id)),
                            "disable" if !id.is_empty() => self
                                .harness
                                .set_plugin_enabled(id, false)
                                .await
                                .map(|_| t!("tui.plugins.disabled", id)),
                            "remove" if !id.is_empty() => {
                                self.harness.remove_plugin(id).await.map(|removed| {
                                    if removed {
                                        t!("tui.plugins.removed", id)
                                    } else {
                                        t!("tui.plugins.notFound", id)
                                    }
                                })
                            }
                            "reload" => self
                                .harness
                                .reload_plugins()
                                .await
                                .map(|_| t("tui.plugins.reloaded").to_string()),
                            "install" if !id.is_empty() => {
                                let source = parts.get(1).copied().unwrap_or("").to_string();
                                self.harness
                                    .install_plugin(&source)
                                    .await
                                    .map(|_| t!("tui.plugins.installed", source))
                            }
                            _ => Err(anyhow::anyhow!(t("tui.plugins.usage"))),
                        };
                        match result {
                            Ok(msg) => self.push_line(TranscriptLine::status(msg)),
                            Err(e) => self
                                .view
                                .transcript
                                .push_line(TranscriptLine::error(t!("tui.err.pluginsFailed", e))),
                        }
                    }
                }
            }
            "/skills" => {
                let skills = self.session.as_mut().expect("session").list_skills().await;
                match skills {
                    Ok(skills) => {
                        let entries: Vec<(String, String)> = skills["skills"]
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .map(|s| {
                                        let name = s["name"].as_str().unwrap_or("?").to_string();
                                        let desc =
                                            s["description"].as_str().unwrap_or("").to_string();
                                        (name, desc)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        if entries.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.skills.none")));
                        } else {
                            let items: Vec<crate::picker::PickerItem> = entries
                                .into_iter()
                                .map(|(name, desc)| {
                                    let mut item =
                                        crate::picker::PickerItem::new(name.clone(), name);
                                    if !desc.is_empty() {
                                        item = item.with_description(desc);
                                    }
                                    item
                                })
                                .collect();
                            let opts =
                                crate::picker::PickerOptions::new(t("tui.picker.selectSkill"))
                                    .filterable()
                                    .paged(10);
                            match crate::picker::select_picker(
                                terminal,
                                self.view.theme,
                                &opts,
                                &items,
                            )? {
                                Some(name) => {
                                    let desc = items
                                        .iter()
                                        .find(|it| it.value == name)
                                        .and_then(|it| it.description.clone())
                                        .unwrap_or_default();
                                    self.push_line(TranscriptLine::status(t!(
                                        "tui.skills.selected",
                                        name,
                                        desc
                                    )));
                                }
                                None => self
                                    .view
                                    .transcript
                                    .push_line(TranscriptLine::status(t("tui.skills.cancelled"))),
                            }
                        }
                    }
                    Err(e) => self
                        .view
                        .transcript
                        .push_line(TranscriptLine::error(t!("tui.err.skillsFailed", e))),
                }
            }
            "/swarm" => {
                // TS parity: `/swarm [on|off|toggle]` toggles the mode; any other
                // argument is a one-shot task — enable swarm with the task as trigger
                // and run it through the normal prompt path.
                let rest = rest.trim();
                let (enabled, trigger): (bool, Option<&str>) = match rest {
                    "" | "on" => (true, None),
                    "off" => (false, None),
                    "toggle" | "t" => {
                        let current = self.session.as_mut().expect("session").get_status().await;
                        let active = current["result"]["swarm_mode"].as_bool().unwrap_or(false);
                        (!active, None)
                    }
                    task => (true, Some(task)),
                };
                self.session
                    .as_mut()
                    .expect("session")
                    .set_swarm_mode(enabled, trigger)
                    .await?;
                self.push_line(TranscriptLine::status(t!(
                    "tui.status.swarm",
                    t(if enabled {
                        "tui.status.on"
                    } else {
                        "tui.status.off"
                    })
                )));
                self.refresh_status().await;
                if let Some(task) = trigger {
                    // One-shot task: run the task text as a normal prompt (TS
                    // swarm-task parity). A manual permission gate asks before the
                    // first tool call.
                    self.run_turn(terminal, task).await?;
                }
            }
            "/mcp" => {
                match self
                    .session
                    .as_mut()
                    .expect("session")
                    .list_mcp_servers()
                    .await
                {
                    Ok(servers) => {
                        let list = servers["mcp_servers"]
                            .as_array()
                            .or_else(|| servers["result"]["mcp_servers"].as_array())
                            .or_else(|| servers["servers"].as_array())
                            .cloned()
                            .unwrap_or_default();
                        let names: Vec<&str> = list
                            .iter()
                            .filter_map(|s| {
                                s["name"].as_str().or_else(|| s["server_name"].as_str())
                            })
                            .collect();
                        if names.is_empty() {
                            self.view
                                .transcript
                                .push_line(TranscriptLine::status(t("tui.mcp.none")));
                        } else {
                            // Full report: reuse the parsed list for
                            // the structured rows.
                            let list: Vec<serde_json::Value> = servers["mcp_servers"]
                                .as_array()
                                .or_else(|| servers["result"]["mcp_servers"].as_array())
                                .or_else(|| servers["servers"].as_array())
                                .cloned()
                                .unwrap_or_default();
                            for line in build_mcp_report(&list) {
                                self.push_line(TranscriptLine::status(line));
                            }
                        }
                    }
                    Err(e) => self
                        .view
                        .transcript
                        .push_line(TranscriptLine::error(t!("tui.err.mcpFailed", e))),
                }
            }
            "/tasks" => {
                if !rest.is_empty() {
                    // `/tasks <id>` shows the task's output (TS
                    // task-output-viewer parity, simplified — a folded
                    // tool line, no full-screen viewer).
                    let body = self
                        .session
                        .as_mut()
                        .expect("session")
                        .get_background_task_output(rest)
                        .await;
                    let output = body["result"]["output"]
                        .as_str()
                        .or_else(|| body["output"].as_str())
                        .unwrap_or("");
                    if output.is_empty() {
                        self.push_line(TranscriptLine::status(t!("tui.tasks.noOutput", rest)));
                    } else {
                        self.view
                            .transcript
                            .push_line(TranscriptLine::tool_collapsed(output.to_string()));
                    }
                } else {
                    let tasks = self
                        .session
                        .as_mut()
                        .expect("session")
                        .list_background_tasks()
                        .await;
                    let list = tasks["tasks"]
                        .as_array()
                        .or_else(|| tasks["result"]["tasks"].as_array())
                        .cloned()
                        .unwrap_or_default();
                    if list.is_empty() {
                        self.push_line(TranscriptLine::status(t("tui.tasks.none")));
                    } else {
                        // Interactive task browser (TS tasks-browser
                        // parity, picker-based): pick a task to view
                        // its output (re-dispatches `/tasks <id>`).
                        let items: Vec<crate::picker::PickerItem> = list
                            .iter()
                            .filter_map(|t| {
                                let id = t["id"].as_str()?.to_string();
                                let label = t["label"].as_str().unwrap_or("").to_string();
                                let state = t["state"].as_str().unwrap_or("?");
                                let mut item = crate::picker::PickerItem::new(
                                    id.clone(),
                                    format!("{id}  [{state}]"),
                                );
                                if !label.is_empty() {
                                    item = item.with_description(label);
                                }
                                Some(item)
                            })
                            .collect();
                        let opts = crate::picker::PickerOptions::new(t!("tui.picker.selectTask"))
                            .filterable()
                            .paged(10);
                        match crate::picker::select_picker(
                            terminal,
                            self.view.theme,
                            &opts,
                            &items,
                        )? {
                            Some(id) => {
                                return self.dispatch(terminal, &format!("/tasks {id}")).await;
                            }
                            None => {
                                self.push_line(TranscriptLine::status(t("tui.tasks.cancelled")))
                            }
                        }
                    }
                }
            }
            "/version" => match self.harness.core_version().await {
                Ok(v) => self
                    .view
                    .transcript
                    .push_line(TranscriptLine::status(t!("tui.version.show", v))),
                Err(e) => self
                    .view
                    .transcript
                    .push_line(TranscriptLine::error(t!("tui.err.versionFailed", e))),
            },
            "/add-dir" => {
                let path = rest.trim();
                if path.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.addDir.usage")));
                } else {
                    // TS parity: confirm the attach (session-only) before applying.
                    if self
                        .confirm(terminal, &t!("tui.addDir.confirm", path))
                        .await?
                    {
                        match self
                            .session
                            .as_mut()
                            .expect("session")
                            .add_additional_dir(path)
                            .await
                        {
                            Ok(_) => {
                                self.push_line(TranscriptLine::status(t!("tui.addDir.added", path)))
                            }
                            Err(e) => {
                                self.push_line(TranscriptLine::error(t!("tui.err.addDirFailed", e)))
                            }
                        }
                    } else {
                        self.push_line(TranscriptLine::status(t("tui.addDir.cancelled")));
                    }
                }
            }
            "/compact" => {
                // TS parity: a bare `/compact` asks for confirmation first; an
                // explicit instruction compacts directly.
                if rest.trim().is_empty()
                    && !self.confirm(terminal, &t!("tui.compact.confirm")).await?
                {
                    return Ok(false);
                }
                let instruction = (!rest.trim().is_empty()).then_some(rest);
                let result = self
                    .session
                    .as_mut()
                    .expect("session")
                    .compact_with_instruction(instruction)
                    .await;
                match result {
                    Ok(_) => self.push_line(TranscriptLine::status(t("tui.compact.ok"))),
                    Err(e) => self.push_line(TranscriptLine::error(t!("tui.err.compactFailed", e))),
                }
            }
            "/usage" => {
                let usage = self.session.as_mut().expect("session").get_usage().await?;
                for line in build_usage_report(&usage["result"]) {
                    self.push_line(TranscriptLine::status(line));
                }
                // Context window readout (TS usage-panel parity).
                let status = self.session.as_mut().expect("session").get_status().await;
                let ctx = status["result"]["context_tokens"].as_u64().unwrap_or(0);
                let max = status["result"]["max_context_tokens"].as_u64().unwrap_or(0);
                if max > 0 {
                    let pct = ctx.checked_mul(100).map(|v| v / max).unwrap_or(0).min(100);
                    self.push_line(TranscriptLine::status(format!(
                        "{} {}",
                        crate::reports::ctx_bar(ctx, max),
                        t!("tui.usage.context", ctx, max, pct)
                    )));
                }
            }
            "/undo" => {
                // TS parity: `/undo [count]` — the count defaults to 1 and is
                // validated (0 / non-numeric are rejected instead of silently
                // undoing one step).
                let count: u32 = match rest.trim() {
                    "" => 1,
                    other => match other.parse::<u32>() {
                        Ok(n) if n > 0 => n,
                        _ => {
                            self.push_line(TranscriptLine::error(t!("tui.undo.badCount", other)));
                            return Ok(false);
                        }
                    },
                };
                let undone = self
                    .session
                    .as_mut()
                    .expect("session")
                    .undo_history(count)
                    .await?;
                self.push_line(TranscriptLine::status(t!(
                    "tui.undo.result",
                    serde_json::to_string(&undone).unwrap_or_default()
                )));
            }
            "/steer" => {
                if rest.is_empty() {
                    self.push_line(TranscriptLine::status(t("tui.steer.usage")));
                } else {
                    let queued = self
                        .session
                        .as_mut()
                        .expect("session")
                        .steer(serde_json::json!([{ "type": "text", "text": rest }]))
                        .await?;
                    self.push_line(TranscriptLine::status(t!("tui.steer.queued", queued)));
                }
            }
            "/discuss" => {
                // Multi-agent discussion (TS `handleDiscussCommand`
                // parity, simplified): enable swarm mode, then send the
                // constructed prompt as a normal turn so the model runs
                // the SwarmDiscussion tool.
                let args = match parse_discuss(rest) {
                    Ok(args) => args,
                    Err(code) => {
                        let msg = match code {
                            "need-topic" => t("tui.discuss.needTopic"),
                            "need-roles" => t("tui.discuss.needRoles"),
                            _ => t("tui.discuss.usage"),
                        };
                        self.push_line(TranscriptLine::error(msg));
                        return Ok(false);
                    }
                };
                if let Err(e) = self
                    .session
                    .as_mut()
                    .expect("session")
                    .set_swarm_mode(true, Some("task"))
                    .await
                {
                    self.push_line(TranscriptLine::error(t!("tui.err.discussSwarm", e)));
                    return Ok(false);
                }
                self.refresh_status().await;
                let mode = if args.debate { "debate" } else { "discussion" };
                let participants = if args.stances.is_empty() {
                    args.roles.join(", ")
                } else {
                    args.roles
                        .iter()
                        .map(|role| {
                            args.stances
                                .iter()
                                .find(|(name, _)| name == role)
                                .map(|(_, stance)| format!("{role} ({stance})"))
                                .unwrap_or_else(|| role.clone())
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let prompt = format!(
    "Start a {mode} on the following topic:\n\nTopic: {}\n\nParticipants: {}\n\nUse the SwarmDiscussion tool.",
    args.topic,
    participants
);
                return self.dispatch(terminal, &prompt).await;
            }
            "/workflow" => {
                // Workflow tool entry (TS `handleWorkflowCommand` parity):
                // list / run / status / cancel all become a prompt that
                // asks the model to drive the Workflow tool. A bare
                // `/workflow` shows the multi-line usage panel; every
                // model-driving subcommand checks that a model is set
                // first (TS `getLlmNotSetMessage`).
                let trimmed = rest.trim();
                if trimmed.is_empty() {
                    for line in [
                        t("tui.workflow.usage"),
                        t("tui.workflow.helpList"),
                        t("tui.workflow.helpRun"),
                        t("tui.workflow.helpStatus"),
                        t("tui.workflow.helpCancel"),
                        t("tui.workflow.helpExample"),
                    ] {
                        self.push_line(TranscriptLine::status(line.to_string()));
                    }
                    return Ok(false);
                }
                let prompt = if trimmed.eq_ignore_ascii_case("list") {
                    Some("List the available workflows using the Workflow tool.".to_string())
                } else if let Some(id) = trimmed.strip_prefix("status ") {
                    Some(format!(
                        "Check the status of workflow run {id} using the Workflow tool."
                    ))
                } else if let Some(id) = trimmed.strip_prefix("cancel ") {
                    Some(format!("Cancel workflow run {id} using the Workflow tool."))
                } else if trimmed.eq_ignore_ascii_case("status")
                    || trimmed.eq_ignore_ascii_case("cancel")
                {
                    None
                } else {
                    // `<name> [args...]` — run it.
                    Some(format!("Run the workflow \"{trimmed}\" using the Workflow tool."))
                };
                let Some(prompt) = prompt else {
                    self.push_line(TranscriptLine::status(t("tui.workflow.usage")));
                    return Ok(false);
                };
                if !self.ensure_model_set().await? {
                    return Ok(false);
                }
                return self.dispatch(terminal, &prompt).await;
            }
            _ => {}
        }
        Ok(false)
    }
}

/// Default `kimi web` origin (kimi-cli `Web.port` default 58627 on
/// loopback; the spawned child prints the real token-bearing URL itself).
const DEFAULT_WEB_ORIGIN: &str = "http://127.0.0.1:58627";

/// GitHub Issues page for feedback. Matches the TS constant
/// (`retired/kimi-code-src/constant/app.ts` `FEEDBACK_ISSUE_URL`).
const FEEDBACK_ISSUE_URL: &str = "https://github.com/MoonshotAI/kimi-code/issues";

/// Best-effort open a URL in the platform browser (Windows `start`, macOS
/// `open`, Linux `xdg-open`). Never fails the caller — the transcript hint
/// already prints the URL as the manual fallback.
fn open_url(url: &str) {
    let (program, args) = if cfg!(windows) {
        ("cmd", vec!["/c", "start", "", url])
    } else if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else {
        ("xdg-open", vec![url])
    };
    let _ = std::process::Command::new(program)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ());
}

/// Spawn the web UI as a detached child: re-exec the current binary with
/// the `web` subcommand. Detached stdio keeps the child's banner off the
/// TUI screen, and a process group of its own keeps the server alive after
/// the TUI exits (terminal Ctrl-C / window close do not reach it).
fn spawn_web_process() -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("web")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no console of its
        // own, so the TUI's console cannot Ctrl-C it.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A process group of its own: terminal Ctrl-C / SIGHUP sent to the
        // TUI's group do not reach the web server.
        cmd.process_group(0);
    }
    cmd.spawn()?;
    Ok(())
}
