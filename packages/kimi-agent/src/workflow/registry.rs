//! Workflow registry: built-in embedded scripts and user `.js` files under
//! `<home>/workflows/`.
//!
//! Ported from the retired `agent-core-v2` `workflowRegistry.ts`; the meta
//! extractor is regex-based (no `eval`), accepting only string-keyed string
//! fields and a string-array `phases`.

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;

use super::WorkflowMeta;

const BUILTIN_SCRIPTS: &[(&str, &str)] = &[
    ("deep-research", include_str!("builtin/deep-research.js")),
    ("code-review", include_str!("builtin/code-review.js")),
    ("test-generator", include_str!("builtin/test-generator.js")),
    (
        "refactor-planner",
        include_str!("builtin/refactor-planner.js"),
    ),
    ("bug-triage", include_str!("builtin/bug-triage.js")),
    ("pr-description", include_str!("builtin/pr-description.js")),
    (
        "architecture-review",
        include_str!("builtin/architecture-review.js"),
    ),
    ("security-audit", include_str!("builtin/security-audit.js")),
    (
        "migration-planner",
        include_str!("builtin/migration-planner.js"),
    ),
];

static META_BODY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}").unwrap());
static FIELD: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(\w+)\s*:\s*["']([^"']*?)["']"#).unwrap());
static PHASES: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)phases\s*:\s*\[([\s\S]*?)\]").unwrap());
static PHASE_ITEM: Lazy<Regex> = Lazy::new(|| Regex::new(r#"["']([^"']*?)["']"#).unwrap());

/// Every built-in workflow, sorted by name.
pub fn list_builtins() -> Vec<WorkflowMeta> {
    let mut metas: Vec<WorkflowMeta> = BUILTIN_SCRIPTS
        .iter()
        .filter_map(|(_, script)| parse_meta(script))
        .collect();
    metas.sort_by(|a, b| a.name.cmp(&b.name));
    metas
}

/// The script and meta of a built-in workflow.
pub fn get_builtin(name: &str) -> Option<(&'static str, WorkflowMeta)> {
    BUILTIN_SCRIPTS
        .iter()
        .find(|(builtin, _)| *builtin == name)
        .and_then(|(_, script)| parse_meta(script).map(|meta| (*script, meta)))
}

/// Resolve `<home>/workflows/<name>.js` into its script and meta.
pub fn resolve_user_workflow(home: &Path, name: &str) -> Option<(String, WorkflowMeta)> {
    if name.is_empty()
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return None;
    }
    let script = std::fs::read_to_string(home.join("workflows").join(format!("{name}.js"))).ok()?;
    let meta = parse_meta(&script)?;
    Some((script, meta))
}

/// Extract the `export const meta = { ... }` literal. Returns `None` when
/// `name` / `description` are missing.
pub fn parse_meta(script: &str) -> Option<WorkflowMeta> {
    let body = META_BODY.captures(script)?.get(1)?.as_str().to_string();
    let mut fields = std::collections::HashMap::new();
    for capture in FIELD.captures_iter(&body) {
        if let (Some(key), Some(value)) = (capture.get(1), capture.get(2)) {
            fields.insert(key.as_str().to_string(), value.as_str().to_string());
        }
    }
    let name = fields.get("name")?.clone();
    let description = fields.get("description")?.clone();

    let phases = PHASES
        .captures(&body)
        .and_then(|capture| capture.get(1))
        .map(|items| {
            PHASE_ITEM
                .captures_iter(items.as_str())
                .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_string()))
                .collect::<Vec<_>>()
        })
        .filter(|phases| !phases.is_empty());

    Some(WorkflowMeta {
        name,
        description,
        when_to_use: fields.get("whenToUse").cloned(),
        phases,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_meta_literal() {
        let meta = parse_meta(
            "export const meta = {\n  name: 'demo',\n  description: \"a demo\",\n  whenToUse: 'use it',\n  phases: ['One', 'Two'],\n};",
        )
        .expect("meta");
        assert_eq!(meta.name, "demo");
        assert_eq!(meta.description, "a demo");
        assert_eq!(meta.when_to_use.as_deref(), Some("use it"));
        assert_eq!(
            meta.phases,
            Some(vec!["One".to_string(), "Two".to_string()])
        );
        assert!(parse_meta("export const meta = { nope: 1 };").is_none());
    }

    #[test]
    fn all_builtins_have_valid_meta() {
        let builtins = list_builtins();
        assert_eq!(builtins.len(), 9);
        assert!(builtins.iter().any(|meta| meta.name == "deep-research"));
        for meta in builtins {
            assert!(!meta.description.is_empty());
        }
        assert!(get_builtin("code-review").is_some());
        assert!(get_builtin("missing").is_none());
    }
}
