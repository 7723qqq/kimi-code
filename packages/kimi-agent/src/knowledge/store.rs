//! SQLite-backed knowledge base — the engine-side `KnowledgeDelegate`.
//!
//! Mirrors the storage semantics of `packages/kimi-native-tools/src/knowledge.rs`
//! (SQLite + FTS5, confirmed-only search, scope boundary matching, duplicate
//! guard) but lives inside the engine, so the stdio host, kimi-server and the
//! SDK never depend on the napi crate. The database file lives at
//! `<KIMI_AGENT_HOME>/knowledge.db` and is wired in [`crate::agent::agent::Agent::new`]
//! whenever a home directory is available; without one the `KnowledgeService`
//! stays a no-op and the `SearchKnowledge` tool honestly answers
//! "No results.".

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use super::{
    KnowledgeDelegate, KnowledgeEntry, KnowledgeQuery, KnowledgeSearchResult,
    KnowledgeStats, KnowledgeStatus,
};

/// The SQLite knowledge store. One `Mutex<Connection>` per store keeps the
/// connection `Send + Sync` (rusqlite connections are `Send` but not `Sync`);
/// WAL mode lets multiple sessions open the same `knowledge.db` concurrently.
pub struct SqliteKnowledgeStore {
    conn: Mutex<Connection>,
}

// ─── Schema ─────────────────────────────────────────────────────────────────
// Mirrors native-tools' schema minus the strict category/source CHECKs — the
// trait-level entry model allows arbitrary categories, so the engine table
// stays permissive and enforces only the status invariant.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    category    TEXT DEFAULT NULL,
    title       TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    scope       TEXT DEFAULT NULL,
    confidence  REAL NOT NULL DEFAULT 1.0,
    source      TEXT NOT NULL DEFAULT 'ai-learned',
    status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, tags, content='entries', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO entries_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope);
CREATE INDEX IF NOT EXISTS idx_entries_confidence ON entries(confidence);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
"#;

/// Only `confirmed` entries participate in search — `pending` (AI-learned,
/// not yet vetted) and `rejected` (soft-deleted) are excluded, matching
/// native-tools semantics.
const STATUS_CONFIRMED: &str = "confirmed";

// ─── Construction ────────────────────────────────────────────────────────────

impl SqliteKnowledgeStore {
    /// Open (creating if needed) the knowledge database at `db_path`.
    pub fn open(db_path: &str) -> Result<Self, String> {
        let path = Path::new(db_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create knowledge db dir: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open knowledge db: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(|e| format!("set WAL mode: {e}"))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| format!("knowledge schema: {e}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Open the default knowledge db under a home directory
    /// (`<home>/knowledge.db`).
    pub fn open_at_home(home_dir: &str) -> Result<Self, String> {
        let path = format!("{}/knowledge.db", home_dir.trim_end_matches(['/', '\\']));
        Self::open(&path)
    }
}

// ─── KnowledgeDelegate ──────────────────────────────────────────────────────

impl KnowledgeDelegate for SqliteKnowledgeStore {
    fn search(&self, query: &KnowledgeQuery) -> Result<KnowledgeSearchResult, String> {
        let conn = self.conn.lock().map_err(|e| format!("knowledge db lock: {e}"))?;

        // Score accumulation keyed by entry id — the same entry can match via
        // scope and FTS; scores are summed, match sources are unioned.
        let mut merged: HashMap<String, (KnowledgeEntry, f64, Vec<String>)> = HashMap::new();
        // Optional category filter applied by every match path.
        let cat_sql = query
            .category
            .as_deref()
            .map(|_| " AND category = ?")
            .unwrap_or("");
        let mut cat_params: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if let Some(ref c) = query.category {
            cat_params.push(c);
        }

        // 1. Scope match — exact scope or a descendant path (`/foo` must not
        // match `/foobar`); mirrors native-tools' ESCAPE'd LIKE boundary and
        // handles both '/' and '\' separators.
        if let Some(ref path) = query.scope {
            let min_conf = query.min_confidence.unwrap_or(0.0);
            let sql = format!(
                "SELECT id,category,title,content,tags,scope,confidence,source,status \
                 FROM entries WHERE status = ?1 AND confidence >= ?2 \
                 AND (scope = ?3 OR ?3 LIKE scope || '/' || '%' ESCAPE '\\' \
                 OR ?3 LIKE scope || '\\' || '%' ESCAPE '\\'){cat_sql} \
                 ORDER BY confidence DESC LIMIT 50"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| format!("{e}"))?;
            let mut p: Vec<&dyn rusqlite::ToSql> =
                vec![&STATUS_CONFIRMED, &min_conf, path];
            p.extend(cat_params.iter().copied());
            let rows = stmt
                .query_map(p.as_slice(), row_to_entry)
                .map_err(|e| format!("{e}"))?;
            for entry in rows.flatten() {
                let score = if entry.scope.is_some() { 3.0 } else { 1.0 };
                let id = entry.id.clone();
                let slot = merged
                    .entry(id)
                    .or_insert_with(|| (entry, 0.0, vec![]));
                slot.1 += score;
                slot.2.push("scope".to_string());
            }
        }

        // 2. FTS5 — safe OR-query built from sanitized terms. An empty or
        // literal-`*` query skips the full-text path entirely.
        let fts_query = if !query.text.is_empty() && query.text != "*" {
            build_fts_query(&query.text)
        } else {
            String::new()
        };
        if !fts_query.is_empty() {
            let min_conf = query.min_confidence.unwrap_or(0.0);
            let sql = format!(
                "SELECT e.id,e.category,e.title,e.content,e.tags,e.scope,e.confidence,e.source,e.status,rank \
                 FROM entries_fts f JOIN entries e ON e.rowid = f.rowid \
                 WHERE entries_fts MATCH ?1 AND e.status = ?2 AND e.confidence >= ?3{cat_sql} \
                 ORDER BY rank LIMIT 50"
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                let mut p: Vec<&dyn rusqlite::ToSql> =
                    vec![&fts_query, &STATUS_CONFIRMED, &min_conf];
                p.extend(cat_params.iter().copied());
                if let Ok(rows) = stmt.query_map(p.as_slice(), |r| {
                    let entry = row_to_entry(r)?;
                    let rank: f64 = r.get(9)?;
                    Ok((entry, rank))
                }) {
                    for row in rows.flatten() {
                        let (entry, rank) = row;
                        let score = 2.0 * (1.0 / (1.0 + rank.abs()));
                        let id = entry.id.clone();
                        let slot = merged
                            .entry(id)
                            .or_insert_with(|| (entry, 0.0, vec![]));
                        slot.1 += score;
                        slot.2.push("fts".to_string());
                    }
                }
            }
        }

        // 3. Column-scan fallback for queries without usable FTS terms
        // (empty text, literal `*`, or every token sanitized away): the
        // category / min-confidence constraints still apply. Baseline score
        // 1.0 with a "columns" match source. Native-tools returns empty for
        // such queries (it has no category parameter); the trait-level query
        // supports category-only searches, so the engine covers them here.
        if fts_query.is_empty() {
            let min_conf = query.min_confidence.unwrap_or(0.0);
            let sql = format!(
                "SELECT id,category,title,content,tags,scope,confidence,source,status \
                 FROM entries WHERE status = ?1 AND confidence >= ?2{cat_sql} \
                 ORDER BY confidence DESC LIMIT 50"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| format!("{e}"))?;
            let mut p: Vec<&dyn rusqlite::ToSql> = vec![&STATUS_CONFIRMED, &min_conf];
            p.extend(cat_params.iter().copied());
            let rows = stmt
                .query_map(p.as_slice(), row_to_entry)
                .map_err(|e| format!("{e}"))?;
            for entry in rows.flatten() {
                let id = entry.id.clone();
                let slot = merged.entry(id).or_insert_with(|| (entry, 0.0, vec![]));
                slot.1 += 1.0;
                slot.2.push("columns".to_string());
            }
        }

        // Sort by relevance (score × confidence), truncate to the requested
        // limit (native-tools default: 20).
        let mut results: Vec<(KnowledgeEntry, f64, Vec<String>)> =
            merged.into_values().collect();
        results.sort_by(|a, b| {
            let ra = a.1 * a.0.confidence.unwrap_or(1.0);
            let rb = b.1 * b.0.confidence.unwrap_or(1.0);
            rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal)
        });
        let limit = query.max_results.unwrap_or(20);
        results.truncate(limit);

        let total = results.len();
        let relevance = results
            .first()
            .map(|(e, score, _)| score * e.confidence.unwrap_or(1.0));
        let mut sources: Vec<String> = results
            .iter()
            .flat_map(|(_, _, s)| s.iter().cloned())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        sources.sort();
        let match_source = if sources.is_empty() {
            None
        } else {
            Some(sources.join(","))
        };
        let entries = results.into_iter().map(|(e, _, _)| e).collect();

        Ok(KnowledgeSearchResult {
            entries,
            total,
            relevance,
            match_source,
        })
    }

    fn store(&self, entry: KnowledgeEntry) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("knowledge db lock: {e}"))?;

        // Duplicate guard mirroring native-tools: same category + same first
        // 30 chars of title (any source) is rejected instead of silently
        // creating a second entry. Empty titles skip the guard.
        if let Some(ref title) = entry.title {
            let prefix: String = title.chars().take(30).collect();
            let dup: i64 = conn
                .query_row(
                    "SELECT count(*) FROM entries WHERE category IS ?1 AND substr(title, 1, 30) = ?2",
                    params![entry.category, prefix],
                    |r| r.get(0),
                )
                .map_err(|e| format!("duplicate check: {e}"))?;
            if dup > 0 {
                return Err(format!(
                    "duplicate knowledge entry: [{:?}] {title}",
                    entry.category
                ));
            }
        }

        let status = status_str(entry.status);
        let tags = entry.tags.join(",");
        conn.execute(
            "INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                entry.id,
                entry.category,
                entry.title.unwrap_or_default(),
                entry.content,
                tags,
                entry.scope,
                entry.confidence.unwrap_or(1.0),
                entry.source.unwrap_or_else(|| "ai-learned".to_string()),
                status,
            ],
        )
        .map_err(|e| format!("insert knowledge entry: {e}"))?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("knowledge db lock: {e}"))?;
        conn.execute("DELETE FROM entries WHERE id = ?1", params![id])
            .map_err(|e| format!("delete knowledge entry: {e}"))?;
        // Idempotent: deleting a missing id is not an error (reject is the
        // soft-delete path and is also idempotent).
        Ok(())
    }

    fn confirm(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("knowledge db lock: {e}"))?;
        let affected = conn
            .execute(
                "UPDATE entries SET status = 'confirmed', confidence = 1.0, \
                 source = 'ai-confirmed', updated_at = datetime('now') WHERE id = ?1",
                params![id],
            )
            .map_err(|e| format!("confirm knowledge entry: {e}"))?;
        if affected == 0 {
            return Err(format!("knowledge entry not found: {id}"));
        }
        Ok(())
    }

    fn reject(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("knowledge db lock: {e}"))?;
        let affected = conn
            .execute(
                "UPDATE entries SET status = 'rejected', updated_at = datetime('now') WHERE id = ?1",
                params![id],
            )
            .map_err(|e| format!("reject knowledge entry: {e}"))?;
        if affected == 0 {
            return Err(format!("knowledge entry not found: {id}"));
        }
        Ok(())
    }

    fn stats(&self) -> Result<KnowledgeStats, String> {
        let conn = self.conn.lock().map_err(|e| format!("knowledge db lock: {e}"))?;
        let total_entries: i64 = conn
            .query_row("SELECT count(*) FROM entries", [], |r| r.get(0))
            .map_err(|e| format!("{e}"))?;
        let avg_confidence: f64 = conn
            .query_row("SELECT COALESCE(avg(confidence), 0) FROM entries", [], |r| r.get(0))
            .map_err(|e| format!("{e}"))?;
        let by_category = group_counts(&conn, "category")?;
        let by_source = group_counts(&conn, "source")?;
        let by_status = group_counts(&conn, "status")?;
        Ok(KnowledgeStats {
            total_entries: total_entries as usize,
            by_category,
            by_source,
            by_status,
            avg_confidence,
        })
    }

    fn import_markdown(
        &self,
        content: &str,
        category: Option<&str>,
    ) -> Result<Vec<KnowledgeEntry>, String> {
        // Parse with the same rule as the no-delegate path, then store with
        // the native-tools import semantics: imported entries are human-added
        // and immediately searchable (confirmed, confidence 1.0).
        let parsed = super::parse_markdown_knowledge(content, category);
        let mut stored = Vec::with_capacity(parsed.len());
        for mut entry in parsed {
            entry.status = KnowledgeStatus::Confirmed;
            entry.confidence = Some(1.0);
            entry.source = Some("human".to_string());
            self.store(entry.clone())?;
            stored.push(entry);
        }
        Ok(stored)
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Map a row to the trait-level entry model. Empty title/source strings are
/// normalized to `None` (the trait model treats them as optional).
fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<KnowledgeEntry> {
    let tags_str: String = row.get(4)?;
    let title: String = row.get(2)?;
    let source: String = row.get(7)?;
    let status: String = row.get(8)?;
    Ok(KnowledgeEntry {
        id: row.get(0)?,
        category: row.get(1)?,
        title: (!title.is_empty()).then_some(title),
        content: row.get(3)?,
        tags: if tags_str.is_empty() {
            vec![]
        } else {
            tags_str.split(',').map(|s| s.trim().to_string()).collect()
        },
        scope: row.get(5)?,
        confidence: row.get(6)?,
        source: (!source.is_empty()).then_some(source),
        status: parse_status(&status),
        metadata: None,
    })
}

fn status_str(status: KnowledgeStatus) -> &'static str {
    match status {
        KnowledgeStatus::Pending => "pending",
        KnowledgeStatus::Confirmed => STATUS_CONFIRMED,
        KnowledgeStatus::Rejected => "rejected",
    }
}

fn parse_status(status: &str) -> KnowledgeStatus {
    match status {
        "confirmed" => KnowledgeStatus::Confirmed,
        "rejected" => KnowledgeStatus::Rejected,
        _ => KnowledgeStatus::Pending,
    }
}

fn group_counts(conn: &Connection, column: &str) -> Result<HashMap<String, usize>, String> {
    let sql = format!("SELECT COALESCE({column}, 'uncategorized'), count(*) FROM entries GROUP BY {column}");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("{e}"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| format!("{e}"))?;
    Ok(rows
        .flatten()
        .map(|(k, v)| (k, v as usize))
        .collect())
}

/// Sanitize a single word for safe use as an FTS5 phrase term: strips all
/// FTS5-special characters and wraps the remainder in double quotes (internal
/// quotes doubled). Ported from native-tools.
fn sanitize_fts_term(word: &str) -> String {
    let cleaned: String = word
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        String::new()
    } else {
        format!("\"{}\"", cleaned.replace('"', "\"\""))
    }
}

/// Build a safe FTS5 OR-query from a free-text string. Ported from
/// native-tools.
fn build_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(sanitize_fts_term)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, SqliteKnowledgeStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("knowledge.db");
        let store = SqliteKnowledgeStore::open(&path.to_string_lossy()).expect("open store");
        (dir, store)
    }

    fn entry(id: &str, title: &str, content: &str, status: KnowledgeStatus) -> KnowledgeEntry {
        KnowledgeEntry {
            id: id.into(),
            content: content.into(),
            category: Some("workflow".into()),
            title: Some(title.into()),
            tags: vec![],
            scope: None,
            confidence: Some(0.9),
            source: Some("human".into()),
            status,
            metadata: None,
        }
    }

    fn query(text: &str) -> KnowledgeQuery {
        KnowledgeQuery {
            text: text.into(),
            max_results: None,
            category: None,
            scope: None,
            min_confidence: None,
        }
    }

    #[test]
    fn crud_roundtrip() {
        let (_dir, store) = temp_store();
        store.store(entry("e1", "Rust ownership", "Borrowing rules prevent use-after-free.", KnowledgeStatus::Confirmed)).unwrap();
        let r = store.search(&query("borrowing")).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.entries[0].id, "e1");
        assert!(r.relevance.unwrap() > 0.0);
        assert_eq!(r.match_source.as_deref(), Some("fts"));
    }

    #[test]
    fn pending_entries_are_not_searchable() {
        let (_dir, store) = temp_store();
        store.store(entry("e1", "Draft note", "Unvetted AI-learned fact.", KnowledgeStatus::Pending)).unwrap();
        let r = store.search(&query("unvetted")).unwrap();
        assert!(r.entries.is_empty());
        assert_eq!(r.total, 0);
    }

    #[test]
    fn confirm_reject_lifecycle() {
        let (_dir, store) = temp_store();
        store.store(entry("e1", "Tip", "Confirmed later.", KnowledgeStatus::Pending)).unwrap();
        assert!(store.search(&query("confirmed")).unwrap().entries.is_empty());

        store.confirm("e1").unwrap();
        let r = store.search(&query("confirmed")).unwrap();
        assert_eq!(r.total, 1);
        let e = &r.entries[0];
        assert_eq!(e.status, KnowledgeStatus::Confirmed);
        assert_eq!(e.confidence, Some(1.0));
        assert_eq!(e.source.as_deref(), Some("ai-confirmed"));

        store.reject("e1").unwrap();
        assert!(store.search(&query("confirmed")).unwrap().entries.is_empty());
    }

    #[test]
    fn confirm_reject_missing_id_fails() {
        let (_dir, store) = temp_store();
        assert!(store.confirm("nope").is_err());
        assert!(store.reject("nope").is_err());
    }

    #[test]
    fn delete_removes_and_is_idempotent() {
        let (_dir, store) = temp_store();
        store.store(entry("e1", "Old", "To be removed.", KnowledgeStatus::Confirmed)).unwrap();
        store.delete("e1").unwrap();
        assert!(store.search(&query("removed")).unwrap().entries.is_empty());
        // Deleting a missing id is not an error.
        store.delete("e1").unwrap();
        store.delete("never-existed").unwrap();
    }

    #[test]
    fn scope_match_is_a_weighted_signal_not_a_filter() {
        let (_dir, store) = temp_store();
        let mut a = entry("a", "In repo", "Scope-a content.", KnowledgeStatus::Confirmed);
        a.scope = Some("/repo".into());
        store.store(a).unwrap();
        let mut b = entry("b", "In sibling", "Scope-b content.", KnowledgeStatus::Confirmed);
        b.scope = Some("/repo-other".into());
        store.store(b).unwrap();

        // Mirrors native-tools semantics: scope is a relevance boost (exact
        // match or descendant path, `/repo` never matches `/repo-other`), not
        // a filter — the FTS path still surfaces out-of-scope hits.
        let q = KnowledgeQuery { text: "scope".into(), max_results: None, category: None, scope: Some("/repo".into()), min_confidence: None };
        let r = store.search(&q).unwrap();
        assert_eq!(r.total, 2);
        assert_eq!(r.entries[0].id, "a", "in-scope entry must rank first");
        let sources = r.match_source.as_deref().unwrap_or("");
        assert!(sources.contains("scope") && sources.contains("fts"), "{sources}");
    }

    #[test]
    fn category_and_confidence_filters() {
        let (_dir, store) = temp_store();
        let mut a = entry("a", "Style", "Use kebab-case.", KnowledgeStatus::Confirmed);
        a.category = Some("coding-style".into());
        a.confidence = Some(0.5);
        store.store(a).unwrap();
        let mut b = entry("b", "Pipeline", "Run CI on push.", KnowledgeStatus::Confirmed);
        b.category = Some("workflow".into());
        b.confidence = Some(0.9);
        store.store(b).unwrap();

        let q = KnowledgeQuery { text: "".into(), max_results: None, category: Some("workflow".into()), scope: None, min_confidence: None };
        let r = store.search(&q).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.entries[0].id, "b");

        let q = KnowledgeQuery { text: "".into(), max_results: None, category: None, scope: None, min_confidence: Some(0.8) };
        let r = store.search(&q).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.entries[0].id, "b");
    }

    #[test]
    fn stats_reflect_store_contents() {
        let (_dir, store) = temp_store();
        let mut a = entry("a", "Style", "One.", KnowledgeStatus::Confirmed);
        a.category = Some("coding-style".into());
        store.store(a).unwrap();
        let mut b = entry("b", "Workflow", "Two.", KnowledgeStatus::Pending);
        b.category = Some("workflow".into());
        b.confidence = Some(0.4);
        store.store(b).unwrap();
        store.store(entry("c", "Human", "Three.", KnowledgeStatus::Confirmed)).unwrap();

        let s = store.stats().unwrap();
        assert_eq!(s.total_entries, 3);
        assert_eq!(s.by_category.get("coding-style"), Some(&1));
        assert_eq!(s.by_category.get("workflow"), Some(&2));
        assert_eq!(s.by_source.get("human"), Some(&3));
        assert_eq!(s.by_status.get("confirmed"), Some(&2));
        assert_eq!(s.by_status.get("pending"), Some(&1));
        assert!(s.avg_confidence > 0.5);
    }

    #[test]
    fn duplicate_store_is_rejected() {
        let (_dir, store) = temp_store();
        store.store(entry("e1", "Same title", "First.", KnowledgeStatus::Confirmed)).unwrap();
        // Same category + same title prefix → duplicate.
        let err = store.store(entry("e2", "Same title", "Second.", KnowledgeStatus::Confirmed)).unwrap_err();
        assert!(err.contains("duplicate"), "{err}");
        // Same id → UNIQUE constraint error.
        let err = store.store(entry("e1", "Different", "Third.", KnowledgeStatus::Confirmed)).unwrap_err();
        assert!(err.contains("UNIQUE"), "{err}");
        // Different title prefix → fine.
        store.store(entry("e2", "Other title", "Fourth.", KnowledgeStatus::Confirmed)).unwrap();
    }

    #[test]
    fn import_markdown_parses_and_stores_confirmed() {
        let (_dir, store) = temp_store();
        let md = "# Title 1\nContent 1\n\n# Title 2\nContent 2\n";
        let entries = store.import_markdown(md, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.status == KnowledgeStatus::Confirmed));
        assert!(entries.iter().all(|e| e.source.as_deref() == Some("human")));
        // Imported entries are immediately searchable — the FTS OR-query
        // matches both imported titles ("Title 1" / "Title 2" share the
        // "Title" token), so assert the specific entry surfaced.
        let r = store.search(&query("Title 1")).unwrap();
        assert!(r.entries.iter().any(|e| e.title.as_deref() == Some("Title 1")));
        // Duplicate import of the same headings is rejected.
        assert!(store.import_markdown(md, None).is_err());
    }

    #[test]
    fn fts_query_sanitizes_special_characters() {
        let (_dir, store) = temp_store();
        store.store(entry("e1", "Rust", "No panic in production.", KnowledgeStatus::Confirmed)).unwrap();
        // Query with FTS5-special characters must not error or crash.
        let q = KnowledgeQuery { text: "panic! (rust) OR \"quote\"".into(), max_results: None, category: None, scope: None, min_confidence: None };
        let r = store.search(&q).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.entries[0].id, "e1");
    }
}
