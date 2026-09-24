use crate::import_export;
use rusqlite::Connection;
use std::path::Path;

pub fn run(conn: &Connection, file: &Path, json_output: bool) -> Result<(), String> {
    let entries = import_export::import_from_markdown(conn, file)?;

    if json_output {
        let json = serde_json::to_string_pretty(&entries)
            .map_err(|e| format!("Failed to serialize output: {e}"))?;
        println!("{json}");
    } else {
        println!("Imported {} entries from {}", entries.len(), file.display());
        for e in &entries {
            println!("  + [{}] {}", e.category, e.title);
        }
    }
    Ok(())
}
