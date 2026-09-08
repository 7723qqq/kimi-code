//! Native BTW (Side-channel question) feature.
//!
//! Mirrors `features/btw/` from upstream `agent-core-v2`:
//! - Forks main conversation history snapshot.
//! - Injects the side-channel system reminder.
//! - Prohibits all tool execution on the side channel with `TOOL_CALL_DISABLED_MESSAGE`.

use std::sync::Arc;

use crate::subagent::manager::SubagentManager;
use crate::subagent::types::SubagentDefinition;
use crate::turn_loop::types::{ExecutableToolResult, LLMMessage};

pub const TOOL_CALL_DISABLED_MESSAGE: &str =
    "Tool calls are disabled for side questions. Answer with text only.";

pub const SIDE_QUESTION_SYSTEM_REMINDER: &str = "\
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.";

/// Start a new side-channel conversation instance, forked from the caller's history.
///
/// Mirrors `SessionBtwService::start` from upstream `agent-core-v2/src/features/btw/btwService.ts`.
pub async fn start_btw(
    manager: &Arc<SubagentManager>,
    history: &[LLMMessage],
) -> Result<String, String> {
    let agent_id = format!("agent-btw-{}", fastrand::u64(..));

    // Register btw definition if not yet present
    manager
        .register_definition(SubagentDefinition {
            name: "btw".into(),
            description: "Side-channel conversation without tool capabilities".into(),
            system_prompt: SIDE_QUESTION_SYSTEM_REMINDER.into(),
            tools: Vec::new(),
            disallowed_tools: vec!["*".into()],
            prompt_prefix: None,
            summary_policy: None,
            model: None,
        })
        .await;

    manager
        .spawn_with_id(&agent_id, "btw", "side-channel")
        .await?;

    // Prepare forked history with closed unclosed tool calls and appended side reminder
    let mut initial_messages = crate::subagent::close_trailing_open_tool_exchange(history);
    initial_messages.push(crate::injection::injection_message(SIDE_QUESTION_SYSTEM_REMINDER.to_string()));

    // Seed the conversation history so resume / foreground turn picks it up
    manager.set_foreground_history(&agent_id, "btw", "side-channel", initial_messages);

    Ok(agent_id)
}

/// Check whether the current caller is a BTW side-channel instance,
/// and if so, return the standard tool call denial result.
pub fn check_btw_tool_denial(caller_agent_id: Option<&str>) -> Option<ExecutableToolResult> {
    if let Some(caller) = caller_agent_id
        && (caller.starts_with("agent-btw-") || caller == "btw")
    {
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: TOOL_CALL_DISABLED_MESSAGE.into(),
            is_error: true,
            note: None,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_start_btw_creates_instance_and_seeds_history() {
        let manager = Arc::new(SubagentManager::new());
        let history = vec![
            LLMMessage::new("user", "how does auth work?"),
            LLMMessage::new("assistant", "it uses bearer tokens"),
        ];

        let agent_id = start_btw(&manager, &history).await.unwrap();
        assert!(agent_id.starts_with("agent-btw-"));

        let seeded = manager.get_foreground_history(&agent_id).unwrap();
        assert_eq!(seeded.len(), 3);
        assert_eq!(seeded[0].content, "how does auth work?");
        assert_eq!(seeded[1].content, "it uses bearer tokens");
        assert!(seeded[2].content.contains("This is a side-channel conversation"));
    }

    #[test]
    fn test_check_btw_tool_denial() {
        assert!(check_btw_tool_denial(Some("main")).is_none());
        assert!(check_btw_tool_denial(Some("subagent-1")).is_none());

        let denied = check_btw_tool_denial(Some("agent-btw-12345")).unwrap();
        assert!(denied.is_error);
        assert_eq!(denied.content, TOOL_CALL_DISABLED_MESSAGE);

        let denied_raw = check_btw_tool_denial(Some("btw")).unwrap();
        assert!(denied_raw.is_error);
        assert_eq!(denied_raw.content, TOOL_CALL_DISABLED_MESSAGE);
    }

    #[tokio::test]
    async fn test_start_btw_closes_unanswered_tool_call_and_appends_reminder() {
        let manager = Arc::new(SubagentManager::new());
        let in_flight_call = crate::turn_loop::types::ToolCall {
            id: "call-read-pending".into(),
            name: "Read".into(),
            arguments: serde_json::json!({ "path": "test.txt" }),
        };
        let history = vec![
            LLMMessage::new("user", "check the config"),
            LLMMessage {
                role: "assistant".into(),
                content: "reading now".into(),
                blocks: Vec::new(),
                tool_calls: vec![in_flight_call],
                tool_call_id: None,
            },
        ];

        let agent_id = start_btw(&manager, &history).await.unwrap();
        let seeded = manager.get_foreground_history(&agent_id).unwrap();
        assert_eq!(seeded.len(), 4, "Must close in-flight tool call and append side reminder");

        assert_eq!(seeded[0].role, "user");
        assert_eq!(seeded[0].content, "check the config");

        assert_eq!(seeded[1].role, "assistant");
        assert_eq!(seeded[1].content, "reading now");

        assert_eq!(seeded[2].role, "tool");
        assert_eq!(seeded[2].tool_call_id.as_deref(), Some("call-read-pending"));
        assert_eq!(seeded[2].content, crate::subagent::INHERITED_IN_FLIGHT_TOOL_OUTPUT);

        assert_eq!(seeded[3].role, "user");
        assert!(seeded[3].content.contains("This is a side-channel conversation with the user"));
        assert!(seeded[3].content.contains("Do not call any tools"));
    }

    #[tokio::test]
    async fn test_native_toolset_rejects_all_tools_for_btw_caller() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().to_string_lossy().to_string();

        let toolset = crate::tools::NativeToolset::new(&workspace, None)
            .unwrap()
            .with_caller_agent_id("agent-btw-99999");

        let tools_to_test = [
            ("Read", serde_json::json!({ "path": "any.txt" })),
            ("Write", serde_json::json!({ "path": "any.txt", "content": "hi" })),
            ("Edit", serde_json::json!({ "path": "any.txt", "old_string": "a", "new_string": "b" })),
            ("Bash", serde_json::json!({ "command": "echo hi" })),
            ("Grep", serde_json::json!({ "pattern": "test" })),
            ("Glob", serde_json::json!({ "pattern": "*.rs" })),
            ("FetchURL", serde_json::json!({ "url": "https://example.com" })),
        ];

        for (name, args) in tools_to_test {
            let res = toolset
                .execute_tool_streaming(None, name, &args, None)
                .await;
            assert!(res.is_some(), "Tool {name} should be handled and intercepted");
            let outcome = res.unwrap();
            assert!(
                outcome.is_error,
                "Tool {name} must be rejected as an error for BTW caller"
            );
            assert_eq!(
                outcome.content,
                TOOL_CALL_DISABLED_MESSAGE,
                "Tool {name} must produce exact TOOL_CALL_DISABLED_MESSAGE rejection"
            );
        }
    }
}
