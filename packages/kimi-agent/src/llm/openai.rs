//! OpenAI Chat Completions request projection and response parsing.
//!
//! Pure functions only — no HTTP. The transport layer (reqwest) and credential
//! wiring are added in a later step; these functions own the provider-specific
//! JSON shape and are unit-tested against fixtures.

use serde_json::{Value, json};

use crate::llm::wire::WireMessage;
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build an OpenAI Chat Completions request body.
///
/// - Assistant tool calls become `tool_calls[]` with `function.arguments`
///   serialized to a JSON **string** (OpenAI's encoding).
/// - Tool results become `{ role: "tool", tool_call_id, content }`.
/// - An assistant turn that only calls tools sends `content: null`.
pub fn build_request(model: &str, messages: &[WireMessage], tools: &[ToolInfo]) -> Value {
    build_request_with_options(model, messages, tools, false)
}

/// Build an OpenAI Chat Completions request body, optionally streaming.
/// Streaming requests set `stream_options.include_usage` so the final
/// chunk carries token usage.
pub fn build_request_with_options(
    model: &str,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
) -> Value {
    let msgs: Vec<Value> = messages.iter().map(project_message).collect();

    let mut req = json!({
        "model": model,
        "messages": msgs,
        "stream": stream,
    });
    if stream {
        req["stream_options"] = json!({ "include_usage": true });
    }

    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect();
        req["tools"] = json!(tool_defs);
    }

    req
}

fn project_message(m: &WireMessage) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("role".into(), json!(m.role));

    // Multimodal blocks project to the content-parts array form. An
    // assistant turn that only calls tools carries a null content per the
    // OpenAI schema; everything else carries its (possibly empty) text.
    if !m.blocks.is_empty() {
        let parts: Vec<Value> = m.blocks.iter().map(project_block).collect();
        obj.insert("content".into(), json!(parts));
    } else if m.role == "assistant" && !m.tool_calls.is_empty() && m.content.is_empty() {
        obj.insert("content".into(), Value::Null);
    } else {
        obj.insert("content".into(), json!(m.content));
    }

    if !m.tool_calls.is_empty() {
        let tcs: Vec<Value> = m
            .tool_calls
            .iter()
            .map(|tc| {
                json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        // OpenAI expects arguments as a JSON-encoded string.
                        "arguments": serde_json::to_string(&tc.arguments)
                            .unwrap_or_else(|_| "{}".to_string()),
                    }
                })
            })
            .collect();
        obj.insert("tool_calls".into(), json!(tcs));
    }

    if let Some(ref tcid) = m.tool_call_id {
        obj.insert("tool_call_id".into(), json!(tcid));
    }

    Value::Object(obj)
}

/// Project a single content block to the OpenAI content-parts form.
fn project_block(b: &ContentBlock) -> Value {
    match b {
        ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
        ContentBlock::Image { media_type, data } => json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{media_type};base64,{data}") },
        }),
        ContentBlock::ImageUrl { url } => json!({
            "type": "image_url",
            "image_url": { "url": url },
        }),
        ContentBlock::AudioUrl { url, id } => {
            let mut audio = json!({ "url": url });
            if let Some(id) = id {
                audio["id"] = Value::String(id.clone());
            }
            json!({ "type": "audio_url", "audio_url": audio })
        }
        ContentBlock::VideoUrl { url, id } => {
            let mut video = json!({ "url": url });
            if let Some(id) = id {
                video["id"] = Value::String(id.clone());
            }
            json!({ "type": "video_url", "video_url": video })
        }
    }
}

/// Parse an OpenAI Chat Completions (non-streaming) response.
pub fn parse_response(v: &Value) -> Result<LLMChatResponse, String> {
    let choice = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or("openai response missing choices[0]")?;
    let message = choice
        .get("message")
        .ok_or("openai response missing choices[0].message")?;

    let finish_reason = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .map(|s| s.to_string());

    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let mut tool_calls = Vec::new();
    if let Some(tcs) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in tcs {
            let id = tc
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let func = tc
                .get("function")
                .ok_or("openai tool_call missing function")?;
            let name = func
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            // arguments is a JSON string; parse it back to a value (tolerating
            // a malformed/partial string by falling back to an empty object).
            let args_str = func
                .get("arguments")
                .and_then(|x| x.as_str())
                .unwrap_or("{}");
            let arguments = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
            tool_calls.push(ToolCall {
                id,
                name,
                arguments,
            });
        }
    }

    Ok(LLMChatResponse {
        content,
        tool_calls,
        finish_reason,
        usage: parse_usage(v.get("usage")),
    })
}

fn parse_usage(usage: Option<&Value>) -> TokenUsage {
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let total_tokens = usage
        .and_then(|u| u.get("total_tokens"))
        .and_then(|x| x.as_u64())
        .map(|t| t as u32)
        .unwrap_or(input_tokens + output_tokens);
    // OpenAI reports cache hits under `prompt_tokens_details.cached_tokens`;
    // they are part of `prompt_tokens` and must not double-count `input`.
    let input_cache_read = usage
        .and_then(|u| u.get("prompt_tokens_details"))
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    TokenUsage {
        input_tokens,
        output_tokens,
        total_tokens,
        input_cache_read,
        input_cache_creation: 0,
    }
}

// ── Streaming (SSE) accumulation ───────────────────────────────────────

/// A tool call being accumulated across stream chunks, keyed by its
/// provider-assigned `index`.
#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Upper bound on tool calls a single streamed response may open. Generous
/// for real responses; small enough that a hostile `index` cannot exhaust
/// memory.
const MAX_STREAM_TOOL_CALLS: usize = 256;

/// Accumulates OpenAI Chat Completions stream chunks into a final
/// [`LLMChatResponse`]. Feed each SSE `data:` JSON payload to
/// [`StreamAccumulator::feed`]; text deltas are returned so the caller can
/// forward them to the host.
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    tool_calls: Vec<PartialToolCall>,
    finish_reason: Option<String>,
    usage: TokenUsage,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve the tool-call slot for a streamed index, or `None` when the
    /// index is implausible.
    ///
    /// The index comes from the provider, and growing the vec to satisfy an
    /// arbitrary one lets a single chunk allocate until the process dies —
    /// which in the napi build takes the host down with it.
    fn tool_call_slot(&mut self, index: usize) -> Option<&mut PartialToolCall> {
        if index >= MAX_STREAM_TOOL_CALLS {
            return None;
        }
        while self.tool_calls.len() <= index {
            self.tool_calls.push(PartialToolCall::default());
        }
        self.tool_calls.get_mut(index)
    }

    /// Feed one stream chunk. Returns the text delta contained in the
    /// chunk, if any.
    pub fn feed(&mut self, v: &Value) -> Option<String> {
        // The final usage-only chunk has an empty `choices` array.
        if let Some(usage) = v.get("usage")
            && !usage.is_null()
        {
            self.usage = parse_usage(Some(usage));
        }
        let choice = v
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())?;
        if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            self.finish_reason = Some(fr.to_string());
        }
        let delta = choice.get("delta")?;

        if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tcs {
                let index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                // An out-of-range index is dropped rather than honoured: it
                // would otherwise grow the vec without bound.
                let Some(slot) = self.tool_call_slot(index) else {
                    continue;
                };
                if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                    slot.id.push_str(id);
                }
                if let Some(func) = tc.get("function") {
                    if let Some(name) = func.get("name").and_then(|x| x.as_str()) {
                        slot.name.push_str(name);
                    }
                    if let Some(args) = func.get("arguments").and_then(|x| x.as_str()) {
                        slot.arguments.push_str(args);
                    }
                }
            }
        }

        let text = delta
            .get("content")
            .and_then(|c| c.as_str())
            .or_else(|| delta.get("reasoning_content").and_then(|c| c.as_str()))?;
        if text.is_empty() {
            return None;
        }
        self.content.push_str(text);
        Some(text.to_string())
    }

    /// Finalize the accumulated stream into a response.
    pub fn finish(self) -> LLMChatResponse {
        let tool_calls = self
            .tool_calls
            .into_iter()
            .filter(|tc| !tc.name.is_empty())
            .filter_map(|tc| {
                // A truncated stream leaves `arguments` unparseable — never
                // fabricate an empty-argument call (it would execute a tool
                // with no real inputs); drop the call instead.
                serde_json::from_str(&tc.arguments)
                    .ok()
                    .map(|arguments| ToolCall {
                        id: tc.id,
                        name: tc.name,
                        arguments,
                    })
            })
            .collect();
        LLMChatResponse {
            content: self.content,
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
    fn build_request_projects_roles_tools_and_stringifies_arguments() {
        let messages = vec![
            WireMessage::text("system", "sys"),
            WireMessage::text("user", "hi"),
            WireMessage::assistant_tool_calls(
                "",
                vec![ToolCall {
                    id: "call_1".into(),
                    name: "Read".into(),
                    arguments: json!({ "path": "a.txt" }),
                }],
            ),
            WireMessage::tool_result("call_1", "file body"),
        ];
        let tools = vec![ToolInfo {
            name: "Read".into(),
            description: "read a file".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let req = build_request("kimi-k2", &messages, &tools);

        assert_eq!(req["model"], "kimi-k2");
        assert_eq!(req["stream"], false);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);

        // Assistant with only tool calls -> content null, tool_calls present.
        let assistant = &msgs[2];
        assert!(assistant["content"].is_null());
        let tc = &assistant["tool_calls"][0];
        assert_eq!(tc["id"], "call_1");
        assert_eq!(tc["type"], "function");
        assert_eq!(tc["function"]["name"], "Read");
        // arguments must be a STRING, not an object.
        let args = tc["function"]["arguments"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(args).unwrap(),
            json!({ "path": "a.txt" })
        );

        // Tool result carries tool_call_id.
        let tool_msg = &msgs[3];
        assert_eq!(tool_msg["role"], "tool");
        assert_eq!(tool_msg["tool_call_id"], "call_1");
        assert_eq!(tool_msg["content"], "file body");

        // Tools projected under {type:function, function:{...}}.
        assert_eq!(req["tools"][0]["type"], "function");
        assert_eq!(req["tools"][0]["function"]["name"], "Read");
        assert_eq!(
            req["tools"][0]["function"]["parameters"],
            json!({ "type": "object" })
        );
    }

    #[test]
    fn build_request_omits_tools_when_empty() {
        let req = build_request("m", &[WireMessage::text("user", "x")], &[]);
        assert!(req.get("tools").is_none());
    }

    #[test]
    fn parse_response_extracts_tool_calls_finish_and_usage() {
        let v = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_9",
                        "type": "function",
                        "function": { "name": "Grep", "arguments": "{\"q\":\"foo\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19 }
        });

        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].id, "call_9");
        assert_eq!(parsed.tool_calls[0].name, "Grep");
        assert_eq!(parsed.tool_calls[0].arguments, json!({ "q": "foo" }));
        assert_eq!(parsed.usage.input_tokens, 12);
        assert_eq!(parsed.usage.output_tokens, 7);
        assert_eq!(parsed.usage.total_tokens, 19);
    }

    #[test]
    fn parse_response_extracts_cached_prompt_tokens() {
        let v = json!({
            "choices": [{ "message": { "role": "assistant", "content": "hi" }, "finish_reason": "stop" }],
            "usage": {
                "prompt_tokens": 40,
                "completion_tokens": 5,
                "total_tokens": 45,
                "prompt_tokens_details": { "cached_tokens": 30 }
            }
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.usage.input_cache_read, 30);
        assert_eq!(parsed.usage.input_tokens, 40);
        assert_eq!(parsed.usage.input_cache_creation, 0);
    }

    #[test]
    fn parse_usage_missing_details_defaults_cache_to_zero() {
        let parsed = parse_response(&json!({
            "choices": [{ "message": { "role": "assistant", "content": "hi" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 2 }
        }))
        .unwrap();
        assert_eq!(parsed.usage.input_cache_read, 0);
        assert_eq!(parsed.usage.input_cache_creation, 0);
    }

    #[test]
    fn parse_response_plain_text_has_no_tool_calls() {
        let v = json!({
            "choices": [{ "message": { "role": "assistant", "content": "hello" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 2 }
        });
        let parsed = parse_response(&v).unwrap();
        assert!(parsed.tool_calls.is_empty());
        assert_eq!(parsed.finish_reason.as_deref(), Some("stop"));
        // total_tokens absent -> derived from prompt + completion.
        assert_eq!(parsed.usage.total_tokens, 5);
    }

    #[test]
    fn parse_response_errors_on_missing_choices() {
        assert!(parse_response(&json!({})).is_err());
    }

    #[test]
    fn build_request_streaming_sets_stream_options() {
        let req = build_request_with_options("m", &[WireMessage::text("user", "x")], &[], true);
        assert_eq!(req["stream"], true);
        assert_eq!(req["stream_options"]["include_usage"], true);
    }

    #[test]
    fn build_request_projects_image_blocks() {
        use crate::turn_loop::types::ContentBlock;
        let msg = WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::Text {
                    text: "what is this?".into(),
                },
                ContentBlock::Image {
                    media_type: "image/png".into(),
                    data: "AAAA".into(),
                },
                ContentBlock::ImageUrl {
                    url: "https://example.com/x.png".into(),
                },
            ],
        );
        let req = build_request("m", &[msg], &[]);
        let content = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "what is this?");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(content[2]["image_url"]["url"], "https://example.com/x.png");
    }

    #[test]
    fn build_request_projects_audio_and_video_blocks() {
        use crate::turn_loop::types::ContentBlock;
        let msg = WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::AudioUrl {
                    url: "https://example.com/a.mp3".into(),
                    id: None,
                },
                ContentBlock::VideoUrl {
                    url: "https://example.com/v.mp4".into(),
                    id: Some("v1".into()),
                },
            ],
        );
        let req = build_request("m", &[msg], &[]);
        let content = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "audio_url");
        assert_eq!(content[0]["audio_url"]["url"], "https://example.com/a.mp3");
        assert!(content[0]["audio_url"].get("id").is_none());
        assert_eq!(content[1]["type"], "video_url");
        assert_eq!(content[1]["video_url"]["url"], "https://example.com/v.mp4");
        assert_eq!(content[1]["video_url"]["id"], "v1");
    }

    #[test]
    fn parse_response_extracts_content_text() {
        let v = json!({
            "choices": [{ "message": { "role": "assistant", "content": "hello" }, "finish_reason": "stop" }],
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.content, "hello");
    }

    #[test]
    fn stream_accumulator_collects_text_and_tool_calls() {
        let mut acc = StreamAccumulator::new();

        // Text deltas.
        let d1 = acc.feed(&json!({ "choices": [{ "delta": { "content": "Hel" } }] }));
        assert_eq!(d1.as_deref(), Some("Hel"));
        let d2 = acc.feed(&json!({ "choices": [{ "delta": { "content": "lo" } }] }));
        assert_eq!(d2.as_deref(), Some("lo"));

        // Tool call split across chunks (arguments arrive in fragments).
        acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "call_1", "function": { "name": "Grep", "arguments": "{\"q\":" } }
        ] } }] }));
        acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "\"foo\"}" } }
        ] } }] }));

        // Finish + usage-only chunk.
        acc.feed(&json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }));
        acc.feed(
            &json!({ "choices": [], "usage": { "prompt_tokens": 7, "completion_tokens": 3 } }),
        );

        let resp = acc.finish();
        assert_eq!(resp.content, "Hello");
        assert_eq!(resp.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call_1");
        assert_eq!(resp.tool_calls[0].name, "Grep");
        assert_eq!(resp.tool_calls[0].arguments, json!({ "q": "foo" }));
        assert_eq!(resp.usage.input_tokens, 7);
        assert_eq!(resp.usage.output_tokens, 3);
        assert_eq!(resp.usage.total_tokens, 10);
    }

    #[test]
    fn stream_accumulator_parallel_tool_calls_by_index() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "a", "function": { "name": "Read", "arguments": "{}" } },
            { "index": 1, "id": "b", "function": { "name": "Glob", "arguments": "{}" } }
        ] } }] }));
        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 2);
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert_eq!(resp.tool_calls[1].name, "Glob");
    }

    #[test]
    fn stream_accumulator_ignores_implausible_tool_call_index() {
        // The index comes from the provider; honouring an arbitrary one grew
        // the accumulator without bound until the process died.
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": "a", "function": { "name": "Read", "arguments": "{}" } },
            { "index": 50_000_000, "id": "b", "function": { "name": "Boom", "arguments": "{}" } }
        ] } }] }));
        assert!(acc.tool_calls.len() <= MAX_STREAM_TOOL_CALLS);
        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "Read");
    }

    #[test]
    fn finish_after_truncated_stream_keeps_partial_content() {
        // A provider that drops the stream mid-flight (no trailing usage
        // chunk and no [DONE]) must still surface the text received so far
        // instead of panicking or returning empty.
        let mut acc = StreamAccumulator::default();
        acc.feed(&json!({ "choices": [{ "delta": { "content": "hel" } }] }));
        acc.feed(&json!({ "choices": [{ "delta": { "content": "lo" } }] }));
        let resp = acc.finish();
        assert_eq!(resp.content, "hello");
        assert!(resp.finish_reason.is_none());
        assert_eq!(resp.usage.output_tokens, 0);
    }

    #[test]
    fn truncated_tool_call_arguments_are_dropped_not_fabricated() {
        // A stream cut inside the JSON arguments must NOT execute a tool call
        // with an empty argument object (e.g. Bash without a command).
        let mut acc = StreamAccumulator::default();
        acc.feed(&json!({
            "choices": [{
                "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "Bash", "arguments": "{\"command\": \"ech" } }] }
            }]
        }));
        acc.feed(&json!({
            "choices": [{
                "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "" } }] }
            }]
        }));
        let resp = acc.finish();
        assert!(resp.tool_calls.is_empty(), "truncated call must be dropped");
        assert!(resp.content.is_empty());
    }

    #[test]
    fn complete_tool_call_arguments_are_kept() {
        let mut acc = StreamAccumulator::default();
        acc.feed(&json!({
            "choices": [{
                "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "Read", "arguments": "{\"path\": \"a.txt\"}" } }] }
            }]
        }));
        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "Read");
        assert_eq!(resp.tool_calls[0].arguments["path"], "a.txt");
    }

    #[test]
    fn test_stream_accumulator_reasoning_content() {
        let mut acc = StreamAccumulator::default();
        let delta1 = acc.feed(&json!({
            "choices": [{
                "delta": { "reasoning_content": "Thinking about " }
            }]
        }));
        assert_eq!(delta1.as_deref(), Some("Thinking about "));

        let delta2 = acc.feed(&json!({
            "choices": [{
                "delta": { "content": "the solution." }
            }]
        }));
        assert_eq!(delta2.as_deref(), Some("the solution."));

        let resp = acc.finish();
        assert_eq!(resp.content, "Thinking about the solution.");
    }
}
