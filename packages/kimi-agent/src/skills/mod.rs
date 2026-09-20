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
    /// UI-scope whitelist (v2 `SkillScope`: `tui` | `web`, #3843). `None`
    /// keeps the skill visible everywhere; a scope list restricts it to
    /// clients whose own mode appears in the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
}

/// Skill scope values (v2 `SkillScope`, #3843): `tui` | `web`. `None` keeps
/// the skill visible everywhere.
pub type SkillScopes = Option<Vec<String>>;

/// Parse `scopes` from a frontmatter value: a bracketed list
/// (`[tui, web]`), a comma-separated bare form (`tui, web`), or a single
/// token. Unknown tokens are dropped; an empty result stays `None`.
fn parse_scopes_value(val: &str) -> SkillScopes {
    let cleaned = val.trim().trim_start_matches('[').trim_end_matches(']');
    let scopes: Vec<String> = cleaned
        .split(',')
        .map(|token| {
            token
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase()
        })
        .filter(|token| matches!(token.as_str(), "tui" | "web"))
        .collect();
    if scopes.is_empty() {
        None
    } else {
        Some(scopes)
    }
}

/// Parse metadata from Markdown content with optional YAML frontmatter.
pub fn parse_skill_metadata(content: &str, fallback_name: &str) -> (String, String, bool) {
    let (name, description, disable_model_invocation, _scopes) =
        parse_skill_metadata_with_scopes(content, fallback_name);
    (name, description, disable_model_invocation)
}

/// [`parse_skill_metadata`] plus the `scopes` frontmatter field.
pub fn parse_skill_metadata_with_scopes(
    content: &str,
    fallback_name: &str,
) -> (String, String, bool, SkillScopes) {
    let trimmed = content.trim_start();
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    let mut disable_model_invocation = false;
    let mut scopes: SkillScopes = None;

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
            } else if let Some(val) = line.strip_prefix("scopes:") {
                scopes = parse_scopes_value(val);
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

    (name, description, disable_model_invocation, scopes)
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
                let (name, desc, disable_inv, scopes) =
                    parse_skill_metadata_with_scopes(&content, &file_name);
                let normalized_key = name.to_lowercase();
                if seen.insert(normalized_key) {
                    let path_str = skill_file.to_string_lossy().replace('\\', "/");
                    out.push(SkillDescriptor {
                        name,
                        description: desc,
                        source: source.to_string(),
                        path: path_str,
                        disable_model_invocation: disable_inv,
                        scopes,
                    });
                }
            }
        } else if file_type.is_file()
            && file_name.ends_with(".md")
            && !file_name.eq_ignore_ascii_case("readme.md")
        {
            let base_name = file_name.trim_end_matches(".md");
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                let (name, desc, disable_inv, scopes) =
                    parse_skill_metadata_with_scopes(&content, base_name);
                let normalized_key = name.to_lowercase();
                if seen.insert(normalized_key) {
                    let path_str = entry.path().to_string_lossy().replace('\\', "/");
                    out.push(SkillDescriptor {
                        name,
                        description: desc,
                        source: source.to_string(),
                        path: path_str,
                        disable_model_invocation: disable_inv,
                        scopes,
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
            scopes: None,
        },
        SkillDescriptor {
            name: "update-config".into(),
            description: "Inspect or edit kimi-code's own config — config.toml and tui.toml. Use when the user asks what a setting does, wants to change one, or needs to fix a deprecated config.".into(),
            source: "builtin".into(),
            path: "builtin://update-config".into(),
            disable_model_invocation: false,
            scopes: None,
        },
        SkillDescriptor {
            name: "write-goal".into(),
            description: "Help the user craft a well-specified /goal objective for goal mode — turn a rough intention into a completion contract with a clear finish line, proof, boundaries, and stop rule.".into(),
            source: "builtin".into(),
            path: "builtin://write-goal".into(),
            disable_model_invocation: false,
            scopes: None,
        },
        // v2 #3843: the theme editor drives TUI-only dialog flows, so it is
        // marked tui-scoped and web clients drop it from their palettes.
        SkillDescriptor {
            name: "custom-theme".into(),
            description: "Create a custom color theme for the terminal UI. Define your own palette as a JSON file in ~/.kimi-code/themes/, or generate one interactively.".into(),
            source: "builtin".into(),
            path: "builtin://custom-theme".into(),
            disable_model_invocation: false,
            scopes: Some(vec!["tui".into()]),
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
///
/// This is the "merge every available directory" default; callers that read
/// `merge_all_available_skills` from a config file use
/// [`scan_all_skills_with_extra_and_merge`] instead.
pub fn scan_all_skills_with_extra(
    workspace_root: Option<&Path>,
    extra_dirs: &[PathBuf],
) -> Vec<SkillDescriptor> {
    scan_all_skills_with_extra_and_merge(workspace_root, extra_dirs, true)
}

/// [`scan_all_skills_with_extra`] with the `merge_all_available_skills`
/// switch (schema; documented default `true`).
///
/// A scope group scans every directory it declares only while merging is on.
/// With merging off the group contributes just its first existing directory
/// (v2 `pushBrandGroup`'s `pushFirstExisting` fallback), so the flag selects
/// one scope's skills instead of layering `.agents/skills` and
/// `.kimi-code/skills` together. `extra_skill_dirs` and the builtins are
/// configured roots rather than brand groups, so the flag never drops them.
///
/// The switch selects one directory where this scan used to layer two: v2
/// gates only its single-element brand groups (`[.kimi-code/skills]`, and
/// `[skills]` under the brand home), so its `pushFirstExisting` fallback
/// resolves to the very directory merging keeps and the key is inert there.
/// The fork folds each scope's brand and generic directory into one group,
/// which is what gives the documented "from all available directories"
/// reading something to switch between.
pub fn scan_all_skills_with_extra_and_merge(
    workspace_root: Option<&Path>,
    extra_dirs: &[PathBuf],
    merge_all_available_skills: bool,
) -> Vec<SkillDescriptor> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    // 1. Project skills
    let project_dirs: Vec<PathBuf> = workspace_root
        .map(|root| {
            vec![
                root.join(".agents").join("skills"),
                root.join(".kimi-code").join("skills"),
            ]
        })
        .unwrap_or_default();
    scan_scope_group(
        &project_dirs,
        "project",
        merge_all_available_skills,
        &mut out,
        &mut seen,
    );

    // 1b. `extra_skill_dirs`: additional scan roots the user declared.
    for dir in extra_dirs {
        scan_directory(dir, "project", &mut out, &mut seen);
    }

    // 2. User skills
    let home_path = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let home = PathBuf::from(home_path);

    let user_dirs = vec![
        home.join(".kimi-code").join("skills"),
        home.join(".agents").join("skills"),
    ];
    scan_scope_group(
        &user_dirs,
        "user",
        merge_all_available_skills,
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

/// Scan one scope's directories: all of them when merging is on, else only
/// the first that exists, so a scope with no directory still contributes
/// nothing rather than shadowing a lower-precedence one.
fn scan_scope_group(
    dirs: &[PathBuf],
    source: &str,
    merge_all_available_skills: bool,
    out: &mut Vec<SkillDescriptor>,
    seen: &mut HashSet<String>,
) {
    if merge_all_available_skills {
        for dir in dirs {
            scan_directory(dir, source, out, seen);
        }
        return;
    }
    if let Some(first) = dirs.iter().find(|dir| dir.is_dir()) {
        scan_directory(first, source, out, seen);
    }
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

    #[test]
    fn test_merge_switch_limits_scope_group_to_first_existing_directory() {
        let temp_dir = tempfile::tempdir().unwrap();
        let proj_root = temp_dir.path();

        let generic = proj_root
            .join(".agents")
            .join("skills")
            .join("generic-skill");
        std::fs::create_dir_all(&generic).unwrap();
        std::fs::write(
            generic.join("SKILL.md"),
            "---\nname: generic-skill\ndescription: From .agents\n---\n",
        )
        .unwrap();
        let brand = proj_root
            .join(".kimi-code")
            .join("skills")
            .join("brand-skill");
        std::fs::create_dir_all(&brand).unwrap();
        std::fs::write(
            brand.join("SKILL.md"),
            "---\nname: brand-skill\ndescription: From .kimi-code\n---\n",
        )
        .unwrap();

        // Merging (the documented default) layers both project directories.
        let merged = scan_all_skills_with_extra_and_merge(Some(proj_root), &[], true);
        assert!(merged.iter().any(|s| s.name == "generic-skill"));
        assert!(merged.iter().any(|s| s.name == "brand-skill"));

        // With merging off the project group keeps only `.agents/skills`, its
        // first existing directory, so `.kimi-code/skills` goes unscanned.
        let selected = scan_all_skills_with_extra_and_merge(Some(proj_root), &[], false);
        assert!(selected.iter().any(|s| s.name == "generic-skill"));
        assert!(
            !selected.iter().any(|s| s.name == "brand-skill"),
            "merging off must not scan the group's second directory"
        );

        // Builtins stay regardless of the switch.
        assert!(selected.iter().any(|s| s.name == "check-kimi-code-docs"));
    }

    #[test]
    fn test_parse_scopes_frontmatter() {
        // Bracketed list, bare list, and single-token forms all parse.
        let (.., scopes) = parse_skill_metadata_with_scopes(
            "---\nname: s\ndescription: d\nscopes: [tui]\n---\nbody",
            "s",
        );
        assert_eq!(scopes, Some(vec!["tui".into()]));

        let (.., scopes) = parse_skill_metadata_with_scopes(
            "---\nname: s\ndescription: d\nscopes: [tui, web]\n---\nbody",
            "s",
        );
        assert_eq!(scopes, Some(vec!["tui".into(), "web".into()]));

        let (.., scopes) = parse_skill_metadata_with_scopes(
            "---\nname: s\ndescription: d\nscopes: web\n---\nbody",
            "s",
        );
        assert_eq!(scopes, Some(vec!["web".into()]));

        // Unknown tokens are dropped; nothing valid stays None.
        let (.., scopes) = parse_skill_metadata_with_scopes(
            "---\nname: s\ndescription: d\nscopes: [cli, ide]\n---\nbody",
            "s",
        );
        assert_eq!(scopes, None);
    }

    #[test]
    fn test_custom_theme_builtin_is_tui_scoped() {
        let list = builtin_skills();
        let theme = list
            .iter()
            .find(|s| s.name == "custom-theme")
            .expect("custom-theme builtin");
        assert_eq!(theme.scopes, Some(vec!["tui".into()]));
        // The unscoped builtins stay visible everywhere.
        let docs = list
            .iter()
            .find(|s| s.name == "check-kimi-code-docs")
            .unwrap();
        assert_eq!(docs.scopes, None);
    }
}
