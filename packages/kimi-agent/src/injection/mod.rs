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
//! variant). Goal/plan-mode providers are contributed by
//! [`goal_plan`] (implemented separately).

use std::path::{Path, PathBuf};

use crate::turn_loop::types::LLMMessage;

/// Wrapper prefix for injection texts, matching v2's `SYSTEM_REMINDER_PREFIX`.
pub const SYSTEM_REMINDER_PREFIX: &str = "<system-reminder>\n";
/// Wrapper suffix for injection texts, matching v2's `SYSTEM_REMINDER_SUFFIX`.
pub const SYSTEM_REMINDER_SUFFIX: &str = "\n</system-reminder>";

/// Goal/plan-mode injection providers (implemented separately from this
/// module; see the injection-layer work item).
pub mod goal_plan;

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
    let mut i = 0;
    while i < messages.len() {
        if is_system_reminder(&messages[i].content) {
            injections.push(messages.remove(i));
        } else {
            i += 1;
        }
    }
    injections
}

/// Context passed to injection providers for one build pass. Mirrors v2's
/// `ContextInjectionContext` (the `injectedPositions` part): the names of
/// injections already appended this turn, in registration order.
pub struct InjectionContext<'a> {
    /// Names of injections already appended this turn, in registration order.
    pub injected: &'a [String],
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
    /// root defaults to the process working directory.
    pub fn with_defaults() -> Self {
        let mut registry = Self::new();
        registry.register("date_change", Box::new(date_change_provider()));
        registry.register(
            "agents_md",
            Box::new(agents_md_provider(std::env::current_dir().ok())),
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
    /// step, in registration order. Providers that return `None` or blank
    /// text contribute nothing; successful injections are recorded in the
    /// context handed to later providers.
    pub fn build_injections(&mut self) -> Vec<String> {
        let mut texts = Vec::new();
        for entry in &mut self.entries {
            let ctx = InjectionContext {
                injected: &self.injected,
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

/// Adapter for the goal/plan-mode providers in [`goal_plan`]: their
/// providers render to a plain string (empty = nothing to inject), while
/// this registry's providers return `Option<String>`. The adapter wraps the
/// former into the latter so `goal_plan::register_goal_plan_injections` can
/// attach both variants to this registry.
impl goal_plan::InjectionRegistry for InjectionRegistry {
    fn register(&mut self, variant: &str, provider: goal_plan::InjectionProvider) {
        self.register(
            variant,
            Box::new(move |_ctx: &InjectionContext| {
                let text = provider();
                if text.trim().is_empty() {
                    None
                } else {
                    Some(text)
                }
            }),
        );
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
/// first pass of a turn and re-injects whenever the date changes mid-turn.
fn date_change_provider() -> impl FnMut(&InjectionContext) -> Option<String> {
    let mut tracker = DateChangeTracker::new();
    move |_ctx: &InjectionContext| tracker.step(&today_utc())
}

/// Current UTC date as `YYYY-MM-DD`. v2 discloses the local date; the engine
/// has no timezone data (std-only), so UTC is the deterministic stand-in —
/// day-boundary detection is unaffected.
fn today_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let days = (now.as_secs() as i64).div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant's `civil_from_days` algorithm; mirrors the
/// private helper in `crate::knowledge`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
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

/// Provider for the workspace-root AGENTS.md reminder (v2 `agents_md`
/// variant): injects once per turn when the workspace root contains an
/// AGENTS.md instruction file that was not part of the injected instructions.
/// `root` is `None` when the process working directory is unavailable.
fn agents_md_provider(root: Option<PathBuf>) -> impl FnMut(&InjectionContext) -> Option<String> {
    let mut injected = false;
    move |_ctx: &InjectionContext| {
        if injected {
            return None;
        }
        let root = root.as_deref()?;
        let path = find_agents_md(root)?;
        injected = true;
        Some(format!(
            "The workspace root is covered by an AGENTS.md instruction file that was not \
             part of the injected instructions:\n- {}\nRead it before making changes in \
             that directory. Each file is suggested at most once per agent.",
            path.display()
        ))
    }
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
        assert!(is_system_reminder("<system-reminder>\nhello\n</system-reminder>"));
        assert!(is_system_reminder("<system-reminder>\nline1\nline2\n</system-reminder>"));
        assert!(is_system_reminder("<system-reminder>\n\n</system-reminder>"));

        // Invalid: missing tags or malformed delimiters
        assert!(!is_system_reminder("hello"));
        assert!(!is_system_reminder(""));
        assert!(!is_system_reminder("<system-reminder>\nhello"));
        assert!(!is_system_reminder("hello\n</system-reminder>"));
        assert!(!is_system_reminder("<system-reminder>hello\n</system-reminder>"));
        assert!(!is_system_reminder("<system-reminder>\nhello</system-reminder>"));
        assert!(!is_system_reminder(" <system-reminder>\nhello\n</system-reminder>"));
        assert!(!is_system_reminder("<system-reminder>\nhello\n</system-reminder> "));
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

        let texts = registry.build_injections();
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
                assert!(ctx.injected.is_empty(), "first provider sees empty injected slice");
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
        let texts = registry.build_injections();
        assert_eq!(texts.len(), 3);
        assert_eq!(texts[0], wrap_system_reminder("one"));
        assert_eq!(texts[1], wrap_system_reminder("two"));
        assert_eq!(texts[2], wrap_system_reminder("three"));
    }

    #[test]
    fn test_with_defaults_registers_builtins_and_builds() {
        let mut registry = InjectionRegistry::with_defaults();
        assert_eq!(registry.names(), vec!["date_change", "agents_md"]);

        let texts = registry.build_injections();
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
    fn test_today_utc_and_civil_from_days() {
        let today = today_utc();
        let parts: Vec<&str> = today.split('-').collect();
        assert_eq!(parts.len(), 3, "today_utc must format as YYYY-MM-DD");
        let year: i64 = parts[0].parse().expect("valid year");
        let month: u32 = parts[1].parse().expect("valid month");
        let day: u32 = parts[2].parse().expect("valid day");

        assert!(year >= 2024, "year must be realistic modern date");
        assert!((1..=12).contains(&month), "month must be in 1..=12");
        assert!((1..=31).contains(&day), "day must be in 1..=31");

        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(-365), (1969, 1, 1));
        assert_eq!(civil_from_days(11016), (2000, 2, 29));
        assert_eq!(civil_from_days(11017), (2000, 3, 1));
        assert_eq!(civil_from_days(19782), (2024, 2, 29));
        assert_eq!(civil_from_days(19783), (2024, 3, 1));
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
        assert!(found_lower
            .file_name()
            .unwrap()
            .to_string_lossy()
            .eq_ignore_ascii_case("agents.md"));
        #[cfg(not(windows))]
        assert_eq!(found_lower, lowercase);

        let dir4 = tempfile::tempdir().unwrap();
        let path_upper = dir4.path().join("AGENTS.md");
        std::fs::write(&path_upper, "# Upper").unwrap();
        let found_prec = find_agents_md(dir4.path()).expect("found");
        assert_eq!(found_prec.file_name().unwrap(), "AGENTS.md");
    }

    #[test]
    fn test_agents_md_provider_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let agents_path = dir.path().join("AGENTS.md");
        std::fs::write(&agents_path, "# Instructions").unwrap();

        let mut provider = agents_md_provider(Some(dir.path().to_path_buf()));
        let ctx = InjectionContext { injected: &[] };

        let text = provider(&ctx).expect("first pass injects");
        let expected = format!(
            "The workspace root is covered by an AGENTS.md instruction file that was not \
             part of the injected instructions:\n- {}\nRead it before making changes in \
             that directory. Each file is suggested at most once per agent.",
            agents_path.display()
        );
        assert_eq!(text, expected);

        assert_eq!(provider(&ctx), None, "at most once per turn");

        let mut none_provider = agents_md_provider(None);
        assert_eq!(none_provider(&ctx), None);

        let empty_dir = tempfile::tempdir().unwrap();
        let mut missing_provider = agents_md_provider(Some(empty_dir.path().to_path_buf()));
        assert_eq!(missing_provider(&ctx), None);
    }

    #[test]
    fn test_injection_registry_adapter_for_goal_plan() {
        use crate::injection::goal_plan::InjectionRegistry as GoalPlanRegistry;

        let mut registry = InjectionRegistry::new();
        GoalPlanRegistry::register(&mut registry, "gp_active", Box::new(|| "goal content".into()));
        GoalPlanRegistry::register(&mut registry, "gp_empty", Box::new(|| "".into()));
        GoalPlanRegistry::register(&mut registry, "gp_whitespace", Box::new(|| "   \n\t ".into()));

        let texts = registry.build_injections();
        assert_eq!(texts.len(), 1);
        assert_eq!(texts[0], wrap_system_reminder("goal content"));
    }
}
