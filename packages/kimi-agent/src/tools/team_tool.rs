//! Native execution of the Team orchestration tool (P28/P32 第四批).
//!
//! Runs a roundtable discussion or structured debate among persistent
//! subagents, mirroring `agent-core-v2`'s `teamTool.ts` semantics.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde_json::Value;

use crate::subagent::SubagentManager;
use crate::team::coordinator::{
    DebateOptions, DebateParticipantConfig, DiscussionOptions, DiscussionParticipantConfig,
    StructuredDebateCoordinator, SubagentManagerHost, TeamCoordinator, format_debate_result,
    format_discussion_result,
};
use crate::turn_loop::types::ExecutableToolResult;

/// Execute the `Team` tool natively.
pub async fn execute_team(
    subagent_manager: &Arc<SubagentManager>,
    args: &Value,
) -> ExecutableToolResult {
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("discussion");
    let topic = match args.get("topic").and_then(|v| v.as_str()) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => {
            return ExecutableToolResult {
                content: "Invalid Team arguments: `topic` is required.".into(),
                is_error: true,
                note: None,
            };
        }
    };
    let participants = match args.get("participants").and_then(|v| v.as_array()) {
        Some(arr) if !arr.is_empty() => arr,
        _ => {
            return ExecutableToolResult {
                content: "Invalid Team arguments: `participants` must be a non-empty array.".into(),
                is_error: true,
                note: None,
            };
        }
    };

    let runtime = match subagent_manager.runtime().await {
        Some(r) => r,
        None => {
            return ExecutableToolResult {
                content: "Team tool requires an injected subagent runtime (llm + callbacks); the host did not provide one.".into(),
                is_error: true,
                note: None,
            };
        }
    };

    let host = SubagentManagerHost::new(
        subagent_manager.clone(),
        runtime.llm.clone(),
        runtime.callbacks.clone(),
    );
    let cancelled = Arc::new(AtomicBool::new(false));

    match mode {
        "debate" => {
            let mut configs = Vec::new();
            for p in participants {
                let profile_name = match p.get("profile_name").and_then(|v| v.as_str()) {
                    Some(n) => n.to_string(),
                    None => {
                        return ExecutableToolResult {
                            content:
                                "Invalid Team arguments: each participant needs `profile_name`."
                                    .into(),
                            is_error: true,
                            note: None,
                        };
                    }
                };
                configs.push(DebateParticipantConfig {
                    profile_name,
                    speaker_name: p
                        .get("speaker_name")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    role_description: p
                        .get("role")
                        .or_else(|| p.get("role_description"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    assigned_stance: p.get("stance").and_then(|v| v.as_str()).map(String::from),
                });
            }
            let options = DebateOptions {
                topic,
                participants: configs,
                max_debate_rounds: args
                    .get("max_rounds")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32),
                consensus_prompt: args
                    .get("consensus_prompt")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                enable_voting: args
                    .get("enable_voting")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            };
            let mut coordinator = StructuredDebateCoordinator::new(host, None);
            let result = coordinator.debate(&options, &cancelled).await;
            ExecutableToolResult {
                content: format_debate_result(&result),
                is_error: false,
                note: Some("native_team".into()),
            }
        }
        _ => {
            let mut configs = Vec::new();
            for p in participants {
                let profile_name = match p.get("profile_name").and_then(|v| v.as_str()) {
                    Some(n) => n.to_string(),
                    None => {
                        return ExecutableToolResult {
                            content:
                                "Invalid Team arguments: each participant needs `profile_name`."
                                    .into(),
                            is_error: true,
                            note: None,
                        };
                    }
                };
                configs.push(DiscussionParticipantConfig {
                    profile_name,
                    speaker_name: p
                        .get("speaker_name")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    role_description: p
                        .get("role")
                        .or_else(|| p.get("role_description"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    turns_per_round: p
                        .get("turns_per_round")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as u32),
                });
            }
            let options = DiscussionOptions {
                topic,
                participants: configs,
                max_rounds: args
                    .get("max_rounds")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32),
                summary_prompt: args
                    .get("summary_prompt")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            };
            let mut coordinator = TeamCoordinator::new(host, None);
            let result = coordinator.discuss(&options, &cancelled).await;
            ExecutableToolResult {
                content: format_discussion_result(&result),
                is_error: false,
                note: Some("native_team".into()),
            }
        }
    }
}

/// Engine tool definition for the `Team` tool.
pub fn team_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "Team".into(),
        description: "Run a multi-agent discussion or structured debate among subagents to explore a topic, cross-review work, or reach consensus. Use discussion mode for open exploration, debate mode for adversarial positions with consensus detection.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "mode": { "type": "string", "enum": ["discussion", "debate"], "description": "discussion = roundtable, debate = structured positions" },
                "topic": { "type": "string", "description": "The topic or question to discuss" },
                "participants": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "profile_name": { "type": "string", "description": "Subagent profile (e.g. research)" },
                            "role": { "type": "string", "description": "Role description for this participant" },
                            "speaker_name": { "type": "string" },
                            "stance": { "type": "string", "description": "Debate mode: assigned stance" },
                            "turns_per_round": { "type": "integer", "description": "Discussion mode: speeches per round" }
                        },
                        "required": ["profile_name"]
                    }
                },
                "max_rounds": { "type": "integer", "description": "Max rounds before ending" },
                "summary_prompt": { "type": "string", "description": "Discussion mode: final summary prompt" },
                "consensus_prompt": { "type": "string", "description": "Debate mode: consensus prompt" },
                "enable_voting": { "type": "boolean", "description": "Debate mode: include a voting phase" }
            },
            "required": ["topic", "participants"]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_team_tool_def_shape() {
        let def = team_tool_def();
        assert_eq!(def.name, "Team");
        assert!(def.input_schema.get("required").is_some());
        assert!(def.description.contains("discussion"));
    }

    #[tokio::test]
    async fn test_team_requires_topic() {
        let manager = Arc::new(SubagentManager::new());
        let res = execute_team(&manager, &serde_json::json!({ "participants": [] })).await;
        assert!(res.is_error);
        assert!(res.content.contains("topic"));
    }

    #[tokio::test]
    async fn test_team_requires_participants() {
        let manager = Arc::new(SubagentManager::new());
        let res = execute_team(
            &manager,
            &serde_json::json!({ "topic": "hello", "participants": [] }),
        )
        .await;
        assert!(res.is_error);
        assert!(res.content.contains("participants"));
    }

    #[tokio::test]
    async fn test_team_without_runtime_reports_error() {
        let manager = Arc::new(SubagentManager::new());
        let res = execute_team(
            &manager,
            &serde_json::json!({
                "topic": "hello",
                "participants": [{ "profile_name": "research", "role": "r" }]
            }),
        )
        .await;
        assert!(res.is_error);
        assert!(res.content.contains("runtime"));
    }
}
