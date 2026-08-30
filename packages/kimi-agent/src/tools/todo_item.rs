//! Pure todo-list rendering logic, ported from the v2 todo feature
//! (`agent-core-v2/src/features/todo/todoItem.ts`). Output is
//! character-for-character aligned with v2 `renderTodoList`, including the
//! empty-list message, milestone aggregation, progress suffixes, and id
//! assignment.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

/// Todo item status, mirroring v2 `TodoStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
}

impl TodoStatus {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "done" => Some(Self::Done),
            _ => None,
        }
    }

    fn marker(self) -> &'static str {
        match self {
            Self::Pending => "[pending]",
            Self::InProgress => "[in_progress]",
            Self::Done => "[done]",
        }
    }
}

/// Todo item kind, mirroring v2 `TodoKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoKind {
    Milestone,
    Task,
}

/// A single todo item, mirroring the v2 `TodoItem` wire shape (camelCase
/// fields on the wire).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: TodoKind,
    pub title: String,
    pub status: TodoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Progress report, mirroring v2 `TodoProgressReport`.
pub struct TodoProgressReport {
    pub overall: u32,
    pub done: usize,
    pub total: usize,
    pub by_id: HashMap<String, u32>,
}

/// Normalize raw wire values into todo items, mirroring v2 `readTodoItems`:
/// non-array input yields an empty list, invalid entries are skipped,
/// progress is clamped to 0-100 and rounded, and missing ids are assigned
/// (`T1`/`T2`… at root, `<parentId>.1`… under a parent, skipping ids already
/// in use).
pub fn read_todo_items(raw: &Value) -> Vec<TodoItem> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    let mut items = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let Some(title) = obj.get("title").and_then(|v| v.as_str()) else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        let Some(status) = obj
            .get("status")
            .and_then(|v| v.as_str())
            .and_then(TodoStatus::from_str)
        else {
            continue;
        };
        let progress = obj
            .get("progress")
            .and_then(|v| v.as_f64())
            .filter(|f| f.is_finite())
            .map(|f| f.round().clamp(0.0, 100.0) as u32);
        items.push(TodoItem {
            id: obj
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("")
                .to_string(),
            parent_id: obj
                .get("parentId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            kind: if obj.get("kind").and_then(|v| v.as_str()) == Some("milestone") {
                TodoKind::Milestone
            } else {
                TodoKind::Task
            },
            title: title.to_string(),
            status,
            progress,
            description: obj
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    assign_missing_ids(items)
}

/// Compute the progress report, mirroring v2 `computeTodoProgress`:
/// milestone progress is the mean of its children (or its own leaf progress
/// when childless), the overall figure is the mean of the milestone values
/// (or of all leaf values when no milestone exists), and a milestone counts
/// as done at 100%.
pub fn compute_todo_progress(todos: &[TodoItem]) -> TodoProgressReport {
    if todos.is_empty() {
        return TodoProgressReport {
            overall: 0,
            done: 0,
            total: 0,
            by_id: HashMap::new(),
        };
    }
    let mut children_of: HashMap<&str, Vec<&TodoItem>> = HashMap::new();
    for todo in todos {
        if let Some(parent) = todo.parent_id.as_deref() {
            children_of.entry(parent).or_default().push(todo);
        }
    }
    let mut by_id: HashMap<String, u32> = HashMap::new();
    for todo in todos {
        if todo.kind != TodoKind::Milestone {
            by_id.insert(todo.id.clone(), leaf_progress(todo));
        }
    }
    let milestones: Vec<&TodoItem> = todos
        .iter()
        .filter(|todo| todo.kind == TodoKind::Milestone)
        .collect();
    if milestones.is_empty() {
        let values: Vec<u32> = todos
            .iter()
            .map(|todo| by_id.get(&todo.id).copied().unwrap_or(0))
            .collect();
        return TodoProgressReport {
            overall: mean(&values),
            done: todos
                .iter()
                .filter(|todo| todo.status == TodoStatus::Done)
                .count(),
            total: todos.len(),
            by_id,
        };
    }
    let mut milestone_values = Vec::with_capacity(milestones.len());
    for milestone in &milestones {
        let children = children_of
            .get(milestone.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let value = if children.is_empty() {
            leaf_progress(milestone)
        } else {
            mean(
                &children
                    .iter()
                    .map(|child| by_id.get(&child.id).copied().unwrap_or(0))
                    .collect::<Vec<_>>(),
            )
        };
        by_id.insert(milestone.id.clone(), value);
        milestone_values.push(value);
    }
    let done = todos
        .iter()
        .filter(|todo| {
            if todo.kind == TodoKind::Milestone {
                by_id.get(&todo.id).copied().unwrap_or(0) >= 100
            } else {
                todo.status == TodoStatus::Done
            }
        })
        .count();
    TodoProgressReport {
        overall: mean(&milestone_values),
        done,
        total: todos.len(),
        by_id,
    }
}

/// Render the todo list tree, mirroring v2 `renderTodoList` with the default
/// title. The empty list renders as `Todo list is empty.`.
pub fn render_todo_list(todos: &[TodoItem]) -> String {
    render_todo_list_with_title(todos, "Current todo list:")
}

/// Render the todo list tree with an explicit title line (v2
/// `renderTodoList(todos, title)`).
pub fn render_todo_list_with_title(todos: &[TodoItem], title: &str) -> String {
    if todos.is_empty() {
        return "Todo list is empty.".into();
    }
    let report = compute_todo_progress(todos);
    let known: HashSet<&str> = todos.iter().map(|todo| todo.id.as_str()).collect();
    let mut children_of: HashMap<&str, Vec<&TodoItem>> = HashMap::new();
    for todo in todos {
        if let Some(parent) = todo.parent_id.as_deref()
            && known.contains(parent)
        {
            children_of.entry(parent).or_default().push(todo);
        }
    }
    let mut lines = vec![format!(
        "{title} (overall {}/{} · {}%)",
        report.done, report.total, report.overall
    )];
    let roots: Vec<&TodoItem> = todos
        .iter()
        .filter(|todo| {
            todo.parent_id
                .as_deref()
                .is_none_or(|parent| !known.contains(parent))
        })
        .collect();
    for root in roots {
        render_tree_line(root, &children_of, &report.by_id, 0, &mut lines);
    }
    lines.join("\n")
}

fn render_tree_line(
    item: &TodoItem,
    children_of: &HashMap<&str, Vec<&TodoItem>>,
    by_id: &HashMap<String, u32>,
    depth: usize,
    lines: &mut Vec<String>,
) {
    let indent = "  ".repeat(depth + 1);
    let progress = by_id.get(&item.id).copied().unwrap_or(0);
    let status = effective_status(item, progress);
    let suffix = progress_suffix(item, children_of, progress);
    lines.push(format!(
        "{indent}{} {}: {}{suffix}",
        status.marker(),
        item.id,
        item.title
    ));
    if let Some(children) = children_of.get(item.id.as_str()) {
        for child in children {
            render_tree_line(child, children_of, by_id, depth + 1, lines);
        }
    }
}

fn effective_status(item: &TodoItem, progress: u32) -> TodoStatus {
    if item.kind != TodoKind::Milestone {
        return item.status;
    }
    if progress >= 100 {
        TodoStatus::Done
    } else if progress > 0 {
        TodoStatus::InProgress
    } else {
        TodoStatus::Pending
    }
}

fn progress_suffix(
    item: &TodoItem,
    children_of: &HashMap<&str, Vec<&TodoItem>>,
    progress: u32,
) -> String {
    if item.kind == TodoKind::Milestone {
        let children = children_of
            .get(item.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let done = children
            .iter()
            .filter(|child| child.status == TodoStatus::Done)
            .count();
        return format!(" ({done}/{} · {progress}%)", children.len());
    }
    if item.status == TodoStatus::Done {
        return String::new();
    }
    if progress > 0 {
        return format!(" ({progress}%)");
    }
    String::new()
}

fn leaf_progress(todo: &TodoItem) -> u32 {
    match todo.status {
        TodoStatus::Done => 100,
        TodoStatus::InProgress => todo.progress.unwrap_or(0),
        TodoStatus::Pending => 0,
    }
}

fn mean(values: &[u32]) -> u32 {
    if values.is_empty() {
        return 0;
    }
    let sum: u32 = values.iter().sum();
    ((sum as f64) / (values.len() as f64)).round() as u32
}

fn assign_missing_ids(items: Vec<TodoItem>) -> Vec<TodoItem> {
    let mut used: HashSet<String> = items
        .iter()
        .filter(|item| !item.id.is_empty())
        .map(|item| item.id.clone())
        .collect();
    items
        .into_iter()
        .map(|mut item| {
            if !item.id.is_empty() {
                return item;
            }
            item.id = match &item.parent_id {
                Some(parent) => smallest_free(&mut used, |n| format!("{parent}.{n}")),
                None => smallest_free(&mut used, |n| format!("T{n}")),
            };
            item
        })
        .collect()
}

fn smallest_free(used: &mut HashSet<String>, format: impl Fn(u32) -> String) -> String {
    let mut n = 1u32;
    while used.contains(&format(n)) {
        n += 1;
    }
    let id = format(n);
    used.insert(id.clone());
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(
        id: &str,
        parent: Option<&str>,
        kind: TodoKind,
        title: &str,
        status: TodoStatus,
    ) -> TodoItem {
        TodoItem {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            kind,
            title: title.into(),
            status,
            progress: None,
            description: None,
        }
    }

    fn task(id: &str, title: &str, status: TodoStatus) -> TodoItem {
        item(id, None, TodoKind::Task, title, status)
    }

    #[test]
    fn test_read_todo_items_non_array_yields_empty() {
        assert!(read_todo_items(&Value::Null).is_empty());
        assert!(read_todo_items(&serde_json::json!({ "todo": [] })).is_empty());
        assert!(read_todo_items(&serde_json::json!("nope")).is_empty());
    }

    #[test]
    fn test_read_todo_items_skips_invalid_entries() {
        let raw = serde_json::json!([
            { "title": "", "status": "pending" },
            { "title": "No status" },
            { "title": "Bad status", "status": "weird" },
            "not an object",
            42,
            { "title": "Valid", "status": "done" }
        ]);
        let items = read_todo_items(&raw);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Valid");
        assert_eq!(items[0].status, TodoStatus::Done);
        assert_eq!(items[0].id, "T1");
    }

    #[test]
    fn test_read_todo_items_clamps_and_rounds_progress() {
        let raw = serde_json::json!([
            { "title": "Over 100", "status": "in_progress", "progress": 150 },
            { "title": "Negative", "status": "in_progress", "progress": -20 },
            { "title": "Fractional", "status": "in_progress", "progress": 33.6 },
            { "title": "String progress", "status": "in_progress", "progress": "40" }
        ]);
        let items = read_todo_items(&raw);
        assert_eq!(items[0].progress, Some(100));
        assert_eq!(items[1].progress, Some(0));
        assert_eq!(items[2].progress, Some(34));
        assert_eq!(items[3].progress, None);
    }

    #[test]
    fn test_read_todo_items_assigns_root_ids_skipping_used() {
        let raw = serde_json::json!([
            { "title": "First", "status": "pending" },
            { "title": "Second", "status": "pending" },
            { "id": "T1", "title": "Takes T1", "status": "pending" },
            { "title": "Fourth", "status": "pending" }
        ]);
        let items = read_todo_items(&raw);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["T2", "T3", "T1", "T4"]);
    }

    #[test]
    fn test_read_todo_items_assigns_child_ids_skipping_used() {
        let raw = serde_json::json!([
            { "id": "M1", "parentId": null, "kind": "milestone", "title": "M", "status": "pending" },
            { "parentId": "M1", "title": "Child one", "status": "pending" },
            { "parentId": "M1", "title": "Child two", "status": "pending" },
            { "id": "M1.1", "parentId": "M1", "title": "Takes M1.1", "status": "pending" }
        ]);
        let items = read_todo_items(&raw);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["M1", "M1.2", "M1.3", "M1.1"]);
    }

    #[test]
    fn test_read_todo_items_mixed_existing_and_missing_ids() {
        let raw = serde_json::json!([
            { "id": "T5", "title": "Has T5", "status": "pending" },
            { "title": "Gets T1", "status": "pending" },
            { "id": "T1", "title": "Has T1", "status": "pending" },
            { "title": "Gets T2", "status": "pending" }
        ]);
        let items = read_todo_items(&raw);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["T5", "T2", "T1", "T3"]);
    }

    #[test]
    fn test_read_todo_items_keeps_extra_fields() {
        let raw = serde_json::json!([
            {
                "id": "T1",
                "parentId": "M1",
                "kind": "milestone",
                "title": "Phase",
                "status": "in_progress",
                "progress": 42,
                "description": "desc"
            }
        ]);
        let items = read_todo_items(&raw);
        assert_eq!(items[0].id, "T1");
        assert_eq!(items[0].parent_id.as_deref(), Some("M1"));
        assert_eq!(items[0].kind, TodoKind::Milestone);
        assert_eq!(items[0].status, TodoStatus::InProgress);
        assert_eq!(items[0].progress, Some(42));
        assert_eq!(items[0].description.as_deref(), Some("desc"));
    }

    #[test]
    fn test_compute_progress_empty() {
        let report = compute_todo_progress(&[]);
        assert_eq!(report.overall, 0);
        assert_eq!(report.done, 0);
        assert_eq!(report.total, 0);
        assert!(report.by_id.is_empty());
    }

    #[test]
    fn test_compute_progress_flat() {
        let todos = vec![
            task("T1", "Read", TodoStatus::InProgress),
            task("T2", "Add", TodoStatus::Pending),
            task("T3", "Write", TodoStatus::Done),
        ];
        let mut todos = todos;
        todos[0].progress = Some(40);
        let report = compute_todo_progress(&todos);
        assert_eq!(report.overall, 47);
        assert_eq!(report.done, 1);
        assert_eq!(report.total, 3);
        assert_eq!(report.by_id.get("T1"), Some(&40));
        assert_eq!(report.by_id.get("T2"), Some(&0));
        assert_eq!(report.by_id.get("T3"), Some(&100));
    }

    #[test]
    fn test_compute_progress_milestones_aggregate_children() {
        let todos = vec![
            item(
                "M1",
                None,
                TodoKind::Milestone,
                "Phase 1",
                TodoStatus::Pending,
            ),
            item(
                "T1",
                Some("M1"),
                TodoKind::Task,
                "Read",
                TodoStatus::InProgress,
            ),
            item("T2", Some("M1"), TodoKind::Task, "Write", TodoStatus::Done),
            item(
                "M2",
                None,
                TodoKind::Milestone,
                "Phase 2",
                TodoStatus::Pending,
            ),
            item(
                "T3",
                Some("M2"),
                TodoKind::Task,
                "Design",
                TodoStatus::Pending,
            ),
        ];
        let mut todos = todos;
        todos[1].progress = Some(40);
        let report = compute_todo_progress(&todos);
        assert_eq!(report.overall, 35);
        assert_eq!(report.done, 1);
        assert_eq!(report.total, 5);
        assert_eq!(report.by_id.get("M1"), Some(&70));
        assert_eq!(report.by_id.get("M2"), Some(&0));
    }

    #[test]
    fn test_compute_progress_done_milestone_counts_done() {
        let todos = vec![
            item(
                "M1",
                None,
                TodoKind::Milestone,
                "Phase 1",
                TodoStatus::Pending,
            ),
            item("T1", Some("M1"), TodoKind::Task, "A", TodoStatus::Done),
            item("T2", Some("M1"), TodoKind::Task, "B", TodoStatus::Done),
        ];
        let report = compute_todo_progress(&todos);
        assert_eq!(report.overall, 100);
        assert_eq!(report.done, 3);
        assert_eq!(report.total, 3);
        assert_eq!(report.by_id.get("M1"), Some(&100));
    }

    #[test]
    fn test_render_empty_list() {
        assert_eq!(render_todo_list(&[]), "Todo list is empty.");
    }

    #[test]
    fn test_render_flat_list_golden() {
        let todos = vec![
            task("T1", "Read session-control.ts", TodoStatus::InProgress),
            task(
                "T2",
                "Add planMode flag to TurnManager",
                TodoStatus::Pending,
            ),
            task("T3", "Write tests", TodoStatus::Done),
        ];
        let mut todos = todos;
        todos[0].progress = Some(40);
        assert_eq!(
            render_todo_list(&todos),
            "Current todo list: (overall 1/3 · 47%)\n  [in_progress] T1: Read session-control.ts (40%)\n  [pending] T2: Add planMode flag to TurnManager\n  [done] T3: Write tests"
        );
    }

    #[test]
    fn test_render_milestones_golden() {
        let todos = vec![
            item(
                "M1",
                None,
                TodoKind::Milestone,
                "Phase 1",
                TodoStatus::Pending,
            ),
            item(
                "T1",
                Some("M1"),
                TodoKind::Task,
                "Read session-control.ts",
                TodoStatus::InProgress,
            ),
            item(
                "T2",
                Some("M1"),
                TodoKind::Task,
                "Write tests",
                TodoStatus::Done,
            ),
            item(
                "M2",
                None,
                TodoKind::Milestone,
                "Phase 2",
                TodoStatus::Pending,
            ),
            item(
                "T3",
                Some("M2"),
                TodoKind::Task,
                "Design API",
                TodoStatus::Pending,
            ),
        ];
        let mut todos = todos;
        todos[1].progress = Some(40);
        assert_eq!(
            render_todo_list(&todos),
            "Current todo list: (overall 1/5 · 35%)\n  [in_progress] M1: Phase 1 (1/2 · 70%)\n    [in_progress] T1: Read session-control.ts (40%)\n    [done] T2: Write tests\n  [pending] M2: Phase 2 (0/1 · 0%)\n    [pending] T3: Design API"
        );
    }

    #[test]
    fn test_render_orphan_parent_renders_as_root_golden() {
        let todos = vec![
            item(
                "T1",
                Some("GONE"),
                TodoKind::Task,
                "Orphan task",
                TodoStatus::InProgress,
            ),
            item(
                "M1",
                None,
                TodoKind::Milestone,
                "Milestone",
                TodoStatus::Pending,
            ),
        ];
        let mut todos = todos;
        todos[0].progress = Some(25);
        assert_eq!(
            render_todo_list(&todos),
            "Current todo list: (overall 0/2 · 0%)\n  [in_progress] T1: Orphan task (25%)\n  [pending] M1: Milestone (0/0 · 0%)"
        );
    }

    #[test]
    fn test_render_nested_children_golden() {
        let todos = vec![
            item(
                "M1",
                None,
                TodoKind::Milestone,
                "Phase 1",
                TodoStatus::Pending,
            ),
            item(
                "T1",
                Some("M1"),
                TodoKind::Task,
                "Investigate",
                TodoStatus::Done,
            ),
            item(
                "T2",
                Some("M1"),
                TodoKind::Task,
                "Implement",
                TodoStatus::InProgress,
            ),
            item(
                "T3",
                Some("T2"),
                TodoKind::Task,
                "Sub-step",
                TodoStatus::Pending,
            ),
        ];
        let mut todos = todos;
        todos[2].progress = Some(50);
        assert_eq!(
            render_todo_list(&todos),
            "Current todo list: (overall 1/4 · 75%)\n  [in_progress] M1: Phase 1 (1/2 · 75%)\n    [done] T1: Investigate\n    [in_progress] T2: Implement (50%)\n      [pending] T3: Sub-step"
        );
    }

    #[test]
    fn test_render_progress_clamped_golden() {
        let todos = vec![
            task("T1", "Over 100", TodoStatus::InProgress),
            task("T2", "Negative", TodoStatus::InProgress),
            task("T3", "Fractional", TodoStatus::InProgress),
        ];
        let mut todos = todos;
        todos[0].progress = Some(100);
        todos[1].progress = Some(0);
        todos[2].progress = Some(34);
        assert_eq!(
            render_todo_list(&todos),
            "Current todo list: (overall 0/3 · 45%)\n  [in_progress] T1: Over 100 (100%)\n  [in_progress] T2: Negative\n  [in_progress] T3: Fractional (34%)"
        );
    }

    #[test]
    fn test_render_done_milestone_golden() {
        let todos = vec![
            item(
                "M1",
                None,
                TodoKind::Milestone,
                "Phase 1",
                TodoStatus::Pending,
            ),
            item("T1", Some("M1"), TodoKind::Task, "A", TodoStatus::Done),
            item("T2", Some("M1"), TodoKind::Task, "B", TodoStatus::Done),
        ];
        assert_eq!(
            render_todo_list(&todos),
            "Current todo list: (overall 3/3 · 100%)\n  [done] M1: Phase 1 (2/2 · 100%)\n    [done] T1: A\n    [done] T2: B"
        );
    }

    #[test]
    fn test_render_custom_title() {
        let todos = vec![task("T1", "A", TodoStatus::Pending)];
        assert_eq!(
            render_todo_list_with_title(&todos, "## TODO List"),
            "## TODO List (overall 0/1 · 0%)\n  [pending] T1: A"
        );
    }

    #[test]
    fn test_todo_item_serializes_camel_case_wire_shape() {
        let todo = TodoItem {
            id: "T1".into(),
            parent_id: Some("M1".into()),
            kind: TodoKind::Task,
            title: "Read".into(),
            status: TodoStatus::InProgress,
            progress: Some(40),
            description: None,
        };
        let value = serde_json::to_value(&todo).unwrap();
        assert_eq!(value["id"], "T1");
        assert_eq!(value["parentId"], "M1");
        assert_eq!(value["kind"], "task");
        assert_eq!(value["status"], "in_progress");
        assert_eq!(value["progress"], 40);
        assert!(value.get("description").is_none());
    }
}
