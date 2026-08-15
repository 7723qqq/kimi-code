//! Knowledge Base — SQLite + FTS5 local coding standards database.
//!
//! Provides napi-exported functions for the TS layer to call directly
//! (no subprocess spawn needed). The database uses WAL mode and FTS5
//! for full-text search across entries.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

static DB: once_cell::sync::Lazy<Mutex<Option<Connection>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL CHECK(category IN ('coding-style','pitfall','architecture','workflow')),
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    scope       TEXT DEFAULT NULL,
    confidence  REAL NOT NULL DEFAULT 1.0,
    source      TEXT NOT NULL CHECK(source IN ('human','ai-learned','ai-confirmed')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
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
"#;

// ─── Models ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct KnowledgeEntry {
    id: String,
    category: String,
    title: String,
    content: String,
    tags: Vec<String>,
    scope: Option<String>,
    confidence: f64,
    source: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct SearchResult {
    entry: KnowledgeEntry,
    relevance: f64,
    match_source: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Stats {
    total: usize,
    by_category: HashMap<String, usize>,
    by_source: HashMap<String, usize>,
    avg_confidence: f64,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn with_db<F, R>(f: F) -> Result<R>
where
    F: FnOnce(&Connection) -> std::result::Result<R, String>,
{
    let guard = DB
        .lock()
        .map_err(|e| Error::from_reason(format!("DB lock: {e}")))?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| Error::from_reason("Knowledge DB not opened. Call knowledge_open first."))?;
    f(conn).map_err(Error::from_reason)
}

fn generate_id() -> String {
    ulid::Ulid::new().to_string()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<KnowledgeEntry> {
    let tags_str: String = row.get(4)?;
    Ok(KnowledgeEntry {
        id: row.get(0)?,
        category: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        tags: if tags_str.is_empty() {
            vec![]
        } else {
            tags_str.split(',').map(|s| s.trim().to_string()).collect()
        },
        scope: row.get(5)?,
        confidence: row.get(6)?,
        source: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ─── NAPI Exports ───────────────────────────────────────────────────────────

#[napi]
pub fn knowledge_open(db_path: String) -> Result<()> {
    let mut guard = DB
        .lock()
        .map_err(|e| Error::from_reason(format!("DB lock: {e}")))?;
    // Close any previously-open database (dropping the rusqlite connection,
    // which flushes WAL and releases the file handle) before reopening.
    if guard.is_some() {
        *guard = None;
    }
    std::fs::create_dir_all(
        std::path::Path::new(&db_path)
            .parent()
            .unwrap_or(std::path::Path::new(".")),
    )
    .ok();
    let conn =
        Connection::open(&db_path).map_err(|e| Error::from_reason(format!("Open DB: {e}")))?;
    conn.execute_batch("PRAGMA journal_mode = WAL;")
        .map_err(|e| Error::from_reason(format!("{e}")))?;
    // Check if schema exists
    let has_table: bool = conn
        .prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='entries'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_table {
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| Error::from_reason(format!("Schema: {e}")))?;
    }
    *guard = Some(conn);
    Ok(())
}

#[napi]
pub fn knowledge_add(
    title: String,
    category: String,
    content: String,
    tags: String,
    scope: Option<String>,
    source: String,
    confidence: f64,
) -> Result<String> {
    with_db(|conn| {
        let id = generate_id();
        let now = now_iso();
        let scope = scope.filter(|s| !s.is_empty());
        conn.execute(
            "INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id, category, title, content, tags, scope, confidence, source, now, now],
        ).map_err(|e| format!("Insert: {e}"))?;

        let entry = KnowledgeEntry {
            id: id.clone(),
            category,
            title,
            content,
            tags: tags
                .split(',')
                .filter(|s| !s.is_empty())
                .map(|s| s.trim().to_string())
                .collect(),
            scope,
            confidence,
            source,
            created_at: now.clone(),
            updated_at: now,
        };
        serde_json::to_string(&entry).map_err(|e| format!("JSON: {e}"))
    })
}

#[napi]
pub fn knowledge_search(
    query: String,
    scope_path: Option<String>,
    tags: Option<String>,
    limit: u32,
    min_confidence: f64,
) -> Result<String> {
    with_db(|conn| {
        let mut results_map: HashMap<String, (KnowledgeEntry, f64, Vec<String>)> = HashMap::new();

        // 1. Scope match
        if let Some(ref path) = scope_path {
            let mut stmt = conn.prepare(
                "SELECT id,category,title,content,tags,scope,confidence,source,created_at,updated_at FROM entries WHERE confidence >= ?1 AND (scope IS NULL OR substr(?2, 1, length(scope)) = scope) ORDER BY confidence DESC LIMIT 20"
            ).map_err(|e| format!("{e}"))?;
            let rows = stmt
                .query_map(params![min_confidence, path], row_to_entry)
                .map_err(|e| format!("{e}"))?;
            for row in rows.flatten() {
                let score = if row.scope.is_some() { 3.0 } else { 1.0 };
                let id = row.id.clone();
                let e = results_map.entry(id).or_insert_with(|| (row, 0.0, vec![]));
                e.1 += score;
                e.2.push("scope".to_string());
            }
        }

        // 2. FTS5
        if !query.is_empty() && query != "*" {
            let fts_query = if query.contains('"') {
                query.clone()
            } else {
                query
                    .split_whitespace()
                    .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            };
            let sql = "SELECT e.id,e.category,e.title,e.content,e.tags,e.scope,e.confidence,e.source,e.created_at,e.updated_at,rank FROM entries_fts f JOIN entries e ON e.rowid=f.rowid WHERE entries_fts MATCH ?1 AND e.confidence >= ?2 ORDER BY rank LIMIT 20";
            if let Ok(mut stmt) = conn.prepare(sql) {
                if let Ok(rows) = stmt.query_map(params![fts_query, min_confidence], |r| {
                    let entry = row_to_entry(r)?;
                    let rank: f64 = r.get(10)?;
                    Ok((entry, rank))
                }) {
                    for row in rows.flatten() {
                        let (entry, rank) = row;
                        let score = 2.0 * (1.0 / (1.0 + rank.abs()));
                        let id = entry.id.clone();
                        let e = results_map
                            .entry(id)
                            .or_insert_with(|| (entry, 0.0, vec![]));
                        e.1 += score;
                        e.2.push("fts".to_string());
                    }
                }
            }
        }

        // 3. Tag overlap
        if let Some(ref tag_str) = tags {
            let query_tags: HashSet<&str> = tag_str
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            if !query_tags.is_empty() {
                let mut stmt = conn.prepare("SELECT id,category,title,content,tags,scope,confidence,source,created_at,updated_at FROM entries WHERE confidence >= ?1 AND tags != ''").map_err(|e| format!("{e}"))?;
                let rows = stmt
                    .query_map(params![min_confidence], row_to_entry)
                    .map_err(|e| format!("{e}"))?;
                for row in rows.flatten() {
                    let entry_tags: HashSet<&str> = row.tags.iter().map(|s| s.as_str()).collect();
                    let overlap = query_tags.intersection(&entry_tags).count();
                    if overlap > 0 {
                        let id = row.id.clone();
                        let e = results_map.entry(id).or_insert_with(|| (row, 0.0, vec![]));
                        e.1 += overlap as f64;
                        e.2.push("tag".to_string());
                    }
                }
            }
        }

        // Sort and truncate
        let mut results: Vec<SearchResult> = results_map
            .into_values()
            .map(|(entry, score, sources)| {
                let relevance = score * entry.confidence;
                let unique: Vec<String> = sources
                    .into_iter()
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect();
                SearchResult {
                    entry,
                    relevance,
                    match_source: unique,
                }
            })
            .collect();
        results.sort_by(|a, b| {
            b.relevance
                .partial_cmp(&a.relevance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(limit as usize);

        serde_json::to_string(&results).map_err(|e| format!("JSON: {e}"))
    })
}

#[napi]
pub fn knowledge_remove(id: String) -> Result<bool> {
    with_db(|conn| {
        let affected = conn
            .execute("DELETE FROM entries WHERE id = ?1", params![id])
            .map_err(|e| format!("{e}"))?;
        Ok(affected > 0)
    })
}

#[napi]
pub fn knowledge_confirm(id: String) -> Result<bool> {
    with_db(|conn| {
        let now = now_iso();
        let affected = conn.execute(
            "UPDATE entries SET confidence = 1.0, source = 'ai-confirmed', updated_at = ?1 WHERE id = ?2",
            params![now, id],
        ).map_err(|e| format!("{e}"))?;
        Ok(affected > 0)
    })
}

#[napi]
pub fn knowledge_stats() -> Result<String> {
    with_db(|conn| {
        let total: usize = conn
            .query_row("SELECT count(*) FROM entries", [], |r| r.get(0))
            .map_err(|e| format!("{e}"))?;
        let mut by_category = HashMap::new();
        let mut stmt = conn
            .prepare("SELECT category, count(*) FROM entries GROUP BY category")
            .map_err(|e| format!("{e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?)))
            .map_err(|e| format!("{e}"))?;
        for row in rows.flatten() {
            by_category.insert(row.0, row.1);
        }

        let mut by_source = HashMap::new();
        let mut stmt = conn
            .prepare("SELECT source, count(*) FROM entries GROUP BY source")
            .map_err(|e| format!("{e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?)))
            .map_err(|e| format!("{e}"))?;
        for row in rows.flatten() {
            by_source.insert(row.0, row.1);
        }

        let avg_confidence: f64 = conn
            .query_row("SELECT COALESCE(avg(confidence),0) FROM entries", [], |r| {
                r.get(0)
            })
            .map_err(|e| format!("{e}"))?;

        let stats = Stats {
            total,
            by_category,
            by_source,
            avg_confidence,
        };
        serde_json::to_string(&stats).map_err(|e| format!("JSON: {e}"))
    })
}

#[napi]
pub fn knowledge_import(markdown: String) -> Result<String> {
    with_db(|conn| {
        let content = markdown.replace("\r\n", "\n");
        let blocks: Vec<&str> = content.split("\n---\n").collect();
        let mut entries = Vec::new();

        for block in blocks {
            let block = block.trim();
            if block.is_empty() {
                continue;
            }
            let lines: Vec<&str> = block.lines().collect();
            if lines.is_empty() {
                continue;
            }

            let header = lines[0].trim_start_matches('#').trim();
            let (cat_str, title) = match header.split_once(':') {
                Some((c, t)) => (c.trim(), t.trim()),
                None => continue,
            };

            let mut tags = String::new();
            let mut scope: Option<String> = None;
            let mut content_start = 1;

            for (i, line) in lines.iter().enumerate().skip(1) {
                if let Some(t) = line.strip_prefix("tags:") {
                    tags = t
                        .split(',')
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join(",");
                    content_start = i + 1;
                } else if let Some(s) = line.strip_prefix("scope:") {
                    let s = s.trim();
                    if !s.is_empty() {
                        scope = Some(s.to_string());
                    }
                    content_start = i + 1;
                } else if line.is_empty() {
                    content_start = i + 1;
                    break;
                } else {
                    break;
                }
            }

            let entry_content = lines[content_start..]
                .join("\n")
                .trim()
                .replace("\n\\---\n", "\n---\n");
            if entry_content.is_empty() {
                continue;
            }

            let id = generate_id();
            let now = now_iso();
            if conn.execute(
                "INSERT INTO entries (id,category,title,content,tags,scope,confidence,source,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,1.0,'human',?7,?8)",
                params![id, cat_str, title, entry_content, tags, scope, now, now],
            ).is_ok() {
                entries.push(KnowledgeEntry { id, category: cat_str.to_string(), title: title.to_string(), content: entry_content, tags: if tags.is_empty() { vec![] } else { tags.split(',').map(|s| s.to_string()).collect() }, scope, confidence: 1.0, source: "human".to_string(), created_at: now.clone(), updated_at: now });
            }
        }

        serde_json::to_string(&entries).map_err(|e| format!("JSON: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // knowledge_* functions operate on a process-global DB singleton, so
    // tests touching it must run serially.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    struct TestDb {
        dir: TempDir,
    }

    impl TestDb {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("knowledge.db");
            knowledge_open(path.to_string_lossy().to_string()).unwrap();
            TestDb { dir }
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            // Close the global connection so the TempDir can be removed on
            // Windows (an open file handle would block deletion).
            *DB.lock().unwrap() = None;
        }
    }

    fn parse_vec<T: serde::de::DeserializeOwned>(json: &str) -> Vec<T> {
        serde_json::from_str(json).expect("result should be valid JSON")
    }

    fn add_entry(title: &str, category: &str, content: &str) -> String {
        knowledge_add(
            title.to_string(),
            category.to_string(),
            content.to_string(),
            "".to_string(),
            None,
            "human".to_string(),
            1.0,
        )
        .unwrap()
    }

    fn add_entry_id(title: &str, category: &str, content: &str) -> String {
        let entry: serde_json::Value = serde_json::from_str(&add_entry(title, category, content)).unwrap();
        entry["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn test_open_creates_empty_db() {
        let _guard = TEST_LOCK.lock().unwrap();
        let db = TestDb::new();
        let stats: serde_json::Value =
            serde_json::from_str(&knowledge_stats().unwrap()).unwrap();
        assert_eq!(stats["total"], 0);
        drop(db);
    }

    #[test]
    fn test_add_returns_entry_json() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        let json = add_entry("Rust lifetimes", "coding-style", "Prefer explicit lifetimes.");
        let entry: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(entry["title"], "Rust lifetimes");
        assert_eq!(entry["category"], "coding-style");
        assert_eq!(entry["source"], "human");
        assert_eq!(entry["confidence"], 1.0);
        assert!(!entry["id"].as_str().unwrap().is_empty());
        assert!(!entry["created_at"].as_str().unwrap().is_empty());
    }

    #[test]
    fn test_search_fts_finds_matches() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        add_entry("Error handling", "pitfall", "Always propagate errors with context.");
        add_entry("Naming", "coding-style", "Use snake_case for functions.");

        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("error".to_string(), None, None, 10, 0.0).unwrap());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["entry"]["title"], "Error handling");
        assert!(results[0]["match_source"].as_array().unwrap().contains(&serde_json::json!("fts")));
    }

    #[test]
    fn test_search_fallback_when_fixed_prefix_wrong() {
        // The fixed prefix `"error" OR "handling"` style query must not match
        // when the phrase is absent.
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        add_entry("Naming", "coding-style", "Use snake_case for functions.");
        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("zzzznope".to_string(), None, None, 10, 0.0).unwrap());
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_scope_match() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        knowledge_add(
            "Scoped rule".to_string(),
            "coding-style".to_string(),
            "Scope-specific guidance.".to_string(),
            "".to_string(),
            Some("G:/repo".to_string()),
            "human".to_string(),
            1.0,
        )
        .unwrap();
        knowledge_add(
            "Global rule".to_string(),
            "coding-style".to_string(),
            "Works everywhere.".to_string(),
            "".to_string(),
            None,
            "human".to_string(),
            1.0,
        )
        .unwrap();

        // Path under the scoped entry's prefix matches.
        let results: Vec<serde_json::Value> = parse_vec(
            &knowledge_search("".to_string(), Some("G:/repo/src".to_string()), None, 10, 0.0)
                .unwrap(),
        );
        assert_eq!(results.len(), 2);
        // Scoped entry scores higher (3.0 scope + 1.0 unscoped = 4.0*1.0 vs 1.0).
        assert_eq!(results[0]["entry"]["title"], "Scoped rule");

        // Unrelated path: only the unscoped entry matches.
        let results: Vec<serde_json::Value> = parse_vec(
            &knowledge_search("".to_string(), Some("G:/other".to_string()), None, 10, 0.0)
                .unwrap(),
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["entry"]["title"], "Global rule");
    }

    #[test]
    fn test_search_tag_overlap() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        knowledge_add(
            "Tagged rule".to_string(),
            "pitfall".to_string(),
            "Content.".to_string(),
            "rust,async".to_string(),
            None,
            "human".to_string(),
            1.0,
        )
        .unwrap();

        let results: Vec<serde_json::Value> = parse_vec(
            &knowledge_search("".to_string(), None, Some("rust".to_string()), 10, 0.0).unwrap(),
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["entry"]["title"], "Tagged rule");
        assert!(results[0]["match_source"].as_array().unwrap().contains(&serde_json::json!("tag")));
    }

    #[test]
    fn test_search_min_confidence_filters() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        knowledge_add(
            "Low confidence".to_string(),
            "pitfall".to_string(),
            "Maybe wrong.".to_string(),
            "".to_string(),
            None,
            "ai-learned".to_string(),
            0.3,
        )
        .unwrap();
        add_entry("High confidence", "coding-style", "Definitely right.");

        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("".to_string(), Some("/".to_string()), None, 10, 0.8).unwrap());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["entry"]["title"], "High confidence");
    }

    #[test]
    fn test_search_limit_truncates() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        for i in 0..5 {
            add_entry(&format!("Rule {i}"), "coding-style", "Shared content body.");
        }
        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("".to_string(), Some("/".to_string()), None, 2, 0.0).unwrap());
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_remove_and_missing() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        let id = add_entry_id("To remove", "pitfall", "Remove me.");
        assert!(knowledge_remove(id.clone()).unwrap());
        // Removed entry is gone from search.
        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("remove".to_string(), None, None, 10, 0.0).unwrap());
        assert!(results.is_empty());
        // Second remove of the same id is a no-op.
        assert!(!knowledge_remove(id).unwrap());
    }

    #[test]
    fn test_confirm_updates_source_and_confidence() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        let id = knowledge_add(
            "AI learned".to_string(),
            "pitfall".to_string(),
            "Content.".to_string(),
            "".to_string(),
            None,
            "ai-learned".to_string(),
            0.4,
        )
        .unwrap();
        let id: serde_json::Value = serde_json::from_str(&id).unwrap();
        let id = id["id"].as_str().unwrap();
        assert!(knowledge_confirm(id.to_string()).expect("confirm failed"), "confirm returned false");
        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("Content".to_string(), None, None, 10, 1.0).unwrap());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["entry"]["source"], "ai-confirmed");
        assert_eq!(results[0]["entry"]["confidence"], 1.0);
        // Confirm of a missing id is a no-op.
        assert!(!knowledge_confirm("missing-id".to_string()).unwrap());
    }

    #[test]
    fn test_stats_grouping() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        add_entry("A", "coding-style", "One.");
        add_entry("B", "coding-style", "Two.");
        add_entry("C", "pitfall", "Three.");

        let stats: serde_json::Value =
            serde_json::from_str(&knowledge_stats().unwrap()).unwrap();
        assert_eq!(stats["total"], 3);
        assert_eq!(stats["by_category"]["coding-style"], 2);
        assert_eq!(stats["by_category"]["pitfall"], 1);
        assert_eq!(stats["by_source"]["human"], 3);
        assert_eq!(stats["avg_confidence"], 1.0);
    }

    #[test]
    fn test_import_markdown_blocks() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        let md = r#"# coding-style:Imported Rule
tags: rust, style
scope: G:/repo

This is the body.
Second line.
---
# pitfall:Second Entry
Content only.
"#;
        let entries: Vec<serde_json::Value> =
            parse_vec(&knowledge_import(md.to_string()).unwrap());
        assert_eq!(entries.len(), 2);

        let first = &entries[0];
        assert_eq!(first["title"], "Imported Rule");
        assert_eq!(first["category"], "coding-style");
        assert_eq!(first["tags"], serde_json::json!(["rust", "style"]));
        assert_eq!(first["scope"], "G:/repo");
        assert_eq!(first["content"], "This is the body.\nSecond line.");
        assert_eq!(first["source"], "human");

        let second = &entries[1];
        assert_eq!(second["title"], "Second Entry");
        assert_eq!(second["tags"], serde_json::json!([]));
        assert_eq!(second["content"], "Content only.");

        // Imported entries are searchable.
        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("imported".to_string(), None, None, 10, 0.0).unwrap());
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_import_skips_malformed_blocks() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        let md = r#"# NoColonTitle
Content.
---
# coding-style:Valid
Good content.
---
# pitfall:Empty body
---
"#;
        let entries: Vec<serde_json::Value> =
            parse_vec(&knowledge_import(md.to_string()).unwrap());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["title"], "Valid");
    }

    #[test]
    fn test_invalid_category_rejected() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _db = TestDb::new();
        let err = knowledge_add(
            "Bad".to_string(),
            "not-a-category".to_string(),
            "Content.".to_string(),
            "".to_string(),
            None,
            "human".to_string(),
            1.0,
        )
        .unwrap_err();
        assert!(err.to_string().contains("CHECK"), "got: {err}");
    }

    #[test]
    fn test_operations_without_open_error() {
        let _guard = TEST_LOCK.lock().unwrap();
        // Ensure no database is open (TestDb::drop resets the singleton).
        *DB.lock().unwrap() = None;
        let err = knowledge_add(
            "X".to_string(),
            "pitfall".to_string(),
            "Y".to_string(),
            "".to_string(),
            None,
            "human".to_string(),
            1.0,
        )
        .unwrap_err();
        assert!(err.to_string().contains("not opened"), "got: {err}");
        let err = knowledge_stats().unwrap_err();
        assert!(err.to_string().contains("not opened"), "got: {err}");
    }

    #[test]
    fn test_open_replaces_existing_db() {
        let _guard = TEST_LOCK.lock().unwrap();
        let db = TestDb::new();
        add_entry("Old data", "pitfall", "From the first database.");
        assert!(db.dir.path().join("knowledge.db").exists());

        // Re-open a fresh database in a new location: old data must be gone.
        let dir2 = tempfile::tempdir().unwrap();
        let path2 = dir2.path().join("kb2.db");
        knowledge_open(path2.to_string_lossy().to_string()).unwrap();
        let results: Vec<serde_json::Value> =
            parse_vec(&knowledge_search("".to_string(), Some("/".to_string()), None, 10, 0.0).unwrap());
        assert!(results.is_empty());
        *DB.lock().unwrap() = None;
        drop(db);
        drop(dir2);
    }
}
