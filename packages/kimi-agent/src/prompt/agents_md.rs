//! AGENTS.md cascading and discovery for Kimi Agent system prompts.
//!
//! Discovers and loads user-global (`~/.kimi-code/AGENTS.md`, `~/.agents/AGENTS.md`)
//! and workspace-local (`.kimi-code/AGENTS.md`, `AGENTS.md`, `agents.md`) instructions,
//! wrapping each section with `<!-- From: <path> -->` and enforcing byte warnings.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const AGENTS_MD_RECOMMENDED_MAX_BYTES: usize = 32 * 1024;
pub const AGENTS_MD_PLAIN_NAMES: &[&str] = &["AGENTS.md", "agents.md"];

/// Result of loading and cascading AGENTS.md instruction files.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadedAgentsMd {
    pub content: String,
    pub warning: Option<String>,
    pub paths: Vec<String>,
}

/// Discovered single AGENTS.md file.
#[derive(Debug, Clone)]
struct AgentFile {
    path: String,
    content: String,
}

/// Get user home directory in a cross-platform way.
fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Normalize path string with forward slashes.
fn normalize_path_display(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

/// Key used for path deduplication (case-insensitive on Windows).
fn dedupe_key(path_str: &str) -> String {
    if cfg!(target_os = "windows") {
        path_str.to_lowercase()
    } else {
        path_str.to_string()
    }
}

/// Read an instruction file if it is non-empty.
fn read_agent_file(path: &Path) -> Option<AgentFile> {
    if !path.is_file() {
        return None;
    }
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(AgentFile {
                    path: normalize_path_display(path),
                    content: trimmed.to_string(),
                })
            }
        }
        Err(_) => None,
    }
}

/// Load and aggregate all relevant AGENTS.md files for a workspace.
pub fn load_agents_md(workspace_root: &Path, custom_brand_home: Option<&Path>) -> LoadedAgentsMd {
    let mut discovered: Vec<AgentFile> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut collect = |path: PathBuf| -> bool {
        if let Some(file) = read_agent_file(&path) {
            let key = dedupe_key(&file.path);
            if seen.insert(key) {
                discovered.push(file);
                return true;
            }
        }
        false
    };

    // 1. User brand home: ~/.kimi-code/AGENTS.md
    if let Some(bh) = custom_brand_home {
        collect(bh.join("AGENTS.md"));
    } else if let Some(home) = user_home_dir() {
        collect(home.join(".kimi-code").join("AGENTS.md"));
        // Generic fallbacks: ~/.agents/AGENTS.md
        for name in AGENTS_MD_PLAIN_NAMES {
            if collect(home.join(".agents").join(name)) {
                break;
            }
        }
    }

    // 2. Workspace root: .kimi-code/AGENTS.md, AGENTS.md, agents.md
    collect(workspace_root.join(".kimi-code").join("AGENTS.md"));
    for name in AGENTS_MD_PLAIN_NAMES {
        if collect(workspace_root.join(name)) {
            break;
        }
    }

    // Render joined content with provenance headers
    let mut rendered_sections: Vec<String> = Vec::new();
    let mut paths = Vec::new();

    for file in &discovered {
        paths.push(file.path.clone());
        rendered_sections.push(format!("<!-- From: {} -->\n{}", file.path, file.content));
    }

    let content = rendered_sections.join("\n\n");
    let total_bytes = content.len();

    let warning = if total_bytes > AGENTS_MD_RECOMMENDED_MAX_BYTES {
        let kb = (total_bytes as f64) / 1024.0;
        let max_kb = (AGENTS_MD_RECOMMENDED_MAX_BYTES as f64) / 1024.0;
        Some(format!(
            "AGENTS.md total {:.1} KB exceeds recommended {:.0} KB. Large instruction files increase cost and latency; consider trimming.",
            kb, max_kb
        ))
    } else {
        None
    };

    LoadedAgentsMd {
        content,
        warning,
        paths,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_load_agents_md_empty_workspace() {
        let temp = tempdir().unwrap();
        let loaded = load_agents_md(temp.path(), Some(temp.path()));
        assert_eq!(
            loaded,
            LoadedAgentsMd {
                content: String::new(),
                warning: None,
                paths: Vec::new(),
            }
        );
    }

    #[test]
    fn test_load_agents_md_ignores_empty_and_whitespace_only_files() {
        let temp_ws = tempdir().unwrap();
        let kimi_code_dir = temp_ws.path().join(".kimi-code");
        std::fs::create_dir(&kimi_code_dir).unwrap();
        std::fs::write(kimi_code_dir.join("AGENTS.md"), "   \n\t\r\n  ").unwrap();
        std::fs::write(temp_ws.path().join("AGENTS.md"), "").unwrap();

        let loaded = load_agents_md(temp_ws.path(), Some(temp_ws.path()));
        assert_eq!(loaded.content, "");
        assert!(loaded.paths.is_empty());
        assert_eq!(loaded.warning, None);
    }

    #[test]
    fn test_load_agents_md_cascades_home_and_workspace() {
        let temp_home = tempdir().unwrap();
        let temp_ws = tempdir().unwrap();

        let home_file = temp_home.path().join("AGENTS.md");
        let ws_file = temp_ws.path().join("AGENTS.md");
        std::fs::write(&home_file, "# Global Rules\nBe nice.").unwrap();
        std::fs::write(&ws_file, "# Local Rules\nUse Rust.").unwrap();

        let loaded = load_agents_md(temp_ws.path(), Some(temp_home.path()));
        let expected_home_path = normalize_path_display(&home_file);
        let expected_ws_path = normalize_path_display(&ws_file);

        assert_eq!(
            loaded.paths,
            vec![expected_home_path.clone(), expected_ws_path.clone()]
        );
        let expected_content = format!(
            "<!-- From: {} -->\n# Global Rules\nBe nice.\n\n<!-- From: {} -->\n# Local Rules\nUse Rust.",
            expected_home_path, expected_ws_path
        );
        assert_eq!(loaded.content, expected_content);
        assert_eq!(loaded.warning, None);
    }

    #[test]
    fn test_load_agents_md_workspace_kimi_code_and_plain_cascade() {
        let temp_ws = tempdir().unwrap();
        let kimi_code_dir = temp_ws.path().join(".kimi-code");
        std::fs::create_dir(&kimi_code_dir).unwrap();

        let sub_agents = kimi_code_dir.join("AGENTS.md");
        let root_agents = temp_ws.path().join("AGENTS.md");
        std::fs::write(&sub_agents, "Specific workspace config").unwrap();
        std::fs::write(&root_agents, "General workspace config").unwrap();

        let empty_home = tempdir().unwrap();
        let loaded = load_agents_md(temp_ws.path(), Some(empty_home.path()));

        let expected_sub_path = normalize_path_display(&sub_agents);
        let expected_root_path = normalize_path_display(&root_agents);

        assert_eq!(
            loaded.paths,
            vec![expected_sub_path.clone(), expected_root_path.clone()]
        );
        let expected_content = format!(
            "<!-- From: {} -->\nSpecific workspace config\n\n<!-- From: {} -->\nGeneral workspace config",
            expected_sub_path, expected_root_path
        );
        assert_eq!(loaded.content, expected_content);
        assert_eq!(loaded.warning, None);
    }

    #[test]
    fn test_load_agents_md_fallback_to_lowercase_agents() {
        let temp_ws = tempdir().unwrap();
        let lower_agents = temp_ws.path().join("agents.md");
        std::fs::write(&lower_agents, "Fallback lowercase config").unwrap();

        let empty_home = tempdir().unwrap();
        let loaded = load_agents_md(temp_ws.path(), Some(empty_home.path()));

        // On case-insensitive filesystems (Windows), checking the first candidate "AGENTS.md"
        // in AGENTS_MD_PLAIN_NAMES succeeds because the filesystem resolves it to the existing file.
        // On case-sensitive filesystems (Linux), "AGENTS.md" does not exist and it falls back to "agents.md".
        let expected_name = if cfg!(target_os = "windows") {
            "AGENTS.md"
        } else {
            "agents.md"
        };
        let expected_path = normalize_path_display(&temp_ws.path().join(expected_name));
        assert_eq!(loaded.paths, vec![expected_path.clone()]);
        assert_eq!(
            loaded.content,
            format!(
                "<!-- From: {} -->\nFallback lowercase config",
                expected_path
            )
        );

        // Deduplication test: when both .kimi-code/AGENTS.md and root AGENTS.md exist,
        // each distinct location is loaded once and not duplicated.
        let upper_agents = temp_ws.path().join("AGENTS.md");
        std::fs::write(&upper_agents, "Primary uppercase config").unwrap();

        let loaded2 = load_agents_md(temp_ws.path(), Some(empty_home.path()));
        let expected_upper_path = normalize_path_display(&upper_agents);
        assert_eq!(loaded2.paths, vec![expected_upper_path.clone()]);
        assert_eq!(
            loaded2.content,
            format!(
                "<!-- From: {} -->\nPrimary uppercase config",
                expected_upper_path
            )
        );
    }

    #[test]
    fn test_load_agents_md_deduplicates_same_path() {
        let temp_ws = tempdir().unwrap();
        let agents_file = temp_ws.path().join("AGENTS.md");
        std::fs::write(&agents_file, "Duplicate test").unwrap();

        // Pass same directory as brand_home and workspace_root
        let loaded = load_agents_md(temp_ws.path(), Some(temp_ws.path()));
        let expected_path = normalize_path_display(&agents_file);

        assert_eq!(loaded.paths, vec![expected_path.clone()]);
        assert_eq!(
            loaded.content,
            format!("<!-- From: {} -->\nDuplicate test", expected_path)
        );
    }

    #[test]
    fn test_load_agents_md_warning_on_exceeded_budget() {
        let temp_ws = tempdir().unwrap();
        let empty_home = tempdir().unwrap();

        // 1. Content exactly within 32 KB budget has no warning
        let safe_content = "x".repeat(30 * 1024);
        std::fs::write(temp_ws.path().join("AGENTS.md"), &safe_content).unwrap();
        let safe_loaded = load_agents_md(temp_ws.path(), Some(empty_home.path()));
        assert_eq!(safe_loaded.warning, None);

        // 2. Content exceeding 32 KB threshold generates exact formatted warning
        let big_content = "a".repeat(35 * 1024);
        std::fs::write(temp_ws.path().join("AGENTS.md"), &big_content).unwrap();

        let loaded = load_agents_md(temp_ws.path(), Some(empty_home.path()));
        let total_bytes = loaded.content.len();
        assert!(total_bytes > AGENTS_MD_RECOMMENDED_MAX_BYTES);

        let kb = (total_bytes as f64) / 1024.0;
        let max_kb = (AGENTS_MD_RECOMMENDED_MAX_BYTES as f64) / 1024.0;
        let expected_warning = format!(
            "AGENTS.md total {:.1} KB exceeds recommended {:.0} KB. Large instruction files increase cost and latency; consider trimming.",
            kb, max_kb
        );

        assert_eq!(loaded.warning, Some(expected_warning));
    }
}
