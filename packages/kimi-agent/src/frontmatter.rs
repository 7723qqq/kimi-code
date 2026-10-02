//! YAML frontmatter extraction.
//!
//! Ports v2 `_base/text/frontmatter.ts` (`parseFrontmatter`), which wraps
//! `js-yaml` and splits a document into its parsed mapping and its body. The
//! two hand-rolled parsers this replaces (`skills/mod.rs` and
//! `tools/tower/frontmatter.rs`) each read `key: value` line by line, which is
//! not YAML: it mis-read folded scalars, dropped block lists, kept inline
//! comments, and flattened nested maps into empty parent keys.
//!
//! v2's own error behaviour is preserved: a document that opens a fence but
//! never closes it is an error, not a document without frontmatter, and YAML
//! that fails to parse surfaces its message rather than being silently ignored.

use serde_json::{Map, Value};

const FENCE: &str = "---";

/// A document's frontmatter mapping and the text after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    /// The parsed frontmatter. Empty when the document has no frontmatter
    /// block, or when the block is empty. Never a non-object: a frontmatter
    /// whose top level is not a mapping is an error (v2 throws
    /// `must be a mapping at the top level`).
    pub data: Map<String, Value>,
    /// Everything after the closing fence, or the whole document when there is
    /// no frontmatter.
    pub body: String,
}

/// Split `text` into its frontmatter mapping and body.
///
/// Returns `Err` when a fence is opened but never closed, when the YAML is
/// malformed, or when the top level is not a mapping — the three cases v2
/// rejects rather than degrading.
pub fn parse_frontmatter(text: &str) -> Result<Frontmatter, String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some(FENCE) {
        return Ok(Frontmatter {
            data: Map::new(),
            body: text.to_string(),
        });
    }

    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(idx, line)| (line.trim() == FENCE).then_some(idx))
        .ok_or_else(|| "Missing closing frontmatter fence".to_string())?;

    let yaml_text = lines[1..close].join("\n");
    let body = lines[close + 1..].join("\n");

    if yaml_text.trim().is_empty() {
        return Ok(Frontmatter {
            data: Map::new(),
            body,
        });
    }

    let parsed: Value =
        serde_yaml::from_str(&yaml_text).map_err(|e| format!("Invalid frontmatter: {e}"))?;
    match parsed {
        Value::Null => Ok(Frontmatter {
            data: Map::new(),
            body,
        }),
        Value::Object(map) => Ok(Frontmatter { data: map, body }),
        _ => Err("Frontmatter must be a mapping at the top level".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_of(text: &str) -> Map<String, Value> {
        parse_frontmatter(text).unwrap().data
    }

    #[test]
    fn a_document_without_frontmatter_is_all_body() {
        let parsed = parse_frontmatter("# Title\n\ntext").unwrap();
        assert!(parsed.data.is_empty());
        assert_eq!(parsed.body, "# Title\n\ntext");
    }

    #[test]
    fn a_folded_scalar_joins_its_lines() {
        let data = data_of("---\ndescription: >\n  a long folded\n  description\n---\nbody");
        assert_eq!(data["description"], "a long folded description");
    }

    #[test]
    fn a_literal_scalar_keeps_its_newlines() {
        let data = data_of("---\ndescription: |\n  line one\n  line two\n---\nbody");
        assert_eq!(
            data["description"],
            // YAML's clip chomping keeps the single trailing newline a `|`
            // block implies, minus the one the split-on-lines consumed.
            "line one\nline two"
        );
    }

    #[test]
    fn a_block_list_becomes_a_real_array() {
        let data = data_of("---\nscopes:\n  - tui\n  - web\n---\nbody");
        assert_eq!(data["scopes"], serde_json::json!(["tui", "web"]));
    }

    #[test]
    fn an_inline_comment_is_not_part_of_the_value() {
        let data = data_of("---\nname: s  # the name\n---\nbody");
        assert_eq!(data["name"], "s");
    }

    #[test]
    fn a_nested_map_keeps_its_own_keys_instead_of_an_empty_parent() {
        let data = data_of("---\nmeta:\n  a: 1\n  b: 2\n---\nbody");
        assert_eq!(data["meta"]["a"], 1);
        assert_eq!(data["meta"]["b"], 2);
    }

    #[test]
    fn a_quoted_value_may_contain_a_colon() {
        let data = data_of("---\nname: \"a: b\"\n---\nbody");
        assert_eq!(data["name"], "a: b");
    }

    #[test]
    fn booleans_and_numbers_are_typed_not_strings() {
        let data = data_of("---\ndisable-model-invocation: true\ncount: 3\n---\nbody");
        assert_eq!(data["disable-model-invocation"], true);
        assert_eq!(data["count"], 3);
    }

    #[test]
    fn an_empty_block_is_an_empty_mapping_not_an_error() {
        let parsed = parse_frontmatter("---\n---\nbody").unwrap();
        assert!(parsed.data.is_empty());
        assert_eq!(parsed.body, "body");
    }

    #[test]
    fn an_unclosed_fence_is_an_error() {
        assert!(parse_frontmatter("---\nname: s\nbody").is_err());
    }

    #[test]
    fn a_non_mapping_top_level_is_an_error() {
        assert!(parse_frontmatter("---\n- a\n- b\n---\nbody").is_err());
    }

    #[test]
    fn malformed_yaml_surfaces_its_message() {
        let err = parse_frontmatter("---\na: [1, 2\n---\nbody").unwrap_err();
        assert!(
            err.starts_with("Invalid frontmatter"),
            "expected a prefixed parse error, got {err:?}"
        );
    }

    #[test]
    fn the_body_keeps_everything_after_the_closing_fence() {
        let parsed = parse_frontmatter("---\nname: s\n---\nline one\n\nline two\n").unwrap();
        // Splitting on `\n` drops the final empty segment, so a document's
        // trailing newline is not part of the body. Callers that need it trim
        // or re-append; nothing here depends on it.
        assert_eq!(parsed.body, "line one\n\nline two");
    }
}
