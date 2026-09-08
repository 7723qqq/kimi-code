//! RFC 6902 JSON Patch & Diff Engine.
//!
//! Provides standard RFC 6902 operations (`add`, `remove`, `replace`, `move`, `copy`, `test`),
//! JSON Pointer RFC 6901 resolution, bidirectional diff computation, and inverse patch generation
//! for fine-grained state undo/redo workflows.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum PatchError {
    #[error("Invalid JSON Pointer syntax: {0}")]
    InvalidPointer(String),
    #[error("Pointer target not found: {0}")]
    NotFound(String),
    #[error("Invalid array index in pointer: {0}")]
    InvalidIndex(String),
    #[error("Type mismatch at {0}: expected {1}, found {2}")]
    TypeMismatch(String, &'static str, &'static str),
    #[error("Test operation failed at {path}: expected {expected}, found {actual}")]
    TestFailed {
        path: String,
        expected: String,
        actual: String,
    },
}

/// Escapes a token for RFC 6901 JSON Pointer (`~` -> `~0`, `/` -> `~1`).
pub fn escape_pointer_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

/// Unescapes an RFC 6901 JSON Pointer token (`~1` -> `/`, `~0` -> `~`).
pub fn unescape_pointer_token(token: &str) -> String {
    token.replace("~1", "/").replace("~0", "~")
}

/// Parses an RFC 6901 JSON pointer string into decoded path segments.
pub fn parse_pointer(pointer: &str) -> Result<Vec<String>, PatchError> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    if !pointer.starts_with('/') {
        return Err(PatchError::InvalidPointer(pointer.to_string()));
    }
    Ok(pointer[1..]
        .split('/')
        .map(unescape_pointer_token)
        .collect())
}

/// Single RFC 6902 Patch Operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum PatchOp {
    Add { path: String, value: Value },
    Remove { path: String },
    Replace { path: String, value: Value },
    Move { from: String, path: String },
    Copy { from: String, path: String },
    Test { path: String, value: Value },
}

impl PatchOp {
    pub fn path(&self) -> &str {
        match self {
            PatchOp::Add { path, .. }
            | PatchOp::Remove { path }
            | PatchOp::Replace { path, .. }
            | PatchOp::Move { path, .. }
            | PatchOp::Copy { path, .. }
            | PatchOp::Test { path, .. } => path,
        }
    }
}

/// Ordered set of RFC 6902 patch operations.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JsonPatchSet {
    pub ops: Vec<PatchOp>,
}

impl JsonPatchSet {
    pub fn new(ops: Vec<PatchOp>) -> Self {
        Self { ops }
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }
}

/// Navigates through a JSON value by segments and retrieves a reference.
fn get_by_segments<'a>(mut val: &'a Value, segments: &[String]) -> Option<&'a Value> {
    for seg in segments {
        match val {
            Value::Object(map) => {
                val = map.get(seg)?;
            }
            Value::Array(arr) => {
                let idx: usize = seg.parse().ok()?;
                val = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(val)
}

/// Retrieves a value by JSON Pointer.
pub fn get_value_at<'a>(root: &'a Value, pointer: &str) -> Result<&'a Value, PatchError> {
    let segments = parse_pointer(pointer)?;
    get_by_segments(root, &segments).ok_or_else(|| PatchError::NotFound(pointer.to_string()))
}

/// Applies a single patch operation to `target` in place, optionally generating an inverse operation.
pub fn apply_op(target: &mut Value, op: &PatchOp) -> Result<Option<PatchOp>, PatchError> {
    match op {
        PatchOp::Test { path, value } => {
            let actual = get_value_at(target, path)?;
            if actual != value {
                return Err(PatchError::TestFailed {
                    path: path.clone(),
                    expected: serde_json::to_string(value).unwrap_or_default(),
                    actual: serde_json::to_string(actual).unwrap_or_default(),
                });
            }
            Ok(None)
        }
        PatchOp::Add { path, value } => {
            let segments = parse_pointer(path)?;
            if segments.is_empty() {
                let old = target.clone();
                *target = value.clone();
                return Ok(Some(PatchOp::Replace {
                    path: String::new(),
                    value: old,
                }));
            }
            let (parent_segs, last_token) = segments.split_at(segments.len() - 1);
            let last = &last_token[0];
            let old_val = get_by_segments(target, &segments).cloned();

            let parent = navigate_mut(target, parent_segs, path)?;
            match parent {
                Value::Object(map) => {
                    map.insert(last.clone(), value.clone());
                    let inverse = match old_val {
                        Some(prev) => PatchOp::Replace {
                            path: path.clone(),
                            value: prev,
                        },
                        None => PatchOp::Remove { path: path.clone() },
                    };
                    Ok(Some(inverse))
                }
                Value::Array(arr) => {
                    if last == "-" {
                        arr.push(value.clone());
                        let idx = arr.len() - 1;
                        Ok(Some(PatchOp::Remove {
                            path: format!("{}/{}", path.trim_end_matches("/-"), idx),
                        }))
                    } else {
                        let idx: usize = last
                            .parse()
                            .map_err(|_| PatchError::InvalidIndex(path.clone()))?;
                        if idx > arr.len() {
                            return Err(PatchError::InvalidIndex(path.clone()));
                        }
                        arr.insert(idx, value.clone());
                        Ok(Some(PatchOp::Remove { path: path.clone() }))
                    }
                }
                _ => Err(PatchError::TypeMismatch(
                    path.clone(),
                    "Object or Array",
                    parent.type_str(),
                )),
            }
        }
        PatchOp::Remove { path } => {
            let segments = parse_pointer(path)?;
            if segments.is_empty() {
                return Err(PatchError::InvalidPointer(
                    "Cannot remove root element".into(),
                ));
            }
            let (parent_segs, last_token) = segments.split_at(segments.len() - 1);
            let last = &last_token[0];

            let parent = navigate_mut(target, parent_segs, path)?;
            match parent {
                Value::Object(map) => {
                    let removed = map
                        .remove(last)
                        .ok_or_else(|| PatchError::NotFound(path.clone()))?;
                    Ok(Some(PatchOp::Add {
                        path: path.clone(),
                        value: removed,
                    }))
                }
                Value::Array(arr) => {
                    let idx: usize = last
                        .parse()
                        .map_err(|_| PatchError::InvalidIndex(path.clone()))?;
                    if idx >= arr.len() {
                        return Err(PatchError::NotFound(path.clone()));
                    }
                    let removed = arr.remove(idx);
                    Ok(Some(PatchOp::Add {
                        path: path.clone(),
                        value: removed,
                    }))
                }
                _ => Err(PatchError::TypeMismatch(
                    path.clone(),
                    "Object or Array",
                    parent.type_str(),
                )),
            }
        }
        PatchOp::Replace { path, value } => {
            let segments = parse_pointer(path)?;
            if segments.is_empty() {
                let old = target.clone();
                *target = value.clone();
                return Ok(Some(PatchOp::Replace {
                    path: String::new(),
                    value: old,
                }));
            }
            let (parent_segs, last_token) = segments.split_at(segments.len() - 1);
            let last = &last_token[0];

            let parent = navigate_mut(target, parent_segs, path)?;
            match parent {
                Value::Object(map) => {
                    if !map.contains_key(last) {
                        return Err(PatchError::NotFound(path.clone()));
                    }
                    let old = map.insert(last.clone(), value.clone()).unwrap();
                    Ok(Some(PatchOp::Replace {
                        path: path.clone(),
                        value: old,
                    }))
                }
                Value::Array(arr) => {
                    let idx: usize = last
                        .parse()
                        .map_err(|_| PatchError::InvalidIndex(path.clone()))?;
                    if idx >= arr.len() {
                        return Err(PatchError::NotFound(path.clone()));
                    }
                    let old = std::mem::replace(&mut arr[idx], value.clone());
                    Ok(Some(PatchOp::Replace {
                        path: path.clone(),
                        value: old,
                    }))
                }
                _ => Err(PatchError::TypeMismatch(
                    path.clone(),
                    "Object or Array",
                    parent.type_str(),
                )),
            }
        }
        PatchOp::Move { from, path } => {
            let from_val = get_value_at(target, from)?.clone();
            let _ = apply_op(target, &PatchOp::Remove { path: from.clone() })?;
            let _ = apply_op(
                target,
                &PatchOp::Add {
                    path: path.clone(),
                    value: from_val,
                },
            )?;
            Ok(Some(PatchOp::Move {
                from: path.clone(),
                path: from.clone(),
            }))
        }
        PatchOp::Copy { from, path } => {
            let from_val = get_value_at(target, from)?.clone();
            let _ = apply_op(
                target,
                &PatchOp::Add {
                    path: path.clone(),
                    value: from_val,
                },
            )?;
            Ok(Some(PatchOp::Remove { path: path.clone() }))
        }
    }
}

/// Applies a sequence of patch operations to `target` and returns the Inverse PatchSet.
pub fn apply_patch(
    target: &mut Value,
    patch: &JsonPatchSet,
) -> Result<JsonPatchSet, PatchError> {
    let mut inverse_ops = Vec::new();
    for op in &patch.ops {
        if let Some(inv) = apply_op(target, op)? {
            inverse_ops.push(inv);
        }
    }
    // Invert the order of inverse operations so applying them reverts in LIFO sequence.
    inverse_ops.reverse();
    Ok(JsonPatchSet::new(inverse_ops))
}

/// Computes an RFC 6902 PatchSet transforming `old` into `new`.
pub fn diff_values(old: &Value, new: &Value) -> JsonPatchSet {
    let mut ops = Vec::new();
    diff_recursive(old, new, String::new(), &mut ops);
    JsonPatchSet::new(ops)
}

fn diff_recursive(old: &Value, new: &Value, current_path: String, ops: &mut Vec<PatchOp>) {
    if old == new {
        return;
    }

    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            // Check for deletions
            for k in old_map.keys() {
                if !new_map.contains_key(k) {
                    let path = format!("{}/{}", current_path, escape_pointer_token(k));
                    ops.push(PatchOp::Remove { path });
                }
            }
            // Check for additions and mutations
            for (k, new_val) in new_map {
                let path = format!("{}/{}", current_path, escape_pointer_token(k));
                match old_map.get(k) {
                    Some(old_val) => {
                        diff_recursive(old_val, new_val, path, ops);
                    }
                    None => {
                        ops.push(PatchOp::Add {
                            path,
                            value: new_val.clone(),
                        });
                    }
                }
            }
        }
        (Value::Array(old_arr), Value::Array(new_arr)) => {
            // For arrays, if elements differ:
            let min_len = old_arr.len().min(new_arr.len());
            for i in 0..min_len {
                let path = format!("{}/{}", current_path, i);
                diff_recursive(&old_arr[i], &new_arr[i], path, ops);
            }
            if new_arr.len() > old_arr.len() {
                for (i, val) in new_arr.iter().enumerate().skip(min_len) {
                    let path = format!("{}/{}", current_path, i);
                    ops.push(PatchOp::Add {
                        path,
                        value: val.clone(),
                    });
                }
            } else if old_arr.len() > new_arr.len() {
                for _ in min_len..old_arr.len() {
                    // Always remove at min_len as the tail shrinks
                    let path = format!("{}/{}", current_path, min_len);
                    ops.push(PatchOp::Remove { path });
                }
            }
        }
        _ => {
            // Value replacement
            ops.push(PatchOp::Replace {
                path: current_path,
                value: new_val_clone(new),
            });
        }
    }
}

fn new_val_clone(val: &Value) -> Value {
    val.clone()
}

fn navigate_mut<'a>(
    mut target: &'a mut Value,
    segments: &[String],
    full_path: &str,
) -> Result<&'a mut Value, PatchError> {
    for seg in segments {
        match target {
            Value::Object(map) => {
                target = map
                    .get_mut(seg)
                    .ok_or_else(|| PatchError::NotFound(full_path.to_string()))?;
            }
            Value::Array(arr) => {
                let idx: usize = seg
                    .parse()
                    .map_err(|_| PatchError::InvalidIndex(full_path.to_string()))?;
                target = arr
                    .get_mut(idx)
                    .ok_or_else(|| PatchError::NotFound(full_path.to_string()))?;
            }
            _ => {
                return Err(PatchError::TypeMismatch(
                    full_path.to_string(),
                    "Object or Array",
                    target.type_str(),
                ));
            }
        }
    }
    Ok(target)
}

trait ValueTypeStr {
    fn type_str(&self) -> &'static str;
}

impl ValueTypeStr for Value {
    fn type_str(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_pointer_parse_and_escape() {
        assert_eq!(escape_pointer_token("a/b~c"), "a~1b~0c");
        assert_eq!(unescape_pointer_token("a~1b~0c"), "a/b~c");
        assert_eq!(escape_pointer_token("~/"), "~0~1");
        assert_eq!(unescape_pointer_token("~0~1"), "~/");
        assert_eq!(unescape_pointer_token("~01"), "~1");
        assert_eq!(unescape_pointer_token("~10"), "/0");

        // Valid pointer parsing
        assert_eq!(parse_pointer("").unwrap(), Vec::<String>::new());
        assert_eq!(parse_pointer("/a/b/c").unwrap(), vec!["a", "b", "c"]);
        let parsed = parse_pointer("/foo/bar~1baz/0").unwrap();
        assert_eq!(parsed, vec!["foo", "bar/baz", "0"]);
        assert_eq!(parse_pointer("///").unwrap(), vec!["", "", ""]);

        // Invalid pointer syntax (must begin with '/')
        assert_eq!(
            parse_pointer("foo/bar"),
            Err(PatchError::InvalidPointer("foo/bar".to_string()))
        );
        assert_eq!(
            parse_pointer("a"),
            Err(PatchError::InvalidPointer("a".to_string()))
        );
    }

    #[test]
    fn test_get_value_at() {
        let doc = json!({
            "title": "Kimi",
            "items": [10, 20, 30],
            "nested": {
                "a/b": "escaped",
                "c~d": "tilde"
            }
        });

        // Root lookup
        assert_eq!(get_value_at(&doc, "").unwrap(), &doc);

        // Nested and array lookup
        assert_eq!(get_value_at(&doc, "/title").unwrap(), &json!("Kimi"));
        assert_eq!(get_value_at(&doc, "/items/1").unwrap(), &json!(20));
        assert_eq!(get_value_at(&doc, "/nested/a~1b").unwrap(), &json!("escaped"));
        assert_eq!(get_value_at(&doc, "/nested/c~0d").unwrap(), &json!("tilde"));

        // Error cases
        assert_eq!(
            get_value_at(&doc, "/missing"),
            Err(PatchError::NotFound("/missing".to_string()))
        );
        assert_eq!(
            get_value_at(&doc, "/items/99"),
            Err(PatchError::NotFound("/items/99".to_string()))
        );
        assert_eq!(
            get_value_at(&doc, "/title/invalid"),
            Err(PatchError::NotFound("/title/invalid".to_string()))
        );
    }

    #[test]
    fn test_apply_add_operation_and_inverses() {
        let mut doc = json!({
            "title": "Old",
            "items": [1, 2]
        });

        // 1. Add to object generates exact Remove inverse
        let patch_add_obj = JsonPatchSet::new(vec![PatchOp::Add {
            path: "/author".into(),
            value: json!("Moonshot"),
        }]);
        let inv = apply_patch(&mut doc, &patch_add_obj).unwrap();
        assert_eq!(doc["author"], json!("Moonshot"));
        assert_eq!(
            inv.ops,
            vec![PatchOp::Remove {
                path: "/author".into()
            }]
        );

        // 2. Add to array with '-' pushes element and generates exact Remove index inverse
        let patch_push = JsonPatchSet::new(vec![PatchOp::Add {
            path: "/items/-".into(),
            value: json!(3),
        }]);
        let inv_push = apply_patch(&mut doc, &patch_push).unwrap();
        assert_eq!(doc["items"], json!([1, 2, 3]));
        assert_eq!(
            inv_push.ops,
            vec![PatchOp::Remove {
                path: "/items/2".into()
            }]
        );

        // 3. Add to array at index 0 inserts at head and shifts
        let patch_insert = JsonPatchSet::new(vec![PatchOp::Add {
            path: "/items/0".into(),
            value: json!(0),
        }]);
        let inv_insert = apply_patch(&mut doc, &patch_insert).unwrap();
        assert_eq!(doc["items"], json!([0, 1, 2, 3]));
        assert_eq!(
            inv_insert.ops,
            vec![PatchOp::Remove {
                path: "/items/0".into()
            }]
        );

        // 4. Overwrite existing property with Add generates Replace inverse
        let patch_overwrite = JsonPatchSet::new(vec![PatchOp::Add {
            path: "/title".into(),
            value: json!("New"),
        }]);
        let inv_overwrite = apply_patch(&mut doc, &patch_overwrite).unwrap();
        assert_eq!(doc["title"], json!("New"));
        assert_eq!(
            inv_overwrite.ops,
            vec![PatchOp::Replace {
                path: "/title".into(),
                value: json!("Old")
            }]
        );

        // 5. Add at root replaces document entirely
        let old_snapshot = doc.clone();
        let patch_root = JsonPatchSet::new(vec![PatchOp::Add {
            path: "".into(),
            value: json!({ "reset": true }),
        }]);
        let inv_root = apply_patch(&mut doc, &patch_root).unwrap();
        assert_eq!(doc, json!({ "reset": true }));
        assert_eq!(
            inv_root.ops,
            vec![PatchOp::Replace {
                path: "".into(),
                value: old_snapshot
            }]
        );

        // Revert root restore
        apply_patch(&mut doc, &inv_root).unwrap();
        assert_eq!(doc["title"], json!("New"));

        // Error cases
        let mut err_doc = json!({ "items": [1, 2], "scalar": 42 });
        assert_eq!(
            apply_patch(
                &mut err_doc,
                &JsonPatchSet::new(vec![PatchOp::Add {
                    path: "/items/not_a_number".into(),
                    value: json!(99),
                }])
            ),
            Err(PatchError::InvalidIndex("/items/not_a_number".into()))
        );
        assert_eq!(
            apply_patch(
                &mut err_doc,
                &JsonPatchSet::new(vec![PatchOp::Add {
                    path: "/items/99".into(),
                    value: json!(99),
                }])
            ),
            Err(PatchError::InvalidIndex("/items/99".into()))
        );
        assert_eq!(
            apply_patch(
                &mut err_doc,
                &JsonPatchSet::new(vec![PatchOp::Add {
                    path: "/scalar/sub".into(),
                    value: json!(99),
                }])
            ),
            Err(PatchError::TypeMismatch(
                "/scalar/sub".into(),
                "Object or Array",
                "number"
            ))
        );
    }

    #[test]
    fn test_apply_remove_operation_and_inverses() {
        let mut doc = json!({
            "title": "Old",
            "items": [10, 20, 30]
        });

        // 1. Remove object property generates exact Add inverse with removed value
        let patch_rm = JsonPatchSet::new(vec![PatchOp::Remove {
            path: "/title".into(),
        }]);
        let inv_rm = apply_patch(&mut doc, &patch_rm).unwrap();
        assert!(doc.get("title").is_none());
        assert_eq!(
            inv_rm.ops,
            vec![PatchOp::Add {
                path: "/title".into(),
                value: json!("Old")
            }]
        );

        // 2. Remove array element by index shifts and generates exact Add inverse
        let patch_rm_arr = JsonPatchSet::new(vec![PatchOp::Remove {
            path: "/items/1".into(),
        }]);
        let inv_rm_arr = apply_patch(&mut doc, &patch_rm_arr).unwrap();
        assert_eq!(doc["items"], json!([10, 30]));
        assert_eq!(
            inv_rm_arr.ops,
            vec![PatchOp::Add {
                path: "/items/1".into(),
                value: json!(20)
            }]
        );

        // Reverting in LIFO restores full doc state
        apply_patch(&mut doc, &inv_rm_arr).unwrap();
        assert_eq!(doc["items"], json!([10, 20, 30]));
        apply_patch(&mut doc, &inv_rm).unwrap();
        assert_eq!(doc["title"], json!("Old"));

        // Error cases
        assert_eq!(
            apply_patch(
                &mut doc,
                &JsonPatchSet::new(vec![PatchOp::Remove {
                    path: "".into()
                }])
            ),
            Err(PatchError::InvalidPointer(
                "Cannot remove root element".into()
            ))
        );
        assert_eq!(
            apply_patch(
                &mut doc,
                &JsonPatchSet::new(vec![PatchOp::Remove {
                    path: "/missing_key".into()
                }])
            ),
            Err(PatchError::NotFound("/missing_key".into()))
        );
        assert_eq!(
            apply_patch(
                &mut doc,
                &JsonPatchSet::new(vec![PatchOp::Remove {
                    path: "/items/99".into()
                }])
            ),
            Err(PatchError::NotFound("/items/99".into()))
        );
        assert_eq!(
            apply_patch(
                &mut doc,
                &JsonPatchSet::new(vec![PatchOp::Remove {
                    path: "/items/abc".into()
                }])
            ),
            Err(PatchError::InvalidIndex("/items/abc".into()))
        );
    }

    #[test]
    fn test_apply_replace_operation_and_inverses() {
        let mut doc = json!({
            "title": "Old",
            "items": [10, 20]
        });

        // 1. Replace object property
        let patch_rep = JsonPatchSet::new(vec![PatchOp::Replace {
            path: "/title".into(),
            value: json!("New"),
        }]);
        let inv_rep = apply_patch(&mut doc, &patch_rep).unwrap();
        assert_eq!(doc["title"], json!("New"));
        assert_eq!(
            inv_rep.ops,
            vec![PatchOp::Replace {
                path: "/title".into(),
                value: json!("Old")
            }]
        );

        // 2. Replace array element
        let patch_rep_arr = JsonPatchSet::new(vec![PatchOp::Replace {
            path: "/items/1".into(),
            value: json!(99),
        }]);
        let inv_rep_arr = apply_patch(&mut doc, &patch_rep_arr).unwrap();
        assert_eq!(doc["items"], json!([10, 99]));
        assert_eq!(
            inv_rep_arr.ops,
            vec![PatchOp::Replace {
                path: "/items/1".into(),
                value: json!(20)
            }]
        );

        // 3. Replace root
        let old_root = doc.clone();
        let patch_rep_root = JsonPatchSet::new(vec![PatchOp::Replace {
            path: "".into(),
            value: json!({ "fresh": 1 }),
        }]);
        let inv_rep_root = apply_patch(&mut doc, &patch_rep_root).unwrap();
        assert_eq!(doc, json!({ "fresh": 1 }));
        assert_eq!(
            inv_rep_root.ops,
            vec![PatchOp::Replace {
                path: "".into(),
                value: old_root
            }]
        );

        // Error cases
        let mut doc_err = json!({ "key": 1, "items": [2] });
        assert_eq!(
            apply_patch(
                &mut doc_err,
                &JsonPatchSet::new(vec![PatchOp::Replace {
                    path: "/missing".into(),
                    value: json!(2),
                }])
            ),
            Err(PatchError::NotFound("/missing".into()))
        );
        assert_eq!(
            apply_patch(
                &mut doc_err,
                &JsonPatchSet::new(vec![PatchOp::Replace {
                    path: "/items/99".into(),
                    value: json!(2),
                }])
            ),
            Err(PatchError::NotFound("/items/99".into()))
        );
    }

    #[test]
    fn test_apply_move_and_copy_operations() {
        let mut doc = json!({
            "first": "value1",
            "arr": [10, 20]
        });

        // 1. Move within object: moves "first" to "second"
        let patch_move = JsonPatchSet::new(vec![PatchOp::Move {
            from: "/first".into(),
            path: "/second".into(),
        }]);
        let inv_move = apply_patch(&mut doc, &patch_move).unwrap();
        assert!(doc.get("first").is_none());
        assert_eq!(doc["second"], json!("value1"));
        assert_eq!(
            inv_move.ops,
            vec![PatchOp::Move {
                from: "/second".into(),
                path: "/first".into()
            }]
        );

        // Revert move
        apply_patch(&mut doc, &inv_move).unwrap();
        assert_eq!(doc["first"], json!("value1"));
        assert!(doc.get("second").is_none());

        // 2. Copy within object: copies "first" to "copied"
        let patch_copy = JsonPatchSet::new(vec![PatchOp::Copy {
            from: "/first".into(),
            path: "/copied".into(),
        }]);
        let inv_copy = apply_patch(&mut doc, &patch_copy).unwrap();
        assert_eq!(doc["first"], json!("value1"));
        assert_eq!(doc["copied"], json!("value1"));
        assert_eq!(
            inv_copy.ops,
            vec![PatchOp::Remove {
                path: "/copied".into()
            }]
        );

        // Error: move / copy from non-existent path
        assert_eq!(
            apply_patch(
                &mut doc,
                &JsonPatchSet::new(vec![PatchOp::Move {
                    from: "/nonexistent".into(),
                    path: "/dest".into(),
                }])
            ),
            Err(PatchError::NotFound("/nonexistent".into()))
        );
        assert_eq!(
            apply_patch(
                &mut doc,
                &JsonPatchSet::new(vec![PatchOp::Copy {
                    from: "/nonexistent".into(),
                    path: "/dest".into(),
                }])
            ),
            Err(PatchError::NotFound("/nonexistent".into()))
        );
    }

    #[test]
    fn test_diff_and_inverse_roundtrip() {
        // Test identical values diff is empty
        let same = json!({ "a": 1, "b": [2, 3] });
        let empty_diff = diff_values(&same, &same);
        assert!(empty_diff.is_empty());
        assert_eq!(empty_diff.len(), 0);

        // Test array shrinking diff produces exact remove ops
        let arr_old = json!({ "list": [1, 2, 3, 4] });
        let arr_new = json!({ "list": [1, 2] });
        let shrink_diff = diff_values(&arr_old, &arr_new);
        assert_eq!(
            shrink_diff.ops,
            vec![
                PatchOp::Remove {
                    path: "/list/2".into()
                },
                PatchOp::Remove {
                    path: "/list/2".into()
                }
            ]
        );
        let mut shrink_target = arr_old.clone();
        let inv_shrink = apply_patch(&mut shrink_target, &shrink_diff).unwrap();
        assert_eq!(shrink_target, arr_new);
        apply_patch(&mut shrink_target, &inv_shrink).unwrap();
        assert_eq!(shrink_target, arr_old);

        // Comprehensive diff roundtrip
        let old = json!({
            "name": "Kimi",
            "active": true,
            "skills": ["rust", "ts"],
            "meta": { "version": 1 }
        });

        let new = json!({
            "name": "Kimi Code",
            "skills": ["rust", "ts", "python"],
            "meta": { "version": 2, "author": "Moonshot" },
            "extra": 100
        });

        let diff = diff_values(&old, &new);
        assert!(!diff.is_empty());
        let mut target = old.clone();
        let inv = apply_patch(&mut target, &diff).unwrap();

        // Target matches new exactly
        assert_eq!(target, new);

        // Applying inverse restores old exactly
        apply_patch(&mut target, &inv).unwrap();
        assert_eq!(target, old);
    }

    #[test]
    fn test_test_op_success_and_failure() {
        let mut doc = json!({ "count": 42, "user": { "name": "Kimi" } });

        // Passing test: returns empty inverse and preserves document unchanged
        let pass = JsonPatchSet::new(vec![
            PatchOp::Test {
                path: "/count".into(),
                value: json!(42),
            },
            PatchOp::Test {
                path: "/user/name".into(),
                value: json!("Kimi"),
            },
        ]);
        let pass_inv = apply_patch(&mut doc, &pass).unwrap();
        assert!(pass_inv.is_empty());
        assert_eq!(doc["count"], json!(42));
        assert_eq!(doc["user"]["name"], json!("Kimi"));

        // Failing test: returns exact TestFailed error with path, expected, and actual
        let fail = JsonPatchSet::new(vec![PatchOp::Test {
            path: "/count".into(),
            value: json!(99),
        }]);
        let err = apply_patch(&mut doc, &fail).unwrap_err();
        assert_eq!(
            err,
            PatchError::TestFailed {
                path: "/count".into(),
                expected: "99".into(),
                actual: "42".into(),
            }
        );

        // Test on non-existent path returns NotFound
        let fail_missing = JsonPatchSet::new(vec![PatchOp::Test {
            path: "/nonexistent".into(),
            value: json!(1),
        }]);
        assert_eq!(
            apply_patch(&mut doc, &fail_missing),
            Err(PatchError::NotFound("/nonexistent".into()))
        );
    }

    #[test]
    fn test_patch_op_path_getter() {
        assert_eq!(
            PatchOp::Add {
                path: "/a".into(),
                value: json!(1)
            }
            .path(),
            "/a"
        );
        assert_eq!(PatchOp::Remove { path: "/b".into() }.path(), "/b");
        assert_eq!(
            PatchOp::Replace {
                path: "/c".into(),
                value: json!(2)
            }
            .path(),
            "/c"
        );
        assert_eq!(
            PatchOp::Move {
                from: "/x".into(),
                path: "/d".into()
            }
            .path(),
            "/d"
        );
        assert_eq!(
            PatchOp::Copy {
                from: "/y".into(),
                path: "/e".into()
            }
            .path(),
            "/e"
        );
        assert_eq!(
            PatchOp::Test {
                path: "/f".into(),
                value: json!(3)
            }
            .path(),
            "/f"
        );
    }
}
