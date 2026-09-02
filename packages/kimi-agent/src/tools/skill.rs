//! Native execution of the Skill tool (state bridge protocol, design doc
//! milestone 7, batch 7).
//!
//! The engine reads the skill's content through `host/state_read {domain:
//! "skill", key: <skill_name>}` and renders it with the v2 Skill tool
//! output: the loaded-inline confirmation line plus the skill's
//! name/description/instructions in a `<skill-loaded>` block.
//!
//! P82: Full arguments tokenization, parameter placeholders ($NAME, $1,
//! $ARGUMENTS, $ARGUMENTS[index]), context placeholders (${KIMI_SKILL_DIR},
//! ${KIMI_SESSION_ID}), plugin instructions prefixing, and disableModelInvocation
//! / inline-skill type gates.

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
/// name/description/instructions, plus optional metadata for expansion and gating.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillWire {
    name: String,
    description: String,
    instructions: String,
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    disable_model_invocation: Option<bool>,
    #[serde(default)]
    skill_type: Option<String>,
    #[serde(default)]
    arguments: Option<SkillArgumentsWire>,
    #[serde(default)]
    argument_names: Option<Vec<String>>,
    #[serde(default)]
    plugin: Option<SkillPluginWire>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SkillArgumentsWire {
    String(String),
    List(Vec<String>),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillPluginWire {
    id: String,
    #[serde(default)]
    instructions: Option<String>,
}

/// Tokenize command-line style argument string: splits on whitespace,
/// respecting single and double quotes.
pub fn tokenize_args(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut has_content = false;

    for c in raw.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                current.push(c);
                has_content = true;
            }
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            has_content = true;
            continue;
        }
        if c.is_whitespace() {
            if has_content {
                out.push(current);
                current = String::new();
                has_content = false;
            }
            continue;
        }
        current.push(c);
        has_content = true;
    }

    if has_content {
        out.push(current);
    }
    out
}

/// Escape XML tags `<` and `>` (matches v2 `escapeXmlTags`).
pub fn escape_xml_tags(input: &str) -> String {
    input.replace('<', "&lt;").replace('>', "&gt;")
}

/// Escape XML attributes `&` and `"` (matches v2 `escapeXmlAttr`).
pub fn escape_xml_attr(input: &str) -> String {
    input.replace('&', "&amp;").replace('"', "&quot;")
}

/// Replace named placeholders `$name` where not followed by `\w` or `[`.
fn replace_named_placeholder(content: &str, name: &str, replacement: &str) -> String {
    let target = format!("${name}");
    let mut result = String::with_capacity(content.len());
    let mut rest = content;

    while let Some(pos) = rest.find(&target) {
        result.push_str(&rest[..pos]);
        let after_pos = pos + target.len();
        let next_char = rest[after_pos..].chars().next();
        let is_word_or_bracket =
            next_char.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '[');

        if is_word_or_bracket {
            result.push_str(&target);
        } else {
            result.push_str(replacement);
        }
        rest = &rest[after_pos..];
    }
    result.push_str(rest);
    result
}

/// Replace positional placeholders `$0`, `$1`, ... where not followed by `\w`.
fn replace_positional_placeholders(content: &str, tokens: &[String]) -> String {
    let mut result = String::with_capacity(content.len());
    let mut rest = content;

    while let Some(pos) = rest.find('$') {
        result.push_str(&rest[..pos]);
        let after_dollar = &rest[pos + 1..];
        let digit_count = after_dollar
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .count();

        if digit_count > 0 {
            let digits = &after_dollar[..digit_count];
            let after_digits = &after_dollar[digit_count..];
            let next_char = after_digits.chars().next();
            let is_word = next_char.is_some_and(|c| c.is_alphanumeric() || c == '_');

            if !is_word && let Ok(index) = digits.parse::<usize>() {
                let val = tokens.get(index).map(|s| s.as_str()).unwrap_or("");
                result.push_str(&escape_xml_tags(val));
                rest = after_digits;
                continue;
            }
        }

        result.push('$');
        rest = after_dollar;
    }
    result.push_str(rest);
    result
}

/// Expand parameters into skill content (matches v2 `expandSkillParameters`).
pub fn expand_skill_parameters(
    body: &str,
    raw_args: &str,
    skill_dir: &str,
    session_id: &str,
    argument_names: &[String],
) -> String {
    let tokens = tokenize_args(raw_args);
    let mut content = body.to_string();

    // 1. Named placeholders $name
    for (index, name) in argument_names.iter().enumerate() {
        let val = escape_xml_tags(tokens.get(index).map(|s| s.as_str()).unwrap_or(""));
        content = replace_named_placeholder(&content, name, &val);
    }

    // 2. $ARGUMENTS[index]
    if let Ok(args_indexed_re) = regex::Regex::new(r"\$ARGUMENTS\[(\d+)\]") {
        content = args_indexed_re
            .replace_all(&content, |caps: &regex::Captures| {
                let index: usize = caps[1].parse().unwrap_or(usize::MAX);
                escape_xml_tags(tokens.get(index).map(|s| s.as_str()).unwrap_or(""))
            })
            .into_owned();
    }

    // 3. Positional placeholders $0, $1, ...
    content = replace_positional_placeholders(&content, &tokens);

    // 4. Raw $ARGUMENTS
    content = content.replace("$ARGUMENTS", &escape_xml_tags(raw_args));

    // 5. Determine if any argument placeholder was present
    let has_argument_placeholder = content != body;

    // 6. Context variables
    content = content
        .replace("${KIMI_SKILL_DIR}", skill_dir)
        .replace("${KIMI_SESSION_ID}", session_id);

    // 7. If no argument placeholder was used and args are non-empty, append ARGUMENTS: line
    if !has_argument_placeholder && !raw_args.is_empty() {
        return format!("{}\n\nARGUMENTS: {}", content, escape_xml_tags(raw_args));
    }

    content
}

fn resolve_argument_names(wire: &SkillWire) -> Vec<String> {
    if let Some(ref names) = wire.argument_names {
        return names.clone();
    }
    match &wire.arguments {
        Some(SkillArgumentsWire::String(s)) => s
            .split_whitespace()
            .filter(|n| !n.trim().is_empty() && !n.chars().all(|c| c.is_ascii_digit()))
            .map(|n| n.to_string())
            .collect(),
        Some(SkillArgumentsWire::List(list)) => list
            .iter()
            .filter(|n| !n.trim().is_empty() && !n.chars().all(|c| c.is_ascii_digit()))
            .cloned()
            .collect(),
        None => Vec::new(),
    }
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
    let session_id = args.get("session_id").and_then(|s| s.as_str());
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
        Ok(response) => render_skill(&response.value, skill_args, session_id),
        Err(error) => map_state_error(name, error),
    }
}

/// Render the host's skill wire value as the v2 Skill tool output: the
/// loaded-inline confirmation line followed by the skill content block.
fn render_skill(
    value: &Value,
    skill_args: Option<&str>,
    session_id: Option<&str>,
) -> ExecutableToolResult {
    let wire: SkillWire = match serde_json::from_value(value.clone()) {
        Ok(wire) => wire,
        Err(_) => {
            return err_result(
                "Invalid skill state from host: expected { name, description, instructions }."
                    .into(),
            );
        }
    };

    if wire.disable_model_invocation == Some(true) {
        return err_result(format!(
            "Skill \"{}\" can only be triggered by the user (model invocation is disabled).",
            wire.name
        ));
    }

    if let Some(ref st) = wire.skill_type
        && st != "prompt"
        && st != "inline"
    {
        return err_result(format!(
            "Skill \"{}\" is not an inline skill and cannot be invoked by the model in v1.",
            wire.name
        ));
    }

    let raw_args = skill_args.unwrap_or("");
    let arg_names = resolve_argument_names(&wire);
    let skill_dir = wire.dir.as_deref().unwrap_or("");

    let expanded_instructions = expand_skill_parameters(
        &wire.instructions,
        raw_args,
        skill_dir,
        session_id.unwrap_or(""),
        &arg_names,
    );

    let content_with_plugin = if let Some(plugin) = &wire.plugin {
        if let Some(instructions) = &plugin.instructions {
            let trimmed = instructions.trim();
            if !trimmed.is_empty() {
                let escaped_id = escape_xml_attr(&plugin.id);
                format!(
                    "<plugin-instructions plugin=\"{escaped_id}\">\n{trimmed}\n</plugin-instructions>\n\n{expanded_instructions}"
                )
            } else {
                expanded_instructions
            }
        } else {
            expanded_instructions
        }
    } else {
        expanded_instructions
    };

    let args_attr = if !raw_args.trim().is_empty() {
        let escaped = escape_xml_attr(raw_args);
        format!(" args=\"{escaped}\"")
    } else {
        String::new()
    };

    ok_result(format!(
        "Skill \"{}\" loaded inline. Follow its instructions.\n\n<skill-loaded name=\"{}\" trigger=\"model-tool\"{args_attr}>\n{}\n\n{}\n</skill-loaded>",
        wire.name, wire.name, wire.description, content_with_plugin
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
        assert!(
            result
                .content
                .contains("args=\"-m &quot;feat: new feature&quot;\"")
        );
        assert!(
            result
                .content
                .contains("ARGUMENTS: -m \"feat: new feature\"")
        );
    }

    #[tokio::test]
    async fn test_name_field_fallback() {
        let (callbacks, read_received) = scripted(read_ok(sample_skill()));
        let result = execute_skill(&callbacks, &serde_json::json!({ "name": "commit" })).await;
        assert!(!result.is_error);
        assert_eq!(read_received.lock().unwrap().clone().unwrap().key, "commit");
    }

    #[test]
    fn test_expand_all_placeholders() {
        let body = "raw=$ARGUMENTS zero=$0 one=$1 second=$ARGUMENTS[1] flag=$flag message=$message dir=${KIMI_SKILL_DIR} session=${KIMI_SESSION_ID}";
        let arg_names = vec!["flag".into(), "message".into()];
        let expanded = expand_skill_parameters(
            body,
            "-m \"fix login\"",
            "/tmp/skills/commit",
            "ses_1",
            &arg_names,
        );
        assert_eq!(
            expanded,
            "raw=-m \"fix login\" zero=-m one=fix login second=fix login flag=-m message=fix login dir=/tmp/skills/commit session=ses_1"
        );
    }

    #[test]
    fn test_unknown_placeholder_left_alone() {
        let body = "unknown=$missing actual=$0 missing=$1";
        let expanded = expand_skill_parameters(body, "hello", "/x", "s", &[]);
        assert_eq!(expanded, "unknown=$missing actual=hello missing=");
    }

    #[test]
    fn test_backslash_dollar_literal() {
        let body = r"raw=\$ARGUMENTS zero=\$0 indexed=\$ARGUMENTS[1] target=\$target";
        let arg_names = vec!["target".into()];
        let expanded = expand_skill_parameters(body, "src/app.ts careful", "/x", "", &arg_names);
        assert_eq!(
            expanded,
            r"raw=\src/app.ts careful zero=\src/app.ts indexed=\careful target=\src/app.ts"
        );
    }

    #[test]
    fn test_append_arguments_when_no_placeholder() {
        let body = "Review this file.";
        let expanded = expand_skill_parameters(body, "src/app.ts", "", "", &[]);
        assert_eq!(expanded, "Review this file.\n\nARGUMENTS: src/app.ts");
    }

    #[test]
    fn test_context_placeholders_still_appends_arguments() {
        let body = "Use ${KIMI_SKILL_DIR}/references/checklist.md.";
        let expanded = expand_skill_parameters(body, "src/app.ts", "/skills/review", "ses_1", &[]);
        assert_eq!(
            expanded,
            "Use /skills/review/references/checklist.md.\n\nARGUMENTS: src/app.ts"
        );
    }

    #[test]
    fn test_longer_variable_names_not_matched() {
        let body = "Leave $targeted alone.";
        let arg_names = vec!["target".into()];
        let expanded = expand_skill_parameters(body, "src/app.ts", "", "", &arg_names);
        assert_eq!(expanded, "Leave $targeted alone.\n\nARGUMENTS: src/app.ts");
    }

    #[test]
    fn test_space_separated_argument_names() {
        let wire = SkillWire {
            name: "review".into(),
            description: "desc".into(),
            instructions: "Target: $target\nMode: $mode".into(),
            dir: None,
            disable_model_invocation: None,
            skill_type: None,
            arguments: Some(SkillArgumentsWire::String("target mode".into())),
            argument_names: None,
            plugin: None,
        };
        let arg_names = resolve_argument_names(&wire);
        let expanded =
            expand_skill_parameters(&wire.instructions, "src/app.ts careful", "", "", &arg_names);
        assert_eq!(expanded, "Target: src/app.ts\nMode: careful");
    }

    #[test]
    fn test_numeric_argument_names_ignored() {
        let wire = SkillWire {
            name: "review".into(),
            description: "desc".into(),
            instructions: "Zero: $0\nOne: $1".into(),
            dir: None,
            disable_model_invocation: None,
            skill_type: None,
            arguments: Some(SkillArgumentsWire::List(vec!["1".into()])),
            argument_names: None,
            plugin: None,
        };
        let arg_names = resolve_argument_names(&wire);
        assert!(arg_names.is_empty());
        let expanded =
            expand_skill_parameters(&wire.instructions, "first second", "", "", &arg_names);
        assert_eq!(expanded, "Zero: first\nOne: second");
    }

    #[test]
    fn test_escapes_xml_tags_in_expanded_args() {
        let body = "target=$target raw=$ARGUMENTS";
        let arg_names = vec!["target".into()];
        let expanded = expand_skill_parameters(body, "<src/app.ts> & notes", "", "", &arg_names);
        assert_eq!(
            expanded,
            "target=&lt;src/app.ts&gt; raw=&lt;src/app.ts&gt; & notes"
        );
    }

    #[tokio::test]
    async fn test_plugin_instructions_prefixed() {
        let skill = serde_json::json!({
            "name": "brainstorm",
            "description": "Brainstorm ideas",
            "instructions": "Brainstorm body.",
            "plugin": {
                "id": "superpowers",
                "instructions": "Use AskUserQuestion for clarifying questions."
            }
        });
        let (callbacks, _) = scripted(read_ok(skill));
        let result = execute_skill(&callbacks, &serde_json::json!({ "skill": "brainstorm" })).await;
        assert!(!result.is_error);
        assert!(result.content.contains("<plugin-instructions plugin=\"superpowers\">\nUse AskUserQuestion for clarifying questions.\n</plugin-instructions>\n\nBrainstorm body."));
    }

    #[tokio::test]
    async fn test_disable_model_invocation_rejected() {
        let skill = serde_json::json!({
            "name": "secret-skill",
            "description": "User only",
            "instructions": "Do secret things",
            "disableModelInvocation": true
        });
        let (callbacks, _) = scripted(read_ok(skill));
        let result =
            execute_skill(&callbacks, &serde_json::json!({ "skill": "secret-skill" })).await;
        assert!(result.is_error);
        assert!(result.content.contains("model invocation is disabled"));
    }

    #[tokio::test]
    async fn test_non_inline_skill_type_rejected() {
        let skill = serde_json::json!({
            "name": "flow-skill",
            "description": "A workflow skill",
            "instructions": "run workflow",
            "skillType": "flow"
        });
        let (callbacks, _) = scripted(read_ok(skill));
        let result = execute_skill(&callbacks, &serde_json::json!({ "skill": "flow-skill" })).await;
        assert!(result.is_error);
        assert!(result.content.contains("not an inline skill"));
    }
}
