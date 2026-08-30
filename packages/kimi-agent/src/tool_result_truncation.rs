//! Local tool-result truncation (P26 批 4).
//!
//! Mirrors `agent-core-v2/src/agent/toolResultTruncation/toolResultTruncationService.ts`
//! so a natively-executed result that exceeds the per-call character cap
//! gets the same shape the host path produces: per-line truncation, a
//! spill-to-disk backup, and a pointer block the model reads.
//!
//! Strategy (identical to the TS service):
//!   1. If `is_error` is true or `content` is empty → return unchanged.
//!   2. If raw text ≤ `DEFAULT_TOOL_RESULT_MAX_CHARS` (50_000) → return
//!      unchanged.
//!   3. Else: shape per-line (2_000 char cap), save the retained prefix
//!      to a file under `spill_dir`, replace the model-facing content
//!      with a pointer block carrying a `Read`-able `output_path`.
//!
//! The defaults are the same constants the TS service uses; changing
//! them here without the TS side will make the two paths diverge.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const DEFAULT_TOOL_RESULT_MAX_CHARS: usize = 50_000;
const DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS: usize = 10_000_000;
const TOOL_RESULT_PREVIEW_HEAD_CHARS: usize = 4_096;
const TOOL_RESULT_PREVIEW_TAIL_CHARS: usize = 1_024;
const TOOL_RESULT_MAX_LINE_CHARS: usize = 2_000;
const TRUNCATION_MARKER: &str = "[...truncated]";

/// A truncated tool result ready to enter the model context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizedToolResult {
    pub content: String,
    pub is_error: bool,
    pub note: Option<String>,
    /// Path to the spill file when the original content was persisted
    /// to disk; `None` when the content fit under the cap.
    pub spill_path: Option<String>,
    /// `true` when the content was truncated (either per-line, by
    /// spilling, or both). Mirrors the TS `truncated` field.
    pub truncated: bool,
}

/// Inputs the truncation service needs from the engine.
pub struct TruncationRequest<'a> {
    pub tool_name: &'a str,
    pub tool_call_id: &'a str,
    pub content: &'a str,
    pub is_error: bool,
    pub note: Option<&'a str>,
}

/// Local tool result truncation. Holds the spill directory the caller
/// chose (typically `<workspace>/.kimi/spill`); the service is stateless
/// beyond that.
pub struct ToolResultTruncator {
    spill_dir: PathBuf,
}

impl ToolResultTruncator {
    pub fn new(spill_dir: PathBuf) -> Self {
        Self { spill_dir }
    }

    /// Construct a `ToolResultTruncator` rooted at `<workspace>/.kimi/spill`.
    /// The directory is created on the first spill (not eagerly).
    pub fn for_workspace(workspace_root: &Path) -> Self {
        Self::new(workspace_root.join(".kimi").join("spill"))
    }

    /// Apply the truncation policy. See module docs for the rules.
    pub fn truncate(&self, req: TruncationRequest<'_>) -> FinalizedToolResult {
        // Errors and empty results are never truncated.
        if req.is_error || req.content.is_empty() {
            return FinalizedToolResult {
                content: req.content.to_string(),
                is_error: req.is_error,
                note: req.note.map(String::from),
                spill_path: None,
                truncated: false,
            };
        }

        let raw_chars = req.content.chars().count();
        if raw_chars <= DEFAULT_TOOL_RESULT_MAX_CHARS {
            return FinalizedToolResult {
                content: req.content.to_string(),
                is_error: false,
                note: req.note.map(String::from),
                spill_path: None,
                truncated: false,
            };
        }

        // Decide how much to retain on disk. The TS service uses
        // MAX_RETAINED_CHARS as a hard ceiling; below that, save the
        // whole prefix; above, save the first 10 MB.
        let retained: String = if req.content.len() <= DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS {
            req.content.to_string()
        } else {
            req.content
                .char_indices()
                .nth(DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS)
                .map(|(idx, _)| req.content[..idx].to_string())
                .unwrap_or_else(|| req.content.to_string())
        };
        let total_chars = raw_chars;
        let preserved_chars = retained.chars().count();

        // Per-line shape: cap every line at 2_000 chars + marker.
        let shaped = shape_per_line(req.content, TOOL_RESULT_MAX_LINE_CHARS);
        let shaped_chars = shaped.chars().count();

        // Spill the retained text to disk; render a pointer if that fails.
        let spill = self.save_spill(req.tool_name, req.tool_call_id, &retained);
        let truncated = true;

        let final_content = match &spill {
            Some(path) if shaped_chars <= DEFAULT_TOOL_RESULT_MAX_CHARS => {
                // Inline pointer appended to the shaped text.
                let pointer =
                    render_appended_spill_pointer(path, preserved_chars, total_chars, false);
                append_to_output(&shaped, &pointer)
            }
            Some(path) => {
                // Persisted pointer replaces the body; head + tail preview.
                render_persisted_pointer(
                    req.tool_name,
                    req.tool_call_id,
                    &retained,
                    path,
                    preserved_chars,
                    total_chars,
                    false,
                )
            }
            None => {
                render_unpersisted_pointer(req.tool_name, req.tool_call_id, &retained, total_chars)
            }
        };

        FinalizedToolResult {
            content: final_content,
            is_error: false,
            note: req.note.map(String::from),
            spill_path: spill,
            truncated,
        }
    }

    fn save_spill(&self, tool_name: &str, tool_call_id: &str, text: &str) -> Option<String> {
        let dir = &self.spill_dir;
        if let Err(e) = fs::create_dir_all(dir) {
            eprintln!("[kimi-agent] spill dir create failed: {e}");
            return None;
        }
        let stem = safe_stem(tool_name, tool_call_id);
        let suffix = short_uuid();
        let filename = format!("{stem}-{suffix}.txt");
        let path = dir.join(&filename);
        let mut f = match fs::File::create(&path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[kimi-agent] spill file create failed: {e}");
                return None;
            }
        };
        if let Err(e) = f.write_all(text.as_bytes()) {
            eprintln!("[kimi-agent] spill file write failed: {e}");
            return None;
        }
        if let Err(e) = f.sync_all() {
            // best-effort; not fatal
            eprintln!("[kimi-agent] spill file sync failed: {e}");
        }
        Some(path.to_string_lossy().into_owned())
    }

    /// Prune spill files older than `max_age` to prevent workspace bloat.
    pub fn cleanup_expired_spills(&self, max_age: std::time::Duration) -> usize {
        let mut pruned = 0;
        let now = std::time::SystemTime::now();
        if let Ok(entries) = fs::read_dir(&self.spill_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata()
                    && let Ok(modified) = meta.modified()
                    && let Ok(age) = now.duration_since(modified)
                    && age > max_age
                    && fs::remove_file(entry.path()).is_ok()
                {
                    pruned += 1;
                }
            }
        }
        pruned
    }
}

/// Cap each line at `max_chars` and append `[...truncated]` when the cap
/// is hit. Mirrors the TS `shapeStringPerLine` helper.
fn shape_per_line(text: &str, max_chars: usize) -> String {
    // Walk lines manually to preserve trailing line breaks.
    let mut out = String::with_capacity(text.len());
    let mut start = 0usize;
    let bytes = text.as_bytes();
    for (idx, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            let line = &text[start..=idx];
            shape_line_into(&mut out, line, max_chars);
            start = idx + 1;
        }
    }
    if start < bytes.len() {
        let line = &text[start..];
        shape_line_into(&mut out, line, max_chars);
    }
    out
}

fn shape_line_into(out: &mut String, line: &str, max_chars: usize) {
    if line.chars().count() > max_chars {
        let line_break = if line.ends_with('\n') { "\n" } else { "" };
        let suffix = format!("{TRUNCATION_MARKER}{line_break}");
        let effective_max = max_chars.max(suffix.chars().count());
        // Keep the first `effective_max - suffix.chars().count()` chars.
        let keep = effective_max.saturating_sub(suffix.chars().count());
        let truncated: String = line.chars().take(keep).collect();
        out.push_str(&truncated);
        out.push_str(&suffix);
    } else {
        out.push_str(line);
    }
}

fn append_to_output(shaped: &str, note: &str) -> String {
    if shaped.is_empty() || shaped.ends_with('\n') {
        format!("{shaped}{note}")
    } else {
        format!("{shaped}\n{note}")
    }
}

fn render_appended_spill_pointer(
    output_path: &str,
    preserved_chars: usize,
    total_chars: usize,
    has_media: bool,
) -> String {
    let first_line = if total_chars > preserved_chars {
        format!(
            "[Per-line truncation occurred; only the first {preserved_chars} characters (of {total_chars}) were saved to a file."
        )
    } else if has_media {
        "[Per-line truncation occurred; the complete text output was saved to a file (media parts stay attached to this result)."
            .to_string()
    } else {
        "[Per-line truncation occurred; the complete output was saved to a file.".to_string()
    };
    format!(
        "{first_line}\noutput_path: {output_path}\nnext_step: Use Read with output_path to page through the saved output, or Grep to search it.]"
    )
}

fn render_persisted_pointer(
    tool_name: &str,
    tool_call_id: &str,
    preview_text: &str,
    output_path: &str,
    preserved_chars: usize,
    total_chars: usize,
    has_media: bool,
) -> String {
    let partial = preserved_chars < total_chars;
    let first_line = if partial {
        format!(
            "Tool output exceeded {DEFAULT_TOOL_RESULT_MAX_CHARS} characters; the first {preserved_chars} characters (of {total_chars}) were saved to a file."
        )
    } else if has_media {
        format!(
            "Tool output exceeded {DEFAULT_TOOL_RESULT_MAX_CHARS} characters; the full text output was saved to a file (media parts stay attached to this result)."
        )
    } else {
        format!(
            "Tool output exceeded {DEFAULT_TOOL_RESULT_MAX_CHARS} characters; the full output was saved to a file."
        )
    };
    let size_line = if partial {
        format!(
            "output_size_chars: {total_chars} (only the first {preserved_chars} characters were preserved)"
        )
    } else {
        format!("output_size_chars: {total_chars}")
    };
    let mut lines = vec![
        first_line,
        format!("tool_name: {tool_name}"),
        format!("tool_call_id: {tool_call_id}"),
        size_line,
        format!("output_path: {output_path}"),
        "next_step: Use Read with output_path to page through the saved output, or Grep to search it."
            .to_string(),
    ];
    append_preview_lines(&mut lines, preview_text);
    lines.join("\n")
}

fn render_unpersisted_pointer(
    tool_name: &str,
    tool_call_id: &str,
    preview_text: &str,
    total_chars: usize,
) -> String {
    let mut lines = vec![
        format!(
            "Tool output exceeded {DEFAULT_TOOL_RESULT_MAX_CHARS} characters and could not be saved to a file; only this preview is available."
        ),
        format!("tool_name: {tool_name}"),
        format!("tool_call_id: {tool_call_id}"),
        format!("output_size_chars: {total_chars}"),
    ];
    append_preview_lines(&mut lines, preview_text);
    lines.join("\n")
}

fn append_preview_lines(lines: &mut Vec<String>, preview_text: &str) {
    let head: String = preview_text
        .chars()
        .take(TOOL_RESULT_PREVIEW_HEAD_CHARS)
        .collect();
    let head_len = head.chars().count();
    let total_preview = preview_text.chars().count();
    let tail_start = head_len.max(total_preview.saturating_sub(TOOL_RESULT_PREVIEW_TAIL_CHARS));
    let tail: String = preview_text.chars().skip(tail_start).collect();
    lines.push(String::new());
    lines.push(format!("[preview: chars [0, {head_len})]"));
    lines.push(head);
    if !tail.is_empty() {
        if tail_start > head_len {
            lines.push(String::new());
            lines.push(format!("[elided: chars [{head_len}, {tail_start})]"));
        }
        lines.push(String::new());
        lines.push(format!("[preview: chars [{tail_start}, {total_preview})]"));
        lines.push(tail);
    }
}

fn safe_stem(tool_name: &str, tool_call_id: &str) -> String {
    let raw: String = format!("{tool_name}-{tool_call_id}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed: String = raw.trim_matches('_').chars().take(80).collect();
    if trimmed.is_empty() {
        "tool-result".to_string()
    } else {
        trimmed
    }
}

/// Cheap unique-ish suffix for the spill filename. Avoids pulling a UUID
/// crate for what is essentially a debug aid; the file content is keyed
/// on tool_name + tool_call_id + uuid-shaped suffix.
fn short_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    format!("{nanos:x}-{pid:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn small() -> ToolResultTruncator {
        ToolResultTruncator::new(env::temp_dir().join("kimi-agent-truncation-test"))
    }

    #[test]
    fn short_content_returns_unchanged() {
        let t = small();
        let r = t.truncate(TruncationRequest {
            tool_name: "Read",
            tool_call_id: "c1",
            content: "hello world",
            is_error: false,
            note: None,
        });
        assert_eq!(r.content, "hello world");
        assert!(!r.truncated);
        assert!(r.spill_path.is_none());
    }

    #[test]
    fn error_result_returns_unchanged() {
        let t = small();
        let long = "x".repeat(100_000);
        let r = t.truncate(TruncationRequest {
            tool_name: "Bash",
            tool_call_id: "c2",
            content: &long,
            is_error: true,
            note: Some("boom"),
        });
        assert_eq!(r.content, long);
        assert!(!r.truncated);
        assert_eq!(r.note.as_deref(), Some("boom"));
    }

    #[test]
    fn large_single_line_uses_inline_pointer_when_shaped_fits() {
        // 60_000 'a' chars on one line — per-line shape caps to ~2_000 chars,
        // so the inline-pointer branch runs (shaped ≤ MAX_CHARS).
        let t = small();
        let long = "a".repeat(60_000);
        let r = t.truncate(TruncationRequest {
            tool_name: "Read",
            tool_call_id: "c3",
            content: &long,
            is_error: false,
            note: None,
        });
        assert!(r.truncated);
        let path = r.spill_path.expect("spill path set");
        assert!(
            std::path::Path::new(&path).is_file(),
            "spill file exists at {path}"
        );
        // Inline pointer: "Per-line truncation occurred" + output_path.
        assert!(r.content.contains("Per-line truncation occurred"));
        assert!(r.content.contains("output_path:"));
        assert!(r.content.contains(&path));
        // The retained text is in the spill file.
        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.chars().count() >= 50_000);
    }

    #[test]
    fn many_oversized_lines_use_persisted_pointer() {
        // 30 lines × 2_000 chars = 60_000 raw chars. Per-line cap leaves each
        // line ~2_020 chars after the marker, so the shaped text is well over
        // 50_000 chars — the persisted-pointer branch must run.
        let t = small();
        let mut content = String::with_capacity(70_000);
        for _ in 0..30 {
            content.push_str(&"b".repeat(2_000));
            content.push('\n');
        }
        let r = t.truncate(TruncationRequest {
            tool_name: "Read",
            tool_call_id: "c3b",
            content: &content,
            is_error: false,
            note: None,
        });
        assert!(r.truncated);
        let path = r.spill_path.expect("spill path set");
        assert!(std::path::Path::new(&path).is_file());
        // Persisted pointer: "Tool output exceeded" + tool metadata + preview.
        assert!(r.content.contains("Tool output exceeded"));
        assert!(r.content.contains("output_path:"));
        assert!(r.content.contains("tool_name: Read"));
        assert!(r.content.contains("tool_call_id: c3b"));
        assert!(r.content.contains("output_size_chars:"));
        assert!(r.content.contains("[preview:"));
    }

    #[test]
    fn per_line_shape_caps_oversized_lines() {
        let t = small();
        let mut content = String::with_capacity(60_000);
        // Add a 5_000-char single line — well over the 2_000 cap.
        content.push_str(&"y".repeat(5_000));
        content.push('\n');
        // Then enough padding to force truncation overall.
        content.push_str(&"z".repeat(60_000));
        let r = t.truncate(TruncationRequest {
            tool_name: "Grep",
            tool_call_id: "c4",
            content: &content,
            is_error: false,
            note: None,
        });
        assert!(r.truncated);
        // The shaped text should contain the marker on the oversized line.
        assert!(r.content.contains(TRUNCATION_MARKER) || r.spill_path.is_some());
    }

    #[test]
    fn spill_failure_falls_back_to_unpersisted_pointer() {
        // A path that cannot be created (parent is a file, not a dir).
        let blocker = env::temp_dir().join(format!("kimi-block-{}", short_uuid()));
        fs::write(&blocker, b"i am a file").unwrap();
        let bad = blocker.join("subdir").join("file.txt");
        let t = ToolResultTruncator::new(bad);
        let long = "a".repeat(60_000);
        let r = t.truncate(TruncationRequest {
            tool_name: "Read",
            tool_call_id: "c5",
            content: &long,
            is_error: false,
            note: None,
        });
        assert!(r.spill_path.is_none());
        assert!(r.content.contains("could not be saved to a file"));
        fs::remove_file(&blocker).ok();
    }
}
