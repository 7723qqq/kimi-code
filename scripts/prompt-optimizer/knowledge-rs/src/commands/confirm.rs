use crate::store;
use rusqlite::Connection;

pub fn run(conn: &Connection, id: &str, json_output: bool) -> Result<(), String> {
    let confirmed =
        store::confirm_entry(conn, id).map_err(|e| format!("Failed to confirm: {e}"))?;

    if !confirmed {
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
        println!("Confirmed entry: {id} (confidence → 1.0, source → ai-confirmed)");
    }
    Ok(())
}
