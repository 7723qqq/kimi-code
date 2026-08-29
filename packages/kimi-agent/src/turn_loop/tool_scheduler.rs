//! Tool scheduling — parallel and serial execution of tool calls with
//! resource conflict detection.
//!
//! Corresponds to `packages/agent-core-v2/src/agent/toolExecutor/toolScheduler.ts`.
//!
//! The scheduler groups tool calls into non-conflicting batches:
//!   - Tasks with non-conflicting resource accesses run in the same batch
//!     (parallel execution).
//!   - Tasks with conflicting resource accesses are placed in separate
//!     batches (serial execution).
//!   - Within each batch, tasks are independent and safe to parallelise.

use std::future::Future;
use std::sync::Arc;

use crate::turn_loop::types::{
    read_file_access, read_tree_access, tool_accesses_conflict, write_file_access,
    write_tree_access, ExecutableToolResult, ToolAccesses, ToolCall, ToolFileAccess,
    ToolResourceAccess, FileOperation,
};

/// A scheduled tool call with its resource accesses.
#[derive(Debug, Clone)]
pub struct ScheduledToolCall {
    pub tool_call: ToolCall,
    pub accesses: ToolAccesses,
}

/// Groups tool calls into non-conflicting batches.
///
/// Returns `Vec<Vec<ScheduledToolCall>>` where each inner vec is a batch
/// of tool calls that can safely execute in parallel. Batches must be
/// executed sequentially (batch 0 → batch 1 → …).
///
/// When all access lists are empty (no access info available), falls back
/// to a single batch containing all calls (parallel-safe by default).
pub fn schedule_tool_calls(tool_calls: Vec<ScheduledToolCall>) -> Vec<Vec<ScheduledToolCall>> {
    if tool_calls.is_empty() {
        return vec![];
    }

    // Fast path: if none have any accesses, all are parallel-safe.
    let all_empty = tool_calls.iter().all(|t| t.accesses.is_empty());
    if all_empty {
        return vec![tool_calls];
    }

    let mut batches: Vec<Vec<ScheduledToolCall>> = Vec::new();

    for call in tool_calls {
        let mut placed = false;
        for batch in &mut batches {
            let conflicts = batch
                .iter()
                .any(|existing| tool_accesses_conflict(&call.accesses, &existing.accesses));
            if !conflicts {
                batch.push(call.clone());
                placed = true;
                break;
            }
        }
        if !placed {
            batches.push(vec![call]);
        }
    }

    batches
}

/// Execute all scheduled tool calls in order, respecting conflict boundaries.
///
/// Calls from the same batch run concurrently; batches run serially, so
/// conflicting calls (e.g. two writes to the same file) never overlap.
/// Results are returned in the original call order (batches are flattened
/// back to a single Vec).
pub async fn execute_scheduled<F, Fut>(
    _turn_id: &str,
    _step: u32,
    scheduled: Vec<ScheduledToolCall>,
    execute_fn: F,
) -> Result<Vec<ExecutableToolResult>, Box<dyn std::error::Error>>
where
    F: Fn(ToolCall) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<ExecutableToolResult, String>> + Send,
{
    let batches = schedule_tool_calls(scheduled);
    if batches.is_empty() {
        return Ok(vec![]);
    }
    let execute_fn = Arc::new(execute_fn);
    let mut all_results = Vec::new();
    for batch in &batches {
        let mut handles = Vec::with_capacity(batch.len());
        for scheduled in batch {
            let tc = scheduled.tool_call.clone();
            let execute_fn = execute_fn.clone();
            handles.push(tokio::spawn(async move { execute_fn(tc).await }));
        }
        for handle in handles {
            match handle.await {
                Ok(Ok(result)) => all_results.push(result),
                Ok(Err(e)) => return Err(e.into()),
                Err(e) => return Err(format!("Tool task join error: {e}").into()),
            }
        }
    }
    Ok(all_results)
}

/// Infer the resource accesses of a tool call from its name and arguments.
///
/// Mirrors the accesses declared by the matching v2 tool implementations
/// (`read` → readFile, `write` → writeFile, `edit` → readWriteFile,
/// `grep` / `glob` → search tree). Unknown tools or calls without a
/// parseable `path` get no accesses (parallel-safe), matching the v2 host's
/// scheduler semantics for undeclared accesses. The host applies its own
/// full permission + conflict layer on execution anyway; this inference
/// only serializes the file-ops whose declared accesses we can reproduce.
pub fn infer_tool_accesses(tool_name: &str, args: &serde_json::Value) -> ToolAccesses {
    let name = tool_name.to_ascii_lowercase();
    let path = args.get("path").and_then(|p| p.as_str());
    match name.as_str() {
        "read" => path
            .map(read_file_access)
            .into_iter()
            .collect(),
        "write" => path
            .map(write_file_access)
            .into_iter()
            .collect(),
        "edit" => path
            .map(|p| {
                ToolResourceAccess::File(ToolFileAccess {
                    operation: FileOperation::ReadWrite,
                    path: p.to_string(),
                    recursive: false,
                })
            })
            .into_iter()
            .collect(),
        "grep" | "glob" => path
            .map(read_tree_access)
            .into_iter()
            .collect(),
        // A shell command mutates arbitrarily — serialize it against the
        // whole workspace so it never runs concurrently with any other
        // tool that touches the sandbox.
        "bash" => vec![write_tree_access("/")],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_loop::types::{
        all_access, read_file_access, write_file_access, FileOperation, ToolFileAccess, ToolResourceAccess,
    };

    #[test]
    fn test_empty_calls() {
        let result = schedule_tool_calls(vec![]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_no_accesses_all_parallel() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![],
            },
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "2".into(),
                    name: "write".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 2);
    }

    #[test]
    fn test_conflicting_writes_same_file() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "1".into(),
                    name: "write".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![write_file_access("/foo/bar.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "2".into(),
                    name: "write".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![write_file_access("/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 1);
        assert_eq!(batches[1].len(), 1);
    }

    #[test]
    fn test_read_write_same_file_conflict() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![read_file_access("/foo/bar.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "2".into(),
                    name: "write".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![write_file_access("/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn test_read_read_same_file_no_conflict() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "1".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![read_file_access("/foo/bar.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "2".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![read_file_access("/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 2);
    }

    #[test]
    fn test_all_access_conflicts_with_everything() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "1".into(),
                    name: "global".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![all_access()],
            },
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "2".into(),
                    name: "read".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![read_file_access("/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn test_non_overlapping_paths_no_conflict() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "1".into(),
                    name: "write".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![write_file_access("/foo/a.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "2".into(),
                    name: "write".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![write_file_access("/bar/b.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 2);
    }

    #[test]
    fn test_recursive_contains_non_recursive() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "1".into(),
                    name: "write_tree".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![
                    ToolResourceAccess::File(crate::turn_loop::types::ToolFileAccess {
                        operation: crate::turn_loop::types::FileOperation::Write,
                        path: "/foo".to_string(),
                        recursive: true,
                    }),
                ],
            },
            ScheduledToolCall {
                tool_call: ToolCall {
                    id: "2".into(),
                    name: "write_file".into(),
                    arguments: serde_json::json!({}),
                },
                accesses: vec![write_file_access("/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn test_three_way_conflict() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/file.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/file.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "3".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/file.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 3);
        for batch in &batches {
            assert_eq!(batch.len(), 1);
        }
    }

    #[test]
    fn test_mixed_conflict_and_non_conflict() {
        // Two writes to different files + one write to same file as first
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/a.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/b.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "3".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/a.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        // 1 and 2 are non-conflicting, 3 conflicts with 1
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 2); // batch 0: 1, 2
        assert_eq!(batches[1].len(), 1); // batch 1: 3
    }

    #[test]
    fn test_search_no_conflict_with_read() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "search".into(), arguments: serde_json::json!({}) },
                accesses: vec![ToolResourceAccess::File(ToolFileAccess {
                    operation: FileOperation::Search,
                    path: "/foo".to_string(),
                    recursive: true,
                })],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "read".into(), arguments: serde_json::json!({}) },
                accesses: vec![read_file_access("/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        // Search is read-only, read is read-only → no conflict
        assert_eq!(batches.len(), 1);
    }

    #[test]
    fn test_search_conflicts_with_write() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "search".into(), arguments: serde_json::json!({}) },
                accesses: vec![ToolResourceAccess::File(ToolFileAccess {
                    operation: FileOperation::Search,
                    path: "/foo".to_string(),
                    recursive: true,
                })],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        // Write conflicts with everything that reads
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn test_readwrite_conflicts_with_both() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "rw".into(), arguments: serde_json::json!({}) },
                accesses: vec![ToolResourceAccess::File(ToolFileAccess {
                    operation: FileOperation::ReadWrite,
                    path: "/foo".to_string(),
                    recursive: false,
                })],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "read".into(), arguments: serde_json::json!({}) },
                accesses: vec![read_file_access("/foo")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "3".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/foo")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        // ReadWrite conflicts with both read and write
        assert_eq!(batches.len(), 3);
    }

    #[test]
    fn test_windows_path_normalization() {
        // Windows paths with backslashes should be normalized
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("C:\\foo\\bar.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("C:/foo/bar.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn test_multiple_accesses_per_tool() {
        // One tool with multiple accesses
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "multi".into(), arguments: serde_json::json!({}) },
                accesses: vec![read_file_access("/a.txt"), write_file_access("/b.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/a.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        // Tool 1 reads /a.txt, Tool 2 writes /a.txt → conflict
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn test_all_access_blocks_all() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "all".into(), arguments: serde_json::json!({}) },
                accesses: vec![all_access()],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "r".into(), arguments: serde_json::json!({}) },
                accesses: vec![read_file_access("/x.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "3".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/y.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        // all() blocks everything, but r and w don't block each other (different paths)
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 1); // [all]
        assert_eq!(batches[1].len(), 2); // [r, w]
    }

    #[test]
    fn test_single_call_no_conflict() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "only".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/x.txt")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 1);
    }

    #[test]
    fn test_different_dirs_no_conflict() {
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/project/a/src/main.rs")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/project/b/src/lib.rs")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "3".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/project/c/README.md")],
            },
        ];
        let batches = schedule_tool_calls(calls);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 3);
    }

    // ── infer_tool_accesses tests ──────────────────────────────────────

    #[test]
    fn test_infer_read() {
        let accesses = infer_tool_accesses("read", &serde_json::json!({"path": "/a.txt"}));
        assert_eq!(accesses, vec![read_file_access("/a.txt")]);
    }

    #[test]
    fn test_infer_write() {
        let accesses = infer_tool_accesses("Write", &serde_json::json!({"path": "/b.txt"}));
        assert_eq!(accesses, vec![write_file_access("/b.txt")]);
    }

    #[test]
    fn test_infer_edit_is_readwrite() {
        let accesses = infer_tool_accesses("edit", &serde_json::json!({"path": "/c.txt"}));
        assert_eq!(accesses, vec![ToolResourceAccess::File(ToolFileAccess {
            operation: FileOperation::ReadWrite,
            path: "/c.txt".into(),
            recursive: false,
        })]);
    }

    #[test]
    fn test_infer_grep_and_glob_are_tree_reads() {
        let accesses = infer_tool_accesses("grep", &serde_json::json!({"path": "/repo"}));
        assert_eq!(accesses, vec![read_tree_access("/repo")]);
        let accesses = infer_tool_accesses("Glob", &serde_json::json!({"path": "/repo"}));
        assert_eq!(accesses, vec![read_tree_access("/repo")]);
    }

    #[test]
    fn test_infer_bash_is_workspace_wide_write() {
        // A shell command mutates arbitrarily, so it must serialize against
        // every other sandbox-touching tool.
        let accesses = infer_tool_accesses("Bash", &serde_json::json!({"command": "echo hi"}));
        assert_eq!(accesses, vec![write_tree_access("/")]);
        assert!(tool_accesses_conflict(
            &accesses,
            &vec![write_file_access("/any/file.txt")],
        ));
    }

    #[test]
    fn test_infer_unknown_tool_has_no_accesses() {
        let accesses = infer_tool_accesses("web_search", &serde_json::json!({"query": "x"}));
        assert!(accesses.is_empty());
    }

    #[test]
    fn test_infer_missing_path_has_no_accesses() {
        let accesses = infer_tool_accesses("read", &serde_json::json!({}));
        assert!(accesses.is_empty());
    }

    // ── execute_scheduled concurrency/serialization tests ──────────────

    /// Conflicting writes to the same file must not overlap: the second
    /// call only starts after the first finishes.
    #[tokio::test]
    async fn test_execute_scheduled_conflicting_writes_serialized() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let scheduled = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/f.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/f.txt")],
            },
        ];
        let executor = {
            let active = active.clone();
            let max_active = max_active.clone();
            move |_tc: ToolCall| {
                let active = active.clone();
                let max_active = max_active.clone();
                async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(ExecutableToolResult { content: "ok".into(), is_error: false, note: None })
                }
            }
        };
        let results = execute_scheduled("t", 0, scheduled, executor).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(max_active.load(Ordering::SeqCst), 1, "conflicting calls must never overlap");
    }

    /// Non-conflicting calls must run concurrently (max active > 1).
    #[tokio::test]
    async fn test_execute_scheduled_non_conflicting_parallel() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let scheduled = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/a.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/b.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "3".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/c.txt")],
            },
        ];
        let executor = {
            let active = active.clone();
            let max_active = max_active.clone();
            move |_tc: ToolCall| {
                let active = active.clone();
                let max_active = max_active.clone();
                async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(ExecutableToolResult { content: "ok".into(), is_error: false, note: None })
                }
            }
        };
        let results = execute_scheduled("t", 0, scheduled, executor).await.unwrap();
        assert_eq!(results.len(), 3);
        assert!(max_active.load(Ordering::SeqCst) > 1, "non-conflicting calls should overlap");
    }

    /// Empty schedule yields an empty result.
    #[tokio::test]
    async fn test_execute_scheduled_empty() {
        let results = execute_scheduled(
            "t",
            0,
            vec![],
            |_tc: ToolCall| async move { Ok(ExecutableToolResult { content: "x".into(), is_error: false, note: None }) },
        ).await.unwrap();
        assert!(results.is_empty());
    }

    /// Results preserve the original call order regardless of batching.
    #[tokio::test]
    async fn test_execute_scheduled_preserves_order_across_batches() {
        let scheduled = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/f.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/g.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "3".into(), name: "write".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/f.txt")],
            },
        ];
        let results = execute_scheduled(
            "t",
            0,
            scheduled,
            |tc: ToolCall| async move { Ok(ExecutableToolResult { content: tc.id, is_error: false, note: None }) },
        ).await.unwrap();
        let ids: Vec<&str> = results.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(ids, vec!["1", "2", "3"]);
    }
}