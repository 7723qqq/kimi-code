//! ListDirectory — compact 2-level directory tree for LLM context.
//!
//! Ported for `kimi-agent` (P26 批 2).

use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::turn_loop::types::ExecutableToolResult;

pub const LIST_DIR_ROOT_WIDTH: usize = 30;
pub const LIST_DIR_CHILD_WIDTH: usize = 10;

#[derive(Debug, Clone)]
struct Entry {
    name: String,
    is_dir: bool,
}

pub fn execute_list_directory(root_dir: &Path, args: &Value) -> Option<ExecutableToolResult> {
    let raw_path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let collapse_hidden = args
        .get("collapse_hidden_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let target_dir = if raw_path.is_empty() || raw_path == "." {
        root_dir.to_path_buf()
    } else {
        let candidate = if Path::new(raw_path).is_absolute() {
            Path::new(raw_path).to_path_buf()
        } else {
            root_dir.join(raw_path)
        };
        match std::fs::canonicalize(&candidate) {
            Ok(p) => {
                if !p.starts_with(root_dir) {
                    return None; // Sandbox escape fallback
                }
                p
            }
            Err(e) => {
                return Some(ExecutableToolResult {
                    content: format!("Directory does not exist: {raw_path} ({e})"),
                    is_error: true,
                    note: None,
                });
            }
        }
    };

    if !target_dir.is_dir() {
        return Some(ExecutableToolResult {
            content: format!("{} is not a directory", target_dir.display()),
            is_error: true,
            note: None,
        });
    }

    let output = render_directory_tree(&target_dir, collapse_hidden);
    Some(ExecutableToolResult {
        content: output,
        is_error: false,
        note: None,
    })
}

pub fn render_directory_tree(dir_path: &Path, collapse_hidden: bool) -> String {
    let (root_entries, total_root, readable) = collect_entries(dir_path, LIST_DIR_ROOT_WIDTH);
    if !readable {
        return "(unreadable directory)".to_string();
    }
    if root_entries.is_empty() {
        return "(empty directory)".to_string();
    }

    let mut lines = Vec::new();
    for entry in &root_entries {
        if entry.is_dir {
            lines.push(format!("{}/", entry.name));
            if !should_collapse_directory(entry, collapse_hidden) {
                let child_path = dir_path.join(&entry.name);
                let (child_entries, total_children, child_readable) =
                    collect_entries(&child_path, LIST_DIR_CHILD_WIDTH);
                if child_readable {
                    for child in &child_entries {
                        let suffix = if child.is_dir { "/" } else { "" };
                        lines.push(format!("  {}{}", child.name, suffix));
                    }
                    if total_children > child_entries.len() {
                        let remaining = total_children - child_entries.len();
                        lines.push(format!("  ... and {remaining} more"));
                    }
                }
            }
        } else {
            lines.push(entry.name.clone());
        }
    }

    if total_root > root_entries.len() {
        let remaining = total_root - root_entries.len();
        lines.push(format!("... and {remaining} more"));
    }

    lines.join("\n")
}

fn collect_entries(dir_path: &Path, max_width: usize) -> (Vec<Entry>, usize, bool) {
    let mut all: Vec<Entry> = Vec::new();

    match fs::read_dir(dir_path) {
        Ok(iter) => {
            for entry in iter.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                all.push(Entry { name, is_dir });
            }
        }
        Err(_) => {
            return (Vec::new(), 0, false);
        }
    }

    let total = all.len();

    // Sort: directories first, then alphabetically (case-insensitive).
    all.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let entries = if all.len() > max_width {
        all.into_iter().take(max_width).collect()
    } else {
        all
    };

    (entries, total, true)
}

fn should_collapse_directory(entry: &Entry, collapse_hidden: bool) -> bool {
    collapse_hidden && entry.is_dir && entry.name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_list_directory_empty() {
        let temp = TempDir::new().unwrap();
        let rendered = render_directory_tree(temp.path(), false);
        assert_eq!(rendered, "(empty directory)");
    }

    #[test]
    fn test_list_directory_structure() {
        let temp = TempDir::new().unwrap();
        let p = temp.path();

        fs::create_dir(p.join("subdir")).unwrap();
        fs::write(p.join("subdir").join("nested.txt"), "nested").unwrap();
        fs::write(p.join("file1.txt"), "hello").unwrap();
        fs::write(p.join("file2.rs"), "world").unwrap();

        let rendered = render_directory_tree(p, false);
        assert!(rendered.contains("subdir/"));
        assert!(rendered.contains("  nested.txt"));
        assert!(rendered.contains("file1.txt"));
        assert!(rendered.contains("file2.rs"));
    }
}
