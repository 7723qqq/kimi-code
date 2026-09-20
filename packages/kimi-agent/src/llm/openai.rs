//! OpenAI Chat Completions request projection and response parsing.
//!
//! Pure functions only — no HTTP. The transport layer (reqwest) and credential
//! wiring are added in a later step; these functions own the provider-specific
//! JSON shape and are unit-tested against fixtures.

use serde_json::{Value, json};

use crate::llm::wire::{StreamDelta, WireMessage};
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ContentBlock, LLMChatResponse, ToolCall, ToolInfo};

/// Build an OpenAI Chat Completions request body.
///
/// - Assistant tool calls become `tool_calls[]` with `function.arguments`
///   serialized to a JSON **string** (OpenAI's encoding).
/// - Tool results become `{ role: "tool", tool_call_id, content }`.
/// - An assistant turn that only calls tools sends `content: null`.
pub fn build_request(model: &str, messages: &[WireMessage], tools: &[ToolInfo]) -> Value {
    build_request_full(model, messages, tools, false, None, None, None)
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
    build_request_full(model, messages, tools, stream, None, None, None)
}

/// Build an OpenAI Chat Completions request body with streaming, optional
/// reasoning effort, and optional preserved-thinking passthrough
/// (`thinking.keep`; the host filters off-values and gates on Thinking).
///
/// `reasoning_key` is the model's declared reasoning field
/// (`[models.<alias>].reasoning_key`). When set, replayed think blocks go back
/// in that field instead of being flattened into the assistant text — v2
/// #3910 restores the provider's reasoning context rather than presenting the
/// model's own reasoning as prose.
pub fn build_request_full(
    model: &str,
    messages: &[WireMessage],
    tools: &[ToolInfo],
    stream: bool,
    reasoning_effort: Option<&str>,
    thinking_keep: Option<&str>,
    reasoning_key: Option<&str>,
) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .map(|message| project_message(message, reasoning_key))
        .collect();

    let mut req = json!({
        "model": model,
        "messages": msgs,
        "stream": stream,
    });
    if stream {
        req["stream_options"] = json!({ "include_usage": true });
    }
    if let Some(effort) = reasoning_effort
        && !effort.is_empty()
        && effort != "off"
        && effort != "none"
    {
        req["reasoning_effort"] = json!(effort);
    }
    if let Some(keep) = thinking_keep
        && !keep.is_empty()
    {
        // Moonshot preserved-thinking passthrough (`thinking.keep`):
        // merged onto the `thinking` object so a companion config set
        // alongside survives.
        let mut thinking = req.get("thinking").cloned().unwrap_or_else(|| json!({}));
        thinking["keep"] = json!(keep);
        req["thinking"] = thinking;
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

fn project_message(m: &WireMessage, reasoning_key: Option<&str>) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("role".into(), json!(m.role));

    // Replay: v2 `lowerMessage` (openai/lower.ts) partitions the assistant's
    // think parts by their stamp. A `detailsIndex` rebuilds the provider's
    // `reasoning_details` array; a `reasoningKey` accumulates into that
    // field; unstamped text goes to the model's declared key — and, with no
    // key declared, flattens into the content text (the fork's pre-#3910
    // fallback, kept for models that speak no reasoning dialect). Only when
    // no part carries any stamp does the whole thinking collapse into the
    // declared key.
    let think_blocks: Vec<&ContentBlock> = if m.role == "assistant" {
        m.blocks
            .iter()
            .filter(|block| matches!(block, ContentBlock::Think { .. }))
            .collect()
    } else {
        Vec::new()
    };
    let mut details: Vec<Value> = Vec::new();
    let mut string_fields: Vec<(String, String)> = Vec::new();
    let mut unstamped = String::new();
    let mut all_thinking = String::new();
    for block in &think_blocks {
        let ContentBlock::Think {
            think,
            encrypted,
            details_index,
            reasoning_key: part_key,
            hidden,
        } = block
        else {
            continue;
        };
        // v2 `lowerMessage`: a hidden part's text is already carried by the
        // string dialect, so it stays out of every string accumulation —
        // its array entry below still stands.
        let hidden = hidden == &Some(true);
        if !hidden {
            all_thinking.push_str(think);
        }
        if details_index.is_some() {
            if !think.is_empty() {
                details.push(json!({ "type": "summary", "summary": think }));
            }
            if let Some(encrypted) = encrypted {
                details.push(json!({ "type": "encrypted", "encrypted": encrypted }));
            }
            continue;
        }
        if let Some(key) = part_key
            .as_deref()
            .filter(|key| *key != REASONING_DETAILS_KEY)
        {
            if !hidden {
                push_string_field(&mut string_fields, key, think);
            }
            continue;
        }
        if !hidden {
            unstamped.push_str(think);
        }
    }
    let redirected = reasoning_key.is_some() || !details.is_empty() || !string_fields.is_empty();
    if redirected && !unstamped.is_empty() {
        // The declared key is where unstamped text goes. Without a declared
        // key it still has a home when the message speaks the details
        // dialect — the default field — and only a message with no dialect
        // at all flattens the text into the content array.
        let key = match reasoning_key {
            Some(key) => Some(key.to_string()),
            None if !details.is_empty() => Some(DEFAULT_REASONING_KEY.to_string()),
            None => None,
        };
        if let Some(key) = key {
            push_string_field(&mut string_fields, &key, &unstamped);
        }
    }

    // Multimodal blocks project to the content-parts array form. An
    // assistant turn that only calls tools carries a null content per the
    // OpenAI schema; everything else carries its (possibly empty) text.
    if !m.blocks.is_empty() {
        let parts: Vec<Value> = m
            .blocks
            .iter()
            .filter(|block| !redirected || !matches!(block, ContentBlock::Think { .. }))
            .map(project_block)
            .collect();
        if parts.is_empty() {
            obj.insert("content".into(), Value::Null);
        } else {
            obj.insert("content".into(), json!(parts));
        }
    } else if m.role == "assistant" && !m.tool_calls.is_empty() && m.content.is_empty() {
        obj.insert("content".into(), Value::Null);
    } else {
        obj.insert("content".into(), json!(m.content));
    }
    if !details.is_empty() {
        obj.insert(REASONING_DETAILS_KEY.into(), json!(details));
        // v2: the default key carries its own string field when one was
        // accumulated, and the whole thinking otherwise.
        let default_value = string_field(&string_fields, DEFAULT_REASONING_KEY)
            .cloned()
            .unwrap_or_else(|| all_thinking.clone());
        obj.insert(DEFAULT_REASONING_KEY.into(), json!(default_value));
    }
    for (key, value) in &string_fields {
        obj.insert(key.clone(), json!(value));
    }
    if !redirected && !all_thinking.is_empty() {
        // No stamp and no declared key: the thinking stays flattened in the
        // content array (the fork's pre-#3910 fallback). A declared key
        // takes the whole thinking, the way it always did.
        if let Some(key) = reasoning_key {
            obj.insert(key.to_string(), json!(all_thinking));
        }
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

/// The provider field the `reasoning_details` array dialect lives in (v2
/// `REASONING_DETAILS_KEY`).
pub const REASONING_DETAILS_KEY: &str = "reasoning_details";

/// The provider field unstamped reasoning text defaults to (v2
/// `DEFAULT_REASONING_KEY`).
pub const DEFAULT_REASONING_KEY: &str = "reasoning_content";

/// Accumulate `text` into the per-key string field, creating it on first
/// sight (v2 `lowerMessage`'s `stringFields` — a keyed part with empty text
/// still creates its field, the way v2's does).
fn push_string_field(fields: &mut Vec<(String, String)>, key: &str, text: &str) {
    if let Some(entry) = fields.iter_mut().find(|(existing, _)| existing == key) {
        entry.1.push_str(text);
    } else {
        fields.push((key.to_string(), text.to_string()));
    }
}

fn string_field<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a String> {
    fields
        .iter()
        .find(|(existing, _)| existing == key)
        .map(|(_, value)| value)
}

/// Project a single content block to the OpenAI content-parts form.
fn project_block(b: &ContentBlock) -> Value {
    match b {
        ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
        ContentBlock::Image {
            media_type, data, ..
        } => json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{media_type};base64,{data}") },
        }),
        ContentBlock::ImageUrl { url, id, .. } => {
            let mut image = json!({ "url": url });
            if let Some(id) = id {
                image["id"] = Value::String(id.clone());
            }
            json!({ "type": "image_url", "image_url": image })
        }
        ContentBlock::AudioUrl { url, id, .. } => {
            let mut audio = json!({ "url": url });
            if let Some(id) = id {
                audio["id"] = Value::String(id.clone());
            }
            json!({ "type": "audio_url", "audio_url": audio })
        }
        ContentBlock::VideoUrl { url, id, .. } => {
            let mut video = json!({ "url": url });
            if let Some(id) = id {
                video["id"] = Value::String(id.clone());
            }
            json!({ "type": "video_url", "video_url": video })
        }
        ContentBlock::Think { think, .. } => json!({ "type": "text", "text": think }),
        // A reference that reached the wire was never resolved: the resolver
        // runs before every request. Degrade visibly rather than hand the
        // provider a `kimi-file://` URL it cannot fetch.
        ContentBlock::MediaRef { kind, .. } => json!({
            "type": "text",
            "text": crate::llm::media_resolver::unavailable_text(*kind),
        }),
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
                extras: None,
            });
        }
    }

    let mut thinking = Vec::new();
    let reasoning = message
        .get("reasoning_content")
        .and_then(|c| c.as_str())
        .or_else(|| message.get("reasoning").and_then(|c| c.as_str()));
    if let Some(think) = reasoning
        && !think.is_empty()
    {
        thinking.push(ContentBlock::Think {
            think: think.to_string(),
            encrypted: None,
            details_index: None,
            reasoning_key: None,
            hidden: None,
        });
    }

    Ok(LLMChatResponse {
        content,
        thinking,
        tool_calls,
        finish_reason,
        usage: parse_usage(v.get("usage")),
    })
}

fn parse_usage(usage: Option<&Value>) -> TokenUsage {
    let Some(u) = usage else {
        return TokenUsage::default();
    };

    let prompt_tokens = u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let output_tokens = u
        .get("completion_tokens")
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;

    let mut cached = 0u32;
    let mut miss: Option<u32> = None;

    // 1. DeepSeek 专有字段：顶层 prompt_cache_hit_tokens / prompt_cache_miss_tokens
    if let Some(hit) = u.get("prompt_cache_hit_tokens").and_then(|x| x.as_u64()) {
        cached = hit as u32;
        if let Some(m) = u.get("prompt_cache_miss_tokens").and_then(|x| x.as_u64()) {
            miss = Some(m as u32);
        }
    } else if let Some(top_cached) = u.get("cached_tokens").and_then(|x| x.as_u64()) {
        // 2. Moonshot AI (Kimi) 专有字段：顶层 cached_tokens
        cached = top_cached as u32;
    } else if let Some(details) = u.get("prompt_tokens_details") {
        // 3. OpenAI 官方规范字段：prompt_tokens_details.cached_tokens
        if let Some(detail_cached) = details.get("cached_tokens").and_then(|x| x.as_u64()) {
            cached = detail_cached as u32;
        }
    }

    let input_tokens = match miss {
        Some(m) => m,
        None => prompt_tokens.saturating_sub(cached),
    };

    TokenUsage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
        input_cache_read: cached,
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
/// [`StreamAccumulator::feed`]; text or thinking deltas are returned so the caller can
/// forward them to the host.
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    thinking: String,
    /// Think parts extracted from the provider's `reasoning_details` array
    /// dialect, stamped with their position (v2 #3910's unported half). They
    /// ride the final message beside the unstamped `thinking` text so the
    /// replay can rebuild the array.
    stamped: Vec<ContentBlock>,
    /// Whether the stream carried the `reasoning_content` string dialect
    /// (v2's `seenReasoningContent`): the details-derived summaries are then
    /// stamped `hidden`, so the replay does not send the same reasoning
    /// twice.
    seen_reasoning_content: bool,
    tool_calls: Vec<PartialToolCall>,
    finish_reason: Option<String>,
    usage: TokenUsage,
    /// The wire field carrying reasoning content for this model
    /// (`[models.<alias>].reasoning_key`); the built-in probe list is the
    /// fallback when the model declares none.
    reasoning_key: Option<String>,
    /// Tool-call argument fragments the last [`Self::feed`] carried, drained by
    /// the caller through [`Self::take_tool_call_deltas`]. Kept out of `feed`'s
    /// return value so a text-only chunk allocates nothing.
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

    /// Declare the model's reasoning field: it is then the only field read, so
    /// a gateway that returns reasoning under a non-standard name still
    /// surfaces it as thinking.
    pub fn with_reasoning_key(mut self, key: Option<&str>) -> Self {
        self.reasoning_key = key.map(str::to_string);
        self
    }

    /// The reasoning text in one delta: the model's declared field when it
    /// declares one, otherwise the probe list of names gateways are known to
    /// use.
    fn reasoning_delta<'a>(&self, delta: &'a Value) -> Option<&'a str> {
        if let Some(key) = self.reasoning_key.as_deref() {
            return delta.get(key).and_then(|c| c.as_str());
        }
        delta
            .get("reasoning_content")
            .and_then(|c| c.as_str())
            .or_else(|| delta.get("reasoning").and_then(|c| c.as_str()))
            .or_else(|| delta.get("reasoning_text").and_then(|c| c.as_str()))
            .or_else(|| delta.get("thought").and_then(|c| c.as_str()))
    }

    /// Whether this delta carried the `reasoning_content` string (v2's
    /// `seenReasoningContent`): once it has, the details-derived summaries
    /// are stamped `hidden` — the replay keeps their array entries but
    /// leaves their text out of the string fields.
    fn reasoning_content_seen(&self, delta: &Value) -> bool {
        delta
            .get("reasoning_content")
            .and_then(|c| c.as_str())
            .is_some_and(|text| !text.is_empty())
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

    /// Feed one stream chunk. Returns the text or thinking delta contained in the
    /// chunk, if any.
    pub fn feed(&mut self, v: &Value) -> Option<StreamDelta> {
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
                let id_fragment = tc.get("id").and_then(|x| x.as_str());
                let function = tc.get("function");
                let name_fragment = function
                    .and_then(|f| f.get("name"))
                    .and_then(|x| x.as_str());
                let arguments_fragment = function
                    .and_then(|f| f.get("arguments"))
                    .and_then(|x| x.as_str());
                // An out-of-range index is dropped rather than honoured: it
                // would otherwise grow the vec without bound.
                let Some(slot) = self.tool_call_slot(index) else {
                    continue;
                };
                if let Some(id) = id_fragment {
                    slot.id.push_str(id);
                }
                if let Some(name) = name_fragment {
                    slot.name.push_str(name);
                }
                if let Some(args) = arguments_fragment {
                    slot.arguments.push_str(args);
                }
                // The fragment goes out with the id accumulated so far: the id
                // itself arrives once, the arguments keep coming.
                if let Some(args) = arguments_fragment {
                    let id = slot.id.clone();
                    self.pending_tool_calls.push(StreamDelta::ToolCall {
                        id,
                        index: Some(index),
                        arguments: args.to_string(),
                    });
                }
            }
        }

        let mut think_delta = None;
        if let Some(think) = self.reasoning_delta(delta)
            && !think.is_empty()
        {
            self.thinking.push_str(think);
            think_delta = Some(StreamDelta::Think(think.to_string()));
        }
        // v2 `seenReasoningContent`: once the `reasoning_content` string has
        // been seen, the details-derived summaries are stamped `hidden` —
        // the replay keeps their array entries but leaves their text out of
        // the string fields, so the provider does not see the same reasoning
        // twice.
        if self.reasoning_content_seen(delta) {
            self.seen_reasoning_content = true;
        }
        // v2 `extractReasoningDetails`: a model that declares no reasoning
        // key speaks the raw `reasoning_details` dialect — each array
        // element becomes a think part stamped with its position, which the
        // request replay rebuilds into the array (v2 #3910's unported half).
        // The stamps ride the final message only; the live stream shows the
        // string dialect, and a stamped part has no string form to show.
        if self.reasoning_key.is_none() {
            self.stamped
                .extend(reasoning_details_parts(delta, self.seen_reasoning_content));
        }
        if let Some(delta) = think_delta {
            return Some(delta);
        }

        if let Some(text) = delta.get("content").and_then(|c| c.as_str())
            && !text.is_empty()
        {
            self.content.push_str(text);
            return Some(StreamDelta::Text(text.to_string()));
        }

        None
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
                        extras: None,
                    })
            })
            .collect();

        let thinking = if self.thinking.is_empty() {
            Vec::new()
        } else {
            vec![ContentBlock::Think {
                think: self.thinking,
                encrypted: None,
                details_index: None,
                reasoning_key: None,
                hidden: None,
            }]
        };
        let mut thinking = thinking;
        // The stamped parts follow the unstamped text: the replay partitions
        // by stamp, so the order only affects how a reader folds them.
        thinking.extend(self.stamped);

        LLMChatResponse {
            content: self.content,
            thinking,
            tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
        }
    }
}

/// The think parts a delta's `reasoning_details` array names (v2
/// `extractReasoningDetails` + `convertReasoningDetails`): each element's
/// position is the part's `detailsIndex`, a summary element carries its
/// text, an encrypted element its attestation. An element that is neither
/// is dropped, the way v2's converter drops it.
/// The think parts a delta's `reasoning_details` array names (v2
/// `extractReasoningDetails` + `convertReasoningDetails`): each element's
/// position is the part's `detailsIndex`, a summary element carries its
/// text, an encrypted element its attestation. An element that is neither
/// is dropped, the way v2's converter drops it. `hidden_summary` stamps the
/// summary parts hidden — the string dialect already carried them (v2's
/// `seenReasoningContent`).
fn reasoning_details_parts(delta: &Value, hidden_summary: bool) -> Vec<ContentBlock> {
    let Some(array) = delta.get(REASONING_DETAILS_KEY).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    for (index, element) in array.iter().enumerate() {
        let kind = element
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let summary = element.get("summary").and_then(Value::as_str);
        let encrypted = element.get("encrypted").and_then(Value::as_str);
        let stamped =
            |think: String, encrypted: Option<String>, hidden: Option<bool>| ContentBlock::Think {
                think,
                encrypted,
                details_index: Some(index as u32),
                reasoning_key: Some(REASONING_DETAILS_KEY.to_string()),
                hidden,
            };
        if kind != "encrypted" && summary.is_some_and(|text| !text.is_empty()) {
            parts.push(stamped(
                summary.unwrap_or_default().to_string(),
                None,
                hidden_summary.then_some(true),
            ));
        }
        if kind != "summary" && encrypted.is_some_and(|text| !text.is_empty()) {
            parts.push(stamped(
                String::new(),
                Some(encrypted.unwrap_or_default().to_string()),
                None,
            ));
        }
    }
    parts
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
                    extras: None,
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
        assert_eq!(parsed.usage.input_tokens, 10);
        assert_eq!(parsed.usage.total_tokens, 15);
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

    /// v2 #3910: a declared reasoning field takes the model's thinking back on
    /// the next request instead of flattening it into assistant prose. Without
    /// a declared key the old text fallback stands (the OpenAI family has no
    /// standard reasoning-in slot).
    #[test]
    fn replayed_thinking_rides_the_declared_reasoning_field() {
        let assistant = WireMessage {
            role: "assistant".into(),
            content: String::new(),
            blocks: vec![
                ContentBlock::Think {
                    think: "I should add the numbers first.".into(),
                    encrypted: None,
                    details_index: None,
                    reasoning_key: None,
                    hidden: None,
                },
                ContentBlock::Text {
                    text: "The answer is 7.".into(),
                },
            ],
            tool_calls: Vec::new(),
            tool_call_id: None,
        };
        let messages = vec![assistant];

        let req = build_request_full(
            "m",
            &messages,
            &[],
            true,
            None,
            None,
            Some("reasoning_content"),
        );
        let first = &req["messages"][0];
        assert_eq!(
            first["reasoning_content"], "I should add the numbers first.",
            "the think block rides the declared field"
        );
        // The redirected block is not duplicated in the content array.
        let parts = first["content"].as_array().unwrap();
        assert_eq!(parts.len(), 1, "only the text block remains in content");
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["text"], "The answer is 7.");

        // Without a declared key the old fallback stands: thinking stays in the
        // content array as text, and no reasoning field is invented.
        let req = build_request_full("m", &messages, &[], true, None, None, None);
        let parts = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert!(req["messages"][0].get("reasoning_content").is_none());
    }

    /// v2 #3910's unported half: think parts stamped with a `detailsIndex`
    /// replay as the provider's `reasoning_details` array (summary +
    /// encrypted entries), with the default reasoning field carrying the
    /// unstamped text — instead of every part collapsing into one string.
    #[test]
    fn stamped_think_parts_replay_as_the_reasoning_details_array() {
        let assistant = WireMessage {
            role: "assistant".into(),
            content: String::new(),
            blocks: vec![
                ContentBlock::Think {
                    think: "weighing options".into(),
                    encrypted: None,
                    details_index: Some(0),
                    reasoning_key: Some("reasoning_details".into()),
                    hidden: None,
                },
                ContentBlock::Think {
                    think: String::new(),
                    encrypted: Some("sig-abc".into()),
                    details_index: Some(1),
                    reasoning_key: Some("reasoning_details".into()),
                    hidden: None,
                },
                ContentBlock::Think {
                    think: "and the plain rest".into(),
                    encrypted: None,
                    details_index: None,
                    reasoning_key: None,
                    hidden: None,
                },
                ContentBlock::Text {
                    text: "done".into(),
                },
            ],
            tool_calls: Vec::new(),
            tool_call_id: None,
        };

        let req = build_request_full("m", &[assistant], &[], true, None, None, None);
        let first = &req["messages"][0];
        assert_eq!(
            first["reasoning_details"],
            json!([
                { "type": "summary", "summary": "weighing options" },
                { "type": "encrypted", "encrypted": "sig-abc" },
            ]),
        );
        // The default field carries the unstamped text; the stamped parts
        // are not duplicated into the content array.
        assert_eq!(first["reasoning_content"], "and the plain rest");
        let parts = first["content"].as_array().unwrap();
        assert_eq!(parts.len(), 1, "only the text block remains in content");
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["text"], "done");
    }

    /// A part naming its own reasoning field accumulates into that field
    /// (v2 `lowerMessage`'s per-key string fields), not the default one.
    #[test]
    fn keyed_think_parts_replay_into_their_own_field() {
        let assistant = WireMessage {
            role: "assistant".into(),
            content: String::new(),
            blocks: vec![
                ContentBlock::Think {
                    think: "first ".into(),
                    encrypted: None,
                    details_index: None,
                    reasoning_key: Some("reasoning".into()),
                    hidden: None,
                },
                ContentBlock::Think {
                    think: "second".into(),
                    encrypted: None,
                    details_index: None,
                    reasoning_key: Some("reasoning".into()),
                    hidden: None,
                },
            ],
            tool_calls: Vec::new(),
            tool_call_id: None,
        };

        let req = build_request_full("m", &[assistant], &[], true, None, None, None);
        let first = &req["messages"][0];
        assert_eq!(first["reasoning"], "first second");
        assert!(first.get("reasoning_content").is_none());
        assert!(first["content"].is_null(), "no non-think block remains");
    }

    /// The parse side of the dialect: a delta carrying a
    /// `reasoning_details` array (a model that declares no reasoning key)
    /// yields think parts stamped with their position, which the replay
    /// above rebuilds.
    #[test]
    fn a_reasoning_details_delta_produces_stamped_think_parts() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "choices": [{ "delta": {
                "reasoning_details": [
                    { "type": "summary", "summary": "step one" },
                    { "type": "encrypted", "encrypted": "sig-1" },
                    { "type": "other" },
                ],
            } }],
        }));
        let response = acc.finish();
        assert_eq!(
            response.thinking,
            vec![
                ContentBlock::Think {
                    think: "step one".into(),
                    encrypted: None,
                    details_index: Some(0),
                    reasoning_key: Some("reasoning_details".into()),
                    hidden: None,
                },
                ContentBlock::Think {
                    think: String::new(),
                    encrypted: Some("sig-1".into()),
                    details_index: Some(1),
                    reasoning_key: Some("reasoning_details".into()),
                    hidden: None,
                },
            ],
            "an element that is neither summary nor encrypted is dropped"
        );
    }

    /// v2 `seenReasoningContent`: once the stream carried the
    /// `reasoning_content` string, the details-derived summaries are stamped
    /// hidden — the replay keeps their array entries but leaves their text
    /// out of the string fields, so the provider does not see the same
    /// reasoning twice.
    #[test]
    fn a_hidden_summary_keeps_its_array_entry_but_not_its_string() {
        let mut acc = StreamAccumulator::new();
        acc.feed(&json!({
            "choices": [{ "delta": { "reasoning_content": "the short form" } }],
        }));
        acc.feed(&json!({
            "choices": [{ "delta": {
                "reasoning_details": [{ "type": "summary", "summary": "the long form" }],
            } }],
        }));
        let response = acc.finish();
        assert_eq!(
            response.thinking,
            vec![
                ContentBlock::Think {
                    think: "the short form".into(),
                    encrypted: None,
                    details_index: None,
                    reasoning_key: None,
                    hidden: None,
                },
                ContentBlock::Think {
                    think: "the long form".into(),
                    encrypted: None,
                    details_index: Some(0),
                    reasoning_key: Some("reasoning_details".into()),
                    hidden: Some(true),
                },
            ],
        );

        let req = build_request_full(
            "m",
            &[WireMessage {
                role: "assistant".into(),
                content: String::new(),
                blocks: response.thinking,
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
            &[],
            true,
            None,
            None,
            None,
        );
        let first = &req["messages"][0];
        // The array entry stands; the hidden text stays out of the string.
        assert_eq!(
            first["reasoning_details"],
            json!([{ "type": "summary", "summary": "the long form" }]),
        );
        assert_eq!(first["reasoning_content"], "the short form");
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
                    name: None,
                },
                ContentBlock::ImageUrl {
                    url: "https://example.com/x.png".into(),
                    id: None,
                    name: None,
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
                    name: None,
                },
                ContentBlock::VideoUrl {
                    url: "https://example.com/v.mp4".into(),
                    id: Some("v1".into()),
                    name: None,
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
        assert_eq!(d1, Some(StreamDelta::Text("Hel".into())));
        let d2 = acc.feed(&json!({ "choices": [{ "delta": { "content": "lo" } }] }));
        assert_eq!(d2, Some(StreamDelta::Text("lo".into())));

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
        assert_eq!(delta1, Some(StreamDelta::Think("Thinking about ".into())));

        let delta2 = acc.feed(&json!({
            "choices": [{
                "delta": { "content": "the solution." }
            }]
        }));
        assert_eq!(delta2, Some(StreamDelta::Text("the solution.".into())));

        let resp = acc.finish();
        assert_eq!(resp.content, "the solution.");
        assert_eq!(resp.thinking.len(), 1);
        assert_eq!(
            resp.thinking[0],
            ContentBlock::Think {
                think: "Thinking about ".into(),
                encrypted: None,
                details_index: None,
                reasoning_key: None,
                hidden: None,
            }
        );
    }

    #[test]
    fn declared_reasoning_key_is_read_before_the_probe_list() {
        // A gateway that returns reasoning under a non-standard field: the
        // declared key wins over the built-in probe list.
        let mut declared = StreamAccumulator::new().with_reasoning_key(Some("thinking_text"));
        let delta = declared.feed(&json!({
            "choices": [{ "delta": { "thinking_text": "step by step" } }]
        }));
        assert_eq!(delta, Some(StreamDelta::Think("step by step".into())));

        // Without a declared key the probe list still applies.
        let mut probed = StreamAccumulator::new();
        let delta = probed.feed(&json!({
            "choices": [{ "delta": { "reasoning_content": "probed" } }]
        }));
        assert_eq!(delta, Some(StreamDelta::Think("probed".into())));
    }

    #[test]
    fn parse_response_extracts_reasoning_content() {
        let v = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "42",
                    "reasoning_content": "Let me calculate 6 * 7"
                },
                "finish_reason": "stop"
            }],
        });
        let parsed = parse_response(&v).unwrap();
        assert_eq!(parsed.content, "42");
        assert_eq!(parsed.thinking.len(), 1);
        assert_eq!(
            parsed.thinking[0],
            ContentBlock::Think {
                think: "Let me calculate 6 * 7".into(),
                encrypted: None,
                details_index: None,
                reasoning_key: None,
                hidden: None,
            }
        );
    }

    #[test]
    fn test_build_request_reasoning_effort() {
        let msgs = vec![WireMessage {
            role: "user".into(),
            content: "hello".into(),
            blocks: vec![],
            tool_calls: vec![],
            tool_call_id: None,
        }];
        let req_high = build_request_full("gpt-4o", &msgs, &[], true, Some("high"), None, None);
        assert_eq!(req_high["reasoning_effort"], "high");

        let req_off = build_request_full("gpt-4o", &msgs, &[], true, Some("off"), None, None);
        assert!(req_off.get("reasoning_effort").is_none());

        let req_none = build_request_full("gpt-4o", &msgs, &[], true, None, None, None);
        assert!(req_none.get("reasoning_effort").is_none());
    }

    #[test]
    fn test_build_request_thinking_keep() {
        let msgs = vec![WireMessage::text("user", "hello")];
        let req_keep = build_request_full("kimi-k2", &msgs, &[], true, None, Some("all"), None);
        assert_eq!(req_keep["thinking"]["keep"], "all");

        let req_no_keep = build_request_full("kimi-k2", &msgs, &[], true, None, None, None);
        assert!(req_no_keep.get("thinking").is_none());
    }

    #[test]
    fn test_parse_usage_cache_variants() {
        // 1. DeepSeek 专有格式 (prompt_cache_hit_tokens)
        let ds_usage = json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "prompt_cache_hit_tokens": 80,
            "prompt_cache_miss_tokens": 20
        });
        let ds_res = parse_usage(Some(&ds_usage));
        assert_eq!(ds_res.input_cache_read, 80);
        assert_eq!(ds_res.input_tokens, 20);
        assert_eq!(ds_res.output_tokens, 20);
        assert_eq!(ds_res.total_tokens, 40);

        // 2. Moonshot AI (Kimi) 专有格式 (cached_tokens)
        let moonshot_usage = json!({
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "cached_tokens": 900
        });
        let ms_res = parse_usage(Some(&moonshot_usage));
        assert_eq!(ms_res.input_cache_read, 900);
        assert_eq!(ms_res.input_tokens, 100);
        assert_eq!(ms_res.output_tokens, 50);

        // 3. OpenAI 官方嵌套格式 (prompt_tokens_details.cached_tokens)
        let openai_usage = json!({
            "prompt_tokens": 500,
            "completion_tokens": 30,
            "prompt_tokens_details": {
                "cached_tokens": 350
            }
        });
        let oai_res = parse_usage(Some(&openai_usage));
        assert_eq!(oai_res.input_cache_read, 350);
        assert_eq!(oai_res.input_tokens, 150);
        assert_eq!(oai_res.output_tokens, 30);
    }
}
