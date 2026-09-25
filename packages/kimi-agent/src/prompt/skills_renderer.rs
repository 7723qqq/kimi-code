//! Skills catalog formatting for Kimi Agent system prompts.
//!
//! Groups discovered skills by scope (Project, User, Built-in) and formats
//! them into Markdown following product conventions.

use crate::skills::{SkillDescriptor, scan_all_skills_with_extra_and_merge};
use std::path::Path;

pub const SKILLS_SECTION_PROSE: &str = "Skills are reusable, composable capabilities that enhance your abilities. Each skill is either a self-contained directory with a `SKILL.md` file or a standalone `.md` file that contains instructions, examples, and/or reference material.\n\n\
Identify the skills relevant to your current task and read the skill file for its instructions; only read further skill details when needed, to conserve the context window.\n\n\
## Available skills\n\n\
Skills are grouped by scope (`Project`, `User`, `Extra`, `Built-in`) so you can tell where each came from. When the user refers to \"the skill in this project\" or \"the user-scope skill\", use the scope heading to disambiguate. When multiple scopes define a skill with the same name, the more specific scope takes precedence: **Project overrides User overrides Extra overrides Built-in**.\n\n\
DISREGARD any earlier skill listings. Current available skills:";

/// Render a list of skill descriptors into the formatted Markdown `# Skills` section.
pub fn render_skills_markdown(skills: &[SkillDescriptor]) -> String {
    // Sub-skills are user-invocable only: v2's catalog filters them out
    // (`listInvocableSkills` drops `isSubSkill`) and advertises the parent
    // instead, so the model never sees `<parent>.<child>`.
    let active_skills: Vec<&SkillDescriptor> = skills
        .iter()
        .filter(|s| !s.disable_model_invocation && s.is_sub_skill != Some(true))
        .collect();

    if active_skills.is_empty() {
        return String::new();
    }

    let mut project_skills = Vec::new();
    let mut user_skills = Vec::new();
    let mut builtin_skills = Vec::new();
    let mut other_skills = Vec::new();

    for skill in active_skills {
        match skill.source.to_lowercase().as_str() {
            "project" => project_skills.push(skill),
            "user" => user_skills.push(skill),
            "builtin" => builtin_skills.push(skill),
            _ => other_skills.push(skill),
        }
    }

    let mut out = format!("\n\n# Skills\n\n{}\n", SKILLS_SECTION_PROSE);

    let format_group = |title: &str, group: &[&SkillDescriptor], buf: &mut String| {
        if group.is_empty() {
            return;
        }
        buf.push_str(&format!("### {}\n", title));
        for s in group {
            let desc = if s.description.is_empty() {
                "No description provided.".to_string()
            } else {
                s.description.clone()
            };
            buf.push_str(&format!("- {}: {}\n  Path: {}\n", s.name, desc, s.path));
        }
    };

    format_group("Project", &project_skills, &mut out);
    format_group("User", &user_skills, &mut out);
    format_group("Built-in", &builtin_skills, &mut out);
    format_group("Extra", &other_skills, &mut out);

    out
}

/// Helper that scans skills for the given workspace and renders the Markdown block.
pub fn generate_skills_section(workspace_root: Option<&Path>) -> String {
    generate_skills_section_with_extra(workspace_root, &[])
}

/// [`generate_skills_section`] plus the user's `extra_skill_dirs`
/// (schema): the prompt must list what `Skill` can actually load.
pub fn generate_skills_section_with_extra(
    workspace_root: Option<&Path>,
    extra_dirs: &[std::path::PathBuf],
) -> String {
    generate_skills_section_with_options(workspace_root, extra_dirs, true)
}

/// [`generate_skills_section_with_extra`] with `merge_all_available_skills`
/// (schema): the prompt must list exactly the directories the scan actually
/// reads, or it advertises skills the `Skill` tool cannot load.
pub fn generate_skills_section_with_options(
    workspace_root: Option<&Path>,
    extra_dirs: &[std::path::PathBuf],
    merge_all_available_skills: bool,
) -> String {
    let skills = scan_all_skills_with_extra_and_merge(
        workspace_root,
        extra_dirs,
        merge_all_available_skills,
    );
    render_skills_markdown(&skills)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_skills_empty_or_all_disabled() {
        // Empty slice returns empty string
        let res = render_skills_markdown(&[]);
        assert_eq!(res, "");

        // All skills with disable_model_invocation=true also returns empty string
        let hidden_skills = vec![
            SkillDescriptor {
                name: "hidden-1".into(),
                description: "Desc 1".into(),
                source: "project".into(),
                path: "path/1".into(),
                disable_model_invocation: true,
                scopes: None,
                is_sub_skill: None,
            },
            SkillDescriptor {
                name: "hidden-2".into(),
                description: "Desc 2".into(),
                source: "user".into(),
                path: "path/2".into(),
                disable_model_invocation: true,
                scopes: None,
                is_sub_skill: None,
            },
        ];
        assert_eq!(render_skills_markdown(&hidden_skills), "");
    }

    #[test]
    fn test_render_skills_all_scopes_formatting_and_filtering() {
        let skills = vec![
            // Project scope (case-insensitive "PROJECT")
            SkillDescriptor {
                name: "proj-tool".into(),
                description: "Project analysis".into(),
                source: "PROJECT".into(),
                path: "G:/ws/skills/proj-tool".into(),
                disable_model_invocation: false,
                scopes: None,
                is_sub_skill: None,
            },
            // Disabled skill in project scope must be omitted
            SkillDescriptor {
                name: "secret-tool".into(),
                description: "Should not appear".into(),
                source: "project".into(),
                path: "G:/ws/skills/secret-tool".into(),
                disable_model_invocation: true,
                scopes: None,
                is_sub_skill: None,
            },
            // User scope
            SkillDescriptor {
                name: "user-helper".into(),
                description: "User automation".into(),
                source: "user".into(),
                path: "C:/Users/name/.skills/user-helper".into(),
                disable_model_invocation: false,
                scopes: None,
                is_sub_skill: None,
            },
            // Built-in scope with empty description fallback
            SkillDescriptor {
                name: "builtin-exec".into(),
                description: "".into(),
                source: "BuiltIn".into(),
                path: "builtin://exec".into(),
                disable_model_invocation: false,
                scopes: None,
                is_sub_skill: None,
            },
            // Extra scope (any unrecognized source string)
            SkillDescriptor {
                name: "plugin-custom".into(),
                description: "External plugin skill".into(),
                source: "marketplace".into(),
                path: "plugins/marketplace/custom".into(),
                disable_model_invocation: false,
                scopes: None,
                is_sub_skill: None,
            },
        ];

        let md = render_skills_markdown(&skills);

        // Verify top-level headers and prose
        assert!(md.starts_with("\n\n# Skills\n\n"));
        assert!(md.contains(SKILLS_SECTION_PROSE));
        assert!(md.contains("## Available skills"));

        // Verify Project section and entry format
        assert!(md.contains(
            "### Project\n- proj-tool: Project analysis\n  Path: G:/ws/skills/proj-tool\n"
        ));
        assert!(!md.contains("secret-tool"));
        assert!(!md.contains("Should not appear"));

        // Verify User section
        assert!(md.contains(
            "### User\n- user-helper: User automation\n  Path: C:/Users/name/.skills/user-helper\n"
        ));

        // Verify Built-in section with description fallback
        assert!(md.contains(
            "### Built-in\n- builtin-exec: No description provided.\n  Path: builtin://exec\n"
        ));

        // Verify Extra section
        assert!(md.contains("### Extra\n- plugin-custom: External plugin skill\n  Path: plugins/marketplace/custom\n"));
    }

    /// v2's catalog drops `isSubSkill` from the model-facing list: a sub-skill
    /// is user-invocable, and the parent is what the prompt advertises.
    #[test]
    fn test_render_skills_omits_sub_skills_and_keeps_the_parent() {
        let skills = vec![
            SkillDescriptor {
                name: "bundle".into(),
                description: "Container skill".into(),
                source: "project".into(),
                path: "G:/ws/skills/bundle".into(),
                disable_model_invocation: false,
                scopes: None,
                is_sub_skill: None,
            },
            SkillDescriptor {
                name: "bundle.child".into(),
                description: "A sub-skill".into(),
                source: "project".into(),
                path: "G:/ws/skills/bundle/child".into(),
                // A file-discovered sub-skill carries no disable flag: only
                // `is_sub_skill` keeps it out of the prompt.
                disable_model_invocation: false,
                scopes: None,
                is_sub_skill: Some(true),
            },
        ];

        let md = render_skills_markdown(&skills);
        assert!(md.contains("- bundle: Container skill\n"), "{md}");
        assert!(!md.contains("bundle.child"), "{md}");
        assert!(!md.contains("A sub-skill"), "{md}");
    }

    #[test]
    fn test_render_skills_omits_empty_groups() {
        // Only User skills provided
        let skills = vec![SkillDescriptor {
            name: "only-user".into(),
            description: "Solo user skill".into(),
            source: "user".into(),
            path: "path/user".into(),
            disable_model_invocation: false,
            scopes: None,
            is_sub_skill: None,
        }];

        let md = render_skills_markdown(&skills);
        assert!(md.contains("### User"));
        assert!(md.contains("- only-user: Solo user skill\n  Path: path/user\n"));

        // Empty groups must not be rendered
        assert!(
            !md.contains("### Project"),
            "empty Project group must not be rendered"
        );
        assert!(
            !md.contains("### Built-in"),
            "empty Built-in group must not be rendered"
        );
        assert!(
            !md.contains("### Extra"),
            "empty Extra group must not be rendered"
        );
    }
}
