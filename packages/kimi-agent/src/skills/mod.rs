//! Skill discovery and catalog scanning for Kimi Agent.
//!
//! Scans workspace-local (`.agents/skills`, `.kimi-code/skills`), user-global
//! (`~/.kimi-code/skills`, `~/.agents/skills`), and builtin product skills with
//! precedence: Project > User > Builtin.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Wire-compatible skill descriptor returned by `/api/v1/workspaces/:id/skills`
/// and `/api/v1/sessions/:id/skills`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
    pub name: String,
    pub description: String,
    pub source: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disable_model_invocation: bool,
}

/// Parse metadata from Markdown content with optional YAML frontmatter.
pub fn parse_skill_metadata(content: &str, fallback_name: &str) -> (String, String, bool) {
    let trimmed = content.trim_start();
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    let mut disable_model_invocation = false;

    if let Some(rest) = trimmed.strip_prefix("---")
        && let Some(end_idx) = rest.find("\n---")
    {
        let frontmatter = &rest[..end_idx];
        for line in frontmatter.lines() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("name:") {
                let parsed = val.trim().trim_matches('"').trim_matches('\'');
                if !parsed.is_empty() {
                    name = parsed.to_string();
                }
            } else if let Some(val) = line.strip_prefix("description:") {
                let parsed = val.trim().trim_matches('"').trim_matches('\'');
                if !parsed.is_empty() {
                    description = parsed.to_string();
                }
            } else if let Some(val) = line.strip_prefix("disable-model-invocation:")
                && val.trim().eq_ignore_ascii_case("true")
            {
                disable_model_invocation = true;
            }
        }
    }

    if description.is_empty() {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with('#')
                || line.starts_with("---")
                || line.starts_with("```")
                || line.starts_with('>')
            {
                continue;
            }
            description = line.to_string();
            break;
        }
    }

    (name, description, disable_model_invocation)
}

fn scan_directory(
    dir: &Path,
    source: &str,
    out: &mut Vec<SkillDescriptor>,
    seen: &mut HashSet<String>,
) {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    let mut entries: Vec<_> = read_dir.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let file_name = entry.file_name().to_string_lossy().to_string();

        if file_type.is_dir() {
            // Check sub_dir/SKILL.md or sub_dir/skill.md
            let mut skill_file = entry.path().join("SKILL.md");
            if !skill_file.exists() {
                skill_file = entry.path().join("skill.md");
            }
            if skill_file.is_file()
                && let Ok(content) = std::fs::read_to_string(&skill_file)
            {
                let (name, desc, disable_inv) = parse_skill_metadata(&content, &file_name);
                let normalized_key = name.to_lowercase();
                if seen.insert(normalized_key) {
                    let path_str = skill_file.to_string_lossy().replace('\\', "/");
                    out.push(SkillDescriptor {
                        name,
                        description: desc,
                        source: source.to_string(),
                        path: path_str,
                        disable_model_invocation: disable_inv,
                    });
                }
            }
        } else if file_type.is_file()
            && file_name.ends_with(".md")
            && !file_name.eq_ignore_ascii_case("readme.md")
        {
            let base_name = file_name.trim_end_matches(".md");
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                let (name, desc, disable_inv) = parse_skill_metadata(&content, base_name);
                let normalized_key = name.to_lowercase();
                if seen.insert(normalized_key) {
                    let path_str = entry.path().to_string_lossy().replace('\\', "/");
                    out.push(SkillDescriptor {
                        name,
                        description: desc,
                        source: source.to_string(),
                        path: path_str,
                        disable_model_invocation: disable_inv,
                    });
                }
            }
        }
    }
}

/// Returns builtin product skills defined by Kimi Code.
pub fn builtin_skills() -> Vec<SkillDescriptor> {
    vec![
        SkillDescriptor {
            name: "check-kimi-code-docs".into(),
            description: "Answer questions about the Kimi Code product using the official documentation — CLI usage, configuration, slash commands, features, membership and quota, API onboarding, third-party tool setup, and error codes.".into(),
            source: "builtin".into(),
            path: "builtin://check-kimi-code-docs".into(),
            disable_model_invocation: false,
        },
        SkillDescriptor {
            name: "update-config".into(),
            description: "Inspect or edit kimi-code's own config — config.toml and tui.toml. Use when the user asks what a setting does, wants to change one, or needs to fix a deprecated config.".into(),
            source: "builtin".into(),
            path: "builtin://update-config".into(),
            disable_model_invocation: false,
        },
        SkillDescriptor {
            name: "write-goal".into(),
            description: "Help the user craft a well-specified /goal objective for goal mode — turn a rough intention into a completion contract with a clear finish line, proof, boundaries, and stop rule.".into(),
            source: "builtin".into(),
            path: "builtin://write-goal".into(),
            disable_model_invocation: false,
        },
    ]
}

/// Scan all skills available to the given workspace root, merged with user-level
/// and builtin skills following Project > User > Builtin priority.
pub fn scan_all_skills(workspace_root: Option<&Path>) -> Vec<SkillDescriptor> {
    scan_all_skills_with_extra(workspace_root, &[])
}

/// [`scan_all_skills`] plus the user's `extra_skill_dirs` (schema): those
/// are scanned as project-level skills, after the conventional project
/// directories and before the user/home ones.
pub fn scan_all_skills_with_extra(
    workspace_root: Option<&Path>,
    extra_dirs: &[PathBuf],
) -> Vec<SkillDescriptor> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    // 1. Project skills
    if let Some(root) = workspace_root {
        scan_directory(
            &root.join(".agents").join("skills"),
            "project",
            &mut out,
            &mut seen,
        );
        scan_directory(
            &root.join(".kimi-code").join("skills"),
            "project",
            &mut out,
            &mut seen,
        );
    }

    // 1b. `extra_skill_dirs`: additional scan roots the user declared.
    for dir in extra_dirs {
        scan_directory(dir, "project", &mut out, &mut seen);
    }

    // 2. User skills
    let home_path = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let home = PathBuf::from(home_path);

    scan_directory(
        &home.join(".kimi-code").join("skills"),
        "user",
        &mut out,
        &mut seen,
    );
    scan_directory(
        &home.join(".agents").join("skills"),
        "user",
        &mut out,
        &mut seen,
    );

    // 3. Builtin skills
    for builtin in builtin_skills() {
        let key = builtin.name.to_lowercase();
        if seen.insert(key) {
            out.push(builtin);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_skill_metadata_frontmatter() {
        let raw = r#"---
name: my-custom-skill
description: Does something awesome.
disable-model-invocation: true
---

# Title
Body text here.
"#;
        let (name, desc, disabled) = parse_skill_metadata(raw, "fallback");
        assert_eq!(name, "my-custom-skill");
        assert_eq!(desc, "Does something awesome.");
        assert!(disabled);
    }

    #[test]
    fn test_parse_skill_metadata_without_frontmatter() {
        let raw = r#"# Skill Title

This is the first paragraph describing the skill.
"#;
        let (name, desc, disabled) = parse_skill_metadata(raw, "my-fallback");
        assert_eq!(name, "my-fallback");
        assert_eq!(desc, "This is the first paragraph describing the skill.");
        assert!(!disabled);
    }

    #[test]
    fn test_scan_directory_and_precedence() {
        let temp_dir = tempfile::tempdir().unwrap();
        let proj_root = temp_dir.path();

        let proj_skills = proj_root.join(".agents").join("skills");
        let skill_a = proj_skills.join("skill-a");
        std::fs::create_dir_all(&skill_a).unwrap();
        std::fs::write(
            skill_a.join("SKILL.md"),
            "---\nname: skill-a\ndescription: Project version of A\n---\n",
        )
        .unwrap();

        let list = scan_all_skills(Some(proj_root));
        let found_a = list.iter().find(|s| s.name == "skill-a");
        assert!(found_a.is_some());
        let a = found_a.unwrap();
        assert_eq!(a.source, "project");
        assert_eq!(a.description, "Project version of A");

        // Builtins should also be included
        assert!(list.iter().any(|s| s.name == "check-kimi-code-docs"));
    }
}
