pub mod loop_fold;

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;

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
            "#,
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
            "#,
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

/// Robustly extract plain text or a multimodal text representation from a JSON
/// payload field.
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
                    buf.push_str(&format!(
                        "[Image: {}]",
                        img.get("url").and_then(|u| u.as_str()).unwrap_or("inline")
                    ));
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

/// Extract the multimodal content blocks (a wire JSON array) from a payload;
/// returns an empty array when missing or not an array.
fn extract_blocks(payload: &serde_json::Value) -> serde_json::Value {
    payload
        .get("blocks")
        .cloned()
        .filter(|v| v.is_array())
        .unwrap_or_else(|| serde_json::json!([]))
}

/// Strip the chain-of-thought draft out of an assistant reply
/// (`thinking... response`) so the history does not bloat.
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

/// The strict self-healing pipeline: aligned with TS
/// `contextProjector/projection.ts` (`summarizeProjectionRepairs`, 9 anomaly
/// classes in total); 4 of them are implemented here:
/// 1. drop a leading orphan Tool or lone Assistant (Anthropic/OpenAI require the
///    first message to be User or System)
/// 2. drop an orphan `Tool.result` with no matching declaration (prevents the
///    `tool_call_id does not match any tool_calls` 400)
/// 3. merge consecutive same-role Assistant messages (prevents Anthropic's
///    `roles must alternate` 400)
/// 4. degrade placeholder images in long history turns (keep the most recent
///    3, degrade older ones to placeholder text so the window cannot blow up)
fn sanitize_and_repair_projection(messages: Vec<Message>) -> Vec<Message> {
    if messages.is_empty() {
        return messages;
    }

    // Step A: collect every legal tool_call_id declared by an Assistant message
    let mut declared_tool_call_ids = std::collections::HashSet::new();
    for msg in &messages {
        if msg.role == MessageRole::Assistant
            && let Some(ref calls) = msg.tool_calls
            && let Some(calls_arr) = calls.as_array()
        {
            for c in calls_arr {
                if let Some(id) = c.get("id").and_then(|i| i.as_str()) {
                    declared_tool_call_ids.insert(id.to_string());
                }
            }
        }
    }

    // Step B: drop orphan Tool results (a Tool's call_id must exist in
    // declared_tool_call_ids)
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

    // Step C: merge consecutive Assistant messages (Anthropic enforces
    // strict alternation)
    let mut merged_assistants: Vec<Message> = Vec::new();
    for msg in filtered_tools {
        if msg.role == MessageRole::Assistant
            && msg.tool_calls.is_none()
            && let Some(last) = merged_assistants.last_mut()
            && last.role == MessageRole::Assistant
            && last.tool_calls.is_none()
        {
            last.content.push_str("\n\n");
            last.content.push_str(&msg.content);
            continue;
        }
        merged_assistants.push(msg);
    }

    // Step D: clear a leading orphan Tool or leftover Assistant message (only when
    // a User message exists — the orphans before the first valid message go)
    let mut cleaned_leading = merged_assistants;
    let has_user = cleaned_leading.iter().any(|m| m.role == MessageRole::User);
    if has_user {
        let leading = cleaned_leading
            .iter()
            .take_while(|m| {
                m.role == MessageRole::Tool
                    || (m.role == MessageRole::Assistant && m.tool_calls.is_none())
            })
            .count();
        cleaned_leading.drain(..leading);
    }

    // Step E: degrade image multimodal content — keep only the 3 most recent
    // inline images, degrade older ones to `[Image (stripped): ...]`
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

/// Fold the raw wire event sequence into the context message list the model
/// needs, with strict self-healing and protocol correction.
pub fn fold_wire_events<'a, I>(events: I) -> Result<Vec<Message>, EventStoreError>
where
    I: IntoIterator<Item = (&'a str, &'a serde_json::Value, bool)>,
{
    let mut messages: Vec<Message> = Vec::new();
    let mut pending_tool_calls: Vec<String> = Vec::new();
    let mut deferred_messages: Vec<Message> = Vec::new();

    let flush_hanging_tools = |msgs: &mut Vec<Message>,
                               pending: &mut Vec<String>,
                               deferred: &mut Vec<Message>| {
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

    for (event_type, payload, is_compaction) in events {
        // 1. Compaction boundary: reset the fold state machine
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

        // 2. Fold-and-project through the state machine
        match event_type {
            "message.system" => {
                if let Some(text) = extract_content_text(payload, "content") {
                    messages.push(Message {
                        role: MessageRole::System,
                        content: text,
                        blocks: extract_blocks(payload),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
            }
            "message.user" => {
                if let Some(text) = extract_content_text(payload, "content") {
                    let user_msg = Message {
                        role: MessageRole::User,
                        content: text,
                        blocks: extract_blocks(payload),
                        tool_calls: None,
                        tool_call_id: None,
                    };
                    // Protocol constraint: while a tool call is awaiting a result,
                    // park the message so the Tool message stays right after its
                    // Assistant
                    if !pending_tool_calls.is_empty() {
                        deferred_messages.push(user_msg);
                    } else {
                        messages.push(user_msg);
                    }
                }
            }
            "message.assistant" => {
                // If the previous round still has a dangling unresolved tool,
                // synthesize a repair first
                if !pending_tool_calls.is_empty() {
                    flush_hanging_tools(
                        &mut messages,
                        &mut pending_tool_calls,
                        &mut deferred_messages,
                    );
                }

                let raw_text = extract_content_text(payload, "content").unwrap_or_default();
                let text = strip_think_blocks(&raw_text);
                let tool_calls = payload.get("tool_calls").cloned();
                let is_partial = payload
                    .get("partial")
                    .and_then(|p| p.as_bool())
                    .unwrap_or(false);

                if is_partial
                    && let Some(last) = messages.last_mut()
                    && last.role == MessageRole::Assistant
                    && last.tool_calls.is_none()
                {
                    last.content.push_str(&text);
                    continue;
                }

                if !text.is_empty() || tool_calls.is_some() {
                    // Collect the tool call ids this Assistant message started
                    if let Some(ref calls) = tool_calls
                        && let Some(calls_arr) = calls.as_array()
                    {
                        for c in calls_arr {
                            if let Some(call_id) = c.get("id").and_then(|id| id.as_str()) {
                                pending_tool_calls.push(call_id.to_string());
                            }
                        }
                    }

                    messages.push(Message {
                        role: MessageRole::Assistant,
                        content: text,
                        blocks: extract_blocks(payload),
                        tool_calls,
                        tool_call_id: None,
                    });
                }
            }
            "tool.result" => {
                let mut tool_call_id = payload
                    .get("tool_call_id")
                    .and_then(|id| id.as_str())
                    .map(String::from);
                let content = extract_content_text(payload, "output").unwrap_or_default();

                // FIFO settlement: with no tool_call_id given, pop the head of
                // pending_tool_calls to settle against
                if tool_call_id.is_none() && !pending_tool_calls.is_empty() {
                    tool_call_id = Some(pending_tool_calls.remove(0));
                } else if let Some(ref id) = tool_call_id
                    && let Some(pos) = pending_tool_calls.iter().position(|x| x == id)
                {
                    pending_tool_calls.remove(pos);
                }

                messages.push(Message {
                    role: MessageRole::Tool,
                    content,
                    blocks: serde_json::json!([]),
                    tool_calls: None,
                    tool_call_id,
                });

                // Once every unresolved tool has returned, release the deferred queue
                if pending_tool_calls.is_empty() && !deferred_messages.is_empty() {
                    messages.append(&mut deferred_messages);
                }
            }
            "step.begin" => {
                if !pending_tool_calls.is_empty() {
                    flush_hanging_tools(
                        &mut messages,
                        &mut pending_tool_calls,
                        &mut deferred_messages,
                    );
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
                if let Some(text) = payload.get("text").and_then(|t| t.as_str())
                    && let Some(last) = messages.last_mut()
                    && last.role == MessageRole::Assistant
                {
                    last.content.push_str(text);
                }
            }
            "tool.call" => {
                let call_id = payload
                    .get("tool_call_id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("call")
                    .to_string();
                let name = payload
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let args = payload
                    .get("arguments")
                    .and_then(|a| a.as_str())
                    .unwrap_or("{}");
                pending_tool_calls.push(call_id.clone());
                if let Some(last) = messages.last_mut()
                    && last.role == MessageRole::Assistant
                {
                    let call_obj = serde_json::json!({
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": args,
                        }
                    });
                    if let Some(ref mut arr) =
                        last.tool_calls.as_mut().and_then(|v| v.as_array_mut())
                    {
                        arr.push(call_obj);
                    }
                }
            }
            "step.end" => {
                let finish_reason = payload.get("finish_reason").and_then(|r| r.as_str());
                if finish_reason != Some("interrupted")
                    && finish_reason != Some("error")
                    && let Some(last) = messages.last_mut()
                    && last.role == MessageRole::Assistant
                    && let Some(arr) = last.tool_calls.as_ref().and_then(|v| v.as_array())
                    && arr.is_empty()
                {
                    last.tool_calls = None;
                }
            }
            _ => {}
        }
    }

    // 3. Loop finished: if a dangling unresolved tool remains at the end (a
    // crashed process or a cancellation), synthesize a repair automatically
    flush_hanging_tools(
        &mut messages,
        &mut pending_tool_calls,
        &mut deferred_messages,
    );

    Ok(sanitize_and_repair_projection(messages))
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
            "SELECT event_type, payload, is_compaction FROM wire_events WHERE session_id = ?1 \
             AND seq >= (SELECT COALESCE(MAX(seq), 0) FROM wire_events WHERE session_id = ?1 AND is_compaction = 1) \
             ORDER BY seq ASC"
        )?;

        let mut raw_rows = Vec::new();
        let mut rows = stmt.query(params![session_id])?;
        while let Some(row) = rows.next()? {
            let event_type: String = row.get(0)?;
            let payload_str: String = row.get(1)?;
            let is_compaction: bool = row.get(2)?;
            let payload: serde_json::Value = serde_json::from_str(&payload_str)?;
            raw_rows.push((event_type, payload, is_compaction));
        }
        drop(rows);
        drop(stmt);
        drop(conn);

        fold_wire_events(raw_rows.iter().map(|(t, p, c)| (t.as_str(), p, *c)))
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

        // Find the most recent checkpoint
        let last_checkpoint: Option<(i64, bool)> = tx
            .query_row(
                "SELECT seq, is_compaction FROM wire_events 
             WHERE session_id = ?1 AND is_checkpoint = 1 
             ORDER BY seq DESC LIMIT 1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let (target_seq, is_compaction) =
            last_checkpoint.ok_or(EventStoreError::CheckpointNotFound)?;

        // Blocked by protocol: refuse to roll back across a compaction boundary
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

        // User asks a question
        store
            .append_event(&RawWireEvent {
                id: "evt_1".into(),
                session_id: session.into(),
                event_type: "message.user".into(),
                payload: serde_json::json!({ "content": "Hello Rust" }),
                is_checkpoint: true,
                is_compaction: false,
                created_at: 1000,
            })
            .unwrap();

        // Assistant replies
        store
            .append_event(&RawWireEvent {
                id: "evt_2".into(),
                session_id: session.into(),
                event_type: "message.assistant".into(),
                payload: serde_json::json!({ "content": "Hi there!" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 1001,
            })
            .unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, MessageRole::User);
        assert_eq!(msgs[1].role, MessageRole::Assistant);

        // Trigger a compaction
        store
            .checkpoint_compress(session, "Prior context summary")
            .unwrap();

        let msgs_after_compaction = store.fold_projection(session).unwrap();
        assert_eq!(msgs_after_compaction.len(), 1);
        assert_eq!(msgs_after_compaction[0].role, MessageRole::System);
        assert_eq!(msgs_after_compaction[0].content, "Prior context summary");

        // Verify undo is refused across a compaction boundary
        let undo_res = store.undo_to_last_checkpoint(session);
        assert!(matches!(
            undo_res,
            Err(EventStoreError::UndoCompactionBoundary)
        ));
    }

    #[test]
    fn test_deferral_queue_tool_results_consecutive() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_session_deferral";

        // 1. The Assistant issues two tool calls
        store
            .append_event(&RawWireEvent {
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
            })
            .unwrap();

        // 2. A user message is interleaved (or a system-injected prompt)
        store
            .append_event(&RawWireEvent {
                id: "evt_2".into(),
                session_id: session.into(),
                event_type: "message.user".into(),
                payload: serde_json::json!({ "content": "Interrupted prompt" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 101,
            })
            .unwrap();

        // 3. The first tool result returns
        store
            .append_event(&RawWireEvent {
                id: "evt_3".into(),
                session_id: session.into(),
                event_type: "tool.result".into(),
                payload: serde_json::json!({ "tool_call_id": "call_a", "output": "output a" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 102,
            })
            .unwrap();

        // 4. The second tool result returns
        store
            .append_event(&RawWireEvent {
                id: "evt_4".into(),
                session_id: session.into(),
                event_type: "tool.result".into(),
                payload: serde_json::json!({ "tool_call_id": "call_b", "output": "output b" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 103,
            })
            .unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 4);
        // Verify deferred ordering: each Tool result stays right after its call,
        // and the interrupted user input lands last
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

        // 1. The Assistant issues a tool call that is unexpectedly left unresolved
        store
            .append_event(&RawWireEvent {
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
            })
            .unwrap();

        // 2. End the turn directly, or start the next one with input
        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, MessageRole::Assistant);
        // The key assertion: a tool call that never got a result must be healed by
        // synthesizing an isError message
        assert_eq!(msgs[1].role, MessageRole::Tool);
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("call_hang"));
        assert!(msgs[1].content.contains("Tool execution was interrupted"));
    }

    #[test]
    fn test_system_prompt_and_multimodal_extraction() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_multimodal";

        // 1. System prompt event
        store
            .append_event(&RawWireEvent {
                id: "evt_sys".into(),
                session_id: session.into(),
                event_type: "message.system".into(),
                payload: serde_json::json!({ "content": "You are Kimi Code CLI." }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 10,
            })
            .unwrap();

        // 2. Multimodal user input (a text plus an image array)
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

        // 3. The assistant reply carries a `<think>` draft
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
        assert!(
            msgs[1]
                .content
                .contains("[Image: data:image/png;base64,mock]")
        );
        assert_eq!(msgs[2].role, MessageRole::Assistant);
        // Verify the think tag is stripped and only the text survives
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
        store
            .append_event(&RawWireEvent {
                id: "evt_bu".into(),
                session_id: session.into(),
                event_type: "message.user".into(),
                payload: serde_json::json!({ "content": "Summarize this", "blocks": blocks_user }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 1,
            })
            .unwrap();

        let blocks_asst = serde_json::json!([
            { "type": "think", "think": "reasoning", "encrypted": "sig" }
        ]);
        store
            .append_event(&RawWireEvent {
                id: "evt_ba".into(),
                session_id: session.into(),
                event_type: "message.assistant".into(),
                payload: serde_json::json!({ "content": "done", "blocks": blocks_asst }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 2,
            })
            .unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].blocks, blocks_user);
        assert_eq!(msgs[1].blocks, blocks_asst);

        // A message with no blocks folds to an empty array, not null
        store
            .append_event(&RawWireEvent {
                id: "evt_plain".into(),
                session_id: session.into(),
                event_type: "message.user".into(),
                payload: serde_json::json!({ "content": "plain text message" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 3,
            })
            .unwrap();
        let msgs2 = store.fold_projection(session).unwrap();
        let plain = msgs2.last().unwrap();
        assert_eq!(plain.blocks, serde_json::json!([]));
    }

    #[test]
    fn test_tool_result_missing_id_fifo_reconciliation() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_fifo_id";

        // The Assistant starts tool call call_1
        store
            .append_event(&RawWireEvent {
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
            })
            .unwrap();

        // The tool result comes back with its tool_call_id field missing
        store
            .append_event(&RawWireEvent {
                id: "evt_2".into(),
                session_id: session.into(),
                event_type: "tool.result".into(),
                payload: serde_json::json!({
                    "output": "command success"
                }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 31,
            })
            .unwrap();

        let msgs = store.fold_projection(session).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].role, MessageRole::Tool);
        // The key assertion: FIFO re-associates it with call_1, so no bogus
        // dangling-tool error is raised
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(msgs[1].content, "command success");
    }

    #[test]
    fn test_sanitize_and_repair_projection_rules() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_repair_rules";

        // 1. Inject an orphan leading Assistant message (e.g. a truncation leftover)
        store
            .append_event(&RawWireEvent {
                id: "evt_leading_bad".into(),
                session_id: session.into(),
                event_type: "message.assistant".into(),
                payload: serde_json::json!({ "content": "I am an orphan leading assistant" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 1,
            })
            .unwrap();

        // 2. A correct User message
        store
            .append_event(&RawWireEvent {
                id: "evt_user_1".into(),
                session_id: session.into(),
                event_type: "message.user".into(),
                payload: serde_json::json!({ "content": "Real first user message" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 2,
            })
            .unwrap();

        // 3. Inject an orphan Tool.result that declares no call_id at all
        store.append_event(&RawWireEvent {
            id: "evt_orphan_tool".into(),
            session_id: session.into(),
            event_type: "tool.result".into(),
            payload: serde_json::json!({ "tool_call_id": "ghost_call_999", "output": "ghost output" }),
            is_checkpoint: false,
            is_compaction: false,
            created_at: 3,
        }).unwrap();

        // 4. Two consecutive Assistant messages (no tool_calls)
        store
            .append_event(&RawWireEvent {
                id: "evt_asst_1".into(),
                session_id: session.into(),
                event_type: "message.assistant".into(),
                payload: serde_json::json!({ "content": "Part 1 of response." }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 4,
            })
            .unwrap();

        store
            .append_event(&RawWireEvent {
                id: "evt_asst_2".into(),
                session_id: session.into(),
                event_type: "message.assistant".into(),
                payload: serde_json::json!({ "content": "Part 2 of response." }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 5,
            })
            .unwrap();

        let msgs = store.fold_projection(session).unwrap();
        // 1. The leading orphan Assistant is cleared and the first message lines
        //    up as User
        assert_eq!(msgs[0].role, MessageRole::User);
        assert_eq!(msgs[0].content, "Real first user message");

        // 2. The orphan Tool message with no matching call id is dropped
        assert!(
            !msgs
                .iter()
                .any(|m| m.tool_call_id.as_deref() == Some("ghost_call_999"))
        );

        // 3. The consecutive Assistant messages are merged into one
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].role, MessageRole::Assistant);
        assert!(msgs[1].content.contains("Part 1 of response."));
        assert!(msgs[1].content.contains("Part 2 of response."));
    }

    #[test]
    fn test_event_store_streamed_loop_events() {
        let store = SqliteEventStore::new_in_memory().unwrap();
        let session = "test_streamed_events";

        store
            .append_event(&RawWireEvent {
                id: "evt_u".into(),
                session_id: session.into(),
                event_type: "message.user".into(),
                payload: serde_json::json!({ "content": "Check weather" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 10,
            })
            .unwrap();

        store
            .append_event(&RawWireEvent {
                id: "evt_sb".into(),
                session_id: session.into(),
                event_type: "step.begin".into(),
                payload: serde_json::json!({ "uuid": "step_stream_1" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 11,
            })
            .unwrap();

        store
            .append_event(&RawWireEvent {
                id: "evt_cp".into(),
                session_id: session.into(),
                event_type: "content.part".into(),
                payload: serde_json::json!({ "text": "Checking " }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 12,
            })
            .unwrap();

        store
            .append_event(&RawWireEvent {
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
            })
            .unwrap();

        store
            .append_event(&RawWireEvent {
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
            })
            .unwrap();

        store
            .append_event(&RawWireEvent {
                id: "evt_se".into(),
                session_id: session.into(),
                event_type: "step.end".into(),
                payload: serde_json::json!({ "finish_reason": "stop" }),
                is_checkpoint: false,
                is_compaction: false,
                created_at: 15,
            })
            .unwrap();

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
