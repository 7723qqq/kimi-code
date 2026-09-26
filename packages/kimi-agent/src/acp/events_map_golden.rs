//! Differential acceptance for the ACP session/update mappers.
//!
//! Every expectation here was produced by **running v2's real
//! `acp-server/src/events-map.ts` under bun**, not by reading it. The generator
//! is `scripts/gen-acp-golden.mjs`; its output is `test/acp-golden.json`. When
//! v2 changes, re-run the generator and this suite reports the real divergence
//! instead of a plausible-looking guess.
//!
//! This exists because code review cannot answer "is the port equivalent" —
//! only running both and diffing the bytes can.

use serde_json::{Value, json};

use crate::acp::events_map::{
    acp_tool_call_id, available_commands_update, infer_tool_kind, plan_from_display,
    session_info_update, todo_list_to_session_update, usage_update,
};
use crate::tool_input_display::TodoListItem;

fn golden() -> Value {
    let raw = include_str!("../../test/acp-golden.json");
    serde_json::from_str(raw).expect("golden file is valid JSON")
}

/// The golden file stores v2's `undefined` return as JSON `null`, and every
/// non-null builder result as the object itself. The Rust side returns
/// `Option<Value>`, so a golden `null` means `None` and anything else means
/// `Some(..)`. Comparing the raw JSON instead would let `None` silently pass as
/// `Value::Null` — precisely the distinction these cases exist to pin.
fn assert_golden(key: &str, actual: Option<Value>) {
    let expected = golden();
    let raw = expected
        .get(key)
        .unwrap_or_else(|| panic!("golden has no case `{key}`"));
    let want: Option<Value> = if raw.is_null() {
        None
    } else {
        Some(raw.clone())
    };
    assert_eq!(actual, want, "case `{key}` diverges from v2");
}

fn todo(items: &[(&str, &str)]) -> Vec<TodoListItem> {
    items
        .iter()
        .map(|(title, status)| TodoListItem {
            title: (*title).to_string(),
            status: (*status).to_string(),
        })
        .collect()
}

#[test]
fn usage_update_matches_v2() {
    assert_golden("usage_basic", Some(usage_update("s1", 1234, 262144)));
    assert_golden("usage_zero_used", Some(usage_update("s1", 0, 128000)));
    assert_golden("usage_zero_both", Some(usage_update("s1", 0, 0)));
}

#[test]
fn session_info_update_matches_v2() {
    assert_golden(
        "session_info_title",
        Some(session_info_update("s1", Some("My title"))),
    );
    assert_golden(
        "session_info_empty",
        Some(session_info_update("s1", Some(""))),
    );
    assert_golden("session_info_null", Some(session_info_update("s1", None)));
}

#[test]
fn available_commands_update_matches_v2() {
    assert_golden(
        "available_empty",
        Some(available_commands_update("s1", &[])),
    );
    assert_golden(
        "available_one",
        Some(available_commands_update(
            "s1",
            &[json!({ "name": "help", "description": "Show available ACP commands" })],
        )),
    );
    assert_golden(
        "available_with_input",
        Some(available_commands_update(
            "s1",
            &[json!({
                "name": "compact",
                "description": "Compact the conversation context",
                "input": { "hint": "<optional>" },
            })],
        )),
    );
}

#[test]
fn todo_list_to_plan_matches_v2() {
    assert_golden("plan_empty", todo_list_to_session_update("s1", &todo(&[])));
    for (key, items) in [
        ("plan_one", &[("first", "pending")][..]),
        ("plan_status_done", &[("a", "done")][..]),
        ("plan_status_completed", &[("b", "completed")][..]),
        ("plan_status_in_progress", &[("c", "in_progress")][..]),
        ("plan_status_pending", &[("d", "pending")][..]),
        ("plan_status_unknown", &[("e", "weird")][..]),
        ("plan_status_empty", &[("f", "")][..]),
        ("plan_empty_title", &[("", "pending")][..]),
        (
            "plan_multi",
            &[
                ("one", "done"),
                ("two", "in_progress"),
                ("three", "nonsense"),
            ][..],
        ),
    ] {
        assert_golden(key, todo_list_to_session_update("s1", &todo(items)));
    }
}

#[test]
fn plan_from_display_gating_matches_v2() {
    use crate::tool_input_display::ToolInputDisplay as D;
    assert_golden(
        "plan_from_block_todo",
        plan_from_display(
            "s1",
            &D::TodoList {
                items: todo(&[("x", "done")]),
            },
        ),
    );
    assert_golden(
        "plan_from_block_diff",
        plan_from_display(
            "s1",
            &D::Diff {
                path: "/a".into(),
                before: "x".into(),
                after: "y".into(),
                hunks: None,
            },
        ),
    );
    assert_golden(
        "plan_from_block_generic",
        plan_from_display(
            "s1",
            &D::Generic {
                summary: "s".into(),
                detail: None,
            },
        ),
    );
}

#[test]
fn tool_kind_and_call_id_match_v2() {
    for (name, key) in [
        ("Read", "toolkind_read"),
        ("Bash", "toolkind_bash"),
        ("NoSuchTool", "toolkind_unknown"),
    ] {
        let want = golden()
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("golden `{key}` is not a string"))
            .to_string();
        assert_eq!(infer_tool_kind(name), want, "tool kind for {name}");
    }
    assert!(
        acp_tool_call_id("turn-1", "call-1").ends_with(":call-1"),
        "the namespacing separator must survive"
    );
}

/// The `ToolInputDisplay` union must serialize to the same wire shape v2's
/// union produces, variant by variant — the `kind` tag is what hosts switch on.
#[test]
fn tool_input_display_wire_shape_matches_v2_variants() {
    use crate::tool_input_display::{PlanReviewOption, ToolInputDisplay as D};

    let cases: Vec<(D, &str)> = vec![
        (
            D::Command {
                command: "ls".into(),
                cwd: Some("/w".into()),
                description: None,
                language: Some("bash".into()),
            },
            "command",
        ),
        (
            D::FileIo {
                operation: "read".into(),
                path: "a".into(),
                detail: None,
                content: None,
                before: None,
                after: None,
            },
            "file_io",
        ),
        (
            D::Diff {
                path: "a".into(),
                before: "x".into(),
                after: "y".into(),
                hunks: Some(2),
            },
            "diff",
        ),
        (
            D::Search {
                query: "q".into(),
                scope: None,
            },
            "search",
        ),
        (
            D::UrlFetch {
                url: "https://e.test".into(),
                method: None,
            },
            "url_fetch",
        ),
        (
            D::AgentCall {
                agent_name: "a".into(),
                prompt: "p".into(),
                background: Some(false),
            },
            "agent_call",
        ),
        (
            D::SkillCall {
                skill_name: "s".into(),
                args: None,
            },
            "skill_call",
        ),
        (
            D::TodoList {
                items: todo(&[("t", "done")]),
            },
            "todo_list",
        ),
        (
            D::Task {
                task_id: "t1".into(),
                status: "running".into(),
                description: "d".into(),
                task_kind: None,
            },
            "task",
        ),
        (
            D::TaskStop {
                task_id: "t1".into(),
                task_description: "d".into(),
            },
            "task_stop",
        ),
        (
            D::PlanReview {
                plan: "p".into(),
                path: Some("/plan.md".into()),
                options: Some(vec![PlanReviewOption {
                    label: "l".into(),
                    description: "d".into(),
                }]),
            },
            "plan_review",
        ),
        (
            D::GoalStart {
                objective: "o".into(),
                completion_criterion: Some("c".into()),
                mode: "manual".into(),
            },
            "goal_start",
        ),
        (
            D::Generic {
                summary: "s".into(),
                detail: None,
            },
            "generic",
        ),
    ];
    assert_eq!(
        cases.len(),
        13,
        "v2's union has 12 variants, plus this guard"
    );
    for (value, kind) in cases {
        let wire = serde_json::to_value(&value).expect("serializes");
        assert_eq!(wire["kind"], kind, "variant tag for {kind}");
        assert_eq!(value.kind(), kind, "kind() agrees with the wire tag");
        let back: D = serde_json::from_value(wire).expect("round-trips");
        assert_eq!(back, value, "{kind} round-trips losslessly");
    }
}
