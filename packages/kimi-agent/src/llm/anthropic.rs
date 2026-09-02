//! Anthropic Messages request projection and response parsing.
//!
//! Pure functions only — no HTTP. Anthropic differs from OpenAI in three ways
//! this layer handles: the system prompt is a top-level `system` field (not a
//! message), assistant tool calls are `tool_use` content blocks whose `input`
//! is a JSON **object** (not a string), and tool results are `tool_result`
//! blocks carried on a `user` message.

use serde_json::{Value, json};

use crate::llm::wire::{StreamDelta, WireMessage};
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build an Anthropic Messages request body. `max_tokens` is required by the
/// API and must be supplied by the caller.
pub fn build_request(
    model: &str,
    max_tokens: u32,
    messages: &[WireMessage],
    tools: &[ToolInfo],
) -> Value {
    build_request_full(model, max_tokens, messages, tools, false, None)
}

/// Build an Anthropic Messages request body, optionally streaming.
pub fn build_request_with_options(
    model: &str,
    max_tokens: u32,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
) -> Value {
    build_request_full(model, max_tokens, messages, tools, stream, None)
}

/// Build an Anthropic Messages request body with optional thinking budget.
pub fn build_request_full(
    model: &str,
    max_tokens: u32,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
    thinking_budget: Option<u32>,
) -> Value {
    let mut system = String::new();
    let mut msgs: Vec<Value> = Vec::new();

    for m in messages {
        match m.role.as_str() {
            "system" => {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(&m.content);
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": m.content }));
                }
                for tc in &m.tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        // Anthropic expects the arguments as a JSON object.
                        "input": tc.arguments,
                    }));
                }
                msgs.push(json!({ "role": "assistant", "content": blocks }));
            }
            "tool" => {
                // A tool result is a `tool_result` block on a user message.
                let tool_use_id = m.tool_call_id.clone().unwrap_or_default();
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": m.content,
                });
                if let Some(last_msg) = msgs.last_mut()
                    && last_msg.get("role").and_then(|r| r.as_str()) == Some("user")
                    && let Some(content_arr) = last_msg.get_mut("content").and_then(|c| c.as_array_mut())
                {
                    content_arr.push(block);
                } else {
                    msgs.push(json!({ "role": "user", "content": [block] }));
                }
            }
            _ => {
                // user (and any unknown role) -> user content blocks.
                // Multimodal blocks win over the plain text content.
                let content: Vec<Value> = if m.blocks.is_empty() {
                    vec![json!({ "type": "text", "text": m.content })]
                } else {
                    m.blocks.iter().map(project_block).collect()
                };
                if let Some(last_msg) = msgs.last_mut()
                    && last_msg.get("role").and_then(|r| r.as_str()) == Some("user")
                    && let Some(content_arr) = last_msg.get_mut("content").and_then(|c| c.as_array_mut())
                {
                    content_arr.extend(content);
                } else {
                    msgs.push(json!({ "role": "user", "content": content }));
                }
            }
        }
    }

    if let Some(last_user_msg) = msgs
        .iter_mut()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        && let Some(content_arr) = last_user_msg.get_mut("content").and_then(|c| c.as_array_mut())
        && let Some(last_block) = content_arr.last_mut()
    {
        last_block["cache_control"] = json!({ "type": "ephemeral" });
    }

    let effective_max_tokens = if let Some(budget) = thinking_budget {
        if budget > 0 && max_tokens <= budget {
            budget.saturating_add(4096)
        } else {
            max_tokens
        }
    } else {
        max_tokens
    };

    let mut req = json!({
        "model": model,
        "max_tokens": effective_max_tokens,
        "messages": msgs,
    });
    if stream {
        req["stream"] = json!(true);
    }
    if let Some(budget) = thinking_budget
        && budget > 0
    {
        req["thinking"] = json!({
            "type": "enabled",
            "budget_tokens": budget,
        });
    }

    if !system.is_empty() {
        req["system"] = json!([{
            "type": "text",
            "text": system,
            "cache_control": { "type": "ephemeral" },
        }]);
    }
    if !tools.is_empty() {
        let mut tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();
        if let Some(last) = tool_defs.last_mut() {
            last["cache_control"] = json!({ "type": "ephemeral" });
        }
        req["tools"] = json!(tool_defs);
    }

    req
}

/// Project a single content block to the Anthropic content-block form.
///
/// Anthropic's Messages API has no native audio/video blocks; audio/video
/// URLs are degraded to placeholder text (mirroring the host's
/// `MEDIA_STRIPPED_PLACEHOLDERS` semantics) so the request stays valid.
fn project_block(b: &ContentBlock) -> Value {
    match b {
        ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
        ContentBlock::Image { media_type, data } => json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media_type, "data": data },
        }),
        ContentBlock::ImageUrl { url } => json!({
            "type": "image",
            "source": { "type": "url", "url": url },
        }),
        ContentBlock::AudioUrl { .. } => json!({
            "type": "text",
            "text": "[audio omitted: not supported by this provider; re-read the file to hear it]",
        }),
        ContentBlock::VideoUrl { .. } => json!({
            "type": "text",
            "text": "[video omitted: not supported by this provider; re-read the file to view it]",
        }),
        ContentBlock::Think { think, encrypted } => {
            let mut obj = json!({ "type": "thinking", "thinking": think });
            if let Some(sig) = encrypted {
                obj["signature"] = json!(sig);
            }
            obj
        }
    }
}

/// Parse an Anthropic Messages (non-streaming) response.
pub fn parse_response(v: &Value) -> Result<LLMChatResponse, String> {
    let content = v
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or("anthropic response missing content array")?;

    let mut text = String::new();
    let mut thinking = Vec::new();
    let mut tool_calls = Vec::new();
    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("thinking") => {
                let think = block.get("thinking").and_then(|x| x.as_str()).unwrap_or("");
                let signature = block
                    .get("signature")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                thinking.push(ContentBlock::Think {
                    think: think.to_string(),
                    encrypted: signature,
                });
            }
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                    text.push_str(t);
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = block.get("input").cloned().unwrap_or_else(|| json!({}));
                tool_calls.push(ToolCall {
                    id,
                    name,
                    arguments,
                });
            }
            _ => {}
        }
    }

    let finish_reason = v
        .get("stop_reason")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    let raw_input = v
        .get("usage")
        .and_then(|u| u.get("input_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = v
        .get("usage")
        .and_then(|u| u.get("output_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let input_cache_read = v
        .get("usage")
        .and_then(|u| u.get("cache_read_input_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let input_cache_creation = v
        .get("usage")
        .and_then(|u| u.get("cache_creation_input_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    // Anthropic's `input_tokens` is the TOTAL input — the cache split fields
    // are additive parts of it — so the wire's uncached `input_tokens` is the
    // remainder. Same rule as `openai.rs::parse_usage`, and the same one the
    // host-proxy leg applies through kosong (`anthropic.ts:718-728`).
    let input_tokens = raw_input.saturating_sub(input_cache_read + input_cache_creation);

    Ok(LLMChatResponse {
        content: text,
        thinking,
        tool_calls,
        finish_reason,
        usage: TokenUsage {
            input_tokens,
            output_tokens,
            total_tokens: input_tokens + output_tokens,
            input_cache_read,
            input_cache_creation,
        },
    })
}

// ── Streaming (SSE) accumulation ───────────────────────────────────────

/// A content block being accumulated across stream events, keyed by index.
#[derive(Debug, Clone)]
enum PartialBlock {
    Text,
    Thinking {
        thinking: String,
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        input_json: String,
    },
}

/// Upper bound on content blocks a single streamed response may open.
/// Generous for real responses (a tool call or two plus text); small enough
/// that a hostile `index` cannot exhaust memory.
const MAX_STREAM_BLOCKS: usize = 256;

/// Accumulates Anthropic Messages stream events into a final
/// [`LLMChatResponse`]. Feed each SSE `data:` JSON payload (each carries a
/// `type` discriminator) to [`StreamAccumulator::feed`]; text or thinking deltas are
/// returned so the caller can forward them to the host.
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    blocks: Vec<Option<PartialBlock>>,
    finish_reason: Option<String>,
    usage: TokenUsage,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve the block slot for a streamed index, or `None` when the index
    /// is implausible.
    ///
    /// The index comes from the provider, and growing the vec to satisfy an
    /// arbitrary one lets a single chunk allocate until the process dies —
    /// which in the napi build takes the host down with it.
    fn slot(&mut self, index: usize) -> Option<&mut Option<PartialBlock>> {
        if index >= MAX_STREAM_BLOCKS {
            return None;
        }
        while self.blocks.len() <= index {
            self.blocks.push(None);
        }
        self.blocks.get_mut(index)
    }

    /// Feed one stream event. Returns the text or thinking delta contained in the
    /// event, if any.
    pub fn feed(&mut self, v: &Value) -> Option<StreamDelta> {
        let event_type = v.get("type").and_then(|t| t.as_str())?;
        match event_type {
            "message_start" => {
                if let Some(usage) = v.get("message").and_then(|m| m.get("usage")) {
                    let raw_input = usage
                        .get("input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0) as u32;
                    self.usage.input_cache_read = usage
                        .get("cache_read_input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0) as u32;
                    self.usage.input_cache_creation = usage
                        .get("cache_creation_input_tokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0) as u32;
                    self.usage.input_tokens = raw_input
                        .saturating_sub(self.usage.input_cache_read + self.usage.input_cache_creation);
                }
                None
            }
            "content_block_start" => {
                let index = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let block = v.get("content_block")?;
                let partial = match block.get("type").and_then(|t| t.as_str()) {
                    Some("thinking") => {
                        let think = block.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                        let signature = block
                            .get("signature")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        PartialBlock::Thinking {
                            thinking: think.to_string(),
                            signature,
                        }
                    }
                    Some("tool_use") => PartialBlock::ToolUse {
                        id: block
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                        name: block
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                        input_json: String::new(),
                    },
                    _ => PartialBlock::Text,
                };
                if let Some(slot) = self.slot(index) {
                    *slot = Some(partial);
                }
                None
            }
            "content_block_delta" => {
                let index = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let delta = v.get("delta")?;
                match delta.get("type").and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        let text = delta.get("text").and_then(|x| x.as_str())?;
                        if text.is_empty() {
                            return None;
                        }
                        self.content.push_str(text);
                        Some(StreamDelta::Text(text.to_string()))
                    }
                    Some("thinking_delta") => {
                        let think = delta.get("thinking").and_then(|x| x.as_str())?;
                        if let Some(Some(PartialBlock::Thinking { thinking, .. })) =
                            self.blocks.get_mut(index)
                        {
                            thinking.push_str(think);
                        }
                        if think.is_empty() {
                            return None;
                        }
                        Some(StreamDelta::Think(think.to_string()))
                    }
                    Some("signature_delta") => {
                        if let Some(Some(PartialBlock::Thinking { signature, .. })) =
                            self.blocks.get_mut(index)
                            && let Some(sig) = delta.get("signature").and_then(|x| x.as_str())
                        {
                            if let Some(s) = signature.as_mut() {
                                s.push_str(sig);
                            } else {
                                *signature = Some(sig.to_string());
                            }
                        }
                        None
                    }
                    Some("input_json_delta") => {
                        if let Some(Some(PartialBlock::ToolUse { input_json, .. })) =
                            self.blocks.get_mut(index)
                            && let Some(fragment) =
                                delta.get("partial_json").and_then(|x| x.as_str())
                        {
                            input_json.push_str(fragment);
                        }
                        None
                    }
                    _ => None,
                }
            }
            "message_delta" => {
                if let Some(sr) = v
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|s| s.as_str())
                {
                    self.finish_reason = Some(sr.to_string());
                }
                if let Some(out) = v
                    .get("usage")
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|x| x.as_u64())
                {
                    self.usage.output_tokens = out as u32;
                }
                None
            }
            // ping / content_block_stop / message_stop carry nothing we need.
            _ => None,
        }
    }

    /// Finalize the accumulated stream into a response.
    pub fn finish(mut self) -> LLMChatResponse {
        self.usage.total_tokens = self.usage.input_tokens + self.usage.output_tokens;
        let mut thinking = Vec::new();
        let mut tool_calls = Vec::new();

        for block in self.blocks.into_iter().flatten() {
            match block {
                PartialBlock::Thinking {
                    thinking: think,
                    signature,
                } => {
                    if !think.is_empty() || signature.is_some() {
                        thinking.push(ContentBlock::Think {
                            think,
                            encrypted: signature,
                        });
                    }
                }
                PartialBlock::ToolUse {
                    id,
                    name,
                    input_json,
                } if !name.is_empty() => {
                    // A truncated stream leaves input_json incomplete — never
                    // fabricate an empty-argument call (it would execute a
                    // tool with no real inputs); drop the call instead.
                    if let Ok(arguments) = serde_json::from_str(&input_json) {
                        tool_calls.push(ToolCall {
                            id,
                            name,
                            arguments,
                        });
                    }
                }
                _ => {}
            }
        }

        LLMChatResponse {
            content: self.content,
            thinking,
            tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_hoists_system_and_encodes_tool_use_as_object() {
        let messages = vec![
            WireMessage::text("system", "sys-a"),
            WireMessage::text("system", "sys-b"),
            WireMessage::text("user", "hi"),
            WireMessage::assistant_tool_calls(
                "let me look",
                vec![ToolCall {
                    id: "tu_1".into(),
                    name: "Read".into(),
                    arguments: json!({ "path": "a.txt" }),
                }],
            ),
            WireMessage::tool_result("tu_1", "file body"),
        ];
        let tools = vec![ToolInfo {
            name: "Read".into(),
            description: "read a file".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let req = build_request("claude-x", 4096, &messages, &tools);

        assert_eq!(req["model"], "claude-x");
        assert_eq!(req["max_tokens"], 4096);
        // System messages are concatenated into the top-level array with cache_control.
        assert_eq!(req["system"][0]["text"], "sys-a\n\nsys-b");
        assert_eq!(req["system"][0]["cache_control"]["type"], "ephemeral");

        let msgs = req["messages"].as_array().unwrap();
        // user, assistant, tool-result-as-user
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"][0]["type"], "text");

        // Assistant: text block + tool_use block with an OBJECT input.
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][0]["type"], "text");
        let tool_use = &msgs[1]["content"][1];
        assert_eq!(tool_use["type"], "tool_use");
        assert_eq!(tool_use["id"], "tu_1");
        assert_eq!(tool_use["name"], "Read");
        assert_eq!(tool_use["input"], json!({ "path": "a.txt" }));

        // Tool result becomes a user message with a tool_result block and cache_control.
        assert_eq!(msgs[2]["role"], "user");
        let tr = &msgs[2]["content"][0];
        assert_eq!(tr["type"], "tool_result");
        assert_eq!(tr["tool_use_id"], "tu_1");
        assert_eq!(tr["content"], "file body");
        assert_eq!(tr["cache_control"]["type"], "ephemeral");

        // Tools use Anthropic's `input_schema` key and last tool has cache_control.
        assert_eq!(req["tools"][0]["name"], "Read");
        assert_eq!(req["tools"][0]["input_schema"], json!({ "type": "object" }));
        assert_eq!(req["tools"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn build_request_merges_consecutive_user_and_tool_messages() {
        let messages = vec![
            WireMessage::text("user", "part 1"),
            WireMessage::text("user", "part 2"),
            WireMessage::assistant_tool_calls(
                "calling",
                vec![
                    ToolCall {
                        id: "call_1".into(),
                        name: "Read".into(),
                        arguments: json!({ "path": "a.txt" }),
                    },
                    ToolCall {
                        id: "call_2".into(),
                        name: "Read".into(),
                        arguments: json!({ "path": "b.txt" }),
                    },
                ],
            ),
            WireMessage::tool_result("call_1", "res 1"),
            WireMessage::tool_result("call_2", "res 2"),
            WireMessage::text("user", "continue please"),
        ];

        let req = build_request("claude-x", 4096, &messages, &[]);
        let msgs = req["messages"].as_array().unwrap();
        // 3 turns total: user (merged), assistant, user (merged 2 tool results + 1 text)
        assert_eq!(msgs.len(), 3);

        // Turn 0: user with 2 text blocks
        assert_eq!(msgs[0]["role"], "user");
        let u0 = msgs[0]["content"].as_array().unwrap();
        assert_eq!(u0.len(), 2);
        assert_eq!(u0[0]["text"], "part 1");
        assert_eq!(u0[1]["text"], "part 2");

        // Turn 1: assistant
        assert_eq!(msgs[1]["role"], "assistant");

        // Turn 2: user with 2 tool_results + 1 text, last block has cache_control
        assert_eq!(msgs[2]["role"], "user");
        let u2 = msgs[2]["content"].as_array().unwrap();
        assert_eq!(u2.len(), 3);
        assert_eq!(u2[0]["type"], "tool_result");
        assert_eq!(u2[0]["tool_use_id"], "call_1");
        assert_eq!(u2[1]["type"], "tool_result");
        assert_eq!(u2[1]["tool_use_id"], "call_2");
        assert_eq!(u2[2]["type"], "text");
        assert_eq!(u2[2]["text"], "continue please");
        assert_eq!(u2[2]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn build_request_without_system_omits_field() {
        let req = build_request("m", 100, &[WireMessage::text("user", "x")], &[]);
        assert!(req.get("system").is_none());
        assert!(req.get("tools").is_none());
    }

    #[test]
    fn parse_response_extracts_tool_use_and_usage() {
        let v = json!({
            "content": [
                { "type": "text", "text": "sure" },
                { "type": "tool_use", "id": "tu_9", "name": "Grep", "input": { "q": "foo" } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 20, "output_tokens": 8 }
        });

        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.finish_reason.as_deref(), Some("tool_use"));
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].id, "tu_9");
        assert_eq!(parsed.tool_calls[0].name, "Grep");
        // Anthropic input is already an object.
        assert_eq!(parsed.tool_calls[0].arguments, json!({ "q": "foo" }));
        assert_eq!(parsed.usage.input_tokens, 20);
        assert_eq!(parsed.usage.output_tokens, 8);
        assert_eq!(parsed.usage.total_tokens, 28);
    }

    #[test]
    fn parse_response_extracts_cache_usage() {
        let v = json!({
            "content": [{ "type": "text", "text": "sure" }],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 50,
                "output_tokens": 6,
                "cache_read_input_tokens": 40,
                "cache_creation_input_tokens": 5
            }
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.usage.input_cache_read, 40);
        assert_eq!(parsed.usage.input_cache_creation, 5);
        // Provider `input_tokens` is the total; the wire carries the uncached
        // remainder, and the total follows the host's `inputOther + output`.
        assert_eq!(parsed.usage.input_tokens, 5);
        assert_eq!(parsed.usage.total_tokens, 11);
    }

    #[test]
    fn parse_response_plain_text_has_no_tool_calls() {
        let v = json!({
            "content": [{ "type": "text", "text": "hello" }],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 3, "output_tokens": 2 }
        });
        let parsed = parse_response(&v).unwrap();
        assert!(parsed.tool_calls.is_empty());
        assert_eq!(parsed.finish_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn parse_response_errors_on_missing_content() {
        assert!(parse_response(&json!({})).is_err());
    }

    #[test]
    fn parse_response_extracts_text_content() {
        let v = json!({
            "content": [
                { "type": "text", "text": "sure, " },
                { "type": "text", "text": "here" }
            ],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.content, "sure, here");
    }

    #[test]
    fn build_request_streaming_sets_stream_flag() {
        let req =
            build_request_with_options("m", 100, &[WireMessage::text("user", "x")], &[], true);
        assert_eq!(req["stream"], true);
    }

    #[test]
    fn build_request_projects_image_blocks() {
        use crate::turn_loop::types::ContentBlock;
        let msg = WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::Text {
                    text: "look".into(),
                },
                ContentBlock::Image {
                    media_type: "image/jpeg".into(),
                    data: "BBBB".into(),
                },
            ],
        );
        let req = build_request("m", 100, &[msg], &[]);
        let content = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[1]["source"]["data"], "BBBB");
    }

    #[test]
    fn build_request_degrades_audio_and_video_blocks() {
        use crate::turn_loop::types::ContentBlock;
        // Anthropic has no native audio/video blocks: they degrade to text.
        let msg = WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::AudioUrl {
                    url: "https://example.com/a.mp3".into(),
                    id: None,
                },
                ContentBlock::VideoUrl {
                    url: "https://example.com/v.mp4".into(),
                    id: None,
                },
            ],
        );
        let req = build_request("m", 100, &[msg], &[]);
        let content = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert!(
            content[0]["text"]
                .as_str()
                .unwrap()
                .contains("audio omitted")
        );
        assert_eq!(content[1]["type"], "text");
        assert!(
            content[1]["text"]
                .as_str()
                .unwrap()
                .contains("video omitted")
        );
    }

    #[test]
    fn stream_accumulator_collects_text_tool_use_and_usage() {
        let mut acc = StreamAccumulator::new();

        acc.feed(
            &json!({ "type": "message_start", "message": { "usage": { "input_tokens": 25 } } }),
        );
        acc.feed(&json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text" } }));
        let d1 = acc.feed(&json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hi " } }));
        assert_eq!(d1, Some(StreamDelta::Text("Hi ".into())));
        let d2 = acc.feed(&json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "there" } }));
        assert_eq!(d2, Some(StreamDelta::Text("there".into())));
        acc.feed(&json!({ "type": "content_block_stop", "index": 0 }));

        acc.feed(&json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "tu_1", "name": "Read" } }));
        acc.feed(&json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }));
        acc.feed(&json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"a.txt\"}" } }));
        acc.feed(&json!({ "type": "content_block_stop", "index": 1 }));

        acc.feed(&json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 9 } }));
        acc.feed(&json!({ "type": "message_stop" }));

        let resp = acc.finish();
        assert_eq!(resp.content, "Hi there");
        assert_eq!(resp.finish_reason.as_deref(), Some("tool_use"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "tu_1");
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert_eq!(resp.tool_calls[0].arguments, json!({ "path": "a.txt" }));
        assert_eq!(resp.usage.input_tokens, 25);
        assert_eq!(resp.usage.output_tokens, 9);
        assert_eq!(resp.usage.total_tokens, 34);
    }

    #[test]
    fn stream_accumulator_reports_uncached_input() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "type": "message_start",
            "message": { "usage": {
                "input_tokens": 50,
                "cache_read_input_tokens": 40,
                "cache_creation_input_tokens": 5
            } }
        }));
        acc.feed(&json!({ "type": "message_delta", "usage": { "output_tokens": 9 } }));

        let resp = acc.finish();
        assert_eq!(resp.usage.input_cache_read, 40);
        assert_eq!(resp.usage.input_cache_creation, 5);
        assert_eq!(resp.usage.input_tokens, 5);
        assert_eq!(resp.usage.total_tokens, 14);
    }

    #[test]
    fn stream_accumulator_collects_thinking_blocks_and_deltas() {
        let mut acc = StreamAccumulator::new();

        acc.feed(&json!({ "type": "message_start", "message": { "usage": { "input_tokens": 10 } } }));
        acc.feed(&json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking" } }));
        let d1 = acc.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "Let's calculate..." }
        }));
        assert_eq!(d1, Some(StreamDelta::Think("Let's calculate...".into())));

        let d_sig = acc.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "signature_delta", "signature": "sig_abc123" }
        }));
        assert_eq!(d_sig, None);
        acc.feed(&json!({ "type": "content_block_stop", "index": 0 }));

        acc.feed(&json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text" } }));
        let d2 = acc.feed(&json!({
            "type": "content_block_delta",
            "index": 1,
            "delta": { "type": "text_delta", "text": "42" }
        }));
        assert_eq!(d2, Some(StreamDelta::Text("42".into())));
        acc.feed(&json!({ "type": "content_block_stop", "index": 1 }));

        acc.feed(&json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 15 } }));
        acc.feed(&json!({ "type": "message_stop" }));

        let resp = acc.finish();
        assert_eq!(resp.content, "42");
        assert_eq!(resp.finish_reason.as_deref(), Some("end_turn"));
        assert_eq!(resp.thinking.len(), 1);
        assert_eq!(
            resp.thinking[0],
            ContentBlock::Think {
                think: "Let's calculate...".into(),
                encrypted: Some("sig_abc123".into()),
            }
        );
    }

    #[test]
    fn parse_response_extracts_thinking_blocks() {
        let v = json!({
            "content": [
                {
                    "type": "thinking",
                    "thinking": "Step-by-step reasoning",
                    "signature": "sig_xyz"
                },
                {
                    "type": "text",
                    "text": "The answer."
                }
            ],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 20
            }
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.content, "The answer.");
        assert_eq!(parsed.thinking.len(), 1);
        assert_eq!(
            parsed.thinking[0],
            ContentBlock::Think {
                think: "Step-by-step reasoning".into(),
                encrypted: Some("sig_xyz".into()),
            }
        );
    }

    #[test]
    fn stream_accumulator_ignores_implausible_block_index() {
        // The index comes from the provider; honouring an arbitrary one grew
        // the accumulator without bound until the process died.
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text" } }));
        acc.feed(&json!({ "type": "content_block_start", "index": 50_000_000, "content_block": { "type": "tool_use", "id": "boom", "name": "Boom" } }));

        assert!(acc.blocks.len() <= MAX_STREAM_BLOCKS);
        let resp = acc.finish();
        assert_eq!(
            resp.tool_calls.len(),
            0,
            "the out-of-range block must be dropped"
        );
    }

    #[test]
    fn finish_after_truncated_stream_keeps_partial_content() {
        // A provider that dies before message_stop (no message_delta, no
        // usage) must still surface the streamed text and finish safely.
        let mut acc = StreamAccumulator::default();
        acc.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "hel" }
        }));
        acc.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "lo" }
        }));
        let resp = acc.finish();
        assert_eq!(resp.content, "hello");
        assert!(resp.finish_reason.is_none());
        assert_eq!(resp.usage.total_tokens, 0);
    }

    #[test]
    fn truncated_tool_use_input_is_dropped_not_fabricated() {
        // A stream cut inside the input JSON must NOT execute a tool call
        // with an empty argument object (e.g. Bash without a command).
        let mut acc = StreamAccumulator::default();
        acc.feed(&json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "tool_use", "id": "tu_1", "name": "Bash" }
        }));
        acc.feed(&json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": "{\"command\": \"ech" }
        }));
        let resp = acc.finish();
        assert!(resp.tool_calls.is_empty(), "truncated call must be dropped");
    }

    #[test]
    fn complete_tool_use_input_is_kept() {
        let mut acc = StreamAccumulator::default();
        acc.feed(&json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "tool_use", "id": "tu_1", "name": "Read" }
        }));
        for fragment in ["{\"path\"", ": \"a.txt\"}"] {
            acc.feed(&json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": fragment }
            }));
        }
        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert_eq!(resp.tool_calls[0].arguments["path"], "a.txt");
    }

    #[test]
    fn test_build_request_thinking_budget() {
        let msgs = vec![WireMessage {
            role: "user".into(),
            content: "hello".into(),
            blocks: vec![],
            tool_calls: vec![],
            tool_call_id: None,
        }];
        let req_thinking = build_request_full("claude-3-7-sonnet-20250219", 4096, &msgs, &[], true, Some(4096));
        assert_eq!(req_thinking["thinking"]["type"], "enabled");
        assert_eq!(req_thinking["thinking"]["budget_tokens"], 4096);
        // max_tokens should be bumped if <= budget
        assert!(req_thinking["max_tokens"].as_u64().unwrap() > 4096);

        let req_no_thinking = build_request_full("claude-3-7-sonnet-20250219", 4096, &msgs, &[], true, None);
        assert!(req_no_thinking.get("thinking").is_none());
        assert_eq!(req_no_thinking["max_tokens"], 4096);
    }
}
