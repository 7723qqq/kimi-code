//! LLM proxy implementation that forwards chat requests to the JS host
//! via the [`HostCallbacks`] trait (abstracting over stdio JSON-RPC and
//! napi-rs ThreadsafeFunction transports).

use std::sync::Arc;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{self, LlmChatMessage};
use crate::turn_loop::types::*;

/// An LLM implementation that proxies requests to the JS host via
/// [`HostCallbacks::llm_chat`].
pub struct HostLlmProxy {
    system_prompt: String,
    model_name: String,
    callbacks: Option<Arc<dyn HostCallbacks>>,
    /// Set when this call is one of several racing providers, so the host can
    /// be told to drop it once another provider wins.
    request_id: Option<String>,
}

impl HostLlmProxy {
    pub fn new(system_prompt: String, model_name: String) -> Self {
        Self {
            system_prompt,
            model_name,
            callbacks: None,
            request_id: None,
        }
    }

    pub fn with_callbacks(mut self, callbacks: Arc<dyn HostCallbacks>) -> Self {
        self.callbacks = Some(callbacks);
        self
    }

    pub fn with_request_id(mut self, request_id: String) -> Self {
        self.request_id = Some(request_id);
        self
    }

    /// Legacy: accept an RPC server and wrap it in [`RpcHostCallbacks`].
    pub fn with_server(self, server: Arc<crate::rpc::server::RpcServer>) -> Self {
        let cb = Arc::new(crate::callbacks::RpcHostCallbacks { server });
        self.with_callbacks(cb)
    }
}

impl LLM for HostLlmProxy {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_retryable_error(&self, error: &str) -> bool {
        // Transport-level and throttling/server errors are retryable;
        // auth, request-shape, and client errors are not. This mirrors
        // NativeHttpLlm's classification so the host-proxy path doesn't
        // waste time retrying 400/401/403 errors.
        const RETRYABLE: &[&str] = &[
            "status 429",
            "status 500",
            "status 502",
            "status 503",
            "status 504",
            "status 529",
            "overloaded",
            "timed out",
            "timeout",
            "connect",
            "connection",
            "sse decode error",
            "econnreset",
            "econnrefused",
            "socket hang up",
        ];
        let lower = error.to_lowercase();
        RETRYABLE.iter().any(|s| lower.contains(s))
    }

    fn chat(&self, params: LLMChatParams) -> crate::rpc::types::BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        let system_prompt = self.system_prompt.clone();
        let model_name = self.model_name.clone();
        let callbacks = self.callbacks.clone();
        let request_id = self.request_id.clone();

        Box::pin(async move {
            let Some(callbacks) = callbacks else {
                return Err("HostLlmProxy: callbacks not set".into());
            };

            // Convert messages
            let messages: Vec<LlmChatMessage> = params
                .messages
                .iter()
                .map(|m| LlmChatMessage {
                    role: m.role.clone(),
                    content: m.content.clone(),
                    blocks: m.blocks.clone(),
                })
                .collect();

            // Convert tools
            let tools: Vec<types::ToolDef> = params
                .tools
                .iter()
                .map(|t| types::ToolDef {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    input_schema: t.input_schema.clone(),
                })
                .collect();

            let request = types::LlmChatRequest {
                system_prompt,
                model_name,
                messages,
                tools,
                request_id,
            };

            let response = callbacks.llm_chat(request).await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    Box::new(std::io::Error::other(e))
                })?;

            // Convert to turn_loop types
            let tool_calls: Vec<ToolCall> = response
                .tool_calls
                .into_iter()
                .map(|tc| ToolCall {
                    id: tc.id,
                    name: tc.name,
                    arguments: tc.arguments,
                })
                .collect();

            let usage = crate::rpc::types::TokenUsage {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
                total_tokens: response.usage.total_tokens,
                input_cache_read: response.usage.input_cache_read,
                input_cache_creation: response.usage.input_cache_creation,
            };

            Ok(LLMChatResponse {
                content: response.content,
                tool_calls,
                finish_reason: response.finish_reason,
                usage,
            })
        })
    }
}