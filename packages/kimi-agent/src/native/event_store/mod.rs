pub mod loop_fold;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use parking_lot::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawWireEvent {
    pub id: String,
    pub session_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub is_checkpoint: bool,
    pub is_compaction: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: MessageRole,
    pub content: String,
    /// Multimodal content blocks carried through verbatim as wire JSON
    /// (ordered array of `{type: "text"|"image"|"image_url"|"audio_url"|"video_url"|"think", ...}`).
    /// Empty array for text-only messages. The event-store crate cannot depend
    /// on the consumer's `ContentBlock` type, so blocks stay as raw JSON and
    /// the consumer deserializes them into its own typed enum.
    #[serde(default)]
    pub blocks: serde_json::Value,
    pub tool_calls: Option<serde_json::Value>,
    pub tool_call_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum EventStoreError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Undo violation: Cannot undo across compaction boundary")]
    UndoCompactionBoundary,
    #[error("Undo failed: Checkpoint not found or history exhausted")]
    CheckpointNotFound,
}

pub trait EventStore: Send + Sync {
    fn append_event(&self, event: &RawWireEvent) -> Result<u64, EventStoreError>;
    fn fold_projection(&self, session_id: &str) -> Result<Vec<Message>, EventStoreError>;
    fn checkpoint_compress(&self, session_id: &str, summary: &str) -> Result<(), EventStoreError>;
    fn undo_to_last_checkpoint(&self, session_id: &str) -> Result<usize, EventStoreError>;
}

pub struct SqliteEventStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteEventStore {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, EventStoreError> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS wire_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                is_checkpoint BOOLEAN NOT NULL DEFAULT 0,
                is_compaction BOOLEAN NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_session_seq ON wire_events(session_id, seq);
            "#
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn new_in_memory() -> Result<Self, EventStoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS wire_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                is_checkpoint BOOLEAN NOT NULL DEFAULT 0,
                is_compaction BOOLEAN NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_session_seq ON wire_events(session_id, seq);
            "#
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

/// 从 JSON payload 字段中鲁棒提取纯文本或多模态文本表示
fn extract_content_text(payload: &serde_json::Value, field: &str) -> Option<String> {
    if let Some(val) = payload.get(field) {
        if let Some(s) = val.as_str() {
            return Some(s.to_string());
        }
        if let Some(arr) = val.as_array() {
            let mut buf = String::new();
            for item in arr {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(text);
                } else if let Some(img) = item.get("image_url") {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&format!("[Image: {}]", img.get("url").and_then(|u| u.as_str()).unwrap_or("inline")));
                }
            }
            if !buf.is_empty() {
                return Some(buf);
            }
            return Some(val.to_string());
        }
        if val.is_object() {
            return Some(val.to_string());
        }
    }
None
}

/// 从 payload 中提取多模态内容块（wire JSON 数组），缺失或非数组时返回空数组。
fn extract_blocks(payload: &serde_json::Value) -> serde_json::Value {
    payload
        .get("blocks")
        .cloned()
        .filter(|v| v.is_array())
        .unwrap_or_else(|| serde_json::json!([]))
}

/// 剥离 Assistant 回复中的思维链草稿（ thinking... response），防止历史上下文膨胀
fn strip_think_blocks(text: &str) -> String {
    let mut result = String::new();
    let mut remaining = text;
    while let Some(start) = remaining.find("<think>") {
        result.push_str(&remaining[..start]);
        if let Some(end) = remaining[start + 7..].find("</think>") {
            remaining = &remaining[start + 7 + end + 8..];
        } else {
            remaining = "";
            break;
        }
    }
    result.push_str(remaining);
    result.trim().to_string()
}

/// 严格自愈流水线：对齐 TS contextProjector/projection.ts 的 9 大自愈规则
/// 1. 过滤开头的孤儿 Tool 或孤立 Assistant（Anthropic/OpenAI 强制首条必须是 User 或 System）
/// 2. 丢弃未声明对应的孤儿 Tool.result（防止 tool_call_id does not match any tool_calls 400 报错）
/// 3. 合并连续同角色 Assistant 消息（防止 Anthropic 报 roles must alternate 400 报错）
/// 4. 历史长轮次图片占位降级（保留最近 3 张，更早的图片降级为占位文字，防止爆窗口）
fn sanitize_and_repair_projection(messages: Vec<Message>) -> Vec<Message> {
    if messages.is_empty() {
        return messages;
    }

    // 步骤 A：收集所有 Assistant 中声明过的合法 tool_call_id
    let mut declared_tool_call_ids = std::collections::HashSet::new();
    for msg in &messages {
        if msg.role == MessageRole::Assistant {
            if let Some(ref calls) = msg.tool_calls {
                if let Some(calls_arr) = calls.as_array() {
                    for c in calls_arr {
                        if let Some(id) = c.get("id").and_then(|i| i.as_str()) {
                            declared_tool_call_ids.insert(id.to_string());
                        }
                    }
                }
            }
        }
    }

    // 步骤 B：过滤孤儿 Tool 结果（Tool 的 call_id 必须存在于 declared_tool_call_ids）
    let filtered_tools: Vec<Message> = messages
        .into_iter()
        .filter(|msg| {
            if msg.role == MessageRole::Tool {
                if let Some(ref id) = msg.tool_call_id {
                    declared_tool_call_ids.contains(id)
                } else {
                    false
                }
            } else {
                true
            }
        })
        .collect();

    // 步骤 C：连续 Assistant 消息合并（Anthropic 强制交替校验）
    let mut merged_assistants: Vec<Message> = Vec::new();
    for msg in filtered_tools {
        if msg.role == MessageRole::Assistant && msg.tool_calls.is_none() {
            if let Some(last) = merged_assistants.last_mut() {
                if last.role == MessageRole::Assistant && last.tool_calls.is_none() {
                    last.content.push_str("\n\n");
                    last.content.push_str(&msg.content);
                    continue;
                }
            }
        }
        merged_assistants.push(msg);
    }

    // 步骤 D：开头的孤立 Tool 或残留 Assistant 消息清理（仅当存在 User 消息时，清理首个有效消息前的孤立项）
    let mut cleaned_leading = merged_assistants;
    let has_user = cleaned_leading.iter().any(|m| m.role == MessageRole::User);
    if has_user {
        while let Some(first) = cleaned_leading.first() {
            if first.role == MessageRole::Tool || (first.role == MessageRole::Assistant && first.tool_calls.is_none()) {
                cleaned_leading.remove(0);
            } else {
                break;
            }
        }
    }

    // 步骤 E：图片多模态降级：仅保留最近 3 处内联图片，更早的图片降级为 [Image (stripped): ...]
    let mut image_count = 0;
    for msg in cleaned_leading.iter_mut().rev() {
        if msg.content.contains("[Image:") {
            image_count += 1;
            if image_count > 3 {
                msg.content = msg.content.replace("[Image:", "[Image (stripped):");
            }
        }
    }

    cleaned_leading
}

impl EventStore for SqliteEventStore {
    fn append_event(&self, event: &RawWireEvent) -> Result<u64, EventStoreError> {
        let conn = self.conn.lock();
        let payload_str = serde_json::to_string(&event.payload)?;
        conn.execute(
            "INSERT INTO wire_events (id, session_id, event_type, payload, is_checkpoint, is_compaction, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.id,
                event.session_id,
                event.event_type,
                payload_str,
                event.is_checkpoint,
                event.is_compaction,
                event.created_at
            ],
        )?;
        Ok(conn.last_insert_rowid() as u64)
    }

    fn fold_projection(&self, session_id: &str) -> Result<Vec<Message>, EventStoreError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT event_type, payload, is_compaction FROM wire_events WHERE session_id = ?1 ORDER BY seq ASC"
        )?;

        let mut messages: Vec<Message> = Vec::new();
        let mut pending_tool_calls: Vec<String> = Vec::new();
        let mut deferred_messages: Vec<Message> = Vec::new();

        let flush_hanging_tools = |msgs: &mut Vec<Message>, pending: &mut Vec<String>, deferred: &mut Vec<Message>| {
            if !pending.is_empty() {
                for call_id in pending.drain(..) {
                    msgs.push(Message {
                        role: MessageRole::Tool,
                        content: "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.".to_string(),
                        blocks: serde_json::json!([]),
                        tool_calls: None,
                        tool_call_id: Some(call_id),
                    });
                }
            }
            if !deferred.is_empty() {
                msgs.append(deferred);
            }
        };

        let mut rows = stmt.query(params![session_id])?;

        while let Some(row) = rows.next()? {
            let event_type: String = row.get(0)?;
            let payload_str: String = row.get(1)?;
            let is_compaction: bool = row.get(2)?;
            let payload: serde_json::Value = serde_json::from_str(&payload_str)?;

            // 1. 压缩边界：重置会话折叠机状态
            if is_compaction {
                messages.clear();
                pending_tool_calls.clear();
                deferred_messages.clear();
                if let Some(summary) = payload.get("summary").and_then(|s| s.as_str()) {
                    messages.push(Message {
                        role: MessageRole::System,
                        content: summary.to_string(),
                        blocks: serde_json::json!([]),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
                continue;
            }

            // 2. 状态机折叠投影
            match event_type.as_str() {
                "message.system" => {
                    if let Some(text) = extract_content_text(&payload, "content") {
                        messages.push(Message {
                            role: MessageRole::System,
                            content: text,
                            blocks: extract_blocks(&payload),
                            tool_calls: None,
                            tool_call_id: None,
                        });
                    }
                }
                "message.user" => {
                    if let Some(text) = extract_content_text(&payload, "content") {
                        let user_msg = Message {
                            role: MessageRole::User,
                            content: text,
                            blocks: extract_blocks(&payload),
                            tool_calls: None,
                            tool_call_id: None,
                        };
                        // 协议约束：当前有等待返回的工具调用时，暂存消息以保持 Tool 消息紧随 Assistant
                        if !pending_tool_calls.is_empty() {
                            deferred_messages.push(user_msg);
                        } else {
                            messages.push(user_msg);
                        }
                    }
                }
                "message.assistant" => {
                    // 若上一轮仍有未决悬挂工具，先强制合成修复
                    if !pending_tool_calls.is_empty() {
                        flush_hanging_tools(&mut messages, &mut pending_tool_calls, &mut deferred_messages);
                    }

                    let raw_text = extract_content_text(&payload, "content").unwrap_or_default();
                    let text = strip_think_blocks(&raw_text);
                    let tool_calls = payload.get("tool_calls").cloned();
                    let is_partial = payload.get("partial").and_then(|p| p.as_bool()).unwrap_or(false);

                    if is_partial {
                        if let Some(last) = messages.last_mut() {
                            if last.role == MessageRole::Assistant && last.tool_calls.is_none() {
                                last.content.push_str(&text);
                                continue;
                            }
                        }
                    }

                    if !text.is_empty() || tool_calls.is_some() {
                        // 提取本条 Assistant 发起的工具调用 ID 列表
                        if let Some(ref calls) = tool_calls {
                            if let Some(calls_arr) = calls.as_array() {
                                for c in calls_arr {
                                    if let Some(call_id) = c.get("id").and_then(|id| id.as_str()) {
                                        pending_tool_calls.push(call_id.to_string());
                                    }
                                }
                            }
                        }

                        messages.push(Message {
                            role: MessageRole::Assistant,
                            content: text,
                            blocks: extract_blocks(&payload),
                            tool_calls,
                            tool_call_id: None,
                        });
                    }
                }
                "tool.result" => {
                    let mut tool_call_id = payload.get("tool_call_id").and_then(|id| id.as_str()).map(String::from);
                    let content = extract_content_text(&payload, "output").unwrap_or_default();

                    // FIFO 核销：若未传 tool_call_id，从 pending_tool_calls 队首弹出核销
                    if tool_call_id.is_none() && !pending_tool_calls.is_empty() {
                        tool_call_id = Some(pending_tool_calls.remove(0));
                    } else if let Some(ref id) = tool_call_id {
                        if let Some(pos) = pending_tool_calls.iter().position(|x| x == id) {
                            pending_tool_calls.remove(pos);
                        }
                    }

                    messages.push(Message {
                        role: MessageRole::Tool,
                        content,
                        blocks: serde_json::json!([]),
                        tool_calls: None,
                        tool_call_id,
                    });

                    // 若所有未决工具全部返回，释放 deferred 队列消息
                    if pending_tool_calls.is_empty() && !deferred_messages.is_empty() {
                        messages.append(&mut deferred_messages);
                    }
                }
                "step.begin" => {
                    if !pending_tool_calls.is_empty() {
                        flush_hanging_tools(&mut messages, &mut pending_tool_calls, &mut deferred_messages);
                    }
                    messages.push(Message {
                        role: MessageRole::Assistant,
                        content: String::new(),
                        blocks: serde_json::json!([]),
                        tool_calls: Some(serde_json::json!([])),
                        tool_call_id: None,
                    });
                }
                "content.part" => {
                    if let Some(text) = payload.get("text").and_then(|t| t.as_str()) {
                        if let Some(last) = messages.last_mut() {
                            if last.role == MessageRole::Assistant {
                                last.content.push_str(text);
                            }
                        }
                    }
                }
                "tool.call" => {
                    let call_id = payload.get("tool_call_id").and_then(|i| i.as_str()).unwrap_or("call").to_string();
                    let name = payload.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                    let args = payload.get("arguments").and_then(|a| a.as_str()).unwrap_or("{}");
                    pending_tool_calls.push(call_id.clone());
                    if let Some(last) = messages.last_mut() {
                        if last.role == MessageRole::Assistant {
                            let call_obj = serde_json::json!({
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": args,
                                }
                            });
                            if let Some(ref mut arr) = last.tool_calls.as_mut().and_then(|v| v.as_array_mut()) {
                                arr.push(call_obj);
                            }
                        }
                    }
                }
                "step.end" => {
                    let finish_reason = payload.get("finish_reason").and_then(|r| r.as_str());
                    if finish_reason != Some("interrupted") && finish_reason != Some("error") {
                        if let Some(last) = messages.last_mut() {
                            if last.role == MessageRole::Assistant {
                                if let Some(arr) = last.tool_calls.as_ref().and_then(|v| v.as_array()) {
                                    if arr.is_empty() {
                                        last.tool_calls = None;
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        // 3. 循环结束：若末尾存在未决悬挂工具（如进程崩溃或取消），自动合成修复
        flush_hanging_tools(&mut messages, &mut pending_tool_calls, &mut deferred_messages);

        Ok(sanitize_and_repair_projection(messages))
    }

    fn checkpoint_compress(&self, session_id: &str, summary: &str) -> Result<(), EventStoreError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let event = RawWireEvent {
            id: ulid::Ulid::new().to_string(),
            session_id: session_id.to_string(),
            event_type: "context.compaction".to_string(),
            payload: serde_json::json!({ "summary": summary }),
            is_checkpoint: true,
            is_compaction: true,
            created_at: now,
        };
        self.append_event(&event)?;
        Ok(())
    }

    fn undo_to_last_checkpoint(&self, session_id: &str) -> Result<usize, EventStoreError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // 查找最近一个检查点
        let last_checkpoint: Option<(i64, bool)> = tx.query_row(
            "SELECT seq, is_compaction FROM wire_events 
             WHERE session_id = ?1 AND is_checkpoint = 1 
             ORDER BY seq DESC LIMIT 1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;

        let (target_seq, is_compaction) = last_checkpoint.ok_or(EventStoreError::CheckpointNotFound)?;

        // 按协议阻断：跨越压缩边界时拒绝执行回滚
        if is_compaction {
            return Err(EventStoreError::UndoCompactionBoundary);
        }

        let deleted_count = tx.execute(
            "DELETE FROM wire_events WHERE session_id = ?1 AND seq >= ?2",
            params![session_id, target_seq],
        )?;

        tx.commit()?;
        Ok(deleted_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_store_projection_and_undo() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_session_1";

        // 用户提问
        store.append_event(&RawWireEvent {
            id: "evt_1".into(),
            session_id: session.into(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": "Hello Rust" }),
            is_checkpoint: true,
            is_compaction: false,
            created_at: 1000,
        }).unwrap();

        // 助手回复
        store.append_event(&RawWireEvent {
            id: "evt_2".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({ "content": "Hi there!" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 1001,
        }).unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, MessageRole::User);
        assert_eq!(msgs[1].role, MessageRole::Assistant);

        // 触发压缩
        store.checkpoint_compress(session, "Prior context summary").unwrap();

        let msgs_after_compaction = store.fold_projection(session).unwrap();
        assert_eq!(msgs_after_compaction.len(), 1);
        assert_eq!(msgs_after_compaction[0].role, MessageRole::System);
        assert_eq!(msgs_after_compaction[0].content, "Prior context summary");

        // 验证跨越压缩边界时拒绝 Undo 回滚
        let undo_res = store.undo_to_last_checkpoint(session);
        assert!(matches!(undo_res, Err(EventStoreError::UndoCompactionBoundary)));
    }

    #[test]
    fn test_deferral_queue_tool_results_consecutive() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_session_deferral";

        // 1. Assistant 发出两个 tool calls
        store.append_event(&RawWireEvent {
            id: "evt_1".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({
                "content": "Calling tools",
                "tool_calls": [
                    { "id": "call_a", "function": { "name": "read" } },
                    { "id": "call_b", "function": { "name": "grep" } }
                ]
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 100,
        }).unwrap();

        // 2. 中途插入用户消息（或系统注入提示）
        store.append_event(&RawWireEvent {
            id: "evt_2".into(),
            session_id: session.into(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": "Interrupted prompt" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 101,
        }).unwrap();

        // 3. 第一个工具结果返回
        store.append_event(&RawWireEvent {
            id: "evt_3".into(),
            session_id: session.into(),
            event_type: "tool.result".into(),
            payload: serde_json::json!({ "tool_call_id": "call_a", "output": "output a" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 102,
        }).unwrap();

        // 4. 第二个工具结果返回
        store.append_event(&RawWireEvent {
            id: "evt_4".into(),
            session_id: session.into(),
            event_type: "tool.result".into(),
            payload: serde_json::json!({ "tool_call_id": "call_b", "output": "output b" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 103,
        }).unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 4);
        // 验证暂存保序：Tool 结果紧随对应调用，被打断的用户输入排在最后
        assert_eq!(msgs[0].role, MessageRole::Assistant);
        assert_eq!(msgs[1].role, MessageRole::Tool);
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("call_a"));
        assert_eq!(msgs[2].role, MessageRole::Tool);
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("call_b"));
        assert_eq!(msgs[3].role, MessageRole::User);
        assert_eq!(msgs[3].content, "Interrupted prompt");
    }

    #[test]
    fn test_hanging_tool_call_recovery() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_session_hanging";

        // 1. Assistant 发出 tool call 但发生意外未决
        store.append_event(&RawWireEvent {
            id: "evt_1".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({
                "content": "Executing hanging tool",
                "tool_calls": [
                    { "id": "call_hang", "function": { "name": "bash" } }
                ]
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 200,
        }).unwrap();

        // 2. 直接结束或下一轮输入
        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, MessageRole::Assistant);
        // 关键断言：未收到结果的 tool call 必须自动合成 isError 消息进行自愈
        assert_eq!(msgs[1].role, MessageRole::Tool);
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("call_hang"));
        assert!(msgs[1].content.contains("Tool execution was interrupted"));
    }

    #[test]
    fn test_system_prompt_and_multimodal_extraction() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_multimodal";

        // 1. 系统提示词事件
        store.append_event(&RawWireEvent {
            id: "evt_sys".into(),
            session_id: session.into(),
            event_type: "message.system".into(),
            payload: serde_json::json!({ "content": "You are Kimi Code CLI." }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 10,
        }).unwrap();

        // 2. 多模态用户输入（含文本与图片数组）
        store.append_event(&RawWireEvent {
            id: "evt_multi".into(),
            session_id: session.into(),
            event_type: "message.user".into(),
            payload: serde_json::json!({
                "content": [
                    { "type": "text", "text": "Describe this image" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,mock" } }
                ]
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 11,
        }).unwrap();

        // 3. 助手回复带有 <think> 标签草稿
        store.append_event(&RawWireEvent {
            id: "evt_asst".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({
                "content": "<think>Thinking deeply about the pixels...</think>This is a test diagram."
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 12,
        }).unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, MessageRole::System);
        assert_eq!(msgs[0].content, "You are Kimi Code CLI.");
        assert_eq!(msgs[1].role, MessageRole::User);
        assert!(msgs[1].content.contains("Describe this image"));
        assert!(msgs[1].content.contains("[Image: data:image/png;base64,mock]"));
        assert_eq!(msgs[2].role, MessageRole::Assistant);
        // 验证 think 标签已剥离，仅保留文本内容
        assert_eq!(msgs[2].content, "This is a test diagram.");
    }

    #[test]
    fn test_blocks_passthrough() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_blocks";

        let blocks_user = serde_json::json!([
            { "type": "text", "text": "Summarize this" },
            { "type": "image_url", "url": "https://example.com/img.png" }
        ]);
        store.append_event(&RawWireEvent {
            id: "evt_bu".into(),
            session_id: session.into(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": "Summarize this", "blocks": blocks_user }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 1,
        }).unwrap();

        let blocks_asst = serde_json::json!([
            { "type": "think", "think": "reasoning", "encrypted": "sig" }
        ]);
        store.append_event(&RawWireEvent {
            id: "evt_ba".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({ "content": "done", "blocks": blocks_asst }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 2,
        }).unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].blocks, blocks_user);
        assert_eq!(msgs[1].blocks, blocks_asst);

        // 无 blocks 的消息折叠后为空数组而非 null
        store.append_event(&RawWireEvent {
            id: "evt_plain".into(),
            session_id: session.into(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": "plain text message" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 3,
        }).unwrap();
        let msgs2 = store.fold_projection(session).unwrap();
        let plain = msgs2.last().unwrap();
        assert_eq!(plain.blocks, serde_json::json!([]));
    }

    #[test]
    fn test_tool_result_missing_id_fifo_reconciliation() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_fifo_id";

        // Assistant 发起工具调用 call_1
        store.append_event(&RawWireEvent {
            id: "evt_1".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({
                "content": "Running command",
                "tool_calls": [
                    { "id": "call_1", "function": { "name": "bash" } }
                ]
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 30,
        }).unwrap();

        // 工具结果返回时丢失了 tool_call_id 字段
        store.append_event(&RawWireEvent {
            id: "evt_2".into(),
            session_id: session.into(),
            event_type: "tool.result".into(),
            payload: serde_json::json!({
                "output": "command success"
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 31,
        }).unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].role, MessageRole::Tool);
        // 关键断言：通过 FIFO 自动关联上 call_1，避免伪悬挂错误
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(msgs[1].content, "command success");
    }

    #[test]
    fn test_sanitize_and_repair_projection_rules() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_repair_rules";

        // 1. 注入一条孤立的开头 Assistant 消息（比如截断残留）
        store.append_event(&RawWireEvent {
            id: "evt_leading_bad".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({ "content": "I am an orphan leading assistant" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 1,
        }).unwrap();

        // 2. 正确的 User 消息
        store.append_event(&RawWireEvent {
            id: "evt_user_1".into(),
            session_id: session.into(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": "Real first user message" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 2,
        }).unwrap();

        // 3. 注入一条未声明任何 call_id 的孤儿 Tool.result
        store.append_event(&RawWireEvent {
            id: "evt_orphan_tool".into(),
            session_id: session.into(),
            event_type: "tool.result".into(),
            payload: serde_json::json!({ "tool_call_id": "ghost_call_999", "output": "ghost output" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 3,
        }).unwrap();

        // 4. 连续两条 Assistant 消息（无 tool_calls）
        store.append_event(&RawWireEvent {
            id: "evt_asst_1".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({ "content": "Part 1 of response." }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 4,
        }).unwrap();

        store.append_event(&RawWireEvent {
            id: "evt_asst_2".into(),
            session_id: session.into(),
            event_type: "message.assistant".into(),
            payload: serde_json::json!({ "content": "Part 2 of response." }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 5,
        }).unwrap();

        let msgs = store.fold_projection(session).unwrap();
        // 1. 首条孤立 Assistant 消息被清理，首条消息对齐为 User
        assert_eq!(msgs[0].role, MessageRole::User);
        assert_eq!(msgs[0].content, "Real first user message");

        // 2. 未匹配对应调用 ID 的孤立 Tool 消息被丢弃
        assert!(!msgs.iter().any(|m| m.tool_call_id.as_deref() == Some("ghost_call_999")));

        // 3. 连续的 Assistant 消息被合并为单条
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].role, MessageRole::Assistant);
        assert!(msgs[1].content.contains("Part 1 of response."));
        assert!(msgs[1].content.contains("Part 2 of response."));
    }

    #[test]
    fn test_event_store_streamed_loop_events() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_streamed_events";

        store.append_event(&RawWireEvent {
            id: "evt_u".into(),
            session_id: session.into(),
            event_type: "message.user".into(),
            payload: serde_json::json!({ "content": "Check weather" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 10,
        }).unwrap();

        store.append_event(&RawWireEvent {
            id: "evt_sb".into(),
            session_id: session.into(),
            event_type: "step.begin".into(),
            payload: serde_json::json!({ "uuid": "step_stream_1" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 11,
        }).unwrap();

        store.append_event(&RawWireEvent {
            id: "evt_cp".into(),
            session_id: session.into(),
            event_type: "content.part".into(),
            payload: serde_json::json!({ "text": "Checking " }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 12,
        }).unwrap();

        store.append_event(&RawWireEvent {
            id: "evt_tc".into(),
            session_id: session.into(),
            event_type: "tool.call".into(),
            payload: serde_json::json!({
                "tool_call_id": "call_weather_1",
                "name": "get_weather",
                "arguments": "{\"city\":\"Beijing\"}"
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 13,
        }).unwrap();

        store.append_event(&RawWireEvent {
            id: "evt_tr".into(),
            session_id: session.into(),
            event_type: "tool.result".into(),
            payload: serde_json::json!({
                "tool_call_id": "call_weather_1",
                "output": "Sunny, 25C"
            }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 14,
        }).unwrap();

        store.append_event(&RawWireEvent {
            id: "evt_se".into(),
            session_id: session.into(),
            event_type: "step.end".into(),
            payload: serde_json::json!({ "finish_reason": "stop" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 15,
        }).unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, MessageRole::User);
        assert_eq!(msgs[0].content, "Check weather");
        assert_eq!(msgs[1].role, MessageRole::Assistant);
        assert_eq!(msgs[1].content, "Checking ");
        assert!(msgs[1].tool_calls.is_some());
        assert_eq!(msgs[2].role, MessageRole::Tool);
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("call_weather_1"));
        assert_eq!(msgs[2].content, "Sunny, 25C");
    }
}
