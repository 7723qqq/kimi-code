//! Native execution of Subagent orchestration tools (P28 批 2).
//!
//! Exposes `invoke_subagent`, `manage_subagents`, and `define_subagent` natively
//! within the Rust engine runtime.

use serde_json::Value;
use std::sync::Arc;

use crate::subagent::{SubagentDefinition, SubagentManager};
use crate::turn_loop::types::ExecutableToolResult;

/// Execute `invoke_subagent` tool natively.
pub async fn execute_invoke_subagent(
    manager: &Arc<SubagentManager>,
    args: &Value,
) -> ExecutableToolResult {
    let mut spawned_records = Vec::new();

    // Spawn the subagent, running an autonomous turn loop when the host has
    // injected a runtime (llm + callbacks); otherwise fall back to a plain
    // lifecycle record so the tool stays usable without a runtime.
    async fn spawn_or_run(
        manager: &Arc<SubagentManager>,
        type_name: &str,
        role: &str,
        prompt: &str,
    ) -> Result<String, String> {
        if let Some(runtime) = manager.runtime().await {
            manager
                .spawn_and_run(
                    type_name,
                    role,
                    prompt,
                    runtime.llm.clone(),
                    runtime.callbacks.clone(),
                )
                .await
        } else {
            manager.spawn(type_name, role).await
        }
    }

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

            let prompt = sub
                .get("Prompt")
                .or_else(|| sub.get("prompt"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            match spawn_or_run(manager, type_name, role, prompt).await {
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

        let prompt = args
            .get("Prompt")
            .or_else(|| args.get("prompt"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        match spawn_or_run(manager, type_name, role, prompt).await {
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
            disallowed_tools: Vec::new(),
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        })
        .await;

    ExecutableToolResult {
        content: format!("Subagent '{name}' registered successfully."),
        is_error: false,
        note: Some("native_subagent".into()),
    }
}

/// Engine tool definitions for the subagent orchestration tools, so the
/// model can discover and call them (used by the standalone REPL).
pub fn subagent_tool_defs() -> Vec<crate::turn_loop::types::ToolInfo> {
    vec![
        crate::turn_loop::types::ToolInfo {
            name: "invoke_subagent".into(),
            description: "Launch one or more subagents in the background. Each subagent runs an autonomous turn loop with its own tool whitelist and reports back when finished.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "Subagents": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "TypeName": { "type": "string", "description": "Registered subagent type (e.g. research)" },
                                "Role": { "type": "string", "description": "Role label for the subagent" },
                                "Prompt": { "type": "string", "description": "Task prompt for the subagent" }
                            }
                        }
                    }
                }
            }),
        },
        crate::turn_loop::types::ToolInfo {
            name: "manage_subagents".into(),
            description: "List running subagents or kill one by conversation id.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "Action": { "type": "string", "enum": ["list", "kill"] },
                    "ConversationIds": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["Action"]
            }),
        },
        crate::turn_loop::types::ToolInfo {
            name: "define_subagent".into(),
            description: "Register a custom subagent definition with a system prompt and tool whitelist.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "system_prompt": { "type": "string" },
                    "tools": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["name"]
            }),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_subagent_tools_execution() {
        let manager = Arc::new(SubagentManager::new());

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
        let res = execute_manage_subagents(manager.as_ref(), &list_args).await;
        assert!(!res.is_error);
        assert!(res.content.contains("Codebase Searcher"));

        // 3. Define custom subagent
        let define_args = serde_json::json!({
            "name": "tester",
            "description": "Test runner",
            "system_prompt": "Run tests and summarize failures.",
            "tools": ["bash", "read"]
        });
        let res = execute_define_subagent(manager.as_ref(), &define_args).await;
        assert!(!res.is_error);
        assert!(res.content.contains("registered successfully"));
    }

    struct MockSubagentLlm;
    impl crate::turn_loop::types::LLM for MockSubagentLlm {
        fn system_prompt(&self) -> &str {
            "mock system prompt"
        }
        fn model_name(&self) -> &str {
            "mock-subagent-model"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<
            '_,
            Result<
                crate::turn_loop::types::LLMChatResponse,
                Box<dyn std::error::Error + Send + Sync>,
            >,
        > {
            Box::pin(async {
                Ok(crate::turn_loop::types::LLMChatResponse {
                    content: "Autonomous research result complete.".into(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: crate::rpc::types::TokenUsage {
                        input_tokens: 10,
                        output_tokens: 15,
                        total_tokens: 25,
                        input_cache_read: 0,
                        input_cache_creation: 0,
                    },
                })
            })
        }
    }

    struct MockCallbacks;
    impl crate::callbacks::HostCallbacks for MockCallbacks {
        fn llm_chat(
            &self,
            _req: crate::rpc::types::LlmChatRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::LlmChatResponse, String>,
        > {
            Box::pin(async { Err("Not needed in mock".into()) })
        }
        fn execute_tool(
            &self,
            _req: crate::rpc::types::ToolExecuteRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async { Err("Not needed in mock".into()) })
        }
        fn check_permission(
            &self,
            _req: crate::rpc::types::PermissionCheckRequest,
        ) -> futures_util::future::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async { Ok(crate::rpc::types::PermissionDecision::allow()) })
        }
    }

    #[tokio::test]
    async fn test_invoke_subagent_runs_real_turn_with_runtime() {
        let manager = Arc::new(SubagentManager::new());
        manager
            .set_runtime(Arc::new(MockSubagentLlm), Arc::new(MockCallbacks))
            .await;

        let invoke_args = serde_json::json!({
            "Subagents": [
                {
                    "TypeName": "research",
                    "Role": "Runtime Searcher",
                    "Prompt": "Find the main loop"
                }
            ]
        });
        let res = execute_invoke_subagent(&manager, &invoke_args).await;
        assert!(!res.is_error);
        assert!(res.content.contains("running"));

        // With a runtime injected, the subagent runs an autonomous turn and
        // reaches Completed instead of staying a bare lifecycle record.
        let list = manager.list().await;
        assert_eq!(list.len(), 1);
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let list = manager.list().await;
            if list[0].state == crate::subagent::SubagentState::Completed {
                let inst = manager.get_instance(&list[0].id).await.unwrap();
                assert!(inst.last_result.as_deref().unwrap().contains("finished in"));
                return;
            }
        }
        panic!("Subagent did not reach Completed state within timeout");
    }

    #[tokio::test]
    async fn test_invoke_subagent_without_runtime_falls_back_to_record() {
        let manager = Arc::new(SubagentManager::new());
        let invoke_args = serde_json::json!({
            "Subagents": [
                {
                    "TypeName": "research",
                    "Role": "Record Only"
                }
            ]
        });
        let res = execute_invoke_subagent(&manager, &invoke_args).await;
        assert!(!res.is_error);
        assert!(res.content.contains("running"));

        let list = manager.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, crate::subagent::SubagentState::Running);
    }

    #[tokio::test]
    async fn test_subagent_tool_defs_expose_orchestration_tools() {
        let defs = subagent_tool_defs();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["invoke_subagent", "manage_subagents", "define_subagent"]
        );
        assert!(defs[0].input_schema.get("type").is_some());
    }
}
