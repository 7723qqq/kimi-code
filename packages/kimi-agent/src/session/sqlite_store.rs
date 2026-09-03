//! SQLite-backed session persistence store.
//!
//! Provides zero-dependency standalone persistence for sessions, turns,
//! messages, checkpoints, and arbitrary state domains using embedded SQLite (WAL mode).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::LLMMessage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct SqliteSessionStore {
    conn: Mutex<Connection>,
}

impl SqliteSessionStore {
    /// Open or create a SQLite database file at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// Create an in-memory SQLite database.
    pub fn in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, rusqlite::Error> {
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                title TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS turns (
                turn_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                turn_number INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                usage TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                tool_calls TEXT,
                tool_call_id TEXT,
                blocks TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS state_entries (
                domain TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (domain, key)
            );

            CREATE TABLE IF NOT EXISTS checkpoints (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            ",
        )?;

        // Ensure columns exist if table was created by older schema
        let columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(messages)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(std::result::Result::ok).collect()
        };
        if !columns.contains("tool_calls") {
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN tool_calls TEXT", []);
        }
        if !columns.contains("tool_call_id") {
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN tool_call_id TEXT", []);
        }
        if !columns.contains("blocks") {
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN blocks TEXT", []);
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Create or update a session header.
    pub fn create_session(
        &self,
        session_id: &str,
        title: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO sessions (session_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(session_id) DO UPDATE SET
                title = coalesce(?2, title),
                updated_at = ?3",
            params![session_id, title, now],
        )?;
        Ok(())
    }

    /// List all persisted sessions ordered by last updated time.
    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT session_id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Get summary for a specific session by ID.
    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionSummary>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT session_id, title, created_at, updated_at FROM sessions WHERE session_id = ?1",
        )?;
        let mut rows = stmt.query(params![session_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(SessionSummary {
                session_id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Delete a session and all its cascading turns, messages, and checkpoints.
    pub fn delete_session(&self, session_id: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(affected > 0)
    }

    /// The turn number a new turn for this session should take, derived from
    /// the `turns` table so a caller that owns the store does not have to keep
    /// its own counter — one would reset on restart and collide on insert.
    pub fn next_turn_number(&self, session_id: &str) -> Result<u32, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let highest: i64 = conn.query_row(
            "SELECT COALESCE(MAX(turn_number), 0) FROM turns WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        Ok(highest.max(0) as u32 + 1)
    }

    /// Append turn messages and record turn execution metadata.
    pub fn save_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        turn_number: u32,
        messages: &[LLMMessage],
        usage: Option<&TokenUsage>,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "INSERT INTO sessions (session_id, title, created_at, updated_at)
             VALUES (?1, NULL, ?2, ?2)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = ?2",
            params![session_id, now],
        )?;

        let usage_json = usage.map(|u| serde_json::to_string(u).unwrap_or_default());

        conn.execute(
            "INSERT INTO turns (turn_id, session_id, turn_number, status, started_at, completed_at, usage)
             VALUES (?1, ?2, ?3, 'completed', ?4, ?4, ?5)
             ON CONFLICT(turn_id) DO UPDATE SET
                status = 'completed',
                completed_at = ?4,
                usage = coalesce(?5, usage)",
            params![turn_id, session_id, turn_number, now, usage_json],
        )?;

        for m in messages {
            let tool_calls_json = if m.tool_calls.is_empty() {
                None
            } else {
                serde_json::to_string(&m.tool_calls).ok()
            };
            let blocks_json = if m.blocks.is_empty() {
                None
            } else {
                serde_json::to_string(&m.blocks).ok()
            };
            conn.execute(
                "INSERT INTO messages (session_id, turn_id, role, content, tool_calls, tool_call_id, blocks, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    session_id,
                    turn_id,
                    m.role,
                    m.content,
                    tool_calls_json,
                    m.tool_call_id,
                    blocks_json,
                    now
                ],
            )?;
        }

        Ok(())
    }

    /// Load the linear conversation history for a session.
    pub fn load_session_history(
        &self,
        session_id: &str,
    ) -> Result<Vec<LLMMessage>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT role, content, tool_calls, tool_call_id, blocks FROM messages WHERE session_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let role: String = row.get(0)?;
            let content: String = row.get(1)?;
            let tool_calls_str: Option<String> = row.get(2)?;
            let tool_call_id: Option<String> = row.get(3)?;
            let blocks_str: Option<String> = row.get(4)?;

            let tool_calls = tool_calls_str
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let blocks = blocks_str
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            Ok(LLMMessage {
                role,
                content,
                blocks,
                tool_call_id,
                tool_calls,
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Put a key-value pair in a state domain (state bridge storage).
    pub fn put_state(&self, domain: &str, key: &str, value: &Value) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let val_str = serde_json::to_string(value).unwrap_or_default();
        conn.execute(
            "INSERT INTO state_entries (domain, key, value, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(domain, key) DO UPDATE SET
                value = ?3,
                updated_at = ?4",
            params![domain, key, val_str, now],
        )?;
        Ok(())
    }

    /// Get a value from a state domain.
    pub fn get_state(&self, domain: &str, key: &str) -> Result<Option<Value>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT value FROM state_entries WHERE domain = ?1 AND key = ?2")?;
        let mut rows = stmt.query(params![domain, key])?;
        if let Some(row) = rows.next()? {
            let s: String = row.get(0)?;
            let val: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
            Ok(Some(val))
        } else {
            Ok(None)
        }
    }

    /// Save a named checkpoint for a session.
    pub fn save_checkpoint(
        &self,
        session_id: &str,
        checkpoint_id: &str,
        name: &str,
        data: &Value,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let data_str = serde_json::to_string(data).unwrap_or_default();
        conn.execute(
            "INSERT INTO checkpoints (id, session_id, name, data, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                name = ?3,
                data = ?4,
                created_at = ?5",
            params![checkpoint_id, session_id, name, data_str, now],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sqlite_session_lifecycle() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session("sess-1", Some("Test Session"))
            .unwrap();

        let msgs = vec![
            LLMMessage::user("Hello"),
            LLMMessage::assistant("Hi there!"),
        ];
        store.save_turn("sess-1", "turn-1", 1, &msgs, None).unwrap();

        let loaded = store.load_session_history("sess-1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].role, "user");
        assert_eq!(loaded[0].content, "Hello");
        assert_eq!(loaded[1].role, "assistant");
        assert_eq!(loaded[1].content, "Hi there!");

        let list = store.list_sessions().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].session_id, "sess-1");
        assert_eq!(list[0].title.as_deref(), Some("Test Session"));
    }

    #[test]
    fn test_sqlite_state_entries_and_checkpoints() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-1", None).unwrap();

        store
            .put_state("skill", "commit", &serde_json::json!({ "name": "commit" }))
            .unwrap();
        let read = store.get_state("skill", "commit").unwrap().unwrap();
        assert_eq!(read["name"], "commit");

        assert!(store.get_state("skill", "unknown").unwrap().is_none());

        store
            .save_checkpoint(
                "sess-1",
                "chk-1",
                "Step 1",
                &serde_json::json!({ "step": 1 }),
            )
            .unwrap();
    }

    #[test]
    fn test_sqlite_structured_tool_calls_and_blocks() {
        use crate::turn_loop::types::{ContentBlock, ToolCall};

        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-structured", None).unwrap();

        let msgs = vec![
            LLMMessage {
                role: "user".into(),
                content: "show me image".into(),
                blocks: vec![ContentBlock::Text {
                    text: "show me image".into(),
                }],
                tool_calls: vec![],
                tool_call_id: None,
            },
            LLMMessage {
                role: "assistant".into(),
                content: "calling tool".into(),
                blocks: vec![],
                tool_calls: vec![ToolCall {
                    id: "call_read_1".into(),
                    name: "Read".into(),
                    arguments: serde_json::json!({ "path": "file.txt" }),
                }],
                tool_call_id: None,
            },
            LLMMessage {
                role: "tool".into(),
                content: "file contents".into(),
                blocks: vec![],
                tool_calls: vec![],
                tool_call_id: Some("call_read_1".into()),
            },
        ];

        store
            .save_turn("sess-structured", "turn-1", 1, &msgs, None)
            .unwrap();

        let loaded = store.load_session_history("sess-structured").unwrap();
        assert_eq!(loaded.len(), 3);

        // Turn 1 user message with blocks
        assert_eq!(loaded[0].role, "user");
        assert_eq!(loaded[0].blocks.len(), 1);

        // Turn 1 assistant message with structured tool call
        assert_eq!(loaded[1].role, "assistant");
        assert_eq!(loaded[1].tool_calls.len(), 1);
        assert_eq!(loaded[1].tool_calls[0].id, "call_read_1");
        assert_eq!(loaded[1].tool_calls[0].name, "Read");
        assert_eq!(loaded[1].tool_calls[0].arguments["path"], "file.txt");

        // Turn 1 tool result with tool_call_id
        assert_eq!(loaded[2].role, "tool");
        assert_eq!(loaded[2].content, "file contents");
        assert_eq!(loaded[2].tool_call_id.as_deref(), Some("call_read_1"));
    }
}
