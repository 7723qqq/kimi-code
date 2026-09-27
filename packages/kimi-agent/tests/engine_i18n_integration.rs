//! Integration test: the engine's own user-facing text follows the host locale.
//!
//! The permission reasons, ACP approval labels and tool-result errors the Rust
//! engine emits are built as [`kimi_agent::i18n::LocalizedText`] — a stable key
//! plus interpolation params, resolved against the catalog compiled into the
//! binary. With the default locale they render English, which is what the ~2800
//! unit assertions in `src/permission/mod.rs` observe; this file covers the
//! *switched* path.
//!
//! It lives here rather than beside those unit tests because naming a locale
//! mutates process-wide state (`kimi_agent::i18n::set_locale`). Inside
//! `src/lib.rs`'s unit-test binary that would race the parallel tests
//! asserting English reasons, so the locale-sensitive coverage gets its own
//! process.

#![cfg(feature = "cli")]

use kimi_agent::acp::permission::permission_options;
use kimi_agent::i18n::{Locale, set_locale};
use kimi_agent::permission::{PermissionEngine, PermissionMode, PolicySnapshot, VerdictDecision};
use serde_json::json;

/// Serializes the tests in this file.
///
/// Naming a locale mutates process-wide state, and the tests inside one
/// integration binary still run on parallel threads — without this, one test's
/// guard dropping would wipe the locale out from under another mid-assertion.
/// Every test here touches the global, so one lock covers the whole file.
static LOCALE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn locale_lock() -> std::sync::MutexGuard<'static, ()> {
    LOCALE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Restore English no matter how the test body exits.
struct LocaleGuard;

impl LocaleGuard {
    fn install_zh() -> Self {
        set_locale(Locale::Zh);
        Self
    }
}

impl Drop for LocaleGuard {
    fn drop(&mut self) {
        set_locale(Locale::En);
    }
}

#[test]
fn permission_reasons_render_in_the_active_locale() {
    let _lock = locale_lock();
    let _guard = LocaleGuard::install_zh();

    let engine = PermissionEngine::new(PolicySnapshot {
        mode: PermissionMode::Manual,
        ..Default::default()
    });

    // SensitiveFileAccessAsk — interpolates `path`.
    let verdict = engine.evaluate("Read", &json!({ "path": ".env" }));
    assert_eq!(verdict.decision, VerdictDecision::Ask);
    assert_eq!(verdict.policy_name, "SensitiveFileAccessAsk");
    assert_eq!(
        verdict.reason.as_deref(),
        Some("访问敏感文件需要审批：.env")
    );

    // FallbackAsk — interpolates the tool name.
    let verdict = engine.evaluate("SomeUnknownTool", &json!({}));
    assert_eq!(verdict.policy_name, "FallbackAsk");
    assert_eq!(
        verdict.reason.as_deref(),
        Some("工具执行需要审批：SomeUnknownTool")
    );
}

#[test]
fn the_english_catalog_answers_the_same_reasons() {
    let _lock = locale_lock();
    set_locale(Locale::En);

    let engine = PermissionEngine::new(PolicySnapshot::default());

    // The same key, resolved against `en` — the pair is what proves the
    // switching above is the catalog doing the work rather than a second
    // hardcoded copy in the engine.
    let verdict = engine.evaluate("Read", &json!({ "path": ".env" }));
    assert_eq!(
        verdict.reason.as_deref(),
        Some("Access to sensitive file requires approval: .env")
    );
}

#[test]
fn a_key_present_in_both_catalogs_renders_in_the_active_locale() {
    let _lock = locale_lock();
    let _guard = LocaleGuard::install_zh();

    let engine = PermissionEngine::new(PolicySnapshot::default());

    // `engine.permission.highRiskShellCommand` carries no `{{placeholder}}`, so
    // the rendered reason is the catalog entry verbatim. Both embedded catalogs
    // define it — `catalog.rs`'s `zh_covers_every_key_en_covers` guarantees
    // that — so this asserts the Chinese one, not an English fallback.
    let verdict = engine.evaluate("Bash", &json!({ "command": "sudo reboot" }));
    assert_eq!(verdict.policy_name, "DangerousCommandAsk");
    assert_eq!(verdict.reason.as_deref(), Some("高风险 shell 命令需要审批"));
}

#[test]
fn acp_approval_labels_render_in_the_active_locale() {
    let _lock = locale_lock();
    let _guard = LocaleGuard::install_zh();

    let options = permission_options();
    let names: Vec<&str> = options
        .as_array()
        .expect("permission_options must be a JSON array")
        .iter()
        .filter_map(|o| o["name"].as_str())
        .collect();

    // The labels are the `zh` catalog entries verbatim. The `kind` values below
    // are protocol tokens, not messages, and stay English.
    assert_eq!(names, vec!["批准一次", "本次会话内批准", "拒绝"]);

    // The `kind` discriminators are what `decision_from_response` matches on, so
    // translating the label must not disturb them.
    let kinds: Vec<&str> = options
        .as_array()
        .expect("permission_options must be a JSON array")
        .iter()
        .filter_map(|o| o["kind"].as_str())
        .collect();
    assert_eq!(kinds, vec!["allow_once", "allow_always", "reject_once"]);
}

#[test]
fn switching_to_english_switches_back() {
    let _lock = locale_lock();
    let engine = PermissionEngine::new(PolicySnapshot::default());

    {
        let _guard = LocaleGuard::install_zh();
        let verdict = engine.evaluate("Read", &json!({ "path": ".env" }));
        assert_ne!(
            verdict.reason.as_deref(),
            Some("Access to sensitive file requires approval: .env")
        );
    }

    // The guard dropped: the process-wide locale is back on English.
    let verdict = engine.evaluate("Read", &json!({ "path": ".env" }));
    assert_eq!(
        verdict.reason.as_deref(),
        Some("Access to sensitive file requires approval: .env")
    );
}

// ---------------------------------------------------------------------------
// Native tool output
// ---------------------------------------------------------------------------

/// The tool-result strings a user reads when something fails. The English
/// assertions throughout `src/tools/mod.rs`'s unit tests cover the default
/// locale; this covers the switched one.
#[test]
fn native_tool_errors_follow_the_active_locale() {
    let _lock = locale_lock();
    let _guard = LocaleGuard::install_zh();

    let dir = tempfile::tempdir().unwrap();
    let toolset =
        kimi_agent::tools::NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();

    // Grep with no matches.
    let grep = toolset
        .execute("Grep", &json!({ "pattern": "zzz_no_such_pattern_zzz" }))
        .expect("Grep runs");
    assert!(
        !grep.content.contains("No matches found for pattern"),
        "a Chinese session must not render the English catalog entry, got: {}",
        grep.content
    );

    // Read of a path that does not exist.
    let read = toolset
        .execute("Read", &json!({ "path": "no/such/file.txt" }))
        .expect("Read runs");
    assert!(
        !read.content.contains("does not exist"),
        "a Chinese session must not render the English catalog entry, got: {}",
        read.content
    );
}

#[test]
fn the_default_locale_is_english() {
    let _lock = locale_lock();
    set_locale(Locale::En);

    let dir = tempfile::tempdir().unwrap();
    let toolset =
        kimi_agent::tools::NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();

    let grep = toolset
        .execute("Grep", &json!({ "pattern": "zzz_no_such_pattern_zzz" }))
        .expect("Grep runs");
    assert!(
        grep.content.contains("No matches found for pattern"),
        "the default locale must render the embedded English catalog, got: {}",
        grep.content
    );
}
