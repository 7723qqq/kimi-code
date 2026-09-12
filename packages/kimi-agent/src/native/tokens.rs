/// Token estimation via character-based heuristic.
///
/// Mirrors `packages/agent-core-v2/src/kosong/contract/tokens.ts`:
///   - ASCII: ~4 chars per token
///   - Non-ASCII (CJK, emoji, etc.): ~1 char per token
///
/// The estimate is transient — the next LLM call returns the real count
/// and supersedes this value. Used to keep `tokenCountWithPending`
/// monotonic between LLM round-trips without paying for a tokenizer.
///
/// ## Byte-level scanning
///
/// Instead of decoding UTF-8 into code points (which `str::chars()` does),
/// we scan raw bytes. In UTF-8:
///   - Bytes `0x00..0x80` are ASCII code points (1 byte = 1 code point)
///   - Bytes `0xC0..0xFF` are start bytes of multi-byte sequences
///     (each code point has exactly one start byte)
///   - Bytes `0x80..0xC0` are continuation bytes (skip)
///
/// This gives identical counts to iterating `char` values but is
/// SIMD-friendly — the compiler auto-vectorizes the byte comparisons.
/// It also matches the JS `for (const char of text)` semantics, which
/// iterates Unicode code points.
///
/// Estimate token count from a single text string.
pub fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    for &b in text.as_bytes() {
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            non_ascii += 1;
        }
    }
    (ascii.div_ceil(4)) + non_ascii
}

/// Estimate token count across multiple text strings (batch mode).
///
/// Equivalent to `texts.iter().map(estimate_tokens).sum()` but with a
/// single napi boundary crossing — collects all text fragments in TS
/// and makes one Rust call instead of N calls.
pub fn estimate_tokens_batch(texts: &[&str]) -> usize {
    let mut total = 0usize;
    for &text in texts {
        total += estimate_tokens(text);
    }
    total
}

/// Truncate text to fit within a token budget, keeping the BEGINNING.
///
/// Walks bytes forward using the same ASCII/non-ASCII heuristic as
/// `estimate_tokens`, and stops at the first code point that would
/// push the running total over the budget. Mirrors
/// `truncateTextToTokens` in `handoff.ts`.
pub fn truncate_text_to_tokens(text: &str, max_tokens: usize) -> String {
    if max_tokens == 0 {
        return String::new();
    }
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    let mut end = 0usize;
    for (i, &b) in text.as_bytes().iter().enumerate() {
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            non_ascii += 1;
        }
        // Continuation bytes (0x80..0xC0) don't count as separate code points.
        if ascii.div_ceil(4) + non_ascii > max_tokens {
            break;
        }
        end = i + 1;
    }
    // 确保 end 截断点严格落在合法的 UTF-8 字符边界上，防止多字节字符被腰斩触发 Panic
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// JSON 结构 Token 密集度加权倍数（对齐 TS kosong/src/tokens.ts JSON_TOKEN_MULTIPLIER = 1.3）
#[allow(dead_code)]
pub const JSON_TOKEN_MULTIPLIER: f64 = 1.3;

/// 单张图片或音视频等多模态媒体块的固定预估 Token 开销（对齐 TS MEDIA_TOKEN_ESTIMATE = 2000）
#[allow(dead_code)]
pub const MEDIA_TOKEN_ESTIMATE: usize = 2000;

/// 对 JSON 序列化文本进行 Token 估算，乘以 1.3 倍补偿标点符号密集开销
#[allow(dead_code)]
pub fn estimate_tokens_for_json(text: &str) -> usize {
    let raw = estimate_tokens(text);
    ((raw as f64) * JSON_TOKEN_MULTIPLIER).ceil() as usize
}

/// 针对工具定义列表计算 Token 预算开销（对齐 TS estimateTokensForTools）
#[allow(dead_code)]
pub fn estimate_tokens_for_tools(tools: &[(&str, &str, &str)]) -> usize {
    let mut total = 0usize;
    for (name, description, schema_json) in tools {
        total += estimate_tokens(name);
        total += estimate_tokens(description);
        total += estimate_tokens(schema_json);
    }
    ((total as f64) * JSON_TOKEN_MULTIPLIER).ceil() as usize
}

/// 针对单条消息计算 Token（支持角色、文本、多模态媒体块及工具调用参数）
#[allow(dead_code)]
pub fn estimate_tokens_for_message_parts(
    role: &str,
    content: &str,
    media_parts_count: usize,
    tool_calls_json: Option<&str>,
) -> usize {
    let mut total = estimate_tokens(role);
    total += estimate_tokens(content);
    total += media_parts_count * MEDIA_TOKEN_ESTIMATE;

    if let Some(calls_json) = tool_calls_json {
        total += estimate_tokens_for_json(calls_json);
    }

    total
}

/// 针对全量消息历史批量计算 Token 总和（对齐 TS estimateTokensForMessages）
#[allow(dead_code)]
pub fn estimate_tokens_for_messages_summary(
    messages: &[(String, String, usize, Option<String>)],
) -> usize {
    let mut total = 0usize;
    for (role, content, media_count, calls_json) in messages {
        total +=
            estimate_tokens_for_message_parts(role, content, *media_count, calls_json.as_deref());
    }
    total
}

/// Token 锚点结构体，对齐 TS TokenCountingAgentModel 的 TokenAnchor 定义
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TokenAnchor {
    pub length: usize,
    pub tokens: usize,
    pub measured: bool,
}

/// 状态化 Token 锚点追踪器，对齐 TS TokenCountingAgentModel 的 measured+estimated 插值算法
#[derive(Debug, Clone)]
pub struct TokenAnchorTracker {
    anchors: Vec<TokenAnchor>,
    current_tokens: usize,
}

impl Default for TokenAnchorTracker {
    fn default() -> Self {
        Self::new()
    }
}

// 刻意停靠（P? 移植自 TS，算法与测试齐备但尚未接线到引擎的 token 估算路径；
// 原生引擎当前走自有估算，接线属于 token_counting.strategy 的工作）。
#[allow(dead_code)]
impl TokenAnchorTracker {
    pub fn new() -> Self {
        Self {
            anchors: vec![TokenAnchor {
                length: 0,
                tokens: 0,
                measured: true,
            }],
            current_tokens: 0,
        }
    }

    /// 记录真实大模型响应返回的实测 Token（对齐 TS TokenCountingMeasured）
    pub fn record_measured(&mut self, length: usize, tokens: usize) {
        let anchor = TokenAnchor {
            length,
            tokens,
            measured: true,
        };
        self.anchors.retain(|a| a.length < length);
        self.anchors.push(anchor);
        self.current_tokens = tokens;
    }

    /// 记录上下文发生裁剪截断时的截断点（对齐 TS TokenCountingTruncated）
    pub fn record_truncation(&mut self, cut_index: usize) {
        self.anchors.retain(|a| a.length <= cut_index);
        if let Some(last) = self.anchors.last() {
            self.current_tokens = last.tokens;
        }
    }

    /// 基于历史锚点与待处理新增消息估算当前整体 Token 规模（对齐 TS measured+estimated）
    pub fn estimate_with_pending(
        &self,
        total_messages_count: usize,
        pending_estimated_tokens: usize,
    ) -> usize {
        if let Some(last) = self.anchors.last()
            && total_messages_count >= last.length
        {
            return last.tokens + pending_estimated_tokens;
        }
        self.current_tokens + pending_estimated_tokens
    }

    /// 获取最新的实测或记录基准 Token 数
    pub fn latest_tokens(&self) -> usize {
        self.current_tokens
    }

    /// 获取当前内部所有锚点快照
    pub fn anchors(&self) -> &[TokenAnchor] {
        &self.anchors
    }
}

/// Truncate text to fit within a token budget, keeping the END.
///
/// Walks bytes backward, skipping UTF-8 continuation bytes to consume
/// multi-byte sequences whole (equivalent to the JS surrogate-pair
/// handling). Mirrors `truncateTextToTokensFromEnd` in `handoff.ts`.
pub fn truncate_text_to_tokens_from_end(text: &str, max_tokens: usize) -> String {
    if max_tokens == 0 {
        return String::new();
    }
    let bytes = text.as_bytes();
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    let mut start = bytes.len();
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        let b = bytes[i];
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            non_ascii += 1;
        } else {
            // Continuation byte: part of a multi-byte sequence already counted
            // (or about to be counted when we reach its start byte).
            continue;
        }
        if ascii.div_ceil(4) + non_ascii > max_tokens {
            break;
        }
        start = i;
    }
    text[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_only() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("hello"), 2);
        assert_eq!(estimate_tokens("hello world"), 3);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn test_cjk() {
        assert_eq!(estimate_tokens("你好"), 2);
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn test_mixed_ascii_cjk() {
        assert_eq!(estimate_tokens("Hello你好"), 4);
        assert_eq!(estimate_tokens("Hello你好World"), 5);
    }

    #[test]
    fn test_emoji() {
        assert_eq!(estimate_tokens("👋"), 1);
        assert_eq!(estimate_tokens("a👋b"), 2);
        assert_eq!(estimate_tokens("🎉🎊"), 2);
    }

    #[test]
    fn test_matches_js_heuristic() {
        let cases = [
            ("", 0),
            ("hello world", 3),
            ("Hello, World!", 4),
            ("你好，世界！", 6),
            ("def estimate_tokens(text):", 7),
            ("const result = await fetch(url);", 8),
        ];
        for (text, expected) in cases {
            let got = estimate_tokens(text);
            assert_eq!(
                got, expected,
                "estimate_tokens({:?}): got {}, expected {}",
                text, got, expected
            );
        }
    }

    #[test]
    fn test_batch() {
        let texts: Vec<&str> = vec!["hello", "world", "你好"];
        assert_eq!(estimate_tokens_batch(&texts), 6);
    }

    #[test]
    fn test_batch_empty() {
        let texts: Vec<&str> = vec![];
        assert_eq!(estimate_tokens_batch(&texts), 0);
    }

    #[test]
    fn test_batch_single() {
        let texts: Vec<&str> = vec!["hello world"];
        assert_eq!(estimate_tokens_batch(&texts), 3);
    }

    // ── truncate_text_to_tokens (forward) ──────────────────────────────

    #[test]
    fn test_truncate_forward_empty() {
        assert_eq!(truncate_text_to_tokens("", 10), "");
    }

    #[test]
    fn test_truncate_forward_zero_budget() {
        assert_eq!(truncate_text_to_tokens("hello", 0), "");
    }

    #[test]
    fn test_truncate_forward_budget_exceeds_text() {
        assert_eq!(truncate_text_to_tokens("hello", 100), "hello");
    }

    #[test]
    fn test_truncate_forward_ascii() {
        // "hello world" = 3 tokens (11 ASCII chars / 4 = 2.75 → 3)
        // budget=1: ceil(4/4)=1 token = 4 chars "hell"; 5th char → ceil(5/4)=2 > 1
        assert_eq!(truncate_text_to_tokens("hello world", 1), "hell");
        // budget=2: ceil(8/4)=2 tokens = 8 chars "hello wo"; 9th char → ceil(9/4)=3 > 2
        assert_eq!(truncate_text_to_tokens("hello world", 2), "hello wo");
        assert_eq!(truncate_text_to_tokens("hello world", 3), "hello world");
    }

    #[test]
    fn test_truncate_forward_cjk() {
        // "你好世界" = 4 tokens (each CJK char = 1 token)
        assert_eq!(truncate_text_to_tokens("你好世界", 1), "你");
        assert_eq!(truncate_text_to_tokens("你好世界", 2), "你好");
        assert_eq!(truncate_text_to_tokens("你好世界", 4), "你好世界");
    }

    #[test]
    fn test_truncate_forward_mixed() {
        // "abc你" = ceil(3/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens("abc你", 1), "abc");
        assert_eq!(truncate_text_to_tokens("abc你", 2), "abc你");
    }

    #[test]
    fn test_truncate_forward_emoji() {
        // "👋" = 1 token (4-byte UTF-8, 1 non-ASCII code point)
        assert_eq!(truncate_text_to_tokens("👋", 0), "");
        assert_eq!(truncate_text_to_tokens("👋", 1), "👋");
        // "a👋b" = ceil(2/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens("a👋b", 1), "a");
        assert_eq!(truncate_text_to_tokens("a👋b", 2), "a👋b");
    }

    #[test]
    fn test_truncate_forward_no_split_multibyte() {
        // Truncation must never split a multi-byte sequence.
        let result = truncate_text_to_tokens("你好", 1);
        assert_eq!(result, "你");
        assert!(result.chars().count() == 1);
    }

    // ── truncate_text_to_tokens_from_end (backward) ────────────────────

    #[test]
    fn test_truncate_backward_empty() {
        assert_eq!(truncate_text_to_tokens_from_end("", 10), "");
    }

    #[test]
    fn test_truncate_backward_zero_budget() {
        assert_eq!(truncate_text_to_tokens_from_end("hello", 0), "");
    }

    #[test]
    fn test_truncate_backward_budget_exceeds_text() {
        assert_eq!(truncate_text_to_tokens_from_end("hello", 100), "hello");
    }

    #[test]
    fn test_truncate_backward_ascii() {
        // "hello world" = 3 tokens
        assert_eq!(truncate_text_to_tokens_from_end("hello world", 1), "orld");
        assert_eq!(
            truncate_text_to_tokens_from_end("hello world", 2),
            "lo world"
        );
        assert_eq!(
            truncate_text_to_tokens_from_end("hello world", 3),
            "hello world"
        );
    }

    #[test]
    fn test_truncate_backward_cjk() {
        // "你好世界" = 4 tokens
        assert_eq!(truncate_text_to_tokens_from_end("你好世界", 1), "界");
        assert_eq!(truncate_text_to_tokens_from_end("你好世界", 2), "世界");
        assert_eq!(truncate_text_to_tokens_from_end("你好世界", 4), "你好世界");
    }

    #[test]
    fn test_truncate_backward_mixed() {
        // "abc你" = ceil(3/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens_from_end("abc你", 1), "你");
        assert_eq!(truncate_text_to_tokens_from_end("abc你", 2), "abc你");
    }

    #[test]
    fn test_truncate_backward_emoji() {
        // "👋" = 1 token
        assert_eq!(truncate_text_to_tokens_from_end("👋", 0), "");
        assert_eq!(truncate_text_to_tokens_from_end("👋", 1), "👋");
        // "a👋b" = ceil(2/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens_from_end("a👋b", 1), "b");
        assert_eq!(truncate_text_to_tokens_from_end("a👋b", 2), "a👋b");
    }

    #[test]
    fn test_truncate_backward_no_split_multibyte() {
        let result = truncate_text_to_tokens_from_end("你好", 1);
        assert_eq!(result, "好");
        assert!(result.chars().count() == 1);
    }

    #[test]
    fn test_truncate_budget_respected() {
        // Both forward and backward truncation must produce text whose
        // estimated token count never exceeds the budget.
        let cases = [
            ("hello world", 1),
            ("hello world", 2),
            ("hello world", 3),
            ("你好世界", 1),
            ("你好世界", 2),
            ("abc你好def", 2),
            ("a👋b🎉c", 2),
        ];
        for (text, budget) in cases {
            let front = truncate_text_to_tokens(text, budget);
            let front_tokens = estimate_tokens(&front);
            assert!(
                front_tokens <= budget,
                "forward({:?}, {}): got {} tokens in {:?}",
                text,
                budget,
                front_tokens,
                front
            );
            let back = truncate_text_to_tokens_from_end(text, budget);
            let back_tokens = estimate_tokens(&back);
            assert!(
                back_tokens <= budget,
                "backward({:?}, {}): got {} tokens in {:?}",
                text,
                budget,
                back_tokens,
                back
            );
        }
    }

    #[test]
    fn test_estimate_tokens_for_json_and_tools() {
        let json_str = r#"{"name": "read_file", "path": "src/main.rs"}"#;
        let raw = estimate_tokens(json_str);
        let weighted = estimate_tokens_for_json(json_str);
        // JSON 1.3 倍加权断言
        assert!(weighted > raw);
        assert_eq!(weighted, ((raw as f64) * 1.3).ceil() as usize);

        let tools = [
            ("read", "read file content", r#"{"type":"object"}"#),
            ("grep", "search file text", r#"{"type":"object"}"#),
        ];
        let tool_tokens = estimate_tokens_for_tools(&tools);
        assert!(tool_tokens > 0);
    }

    #[test]
    fn test_estimate_tokens_multimodal_messages() {
        // "user" (4 ascii = 1 token) + "Please describe the diagram" (27 ascii = 7 tokens) + 1 image (2000) = 2008
        let single_img_tokens = estimate_tokens_for_message_parts(
            "user",
            "Please describe the diagram",
            1, // 1 张图片
            None,
        );
        assert_eq!(
            single_img_tokens, 2008,
            "Exact multimodal token calculation: 1 + 7 + 2000"
        );

        // Message 1: "user" (1) + "Hello" (2) = 3
        // Message 2: "assistant" (3) + "Sure" (1) + calls json '{"path":"test.rs"}' (18 ascii -> 5 tokens * 1.3 = 7) = 11
        // Message 3: "user" (1) + "Look at this" (3) + 1 image (2000) = 2004
        // Total = 3 + 11 + 2004 = 2018
        let msgs = [
            ("user".to_string(), "Hello".to_string(), 0, None),
            (
                "assistant".to_string(),
                "Sure".to_string(),
                0,
                Some(r#"{"path":"test.rs"}"#.to_string()),
            ),
            ("user".to_string(), "Look at this".to_string(), 1, None),
        ];
        let total = estimate_tokens_for_messages_summary(&msgs);
        assert_eq!(
            total, 2018,
            "Exact summary messages token count: 3 + 11 + 2004 = 2018"
        );
    }

    #[test]
    fn test_truncate_forward_cjk_boundary_safety() {
        let text = "这是一个针对多字节字符边界安全的截断测试";
        for budget in 0..10 {
            let res = truncate_text_to_tokens(text, budget);
            assert!(res.is_empty() || res.chars().count() <= budget);
        }
    }

    #[test]
    fn test_token_anchor_tracker_lifecycle() {
        let mut tracker = TokenAnchorTracker::new();
        assert_eq!(tracker.latest_tokens(), 0);

        // Record first turn measured: 3 messages, 1500 tokens
        tracker.record_measured(3, 1500);
        assert_eq!(tracker.latest_tokens(), 1500);

        // Estimate with 2 pending messages (250 estimated tokens) -> exactly 1750
        let estimated = tracker.estimate_with_pending(5, 250);
        assert_eq!(estimated, 1750);

        // Record second turn measured: 6 messages, 2200 tokens
        tracker.record_measured(6, 2200);
        assert_eq!(tracker.latest_tokens(), 2200);

        // Record truncation at cut_index = 3 (drops anchor at length 6, rolls back to anchor 3)
        tracker.record_truncation(3);
        assert_eq!(tracker.latest_tokens(), 1500);
        assert_eq!(tracker.anchors().len(), 2); // anchors: 0 and 3

        // Record truncation at cut_index = 0 (drops anchor 3, rolls back to initial empty anchor)
        tracker.record_truncation(0);
        assert_eq!(tracker.latest_tokens(), 0);
        assert_eq!(tracker.anchors().len(), 1); // only anchor 0 remains

        // Estimate with total_messages_count less than last anchor
        tracker.record_measured(5, 1000);
        let under_len_est = tracker.estimate_with_pending(2, 50);
        assert_eq!(under_len_est, 1050);
    }
}
