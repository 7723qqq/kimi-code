/// Record storage — append and query agent records.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::persistence::store::SqliteStore;

/// A single persisted record entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: i64,
    pub session_id: String,
    pub turn_id: String,
    pub record_type: String,
    pub data_json: Value,
    pub created_at: String,
}

/// Input for appending a new record (id is auto-generated).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordInput {
    pub session_id: String,
    pub turn_id: String,
    pub record_type: String,
    pub data_json: Value,
    pub created_at: String,
}

/// Store and query agent records via SQLite.
pub struct RecordStore {
    store: SqliteStore,
}

// ── Wire record types (vis timeline / wire view contract) ─────────────────
//
// These constants are the single source of truth for the `record_type` column
// of the `records` table. Stage 2 (the vis reader) consumes exactly these
// values, so do not rename them without updating the reader.
//
// data_json shapes (documented here; the engine writes them verbatim):
// - `message.append`        = ContextMessage (role/content/tool_calls/tool_call_id/origin/…)
// - `turn.started`          = { "turn_id": string }
// - `turn.ended`            = { "turn_id": string, "reason": string, "steps": number }
// - `tool.call`             = { "tool_call_id": string, "name": string, "input": object }
// - `tool.result`           = { "tool_call_id": string, "name": string, "output": string, "is_error": bool }
// - `usage.updated`         = { "model": string, "input_tokens": number, "output_tokens": number, "total_tokens": number }
// - `goal.updated`          = GoalSnapshot (camelCase; see crate::goal::GoalSnapshot)
// - `compaction.started`    = { "trigger": string, "tokens_before": number }
// - `compaction.completed`  = { "trigger": string, "tokens_before": number, "tokens_after": number, "summary": string }
pub const RECORD_TYPE_MESSAGE_APPEND: &str = "message.append";
pub const RECORD_TYPE_TURN_STARTED: &str = "turn.started";
pub const RECORD_TYPE_TURN_ENDED: &str = "turn.ended";
pub const RECORD_TYPE_TOOL_CALL: &str = "tool.call";
pub const RECORD_TYPE_TOOL_RESULT: &str = "tool.result";
pub const RECORD_TYPE_USAGE_UPDATED: &str = "usage.updated";
pub const RECORD_TYPE_GOAL_UPDATED: &str = "goal.updated";
pub const RECORD_TYPE_COMPACTION_STARTED: &str = "compaction.started";
pub const RECORD_TYPE_COMPACTION_COMPLETED: &str = "compaction.completed";

impl RecordStore {
    /// Create a new record store backed by the given SQLite store.
    pub fn new(store: SqliteStore) -> Self {
        Self { store }
    }

    /// Append a wire record with an auto-generated ISO-8601 timestamp.
    ///
    /// This is the production write path for engine events (turns, messages,
    /// tool calls, usage, goals, compaction). Failures are surfaced to the
    /// caller, which must swallow them — a lost record must never change
    /// engine behaviour.
    pub fn append_wire(
        &self,
        session_id: &str,
        turn_id: &str,
        record_type: &str,
        data_json: Value,
    ) -> anyhow::Result<i64> {
        self.append_record(&RecordInput {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            record_type: record_type.to_string(),
            data_json,
            created_at: iso_now(),
        })
    }

    /// Append a new record and return the auto-generated ID.
    pub fn append_record(&self, input: &RecordInput) -> anyhow::Result<i64> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO records (session_id, turn_id, record_type, data_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    input.session_id,
                    input.turn_id,
                    input.record_type,
                    serde_json::to_string(&input.data_json)?,
                    input.created_at,
                ],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    /// Get records for a session, optionally starting after a given ID.
    ///
    /// - `session_id` — which session's records to fetch.
    /// - `after_id` — if `Some`, only return records with `id > after_id`.
    /// - `limit` — maximum number of records to return.
    pub fn get_records(
        &self,
        session_id: &str,
        after_id: Option<i64>,
        limit: usize,
    ) -> anyhow::Result<Vec<Record>> {
        self.store.with_conn(|c| {
            let sql = match after_id {
                Some(_) => {
                    "SELECT id, session_id, turn_id, record_type, data_json, created_at
                     FROM records
                     WHERE session_id = ?1 AND id > ?2
                     ORDER BY id ASC
                     LIMIT ?3"
                }
                None => {
                    "SELECT id, session_id, turn_id, record_type, data_json, created_at
                     FROM records
                     WHERE session_id = ?1
                     ORDER BY id ASC
                     LIMIT ?2"
                }
            };

            let mut stmt = c.prepare(sql)?;

            let rows: Vec<Record> = if let Some(after) = after_id {
                stmt.query_map(
                    rusqlite::params![session_id, after, limit as i64],
                    |row| {
                        let data_str: String = row.get(4)?;
                        Ok(Record {
                            id: row.get(0)?,
                            session_id: row.get(1)?,
                            turn_id: row.get(2)?,
                            record_type: row.get(3)?,
                            data_json: serde_json::from_str(&data_str)
                                .unwrap_or_default(),
                            created_at: row.get(5)?,
                        })
                    },
                )?
                .filter_map(|r| r.ok())
                .collect()
            } else {
                stmt.query_map(
                    rusqlite::params![session_id, limit as i64],
                    |row| {
                        let data_str: String = row.get(4)?;
                        Ok(Record {
                            id: row.get(0)?,
                            session_id: row.get(1)?,
                            turn_id: row.get(2)?,
                            record_type: row.get(3)?,
                            data_json: serde_json::from_str(&data_str)
                                .unwrap_or_default(),
                            created_at: row.get(5)?,
                        })
                    },
                )?
                .filter_map(|r| r.ok())
                .collect()
            };

            Ok(rows)
        })
    }
}

/// ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) without external crates —
/// mirrors the `SessionManager::iso_now` formatter so records and session
/// rows share a comparable timestamp format.
fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86_400;
    let time = secs % 86_400;
    let (y, m, d) = {
        let y = 1970 + days / 365;
        let doy = days % 365;
        let m = (doy * 12) / 365 + 1;
        let d = doy - ((m - 1) * 365) / 12 + 1;
        (y, m, d)
    };
    let (hh, mm, ss) = (time / 3600, (time % 3600) / 60, time % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    #[test]
    fn test_append_and_get_records() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());

        let id = store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-1".into(),
                record_type: "user_message".into(),
                data_json: serde_json::json!({"text": "hello"}),
                created_at: "2025-01-01T00:00:00Z".into(),
            })
            .unwrap();

        let records = store.get_records("sess-1", None, 10).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, id);
        assert_eq!(records[0].record_type, "user_message");
        assert_eq!(records[0].data_json["text"], "hello");
    }

    #[test]
    fn test_get_records_after_id() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());

        let id1 = store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-1".into(),
                record_type: "type_a".into(),
                data_json: Value::Null,
                created_at: "2025-01-01T00:00:00Z".into(),
            })
            .unwrap();
        let _id2 = store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-2".into(),
                record_type: "type_b".into(),
                data_json: Value::Null,
                created_at: "2025-01-01T00:00:01Z".into(),
            })
            .unwrap();

        // Fetch only records after id1
        let records = store.get_records("sess-1", Some(id1), 10).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].record_type, "type_b");
    }

    #[test]
    fn test_get_records_respects_limit() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());

        for i in 0..10 {
            store
                .append_record(&RecordInput {
                    session_id: "sess-1".into(),
                    turn_id: format!("turn-{i}"),
                    record_type: "test".into(),
                    data_json: Value::Null,
                    created_at: format!("2025-01-01T00:00:{i:02}Z"),
                })
                .unwrap();
        }

        let records = store.get_records("sess-1", None, 3).unwrap();
        assert_eq!(records.len(), 3);
    }

    #[test]
    fn test_get_records_empty_session() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());
        let records = store.get_records("nonexistent", None, 10).unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn test_get_records_scoped_to_session() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());
        store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-1".into(),
                record_type: "a".into(),
                data_json: Value::Null,
                created_at: "2025-01-01T00:00:00Z".into(),
            })
            .unwrap();

        let records = store.get_records("sess-2", None, 10).unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn test_append_wire_stamps_timestamp_and_type() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());
        let id = store
            .append_wire(
                "sess-1",
                "turn-1",
                RECORD_TYPE_TURN_ENDED,
                serde_json::json!({ "turn_id": "turn-1", "reason": "EndTurn" }),
            )
            .unwrap();
        assert!(id > 0);

        let records = store.get_records("sess-1", None, 10).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].record_type, RECORD_TYPE_TURN_ENDED);
        assert_eq!(records[0].data_json["reason"], "EndTurn");
        assert!(
            !records[0].created_at.is_empty(),
            "created_at must be stamped"
        );
    }

    #[test]
    fn test_record_type_constants_are_stable() {
        // Lock the wire contract strings for the stage-2 vis reader.
        assert_eq!(RECORD_TYPE_MESSAGE_APPEND, "message.append");
        assert_eq!(RECORD_TYPE_TURN_STARTED, "turn.started");
        assert_eq!(RECORD_TYPE_TURN_ENDED, "turn.ended");
        assert_eq!(RECORD_TYPE_TOOL_CALL, "tool.call");
        assert_eq!(RECORD_TYPE_TOOL_RESULT, "tool.result");
        assert_eq!(RECORD_TYPE_USAGE_UPDATED, "usage.updated");
        assert_eq!(RECORD_TYPE_GOAL_UPDATED, "goal.updated");
        assert_eq!(RECORD_TYPE_COMPACTION_STARTED, "compaction.started");
        assert_eq!(RECORD_TYPE_COMPACTION_COMPLETED, "compaction.completed");
    }
}