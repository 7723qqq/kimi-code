//! Engine-side i18n — locale-aware rendering of the engine's own user-facing text.
//!
//! The translation engine itself lives in [`crate::native::translation`]. This
//! module is the seam that lets the engine's own messages (permission reasons,
//! tool-result notes, error prefixes, ACP approval labels) participate in the
//! host's locale instead of being hardcoded English.
//!
//! # Why a synchronous, in-process lookup
//!
//! Under napi the engine cannot call back into JavaScript synchronously — every
//! `HostCallbacks` method is an async `BoxFuture` precisely because a
//! Rust→JS hop must go through a threadsafe function. A translator that
//! round-trips to the host would therefore be unusable from the two places that
//! need it most: `permission::evaluate`, a synchronous pure function that
//! produces the majority of permission reasons, and `LlmError`'s `Display`
//! implementation, which can never await.
//!
//! So the host hands its locale JSON over once and the engine resolves keys
//! locally against a cached parse. Rendering is a pure in-memory lookup, which
//! makes it callable from any context, sync or async.
//!
//! # The English fallback
//!
//! Every [`LocalizedText`] carries an English rendering alongside its key. A
//! host that never wired a locale — the standalone REPL, an ACP client without
//! i18n, unit tests — still produces correct English rather than a bare key
//! leaking into a transcript. The trade-off is that the Rust-side English and
//! the `en` locale entry are two copies of one sentence; that drift is what the
//! parity check (`scripts/check-engine-i18n-parity.mjs`) exists to catch.
//!
//! # Process-wide instance
//!
//! [`set_engine_locale`] installs the locale for the whole process, mirroring
//! how the TypeScript side models locale as module-level state and how
//! `native::napi_bindings` already keeps a process-wide `CachedTranslator`.
//! Tests and embedders that hold their own [`EngineI18n`] use
//! [`LocalizedText::render_with`] instead, so they never touch the global.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock, RwLockReadGuard};

use crate::native::translation::CachedTranslator;

/// Build a `HashMap<String, String>` of interpolation parameters for
/// [`LocalizedText::fmt`].
///
/// Values may be anything `Display`, so call sites do not have to pre-stringify
/// paths, counts or rule names.
///
/// ```
/// use kimi_agent::i18n::i18n_params;
/// let params = i18n_params!["path" => "/etc/hosts", "count" => 3];
/// assert_eq!(params["path"], "/etc/hosts");
/// assert_eq!(params["count"], "3");
/// ```
#[macro_export]
macro_rules! i18n_params {
    ($($name:literal => $value:expr),+ $(,)?) => {{
        let mut map: ::std::collections::HashMap<String, String> = ::std::collections::HashMap::new();
        $( map.insert($name.to_string(), $value.to_string()); )+
        map
    }};
}

// `#[macro_export]` places the macro at the crate root; re-export it here so
// call sites can reach it through the `i18n` module path as well.
pub use i18n_params;

/// The host's active locale, held as the JSON message trees the host supplied.
///
/// `locale_json` is the active language; `fallback_json` is what a key missing
/// from the active language falls back to (English). The engine never invents
/// locale data — an unset instance simply renders English fallbacks.
#[derive(Default)]
pub struct EngineI18n {
    locale_json: String,
    fallback_json: String,
    translator: CachedTranslator,
}

impl std::fmt::Debug for EngineI18n {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `CachedTranslator` holds a parsed-JSON cache that is not worth
        // printing, and it does not implement `Debug`; reporting whether a
        // locale is installed is the only interesting state.
        f.debug_struct("EngineI18n")
            .field("is_set", &self.is_set())
            .finish()
    }
}

impl EngineI18n {
    /// An unwired instance: every message renders its English fallback.
    pub fn unset() -> Self {
        Self::default()
    }

    /// A wired instance serving `locale_json` with `fallback_json` behind it.
    pub fn new(locale_json: String, fallback_json: String) -> Self {
        Self {
            locale_json,
            fallback_json,
            translator: CachedTranslator::new(),
        }
    }

    /// Whether a locale has been installed.
    pub fn is_set(&self) -> bool {
        !self.locale_json.is_empty()
    }

    /// Replace the active locale, evicting the parsed-JSON cache so no stale
    /// tree survives the switch.
    pub fn set_locale(&mut self, locale_json: String, fallback_json: String) {
        self.locale_json = locale_json;
        self.fallback_json = fallback_json;
        self.translator.clear_cache();
    }

    /// Drop the active locale; messages render their English fallback again.
    pub fn clear(&mut self) {
        self.locale_json.clear();
        self.fallback_json.clear();
        self.translator.clear_cache();
    }

    /// Resolve `key` against the active locale, then the fallback.
    ///
    /// `None` means either "no locale installed" or "the key is missing from
    /// both trees" — the caller falls back to English in both cases, so the two
    /// are deliberately not distinguished.
    pub fn translate(&self, key: &str, params: Option<&HashMap<String, String>>) -> Option<String> {
        if !self.is_set() {
            return None;
        }
        // `translation::translate` returns the key itself on a miss. That is the
        // established miss signal across the crate's i18n surface, so compare
        // against it rather than re-resolving both trees here.
        let rendered =
            self.translator
                .translate(&self.locale_json, &self.fallback_json, key, params);
        if rendered == key {
            None
        } else {
            Some(rendered)
        }
    }

    /// Render `text` against this instance.
    pub fn render(&self, text: &LocalizedText) -> String {
        match self.translate(text.key, Some(&text.params)) {
            Some(rendered) => rendered,
            None => text.fallback_en.clone(),
        }
    }
}

/// A user-facing message the engine produces as a stable key plus interpolation
/// parameters, with an English rendering carried alongside for the unwired case.
#[derive(Debug, Clone)]
pub struct LocalizedText {
    key: &'static str,
    params: HashMap<String, String>,
    fallback_en: String,
}

impl LocalizedText {
    /// A message with no interpolation parameters.
    pub fn plain(key: &'static str, en: &str) -> Self {
        Self {
            key,
            params: HashMap::new(),
            fallback_en: en.to_string(),
        }
    }

    /// A message whose `en` rendering already has its parameters substituted,
    /// paired with the same parameters for the localized rendering.
    pub fn fmt(key: &'static str, en: String, params: HashMap<String, String>) -> Self {
        Self {
            key,
            params,
            fallback_en: en,
        }
    }

    /// The locale key this message resolves to.
    pub fn key(&self) -> &'static str {
        self.key
    }

    /// Render against the process-wide locale installed by
    /// [`set_engine_locale`].
    pub fn render(&self) -> String {
        engine_i18n().render(self)
    }

    /// Render against an explicit instance. Prefer this in tests and in
    /// embedders that own their [`EngineI18n`], so they never observe — or
    /// disturb — the process-wide locale.
    pub fn render_with(&self, i18n: &EngineI18n) -> String {
        i18n.render(self)
    }
}

// ---------------------------------------------------------------------------
// Process-wide locale
// ---------------------------------------------------------------------------

static ENGINE_I18N: OnceLock<RwLock<EngineI18n>> = OnceLock::new();

fn engine_i18n_slot() -> &'static RwLock<EngineI18n> {
    ENGINE_I18N.get_or_init(|| RwLock::new(EngineI18n::unset()))
}

/// A poisoned lock still holds a consistent `EngineI18n` (its fields are only
/// ever replaced wholesale), so recovering the guard is safe and keeps a panic
/// in one thread from wedging every later render.
fn read_guard(lock: &'static RwLock<EngineI18n>) -> RwLockReadGuard<'static, EngineI18n> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn engine_i18n() -> RwLockReadGuard<'static, EngineI18n> {
    read_guard(engine_i18n_slot())
}

/// Install the host's active locale for the whole process.
///
/// `fallback_json` is the language a key missing from `locale_json` resolves
/// against — English in this project.
pub fn set_engine_locale(locale_json: String, fallback_json: String) {
    let mut guard = engine_i18n_slot()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.set_locale(locale_json, fallback_json);
}

/// Drop the active locale; messages render their English fallback again.
pub fn clear_engine_locale() {
    let mut guard = engine_i18n_slot()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.clear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const EN: &str = r#"{
        "engine": {
            "permission": {
                "deniedByRule": "Denied by user rule: {{rule}}: {{why}}",
                "sensitiveFile": "Access to sensitive file requires approval: {{path}}"
            },
            "uninterpolated": "Plain engine message"
        }
    }"#;

    const ZH: &str = r#"{
        "engine": {
            "permission": {
                "deniedByRule": "已被用户规则拒绝：{{rule}}：{{why}}"
            }
        }
    }"#;

    fn wired() -> EngineI18n {
        EngineI18n::new(ZH.to_string(), EN.to_string())
    }

    fn denied_by_rule() -> LocalizedText {
        LocalizedText::fmt(
            "engine.permission.deniedByRule",
            "Denied by user rule: my-rule: too risky".to_string(),
            i18n_params!["rule" => "my-rule", "why" => "too risky"],
        )
    }

    // ── unwired ─────────────────────────────────────────────────────────

    #[test]
    fn unset_instance_renders_the_english_fallback() {
        let text = denied_by_rule();
        assert_eq!(
            text.render_with(&EngineI18n::unset()),
            "Denied by user rule: my-rule: too risky"
        );
    }

    #[test]
    fn unset_instance_renders_plain_english() {
        let text = LocalizedText::plain("engine.uninterpolated", "Plain engine message");
        assert_eq!(
            text.render_with(&EngineI18n::unset()),
            "Plain engine message"
        );
    }

    #[test]
    fn default_is_unset() {
        assert!(!EngineI18n::default().is_set());
        assert!(!EngineI18n::unset().is_set());
    }

    // ── wired ───────────────────────────────────────────────────────────

    #[test]
    fn wired_instance_renders_the_active_locale() {
        assert_eq!(
            denied_by_rule().render_with(&wired()),
            "已被用户规则拒绝：my-rule：too risky"
        );
    }

    #[test]
    fn wired_instance_interpolates_params() {
        let text = LocalizedText::fmt(
            "engine.permission.sensitiveFile",
            "Access to sensitive file requires approval: /etc/hosts".to_string(),
            i18n_params!["path" => "/etc/hosts"],
        );
        assert_eq!(
            text.render_with(&wired()),
            "Access to sensitive file requires approval: /etc/hosts"
        );
    }

    #[test]
    fn key_missing_in_active_locale_falls_back_to_the_fallback_language() {
        // `engine.uninterpolated` exists only in EN.
        let text = LocalizedText::plain("engine.uninterpolated", "Plain engine message");
        assert_eq!(text.render_with(&wired()), "Plain engine message");
    }

    #[test]
    fn key_missing_everywhere_falls_back_to_english() {
        let text = LocalizedText::plain("engine.nosuchkey", "Never translated");
        assert_eq!(text.render_with(&wired()), "Never translated");
    }

    #[test]
    fn translate_returns_none_on_a_miss() {
        let i18n = wired();
        assert!(i18n.translate("engine.nosuchkey", None).is_none());
        assert!(
            i18n.translate("engine.permission.deniedByRule", None)
                .is_some()
        );
        assert!(
            EngineI18n::unset()
                .translate("engine.permission.deniedByRule", None)
                .is_none()
        );
    }

    // ── locale switching ────────────────────────────────────────────────

    #[test]
    fn set_locale_switches_the_active_language() {
        let mut i18n = wired();
        assert_eq!(
            denied_by_rule().render_with(&i18n),
            "已被用户规则拒绝：my-rule：too risky"
        );

        i18n.set_locale(EN.to_string(), EN.to_string());
        assert_eq!(
            denied_by_rule().render_with(&i18n),
            "Denied by user rule: my-rule: too risky"
        );
    }

    #[test]
    fn set_locale_evicts_the_previous_parse() {
        let mut i18n = EngineI18n::new(ZH.to_string(), EN.to_string());
        let first = denied_by_rule().render_with(&i18n);
        // Re-point the same JSON string at different content: without a cache
        // clear the stale tree would keep answering.
        i18n.set_locale(EN.to_string(), EN.to_string());
        let second = denied_by_rule().render_with(&i18n);
        assert_ne!(first, second);
        assert_eq!(second, "Denied by user rule: my-rule: too risky");
    }

    #[test]
    fn clear_returns_to_the_english_fallback() {
        let mut i18n = wired();
        assert_eq!(
            denied_by_rule().render_with(&i18n),
            "已被用户规则拒绝：my-rule：too risky"
        );
        i18n.clear();
        assert!(!i18n.is_set());
        assert_eq!(
            denied_by_rule().render_with(&i18n),
            "Denied by user rule: my-rule: too risky"
        );
    }

    // ── params macro ────────────────────────────────────────────────────

    #[test]
    fn params_macro_accepts_many_display_types() {
        let params = i18n_params![
            "path" => "/etc/hosts",
            "count" => 3,
            "ratio" => 0.5,
            "flag" => true,
        ];
        assert_eq!(params.len(), 4);
        assert_eq!(params["path"], "/etc/hosts");
        assert_eq!(params["count"], "3");
        assert_eq!(params["ratio"], "0.5");
        assert_eq!(params["flag"], "true");
    }

    #[test]
    fn key_accessor_exposes_the_locale_key() {
        let text = LocalizedText::plain("engine.uninterpolated", "Plain engine message");
        assert_eq!(text.key(), "engine.uninterpolated");
    }

    // ── process-wide locale ─────────────────────────────────────────────
    //
    // Every other test in this module renders against an explicit
    // `EngineI18n`, so they never observe the process-wide instance and this
    // one is free to install and tear down a locale without racing them.

    #[test]
    fn process_wide_locale_round_trips_through_the_public_seam() {
        // Unset by default.
        assert_eq!(
            denied_by_rule().render(),
            "Denied by user rule: my-rule: too risky"
        );

        set_engine_locale(ZH.to_string(), EN.to_string());
        assert_eq!(
            denied_by_rule().render(),
            "已被用户规则拒绝：my-rule：too risky"
        );

        // Switching the process-wide locale takes effect immediately.
        set_engine_locale(EN.to_string(), EN.to_string());
        assert_eq!(
            denied_by_rule().render(),
            "Denied by user rule: my-rule: too risky"
        );

        clear_engine_locale();
        assert_eq!(
            denied_by_rule().render(),
            "Denied by user rule: my-rule: too risky"
        );
    }

    #[test]
    fn empty_locale_json_is_treated_as_unset() {
        set_engine_locale(String::new(), EN.to_string());
        assert!(!engine_i18n().is_set());
        assert_eq!(
            denied_by_rule().render(),
            "Denied by user rule: my-rule: too risky"
        );
    }
}
