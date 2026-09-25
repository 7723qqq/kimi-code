//! OpenAI Responses API (`/v1/responses`) adapter.
//!
//! Handles OpenAI's structured responses endpoint with streaming SSE accumulation.

use serde_json::{Value, json};

use crate::llm::wire::{StreamDelta, WireMessage};
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// 判断模型是否在 Responses API 中要求使用 developer 角色替代 system 角色 (o1/o3/o4 系列)
pub fn uses_developer_role(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    lower.contains("o1") || lower.contains("o3") || lower.contains("o4")
}

/// Build an OpenAI `/v1/responses` request payload.
pub fn build_request_full(
    model: &str,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
    reasoning_effort: Option<&str>,
) -> Value {
    let mut input: Vec<Value> = Vec::new();
    let dev_role = uses_developer_role(model);

    for m in messages {
        match m.role.as_str() {
            "system" => {
                let role = if dev_role { "developer" } else { "system" };
                input.push(json!({
                    "type": "message",
                    "role": role,
                    "content": m.content,
                }));
            }
            "assistant" => {
                if !m.content.is_empty() {
                    input.push(json!({
                        "type": "message",
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
                            ContentBlock::Image {
                                media_type, data, ..
                            } => {
                                parts.push(json!({
                                    "type": "input_image",
                                    "image_url": format!("data:{};base64,{}", media_type, data),
                                }));
                            }
                            _ => {}
                        }
                    }
                    input.push(json!({
                        "type": "message",
                        "role": "user",
                        "content": parts,
                    }));
                } else {
                    input.push(json!({
                        "type": "message",
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

    // Same host-level tokens as the chat-completions body: `on` is the
    // boolean-model sentinel and has no wire meaning, while a declared
    // `none` / `minimal` / `xhigh` is a real effort the provider accepts.
    if let Some(effort) = crate::llm::effort::wire_reasoning_effort(reasoning_effort) {
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
                    // Absent or empty arguments are a valid no-args call;
                    // present-but-unparsable arguments are corruption — fail
                    // the parse instead of executing with a fabricated `{}`.
                    let arguments: Value = match item.get("arguments") {
                        None => json!({}),
                        Some(a) if a.as_str().is_some_and(|s| s.trim().is_empty()) => json!({}),
                        Some(Value::String(s)) => serde_json::from_str(s).map_err(|e| {
                            format!("function call '{name}' has invalid arguments ({e})")
                        })?,
                        Some(other) => other.clone(),
                    };
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        arguments,
                        extras: None,
                    });
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
                                    details_index: None,
                                    reasoning_key: None,
                                    details_summary: None,
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
        timing: None,
    })
}

fn parse_usage(usage: Option<&Value>) -> TokenUsage {
    let Some(u) = usage else {
        return TokenUsage::default();
    };

    let raw_input = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let output_tokens = u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;

    let input_cache_read = u
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;

    let input_tokens = raw_input.saturating_sub(input_cache_read);

    let total_tokens = u
        .get("total_tokens")
        .and_then(|x| x.as_u64())
        .map(|t| t as u32)
        .unwrap_or(input_tokens + output_tokens);

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
    /// Terminal transport-level failure observed mid-stream (truncated
    /// function-call arguments, `response.failed`). The transport must turn
    /// this into an `Err`, never into a silently completed empty answer.
    error: Option<String>,
    /// Tool-call argument fragments the last [`Self::feed`] carried, drained by
    /// the caller through [`Self::take_tool_call_deltas`].
    pending_tool_calls: Vec<StreamDelta>,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drain the tool-call argument fragments the last [`Self::feed`] carried,
    /// in arrival order.
    pub fn take_tool_call_deltas(&mut self) -> Vec<StreamDelta> {
        std::mem::take(&mut self.pending_tool_calls)
    }

    /// Feed an SSE event object from the responses stream.
    pub fn feed(&mut self, v: &Value) -> Option<StreamDelta> {
        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "response.output_text.delta" | "response.text.delta" | "response.output_item.delta" => {
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
                    // The call's id is announced before its arguments stream, so
                    // it is available here; without it the fragment could not be
                    // addressed to the tool-call entity.
                    if let Some(id) = self.current_call_id.clone() {
                        self.pending_tool_calls.push(StreamDelta::ToolCall {
                            id,
                            index: None,
                            arguments: delta.to_string(),
                        });
                    }
                }
            }
            "response.output_item.done" => {
                self.flush_current_tool_call();
            }
            "response.completed" | "response.incomplete" | "response.done" => {
                let resp = v.get("response").unwrap_or(v);
                self.finish_reason = resp
                    .get("status")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
                if let Some(usage) = resp.get("usage") {
                    self.usage = parse_usage(Some(usage));
                }
            }
            "response.failed" => {
                let resp = v.get("response").unwrap_or(v);
                let err_msg = resp
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("response.failed");
                self.finish_reason = Some(format!("failed: {err_msg}"));
                // A failed response is a terminal transport failure, not an
                // empty answer: record it so the transport returns Err even
                // if a caller feeds the accumulator without the shared
                // in-band-error pre-check.
                if self.error.is_none() {
                    self.error = Some(format!("responses stream failed: {err_msg}"));
                }
            }
            "error" => {
                let err_msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("stream error");
                self.finish_reason = Some(format!("failed: {err_msg}"));
                if self.error.is_none() {
                    self.error = Some(format!("responses stream error: {err_msg}"));
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
            // Fail closed on truncated arguments: executing a tool with a
            // fabricated `{}` (e.g. Bash/Write with empty params) is worse
            // than failing the turn. An empty argument stream is a valid
            // no-args call; a non-empty but unparsable one is corruption.
            let trimmed = self.current_call_args.trim();
            let arguments = if trimmed.is_empty() {
                json!({})
            } else {
                match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        if self.error.is_none() {
                            self.error = Some(format!(
                                "function call '{name}' has truncated (non-JSON) arguments ({e}); refusing to execute with fabricated empty arguments"
                            ));
                        }
                        self.current_call_args.clear();
                        return;
                    }
                }
            };
            self.tool_calls.push(ToolCall {
                id,
                name,
                arguments,
                extras: None,
            });
            self.current_call_args.clear();
        }
    }

    /// Terminal failure observed while accumulating, if any. The transport
    /// must return it as `Err` instead of completing the turn silently.
    pub fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }

    pub fn finish(mut self) -> LLMChatResponse {
        self.flush_current_tool_call();

        // Fail closed: a corrupted tool call (or a failed response) poisons
        // the whole turn. Handing upward a partial tool set — or an empty
        // answer with a "failed" finish reason — is what turned provider
        // failures into silent empty completions. The contentless, toolless,
        // reasonless response is mapped to `Err` by the transport.
        if self.error.is_some() {
            return LLMChatResponse {
                content: String::new(),
                thinking: Vec::new(),
                tool_calls: Vec::new(),
                finish_reason: None,
                usage: self.usage,
                timing: None,
            };
        }

        let mut thinking = Vec::new();
        if !self.thinking.is_empty() {
            thinking.push(ContentBlock::Think {
                think: self.thinking,
                encrypted: None,
                details_index: None,
                reasoning_key: None,
                details_summary: None,
            });
        }

        LLMChatResponse {
            content: self.content,
            thinking,
            tool_calls: self.tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
            timing: None,
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

    #[test]
    fn test_build_request_omits_host_level_efforts() {
        let messages = vec![WireMessage::text("user", "hi")];

        // `on` is the boolean-model sentinel, not a wire value; `off` means
        // thinking is disabled. Neither belongs in `reasoning.effort`.
        for effort in ["on", "off", ""] {
            let req = build_request_full("gpt-5", &messages, &[], true, Some(effort));
            assert!(
                req.get("reasoning").is_none(),
                "effort {effort:?} must not reach the wire"
            );
        }

        let req_none = build_request_full("gpt-5", &messages, &[], true, Some("none"));
        assert_eq!(req_none["reasoning"]["effort"], "none");
    }

    #[test]
    fn test_stream_accumulator_output_text_and_reasoning() {
        let mut acc = StreamAccumulator::new();
        let delta1 = acc.feed(&json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": "Thinking about it..."
        }));
        assert_eq!(
            delta1,
            Some(StreamDelta::Think("Thinking about it...".into()))
        );

        let delta2 = acc.feed(&json!({
            "type": "response.output_text.delta",
            "delta": "Hello world!"
        }));
        assert_eq!(delta2, Some(StreamDelta::Text("Hello world!".into())));

        acc.feed(&json!({
            "type": "response.completed",
            "response": {
                "status": "stop",
                "usage": {
                    "input_tokens": 15,
                    "output_tokens": 5,
                    "total_tokens": 20
                }
            }
        }));

        let resp = acc.finish();
        assert_eq!(resp.content, "Hello world!");
        assert_eq!(resp.finish_reason.as_deref(), Some("stop"));
        assert_eq!(resp.usage.input_tokens, 15);
        assert_eq!(resp.usage.output_tokens, 5);
        assert_eq!(resp.usage.total_tokens, 20);
        assert_eq!(resp.thinking.len(), 1);
    }

    #[test]
    fn test_stream_accumulator_tool_calls() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "call_id": "call_123",
                "name": "search"
            }
        }));
        acc.feed(&json!({
            "type": "response.function_call_arguments.delta",
            "delta": "{\"query\":"
        }));
        acc.feed(&json!({
            "type": "response.function_call_arguments.delta",
            "delta": "\"rust\"}"
        }));
        acc.feed(&json!({
            "type": "response.output_item.done"
        }));

        let resp = acc.finish();
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "search");
        assert_eq!(resp.tool_calls[0].id, "call_123");
        assert_eq!(resp.tool_calls[0].arguments["query"], "rust");
    }

    #[test]
    fn test_stream_accumulator_failure() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "type": "response.failed",
            "response": {
                "error": {
                    "message": "Rate limit exceeded"
                }
            }
        }));

        let mut resp_acc = acc;
        let err = resp_acc.take_error();
        assert!(
            err.is_some_and(|m| m.contains("Rate limit exceeded")),
            "a failed response must surface as a transport error, not an empty completion"
        );
        let _ = resp_acc.finish();
    }

    #[test]
    fn test_truncated_tool_call_arguments_are_an_error_not_empty_object() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "call_id": "call_9",
                "name": "Bash"
            }
        }));
        // Stream cut mid-arguments: `{"command": "rm -rf /tmp/x` never parses.
        acc.feed(&json!({
            "type": "response.function_call_arguments.delta",
            "delta": "{\"command\": \"rm -rf /tmp/x"
        }));

        // The corruption only materializes at flush time; the transport
        // surfaces mid-stream failures via take_error() and finish() refuses
        // to hand up a partial tool set.
        let resp = acc.finish();
        assert!(
            resp.tool_calls.is_empty() && resp.content.is_empty(),
            "the corrupted call must be dropped, not pushed with empty arguments"
        );
        assert!(
            resp.finish_reason.is_none(),
            "a poisoned turn must come back contentless/toolless/reasonless so the transport errors"
        );
    }

    #[test]
    fn test_empty_tool_call_arguments_stay_a_valid_no_args_call() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "call_id": "call_10",
                "name": "ListFiles"
            }
        }));
        acc.feed(&json!({ "type": "response.output_item.done" }));

        let mut acc2 = acc;
        assert!(acc2.take_error().is_none());
        let resp = acc2.finish();
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].arguments, json!({}));
    }

    #[test]
    fn test_parse_response_rejects_invalid_arguments() {
        let bad = json!({
            "status": "completed",
            "output": [{
                "type": "function_call",
                "call_id": "call_1",
                "name": "Write",
                "arguments": "{\"path\": \"/x"
            }]
        });
        assert!(
            parse_response(&bad).is_err(),
            "non-streaming invalid arguments must fail the parse, not become {{}}"
        );
        let no_args = json!({
            "status": "completed",
            "output": [{
                "type": "function_call",
                "call_id": "call_2",
                "name": "ListFiles"
            }]
        });
        let parsed = parse_response(&no_args).unwrap();
        assert_eq!(parsed.tool_calls[0].arguments, json!({}));
    }

    #[test]
    fn test_responses_developer_role_for_o1_o3() {
        let msgs = vec![
            WireMessage::text("system", "You are an expert coder."),
            WireMessage::text("user", "Hello o3"),
        ];
        let req_o3 = build_request_full("o3-mini", &msgs, &[], true, None);
        let input_o3 = req_o3["input"].as_array().unwrap();
        // o1/o3 模型断言：system 角色必须映射为 developer 且携带 type: message
        assert_eq!(input_o3[0]["type"], "message");
        assert_eq!(input_o3[0]["role"], "developer");
        assert_eq!(input_o3[0]["content"], "You are an expert coder.");
        assert_eq!(input_o3[1]["type"], "message");
        assert_eq!(input_o3[1]["role"], "user");

        // 普通模型保持 role: system
        let req_4o = build_request_full("gpt-4o", &msgs, &[], true, None);
        let input_4o = req_4o["input"].as_array().unwrap();
        assert_eq!(input_4o[0]["type"], "message");
        assert_eq!(input_4o[0]["role"], "system");
    }

    #[test]
    fn test_responses_usage_subtracts_cached_tokens() {
        let usage = json!({
            "input_tokens": 1000,
            "output_tokens": 50,
            "input_tokens_details": {
                "cached_tokens": 800
            }
        });
        let parsed = parse_usage(Some(&usage));
        assert_eq!(parsed.input_cache_read, 800);
        // 关键断言：未缓存输入 Token 必须正确扣减已缓存部分 (1000 - 800 = 200)
        assert_eq!(parsed.input_tokens, 200);
        assert_eq!(parsed.output_tokens, 50);
    }
}
