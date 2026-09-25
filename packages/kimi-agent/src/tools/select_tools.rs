//! Native `select_tools` progressive tool disclosure tool.
//!
//! Mirrors `packages/agent-core-v2/src/agent/toolSelect/` and
//! `packages/agent-core-v2/src/agent/tools/select-tools/`.
//!
//! # Wiring (2026-09-14)
//!
//! Live:
//! - `execute_select_tools` is dispatched from the `"select_tools"` arm of
//!   [`crate::tools::NativeToolset::execute`], and the loaded set is now the
//!   toolset's **session-scoped** `loaded_tools` set instead of a set created
//!   and dropped on every call. `already_available` therefore reports names
//!   loaded by an earlier call, and `to_load` reports only genuinely new ones.
//! - `render_loadable_tools_announcement` is reached from
//!   `execute_select_tools` and delivered to the model as a follow-up `user`
//!   message via [`ExecutableToolResult::delivery`], so the
//!   `<tools_added>` block the tool description refers to actually arrives.
//!
//! Deliberately unreachable:
//! - `not_loaded_tool_output` has no call site **by design**. v2 deferred MCP
//!   schemas out of `tools[]` and refused a call to a deferred-but-unloaded
//!   tool. This engine advertises every tool it can execute
//!   (`GET /api/v1/tools` reports all builtins and all MCP tools as
//!   `active: true`), so no advertised tool is ever "not loaded" — gating a
//!   call would reject tools the model can see. Keeping the helper here
//!   documents the v2 wording; it is intentionally not wired.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::turn_loop::types::ExecutableToolResult;

pub const SELECT_TOOLS_TOOL_NAME: &str = "select_tools";

pub const SELECT_TOOLS_DESCRIPTION: &str = "\
Load one or more tools by name so you can call them. \
The loadable names are listed in the <tools_added>/<tools_removed> announcements \
in the system context — fold them in order to get the current list. \
Pass the exact tool name(s) you need — plugin, skill, or category names do not work. \
The full definitions become available immediately, so you can call them directly \
in your next tool call. \
Only announced names are loadable — tools you already have available are called \
directly, never passed to select_tools.";

pub fn select_tools_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "names": {
                "type": "array",
                "items": { "type": "string" },
                "minItems": 1,
                "description": "Exact tool names to load, taken from the latest announced tool list."
            }
        },
        "required": ["names"]
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadToolsResult {
    pub to_load: Vec<String>,
    pub already_available: Vec<String>,
    /// Requested names the model can already call directly — advertised in
    /// the shaped table, not behind the deferred-disclosure gate (upstream
    /// #3885 `isStaticCallable`).
    pub already_callable: Vec<String>,
    pub unknown: Vec<String>,
}

pub fn evaluate_load_tools(
    requested: &[String],
    available_tools: &HashSet<String>,
    currently_loaded: &HashSet<String>,
    callable_tools: &HashSet<String>,
) -> LoadToolsResult {
    let mut to_load = Vec::new();
    let mut already_available = Vec::new();
    let mut already_callable = Vec::new();
    let mut unknown = Vec::new();

    let mut seen = HashSet::new();
    for name in requested {
        if !seen.insert(name) {
            continue;
        }
        if currently_loaded.contains(name) {
            already_available.push(name.clone());
        } else if available_tools.contains(name) {
            to_load.push(name.clone());
        } else if callable_tools.contains(name) {
            already_callable.push(name.clone());
        } else {
            unknown.push(name.clone());
        }
    }

    LoadToolsResult {
        to_load,
        already_available,
        already_callable,
        unknown,
    }
}

/// Upstream #3885 `suggestToolNames`: case-only fixes first, then substring
/// matches over the `mcp__`-stripped query, then matches against the last
/// `__` segment of the candidate. Sorted, capped at three.
fn suggest_tool_names(name: &str, pool: &[String]) -> Vec<String> {
    let lower = name.to_ascii_lowercase();
    let mut case_fix: Vec<String> = pool
        .iter()
        .filter(|candidate| candidate.to_ascii_lowercase() == lower)
        .cloned()
        .collect();
    case_fix.sort();
    if !case_fix.is_empty() {
        case_fix.truncate(3);
        return case_fix;
    }
    let mut matches = HashSet::new();
    let stripped = lower.strip_prefix("mcp__").unwrap_or(&lower);
    if stripped.len() >= 3 {
        for candidate in pool {
            if candidate.to_ascii_lowercase().contains(stripped) {
                matches.insert(candidate.clone());
            }
        }
    }
    if matches.is_empty() {
        for candidate in pool {
            let last = candidate.rsplit("__").next().unwrap_or(candidate);
            if last.len() >= 3 && lower.contains(&last.to_ascii_lowercase()) {
                matches.insert(candidate.clone());
            }
        }
    }
    let mut sorted: Vec<String> = matches.into_iter().collect();
    sorted.sort();
    sorted.truncate(3);
    sorted
}

pub fn execute_select_tools(
    args: &Value,
    available_tools: &HashSet<String>,
    currently_loaded: &mut HashSet<String>,
    callable_tools: &HashSet<String>,
) -> ExecutableToolResult {
    let names: Vec<String> = match args.get("names").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        None => {
            return ExecutableToolResult {
                delivery: None,
                stop_turn: false,
                content: "Invalid arguments: 'names' array is required.".into(),
                is_error: true,
                note: None,
            };
        }
    };

    if names.is_empty() {
        return ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: "Invalid arguments: 'names' must contain at least one tool name.".into(),
            is_error: true,
            note: None,
        };
    }

    let result = evaluate_load_tools(&names, available_tools, currently_loaded, callable_tools);

    // Sorted so the rendered guidance is deterministic (the upstream TS array
    // inherited insertion order; a Rust HashSet does not).
    let mut loadable: Vec<String> = available_tools
        .iter()
        .filter(|name| !currently_loaded.contains(*name))
        .cloned()
        .collect();
    loadable.sort();

    let mut lines = Vec::new();
    if !result.to_load.is_empty() {
        lines.push(format!("Loaded: {}", result.to_load.join(", ")));
        for name in &result.to_load {
            currently_loaded.insert(name.clone());
        }
    }
    if !result.already_available.is_empty() {
        lines.push(format!(
            "Already available: {}",
            result.already_available.join(", ")
        ));
    }
    for name in &result.already_callable {
        lines.push(format!(
            "\"{name}\" is already available — call it directly; \
select_tools is only for names in the <tools_added> announcements."
        ));
    }
    for name in &result.unknown {
        let candidates = suggest_tool_names(
            name,
            &loadable
                .iter()
                .chain(currently_loaded.iter())
                .cloned()
                .collect::<Vec<_>>(),
        );
        if !candidates.is_empty() {
            lines.push(format!(
                "Unknown tool: {name}. Did you mean: {}?",
                candidates.join(", ")
            ));
        } else if loadable.is_empty() {
            lines.push(format!(
                "Unknown tool: {name}. No tools can be loaded in this session — \
use the tools you already have."
            ));
        } else if loadable.len() <= 5 {
            lines.push(format!(
                "Unknown tool: {name}. Loadable tools: {}.",
                loadable.join(", ")
            ));
        } else {
            lines.push(format!(
                "Unknown tool: {name}. Pick from the latest announced tools list."
            ));
        }
    }

    let is_error = result.to_load.is_empty()
        && result.already_available.is_empty()
        && result.already_callable.is_empty();

    // Announce what just became loadable. `delivery` reaches the model as a
    // follow-up `user` message — the same channel v2 used for its
    // `loadable-tools` reminder. Without this the tool description told the
    // model to fold `<tools_added>` blocks that were never produced, and
    // `render_loadable_tools_announcement` had no caller at all.
    let delivery = render_loadable_tools_announcement(&result.to_load, &[]).map(|text| {
        crate::turn_loop::types::ToolDelivery {
            blocks: vec![crate::rpc::types::ContentBlock::Text { text }],
            origin: None,
        }
    });

    ExecutableToolResult {
        delivery,
        stop_turn: false,
        content: lines.join("\n"),
        is_error,
        note: None,
    }
}

pub fn not_loaded_tool_output(name: &str) -> String {
    format!(
        "Tool \"{name}\" is available but not loaded. \
Call select_tools with [\"{name}\"] first, then call the tool."
    )
}

pub fn render_loadable_tools_announcement(added: &[String], removed: &[String]) -> Option<String> {
    if added.is_empty() && removed.is_empty() {
        return None;
    }
    let mut sections = Vec::new();
    if !added.is_empty() {
        sections.push(format!(
            "<tools_added>\n{}\n</tools_added>",
            added.join("\n")
        ));
    }
    if !removed.is_empty() {
        sections.push(format!(
            "<tools_removed>\n{}\n</tools_removed>",
            removed.join("\n")
        ));
    }
    sections.push(
        "Use the select_tools tool with exact names to load full definitions of the \
announced tools before calling them. \
Only the announced names are loadable — tools you already have available are called \
directly, never passed to select_tools; plugin, skill, or category names do not work. \
Names listed as removed are no longer loadable — do not select them. \
Fold all announcements in this conversation in order to get the current list."
            .into(),
    );
    Some(sections.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_tools_schema_validity() {
        let schema = select_tools_schema();
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["names"].is_object());
        assert_eq!(schema["required"][0], "names");
    }

    #[test]
    fn test_evaluate_load_tools() {
        let mut available = HashSet::new();
        available.insert("mcp__github__search".into());
        available.insert("mcp__github__create_pr".into());
        let callable = HashSet::new();

        let mut loaded = HashSet::new();
        loaded.insert("mcp__github__search".into());

        let requested = vec![
            "mcp__github__search".into(),
            "mcp__github__create_pr".into(),
            "unknown_tool".into(),
        ];

        let res = evaluate_load_tools(&requested, &available, &loaded, &callable);
        assert_eq!(res.already_available, vec!["mcp__github__search"]);
        assert_eq!(res.to_load, vec!["mcp__github__create_pr"]);
        assert_eq!(res.unknown, vec!["unknown_tool"]);
    }

    #[test]
    fn test_already_callable_is_reported_not_loaded() {
        let mut available = HashSet::new();
        available.insert("mcp__github__search".into());
        let mut callable = HashSet::new();
        callable.insert("grep".into());

        let loaded = HashSet::new();
        let res = evaluate_load_tools(
            &["grep".into(), "mcp__github__search".into()],
            &available,
            &loaded,
            &callable,
        );
        assert_eq!(res.already_callable, vec!["grep"]);
        assert_eq!(res.to_load, vec!["mcp__github__search"]);
    }

    #[test]
    fn test_suggest_tool_names() {
        let pool = vec![
            "mcp__github__search_code".into(),
            "mcp__github__create_pr".into(),
            "Grep".into(),
        ];
        // Case-only fix wins over everything else.
        assert_eq!(suggest_tool_names("grep", &pool), vec!["Grep"]);
        // Substring over the mcp__-stripped query.
        assert_eq!(
            suggest_tool_names("mcp__github__search", &pool),
            vec!["mcp__github__search_code"]
        );
        // Last-segment containment: the query contains the candidate's final
        // `__` segment, and the substring branch found nothing first.
        assert_eq!(
            suggest_tool_names("my_create_pr", &pool),
            vec!["mcp__github__create_pr"]
        );
        assert!(suggest_tool_names("zzz", &pool).is_empty());
    }

    #[test]
    fn test_execute_select_tools_lifecycle() {
        let mut available = HashSet::new();
        available.insert("tool_a".into());
        available.insert("tool_b".into());
        let callable = HashSet::new();

        let mut loaded = HashSet::new();

        // 1. Initial load with exact formatted output
        let res1 = execute_select_tools(
            &json!({ "names": ["tool_a", "tool_a", "tool_b", "nonexistent"] }),
            &available,
            &mut loaded,
            &callable,
        );
        assert!(!res1.is_error);
        assert_eq!(
            res1.content,
            "Loaded: tool_a, tool_b\nUnknown tool: nonexistent. Loadable tools: tool_a, tool_b."
        );
        assert!(loaded.contains("tool_a"));
        assert!(loaded.contains("tool_b"));

        // 2. Subsequent load for already loaded tool
        let res2 = execute_select_tools(
            &json!({ "names": ["tool_a"] }),
            &available,
            &mut loaded,
            &callable,
        );
        assert!(!res2.is_error);
        assert_eq!(res2.content, "Already available: tool_a");

        // 3. Only unknown tools with nothing left loadable -> the "no tools"
        //    guidance (upstream #3885's loadable.length === 0 arm).
        let res3 = execute_select_tools(
            &json!({ "names": ["bogus"] }),
            &available,
            &mut loaded,
            &callable,
        );
        assert!(res3.is_error);
        assert_eq!(
            res3.content,
            "Unknown tool: bogus. No tools can be loaded in this session — use the tools you already have."
        );

        // 4. Empty names array -> is_error true
        let res_empty =
            execute_select_tools(&json!({ "names": [] }), &available, &mut loaded, &callable);
        assert!(res_empty.is_error);
        assert_eq!(
            res_empty.content,
            "Invalid arguments: 'names' must contain at least one tool name."
        );

        // 5. Missing names field -> is_error true
        let res_missing = execute_select_tools(&json!({}), &available, &mut loaded, &callable);
        assert!(res_missing.is_error);
        assert_eq!(
            res_missing.content,
            "Invalid arguments: 'names' array is required."
        );

        // 6. A statically callable name is answered with direct-call guidance
        //    and is not an error (upstream #3885).
        let mut static_tools = HashSet::new();
        static_tools.insert("grep".into());
        let res6 = execute_select_tools(
            &json!({ "names": ["grep"] }),
            &available,
            &mut loaded,
            &static_tools,
        );
        assert!(!res6.is_error);
        assert_eq!(
            res6.content,
            "\"grep\" is already available — call it directly; select_tools is only for names in the <tools_added> announcements."
        );

        // 6. not_loaded_tool_output exact wording match
        assert_eq!(
            not_loaded_tool_output("mcp__github__search"),
            "Tool \"mcp__github__search\" is available but not loaded. Call select_tools with [\"mcp__github__search\"] first, then call the tool."
        );
    }

    #[test]
    fn test_render_loadable_tools_announcement() {
        let added = vec!["mcp__tool1".into(), "mcp__tool2".into()];
        let removed = vec!["mcp__tool3".into()];
        let announcement = render_loadable_tools_announcement(&added, &removed).unwrap();
        assert!(announcement.contains("<tools_added>\nmcp__tool1\nmcp__tool2\n</tools_added>"));
        assert!(announcement.contains("<tools_removed>\nmcp__tool3\n</tools_removed>"));
        assert!(announcement.contains("Use the select_tools tool with exact names"));
    }
}
