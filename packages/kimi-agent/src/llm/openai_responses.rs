//! OpenAI Responses API (`/v1/responses`) adapter.
//!
//! Handles OpenAI's structured responses endpoint with streaming SSE accumulation.

use serde_json::{Value, json};

use crate::llm::wire::{StreamDelta, WireMessage};
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build an OpenAI `/v1/responses` request payload.
pub fn build_request_full(
    model: &str,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
    reasoning_effort: Option<&str>,
) -> Value {
    let mut input: Vec<Value> = Vec::new();

    for m in messages {
        match m.role.as_str() {
            "system" => {
                input.push(json!({
                    "role": "system",
                    "content": m.content,
                }));
            }
            "assistant" => {
                if !m.content.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": m.content,
                    }));
                }
                for tc in &m.tool_calls {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": tc.id,
                        "name": tc.name,
                        "arguments": tc.arguments.to_string(),
                    }));
                }
            }
            "tool" => {
                let call_id = m.tool_call_id.as_deref().unwrap_or("call_default");
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": m.content,
                }));
            }
            _ => {
                if !m.blocks.is_empty() {
                    let mut parts = Vec::new();
                    for b in &m.blocks {
                        match b {
                            ContentBlock::Text { text } => {
                                parts.push(json!({ "type": "input_text", "text": text }));
                            }
                            ContentBlock::Image { media_type, data } => {
                                parts.push(json!({
                                    "type": "input_image",
                                    "image_url": format!("data:{};base64,{}", media_type, data),
                                }));
                            }
                            _ => {}
                        }
                    }
                    input.push(json!({
                        "role": "user",
                        "content": parts,
                    }));
                } else {
                    input.push(json!({
                        "role": "user",
                        "content": m.content,
                    }));
                }
            }
        }
    }

    let mut req = json!({
        "model": model,
        "input": input,
        "stream": stream,
    });

    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                })
            })
            .collect();
        req["tools"] = json!(tool_defs);
    }

    if let Some(effort) = reasoning_effort {
        req["reasoning"] = json!({ "effort": effort });
    }

    req
}

/// Parse an OpenAI `/v1/responses` non-streaming response.
pub fn parse_response(v: &Value) -> Result<LLMChatResponse, String> {
    let mut content = String::new();
    let mut thinking = Vec::new();
    let mut tool_calls = Vec::new();

    if let Some(output) = v.get("output").and_then(|o| o.as_array()) {
        for item in output {
            let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match item_type {
                "message" => {
                    if let Some(parts) = item.get("content").and_then(|c| c.as_array()) {
                        for p in parts {
                            if let Some(text) = p.get("text").and_then(|t| t.as_str()) {
                                content.push_str(text);
                            }
                        }
                    }
                }
                "function_call" => {
                    let id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(|i| i.as_str())
                        .unwrap_or("call_default")
                        .to_string();
                    let name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let arguments: Value = item
                        .get("arguments")
                        .and_then(|a| a.as_str())
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(json!({}));
                    tool_calls.push(ToolCall { id, name, arguments });
                }
                "reasoning" => {
                    let encrypted = item
                        .get("encrypted_content")
                        .and_then(|e| e.as_str())
                        .map(|s| s.to_string());
                    if let Some(summary) = item.get("summary").and_then(|s| s.as_array()) {
                        for sp in summary {
                            if let Some(text) = sp.get("text").and_then(|t| t.as_str()) {
                                thinking.push(ContentBlock::Think {
                                    think: text.to_string(),
                                    encrypted: encrypted.clone(),
                                });
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let finish_reason = v
        .get("status")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    let usage = parse_usage(v.get("usage"));

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
        .and_then(|u| u.get("input_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    let total_tokens = usage
        .and_then(|u| u.get("total_tokens"))
        .and_then(|x| x.as_u64())
        .map(|t| t as u32)
        .unwrap_or(input_tokens + output_tokens);

    let input_cache_read = usage
        .and_then(|u| u.get("input_tokens_details"))
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

// ── Streaming (SSE) accumulator for /v1/responses ─────────────────────

#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    thinking: String,
    current_call_id: Option<String>,
    current_call_name: Option<String>,
    current_call_args: String,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    usage: TokenUsage,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed an SSE event object from the responses stream.
    pub fn feed(&mut self, v: &Value) -> Option<StreamDelta> {
        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "response.text.delta" | "response.output_item.delta" => {
                if let Some(delta) = v.get("delta").and_then(|d| d.as_str()) {
                    self.content.push_str(delta);
                    return Some(StreamDelta::Text(delta.to_string()));
                }
            }
            "response.reasoning.delta" | "response.reasoning_summary_text.delta" => {
                if let Some(delta) = v.get("delta").and_then(|d| d.as_str()) {
                    self.thinking.push_str(delta);
                    return Some(StreamDelta::Think(delta.to_string()));
                }
            }
            "response.output_item.added" => {
                if let Some(item) = v.get("item")
                    && item.get("type").and_then(|t| t.as_str()) == Some("function_call")
                {
                    self.flush_current_tool_call();
                    self.current_call_id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(|i| i.as_str())
                        .map(|s| s.to_string());
                    self.current_call_name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string());
                    self.current_call_args.clear();
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(delta) = v.get("delta").and_then(|d| d.as_str()) {
                    self.current_call_args.push_str(delta);
                }
            }
            "response.output_item.done" => {
                self.flush_current_tool_call();
            }
            "response.done" => {
                if let Some(resp) = v.get("response") {
                    self.finish_reason = resp
                        .get("status")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    if let Some(usage) = resp.get("usage") {
                        self.usage = parse_usage(Some(usage));
                    }
                }
            }
            _ => {}
        }

        None
    }

    fn flush_current_tool_call(&mut self) {
        if let Some(name) = self.current_call_name.take() {
            let id = self
                .current_call_id
                .take()
                .unwrap_or_else(|| format!("call_{}", self.tool_calls.len()));
            let arguments: Value = serde_json::from_str(&self.current_call_args)
                .unwrap_or_else(|_| json!({}));
            self.tool_calls.push(ToolCall { id, name, arguments });
            self.current_call_args.clear();
        }
    }

    pub fn finish(mut self) -> LLMChatResponse {
        self.flush_current_tool_call();

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
    fn test_build_request_and_parse_response() {
        let messages = vec![
            WireMessage::text("system", "Be helpful"),
            WireMessage::text("user", "What is 2+2?"),
        ];
        let tools = vec![ToolInfo {
            name: "Calculator".into(),
            description: "math".into(),
            input_schema: json!({ "type": "object" }),
        }];

        let req = build_request_full("gpt-4o", &messages, &tools, true, Some("low"));
        assert_eq!(req["model"], "gpt-4o");
        assert_eq!(req["input"].as_array().unwrap().len(), 2);
        assert_eq!(req["tools"].as_array().unwrap().len(), 1);
        assert_eq!(req["reasoning"]["effort"], "low");

        let resp_json = json!({
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [{ "type": "text", "text": "4" }]
                }
            ],
            "usage": {
                "input_tokens": 10,
                "output_tokens": 2,
                "total_tokens": 12
            }
        });
        let parsed = parse_response(&resp_json).unwrap();
        assert_eq!(parsed.content, "4");
        assert_eq!(parsed.finish_reason.as_deref(), Some("completed"));
        assert_eq!(parsed.usage.total_tokens, 12);
    }
}
