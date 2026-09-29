//! Engine-side i18n — locale-aware rendering of the engine's own user-facing text.
//!
//! The message trees live in [`crate::native::catalog`], compiled into the
//! binary from `locales/{en,zh}.json`. This module is the seam that lets the
//! engine's own messages (permission reasons, tool-result notes, error
//! prefixes, ACP approval labels) render in the host's locale instead of being
//! hardcoded English.
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
//! So the host names a locale once with [`set_locale`] and the engine resolves
//! keys locally. Rendering is a pure in-memory lookup, which makes it callable
//! from any context, sync or async.
//!
//! # One English source
//!
//! A [`LocalizedText`] names a key; the sentence comes from the embedded `en`
//! catalog. That is the same entry the host's own `t()` resolves through, so
//! there is no second copy of the English in Rust to drift from — a key that
//! resolves nowhere renders as the bare key instead, which
//! `scripts/check-engine-i18n-parity.mjs` fails the build on.
//!
//! # Process-wide instance
//!
//! [`set_locale`] names the locale that both [`LocalizedText::render`] and
//! [`EngineI18n::translate_embedded`] read, mirroring how the TypeScript side
//! models locale as module-level state. It is the same slot the napi
//! `setEngineLocale` binding writes, so the engine's own text and the host's
//! `t()` can never disagree about the language.
//!
//! Tests and embedders that hold their own [`EngineI18n`] use
//! [`LocalizedText::render_with`] instead, so they never touch the global.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock, RwLockReadGuard};

pub use crate::native::catalog::Locale;
use crate::native::catalog::{lookup, table};

/// Build a `HashMap<String, String>` of interpolation parameters for
/// [`LocalizedText::with_params`].
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

/// The host's active locale.
///
/// `active` is the language [`EngineI18n::translate_embedded`] resolves against,
/// with the embedded `en` catalog behind it. There is nothing else to install:
/// the trees are compiled into the binary, so an instance carries a choice, not
/// a payload.
#[derive(Default)]
pub struct EngineI18n {
    pub(crate) active: Locale,
}

impl std::fmt::Debug for EngineI18n {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineI18n")
            .field("active", &self.active)
            .finish()
    }
}

impl EngineI18n {
    /// Resolve `key` against the embedded catalog, then English.
    ///
    /// `None` means the key is in neither embedded tree; the caller renders the
    /// key itself, which is how a typo surfaces instead of hiding.
    pub fn translate_embedded(
        &self,
        key: &str,
        params: Option<&HashMap<String, String>>,
    ) -> Option<String> {
        let template = lookup(self.active, key).or_else(|| lookup(Locale::En, key))?;
        Some(crate::native::catalog::interpolate(
            template,
            params.unwrap_or(&HashMap::new()),
        ))
    }

    /// Every key the embedded `en` catalog resolves.
    pub fn embedded_keys(&self) -> impl Iterator<Item = &'static str> {
        table(Locale::En).keys().map(String::as_str)
    }

    /// Render `text` against this instance. An unknown key renders as the key
    /// itself — the catalog is embedded, so there is no third fallback left.
    pub fn render(&self, text: &LocalizedText) -> String {
        match self.translate_embedded(text.key, Some(&text.params)) {
            Some(rendered) => rendered,
            None => text.key.to_string(),
        }
    }
}

/// A user-facing message the engine produces as a stable key plus interpolation
/// parameters. The sentence for every locale comes from the embedded catalog.
#[derive(Debug, Clone)]
pub struct LocalizedText {
    key: &'static str,
    params: HashMap<String, String>,
}

impl LocalizedText {
    /// A message with no interpolation parameters.
    pub fn new(key: &'static str) -> Self {
        Self {
            key,
            params: HashMap::new(),
        }
    }

    /// A message whose template carries `{{name}}` placeholders.
    pub fn with_params(key: &'static str, params: HashMap<String, String>) -> Self {
        Self { key, params }
    }

    /// The locale key this message resolves to.
    pub fn key(&self) -> &'static str {
        self.key
    }

    /// Render against the process-wide locale installed by [`set_locale`].
    pub fn render(&self) -> String {
        engine_i18n().render(self)
    }

    /// Render against an explicit instance, so tests and embedders never touch
    /// the process-wide locale.
    pub fn render_with(&self, i18n: &EngineI18n) -> String {
        i18n.render(self)
    }
}

// ---------------------------------------------------------------------------
// Process-wide locale
// ---------------------------------------------------------------------------

static ENGINE_I18N: OnceLock<RwLock<EngineI18n>> = OnceLock::new();

fn engine_i18n_slot() -> &'static RwLock<EngineI18n> {
    ENGINE_I18N.get_or_init(RwLock::default)
}

/// A poisoned lock still holds a consistent `EngineI18n` (its single field is
/// replaced wholesale), so recovering the guard is safe and keeps a panic in
/// one thread from wedging every later render.
fn read_guard(lock: &'static RwLock<EngineI18n>) -> RwLockReadGuard<'static, EngineI18n> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn engine_i18n() -> RwLockReadGuard<'static, EngineI18n> {
    read_guard(engine_i18n_slot())
}

/// Name the process-wide locale, the path both [`LocalizedText::render`] and
/// [`EngineI18n::translate_embedded`] read.
///
/// This is what the napi `setEngineLocale` binding calls, so the engine's own
/// messages and the host's `t()` resolve against one locale rather than two
/// that could disagree.
pub fn set_locale(locale: Locale) {
    let mut guard = engine_i18n_slot()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.active = locale;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// These render against an explicit `EngineI18n` rather than the process-wide
// instance, so they never observe — or disturb — the locale a host installs.

#[cfg(test)]
mod tests {
    use super::*;

    fn text() -> LocalizedText {
        LocalizedText::with_params(
            "engine.permission.deniedByUserRule",
            i18n_params!["rule" => "my-rule", "why" => "too risky"],
        )
    }

    #[test]
    fn default_locale_renders_english_from_the_embedded_catalog() {
        let out = text().render_with(&EngineI18n::default());
        assert!(out.contains("my-rule") && out.contains("too risky"));
        assert_ne!(out, "engine.permission.deniedByUserRule");
    }

    #[test]
    fn the_zh_catalog_renders_chinese() {
        let zh = EngineI18n { active: Locale::Zh };
        let out = text().render_with(&zh);
        assert!(out.contains("my-rule") && out.contains("too risky"));
        assert_ne!(out, "engine.permission.deniedByUserRule");
    }

    /// Covers the `or_else(|| lookup(Locale::En, key))` arm of
    /// [`EngineI18n::translate_embedded`].
    ///
    /// The arm only fires for a key the *active* locale lacks, and `zh` is a
    /// superset of `en`, so no catalog key can reach it — there is no honest
    /// way to execute it through the public API. What can be tested is the
    /// guard that keeps it dormant, from the rendering side: every key `en`
    /// resolves must also resolve in `zh`. A future locale that ships a partial
    /// catalog fails here, at the point the fallback would start shadowing it.
    ///
    /// The second half pins the other direction — the active locale still wins
    /// for a key whose two translations differ, so the arm cannot be taken
    /// silently by a catalog that happens to agree.
    #[test]
    fn the_english_fallback_arm_needs_a_key_the_active_locale_lacks() {
        let zh = EngineI18n { active: Locale::Zh };
        for key in zh.embedded_keys() {
            assert!(
                lookup(Locale::Zh, key).is_some(),
                "zh must define {key}, or the en arm starts shadowing zh"
            );
        }

        let key = "engine.permission.deniedByUserRule";
        let en = lookup(Locale::En, key).expect("en defines the key");
        let zh_text = lookup(Locale::Zh, key).expect("zh defines the key");
        assert_ne!(en, zh_text, "the two catalogs must differ for this to bite");
        assert_eq!(zh.translate_embedded(key, None).as_deref(), Some(zh_text));
    }

    #[test]
    fn an_unknown_key_renders_as_the_key() {
        let bogus = LocalizedText::new("engine.definitely.not.a.key");
        assert_eq!(
            bogus.render_with(&EngineI18n::default()),
            "engine.definitely.not.a.key"
        );
    }

    #[test]
    fn a_plain_message_renders_without_braces() {
        let out =
            LocalizedText::new("engine.permission.reject").render_with(&EngineI18n::default());
        assert!(!out.contains('{') && !out.contains('}'));
    }

    #[test]
    fn params_macro_accepts_many_display_types() {
        let params = i18n_params!["path" => "/etc/hosts", "count" => 3, "flag" => true];
        assert_eq!(params["count"], "3");
        assert_eq!(params["flag"], "true");
    }
}
