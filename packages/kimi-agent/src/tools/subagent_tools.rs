//! Native execution of Subagent orchestration tools (P28 批 2).
//!
//! Exposes `invoke_subagent`, `manage_subagents`, and `define_subagent` natively
//! within the Rust engine runtime.

use serde_json::Value;

use crate::subagent::{SubagentDefinition, SubagentManager};
use crate::turn_loop::types::ExecutableToolResult;

/// Execute `invoke_subagent` tool natively.
pub async fn execute_invoke_subagent(
    manager: &SubagentManager,
    args: &Value,
) -> ExecutableToolResult {
    let mut spawned_records = Vec::new();

    let subagents_array = args
        .get("Subagents")
        .or_else(|| args.get("subagents"))
        .and_then(|v| v.as_array());

    if let Some(subagents) = subagents_array {
        for sub in subagents {
            let type_name = sub
                .get("TypeName")
                .or_else(|| sub.get("type_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("research");

            let role = sub
                .get("Role")
                .or_else(|| sub.get("role"))
                .and_then(|v| v.as_str())
                .unwrap_or("Codebase Researcher");

            match manager.spawn(type_name, role).await {
                Ok(id) => {
                    spawned_records.push(serde_json::json!({
                        "conversationId": id,
                        "typeName": type_name,
                        "role": role,
                        "status": "running",
                    }));
                }
                Err(e) => {
                    spawned_records.push(serde_json::json!({
                        "typeName": type_name,
                        "role": role,
                        "error": e,
                    }));
                }
            }
        }
    } else {
        // Single subagent payload fallback
        let type_name = args
            .get("TypeName")
            .or_else(|| args.get("type_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("research");

        let role = args
            .get("Role")
            .or_else(|| args.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("Codebase Researcher");

        match manager.spawn(type_name, role).await {
            Ok(id) => {
                spawned_records.push(serde_json::json!({
                    "conversationId": id,
                    "typeName": type_name,
                    "role": role,
                    "status": "running",
                }));
            }
            Err(e) => {
                return ExecutableToolResult {
                    content: format!("Failed to invoke subagent: {e}"),
                    is_error: true,
                    note: None,
                };
            }
        }
    }

    ExecutableToolResult {
        content: serde_json::to_string_pretty(&serde_json::json!({
            "spawned": spawned_records,
            "status": "success",
            "message": "Subagent(s) launched in background."
        }))
        .unwrap_or_default(),
        is_error: false,
        note: Some("native_subagent".into()),
    }
}

/// Execute `manage_subagents` tool natively.
pub async fn execute_manage_subagents(
    manager: &SubagentManager,
    args: &Value,
) -> ExecutableToolResult {
    let action = args
        .get("Action")
        .or_else(|| args.get("action"))
        .and_then(|v| v.as_str())
        .unwrap_or("list");

    match action {
        "list" => {
            let list = manager.list().await;
            ExecutableToolResult {
                content: serde_json::to_string_pretty(&list).unwrap_or_default(),
                is_error: false,
                note: Some("native_subagent".into()),
            }
        }
        "kill" => {
            let ids = args
                .get("ConversationIds")
                .or_else(|| args.get("conversation_ids"))
                .and_then(|v| v.as_array());

            let mut killed = 0;
            if let Some(ids) = ids {
                for id_val in ids {
                    if let Some(id) = id_val.as_str()
                        && let Ok(true) = manager.kill(id).await
                    {
                        killed += 1;
                    }
                }
            }

            ExecutableToolResult {
                content: serde_json::json!({ "killed": killed }).to_string(),
                is_error: false,
                note: Some("native_subagent".into()),
            }
        }
        _ => ExecutableToolResult {
            content: format!("Unsupported manage_subagents action: '{action}'"),
            is_error: true,
            note: None,
        },
    }
}

/// Execute `define_subagent` tool natively.
pub async fn execute_define_subagent(
    manager: &SubagentManager,
    args: &Value,
) -> ExecutableToolResult {
    let name = match args
        .get("name")
        .or_else(|| args.get("Name"))
        .and_then(|v| v.as_str())
    {
        Some(n) => n.to_string(),
        None => {
            return ExecutableToolResult {
                content: "Missing required 'name' argument".into(),
                is_error: true,
                note: None,
            };
        }
    };

    let description = args
        .get("description")
        .or_else(|| args.get("Description"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let system_prompt = args
        .get("system_prompt")
        .or_else(|| args.get("SystemPrompt"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let tools = args
        .get("tools")
        .or_else(|| args.get("Tools"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    manager
        .register_definition(SubagentDefinition {
            name: name.clone(),
            description,
            system_prompt,
            tools,
            model: None,
        })
        .await;

    ExecutableToolResult {
        content: format!("Subagent '{name}' registered successfully."),
        is_error: false,
        note: Some("native_subagent".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_subagent_tools_execution() {
        let manager = SubagentManager::new();

        // 1. Invoke research subagent
        let invoke_args = serde_json::json!({
            "Subagents": [
                {
                    "TypeName": "research",
                    "Role": "Codebase Searcher",
                    "Prompt": "Find all usages of NativeHttpLlm"
                }
            ]
        });
        let res = execute_invoke_subagent(&manager, &invoke_args).await;
        assert!(!res.is_error);
        assert!(res.content.contains("running"));

        // 2. Manage: list
        let list_args = serde_json::json!({ "Action": "list" });
        let res = execute_manage_subagents(&manager, &list_args).await;
        assert!(!res.is_error);
        assert!(res.content.contains("Codebase Searcher"));

        // 3. Define custom subagent
        let define_args = serde_json::json!({
            "name": "tester",
            "description": "Test runner",
            "system_prompt": "Run tests and summarize failures.",
            "tools": ["bash", "read"]
        });
        let res = execute_define_subagent(&manager, &define_args).await;
        assert!(!res.is_error);
        assert!(res.content.contains("registered successfully"));
    }
}
