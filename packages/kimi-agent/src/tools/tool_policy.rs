//! Engine-owned native tool table and the global `[tools]` switch.
//!
//! Host-driven sessions (the napi addon, the standalone server, stdio) run
//! tool calls through [`super::NativeToolset`], so the engine also owns the
//! definitions advertised to the model: [`native_tool_defs`] assembles the
//! set and [`ToolsFilter`] intersects it with the user's `[tools]` global
//! enable/disable lists (v2 `toolPolicy` service). The host's own tool table
//! and MCP-discovered tools are merged on top by `NativeToolCallbacks`.

use crate::turn_loop::types::ToolInfo;

/// Global `[tools]` switch (v2 `tools.enabled` / `tools.disabled`): an
/// allowlist applied first, then a denylist. Built-in tools match by exact
/// name; MCP tools match with `mcp__` globs (`mcp__github__*`).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ToolsFilter {
    #[serde(default)]
    pub enabled: Vec<String>,
    #[serde(default)]
    pub disabled: Vec<String>,
}

impl ToolsFilter {
    /// Whether the filter constrains anything (both lists empty = pass-through).
    pub fn is_active(&self) -> bool {
        !self.enabled.is_empty() || !self.disabled.is_empty()
    }

    /// Whether `name` survives the global switch: it must pass the allowlist
    /// when one is configured, then must not match any denylist entry.
    pub fn allows(&self, name: &str) -> bool {
        let enabled = self.enabled.is_empty()
            || self
                .enabled
                .iter()
                .any(|pattern| matches_tool_pattern(pattern, name));
        enabled
            && !self
                .disabled
                .iter()
                .any(|pattern| matches_tool_pattern(pattern, name))
    }

    /// Drop every definition the filter rejects, keeping the input order.
    pub fn apply(&self, defs: Vec<ToolInfo>) -> Vec<ToolInfo> {
        if !self.is_active() {
            return defs;
        }
        defs.into_iter()
            .filter(|definition| self.allows(&definition.name))
            .collect()
    }

    /// Whether a native tool *call* must be refused. Enforcement is
    /// case-insensitive for built-ins (the engine dispatches on the lowercase
    /// wire name while the configured table spells them `Read`), so a
    /// disabled tool is refused even when the model calls it from memory.
    pub fn blocks_call(&self, name: &str) -> bool {
        if !self.is_active() {
            return false;
        }
        let matches = |pattern: &str| {
            if pattern.starts_with("mcp__") {
                matches_tool_pattern(pattern, name)
            } else {
                pattern.eq_ignore_ascii_case(name)
            }
        };
        let enabled = self.enabled.is_empty() || self.enabled.iter().any(|p| matches(p));
        !enabled || self.disabled.iter().any(|p| matches(p))
    }
}

/// `mcp__` patterns match as globs (`*` matches any run of characters);
/// every other name matches exactly and case-sensitively, mirroring the
/// v2 global tool switch. Shared with the per-profile policy (v2
/// `isToolActive`), which applies the same source-dependent rule.
pub fn matches_tool_pattern(pattern: &str, name: &str) -> bool {
    if !pattern.starts_with("mcp__") || !pattern.contains('*') {
        return pattern == name;
    }
    glob_match(pattern, name)
}

/// Minimal glob matcher: `*` is the only metacharacter, everything else is
/// literal. Sufficient for MCP tool patterns such as `mcp__github__*`.
fn glob_match(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = name;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if index == 0 {
            let Some(stripped) = rest.strip_prefix(part) else {
                return false;
            };
            rest = stripped;
        } else if index == parts.len() - 1 {
            return rest.ends_with(part);
        } else if let Some(position) = rest.find(part) {
            rest = &rest[position + part.len()..];
        } else {
            return false;
        }
    }
    // A pattern that neither starts nor ends with `*` must match exactly,
    // which the prefix and suffix checks above already enforce.
    pattern.starts_with('*') || pattern.ends_with('*') || rest.is_empty()
}

/// Subagent orchestration definitions (the `Agent` / `AgentSwarm` surface),
/// carrying the `[secondary_model]` pool when one is configured.
fn subagent_defs(
    pool: Option<&crate::subagent::secondary::SecondaryModelRuntime>,
) -> Vec<ToolInfo> {
    vec![
        crate::tools::agent_tool::agent_tool_def(pool),
        crate::tools::swarm_tool::agent_swarm_tool_def(pool),
    ]
}

/// Every engine-owned tool definition for a host-driven session, filtered by
/// the user's `[tools]` switch. The list mirrors what [`super::NativeToolset`]
/// executes natively plus the host-routed subagent orchestration tools; MCP
/// tools and host-registered tools are appended by the callbacks layer.
pub fn native_tool_defs(
    github_available: bool,
    tower_enabled: bool,
    filter: Option<&ToolsFilter>,
    secondary_model: Option<&crate::subagent::secondary::SecondaryModelRuntime>,
) -> Vec<ToolInfo> {
    let mut defs = crate::tools::core_tool_defs::core_tool_defs();
    defs.extend(subagent_defs(secondary_model));
    defs.push(crate::tools::todo_list::todo_list_tool_def());
    defs.push(crate::tools::ask_user_question::ask_user_question_tool_def());
    defs.push(crate::tools::plan_mode::enter_plan_mode_tool_def());
    defs.push(crate::tools::exit_plan_mode::exit_plan_mode_tool_def());
    defs.push(crate::tools::get_goal::get_goal_tool_def());
    defs.push(crate::tools::create_goal::create_goal_tool_def());
    defs.push(crate::tools::goal_tools::update_goal_tool_def());
    defs.push(crate::tools::goal_tools::set_goal_budget_tool_def());
    defs.push(crate::tools::cron_tools::cron_list_tool_def());
    defs.push(crate::tools::cron_tools::cron_create_tool_def());
    defs.push(crate::tools::cron_tools::cron_delete_tool_def());
    defs.push(crate::tools::task_tools::task_list_tool_def());
    defs.push(crate::tools::task_tools::task_output_tool_def());
    defs.push(crate::tools::task_tools::task_stop_tool_def());
    defs.push(crate::tools::task_tools::wait_for_tool_def());
    defs.push(crate::tools::skill::skill_tool_def());
    defs.push(crate::tools::knowledge_tool::knowledge_tool_def());
    defs.push(crate::tools::team_tool::team_tool_def());
    defs.push(crate::tools::workflow::workflow_tool_def());
    if github_available {
        defs.extend(crate::tools::github::github_tool_defs());
    }
    if tower_enabled {
        defs.extend(crate::tools::tower::tower_tool_defs());
    }
    match filter {
        Some(filter) => filter.apply(defs),
        None => defs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def_names(defs: &[ToolInfo]) -> Vec<&str> {
        defs.iter().map(|d| d.name.as_str()).collect()
    }

    #[test]
    fn empty_filter_allows_everything() {
        let filter = ToolsFilter::default();
        assert!(!filter.is_active());
        assert!(filter.allows("Read"));
        assert!(filter.allows("mcp__github__search"));
    }

    #[test]
    fn allowlist_intersects_and_denylist_subtracts() {
        let filter = ToolsFilter {
            enabled: vec!["Read".into(), "Bash".into()],
            disabled: vec!["Bash".into()],
        };
        assert!(filter.allows("Read"));
        assert!(!filter.allows("Bash"), "denylist wins over the allowlist");
        assert!(!filter.allows("Grep"), "not in the allowlist");
    }

    #[test]
    fn builtin_names_match_exactly_and_case_sensitively() {
        let filter = ToolsFilter {
            enabled: Vec::new(),
            disabled: vec!["read".into(), "Bash(rm -rf*)".into()],
        };
        assert!(filter.allows("Read"), "built-ins are case-sensitive");
        assert!(
            filter.allows("Bash"),
            "argument patterns do not match names"
        );
        assert!(
            filter.allows("mcp__github__read"),
            "non-mcp patterns do not glob"
        );
        assert!(!filter.allows("read"));
    }

    #[test]
    fn mcp_globs_match_the_qualified_name() {
        let filter = ToolsFilter {
            enabled: Vec::new(),
            disabled: vec!["mcp__github__*".into()],
        };
        assert!(!filter.allows("mcp__github__search"));
        assert!(filter.allows("mcp__slack__search"));
        assert!(
            filter.allows("mcp__github"),
            "glob requires the tool segment"
        );

        let bare = ToolsFilter {
            enabled: Vec::new(),
            disabled: vec!["mcp__*".into()],
        };
        assert!(!bare.allows("mcp__github__search"));
    }

    #[test]
    fn mcp_middle_glob_matches() {
        assert!(glob_match("mcp__*__search", "mcp__github__search"));
        assert!(!glob_match("mcp__*__read", "mcp__github__search"));
        assert!(glob_match("*search", "mcp__github__search"));
        assert!(glob_match("mcp__github__*", "mcp__github__search"));
    }

    #[test]
    fn call_enforcement_is_case_insensitive_for_builtins() {
        let filter = ToolsFilter {
            enabled: Vec::new(),
            disabled: vec!["Read".into()],
        };
        assert!(filter.blocks_call("read"), "lowercase wire name is blocked");
        assert!(filter.blocks_call("Read"));
        assert!(!filter.blocks_call("Grep"));

        let allow_only_read = ToolsFilter {
            enabled: vec!["Read".into()],
            disabled: Vec::new(),
        };
        assert!(!allow_only_read.blocks_call("read"));
        assert!(allow_only_read.blocks_call("Bash"));
    }

    #[test]
    fn native_tool_defs_expose_the_orchestration_surface() {
        let defs = native_tool_defs(false, false, None, None);
        let names = def_names(&defs);
        for expected in [
            "Read",
            "Grep",
            "Glob",
            "Write",
            "Edit",
            "Bash",
            "FetchURL",
            "WebSearch",
            "Agent",
            "AgentSwarm",
            "TodoList",
            "AskUserQuestion",
            "EnterPlanMode",
            "ExitPlanMode",
            "GetGoal",
            "CreateGoal",
            "UpdateGoal",
            "SetGoalBudget",
            "CronList",
            "CronCreate",
            "CronDelete",
            "TaskList",
            "TaskOutput",
            "TaskStop",
            "WaitFor",
            "Skill",
            "Knowledge",
            "Team",
            "Workflow",
        ] {
            assert!(
                names.contains(&expected),
                "missing tool definition: {expected}"
            );
        }
        assert!(!names.contains(&"TowerInit"), "tower tools are gated");
        assert!(
            !names.contains(&"Lsp"),
            "tower/lsp stay out of the advertised table"
        );
    }

    #[test]
    fn native_tool_defs_apply_the_filter() {
        let filter = ToolsFilter {
            enabled: Vec::new(),
            disabled: vec!["WebSearch".into(), "mcp__github__*".into()],
        };
        let defs = native_tool_defs(false, false, Some(&filter), None);
        let names = def_names(&defs);
        assert!(!names.contains(&"WebSearch"));
        assert!(names.contains(&"FetchURL"));

        let allow_only_read = ToolsFilter {
            enabled: vec!["Read".into()],
            disabled: Vec::new(),
        };
        let defs = native_tool_defs(false, false, Some(&allow_only_read), None);
        assert_eq!(def_names(&defs), vec!["Read"]);
    }

    #[test]
    fn github_and_tower_defs_follow_their_switches() {
        let github_defs = native_tool_defs(true, false, None, None);
        let with_github = def_names(&github_defs);
        assert!(
            with_github.iter().any(|name| name.starts_with("GitHub")),
            "github tools are advertised when a token is configured"
        );
        let tower_defs = native_tool_defs(false, true, None, None);
        let with_tower = def_names(&tower_defs);
        assert!(with_tower.contains(&"TowerInit"));
    }
}
