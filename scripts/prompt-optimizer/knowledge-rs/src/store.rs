use chrono::Utc;
use rusqlite::{params, Connection, Result};
use ulid::Ulid;

use crate::models::{Category, KnowledgeEntry, Source, Stats};

// Mirrors the add CLI command's arguments (one per entity field); keep the flat signature
#[allow(clippy::too_many_arguments)]
pub fn add_entry(
    conn: &Connection,
    category: &Category,
    title: &str,
    content: &str,
    tags: &[String],
    scope: Option<&str>,
    source: &Source,
    confidence: f64,
) -> Result<KnowledgeEntry> {
    let id = Ulid::new().to_string();
    let now = Utc::now().to_rfc3339();
    let tags_str = tags.join(",");
    // Normalize empty scope to NULL (global)
    let scope = scope.filter(|s| !s.is_empty());

    conn.execute(
        "INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, category.as_str(), title, content, tags_str, scope, confidence, source.as_str(), now, now],
    )?;

    Ok(KnowledgeEntry {
        id,
        category: category.clone(),
        title: title.to_string(),
        content: content.to_string(),
        tags: tags.to_vec(),
        scope: scope.map(|s| s.to_string()),
        confidence,
        source: source.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn get_entry(conn: &Connection, id: &str) -> Result<Option<KnowledgeEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at FROM entries WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_entry(row)?)),
        None => Ok(None),
    }
}

pub fn list_entries(
    conn: &Connection,
    category: Option<&str>,
    tag: Option<&str>,
    source: Option<&str>,
) -> Result<Vec<KnowledgeEntry>> {
    let mut sql = String::from(
        "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at FROM entries WHERE 1=1",
    );
    let mut param_values: Vec<String> = Vec::new();

    if let Some(cat) = category {
        param_values.push(cat.to_string());
        sql.push_str(&format!(" AND category = ?{}", param_values.len()));
    }
    if let Some(t) = tag {
        param_values.push(format!("%{t}%"));
        sql.push_str(&format!(" AND tags LIKE ?{}", param_values.len()));
    }
    if let Some(src) = source {
        param_values.push(src.to_string());
        sql.push_str(&format!(" AND source = ?{}", param_values.len()));
    }
    sql.push_str(" ORDER BY updated_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(params_refs.as_slice(), row_to_entry)?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn update_entry(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    content: Option<&str>,
    tags: Option<&str>,
    category: Option<&str>,
    scope: Option<Option<&str>>,
) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut param_values: Vec<String> = vec![now];

    if let Some(t) = title {
        param_values.push(t.to_string());
        sets.push(format!("title = ?{}", param_values.len()));
    }
    if let Some(c) = content {
        param_values.push(c.to_string());
        sets.push(format!("content = ?{}", param_values.len()));
    }
    if let Some(t) = tags {
        param_values.push(t.to_string());
        sets.push(format!("tags = ?{}", param_values.len()));
    }
    if let Some(cat) = category {
        param_values.push(cat.to_string());
        sets.push(format!("category = ?{}", param_values.len()));
    }
    if let Some(s) = scope {
        param_values.push(s.unwrap_or("").to_string());
        sets.push(format!("scope = NULLIF(?{}, '')", param_values.len()));
    }

    param_values.push(id.to_string());
    let id_param = param_values.len();
    let sql = format!("UPDATE entries SET {} WHERE id = ?{}", sets.join(", "), id_param);

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let affected = conn.execute(&sql, params_refs.as_slice())?;
    Ok(affected > 0)
}

pub fn remove_entry(conn: &Connection, id: &str) -> Result<bool> {
    let affected = conn.execute("DELETE FROM entries WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

pub fn confirm_entry(conn: &Connection, id: &str) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE entries SET confidence = 1.0, source = 'ai-confirmed', updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(affected > 0)
}

pub fn get_stats(conn: &Connection) -> Result<Stats> {
    let total: usize = conn.query_row("SELECT count(*) FROM entries", [], |r| r.get(0))?;

    let mut by_category = std::collections::HashMap::new();
    let mut stmt = conn.prepare("SELECT category, count(*) FROM entries GROUP BY category")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
    })?;
    for row in rows {
        let (cat, count) = row?;
        by_category.insert(cat, count);
    }

    let mut by_source = std::collections::HashMap::new();
    let mut stmt = conn.prepare("SELECT source, count(*) FROM entries GROUP BY source")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
    })?;
    for row in rows {
        let (src, count) = row?;
        by_source.insert(src, count);
    }

    let avg_confidence: f64 = conn
        .query_row("SELECT COALESCE(avg(confidence), 0) FROM entries", [], |r| r.get(0))?;

    Ok(Stats { total, by_category, by_source, avg_confidence })
}

fn row_to_entry(row: &rusqlite::Row) -> Result<KnowledgeEntry> {
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

    fn test_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_database(&dir.path().join("test.db")).unwrap();
        (dir, conn)
    }

    fn add(
        conn: &Connection,
        category: Category,
        title: &str,
        content: &str,
        tags: &[&str],
        source: Source,
        confidence: f64,
    ) -> KnowledgeEntry {
        let tags: Vec<String> = tags.iter().map(|s| s.to_string()).collect();
        add_entry(
            conn,
            &category,
            title,
            content,
            &tags,
            None,
            &source,
            confidence,
        )
        .unwrap()
    }

    #[test]
    fn add_and_get_roundtrip() {
        let (_dir, conn) = test_db();
        let entry = add(
            &conn,
            Category::CodingStyle,
            "Use snake_case",
            "Function names use snake_case.",
            &["rust", "naming"],
            Source::Human,
            0.9,
        );
        assert!(!entry.id.is_empty());

        let fetched = get_entry(&conn, &entry.id).unwrap().expect("entry exists");
        assert_eq!(fetched.title, "Use snake_case");
        assert_eq!(fetched.category, Category::CodingStyle);
        assert_eq!(fetched.tags, vec!["rust".to_string(), "naming".to_string()]);
        assert_eq!(fetched.scope, None);
        assert_eq!(fetched.source, Source::Human);
        assert_eq!(fetched.confidence, 0.9);
        assert!(!fetched.created_at.is_empty());
        assert!(!fetched.updated_at.is_empty());
    }

    #[test]
    fn get_missing_returns_none() {
        let (_dir, conn) = test_db();
        assert!(get_entry(&conn, "missing-id").unwrap().is_none());
    }

    #[test]
    fn empty_scope_normalized_to_null() {
        let (_dir, conn) = test_db();
        let entry = add_entry(
            &conn,
            &Category::Pitfall,
            "Global rule",
            "Applies everywhere.",
            &[],
            Some(""),
            &Source::Human,
            1.0,
        )
        .unwrap();
        assert_eq!(entry.scope, None);
    }

    #[test]
    fn list_filters_by_category_tag_source() {
        let (_dir, conn) = test_db();
        add(&conn, Category::Pitfall, "P1", "Content.", &["rust"], Source::Human, 1.0);
        add(&conn, Category::Pitfall, "P2", "Content.", &["go"], Source::AiLearned, 0.5);
        add(&conn, Category::CodingStyle, "C1", "Content.", &["rust"], Source::Human, 1.0);

        assert_eq!(list_entries(&conn, Some("pitfall"), None, None).unwrap().len(), 2);
        assert_eq!(list_entries(&conn, None, Some("rust"), None).unwrap().len(), 2);
        assert_eq!(list_entries(&conn, None, None, Some("ai-learned")).unwrap().len(), 1);
        assert_eq!(list_entries(&conn, Some("workflow"), None, None).unwrap().len(), 0);
    }

    #[test]
    fn list_orders_by_updated_at_desc() {
        let (_dir, conn) = test_db();
        add(&conn, Category::Pitfall, "Old", "Content.", &[], Source::Human, 1.0);
        std::thread::sleep(std::time::Duration::from_millis(20));
        add(&conn, Category::Pitfall, "New", "Content.", &[], Source::Human, 1.0);

        let entries = list_entries(&conn, Some("pitfall"), None, None).unwrap();
        assert_eq!(entries[0].title, "New");
        assert_eq!(entries[1].title, "Old");
    }

    #[test]
    fn update_fields_and_scope() {
        let (_dir, conn) = test_db();
        let entry = add(&conn, Category::Pitfall, "Old title", "Old content.", &["a"], Source::Human, 0.4);

        let updated = update_entry(
            &conn,
            &entry.id,
            Some("New title"),
            Some("New content."),
            Some("b"),
            Some("workflow"),
            Some(Some("G:/repo")),
        )
        .unwrap();
        assert!(updated);

        let fetched = get_entry(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(fetched.title, "New title");
        assert_eq!(fetched.content, "New content.");
        assert_eq!(fetched.tags, vec!["b".to_string()]);
        assert_eq!(fetched.category, Category::Workflow);
        assert_eq!(fetched.scope.as_deref(), Some("G:/repo"));
    }

    #[test]
    fn update_scope_to_null_clears_it() {
        let (_dir, conn) = test_db();
        let entry = add_entry(
            &conn,
            &Category::Pitfall,
            "Scoped",
            "Content.",
            &[],
            Some("G:/repo"),
            &Source::Human,
            1.0,
        )
        .unwrap();
        assert!(update_entry(&conn, &entry.id, None, None, None, None, Some(None)).unwrap());
        let fetched = get_entry(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(fetched.scope, None);
    }

    #[test]
    fn update_missing_id_returns_false() {
        let (_dir, conn) = test_db();
        assert!(!update_entry(&conn, "missing", None, None, None, None, None).unwrap());
    }

    #[test]
    fn remove_and_confirm() {
        let (_dir, conn) = test_db();
        let entry = add(&conn, Category::Pitfall, "Temp", "Content.", &[], Source::AiLearned, 0.3);

        assert!(confirm_entry(&conn, &entry.id).unwrap());
        let fetched = get_entry(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(fetched.source, Source::AiConfirmed);
        assert_eq!(fetched.confidence, 1.0);

        assert!(remove_entry(&conn, &entry.id).unwrap());
        assert!(get_entry(&conn, &entry.id).unwrap().is_none());
        assert!(!remove_entry(&conn, &entry.id).unwrap());
        assert!(!confirm_entry(&conn, &entry.id).unwrap());
    }

    #[test]
    fn stats_aggregates() {
        let (_dir, conn) = test_db();
        add(&conn, Category::CodingStyle, "A", "Content.", &[], Source::Human, 1.0);
        add(&conn, Category::CodingStyle, "B", "Content.", &[], Source::Human, 0.5);
        add(&conn, Category::Pitfall, "C", "Content.", &[], Source::AiLearned, 0.25);

        let stats = get_stats(&conn).unwrap();
        assert_eq!(stats.total, 3);
        assert_eq!(stats.by_category.get("coding-style"), Some(&2));
        assert_eq!(stats.by_category.get("pitfall"), Some(&1));
        assert_eq!(stats.by_source.get("human"), Some(&2));
        assert_eq!(stats.by_source.get("ai-learned"), Some(&1));
        assert!((stats.avg_confidence - (1.0 + 0.5 + 0.25) / 3.0).abs() < 1e-9);
    }

    #[test]
    fn stats_empty_db() {
        let (_dir, conn) = test_db();
        let stats = get_stats(&conn).unwrap();
        assert_eq!(stats.total, 0);
        assert!(stats.by_category.is_empty());
        assert_eq!(stats.avg_confidence, 0.0);
    }

    #[test]
    fn invalid_category_rejected_by_schema() {
        let (_dir, conn) = test_db();
        let err = conn.execute(
            "INSERT INTO entries (id, category, title, content, tags, confidence, source, created_at, updated_at)
             VALUES ('x', 'bogus', 't', 'c', '', 1.0, 'human', 'now', 'now')",
            [],
        );
        assert!(err.is_err(), "CHECK constraint should reject the row");
    }
}
