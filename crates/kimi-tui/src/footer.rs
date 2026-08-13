//! Footer status bar — two lines below the input pane (TS `footer.ts`
//! parity, simplified). Line 1: mode badges + model + cwd + git branch,
//! with a rotating tip right-aligned; line 2: context usage right-aligned.
//! Pure over [`FooterInfo`], so it is unit-testable without a terminal.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};

use crate::i18n::t;
use crate::t;
use crate::theme::Theme;

/// Live session status for the footer strip, refreshed from
/// `session/get_status` plus the working directory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FooterInfo {
    pub plan: bool,
    pub swarm: bool,
    pub auto: bool,
    pub yolo: bool,
    pub model: String,
    /// Thinking effort label (`off`/`low`/`medium`/`high`/`on`), shown
    /// next to the model when not off (TS footer thinking-label parity).
    pub thinking: String,
    /// Context tokens as a percentage of the window (0..=100).
    pub ctx_pct: u8,
    pub cwd: String,
    pub branch: Option<String>,
    /// Live goal badge (`[goal ● active · 4m · 7/20 turns]`), driven by
    /// `session.goal.updated` events (TS `formatGoalBadge` parity); `None`
    /// when no live goal.
    pub goal: Option<GoalBadge>,
}

impl FooterInfo {
    /// Build from a `session/get_status` result; `cwd` and `branch` come
    /// from the process working directory + `.git/HEAD` (no subprocess).
    pub fn from_status(status: &serde_json::Value) -> Self {
        let ctx = status["context_tokens"].as_u64().unwrap_or(0);
        let max = status["max_context_tokens"].as_u64().unwrap_or(0);
        let ctx_pct = if max > 0 {
            ctx.checked_mul(100)
                .map(|v| (v / max) as u8)
                .unwrap_or(0)
                .min(100)
        } else {
            0
        };
        let permission = status["permission"].as_str().unwrap_or("");
        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        Self {
            plan: status["plan_mode"].as_bool().unwrap_or(false),
            swarm: status["swarm_mode"].as_bool().unwrap_or(false),
            auto: permission == "auto",
            yolo: permission == "yolo",
            model: status["model"].as_str().unwrap_or("-").to_string(),
            thinking: status["thinking_effort"].as_str().unwrap_or("").to_string(),
            ctx_pct,
            cwd,
            branch: current_git_branch(),
            goal: None,
        }
    }
}

/// Footer goal badge status — the live statuses that render a badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalBadgeStatus {
    Active,
    Paused,
    Blocked,
}

impl GoalBadgeStatus {
    /// Parse the engine snapshot status; `None` for terminal/unknown
    /// statuses (no badge).
    fn parse(status: &str) -> Option<Self> {
        match status {
            "active" => Some(Self::Active),
            "paused" => Some(Self::Paused),
            "blocked" => Some(Self::Blocked),
            _ => None,
        }
    }
}

/// A live goal badge from a `session.goal.updated` snapshot (TS
/// `formatGoalBadge` parity, structured so the elapsed counter can tick at
/// render time). `None` for terminal/no goal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalBadge {
    /// Live status; drives the dot and the localized label.
    pub status: GoalBadgeStatus,
    /// Engine-reported wall-clock elapsed at snapshot time (already live
    /// for active goals).
    pub elapsed_ms: u64,
    /// Epoch millis when the TUI observed the snapshot, so the active
    /// elapsed counter keeps ticking between events (TS
    /// `goalObservedAtMs` parity).
    pub observed_at_ms: u64,
    pub turns_used: u32,
    pub turn_budget: Option<u32>,
}

impl GoalBadge {
    /// Parse a badge from a camelCase `GoalSnapshot` (null snapshot or
    /// terminal status → `None`, which clears the badge).
    pub fn from_snapshot(snapshot: &serde_json::Value) -> Option<Self> {
        let status = GoalBadgeStatus::parse(snapshot["status"].as_str()?)?;
        Some(Self {
            status,
            elapsed_ms: snapshot["wallClockMs"].as_u64().unwrap_or(0),
            observed_at_ms: now_ms(),
            turns_used: snapshot["turnsUsed"].as_u64().unwrap_or(0) as u32,
            turn_budget: snapshot["budget"]["turnBudget"].as_u64().map(|b| b as u32),
        })
    }

    /// Wall-clock elapsed for the badge: the snapshot's value plus the time
    /// since it was observed, ticking only while active (TS
    /// `goalWallClockMs` parity — paused/blocked stay frozen).
    fn live_elapsed_ms(&self, now_ms: u64) -> u64 {
        if self.status == GoalBadgeStatus::Active {
            self.elapsed_ms
                .saturating_add(now_ms.saturating_sub(self.observed_at_ms))
        } else {
            self.elapsed_ms
        }
    }

    /// The turns segment: `7/20 turns` with a budget, else a plain
    /// singular/plural count (`1 turn` / `3 turns`).
    fn turns_text(&self) -> String {
        if let Some(budget) = self.turn_budget {
            format!(
                "{}/{} {}",
                self.turns_used,
                budget,
                crate::i18n::t("tui.footer.turns")
            )
        } else if self.turns_used == 1 {
            t!("tui.footer.turnOne", 1)
        } else {
            t!("tui.footer.turnOther", self.turns_used)
        }
    }
}

/// Render the badge text, e.g. `[goal ● active · 4m · 7/20 turns]` (TS
/// `goalBadge` template parity; zh: `[目标 ● 进行中 · 4m · 7/20 轮]`).
/// `now_ms` is the render clock — pass the badge's own `observed_at_ms` to
/// pin the elapsed value.
pub fn render_goal_badge(badge: &GoalBadge, now_ms: u64) -> String {
    let dot = match badge.status {
        GoalBadgeStatus::Active => "●",
        GoalBadgeStatus::Paused | GoalBadgeStatus::Blocked => "○",
    };
    let status_label = match badge.status {
        GoalBadgeStatus::Active => t("tui.footer.goalStatusActive"),
        GoalBadgeStatus::Paused => t("tui.footer.goalStatusPaused"),
        GoalBadgeStatus::Blocked => t("tui.footer.goalStatusBlocked"),
    };
    let elapsed = format_badge_elapsed(badge.live_elapsed_ms(now_ms));
    t!(
        "tui.footer.goalBadge",
        dot,
        status_label,
        elapsed,
        badge.turns_text()
    )
}

/// Compact elapsed duration for the badge (TS `formatBadgeElapsed` parity):
/// `<60s → "Ns"`, `<60m → "Nm"`, else `"Nh{X}m"` (minutes always shown).
fn format_badge_elapsed(ms: u64) -> String {
    let total_seconds = ms.saturating_add(500) / 1000;
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let minutes = total_seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    format!("{}h{}m", minutes / 60, minutes % 60)
}

/// Current epoch millis — the footer's render clock (TS `Date.now()`).
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The current git branch by parsing `.git/HEAD` (cheap, no subprocess).
fn current_git_branch() -> Option<String> {
    let head = std::env::current_dir().ok()?.join(".git").join("HEAD");
    let text = std::fs::read_to_string(head).ok()?;
    text.strip_prefix("ref: refs/heads/")
        .map(|b| b.trim().to_string())
}

/// Shorten a working directory for the footer (TS `shortenCwd` parity):
/// `~` for the home dir, then at most 3 path segments.
fn shorten_cwd(path: &str) -> String {
    if path.is_empty() {
        return path.to_string();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() {
        if path == home {
            return "~".to_string();
        }
        let prefix = format!("{home}/");
        if let Some(rest) = path.strip_prefix(&prefix) {
            return format!("~/{rest}");
        }
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() <= 3 {
        path.to_string()
    } else {
        format!("…/{}", segments[segments.len() - 3..].join("/"))
    }
}

/// The tip keys, rotated on a 10s cadence.
const TIP_KEYS: &[&str] = &[
    "tui.tip.0",
    "tui.tip.1",
    "tui.tip.2",
    "tui.tip.3",
    "tui.tip.4",
    "tui.tip.5",
];

/// Which tip to show now (time-based, so it rotates while idle).
pub fn tip_index() -> usize {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (secs / 10) as usize % TIP_KEYS.len()
}

/// The two footer lines for a `width`-wide pane: the status strip with a
/// right-aligned tip, then right-aligned context usage.
pub fn footer_lines(info: &FooterInfo, theme: Theme, width: u16) -> Vec<RenderLine<'static>> {
    // Line 1 — left: `[auto] [yolo] [plan] [swarm] model  cwd  (branch)`.
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (label, on) in [
        ("auto", info.auto),
        ("yolo", info.yolo),
        ("plan", info.plan),
        ("swarm", info.swarm),
    ] {
        if on {
            spans.push(Span::styled(
                format!("[{label}] "),
                Style::default()
                    .fg(theme.assistant)
                    .add_modifier(Modifier::BOLD),
            ));
        }
    }
    if let Some(goal) = &info.goal {
        spans.push(Span::styled(
            format!("{} ", render_goal_badge(goal, now_ms())),
            Style::default().fg(theme.status),
        ));
    }
    spans.push(Span::styled(
        info.model.clone(),
        Style::default().fg(theme.status),
    ));
    if !info.thinking.is_empty() && info.thinking != "off" {
        spans.push(Span::styled(
            format!(" ({})", info.thinking),
            Style::default().fg(theme.thinking),
        ));
    }
    let cwd = shorten_cwd(&info.cwd);
    if !cwd.is_empty() {
        spans.push(Span::styled(
            format!("  {cwd}"),
            Style::default().fg(theme.thinking),
        ));
    }
    if let Some(branch) = &info.branch {
        spans.push(Span::styled(
            format!(" ({branch})"),
            Style::default().fg(theme.thinking),
        ));
    }
    let strip_width: usize = spans.iter().map(|s| s.width()).sum();

    // Right-aligned rotating tip on line 1.
    let tip_text = t(TIP_KEYS[tip_index()]);
    let tip_span = Span::styled(tip_text, Style::default().fg(theme.thinking));
    let tip_width = tip_span.width();
    let pad = (width as usize).saturating_sub(strip_width + 1 + tip_width);
    spans.push(Span::raw(" ".repeat(pad + 1)));
    spans.push(tip_span);
    let line1 = RenderLine::from(spans);

    // Line 2 — right-aligned context usage.
    let ctx_text = t!("tui.footer.ctx", info.ctx_pct);
    let ctx_line = RenderLine::from(Span::styled(
        ctx_text.clone(),
        Style::default().fg(theme.status),
    ));
    let ctx_width = ctx_line.width();
    let pad2 = (width as usize).saturating_sub(ctx_width);
    let line2 = RenderLine::from(vec![
        Span::raw(" ".repeat(pad2)),
        Span::styled(ctx_text, Style::default().fg(theme.status)),
    ]);

    vec![line1, line2]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Locale;

    #[test]
    fn from_status_parses_modes_and_context() {
        let status = serde_json::json!({
            "plan_mode": true,
            "swarm_mode": false,
            "permission": "yolo",
            "model": "kimi-k2",
            "thinking_effort": "high",
            "context_tokens": 300,
            "max_context_tokens": 1000,
        });
        let info = FooterInfo::from_status(&status);
        assert!(info.plan);
        assert!(!info.swarm);
        assert!(info.yolo);
        assert!(!info.auto);
        assert_eq!(info.model, "kimi-k2");
        assert_eq!(info.thinking, "high");
        assert_eq!(info.ctx_pct, 30);
    }

    #[test]
    fn context_percentage_clamps() {
        let info = FooterInfo::from_status(&serde_json::json!({
            "context_tokens": 5000,
            "max_context_tokens": 1000,
        }));
        assert_eq!(info.ctx_pct, 100);
        let info = FooterInfo::from_status(&serde_json::json!({}));
        assert_eq!(info.ctx_pct, 0);
    }

    #[test]
    fn footer_lines_render_modes_and_usage() {
        // Pin En so assertions are stable regardless of the dev tui.toml.
        crate::i18n::set_locale(Locale::En);
        let info = FooterInfo {
            plan: true,
            swarm: false,
            auto: true,
            yolo: false,
            model: "kimi-k2".into(),
            thinking: "high".into(),
            ctx_pct: 30,
            cwd: "/work".into(),
            branch: Some("main".into()),
            goal: Some(GoalBadge {
                status: GoalBadgeStatus::Active,
                elapsed_ms: 4 * 60 * 1000,
                observed_at_ms: now_ms(),
                turns_used: 3,
                turn_budget: None,
            }),
        };
        let lines = footer_lines(&info, Theme::dark(), 80);
        assert_eq!(lines.len(), 2);
        let strip: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert!(strip.contains("[auto]"), "strip: {strip}");
        assert!(strip.contains("[plan]"), "strip: {strip}");
        assert!(strip.contains("kimi-k2"), "strip: {strip}");
        assert!(strip.contains("(high)"), "thinking label: {strip}");
        assert!(strip.contains("/work"), "strip: {strip}");
        assert!(strip.contains("(main)"), "strip: {strip}");
        assert!(strip.contains("[goal ● active · 4m · 3 turns]"), "goal badge: {strip}");
        // The current tip text right-aligns on line 1 (no prefix, TS parity).
        let tip_text = crate::i18n::t(TIP_KEYS[tip_index()]);
        assert!(strip.contains(tip_text), "tip on line 1: {strip}");
        let usage: String = lines[1].spans.iter().map(|s| s.content.clone()).collect();
        assert!(usage.contains("ctx: 30%"), "usage: {usage}");
    }

    #[test]
    fn cwd_shortening() {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            assert_eq!(shorten_cwd(&home), "~");
            assert_eq!(shorten_cwd(&format!("{home}/a/b")), "~/a/b");
        }
        assert_eq!(shorten_cwd("/a/b/c/d/e"), "…/c/d/e");
        assert_eq!(shorten_cwd("/a/b/c"), "/a/b/c");
        assert_eq!(shorten_cwd(""), "");
    }

    #[test]
    fn tip_index_rotates_within_bounds() {
        for _ in 0..10 {
            let idx = tip_index();
            assert!(idx < TIP_KEYS.len(), "idx {idx}");
        }
    }

    #[test]
    fn goal_badge_parses_live_snapshots() {
        // Pin En so the badge labels are stable.
        crate::i18n::set_locale(Locale::En);
        // Active with a turn budget → `used/limit turns`.
        let budgeted = serde_json::json!({
            "status": "active",
            "turnsUsed": 7,
            "wallClockMs": 240_000,
            "budget": { "turnBudget": 20 },
        });
        let badge = GoalBadge::from_snapshot(&budgeted).expect("badge");
        assert_eq!(
            render_goal_badge(&badge, badge.observed_at_ms),
            "[goal ● active · 4m · 7/20 turns]"
        );
        // Paused without a budget → hollow dot, plain count.
        let paused = serde_json::json!({ "status": "paused", "turnsUsed": 5 });
        let badge = GoalBadge::from_snapshot(&paused).expect("badge");
        assert_eq!(
            render_goal_badge(&badge, badge.observed_at_ms),
            "[goal ○ paused · 0s · 5 turns]"
        );
        // Singular count when the budget is absent.
        let one = GoalBadge::from_snapshot(&serde_json::json!({ "status": "blocked", "turnsUsed": 1 }))
            .expect("badge");
        assert_eq!(
            render_goal_badge(&one, one.observed_at_ms),
            "[goal ○ blocked · 0s · 1 turn]"
        );
        // Terminal / missing / null snapshots → no badge.
        assert!(GoalBadge::from_snapshot(&serde_json::json!({ "status": "complete" })).is_none());
        assert!(GoalBadge::from_snapshot(&serde_json::json!({})).is_none());
        assert!(GoalBadge::from_snapshot(&serde_json::Value::Null).is_none());
        // No goal → the footer strip carries no badge.
        let info = FooterInfo { goal: None, ..FooterInfo::default() };
        let lines = footer_lines(&info, Theme::dark(), 80);
        let strip: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert!(!strip.contains("[goal"), "no badge without a goal: {strip}");
    }

    #[test]
    fn goal_badge_ticks_only_while_active() {
        crate::i18n::set_locale(Locale::En);
        let snapshot = serde_json::json!({ "status": "active", "turnsUsed": 3, "wallClockMs": 0 });
        let badge = GoalBadge::from_snapshot(&snapshot).expect("badge");
        // 65s after observation the active badge shows the added time…
        assert_eq!(
            render_goal_badge(&badge, badge.observed_at_ms + 65_000),
            "[goal ● active · 1m · 3 turns]"
        );
        // …but a paused badge stays frozen at the snapshot value.
        let paused = GoalBadge::from_snapshot(&serde_json::json!({ "status": "paused", "turnsUsed": 1 }))
            .expect("badge");
        assert_eq!(
            render_goal_badge(&paused, paused.observed_at_ms + 65_000),
            "[goal ○ paused · 0s · 1 turn]"
        );
    }

    #[test]
    fn goal_badge_elapsed_formats() {
        assert_eq!(format_badge_elapsed(0), "0s");
        assert_eq!(format_badge_elapsed(29_499), "29s");
        assert_eq!(format_badge_elapsed(29_500), "30s"); // rounds to the second
        assert_eq!(format_badge_elapsed(4 * 60_000), "4m");
        assert_eq!(format_badge_elapsed(59 * 60_000), "59m");
        assert_eq!(format_badge_elapsed(60 * 60_000), "1h0m"); // TS always prints minutes
        assert_eq!(format_badge_elapsed(61 * 60_000), "1h1m");
    }

    #[test]
    fn goal_badge_localizes_zh() {
        // Pure-locale check (the global-locale tests above pin En): the zh
        // template + labels compose the same shape as En.
        use crate::i18n::{t_fmt_for, t_for, Locale as L};
        assert_eq!(
            t_fmt_for(
                L::Zh,
                "tui.footer.goalBadge",
                &["●".into(), "进行中".into(), "4m".into(), "7/20 轮".into()],
            ),
            "[目标 ● 进行中 · 4m · 7/20 轮]"
        );
        assert_eq!(t_for(L::Zh, "tui.footer.goalStatusPaused"), "已暂停");
        assert_eq!(t_for(L::Zh, "tui.footer.goalStatusBlocked"), "已受阻");
        assert_eq!(t_fmt_for(L::Zh, "tui.footer.turnOther", &["3".into()]), "3 轮");
        assert_eq!(t_for(L::Zh, "tui.footer.turns"), "轮");
    }
}
