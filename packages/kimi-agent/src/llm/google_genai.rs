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
                    parts.push(json!({
                        "functionCall": {
                            "name": tc.name,
                            "args": tc.arguments,
                        }
                    }));
                }
                contents.push(json!({ "role": "model", "parts": parts }));
            }
            "tool" => {
                let tool_name = m.tool_call_id.as_deref().unwrap_or("tool");
                let parsed_response: Value = serde_json::from_str(&m.content)
                    .unwrap_or_else(|_| json!({ "output": m.content }));
                let part = json!({
                    "functionResponse": {
                        "name": tool_name,
                        "response": parsed_response,
                    }
                });
                if let Some(last_msg) = contents.last_mut()
                    && last_msg.get("role").and_then(|r| r.as_str()) == Some("user")
                    && let Some(parts_arr) = last_msg.get_mut("parts").and_then(|p| p.as_array_mut())
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
                        _ => {}
                    }
                }
                if parts.is_empty() {
                    parts.push(json!({ "text": "" }));
                }
                if let Some(last_msg) = contents.last_mut()
                    && last_msg.get("role").and_then(|r| r.as_str()) == Some("user")
                    && let Some(parts_arr) = last_msg.get_mut("parts").and_then(|p| p.as_array_mut())
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
                let id = format!("{}_{}", name, i);
                tool_calls.push(ToolCall {
                    id,
                    name: name.to_string(),
                    arguments,
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
                let id = format!("{}_{}", name, self.tool_calls.len() + i);
                self.tool_calls.push(ToolCall {
                    id,
                    name: name.to_string(),
                    arguments,
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
        assert_eq!(req["systemInstruction"]["parts"][0]["text"], "You are a bot");

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

        assert_eq!(req["generationConfig"]["thinkingConfig"]["thinkingBudget"], 2048);
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
}
