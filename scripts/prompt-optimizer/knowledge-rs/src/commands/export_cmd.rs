use crate::import_export;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

pub fn run(conn: &Connection, file: Option<&Path>, json_output: bool) -> Result<(), String> {
    let markdown = import_export::export_to_markdown(conn)?;

    if let Some(path) = file {
        fs::write(path, &markdown)
            .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
        if json_output {
            let result = serde_json::json!({"exported_to": path.display().to_string()});
            let json = serde_json::to_string(&result)
                .map_err(|e| format!("Failed to serialize output: {e}"))?;
            println!("{json}");
        } else {
            println!("Exported to: {}", path.display());
        }
    } else {
        print!("{markdown}");
    }
    Ok(())
}
