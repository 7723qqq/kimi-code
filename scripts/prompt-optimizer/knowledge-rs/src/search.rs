use rusqlite::{params, Connection, Result};
use std::collections::HashSet;

use crate::models::{KnowledgeEntry, SearchResult};

pub fn search(
    conn: &Connection,
    query: &str,
    scope_path: Option<&str>,
    tags: Option<&[String]>,
    limit: usize,
    min_confidence: f64,
) -> Result<Vec<SearchResult>> {
    let mut results_map: std::collections::HashMap<String, (KnowledgeEntry, f64, Vec<String>)> =
        std::collections::HashMap::new();

    // 1. Scope match: entries whose scope is a prefix of the given path (or global)
    if let Some(path) = scope_path {
        let mut stmt = conn.prepare(
            "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at
             FROM entries
             WHERE confidence >= ?1 AND (scope IS NULL OR substr(?2, 1, length(scope)) = scope)
             ORDER BY confidence DESC
             LIMIT 20",
        )?;
        let rows = stmt.query_map(params![min_confidence, path], row_to_entry)?;
        for row in rows {
            let entry = row?;
            let score = if entry.scope.is_some() { 3.0 } else { 1.0 };
            let id = entry.id.clone();
            let e = results_map.entry(id).or_insert_with(|| (entry, 0.0, vec![]));
            e.1 += score;
            e.2.push("scope".to_string());
        }
    }

    // 2. FTS5 full-text search
    if !query.is_empty() && query != "*" {
        // Quote each word to prevent FTS5 operator interpretation (NOT, AND, OR, NEAR)
        let fts_query = if query.contains('"') {
            query.to_string()
        } else {
            query.split_whitespace()
                .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" OR ")
        };

        let sql = "SELECT e.id, e.category, e.title, e.content, e.tags, e.scope, e.confidence, e.source, e.created_at, e.updated_at, rank
                   FROM entries_fts f
                   JOIN entries e ON e.rowid = f.rowid
                   WHERE entries_fts MATCH ?1 AND e.confidence >= ?2
                   ORDER BY rank
                   LIMIT 20";

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![fts_query, min_confidence], |row| {
            let entry = row_to_entry(row)?;
            let rank: f64 = row.get(10)?;
            Ok((entry, rank))
        });

        if let Ok(rows) = rows {
            for (entry, rank) in rows.flatten() {
                // FTS rank is negative (more negative = better match), normalize
                let score = 2.0 * (1.0 / (1.0 + rank.abs()));
                let e = results_map.entry(entry.id.clone()).or_insert_with(|| (entry, 0.0, vec![]));
                e.1 += score;
                e.2.push("fts".to_string());
            }
        }
    }

    // 3. Tag overlap
    if let Some(query_tags) = tags {
        let tag_set: HashSet<&str> = query_tags.iter().map(|s| s.as_str()).collect();

        let mut stmt = conn.prepare(
            "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at
             FROM entries WHERE confidence >= ?1 AND tags != ''",
        )?;
        let rows = stmt.query_map(params![min_confidence], row_to_entry)?;

        for entry in rows.flatten() {
            let entry_tags: HashSet<&str> = entry.tags.iter().map(|s| s.as_str()).collect();
            let overlap = tag_set.intersection(&entry_tags).count();
            if overlap > 0 {
                let score = overlap as f64;
                let e = results_map.entry(entry.id.clone()).or_insert_with(|| (entry, 0.0, vec![]));
                e.1 += score;
                e.2.push("tag".to_string());
            }
        }
    }

    // Sort by relevance (score * confidence), then truncate
    let mut results: Vec<SearchResult> = results_map
        .into_values()
        .map(|(entry, score, sources)| {
            let relevance = score * entry.confidence;
            // Deduplicate match sources
            let unique_sources: Vec<String> = sources.into_iter().collect::<HashSet<_>>().into_iter().collect();
            SearchResult { entry, relevance, match_source: unique_sources }
        })
        .collect();

    results.sort_by(|a, b| b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(limit);

    Ok(results)
}

fn row_to_entry(row: &rusqlite::Row) -> Result<KnowledgeEntry> {
    use crate::models::{Category, Source};
    let category_str: String = row.get(1)?;
    let source_str: String = row.get(7)?;
    let tags_str: String = row.get(4)?;

    Ok(KnowledgeEntry {
        id: row.get(0)?,
        category: Category::from_str(&category_str).unwrap_or(Category::Pitfall),
        title: row.get(2)?,
        content: row.get(3)?,
        tags: if tags_str.is_empty() { vec![] } else { tags_str.split(',').map(|s| s.trim().to_string()).collect() },
        scope: row.get(5)?,
        confidence: row.get(6)?,
        source: Source::from_str(&source_str).unwrap_or(Source::Human),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use crate::models::{Category, Source};
    use crate::store::add_entry;

    fn test_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_database(&dir.path().join("test.db")).unwrap();
        (dir, conn)
    }

    fn add(
        conn: &Connection,
        title: &str,
        content: &str,
        tags: &[&str],
        scope: Option<&str>,
        confidence: f64,
        source: Source,
    ) {
        let tags: Vec<String> = tags.iter().map(|s| s.to_string()).collect();
        add_entry(
            conn,
            &Category::Pitfall,
            title,
            content,
            &tags,
            scope,
            &source,
            confidence,
        )
        .unwrap();
    }

    #[test]
    fn fts_finds_matching_content() {
        let (_dir, conn) = test_db();
        add(&conn, "Error handling", "Always propagate errors.", &[], None, 1.0, Source::Human);
        add(&conn, "Naming", "Use snake_case.", &[], None, 1.0, Source::Human);

        let results = search(&conn, "propagate", None, None, 10, 0.0).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.title, "Error handling");
        assert!(results[0].match_source.contains(&"fts".to_string()));
    }

    #[test]
    fn fts_multi_word_or_query() {
        let (_dir, conn) = test_db();
        add(&conn, "A", "alpha beta", &[], None, 1.0, Source::Human);
        add(&conn, "B", "gamma delta", &[], None, 1.0, Source::Human);

        // Two words are OR-ed: both entries match.
        let results = search(&conn, "alpha delta", None, None, 10, 0.0).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn no_query_no_scope_returns_nothing() {
        let (_dir, conn) = test_db();
        add(&conn, "A", "content", &[], None, 1.0, Source::Human);
        // Without a query, scope, or tags there is nothing to match.
        let results = search(&conn, "", None, None, 10, 0.0).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn scope_prefix_matching() {
        let (_dir, conn) = test_db();
        add(&conn, "Scoped", "Content.", &[], Some("G:/repo"), 1.0, Source::Human);
        add(&conn, "Global", "Content.", &[], None, 1.0, Source::Human);

        // Path under the scope prefix matches both; scoped ranks higher.
        let results = search(&conn, "", Some("G:/repo/src"), None, 10, 0.0).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].entry.title, "Scoped");
        assert!(results[0].match_source.contains(&"scope".to_string()));

        // Unrelated path only matches the global entry.
        let results = search(&conn, "", Some("G:/other"), None, 10, 0.0).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.title, "Global");
    }

    #[test]
    fn tag_overlap_scoring() {
        let (_dir, conn) = test_db();
        add(&conn, "Tagged", "Content.", &["rust", "async"], None, 1.0, Source::Human);
        add(&conn, "Untagged", "Content.", &["go"], None, 1.0, Source::Human);

        let results = search(&conn, "", None, Some(&["rust".to_string()]), 10, 0.0).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.title, "Tagged");
        assert!(results[0].match_source.contains(&"tag".to_string()));
    }

    #[test]
    fn min_confidence_filters() {
        let (_dir, conn) = test_db();
        add(&conn, "Low", "shared body", &[], None, 0.3, Source::AiLearned);
        add(&conn, "High", "shared body", &[], None, 1.0, Source::Human);

        let results = search(&conn, "shared", None, None, 10, 0.8).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.title, "High");
    }

    #[test]
    fn limit_truncates() {
        let (_dir, conn) = test_db();
        for i in 0..5 {
            add(&conn, &format!("Rule {i}"), "Shared content body.", &[], None, 1.0, Source::Human);
        }
        let results = search(&conn, "", Some("/"), None, 2, 0.0).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn combined_sources_deduplicate() {
        let (_dir, conn) = test_db();
        add(&conn, "Combo", "matching keyword", &["kw"], Some("G:/repo"), 1.0, Source::Human);

        // Query + scope + tag all hit the same entry; sources deduplicate.
        let results = search(
            &conn,
            "keyword",
            Some("G:/repo/x"),
            Some(&["kw".to_string()]),
            10,
            0.0,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        let mut sources = results[0].match_source.clone();
        sources.sort();
        assert_eq!(sources, vec!["fts".to_string(), "scope".to_string(), "tag".to_string()]);
    }
}
