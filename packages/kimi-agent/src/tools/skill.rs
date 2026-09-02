//! Native execution of the Skill tool (state bridge protocol, design doc
//! milestone 7, batch 7).
//!
//! The engine reads the skill's content through `host/state_read {domain:
//! "skill", key: <skill_name>}` and renders it with the v2 Skill tool
//! output: the loaded-inline confirmation line plus the skill's
//! name/description/instructions in a `<skill-loaded>` block. The host owns
//! the skill catalog and the not-found verdict (`-32002`), which maps to the
//! v2 not-found message. The wire carries no argument string, so `args`
//! expansion is a host-side concern; the engine forwards only the skill
//! name.

use serde::Deserialize;
use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::StateReadRequest;
use crate::turn_loop::types::ExecutableToolResult;

/// v2 not-found output tail (`SkillTool.execution`).
const SKILL_NOT_FOUND_MESSAGE: &str = "not found in the current skill listing.";

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot load skills
/// for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot load skills.";

/// Wire shape of the skill domain: the host returns the skill's
/// name/description/instructions.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillWire {
    name: String,
    description: String,
    instructions: String,
}

/// Execute the Skill tool natively: `state_read` the skill domain and render
/// the v2-aligned skill content.
pub async fn execute_skill(callbacks: &dyn HostCallbacks, args: &Value) -> ExecutableToolResult {
    let name = args
        .get("skill")
        .or_else(|| args.get("name"))
        .and_then(|s| s.as_str());
    let Some(name) = name else {
        return err_result("Invalid Skill arguments: `skill` must be a string.".into());
    };
    if name.is_empty() {
        return err_result("Invalid Skill arguments: `skill` must not be empty.".into());
    }
    let skill_args = args.get("args").and_then(|a| a.as_str());
    let request = StateReadRequest {
        domain: "skill".into(),
        key: name.into(),
        turn_id: args
            .get("turn_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        tool_call_id: args
            .get("tool_call_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    };
    match callbacks.state_read(request).await {
        Ok(response) => render_skill(&response.value, skill_args),
        Err(error) => map_state_error(name, error),
    }
}

/// Render the host's skill wire value as the v2 Skill tool output: the
/// loaded-inline confirmation line followed by the skill content block.
fn render_skill(value: &Value, skill_args: Option<&str>) -> ExecutableToolResult {
    let wire: SkillWire = match serde_json::from_value(value.clone()) {
        Ok(wire) => wire,
        Err(_) => {
            return err_result(
                "Invalid skill state from host: expected { name, description, instructions }."
                    .into(),
            );
        }
    };
    let (args_attr, instructions) = match skill_args {
        Some(a) if !a.trim().is_empty() => {
            let escaped = a.replace('&', "&amp;").replace('"', "&quot;");
            (
                format!(" args=\"{}\"", escaped),
                format!("{}\n\nARGUMENTS:\n{}", wire.instructions, a),
            )
        }
        _ => (String::new(), wire.instructions),
    };
    ok_result(format!(
        "Skill \"{}\" loaded inline. Follow its instructions.\n\n<skill-loaded name=\"{}\" trigger=\"model-tool\"{}>\n{}\n\n{}\n</skill-loaded>",
        wire.name, wire.name, args_attr, wire.description, instructions
    ))
}

/// Map a state bridge error to a tool result: a missing skill (the host's
/// `-32002` unknown-key verdict) gets the v2 not-found message, an unwired
/// host (message carries the `does not support state bridge` phrase) gets
/// the dedicated failure message, and everything else passes through
/// verbatim.
fn map_state_error(name: &str, error: String) -> ExecutableToolResult {
    if error.contains("-32002") {
        err_result(format!("Skill \"{name}\" {SKILL_NOT_FOUND_MESSAGE}"))
    } else if error.contains("does not support state bridge") {
        err_result(STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE.into())
    } else {
        err_result(error)
    }
}

/// Engine tool definition for Skill, so the model can discover and call it
/// (used by the standalone REPL and native tool listing). The description
/// mirrors v2 `skill.md`; the schema mirrors `SkillToolInputSchema`.
///
/// Caveat on the `args` text: it promises whitespace tokenization and
/// placeholder expansion (`$NAME`, `$1`, `$ARGUMENTS`). Expansion lives on
/// the host (`features/skill/catalog/registry.ts` `expandSkillParameters`);
/// this crate's [`render_skill`] only appends a trailing `ARGUMENTS:` line.
/// On the napi path the host supplies the tool definition, so this text
/// reaches the model — with the engine's weaker behavior behind it — only
/// through the standalone REPL / native tool listing.
pub fn skill_tool_def() -> crate::turn_loop::types::ToolInfo {
    crate::turn_loop::types::ToolInfo {
        name: "Skill".into(),
        description: "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a `<skill-loaded>` block for it with the same `args` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier `args` and will not reflect new inputs.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "skill": {
                    "type": "string",
                    "description": "The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. \"commit\", \"pdf\")."
                },
                "args": {
                    "type": "string",
                    "description": "Optional argument string for the skill, written like a command line (e.g. `-m \"fix bug\"`, `123`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing `ARGUMENTS:` line. Omit it only when there is nothing to pass."
                }
            },
            "required": ["skill"],
            "additionalProperties": false
        }),
    }
}

fn ok_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: false,
        note: None,
    }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        content,
        is_error: true,
        note: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{
        BoxFuture, PermissionDecision, StateReadRequest, StateReadResponse, StateWriteRequest,
        StateWriteResponse,
    };
    use std::sync::Arc;

    /// Scripted callbacks: records the received state requests and answers
    /// with canned responses.
    struct ScriptedCallbacks {
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
        read_received: Arc<std::sync::Mutex<Option<StateReadRequest>>>,
    }

    impl HostCallbacks for ScriptedCallbacks {
        fn llm_chat(
            &self,
            _: crate::rpc::types::LlmChatRequest,
        ) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn execute_tool(
            &self,
            _: crate::rpc::types::ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<crate::rpc::types::ToolExecuteResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }

        fn check_permission(
            &self,
            _: crate::rpc::types::PermissionCheckRequest,
        ) -> BoxFuture<'static, Result<PermissionDecision, String>> {
            Box::pin(async { Ok(PermissionDecision::allow()) })
        }

        fn state_read(
            &self,
            request: StateReadRequest,
        ) -> BoxFuture<'static, Result<StateReadResponse, String>> {
            *self.read_received.lock().unwrap() = Some(request);
            let response = self.read_response.clone();
            Box::pin(async move { response })
        }

        fn state_write(
            &self,
            _: StateWriteRequest,
        ) -> BoxFuture<'static, Result<StateWriteResponse, String>> {
            let response = self.write_response.clone();
            Box::pin(async move { response })
        }
    }

    fn scripted(
        read_response: Result<StateReadResponse, String>,
    ) -> (
        ScriptedCallbacks,
        Arc<std::sync::Mutex<Option<StateReadRequest>>>,
    ) {
        let read_received = Arc::new(std::sync::Mutex::new(None));
        (
            ScriptedCallbacks {
                read_response,
                write_response: Ok(StateWriteResponse {
                    ok: true,
                    value: Value::Null,
                }),
                read_received: read_received.clone(),
            },
            read_received,
        )
    }

    fn read_ok(value: Value) -> Result<StateReadResponse, String> {
        Ok(StateReadResponse { value })
    }

    fn sample_skill() -> Value {
        serde_json::json!({
            "name": "commit",
            "description": "Write conventional commit messages.",
            "instructions": "1. Stage the files.\n2. Write the message."
        })
    }

    #[tokio::test]
    async fn test_renders_skill_content() {
        let (callbacks, read_received) = scripted(read_ok(sample_skill()));
        let result = execute_skill(&callbacks, &serde_json::json!({ "skill": "commit" })).await;
        assert!(!result.is_error);
        assert_eq!(
            result.content,
            "Skill \"commit\" loaded inline. Follow its instructions.\n\n<skill-loaded name=\"commit\" trigger=\"model-tool\">\nWrite conventional commit messages.\n\n1. Stage the files.\n2. Write the message.\n</skill-loaded>"
        );
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "skill");
        assert_eq!(request.key, "commit");
        assert_eq!(request.turn_id, "");
        assert_eq!(request.tool_call_id, "");
    }

    #[tokio::test]
    async fn test_not_found_maps_to_v2_message() {
        let (callbacks, _) = scripted(Err(
            "State read error: [-32002] unknown skill: commit".into()
        ));
        let result = execute_skill(&callbacks, &serde_json::json!({ "skill": "commit" })).await;
        assert!(result.is_error);
        assert_eq!(
            result.content,
            "Skill \"commit\" not found in the current skill listing."
        );
    }

    #[tokio::test]
    async fn test_unsupported_host_returns_failure_message() {
        let (callbacks, _) = scripted(Err("host does not support state bridge".into()));
        let result = execute_skill(&callbacks, &serde_json::json!({ "skill": "commit" })).await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_other_host_error_passes_through() {
        let (callbacks, _) = scripted(Err(
            "State read error: [-32001] unknown domain: skill".into()
        ));
        let result = execute_skill(&callbacks, &serde_json::json!({ "skill": "commit" })).await;
        assert!(result.is_error);
        assert!(result.content.contains("-32001"));
        assert!(result.content.contains("unknown domain"));
    }

    #[tokio::test]
    async fn test_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received) = scripted(read_ok(sample_skill()));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "skill": "" }),
            serde_json::json!({ "skill": 42 }),
        ] {
            let result = execute_skill(&callbacks, &bad).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid Skill arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_invalid_wire_shape_returns_error() {
        let (callbacks, _) = scripted(read_ok(serde_json::json!({ "name": "commit" })));
        let result = execute_skill(&callbacks, &serde_json::json!({ "skill": "commit" })).await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid skill state from host"));
    }

    #[tokio::test]
    async fn test_turn_and_tool_call_ids_are_forwarded() {
        let (callbacks, read_received) = scripted(read_ok(sample_skill()));
        let result = execute_skill(
            &callbacks,
            &serde_json::json!({
                "skill": "commit",
                "turn_id": "turn-42",
                "tool_call_id": "call_abc"
            }),
        )
        .await;
        assert!(!result.is_error);
        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.turn_id, "turn-42");
        assert_eq!(request.tool_call_id, "call_abc");
    }

    #[test]
    fn test_tool_def_matches_v2_schema() {
        let def = skill_tool_def();
        assert_eq!(def.name, "Skill");
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["additionalProperties"], false);
        assert_eq!(def.input_schema["required"][0], "skill");
        assert!(def.input_schema["properties"]["skill"].is_object());
        assert!(def.input_schema["properties"]["args"].is_object());
        assert!(def.description.contains("BLOCKING REQUIREMENT"));
        assert!(def.description.contains("<skill-loaded>"));
    }

    #[tokio::test]
    async fn test_renders_skill_with_args_expansion() {
        let (callbacks, _) = scripted(read_ok(sample_skill()));
        let result = execute_skill(
            &callbacks,
            &serde_json::json!({
                "skill": "commit",
                "args": "-m \"feat: new feature\""
            }),
        )
        .await;
        assert!(!result.is_error);
        assert!(result.content.contains("args=\"-m &quot;feat: new feature&quot;\""));
        assert!(result.content.contains("ARGUMENTS:\n-m \"feat: new feature\""));
    }

    #[tokio::test]
    async fn test_name_field_fallback() {
        let (callbacks, read_received) = scripted(read_ok(sample_skill()));
        let result = execute_skill(&callbacks, &serde_json::json!({ "name": "commit" })).await;
        assert!(!result.is_error);
        assert_eq!(read_received.lock().unwrap().clone().unwrap().key, "commit");
    }
}
