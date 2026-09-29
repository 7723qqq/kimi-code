//! The embedded locale catalog.
//!
//! `generate-locale-json.cjs` writes `locales/{en,zh}.json` from the single
//! `packages/i18n-catalog` source; `include_str!` bakes those artifacts into the
//! binary, so the host names a locale once and looks keys up instead of pushing
//! JSON across the napi boundary on every call.
//!
//! It is the only copy: the host resolves every string by key, so no
//! JavaScript copy of the trees is left to drift.
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

/// Replace `{{name}}` placeholders in `template` with values from `params`.
///
/// An unknown name — and a `{{` with no closing `}}` — is left as literal
/// text. A template that ships a placeholder its locale never fills renders
/// visibly broken rather than silently truncated, which is the one behaviour
/// worth keeping while the catalogs are still hand-edited.
pub(crate) fn interpolate(template: &str, params: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        rest = &rest[start + 2..];

        let Some(end) = rest.find("}}") else {
            result.push_str("{{");
            break;
        };
        let name = &rest[..end];
        rest = &rest[end + 2..];
        match params.get(name) {
            Some(value) => result.push_str(value),
            None => {
                result.push_str("{{");
                result.push_str(name);
                result.push_str("}}");
            }
        }
    }

    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── interpolate ──────────────────────────────────────────────────────

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn interpolate_fills_every_placeholder() {
        let out = interpolate(
            "Found {{count}} {{item}}s in {{location}}",
            &params(&[("count", "5"), ("item", "record"), ("location", "database")]),
        );
        assert_eq!(out, "Found 5 records in database");
    }

    #[test]
    fn interpolate_handles_consecutive_placeholders() {
        assert_eq!(
            interpolate("{{a}}{{b}}", &params(&[("a", "x"), ("b", "y")])),
            "xy"
        );
    }

    #[test]
    fn interpolate_keeps_an_unknown_name_literal() {
        assert_eq!(
            interpolate("Hello, {{name}}!", &params(&[])),
            "Hello, {{name}}!"
        );
    }

    #[test]
    fn interpolate_keeps_an_unclosed_brace_literal() {
        assert_eq!(
            interpolate("Hello {{name", &params(&[("name", "x")])),
            "Hello {{name"
        );
    }

    #[test]
    fn interpolate_keeps_an_empty_placeholder_literal() {
        assert_eq!(interpolate("{{}}", &params(&[])), "{{}}");
    }

    #[test]
    fn interpolate_passes_a_template_without_placeholders_through() {
        assert_eq!(interpolate("Plain text", &params(&[])), "Plain text");
        assert_eq!(interpolate("", &params(&[])), "");
    }

    #[test]
    fn interpolate_does_not_escape_the_substituted_value() {
        assert_eq!(
            interpolate("{{text}}", &params(&[("text", "a<b>c&d\"e'")])),
            "a<b>c&d\"e'"
        );
    }

    // ── embedded catalog ─────────────────────────────────────────────────

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
        for key in table(Locale::En).keys() {
            assert!(lookup(Locale::Zh, key).is_some(), "zh is missing {key}");
        }
    }
}
