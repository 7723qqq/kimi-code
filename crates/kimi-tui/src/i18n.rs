//! Minimal i18n for the Rust TUI — a locale-aware `t()` over a built-in
//! en/zh dictionary. The key space (`tui.*`) is self-contained in Rust and
//! is the source of truth for the TUI's own strings (no TS dependency),
//! matching the migration direction where i18n data eventually lives in
//! Rust. Messages carry `{0}`-style positional placeholders; call sites use
//! `t!("key", …)` (a macro wrapper over `format!`-style runtime templates).
//!
//! The active locale is resolved once from `tui.toml` (`locale` field) on
//! first use; `set_locale` overrides it (the future `/locale` command).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The supported UI locales.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    /// English (the default; also the fallback for missing entries).
    En,
    /// Simplified Chinese.
    Zh,
}

impl Locale {
    /// Parse a locale string (`en` / `zh`); anything else is `En`.
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("zh") => Locale::Zh,
            _ => Locale::En,
        }
    }
}

/// The active locale plus whether it has been resolved from config yet.
/// A `Mutex` (not `OnceLock`) so `set_locale` can genuinely switch locales
/// (the future `/locale` command) and tests stay independent.
static LOCALE: Mutex<Locale> = Mutex::new(Locale::En);
static LOCALE_RESOLVED: AtomicBool = AtomicBool::new(false);

/// Re-read `tui.toml` on the next `active_locale()` (the `/reload-tui`
/// command).
pub fn reload_locale() {
    LOCALE_RESOLVED.store(false, Ordering::Relaxed);
}

/// Override the active locale (persisted via tui.toml by the caller).
pub fn set_locale(locale: Locale) {
    *LOCALE.lock().unwrap() = locale;
    LOCALE_RESOLVED.store(true, Ordering::Relaxed);
}

/// The active locale; reads `tui.toml` on first use.
pub fn active_locale() -> Locale {
    let mut guard = LOCALE.lock().unwrap();
    if !LOCALE_RESOLVED.load(Ordering::Relaxed) {
        *guard = locale_from_config();
        LOCALE_RESOLVED.store(true, Ordering::Relaxed);
    }
    *guard
}

/// Resolve the locale from `~/.kimi-code/tui.toml` (`locale` field).
fn locale_from_config() -> Locale {
    let Some(path) = crate::theme::tui_config_path() else {
        return Locale::En;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Locale::En;
    };
    let Ok(value) = text.parse::<toml::Value>() else {
        return Locale::En;
    };
    Locale::parse(value.get("locale").and_then(|v| v.as_str()))
}

/// Persist the `locale` field to `tui.toml` (creates the file when absent)
/// so the choice survives restarts.
pub fn save_locale(locale: Locale) -> anyhow::Result<()> {
    let key = match locale {
        Locale::En => "en",
        Locale::Zh => "zh",
    };
    crate::theme::set_tui_config_field("locale", toml::Value::String(key.to_string()))
}

/// Look up `key` in the dictionary for the active locale. Falls back to the
/// key itself when missing — a visible signal that the entry is absent.
/// Linear scan: the dictionary is small (~100 entries) and grouped by
/// topic, so entries don't need to stay sorted.
pub fn t(key: &str) -> &str {
    t_for(active_locale(), key)
}

/// Locale-explicit lookup (pure — used by tests and hosts that pass a
/// concrete locale).
pub fn t_for(locale: Locale, key: &str) -> &str {
    match MESSAGES.iter().find(|(k, _, _)| *k == key) {
        Some((_, en, zh)) => match locale {
            Locale::En => en,
            Locale::Zh => zh,
        },
        None => key,
    }
}

/// Format a localized template (`{0}`-style positional placeholders) with
/// the given arguments. Unknown keys fall back to the key itself.
pub fn t_fmt(key: &str, args: &[String]) -> String {
    t_fmt_for(active_locale(), key, args)
}

/// Locale-explicit template formatting (pure — used by tests).
pub fn t_fmt_for(locale: Locale, key: &str, args: &[String]) -> String {
    let tpl = t_for(locale, key);
    if args.is_empty() {
        return tpl.to_string();
    }
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(start) = rest.find('{') {
        // Only `{digit}` placeholders are substituted; anything else passes
        // through verbatim (e.g. literal braces in the template).
        let Some(end_rel) = rest[start + 1..].find('}') else {
            out.push_str(rest);
            return out;
        };
        let end = start + 1 + end_rel;
        match rest[start + 1..end]
            .parse::<usize>()
            .ok()
            .and_then(|i| args.get(i))
        {
            Some(arg) => {
                out.push_str(&rest[..start]);
                out.push_str(arg);
                rest = &rest[end + 1..];
            }
            None => {
                out.push_str(&rest[..=end]);
                rest = &rest[end + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `t!("key", arg1, arg2)` — localized, positionally-formatted text.
/// `format!` needs a literal format string, so runtime templates go through
/// this macro instead.
#[macro_export]
macro_rules! t {
    ($key:expr $(, $arg:expr)* $(,)?) => {{
        // Arguments are heterogeneous (&str, numbers, owned strings);
        // `format!` converts through Display for all of them.
        let args = &[$( format!("{}", $arg) ),*];
        $crate::i18n::t_fmt($key, args)
    }};
}

/// `(key, en, zh)`, sorted by key for binary search. Placeholders use
/// `{0}`-style positional references, filled by `t!("key", …)`.
static MESSAGES: &[(&str, &str, &str)] = &[
    // ── Startup ────────────────────────────────────────────────────────
    (
        "tui.start.loggedIn",
        "kimi auth: logged in",
        "kimi 认证：已登录",
    ),
    (
        "tui.start.notLoggedIn",
        "not logged in — type /login to authenticate",
        "未登录 — 输入 /login 进行认证",
    ),
    (
        "tui.start.sessionReady",
        "session {0} ready — type /help",
        "会话 {0} 已就绪 — 输入 /help",
    ),
    // ── General / help ─────────────────────────────────────────────────
    ("tui.help.commands", "commands: {0}", "命令：{0}"),
    ("tui.help.title", "help", "帮助"),
    ("tui.help.shortcuts", "shortcuts", "快捷键"),
    ("tui.help.scrollHint", "↑/↓ scroll · Esc close", "↑/↓ 滚动 · Esc 关闭"),
    (
        "tui.help.detailHint",
        "type /help <command> for a command's description",
        "输入 /help <命令> 查看单个命令的说明",
    ),
    (
        "tui.help.unknown",
        "unknown command {0} — try /help",
        "未知命令 {0} — 输入 /help",
    ),
    (
        "tui.err.unknownCommand",
        "unknown command {0} — try /help",
        "未知命令 {0} — 输入 /help",
    ),
    ("tui.err.generic", "error: {0}", "错误：{0}"),
    ("tui.err.command", "command failed: {0}", "命令失败：{0}"),
    ("tui.status.plan", "plan mode {0}", "计划模式{0}"),
    ("tui.status.swarm", "swarm mode {0}", "群组模式{0}"),
    ("tui.status.on", "on", "已开启"),
    ("tui.status.off", "off", "已关闭"),
    ("tui.plan.cleared", "plan mode cleared", "已清除计划模式"),
    (
        "tui.copy.none",
        "no assistant message to copy",
        "没有可复制的助手消息",
    ),
    (
        "tui.copy.ok",
        "copied {0} chars to the clipboard",
        "已复制 {0} 个字符到剪贴板",
    ),
    ("tui.err.copyFailed", "copy failed: {0}", "复制失败：{0}"),
    ("tui.exportMd.done", "exported to {0}", "已导出到 {0}"),
    (
        "tui.err.exportMdFailed",
        "export failed: {0}",
        "导出失败：{0}",
    ),
    // ── Approvals ──────────────────────────────────────────────────────
    (
        "tui.approval.none",
        "no pending approvals",
        "没有待处理的审批",
    ),
    (
        "tui.approval.listItem",
        "{0}  {1}  ({2})",
        "{0}  {1}  ({2})",
    ),
    (
        "tui.approval.modalHint",
        "y = allow    n = deny    s = allow for session    Esc = close",
        "y=允许    n=拒绝    s=本会话允许    Esc=关闭",
    ),
    (
        "tui.question.replyHint",
        "reply with a number, or free text",
        "输入数字或自由文本回答",
    ),
    ("tui.question.title", "question", "提问"),
    ("tui.question.options", "options:", "选项："),
    ("tui.question.answer", "answer:", "回答："),
    (
        "tui.question.hint",
        "number = pick · Enter = send · Esc = skip",
        "数字=选择 · Enter=发送 · Esc=跳过",
    ),
    (
        "tui.question.multiHint",
        "numbers = toggle · Enter = send · Esc = skip",
        "数字=多选 · Enter=发送 · Esc=跳过",
    ),
    ("tui.question.more", "{0} more options", "还有 {0} 个选项"),
    (
        "tui.approval.approveUsage",
        "usage: /approve <approval-id>",
        "用法：/approve <审批ID>",
    ),
    (
        "tui.approval.denyUsage",
        "usage: /deny <approval-id>",
        "用法：/deny <审批ID>",
    ),
    ("tui.approval.allowed", "approval allowed", "已允许该审批"),
    ("tui.approval.denied", "approval denied", "已拒绝该审批"),
    (
        "tui.approval.moreLines",
        "… and {0} more lines",
        "… 还有 {0} 行",
    ),
    (
        "tui.approval.moreOptions",
        "… and {0} more options",
        "… 还有 {0} 个选项",
    ),
    (
        "tui.approval.todoEmpty",
        "(no todos)",
        "(无待办项)",
    ),
    // ── Relative time (session picker rows) ─────────────────────────────
    ("tui.time.sAgo", "{0}s ago", "{0}秒前"),
    ("tui.time.mAgo", "{0}m ago", "{0}分钟前"),
    ("tui.time.hAgo", "{0}h ago", "{0}小时前"),
    ("tui.time.dAgo", "{0}d ago", "{0}天前"),
    // ── Tool-result chips (collapsed card summaries) ────────────────────
    ("tui.chip.editOk", "Edit ok", "编辑成功"),
    ("tui.chip.edit", "Edit {0}", "编辑 {0}"),
    ("tui.chip.write", "Write {0} lines", "写入 {0} 行"),
    ("tui.chip.read", "Read {0} lines", "读取 {0} 行"),
    ("tui.chip.bashOk", "Bash ok", "命令成功"),
    ("tui.chip.failed", "{0} failed", "{0} 失败"),
    // ── Dangerous-command detection (TS `tui.dangerPatterns` parity) ─────
    (
        "tui.dangerPatterns.recursiveDelete",
        "recursive delete",
        "递归删除",
    ),
    ("tui.dangerPatterns.sudo", "sudo", "sudo"),
    (
        "tui.dangerPatterns.pipeToShell",
        "pipe to shell",
        "管道至 shell",
    ),
    ("tui.dangerPatterns.ddWrite", "dd write", "dd 写入"),
    ("tui.dangerPatterns.mkfs", "mkfs", "mkfs"),
    (
        "tui.dangerPatterns.writeToRawDevice",
        "write to raw device",
        "写入裸设备",
    ),
    ("tui.dangerPatterns.chmod777", "chmod 777", "chmod 777"),
    ("tui.dangerPatterns.forkBomb", "fork bomb", "fork 炸弹"),
    // ── Permission-mode descriptions (picker rows) ──────────────────────
    (
        "tui.permission.descManual",
        "approve each tool call",
        "每个工具调用需要批准",
    ),
    (
        "tui.permission.descPlan",
        "propose changes, approve execution",
        "先提出方案，再批准执行",
    ),
    (
        "tui.permission.descAuto",
        "auto-approve safe operations",
        "自动批准安全操作",
    ),
    (
        "tui.permission.descYolo",
        "skip all approvals",
        "跳过所有批准",
    ),
    (
        "tui.diff.unchangedLines",
        "{0} unchanged line(s) …",
        "{0} 行未变更…",
    ),
    (
        "tui.diff.moreChangesHidden",
        "… {0} more change(s) hidden",
        "… 还有 {0} 处变更已隐藏",
    ),
    (
        "tui.approval.notFound",
        "approval not found",
        "未找到该审批",
    ),
    (
        "tui.approval.requested",
        "approval requested: {0} ({1}) {2} — y/n, v=details, s=for-session",
        "审批请求：{0} ({1}) {2} — y=允许，n=拒绝，v=详情，s=本会话允许",
    ),
    (
        "tui.approval.inspect",
        "approval requested — run /approvals to inspect",
        "有审批请求 — 运行 /approvals 查看",
    ),
    ("tui.approval.ruleLabel", "Always allow", "始终允许"),
    (
        "tui.approval.allowedForSession",
        "{0} approved for session ({1} will auto-approve)",
        "{0} 已为本会话批准（{1} 将自动批准）",
    ),
    (
        "tui.approval.noLongerPending",
        "{0} no longer pending",
        "{0} 不再待处理",
    ),
    ("tui.approval.allowedAction", "{0} allowed", "{0} 已允许"),
    ("tui.approval.deniedAction", "{0} denied", "{0} 已拒绝"),
    // ── Status / info ───────────────────────────────────────────────────
    (
        "tui.status.summary",
        "model: {0} | mode: {1} | permission: {2} | thinking: {3} | ctx: {4}/{5}",
        "模型：{0} | 模式：{1} | 权限：{2} | 思考：{3} | 上下文：{4}/{5}",
    ),
    (
        "tui.status.reportModel",
        "kimi {0} · model: {1}",
        "kimi {0} · 模型：{1}",
    ),
    ("tui.status.reportMode", "mode: {0}", "模式：{0}"),
    ("tui.status.reportPermission", "permission: {0}", "权限：{0}"),
    ("tui.status.reportThinking", "thinking: {0}", "思考：{0}"),
    (
        "tui.status.reportCtx",
        "context: {0}/{1} tokens",
        "上下文：{0}/{1} tokens",
    ),
    ("tui.status.reportSession", "session: {0}", "会话：{0}"),
    (
        "tui.info.version",
        "kimi {0} — session {1}",
        "kimi {0} — 会话 {1}",
    ),
    ("tui.err.infoFailed", "info failed: {0}", "info 失败：{0}"),
    (
        "tui.usage.session",
        "usage: /session [set <title>]",
        "用法：/session [set <标题>]",
    ),
    ("tui.status.sessionId", "session {0}", "会话 {0}"),
    ("tui.status.sessionSet", "session {0}", "会话 {0}"),
    (
        "tui.err.renameFailed",
        "rename failed: {0}",
        "重命名失败：{0}",
    ),
    ("tui.status.modelSummary", "model: {0}", "模型：{0}"),
    ("tui.status.modeSummary", "mode: {0}", "模式：{0}"),
    // ── Plugins ─────────────────────────────────────────────────────────
    ("tui.plugins.none", "no plugins installed", "未安装插件"),
    ("tui.plugins.cancelled", "plugin selection cancelled", "已取消插件选择"),
    ("tui.plugins.list", "plugins ({0}): {1}", "插件（{0}）：{1}"),
    (
        "tui.err.pluginsFailed",
        "plugins failed: {0}",
        "插件操作失败：{0}",
    ),
    ("tui.plugins.enabled", "enabled {0}", "已启用 {0}"),
    ("tui.plugins.disabled", "disabled {0}", "已禁用 {0}"),
    ("tui.plugins.removed", "removed {0}", "已移除 {0}"),
    (
        "tui.plugins.notFound",
        "removed {0} (not found)",
        "已移除 {0}（未找到）",
    ),
    ("tui.plugins.reloaded", "plugins reloaded", "插件已重载"),
    (
        "tui.plugins.confirmRemove",
        "remove plugin {0}? (y/N)",
        "移除插件 {0}？(y/N)",
    ),
    (
        "tui.provider.confirmRemove",
        "remove provider {0}? (y/N)",
        "移除供应商 {0}？(y/N)",
    ),
    ("tui.plugins.installed", "installed {0}", "已安装 {0}"),
    // ── Informational commands (no engine data source in Rust yet) ──────
    (
        "tui.experiments.hint",
        "experimental flags are managed in config.toml",
        "实验性功能开关在 config.toml 中管理",
    ),
    (
        "tui.multiLlm.hint",
        "multi-LLM providers are configured in config.toml",
        "多 LLM 供应商在 config.toml 中配置",
    ),
    (
        "tui.feedback.hint",
        "feedback is collected by the CLI — run `kimi --feedback`",
        "反馈由 CLI 收集 — 运行 `kimi --feedback`",
    ),
    (
        "tui.web.hint",
        "run `kimi web` in the terminal to start the web UI",
        "在终端运行 `kimi web` 启动 Web UI",
    ),
    (
        "tui.plugins.usage",
        "usage: /plugins [list|enable|disable|remove|reload|install <source>]",
        "用法：/plugins [list|enable|disable|remove|reload|install <来源>]",
    ),
    // ── Config / skills ─────────────────────────────────────────────────
    ("tui.config.show", "config: {0}", "配置：{0}"),
    (
        "tui.err.configFailed",
        "config failed: {0}",
        "读取配置失败：{0}",
    ),
    ("tui.skills.none", "no skills registered", "没有注册的技能"),
    ("tui.skills.selected", "{0}: {1}", "{0}：{1}"),
    (
        "tui.skills.cancelled",
        "skill selection cancelled",
        "已取消技能选择",
    ),
    (
        "tui.err.skillsFailed",
        "skills failed: {0}",
        "技能列表失败：{0}",
    ),
    // ── Thinking / permission ───────────────────────────────────────────
    (
        "tui.thinking.usage",
        "usage: /thinking <low|medium|high>",
        "用法：/thinking <low|medium|high>",
    ),
    (
        "tui.thinking.set",
        "thinking effort set to {0}",
        "思考强度已设为 {0}",
    ),
    (
        "tui.permission.mode",
        "permission mode: {0}",
        "权限模式：{0}",
    ),
    (
        "tui.permission.cancelled",
        "permission selection cancelled",
        "已取消权限选择",
    ),
    ("tui.permission.yolo", "yolo mode {0}", "YOLO 模式{0}"),
    ("tui.permission.auto", "auto mode {0}", "自动模式{0}"),
    // ── Session lifecycle ───────────────────────────────────────────────
    (
        "tui.session.initialized",
        "session initialized (agents.md)",
        "会话已初始化（agents.md）",
    ),
    (
        "tui.title.usage",
        "usage: /title <title>",
        "用法：/title <标题>",
    ),
    ("tui.title.set", "session title: {0}", "会话标题：{0}"),
    (
        "tui.mcp.none",
        "no MCP servers configured",
        "没有配置 MCP 服务器",
    ),
    ("tui.mcp.list", "MCP servers: {0}", "MCP 服务器：{0}"),
    ("tui.err.mcpFailed", "mcp failed: {0}", "MCP 操作失败：{0}"),
    ("tui.tasks.none", "no background tasks", "没有后台任务"),
    ("tui.picker.selectTask", "select a task", "选择一个任务"),
    ("tui.tasks.cancelled", "task selection cancelled", "已取消任务选择"),
    ("tui.tasks.listItem", "{0}  {1}  [{2}]", "{0}  {1}  [{2}]"),
    (
        "tui.tasks.noOutput",
        "task {0} has no output",
        "任务 {0} 没有输出",
    ),
    ("tui.theme.set", "theme: {0}", "主题：{0}"),
    ("tui.theme.dark", "dark", "深色"),
    ("tui.theme.light", "light", "浅色"),
    ("tui.theme.auto", "auto", "自动"),
    (
        "tui.theme.usage",
        "usage: /theme <dark|light|auto>",
        "用法：/theme <dark|light|auto>",
    ),
    (
        "tui.theme.cancelled",
        "theme selection cancelled",
        "已取消主题选择",
    ),
    ("tui.picker.selectTheme", "select a theme", "选择主题"),
    ("tui.version.show", "kimi version: {0}", "kimi 版本：{0}"),
    (
        "tui.err.versionFailed",
        "version failed: {0}",
        "获取版本失败：{0}",
    ),
    (
        "tui.models.none",
        "no model aliases configured",
        "没有配置模型别名",
    ),
    ("tui.models.default", "default: {0}", "默认：{0}"),
    ("tui.models.set", "model set to {0}", "模型已设为 {0}"),
    (
        "tui.models.cancelled",
        "model selection cancelled",
        "已取消模型选择",
    ),
    ("tui.reload.ok", "session reloaded", "会话已重载"),
    (
        "tui.err.reloadFailed",
        "reload failed: {0}",
        "重载失败：{0}",
    ),
    (
        "tui.resume.usage",
        "usage: /resume <session-id>",
        "用法：/resume <会话ID>",
    ),
    (
        "tui.resume.switched",
        "switched to session {0}",
        "已切换到会话 {0}",
    ),
    // ── Goal ────────────────────────────────────────────────────────────
    (
        "tui.goal.usage",
        "usage: /goal <objective> | status|pause|resume|cancel|replace|next",
        "用法：/goal <目标> | status|pause|resume|cancel|replace|next",
    ),
    ("tui.goal.status", "goal status: {0}", "目标状态：{0}"),
    ("tui.goal.none", "no active goal", "没有活动目标"),
    (
        "tui.goal.panelStatus",
        "status: {0} · {1} turns · {2} tokens",
        "状态：{0} · {1} 轮 · {2} tokens",
    ),
    ("tui.goal.reportObjective", "objective: {0}", "目标：{0}"),
    ("tui.goal.reportStatus", "status: {0}", "状态：{0}"),
    ("tui.goal.reportTurns", "turns: {0}", "轮次：{0}"),
    ("tui.goal.reportTokens", "tokens: {0}", "Token：{0}"),
    ("tui.goal.paused", "goal paused", "目标已暂停"),
    ("tui.goal.resumed", "goal resumed", "目标已恢复"),
    ("tui.goal.cancelled", "goal cancelled", "目标已取消"),
    (
        "tui.goal.replaceUsage",
        "usage: /goal replace <objective>",
        "用法：/goal replace <目标>",
    ),
    ("tui.goal.replaced", "goal replaced: {0}", "目标已替换：{0}"),
    ("tui.goal.created", "goal created: {0}", "目标已创建：{0}"),
    (
        "tui.goal.nextUnsupported",
        "goal queueing is not supported in the Rust TUI — use a plain objective",
        "Rust TUI 不支持目标排队 — 请直接输入目标",
    ),
    ("tui.goal.show", "goal: {0}", "目标：{0}"),
    (
        "tui.goal.queued",
        "queued goal: {0} ({1} queued)",
        "已排队目标：{0}（队列 {1}）",
    ),
    (
        "tui.goal.queueUsage",
        "usage: /goal next <objective> | manage | remove <id> | move <id> up|down | promote",
        "用法：/goal next <目标> | manage | remove <ID> | move <ID> up|down | promote",
    ),
    ("tui.goal.queueEmpty", "no queued goals", "队列中没有目标"),
    (
        "tui.goal.queueList",
        "queued goals ({0}):",
        "排队目标（{0}）：",
    ),
    ("tui.goal.queueItem", "{0}  {1}", "{0}  {1}"),
    (
        "tui.goal.removed",
        "removed queued goal {0}",
        "已移除排队目标 {0}",
    ),
    (
        "tui.goal.removedNotFound",
        "queued goal {0} not found",
        "未找到排队目标 {0}",
    ),
    (
        "tui.goal.moved",
        "moved queued goal {0}",
        "已移动排队目标 {0}",
    ),
    (
        "tui.goal.promoted",
        "promoted queued goal: {0}",
        "已提升排队目标：{0}",
    ),
    (
        "tui.goal.noQueued",
        "no queued goals to promote",
        "没有可提升的排队目标",
    ),
    // ── Context / history ───────────────────────────────────────────────
    ("tui.addDir.added", "added dir {0}", "已添加目录 {0}"),
    (
        "tui.err.addDirFailed",
        "add-dir failed: {0}",
        "add-dir 失败：{0}",
    ),
    (
        "tui.addDir.usage",
        "usage: /add-dir <path>",
        "用法：/add-dir <路径>",
    ),
    ("tui.clear.ok", "context cleared", "上下文已清空"),
    ("tui.compact.ok", "context compacted", "上下文已压缩"),
    (
        "tui.err.compactFailed",
        "compact failed: {0}",
        "压缩失败：{0}",
    ),
    ("tui.undo.result", "undo: {0}", "撤销：{0}"),
    (
        "tui.usage.none",
        "usage: no tokens recorded",
        "用量：暂无 token 记录",
    ),
    (
        "tui.usage.total",
        "usage: {0} total ({1} in / {2} out)",
        "用量：共 {0}（输入 {1} / 输出 {2}）",
    ),
    ("tui.usage.reportTotal", "total: {0}", "总计：{0}"),
    ("tui.usage.reportInput", "input: {0}", "输入：{0}"),
    ("tui.usage.reportOutput", "output: {0}", "输出：{0}"),
    (
        "tui.usage.context",
        "context: {0}/{1} tokens ({2}%)",
        "上下文：{0}/{1} tokens（{2}%）",
    ),
    (
        "tui.fork.usage",
        "usage: /fork <new-session-id>",
        "用法：/fork <新会话ID>",
    ),
    ("tui.fork.done", "forked to {0}", "已分叉到 {0}"),
    (
        "tui.steer.usage",
        "usage: /steer <text>",
        "用法：/steer <文本>",
    ),
    ("tui.steer.queued", "steer queued: {0}", "已排队引导：{0}"),
    (
        "tui.import.usage",
        "usage: /import <text>",
        "用法：/import <文本>",
    ),
    ("tui.import.done", "imported {0} chars", "已导入 {0} 个字符"),
    // ── Sessions / export / archive ─────────────────────────────────────
    ("tui.sessions.none", "no sessions", "没有会话"),
    (
        "tui.sessions.cancelled",
        "session selection cancelled",
        "已取消会话选择",
    ),
    ("tui.sessions.switched", "session: {0}", "会话：{0}"),
    (
        "tui.export.done",
        "exported to {0} ({1} bytes)",
        "已导出到 {0}（{1} 字节）",
    ),
    ("tui.err.exportWrite", "write failed: {0}", "写入失败：{0}"),
    (
        "tui.err.exportFailed",
        "export failed: {0}",
        "导出失败：{0}",
    ),
    ("tui.archive.ok", "session archived", "会话已归档"),
    ("tui.btw.usage", "/btw <question> — ask a side agent", "/btw <问题> —— 向旁路子代理提问"),
    (
        "tui.btw.started",
        "side agent {0} started — prompts route to it until /endbtw",
        "旁路子代理 {0} 已启动 —— 后续提问将路由给它，直到 /endbtw",
    ),
    (
        "tui.btw.alreadyActive",
        "a side agent is already active — run /endbtw first",
        "旁路子代理已激活 —— 请先运行 /endbtw",
    ),
    (
        "tui.btw.ended",
        "side agent ended — prompts route to the main session",
        "旁路子代理已结束 —— 提问恢复路由到主会话",
    ),
    (
        "tui.err.archiveNotFound",
        "archive: session not found",
        "归档：未找到该会话",
    ),
    (
        "tui.err.archiveFailed",
        "archive failed: {0}",
        "归档失败：{0}",
    ),
    (
        "tui.err.archiveNoSession",
        "archive: no active session",
        "归档：没有活动会话",
    ),
    // ── Auth ────────────────────────────────────────────────────────────
    ("tui.auth.already", "already logged in", "已登录"),
    (
        "tui.auth.openUrl",
        "open {0} and enter code {1}",
        "打开 {0} 并输入代码 {1}",
    ),
    ("tui.auth.abandoned", "login abandoned", "已放弃登录"),
    ("tui.auth.ok", "logged in", "已登录"),
    ("tui.err.loginFailed", "login failed: {0}", "登录失败：{0}"),
    ("tui.auth.loggedOut", "logged out", "已退出登录"),
    (
        "tui.err.logoutFailed",
        "logout failed: {0}",
        "退出登录失败：{0}",
    ),
    // ── Turn lifecycle ──────────────────────────────────────────────────
    ("tui.turn.cancelled", "turn cancelled", "已取消本轮"),
    (
        "tui.turn.exitConfirm",
        "press Ctrl-C again to exit",
        "再按一次 Ctrl-C 退出",
    ),
    (
        "tui.turn.summary",
        "… {0} tools · {1} messages",
        "… {0} 次工具调用 · {1} 条消息",
    ),
    ("tui.shell.done", "command finished", "命令执行完成"),
    (
        "tui.err.shellFailed",
        "shell failed: {0}",
        "命令执行失败：{0}",
    ),
    (
        "tui.paste.image",
        "pasted image #{0} (Alt-V)",
        "已粘贴图片 #{0}（Alt-V）",
    ),
    (
        "tui.paste.noImage",
        "no image on the clipboard",
        "剪贴板中没有图片",
    ),
    (
        "tui.discuss.usage",
        "usage: /discuss <topic> [with <role1>,<role2>,...] [--debate]",
        "用法：/discuss <话题> [with <角色1>,<角色2>,...] [--debate]",
    ),
    (
        "tui.discuss.needTopic",
        "discuss: need a topic",
        "讨论：需要一个话题",
    ),
    (
        "tui.discuss.needRoles",
        "discuss: need at least 2 roles",
        "讨论：至少需要 2 个角色",
    ),
    (
        "tui.err.discussSwarm",
        "could not enable swarm mode: {0}",
        "无法启用群组模式：{0}",
    ),
    (
        "tui.workflow.usage",
        "usage: /workflow list | <name> [args...] | status <runId> | cancel <runId>",
        "用法：/workflow list | <名称> [参数...] | status <运行ID> | cancel <运行ID>",
    ),
    (
        "tui.provider.none",
        "no providers configured",
        "没有配置任何提供商",
    ),
    ("tui.provider.select", "select a provider", "选择一个供应商"),
    ("tui.provider.cancelled", "provider selection cancelled", "已取消供应商选择"),
    ("tui.provider.list", "providers ({0}):", "提供商（{0}）："),
    ("tui.provider.keySet", "apiKey set", "已设置 apiKey"),
    ("tui.provider.keyMissing", "no apiKey", "无 apiKey"),
    (
        "tui.provider.removed",
        "removed provider {0}",
        "已移除提供商 {0}",
    ),
    (
        "tui.provider.usage",
        "usage: /provider [list|remove <name>|add]",
        "用法：/provider [list|remove <名称>|add]",
    ),
    (
        "tui.provider.addHint",
        "add a provider via /login or config.toml (providers.<name>)",
        "通过 /login 或 config.toml（providers.<名称>）添加提供商",
    ),
    (
        "tui.reloadTui.ok",
        "tui preferences reloaded",
        "界面偏好已重载",
    ),
    (
        "tui.editor.noEditor",
        "no editor configured (set $EDITOR)",
        "未配置编辑器（请设置 $EDITOR）",
    ),
    (
        "tui.err.editorFailed",
        "editor failed: {0}",
        "编辑器失败：{0}",
    ),
    (
        "tui.editor.usage",
        "usage: /editor <command> (e.g. code --wait)",
        "用法：/editor <命令>（如 code --wait）",
    ),
    ("tui.editor.set", "editor set to {0}", "编辑器已设为 {0}"),
    ("tui.editor.current", "editor: {0}", "编辑器：{0}"),
    // ── Locale ─────────────────────────────────────────────────────────
    (
        "tui.locale.usage",
        "usage: /locale <en|zh>",
        "用法：/locale <en|zh>",
    ),
    ("tui.locale.set", "locale set to {0}", "语言已设为 {0}"),
    ("tui.picker.selectLocale", "select a language", "选择语言"),
    (
        "tui.locale.cancelled",
        "locale selection cancelled",
        "已取消语言选择",
    ),
    ("tui.settings.model", "Switch model", "切换模型"),
    ("tui.settings.theme", "Set the theme", "设置主题"),
    (
        "tui.settings.editor",
        "Set the external editor",
        "设置外部编辑器",
    ),
    (
        "tui.settings.language",
        "Switch the UI language",
        "切换界面语言",
    ),
    (
        "tui.settings.permission",
        "Set permission mode",
        "设置权限模式",
    ),
    ("tui.picker.selectSetting", "settings", "设置"),
    ("tui.settings.cancelled", "settings closed", "已关闭设置"),
    // ── Chat chrome ─────────────────────────────────────────────────────
    ("tui.chat.title", "chat", "对话"),
    ("tui.chat.inputTitle", "input — {0}", "输入 — {0}"),
    ("tui.footer.model", "model: {0}", "模型：{0}"),
    ("tui.footer.ctx", "ctx: {0}%", "上下文：{0}%"),
    ("tui.footer.turns", "turns", "轮"),
    ("tui.footer.tipPrefix", "tip: {0}", "提示：{0}"),
    (
        "tui.tip.0",
        "Press Esc or Ctrl-C to cancel a running turn",
        "按 Esc 或 Ctrl-C 取消进行中的回合",
    ),
    (
        "tui.tip.1",
        "Type /help to list all commands",
        "输入 /help 列出全部命令",
    ),
    (
        "tui.tip.2",
        "Tab completes commands and arguments",
        "Tab 补全命令和参数",
    ),
    (
        "tui.tip.3",
        "Ctrl-O expands and collapses tool output",
        "Ctrl-O 展开/折叠工具输出",
    ),
    (
        "tui.tip.4",
        "Ctrl-U clears the input line",
        "Ctrl-U 清空输入行",
    ),
    (
        "tui.tip.5",
        "y = allow, n = deny when approvals are pending",
        "有待审批时 y=允许，n=拒绝",
    ),
    ("tui.picker.selectSkill", "select a skill", "选择一个技能"),
    ("tui.picker.selectModel", "select a model", "选择一个模型"),
    ("tui.picker.selectPlugin", "select a plugin", "选择一个插件"),
    ("tui.picker.selectAction", "select an action", "选择一个操作"),
    (
        "tui.picker.selectSession",
        "select a session",
        "选择一个会话",
    ),
    (
        "tui.picker.selectPermission",
        "select permission mode",
        "选择权限模式",
    ),
    (
        "tui.picker.resumeSession",
        "resume a session (Esc = new)",
        "恢复会话（Esc = 新建）",
    ),
    (
        "tui.picker.hint",
        "{0} — ↑/↓ pick · Enter select · Esc cancel",
        "{0} — ↑/↓ 选择 · Enter 确认 · Esc 取消",
    ),
    (
        "tui.picker.noMatch",
        "no match: {0}",
        "无匹配：{0}",
    ),
    // ── Command descriptions (completion popup / /help) ────────────────
    ("tui.cmd.quit", "Leave the chat", "退出聊天"),
    ("tui.cmd.exit", "Leave the chat", "退出聊天"),
    ("tui.cmd.help", "Show available commands", "显示可用命令"),
    (
        "tui.cmd.approvals",
        "List pending approvals",
        "列出待处理的审批",
    ),
    (
        "tui.cmd.approve",
        "Approve a pending approval",
        "批准一个待处理的审批",
    ),
    (
        "tui.cmd.deny",
        "Deny a pending approval",
        "拒绝一个待处理的审批",
    ),
    ("tui.cmd.status", "Show session status", "显示会话状态"),
    ("tui.cmd.info", "Show session info", "显示会话信息"),
    (
        "tui.cmd.session",
        "Show or rename the session",
        "显示或重命名会话",
    ),
    ("tui.cmd.plugins", "Manage plugins", "管理插件"),
    ("tui.cmd.config", "Show engine config", "显示引擎配置"),
    ("tui.cmd.skills", "List skills", "列出技能"),
    ("tui.cmd.plan", "Toggle plan mode", "切换计划模式"),
    (
        "tui.cmd.swarm",
        "Toggle swarm mode or run a task",
        "切换群组模式或运行任务",
    ),
    ("tui.cmd.thinking", "Set thinking effort", "设置思考强度"),
    ("tui.cmd.permission", "Set permission mode", "设置权限模式"),
    (
        "tui.cmd.yolo",
        "Auto-approve all tool calls",
        "自动批准所有工具调用",
    ),
    ("tui.cmd.auto", "Auto permission mode", "自动权限模式"),
    ("tui.cmd.new", "Start a fresh session", "开始新会话"),
    ("tui.cmd.init", "Generate AGENTS.md", "生成 AGENTS.md"),
    ("tui.cmd.title", "Rename the session", "重命名会话"),
    ("tui.cmd.mcp", "List MCP servers", "列出 MCP 服务器"),
    ("tui.cmd.tasks", "List background tasks", "列出后台任务"),
    (
        "tui.cmd.theme",
        "Toggle dark/light theme",
        "切换深色/浅色主题",
    ),
    ("tui.cmd.version", "Show version", "显示版本"),
    ("tui.cmd.models", "List models", "列出模型"),
    ("tui.cmd.model", "Switch model", "切换模型"),
    ("tui.cmd.reload", "Reload session state", "重载会话状态"),
    ("tui.cmd.resume", "Switch to a session", "切换到某个会话"),
    ("tui.cmd.goal", "Start or manage a goal", "开始或管理目标"),
    ("tui.cmd.goal-cancel", "Cancel the goal", "取消目标"),
    ("tui.cmd.goal-pause", "Pause the goal", "暂停目标"),
    ("tui.cmd.goal-resume", "Resume the goal", "恢复目标"),
    ("tui.cmd.goal-status", "Show goal status", "显示目标状态"),
    (
        "tui.cmd.add-dir",
        "Add an additional directory",
        "添加附加目录",
    ),
    ("tui.cmd.clear", "Clear session context", "清空会话上下文"),
    ("tui.cmd.compact", "Compact the conversation", "压缩对话"),
    ("tui.cmd.usage", "Show token usage", "显示 token 用量"),
    ("tui.cmd.undo", "Undo the last turn", "撤销上一轮"),
    ("tui.cmd.fork", "Fork the session", "分叉会话"),
    ("tui.cmd.steer", "Steer the active turn", "引导当前回合"),
    ("tui.cmd.import", "Import context", "导入上下文"),
    ("tui.cmd.sessions", "Switch sessions", "切换会话"),
    ("tui.cmd.export", "Export the session", "导出会话"),
    ("tui.cmd.archive", "Archive the session", "归档会话"),
    (
        "tui.cmd.btw",
        "Ask a forked side agent a question",
        "向旁路子代理提问",
    ),
    (
        "tui.cmd.endbtw",
        "End the side-question agent",
        "结束旁路子代理",
    ),
    (
        "tui.cmd.login",
        "Authenticate with a platform",
        "使用平台登录",
    ),
    (
        "tui.cmd.logout",
        "Log out of the current provider",
        "退出当前提供商登录",
    ),
    ("tui.cmd.locale", "Switch the UI language", "切换界面语言"),
    (
        "tui.cmd.editor",
        "Set the external editor (Ctrl-G)",
        "设置外部编辑器（Ctrl-G）",
    ),
    ("tui.cmd.settings", "Open the settings menu", "打开设置菜单"),
    (
        "tui.cmd.copy",
        "Copy the last assistant reply",
        "复制最近一条助手回复",
    ),
    (
        "tui.cmd.export-md",
        "Export the session as Markdown",
        "将会话导出为 Markdown",
    ),
    (
        "tui.cmd.discuss",
        "Run a multi-agent discussion",
        "运行多智能体讨论",
    ),
    (
        "tui.cmd.workflow",
        "Run or manage workflows",
        "运行或管理工作流",
    ),
    ("tui.cmd.provider", "Manage AI providers", "管理 AI 提供商"),
    (
        "tui.cmd.experiments",
        "Toggle experimental features",
        "实验性功能开关",
    ),
    (
        "tui.cmd.multi-llm",
        "Configure multi-LLM providers",
        "配置多 LLM 供应商",
    ),
    ("tui.cmd.feedback", "Send feedback", "发送反馈"),
    ("tui.cmd.web", "Open the web UI", "打开 Web UI"),
    (
        "tui.cmd.reload-tui",
        "Reload only the TUI preferences",
        "仅重载界面偏好",
    ),

    // ── CLI (shared with kimi-cli via `kimi_tui::i18n::t`) ─────────────
    ("cli.print.promptEmpty", "Prompt cannot be empty.", "提示不能为空。"),
    ("cli.print.modelEmpty", "Model cannot be empty.", "模型不能为空。"),
    (
        "cli.print.jsonStreamConflict",
        "--json and --output-format stream-json are mutually exclusive",
        "--json 与 --output-format stream-json 不能同时使用",
    ),
    (
        "cli.print.sessionIdRequired",
        "--session requires an id in prompt mode",
        "提示模式下 --session 需要指定 id",
    ),
    (
        "cli.print.resumeHint",
        "To resume this session: kimi resume {0}",
        "恢复此会话：kimi resume {0}",
    ),
    (
        "cli.provider.missingApiKey",
        "Missing API key. Pass --api-key <key> or set KIMI_REGISTRY_API_KEY.",
        "缺少 API 密钥。请传 --api-key <key> 或设置 KIMI_REGISTRY_API_KEY。",
    ),
    (
        "cli.web.tokenGenerated",
        "generated server.token at {0}",
        "已生成 server.token：{0}",
    ),
    (
        "cli.web.tokenPersistFailed",
        "could not persist server.token at {0}; running lenient",
        "无法持久化 server.token：{0}；以宽松模式运行",
    ),
    (
        "cli.chat.banner",
        "chat session {0} — type /help for commands",
        "聊天会话 {0} — 输入 /help 查看命令",
    ),
    (
        "cli.doctor.allValid",
        "All checked config files are valid.",
        "所有检查的配置文件均有效。",
    ),
    (
        "cli.doctor.issuesFound",
        "Kimi doctor found {0} issue{1}.",
        "Kimi doctor 发现 {0} 个问题。",
    ),
    (
        "cli.vis.notBundled",
        "the vis frontend ships with the TS distribution (npm wrapper) — not bundled in the Rust build",
        "vis 前端随 TS 分发提供（npm wrapper）——未包含在 Rust 构建中",
    ),

    // ── top-level option validation (TS `validateOptions` parity) ────────
    (
        "cli.opts.continueSessionConflict",
        "Cannot combine --continue, --session.",
        "不能同时使用 --continue 与 --session。",
    ),
    (
        "cli.opts.yoloAutoConflict",
        "Cannot combine --yolo with --auto.",
        "不能同时使用 --yolo 与 --auto。",
    ),
    (
        "cli.opts.promptYoloConflict",
        "Cannot combine --prompt with --yolo.",
        "不能同时使用 --prompt 与 --yolo。",
    ),
    (
        "cli.opts.promptAutoConflict",
        "Cannot combine --prompt with --auto.",
        "不能同时使用 --prompt 与 --auto。",
    ),
    (
        "cli.opts.promptPlanConflict",
        "Cannot combine --prompt with --plan.",
        "不能同时使用 --prompt 与 --plan。",
    ),
    (
        "cli.opts.outputFormatNotPrompt",
        "Output format is only supported in prompt mode.",
        "输出格式仅支持在提示模式下使用。",
    ),
    (
        "cli.opts.invalidOutputFormatEnv",
        "Invalid KIMI_MODEL_OUTPUT_FORMAT value \"{0}\". Expected one of: text, stream-json.",
        "无效的 KIMI_MODEL_OUTPUT_FORMAT 值 \"{0}\"。期望值为：text、stream-json。",
    ),

    // ── headless goal prefix (TS `parseHeadlessGoalCreate` parity) ───────
    (
        "cli.goal.provideObjective",
        "Provide a goal objective, e.g. `/goal Ship feature X`.",
        "请提供目标描述，例如：`/goal 实现功能 X`。",
    ),
    (
        "cli.goal.objectiveTooLong",
        "Goal objective is too long (max {0} characters). Reference long details by file path.",
        "目标描述过长（最多 {0} 个字符）。请通过文件路径引用详细内容。",
    ),

    // ── web token rotation (`kimi web rotate-token`, TS parity) ──────────
    (
        "cli.web.tokenRotated",
        "The previous token is now invalid. A running server picks up the new token automatically.",
        "之前的令牌已失效。运行中的服务器会自动使用新令牌。",
    ),
    (
        "cli.web.newToken",
        "New server token: {0}",
        "新的服务器令牌：{0}",
    ),

    // ── deprecated `kimi server` shim (TS `DEPRECATED_SERVER_NOTICE`) ─────
    (
        "cli.server.deprecated",
        "`kimi server` has been deprecated and no longer works.\n\
         Use `kimi web` instead — it runs the local server in the foreground and opens the web UI (`--no-open` to skip).\n\
         To stop a server started by a version before 0.28.0, use `kimi server kill`.\n\
         This notice will be removed in the next major version of Kimi Code.",
        "`kimi server` 已弃用，不再可用。\n\
         请改用 `kimi web`——它在前台运行本地服务器并打开 Web UI（可用 `--no-open` 跳过）。\n\
         如需停止 0.28.0 之前版本启动的服务器，请使用 `kimi server kill`。\n\
         此提示将在下一个主版本中移除。",
    ),

    // ── provider management output (TS `sub/provider.ts` parity) ──────────
    (
        "cli.provider.noProviders",
        "No providers configured.",
        "未配置任何提供商。",
    ),
    (
        "cli.provider.defaultModel",
        "Default model: {0}",
        "默认模型：{0}",
    ),
    (
        "cli.provider.catalogNoMatch",
        "No providers in catalog match \"{0}\".",
        "目录中没有匹配 \"{0}\" 的提供商。",
    ),
    (
        "cli.provider.catalogEmpty",
        "Catalog is empty.",
        "目录为空。",
    ),
    (
        "cli.provider.catalogProviderMissing",
        "Provider \"{0}\" not found in catalog at {1}.",
        "目录 {1} 中找不到提供商 \"{0}\"。",
    ),
    (
        "cli.provider.catalogModelNotIn",
        "Model \"{0}\" is not in provider \"{1}\". Run \"kimi provider catalog list {1}\" to see available ids.",
        "模型 \"{0}\" 不属于提供商 \"{1}\"。运行 \"kimi provider catalog list {1}\" 查看可用 id。",
    ),
    (
        "cli.provider.catalogNoModels",
        "Provider \"{0}\" lists no usable models in this catalog.",
        "提供商 \"{0}\" 在此目录中没有可用模型。",
    ),
    // ── clap help texts (`cli.help.*`) ───────────────────────────────────
    // `localize_cli_command` in kimi-cli overrides the derive doc comments
    // with these when the active locale is zh; English keeps the derive
    // docs verbatim, so these `en` values mirror them for reference/tests.
    ("cli.help.about", "Kimi Code CLI (Rust-first)", "Kimi Code CLI（Rust 优先）"),
    (
        "cli.help.arg.server",
        "Drive a separate server process (`kimi-server-serve`) over stdio instead of an embedded in-process server.",
        "通过 stdio 驱动独立服务进程（`kimi-server-serve`），而不是使用进程内嵌服务器。",
    ),
    (
        "cli.help.arg.session",
        "Resume an existing session: with no subcommand, enters the interactive TUI bound to that session. A value-less `-S`/`-r` opens the session picker.",
        "恢复已有会话：不带子命令时进入绑定该会话的交互式 TUI；不带值的 `-S`/`-r` 打开会话选择器。",
    ),
    (
        "cli.help.arg.prompt",
        "Run one prompt non-interactively (the documented `kimi --prompt \"...\"` form; `-p` as the first token still resolves to the `print` subcommand).",
        "以非交互方式运行一条提示（即文档中的 `kimi --prompt \"...\"` 形式；`-p` 作为首个参数仍通过别名解析到 `print` 子命令）。",
    ),
    (
        "cli.help.arg.continue",
        "Resume the most recently updated session in the current directory when entering the TUI.",
        "进入 TUI 时恢复当前目录中最近更新的会话。",
    ),
    (
        "cli.help.arg.yolo",
        "Enter the TUI in yolo mode (auto-approve).",
        "以 yolo 模式进入 TUI（自动批准）。",
    ),
    (
        "cli.help.arg.auto",
        "Enter the TUI in auto mode.",
        "以自动权限模式进入 TUI。",
    ),
    (
        "cli.help.arg.plan",
        "Enter the TUI in plan mode.",
        "以计划模式进入 TUI。",
    ),
    (
        "cli.help.arg.model",
        "Set the model for the session.",
        "设置会话的模型。",
    ),
    (
        "cli.help.arg.output-format",
        "Non-interactive output format; only used with `--prompt`/`-p` (defaults to `text`).",
        "非交互输出格式；仅与 `--prompt`/`-p` 一起使用（默认 `text`）。",
    ),
    (
        "cli.help.arg.add-dir",
        "Additional workspace directories to attach to the session (repeatable).",
        "为本会话附加额外的工作区目录（可重复）。",
    ),
    (
        "cli.help.arg.skills-dir",
        "Load skills from these directories instead of the auto-discovered user/project dirs (repeatable).",
        "从这些目录加载 skills，替代自动发现的用户和项目目录（可重复）。",
    ),
    ("cli.help.cmd.print", "Run one prompt non-interactively.", "以非交互方式运行一条提示。"),
    ("cli.help.cmd.sessions", "List persisted sessions.", "列出已持久化的会话。"),
    (
        "cli.help.cmd.resume",
        "Resume a session and run a prompt on it.",
        "恢复一个会话并对其运行提示。",
    ),
    (
        "cli.help.cmd.config",
        "Show the engine config (model/provider); with `--set`, write a value.",
        "显示引擎配置（模型/提供商）；配合 `--set` 写入值。",
    ),
    ("cli.help.cmd.doctor", "Environment + config diagnostics.", "环境与配置诊断。"),
    ("cli.help.cmd.health", "Engine health check.", "引擎健康检查。"),
    (
        "cli.help.cmd.export",
        "Export a session as a ZIP archive.",
        "将会话导出为 ZIP 归档。",
    ),
    (
        "cli.help.cmd.chat",
        "Interactive chat loop (stage-D prototype: plain text, no ratatui).",
        "交互式聊天循环（阶段 D 原型：纯文本，无 ratatui）。",
    ),
    (
        "cli.help.cmd.acp",
        "Serve the Agent Client Protocol (ACP) over stdio.",
        "通过 stdio 提供 Agent Client Protocol（ACP）服务。",
    ),
    (
        "cli.help.cmd.completions",
        "Generate a shell completion script.",
        "生成 shell 补全脚本。",
    ),
    (
        "cli.help.cmd.provider",
        "Provider management from the models.dev catalog.",
        "基于 models.dev 目录的提供商管理。",
    ),
    (
        "cli.help.cmd.login",
        "Log in via the kimi OAuth device flow.",
        "通过 kimi OAuth 设备码流程登录。",
    ),
    (
        "cli.help.cmd.logout",
        "Remove the kimi provider credentials from the engine config.",
        "从引擎配置中移除 kimi 提供商凭据。",
    ),
    (
        "cli.help.cmd.upgrade",
        "Update the CLI to the latest version (managed by the distribution).",
        "将 CLI 更新到最新版本（由分发机制管理）。",
    ),
    (
        "cli.help.cmd.migrate",
        "Migrate legacy kimi-cli data — a one-time step handled by the TS distribution.",
        "迁移旧 kimi-cli 数据——由 TS 分发处理的一次性步骤。",
    ),
    (
        "cli.help.cmd.web",
        "Launch the web UI server (the Rust `/api/v1` + WS surface; the SPA frontend is served from `--assets` when given).",
        "启动 Web UI 服务（Rust `/api/v1` + WS 接口；给定 `--assets` 时从此目录提供 SPA 前端）。",
    ),
    (
        "cli.help.cmd.vis",
        "Launch the visualization frontend (ships with the TS distribution).",
        "启动可视化前端（随 TS 分发提供）。",
    ),
    (
        "cli.help.cmd.server",
        "Deprecated — use `kimi web` instead.",
        "已弃用——请改用 `kimi web`。",
    ),
    ("cli.help.arg.prompt-text", "The prompt to run.", "要运行的提示。"),
    (
        "cli.help.arg.verbose",
        "Print engine events (progress/deltas) as they arrive.",
        "实时打印引擎事件（进度/增量）。",
    ),
    (
        "cli.help.arg.json",
        "Print the raw RPC result JSON instead of the rendered transcript.",
        "打印原始 RPC 结果 JSON，而不是渲染后的记录文本。",
    ),
    (
        "cli.help.arg.goal",
        "Create a goal on the session before prompting (goal mode).",
        "提示前在会话上创建目标（目标模式）。",
    ),
    (
        "cli.help.arg.session-model",
        "Set the session model before prompting.",
        "提示前设置会话模型。",
    ),
    (
        "cli.help.arg.plan-mode",
        "Enable plan mode before prompting.",
        "提示前启用计划模式。",
    ),
    (
        "cli.help.arg.print-continue",
        "Resume the most recently updated session instead of a fresh one (mutually exclusive with `-S <id>`/`-r <id>`).",
        "恢复最近更新的会话而不是新建（与 `-S <id>`/`-r <id>` 互斥）。",
    ),
    (
        "cli.help.arg.print-output-format",
        "Output format: `text` (default) or `stream-json` (JSONL).",
        "输出格式：`text`（默认）或 `stream-json`（JSONL）。",
    ),
    (
        "cli.help.arg.print-yolo",
        "Auto-approve tool calls (permission mode auto).",
        "自动批准工具调用（自动权限模式）。",
    ),
    (
        "cli.help.arg.print-auto",
        "Auto permission mode (mutually exclusive with --yolo).",
        "自动权限模式（与 --yolo 互斥）。",
    ),
    (
        "cli.help.arg.limit",
        "Max sessions to list.",
        "最多列出的会话数。",
    ),
    (
        "cli.help.arg.session-id",
        "Session id to resume.",
        "要恢复的会话 ID。",
    ),
    (
        "cli.help.arg.set",
        "Set a config value (repeatable), e.g. `--set defaultModel=kimi-k2` or `--set providers.anthropic.apiKey=sk-…`. Values are strings.",
        "设置配置值（可重复），如 `--set defaultModel=kimi-k2` 或 `--set providers.anthropic.apiKey=sk-…`。值为字符串。",
    ),
    (
        "cli.help.arg.delete",
        "Delete a config section entry (repeatable), e.g. `--delete providers.kimi` or `--delete models.kimi-k2`. Only section-level entries (`providers.<id>`, `models.<alias>`) can be removed.",
        "删除配置节条目（可重复），如 `--delete providers.kimi` 或 `--delete models.kimi-k2`。只能删除节级条目（`providers.<id>`、`models.<alias>`）。",
    ),
    ("cli.help.arg.path", "Path to the file (defaults to the first found).", "文件路径（默认使用找到的第一个）。"),
    ("cli.help.cmd.dt-config", "Validate a specific config.toml file.", "验证指定的 config.toml 文件。"),
    (
        "cli.help.cmd.dt-tui",
        "Validate a specific tui.toml file (syntax only).",
        "验证指定的 tui.toml 文件（仅语法）。",
    ),
    (
        "cli.help.arg.export-session-id",
        "Session id to export (defaults to the most recent session).",
        "要导出的会话 ID（默认最近的会话）。",
    ),
    (
        "cli.help.arg.export-output",
        "Output zip path (defaults to `<session_id>.zip` in the cwd).",
        "输出 zip 路径（默认当前目录下的 `<session_id>.zip`）。",
    ),
    (
        "cli.help.arg.export-yes",
        "Pick the most recent session without confirmation.",
        "不确认直接选择最近的会话。",
    ),
    (
        "cli.help.arg.include-global-log",
        "Include the global log file in the archive (default on).",
        "在归档中包含全局日志文件（默认开启）。",
    ),
    (
        "cli.help.arg.no-include-global-log",
        "Omit the global log file from the archive (the default is to include it; this flips that default off).",
        "从归档中排除全局日志文件（默认包含；此选项翻转默认值）。",
    ),
    (
        "cli.help.arg.chat-session",
        "Session id to reuse (defaults to a fresh `chat-<pid>` one).",
        "要复用的会话 ID（默认新建 `chat-<pid>` 会话）。",
    ),
    (
        "cli.help.arg.chat-continue",
        "Resume the most recently updated session instead of a fresh one.",
        "恢复最近更新的会话而不是新建。",
    ),
    (
        "cli.help.arg.chat-model",
        "Set the session model at startup.",
        "启动时设置会话模型。",
    ),
    (
        "cli.help.arg.acp-login",
        "Run the kimi OAuth login flow instead of serving.",
        "运行 kimi OAuth 登录流程而不是提供服务。",
    ),
    ("cli.help.arg.shell", "Target shell.", "目标 shell。"),
    ("cli.help.cmd.pv-list", "List configured providers (from the engine config; apiKey masked).", "列出已配置的提供商（来自引擎配置；apiKey 掩码显示）。"),
    (
        "cli.help.cmd.pv-add",
        "Import providers from a registry api.json URL (the model catalog is such a registry).",
        "从注册表 api.json URL 导入提供商（模型目录即此类注册表）。",
    ),
    (
        "cli.help.cmd.pv-remove",
        "Remove a provider from the engine config.",
        "从引擎配置中移除提供商。",
    ),
    (
        "cli.help.cmd.pv-catalog",
        "Browse the model catalog (models.dev) and import providers from it.",
        "浏览模型目录（models.dev）并从中导入提供商。",
    ),
    (
        "cli.help.arg.url",
        "Registry / catalog URL.",
        "注册表/目录 URL。",
    ),
    (
        "cli.help.arg.api-key",
        "API key for the imported providers (falls back to the env var when absent).",
        "导入提供商的 API key（缺省时回退到环境变量）。",
    ),
    (
        "cli.help.arg.provider-id",
        "Provider id (e.g. `openai`, `anthropic`, `kimi`).",
        "提供商 ID（如 `openai`、`anthropic`、`kimi`）。",
    ),
    (
        "cli.help.cmd.cat-list",
        "List catalog providers, optionally drilled into one.",
        "列出目录提供商，可选深入查看一个。",
    ),
    (
        "cli.help.cmd.cat-search",
        "Search catalog providers/models by keyword.",
        "按关键字搜索目录提供商/模型。",
    ),
    (
        "cli.help.cmd.cat-add",
        "Import one catalog provider into the engine config.",
        "将一个目录提供商导入引擎配置。",
    ),
    (
        "cli.help.arg.cat-provider-id",
        "Optional provider id to drill into (shows its models).",
        "可选的提供商 ID（显示其模型）。",
    ),
    (
        "cli.help.arg.cat-filter",
        "Case-insensitive id/name substring filter.",
        "不区分大小写的 id/名称子串过滤。",
    ),
    (
        "cli.help.arg.cat-url",
        "Catalog URL override (tests / mirrors).",
        "目录 URL 覆盖（测试/镜像）。",
    ),
    (
        "cli.help.arg.query",
        "Keyword to match against provider and model names.",
        "与提供商和模型名称匹配的关键字。",
    ),
    (
        "cli.help.arg.cat-id",
        "Catalog provider id (e.g. `openai`, `anthropic`).",
        "目录提供商 ID（如 `openai`、`anthropic`）。",
    ),
    (
        "cli.help.arg.cat-api-key",
        "API key (falls back to the provider's env var when absent).",
        "API key（缺省时回退到提供商的 env var）。",
    ),
    (
        "cli.help.arg.default-model",
        "Set this model as the engine default.",
        "将此模型设为引擎默认。",
    ),
    (
        "cli.help.arg.base-url",
        "Explicit base URL (required when the import resolution reports `needs-base-url`; wins over the catalog endpoint otherwise).",
        "显式 base URL（导入解析报告 `needs-base-url` 时必需；否则优先于目录端点）。",
    ),
    (
        "cli.help.arg.oauth-host",
        "Override the OAuth host (defaults to the kimi production server).",
        "覆盖 OAuth 主机（默认 kimi 生产服务器）。",
    ),
    (
        "cli.help.arg.max-polls",
        "Max poll attempts (default 180, ~5s apart ≈ 15 min — the device code validity window).",
        "最大轮询次数（默认 180，间隔约 5 秒 ≈ 15 分钟——设备码有效期窗口）。",
    ),
    (
        "cli.help.arg.port",
        "Port to serve on (default 58627).",
        "服务端口（默认 58627）。",
    ),
    (
        "cli.help.arg.host",
        "Host to bind (default 127.0.0.1).",
        "绑定主机（默认 127.0.0.1）。",
    ),
    (
        "cli.help.arg.dangerous-bypass-auth",
        "Disable bearer auth (dev mode).",
        "禁用 Bearer 认证（开发模式）。",
    ),
    (
        "cli.help.arg.no-open",
        "Do not open the browser automatically.",
        "不自动打开浏览器。",
    ),
    (
        "cli.help.arg.assets",
        "Serve the bundled SPA from this directory.",
        "从此目录提供打包的 SPA。",
    ),
    (
        "cli.help.arg.allowed-hosts",
        "Extra allowed Host headers / domain suffixes (DNS-rebinding allowlist).",
        "额外允许的 Host 头/域名后缀（DNS 反绑白名单）。",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_keys_are_unique() {
        let mut keys: Vec<&str> = MESSAGES.iter().map(|(k, _, _)| *k).collect();
        keys.sort_unstable();
        let dupes: Vec<&str> = keys
            .windows(2)
            .filter(|w| w[0] == w[1])
            .map(|w| w[0])
            .collect();
        assert!(dupes.is_empty(), "duplicate dictionary keys: {dupes:?}");
    }

    #[test]
    fn lookup_returns_locale_text() {
        assert_eq!(
            t_for(Locale::En, "tui.start.notLoggedIn"),
            "not logged in — type /login to authenticate"
        );
        assert_eq!(
            t_for(Locale::Zh, "tui.start.notLoggedIn"),
            "未登录 — 输入 /login 进行认证"
        );
    }

    #[test]
    fn lookup_missing_key_falls_back_to_key() {
        assert_eq!(
            t_for(Locale::En, "tui.does.not.exist"),
            "tui.does.not.exist"
        );
    }

    #[test]
    fn locale_parses() {
        assert_eq!(Locale::parse(Some("zh")), Locale::Zh);
        assert_eq!(Locale::parse(Some("en")), Locale::En);
        assert_eq!(Locale::parse(Some("fr")), Locale::En);
        assert_eq!(Locale::parse(None), Locale::En);
    }

    #[test]
    fn templates_fill_positionally() {
        let args = vec![
            "https://example.test/device".to_string(),
            "ABCD-EFGH".to_string(),
        ];
        assert_eq!(
            t_fmt_for(Locale::En, "tui.auth.openUrl", &args),
            "open https://example.test/device and enter code ABCD-EFGH"
        );
        assert_eq!(
            t_fmt_for(Locale::Zh, "tui.auth.openUrl", &args),
            "打开 https://example.test/device 并输入代码 ABCD-EFGH"
        );
    }
}
