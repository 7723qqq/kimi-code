//! MultiLLM — concurrent execution across multiple LLM providers.
//!
//! Sends the same prompt to all registered providers concurrently and
//! returns the first successful response ("first past the post").
//! Failed providers are recorded but don't block the overall result.

use crate::callbacks::HostCallbacks;
use crate::llm::proxy::HostLlmProxy;
use crate::turn_loop::types::*;
use futures_util::future::select_all;
use std::collections::HashMap;
use std::sync::Arc;

/// A single LLM provider configuration for MultiLLM.
pub struct LlmProvider {
    pub name: String,
    pub system_prompt: String,
    pub model: String,
    pub callbacks: Arc<dyn HostCallbacks>,
}

impl LlmProvider {
    pub fn to_llm(&self) -> HostLlmProxy {
        HostLlmProxy::new(self.system_prompt.clone(), self.model.clone())
            .with_callbacks(self.callbacks.clone())
    }

    /// Build a proxy whose request the host can abort, for the multi-provider
    /// race where this call may lose.
    pub fn to_llm_with_request_id(&self, request_id: String) -> HostLlmProxy {
        self.to_llm().with_request_id(request_id)
    }
}

/// Monotonic suffix keeping racing request ids unique within the process.
static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Result from a single provider in the race.
#[derive(Debug)]
pub struct ProviderResult {
    pub provider_name: String,
    pub result: Result<LLMChatResponse, String>,
    pub elapsed_ms: u64,
}

/// MultiLLM — runs multiple providers concurrently.
///
/// Usage:
/// ```rust,ignore
/// let multi = MultiLLM::new(providers);
/// let winner = multi.first_past_the_post(params).await;
/// ```
pub struct MultiLLM {
    providers: Vec<LlmProvider>,
    label: String,
}

impl MultiLLM {
    pub fn new(providers: Vec<LlmProvider>) -> Self {
        let label = if providers.len() <= 1 {
            providers
                .first()
                .map(|p| p.model.clone())
                .unwrap_or_default()
        } else {
            format!("{} + {} others", providers[0].model, providers.len() - 1)
        };
        Self { providers, label }
    }

    pub fn provider_count(&self) -> usize {
        self.providers.len()
    }

    /// Run all providers concurrently and return the first SUCCESSFUL response
    /// as soon as it completes ("first past the post"), aborting the losers.
    ///
    /// A provider that finishes first with an error does not win: its error is
    /// recorded and the race continues with the rest. If every provider fails,
    /// all errors are returned joined together.
    pub async fn first_past_the_post(
        &self,
        params: LLMChatParams,
    ) -> Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>> {
        if self.providers.is_empty() {
            return Err("No LLM providers configured".into());
        }
        if self.providers.len() == 1 {
            let llm = self.providers[0].to_llm();
            return llm.chat(params).await;
        }

        // Spawn each provider as a tokio task. Every racer carries its own
        // request id so the losers can be cancelled at the host — aborting the
        // task only drops the receiver and leaves the provider call running.
        let mut handles = Vec::with_capacity(self.providers.len());
        let mut cancellers: HashMap<String, Arc<dyn HostCallbacks>> = HashMap::new();
        for provider in &self.providers {
            let params = params.clone();
            let request_id = format!(
                "llm-{}-{}",
                provider.name,
                NEXT_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let llm = provider.to_llm_with_request_id(request_id.clone());
            let name = provider.name.clone();
            cancellers.insert(request_id.clone(), provider.callbacks.clone());

            handles.push(tokio::spawn(async move {
                let start = std::time::Instant::now();
                let result = llm.chat(params).await;
                let elapsed = start.elapsed().as_millis() as u64;
                (
                    request_id,
                    ProviderResult {
                        provider_name: name,
                        result: result.map_err(|e| e.to_string()),
                        elapsed_ms: elapsed,
                    },
                )
            }));
        }

        race_first_success(handles, &cancellers).await
    }

    /// Run all providers and return ALL results (for comparison/debugging).
    pub async fn all_results(&self, params: LLMChatParams) -> Vec<ProviderResult> {
        if self.providers.is_empty() {
            return vec![];
        }

        let mut handles = Vec::with_capacity(self.providers.len());
        for provider in &self.providers {
            let params = params.clone();
            let llm = provider.to_llm();
            let name = provider.name.clone();

            handles.push(tokio::spawn(async move {
                let start = std::time::Instant::now();
                let result = llm.chat(params).await;
                let elapsed = start.elapsed().as_millis() as u64;
                ProviderResult {
                    provider_name: name,
                    result: result.map_err(|e| e.to_string()),
                    elapsed_ms: elapsed,
                }
            }));
        }

        let mut results = Vec::with_capacity(handles.len());
        for handle in handles {
            if let Ok(r) = handle.await {
                results.push(r);
            }
        }
        results
    }
}

/// Await the first task to COMPLETE (by completion order, not spawn order);
/// return the first successful response and abort the remaining tasks. Errors
/// from providers that finish first with a failure are collected and only
/// surfaced if every provider fails. Assumes `handles` is non-empty.
///
/// Losers are cancelled at the host as well as aborted locally: the host has
/// already issued the provider call, and dropping the receiver alone would let
/// it run to completion and bill for work nobody will read.
async fn race_first_success(
    mut handles: Vec<tokio::task::JoinHandle<(String, ProviderResult)>>,
    cancellers: &HashMap<String, Arc<dyn HostCallbacks>>,
) -> Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>> {
    let mut errors: Vec<String> = Vec::new();
    while !handles.is_empty() {
        let (joined, _index, rest) = select_all(handles).await;
        handles = rest;
        match joined {
            Ok((winner_id, pr)) => match pr.result {
                Ok(response) => {
                    eprintln!("MultiLLM: {} won ({}ms)", pr.provider_name, pr.elapsed_ms);
                    for handle in &handles {
                        handle.abort();
                    }
                    for (id, callbacks) in cancellers {
                        if id != &winner_id {
                            callbacks.cancel_llm_chat(id);
                        }
                    }
                    return Ok(response);
                }
                Err(e) => errors.push(format!("{}: {e}", pr.provider_name)),
            },
            Err(e) => errors.push(format!("join error: {e}")),
        }
    }
    Err(errors.join("; ").into())
}

impl LLM for MultiLLM {
    fn system_prompt(&self) -> &str {
        self.providers
            .first()
            .map(|p| p.system_prompt.as_str())
            .unwrap_or("")
    }

    fn model_name(&self) -> &str {
        &self.label
    }

    fn is_retryable_error(&self, error: &str) -> bool {
        self.providers
            .first()
            .map(|p| p.to_llm().is_retryable_error(error))
            .unwrap_or(false)
    }

    fn chat(
        &self,
        params: LLMChatParams,
    ) -> crate::rpc::types::BoxFuture<
        '_,
        Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>,
    > {
        Box::pin(async move { self.first_past_the_post(params).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::TokenUsage;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A mock LLM with configurable delay and success/failure.
    struct MockTestLlm {
        name: String,
        delay_ms: u64,
        should_fail: bool,
        call_count: Arc<AtomicU32>,
    }

    impl MockTestLlm {
        fn new(name: &str, delay_ms: u64, should_fail: bool) -> Self {
            Self {
                name: name.to_string(),
                delay_ms,
                should_fail,
                call_count: Arc::new(AtomicU32::new(0)),
            }
        }
    }

    impl LLM for MockTestLlm {
        fn system_prompt(&self) -> &str {
            "mock"
        }
        fn model_name(&self) -> &str {
            &self.name
        }
        fn is_retryable_error(&self, _: &str) -> bool {
            false
        }

        fn chat(
            &self,
            _params: LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<
            '_,
            Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>,
        > {
            let delay = self.delay_ms;
            let fail = self.should_fail;
            let name = self.name.clone();
            let cc = self.call_count.clone();

            Box::pin(async move {
                cc.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                if fail {
                    Err(format!("{name} failed").into())
                } else {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: vec![],
                        finish_reason: Some(name),
                        usage: TokenUsage {
                            input_tokens: 10,
                            output_tokens: 5,
                            total_tokens: 15,
                            ..Default::default()
                        },
                    })
                }
            })
        }
    }

    #[tokio::test]
    async fn test_mock_llm_ok() {
        let mock = MockTestLlm::new("fast", 5, false);
        let params = LLMChatParams {
            messages: vec![],
            tools: vec![],
        };
        let result = mock.chat(params).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().finish_reason.unwrap(), "fast");
    }

    #[tokio::test]
    async fn test_mock_llm_fail() {
        let mock = MockTestLlm::new("failing", 5, true);
        let params = LLMChatParams {
            messages: vec![],
            tools: vec![],
        };
        let result = mock.chat(params).await;
        assert!(result.is_err());
    }

    fn mk_response(tag: &str) -> LLMChatResponse {
        LLMChatResponse {
            content: String::new(),
            tool_calls: vec![],
            finish_reason: Some(tag.to_string()),
            usage: TokenUsage {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn test_race_returns_fastest_success() {
        // A slow success spawned FIRST must not beat a fast success spawned
        // second: the race resolves on completion order, not spawn order.
        let slow = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            (
                "slow-id".to_string(),
                ProviderResult {
                    provider_name: "slow".into(),
                    result: Ok(mk_response("slow")),
                    elapsed_ms: 80,
                },
            )
        });
        let fast = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            (
                "fast-id".to_string(),
                ProviderResult {
                    provider_name: "fast".into(),
                    result: Ok(mk_response("fast")),
                    elapsed_ms: 5,
                },
            )
        });
        let winner = race_first_success(vec![slow, fast], &HashMap::new())
            .await
            .unwrap();
        assert_eq!(winner.finish_reason.as_deref(), Some("fast"));
    }

    #[tokio::test]
    async fn test_race_prefers_success_over_fast_failure() {
        // A fast failure must not win: its error is recorded and the slower
        // success is returned instead.
        let fast_fail = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            (
                "failer-id".to_string(),
                ProviderResult {
                    provider_name: "failer".into(),
                    result: Err("boom".into()),
                    elapsed_ms: 5,
                },
            )
        });
        let slow_ok = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            (
                "ok-id".to_string(),
                ProviderResult {
                    provider_name: "ok".into(),
                    result: Ok(mk_response("ok")),
                    elapsed_ms: 30,
                },
            )
        });
        let winner = race_first_success(vec![fast_fail, slow_ok], &HashMap::new())
            .await
            .unwrap();
        assert_eq!(winner.finish_reason.as_deref(), Some("ok"));
    }

    /// Host callbacks that record which request ids the engine asked the host
    /// to drop, and serve a deliberately slow "slow" model so the race has a
    /// predictable winner.
    struct CancellationSpy {
        cancelled: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl CancellationSpy {
        fn new() -> (Arc<CancellationSpy>, Arc<std::sync::Mutex<Vec<String>>>) {
            let log = Arc::new(std::sync::Mutex::new(Vec::new()));
            (
                Arc::new(Self {
                    cancelled: log.clone(),
                }),
                log,
            )
        }
    }

    impl HostCallbacks for CancellationSpy {
        fn llm_chat(
            &self,
            request: crate::rpc::types::LlmChatRequest,
        ) -> crate::rpc::types::BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>>
        {
            let slow = request.model_name == "slow";
            let request_id = request.request_id.clone();
            Box::pin(async move {
                if slow {
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                }
                Ok(crate::rpc::types::LlmChatResponse {
                    content: request_id.unwrap_or_default(),
                    tool_calls: vec![],
                    finish_reason: Some(if slow { "slow" } else { "fast" }.to_string()),
                    usage: crate::rpc::types::TokenUsage::default(),
                })
            })
        }

        fn execute_tool(
            &self,
            _request: crate::rpc::types::ToolExecuteRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::ToolExecuteResponse, String>,
        > {
            Box::pin(async { Err("not used by this test".into()) })
        }

        fn check_permission(
            &self,
            _request: crate::rpc::types::PermissionCheckRequest,
        ) -> crate::rpc::types::BoxFuture<
            'static,
            Result<crate::rpc::types::PermissionDecision, String>,
        > {
            Box::pin(async { Err("not used by this test".into()) })
        }

        fn cancel_llm_chat(&self, request_id: &str) {
            self.cancelled.lock().unwrap().push(request_id.to_string());
        }
    }

    /// The loser's provider request must be cancelled at the host, not just
    /// aborted locally — otherwise it runs to completion and bills for work
    /// nobody will read.
    #[tokio::test]
    async fn test_losing_providers_are_cancelled_at_the_host() {
        let (slow_spy, slow_log) = CancellationSpy::new();
        let (fast_spy, fast_log) = CancellationSpy::new();
        let slow_callbacks: Arc<dyn HostCallbacks> = slow_spy;
        let fast_callbacks: Arc<dyn HostCallbacks> = fast_spy;
        let multi = MultiLLM::new(vec![
            LlmProvider {
                name: "slow".into(),
                system_prompt: String::new(),
                model: "slow".into(),
                callbacks: slow_callbacks.clone(),
            },
            LlmProvider {
                name: "fast".into(),
                system_prompt: String::new(),
                model: "fast".into(),
                callbacks: fast_callbacks.clone(),
            },
        ]);

        let winner = multi
            .first_past_the_post(LLMChatParams {
                messages: vec![],
                tools: vec![],
            })
            .await
            .unwrap();
        assert_eq!(winner.finish_reason.as_deref(), Some("fast"));

        // The loser is cancelled; the winner is not.
        let cancelled = slow_log.lock().unwrap();
        assert_eq!(
            cancelled.len(),
            1,
            "the losing provider must be cancelled once"
        );
        assert!(
            cancelled[0].contains("slow"),
            "unexpected id: {}",
            cancelled[0]
        );
        drop(cancelled);

        assert!(
            fast_log.lock().unwrap().is_empty(),
            "the winning provider must not be cancelled"
        );
    }

    #[tokio::test]
    async fn test_race_all_fail_reports_every_error() {
        let f1 = tokio::spawn(async {
            (
                "f1-id".to_string(),
                ProviderResult {
                    provider_name: "f1".into(),
                    result: Err("e1".into()),
                    elapsed_ms: 1,
                },
            )
        });
        let f2 = tokio::spawn(async {
            (
                "f2-id".to_string(),
                ProviderResult {
                    provider_name: "f2".into(),
                    result: Err("e2".into()),
                    elapsed_ms: 1,
                },
            )
        });
        let err = race_first_success(vec![f1, f2], &HashMap::new())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("f1: e1"), "missing f1 error: {err}");
        assert!(err.contains("f2: e2"), "missing f2 error: {err}");
    }

    #[tokio::test]
    async fn test_call_count() {
        let p1 = MockTestLlm::new("p1", 10, false);
        let p2 = MockTestLlm::new("p2", 10, false);

        let params = LLMChatParams {
            messages: vec![],
            tools: vec![],
        };

        let (r1, r2) = tokio::join!(p1.chat(params.clone()), p2.chat(params));
        assert!(r1.is_ok());
        assert!(r2.is_ok());
    }

    #[test]
    fn test_label_logic() {
        let label = if 2 <= 1 {
            "single".to_string()
        } else {
            format!("{} + {} others", "a", 2 - 1)
        };
        assert_eq!(label, "a + 1 others");

        let label = if 1 <= 1 {
            "single".to_string()
        } else {
            String::new()
        };
        assert_eq!(label, "single");
    }
}
