#![allow(dead_code)]

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

use crate::turn_loop::types::{
    tool_accesses_conflict, ExecutableToolResult, ToolAccesses, ToolCall,
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
/// Tools within a batch are conflict-free by construction, so they run in
/// parallel; batches run sequentially. Results are returned in the original
/// call order (batches are flattened back to a single Vec).
pub async fn execute_scheduled<F, Fut>(
    scheduled: Vec<ScheduledToolCall>,
    execute_fn: F,
) -> Result<Vec<ExecutableToolResult>, Box<dyn std::error::Error>>
where
    F: Fn(&ToolCall) -> Fut,
    Fut: Future<Output = Result<ExecutableToolResult, Box<dyn std::error::Error>>>,
{
    let batches = schedule_tool_calls(scheduled);
    let mut all_results = Vec::new();
    for batch in &batches {
        // Run the batch's tools concurrently (they are non-conflicting), then
        // append results in the original call order.
        let results = futures_util::future::join_all(
            batch.iter().map(|s| execute_fn(&s.tool_call)),
        )
        .await;
        for r in results {
            all_results.push(r?);
        }
    }
    Ok(all_results)
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

    #[tokio::test]
    async fn test_execute_scheduled_runs_batch_in_parallel() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        // Two non-conflicting reads → one batch → must run concurrently.
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "read".into(), arguments: serde_json::json!({}) },
                accesses: vec![read_file_access("/a.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "read".into(), arguments: serde_json::json!({}) },
                accesses: vec![read_file_access("/b.txt")],
            },
        ];

        let concurrent = Arc::new(AtomicU32::new(0));
        let max_concurrent = Arc::new(AtomicU32::new(0));
        let cc = concurrent.clone();
        let mc = max_concurrent.clone();

        let result = execute_scheduled(calls, move |_tc: &ToolCall| {
            let cc = cc.clone();
            let mc = mc.clone();
            async move {
                let cur = cc.fetch_add(1, Ordering::SeqCst) + 1;
                mc.fetch_max(cur, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                cc.fetch_sub(1, Ordering::SeqCst);
                Ok(ExecutableToolResult {
                    content: "ok".into(),
                    is_error: false,
                    is_prediction: false,
                })
            }
        })
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 2);
        // Both ran concurrently → peak concurrency reached 2.
        assert_eq!(max_concurrent.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_execute_scheduled_preserves_call_order() {
        // Conflicting writes → separate batches → serial, but results must
        // come back in the original call order.
        let calls = vec![
            ScheduledToolCall {
                tool_call: ToolCall { id: "1".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/f.txt")],
            },
            ScheduledToolCall {
                tool_call: ToolCall { id: "2".into(), name: "w".into(), arguments: serde_json::json!({}) },
                accesses: vec![write_file_access("/f.txt")],
            },
        ];

        let result = execute_scheduled(calls, |tc: &ToolCall| {
            let id = tc.id.clone();
            async move {
                Ok(ExecutableToolResult {
                    content: id,
                    is_error: false,
                    is_prediction: false,
                })
            }
        })
        .await;

        let results = result.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].content, "1");
        assert_eq!(results[1].content, "2");
    }
}