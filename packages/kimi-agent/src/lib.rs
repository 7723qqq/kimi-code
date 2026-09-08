//! kimi-agent — Rust agent engine library.
//!
//! Shared library entry point for both the CLI binary (stdio JSON-RPC)
//! and the napi-rs native addon (direct Node.js integration).

pub mod acp;
pub mod callbacks;
pub mod compaction;
pub mod config;
pub mod cron;
pub mod engine;
pub mod events;
pub mod goal;
pub mod injection;
pub mod knowledge;
pub mod llm;
pub mod mcp;
pub mod native;
#[cfg(feature = "napi")]
pub mod napi_bindings;
pub mod permission;
pub mod pipeline;
pub mod prompt;
pub mod repl;
pub mod rpc;
pub mod server;
pub mod session;
pub mod skills;
pub mod storage;
pub mod subagent;
pub mod swarm;
pub mod team;
pub mod tool_result_truncation;
pub mod tools;
pub mod turn_events;
pub mod turn_loop;

use std::sync::Arc;
use crate::native::event_store::{EventStore, RawWireEvent};
use crate::native::permission_engine::PermissionEngine;
use crate::turn_loop::types::LLMMessage;

/// 将 EventStore 折叠出的通用模型消息转换为 TurnLoop 所需的 LLMMessage
pub fn event_store_message_to_llm(msg: crate::native::event_store::Message) -> LLMMessage {
    let role = match msg.role {
        crate::native::event_store::MessageRole::System => "system",
        crate::native::event_store::MessageRole::User => "user",
        crate::native::event_store::MessageRole::Assistant => "assistant",
        crate::native::event_store::MessageRole::Tool => "tool",
    };

    let mut tool_calls = Vec::new();
    if let Some(calls_val) = msg.tool_calls
        && let Some(arr) = calls_val.as_array()
    {
        for c in arr {
            let id = c.get("id").and_then(|i| i.as_str()).unwrap_or("call").to_string();
            let name = c.get("function").and_then(|f| f.get("name")).and_then(|n| n.as_str()).unwrap_or("tool").to_string();
            let arguments = c.get("function").and_then(|f| f.get("arguments")).cloned().unwrap_or(serde_json::json!({}));
            tool_calls.push(crate::turn_loop::types::ToolCall {
                id,
                name,
                arguments,
                extras: None,
            });
        }
    }

    let blocks: Vec<crate::rpc::types::ContentBlock> =
        serde_json::from_value(msg.blocks).unwrap_or_default();

    LLMMessage {
        role: role.to_string(),
        content: msg.content,
        blocks,
        tool_calls,
        tool_call_id: msg.tool_call_id,
    }
}

/// 纯原生环境下的宿主回调桩（将权限评估直接导向原生 PermissionEngine）
struct NativeHostCallbacks {
    permission: Arc<PermissionEngine>,
}

impl crate::callbacks::HostCallbacks for NativeHostCallbacks {
    fn llm_chat(
        &self,
        _req: crate::rpc::types::LlmChatRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
        Box::pin(async { Err("Host proxy not supported in pure native engine".into()) })
    }

    fn execute_tool(
        &self,
        req: crate::rpc::types::ToolExecuteRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::ToolExecuteResponse, String>> {
        let tool_name = req.tool_name;
        Box::pin(async move {
            Err(format!("Tool '{tool_name}' not available on host callback"))
        })
    }

    fn check_permission(
        &self,
        req: crate::rpc::types::PermissionCheckRequest,
    ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::PermissionDecision, String>> {
        let perm = self.permission.clone();
        Box::pin(async move {
            let decision = if req.tool_name.eq_ignore_ascii_case("bash") {
                let cmd = req.arguments.get("command").and_then(|c| c.as_str()).unwrap_or("");
                perm.evaluate_bash_command(cmd)
            } else {
                let path_arg = req.arguments.get("path").and_then(|p| p.as_str()).map(std::path::Path::new);
                perm.evaluate_tool_call(&req.tool_name, path_arg)
            };

            match decision {
                crate::native::permission_engine::PermissionDecision::Allow => {
                    Ok(crate::rpc::types::PermissionDecision::allow())
                }
                crate::native::permission_engine::PermissionDecision::Deny => {
                    Ok(crate::rpc::types::PermissionDecision::deny("Operation denied by local permission engine"))
                }
                crate::native::permission_engine::PermissionDecision::AskUser => {
                    Ok(crate::rpc::types::PermissionDecision::deny("Operation requires user confirmation"))
                }
            }
        })
    }
}

use crate::engine::EngineConfig;

/// 自治运行引擎核心结构体
pub struct KimiEngine {
    store: Arc<dyn EventStore>,
    permission: Arc<PermissionEngine>,
    engine_config: EngineConfig,
}

impl KimiEngine {
    /// 构造完全独立的引擎实例
    pub fn new(
        store: Arc<dyn EventStore>,
        permission: Arc<PermissionEngine>,
    ) -> Self {
        Self {
            store,
            permission,
            engine_config: EngineConfig::default(),
        }
    }

    /// 设置引擎执行配置（如 Token 预算上限）
    pub fn with_engine_config(mut self, config: EngineConfig) -> Self {
        self.engine_config = config;
        self
    }

    /// 自主驱动单回合运行（简单文本闭环）
    pub async fn run_once(&self, session_id: &str, user_prompt: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        // 1. 将用户输入记入 SQLite 追加事件日志
        self.store.append_event(&RawWireEvent {
            id: ulid::Ulid::new().to_string(),
            session_id: session_id.to_string(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": user_prompt }),
            is_checkpoint: true,
            is_compaction: false,
            created_at: now,
        }).map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;

        // 2. 自主从事件日志中流式折叠还原完整上下文
        let _messages = self.store.fold_projection(session_id).map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;

        // 3. 原生权限评估，必要时阻塞终端
        if !self.permission.prompt_user_if_needed("agent_turn", None) {
            return Err("Execution denied by local permission engine".into());
        }

        let assistant_reply = format!("Engine response to '{}'", user_prompt);

        // 4. 将助手输出写入追加日志
        self.store.append_event(&RawWireEvent {
            id: ulid::Ulid::new().to_string(),
            session_id: session_id.to_string(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({ "content": assistant_reply }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: now + 1,
        }).map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;

        Ok(assistant_reply)
    }

    /// 原生全功能单回合循环驱动（直接驱动 3389 行真实 run_turn）
    pub async fn run_turn_with_llm(
        &self,
        session_id: &str,
        user_prompt: &str,
        llm: &dyn crate::turn_loop::types::LLM,
        max_steps: u32,
    ) -> Result<crate::turn_loop::types::TurnResult, Box<dyn std::error::Error + Send + Sync>> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        // 1. 将本次提问写入事件存储
        self.store.append_event(&RawWireEvent {
            id: ulid::Ulid::new().to_string(),
            session_id: session_id.to_string(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": user_prompt }),
            is_checkpoint: true,
            is_compaction: false,
            created_at: now,
        }).map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;

        // 2. 从事件存储折叠出历史消息并转为 LLMMessage
        let projected = self.store.fold_projection(session_id)
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
        let llm_messages: Vec<LLMMessage> = projected.into_iter().map(event_store_message_to_llm).collect();

        // 3. 组装输入与原生工具回调
        let turn_id = ulid::Ulid::new().to_string();
        let base_callbacks: Arc<dyn crate::callbacks::HostCallbacks> = Arc::new(NativeHostCallbacks {
            permission: self.permission.clone(),
        });

        let workspace_str = self.permission.workspace_root().to_string_lossy().to_string();
        let tool_defs = crate::tools::core_tool_defs::core_tool_defs();
        let callbacks = if let Some(toolset) = crate::tools::NativeToolset::new(&workspace_str, None) {
            let toolset = Arc::new(toolset.with_callbacks(base_callbacks.clone()));
            Arc::new(crate::callbacks::NativeToolCallbacks {
                inner: base_callbacks.clone(),
                toolset,
                native_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
                truncator: None,
                permission_engine: None,
                plan_guard: None,
                stale_guard: None,
                goal_guard: None,
                hook_guard: None,
                agent_tool_veto: None,
                tools_veto: None,
                todo_tool_veto: None,
                tower_worktree_root: None,
                sandbox_policy: None,
            }) as Arc<dyn crate::callbacks::HostCallbacks>
        } else {
            base_callbacks
        };

        let input = crate::turn_loop::types::RunTurnInput {
            max_attempts: None,
            turn_id: turn_id.clone(),
            llm,
            messages: llm_messages,
            tools: &[],
            tool_defs,
            max_steps,
            max_context_tokens: Some(self.engine_config.max_tokens_limit as u32),
            goal: None,
            cancellation: None,
        };

        // 4. 驱动原生 run_turn 循环
        let turn_res = crate::turn_loop::run_turn::run_turn(input, &callbacks).await
            .map_err(|e| format!("{e}"))?;

        // 5. 将模型与工具产生的最新消息流写入 SQLite 事件存储
        for msg in &turn_res.messages {
            if msg.role == "assistant" && (!msg.content.is_empty() || !msg.tool_calls.is_empty()) {
                let tool_calls_json = if msg.tool_calls.is_empty() {
                    None
                } else {
                    Some(serde_json::to_value(&msg.tool_calls).unwrap_or(serde_json::Value::Null))
                };
                let _ = self.store.append_event(&RawWireEvent {
                    id: ulid::Ulid::new().to_string(),
                    session_id: session_id.to_string(),
                    event_type: "message.assistant".into(),
                    payload: serde_json::json!({
                        "content": msg.content,
                        "tool_calls": tool_calls_json,
                    }),
                    is_checkpoint: false,
                    is_compaction: false,
                    created_at: now + 1,
                });
            } else if msg.role == "tool" {
                let _ = self.store.append_event(&RawWireEvent {
                    id: ulid::Ulid::new().to_string(),
                    session_id: session_id.to_string(),
                    event_type: "tool.result".into(),
                    payload: serde_json::json!({
                        "content": msg.content,
                        "tool_call_id": msg.tool_call_id,
                    }),
                    is_checkpoint: false,
                    is_compaction: false,
                    created_at: now + 1,
                });
            }
        }

        Ok(turn_res)
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::native::event_store::SqliteEventStore;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_kimi_engine_run_once_flow() {
        let store = Arc::new(SqliteEventStore::new_in_memory().unwrap());
        let root = PathBuf::from("G:/kimi/kimi-code");
        let permission = Arc::new(PermissionEngine::new(&root, None).unwrap());

        let engine = KimiEngine::new(store.clone(), permission);
        let reply = engine.run_once("session_test", "Hello Native Rust Engine").await.unwrap();
        assert!(reply.contains("Hello Native Rust Engine"));

        let msgs = store.fold_projection("session_test").unwrap();
        assert_eq!(msgs.len(), 2);
    }

    struct MockLLM;
    impl crate::turn_loop::types::LLM for MockLLM {
        fn system_prompt(&self) -> &str { "You are a test engine." }
        fn model_name(&self) -> &str { "mock-model" }
        fn is_retryable_error(&self, _error: &str) -> bool { false }
        fn chat(
            &self,
            _params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<'_, Result<crate::turn_loop::types::LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
            Box::pin(async {
                Ok(crate::turn_loop::types::LLMChatResponse {
                    content: "Simulated native LLM reply".into(),
                    thinking: Vec::new(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: crate::rpc::types::TokenUsage::default(),
                })
            })
        }
    }

    #[tokio::test]
    async fn test_kimi_engine_real_run_turn_execution() {
        let store = Arc::new(SqliteEventStore::new_in_memory().unwrap());
        let root = PathBuf::from("G:/kimi/kimi-code");
        let permission = Arc::new(PermissionEngine::new(&root, None).unwrap());

        let engine = KimiEngine::new(store.clone(), permission);
        let mock_llm = MockLLM;

        let result = engine.run_turn_with_llm("sess_real_turn", "Run full loop step", &mock_llm, 3).await.unwrap();
        assert_eq!(result.steps, 1);
        
        let last_msg = result.messages.last().expect("must have assistant reply");
        assert_eq!(last_msg.role, "assistant");
        assert_eq!(last_msg.content, "Simulated native LLM reply");

        // 验证 SQLite 事件日志完整持久化了本次 Turn 执行
        let history = store.fold_projection("sess_real_turn").unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].role, crate::native::event_store::MessageRole::User);
        assert_eq!(history[0].content, "Run full loop step");
        assert_eq!(history[1].role, crate::native::event_store::MessageRole::Assistant);
        assert_eq!(history[1].content, "Simulated native LLM reply");
    }

    struct MockToolCallingLLM {
        call_count: std::sync::atomic::AtomicUsize,
    }

    impl crate::turn_loop::types::LLM for MockToolCallingLLM {
        fn system_prompt(&self) -> &str { "You are a tool-using engine." }
        fn model_name(&self) -> &str { "mock-tool-model" }
        fn is_retryable_error(&self, _error: &str) -> bool { false }
        fn chat(
            &self,
            _params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<'_, Result<crate::turn_loop::types::LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
            let count = self.call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move {
                if count == 0 {
                    // 第 1 步：发起 Read 工具调用
                    Ok(crate::turn_loop::types::LLMChatResponse {
                        content: "".into(),
                        thinking: Vec::new(),
                        tool_calls: vec![crate::turn_loop::types::ToolCall {
                            id: "call_read_1".into(),
                            name: "Read".into(),
                            arguments: serde_json::json!({
                                "path": "package.json"
                            }),
                            extras: None,
                        }],
                        finish_reason: Some("tool_calls".into()),
                        usage: crate::rpc::types::TokenUsage::default(),
                    })
                } else {
                    // 第 2 步：观察到工具结果后输出最终回答
                    Ok(crate::turn_loop::types::LLMChatResponse {
                        content: "Successfully inspected package.json".into(),
                        thinking: Vec::new(),
                        tool_calls: Vec::new(),
                        finish_reason: Some("stop".into()),
                        usage: crate::rpc::types::TokenUsage::default(),
                    })
                }
            })
        }
    }

    #[tokio::test]
    async fn test_kimi_engine_multistep_native_tool_execution() {
        let store = Arc::new(SqliteEventStore::new_in_memory().unwrap());
        let root = std::env::current_dir().unwrap();
        let permission = Arc::new(PermissionEngine::new(&root, None).unwrap());

        let engine = KimiEngine::new(store.clone(), permission);
        let mock_llm = MockToolCallingLLM {
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };

        let result = engine.run_turn_with_llm("sess_multi_step", "Inspect package.json", &mock_llm, 5).await.unwrap();
        assert_eq!(result.steps, 2);

        let last_msg = result.messages.last().expect("must have final assistant reply");
        assert_eq!(last_msg.role, "assistant");
        assert_eq!(last_msg.content, "Successfully inspected package.json");

        // 验证事件流存储了完整的多步事件链
        let history = store.fold_projection("sess_multi_step").unwrap();
        assert!(history.len() >= 3);
        assert_eq!(history[0].role, crate::native::event_store::MessageRole::User);
        assert_eq!(history[0].content, "Inspect package.json");
        assert_eq!(history[1].role, crate::native::event_store::MessageRole::Assistant);
        assert_eq!(history[2].role, crate::native::event_store::MessageRole::Tool);
        assert_eq!(history[2].tool_call_id.as_deref(), Some("call_read_1"));
    }

    #[tokio::test]
    async fn test_kimi_engine_with_custom_engine_config() {
        let store = Arc::new(SqliteEventStore::new_in_memory().unwrap());
        let root = std::env::current_dir().unwrap();
        let permission = Arc::new(PermissionEngine::new(&root, None).unwrap());

        let custom_config = EngineConfig {
            max_tokens_limit: 50_000,
            stop_hook: None,
        };

        let engine = KimiEngine::new(store.clone(), permission).with_engine_config(custom_config);
        let mock_llm = MockLLM;

        let result = engine.run_turn_with_llm("sess_cfg_test", "Hello with config", &mock_llm, 2).await.unwrap();
        assert_eq!(result.steps, 1);
        assert_eq!(engine.engine_config.max_tokens_limit, 50_000);
    }
}
