//! Task output formatting, ported from the v2 task tools
//! (`agent-core-v2/src/agent/task/tools/format.ts`). `format_plain_object`
//! renders a record as `snake_case_field: value` lines for the TaskList /
//! TaskOutput / WaitFor tools.

use serde_json::{Map, Value};

/// Convert a camelCase field name to snake_case, mirroring v2 `fieldName`
/// (each ASCII uppercase letter becomes `_` + its lowercase form).
pub fn field_name(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for ch in key.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Render a scalar the way JS `String(value)` does: strings pass through
/// unquoted, numbers and booleans use their JSON rendering. Objects and
/// arrays render as JSON (v2 never passes them to this helper).
fn format_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn format_lines<'a>(entries: impl Iterator<Item = (&'a str, &'a Value)>) -> String {
    entries
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| format!("{}: {}", field_name(key), format_value(value)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Format a record as `field: value` lines, mirroring v2 `formatPlainObject`:
/// null values are skipped, camelCase keys become snake_case, strings pass
/// through unquoted. Non-object input renders as an empty string.
///
/// Note: serde_json objects iterate keys in sorted order (no
/// `preserve_order` feature), so records deserialized from the host render
/// alphabetically; use [`format_plain_object_entries`] when the v2 field
/// order must be preserved.
pub fn format_plain_object(record: &Value) -> String {
    let Some(obj) = record.as_object() else {
        return String::new();
    };
    format_lines(obj.iter().map(|(k, v)| (k.as_str(), v)))
}

/// v2 `formatTaskRecord` (upstream #3966): the record's `startedAt` /
/// `endedAt` are replaced by a leading `Wall time: X.XXX seconds` line —
/// `endedAt` falls back to now for a still-running task, and the duration
/// clamps at zero. The remaining fields render as the plain object body; a
/// record with no timing fields renders as the plain body alone (v2's types
/// guarantee `startedAt`, the wire does not).
pub fn format_task_record(record: &Value) -> String {
    let Some(obj) = record.as_object() else {
        return String::new();
    };
    let started_at = obj.get("startedAt").and_then(|v| v.as_u64());
    let body = format_lines(
        obj.iter()
            .filter(|(key, _)| !matches!(key.as_str(), "startedAt" | "endedAt"))
            .map(|(k, v)| (k.as_str(), v)),
    );
    let Some(started_at) = started_at else {
        return body;
    };
    let ended_at = obj
        .get("endedAt")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(now_ms);
    let header = crate::turn_loop::wall_time::wall_time_header(ended_at.saturating_sub(started_at));
    if body.is_empty() {
        header
    } else {
        format!("{header}\n{body}")
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Format an ordered list of (key, value) pairs, preserving the given order
/// (the v2 object-literal order). Null values are skipped.
pub fn format_plain_object_entries(entries: &[(&str, &Value)]) -> String {
    format_lines(entries.iter().copied())
}

/// Format a record map as `field: value` lines (see
/// [`format_plain_object`]).
pub fn format_plain_object_map(record: &Map<String, Value>) -> String {
    format_lines(record.iter().map(|(k, v)| (k.as_str(), v)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_field_name() {
        assert_eq!(field_name("taskId"), "task_id");
        assert_eq!(field_name("outputPath"), "output_path");
        assert_eq!(field_name("fullOutputTool"), "full_output_tool");
        assert_eq!(field_name("task_id"), "task_id");
        assert_eq!(field_name("description"), "description");
        assert_eq!(field_name("URL"), "_u_r_l");
    }

    #[test]
    fn test_format_plain_object_golden() {
        let record = json!({
            "taskId": "task-1",
            "description": "Running tests",
            "status": "running",
            "detached": false,
            "startedAt": 1700000000000u64,
            "endedAt": null,
            "stopReason": null,
            "timeoutMs": 60000
        });
        // serde_json objects iterate keys in sorted order.
        assert_eq!(
            format_plain_object(&record),
            "description: Running tests\n\
             detached: false\n\
             started_at: 1700000000000\n\
             status: running\n\
             task_id: task-1\n\
             timeout_ms: 60000"
        );
    }

    #[test]
    fn test_format_plain_object_entries_preserves_order() {
        let entries = [
            ("taskId", &json!("task-1")),
            ("description", &json!("Running tests")),
            ("status", &json!("running")),
            ("startedAt", &json!(1_700_000_000_000u64)),
            ("endedAt", &Value::Null),
            ("timeoutMs", &json!(60_000)),
        ];
        assert_eq!(
            format_plain_object_entries(&entries),
            "task_id: task-1\n\
             description: Running tests\n\
             status: running\n\
             started_at: 1700000000000\n\
             timeout_ms: 60000"
        );
    }

    #[test]
    fn test_format_plain_object_map() {
        let mut map = Map::new();
        map.insert("taskId".into(), json!("task-1"));
        map.insert("endedAt".into(), Value::Null);
        assert_eq!(format_plain_object_map(&map), "task_id: task-1");
    }

    #[test]
    fn test_format_plain_object_non_object_and_empty() {
        assert_eq!(format_plain_object(&json!("nope")), "");
        assert_eq!(format_plain_object(&json!(42)), "");
        assert_eq!(format_plain_object(&json!([])), "");
        assert_eq!(format_plain_object(&json!({})), "");
    }

    #[test]
    fn test_format_plain_object_scalar_rendering() {
        let record = json!({
            "flag": true,
            "ratio": 0.5,
            "count": 3,
            "note": "plain text"
        });
        let out = format_plain_object(&record);
        assert!(out.contains("flag: true"));
        assert!(out.contains("ratio: 0.5"));
        assert!(out.contains("count: 3"));
        assert!(out.contains("note: plain text"));
    }

    #[test]
    fn test_format_task_record_replaces_timing_with_wall_time_line() {
        // Upstream #3966: startedAt/endedAt leave the body; the wall-time
        // line takes their place at the top.
        let record = json!({
            "taskId": "task-1",
            "description": "Running tests",
            "status": "completed",
            "startedAt": 1700000000000u64,
            "endedAt": 1700000001000u64
        });
        assert_eq!(
            format_task_record(&record),
            "Wall time: 1.000 seconds\n\
             description: Running tests\n\
             status: completed\n\
             task_id: task-1"
        );
    }

    #[test]
    fn test_format_task_record_without_timing_renders_plain_body() {
        let record = json!({ "taskId": "task-1", "status": "running" });
        assert_eq!(
            format_task_record(&record),
            "status: running\ntask_id: task-1"
        );
    }

    #[test]
    fn test_format_task_record_body_only_timing_renders_header_alone() {
        let record = json!({ "startedAt": 1700000000000u64, "endedAt": 1700000000500u64 });
        assert_eq!(format_task_record(&record), "Wall time: 0.500 seconds");
    }

    #[test]
    fn test_format_task_record_non_object_renders_empty() {
        assert_eq!(format_task_record(&json!("nope")), "");
        assert_eq!(format_task_record(&json!([])), "");
    }
}
