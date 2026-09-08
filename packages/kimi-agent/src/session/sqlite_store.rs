//! SQLite-backed session persistence store.
//!
//! Provides zero-dependency standalone persistence for sessions, turns,
//! messages, checkpoints, and arbitrary state domains using embedded SQLite (WAL mode).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::LLMMessage;

/// Format a millisecond timestamp as an ISO-8601 string.
fn format_iso(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Compute standard deterministic workspace ID `wd_<slug>_<hash12>`.
pub fn encode_workdir_key(work_dir: &str) -> String {
    let normalized = work_dir.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let base = normalized.split('/').next_back().unwrap_or(normalized);

    let mut slug = String::new();
    for c in base.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            slug.push(c);
        } else {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    let slug = if slug.len() > 40 {
        slug[..40].trim_matches('-').to_string()
    } else {
        slug
    };
    let final_slug = if slug.is_empty() || slug == "." || slug == ".." {
        "workspace".to_string()
    } else {
        slug
    };

    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let hash12 = &hash[..12];

    format!("wd_{final_slug}_{hash12}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionExport {
    pub session: SessionSummary,
    pub messages: Vec<LLMMessage>,
    pub turns_count: usize,
    pub exported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub root: String,
    pub name: String,
    pub created_at: String,
    pub last_opened_at: String,
    pub session_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub session_id: String,
    pub workspace_id: String,
    pub session_title: String,
    pub agent_id: String,
    pub role: String,
    pub snippet: String,
    pub time: String,
    pub turn: usize,
    pub step_id: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHistoryChange {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oversize: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHistoryContent {
    pub version: usize,
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
}

/// Helper to compute status, additions, and deletions for file content changes.
pub fn compute_line_diff(before: Option<&str>, after: Option<&str>) -> (String, usize, usize) {
    match (before, after) {
        (None, Some(a)) => {
            let lines = a.lines().count();
            ("added".to_string(), lines, 0)
        }
        (Some(b), None) => {
            let lines = b.lines().count();
            ("deleted".to_string(), 0, lines)
        }
        (Some(b), Some(a)) => {
            if b == a {
                ("modified".to_string(), 0, 0)
            } else {
                let b_lines: Vec<&str> = b.lines().collect();
                let a_lines: Vec<&str> = a.lines().collect();
                let b_set: std::collections::HashSet<&str> = b_lines.iter().copied().collect();
                let a_set: std::collections::HashSet<&str> = a_lines.iter().copied().collect();
                let mut additions = 0;
                let mut deletions = 0;
                for l in &a_lines {
                    if !b_set.contains(l) {
                        additions += 1;
                    }
                }
                for l in &b_lines {
                    if !a_set.contains(l) {
                        deletions += 1;
                    }
                }
                if additions == 0 && deletions == 0 {
                    additions = a_lines.len().abs_diff(b_lines.len());
                }
                ("modified".to_string(), additions, deletions)
            }
        }
        (None, None) => ("modified".to_string(), 0, 0),
    }
}

fn extract_snippet(text: &str, query: &str, max_len: usize) -> String {
    let lower_text = text.to_lowercase();
    let lower_query = query.to_lowercase();
    if let Some(idx) = lower_text.find(&lower_query) {
        let start = idx.saturating_sub(max_len / 4);
        let end = (idx + query.len() + max_len * 3 / 4).min(text.len());
        let mut snippet = String::new();
        if start > 0 {
            snippet.push_str("...");
        }
        snippet.push_str(&text[start..end]);
        if end < text.len() {
            snippet.push_str("...");
        }
        snippet
    } else if text.len() > max_len {
        format!("{}...", &text[..max_len])
    } else {
        text.to_string()
    }
}

/// The synthetic turn id the compaction rewrite saves its summary under.
const COMPACT_TURN_ID: &str = "turn-compact";

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
                updated_at INTEGER NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                parent_session_id TEXT
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

            CREATE TABLE IF NOT EXISTS workspaces (
                workspace_id TEXT PRIMARY KEY,
                root TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_opened_at INTEGER NOT NULL,
                trusted INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS session_file_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                turn_id INTEGER NOT NULL,
                path TEXT NOT NULL,
                status TEXT NOT NULL,
                content_before TEXT,
                content_after TEXT,
                additions INTEGER NOT NULL DEFAULT 0,
                deletions INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_file_history_session_turn ON session_file_history(session_id, turn_id);

            CREATE TABLE IF NOT EXISTS wire_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                is_checkpoint BOOLEAN NOT NULL DEFAULT 0,
                is_compaction BOOLEAN NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_wire_session_seq ON wire_events(session_id, seq);
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

        let session_columns: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.filter_map(std::result::Result::ok).collect()
        };
        if !session_columns.contains("workspace_id") {
            let _ = conn.execute("ALTER TABLE sessions ADD COLUMN workspace_id TEXT", []);
        }
        if !session_columns.contains("archived") {
            let _ = conn.execute(
                "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
                [],
            );
        }
        if !session_columns.contains("parent_session_id") {
            let _ = conn.execute(
                "ALTER TABLE sessions ADD COLUMN parent_session_id TEXT",
                [],
            );
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
        self.create_session_with_workspace(session_id, title, None)
    }

    /// Create or update a session header with an optional workspace association.
    pub fn create_session_with_workspace(
        &self,
        session_id: &str,
        title: Option<&str>,
        workspace_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO sessions (session_id, title, created_at, updated_at, workspace_id)
             VALUES (?1, ?2, ?3, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET
                title = coalesce(?2, title),
                updated_at = ?3,
                workspace_id = coalesce(?4, workspace_id)",
            params![session_id, title, now, workspace_id],
        )?;
        Ok(())
    }

    /// List all persisted sessions ordered by last updated time.
    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT session_id, title, created_at, updated_at, workspace_id, archived, parent_session_id FROM sessions ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                workspace_id: row.get(4)?,
                archived: row.get::<_, i64>(5)? != 0,
                parent_session_id: row.get(6)?,
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
            "SELECT session_id, title, created_at, updated_at, workspace_id, archived, parent_session_id FROM sessions WHERE session_id = ?1",
        )?;
        let mut rows = stmt.query(params![session_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(SessionSummary {
                session_id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                workspace_id: row.get(4)?,
                archived: row.get::<_, i64>(5)? != 0,
                parent_session_id: row.get(6)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Export an entire session's metadata and conversation history as a snapshot.
    pub fn export_session(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionExport>, rusqlite::Error> {
        let session = match self.get_session(session_id)? {
            Some(s) => s,
            None => return Ok(None),
        };
        let messages = self.load_session_history(session_id)?;
        let turns_count: usize = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM turns WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .unwrap_or(0)
        };
        let now_iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Ok(Some(SessionExport {
            session,
            messages,
            turns_count,
            exported_at: now_iso,
        }))
    }

    /// Create or update a workspace.
    pub fn create_workspace(
        &self,
        root: &str,
        name: Option<&str>,
    ) -> Result<WorkspaceSummary, rusqlite::Error> {
        let id = encode_workdir_key(root);
        let normalized_root = root.replace('\\', "/").trim_end_matches('/').to_string();
        let base = normalized_root
            .split('/')
            .next_back()
            .unwrap_or(&normalized_root)
            .to_string();
        let ws_name = name.unwrap_or(&base);
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO workspaces (workspace_id, root, name, created_at, last_opened_at, trusted)
             VALUES (?1, ?2, ?3, ?4, ?4, 1)
             ON CONFLICT(workspace_id) DO UPDATE SET
                name = coalesce(?3, name),
                last_opened_at = ?4",
            params![id, normalized_root, ws_name, now],
        )?;

        let session_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE workspace_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let (created_at, last_opened_at): (i64, i64) = conn.query_row(
            "SELECT created_at, last_opened_at FROM workspaces WHERE workspace_id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        Ok(WorkspaceSummary {
            id,
            root: normalized_root,
            name: ws_name.to_string(),
            created_at: format_iso(created_at),
            last_opened_at: format_iso(last_opened_at),
            session_count,
        })
    }

    /// List all registered workspaces ordered by last opened time.
    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceSummary>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT w.workspace_id, w.root, w.name, w.created_at, w.last_opened_at,
                    (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.workspace_id)
             FROM workspaces w ORDER BY w.last_opened_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let root: String = row.get(1)?;
            let name: String = row.get(2)?;
            let created_at: i64 = row.get(3)?;
            let last_opened_at: i64 = row.get(4)?;
            let session_count: usize = row.get(5)?;
            Ok(WorkspaceSummary {
                id,
                root,
                name,
                created_at: format_iso(created_at),
                last_opened_at: format_iso(last_opened_at),
                session_count,
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Retrieve a single workspace summary by ID.
    pub fn get_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceSummary>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT w.workspace_id, w.root, w.name, w.created_at, w.last_opened_at,
                    (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.workspace_id)
             FROM workspaces w WHERE w.workspace_id = ?1",
        )?;
        let mut rows = stmt.query(params![workspace_id])?;
        if let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let root: String = row.get(1)?;
            let name: String = row.get(2)?;
            let created_at: i64 = row.get(3)?;
            let last_opened_at: i64 = row.get(4)?;
            let session_count: usize = row.get(5)?;
            Ok(Some(WorkspaceSummary {
                id,
                root,
                name,
                created_at: format_iso(created_at),
                last_opened_at: format_iso(last_opened_at),
                session_count,
            }))
        } else {
            Ok(None)
        }
    }

    /// Update a workspace's display name.
    pub fn update_workspace_name(
        &self,
        workspace_id: &str,
        name: &str,
    ) -> Result<Option<WorkspaceSummary>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "UPDATE workspaces SET name = ?1, last_opened_at = ?2 WHERE workspace_id = ?3",
            params![name, chrono::Utc::now().timestamp_millis(), workspace_id],
        )?;
        drop(conn);
        if affected > 0 {
            self.get_workspace(workspace_id)
        } else {
            Ok(None)
        }
    }

    /// Delete a workspace entry.
    pub fn delete_workspace(&self, workspace_id: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "DELETE FROM workspaces WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(affected > 0)
    }

    /// Query whether a workspace is trusted. Default to true if unconfigured.
    pub fn is_workspace_trusted(&self, workspace_id: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let trusted: Option<i64> = conn
            .query_row(
                "SELECT trusted FROM workspaces WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(trusted.map(|v| v != 0).unwrap_or(true))
    }

    /// Set trust state for a workspace.
    pub fn set_workspace_trusted(
        &self,
        workspace_id: &str,
        trusted: bool,
    ) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "UPDATE workspaces SET trusted = ?2 WHERE workspace_id = ?1",
            params![workspace_id, if trusted { 1 } else { 0 }],
        )?;
        Ok(affected > 0)
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

    /// Fork an existing session into a new session with copied history.
    pub fn fork_session(
        &self,
        source_session_id: &str,
        new_session_id: &str,
        title: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let history = self.load_session_history(source_session_id)?;
        let source = self.get_session(source_session_id)?;
        let Some(source) = source else {
            return Ok(false);
        };
        let effective_title = title.or(source.title.as_deref());
        self.create_session_with_workspace(
            new_session_id,
            effective_title,
            source.workspace_id.as_deref(),
        )?;
        // Children are queryable via /sessions/{id}/children.
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE sessions SET parent_session_id = ?1 WHERE session_id = ?2",
                params![source_session_id, new_session_id],
            )?;
        }
        if !history.is_empty() {
            self.save_turn(new_session_id, "turn-fork", 1, &history, None)?;
        }
        Ok(true)
    }

    /// Archive a session (v2 `archive` action): hidden from the default
    /// session list until restored.
    pub fn archive_session(&self, session_id: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE sessions SET archived = 1, updated_at = ?2 WHERE session_id = ?1",
            params![session_id, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(changed > 0)
    }

    /// Restore a previously archived session (v2 `restore` action).
    pub fn restore_session(&self, session_id: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE sessions SET archived = 0, updated_at = ?2 WHERE session_id = ?1",
            params![session_id, chrono::Utc::now().timestamp_millis()],
        )?;
        Ok(changed > 0)
    }

    /// Sessions forked from the given session (v2 `/sessions/{id}/children`).
    pub fn list_children(&self, session_id: &str) -> Result<Vec<SessionSummary>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT session_id, title, created_at, updated_at, workspace_id, archived, parent_session_id FROM sessions WHERE parent_session_id = ?1 ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                workspace_id: row.get(4)?,
                archived: row.get::<_, i64>(5)? != 0,
                parent_session_id: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Deterministic title derivation from the session's own history
    /// (v2 `title/generate` source=first_turn|user_prompts). The `digest`
    /// source needs a managed LLM call and is rejected here.
    pub fn generate_title(
        &self,
        session_id: &str,
        source: Option<&str>,
    ) -> Result<Option<String>, String> {
        match source.unwrap_or("first_turn") {
            "digest" => {
                return Err("source=digest requires the managed chat_title channel, which the native server does not wire yet".into())
            }
            "first_turn" | "user_prompts" => {}
            other => return Err(format!("unknown title source: {other}")),
        }
        let history = self.load_session_history(session_id).map_err(|e| e.to_string())?;
        let prompt = history
            .iter()
            .filter(|m| m.role == "user")
            .map(|m| m.content.trim())
            .find(|c| !c.is_empty());
        let Some(prompt) = prompt else {
            return Ok(None);
        };
        let mut title: String = prompt
            .chars()
            .map(|c| if c.is_whitespace() { ' ' } else { c })
            .collect();
        title = title.trim().to_string();
        title.truncate(60);
        Ok(Some(title))
    }

    /// Undo the latest `count` completed turns in the session.
    ///
    /// Refuses to undo across a compaction boundary (the `turn-compact`
    /// summary produced by [`Self::compact_session`]): the pre-compaction
    /// messages no longer exist as rows, so deleting the summary turn would
    /// corrupt the projection — the same guarantee the TS event ledger
    /// enforces as `UndoCompactionBoundary` (event_store/mod.rs:43-47).
    pub fn undo_turns(&self, session_id: &str, count: usize) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT turn_id FROM turns WHERE session_id = ?1 ORDER BY turn_number DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let turn_ids: Vec<String> = stmt
            .query_map(params![session_id, count as i64], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        if turn_ids.iter().any(|tid| tid == COMPACT_TURN_ID) {
            return Err(format!(
                "undo refused: crossing the compaction boundary turn '{COMPACT_TURN_ID}' would corrupt the session projection"
            ));
        }

        for tid in &turn_ids {
            let _ = conn.execute(
                "DELETE FROM session_file_history WHERE session_id = ?1 AND turn_id IN (
                    SELECT turn_number FROM turns WHERE session_id = ?1 AND turn_id = ?2
                )",
                params![session_id, tid],
            );
            conn.execute(
                "DELETE FROM messages WHERE session_id = ?1 AND turn_id = ?2",
                params![session_id, tid],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM turns WHERE turn_id = ?1 AND session_id = ?2",
                params![tid, session_id],
            )
            .map_err(|e| e.to_string())?;
        }

        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE session_id = ?1",
            params![session_id, now],
        )
        .map_err(|e| e.to_string())?;

        Ok(turn_ids.len())
    }

    /// Revert file modifications recorded in a specific turn of a session,
    /// restoring files to their `content_before` states (or deleting newly created ones).
    pub fn revert_turn_file_changes(
        &self,
        session_id: &str,
        turn_id: usize,
        workspace_root: &Path,
    ) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT path, content_before, status FROM session_file_history
                 WHERE session_id = ?1 AND turn_id = ?2 ORDER BY id DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id, turn_id as i64], |row| {
                let path: String = row.get(0)?;
                let content_before: Option<String> = row.get(1)?;
                let status: String = row.get(2)?;
                Ok((path, content_before, status))
            })
            .map_err(|e| e.to_string())?;

        let mut reverted = Vec::new();
        for item in rows {
            let (rel_path, before, status) = item.map_err(|e| e.to_string())?;
            let full_path = workspace_root.join(&rel_path);
            if status == "added" || before.is_none() {
                if full_path.exists() {
                    let _ = std::fs::remove_file(&full_path);
                }
            } else if let Some(text) = before {
                if let Some(parent) = full_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&full_path, text)
                    .map_err(|e| format!("Failed to restore {}: {e}", full_path.display()))?;
            }
            reverted.push(rel_path);
        }
        Ok(reverted)
    }

    /// Compact history for the session using the force compaction algorithm.
    ///
    /// Records a `compaction-boundary` checkpoint first so undo bookkeeping
    /// can refuse to cross it, mirroring the ledger's compaction markers
    /// (event_store `is_compaction`).
    pub fn compact_session(&self, session_id: &str) -> Result<usize, String> {
        let history = self.load_session_history(session_id).map_err(|e| e.to_string())?;
        if history.len() <= 2 {
            return Ok(0);
        }
        let config = crate::compaction::CompactionConfig::default();
        let compacted = crate::compaction::force_compact_messages(&history, &config);
        if compacted.len() >= history.len() {
            return Ok(0);
        }
        let removed = history.len() - compacted.len();
        self.save_checkpoint(
            session_id,
            &format!("compaction-{session_id}-{}", chrono::Utc::now().timestamp_millis()),
            "compaction-boundary",
            &json!({
                "messages_before": history.len(),
                "removed": removed,
            }),
        )
        .map_err(|e| e.to_string())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM messages WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        self.save_turn(session_id, COMPACT_TURN_ID, 1, &compacted, None)
            .map_err(|e| e.to_string())?;
        Ok(removed)
    }

    /// Update the session title and refresh updated_at timestamp.
    pub fn update_session_title(
        &self,
        session_id: &str,
        title: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let affected = conn.execute(
            "UPDATE sessions SET title = ?2, updated_at = ?3 WHERE session_id = ?1",
            params![session_id, title, now],
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

    /// Read a string value from the GUI store domain.
    pub fn gui_get_item(&self, key: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT value FROM state_entries WHERE domain = 'gui_store' AND key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            let s: String = row.get(0)?;
            Ok(Some(s))
        } else {
            Ok(None)
        }
    }

    /// Set a string value in the GUI store domain.
    pub fn gui_set_item(&self, key: &str, value: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO state_entries (domain, key, value, updated_at)
             VALUES ('gui_store', ?1, ?2, ?3)
             ON CONFLICT(domain, key) DO UPDATE SET
                value = ?2,
                updated_at = ?3",
            params![key, value, now],
        )?;
        Ok(())
    }

    /// Remove an item from the GUI store domain.
    pub fn gui_remove_item(&self, key: &str) -> Result<bool, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute(
            "DELETE FROM state_entries WHERE domain = 'gui_store' AND key = ?1",
            params![key],
        )?;
        Ok(affected > 0)
    }

    /// Clear all items in the GUI store domain.
    pub fn gui_clear(&self) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM state_entries WHERE domain = 'gui_store'", [])?;
        Ok(())
    }

    /// Get count of items in the GUI store domain.
    pub fn gui_length(&self) -> Result<usize, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let count: usize = conn.query_row(
            "SELECT COUNT(*) FROM state_entries WHERE domain = 'gui_store'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Search messages and session titles matching `query`.
    pub fn search_messages(
        &self,
        query: &str,
        session_id: Option<&str>,
        role: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SearchHit>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let query_trim = query.trim();
        if query_trim.is_empty() {
            return Ok(vec![]);
        }

        let like_pattern = format!("%{}%", query_trim);
        let mut sql = String::from(
            "SELECT m.session_id, COALESCE(s.title, ''), m.role, m.content, m.created_at, m.turn_id
             FROM messages m
             LEFT JOIN sessions s ON m.session_id = s.session_id
             WHERE (m.content LIKE ?1 OR s.title LIKE ?1)",
        );

        let mut params_vec: Vec<rusqlite::types::Value> = vec![like_pattern.into()];

        if let Some(sid) = session_id {
            params_vec.push(sid.to_string().into());
            sql.push_str(&format!(" AND m.session_id = ?{}", params_vec.len()));
        }

        if let Some(r) = role {
            params_vec.push(r.to_string().into());
            sql.push_str(&format!(" AND m.role = ?{}", params_vec.len()));
        }

        params_vec.push((limit as i64).into());
        sql.push_str(&format!(
            " ORDER BY m.created_at DESC LIMIT ?{}",
            params_vec.len()
        ));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
            let session_id: String = row.get(0)?;
            let session_title: String = row.get(1)?;
            let role: String = row.get(2)?;
            let content: String = row.get(3)?;
            let created_at_ms: i64 = row.get(4)?;
            let turn_id: String = row.get(5)?;

            let snippet = extract_snippet(&content, query_trim, 120);

            Ok(SearchHit {
                session_id,
                workspace_id: String::new(),
                session_title,
                agent_id: "main".to_string(),
                role,
                snippet,
                time: format_iso(created_at_ms),
                turn: 1,
                step_id: turn_id,
                score: 1.0,
            })
        })?;

        let mut hits = Vec::new();
        for row in rows {
            hits.push(row?);
        }
        Ok(hits)
    }

    /// Count total messages in store.
    pub fn count_messages(&self) -> Result<usize, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let count: usize = conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
        Ok(count)
    }

    /// Record a file change checkpoint in a turn.
    pub fn record_file_change(
        &self,
        session_id: &str,
        turn_id: usize,
        path: &str,
        content_before: Option<&str>,
        content_after: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let (status, additions, deletions) = compute_line_diff(content_before, content_after);
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO session_file_history (session_id, turn_id, path, status, content_before, content_after, additions, deletions, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                session_id,
                turn_id as i64,
                path,
                status,
                content_before,
                content_after,
                additions as i64,
                deletions as i64,
                now
            ],
        )?;
        // Auto-prune older entries beyond retention limit (500 records per session)
        conn.execute(
            "DELETE FROM session_file_history
             WHERE session_id = ?1 AND id NOT IN (
                 SELECT id FROM session_file_history
                 WHERE session_id = ?1
                 ORDER BY id DESC
                 LIMIT 500
             )",
            params![session_id],
        )?;
        Ok(())
    }

    /// Explicitly prune file history records for a session to enforce retention limit.
    pub fn prune_file_history(
        &self,
        session_id: &str,
        max_entries: usize,
    ) -> Result<usize, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute(
            "DELETE FROM session_file_history
             WHERE session_id = ?1 AND id NOT IN (
                 SELECT id FROM session_file_history
                 WHERE session_id = ?1
                 ORDER BY id DESC
                 LIMIT ?2
             )",
            params![session_id, max_entries as i64],
        )?;
        Ok(deleted)
    }

    /// List turn-level file history changes for a session.
    pub fn get_file_history_changes(
        &self,
        session_id: &str,
        turn_id: Option<usize>,
    ) -> Result<(Vec<FileHistoryChange>, bool), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let (query, has_turn) = match turn_id {
            Some(t) => (
                "SELECT path, status, additions, deletions FROM session_file_history WHERE session_id = ?1 AND turn_id = ?2 ORDER BY id ASC",
                Some(t as i64),
            ),
            None => (
                "SELECT path, status, additions, deletions FROM session_file_history WHERE session_id = ?1 ORDER BY id ASC",
                None,
            ),
        };

        let mut stmt = conn.prepare(query)?;
        let mut changes = Vec::new();
        let mut rows = match has_turn {
            Some(t) => stmt.query(params![session_id, t])?,
            None => stmt.query(params![session_id])?,
        };

        while let Some(row) = rows.next()? {
            changes.push(FileHistoryChange {
                path: row.get(0)?,
                status: row.get(1)?,
                additions: row.get::<_, i64>(2)? as usize,
                deletions: row.get::<_, i64>(3)? as usize,
                binary: Some(false),
                oversize: Some(false),
            });
        }

        let recorded = !changes.is_empty();
        Ok((changes, recorded))
    }

    /// Retrieve file content for a given turn and path.
    pub fn get_file_history_content(
        &self,
        session_id: &str,
        turn_id: usize,
        path: &str,
        phase: &str,
    ) -> Result<Option<FileHistoryContent>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let query = if phase == "start" {
            "SELECT content_before, id FROM session_file_history WHERE session_id = ?1 AND turn_id = ?2 AND path = ?3 ORDER BY id ASC LIMIT 1"
        } else {
            "SELECT content_after, id FROM session_file_history WHERE session_id = ?1 AND turn_id = ?2 AND path = ?3 ORDER BY id DESC LIMIT 1"
        };

        let mut stmt = conn.prepare(query)?;
        let mut rows = stmt.query(params![session_id, turn_id as i64, path])?;
        if let Some(row) = rows.next()? {
            let content: Option<String> = row.get(0)?;
            let version: i64 = row.get(1)?;
            Ok(Some(FileHistoryContent {
                version: version as usize,
                content,
                binary: Some(false),
            }))
        } else {
            Ok(None)
        }
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

        let s_init = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(s_init.session_id, "sess-1");
        assert_eq!(s_init.title.as_deref(), Some("Test Session"));
        assert!(s_init.created_at > 0);
        assert!(s_init.updated_at >= s_init.created_at);

        // Updating session without title preserves original title and updates updated_at
        store.create_session("sess-1", None).unwrap();
        let s_preserved = store.get_session("sess-1").unwrap().unwrap();
        assert_eq!(s_preserved.title.as_deref(), Some("Test Session"));
        assert!(s_preserved.updated_at >= s_init.updated_at);

        // Save turn with TokenUsage
        let msgs = vec![
            LLMMessage::user("Hello"),
            LLMMessage::assistant("Hi there!"),
        ];
        let usage = TokenUsage {
            input_tokens: 150,
            output_tokens: 42,
            total_tokens: 192,
            input_cache_creation: 10,
            input_cache_read: 5,
        };
        store
            .save_turn("sess-1", "turn-1", 1, &msgs, Some(&usage))
            .unwrap();

        // Verify loaded messages
        let loaded = store.load_session_history("sess-1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].role, "user");
        assert_eq!(loaded[0].content, "Hello");
        assert_eq!(loaded[1].role, "assistant");
        assert_eq!(loaded[1].content, "Hi there!");

        // Verify turn record and persisted token usage
        {
            let conn = store.conn.lock().unwrap();
            let (status, usage_json): (String, Option<String>) = conn
                .query_row(
                    "SELECT status, usage FROM turns WHERE turn_id = 'turn-1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(status, "completed");
            let parsed_usage: TokenUsage =
                serde_json::from_str(&usage_json.expect("usage serialized")).unwrap();
            assert_eq!(parsed_usage.input_tokens, 150);
            assert_eq!(parsed_usage.output_tokens, 42);
            assert_eq!(parsed_usage.input_cache_creation, 10);
            assert_eq!(parsed_usage.input_cache_read, 5);
        }

        // Save a second turn and verify chronological order
        let msgs_turn2 = vec![
            LLMMessage::user("Second question"),
            LLMMessage::assistant("Second answer"),
        ];
        store
            .save_turn("sess-1", "turn-2", 2, &msgs_turn2, None)
            .unwrap();
        let loaded2 = store.load_session_history("sess-1").unwrap();
        assert_eq!(loaded2.len(), 4);
        assert_eq!(loaded2[2].content, "Second question");
        assert_eq!(loaded2[3].content, "Second answer");

        let list = store.list_sessions().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].session_id, "sess-1");
        assert_eq!(list[0].title.as_deref(), Some("Test Session"));
    }

    #[test]
    fn test_sqlite_state_entries_and_checkpoints() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-1", None).unwrap();

        // 1. Put and get state with complex object
        let state_val = serde_json::json!({
            "name": "commit",
            "flags": ["staged", "amend"],
            "count": 42
        });
        store.put_state("skill", "commit", &state_val).unwrap();
        let read = store.get_state("skill", "commit").unwrap().unwrap();
        assert_eq!(read, state_val);
        assert_eq!(read["flags"][0], "staged");
        assert_eq!(read["count"], 42);

        // State overwrite updates value
        let updated_val = serde_json::json!({ "name": "commit", "count": 43 });
        store.put_state("skill", "commit", &updated_val).unwrap();
        assert_eq!(
            store.get_state("skill", "commit").unwrap().unwrap()["count"],
            43
        );

        // Non-existent key returns None
        assert!(store.get_state("skill", "unknown").unwrap().is_none());
        assert!(store.get_state("unknown_domain", "key").unwrap().is_none());

        // 2. Save and verify checkpoint
        let chk_data = serde_json::json!({ "step": 1, "status": "in_progress" });
        store
            .save_checkpoint("sess-1", "chk-1", "Step 1", &chk_data)
            .unwrap();

        // Verify checkpoint in sqlite table
        {
            let conn = store.conn.lock().unwrap();
            let (sess_id, name, data_str, created_at): (String, String, String, i64) = conn
                .query_row(
                    "SELECT session_id, name, data, created_at FROM checkpoints WHERE id = 'chk-1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .unwrap();
            assert_eq!(sess_id, "sess-1");
            assert_eq!(name, "Step 1");
            assert_eq!(data_str, serde_json::to_string(&chk_data).unwrap());
            assert!(created_at > 0);
        }

        // Updating checkpoint on conflict
        let chk_data2 = serde_json::json!({ "step": 2, "status": "done" });
        store
            .save_checkpoint("sess-1", "chk-1", "Step 2 Done", &chk_data2)
            .unwrap();
        {
            let conn = store.conn.lock().unwrap();
            let (name, data_str): (String, String) = conn
                .query_row(
                    "SELECT name, data FROM checkpoints WHERE id = 'chk-1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(name, "Step 2 Done");
            assert_eq!(data_str, serde_json::to_string(&chk_data2).unwrap());
        }

        // Foreign key constraint: saving checkpoint for non-existent session fails
        let bad_chk = store.save_checkpoint(
            "non-existent-sess",
            "chk-bad",
            "Bad",
            &serde_json::json!({}),
        );
        assert!(bad_chk.is_err(), "foreign key constraint must reject non-existent session");
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
                blocks: vec![
                    ContentBlock::Text {
                        text: "show me image".into(),
                    },
                    ContentBlock::ImageUrl {
                        url: "https://example.com/cat.png".into(),
                    },
                ],
                tool_calls: vec![],
                tool_call_id: None,
            },
            LLMMessage {
                role: "assistant".into(),
                content: "calling tools".into(),
                blocks: vec![],
                tool_calls: vec![
                    ToolCall {
                        id: "call_read_1".into(),
                        name: "Read".into(),
                        arguments: serde_json::json!({ "path": "file.txt" }),
                    },
                    ToolCall {
                        id: "call_read_2".into(),
                        name: "Grep".into(),
                        arguments: serde_json::json!({ "pattern": "TODO" }),
                    },
                ],
                tool_call_id: None,
            },
            LLMMessage {
                role: "tool".into(),
                content: "file contents".into(),
                blocks: vec![],
                tool_calls: vec![],
                tool_call_id: Some("call_read_1".into()),
            },
            LLMMessage {
                role: "tool".into(),
                content: "matches found".into(),
                blocks: vec![],
                tool_calls: vec![],
                tool_call_id: Some("call_read_2".into()),
            },
        ];

        store
            .save_turn("sess-structured", "turn-1", 1, &msgs, None)
            .unwrap();

        let loaded = store.load_session_history("sess-structured").unwrap();
        assert_eq!(loaded.len(), 4);

        // Turn 1 user message with multiple blocks
        assert_eq!(loaded[0].role, "user");
        assert_eq!(loaded[0].blocks.len(), 2);
        assert_eq!(
            loaded[0].blocks[0],
            ContentBlock::Text {
                text: "show me image".into()
            }
        );
        assert_eq!(
            loaded[0].blocks[1],
            ContentBlock::ImageUrl {
                url: "https://example.com/cat.png".into()
            }
        );

        // Turn 1 assistant message with multiple structured tool calls
        assert_eq!(loaded[1].role, "assistant");
        assert_eq!(loaded[1].tool_calls.len(), 2);
        assert_eq!(loaded[1].tool_calls[0].id, "call_read_1");
        assert_eq!(loaded[1].tool_calls[0].name, "Read");
        assert_eq!(loaded[1].tool_calls[0].arguments["path"], "file.txt");
        assert_eq!(loaded[1].tool_calls[1].id, "call_read_2");
        assert_eq!(loaded[1].tool_calls[1].name, "Grep");
        assert_eq!(loaded[1].tool_calls[1].arguments["pattern"], "TODO");

        // Turn 1 tool results with corresponding tool_call_ids
        assert_eq!(loaded[2].role, "tool");
        assert_eq!(loaded[2].content, "file contents");
        assert_eq!(loaded[2].tool_call_id.as_deref(), Some("call_read_1"));

        assert_eq!(loaded[3].role, "tool");
        assert_eq!(loaded[3].content, "matches found");
        assert_eq!(loaded[3].tool_call_id.as_deref(), Some("call_read_2"));
    }

    #[test]
    fn test_fork_session_copies_history_and_creates_new_session() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session_with_workspace("sess-orig", Some("Original"), Some("wd_test_123"))
            .unwrap();
        let msgs = vec![
            LLMMessage::user("hello from original"),
            LLMMessage::assistant("assistant reply"),
        ];
        store
            .save_turn("sess-orig", "turn-1", 1, &msgs, None)
            .unwrap();

        // Fork to sess-fork with explicit title
        let ok = store
            .fork_session("sess-orig", "sess-fork", Some("Forked"))
            .unwrap();
        assert!(ok);

        let forked = store.get_session("sess-fork").unwrap().unwrap();
        assert_eq!(forked.session_id, "sess-fork");
        assert_eq!(forked.title.as_deref(), Some("Forked"));
        assert_eq!(forked.workspace_id.as_deref(), Some("wd_test_123"));

        let forked_history = store.load_session_history("sess-fork").unwrap();
        assert_eq!(forked_history.len(), 2);
        assert_eq!(forked_history[0].content, "hello from original");
        assert_eq!(forked_history[1].content, "assistant reply");

        // Subsequent turns in original do not leak into forked session (isolation)
        store
            .save_turn(
                "sess-orig",
                "turn-2",
                2,
                &[LLMMessage::user("isolated prompt")],
                None,
            )
            .unwrap();
        assert_eq!(store.load_session_history("sess-orig").unwrap().len(), 3);
        assert_eq!(store.load_session_history("sess-fork").unwrap().len(), 2);

        // Fork without title inherits original title
        let ok_inherit = store
            .fork_session("sess-orig", "sess-inherit", None)
            .unwrap();
        assert!(ok_inherit);
        let inherited = store.get_session("sess-inherit").unwrap().unwrap();
        assert_eq!(inherited.title.as_deref(), Some("Original"));
        assert_eq!(inherited.workspace_id.as_deref(), Some("wd_test_123"));

        // Fork non-existent returns false
        let missing = store
            .fork_session("sess-missing", "sess-none", None)
            .unwrap();
        assert!(!missing);
    }

    #[test]
    fn test_workspaces_crud_trust_and_session_count() {
        let store = SqliteSessionStore::in_memory().unwrap();

        // Test workdir key encoding algorithm
        let key1 = encode_workdir_key("G:\\kimi\\kimi-code\\");
        assert!(key1.starts_with("wd_kimi-code_"));
        assert_eq!(key1.len(), "wd_kimi-code_".len() + 12);

        let key_empty = encode_workdir_key("");
        assert!(key_empty.starts_with("wd_workspace_"));
        assert_eq!(key_empty.len(), "wd_workspace_".len() + 12);

        let key_dot = encode_workdir_key(".");
        assert!(key_dot.starts_with("wd_workspace_"));

        // 1. Create workspace
        let ws1 = store
            .create_workspace("/path/to/my-project", Some("My Project"))
            .unwrap();
        assert_eq!(ws1.id, encode_workdir_key("/path/to/my-project"));
        assert_eq!(ws1.root, "/path/to/my-project");
        assert_eq!(ws1.name, "My Project");
        assert_eq!(ws1.session_count, 0);

        // Validate timestamp formats are valid ISO-8601
        let created_dt = chrono::DateTime::parse_from_rfc3339(&ws1.created_at)
            .expect("valid ISO-8601 created_at");
        let last_opened_dt = chrono::DateTime::parse_from_rfc3339(&ws1.last_opened_at)
            .expect("valid ISO-8601 last_opened_at");
        assert!(last_opened_dt >= created_dt);

        // 2. Default trust is true
        assert!(store.is_workspace_trusted(&ws1.id).unwrap());
        // Toggle trust to false
        assert!(store.set_workspace_trusted(&ws1.id, false).unwrap());
        assert!(!store.is_workspace_trusted(&ws1.id).unwrap());
        assert!(store.set_workspace_trusted(&ws1.id, true).unwrap());
        assert!(store.is_workspace_trusted(&ws1.id).unwrap());

        // 3. Create session linked to workspace
        store
            .create_session_with_workspace("s1", Some("Session 1"), Some(&ws1.id))
            .unwrap();
        store
            .create_session_with_workspace("s2", Some("Session 2"), Some(&ws1.id))
            .unwrap();

        // 4. Query workspace again -> session_count == 2
        let ws1_updated = store.get_workspace(&ws1.id).unwrap().unwrap();
        assert_eq!(ws1_updated.session_count, 2);

        // 5. Update workspace with new name on conflict
        let ws1_renamed = store
            .create_workspace("/path/to/my-project", Some("Renamed Project"))
            .unwrap();
        assert_eq!(ws1_renamed.name, "Renamed Project");
        assert_eq!(ws1_renamed.session_count, 2);

        // 6. List workspaces
        let list = store.list_workspaces().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, ws1.id);
        assert_eq!(list[0].name, "Renamed Project");

        // 7. Delete workspace
        let deleted = store.delete_workspace(&ws1.id).unwrap();
        assert!(deleted);
        assert!(store.get_workspace(&ws1.id).unwrap().is_none());
        assert_eq!(store.list_workspaces().unwrap().len(), 0);

        // Deleting non-existent workspace returns false
        assert!(!store.delete_workspace(&ws1.id).unwrap());
    }

    #[test]
    fn test_export_session_full_snapshot() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session("sess-exp", Some("Export Session"))
            .unwrap();
        let msgs = vec![
            LLMMessage::user("Please export this"),
            LLMMessage::assistant("Exporting now"),
        ];
        store
            .save_turn("sess-exp", "turn-1", 1, &msgs, None)
            .unwrap();

        // Export existing
        let export = store.export_session("sess-exp").unwrap().unwrap();
        assert_eq!(export.session.session_id, "sess-exp");
        assert_eq!(export.session.title.as_deref(), Some("Export Session"));
        assert_eq!(export.messages.len(), 2);
        assert_eq!(export.messages[0].content, "Please export this");
        assert_eq!(export.messages[1].content, "Exporting now");
        assert_eq!(export.turns_count, 1);

        // Validate exported_at is a concrete, valid recent ISO-8601 timestamp
        let parsed_dt = chrono::DateTime::parse_from_rfc3339(&export.exported_at)
            .expect("exported_at must be valid RFC 3339 timestamp");
        assert!(parsed_dt.timestamp_millis() <= chrono::Utc::now().timestamp_millis());

        // Add second turn and export again
        store
            .save_turn(
                "sess-exp",
                "turn-2",
                2,
                &[LLMMessage::user("turn 2")],
                None,
            )
            .unwrap();
        let export2 = store.export_session("sess-exp").unwrap().unwrap();
        assert_eq!(export2.turns_count, 2);
        assert_eq!(export2.messages.len(), 3);

        // Export non-existent returns None
        assert!(store.export_session("sess-missing").unwrap().is_none());
    }

    #[test]
    fn test_update_session_title() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session("sess-title-test", Some("Initial Title"))
            .unwrap();

        let s1 = store.get_session("sess-title-test").unwrap().unwrap();
        assert_eq!(s1.title.as_deref(), Some("Initial Title"));

        let updated = store
            .update_session_title("sess-title-test", Some("Updated Title"))
            .unwrap();
        assert!(updated);

        let s2 = store.get_session("sess-title-test").unwrap().unwrap();
        assert_eq!(s2.title.as_deref(), Some("Updated Title"));
        assert!(s2.updated_at >= s1.updated_at);

        let missing = store
            .update_session_title("sess-non-existent", Some("Nope"))
            .unwrap();
        assert!(!missing);
    }

    #[test]
    fn test_gui_store_crud() {
        let store = SqliteSessionStore::in_memory().unwrap();
        assert_eq!(store.gui_length().unwrap(), 0);
        assert_eq!(store.gui_get_item("theme").unwrap(), None);

        store.gui_set_item("theme", "dark").unwrap();
        assert_eq!(
            store.gui_get_item("theme").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(store.gui_length().unwrap(), 1);

        store.gui_set_item("sidebar", "expanded").unwrap();
        assert_eq!(store.gui_length().unwrap(), 2);

        // Update existing
        store.gui_set_item("theme", "light").unwrap();
        assert_eq!(
            store.gui_get_item("theme").unwrap().as_deref(),
            Some("light")
        );

        // Remove single item
        assert!(store.gui_remove_item("theme").unwrap());
        assert_eq!(store.gui_get_item("theme").unwrap(), None);
        assert_eq!(store.gui_length().unwrap(), 1);

        // Removing non-existent item returns false
        assert!(!store.gui_remove_item("theme").unwrap());

        // Clear all
        store.gui_clear().unwrap();
        assert_eq!(store.gui_length().unwrap(), 0);
    }

    #[test]
    fn test_search_messages_and_titles() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session("sess-1", Some("Refactoring Core"))
            .unwrap();
        store.create_session("sess-2", Some("Bug Fixes")).unwrap();

        store
            .save_turn(
                "sess-1",
                "t1",
                1,
                &[
                    LLMMessage::user("Please optimize the database queries."),
                    LLMMessage::assistant("I have added an index to the table."),
                ],
                None,
            )
            .unwrap();
        store
            .save_turn(
                "sess-2",
                "t2",
                1,
                &[LLMMessage::user("Fix the null pointer crash.")],
                None,
            )
            .unwrap();

        // 1. Search by content keyword
        let hits = store.search_messages("database", None, None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "sess-1");
        assert_eq!(hits[0].session_title, "Refactoring Core");
        assert_eq!(hits[0].role, "user");
        assert_eq!(hits[0].step_id, "t1");
        assert_eq!(hits[0].turn, 1);
        assert_eq!(hits[0].score, 1.0);
        assert!(hits[0].snippet.contains("database"));
        chrono::DateTime::parse_from_rfc3339(&hits[0].time).expect("valid ISO-8601 hit time");

        // 2. Search by title keyword
        let hits_title = store
            .search_messages("Refactoring", None, None, 10)
            .unwrap();
        assert_eq!(hits_title.len(), 2, "both messages in sess-1 match session title");
        assert_eq!(hits_title[0].session_title, "Refactoring Core");
        assert_eq!(hits_title[1].session_title, "Refactoring Core");

        // 3. Filter by role
        let hits_assistant = store
            .search_messages("index", None, Some("assistant"), 10)
            .unwrap();
        assert_eq!(hits_assistant.len(), 1);
        assert_eq!(hits_assistant[0].role, "assistant");

        let hits_user = store
            .search_messages("index", None, Some("user"), 10)
            .unwrap();
        assert_eq!(hits_user.len(), 0);

        // 4. Filter by session_id
        let hits_sess2 = store
            .search_messages("Fix", Some("sess-2"), None, 10)
            .unwrap();
        assert_eq!(hits_sess2.len(), 1);
        assert_eq!(hits_sess2[0].session_id, "sess-2");

        // 5. Query edge cases
        assert!(store.search_messages("", None, None, 10).unwrap().is_empty());
        assert!(store.search_messages("   \t ", None, None, 10).unwrap().is_empty());
        assert!(store.search_messages("nonexistent query", None, None, 10).unwrap().is_empty());

        // 6. Search with limit
        let limited = store.search_messages("the", None, None, 1).unwrap();
        assert_eq!(limited.len(), 1);

        // 7. Snippet extraction with query in middle of long string
        let long_text = "start_prefix ".repeat(15) + "CRITICAL_KEYWORD" + &" end_suffix".repeat(15);
        store
            .save_turn(
                "sess-1",
                "t3",
                2,
                &[LLMMessage::user(&long_text)],
                None,
            )
            .unwrap();
        let snippet_hits = store.search_messages("CRITICAL_KEYWORD", None, None, 1).unwrap();
        assert_eq!(snippet_hits.len(), 1);
        assert!(snippet_hits[0].snippet.starts_with("..."));
        assert!(snippet_hits[0].snippet.ends_with("..."));
        assert!(snippet_hits[0].snippet.contains("CRITICAL_KEYWORD"));

        // 8. Total count
        assert_eq!(store.count_messages().unwrap(), 4);
    }

    #[test]
    fn test_file_history_crud_and_diff() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-fh", Some("File History Test")).unwrap();

        // Direct test of compute_line_diff logic
        assert_eq!(
            compute_line_diff(None, Some("line1\nline2\n")),
            ("added".to_string(), 2, 0)
        );
        assert_eq!(
            compute_line_diff(Some("line1\nline2\n"), None),
            ("deleted".to_string(), 0, 2)
        );
        assert_eq!(
            compute_line_diff(Some("line1\nline2\n"), Some("line1\nline2\n")),
            ("modified".to_string(), 0, 0)
        );
        assert_eq!(
            compute_line_diff(Some("line1\nline2\n"), Some("line1\nline3\n")),
            ("modified".to_string(), 1, 1)
        );
        assert_eq!(
            compute_line_diff(None, None),
            ("modified".to_string(), 0, 0)
        );

        // Turn 1: Add a new file
        store
            .record_file_change(
                "sess-fh",
                1,
                "src/main.rs",
                None,
                Some("fn main() {\n    println!(\"hello\");\n}\n"),
            )
            .unwrap();

        // Turn 2: Modify the file
        store
            .record_file_change(
                "sess-fh",
                2,
                "src/main.rs",
                Some("fn main() {\n    println!(\"hello\");\n}\n"),
                Some("fn main() {\n    println!(\"world\");\n    let x = 10;\n}\n"),
            )
            .unwrap();

        // Turn 3: Delete the file
        store
            .record_file_change(
                "sess-fh",
                3,
                "src/main.rs",
                Some("fn main() {\n    println!(\"world\");\n    let x = 10;\n}\n"),
                None,
            )
            .unwrap();

        // Check Turn 1 changes
        let (ch1, rec1) = store.get_file_history_changes("sess-fh", Some(1)).unwrap();
        assert!(rec1);
        assert_eq!(ch1.len(), 1);
        assert_eq!(ch1[0].path, "src/main.rs");
        assert_eq!(ch1[0].status, "added");
        assert_eq!(ch1[0].additions, 3);
        assert_eq!(ch1[0].deletions, 0);

        // Check Turn 2 changes
        let (ch2, rec2) = store.get_file_history_changes("sess-fh", Some(2)).unwrap();
        assert!(rec2);
        assert_eq!(ch2.len(), 1);
        assert_eq!(ch2[0].path, "src/main.rs");
        assert_eq!(ch2[0].status, "modified");

        // Check Turn 3 (deletion)
        let (ch3, rec3) = store.get_file_history_changes("sess-fh", Some(3)).unwrap();
        assert!(rec3);
        assert_eq!(ch3.len(), 1);
        assert_eq!(ch3[0].path, "src/main.rs");
        assert_eq!(ch3[0].status, "deleted");
        assert_eq!(ch3[0].additions, 0);
        assert_eq!(ch3[0].deletions, 4);

        // Check turn_id = None returns changes across all turns in chronological order
        let (all_changes, all_rec) = store.get_file_history_changes("sess-fh", None).unwrap();
        assert!(all_rec);
        assert_eq!(all_changes.len(), 3);
        assert_eq!(all_changes[0].status, "added");
        assert_eq!(all_changes[1].status, "modified");
        assert_eq!(all_changes[2].status, "deleted");

        // Verify retention prune
        let pruned = store.prune_file_history("sess-fh", 2).unwrap();
        assert_eq!(pruned, 1);
        let (retained_changes, _) = store.get_file_history_changes("sess-fh", None).unwrap();
        assert_eq!(retained_changes.len(), 2);
        assert_eq!(retained_changes[0].status, "modified");
        assert_eq!(retained_changes[1].status, "deleted");

        // Non-existent turn returns recorded = false
        let (ch_none, rec_none) = store.get_file_history_changes("sess-fh", Some(99)).unwrap();
        assert!(!rec_none);
        assert!(ch_none.is_empty());

        // Check content at Turn 2 phase start & end
        let start_content = store
            .get_file_history_content("sess-fh", 2, "src/main.rs", "start")
            .unwrap()
            .unwrap();
        assert!(start_content.content.unwrap().contains("println!(\"hello\")"));

        let end_content = store
            .get_file_history_content("sess-fh", 2, "src/main.rs", "end")
            .unwrap()
            .unwrap();
        assert!(end_content.content.unwrap().contains("println!(\"world\")"));

        // Non-existent path content
        assert!(
            store
                .get_file_history_content("sess-fh", 2, "src/missing.rs", "end")
                .unwrap()
                .is_none()
        );

        // Test revert_turn_file_changes restores to content_before
        let temp_ws = tempfile::tempdir().unwrap();
        let file_path = temp_ws.path().join("src/main.rs");
        std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        std::fs::write(&file_path, "modified code").unwrap();

        store.create_session("sess-revert", None).unwrap();
        store
            .record_file_change(
                "sess-revert",
                1,
                "src/main.rs",
                Some("original code"),
                Some("modified code"),
            )
            .unwrap();

        let reverted = store
            .revert_turn_file_changes("sess-revert", 1, temp_ws.path())
            .unwrap();
        assert_eq!(reverted, vec!["src/main.rs"]);
        assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "original code");
    }

    #[test]
    fn test_next_turn_number() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-seq", None).unwrap();

        // Fresh session starts at turn 1
        assert_eq!(store.next_turn_number("sess-seq").unwrap(), 1);

        // After turn 1, next is 2
        store
            .save_turn(
                "sess-seq",
                "t1",
                1,
                &[LLMMessage::user("first")],
                None,
            )
            .unwrap();
        assert_eq!(store.next_turn_number("sess-seq").unwrap(), 2);

        // After jump to turn 5, next is 6
        store
            .save_turn(
                "sess-seq",
                "t5",
                5,
                &[LLMMessage::user("fifth")],
                None,
            )
            .unwrap();
        assert_eq!(store.next_turn_number("sess-seq").unwrap(), 6);
    }

    #[test]
    fn test_undo_turns() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-undo", None).unwrap();

        store
            .save_turn("sess-undo", "t1", 1, &[LLMMessage::user("1")], None)
            .unwrap();
        store
            .save_turn("sess-undo", "t2", 2, &[LLMMessage::user("2")], None)
            .unwrap();
        store
            .save_turn("sess-undo", "t3", 3, &[LLMMessage::user("3")], None)
            .unwrap();

        assert_eq!(store.load_session_history("sess-undo").unwrap().len(), 3);

        // Undo 1 turn -> turn 3 deleted
        let undone = store.undo_turns("sess-undo", 1).unwrap();
        assert_eq!(undone, 1);
        let history = store.load_session_history("sess-undo").unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].content, "1");
        assert_eq!(history[1].content, "2");

        // Undo 10 turns when only 2 remain -> undoes 2 turns
        let undone_all = store.undo_turns("sess-undo", 10).unwrap();
        assert_eq!(undone_all, 2);
        assert!(store.load_session_history("sess-undo").unwrap().is_empty());

        // Undo on empty session returns 0
        assert_eq!(store.undo_turns("sess-undo", 1).unwrap(), 0);
    }

    #[test]
    fn test_compact_session() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-compact", None).unwrap();

        // 1. Session with <= 2 messages returns 0
        store
            .save_turn("sess-compact", "t1", 1, &[LLMMessage::user("hi")], None)
            .unwrap();
        assert_eq!(store.compact_session("sess-compact").unwrap(), 0);

        // 2. Add many turns
        for i in 2..=15 {
            store
                .save_turn(
                    "sess-compact",
                    &format!("t{i}"),
                    i,
                    &[
                        LLMMessage::user(&format!("User message {i}")),
                        LLMMessage::assistant(&format!("Assistant message {i}")),
                    ],
                    None,
                )
                .unwrap();
        }
        let pre_len = store.load_session_history("sess-compact").unwrap().len();
        assert!(pre_len >= 29);

        let removed = store.compact_session("sess-compact").unwrap();
        assert!(removed > 0);

        let post_history = store.load_session_history("sess-compact").unwrap();
        assert_eq!(post_history.len(), pre_len - removed);
        assert!(post_history.len() < pre_len);

        // Undoing a normal post-compaction turn still works…
        let undone = store.undo_turns("sess-compact", 1).unwrap();
        assert_eq!(undone, 1);

        // …but an undo that would swallow the compaction summary itself is
        // refused — the pre-compaction rows no longer exist, so deleting the
        // boundary turn would corrupt the projection (event_store
        // `UndoCompactionBoundary`, event_store/mod.rs:43-47).
        let err = store.undo_turns("sess-compact", 100).unwrap_err();
        assert!(
            err.contains("undo refused"),
            "expected boundary refusal, got: {err}"
        );
    }

    #[test]
    fn test_delete_session_cascades() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store
            .create_session("sess-del", Some("To Delete"))
            .unwrap();

        store
            .save_turn(
                "sess-del",
                "t1",
                1,
                &[LLMMessage::user("hello")],
                None,
            )
            .unwrap();

        store
            .save_checkpoint(
                "sess-del",
                "chk-del",
                "Checkpoint",
                &serde_json::json!({ "ok": true }),
            )
            .unwrap();

        store
            .record_file_change(
                "sess-del",
                1,
                "file.rs",
                None,
                Some("code"),
            )
            .unwrap();

        // Delete session
        let deleted = store.delete_session("sess-del").unwrap();
        assert!(deleted);

        // Session is gone
        assert!(store.get_session("sess-del").unwrap().is_none());
        assert!(store.load_session_history("sess-del").unwrap().is_empty());

        // Cascading deletion verified directly in tables
        {
            let conn = store.conn.lock().unwrap();
            let turn_count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM turns WHERE session_id = 'sess-del'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(turn_count, 0, "turns must cascade delete");

            let msg_count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM messages WHERE session_id = 'sess-del'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(msg_count, 0, "messages must cascade delete");

            let chk_count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM checkpoints WHERE session_id = 'sess-del'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(chk_count, 0, "checkpoints must cascade delete");

            let fh_count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_file_history WHERE session_id = 'sess-del'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(fh_count, 0, "file history must cascade delete");
        }

        // Deleting non-existent session returns false
        assert!(!store.delete_session("sess-del").unwrap());
    }

    #[test]
    fn test_undo_turns_transactional_integrity() {
        let store = SqliteSessionStore::in_memory().unwrap();
        store.create_session("sess-undo", Some("Undo Test")).unwrap();

        // Save Turn 1
        let msgs_t1 = vec![
            LLMMessage::user("prompt 1"),
            LLMMessage::assistant("reply 1"),
        ];
        store.save_turn("sess-undo", "t1", 1, &msgs_t1, None).unwrap();

        // Save Turn 2
        let msgs_t2 = vec![
            LLMMessage::user("prompt 2"),
            LLMMessage::assistant("reply 2"),
        ];
        store.save_turn("sess-undo", "t2", 2, &msgs_t2, None).unwrap();

        // Save Turn 3
        let msgs_t3 = vec![
            LLMMessage::user("prompt 3"),
            LLMMessage::assistant("reply 3"),
        ];
        store.save_turn("sess-undo", "t3", 3, &msgs_t3, None).unwrap();

        let history_before = store.load_session_history("sess-undo").unwrap();
        assert_eq!(history_before.len(), 6);

        // Undo 1 turn (should remove t3)
        let undone = store.undo_turns("sess-undo", 1).unwrap();
        assert_eq!(undone, 1);
        let history_after_1 = store.load_session_history("sess-undo").unwrap();
        assert_eq!(history_after_1.len(), 4);
        assert_eq!(history_after_1[0].content, "prompt 1");
        assert_eq!(history_after_1[1].content, "reply 1");
        assert_eq!(history_after_1[2].content, "prompt 2");
        assert_eq!(history_after_1[3].content, "reply 2");

        // Next turn number must be 3
        assert_eq!(store.next_turn_number("sess-undo").unwrap(), 3);

        // Undo remaining 2 turns
        let undone_all = store.undo_turns("sess-undo", 10).unwrap();
        assert_eq!(undone_all, 2);
        let history_empty = store.load_session_history("sess-undo").unwrap();
        assert_eq!(history_empty.len(), 0);
        assert_eq!(store.next_turn_number("sess-undo").unwrap(), 1);
    }
}
