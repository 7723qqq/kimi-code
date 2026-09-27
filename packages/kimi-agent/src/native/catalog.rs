//! The embedded locale catalog.
//!
//! `generate-locale-json.cjs` writes `locales/{en,zh}.json` from the single
//! `packages/i18n-catalog` source; `include_str!` bakes those artifacts into the
//! binary, so every consumer of the engine — the CLI, the ACP client, an
//! embedder — renders the host's language without pushing JSON across the napi
//! boundary. The host names a locale once and looks keys up from there.
//!
//! It is not yet the only copy on disk: `packages/i18n` and `apps/kimi-code`
//! still import `en` / `zh` for their pure-JS fallback and `getMessages()`, so
//! the binary and the TypeScript runtime each hold a copy until those go.
//!
//! The JSON is parsed once per locale into a flat dot-path table. A miss is a
//! `None`, never a panic: CI regenerates the artifacts and fails on any diff
//! (`.github/workflows/ci.yml`), so malformed JSON cannot reach a build.

use std::collections::HashMap;
use std::sync::LazyLock;

/// The host's active language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Locale {
    #[default]
    En,
    Zh,
}

impl Locale {
    /// Parse a locale name as the host spells it (`"en"` / `"zh"`).
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "en" => Some(Self::En),
            "zh" => Some(Self::Zh),
            _ => None,
        }
    }
}

const EN_JSON: &str = include_str!("../locales/en.json");
const ZH_JSON: &str = include_str!("../locales/zh.json");

/// Flatten the nested locale tree into `dot.path` → template.
fn build(json: &str) -> HashMap<String, String> {
    let tree: serde_json::Value =
        serde_json::from_str(json).expect("embedded locale JSON must be valid");
    let mut out = HashMap::new();
    flatten(&tree, "", &mut out);
    out
}

fn flatten(node: &serde_json::Value, prefix: &str, out: &mut HashMap<String, String>) {
    match node {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten(child, &path, out);
            }
        }
        serde_json::Value::String(text) => {
            out.insert(prefix.to_string(), text.clone());
        }
        _ => {}
    }
}

static EN: LazyLock<HashMap<String, String>> = LazyLock::new(|| build(EN_JSON));
static ZH: LazyLock<HashMap<String, String>> = LazyLock::new(|| build(ZH_JSON));

/// The flat table for `locale`.
pub fn table(locale: Locale) -> &'static HashMap<String, String> {
    match locale {
        Locale::En => &EN,
        Locale::Zh => &ZH,
    }
}

/// The template for `key` in `locale`, or `None` when the key is absent.
pub fn lookup(locale: Locale, key: &str) -> Option<&'static str> {
    table(locale).get(key).map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_locale_resolves_a_known_engine_key() {
        let en = lookup(Locale::En, "engine.permission.reject").expect("en has the key");
        let zh = lookup(Locale::Zh, "engine.permission.reject").expect("zh has the key");
        assert_ne!(en, zh, "the two locales must not render the same text");
    }

    #[test]
    fn a_tui_key_resolves_from_the_embedded_catalog() {
        assert!(lookup(Locale::En, "common.ok").is_some());
    }

    #[test]
    fn an_unknown_key_resolves_to_none() {
        assert!(lookup(Locale::En, "engine.definitely.not.a.key").is_none());
    }

    #[test]
    fn zh_covers_every_key_en_covers() {
        // A key present in en but absent in zh would silently render English
        // in a Chinese session; the locale-key gates cover the .ts sources, this
        // covers the artifact the binary actually embeds.
        for (key, _) in table(Locale::En) {
            assert!(lookup(Locale::Zh, key).is_some(), "zh is missing {key}");
        }
    }
}
