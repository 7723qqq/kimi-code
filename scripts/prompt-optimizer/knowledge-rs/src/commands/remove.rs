use crate::store;
use rusqlite::Connection;

pub fn run(conn: &Connection, id: &str, json_output: bool) -> Result<(), String> {
    let removed = store::remove_entry(conn, id).map_err(|e| format!("Failed to remove: {e}"))?;

    if !removed {
        return Err(format!("Entry not found: {id}"));
    }

    if json_output {
        let result = serde_json::json!({"removed": id});
        let json = serde_json::to_string(&result)
            .map_err(|e| format!("Failed to serialize output: {e}"))?;
        println!("{json}");
    } else {
        println!("Removed entry: {id}");
    }
    Ok(())
}
