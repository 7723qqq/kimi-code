//! Native execution of the Knowledge tool — the SQLite + FTS5 local coding
//! standards database (storage in `crate::knowledge`, ported from
//! `kimi-native-tools/src/knowledge.rs`).
//!
//! The tool shell mirrors v2 `knowledge-tool.ts`: the `action`
//! discriminator (search/add/confirm/reject/remove/stats/import) dispatches
//! to the storage layer and the rendered output matches the v2 wording.
//! The database path resolves like v2 `AgentKnowledgeService`:
//! `<workspace>/.kimi-code/knowledge.db`, falling back to
//! `~/.kimi-code/knowledge.db` when the project DB cannot be opened.

use std::path::Path;

use serde_json::Value;

use crate::knowledge;
use crate::turn_loop::types::ExecutableToolResult;

/// Default search limit and minimum confidence, mirroring v2
/// `AgentKnowledgeService.search` (limit 5, minConfidence 0.5).
const SEARCH_LIMIT: u32 = 5;
const SEARCH_MIN_CONFIDENCE: f64 = 0.5;

/// Execute the Knowledge tool natively: resolve the DB path for the
/// workspace, open it (project DB first, user DB as fallback), then
/// dispatch on `action` and render the v2-aligned output.
pub fn execute_knowledge(workspace_root: &Path, args: &Value) -> ExecutableToolResult {
    let Some(action) = args.get("action").and_then(|a| a.as_str()) else {
        return err_result("Error: `action` is required for the Knowledge tool.".into());
    };
    if let Err(e) = ensure_open(workspace_root) {
        return err_result(e);
    }
    match action {
        "search" => execute_search(args),
        "add" => execute_add(args),
        "confirm" => execute_confirm(args),
        "reject" => execute_reject(args),
        "remove" => execute_remove(args),
        "stats" => execute_stats(),
        "import" => execute_import(args),
        other => err_result(format!(
            "Error: unknown knowledge action `{other}`. Valid actions: search, add, confirm, reject, remove, stats, import."
        )),
    }
}

/// The project DB path under a workspace root (v2 `${cwd}/.kimi-code/knowledge.db`).
fn project_db_path(workspace_root: &Path) -> String {
    workspace_root
        .join(".kimi-code")
        .join("knowledge.db")
        .to_string_lossy()
        .into_owned()
}

/// The user-level fallback DB path (v2 `${homeDir}/knowledge.db`, where
/// homeDir is the kimi-code home directory).
fn user_db_path() -> Option<String> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(
        Path::new(&home)
            .join(".kimi-code")
            .join("knowledge.db")
            .to_string_lossy()
            .into_owned(),
    )
}

/// Open the knowledge DB for a workspace: the project DB first, the user
/// DB as fallback. `open` replaces any previously-open connection, so
/// repeated calls are idempotent.
fn ensure_open(workspace_root: &Path) -> Result<(), String> {
    let project = project_db_path(workspace_root);
    match knowledge::open(project.clone()) {
        Ok(()) => Ok(()),
        Err(project_err) => {
            let user = user_db_path().ok_or_else(|| {
                format!(
                    "Failed to open knowledge DB at {project}: {project_err} (no home dir for fallback)"
                )
            })?;
            match knowledge::open(user.clone()) {
                Ok(()) => Ok(()),
                Err(user_err) => Err(format!(
                    "Failed to open knowledge DB at {project} ({project_err}) and fallback {user} ({user_err})"
                )),
            }
        }
    }
}

fn execute_search(args: &Value) -> ExecutableToolResult {
    let query = args
        .get("query")
        .and_then(|q| q.as_str())
        .unwrap_or("")
        .to_string();
    let scope = args
        .get("scope")
        .and_then(|s| s.as_str())
        .map(str::to_string);
    let tags = args
        .get("tags")
        .and_then(|t| t.as_str())
        .map(str::to_string);
    let json = match knowledge::search(query, scope, tags, SEARCH_LIMIT, SEARCH_MIN_CONFIDENCE) {
        Ok(json) => json,
        Err(e) => return err_result(format!("Knowledge search failed: {e}")),
    };
    let results: Vec<Value> = match serde_json::from_str(&json) {
        Ok(results) => results,
        Err(_) => return err_result("Knowledge search returned invalid results.".into()),
    };
    if results.is_empty() {
        return ok_result("No matching knowledge entries found.".into());
    }
    // v2 rendering: `${i+1}. [${category}] ${title} (confidence: ${c})\n   ${first line}`.
    let mut lines = Vec::new();
    for (i, result) in results.iter().enumerate() {
        let entry = &result["entry"];
        let category = entry["category"].as_str().unwrap_or("");
        let title = entry["title"].as_str().unwrap_or("");
        let confidence = entry["confidence"].as_f64().unwrap_or(0.0);
        let first_line = entry["content"]
            .as_str()
            .unwrap_or("")
            .split('\n')
            .next()
            .unwrap_or("");
        lines.push(format!(
            "{}. [{}] {} (confidence: {})\n   {}",
            i + 1,
            category,
            title,
            confidence,
            first_line
        ));
    }
    ok_result(lines.join("\n\n"))
}

fn execute_add(args: &Value) -> ExecutableToolResult {
    let title = args.get("title").and_then(|t| t.as_str());
    let content = args.get("content").and_then(|c| c.as_str());
    let category = args.get("category").and_then(|c| c.as_str());
    let (Some(title), Some(content), Some(category)) = (title, content, category) else {
        return err_result(
            "Error: title, content, and category are required for add action.".into(),
        );
    };
    let tags = args
        .get("tags")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let scope = args
        .get("scope")
        .and_then(|s| s.as_str())
        .map(str::to_string);
    // v2 tool adds with source 'ai-learned' and confidence 0.7.
    let json = match knowledge::add(
        title.to_string(),
        category.to_string(),
        content.to_string(),
        tags,
        scope,
        "ai-learned".to_string(),
        0.7,
    ) {
        Ok(json) => json,
        Err(e) => return err_result(format!("Failed to add knowledge entry: {e}")),
    };
    let entry: Value = match serde_json::from_str(&json) {
        Ok(entry) => entry,
        Err(_) => return err_result("Failed to add knowledge entry.".into()),
    };
    let id = entry["id"].as_str().unwrap_or("");
    ok_result(format!(
        "Learned: [{category}] {title} (id: {id}, confidence: 0.7)"
    ))
}

fn execute_confirm(args: &Value) -> ExecutableToolResult {
    let Some(id) = args.get("id").and_then(|i| i.as_str()) else {
        return err_result("Error: id is required for confirm action.".into());
    };
    match knowledge::confirm(id.to_string()) {
        Ok(true) => ok_result(format!("Confirmed entry {id} (confidence → 1.0)")),
        Ok(false) => err_result(format!("Entry {id} not found.")),
        Err(e) => err_result(format!("Knowledge confirm failed: {e}")),
    }
}

fn execute_reject(args: &Value) -> ExecutableToolResult {
    let Some(id) = args.get("id").and_then(|i| i.as_str()) else {
        return err_result("Error: id is required for reject action.".into());
    };
    match knowledge::remove(id.to_string()) {
        Ok(true) => ok_result(format!("Rejected and removed entry {id}")),
        Ok(false) => err_result(format!("Entry {id} not found.")),
        Err(e) => err_result(format!("Knowledge remove failed: {e}")),
    }
}

fn execute_remove(args: &Value) -> ExecutableToolResult {
    let Some(id) = args.get("id").and_then(|i| i.as_str()) else {
        return err_result("Error: id is required for remove action.".into());
    };
    match knowledge::remove(id.to_string()) {
        Ok(true) => ok_result(format!("Removed entry {id}")),
        Ok(false) => err_result(format!("Entry {id} not found.")),
        Err(e) => err_result(format!("Knowledge remove failed: {e}")),
    }
}

fn execute_stats() -> ExecutableToolResult {
    let json = match knowledge::stats() {
        Ok(json) => json,
        Err(e) => return err_result(format!("Knowledge stats failed: {e}")),
    };
    let stats: Value = match serde_json::from_str(&json) {
        Ok(stats) => stats,
        Err(_) => return err_result("Knowledge stats returned invalid data.".into()),
    };
    let total = stats["total"].as_u64().unwrap_or(0);
    let avg_confidence = stats["avg_confidence"].as_f64().unwrap_or(0.0);
    ok_result(format!(
        "Knowledge stats: {total} entries\nby category: {}\nby source: {}\navg confidence: {avg_confidence}",
        render_counts(&stats["by_category"]),
        render_counts(&stats["by_source"]),
    ))
}

/// Render a `{name: count}` map as a sorted `name=count, ...` list (sorted
/// so the output is deterministic — HashMap iteration order is not).
fn render_counts(map: &Value) -> String {
    let mut pairs: Vec<(String, u64)> = map
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_u64().map(|n| (k.clone(), n)))
                .collect()
        })
        .unwrap_or_default();
    pairs.sort();
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn execute_import(args: &Value) -> ExecutableToolResult {
    let Some(markdown) = args.get("markdown").and_then(|m| m.as_str()) else {
        return err_result("Error: `markdown` is required for the import action.".into());
    };
    match knowledge::import(markdown.to_string()) {
        Ok(json) => {
            let entries: Vec<Value> = serde_json::from_str(&json).unwrap_or_default();
            let n = entries.len();
            ok_result(format!(
                "Imported {n} knowledge entr{}",
                if n == 1 { "y" } else { "ies" }
            ))
        }
        Err(e) => err_result(format!("Knowledge import failed: {e}")),
    }
}

/// Engine tool definition for Knowledge, so the model can discover and call
/// it (used by the standalone REPL and native tool listing). The description
/// mirrors v2 `knowledge-tool.md`; the schema mirrors
/// `KnowledgeInputSchema` plus the engine-only `remove`/`stats`/`import`
/// actions.
pub fn knowledge_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "Knowledge".into(),
        description: "Use this tool to interact with the local knowledge base — a structured store of coding standards, pitfalls, architecture decisions, and workflow rules for the current project.\n\nThe knowledge base is automatically queried before each turn to inject relevant standards. You can also actively search, add, confirm, or reject entries.\n\nSub-commands (pass as the `action` parameter):\n- `search`: Find entries relevant to a query, file path, or tags\n- `add`: Record a new standard or pitfall discovered during work\n- `confirm`: Upgrade an AI-learned entry to confirmed (confidence → 1.0)\n- `reject`: Remove an incorrect or outdated entry\n\nWhen to use:\n- After discovering a non-obvious constraint or convention: use `add`\n- When the user corrects you and the correction is a reusable rule: use `add`\n- When reviewing existing entries: use `search`\n- To validate or dismiss auto-learned entries: use `confirm` or `reject`\n\nDo NOT use this tool for:\n- General knowledge or facts (only project-specific standards)\n- Temporary per-session preferences\n- Information already in AGENTS.md (avoid duplication)".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["search", "add", "confirm", "reject", "remove", "stats", "import"],
                    "description": "The knowledge sub-command to run."
                },
                "query": {
                    "type": "string",
                    "description": "Search query (FTS5 full-text)."
                },
                "scope": {
                    "type": "string",
                    "description": "File path scope for search."
                },
                "tags": {
                    "type": "string",
                    "description": "Comma-separated tags for search or add."
                },
                "id": {
                    "type": "string",
                    "description": "Entry id for confirm/reject/remove."
                },
                "title": {
                    "type": "string",
                    "description": "Entry title for add."
                },
                "category": {
                    "type": "string",
                    "enum": ["coding-style", "pitfall", "architecture", "workflow"],
                    "description": "Entry category for add."
                },
                "content": {
                    "type": "string",
                    "description": "Entry content for add."
                },
                "markdown": {
                    "type": "string",
                    "description": "Markdown blocks (`# category:title` + `---` separated) to import."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
    }
}

fn ok_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: false,
        note: None,
    }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: true,
        note: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::{TEST_LOCK, close_db_for_tests};
    use serde_json::json;

    /// A tempdir workspace; the global DB connection is closed on drop so
    /// the directory can be removed on Windows.
    struct TestWorkspace {
        dir: tempfile::TempDir,
    }

    impl TestWorkspace {
        fn new() -> Self {
            TestWorkspace {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            close_db_for_tests();
        }
    }

    /// Extract the entry id from an add result
    /// (`Learned: [cat] title (id: <id>, confidence: 0.7)`).
    fn extract_id(output: &str) -> String {
        let start = output.find("id: ").expect("add output has id") + 4;
        let end = output[start..]
            .find(", confidence")
            .expect("add output has confidence")
            + start;
        output[start..end].to_string()
    }

    #[test]
    fn test_search_renders_v2_format() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let added = execute_knowledge(
            ws.path(),
            &json!({
                "action": "add",
                "title": "Rust lifetimes",
                "category": "coding-style",
                "content": "Prefer explicit lifetimes.\nSecond line."
            }),
        );
        assert!(!added.is_error, "content: {}", added.content);
        let result = execute_knowledge(
            ws.path(),
            &json!({ "action": "search", "query": "lifetimes" }),
        );
        assert!(!result.is_error, "content: {}", result.content);
        assert_eq!(
            result.content,
            "1. [coding-style] Rust lifetimes (confidence: 0.7)\n   Prefer explicit lifetimes."
        );
        drop(ws);
    }

    #[test]
    fn test_search_empty_renders_v2_message() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let result = execute_knowledge(
            ws.path(),
            &json!({ "action": "search", "query": "zzzznope" }),
        );
        assert!(!result.is_error, "content: {}", result.content);
        assert_eq!(result.content, "No matching knowledge entries found.");
        drop(ws);
    }

    #[test]
    fn test_add_requires_title_content_category() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        for bad in [
            json!({ "action": "add", "title": "T", "category": "pitfall" }),
            json!({ "action": "add", "title": "T", "content": "C" }),
            json!({ "action": "add", "content": "C", "category": "pitfall" }),
        ] {
            let result = execute_knowledge(ws.path(), &bad);
            assert!(result.is_error, "args: {bad}");
            assert!(
                result
                    .content
                    .contains("title, content, and category are required"),
                "args: {bad}, content: {}",
                result.content
            );
        }
        drop(ws);
    }

    #[test]
    fn test_add_renders_learned() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let result = execute_knowledge(
            ws.path(),
            &json!({
                "action": "add",
                "title": "Async pitfalls",
                "category": "pitfall",
                "content": "Never block the executor.",
                "tags": "rust,async",
                "scope": "G:/repo"
            }),
        );
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result
                .content
                .starts_with("Learned: [pitfall] Async pitfalls (id: "),
            "content: {}",
            result.content
        );
        assert!(result.content.ends_with(", confidence: 0.7)"));
        drop(ws);
    }

    #[test]
    fn test_confirm_and_reject_flow() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let added = execute_knowledge(
            ws.path(),
            &json!({
                "action": "add",
                "title": "AI rule",
                "category": "pitfall",
                "content": "Body."
            }),
        );
        let id = extract_id(&added.content);
        let confirmed = execute_knowledge(ws.path(), &json!({ "action": "confirm", "id": id }));
        assert!(!confirmed.is_error, "content: {}", confirmed.content);
        assert_eq!(
            confirmed.content,
            format!("Confirmed entry {id} (confidence → 1.0)")
        );
        let rejected = execute_knowledge(ws.path(), &json!({ "action": "reject", "id": id }));
        assert!(!rejected.is_error, "content: {}", rejected.content);
        assert_eq!(rejected.content, format!("Rejected and removed entry {id}"));
        // Second reject of the same id is a not-found error.
        let missing = execute_knowledge(ws.path(), &json!({ "action": "reject", "id": id }));
        assert!(missing.is_error);
        assert_eq!(missing.content, format!("Entry {id} not found."));
        drop(ws);
    }

    #[test]
    fn test_remove_action_renders() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let added = execute_knowledge(
            ws.path(),
            &json!({
                "action": "add",
                "title": "To remove",
                "category": "pitfall",
                "content": "Body."
            }),
        );
        let id = extract_id(&added.content);
        let removed = execute_knowledge(ws.path(), &json!({ "action": "remove", "id": id }));
        assert!(!removed.is_error, "content: {}", removed.content);
        assert_eq!(removed.content, format!("Removed entry {id}"));
        drop(ws);
    }

    #[test]
    fn test_confirm_requires_id() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let result = execute_knowledge(ws.path(), &json!({ "action": "confirm" }));
        assert!(result.is_error);
        assert_eq!(result.content, "Error: id is required for confirm action.");
        drop(ws);
    }

    #[test]
    fn test_stats_renders_counts() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        execute_knowledge(
            ws.path(),
            &json!({ "action": "add", "title": "A", "category": "coding-style", "content": "One." }),
        );
        execute_knowledge(
            ws.path(),
            &json!({ "action": "add", "title": "B", "category": "pitfall", "content": "Two." }),
        );
        let result = execute_knowledge(ws.path(), &json!({ "action": "stats" }));
        assert!(!result.is_error, "content: {}", result.content);
        assert!(
            result.content.contains("Knowledge stats: 2 entries"),
            "content: {}",
            result.content
        );
        assert!(
            result
                .content
                .contains("by category: coding-style=1, pitfall=1"),
            "content: {}",
            result.content
        );
        assert!(
            result.content.contains("by source: ai-learned=2"),
            "content: {}",
            result.content
        );
        assert!(
            result.content.contains("avg confidence: 0.7"),
            "content: {}",
            result.content
        );
        drop(ws);
    }

    #[test]
    fn test_import_renders_count_and_is_searchable() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let md = "# coding-style:Imported Rule\ntags: rust\n\nBody here.\n---\n# pitfall:Second\nContent only.\n";
        let result = execute_knowledge(ws.path(), &json!({ "action": "import", "markdown": md }));
        assert!(!result.is_error, "content: {}", result.content);
        assert_eq!(result.content, "Imported 2 knowledge entries");
        let search = execute_knowledge(
            ws.path(),
            &json!({ "action": "search", "query": "imported" }),
        );
        assert!(!search.is_error, "content: {}", search.content);
        assert!(
            search.content.contains("Imported Rule"),
            "content: {}",
            search.content
        );
        drop(ws);
    }

    #[test]
    fn test_import_requires_markdown() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let result = execute_knowledge(ws.path(), &json!({ "action": "import" }));
        assert!(result.is_error);
        assert!(result.content.contains("markdown"));
        drop(ws);
    }

    #[test]
    fn test_unknown_action_errors() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let result = execute_knowledge(ws.path(), &json!({ "action": "frobnicate" }));
        assert!(result.is_error);
        assert!(result.content.contains("unknown knowledge action"));
        drop(ws);
    }

    #[test]
    fn test_missing_action_errors() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let result = execute_knowledge(ws.path(), &json!({}));
        assert!(result.is_error);
        assert!(
            result.content.contains("`action` is required"),
            "content: {}",
            result.content
        );
        drop(ws);
    }

    #[test]
    fn test_db_created_under_workspace_dot_kimi_code() {
        let _guard = TEST_LOCK.lock().unwrap();
        let ws = TestWorkspace::new();
        let result = execute_knowledge(ws.path(), &json!({ "action": "stats" }));
        assert!(!result.is_error, "content: {}", result.content);
        assert!(ws.path().join(".kimi-code").join("knowledge.db").exists());
        drop(ws);
    }

    #[test]
    fn test_db_path_resolution() {
        // Uses a plain tempdir (not TestWorkspace) so the Drop path never
        // touches the shared DB outside the TEST_LOCK.
        let dir = tempfile::tempdir().unwrap();
        let project = project_db_path(dir.path());
        assert!(
            project.ends_with(".kimi-code\\knowledge.db")
                || project.ends_with(".kimi-code/knowledge.db")
        );
        assert!(project.contains(".kimi-code"));
        let user = user_db_path();
        assert!(user.is_some());
        assert!(user.unwrap().ends_with("knowledge.db"));
        drop(dir);
    }

    #[test]
    fn test_tool_def_matches_v2_schema() {
        let def = knowledge_tool_def();
        assert_eq!(def.name, "Knowledge");
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["required"][0], "action");
        assert_eq!(
            def.input_schema["properties"]["action"]["enum"][0],
            "search"
        );
        assert_eq!(
            def.input_schema["properties"]["category"]["enum"][0],
            "coding-style"
        );
        assert!(def.description.contains("knowledge base"));
    }
}
