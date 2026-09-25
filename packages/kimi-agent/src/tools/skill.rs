//! Native execution of the Skill tool (state bridge protocol, design doc
//! milestone 7, batch 7).
//!
//! A skill resolves from the engine's own scan first — the same
//! `scan_all_skills*` pass that renders the system prompt's `# Skills`
//! section — so the tool loads exactly what the prompt advertised
//! (`prompt/skills_renderer.rs` calls that pairing a requirement: a listing
//! the tool cannot load is a broken promise). The `host/state_read {domain:
//! "skill", key: <skill_name>}` bridge stays as the fallback for a skill only
//! the host knows about (v2 serves the domain from the host's session catalog).
//!
//! Either way the result follows v2 `executeModelSkill`: the tool output is
//! the short confirmation line and the skill content is delivered as a
//! follow-up user message (steer), wrapped in a `<skill-loaded>` block —
//! content blocks on a tool message are rejected by OpenAI-compatible APIs.
//!
//! P82: Full arguments tokenization, parameter placeholders ($NAME, $1,
//! $ARGUMENTS, $ARGUMENTS[index]), context placeholders (${KIMI_SKILL_DIR},
//! ${KIMI_SESSION_ID}), plugin instructions prefixing, and disableModelInvocation
//! / inline-skill type gates.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Value, json};

use super::err_result;
use crate::callbacks::HostCallbacks;
use crate::rpc::types::{ContentBlock, StateReadRequest, ToolDelivery};
use crate::turn_loop::types::ExecutableToolResult;

/// v2 not-found output tail (`SkillTool.execution`).
const SKILL_NOT_FOUND_MESSAGE: &str = "not found in the current skill listing.";

/// Failure message when the connected host does not implement the state
/// bridge. The model must not retry the tool — the host cannot load skills
/// for this session.
const STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE: &str = "The connected client does not support the state bridge. Do NOT call this tool again — the host cannot load skills.";

/// Wire shape of the skill domain: the host returns the skill's
/// name/instructions, plus optional metadata for expansion and gating.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillWire {
    name: String,
    instructions: String,
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    source: Option<String>,
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
fn tokenize_args(raw: &str) -> Vec<String> {
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
fn escape_xml_attr(input: &str) -> String {
    input.replace('&', "&amp;").replace('"', "&quot;")
}

/// Escape every XML-significant character (`&`, `<`, `>`, `"`) for an
/// attribute value (matches v2 `escapeXml`).
fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Replace named placeholders `$name` where not followed by `[` or a word
/// character.
fn replace_named_placeholder(content: &str, name: &str, replacement: &str) -> String {
    let target = format!("${name}");
    let mut result = String::with_capacity(content.len());
    let mut rest = content;

    while let Some(pos) = rest.find(&target) {
        result.push_str(&rest[..pos]);
        let after_pos = pos + target.len();
        let next_char = rest[after_pos..].chars().next();
        // v2 uses the JS `\w` class (ASCII [A-Za-z0-9_]) plus `[`.
        let is_word_or_bracket =
            next_char.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '[');

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

/// Replace positional placeholders `$0`, `$1`, ... where not followed by a
/// word character.
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
            let is_word = next_char.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');

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

/// `$ARGUMENTS[index]` — compiled once, not per call.
static ARGUMENTS_INDEXED_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\$ARGUMENTS\[(\d+)\]").unwrap());

/// Expand parameters into skill content (matches v2 `expandSkillParameters`).
fn expand_skill_parameters(
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
    content = ARGUMENTS_INDEXED_RE
        .replace_all(&content, |caps: &regex::Captures| {
            let index: usize = caps[1].parse().unwrap_or(usize::MAX);
            escape_xml_tags(tokens.get(index).map(|s| s.as_str()).unwrap_or(""))
        })
        .into_owned();

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

/// Drop the YAML frontmatter block, if any: the model sees the body, the
/// host the metadata (same split as v2's frontmatter parser).
fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    match trimmed.strip_prefix("---") {
        Some(rest) => match rest.find("\n---") {
            Some(idx) => rest[idx + "\n---".len()..].trim_start_matches(['\r', '\n']),
            None => trimmed,
        },
        None => trimmed,
    }
}

/// A skill resolved from either the engine scan or the host state bridge,
/// normalized into one shape for gating and rendering.
struct ResolvedSkill {
    name: String,
    instructions: String,
    dir: Option<String>,
    path: Option<String>,
    source: Option<String>,
    skill_type: Option<String>,
    disable_model_invocation: bool,
    argument_names: Vec<String>,
    plugin: Option<SkillPluginWire>,
}

impl ResolvedSkill {
    fn from_wire(wire: SkillWire) -> Self {
        let argument_names = resolve_argument_names(&wire);
        Self {
            name: wire.name,
            instructions: wire.instructions,
            dir: wire.dir,
            path: wire.path,
            source: wire.source,
            skill_type: wire.skill_type,
            disable_model_invocation: wire.disable_model_invocation == Some(true),
            argument_names,
            plugin: wire.plugin,
        }
    }
}

/// Where the `Skill` tool resolves a skill from: the roots **and** the
/// scope-group policy the system prompt's `# Skills` section was rendered from
/// (`prompt/builder.rs`). Both halves matter — with
/// `merge_all_available_skills` off the prompt lists only each scope group's
/// first existing directory, so a tool that always merged would load skills the
/// prompt never advertised, and could resolve a name the two scans disagree on.
#[derive(Debug, Clone, Copy)]
pub struct SkillScan<'a> {
    pub root: Option<&'a Path>,
    pub extra_dirs: &'a [PathBuf],
    pub merge_all_available_skills: bool,
}

/// Resolve a skill from the engine's own scan: file-backed project/user
/// skills first, then the embedded builtin skills. `None` when the scan
/// carries no skill with that name (the caller then asks the host).
fn scan_skill(name: &str, scan: &SkillScan<'_>) -> Option<ResolvedSkill> {
    let found = crate::skills::scan_all_skills_with_extra_and_merge(
        scan.root,
        scan.extra_dirs,
        scan.merge_all_available_skills,
    )
    .into_iter()
    .find(|s| s.name == name)?;

    if found.source == "builtin" {
        let skill_name = found.name.clone();
        let def = crate::skills::builtin_skill_defs()
            .into_iter()
            .find(|def| def.descriptor.name == skill_name)?;
        // v2 keeps `dir`/`path` at the builtin pseudo-path so a builtin's
        // `${KIMI_SKILL_DIR}` resolves to the same pseudo location.
        let pseudo_path = def.descriptor.path.clone();
        return Some(ResolvedSkill {
            name: skill_name,
            instructions: strip_frontmatter(def.body).trim_end().to_string(),
            dir: Some(pseudo_path.clone()),
            path: Some(pseudo_path),
            source: Some(def.descriptor.source.clone()),
            skill_type: None,
            disable_model_invocation: def.descriptor.disable_model_invocation,
            argument_names: Vec::new(),
            plugin: None,
        });
    }

    let raw = std::fs::read_to_string(&found.path).ok()?;
    let meta = crate::skills::parse_skill_frontmatter(&raw, &found.name);
    let dir = Path::new(&found.path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    Some(ResolvedSkill {
        name: found.name,
        instructions: strip_frontmatter(&raw).trim_end().to_string(),
        dir,
        path: Some(found.path),
        source: Some(found.source),
        skill_type: meta.skill_type,
        disable_model_invocation: found.disable_model_invocation,
        argument_names: meta.argument_names,
        plugin: None,
    })
}

/// Execute the Skill tool natively: resolve the skill from the engine's own
/// scan, falling back to `host/state_read {domain: "skill"}`, and render the
/// v2-aligned output + steer delivery.
pub async fn execute_skill(
    callbacks: &dyn HostCallbacks,
    session_id: Option<&str>,
    args: &Value,
    scan: SkillScan<'_>,
) -> ExecutableToolResult {
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
    let raw_args = args.get("args").and_then(|a| a.as_str()).unwrap_or("");
    let session_id = args
        .get("session_id")
        .and_then(|s| s.as_str())
        .or(session_id);

    // The engine's own scan is the authority: it is what the system prompt
    // listed, so a skill it finds loads without round-tripping the host.
    let resolved = if let Some(skill) = scan_skill(name, &scan) {
        skill
    } else {
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
            Ok(response) => match serde_json::from_value::<SkillWire>(response.value) {
                Ok(wire) => ResolvedSkill::from_wire(wire),
                Err(_) => {
                    return err_result(
                        "Invalid skill state from host: expected { name, instructions }.".into(),
                    );
                }
            },
            Err(error) => return map_state_error(name, error),
        }
    };

    // Gates in v2's order: user-only skills first, then the inline-type gate.
    if resolved.disable_model_invocation {
        return err_result(format!(
            "Skill \"{}\" can only be triggered by the user (model invocation is disabled).",
            resolved.name
        ));
    }
    if let Some(ref st) = resolved.skill_type
        && st != "prompt"
        && st != "inline"
    {
        return err_result(format!(
            "Skill \"{}\" is not an inline skill and cannot be invoked by the model in v1.",
            resolved.name
        ));
    }

    let skill_dir = resolved.dir.clone().unwrap_or_default();
    let expanded_instructions = expand_skill_parameters(
        &resolved.instructions,
        raw_args,
        &skill_dir,
        session_id.unwrap_or(""),
        &resolved.argument_names,
    );
    let skill_content = prefix_plugin_instructions(&resolved.plugin, expanded_instructions);

    // Activation provenance (v2 `SkillActivationOrigin` + `SkillActivated`).
    let activation_id = ulid::Ulid::new().to_string();
    let trigger = "model-tool";

    let mut origin = json!({
        "kind": "skill_activation",
        "activationId": activation_id,
        "skillName": resolved.name,
        "trigger": trigger,
    });
    if !raw_args.is_empty() {
        origin["skillArgs"] = json!(raw_args);
    }
    if let Some(ref path) = resolved.path {
        origin["skillPath"] = json!(path);
    }
    if let Some(ref source) = resolved.source {
        origin["skillSource"] = json!(source);
    }

    // v2 `recordModelToolActivation`: the durable event plus telemetry,
    // before the delivery lands.
    let mut activated = json!({
        "type": "skill.activated",
        "activationId": activation_id,
        "skillName": resolved.name,
        "trigger": trigger,
    });
    if !raw_args.is_empty() {
        activated["skillArgs"] = json!(raw_args);
    }
    if let Some(ref path) = resolved.path {
        activated["skillPath"] = json!(path);
    }
    if let Some(ref source) = resolved.source {
        activated["skillSource"] = json!(source);
    }
    callbacks.emit_event(activated);
    callbacks.telemetry(json!({
        "event": "skill_invoked",
        "skill_name": resolved.name,
        "trigger": trigger,
    }));

    // Block attributes: name, trigger, source, dir, args. Undefined values
    // are dropped; empty strings kept (v2 `renderSkillAttributes`).
    let attrs = render_skill_attributes(&resolved, raw_args, trigger);
    let block = format!("<skill-loaded{attrs}>\n{skill_content}\n</skill-loaded>");
    let delivery_text =
        format!("Skill tool loaded instructions for this request. Follow them.\n\n{block}");

    ExecutableToolResult {
        content: format!(
            "Skill \"{}\" loaded inline. Follow its instructions.",
            resolved.name
        ),
        delivery: Some(ToolDelivery {
            blocks: vec![ContentBlock::Text {
                text: delivery_text,
            }],
            origin: Some(origin),
        }),
        stop_turn: false,
        is_error: false,
        note: None,
    }
}

/// Prefix the skill content with its plugin's instructions when present
/// (v2 registry `renderSkillPrompt`).
fn prefix_plugin_instructions(plugin: &Option<SkillPluginWire>, content: String) -> String {
    if let Some(plugin) = plugin
        && let Some(instructions) = &plugin.instructions
    {
        let trimmed = instructions.trim();
        if !trimmed.is_empty() {
            let escaped_id = escape_xml_attr(&plugin.id);
            return format!(
                "<plugin-instructions plugin=\"{escaped_id}\">\n{trimmed}\n</plugin-instructions>\n\n{content}"
            );
        }
    }
    content
}

/// Render the `skill-loaded` opening tag's attribute list.
fn render_skill_attributes(skill: &ResolvedSkill, raw_args: &str, trigger: &str) -> String {
    let attrs: [(&str, Option<&str>); 5] = [
        ("name", Some(skill.name.as_str())),
        ("trigger", Some(trigger)),
        ("source", skill.source.as_deref()),
        ("dir", skill.dir.as_deref()),
        ("args", Some(raw_args)),
    ];
    attrs
        .iter()
        .filter(|(_, value)| value.is_some())
        .map(|(name, value)| format!(" {name}=\"{}\"", escape_xml(value.unwrap())))
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::{
        BoxFuture, PermissionDecision, StateReadRequest, StateReadResponse, StateWriteRequest,
        StateWriteResponse,
    };
    use std::sync::Arc;

    /// The `(callbacks, recorded state-read, recorded telemetry events)` triple
    /// [`scripted`] hands back. Named because the raw tuple trips
    /// `clippy::type_complexity`.
    type Scripted = (
        ScriptedCallbacks,
        Arc<std::sync::Mutex<Option<StateReadRequest>>>,
        Arc<std::sync::Mutex<Vec<Value>>>,
    );

    /// Scripted callbacks: records the received state requests and emitted
    /// events, answers with canned responses.
    struct ScriptedCallbacks {
        read_response: Result<StateReadResponse, String>,
        write_response: Result<StateWriteResponse, String>,
        read_received: Arc<std::sync::Mutex<Option<StateReadRequest>>>,
        events: Arc<std::sync::Mutex<Vec<Value>>>,
        telemetry_events: Arc<std::sync::Mutex<Vec<Value>>>,
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

        fn emit_event(&self, event: Value) {
            self.events.lock().unwrap().push(event);
        }

        fn telemetry(&self, event: Value) {
            self.telemetry_events.lock().unwrap().push(event);
        }
    }

    fn scripted(read_response: Result<StateReadResponse, String>) -> Scripted {
        let read_received = Arc::new(std::sync::Mutex::new(None));
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let telemetry_events = Arc::new(std::sync::Mutex::new(Vec::new()));
        (
            ScriptedCallbacks {
                read_response,
                write_response: Ok(StateWriteResponse {
                    ok: true,
                    value: Value::Null,
                }),
                read_received: read_received.clone(),
                events: events.clone(),
                telemetry_events,
            },
            read_received,
            events,
        )
    }

    fn read_ok(value: Value) -> Result<StateReadResponse, String> {
        Ok(StateReadResponse { value })
    }

    /// The scan a test passes when it only cares about roots: merging on, the
    /// documented default, with no extra roots.
    fn scan(root: Option<&Path>) -> SkillScan<'_> {
        SkillScan {
            root,
            extra_dirs: &[],
            merge_all_available_skills: true,
        }
    }

    fn sample_skill() -> Value {
        serde_json::json!({
            "name": "commit",
            "instructions": "1. Stage the files.\n2. Write the message."
        })
    }

    #[tokio::test]
    async fn test_renders_skill_output_and_delivery() {
        let (callbacks, read_received, events) = scripted(read_ok(sample_skill()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "commit" }),
            scan(None),
        )
        .await;
        assert!(!result.is_error);
        // The tool output is the confirmation line only (v2 tool output).
        assert_eq!(
            result.content,
            "Skill \"commit\" loaded inline. Follow its instructions."
        );
        // The instructions ride a follow-up user delivery, not the tool result.
        let delivery = result.delivery.expect("steer delivery");
        let ContentBlock::Text { text } = &delivery.blocks[0] else {
            panic!("expected a text block");
        };
        assert_eq!(
            text,
            "Skill tool loaded instructions for this request. Follow them.\n\n<skill-loaded name=\"commit\" trigger=\"model-tool\" args=\"\">\n1. Stage the files.\n2. Write the message.\n</skill-loaded>"
        );
        // The delivered user message carries the skill_activation origin.
        let origin = delivery.origin.expect("origin");
        assert_eq!(origin["kind"], "skill_activation");
        assert_eq!(origin["skillName"], "commit");
        assert_eq!(origin["trigger"], "model-tool");

        let request = read_received.lock().unwrap().clone().unwrap();
        assert_eq!(request.domain, "skill");
        assert_eq!(request.key, "commit");
        assert_eq!(request.turn_id, "");
        assert_eq!(request.tool_call_id, "");

        // The skill.activated activation event fires once.
        let recorded = events.lock().unwrap();
        let activated = recorded
            .iter()
            .find(|e| e["type"] == "skill.activated")
            .expect("skill.activated event");
        assert_eq!(activated["skillName"], "commit");
        assert_eq!(activated["trigger"], "model-tool");
        assert!(activated.get("skillArgs").is_none());
    }

    #[tokio::test]
    async fn test_not_found_maps_to_v2_message() {
        let (callbacks, _, _) = scripted(Err(
            "State read error: [-32002] unknown skill: commit".into()
        ));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "commit" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(
            result.content,
            "Skill \"commit\" not found in the current skill listing."
        );
    }

    #[tokio::test]
    async fn test_unsupported_host_returns_failure_message() {
        let (callbacks, _, _) = scripted(Err("host does not support state bridge".into()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "commit" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, STATE_BRIDGE_UNSUPPORTED_FAILURE_MESSAGE);
    }

    #[tokio::test]
    async fn test_other_host_error_passes_through() {
        let (callbacks, _, _) = scripted(Err(
            "State read error: [-32001] unknown domain: skill".into()
        ));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "commit" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("-32001"));
        assert!(result.content.contains("unknown domain"));
    }

    #[tokio::test]
    async fn test_invalid_args_return_error_without_calling_host() {
        let (callbacks, read_received, _) = scripted(read_ok(sample_skill()));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ "skill": "" }),
            serde_json::json!({ "skill": 42 }),
        ] {
            let result = execute_skill(&callbacks, None, &bad, scan(None)).await;
            assert!(result.is_error, "args: {bad}");
            assert!(result.content.contains("Invalid Skill arguments"));
        }
        assert!(read_received.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_invalid_wire_shape_returns_error() {
        let (callbacks, _, _) = scripted(read_ok(serde_json::json!({ "name": "commit" })));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "commit" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("Invalid skill state from host"));
    }

    #[tokio::test]
    async fn test_turn_and_tool_call_ids_are_forwarded() {
        let (callbacks, read_received, _) = scripted(read_ok(sample_skill()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({
                "skill": "commit",
                "turn_id": "turn-42",
                "tool_call_id": "call_abc"
            }),
            scan(None),
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
        let (callbacks, _, events) = scripted(read_ok(sample_skill()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({
                "skill": "commit",
                "args": "-m \"feat: new feature\""
            }),
            scan(None),
        )
        .await;
        assert!(!result.is_error);
        let ContentBlock::Text { text } = &result.delivery.unwrap().blocks[0] else {
            panic!("expected a text block");
        };
        assert!(
            text.contains("args=\"-m &quot;feat: new feature&quot;\""),
            "{text}"
        );
        assert!(
            text.contains("ARGUMENTS: -m \"feat: new feature\""),
            "{text}"
        );
        // Args ride both the origin and the activation event.
        let activated = events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "skill.activated")
            .unwrap()
            .clone();
        assert_eq!(activated["skillArgs"], "-m \"feat: new feature\"");
    }

    #[tokio::test]
    async fn test_name_field_fallback() {
        let (callbacks, read_received, _) = scripted(read_ok(sample_skill()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "name": "commit" }),
            scan(None),
        )
        .await;
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
            instructions: "Target: $target\nMode: $mode".into(),
            dir: None,
            path: None,
            source: None,
            disable_model_invocation: None,
            skill_type: None,
            arguments: Some(SkillArgumentsWire::String("target mode".into())),
            argument_names: None,
            plugin: None,
        };
        let resolved = ResolvedSkill::from_wire(wire);
        let expanded = expand_skill_parameters(
            &resolved.instructions,
            "src/app.ts careful",
            "",
            "",
            &resolved.argument_names,
        );
        assert_eq!(expanded, "Target: src/app.ts\nMode: careful");
    }

    #[test]
    fn test_numeric_argument_names_ignored() {
        let wire = SkillWire {
            name: "review".into(),
            instructions: "Zero: $0\nOne: $1".into(),
            dir: None,
            path: None,
            source: None,
            disable_model_invocation: None,
            skill_type: None,
            arguments: Some(SkillArgumentsWire::List(vec!["1".into()])),
            argument_names: None,
            plugin: None,
        };
        let resolved = ResolvedSkill::from_wire(wire);
        assert!(resolved.argument_names.is_empty());
        let expanded = expand_skill_parameters(
            &resolved.instructions,
            "first second",
            "",
            "",
            &resolved.argument_names,
        );
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
            "instructions": "Brainstorm body.",
            "plugin": {
                "id": "superpowers",
                "instructions": "Use AskUserQuestion for clarifying questions."
            }
        });
        let (callbacks, _, _) = scripted(read_ok(skill));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "brainstorm" }),
            scan(None),
        )
        .await;
        assert!(!result.is_error);
        let ContentBlock::Text { text } = &result.delivery.unwrap().blocks[0] else {
            panic!("expected a text block");
        };
        assert!(text.contains("<plugin-instructions plugin=\"superpowers\">\nUse AskUserQuestion for clarifying questions.\n</plugin-instructions>\n\nBrainstorm body."));
    }

    #[tokio::test]
    async fn test_disable_model_invocation_rejected() {
        let skill = serde_json::json!({
            "name": "secret-skill",
            "instructions": "Do secret things",
            "disableModelInvocation": true
        });
        let (callbacks, _, _) = scripted(read_ok(skill));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "secret-skill" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("model invocation is disabled"));
    }

    #[tokio::test]
    async fn test_non_inline_skill_type_rejected() {
        let skill = serde_json::json!({
            "name": "flow-skill",
            "instructions": "run workflow",
            "skillType": "flow"
        });
        let (callbacks, _, _) = scripted(read_ok(skill));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "flow-skill" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("not an inline skill"));
    }

    #[tokio::test]
    async fn test_skill_interpolates_session_id_from_context() {
        let skill = serde_json::json!({
            "name": "session-test",
            "instructions": "session is ${KIMI_SESSION_ID}",
        });
        let (callbacks, _, _) = scripted(read_ok(skill));
        let result = execute_skill(
            &callbacks,
            Some("session-xyz-123"),
            &serde_json::json!({ "skill": "session-test" }),
            scan(None),
        )
        .await;
        assert!(!result.is_error);
        let ContentBlock::Text { text } = &result.delivery.unwrap().blocks[0] else {
            panic!("expected a text block");
        };
        assert!(text.contains("session is session-xyz-123"));
    }

    /// The engine's own scan is the primary source, so a workspace skill loads
    /// even when the host cannot answer the state bridge at all — and the
    /// frontmatter stays out of what the model sees.
    #[tokio::test]
    async fn test_workspace_skill_loads_without_the_host_bridge() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join(".kimi-code").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: A workspace skill.\n---\n\nDo the demo thing.\n",
        )
        .unwrap();

        // The host refuses the bridge outright; only the engine scan can answer.
        let (callbacks, read_received, events) =
            scripted(Err("host does not support state bridge".into()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "demo" }),
            scan(Some(dir.path())),
        )
        .await;

        assert!(!result.is_error, "{}", result.content);
        assert_eq!(
            result.content,
            "Skill \"demo\" loaded inline. Follow its instructions."
        );
        let ContentBlock::Text { text } = &result.delivery.as_ref().unwrap().blocks[0] else {
            panic!("expected a text block");
        };
        assert!(text.contains("<skill-loaded name=\"demo\""));
        assert!(text.contains("Do the demo thing."));
        // The frontmatter block is metadata, not instructions.
        assert!(!text.contains("---\ndescription:"));
        // Resolved locally: the host was never asked, but the activation event
        // still records it for the transcript.
        assert!(read_received.lock().unwrap().is_none());
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "skill.activated")
        );

        // An unknown name still falls through to the bridge, so a host that
        // owns extra skills keeps working.
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "no-such-skill" }),
            scan(Some(dir.path())),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("does not support the state bridge"));
    }

    /// Scanned skills carry their frontmatter metadata: named `arguments`
    /// expand positionally, and a non-inline `type` keeps the skill out.
    #[tokio::test]
    async fn test_scanned_skill_honors_arguments_and_type_gates() {
        let dir = tempfile::tempdir().unwrap();

        let named_dir = dir.path().join(".agents").join("skills").join("review");
        std::fs::create_dir_all(&named_dir).unwrap();
        std::fs::write(
            named_dir.join("SKILL.md"),
            "---\nname: review\ndescription: Review a target.\narguments: target mode\n---\n\nReview $target in $mode.",
        )
        .unwrap();

        let (callbacks, _, _) = scripted(Err("host does not support state bridge".into()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({
                "skill": "review",
                "args": "src/app.ts strict"
            }),
            scan(Some(dir.path())),
        )
        .await;
        assert!(!result.is_error, "{}", result.content);
        let ContentBlock::Text { text } = &result.delivery.as_ref().unwrap().blocks[0] else {
            panic!("expected a text block");
        };
        assert!(text.contains("Review src/app.ts in strict."), "{text}");
        assert!(text.contains("source=\"project\""), "{text}");
        assert!(text.contains("dir=\""), "{text}");

        // A workspace flow skill is listed by the scan metadata but rejected.
        let flow_dir = dir.path().join(".agents").join("skills").join("flow-skill");
        std::fs::create_dir_all(&flow_dir).unwrap();
        std::fs::write(
            flow_dir.join("SKILL.md"),
            "---\nname: flow-skill\ndescription: A flow.\ntype: flow\n---\n\nRun the flow.",
        )
        .unwrap();
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "flow-skill" }),
            scan(Some(dir.path())),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("not an inline skill"));
    }

    /// The scope-group policy is part of the scan contract: with
    /// `merge_all_available_skills` off the prompt lists only each group's first
    /// existing directory, so the tool must miss a skill that lives in the
    /// second one and hand the question to the host bridge.
    #[tokio::test]
    async fn test_skill_scan_honors_the_merge_switch() {
        let dir = tempfile::tempdir().unwrap();
        // `.agents/skills` is the project group's first existing directory, so
        // it is the only one a merge-off scan reads.
        let generic = dir.path().join(".agents").join("skills").join("generic");
        std::fs::create_dir_all(&generic).unwrap();
        std::fs::write(
            generic.join("SKILL.md"),
            "---\nname: generic\ndescription: From .agents\n---\n\nGeneric body.\n",
        )
        .unwrap();
        let brand = dir.path().join(".kimi-code").join("skills").join("brand");
        std::fs::create_dir_all(&brand).unwrap();
        std::fs::write(
            brand.join("SKILL.md"),
            "---\nname: brand\ndescription: From .kimi-code\n---\n\nBrand body.\n",
        )
        .unwrap();

        // The host refuses the bridge, so whatever the engine scan misses is
        // reported as unloadable — the fact under test.
        let (callbacks, read_received, _) =
            scripted(Err("host does not support state bridge".into()));

        let merged = SkillScan {
            root: Some(dir.path()),
            extra_dirs: &[],
            merge_all_available_skills: true,
        };
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "brand" }),
            merged,
        )
        .await;
        assert!(!result.is_error, "{}", result.content);
        let ContentBlock::Text { text } = &result.delivery.as_ref().unwrap().blocks[0] else {
            panic!("expected a text block");
        };
        assert!(text.contains("Brand body."), "{text}");
        assert!(read_received.lock().unwrap().is_none(), "the scan answered");

        let selected = SkillScan {
            root: Some(dir.path()),
            extra_dirs: &[],
            merge_all_available_skills: false,
        };
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "brand" }),
            selected,
        )
        .await;
        assert!(result.is_error);
        assert!(
            result.content.contains("does not support the state bridge"),
            "{}",
            result.content
        );
        assert!(
            read_received.lock().unwrap().is_some(),
            "a merge-off miss must fall back to the host"
        );

        // The group's first directory stays reachable either way.
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "generic" }),
            selected,
        )
        .await;
        assert!(!result.is_error, "{}", result.content);
    }

    /// A sub-skill is user-invocable, so the model must not load it — the same
    /// gate as any `disable_model_invocation` skill (v2 keeps the two
    /// catalogs apart for the same reason).
    #[tokio::test]
    async fn test_sub_skill_is_not_model_invocable() {
        let (callbacks, _, _) = scripted(Err("host does not support state bridge".into()));

        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "sub-skill.review" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert!(
            result.content.contains("model invocation is disabled"),
            "{}",
            result.content
        );
    }

    /// The four builtin skills are scan-resolved to their embedded bodies,
    /// so a listing the prompt advertises is actually loadable.
    #[tokio::test]
    async fn test_builtin_skills_load_embedded_bodies() {
        let (callbacks, read_received, _) =
            scripted(Err("host does not support state bridge".into()));

        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "update-config" }),
            scan(None),
        )
        .await;
        assert!(!result.is_error, "{}", result.content);
        let delivery = result.delivery.expect("delivery");
        let ContentBlock::Text { text } = &delivery.blocks[0] else {
            panic!("expected a text block");
        };
        assert!(
            text.contains("<skill-loaded name=\"update-config\""),
            "{text}"
        );
        assert!(text.contains("source=\"builtin\""), "{text}");
        assert!(text.contains("dir=\"builtin://update-config\""), "{text}");
        // The host bridge was never needed.
        assert!(read_received.lock().unwrap().is_none());

        // custom-theme is user-only: model invocation is rejected.
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "custom-theme" }),
            scan(None),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.contains("model invocation is disabled"));
    }

    /// Skill names and args are XML-escaped inside attributes, so a name
    /// carrying quotes cannot break out of the tag.
    #[tokio::test]
    async fn test_skill_name_is_escaped_in_attributes() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join(".kimi-code").join("skills").join("a-b");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: 'q\"x'\ndescription: d\n---\n\nBody.",
        )
        .unwrap();

        let (callbacks, _, _) = scripted(Err("x".into()));
        let result = execute_skill(
            &callbacks,
            None,
            &serde_json::json!({ "skill": "q\"x" }),
            scan(Some(dir.path())),
        )
        .await;
        assert!(!result.is_error, "{}", result.content);
        let ContentBlock::Text { text } = &result.delivery.as_ref().unwrap().blocks[0] else {
            panic!("expected a text block");
        };
        assert!(text.contains("name=\"q&quot;x\""), "{text}");
    }
}
