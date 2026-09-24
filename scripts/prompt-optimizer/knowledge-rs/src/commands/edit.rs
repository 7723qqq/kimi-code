use crate::store;
use rusqlite::Connection;

// CLI entry: args come straight from command-line parsing; keep the flat signature
#[allow(clippy::too_many_arguments)]
pub fn run(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    content: Option<&str>,
    tags: Option<&str>,
    category: Option<&str>,
    scope: Option<String>,
    json_output: bool,
) -> Result<(), String> {
    let scope_opt = scope
        .as_ref()
        .map(|s| if s.is_empty() { None } else { Some(s.as_str()) });
    let updated = store::update_entry(conn, id, title, content, tags, category, scope_opt)
        .map_err(|e| format!("Failed to update: {e}"))?;

    if !updated {
        return Err(format!("Entry not found: {id}"));
    }

    if json_output {
        let entry = store::get_entry(conn, id)
            .map_err(|e| format!("Failed to get entry: {e}"))?
            .ok_or_else(|| format!("Entry not found: {id}"))?;
        let json = serde_json::to_string_pretty(&entry)
            .map_err(|e| format!("Failed to serialize output: {e}"))?;
        println!("{json}");
    } else {
        println!("Updated entry: {id}");
    }
    Ok(())
}
