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
    /// A sub-skill of a `has-sub-skill: true` parent (v2 `SkillMetadata
    /// .isSubSkill`). `None` on a normal skill; clients use it to expose the
    /// child under its dotted parent name (`/parent.child`) and the engine's
    /// prompt keeps sub-skills out of the model's catalog — the parent skill is
    /// what the model sees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_sub_skill: Option<bool>,
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

/// Full frontmatter parse: catalog fields plus the `Skill` tool's metadata
/// (`type`, declared `arguments`).
#[derive(Debug, Clone)]
pub struct ParsedSkillMeta {
    pub name: String,
    pub description: String,
    pub disable_model_invocation: bool,
    pub scopes: SkillScopes,
    /// Frontmatter `type` (v2 `SkillMetadata.type`): `prompt` | `inline` |
    /// `flow` | `reference`. `None` defaults to `inline` at render time.
    pub skill_type: Option<String>,
    /// Named arguments declared via frontmatter `arguments` — a bare string,
    /// an inline `[a, b]` list, or a block `- a` list — filtered to valid
    /// names (non-empty, not all digits).
    pub argument_names: Vec<String>,
    /// Frontmatter `has-sub-skill` / `hasSubSkill` (v2 `hasSubSkillEnabled`):
    /// the parent opts its directory's children in as sub-skills.
    pub has_sub_skill: bool,
}

/// Parse metadata from Markdown content with optional YAML frontmatter.
pub fn parse_skill_metadata(content: &str, fallback_name: &str) -> (String, String, bool) {
    let meta = parse_skill_frontmatter(content, fallback_name);
    (meta.name, meta.description, meta.disable_model_invocation)
}

/// Parse the full frontmatter (see [`ParsedSkillMeta`]).
pub fn parse_skill_frontmatter(content: &str, fallback_name: &str) -> ParsedSkillMeta {
    let trimmed = content.trim_start();
    let mut meta = ParsedSkillMeta {
        name: fallback_name.to_string(),
        description: String::new(),
        disable_model_invocation: false,
        scopes: None,
        skill_type: None,
        argument_names: Vec::new(),
        has_sub_skill: false,
    };

    if let Some(rest) = trimmed.strip_prefix("---")
        && let Some(end_idx) = rest.find("\n---")
    {
        let frontmatter = &rest[..end_idx];
        let mut lines = frontmatter.lines().peekable();
        while let Some(line) = lines.next() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("name:") {
                if let Some(parsed) = non_empty_trimmed(val) {
                    meta.name = parsed;
                }
            } else if let Some(val) = line.strip_prefix("description:") {
                if let Some(parsed) = non_empty_trimmed(val) {
                    meta.description = parsed;
                }
            } else if let Some(val) = line.strip_prefix("type:") {
                if let Some(parsed) = non_empty_trimmed(val) {
                    meta.skill_type = Some(parsed);
                }
            } else if (line.strip_prefix("disable-model-invocation:").is_some()
                || line.strip_prefix("disable_model_invocation:").is_some())
                && line
                    .rsplit(':')
                    .next()
                    .is_some_and(|val| val.trim().eq_ignore_ascii_case("true"))
            {
                // v2 `METADATA_ALIASES` accepts both spellings, and the docs
                // and existing skills use the snake_case one.
                meta.disable_model_invocation = true;
            } else if (line.strip_prefix("has-sub-skill:").is_some()
                || line.strip_prefix("hasSubSkill:").is_some())
                && line
                    .rsplit(':')
                    .next()
                    .is_some_and(|val| val.trim().eq_ignore_ascii_case("true"))
            {
                meta.has_sub_skill = true;
            } else if let Some(val) = line.strip_prefix("scopes:") {
                meta.scopes = parse_scopes_value(val);
            } else if let Some(val) = line.strip_prefix("arguments:") {
                meta.argument_names = parse_argument_names_value(val, &mut lines);
            }
        }
    }

    if meta.description.is_empty() {
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
            meta.description = line.to_string();
            break;
        }
    }

    meta
}

fn non_empty_trimmed(val: &str) -> Option<String> {
    let parsed = val.trim().trim_matches('"').trim_matches('\'');
    if parsed.is_empty() {
        None
    } else {
        Some(parsed.to_string())
    }
}

fn is_valid_argument_name(name: &str) -> bool {
    !name.is_empty() && !name.bytes().all(|b| b.is_ascii_digit())
}

/// Parse frontmatter `arguments`: a bare whitespace string, an inline
/// bracket list, or — when the value is empty — a block list of `- item`
/// lines that follow.
fn parse_argument_names_value(
    val: &str,
    lines: &mut std::iter::Peekable<std::str::Lines>,
) -> Vec<String> {
    let raw = val.trim();
    if raw.is_empty() {
        let mut out = Vec::new();
        while let Some(next) = lines.peek() {
            let entry = next.trim();
            let Some(item) = entry.strip_prefix('-') else {
                break;
            };
            let item = item.trim().trim_matches('"').trim_matches('\'');
            if is_valid_argument_name(item) {
                out.push(item.to_string());
            }
            lines.next();
        }
        return out;
    }
    if let Some(inner) = raw.strip_prefix('[') {
        inner
            .trim_end_matches(']')
            .split(',')
            .map(|item| item.trim().trim_matches('"').trim_matches('\''))
            .filter(|item| is_valid_argument_name(item))
            .map(str::to_string)
            .collect()
    } else {
        raw.split_whitespace()
            .filter(|item| is_valid_argument_name(item))
            .map(str::to_string)
            .collect()
    }
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
                && let Some(meta) = push_descriptor(
                    &content,
                    &file_name,
                    &skill_file.to_string_lossy(),
                    source,
                    out,
                    seen,
                    None,
                )
                && meta.has_sub_skill
            {
                // A `has-sub-skill: true` parent: its directory children become
                // `<parent>.<child>` sub-skills (v2 `allowedSubSkillBundles`).
                scan_sub_skills(&entry.path(), &meta.name, source, out, seen);
            }
        } else if file_type.is_file()
            && file_name.ends_with(".md")
            && !file_name.eq_ignore_ascii_case("readme.md")
        {
            let base_name = file_name.trim_end_matches(".md");
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                push_descriptor(
                    &content,
                    base_name,
                    &entry.path().to_string_lossy(),
                    source,
                    out,
                    seen,
                    None,
                );
            }
        }
    }
}

/// Parse one skill file and append its descriptor under the given source,
/// honoring the case-insensitive dedupe set. `sub_skill_parent` names the
/// `has-sub-skill: true` parent whose child this is: the descriptor then takes
/// the qualified `<parent>.<child>` name and is marked as a sub-skill (v2
/// `parseAndRegister`'s `subSkillParentName` branch).
///
/// Returns the metadata of the descriptor it appended, so the caller can act
/// on `has_sub_skill`; `None` when the name was already taken.
fn push_descriptor(
    content: &str,
    fallback_name: &str,
    path: &str,
    source: &str,
    out: &mut Vec<SkillDescriptor>,
    seen: &mut HashSet<String>,
    sub_skill_parent: Option<&str>,
) -> Option<ParsedSkillMeta> {
    let mut meta = parse_skill_frontmatter(content, fallback_name);
    if let Some(parent) = sub_skill_parent {
        meta.name = qualify_sub_skill_name(parent, &meta.name);
    }
    if !seen.insert(meta.name.to_lowercase()) {
        return None;
    }
    out.push(SkillDescriptor {
        name: meta.name.clone(),
        description: meta.description.clone(),
        source: source.to_string(),
        path: path.replace('\\', "/"),
        disable_model_invocation: meta.disable_model_invocation,
        scopes: meta.scopes.clone(),
        is_sub_skill: sub_skill_parent.map(|_| true),
    });
    Some(meta)
}

/// v2 `qualifySubSkillName`: `<parent>.<child>`, leaving a name that is already
/// qualified — or a child named after its parent — untouched.
fn qualify_sub_skill_name(parent: &str, child: &str) -> String {
    if child == parent || child.starts_with(&format!("{parent}.")) {
        child.to_string()
    } else {
        format!("{parent}.{child}")
    }
}

/// The roots and policy one catalog scan uses, owned so a session can serve the
/// *engine's* catalog to a host later (v2 serves the catalog from the engine:
/// the builtin product skills, the dotted sub-skill commands and
/// `extra_skill_dirs` exist only there).
#[derive(Debug, Clone, Default)]
pub struct SkillScanRoots {
    pub root: Option<PathBuf>,
    pub extra_dirs: Vec<PathBuf>,
    pub merge_all_available_skills: bool,
}

impl SkillScanRoots {
    /// The catalog this session advertises: project scope, the extra roots,
    /// the user scope, then the builtins.
    pub fn catalog(&self) -> Vec<SkillDescriptor> {
        scan_all_skills_with_extra_and_merge(
            self.root.as_deref(),
            &self.extra_dirs,
            self.merge_all_available_skills,
        )
    }
}

/// Register a `has-sub-skill: true` parent's directory children as
/// `<parent>.<child>` sub-skills (v2 `walkSkillDir`'s
/// `allowedSubSkillBundles` branch). Sub-skills are user-invocable, so the
/// prompt's catalog keeps them out and only the parent is advertised to the
/// model.
fn scan_sub_skills(
    parent_dir: &Path,
    parent_name: &str,
    source: &str,
    out: &mut Vec<SkillDescriptor>,
    seen: &mut HashSet<String>,
) {
    let Ok(read_dir) = std::fs::read_dir(parent_dir) else {
        return;
    };
    let mut entries: Vec<_> = read_dir.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let child_name = entry.file_name().to_string_lossy().to_string();
        let mut skill_file = entry.path().join("SKILL.md");
        if !skill_file.exists() {
            skill_file = entry.path().join("skill.md");
        }
        if !skill_file.is_file() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&skill_file) else {
            continue;
        };
        push_descriptor(
            &content,
            &child_name,
            &skill_file.to_string_lossy(),
            source,
            out,
            seen,
            Some(parent_name),
        );
    }
}

/// A builtin product skill: its catalog descriptor plus the embedded body
/// the `Skill` tool loads (v2 ships the same content through `*.md?raw`).
pub struct BuiltinSkillDef {
    pub descriptor: SkillDescriptor,
    pub body: &'static str,
}

const CHECK_KIMI_CODE_DOCS_BODY: &str = include_str!("builtin/check-kimi-code-docs.md");
const UPDATE_CONFIG_BODY: &str = include_str!("builtin/update-config.md");
const WRITE_GOAL_BODY: &str = include_str!("builtin/write-goal.md");
const CUSTOM_THEME_BODY: &str = include_str!("builtin/custom-theme.md");
const IMPORT_FROM_CC_CODEX_BODY: &str = include_str!("builtin/import-from-cc-codex.md");
const SUB_SKILL_BODY: &str = include_str!("builtin/sub-skill/SKILL.md");
const SUB_SKILL_REVIEW_BODY: &str = include_str!("builtin/sub-skill/review/SKILL.md");
const SUB_SKILL_CONSOLIDATE_BODY: &str = include_str!("builtin/sub-skill/consolidate/SKILL.md");

/// Every builtin product skill, derived from its embedded `SKILL.md`: the
/// descriptor's name/description and the body the tool loads stay one source
/// (v2's `parseSkillText`, then the path/dir override).
pub fn builtin_skill_defs() -> Vec<BuiltinSkillDef> {
    vec![
        builtin_def(
            "check-kimi-code-docs",
            CHECK_KIMI_CODE_DOCS_BODY,
            None,
            false,
        ),
        builtin_def("update-config", UPDATE_CONFIG_BODY, None, false),
        builtin_def("write-goal", WRITE_GOAL_BODY, None, false),
        // v2's `custom-theme` wrapper override: user-only (model invocation
        // disabled) and TUI-scoped.
        builtin_def(
            "custom-theme",
            CUSTOM_THEME_BODY,
            Some(vec!["tui".into()]),
            true,
        ),
        // v2 `IMPORT_FROM_CC_CODEX_SKILL`: a user-only product skill (it
        // migrates local Claude Code / Codex assets, so the model must not
        // start it on its own).
        builtin_def(
            "import-from-cc-codex",
            IMPORT_FROM_CC_CODEX_BODY,
            None,
            true,
        ),
        // v2's `sub-skill` bundle: the parent container plus its two
        // user-invocable children, whose names are qualified by the parent.
        sub_skill_def("sub-skill", "builtin://sub-skill", SUB_SKILL_BODY),
        sub_skill_def(
            "sub-skill.review",
            "builtin://sub-skill/review",
            SUB_SKILL_REVIEW_BODY,
        ),
        sub_skill_def(
            "sub-skill.consolidate",
            "builtin://sub-skill/consolidate",
            SUB_SKILL_CONSOLIDATE_BODY,
        ),
    ]
}

fn builtin_def(
    name: &str,
    body: &'static str,
    scopes: Option<Vec<String>>,
    disable_model_invocation: bool,
) -> BuiltinSkillDef {
    let parsed = parse_skill_frontmatter(body, name);
    BuiltinSkillDef {
        descriptor: SkillDescriptor {
            name: parsed.name,
            description: parsed.description,
            source: "builtin".into(),
            path: format!("builtin://{name}"),
            disable_model_invocation,
            scopes: if scopes.is_some() {
                scopes
            } else {
                parsed.scopes
            },
            is_sub_skill: None,
        },
        body,
    }
}

/// One member of the `sub-skill` bundle (v2 `makeBuiltin`): the descriptor name
/// is the qualified one — the body carries only the child's own name — and
/// every member is user-invocable, so the prompt never advertises it. The two
/// children additionally carry `is_sub_skill`, which is what clients use to
/// expose them as dotted commands (`/sub-skill.review`).
fn sub_skill_def(name: &str, pseudo_path: &str, body: &'static str) -> BuiltinSkillDef {
    let parsed = parse_skill_frontmatter(body, name);
    BuiltinSkillDef {
        descriptor: SkillDescriptor {
            name: name.to_string(),
            description: parsed.description,
            source: "builtin".into(),
            path: pseudo_path.to_string(),
            disable_model_invocation: true,
            scopes: parsed.scopes,
            is_sub_skill: (name != "sub-skill").then_some(true),
        },
        body,
    }
}

/// Builtin descriptors (see [`builtin_skill_defs`]).
pub fn builtin_skills() -> Vec<SkillDescriptor> {
    builtin_skill_defs()
        .into_iter()
        .map(|def| def.descriptor)
        .collect()
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
        assert_eq!(
            parse_skill_frontmatter(
                "---\nname: s\ndescription: d\nscopes: [tui]\n---\nbody",
                "s"
            )
            .scopes,
            Some(vec!["tui".into()])
        );
        assert_eq!(
            parse_skill_frontmatter(
                "---\nname: s\ndescription: d\nscopes: [tui, web]\n---\nbody",
                "s"
            )
            .scopes,
            Some(vec!["tui".into(), "web".into()])
        );
        assert_eq!(
            parse_skill_frontmatter("---\nname: s\ndescription: d\nscopes: web\n---\nbody", "s")
                .scopes,
            Some(vec!["web".into()])
        );

        // Unknown tokens are dropped; nothing valid stays None.
        assert_eq!(
            parse_skill_frontmatter(
                "---\nname: s\ndescription: d\nscopes: [cli, ide]\n---\nbody",
                "s"
            )
            .scopes,
            None
        );
    }

    #[test]
    fn test_parse_type_and_arguments_frontmatter() {
        // Bare string arguments map positionally by name.
        let meta = parse_skill_frontmatter(
            "---\nname: s\ndescription: d\ntype: prompt\narguments: target mode\n---\nbody",
            "s",
        );
        assert_eq!(meta.skill_type.as_deref(), Some("prompt"));
        assert_eq!(meta.argument_names, vec!["target", "mode"]);

        // Inline list arguments.
        let meta = parse_skill_frontmatter(
            "---\nname: s\ndescription: d\narguments: [a, b]\n---\nbody",
            "s",
        );
        assert_eq!(meta.argument_names, vec!["a", "b"]);

        // Block list arguments.
        let meta = parse_skill_frontmatter(
            "---\nname: s\ndescription: d\narguments:\n  - a\n  - b\n---\nbody",
            "s",
        );
        assert_eq!(meta.argument_names, vec!["a", "b"]);

        // All-digit and empty names are dropped (they are positional, not named).
        let meta = parse_skill_frontmatter(
            "---\nname: s\ndescription: d\narguments: [\"1\", name, \"\"]\n---\nbody",
            "s",
        );
        assert_eq!(meta.argument_names, vec!["name"]);
    }

    #[test]
    fn test_builtin_sub_skill_bundle_is_user_only_and_qualified() {
        let defs = builtin_skill_defs();

        // The container itself: user-invocable, not itself a sub-skill.
        let parent = defs
            .iter()
            .find(|d| d.descriptor.name == "sub-skill")
            .expect("sub-skill builtin");
        assert!(parent.descriptor.disable_model_invocation);
        assert_eq!(parent.descriptor.is_sub_skill, None);
        assert!(!parent.body.is_empty());

        // Its children carry the qualified name clients expose as a dotted
        // command, and stay user-only.
        for (name, path) in [
            ("sub-skill.review", "builtin://sub-skill/review"),
            ("sub-skill.consolidate", "builtin://sub-skill/consolidate"),
        ] {
            let child = defs.iter().find(|d| d.descriptor.name == name).expect(name);
            assert_eq!(child.descriptor.is_sub_skill, Some(true), "{name}");
            assert!(
                child.descriptor.disable_model_invocation,
                "{name} is user-invocable only"
            );
            assert_eq!(child.descriptor.path, path);
            assert!(!child.body.is_empty(), "{name} needs its body");
        }

        // The Claude Code / Codex importer is a user-only product skill too.
        let importer = defs
            .iter()
            .find(|d| d.descriptor.name == "import-from-cc-codex")
            .expect("import-from-cc-codex builtin");
        assert!(importer.descriptor.disable_model_invocation);
        assert_eq!(importer.descriptor.is_sub_skill, None);
        assert!(!importer.body.is_empty());
    }

    /// v2 `fileSkillDiscovery`'s `allowedSubSkillBundles`: a parent that opts in
    /// with `has-sub-skill: true` has its directory children registered as
    /// `<parent>.<child>`.
    #[test]
    fn test_a_sub_skill_parent_qualifies_its_children() {
        let temp_dir = tempfile::tempdir().unwrap();
        let parent = temp_dir
            .path()
            .join(".agents")
            .join("skills")
            .join("bundle");
        std::fs::create_dir_all(parent.join("child")).unwrap();
        std::fs::write(
            parent.join("SKILL.md"),
            "---\nname: bundle\ndescription: Container.\nhas-sub-skill: true\n---\n\nBody.\n",
        )
        .unwrap();
        std::fs::write(
            parent.join("child").join("SKILL.md"),
            "---\nname: child\ndescription: A child.\n---\n\nChild body.\n",
        )
        .unwrap();

        let list = scan_all_skills(Some(temp_dir.path()));
        let parent_entry = list.iter().find(|s| s.name == "bundle").expect("parent");
        assert_eq!(parent_entry.is_sub_skill, None);
        let child_entry = list
            .iter()
            .find(|s| s.name == "bundle.child")
            .expect("qualified child");
        assert_eq!(child_entry.is_sub_skill, Some(true));
        assert_eq!(child_entry.description, "A child.");
        assert!(
            child_entry
                .path
                .replace('\\', "/")
                .ends_with("bundle/child/SKILL.md"),
            "{}",
            child_entry.path
        );
    }

    /// Without the opt-in the children are ordinary directories, not skills —
    /// the flag is what pulls them into the catalog.
    #[test]
    fn test_a_parent_without_the_flag_keeps_its_children_unlisted() {
        let temp_dir = tempfile::tempdir().unwrap();
        let parent = temp_dir.path().join(".agents").join("skills").join("plain");
        std::fs::create_dir_all(parent.join("child")).unwrap();
        std::fs::write(
            parent.join("SKILL.md"),
            "---\nname: plain\ndescription: No children.\n---\n\nBody.\n",
        )
        .unwrap();
        std::fs::write(
            parent.join("child").join("SKILL.md"),
            "---\nname: child\ndescription: Not a sub-skill.\n---\n\nChild body.\n",
        )
        .unwrap();

        let list = scan_all_skills(Some(temp_dir.path()));
        assert!(list.iter().any(|s| s.name == "plain"));
        assert!(
            !list
                .iter()
                .any(|s| s.name == "child" || s.name == "plain.child"),
            "a parent without `has-sub-skill` must not register its children"
        );
    }

    #[test]
    fn test_parse_disable_model_invocation_accepts_both_spellings() {
        // v2 `METADATA_ALIASES` maps both spellings onto the same field, and
        // the docs plus existing skills on disk use the snake_case one.
        for body in [
            "---\nname: s\ndisable-model-invocation: true\n---\nbody",
            "---\nname: s\ndisable_model_invocation: true\n---\nbody",
            "---\nname: s\ndisable_model_invocation: TRUE\n---\nbody",
        ] {
            assert!(
                parse_skill_frontmatter(body, "s").disable_model_invocation,
                "{body}"
            );
        }
        for body in [
            "---\nname: s\n---\nbody",
            "---\nname: s\ndisable_model_invocation: false\n---\nbody",
        ] {
            assert!(
                !parse_skill_frontmatter(body, "s").disable_model_invocation,
                "{body}"
            );
        }
    }

    #[test]
    fn test_parse_has_sub_skill_frontmatter() {
        // Both spellings v2 accepts (`hasSubSkillEnabled`).
        for body in [
            "---\nname: s\nhas-sub-skill: true\n---\nbody",
            "---\nname: s\nhasSubSkill: true\n---\nbody",
            "---\nname: s\nhas-sub-skill: TRUE\n---\nbody",
        ] {
            assert!(parse_skill_frontmatter(body, "s").has_sub_skill, "{body}");
        }
        // Absent or off leaves it unset.
        for body in [
            "---\nname: s\n---\nbody",
            "---\nname: s\nhas-sub-skill: false\n---\nbody",
        ] {
            assert!(!parse_skill_frontmatter(body, "s").has_sub_skill, "{body}");
        }
    }

    #[test]
    fn test_custom_theme_builtin_is_user_only_and_tui_scoped() {
        let defs = builtin_skill_defs();
        let theme = defs
            .iter()
            .find(|d| d.descriptor.name == "custom-theme")
            .expect("custom-theme builtin");
        assert_eq!(theme.descriptor.scopes, Some(vec!["tui".into()]));
        assert!(theme.descriptor.disable_model_invocation);
        // The body the Skill tool loads is present and frontmatter-free at load.
        assert!(!theme.body.is_empty());

        // The unscoped builtins stay model-invocable.
        let docs = defs
            .iter()
            .find(|d| d.descriptor.name == "check-kimi-code-docs")
            .unwrap();
        assert_eq!(docs.descriptor.scopes, None);
        assert!(!docs.descriptor.disable_model_invocation);
    }
}
