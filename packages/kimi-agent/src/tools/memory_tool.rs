//! Native execution of the six memory tools.
//!
//! The tool shell mirrors the memory section of the system prompt: `path` is
//! a relative memory path, every mutation carries `if_version`, and a
//! rejected mutation returns the file's current content so the model can
//! merge and retry in the same turn. Storage lives in
//! [`crate::tools::memory_store`]; this module validates arguments and renders
//! results.
//!
//! The memory root resolves from the Kimi home (`~/.kimi-code/memory`), not
//! from the workspace, so the store is the same in every workspace. The
//! workspace root is used only to derive the project id that scopes the
//! listing.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::tools::memory_store::{self, MemoryEntry};
use crate::turn_loop::types::ExecutableToolResult;

/// Most files one `memory_read` call may open.
const MAX_READ_PATHS: usize = 20;
/// Files per `memory_list` page.
const LIST_PAGE_SIZE: usize = 50;
/// Longest one-line preview `memory_list` renders per file.
const PREVIEW_MAX_CHARS: usize = 120;

/// The resolved memory root plus the project id of the calling workspace.
pub struct MemoryContext {
    pub base: PathBuf,
    pub project_id: String,
}

impl MemoryContext {
    pub fn new(base: PathBuf, workspace_root: &Path) -> Self {
        Self {
            base,
            project_id: memory_store::project_id_for(workspace_root),
        }
    }

    /// Resolve the memory root from the environment. Fails when no home
    /// directory is known, which is the only case where the tools cannot run
    /// at all.
    pub fn resolve(workspace_root: &Path) -> Result<Self, String> {
        let base = memory_store::memory_base().ok_or_else(|| {
            "The memory store is unavailable: no home directory is set (KIMI_CODE_HOME, USERPROFILE, or HOME)."
                .to_string()
        })?;
        Ok(Self::new(base, workspace_root))
    }
}

/// `memory_read(path)` — read one file, or up to [`MAX_READ_PATHS`] of them.
pub fn execute_memory_read(workspace_root: &Path, args: &Value) -> ExecutableToolResult {
    with_context(workspace_root, args, read)
}

/// `memory_write(path, content, if_version)` — create a file, or replace one
/// in full.
pub fn execute_memory_write(workspace_root: &Path, args: &Value) -> ExecutableToolResult {
    with_context(workspace_root, args, write)
}

/// `memory_str_replace(path, old_str, new_str, if_version)` — change one part
/// of a file.
pub fn execute_memory_str_replace(workspace_root: &Path, args: &Value) -> ExecutableToolResult {
    with_context(workspace_root, args, str_replace)
}

/// `memory_append(path, content, if_version)` — add a line at the end.
pub fn execute_memory_append(workspace_root: &Path, args: &Value) -> ExecutableToolResult {
    with_context(workspace_root, args, append)
}

/// `memory_list(path_prefix, cursor)` — refresh the listing.
pub fn execute_memory_list(workspace_root: &Path, args: &Value) -> ExecutableToolResult {
    with_context(workspace_root, args, list)
}

/// `memory_delete(path, if_version)` — remove a whole file.
pub fn execute_memory_delete(workspace_root: &Path, args: &Value) -> ExecutableToolResult {
    with_context(workspace_root, args, delete)
}

fn with_context(
    workspace_root: &Path,
    args: &Value,
    run: fn(&MemoryContext, &Value) -> ExecutableToolResult,
) -> ExecutableToolResult {
    match MemoryContext::resolve(workspace_root) {
        Ok(context) => run(&context, args),
        Err(error) => err_result(error),
    }
}

fn read(context: &MemoryContext, args: &Value) -> ExecutableToolResult {
    let paths = match args.get("path") {
        Some(Value::String(path)) => vec![path.clone()],
        Some(Value::Array(items)) => {
            let mut paths = Vec::with_capacity(items.len());
            for item in items {
                match item.as_str() {
                    Some(path) => paths.push(path.to_string()),
                    None => {
                        return err_result("Error: every entry in `path` must be a string.".into());
                    }
                }
            }
            paths
        }
        _ => {
            return err_result(
                "Error: `path` is required — a memory path, or an array of up to 20 of them."
                    .into(),
            );
        }
    };
    if paths.is_empty() {
        return err_result("Error: `path` must name at least one file.".into());
    }
    if paths.len() > MAX_READ_PATHS {
        return err_result(format!(
            "Error: `path` accepts at most {MAX_READ_PATHS} files per call ({} given).",
            paths.len()
        ));
    }
    let mut sections = Vec::with_capacity(paths.len());
    let mut failures = 0;
    for path in &paths {
        match memory_store::read(&context.base, path) {
            Ok((content, version)) => {
                sections.push(format!("{path} (version: {version})\n{content}"));
            }
            Err(error) => {
                failures += 1;
                sections.push(error);
            }
        }
    }
    let content = sections.join("\n\n");
    // A partial read still carries usable content, so only a call where every
    // path failed is reported as an error.
    if failures == paths.len() {
        err_result(content)
    } else {
        ok_result(content)
    }
}

fn write(context: &MemoryContext, args: &Value) -> ExecutableToolResult {
    let (Some(path), Some(content), Some(if_version)) = (
        args.get("path").and_then(Value::as_str),
        args.get("content").and_then(Value::as_str),
        args.get("if_version").and_then(Value::as_str),
    ) else {
        return err_result("Error: `path`, `content`, and `if_version` are required.".into());
    };
    match memory_store::write(&context.base, path, content, if_version) {
        Ok(version) => ok_result(format!("Wrote {path} (version: {version})")),
        Err(error) => err_result(error),
    }
}

fn str_replace(context: &MemoryContext, args: &Value) -> ExecutableToolResult {
    let (Some(path), Some(old_str), Some(new_str), Some(if_version)) = (
        args.get("path").and_then(Value::as_str),
        args.get("old_str").and_then(Value::as_str),
        args.get("new_str").and_then(Value::as_str),
        args.get("if_version").and_then(Value::as_str),
    ) else {
        return err_result(
            "Error: `path`, `old_str`, `new_str`, and `if_version` are required.".into(),
        );
    };
    match memory_store::str_replace(&context.base, path, old_str, new_str, if_version) {
        Ok(version) => ok_result(format!("Updated {path} (version: {version})")),
        Err(error) => err_result(error),
    }
}

fn append(context: &MemoryContext, args: &Value) -> ExecutableToolResult {
    let (Some(path), Some(content), Some(if_version)) = (
        args.get("path").and_then(Value::as_str),
        args.get("content").and_then(Value::as_str),
        args.get("if_version").and_then(Value::as_str),
    ) else {
        return err_result("Error: `path`, `content`, and `if_version` are required.".into());
    };
    match memory_store::append(&context.base, path, content, if_version) {
        Ok(version) => ok_result(format!("Appended to {path} (version: {version})")),
        Err(error) => err_result(error),
    }
}

fn delete(context: &MemoryContext, args: &Value) -> ExecutableToolResult {
    let (Some(path), Some(if_version)) = (
        args.get("path").and_then(Value::as_str),
        args.get("if_version").and_then(Value::as_str),
    ) else {
        return err_result("Error: `path` and `if_version` are required.".into());
    };
    match memory_store::delete(&context.base, path, if_version) {
        Ok(()) => ok_result(format!("Deleted {path}.")),
        Err(error) => err_result(error),
    }
}

fn list(context: &MemoryContext, args: &Value) -> ExecutableToolResult {
    let prefix = args
        .get("path_prefix")
        .and_then(Value::as_str)
        .unwrap_or("");
    let cursor = match args.get("cursor") {
        None | Some(Value::Null) => 0,
        Some(value) => match value.as_str().and_then(|s| s.trim().parse::<usize>().ok()) {
            Some(cursor) => cursor,
            None => {
                return err_result(
                    "Error: `cursor` must be the value a previous `memory_list` returned.".into(),
                );
            }
        },
    };
    let entries = memory_store::list_entries_for(&context.base, &context.project_id, prefix);
    if entries.is_empty() {
        return ok_result(if prefix.is_empty() {
            "No memory files found.".to_string()
        } else {
            format!("No memory files found under {prefix}.")
        });
    }
    if cursor >= entries.len() {
        return ok_result("No more memory files.".into());
    }
    let page = &entries[cursor..entries.len().min(cursor + LIST_PAGE_SIZE)];
    let mut lines: Vec<String> = page
        .iter()
        .map(|entry| render_row(&context.base, entry))
        .collect();
    let next = cursor + page.len();
    if next < entries.len() {
        lines.push(format!("(next cursor: {next})"));
    }
    ok_result(lines.join("\n"))
}

/// One `memory_list` row: path, size, last update, version, and the file's
/// first content line.
fn render_row(base: &Path, entry: &MemoryEntry) -> String {
    let meta = fs::metadata(base.join(&entry.rel_path)).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let updated = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(format_modified)
        .unwrap_or_else(|| "unknown".to_string());
    let mut row = format!(
        "{}  {}  {}  v:{}",
        entry.rel_path,
        format_size(size),
        updated,
        entry.version
    );
    if let Some(preview) = preview_line(base, &entry.rel_path) {
        row.push_str("\n  ");
        row.push_str(&preview);
    }
    row
}

fn preview_line(base: &Path, rel_path: &str) -> Option<String> {
    let (content, _) = memory_store::read(base, rel_path).ok()?;
    let body = memory_store::body(&content);
    let line = body.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(truncate_chars(line, PREVIEW_MAX_CHARS))
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    }
}

fn format_modified(time: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time)
        .format("%Y-%m-%d %H:%M UTC")
        .to_string()
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn ok_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content,
        is_error: false,
        note: None,
    }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content,
        is_error: true,
        note: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    const PROFILE: &str = "---\nname: profile\ndescription: Who they are.\ntype: note\n---\n\n- [stated] Works on the kimi-code CLI.\n";

    fn context() -> (TempDir, MemoryContext) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("memory");
        let workspace = dir.path().join("workspace");
        let context = MemoryContext::new(base, &workspace);
        (dir, context)
    }

    #[test]
    fn test_write_then_read_round_trip() {
        let (_dir, context) = context();
        let written = write(
            &context,
            &json!({ "path": "global/profile.md", "content": PROFILE, "if_version": "new" }),
        );
        assert!(!written.is_error, "{}", written.content);
        assert!(
            written
                .content
                .starts_with("Wrote global/profile.md (version: ")
        );

        let read_back = read(&context, &json!({ "path": "global/profile.md" }));
        assert!(!read_back.is_error, "{}", read_back.content);
        assert!(
            read_back
                .content
                .starts_with("global/profile.md (version: ")
        );
        assert!(read_back.content.ends_with(PROFILE));
    }

    #[test]
    fn test_read_accepts_an_array_and_reports_per_path_failures() {
        let (_dir, context) = context();
        write(
            &context,
            &json!({ "path": "global/profile.md", "content": PROFILE, "if_version": "new" }),
        );
        let result = read(
            &context,
            &json!({ "path": ["global/profile.md", "global/missing.md"] }),
        );
        assert!(!result.is_error, "{}", result.content);
        assert!(result.content.contains("global/profile.md (version: "));
        assert!(result.content.contains("Cannot read global/missing.md"));

        let all_missing = read(&context, &json!({ "path": ["global/a.md", "global/b.md"] }));
        assert!(all_missing.is_error);
        assert!(all_missing.content.contains("Cannot read global/a.md"));
        assert!(all_missing.content.contains("Cannot read global/b.md"));
    }

    #[test]
    fn test_read_argument_validation() {
        let (_dir, context) = context();
        let missing = read(&context, &json!({}));
        assert!(missing.is_error);
        assert!(missing.content.contains("`path` is required"));

        let empty = read(&context, &json!({ "path": [] }));
        assert!(empty.is_error);
        assert!(empty.content.contains("at least one file"));

        let not_a_string = read(&context, &json!({ "path": [1] }));
        assert!(not_a_string.is_error);
        assert!(not_a_string.content.contains("must be a string"));

        let too_many: Vec<String> = (0..21).map(|i| format!("global/f{i}.md")).collect();
        let over = read(&context, &json!({ "path": too_many }));
        assert!(over.is_error);
        assert!(over.content.contains("at most 20 files"));
    }

    #[test]
    fn test_write_requires_every_argument() {
        let (_dir, context) = context();
        for args in [
            json!({ "content": PROFILE, "if_version": "new" }),
            json!({ "path": "global/profile.md", "if_version": "new" }),
            json!({ "path": "global/profile.md", "content": PROFILE }),
        ] {
            let result = write(&context, &args);
            assert!(result.is_error, "args: {args}");
            assert!(
                result
                    .content
                    .contains("`path`, `content`, and `if_version`"),
                "{}",
                result.content
            );
        }
    }

    #[test]
    fn test_write_conflict_is_an_error_carrying_the_current_content() {
        let (_dir, context) = context();
        write(
            &context,
            &json!({ "path": "global/profile.md", "content": PROFILE, "if_version": "new" }),
        );
        let conflict = write(
            &context,
            &json!({ "path": "global/profile.md", "content": "other", "if_version": "new" }),
        );
        assert!(conflict.is_error);
        assert!(conflict.content.contains("Version conflict"));
        assert!(conflict.content.contains(PROFILE));
    }

    #[test]
    fn test_str_replace_flow() {
        let (_dir, context) = context();
        let written = write(
            &context,
            &json!({ "path": "global/profile.md", "content": PROFILE, "if_version": "new" }),
        );
        let version = version_of(&written.content);
        let replaced = str_replace(
            &context,
            &json!({
                "path": "global/profile.md",
                "old_str": "- [stated] Works on the kimi-code CLI.",
                "new_str": "- [stated] Works on the kimi-code CLI.\n- [stated] Lives in Berlin.",
                "if_version": version,
            }),
        );
        assert!(!replaced.is_error, "{}", replaced.content);
        assert!(
            replaced
                .content
                .starts_with("Updated global/profile.md (version: ")
        );

        let missed = str_replace(
            &context,
            &json!({
                "path": "global/profile.md",
                "old_str": "not in the file",
                "new_str": "x",
                "if_version": version_of(&replaced.content),
            }),
        );
        assert!(missed.is_error);
        assert!(missed.content.contains("was not found"));
        assert!(missed.content.contains("Lives in Berlin."));
    }

    #[test]
    fn test_str_replace_requires_every_argument() {
        let (_dir, context) = context();
        let result = str_replace(&context, &json!({ "path": "global/profile.md" }));
        assert!(result.is_error);
        assert!(
            result
                .content
                .contains("`path`, `old_str`, `new_str`, and `if_version`"),
            "{}",
            result.content
        );
    }

    #[test]
    fn test_append_creates_then_adds_a_line() {
        let (_dir, context) = context();
        let created = append(
            &context,
            &json!({
                "path": "global/topics/habits.md",
                "content": "- [stated] Runs in the morning.",
                "if_version": "new",
            }),
        );
        assert!(!created.is_error, "{}", created.content);
        let appended = append(
            &context,
            &json!({
                "path": "global/topics/habits.md",
                "content": "- [stated] Reads at night.",
                "if_version": version_of(&created.content),
            }),
        );
        assert!(!appended.is_error, "{}", appended.content);
        let read_back = read(&context, &json!({ "path": "global/topics/habits.md" }));
        assert!(
            read_back
                .content
                .ends_with("- [stated] Runs in the morning.\n- [stated] Reads at night.\n")
        );
    }

    #[test]
    fn test_delete_flow() {
        let (_dir, context) = context();
        let written = write(
            &context,
            &json!({ "path": "global/profile.md", "content": PROFILE, "if_version": "new" }),
        );
        let stale = delete(
            &context,
            &json!({ "path": "global/profile.md", "if_version": "stale" }),
        );
        assert!(stale.is_error);
        assert!(stale.content.contains("Version conflict"));

        let deleted = delete(
            &context,
            &json!({ "path": "global/profile.md", "if_version": version_of(&written.content) }),
        );
        assert!(!deleted.is_error, "{}", deleted.content);
        assert_eq!(deleted.content, "Deleted global/profile.md.");
        assert!(read(&context, &json!({ "path": "global/profile.md" })).is_error);

        let missing = delete(&context, &json!({ "path": "global/profile.md" }));
        assert!(missing.is_error);
        assert!(
            missing
                .content
                .contains("`path` and `if_version` are required")
        );
    }

    #[test]
    fn test_list_renders_rows_and_previews() {
        let (_dir, context) = context();
        write(
            &context,
            &json!({ "path": "global/profile.md", "content": PROFILE, "if_version": "new" }),
        );
        let result = list(&context, &json!({}));
        assert!(!result.is_error, "{}", result.content);
        assert!(
            result.content.contains("global/profile.md  "),
            "{}",
            result.content
        );
        assert!(result.content.contains(" B  "), "{}", result.content);
        assert!(result.content.contains(" UTC  v:"), "{}", result.content);
        assert!(
            result
                .content
                .contains("\n  - [stated] Works on the kimi-code CLI."),
            "{}",
            result.content
        );
        assert!(!result.content.contains("next cursor"));
    }

    #[test]
    fn test_list_empty_and_bad_cursor() {
        let (_dir, context) = context();
        let empty = list(&context, &json!({}));
        assert!(!empty.is_error);
        assert_eq!(empty.content, "No memory files found.");

        let bad_cursor = list(&context, &json!({ "cursor": "not-a-cursor" }));
        assert!(bad_cursor.is_error);
        assert!(bad_cursor.content.contains("`cursor` must be the value"));
    }

    #[test]
    fn test_list_pages_with_a_cursor() {
        let (_dir, context) = context();
        for i in 0..(LIST_PAGE_SIZE + 3) {
            write(
                &context,
                &json!({
                    "path": format!("global/topics/topic-{i:03}.md"),
                    "content": format!("# Topic {i}\n"),
                    "if_version": "new",
                }),
            );
        }
        let first = list(&context, &json!({}));
        assert!(!first.is_error, "{}", first.content);
        assert!(
            first
                .content
                .contains(&format!("(next cursor: {LIST_PAGE_SIZE})"))
        );
        assert!(first.content.contains("global/topics/topic-000.md"));
        assert!(!first.content.contains("global/topics/topic-052.md"));

        let second = list(&context, &json!({ "cursor": LIST_PAGE_SIZE.to_string() }));
        assert!(!second.is_error, "{}", second.content);
        assert!(second.content.contains("global/topics/topic-052.md"));
        assert!(!second.content.contains("next cursor"));

        let past_the_end = list(&context, &json!({ "cursor": "999" }));
        assert!(!past_the_end.is_error);
        assert_eq!(past_the_end.content, "No more memory files.");
    }

    /// The public entry points resolve the memory root from the environment.
    /// Only the read-only one is exercised here: a write would touch the real
    /// memory root when a home directory is set.
    #[test]
    fn test_public_entry_point_resolves_the_store_from_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let result = execute_memory_list(dir.path(), &json!({}));
        if memory_store::memory_base().is_some() {
            assert!(!result.is_error, "{}", result.content);
        } else {
            assert!(result.is_error);
            assert!(
                result.content.contains("no home directory"),
                "{}",
                result.content
            );
        }
    }

    #[test]
    fn test_list_prefix_selects_a_scope() {
        let (_dir, context) = context();
        write(
            &context,
            &json!({ "path": "global/profile.md", "content": PROFILE, "if_version": "new" }),
        );
        write(
            &context,
            &json!({ "path": "sessions/s1/scratch.md", "content": "# Scratch\n", "if_version": "new" }),
        );
        let default = list(&context, &json!({}));
        assert!(default.content.contains("global/profile.md"));
        assert!(!default.content.contains("sessions/s1/scratch.md"));

        let sessions = list(&context, &json!({ "path_prefix": "sessions/" }));
        assert!(sessions.content.contains("sessions/s1/scratch.md"));
        assert!(!sessions.content.contains("global/profile.md"));
    }

    #[test]
    fn test_tools_refuse_paths_outside_the_memory_store() {
        let (_dir, context) = context();
        for bad in ["../escape.md", "/etc/passwd", "global/../../escape.md"] {
            let result = write(
                &context,
                &json!({ "path": bad, "content": "x", "if_version": "new" }),
            );
            assert!(result.is_error, "path {bad:?}");
            assert!(result.content.starts_with("Error:"), "{}", result.content);
            assert!(read(&context, &json!({ "path": bad })).is_error);
        }
        assert!(!context.base.exists());
    }

    #[test]
    fn test_context_project_id_follows_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let a = MemoryContext::new(dir.path().join("memory"), Path::new("G:/kimi/kimi-code"));
        let b = MemoryContext::new(dir.path().join("memory"), Path::new("G:\\kimi\\kimi-code"));
        assert_eq!(a.project_id, b.project_id);
        assert_eq!(a.project_id, "28c0fe7f6661");
    }

    /// Pull the version token out of a `Wrote … (version: <token>)` result.
    fn version_of(content: &str) -> String {
        let start = content
            .find("(version: ")
            .expect("result carries a version")
            + 10;
        let end = content[start..]
            .find(')')
            .expect("version is parenthesized")
            + start;
        content[start..end].to_string()
    }
}
