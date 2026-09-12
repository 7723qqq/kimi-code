//! System prompt builder and template variable interpolator.
//!
//! Orchestrates environment discovery, AGENTS.md cascading, skills catalog
//! rendering, and role profiles into the complete system prompt for any turn.

use std::path::{Path, PathBuf};

use super::agents_md::load_agents_md;
use super::environment::{collect_environment, generate_cwd_listing};
use super::profiles::ProfileCatalog;
use super::skills_renderer::generate_skills_section_with_extra;

pub const DEFAULT_PRODUCT_NAME: &str = "Kimi Code CLI";
pub const DEFAULT_REPLY_STYLE_GUIDE: &str = "Your text replies render as Markdown in the user's terminal. Keep structure light and shallow — deep nesting, large tables, and heavy headings read poorly there. Cite code locations as `path/to/file.ts:42` so the user can navigate to them. Do not use emoji unless the user does first or asks for it.";

pub const NOTIFY_USER_GUIDANCE: &str = "When `NotifyUser` is available, use it proactively to keep the end user informed while you work. For a multi-step task, send an early update describing your approach, then report meaningful findings, phase conclusions, long waits, and blockers. Keep each update to one or two sentences in the end user's language; avoid repeating unchanged status. The UI adds the source label automatically. If you are working as a subagent, report only your own subtask's progress, do not present its completion as completion of the whole task, and do not ask the end user questions or request decisions. Updates do not automatically reach your parent agent: include every important finding in your final handoff. Updates remain visible until the main agent starts its next turn, so your final reply must still stand on its own.";

pub const SYSTEM_PROMPT_TEMPLATE: &str = include_str!("./system.md");

/// Builder for constructing comprehensive agent system prompts.
#[derive(Debug, Clone)]
pub struct SystemPromptBuilder {
    workspace_root: PathBuf,
    product_name: String,
    reply_style_guide: String,
    override_shell: Option<String>,
    profile_name: String,
    custom_brand_home: Option<PathBuf>,
    custom_agents_md: Option<String>,
    custom_skills_section: Option<String>,
    plugin_sections: Option<String>,
    additional_dirs: Vec<PathBuf>,
    /// Extra skill scan roots (`extra_skill_dirs`): the listed skills must
    /// match what the `Skill` tool can load.
    skill_dirs: Vec<PathBuf>,
    notify_user_active: bool,
}

impl SystemPromptBuilder {
    /// Create a new builder anchored at the given workspace root.
    pub fn new(workspace_root: impl AsRef<Path>) -> Self {
        Self {
            workspace_root: workspace_root.as_ref().to_path_buf(),
            product_name: DEFAULT_PRODUCT_NAME.to_string(),
            reply_style_guide: DEFAULT_REPLY_STYLE_GUIDE.to_string(),
            override_shell: None,
            profile_name: "agent".to_string(),
            custom_brand_home: None,
            custom_agents_md: None,
            custom_skills_section: None,
            plugin_sections: None,
            additional_dirs: Vec::new(),
            skill_dirs: Vec::new(),
            notify_user_active: false,
        }
    }

    /// Set whether `NotifyUser` guidance is injected into the system prompt.
    #[must_use]
    pub fn with_notify_user(mut self, active: bool) -> Self {
        self.notify_user_active = active;
        self
    }

    /// Extra skill scan roots (schema `extra_skill_dirs`).
    #[must_use]
    pub fn with_skill_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.skill_dirs = dirs;
        self
    }

    pub fn with_product_name(mut self, name: impl Into<String>) -> Self {
        self.product_name = name.into();
        self
    }

    pub fn with_profile(mut self, profile: impl Into<String>) -> Self {
        self.profile_name = profile.into();
        self
    }

    pub fn with_shell(mut self, shell_path: impl Into<String>) -> Self {
        self.override_shell = Some(shell_path.into());
        self
    }

    pub fn with_brand_home(mut self, path: impl AsRef<Path>) -> Self {
        self.custom_brand_home = Some(path.as_ref().to_path_buf());
        self
    }

    pub fn with_custom_agents_md(mut self, md: impl Into<String>) -> Self {
        self.custom_agents_md = Some(md.into());
        self
    }

    pub fn with_custom_skills(mut self, skills: impl Into<String>) -> Self {
        self.custom_skills_section = Some(skills.into());
        self
    }

    pub fn with_plugin_sections(mut self, plugins: impl Into<String>) -> Self {
        self.plugin_sections = Some(plugins.into());
        self
    }

    pub fn add_additional_dir(mut self, dir: impl AsRef<Path>) -> Self {
        self.additional_dirs.push(dir.as_ref().to_path_buf());
        self
    }

    /// Build the default system prompt for the given workspace path.
    pub fn build_default(workspace_root: impl AsRef<Path>) -> String {
        Self::new(workspace_root).build()
    }

    /// [`Self::build_default`] with extra skill scan roots (schema
    /// `extra_skill_dirs`).
    pub fn build_default_with_skill_dirs(
        workspace_root: impl AsRef<Path>,
        skill_dirs: Vec<PathBuf>,
    ) -> String {
        Self::new(workspace_root)
            .with_skill_dirs(skill_dirs)
            .build()
    }

    /// Build the full system prompt string.
    pub fn build(self) -> String {
        // 1. Environment
        let env = collect_environment(&self.workspace_root, self.override_shell.as_deref());

        // 2. Profile role additional
        let catalog = ProfileCatalog::with_builtins();
        let role_additional = catalog
            .get(&self.profile_name)
            .map(|p| p.role_additional.clone())
            .unwrap_or_default();

        // 3. AGENTS.md
        let agents_md = if let Some(custom) = self.custom_agents_md {
            custom
        } else {
            let loaded = load_agents_md(&self.workspace_root, self.custom_brand_home.as_deref());
            loaded.content
        };

        // 4. Skills section
        let skills_section = if let Some(custom) = self.custom_skills_section {
            custom
        } else {
            generate_skills_section_with_extra(Some(&self.workspace_root), &self.skill_dirs)
        };

        // 5. Additional directories
        let additional_dirs_section = if self.additional_dirs.is_empty() {
            String::new()
        } else {
            let mut buf = String::from(
                "\n\n## Additional Directories\n\nThe following directories have been added to the workspace. You can read, write, search, and glob files in these directories as part of your workspace scope.\n\n",
            );
            for dir in &self.additional_dirs {
                let listing = generate_cwd_listing(dir, true);
                buf.push_str(&format!("### {}\n{}\n\n", dir.display(), listing));
            }
            buf
        };

        // 6. Plugin sections
        let plugin_sections = if let Some(plugins) = self.plugin_sections {
            if !plugins.is_empty() {
                format!(
                    "\n\n# Plugin Instructions\n\nThe following instructions are contributed by enabled plugins.\n\n{}\n\n",
                    plugins
                )
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // 7. Shell representation
        let shell_desc = if !env.shell_name.is_empty() {
            format!("{} (`{}`)", env.shell_name, env.shell_path)
        } else {
            String::new()
        };

        // 8. Interpolation
        let mut prompt = SYSTEM_PROMPT_TEMPLATE.to_string();

        let notify_user_guidance = if self.notify_user_active {
            format!(" {}", NOTIFY_USER_GUIDANCE)
        } else {
            String::new()
        };

        let replacements = [
            ("${product_name}", self.product_name.as_str()),
            ("${role_additional}", role_additional.as_str()),
            ("${reply_style_guide}", self.reply_style_guide.as_str()),
            ("${notify_user_guidance}", notify_user_guidance.as_str()),
            ("${os}", env.os_kind.as_str()),
            ("${shell}", shell_desc.as_str()),
            ("${windows_notes}", env.windows_notes.as_str()),
            ("${runtime_notes}", ""),
            ("${cwd}", env.cwd.as_str()),
            ("${cwd_listing}", env.cwd_listing.as_str()),
            (
                "${additional_dirs_section}",
                additional_dirs_section.as_str(),
            ),
            ("${agents_md}", agents_md.as_str()),
            ("${skills_section}", skills_section.as_str()),
            ("${plugin_sections}", plugin_sections.as_str()),
        ];

        for (var, val) in replacements {
            prompt = prompt.replace(var, val);
        }

        prompt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_builder_renders_core_sections_and_resolves_all_placeholders() {
        let temp = tempdir().unwrap();
        let prompt = SystemPromptBuilder::new(temp.path())
            .with_profile("agent")
            .build();

        // Hard requirement: NO unexpanded ${variable} template placeholders remain
        assert!(
            !prompt.contains("${"),
            "prompt contains unexpanded template variables: {}",
            prompt
                .lines()
                .filter(|l| l.contains("${"))
                .collect::<Vec<_>>()
                .join("\n")
        );

        // Core header and identity
        assert!(prompt.starts_with(
            "You are Kimi Code CLI, an interactive general AI agent running on a user's computer."
        ));

        // All required top-level section headings in sequence
        let sections = [
            "# Communicating with the user",
            "# Tool use",
            "# Coding",
            "# Risky actions",
            "# Delivering work",
            "# Context management",
            "# Environment",
            "# Project information",
        ];
        let mut last_idx = 0;
        for sec in sections {
            let idx = prompt
                .find(sec)
                .unwrap_or_else(|| panic!("missing section heading: {sec}"));
            assert!(idx >= last_idx, "section {} appeared out of order", sec);
            last_idx = idx;
        }

        // Environment disclosure interpolation
        let normalized_cwd = temp.path().display().to_string().replace('\\', "/");
        assert!(prompt.contains(&format!(
            "The current working directory is `{}`",
            normalized_cwd
        )));
        assert!(prompt.contains("```\n(empty directory)\n```"));

        // By default with no additional dirs or plugins, those sections are omitted
        assert!(!prompt.contains("## Additional Directories"));
        assert!(!prompt.contains("# Plugin Instructions"));
    }

    #[test]
    fn test_builder_role_additional_for_all_profiles() {
        let temp = tempdir().unwrap();

        // 1. Agent profile has no subagent prefix
        let agent_prompt = SystemPromptBuilder::new(temp.path())
            .with_profile("agent")
            .build();
        assert!(!agent_prompt.contains("You are now running as a subagent."));

        // 2. Coder profile has subagent prefix + coder handoff suffix
        let coder_prompt = SystemPromptBuilder::new(temp.path())
            .with_profile("coder")
            .build();
        assert!(coder_prompt.contains("You are now running as a subagent."));
        assert!(coder_prompt.contains("Your final message is the entire handoff"));

        // 3. Explore profile has subagent prefix + explore suffix
        let explore_prompt = SystemPromptBuilder::new(temp.path())
            .with_profile("explore")
            .build();
        assert!(explore_prompt.contains("You are now running as a subagent."));
        assert!(explore_prompt.contains("Fast agent specialized for exploring codebases."));

        // 4. Plan profile has subagent prefix + plan suffix
        let plan_prompt = SystemPromptBuilder::new(temp.path())
            .with_profile("plan")
            .build();
        assert!(plan_prompt.contains("You are now running as a subagent."));
        assert!(plan_prompt.contains("Read-only implementation planning and architecture design."));

        // 5. Unknown profile defaults to empty role_additional without error
        let unknown_prompt = SystemPromptBuilder::new(temp.path())
            .with_profile("custom_unknown")
            .build();
        assert!(!unknown_prompt.contains("You are now running as a subagent."));
        assert!(!unknown_prompt.contains("${role_additional}"));
    }

    #[test]
    fn test_builder_custom_product_name_and_shell() {
        let temp = tempdir().unwrap();
        let prompt = SystemPromptBuilder::new(temp.path())
            .with_product_name("Kimi Native Agent")
            .with_shell("/custom/bin/bash")
            .build();

        assert!(prompt.starts_with("You are Kimi Native Agent, an interactive general AI agent"));
        assert!(
            prompt.contains("the Bash tool executes commands using **bash (`/custom/bin/bash`)**")
        );
    }

    #[test]
    fn test_builder_custom_agents_md_and_skills() {
        let temp = tempdir().unwrap();
        let custom_md = "# Custom Rules\nAlways verify before done.";
        let custom_skills = "\n\n# Skills\n\nCustom skills list here.";

        let prompt = SystemPromptBuilder::new(temp.path())
            .with_custom_agents_md(custom_md)
            .with_custom_skills(custom_skills)
            .build();

        assert!(prompt.contains("The applicable `AGENTS.md` instructions are:\n\n```````\n# Custom Rules\nAlways verify before done.\n```````"));
        assert!(prompt.contains("Custom skills list here."));
    }

    #[test]
    fn test_builder_additional_dirs_and_plugin_sections() {
        let temp_ws = tempdir().unwrap();
        let extra_dir = tempdir().unwrap();
        std::fs::write(extra_dir.path().join("extra.txt"), "hello").unwrap();

        let prompt = SystemPromptBuilder::new(temp_ws.path())
            .add_additional_dir(extra_dir.path())
            .with_plugin_sections("## Plugin A\nFollow plugin instructions.")
            .build();

        // Additional directories section
        assert!(prompt.contains("## Additional Directories"));
        assert!(prompt.contains(&format!("### {}\n", extra_dir.path().display())));
        assert!(prompt.contains("extra.txt"));

        // Plugin instructions section
        assert!(prompt.contains("# Plugin Instructions\n\nThe following instructions are contributed by enabled plugins.\n\n## Plugin A\nFollow plugin instructions.\n\n"));
    }

    #[test]
    fn test_builder_build_default_matches_new_build() {
        let temp = tempdir().unwrap();
        let default_built = SystemPromptBuilder::build_default(temp.path());
        let manual_built = SystemPromptBuilder::new(temp.path()).build();
        assert_eq!(default_built, manual_built);
    }

    #[test]
    fn test_builder_notify_user_toggle() {
        let temp = tempdir().unwrap();
        let prompt_disabled = SystemPromptBuilder::new(temp.path())
            .with_notify_user(false)
            .build();
        assert!(!prompt_disabled.contains(NOTIFY_USER_GUIDANCE));
        assert!(!prompt_disabled.contains("${notify_user_guidance}"));

        let prompt_enabled = SystemPromptBuilder::new(temp.path())
            .with_notify_user(true)
            .build();
        assert!(prompt_enabled.contains(NOTIFY_USER_GUIDANCE));
        assert!(prompt_enabled.contains("When `NotifyUser` is available, use it proactively"));
        assert!(!prompt_enabled.contains("${notify_user_guidance}"));
    }
}
