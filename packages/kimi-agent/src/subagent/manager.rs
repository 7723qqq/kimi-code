//! Subagent lifecycle and concurrency manager.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::RwLock;

use crate::subagent::types::*;

type InstanceEntry = (SubagentInstance, Arc<AtomicBool>);
type InstanceMap = Arc<RwLock<HashMap<String, InstanceEntry>>>;
type DefinitionMap = Arc<RwLock<HashMap<String, SubagentDefinition>>>;

/// Execution runtime injected by the host so subagents can run real turns.
pub struct SubagentRuntime {
    pub llm: Arc<dyn crate::turn_loop::types::LLM>,
    pub callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
}

pub struct SubagentManager {
    definitions: DefinitionMap,
    instances: InstanceMap,
    runtime: RwLock<Option<Arc<SubagentRuntime>>>,
}

impl Default for SubagentManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SubagentManager {
    pub fn new() -> Self {
        let mut defs = HashMap::new();
        // Built-in research subagent
        defs.insert(
            "research".into(),
            SubagentDefinition {
                name: "research".into(),
                description: "Research subagent with read-only tools for exploring codebase and fetching web info.".into(),
                system_prompt: "You are a specialized research subagent. Use read, grep, glob, fetch_url, and web_search to find information and report concise findings.".into(),
                tools: vec![
                    "read".into(),
                    "grep".into(),
                    "glob".into(),
                    "fetch_url".into(),
                    "web_search".into(),
                    "list_directory".into(),
                ],
                model: None,
            },
        );

        Self {
            definitions: Arc::new(RwLock::new(defs)),
            instances: Arc::new(RwLock::new(HashMap::new())),
            runtime: RwLock::new(None),
        }
    }

    /// Inject the execution runtime (LLM + callbacks) so subagents can run
    /// autonomous turns. Called after the callback pipeline is assembled.
    pub async fn set_runtime(
        &self,
        llm: Arc<dyn crate::turn_loop::types::LLM>,
        callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    ) {
        *self.runtime.write().await = Some(Arc::new(SubagentRuntime { llm, callbacks }));
    }

    /// Current execution runtime, if injected.
    pub async fn runtime(&self) -> Option<Arc<SubagentRuntime>> {
        self.runtime.read().await.clone()
    }

    /// Register or update a subagent definition.
    pub async fn register_definition(&self, def: SubagentDefinition) {
        let mut defs = self.definitions.write().await;
        defs.insert(def.name.clone(), def);
    }

    /// Get a registered definition by name.
    pub async fn get_definition(&self, name: &str) -> Option<SubagentDefinition> {
        let defs = self.definitions.read().await;
        defs.get(name).cloned()
    }

    /// Spawn a new subagent instance.
    pub async fn spawn(&self, type_name: &str, role: &str) -> Result<String, String> {
        let defs = self.definitions.read().await;
        if !defs.contains_key(type_name) && type_name != "self" {
            return Err(format!("Unknown subagent type: '{type_name}'"));
        }

        let id = format!("subagent-{}", fastrand::u64(..));
        let cancellation = Arc::new(AtomicBool::new(false));

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let instance = SubagentInstance {
            id: id.clone(),
            type_name: type_name.to_string(),
            role: role.to_string(),
            state: SubagentState::Running,
            created_at_ms: now_ms,
            last_result: None,
        };

        let mut instances = self.instances.write().await;
        instances.insert(id.clone(), (instance, cancellation));

        Ok(id)
    }

    /// Spawn a new subagent and launch an autonomous background execution loop.
    pub async fn spawn_and_run(
        self: &Arc<Self>,
        type_name: &str,
        role: &str,
        prompt: &str,
        llm: Arc<dyn crate::turn_loop::types::LLM>,
        callbacks: Arc<dyn crate::callbacks::HostCallbacks>,
    ) -> Result<String, String> {
        let id = self.spawn(type_name, role).await?;
        let def = self
            .get_definition(type_name)
            .await
            .unwrap_or_else(|| SubagentDefinition {
                name: type_name.to_string(),
                description: format!("Dynamic subagent for {role}"),
                system_prompt: format!("You are {role}. Complete the user's task accurately."),
                tools: vec![
                    "read".into(),
                    "grep".into(),
                    "glob".into(),
                    "fetch_url".into(),
                    "web_search".into(),
                    "list_directory".into(),
                ],
                model: None,
            });

        let mgr = self.clone();
        let subagent_id = id.clone();
        let prompt_str = prompt.to_string();
        let subagent_role = role.to_string();

        let cancel_flag = {
            let instances = mgr.instances.read().await;
            instances.get(&subagent_id).map(|(_, c)| c.clone())
        };

        tokio::spawn(async move {
            let turn_id = format!("subturn-{}", fastrand::u64(..));
            let messages = vec![crate::turn_loop::types::LLMMessage {
                role: "user".into(),
                content: format!("{}\n\nTask: {}", def.system_prompt, prompt_str),
                blocks: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }];

            let run_input = crate::turn_loop::types::RunTurnInput {
                turn_id,
                llm: llm.as_ref(),
                messages,
                tools: &[],
                tool_defs: Vec::new(),
                max_steps: 15,
                goal: None,
                cancellation: cancel_flag,
            };

            let run_result = crate::turn_loop::run_turn::run_turn(run_input, &callbacks)
                .await
                .map_err(|e| e.to_string());

            match run_result {
                Ok(turn_res) => {
                    let result_text = format!(
                        "Subagent '{}' finished in {} steps (Tokens: {}).",
                        subagent_role, turn_res.steps, turn_res.usage.total_tokens
                    );
                    mgr.update_state(&subagent_id, SubagentState::Completed, Some(result_text))
                        .await;
                }
                Err(err_msg) => {
                    mgr.update_state(
                        &subagent_id,
                        SubagentState::Failed,
                        Some(format!("Error: {err_msg}")),
                    )
                    .await;
                }
            }
        });

        Ok(id)
    }

    /// Retrieve an instance snapshot by ID.
    pub async fn get_instance(&self, id: &str) -> Option<SubagentInstance> {
        let instances = self.instances.read().await;
        instances.get(id).map(|(inst, _)| inst.clone())
    }

    /// Update the state of a subagent instance.
    pub async fn update_state(&self, id: &str, state: SubagentState, result: Option<String>) {
        let mut instances = self.instances.write().await;
        if let Some((inst, _)) = instances.get_mut(id) {
            inst.state = state;
            if result.is_some() {
                inst.last_result = result;
            }
        }
    }

    /// Terminate a running subagent by setting its cancellation flag.
    pub async fn kill(&self, id: &str) -> Result<bool, String> {
        let mut instances = self.instances.write().await;
        if let Some((inst, cancel_flag)) = instances.get_mut(id) {
            cancel_flag.store(true, Ordering::SeqCst);
            inst.state = SubagentState::Terminated;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// List summaries of all subagent instances.
    pub async fn list(&self) -> Vec<SubagentSummary> {
        let instances = self.instances.read().await;
        let mut list: Vec<SubagentSummary> = instances
            .values()
            .map(|(inst, _)| SubagentSummary {
                id: inst.id.clone(),
                type_name: inst.type_name.clone(),
                role: inst.role.clone(),
                state: inst.state,
                created_at_ms: inst.created_at_ms,
            })
            .collect();
        list.sort_by_key(|s| std::cmp::Reverse(s.created_at_ms));
        list
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_subagent_lifecycle() {
        let manager = SubagentManager::new();

        // Check built-in research definition
        let def = manager.get_definition("research").await.unwrap();
        assert_eq!(def.name, "research");
        assert!(def.tools.contains(&"fetch_url".to_string()));

        // Spawn a research subagent
        let id = manager
            .spawn("research", "Documentation Researcher")
            .await
            .unwrap();

        let list = manager.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].state, SubagentState::Running);

        // Update state
        manager
            .update_state(&id, SubagentState::Completed, Some("Found 5 docs".into()))
            .await;

        let list = manager.list().await;
        assert_eq!(list[0].state, SubagentState::Completed);

        // Kill subagent
        assert!(manager.kill(&id).await.unwrap());
        let list = manager.list().await;
        assert_eq!(list[0].state, SubagentState::Terminated);
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
    async fn test_subagent_spawn_and_run() {
        let manager = Arc::new(SubagentManager::new());
        let llm = Arc::new(MockSubagentLlm);
        let callbacks = Arc::new(MockCallbacks);

        let id = manager
            .spawn_and_run(
                "research",
                "Automated Codebase Scanner",
                "Investigate main loop architecture",
                llm,
                callbacks,
            )
            .await
            .unwrap();

        // Allow background Tokio task to execute run_turn
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if let Some(inst) = manager.get_instance(&id).await
                && inst.state == SubagentState::Completed
            {
                assert!(inst.last_result.is_some());
                assert!(inst.last_result.unwrap().contains("finished in"));
                return;
            }
        }

        panic!("Subagent did not reach Completed state within timeout");
    }

    #[tokio::test]
    async fn test_subagent_runtime_injection() {
        let manager = Arc::new(SubagentManager::new());
        assert!(manager.runtime().await.is_none());

        let llm: Arc<dyn crate::turn_loop::types::LLM> = Arc::new(MockSubagentLlm);
        let callbacks: Arc<dyn crate::callbacks::HostCallbacks> = Arc::new(MockCallbacks);
        manager.set_runtime(llm.clone(), callbacks.clone()).await;

        let runtime = manager.runtime().await.expect("runtime injected");
        assert!(Arc::ptr_eq(&runtime.llm, &llm));
        assert!(Arc::ptr_eq(&runtime.callbacks, &callbacks));
    }
}
