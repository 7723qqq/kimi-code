//! Google GenAI / Gemini API adapter.
//!
//! Translates between kimi-agent's internal wire formats and Google's
//! `models/{model}:generateContent` / `models/{model}:streamGenerateContent`
//! JSON schema with streaming SSE accumulation.

use serde_json::{Value, json};

use crate::llm::wire::{StreamDelta, WireMessage};
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build a Google GenAI request payload from the wire messages.
pub fn build_request(
    messages: &[WireMessage],
    tools: &[ToolInfo],
    thinking_budget: Option<u32>,
) -> Value {
    build_request_full(messages, tools, thinking_budget)
}

/// Build a full Google GenAI request body with optional thinking configuration.
pub fn build_request_full(
    messages: &[WireMessage],
    tools: &[ToolInfo],
    thinking_budget: Option<u32>,
) -> Value {
    let mut system = String::new();
    let mut contents: Vec<Value> = Vec::new();
    let mut tool_name_by_id = std::collections::HashMap::new();

    for m in messages {
        match m.role.as_str() {
            "system" => {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(&m.content);
            }
            "assistant" => {
                let mut parts: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    parts.push(json!({ "text": m.content }));
                }
                for tc in &m.tool_calls {
                    tool_name_by_id.insert(tc.id.clone(), tc.name.clone());
                    let mut fc = json!({
                        "functionCall": {
                            "name": tc.name,
                            "args": tc.arguments,
                        }
                    });
                    // Restore the Gemini attestation signature so the API
                    // accepts the echoed function call (v2
                    // google-genai.ts:274-276).
                    if let Some(extras) = &tc.extras
                        && let Some(sig) = extras
                            .get("thought_signature_b64")
                            .and_then(|s| s.as_str())
                    {
                        fc["functionCall"]["thought_signature"] = json!(sig);
                    }
                    parts.push(fc);
                }
                contents.push(json!({ "role": "model", "parts": parts }));
            }
            "tool" => {
                let call_id = m.tool_call_id.as_deref().unwrap_or_default();
                let tool_name = tool_name_by_id.get(call_id).cloned().unwrap_or_else(|| {
                    fallback_tool_name_from_id(call_id)
                });

                // Gemini 强制要求 functionResponse.response 必须为 JSON Object
                let response_obj = if let Ok(Value::Object(map)) = serde_json::from_str(&m.content) {
                    Value::Object(map)
                } else {
                    json!({ "output": m.content })
                };

                let part = json!({
                    "functionResponse": {
                        "name": tool_name,
                        "response": response_obj,
                    }
                });
                if let Some(last_msg) = contents.last_mut()
                    && last_msg.get("role").and_then(|r| r.as_str()) == Some("user")
                    && let Some(parts_arr) =
                        last_msg.get_mut("parts").and_then(|p| p.as_array_mut())
                {
                    parts_arr.push(part);
                } else {
                    contents.push(json!({ "role": "user", "parts": [part] }));
                }
            }
            _ => {
                let mut parts: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    parts.push(json!({ "text": m.content }));
                }
                for b in &m.blocks {
                    match b {
                        ContentBlock::Text { text } => parts.push(json!({ "text": text })),
                        ContentBlock::Image { media_type, data } => {
                            parts.push(json!({
                                "inlineData": {
                                    "mimeType": media_type,
                                    "data": data,
                                }
                            }));
                        }
                        ContentBlock::ImageUrl { url } => {
                            parts.push(convert_media_url(url, "image/png"));
                        }
                        ContentBlock::AudioUrl { url, .. } => {
                            parts.push(convert_media_url(url, "audio/mpeg"));
                        }
                        ContentBlock::VideoUrl { url, .. } => {
                            parts.push(convert_media_url(url, "video/mp4"));
                        }
                        ContentBlock::Think { .. } => {}
                    }
                }
                if parts.is_empty() {
                    parts.push(json!({ "text": "" }));
                }
                if let Some(last_msg) = contents.last_mut()
                    && last_msg.get("role").and_then(|r| r.as_str()) == Some("user")
                    && let Some(parts_arr) =
                        last_msg.get_mut("parts").and_then(|p| p.as_array_mut())
                {
                    parts_arr.extend(parts);
                } else {
                    contents.push(json!({ "role": "user", "parts": parts }));
                }
            }
        }
    }

    let mut req = json!({
        "contents": contents,
    });

    if !system.is_empty() {
        req["systemInstruction"] = json!({
            "parts": [{ "text": system }]
        });
    }

    if !tools.is_empty() {
        let funcs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                })
            })
            .collect();
        req["tools"] = json!([{ "functionDeclarations": funcs }]);
    }

    if let Some(budget) = thinking_budget
        && budget > 0
    {
        req["generationConfig"] = json!({
            "thinkingConfig": {
                "thinkingBudget": budget,
            }
        });
    }

    req
}

/// Convert a data URL or HTTP URL to a Google GenAI inline/file data part
/// (v2 `convertMediaUrl`, google-genai.ts:153-191):
/// - `data:` URLs are parsed into `{ inlineData: { mimeType, data } }`
/// - `http(s):` URLs use `{ fileData: { fileUri, mimeType } }`, with the
///   mime type guessed from the path extension when possible.
fn convert_media_url(url: &str, fallback_mime_type: &str) -> Value {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = match rest.find(',') {
            Some(idx) => (&rest[..idx], &rest[idx + 1..]),
            None => (rest, ""),
        };
        let mime_type = meta.split(';').next().unwrap_or(fallback_mime_type);
        return json!({ "inlineData": { "mimeType": mime_type, "data": data } });
    }
    let mime_type = guess_mime_from_url(url).unwrap_or(fallback_mime_type);
    json!({ "fileData": { "fileUri": url, "mimeType": mime_type } })
}

/// Guess a media mime type from a URL's path extension (v2
/// `convertMediaUrl` extension table, google-genai.ts:180-190).
fn guess_mime_from_url(url: &str) -> Option<&'static str> {
    let path = url::Url::parse(url).ok()?.path().to_ascii_lowercase();
    if path.ends_with(".png") {
        Some("image/png")
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if path.ends_with(".gif") {
        Some("image/gif")
    } else if path.ends_with(".webp") {
        Some("image/webp")
    } else if path.ends_with(".mp3") || path.ends_with(".mpeg") {
        Some("audio/mpeg")
    } else if path.ends_with(".wav") {
        Some("audio/wav")
    } else if path.ends_with(".ogg") {
        Some("audio/ogg")
    } else if path.ends_with(".mp4") {
        Some("video/mp4")
    } else if path.ends_with(".webm") {
        Some("video/webm")
    } else {
        None
    }
}

/// Parse a Google GenAI `generateContent` JSON response.
pub fn parse_response(v: &Value) -> Result<LLMChatResponse, String> {
    let candidate = v
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "missing candidates array in Google GenAI response".to_string())?;

    let finish_reason = candidate
        .get("finishReason")
        .and_then(|f| f.as_str())
        .map(|fr| match fr {
            "STOP" => "stop".to_string(),
            "MAX_TOKENS" => "length".to_string(),
            _ => fr.to_lowercase(),
        });

    let mut content = String::new();
    let mut thinking = Vec::new();
    let mut tool_calls = Vec::new();

    if let Some(parts) = candidate
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
    {
        for (i, part) in parts.iter().enumerate() {
            let is_thought = part
                .get("thought")
                .and_then(|t| t.as_bool())
                .unwrap_or(false);

            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                if is_thought {
                    thinking.push(ContentBlock::Think {
                        think: text.to_string(),
                        encrypted: None,
                    });
                } else {
                    content.push_str(text);
                }
            }

            if let Some(fc) = part.get("functionCall")
                && let Some(name) = fc.get("name").and_then(|n| n.as_str())
            {
                let arguments = fc.get("args").cloned().unwrap_or(json!({}));
                let id = fc
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}_{}", name, i));
                // Carry the Gemini attestation signature so the echoed
                // function call is accepted on the next request (v2
                // google-genai.ts:540-546).
                let extras = part
                    .get("thoughtSignature")
                    .or_else(|| part.get("thought_signature"))
                    .and_then(|s| s.as_str())
                    .map(|sig| json!({ "thought_signature_b64": sig }));
                tool_calls.push(ToolCall {
                    id,
                    name: name.to_string(),
                    arguments,
                    extras,
                });
            }
        }
    }

    let usage = parse_usage(v.get("usageMetadata"));

    Ok(LLMChatResponse {
        content,
        thinking,
        tool_calls,
        finish_reason,
        usage,
    })
}

fn parse_usage(usage: Option<&Value>) -> TokenUsage {
    let input_tokens = usage
        .and_then(|u| u.get("promptTokenCount"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = usage
        .and_then(|u| u.get("candidatesTokenCount"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let total_tokens = usage
        .and_then(|u| u.get("totalTokenCount"))
        .and_then(|x| x.as_u64())
        .map(|t| t as u32)
        .unwrap_or(input_tokens + output_tokens);
    let input_cache_read = usage
        .and_then(|u| u.get("cachedContentTokenCount"))
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

/// Accumulates Google GenAI `streamGenerateContent` stream chunks into a final
/// [`LLMChatResponse`].
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    thinking: String,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    usage: TokenUsage,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one stream chunk. Returns text or thinking delta if present.
    pub fn feed(&mut self, v: &Value) -> Option<StreamDelta> {
        if let Some(usage) = v.get("usageMetadata") {
            self.usage = parse_usage(Some(usage));
        }

        let candidate = v
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())?;

        if let Some(fr) = candidate.get("finishReason").and_then(|f| f.as_str()) {
            self.finish_reason = Some(match fr {
                "STOP" => "stop".to_string(),
                "MAX_TOKENS" => "length".to_string(),
                _ => fr.to_lowercase(),
            });
        }

        let parts = candidate
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())?;

        let mut returned_delta = None;

        for (i, part) in parts.iter().enumerate() {
            let is_thought = part
                .get("thought")
                .and_then(|t| t.as_bool())
                .unwrap_or(false);

            if let Some(text) = part.get("text").and_then(|t| t.as_str())
                && !text.is_empty()
            {
                if is_thought {
                    self.thinking.push_str(text);
                    if returned_delta.is_none() {
                        returned_delta = Some(StreamDelta::Think(text.to_string()));
                    }
                } else {
                    self.content.push_str(text);
                    if returned_delta.is_none() {
                        returned_delta = Some(StreamDelta::Text(text.to_string()));
                    }
                }
            }

            if let Some(fc) = part.get("functionCall")
                && let Some(name) = fc.get("name").and_then(|n| n.as_str())
            {
                let arguments = fc.get("args").cloned().unwrap_or(json!({}));
                let id = fc
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}_{}", name, self.tool_calls.len() + i));
                self.tool_calls.push(ToolCall {
                    id,
                    name: name.to_string(),
                    arguments,
                    extras: None,
                });
            }
        }

        returned_delta
    }

    /// Finalize the accumulated stream into a response.
    pub fn finish(self) -> LLMChatResponse {
        let mut thinking = Vec::new();
        if !self.thinking.is_empty() {
            thinking.push(ContentBlock::Think {
                think: self.thinking,
                encrypted: None,
            });
        }

        LLMChatResponse {
            content: self.content,
            thinking,
            tool_calls: self.tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
        }
    }
}

fn fallback_tool_name_from_id(call_id: &str) -> String {
    if call_id.is_empty() {
        return "tool".to_string();
    }
    if let Some(pos) = call_id.rfind('_') {
        let prefix = &call_id[..pos];
        if !prefix.is_empty() {
            return prefix.to_string();
        }
    }
    call_id.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_request_formats_system_contents_tools() {
        let messages = vec![
            WireMessage::text("system", "You are a bot"),
            WireMessage::text("user", "Hello"),
            WireMessage::assistant_tool_calls(
                "Let me check",
                vec![ToolCall {
                    id: "call_1".into(),
                    name: "Grep".into(),
                    arguments: json!({ "query": "abc" }),
                    extras: None,
                }],
            ),
            WireMessage::tool_result("Grep", "results: none"),
        ];

        let tools = vec![ToolInfo {
            name: "Grep".into(),
            description: "search regex".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let req = build_request_full(&messages, &tools, Some(2048));
        assert_eq!(
            req["systemInstruction"]["parts"][0]["text"],
            "You are a bot"
        );

        let contents = req["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "Hello");

        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["text"], "Let me check");
        assert_eq!(contents[1]["parts"][1]["functionCall"]["name"], "Grep");

        assert_eq!(contents[2]["role"], "user");
        assert_eq!(contents[2]["parts"][0]["functionResponse"]["name"], "Grep");

        let decls = req["tools"][0]["functionDeclarations"].as_array().unwrap();
        assert_eq!(decls[0]["name"], "Grep");

        assert_eq!(
            req["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            2048
        );
    }

    #[test]
    fn test_parse_response_and_stream_accumulator() {
        let mut acc = StreamAccumulator::new();
        let chunk1 = json!({
            "candidates": [{
                "content": {
                    "parts": [{ "thought": true, "text": "Reasoning step" }]
                }
            }]
        });
        let d1 = acc.feed(&chunk1);
        assert_eq!(d1, Some(StreamDelta::Think("Reasoning step".into())));

        let chunk2 = json!({
            "candidates": [{
                "content": {
                    "parts": [{ "text": "Final answer" }]
                },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 15,
                "candidatesTokenCount": 8,
                "totalTokenCount": 23
            }
        });
        let d2 = acc.feed(&chunk2);
        assert_eq!(d2, Some(StreamDelta::Text("Final answer".into())));

        let resp = acc.finish();
        assert_eq!(resp.content, "Final answer");
        assert_eq!(resp.thinking.len(), 1);
        assert_eq!(resp.finish_reason.as_deref(), Some("stop"));
        assert_eq!(resp.usage.input_tokens, 15);
        assert_eq!(resp.usage.output_tokens, 8);
    }

    #[test]
    fn test_parse_response_function_call_id_preservation() {
        let resp_with_id = json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "functionCall": {
                            "id": "call_exact_123",
                            "name": "Write",
                            "args": { "path": "test.txt", "content": "hello" }
                        }
                    }]
                }
            }]
        });
        let parsed = parse_response(&resp_with_id).unwrap();
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].id, "call_exact_123");
        assert_eq!(parsed.tool_calls[0].name, "Write");

        // Fallback without id
        let resp_no_id = json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "functionCall": {
                            "name": "Read",
                            "args": { "path": "test.txt" }
                        }
                    }]
                }
            }]
        });
        let parsed_no_id = parse_response(&resp_no_id).unwrap();
        assert_eq!(parsed_no_id.tool_calls[0].id, "Read_0");
    }

    #[test]
    fn test_build_request_maps_function_response_name_correctly() {
        let msgs = vec![
            WireMessage::text("user", "read this"),
            WireMessage {
                role: "assistant".into(),
                content: "".into(),
                blocks: vec![],
                tool_calls: vec![ToolCall {
                    id: "call_abc_123".into(),
                    name: "read_file".into(),
                    arguments: json!({ "path": "test.txt" }),
                    extras: None,
                }],
                tool_call_id: None,
            },
            WireMessage {
                role: "tool".into(),
                content: "file content here".into(),
                blocks: vec![],
                tool_calls: vec![],
                tool_call_id: Some("call_abc_123".into()),
            },
        ];

        let req = build_request(&msgs, &[], None);
        let contents = req["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);

        // 关键断言：第 3 条消息 (tool) 被映射为 user 角色，且 functionResponse.name 必须是工具名 read_file，而不是 call_abc_123！
        assert_eq!(contents[2]["role"], "user");
        let resp_part = &contents[2]["parts"][0]["functionResponse"];
        assert_eq!(resp_part["name"], "read_file");
        // 关键断言：response 必须为 JSON Object
        assert!(resp_part["response"].is_object());
        assert_eq!(resp_part["response"]["output"], "file content here");
    }

    /// URL media blocks project to `fileData` (http) / `inlineData` (data
    /// URL), with the mime type guessed from the path extension (v2
    /// `convertMediaUrl`, google-genai.ts:153-191).
    #[test]
    fn test_build_request_media_urls() {
        let messages = vec![WireMessage::with_blocks(
            "user",
            vec![
                ContentBlock::ImageUrl {
                    url: "https://example.com/photo.png".into(),
                },
                ContentBlock::AudioUrl {
                    url: "https://example.com/sound.mp3".into(),
                    id: None,
                },
                ContentBlock::VideoUrl {
                    url: "data:video/mp4;base64,AAAA".into(),
                    id: None,
                },
                ContentBlock::ImageUrl {
                    url: "https://example.com/unknown.bin".into(),
                },
            ],
        )];

        let req = build_request_full(&messages, &[], None);
        let parts = req["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 4);

        // http URL → fileData with extension-guessed mime.
        assert_eq!(
            parts[0]["fileData"]["fileUri"],
            "https://example.com/photo.png"
        );
        assert_eq!(parts[0]["fileData"]["mimeType"], "image/png");
        assert_eq!(parts[1]["fileData"]["mimeType"], "audio/mpeg");
        // data URL → inlineData with the declared mime.
        assert_eq!(parts[2]["inlineData"]["mimeType"], "video/mp4");
        assert_eq!(parts[2]["inlineData"]["data"], "AAAA");
        // Unknown extension falls back to the block's default mime.
        assert_eq!(parts[3]["fileData"]["mimeType"], "image/png");
    }

    /// Gemini `thoughtSignature` round-trips: `parse_response` captures it
    /// into `ToolCall.extras`, and `build_request` restores it on the echoed
    /// function call (v2 google-genai.ts:274-276, 540-546).
    #[test]
    fn test_thought_signature_roundtrip() {
        let resp = json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "functionCall": {
                            "name": "Grep",
                            "args": { "query": "x" },
                            "id": "fc_1"
                        },
                        "thoughtSignature": "sig-b64"
                    }]
                }
            }]
        });
        let parsed = parse_response(&resp).unwrap();
        assert_eq!(parsed.tool_calls.len(), 1);
        let extras = parsed.tool_calls[0].extras.as_ref().expect("extras captured");
        assert_eq!(extras["thought_signature_b64"], "sig-b64");

        let messages = vec![WireMessage::assistant_tool_calls(
            "",
            vec![ToolCall {
                id: "fc_1".into(),
                name: "Grep".into(),
                arguments: json!({ "query": "x" }),
                extras: Some(json!({ "thought_signature_b64": "sig-b64" })),
            }],
        )];
        let req = build_request_full(&messages, &[], None);
        let fc = &req["contents"][0]["parts"][0]["functionCall"];
        assert_eq!(fc["name"], "Grep");
        assert_eq!(fc["thought_signature"], "sig-b64");
    }
}
