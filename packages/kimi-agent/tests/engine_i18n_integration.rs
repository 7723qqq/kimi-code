//! Integration test: the engine's own user-facing text follows the host locale.
//!
//! The permission reasons, ACP approval labels and LLM error prefixes the Rust
//! engine emits are built as [`kimi_agent::i18n::LocalizedText`] — a stable key
//! plus interpolation params plus an English fallback. With no locale installed
//! they render the English fallback, which is what the ~2800 unit assertions in
//! `src/permission/mod.rs` observe; this file covers the *wired* path.
//!
//! It lives here rather than beside those unit tests because installing a
//! locale mutates process-wide state (`kimi_agent::i18n::set_engine_locale`).
//! Inside `src/lib.rs`'s unit-test binary that would race the parallel tests
//! asserting English reasons, so the locale-sensitive coverage gets its own
//! process.

#![cfg(feature = "cli")]

use kimi_agent::acp::permission::permission_options;
use kimi_agent::i18n::{clear_engine_locale, set_engine_locale};
use kimi_agent::permission::{PermissionEngine, PermissionMode, PolicySnapshot, VerdictDecision};
use serde_json::json;

/// Minimal locale pair: English is the fallback tree, Chinese the active one.
/// Only the keys under test are present — everything else must fall back.
const EN: &str = r#"{
    "engine": {
        "permission": {
            "sensitiveFileAccess": "Access to sensitive file requires approval: {{path}}",
            "toolExecutionRequiresApproval": "Tool execution requires approval: {{tool_name}}"
        },
        "tools": {
            "grep": { "noMatches": "No matches found for pattern: {{pattern}}" },
            "read": { "notExist": "\"{{path}}\" does not exist." },
            "edit": { "notExist": "\"{{path}}\" does not exist." }
        }
    }
}"#;

const ZH: &str = r#"{
    "engine": {
        "permission": {
            "sensitiveFileAccess": "访问敏感文件需要审批：{{path}}",
            "toolExecutionRequiresApproval": "工具执行需要审批：{{tool_name}}",
            "approveOnce": "批准一次",
            "approveForSession": "本次会话内批准",
            "reject": "拒绝"
        },
        "tools": {
            "grep": { "noMatches": "未找到匹配 {{pattern}} 的结果" },
            "read": { "notExist": "\"{{path}}\" 不存在。" },
            "edit": { "notExist": "\"{{path}}\" 不存在。" }
        }
    }
}"#;

/// Serializes the tests in this file.
///
/// Installing a locale mutates process-wide state, and the tests inside one
/// integration binary still run on parallel threads — without this, one test's
/// guard dropping would wipe the locale out from under another mid-assertion.
/// Every test here touches the global, so one lock covers the whole file.
static LOCALE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn locale_lock() -> std::sync::MutexGuard<'static, ()> {
    LOCALE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Restore the unwired state no matter how the test body exits.
struct LocaleGuard;

impl LocaleGuard {
    fn install_zh() -> Self {
        set_engine_locale(ZH.to_string(), EN.to_string());
        Self
    }
}

impl Drop for LocaleGuard {
    fn drop(&mut self) {
        clear_engine_locale();
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
fn a_key_missing_from_the_active_locale_falls_back_to_english() {
    let _lock = locale_lock();
    let _guard = LocaleGuard::install_zh();

    let engine = PermissionEngine::new(PolicySnapshot::default());

    // `engine.permission.highRiskShellCommand` is absent from both trees above,
    // so the reason must come back as the engine's own English fallback rather
    // than leaking the key or panicking.
    let verdict = engine.evaluate("Bash", &json!({ "command": "sudo reboot" }));
    assert_eq!(verdict.policy_name, "DangerousCommandAsk");
    assert_eq!(
        verdict.reason.as_deref(),
        Some("High-risk shell command requires approval")
    );
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
fn clearing_the_locale_restores_the_english_fallback() {
    let _lock = locale_lock();
    let engine = PermissionEngine::new(PolicySnapshot::default());

    {
        let _guard = LocaleGuard::install_zh();
        let verdict = engine.evaluate("Read", &json!({ "path": ".env" }));
        assert_eq!(
            verdict.reason.as_deref(),
            Some("访问敏感文件需要审批：.env")
        );
    }

    // The guard dropped: the engine is unwired again.
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
/// assertions throughout `src/tools/mod.rs`'s unit tests cover the unwired
/// fallback; this covers the wired path.
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
        grep.content.contains("未找到匹配"),
        "grep no-match message should be localized, got: {}",
        grep.content
    );

    // Read of a path that does not exist.
    let read = toolset
        .execute("Read", &json!({ "path": "no/such/file.txt" }))
        .expect("Read runs");
    assert!(
        read.content.contains("不存在"),
        "read not-found message should be localized, got: {}",
        read.content
    );
}

#[test]
fn native_tool_errors_stay_english_when_no_locale_is_installed() {
    let _lock = locale_lock();
    kimi_agent::i18n::clear_engine_locale();

    let dir = tempfile::tempdir().unwrap();
    let toolset =
        kimi_agent::tools::NativeToolset::new(dir.path().to_str().unwrap(), None).unwrap();

    let grep = toolset
        .execute("Grep", &json!({ "pattern": "zzz_no_such_pattern_zzz" }))
        .expect("Grep runs");
    assert!(
        grep.content.contains("No matches found for pattern"),
        "unwired engine must render the English fallback, got: {}",
        grep.content
    );
}
