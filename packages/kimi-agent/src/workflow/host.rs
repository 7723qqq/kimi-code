//! `WorkflowHost` backed by the engine's [`SubagentManager`].
//!
//! The workflow runtime's `agent()` primitive becomes a real foreground
//! subagent run; `search()` stays empty until a web-search provider is wired.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::subagent::manager::{ForegroundTurnOutcome, SubagentManager, final_assistant_summary};

use super::runtime::{SearchHit, WorkflowAgentOpts, WorkflowHost};

pub type SearchProvider = dyn Fn(String, usize) -> Vec<SearchHit> + Send + Sync;

pub struct SubagentWorkflowHost {
    manager: Arc<SubagentManager>,
    workspace_root: PathBuf,
    home: Option<PathBuf>,
    search: Option<Arc<SearchProvider>>,
}

impl SubagentWorkflowHost {
    pub fn new(
        manager: Arc<SubagentManager>,
        workspace_root: PathBuf,
        home: Option<PathBuf>,
    ) -> Self {
        Self {
            manager,
            workspace_root,
            home,
            search: None,
        }
    }

    /// Attach a synchronous web-search provider (`agent()`-grade results).
    pub fn with_search(mut self, search: Arc<SearchProvider>) -> Self {
        self.search = Some(search);
        self
    }
}

#[async_trait]
impl WorkflowHost for SubagentWorkflowHost {
    async fn spawn_agent(&self, prompt: String, opts: WorkflowAgentOpts) -> Option<Value> {
        let profile = opts
            .agent_type
            .clone()
            .unwrap_or_else(|| "coder".to_string());
        let agent_id = self.manager.spawn(&profile, &prompt).await.ok()?;

        // v2 `spawnAgent`: a schema appends a strict JSON-output instruction.
        let full_prompt = match opts.schema.as_ref() {
            Some(schema) => format!(
                "{prompt}\n\nYou MUST respond with a JSON object matching this schema:\n{}\n\nReturn ONLY the JSON object, no markdown fences, no explanation.",
                serde_json::to_string_pretty(schema).unwrap_or_default()
            ),
            None => prompt,
        };

        let run =
            self.manager
                .run_foreground_turn_with_history(&agent_id, &full_prompt, None, None);
        let outcome = match opts.timeout_ms.filter(|ms| *ms > 0) {
            Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), run).await {
                Ok(result) => result,
                Err(_) => {
                    let _ = self.manager.kill(&agent_id).await;
                    return None;
                }
            },
            None => run.await,
        };

        let result = match outcome {
            Ok(ForegroundTurnOutcome::Completed(turn)) => {
                let summary = final_assistant_summary(&turn.messages);
                if opts.schema.is_some() {
                    parse_json_result(&summary)
                } else {
                    Some(Value::String(summary))
                }
            }
            _ => None,
        };
        let _ = self.manager.kill(&agent_id).await;
        result
    }

    async fn search(&self, query: String, count: usize) -> Vec<SearchHit> {
        match &self.search {
            Some(provider) => provider(query, count),
            None => Vec::new(),
        }
    }

    fn workspace_root(&self) -> PathBuf {
        self.workspace_root.clone()
    }

    fn home_dir(&self) -> Option<PathBuf> {
        self.home.clone()
    }
}

/// Parse a subagent summary as JSON: direct, then a fenced block, then the
/// first `{...}` span. Ported from v2 `parseJsonResult`.
fn parse_json_result(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }
    if let Some(start) = text.find("```") {
        let rest = &text[start + 3..];
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        if let Some(end) = rest.find("```")
            && let Ok(value) = serde_json::from_str::<Value>(rest[..end].trim())
        {
            return Some(value);
        }
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start
        && let Ok(value) = serde_json::from_str::<Value>(&text[start..=end])
    {
        return Some(value);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_from_plain_fenced_and_embedded_text() {
        assert_eq!(
            parse_json_result(r#"{"a":1}"#),
            Some(serde_json::json!({ "a": 1 }))
        );
        assert_eq!(
            parse_json_result("here:\n```json\n{\"b\":2}\n```\ndone"),
            Some(serde_json::json!({ "b": 2 }))
        );
        assert_eq!(
            parse_json_result("prefix {\"c\":3} suffix"),
            Some(serde_json::json!({ "c": 3 }))
        );
        assert_eq!(parse_json_result("no json here"), None);
    }
}
