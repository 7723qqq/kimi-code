//! Session initialization prompt and reminder (v2 sessionInit feature mirror).

pub const DEFAULT_INIT_PROMPT: &str = r#"You are a software engineering expert with many years of programming experience. Please explore the current project directory to understand the project's architecture and main details.

Task requirements:
1. Analyze the project structure and identify key configuration files (such as pyproject.toml, package.json, Cargo.toml, etc.).
2. Understand the project's technology stack, build process and runtime architecture.
3. Identify how the code is organized and main module divisions.
4. Discover project-specific development conventions, testing strategies, and deployment processes.

After the exploration, do a thorough summary of your findings and write it to the `AGENTS.md` file in the project root, replacing the file's previous content. If the file already exists, read it first and carry forward whatever is still accurate — the result should be one coherent, up-to-date file, not an append.

For your information, `AGENTS.md` is a file intended to be read by AI coding agents. Expect the reader of this file to know nothing about the project.

You should compose this file according to the actual project content. Do not make any assumptions or generalizations. Ensure the information is accurate and useful. You must use the natural language that is mainly used in the project's comments and documentation.

Popular sections that people usually write in `AGENTS.md` are:

- Project overview
- Build and test commands
- Code style guidelines
- Testing instructions
- Security considerations"#;

pub fn init_completion_reminder(agents_md: &str) -> String {
    let latest = if agents_md.trim().is_empty() {
        "No AGENTS.md content was found after `/init` completed."
    } else {
        agents_md
    };
    format!(
        "The user just ran `/init` slash command.\n\
         The system has analyzed the codebase and generated an `AGENTS.md` file.\n\n\
         Latest AGENTS.md file content:\n\
         {latest}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_prompt_and_reminder() {
        assert!(DEFAULT_INIT_PROMPT.contains("AGENTS.md"));
        let rem = init_completion_reminder("# My Project");
        assert!(rem.contains("The user just ran `/init`"));
        assert!(rem.contains("# My Project"));

        let empty_rem = init_completion_reminder("");
        assert!(empty_rem.contains("No AGENTS.md content was found"));
    }
}
