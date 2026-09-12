//! Native `select_tools` progressive tool disclosure tool.
//!
//! Mirrors `packages/agent-core-v2/src/agent/toolSelect/` and
//! `packages/agent-core-v2/src/agent/tools/select-tools/`.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::turn_loop::types::ExecutableToolResult;

pub const SELECT_TOOLS_TOOL_NAME: &str = "select_tools";

pub const SELECT_TOOLS_DESCRIPTION: &str = "\
Load one or more tools by name so you can call them. \
All available tool names are listed in the <tools_added>/<tools_removed> announcements \
in the system context — fold them in order to get the current list. \
Pass the exact name(s) you need; their full definitions become available immediately, \
so you can call them directly in your next tool call.";

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
    pub unknown: Vec<String>,
}

pub fn evaluate_load_tools(
    requested: &[String],
    available_tools: &HashSet<String>,
    currently_loaded: &HashSet<String>,
) -> LoadToolsResult {
    let mut to_load = Vec::new();
    let mut already_available = Vec::new();
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
        } else {
            unknown.push(name.clone());
        }
    }

    LoadToolsResult {
        to_load,
        already_available,
        unknown,
    }
}

pub fn execute_select_tools(
    args: &Value,
    available_tools: &HashSet<String>,
    currently_loaded: &mut HashSet<String>,
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

    let result = evaluate_load_tools(&names, available_tools, currently_loaded);

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
    for name in &result.unknown {
        lines.push(format!(
            "Unknown tool: {name}. Pick from the latest announced tools list."
        ));
    }

    let is_error = result.to_load.is_empty() && result.already_available.is_empty();
    ExecutableToolResult {
        delivery: None,
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
        "Use the select_tools tool with exact names to load full tool definitions before calling them. \
Names listed as removed are no longer loadable — do not select them. \
Fold all announcements in this conversation in order to get the current list.".into(),
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

        let mut loaded = HashSet::new();
        loaded.insert("mcp__github__search".into());

        let requested = vec![
            "mcp__github__search".into(),
            "mcp__github__create_pr".into(),
            "unknown_tool".into(),
        ];

        let res = evaluate_load_tools(&requested, &available, &loaded);
        assert_eq!(res.already_available, vec!["mcp__github__search"]);
        assert_eq!(res.to_load, vec!["mcp__github__create_pr"]);
        assert_eq!(res.unknown, vec!["unknown_tool"]);
    }

    #[test]
    fn test_execute_select_tools_lifecycle() {
        let mut available = HashSet::new();
        available.insert("tool_a".into());
        available.insert("tool_b".into());

        let mut loaded = HashSet::new();

        // 1. Initial load with exact formatted output
        let res1 = execute_select_tools(
            &json!({ "names": ["tool_a", "tool_a", "tool_b", "nonexistent"] }),
            &available,
            &mut loaded,
        );
        assert!(!res1.is_error);
        assert_eq!(
            res1.content,
            "Loaded: tool_a, tool_b\nUnknown tool: nonexistent. Pick from the latest announced tools list."
        );
        assert!(loaded.contains("tool_a"));
        assert!(loaded.contains("tool_b"));

        // 2. Subsequent load for already loaded tool
        let res2 = execute_select_tools(&json!({ "names": ["tool_a"] }), &available, &mut loaded);
        assert!(!res2.is_error);
        assert_eq!(res2.content, "Already available: tool_a");

        // 3. Only unknown tools -> is_error true with exact guidance
        let res3 = execute_select_tools(&json!({ "names": ["bogus"] }), &available, &mut loaded);
        assert!(res3.is_error);
        assert_eq!(
            res3.content,
            "Unknown tool: bogus. Pick from the latest announced tools list."
        );

        // 4. Empty names array -> is_error true
        let res_empty = execute_select_tools(&json!({ "names": [] }), &available, &mut loaded);
        assert!(res_empty.is_error);
        assert_eq!(
            res_empty.content,
            "Invalid arguments: 'names' must contain at least one tool name."
        );

        // 5. Missing names field -> is_error true
        let res_missing = execute_select_tools(&json!({}), &available, &mut loaded);
        assert!(res_missing.is_error);
        assert_eq!(
            res_missing.content,
            "Invalid arguments: 'names' array is required."
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
