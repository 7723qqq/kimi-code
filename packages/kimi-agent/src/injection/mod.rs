//! Turn-level context injection layer.
//!
//! Mirrors v2's AgentReminder mechanism
//! (`packages/agent-core-v2/src/features/reminder/`): before each LLM call
//! the turn loop asks registered providers for reminder texts and appends
//! them to the message history wrapped in `<system-reminder>…</system-reminder>`
//! (v2 `wrapSystemReminder`). Injection messages are identified by their
//! wrapper so the turn loop can keep them out of compaction trimming — the
//! Rust analog of v2's `origin.kind === 'injection'` classification.
//!
//! Built-in injections live here: the date-change reminder (v2 `dateChange`
//! variant) and the workspace-root AGENTS.md reminder (v2 `agents_md`
//! variant). The rest are contributed by their own modules — goal/plan mode
//! by [`goal_plan`], the permission-mode reminders by [`permission_mode`],
//! the post-interruption reminder by [`interruption_reminder`], and swarm
//! mode by [`swarm_mode`].

use std::path::{Path, PathBuf};

use crate::turn_loop::types::LLMMessage;

/// Wrapper prefix for injection texts, matching v2's `SYSTEM_REMINDER_PREFIX`.
pub const SYSTEM_REMINDER_PREFIX: &str = "<system-reminder>\n";
/// Wrapper suffix for injection texts, matching v2's `SYSTEM_REMINDER_SUFFIX`.
pub const SYSTEM_REMINDER_SUFFIX: &str = "\n</system-reminder>";

/// Goal/plan-mode injection providers.
pub mod goal_plan;

/// Permission-mode injection providers (v2 `PermissionModeInjection`).
pub mod permission_mode;

/// The interruption reminder (v2 `interruptionReminderService`): a one-shot
/// head-of-turn reminder after a user-cancelled turn.
pub mod interruption_reminder;

/// Swarm-mode reminders (v2 `SwarmInjection`, the `swarm_mode` variant).
pub mod swarm_mode;

/// What the injection providers read their domain values from.
pub mod state;

pub use state::DomainValueSource;

/// Wrap an injection text in the `<system-reminder>` envelope. The content
/// is trimmed and placed between the prefix and suffix, exactly like v2's
/// `wrapSystemReminder`.
pub fn wrap_system_reminder(content: &str) -> String {
    format!(
        "{SYSTEM_REMINDER_PREFIX}{}{SYSTEM_REMINDER_SUFFIX}",
        content.trim()
    )
}

/// Whether a message content is a system-reminder injection (v2
/// `systemReminderContent` detection).
pub fn is_system_reminder(text: &str) -> bool {
    text.starts_with(SYSTEM_REMINDER_PREFIX) && text.ends_with(SYSTEM_REMINDER_SUFFIX)
}

/// Build a `user`-role message carrying an injection text. v2 appends
/// injections with role `user` and `origin.kind === 'injection'`; the Rust
/// engine marks them by their `<system-reminder>` content instead.
pub fn injection_message(text: String) -> LLMMessage {
    LLMMessage {
        role: "user".into(),
        content: text,
        ..Default::default()
    }
}

/// Remove injection messages from `messages` in place and return them,
/// preserving order. The turn loop uses this to keep injections out of
/// compaction trimming: they are pulled out before compacting and
/// re-appended after.
pub fn split_injections(messages: &mut Vec<LLMMessage>) -> Vec<LLMMessage> {
    let mut injections = Vec::new();
    let mut kept = Vec::with_capacity(messages.len());
    for message in messages.drain(..) {
        if is_system_reminder(&message.content) {
            injections.push(message);
        } else {
            kept.push(message);
        }
    }
    *messages = kept;
    injections
}

/// Context passed to injection providers for one build pass. Mirrors v2's
/// `ContextInjectionContext` (`isNewTurn` + the `injectedPositions` part):
/// whether this is the first step of the turn, and the names of injections
/// already appended this turn, in registration order.
/// What the previous step's tool calls did, handed to per-access providers.
///
/// v2 assembles the same three things from a `ToolDidExecuteContext`: the file
/// accesses become target directories (`:284-306`), an instruction file the
/// call read becomes `selfKnown` (`:297-302`), and a Bash call's own `cwd`
/// argument is contributed whether or not any operand resolves
/// (`:255-262, 274-276`).
#[derive(Debug, Clone, Default)]
pub struct StepAccess {
    /// Directories the calls touched: a file tool's parent, a tree search's
    /// own root.
    pub dirs: Vec<PathBuf>,
    /// Instruction files the calls read themselves.
    pub self_read: Vec<PathBuf>,
    /// Working directories Bash calls declared through their `cwd` argument.
    pub declared_cwds: Vec<String>,
}

impl StepAccess {
    /// True when nothing was recorded, so a provider can skip its probe.
    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty() && self.self_read.is_empty() && self.declared_cwds.is_empty()
    }
}

pub struct InjectionContext<'a> {
    /// Whether this build pass runs at the first step of the turn (v2
    /// `isNewTurn`): turn-gated providers (goal) inject only on it.
    pub is_new_turn: bool,
    /// Names of injections already appended this turn, in registration order.
    pub injected: &'a [String],
    /// What the previous step's tool calls did. Empty when the caller does not
    /// track accesses, in which case per-access providers see no new ground.
    pub access: &'a StepAccess,
}

/// A named injection provider: returns the raw reminder text for the current
/// step, or `None` when nothing should be injected. Providers may keep
/// per-turn state in their closure (e.g. the date-change tracker).
pub type InjectionProvider = Box<dyn FnMut(&InjectionContext) -> Option<String> + Send>;

struct InjectionEntry {
    name: String,
    provider: InjectionProvider,
}

/// Registry of injection providers, mirroring v2's
/// `AgentReminder.register(variant, provider)`.
pub struct InjectionRegistry {
    entries: Vec<InjectionEntry>,
    /// Names of injections already appended this turn, in registration order.
    injected: Vec<String>,
}

impl InjectionRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            injected: Vec::new(),
        }
    }

    /// Register a provider under a variant name (v2 `register(variant,
    /// provider)`). Providers run in registration order.
    pub fn register(&mut self, name: &str, provider: InjectionProvider) {
        self.entries.push(InjectionEntry {
            name: name.to_string(),
            provider,
        });
    }

    /// Create a registry with the built-in injections: the date-change
    /// reminder and the workspace-root AGENTS.md reminder. The workspace
    /// root defaults to the process working directory. `date_baseline` seeds
    /// the date-change tracker with a previously disclosed date (scanned
    /// from history) so the baseline is not re-injected every turn;
    /// `agents_md_baseline` does the same for the AGENTS.md paths an earlier
    /// reminder already named.
    pub fn with_defaults(date_baseline: Option<String>, agents_md_baseline: Vec<String>) -> Self {
        let mut registry = Self::new();
        registry.register("date_change", Box::new(date_change_provider(date_baseline)));
        registry.register(
            "agents_md",
            Box::new(agents_md_provider(
                std::env::current_dir().ok(),
                agents_md_baseline,
            )),
        );
        registry
    }

    /// Names of registered providers, in registration order.
    pub fn names(&self) -> Vec<&str> {
        self.entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    /// Run every provider and return the wrapped injection texts for this
    /// step, in registration order. `is_new_turn` gates turn-scoped providers
    /// (v2 `isNewTurn`): they inject only at the turn's first step.
    /// Providers that return `None` or blank text contribute nothing;
    /// successful injections are recorded in the context handed to later
    /// providers.
    pub fn build_injections(&mut self, is_new_turn: bool) -> Vec<String> {
        self.build_injections_with_accesses(is_new_turn, &StepAccess::default())
    }

    /// Run every provider with what the previous step's tool calls did, so
    /// per-access providers (the AGENTS.md reminder) can discover instruction
    /// files in the subtrees those calls touched.
    pub fn build_injections_with_accesses(
        &mut self,
        is_new_turn: bool,
        access: &StepAccess,
    ) -> Vec<String> {
        let mut texts = Vec::new();
        for entry in &mut self.entries {
            let ctx = InjectionContext {
                is_new_turn,
                injected: &self.injected,
                access,
            };
            if let Some(content) = (entry.provider)(&ctx)
                && !content.trim().is_empty()
            {
                self.injected.push(entry.name.clone());
                texts.push(wrap_system_reminder(&content));
            }
        }
        texts
    }
}

impl Default for InjectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Built-in injections ─────────────────────────────────────────────────────

/// State machine for the date-change reminder (v2 `dateChange` variant):
/// records the last disclosed date and produces the baseline/change texts.
/// Pure — the caller supplies the current date, so tests can drive day
/// boundaries deterministically.
pub struct DateChangeTracker {
    last_date: Option<String>,
}

impl DateChangeTracker {
    /// Create a tracker with no disclosed date yet.
    pub fn new() -> Self {
        Self { last_date: None }
    }

    /// Create a tracker seeded with a previously disclosed date (v2's
    /// history-scanned `lastDisclosure`): the baseline survives across turns,
    /// so a matching seed suppresses the baseline re-injection until the date
    /// actually changes.
    pub fn with_last_date(last_date: Option<String>) -> Self {
        Self { last_date }
    }

    /// Feed the current date; returns the reminder text to inject for this
    /// step, or `None` when the date is unchanged since the last disclosure.
    /// The first call injects the baseline date (v2's seed disclosure);
    /// later calls inject only when the date changed.
    pub fn step(&mut self, today: &str) -> Option<String> {
        match &self.last_date {
            None => {
                self.last_date = Some(today.to_string());
                Some(format!(
                    "Today's date is {today}. The current date is restated in a reminder \
                     whenever it changes; rely on the latest such reminder for the current \
                     date. DO NOT mention this to the user explicitly."
                ))
            }
            Some(previous) if previous != today => {
                self.last_date = Some(today.to_string());
                Some(format!(
                    "The date has changed. Today's date is now {today}. Rely on this \
                     reminder over any earlier date statement for the current date. DO NOT \
                     mention this to the user explicitly."
                ))
            }
            Some(_) => None,
        }
    }
}

impl Default for DateChangeTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Provider for the date-change reminder: injects the current date on the
/// first pass of a turn unless a prior disclosure was already scanned from
/// history, and re-injects whenever the date changes mid-turn.
fn date_change_provider(
    baseline: Option<String>,
) -> impl FnMut(&InjectionContext) -> Option<String> {
    let mut tracker = DateChangeTracker::with_last_date(baseline);
    move |_ctx: &InjectionContext| tracker.step(&today_local())
}

/// Current local date as `YYYY-MM-DD` (v2 discloses the host-clock local
/// date via `Intl.DateTimeFormat`; chrono's `Local` resolves the system
/// timezone).
fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Scan prior conversation messages for the last date-disclosure reminder and
/// extract the disclosed date (v2's history-scanned `lastDisclosure`): the
/// baseline survives across turns, so the date is only re-injected when it
/// actually changes instead of at the first step of every turn.
pub fn scan_date_baseline(messages: &[LLMMessage]) -> Option<String> {
    const MARKER: &str = "Today's date is";
    for message in messages.iter().rev() {
        let content = message.content.as_str();
        let Some(at) = content.rfind(MARKER) else {
            continue;
        };
        // The change text reads "Today's date is now <date>"; the baseline
        // reads "Today's date is <date>". Skip the optional " now ".
        let mut after = &content[at + MARKER.len()..];
        after = after.strip_prefix(" now ").unwrap_or(after);
        after = after.strip_prefix(' ').unwrap_or(after);
        let date: String = after
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        if date.len() == 10 {
            return Some(date);
        }
    }
    None
}

/// Find an AGENTS.md instruction file directly under `root` (v2
/// `AGENTS_MD_PLAIN_NAMES`: `AGENTS.md` / `agents.md`).
pub fn find_agents_md(root: &Path) -> Option<PathBuf> {
    for name in ["AGENTS.md", "agents.md"] {
        let candidate = root.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Provider for the AGENTS.md reminder (v2 `agents_md` variant), backed by
/// [`AgentsMdReminder`].
///
/// `root` is the workspace root, the top of every probed chain; `None` when
/// the process working directory is unavailable. `disclosed` carries the paths
/// an earlier reminder already named, scanned out of history because the fork's
/// messages carry no `origin.disclosure` (v2 keeps the set on the last
/// injection) — the same substitution [`scan_agents_md_baseline`] makes for the
/// other variants.
fn agents_md_provider(
    root: Option<PathBuf>,
    disclosed: Vec<String>,
) -> impl FnMut(&InjectionContext) -> Option<String> {
    let mut reminder = AgentsMdReminder::new(root, disclosed);
    move |ctx: &InjectionContext| {
        reminder.observe(ctx.access);
        let fresh = reminder.take_pending();
        if fresh.is_empty() {
            return None;
        }
        Some(agents_md_reminder_text(&fresh))
    }
}

/// The reminder body v2 renders for a non-empty set of discovered paths
/// (`agentsMdReminderService.ts:353-359`), verbatim.
fn agents_md_reminder_text(paths: &[String]) -> String {
    let listed = paths
        .iter()
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "The following AGENTS.md file(s) apply to paths accessed by your recent tool call, \
         but were not included in your system prompt:\n{listed}\n\
         Read them before making changes in those directories."
    )
}

/// The instruction-file basenames, as an [`AgentsMdReminder`] lookup set.
fn is_agents_md_name(name: &str) -> bool {
    name == "AGENTS.md" || name == "agents.md"
}

/// State machine for the AGENTS.md reminder (v2 `AgentsMdReminderService`).
///
/// v2 hooks `onDidExecuteTool`, walks from the project root down to every
/// directory the call touched, and queues any AGENTS.md it has not already
/// disclosed. The fork's provider runs at the same observation point — before
/// each LLM call, which is after the previous step's tool calls — so the only
/// input v2 gets for free and this does not is *which* directories were
/// touched; that arrives as [`InjectionContext::accessed_dirs`].
///
/// v2 resolves the chain against `findProjectRoot`. This walks from the
/// workspace root instead: that is the boundary the rest of the fork already
/// enforces, and it avoids introducing a second notion of "project" that could
/// disagree with the sandbox.
pub struct AgentsMdReminder {
    /// AGENTS.md paths already in the instructions or already suggested.
    known: std::collections::HashSet<String>,
    /// Discovered by a probe but not yet suggested.
    queue: Vec<String>,
    /// Paths the model itself just read, so naming them back is noise (v2
    /// `selfKnown`, which suppresses the reminder for the rest of the step).
    read_recently: std::collections::HashSet<String>,
    /// Workspace root, the top of every probed chain.
    root: Option<PathBuf>,
}

impl AgentsMdReminder {
    /// Seed a reminder. `disclosed` are the paths history already named; they
    /// start out known so a resumed session does not re-suggest them.
    pub fn new(root: Option<PathBuf>, disclosed: Vec<String>) -> Self {
        Self {
            known: disclosed.into_iter().collect(),
            queue: Vec::new(),
            read_recently: std::collections::HashSet::new(),
            root,
        }
    }

    /// Record one step's tool activity and probe what it reached.
    pub fn observe(&mut self, access: &StepAccess) {
        for path in &access.self_read {
            self.read_recently.insert(normalize_agents_md(path));
        }
        for dir in &access.dirs {
            self.probe_chain(dir);
        }
        self.observe_declared_cwds(&access.declared_cwds);
    }

    /// A Bash call's own `cwd` argument, which v2 contributes whether or not
    /// any operand resolves (`agentsMdReminderService.ts:255-262, 274-276`).
    ///
    /// v2's *other* half — the operand directories from `extractBashTargetDirs`
    /// — needs a bash syntax tree, and this engine has no parser: see
    /// `native/permission_engine/dangerous_command.rs`, which takes the same
    /// absence as an accepted, conservative degradation. Missing a `cwd` here
    /// costs the reminder one directory, which is the safe direction to be
    /// wrong in; guessing a wrong one would point the model at a file it has no
    /// reason to read.
    fn observe_declared_cwds(&mut self, cwds: &[String]) {
        let Some(root) = self.root.clone() else {
            return;
        };
        for cwd in cwds {
            if cwd.is_empty() {
                continue;
            }
            let candidate = Path::new(cwd);
            let resolved = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                root.join(candidate)
            };
            self.probe_chain(&resolved);
        }
    }

    /// Walk from the workspace root down to `dir`, queueing every AGENTS.md
    /// found on the way. A directory outside the root has no chain here, so it
    /// contributes nothing — the same outcome v2 gets when `findProjectRoot`
    /// does not contain the anchor.
    fn probe_chain(&mut self, dir: &Path) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let Ok(relative) = dir.strip_prefix(&root) else {
            return;
        };
        let mut current = root.clone();
        self.queue_here(&current);
        for component in relative.components() {
            current = current.join(component);
            self.queue_here(&current);
        }
    }

    fn queue_here(&mut self, dir: &Path) {
        let Some(found) = find_agents_md(dir) else {
            return;
        };
        let key = normalize_agents_md(&found);
        if !self.known.contains(&key) && !self.queue.contains(&key) {
            self.queue.push(key);
        }
    }

    /// Drain the queue into the paths worth suggesting now: anything not
    /// already known and not one the model just read. The returned paths become
    /// known, so each is suggested at most once.
    pub fn take_pending(&mut self) -> Vec<String> {
        let queued = std::mem::take(&mut self.queue);
        let fresh: Vec<String> = queued
            .into_iter()
            .filter(|path| !self.known.contains(path) && !self.read_recently.contains(path))
            .collect();
        for path in &fresh {
            self.known.insert(path.clone());
        }
        // v2 clears `readRecently` per injection pass (`:153-154`).
        self.read_recently.clear();
        fresh
    }

    /// Paths already in the instructions or already suggested. Exposed for
    /// tests and for the ledger; not part of the injection contract.
    pub fn known_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.known.iter().cloned().collect();
        paths.sort();
        paths
    }
}

/// A comparable form of an AGENTS.md path: forward slashes, no trailing
/// separator. v2 normalizes the same way before putting a path in its `known`
/// set (`normalize` in `agentsMdReminderService.ts`), so a path discovered by a
/// probe and the same path named in history compare equal.
fn normalize_agents_md(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    text.trim_end_matches('/').to_string()
}

/// Whether a tool that read `path` read an instruction file, i.e. whether it
/// belongs in the reminder's `selfKnown` set.
pub fn is_agents_md_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_agents_md_name)
}

/// The AGENTS.md paths an earlier reminder already disclosed. v2 keeps the set
/// on the injection message's `origin.disclosure`; the fork's messages carry
/// no origin, so the reminder text is scanned instead — the same shape as
/// [`scan_date_baseline`].
pub fn scan_agents_md_baseline(messages: &[LLMMessage]) -> Vec<String> {
    const MARKER: &str =
        "The following AGENTS.md file(s) apply to paths accessed by your recent tool call";
    let mut disclosed: Vec<String> = Vec::new();
    for message in messages {
        let content = message.content.as_str();
        if !content.contains(MARKER) {
            continue;
        }
        for line in content.lines() {
            let Some(path) = line.strip_prefix("- ") else {
                continue;
            };
            let path = path.trim();
            if !path.is_empty() && !disclosed.iter().any(|seen| seen == path) {
                disclosed.push(path.to_string());
            }
        }
    }
    disclosed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wrap_system_reminder_format() {
        // Basic whitespace trimming
        let wrapped = wrap_system_reminder("  hello world  ");
        assert_eq!(
            wrapped,
            "<system-reminder>\nhello world\n</system-reminder>"
        );

        // Multiline content preservation
        let multiline = wrap_system_reminder(" \n line 1 \n  line 2\n ");
        assert_eq!(
            multiline,
            "<system-reminder>\nline 1 \n  line 2\n</system-reminder>"
        );

        // Empty and whitespace-only strings
        assert_eq!(
            wrap_system_reminder(""),
            "<system-reminder>\n\n</system-reminder>"
        );
        assert_eq!(
            wrap_system_reminder("   \t\r\n   "),
            "<system-reminder>\n\n</system-reminder>"
        );

        // Structural invariant with prefix and suffix
        assert!(wrapped.starts_with(SYSTEM_REMINDER_PREFIX));
        assert!(wrapped.ends_with(SYSTEM_REMINDER_SUFFIX));
    }

    #[test]
    fn test_is_system_reminder_detection() {
        // Valid reminders
        assert!(is_system_reminder(
            "<system-reminder>\nhello\n</system-reminder>"
        ));
        assert!(is_system_reminder(
            "<system-reminder>\nline1\nline2\n</system-reminder>"
        ));
        assert!(is_system_reminder(
            "<system-reminder>\n\n</system-reminder>"
        ));

        // Invalid: missing tags or malformed delimiters
        assert!(!is_system_reminder("hello"));
        assert!(!is_system_reminder(""));
        assert!(!is_system_reminder("<system-reminder>\nhello"));
        assert!(!is_system_reminder("hello\n</system-reminder>"));
        assert!(!is_system_reminder(
            "<system-reminder>hello\n</system-reminder>"
        ));
        assert!(!is_system_reminder(
            "<system-reminder>\nhello</system-reminder>"
        ));
        assert!(!is_system_reminder(
            " <system-reminder>\nhello\n</system-reminder>"
        ));
        assert!(!is_system_reminder(
            "<system-reminder>\nhello\n</system-reminder> "
        ));
    }

    #[test]
    fn test_injection_message_shape() {
        let content = wrap_system_reminder("system instruction payload");
        let message = injection_message(content.clone());
        assert_eq!(message.role, "user");
        assert_eq!(message.content, content);
        assert!(is_system_reminder(&message.content));
        assert!(message.blocks.is_empty());
        assert!(message.tool_calls.is_empty());
        assert!(message.tool_call_id.is_none());
    }

    #[test]
    fn test_split_injections_separates_and_preserves_order() {
        let mut messages = vec![
            LLMMessage {
                role: "user".into(),
                content: "plain user message".into(),
                ..Default::default()
            },
            LLMMessage {
                role: "user".into(),
                content: wrap_system_reminder("reminder 1"),
                ..Default::default()
            },
            LLMMessage {
                role: "user".into(),
                content: wrap_system_reminder("reminder 2"),
                ..Default::default()
            },
            LLMMessage {
                role: "assistant".into(),
                content: "assistant reply".into(),
                ..Default::default()
            },
            LLMMessage {
                role: "user".into(),
                content: wrap_system_reminder("reminder 3"),
                ..Default::default()
            },
        ];

        let injections = split_injections(&mut messages);

        // Injections separated with exact count and content in original order
        assert_eq!(injections.len(), 3);
        assert_eq!(injections[0].role, "user");
        assert_eq!(injections[0].content, wrap_system_reminder("reminder 1"));
        assert_eq!(injections[1].role, "user");
        assert_eq!(injections[1].content, wrap_system_reminder("reminder 2"));
        assert_eq!(injections[2].role, "user");
        assert_eq!(injections[2].content, wrap_system_reminder("reminder 3"));

        // Remaining non-injection messages preserved exactly in order
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "plain user message");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "assistant reply");

        // Edge case: all injections
        let mut all_inj = vec![
            LLMMessage {
                role: "user".into(),
                content: wrap_system_reminder("a"),
                ..Default::default()
            },
            LLMMessage {
                role: "user".into(),
                content: wrap_system_reminder("b"),
                ..Default::default()
            },
        ];
        let split_all = split_injections(&mut all_inj);
        assert!(all_inj.is_empty());
        assert_eq!(split_all.len(), 2);
        assert_eq!(split_all[0].content, wrap_system_reminder("a"));
        assert_eq!(split_all[1].content, wrap_system_reminder("b"));

        // Edge case: no injections
        let mut no_inj = vec![LLMMessage {
            role: "user".into(),
            content: "regular".into(),
            ..Default::default()
        }];
        let split_none = split_injections(&mut no_inj);
        assert!(split_none.is_empty());
        assert_eq!(no_inj.len(), 1);
        assert_eq!(no_inj[0].content, "regular");

        // Edge case: empty input
        let mut empty: Vec<LLMMessage> = Vec::new();
        let split_empty = split_injections(&mut empty);
        assert!(split_empty.is_empty());
        assert!(empty.is_empty());
    }

    #[test]
    fn test_registry_register_and_build() {
        let mut registry = InjectionRegistry::new();
        registry.register("a", Box::new(|_| Some("first".into())));
        registry.register("b", Box::new(|_| None));
        registry.register("c", Box::new(|_| Some("   ".into())));
        registry.register("d", Box::new(|_| Some("fourth\nline2".into())));

        assert_eq!(registry.names(), vec!["a", "b", "c", "d"]);

        let texts = registry.build_injections(true);
        assert_eq!(
            texts.len(),
            2,
            "None and whitespace-only providers contribute nothing"
        );
        assert_eq!(texts[0], wrap_system_reminder("first"));
        assert_eq!(texts[1], wrap_system_reminder("fourth\nline2"));
    }

    #[test]
    fn test_registry_context_exposes_injected_names() {
        let mut registry = InjectionRegistry::new();
        registry.register(
            "first",
            Box::new(|ctx| {
                assert!(
                    ctx.injected.is_empty(),
                    "first provider sees empty injected slice"
                );
                Some("one".into())
            }),
        );
        registry.register(
            "skipped",
            Box::new(|ctx| {
                assert_eq!(ctx.injected, &["first"]);
                None
            }),
        );
        registry.register(
            "blank",
            Box::new(|ctx| {
                assert_eq!(ctx.injected, &["first"]);
                Some("   ".into())
            }),
        );
        registry.register(
            "second",
            Box::new(|ctx| {
                assert_eq!(ctx.injected, &["first"]);
                Some("two".into())
            }),
        );
        registry.register(
            "third",
            Box::new(|ctx| {
                assert_eq!(ctx.injected, &["first", "second"]);
                Some("three".into())
            }),
        );
        let texts = registry.build_injections(true);
        assert_eq!(texts.len(), 3);
        assert_eq!(texts[0], wrap_system_reminder("one"));
        assert_eq!(texts[1], wrap_system_reminder("two"));
        assert_eq!(texts[2], wrap_system_reminder("three"));
    }

    #[test]
    fn test_with_defaults_registers_builtins_and_builds() {
        let mut registry = InjectionRegistry::with_defaults(None, Vec::new());
        assert_eq!(registry.names(), vec!["date_change", "agents_md"]);

        let texts = registry.build_injections(true);
        assert!(
            !texts.is_empty(),
            "with_defaults must produce at least the date_change reminder"
        );
        assert!(is_system_reminder(&texts[0]));
        assert!(texts[0].starts_with("<system-reminder>\nToday's date is "));

        let empty_reg = InjectionRegistry::default();
        assert!(empty_reg.names().is_empty());
    }

    #[test]
    fn test_date_change_tracker_baseline() {
        let mut tracker = DateChangeTracker::new();
        let text = tracker
            .step("2026-09-02")
            .expect("first pass injects the baseline");
        assert_eq!(
            text,
            "Today's date is 2026-09-02. The current date is restated in a reminder whenever it \
             changes; rely on the latest such reminder for the current date. DO NOT mention this \
             to the user explicitly."
        );
    }

    #[test]
    fn test_date_change_tracker_unchanged_is_silent() {
        let mut tracker = DateChangeTracker::default();
        let first = tracker.step("2026-09-02");
        assert!(first.is_some());
        assert_eq!(
            tracker.step("2026-09-02"),
            None,
            "same date must not re-inject"
        );
        assert_eq!(
            tracker.step("2026-09-02"),
            None,
            "repeated calls with same date must remain silent"
        );
    }

    #[test]
    fn test_date_change_tracker_crosses_day() {
        let mut tracker = DateChangeTracker::new();
        tracker.step("2026-09-02");

        let text = tracker.step("2026-09-03").expect("day change injects");
        assert_eq!(
            text,
            "The date has changed. Today's date is now 2026-09-03. Rely on this reminder over \
             any earlier date statement for the current date. DO NOT mention this to the user \
             explicitly."
        );

        assert_eq!(
            tracker.step("2026-09-03"),
            None,
            "no repeat after the change"
        );

        let text2 = tracker.step("2026-09-04").expect("next day change injects");
        assert_eq!(
            text2,
            "The date has changed. Today's date is now 2026-09-04. Rely on this reminder over \
             any earlier date statement for the current date. DO NOT mention this to the user \
             explicitly."
        );
    }

    #[test]
    fn test_today_local_formats() {
        let today = today_local();
        let parts: Vec<&str> = today.split('-').collect();
        assert_eq!(parts.len(), 3, "today_local must format as YYYY-MM-DD");
        let year: i64 = parts[0].parse().expect("valid year");
        let month: u32 = parts[1].parse().expect("valid month");
        let day: u32 = parts[2].parse().expect("valid day");

        assert!(year >= 2024, "year must be realistic modern date");
        assert!((1..=12).contains(&month), "month must be in 1..=12");
        assert!((1..=31).contains(&day), "day must be in 1..=31");
    }

    #[test]
    fn test_scan_date_baseline_finds_last_disclosure() {
        let baseline = "Today's date is 2026-09-08. The current date is restated in a \
                        reminder whenever it changes; rely on the latest such reminder \
                        for the current date. DO NOT mention this to the user explicitly.";
        let change = "The date has changed. Today's date is now 2026-09-09. Rely on this \
                      reminder over any earlier date statement for the current date. DO \
                      NOT mention this to the user explicitly.";
        let msg = |text: &str| LLMMessage {
            role: "user".into(),
            content: text.to_string(),
            ..Default::default()
        };
        assert_eq!(scan_date_baseline(&[]), None);
        assert_eq!(
            scan_date_baseline(&[msg(baseline)]),
            Some("2026-09-08".into())
        );
        // The latest disclosure wins, regardless of kind.
        assert_eq!(
            scan_date_baseline(&[msg(baseline), msg("unrelated"), msg(change)]),
            Some("2026-09-09".into())
        );
        // Non-date text with a coincidental prefix must not parse.
        assert_eq!(
            scan_date_baseline(&[msg("Today's date is somewhere")]),
            None
        );
    }

    #[test]
    fn test_find_agents_md_cases() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(find_agents_md(dir.path()), None);

        let uppercase = dir.path().join("AGENTS.md");
        std::fs::write(&uppercase, "# Instructions").unwrap();
        let found = find_agents_md(dir.path()).expect("AGENTS.md found");
        assert_eq!(found, uppercase);
        assert_eq!(found.file_name().unwrap(), "AGENTS.md");

        let dir2 = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir2.path().join("AGENTS.md")).unwrap();
        assert_eq!(
            find_agents_md(dir2.path()),
            None,
            "directory named AGENTS.md must not match"
        );

        let dir3 = tempfile::tempdir().unwrap();
        let lowercase = dir3.path().join("agents.md");
        std::fs::write(&lowercase, "# Instructions").unwrap();
        let found_lower = find_agents_md(dir3.path()).expect("agents.md found");
        assert!(found_lower.is_file());
        assert_eq!(
            std::fs::read_to_string(&found_lower).unwrap(),
            "# Instructions"
        );
        assert_eq!(found_lower.parent().unwrap(), dir3.path());
        assert!(
            found_lower
                .file_name()
                .unwrap()
                .to_string_lossy()
                .eq_ignore_ascii_case("agents.md")
        );
        #[cfg(not(windows))]
        assert_eq!(found_lower, lowercase);

        let dir4 = tempfile::tempdir().unwrap();
        let path_upper = dir4.path().join("AGENTS.md");
        std::fs::write(&path_upper, "# Upper").unwrap();
        let found_prec = find_agents_md(dir4.path()).expect("found");
        assert_eq!(found_prec.file_name().unwrap(), "AGENTS.md");
    }

    /// A non-turn build pass carrying one step's tool activity — what
    /// `run_turn.rs` hands the injection pass after the step's calls ran.
    fn step(access: &StepAccess) -> InjectionContext<'_> {
        InjectionContext {
            is_new_turn: false,
            injected: &[],
            access,
        }
    }

    /// The reminder walks the chain from the workspace root down to each
    /// directory the previous step touched, so a nested `sub/AGENTS.md` is found
    /// when a tool reads `sub/deep/file.txt` — the reason v2 probes a chain
    /// rather than a single directory. Each file is suggested at most once, and
    /// one the model just read itself is not suggested back.
    #[test]
    fn test_agents_md_provider_walks_the_chain_and_suggests_once() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("sub").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        let nested_agents = nested.join("AGENTS.md");
        std::fs::write(&nested_agents, "# Nested").unwrap();

        let mut provider = agents_md_provider(Some(root.path().to_path_buf()), Vec::new());
        // A tool read `sub/deep/file.txt`; the reminder sees its parent.
        let access = StepAccess {
            dirs: vec![nested],
            ..Default::default()
        };
        let ctx = step(&access);

        let text = provider(&ctx).expect("the nested file is discovered");
        // v2 normalizes the paths it puts in the reminder, so the listed form is
        // forward-slashed even where the platform path is not.
        let expected = format!(
            "The following AGENTS.md file(s) apply to paths accessed by your recent tool \
             call, but were not included in your system prompt:\n- {}\n\
             Read them before making changes in those directories.",
            normalize_agents_md(&nested_agents)
        );
        assert_eq!(text, expected);
        assert_eq!(provider(&ctx), None, "at most once per agent");
    }

    /// The workspace root's own AGENTS.md is the head of every chain, so a tool
    /// touching any directory surfaces it — the case the previous
    /// workspace-root-only provider covered.
    #[test]
    fn test_agents_md_provider_still_finds_the_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("pkg");
        std::fs::create_dir_all(&sub).unwrap();
        let agents_path = dir.path().join("AGENTS.md");
        std::fs::write(&agents_path, "# Instructions").unwrap();

        let mut provider = agents_md_provider(Some(dir.path().to_path_buf()), Vec::new());
        let access = StepAccess {
            dirs: vec![sub],
            ..Default::default()
        };
        let ctx = step(&access);

        let text = provider(&ctx).expect("the root file heads every chain");
        assert!(
            text.contains(&normalize_agents_md(&agents_path)),
            "content: {text}"
        );
    }

    /// v2 `selfKnown`: a model that just read an AGENTS.md is not told to go
    /// read it again.
    #[test]
    fn a_file_the_model_just_read_is_not_suggested_back() {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let agents_path = sub.join("AGENTS.md");
        std::fs::write(&agents_path, "# Sub").unwrap();

        let mut provider = agents_md_provider(Some(root.path().to_path_buf()), Vec::new());
        let access = StepAccess {
            dirs: vec![sub.clone()],
            self_read: vec![agents_path],
            ..Default::default()
        };
        let ctx = step(&access);
        assert_eq!(provider(&ctx), None, "it already has the contents");

        // The suppression lasts one pass only (v2 clears `readRecently`).
        let later_access = StepAccess {
            dirs: vec![sub],
            ..Default::default()
        };
        let later = step(&later_access);
        assert!(
            provider(&later).is_some(),
            "a later tool call in the same subtree does remind"
        );
    }

    /// No workspace root, or a directory outside it, has no chain to walk.
    #[test]
    fn agents_md_provider_without_a_chain_injects_nothing() {
        let nothing = StepAccess::default();
        let empty = step(&nothing);
        let mut no_root = agents_md_provider(None, Vec::new());
        assert_eq!(no_root(&empty), None);

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "# Instructions").unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut provider = agents_md_provider(Some(dir.path().to_path_buf()), Vec::new());
        let outside_access = StepAccess {
            dirs: vec![outside.path().to_path_buf()],
            ..Default::default()
        };
        assert_eq!(
            provider(&step(&outside_access)),
            None,
            "outside the workspace root"
        );

        let bare = tempfile::tempdir().unwrap();
        let mut missing = agents_md_provider(Some(bare.path().to_path_buf()), Vec::new());
        assert_eq!(missing(&empty), None, "no AGENTS.md anywhere on the chain");
    }

    /// v2 `agentsMdReminderService.ts:255-262, 274-276`: a Bash call's own
    /// `cwd` argument is contributed whether or not any operand resolves, and
    /// it resolves against the agent's base directory when relative.
    #[test]
    fn a_bash_call_contributes_its_declared_cwd() {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("tools");
        std::fs::create_dir_all(&sub).unwrap();
        let agents_path = sub.join("AGENTS.md");
        std::fs::write(&agents_path, "# Tools").unwrap();

        let mut provider = agents_md_provider(Some(root.path().to_path_buf()), Vec::new());
        let relative = StepAccess {
            declared_cwds: vec!["tools".to_string()],
            ..Default::default()
        };
        let text = provider(&step(&relative)).expect("the declared cwd heads a chain");
        assert!(
            text.contains(&normalize_agents_md(&agents_path)),
            "content: {text}"
        );

        // The same cwd spelled absolutely resolves to the same place.
        let mut absolute_provider = agents_md_provider(Some(root.path().to_path_buf()), Vec::new());
        let absolute = StepAccess {
            declared_cwds: vec![sub.to_string_lossy().into_owned()],
            ..Default::default()
        };
        let text = absolute_provider(&step(&absolute)).expect("an absolute cwd resolves too");
        assert!(
            text.contains(&normalize_agents_md(&agents_path)),
            "content: {text}"
        );

        // A cwd outside the workspace contributes no chain, as with any other
        // out-of-root path.
        let outside = tempfile::tempdir().unwrap();
        let mut outside_provider = agents_md_provider(Some(root.path().to_path_buf()), Vec::new());
        let escaping = StepAccess {
            declared_cwds: vec![outside.path().to_string_lossy().into_owned()],
            ..Default::default()
        };
        assert_eq!(outside_provider(&step(&escaping)), None);
    }

    /// A path history already named starts out known, so a resumed session does
    /// not suggest it again — this is the fork's stand-in for v2's
    /// `origin.disclosure` seed.
    #[test]
    fn a_disclosed_path_is_never_suggested_again() {
        let dir = tempfile::tempdir().unwrap();
        let agents_path = dir.path().join("AGENTS.md");
        std::fs::write(&agents_path, "# Instructions").unwrap();
        let disclosed = vec![normalize_agents_md(&agents_path)];

        let mut provider = agents_md_provider(Some(dir.path().to_path_buf()), disclosed);
        let access = StepAccess {
            dirs: vec![dir.path().to_path_buf()],
            ..Default::default()
        };
        assert_eq!(provider(&step(&access)), None, "history already named it");
    }

    #[test]
    fn a_provider_that_renders_blank_injects_nothing() {
        let mut registry = InjectionRegistry::new();
        registry.register("blank", Box::new(|_| Some("   \n\t ".into())));
        registry.register("text", Box::new(|_| Some("content".into())));

        let texts = registry.build_injections(true);
        assert_eq!(texts, vec![wrap_system_reminder("content")]);
    }
}
