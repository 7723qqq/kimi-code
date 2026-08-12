//! Plugin injector — extracts skills, MCP servers, hooks, system-prompt
//! contributions, and agent directories from enabled plugins and makes them
//! available to the agent.
//!
//! Mirrors `packages/agent-core/src/plugin/manager.ts` injection logic.

use std::path::{Path, PathBuf};

use crate::mcp::runtime::McpServerSpecInput;
use crate::plugin::store::PluginStore;
use crate::plugin::types::*;
use crate::skill::SkillMetadataInput;
use kimi_protocol::hooks::{HookDef, HookEventType};

/// A plugin system-prompt contribution, ready to be composed into the
/// session system prompt (upstream #2314).
#[derive(Debug, Clone)]
pub struct PluginSystemPrompt {
    pub plugin_id: String,
    pub content: String,
}

/// Plugin injection result — what the plugin contributes to the session,
/// already mapped to the shapes `session/create` consumes (skills carry an
/// absolute `path` resolved against the plugin root; MCP servers and hooks
/// are wire-ready registration/def inputs).
pub struct PluginInjection {
    pub skills: Vec<SkillMetadataInput>,
    pub mcp_servers: Vec<McpServerSpecInput>,
    pub hooks: Vec<HookDef>,
    pub system_prompts: Vec<PluginSystemPrompt>,
    pub agent_roots: Vec<PluginAgent>,
}

/// Aggregate budget for composed plugin system-prompt sections (bytes),
/// matching upstream `PLUGIN_SECTIONS_MAX_BYTES`.
pub const PLUGIN_SECTIONS_MAX_BYTES: usize = 64 * 1024;

/// Compose the plugin system-prompt contributions into one block, skipping
/// contributions that would exceed the aggregate budget.
///
/// Returns the composed block and the ids of plugins whose contributions
/// were skipped, mirroring upstream `composePluginSections`.
pub fn compose_plugin_sections(sections: &[PluginSystemPrompt]) -> (String, Vec<String>) {
    let mut parts: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut total_bytes = 0usize;
    for section in sections {
        let block = format!("<!-- From: plugin {} -->\n{}", section.plugin_id, section.content);
        let bytes = block.len();
        if total_bytes + bytes > PLUGIN_SECTIONS_MAX_BYTES {
            skipped.push(section.plugin_id.clone());
            continue;
        }
        total_bytes += bytes;
        parts.push(block);
    }
    (parts.join("\n\n"), skipped)
}

/// Collect all contributions from enabled plugins, mapped to the shapes
/// `session/create` consumes. `plugins_dir` resolves skill files for
/// github/url-sourced plugins (local plugins resolve against their own path).
pub fn collect_plugin_injections(
    store: &PluginStore,
    plugins_dir: Option<&Path>,
) -> PluginInjection {
    let plugins = match store.list_enabled() {
        Ok(p) => p,
        Err(_) => return PluginInjection {
            skills: vec![],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompts: vec![],
            agent_roots: vec![],
        },
    };

    let mut skills = Vec::new();
    let mut mcp_servers = Vec::new();
    let mut hooks = Vec::new();
    let mut system_prompts = Vec::new();
    let mut agent_roots = Vec::new();

    for plugin in &plugins {
        skills.extend(plugin_skills_to_inputs(plugin, plugins_dir));
        mcp_servers.extend(plugin_mcp_to_inputs(plugin));
        hooks.extend(plugin_hooks_to_defs(plugin));
        if let Some(ref content) = plugin.system_prompt {
            system_prompts.push(PluginSystemPrompt {
                plugin_id: plugin.id.clone(),
                content: content.clone(),
            });
        }
        agent_roots.extend(plugin.agents.iter().cloned());
    }

    PluginInjection {
        skills,
        mcp_servers,
        hooks,
        system_prompts,
        agent_roots,
    }
}

/// Resolve a plugin's root directory (where `plugin.json` lives), used to
/// absolutize skill files. Local plugins resolve against their own path (the
/// directory, or the manifest file's parent); github/url plugins against
/// their install dir under `plugins_dir` (zip archives nest the manifest one
/// level down — the first subdirectory containing `plugin.json` wins).
pub fn plugin_root_dir(source: &PluginSource, plugins_dir: Option<&Path>) -> Option<PathBuf> {
    match source {
        PluginSource::Local { path } => {
            let p = Path::new(path);
            if p.is_dir() {
                Some(p.to_path_buf())
            } else if p.is_file() {
                p.parent().map(|d| d.to_path_buf())
            } else {
                None
            }
        }
        PluginSource::Github { repo, .. } => plugins_dir
            .map(|d| d.join(crate::plugin::install::sanitize_plugin_name(repo)))
            .and_then(|d| manifest_root_under(&d)),
        PluginSource::Url { url } => plugins_dir
            .map(|d| d.join(crate::plugin::install::sanitize_plugin_name(url)))
            .and_then(|d| manifest_root_under(&d)),
    }
}

/// Find the directory holding `plugin.json`, either directly under `dir` or
/// in the first nested subdirectory (GitHub/zip archives).
fn manifest_root_under(dir: &Path) -> Option<PathBuf> {
    if dir.join("plugin.json").is_file() {
        return Some(dir.to_path_buf());
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() && p.join("plugin.json").is_file() {
            return Some(p);
        }
    }
    None
}

/// Map a plugin's skills to session wire inputs, resolving each `file`
/// against the plugin root. When the root cannot be determined the raw
/// relative `file` is kept as `path` (activation falls back to the
/// description); `source` records the plugin id.
pub fn plugin_skills_to_inputs(
    record: &PluginRecord,
    plugins_dir: Option<&Path>,
) -> Vec<SkillMetadataInput> {
    let root = plugin_root_dir(&record.source, plugins_dir);
    record
        .skills
        .iter()
        .map(|s| SkillMetadataInput {
            name: s.name.clone(),
            description: s.description.clone(),
            skill_type: "prompt".to_string(),
            source: Some(record.id.clone()),
            path: match &root {
                Some(r) => Some(r.join(&s.file).to_string_lossy().to_string()),
                None if s.file.is_empty() => None,
                None => Some(s.file.clone()),
            },
            dir: None,
            content: None,
        })
        .collect()
}

/// Map a plugin's MCP servers to session registration inputs (enabled).
pub fn plugin_mcp_to_inputs(record: &PluginRecord) -> Vec<McpServerSpecInput> {
    record
        .mcp_servers
        .iter()
        .map(|m| McpServerSpecInput {
            name: m.name.clone(),
            transport: Some(m.transport.clone()),
            enabled: Some(true),
            command: m.command.clone(),
            args: Vec::new(),
            env: None,
            cwd: None,
            url: m.url.clone(),
            enabled_tools: None,
            disabled_tools: None,
            bearer_token: None,
            bearer_token_env_var: None,
            startup_timeout_ms: None,
            tool_timeout_ms: None,
            has_headers: None,
            project_root: None,
        })
        .collect()
}

/// Map a plugin's hooks to engine hook definitions; hooks with an unknown
/// event name are skipped.
pub fn plugin_hooks_to_defs(record: &PluginRecord) -> Vec<HookDef> {
    record
        .hooks
        .iter()
        .filter_map(|h| {
            HookEventType::from_str(&h.event).map(|event| HookDef {
                event,
                matcher: h.matcher.clone(),
                command: h.command.clone(),
                timeout: None,
                cwd: None,
                env: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    fn make_store() -> PluginStore {
        let store = PluginStore::new(SqliteStore::in_memory().unwrap());
        store.init().unwrap();
        store
    }

    #[test]
    fn test_empty_plugins_produce_empty_injection() {
        let store = make_store();
        let injection = collect_plugin_injections(&store, None);
        assert!(injection.skills.is_empty());
        assert!(injection.mcp_servers.is_empty());
        assert!(injection.hooks.is_empty());
    }

    #[test]
    fn test_enabled_plugin_contributes_skills() {
        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/my-plugin".into(),
            name: "My Plugin".into(),
            version: "1.0.0".into(),
            description: "Test".into(),
            source: PluginSource::Local { path: "/tmp/plugin".into() },
            state: PluginState::Enabled,
            installed_at: "0".into(),
            skills: vec![PluginSkill {
                name: "test-skill".into(),
                description: "A test skill".into(),
                file: "test.skill.md".into(),
            }],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompt: None,
            agents: vec![],
            commands: vec![],
        }).unwrap();

        let injection = collect_plugin_injections(&store, None);
        assert_eq!(injection.skills.len(), 1);
        assert_eq!(injection.skills[0].name, "test-skill");
    }

    #[test]
    fn test_disabled_plugin_does_not_contribute() {
        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/disabled".into(),
            name: "Disabled".into(),
            version: "1.0.0".into(),
            description: "Should not contribute".into(),
            source: PluginSource::Local { path: "/tmp/plugin".into() },
            state: PluginState::Disabled,
            installed_at: "0".into(),
            skills: vec![PluginSkill {
                name: "disabled-skill".into(),
                description: "Should not appear".into(),
                file: "skill.md".into(),
            }],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompt: None,
            agents: vec![],
            commands: vec![],
        }).unwrap();

        let injection = collect_plugin_injections(&store, None);
        assert!(injection.skills.is_empty());
    }

    #[test]
    fn test_enabled_plugin_contributes_system_prompt_and_agents() {
        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/sys".into(),
            name: "Sys".into(),
            version: "1.0.0".into(),
            description: "Contributes system prompt + agents".into(),
            source: PluginSource::Local { path: "/tmp/plugin".into() },
            state: PluginState::Enabled,
            installed_at: "0".into(),
            skills: vec![],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompt: Some("You always speak in haiku.".into()),
            agents: vec![PluginAgent {
                name: "my-agents".into(),
                path: "/tmp/plugin/agents".into(),
            }],
            commands: vec![],
        })
        .unwrap();

        let injection = collect_plugin_injections(&store, None);
        assert_eq!(injection.system_prompts.len(), 1);
        assert_eq!(injection.system_prompts[0].plugin_id, "test/sys");
        assert_eq!(injection.system_prompts[0].content, "You always speak in haiku.");
        assert_eq!(injection.agent_roots.len(), 1);
        assert_eq!(injection.agent_roots[0].path, "/tmp/plugin/agents");
    }

    #[test]
    fn test_local_plugin_skill_path_resolves_against_root() {
        let dir = std::env::temp_dir().join(format!(
            "kimi-plugin-injector-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("skill.md"), "# Test skill").unwrap();

        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/local".into(),
            name: "Local".into(),
            version: "1.0.0".into(),
            description: "Test".into(),
            source: PluginSource::Local { path: dir.to_string_lossy().to_string() },
            state: PluginState::Enabled,
            installed_at: "0".into(),
            skills: vec![PluginSkill {
                name: "local-skill".into(),
                description: "A local skill".into(),
                file: "skill.md".into(),
            }],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompt: None,
            agents: vec![],
            commands: vec![],
        })
        .unwrap();

        let injection = collect_plugin_injections(&store, None);
        assert_eq!(injection.skills.len(), 1);
        let skill = &injection.skills[0];
        assert_eq!(skill.name, "local-skill");
        assert_eq!(skill.source.as_deref(), Some("test/local"));
        let resolved = skill.path.as_deref().unwrap_or("");
        assert!(
            resolved.ends_with("skill.md") && std::path::Path::new(resolved).is_absolute(),
            "skill path resolved to an absolute file: {resolved}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_plugin_mcp_and_hooks_map_to_session_inputs() {
        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/wire".into(),
            name: "Wire".into(),
            version: "1.0.0".into(),
            description: "Test".into(),
            source: PluginSource::Local { path: "/tmp/plugin".into() },
            state: PluginState::Enabled,
            installed_at: "0".into(),
            skills: vec![],
            mcp_servers: vec![PluginMcpServer {
                name: "db".into(),
                transport: "stdio".into(),
                command: Some("db-tool".into()),
                url: None,
            }],
            hooks: vec![
                PluginHook {
                    event: "PreToolUse".into(),
                    command: "echo pre".into(),
                    matcher: Some("^Read$".into()),
                },
                PluginHook {
                    event: "NotAnEvent".into(),
                    command: "echo nope".into(),
                    matcher: None,
                },
            ],
            system_prompt: None,
            agents: vec![],
            commands: vec![],
        })
        .unwrap();

        let injection = collect_plugin_injections(&store, None);
        assert_eq!(injection.mcp_servers.len(), 1);
        assert_eq!(injection.mcp_servers[0].name, "db");
        assert_eq!(injection.mcp_servers[0].transport.as_deref(), Some("stdio"));
        assert_eq!(injection.mcp_servers[0].command.as_deref(), Some("db-tool"));
        // Unknown hook event dropped; known one mapped with matcher.
        assert_eq!(injection.hooks.len(), 1);
        assert_eq!(
            injection.hooks[0].event,
            kimi_protocol::hooks::HookEventType::PreToolUse
        );
        assert_eq!(injection.hooks[0].command, "echo pre");
        assert_eq!(injection.hooks[0].matcher.as_deref(), Some("^Read$"));
    }

    #[test]
    fn test_compose_plugin_sections_budgets_and_marks_skipped() {
        // Fits comfortably.
        let (content, skipped) = compose_plugin_sections(&[
            PluginSystemPrompt { plugin_id: "a".into(), content: "short".into() },
            PluginSystemPrompt { plugin_id: "b".into(), content: "also short".into() },
        ]);
        assert!(skipped.is_empty());
        assert!(content.contains("<!-- From: plugin a -->"));
        assert!(content.contains("<!-- From: plugin b -->"));

        // One oversized contribution blows the aggregate budget → skipped.
        let huge = "x".repeat(PLUGIN_SECTIONS_MAX_BYTES + 10);
        let (_, skipped) = compose_plugin_sections(&[PluginSystemPrompt {
            plugin_id: "big".into(),
            content: huge,
        }]);
        assert_eq!(skipped, vec!["big".to_string()]);
    }
}