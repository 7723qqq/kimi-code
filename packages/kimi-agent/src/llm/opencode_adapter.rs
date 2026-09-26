//! Outbound request adapter for opencode's free tier (a compatibility layer).
//!
//! `https://opencode.ai/zen/*` applies a **shape gate** to the free tier: all
//! three conditions must hold **simultaneously** or the request is rejected
//! with 403, and the error text is identical in every case, so it never says
//! which condition failed:
//!
//! ```text
//! 403 {"type":"error","error":{"type":"FreeTierError",
//!     "message":"OpenCode's free tier can only be used from within OpenCode"}}
//! ```
//!
//! 1. **Must stream** — `stream: false` → 403 (measured by bisecting each
//!    condition, ROADMAP §6.9.3);
//! 2. **`tools` must contain both lowercase `bash` and `read`** — `tools: []`,
//!    `[calculate]`, and even a missing `tools` key are all 403;
//! 3. **Must carry `x-opencode-*` headers** — not this layer's job: the engine
//!    only assembles the body, and the headers come from the provider's
//!    `custom_headers` (see `~/.kimi-code/config.toml`).
//!
//! # The engine's two kinds of request
//!
//! * **The main loop request, with tools.** Tool names are the engine's
//!   canonical names (`Bash` / `Read`), capitalized, and the gate rejects them
//!   as sent. This layer rewrites the **outbound** names into the lowercase
//!   aliases the gate names. The return trip restores them to **canonical
//!   names** ([`crate::tools::canonical_tool_name`], matched against the tool
//!   table in `run_turn`): dispatch and permission matching happen to be
//!   case-insensitive (`tools::NativeToolset::execute`,
//!   `permission::Rule::matches`), but `tool.call.*` events, ACP's tool-kind
//!   mapping, the TUI renderers and the user's hook matchers all read names
//!   by exact case, so an alias left on the return trip would miss them all.
//! * **Auxiliary requests without tools.** The summarizer, title generator and
//!   memory filer pass no tools, so they were **necessarily** 403 before —
//!   a failed summary is `compaction.cancelled`, i.e. the user seeing
//!   "compaction cancelled". This layer **injects shape placeholders** for the
//!   missing `bash` / `read` so the gate lets the request through. The
//!   placeholders take the shape of the protocol (Chat Completions / Responses
//!   / Anthropic / Google).
//!
//! # The placeholder tools' risk, and how it is mitigated
//!
//! The placeholders reuse the two names the gate asks for, so the model may
//! genuinely try to call them. Two mitigations: the description says
//! `Do not call this tool` explicitly; and the callers (summarizer / title
//! generator) never consume `tool_calls` — they only take the text. This is
//! still a "patch the shape" trade-off — ROADMAP §6.9.3 records the
//! alternative as "admit the free tier does not support compaction".
//!
//! Note the placeholders are **not** confined to tool-less requests: a request
//! whose tool table is narrowed (a read-only subagent, a profile whose
//! `disallowedTools` excludes Bash) is likewise missing `bash` and therefore
//! receives a `bash` entry — the gate is a hard shape check, and skipping the
//! patch fails the whole request with 403. The enforcement is **not** this
//! layer's job: the call still goes through the global `[tools]` switch, the
//! subagent allowlist and the permission engine, and a placeholder never lets
//! any call bypass them. This is a **known trade-off** (ROADMAP §6.9.3).
//!
//! # Deliberately not done here
//!
//! **Reasoning effort is not rewritten.** There used to be an alias table
//! collapsing `max` / `xhigh` / `minimal` into `high` / `low`, on the grounds
//! that upstream only accepted `low` / `medium` / `high` / `none`. Upstream's
//! accepted set has since changed — it reports the legal set itself:
//!
//! ```text
//! 400 ... reasoning_effort: Invalid option: expected one of
//!     "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"
//! ```
//!
//! Measured on `mimo-v2.6-flash-free`, all seven values return 200, `max`
//! included, so the alias table became a silent downgrade: a user-configured
//! `max` was rewritten to `high` on the wire. Effort therefore always goes out
//! exactly as configured; the only outbound filter is [`crate::llm::effort`],
//! which rejects host-side tokens like `on` — not the tiers this layer used to
//! collapse.
//!
//! **Message and reasoning content is not rewritten.** The response-side
//! dialects (`reasoning` / `reasoning_content` / `reasoning_details`) are
//! handled by [`crate::llm::openai`]'s accumulator against a probe table; this
//! layer only computes the placeholders' shape.

use serde_json::{Map, Value, json};

/// The tool names this layer rewrites. Only the two the gate actually checks
/// are listed — every other tool keeps the engine's canonical name, so the list
/// the model sees matches the one everywhere else. Add a line here if the gate
/// ever asks for more names.
pub const TOOL_NAME_ALIASES: &[(&str, &str)] = &[("Bash", "bash"), ("Read", "read")];

/// The names the gate requires to appear in `tools` (lowercase).
pub const FREE_TIER_REQUIRED_TOOLS: &[&str] = &["bash", "read"];

/// The placeholder tools' description: it tells the model not to call them,
/// because they exist only to satisfy the gateway's shape check.
const PLACEHOLDER_DESCRIPTION: &str =
    "Shape placeholder required by the gateway. Do not call this tool.";

/// Whether `base_url` points at an opencode zen endpoint (both `/zen/v1` and
/// `/zen/go/v1` match).
pub fn is_opencode_endpoint(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return false;
    };
    url.host_str() == Some("opencode.ai") && url.path().starts_with("/zen/")
}

/// Which wire shape a placeholder tool takes — matching the three structures
/// [`rewrite_tool_names`] covers, decided by the request's protocol (the values
/// line up with the branch `llm::http` uses to pick a protocol).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaceholderShape {
    /// OpenAI Chat Completions: the definition sits under `function`.
    ChatCompletions,
    /// OpenAI Responses: `name` and `parameters` are at the top level.
    Responses,
    /// Anthropic: no `type` at the top level; the parameter schema is called
    /// `input_schema`.
    Anthropic,
    /// Google: declarations must be wrapped in a `functionDeclarations` array.
    Google,
}

/// Pick the placeholder shape by protocol name. An unknown protocol is handled
/// as Chat Completions, matching `llm::http`'s fallback branch.
fn placeholder_shape(protocol: &str) -> PlaceholderShape {
    match protocol {
        "anthropic" => PlaceholderShape::Anthropic,
        "openai_responses" | "openai-responses" => PlaceholderShape::Responses,
        "google" | "google-genai" | "gemini" => PlaceholderShape::Google,
        _ => PlaceholderShape::ChatCompletions,
    }
}

/// Rewrite the request body in place so it passes the free tier's shape gate.
///
/// The order matters: **first** rewrite the tool names (swapping the engine's
/// canonical names for the lowercase the gate wants), **then** patch the shape
/// (the names it sees are already the outbound ones by then, so the
/// missing-entry check is accurate). `protocol` decides the placeholders' wire
/// shape.
pub fn apply(body: &mut Value, protocol: &str) {
    rewrite_tool_names(body);
    enforce_free_tier_shape(body, placeholder_shape(protocol));
}

/// Swap the tool names in `tools` for their outbound aliases. Covers three wire
/// structures: OpenAI Chat Completions nests the definition under `function`,
/// Anthropic and OpenAI Responses put `name` at the top level, and Google wraps
/// the list in `functionDeclarations`. An entry with no matching field, or a
/// value absent from the alias table, is left as is.
fn rewrite_tool_names(body: &mut Value) {
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        if let Some(function) = tool.get_mut("function") {
            rewrite_field(function, "name", TOOL_NAME_ALIASES);
        }
        rewrite_field(tool, "name", TOOL_NAME_ALIASES);
        if let Some(declarations) = tool
            .get_mut("functionDeclarations")
            .and_then(Value::as_array_mut)
        {
            for declaration in declarations {
                rewrite_field(declaration, "name", TOOL_NAME_ALIASES);
            }
        }
    }
}

/// Swap `container[field]` for its alias per the alias table.
fn rewrite_field(container: &mut Value, field: &str, aliases: &[(&str, &str)]) {
    let Some(current) = container.get(field).and_then(Value::as_str) else {
        return;
    };
    let Some((_, alias)) = aliases.iter().find(|(from, _)| *from == current) else {
        return;
    };
    if let Some(slot) = container.get_mut(field) {
        *slot = Value::String((*alias).to_owned());
    }
}

/// Fill in the shape the gate requires: `stream: true`, and `tools` containing
/// at least [`FREE_TIER_REQUIRED_TOOLS`].
///
/// `stream` is **forced** to `true` (the gate only accepts streaming; writing
/// `false` explicitly is 403 too); everything else changes only when missing. A
/// malformed body (a non-object body, a non-array `tools`) is let through
/// untouched: bending the structure into something that passes would hide the
/// caller's real bug, so the gate is better left to reject it.
fn enforce_free_tier_shape(body: &mut Value, shape: PlaceholderShape) {
    let Some(object) = body.as_object_mut() else {
        return;
    };

    if object.get("stream").and_then(Value::as_bool) != Some(true) {
        object.insert("stream".to_owned(), Value::Bool(true));
    }

    let missing: Vec<&str> = FREE_TIER_REQUIRED_TOOLS
        .iter()
        .copied()
        .filter(|required| !declares_tool(object, required))
        .collect();
    if missing.is_empty() {
        return;
    }

    let entry = object
        .entry("tools".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(array) = entry.as_array_mut() else {
        // `tools` exists but is not an array: do not guess the caller's intent,
        // leave it to the gate.
        return;
    };

    // Google's declarations must stay inside `functionDeclarations`: append to an
    // existing group, or create one — never drop a bare declaration at the top
    // level of `tools`.
    if shape == PlaceholderShape::Google {
        let existing = array.iter_mut().find_map(|tool| {
            tool.get_mut("functionDeclarations")
                .and_then(Value::as_array_mut)
        });
        match existing {
            Some(declarations) => {
                declarations.extend(missing.iter().map(|name| declaration(name)));
            }
            None => array.push(json!({
                "functionDeclarations": missing
                    .iter()
                    .map(|name| declaration(name))
                    .collect::<Vec<Value>>(),
            })),
        }
        return;
    }

    for name in missing {
        array.push(placeholder_tool(name, shape));
    }
}

/// Whether `tools` already declares an outbound name (case-sensitive — the
/// lowercase literal is exactly what the gate reads).
fn declares_tool(object: &Map<String, Value>, name: &str) -> bool {
    let Some(tools) = object.get("tools").and_then(Value::as_array) else {
        return false;
    };
    tools.iter().any(|tool| {
        let in_function = tool
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str);
        let at_top_level = tool.get("name").and_then(Value::as_str);
        let in_declarations = tool
            .get("functionDeclarations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|d| d.get("name").and_then(Value::as_str))
            .any(|declared| declared == name);
        in_function == Some(name) || at_top_level == Some(name) || in_declarations
    })
}

/// An empty parameter schema: the placeholder exists only to pass the gate, so
/// the parameters are deliberately left empty.
fn empty_parameters() -> Value {
    json!({ "type": "object", "properties": {} })
}

/// A tool definition that exists only to pass the gate: the name is one the gate
/// asks for, the parameter schema is deliberately empty, and the description
/// says not to call it. The shape follows the protocol.
fn placeholder_tool(name: &str, shape: PlaceholderShape) -> Value {
    match shape {
        PlaceholderShape::ChatCompletions => json!({
            "type": "function",
            "function": {
                "name": name,
                "description": PLACEHOLDER_DESCRIPTION,
                "parameters": empty_parameters(),
            },
        }),
        PlaceholderShape::Responses => json!({
            "type": "function",
            "name": name,
            "description": PLACEHOLDER_DESCRIPTION,
            "parameters": empty_parameters(),
        }),
        PlaceholderShape::Anthropic => json!({
            "name": name,
            "description": PLACEHOLDER_DESCRIPTION,
            "input_schema": empty_parameters(),
        }),
        // Google's placeholder is installed straight into `functionDeclarations` by
        // `enforce_free_tier_shape`; returning a well-formed single-declaration
        // group here keeps one fewer "unreachable" around if that ever changes.
        PlaceholderShape::Google => json!({ "functionDeclarations": [declaration(name)] }),
    }
}

/// One Google function declaration.
fn declaration(name: &str) -> Value {
    json!({
        "name": name,
        "description": PLACEHOLDER_DESCRIPTION,
        "parameters": empty_parameters(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str) -> Value {
        json!({
            "type": "function",
            "function": { "name": name, "description": "d", "parameters": { "type": "object" } }
        })
    }

    /// Every name the entries declare, skipping entries that declare none (the
    /// malformed shapes some tests deliberately feed in).
    fn names(body: &Value) -> Vec<String> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| {
                t["function"]["name"]
                    .as_str()
                    .or_else(|| t["name"].as_str())
                    .map(str::to_owned)
            })
            .collect()
    }

    /// The names declared inside every Google `functionDeclarations` group.
    fn declared_names(body: &Value) -> Vec<String> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["functionDeclarations"].as_array())
            .flatten()
            .filter_map(|d| d["name"].as_str().map(str::to_owned))
            .collect()
    }

    /// Whether a name was injected as a shape placeholder rather than declared
    /// by the caller: the placeholder description is the marker.
    fn is_placeholder(body: &Value, name: &str) -> bool {
        let entry = body["tools"].as_array().unwrap().iter().find(|t| {
            t["function"]["name"].as_str() == Some(name) || t["name"].as_str() == Some(name)
        });
        entry.is_some_and(|t| {
            t["function"]["description"]
                .as_str()
                .or_else(|| t["description"].as_str())
                .is_some_and(|d| d.contains("Do not call"))
        })
    }

    #[test]
    fn rewrites_only_the_aliased_names() {
        let mut body = json!({
            "model": "mimo-v2.6-flash-free",
            "tools": [
                tool("Bash"),
                tool("Read"),
                tool("Grep"),
                tool("Glob"),
                tool("Write"),
                tool("Edit"),
                tool("FetchURL"),
            ],
        });
        apply(&mut body, "openai");
        assert_eq!(
            names(&body),
            vec!["bash", "read", "Grep", "Glob", "Write", "Edit", "FetchURL"]
        );
    }

    #[test]
    fn rewrites_the_anthropic_and_responses_shapes() {
        let mut body = json!({
            "tools": [
                { "name": "Bash", "description": "d", "input_schema": { "type": "object" } },
                { "name": "Read", "description": "d", "input_schema": { "type": "object" } },
                { "name": "Grep", "description": "d", "input_schema": { "type": "object" } },
            ],
        });
        apply(&mut body, "openai");
        let got: Vec<&str> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(got, vec!["bash", "read", "Grep"]);
    }

    #[test]
    fn rewrites_the_google_shape() {
        let mut body = json!({
            "tools": [{
                "functionDeclarations": [
                    { "name": "Bash", "description": "d" },
                    { "name": "Read", "description": "d" },
                    { "name": "Glob", "description": "d" },
                ]
            }],
        });
        apply(&mut body, "openai");
        let got: Vec<&str> = body["tools"][0]["functionDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(got, vec!["bash", "read", "Glob"]);
    }

    #[test]
    fn leaves_the_reasoning_effort_alone() {
        // The upstream accepts the full enum now, so the adapter must not
        // rewrite a declared effort into a weaker one — a silent downgrade is
        // worse than a loud 400.
        for effort in ["low", "medium", "high", "xhigh", "max", "minimal", "none"] {
            let mut body = json!({ "reasoning_effort": effort });
            apply(&mut body, "openai");
            assert_eq!(body["reasoning_effort"], effort, "{effort} must survive");
        }
    }

    #[test]
    fn forces_streaming_on() {
        // `stream: false` is a 403 on the free tier, so the request that carries
        // no streaming flag at all must come out streaming.
        let mut body = json!({ "model": "m", "messages": [] });
        apply(&mut body, "openai");
        assert_eq!(body["stream"], Value::Bool(true));
    }

    #[test]
    fn injects_the_shape_placeholders_when_tools_are_absent() {
        // The summarizer / title generator send no tools at all; without this
        // they are a guaranteed 403 and compaction reports "cancelled".
        let mut body = json!({ "model": "m", "messages": [], "stream": true });
        apply(&mut body, "openai");
        let got = names(&body);
        assert!(
            got.contains(&"bash".to_owned()),
            "bash placeholder missing: {got:?}"
        );
        assert!(
            got.contains(&"read".to_owned()),
            "read placeholder missing: {got:?}"
        );
        // The placeholders must not look callable.
        let bash = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "bash")
            .unwrap();
        assert!(
            bash["function"]["description"]
                .as_str()
                .unwrap()
                .contains("Do not call")
        );
    }

    #[test]
    fn appends_only_the_missing_placeholder() {
        // A request that already carries `bash` but not `read` gets exactly one
        // addition — the gate checks the pair, not each name on its own.
        let mut body = json!({ "stream": true, "tools": [tool("bash"), tool("Grep")] });
        apply(&mut body, "openai");
        assert_eq!(names(&body), vec!["bash", "Grep", "read"]);
    }

    #[test]
    fn a_full_toolset_is_left_alone() {
        // The gate's pair is already declared, so nothing is appended — the only
        // change is the alias rewrite (`Bash` / `Read` become the lowercase names
        // the gate looks for).
        let mut body = json!({ "stream": true, "tools": [tool("Bash"), tool("Read")] });
        apply(&mut body, "openai");
        assert_eq!(names(&body), vec!["bash", "read"]);
        assert!(
            !is_placeholder(&body, "bash"),
            "a declared tool must not be replaced by a placeholder: {body}"
        );
        assert!(!is_placeholder(&body, "read"));
    }

    #[test]
    fn a_restricted_tool_table_still_gets_the_gate_pair() {
        // A read-only table (the `explore` subagent, a profile that disallows
        // Bash) lacks `bash`, so the gate would 403 the whole request. The
        // placeholder is what keeps the request alive; execution stays gated by
        // the `[tools]` switch, the subagent allowlist and the permission
        // engine — injecting the name does not open a bypass.
        let mut body = json!({ "stream": true, "tools": [tool("Read"), tool("Grep")] });
        apply(&mut body, "openai");
        assert_eq!(names(&body), vec!["read", "Grep", "bash"]);
        assert!(is_placeholder(&body, "bash"));
        assert!(!is_placeholder(&body, "read"), "the real Read is untouched");
    }

    #[test]
    fn tolerates_malformed_tool_entries() {
        let mut body = json!({
            "stream": true,
            "tools": [
                { "type": "function" },
                { "function": {} },
                { "function": { "name": 7 } },
                tool("Bash"),
            ],
        });
        apply(&mut body, "openai");
        assert_eq!(body["tools"][3]["function"]["name"], "bash");
        // `Read` was genuinely missing, so it is appended rather than skipped.
        assert!(names(&body).contains(&"read".to_owned()));
    }

    #[test]
    fn a_non_array_tools_value_is_left_to_the_gate() {
        // Reshaping a malformed body would hide the caller's bug.
        let mut body = json!({ "stream": true, "tools": "nonsense" });
        apply(&mut body, "openai");
        assert_eq!(body["tools"], json!("nonsense"));
    }

    #[test]
    fn the_placeholder_shape_follows_the_protocol() {
        // Responses: `name` and `parameters` sit at the top level.
        let mut responses = json!({ "stream": true, "tools": [] });
        apply(&mut responses, "openai_responses");
        let entry = &responses["tools"][0];
        assert_eq!(entry["type"], "function");
        assert_eq!(entry["name"], "bash");
        assert!(
            entry["parameters"].is_object(),
            "Responses carries `parameters`: {entry}"
        );

        // Anthropic: no `type`, and the schema is `input_schema`.
        let mut anthropic = json!({ "stream": true, "tools": [] });
        apply(&mut anthropic, "anthropic");
        let entry = &anthropic["tools"][0];
        assert_eq!(entry["name"], "bash");
        assert!(
            entry["input_schema"].is_object(),
            "Anthropic carries `input_schema`: {entry}"
        );
        assert!(
            entry.get("type").is_none(),
            "no `type` on Anthropic: {entry}"
        );
        assert!(entry.get("parameters").is_none());
    }

    #[test]
    fn placeholders_join_the_google_declaration_group() {
        // Google nests declarations, so a bare unit appended to `tools` would be
        // malformed: the missing name joins the group that is already there.
        let mut body = json!({
            "stream": true,
            "tools": [{ "functionDeclarations": [{ "name": "Read", "description": "d" }] }],
        });
        apply(&mut body, "google");
        assert_eq!(declared_names(&body), vec!["read", "bash"]);
        assert_eq!(
            body["tools"].as_array().unwrap().len(),
            1,
            "no second group"
        );

        // A request with no tools at all gets exactly one group holding the pair.
        let mut bare = json!({ "stream": true });
        apply(&mut bare, "google-genai");
        assert_eq!(declared_names(&bare), vec!["bash", "read"]);
        assert_eq!(bare["tools"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn recognises_the_zen_endpoints() {
        assert!(is_opencode_endpoint("https://opencode.ai/zen/v1"));
        assert!(is_opencode_endpoint("https://opencode.ai/zen/go/v1"));
        assert!(is_opencode_endpoint("https://opencode.ai/zen/v1/"));
        assert!(is_opencode_endpoint("  https://opencode.ai/zen/v1  "));
    }

    #[test]
    fn rejects_other_endpoints() {
        assert!(!is_opencode_endpoint("https://api.deepseek.com"));
        assert!(!is_opencode_endpoint("https://opencode.ai/theme"));
        assert!(!is_opencode_endpoint("https://opencode.ai/"));
        assert!(!is_opencode_endpoint("http://127.0.0.1:18992/v1"));
        assert!(!is_opencode_endpoint("not a url"));
        assert!(!is_opencode_endpoint(""));
    }
}
