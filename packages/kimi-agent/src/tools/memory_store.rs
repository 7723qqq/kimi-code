//! Memory filesystem storage layer.
//!
//! The memory store is a tree of markdown files under `~/.kimi-code/memory/`,
//! laid out by [`crate::tools::memory_paths`] as `global/`,
//! `projects/<project-id>/`, and `sessions/<session-id>/`. This module owns
//! the read/write side of that layout: frontmatter parsing, the content
//! version token that makes every mutation conditional, and the three blocks
//! the system prompt injects (`<memory_listing>`, `<profile>`,
//! `<preferences>`).
//!
//! Every mutation is guarded by `if_version`: `"new"` means the path must be
//! unused, any other value must equal the file's current version. A rejected
//! mutation returns the file's current content, so the caller can merge
//! against what is actually there and retry in the same turn — the memory
//! section promises exactly that.
//!
//! Path safety is a security boundary: a tool must not reach any file outside
//! the memory base through this API, so every relative path is re-validated
//! here (absolute paths, `..`, backslashes, drive letters, and empty segments
//! are rejected) instead of being trusted from the caller.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::tools::memory_paths::{
    MemoryScope, MemoryType, build_rel_path, content_version, detect_type, extract_title,
    memory_dir, parse_memory_path, project_id_from_cwd, sanitize_file_name, scope_dir,
};
use crate::tools::tower::frontmatter::parse_frontmatter;

/// A memory file as a listing sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEntry {
    pub rel_path: String,
    pub title: String,
    pub description: String,
    pub memory_type: MemoryType,
    pub aliases: Vec<String>,
    pub sources: Vec<String>,
    pub version: String,
}

/// The memory root: `$KIMI_CODE_HOME/memory`, else `~/.kimi-code/memory`.
pub fn memory_base() -> Option<PathBuf> {
    crate::workflow::kimi_home().map(|home| memory_base_at(&home))
}

/// The memory root under an explicit Kimi home directory (`~/.kimi-code`).
pub fn memory_base_at(kimi_home: &Path) -> PathBuf {
    memory_dir(kimi_home)
}

/// The project id of a workspace root. The path is normalized to forward
/// slashes first, so the same workspace hashes the same however the platform
/// spelled it.
pub fn project_id_for(workspace_root: &Path) -> String {
    project_id_from_cwd(&workspace_root.to_string_lossy().replace('\\', "/"))
}

/// Read a memory file: its content and the version token of that content.
pub fn read(base: &Path, rel_path: &str) -> Result<(String, String), String> {
    let (rel, path) = resolve_path(base, rel_path)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("Cannot read {rel}: {e}"))?;
    let version = content_version(&content);
    Ok((content, version))
}

/// Create a memory file, or replace one in full. Returns the new version.
pub fn write(
    base: &Path,
    rel_path: &str,
    content: &str,
    if_version: &str,
) -> Result<String, String> {
    let (rel, path) = resolve_path(base, rel_path)?;
    check_version(&rel, &path, if_version)?;
    write_atomic(&path, content)?;
    Ok(content_version(content))
}

/// Replace one occurrence of `old_str` in a memory file. `old_str` must match
/// exactly once; zero or several matches are rejected with the current
/// content, so the caller can pick a unique anchor and retry.
pub fn str_replace(
    base: &Path,
    rel_path: &str,
    old_str: &str,
    new_str: &str,
    if_version: &str,
) -> Result<String, String> {
    let (rel, path) = resolve_path(base, rel_path)?;
    if old_str.is_empty() {
        return Err("Error: `old_str` must not be empty.".into());
    }
    let content = require_current(&rel, &path, if_version)?;
    let matches = content.matches(old_str).count();
    if matches == 0 {
        return Err(format!(
            "`old_str` was not found in {rel}. Match the file's text exactly.\n\nCurrent content:\n{content}"
        ));
    }
    if matches > 1 {
        return Err(format!(
            "`old_str` matches {matches} times in {rel}; it must match exactly once. Add surrounding context to make it unique.\n\nCurrent content:\n{content}"
        ));
    }
    let updated = content.replacen(old_str, new_str, 1);
    write_atomic(&path, &updated)?;
    Ok(content_version(&updated))
}

/// Add a line at the end of a memory file, creating it when `if_version` is
/// `"new"`.
pub fn append(
    base: &Path,
    rel_path: &str,
    content: &str,
    if_version: &str,
) -> Result<String, String> {
    let (rel, path) = resolve_path(base, rel_path)?;
    let current = check_version(&rel, &path, if_version)?;
    let updated = append_line(current.as_deref().unwrap_or(""), content);
    write_atomic(&path, &updated)?;
    Ok(content_version(&updated))
}

/// Remove a whole memory file.
pub fn delete(base: &Path, rel_path: &str, if_version: &str) -> Result<(), String> {
    let (rel, path) = resolve_path(base, rel_path)?;
    require_current(&rel, &path, if_version)?;
    fs::remove_file(&path).map_err(|e| format!("Cannot delete {rel}: {e}"))
}

/// Every `*.md` file under one scope directory, sorted by relative path.
pub fn list_entries(base: &Path, scope: MemoryScope, scope_id: &str) -> Vec<MemoryEntry> {
    let mut entries = Vec::new();
    collect_entries(base, &scope_dir(base, scope, scope_id), &mut entries);
    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    entries
}

/// The entries a listing shows: the global scope plus the current project, or
/// the scope `path_prefix` names when it names one.
///
/// The memory base is shared by every workspace on the machine, so the
/// default set stays scoped to the caller's project — a listing that mixed
/// projects would invite the model to read another project's file. A prefix
/// naming a scope (`global/`, `projects/<id>/`, `sessions/<id>/`) widens the
/// walk to that scope on request.
pub fn list_entries_for(base: &Path, project_id: &str, path_prefix: &str) -> Vec<MemoryEntry> {
    let prefix = path_prefix.trim();
    let mut entries = Vec::new();
    for (scope, scope_id) in listing_scopes(base, project_id, prefix) {
        entries.extend(list_entries(base, scope, &scope_id));
    }
    if !prefix.is_empty() {
        entries.retain(|entry| entry.rel_path.starts_with(prefix));
    }
    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    entries
}

/// Render the `<memory_listing>` block: one line per file with its path, type,
/// summary, aliases, and sources.
pub fn render_listing(entries: &[MemoryEntry]) -> String {
    let mut out = String::from("<memory_listing>\n");
    if entries.is_empty() {
        out.push_str("(empty)\n");
    }
    for entry in entries {
        out.push_str("- ");
        out.push_str(&entry.rel_path);
        out.push_str(&format!(" [{}]", entry.memory_type.as_str()));
        let summary = if entry.description.is_empty() {
            entry.title.as_str()
        } else {
            entry.description.as_str()
        };
        if !summary.is_empty() {
            out.push_str(" — ");
            out.push_str(summary);
        }
        if !entry.aliases.is_empty() {
            out.push_str(&format!(" [aliases: {}]", entry.aliases.join(", ")));
        }
        if !entry.sources.is_empty() {
            out.push_str(&format!(" [sources: {}]", entry.sources.join(", ")));
        }
        out.push('\n');
    }
    out.push_str("</memory_listing>");
    out
}

/// Render the `<profile>` block from `global/profile.md`.
pub fn render_profile(base: &Path) -> String {
    render_block("profile", base, "global/profile.md")
}

/// Render the `<preferences>` block from `global/preferences.md`.
pub fn render_preferences(base: &Path) -> String {
    render_block("preferences", base, "global/preferences.md")
}

/// Render one injected block from a memory file. The frontmatter is listing
/// metadata, so only the body reaches the prompt.
fn render_block(tag: &str, base: &Path, rel_path: &str) -> String {
    let body = read(base, rel_path)
        .ok()
        .map(|(content, _)| body(&content))
        .unwrap_or_default();
    if body.is_empty() {
        format!("<{tag}>\n(empty)\n</{tag}>")
    } else {
        format!("<{tag}>\n{body}\n</{tag}>")
    }
}

/// The body of a memory file, with its frontmatter stripped.
pub fn body(content: &str) -> String {
    parse_frontmatter(content).1
}

/// Resolve a relative memory path to an absolute path inside `base`, or
/// explain why it is not a legal memory path.
///
/// The caller is a tool driven by model output, so nothing about the path is
/// trusted: absolute paths, `..`, backslashes, drive letters, and empty
/// segments are rejected before the join, and the joined result is checked to
/// still be under `base`.
fn resolve_path(base: &Path, rel_path: &str) -> Result<(String, PathBuf), String> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty() {
        return Err("Error: `path` must not be empty.".into());
    }
    if trimmed.starts_with('/') || trimmed.contains('\\') || trimmed.contains(':') {
        return Err(not_a_memory_path(trimmed));
    }
    let Some(parsed) = parse_memory_path(trimmed) else {
        return Err(not_a_memory_path(trimmed));
    };
    if parsed.scope != MemoryScope::Global && !is_safe_segment(&parsed.scope_id) {
        return Err(not_a_memory_path(trimmed));
    }
    let mut segments: Vec<&str> = parsed.file_name.split('/').collect();
    let last = segments.pop().unwrap_or("");
    if segments.iter().any(|dir| !is_safe_segment(dir)) {
        return Err(not_a_memory_path(trimmed));
    }
    let Some(file_name) = sanitize_file_name(last) else {
        return Err(not_a_memory_path(trimmed));
    };
    let mut parts: Vec<String> = segments.iter().map(|dir| (*dir).to_string()).collect();
    parts.push(file_name);
    let rel = build_rel_path(parsed.scope, &parsed.scope_id, &parts.join("/"));
    let path = base.join(&rel);
    if !path.starts_with(base) {
        return Err(format!(
            "Error: `{trimmed}` resolves outside the memory store."
        ));
    }
    Ok((rel, path))
}

fn not_a_memory_path(rel_path: &str) -> String {
    format!(
        "Error: `{rel_path}` is not a memory path. Use a relative path under `global/`, `projects/<id>/`, or `sessions/<id>/`."
    )
}

/// Whether a path segment is safe to join under the memory base: no empty
/// segment, no `.` / `..`, and no separator or drive-letter characters.
fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.contains('/')
        && !segment.contains('\\')
        && !segment.contains(':')
}

/// The scopes a listing walks. A prefix naming a scope selects that scope
/// alone; anything else selects the global scope plus the caller's project.
fn listing_scopes(base: &Path, project_id: &str, prefix: &str) -> Vec<(MemoryScope, String)> {
    let mut parts = prefix.split('/');
    match (parts.next(), parts.next()) {
        (Some("global"), _) => vec![(MemoryScope::Global, String::new())],
        (Some("projects"), Some(id)) if is_safe_segment(id) => {
            vec![(MemoryScope::Project, id.to_string())]
        }
        (Some("projects"), _) => child_scope_ids(base, MemoryScope::Project),
        (Some("sessions"), Some(id)) if is_safe_segment(id) => {
            vec![(MemoryScope::Session, id.to_string())]
        }
        (Some("sessions"), _) => child_scope_ids(base, MemoryScope::Session),
        _ => vec![
            (MemoryScope::Global, String::new()),
            (MemoryScope::Project, project_id.to_string()),
        ],
    }
}

/// Every scope id under `projects/` or `sessions/`, sorted.
fn child_scope_ids(base: &Path, scope: MemoryScope) -> Vec<(MemoryScope, String)> {
    let Ok(read) = fs::read_dir(scope_dir(base, scope, "")) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = read
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids.into_iter().map(|id| (scope, id)).collect()
}

/// Enforce the `if_version` contract and return the file's current content.
///
/// `"new"` requires an unused path; any other value must equal the current
/// version. Both failures carry the current content, so the caller can merge
/// and retry without a second read.
fn check_version(rel: &str, path: &Path, if_version: &str) -> Result<Option<String>, String> {
    let current = current_content(rel, path)?;
    match (if_version, &current) {
        ("new", None) => Ok(None),
        ("new", Some(content)) => Err(conflict(
            rel,
            content,
            "the path is already in use and `if_version: \"new\"` requires an unused path",
        )),
        (_, None) => Err(format!(
            "{rel} does not exist. Pass `if_version: \"new\"` to create it."
        )),
        (expected, Some(content)) => {
            let version = content_version(content);
            if version == expected {
                Ok(current)
            } else {
                Err(conflict(
                    rel,
                    content,
                    &format!("expected version {expected}, current version is {version}"),
                ))
            }
        }
    }
}

/// [`check_version`] for the operations that cannot create a file.
fn require_current(rel: &str, path: &Path, if_version: &str) -> Result<String, String> {
    check_version(rel, path, if_version)?.ok_or_else(|| format!("{rel} does not exist."))
}

fn conflict(rel: &str, content: &str, reason: &str) -> String {
    format!(
        "Version conflict on {rel} (current version {}): {reason}.\n\nCurrent content:\n{content}",
        content_version(content)
    )
}

fn current_content(rel: &str, path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read {rel}: {e}")),
    }
}

/// Write a file atomically (tmp file + rename), so a crash mid-write never
/// leaves a truncated memory file behind.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("md.tmp");
    let mut file =
        fs::File::create(&tmp).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Cannot replace {}: {e}", path.display()))
}

/// Append `addition` as a line, keeping exactly one newline between the
/// existing content and the addition.
fn append_line(existing: &str, addition: &str) -> String {
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(addition);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn collect_entries(base: &Path, dir: &Path, out: &mut Vec<MemoryEntry>) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_entries(base, &path, out);
        } else if file_type.is_file()
            && is_markdown(&path)
            && let Some(entry) = read_entry(base, &path)
        {
            out.push(entry);
        }
    }
}

fn read_entry(base: &Path, path: &Path) -> Option<MemoryEntry> {
    let rel_path = path
        .strip_prefix(base)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let content = fs::read_to_string(path).ok()?;
    let (fields, body) = parse_frontmatter(&content);
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    Some(MemoryEntry {
        title: extract_title(&body, &file_name),
        description: fields
            .get("description")
            .map(|value| value.trim().to_string())
            .unwrap_or_default(),
        memory_type: detect_type(&content),
        aliases: fields
            .get("aliases")
            .map(|v| parse_list(v))
            .unwrap_or_default(),
        sources: fields
            .get("sources")
            .map(|v| parse_list(v))
            .unwrap_or_default(),
        version: content_version(&content),
        rel_path,
    })
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

/// Parse a frontmatter list value: `[a, b]`, or a bare single value.
fn parse_list(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed);
    inner
        .split(',')
        .map(|item| unquote(item.trim()))
        .filter(|item| !item.is_empty())
        .collect()
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const PROFILE: &str = "---\nname: profile\ndescription: Who they are: name, role, employer.\ntype: note\nsources: [chat]\naliases: [me, the user]\n---\n\n- [stated] Works on the kimi-code CLI.\n";

    fn base() -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("memory");
        (dir, base)
    }

    #[test]
    fn test_write_read_round_trip() {
        let (_dir, base) = base();
        let version = write(&base, "global/profile.md", PROFILE, "new").unwrap();
        assert_eq!(version, content_version(PROFILE));
        let (content, read_version) = read(&base, "global/profile.md").unwrap();
        assert_eq!(content, PROFILE);
        assert_eq!(read_version, version);
        assert!(base.join("global").join("profile.md").is_file());
    }

    #[test]
    fn test_write_creates_parent_directories() {
        let (_dir, base) = base();
        write(&base, "projects/abc123/areas/foo.md", "# Foo\n", "new").unwrap();
        assert!(base.join("projects/abc123/areas/foo.md").is_file());
    }

    #[test]
    fn test_write_new_rejects_an_existing_file_with_its_content() {
        let (_dir, base) = base();
        write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let err = write(&base, "global/profile.md", "replacement", "new").unwrap_err();
        assert!(
            err.contains("Version conflict on global/profile.md"),
            "{err}"
        );
        assert!(err.contains(&content_version(PROFILE)), "{err}");
        assert!(err.contains(PROFILE), "{err}");
        // The rejected write left the file alone.
        assert_eq!(read(&base, "global/profile.md").unwrap().0, PROFILE);
    }

    #[test]
    fn test_write_version_conflict_returns_current_content() {
        let (_dir, base) = base();
        let version = write(&base, "global/profile.md", PROFILE, "new").unwrap();
        write(&base, "global/profile.md", "second", &version).unwrap();
        let err = write(&base, "global/profile.md", "third", &version).unwrap_err();
        assert!(err.contains("expected version"), "{err}");
        assert!(err.contains(&content_version("second")), "{err}");
        assert!(err.contains("Current content:\nsecond"), "{err}");
        assert_eq!(read(&base, "global/profile.md").unwrap().0, "second");
    }

    #[test]
    fn test_write_to_a_missing_file_asks_for_new() {
        let (_dir, base) = base();
        let err = write(&base, "global/profile.md", PROFILE, "abc123def456").unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        assert!(err.contains("if_version: \"new\""), "{err}");
    }

    #[test]
    fn test_read_missing_file_errors() {
        let (_dir, base) = base();
        let err = read(&base, "global/nope.md").unwrap_err();
        assert!(err.contains("Cannot read global/nope.md"), "{err}");
    }

    #[test]
    fn test_str_replace_round_trip() {
        let (_dir, base) = base();
        let version = write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let new_version = str_replace(
            &base,
            "global/profile.md",
            "- [stated] Works on the kimi-code CLI.",
            "- [stated] Works on the kimi-code CLI.\n- [stated] Lives in Berlin.",
            &version,
        )
        .unwrap();
        let (content, read_version) = read(&base, "global/profile.md").unwrap();
        assert!(content.contains("Lives in Berlin."));
        assert_eq!(read_version, new_version);
        assert_ne!(new_version, version);
    }

    #[test]
    fn test_str_replace_zero_matches_returns_current_content() {
        let (_dir, base) = base();
        let version = write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let err =
            str_replace(&base, "global/profile.md", "not in the file", "x", &version).unwrap_err();
        assert!(err.contains("was not found"), "{err}");
        assert!(err.contains("Current content:\n"), "{err}");
        assert!(err.contains(PROFILE), "{err}");
    }

    #[test]
    fn test_str_replace_multiple_matches_is_rejected() {
        let (_dir, base) = base();
        let version = write(&base, "global/dup.md", "same\nsame\n", "new").unwrap();
        let err = str_replace(&base, "global/dup.md", "same", "other", &version).unwrap_err();
        assert!(err.contains("matches 2 times"), "{err}");
        assert!(err.contains("Current content:\nsame\nsame\n"), "{err}");
        assert_eq!(read(&base, "global/dup.md").unwrap().0, "same\nsame\n");
    }

    #[test]
    fn test_str_replace_rejects_an_empty_old_str() {
        let (_dir, base) = base();
        let version = write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let err = str_replace(&base, "global/profile.md", "", "x", &version).unwrap_err();
        assert!(err.contains("`old_str` must not be empty"), "{err}");
    }

    #[test]
    fn test_str_replace_checks_the_version() {
        let (_dir, base) = base();
        write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let err = str_replace(&base, "global/profile.md", "kimi-code", "x", "stale").unwrap_err();
        assert!(err.contains("Version conflict"), "{err}");
    }

    #[test]
    fn test_append_creates_then_adds_a_line() {
        let (_dir, base) = base();
        let version = append(
            &base,
            "global/topics/habits.md",
            "- [stated] Runs in the morning.",
            "new",
        )
        .unwrap();
        assert_eq!(
            read(&base, "global/topics/habits.md").unwrap().0,
            "- [stated] Runs in the morning.\n"
        );
        let version = append(
            &base,
            "global/topics/habits.md",
            "- [stated] Reads at night.",
            &version,
        )
        .unwrap();
        let (content, read_version) = read(&base, "global/topics/habits.md").unwrap();
        assert_eq!(
            content,
            "- [stated] Runs in the morning.\n- [stated] Reads at night.\n"
        );
        assert_eq!(read_version, version);
    }

    #[test]
    fn test_append_requires_an_existing_file_unless_new() {
        let (_dir, base) = base();
        let err = append(&base, "global/topics/habits.md", "x", "abc123def456").unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn test_delete_removes_the_file_and_checks_the_version() {
        let (_dir, base) = base();
        let version = write(&base, "global/profile.md", PROFILE, "new").unwrap();
        let err = delete(&base, "global/profile.md", "stale").unwrap_err();
        assert!(err.contains("Version conflict"), "{err}");
        assert!(base.join("global/profile.md").is_file());
        delete(&base, "global/profile.md", &version).unwrap();
        assert!(!base.join("global/profile.md").exists());
        let err = delete(&base, "global/profile.md", &version).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn test_path_traversal_is_rejected() {
        let (_dir, base) = base();
        for bad in [
            "",
            "   ",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "global/../../escape.md",
            "global/..",
            "projects/../escape.md",
            "projects/../../escape.md",
            "sessions/../escape.md",
            "global/./x.md",
            "global//x.md",
            "global/",
            "global",
            "foo/bar.md",
            "PROJECTS/abc/x.md",
            "global/sub/../../../escape.md",
            "global/x.md/../../escape.md",
        ] {
            let err = write(&base, bad, "x", "new").unwrap_err();
            assert!(err.starts_with("Error:"), "path {bad:?} → {err}");
            assert!(read(&base, bad).is_err(), "path {bad:?} was readable");
        }
        assert!(!base.exists() || fs::read_dir(&base).unwrap().next().is_none());
    }

    #[test]
    fn test_path_normalizes_a_missing_md_suffix() {
        let (_dir, base) = base();
        write(&base, "global/profile", PROFILE, "new").unwrap();
        assert!(base.join("global/profile.md").is_file());
        assert_eq!(read(&base, "global/profile.md").unwrap().0, PROFILE);
    }

    #[test]
    fn test_list_entries_parses_frontmatter() {
        let (_dir, base) = base();
        write(&base, "global/profile.md", PROFILE, "new").unwrap();
        write(
            &base,
            "global/topics/habits.md",
            "---\nname: habits\ndescription: Routines and recurring topics.\ntype: reference\n---\n\n# Habits\n\n- [stated] Runs.\n",
            "new",
        )
        .unwrap();
        let entries = list_entries(&base, MemoryScope::Global, "");
        assert_eq!(entries.len(), 2);
        let profile = &entries[0];
        assert_eq!(profile.rel_path, "global/profile.md");
        assert_eq!(profile.title, "profile");
        assert_eq!(profile.description, "Who they are: name, role, employer.");
        assert_eq!(profile.memory_type, MemoryType::Note);
        assert_eq!(profile.aliases, vec!["me", "the user"]);
        assert_eq!(profile.sources, vec!["chat"]);
        assert_eq!(profile.version, content_version(PROFILE));
        let habits = &entries[1];
        assert_eq!(habits.rel_path, "global/topics/habits.md");
        assert_eq!(habits.title, "Habits");
        assert_eq!(habits.memory_type, MemoryType::Reference);
        assert!(habits.aliases.is_empty());
    }

    #[test]
    fn test_list_entries_ignores_non_markdown_and_missing_dirs() {
        let (_dir, base) = base();
        write(&base, "global/profile.md", PROFILE, "new").unwrap();
        fs::write(base.join("global").join("notes.txt"), "not memory").unwrap();
        let entries = list_entries(&base, MemoryScope::Global, "");
        assert_eq!(entries.len(), 1);
        assert!(list_entries(&base, MemoryScope::Project, "missing").is_empty());
    }

    #[test]
    fn test_list_entries_for_scopes_global_and_current_project() {
        let (_dir, base) = base();
        write(&base, "global/profile.md", PROFILE, "new").unwrap();
        write(&base, "projects/mine/areas/foo.md", "# Foo\n", "new").unwrap();
        write(&base, "projects/other/areas/bar.md", "# Bar\n", "new").unwrap();
        write(&base, "sessions/s1/scratch.md", "# Scratch\n", "new").unwrap();

        let default = list_entries_for(&base, "mine", "");
        let paths: Vec<&str> = default.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["global/profile.md", "projects/mine/areas/foo.md"]
        );

        let scoped = list_entries_for(&base, "mine", "projects/other");
        let paths: Vec<&str> = scoped.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["projects/other/areas/bar.md"]);

        let sessions = list_entries_for(&base, "mine", "sessions/");
        let paths: Vec<&str> = sessions.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["sessions/s1/scratch.md"]);

        let global = list_entries_for(&base, "mine", "global/");
        let paths: Vec<&str> = global.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["global/profile.md"]);

        assert!(list_entries_for(&base, "mine", "projects/../..").is_empty());
    }

    #[test]
    fn test_render_listing() {
        let (_dir, base) = base();
        write(&base, "global/profile.md", PROFILE, "new").unwrap();
        write(&base, "global/topics/habits.md", "# Habits\n", "new").unwrap();
        let rendered = render_listing(&list_entries(&base, MemoryScope::Global, ""));
        assert_eq!(
            rendered,
            "<memory_listing>\n\
             - global/profile.md [note] — Who they are: name, role, employer. [aliases: me, the user] [sources: chat]\n\
             - global/topics/habits.md [note] — Habits\n\
             </memory_listing>"
        );
    }

    #[test]
    fn test_render_listing_empty() {
        assert_eq!(
            render_listing(&[]),
            "<memory_listing>\n(empty)\n</memory_listing>"
        );
    }

    #[test]
    fn test_render_profile_and_preferences_strip_frontmatter() {
        let (_dir, base) = base();
        write(&base, "global/profile.md", PROFILE, "new").unwrap();
        assert_eq!(
            render_profile(&base),
            "<profile>\n- [stated] Works on the kimi-code CLI.\n</profile>"
        );
        assert_eq!(
            render_preferences(&base),
            "<preferences>\n(empty)\n</preferences>"
        );
        write(
            &base,
            "global/preferences.md",
            "---\nname: preferences\ndescription: How they want replies.\n---\n\n- [stated] Prefers short answers.\n",
            "new",
        )
        .unwrap();
        assert_eq!(
            render_preferences(&base),
            "<preferences>\n- [stated] Prefers short answers.\n</preferences>"
        );
    }

    #[test]
    fn test_project_id_for_normalizes_separators() {
        assert_eq!(
            project_id_for(Path::new("G:/kimi/kimi-code")),
            project_id_for(Path::new("G:\\kimi\\kimi-code"))
        );
        assert_eq!(
            project_id_for(Path::new("G:/kimi/kimi-code")),
            "28c0fe7f6661"
        );
    }

    #[test]
    fn test_memory_base_at() {
        assert_eq!(
            memory_base_at(Path::new("/home/user/.kimi-code")),
            PathBuf::from("/home/user/.kimi-code/memory")
        );
    }

    #[test]
    fn test_parse_list() {
        assert_eq!(parse_list("[a, b]"), vec!["a", "b"]);
        assert_eq!(parse_list("[]"), Vec::<String>::new());
        assert_eq!(parse_list("chat"), vec!["chat"]);
        assert_eq!(
            parse_list("[\"quoted name\", 'other']"),
            vec!["quoted name", "other"]
        );
        assert_eq!(parse_list(""), Vec::<String>::new());
    }

    #[test]
    fn test_append_line_keeps_one_newline() {
        assert_eq!(append_line("", "a"), "a\n");
        assert_eq!(append_line("a", "b"), "a\nb\n");
        assert_eq!(append_line("a\n", "b"), "a\nb\n");
        assert_eq!(append_line("a\n", "b\n"), "a\nb\n");
    }
}
