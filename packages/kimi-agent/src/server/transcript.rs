use serde_json::{Value, json};

use crate::turn_loop::types::LLMMessage;

pub mod grade;
pub mod model;
pub mod ops;
pub mod project;

pub const DEFAULT_PAGE_SIZE: usize = 20;

#[derive(Clone)]
struct StepDraft {
    step_id: String,
    ordinal: usize,
    frames: Vec<Value>,
}

#[derive(Clone)]
struct TurnDraft {
    turn_id: String,
    ordinal: usize,
    prompt: Option<String>,
    steps: Vec<StepDraft>,
}

impl TurnDraft {
    fn new(ordinal: usize, prompt: Option<String>) -> Self {
        Self {
            turn_id: format!("t{ordinal}"),
            ordinal,
            prompt,
            steps: Vec::new(),
        }
    }

    fn to_value(&self) -> Value {
        let steps: Vec<Value> = self
            .steps
            .iter()
            .map(|step| {
                json!({
                    "kind": "step",
                    "stepId": step.step_id,
                    "turnId": self.turn_id,
                    "ordinal": step.ordinal,
                    "state": "completed",
                    "frames": step.frames,
                })
            })
            .collect();
        let mut turn = json!({
            "kind": "turn",
            "turnId": self.turn_id,
            "ordinal": self.ordinal,
            "state": "completed",
            "origin": { "kind": "user" },
            "steps": steps,
        });
        if let Some(prompt) = self.prompt.as_ref()
            && !prompt.is_empty()
        {
            turn["prompt"] = json!(prompt);
        }
        turn
    }
}

pub fn build_items(history: &[LLMMessage]) -> Vec<Value> {
    let mut turns: Vec<TurnDraft> = Vec::new();
    let mut next_ordinal = 0usize;

    for message in history {
        match message.role.as_str() {
            "system" => continue,
            "user" => {
                let prompt = if message.content.is_empty() {
                    None
                } else {
                    Some(message.content.clone())
                };
                turns.push(TurnDraft::new(next_ordinal, prompt));
                next_ordinal += 1;
            }
            "assistant" => {
                if turns.is_empty() {
                    turns.push(TurnDraft::new(next_ordinal, None));
                    next_ordinal += 1;
                }
                let turn = turns.last_mut().expect("turn ensured above");
                let step_ordinal = turn.steps.len() + 1;
                let step_id = format!("{}.{}", turn.turn_id, step_ordinal);
                let mut frames: Vec<Value> = Vec::new();
                let mut frame_count = 0usize;
                let mut next_frame_id = || {
                    frame_count += 1;
                    format!("{step_id}.f{frame_count}")
                };
                if !message.content.is_empty() {
                    frames.push(json!({
                        "kind": "text",
                        "frameId": next_frame_id(),
                        "role": "assistant",
                        "text": message.content,
                    }));
                }
                for call in &message.tool_calls {
                    frames.push(json!({
                        "kind": "tool",
                        "frameId": format!("{step_id}.{}", call.id),
                        "toolCallId": call.id,
                        "name": call.name,
                        "state": "running",
                        "input": call.arguments,
                    }));
                }
                turn.steps.push(StepDraft {
                    step_id,
                    ordinal: step_ordinal,
                    frames,
                });
            }
            "tool" => {
                let Some(turn) = turns.last_mut() else {
                    continue;
                };
                let Some(tool_call_id) = message.tool_call_id.as_deref() else {
                    continue;
                };
                patch_tool_frame(turn, tool_call_id, &message.content);
            }
            _ => {}
        }
    }

    turns.iter().map(TurnDraft::to_value).collect()
}

fn patch_tool_frame(turn: &mut TurnDraft, tool_call_id: &str, output: &str) {
    for step in turn.steps.iter_mut().rev() {
        for frame in step.frames.iter_mut().rev() {
            if frame.get("kind").and_then(|v| v.as_str()) == Some("tool")
                && frame.get("toolCallId").and_then(|v| v.as_str()) == Some(tool_call_id)
            {
                frame["state"] = json!("done");
                frame["output"] = json!(output);
                return;
            }
        }
    }
}

fn turn_ordinal(item: &Value) -> Option<i64> {
    item.get("ordinal").and_then(|v| v.as_i64())
}

pub fn paginate_turns(items: &[Value], query: &TurnPageQuery) -> (Vec<Value>, bool) {
    let page_size = query.page_size.max(1);
    let turns: Vec<&Value> = items
        .iter()
        .filter(|item| item.get("kind").and_then(|v| v.as_str()) == Some("turn"))
        .collect();
    if turns.is_empty() {
        return (Vec::new(), false);
    }

    if let Some(after) = query.after_turn.as_deref() {
        let after_ordinal = parse_turn_ordinal(after);
        let selected: Vec<&Value> = turns
            .into_iter()
            .filter(|item| match (turn_ordinal(item), after_ordinal) {
                (Some(value), Some(after)) => value > after,
                _ => false,
            })
            .take(page_size)
            .collect();
        let has_more = selected.len() == page_size;
        return (selected.into_iter().cloned().collect(), has_more);
    }

    if let Some(before) = query.before_turn.as_deref() {
        let before_ordinal = parse_turn_ordinal(before);
        let older: Vec<&Value> = turns
            .into_iter()
            .filter(|item| match (turn_ordinal(item), before_ordinal) {
                (Some(value), Some(before)) => value < before,
                _ => false,
            })
            .collect();
        let start = older.len().saturating_sub(page_size);
        let selected = older[start..].to_vec();
        let has_more = older.len() > selected.len();
        return (selected.into_iter().cloned().collect(), has_more);
    }

    let start = turns.len().saturating_sub(page_size);
    let selected = turns[start..].to_vec();
    let has_more = turns.len() > selected.len();
    (selected.into_iter().cloned().collect(), has_more)
}

fn parse_turn_ordinal(turn_id: &str) -> Option<i64> {
    turn_id
        .strip_prefix('t')
        .and_then(|rest| rest.parse::<i64>().ok())
}

pub fn project_user_messages(items: &[Value]) -> Vec<Value> {
    let mut messages = Vec::new();
    for item in items {
        if item.get("kind").and_then(|v| v.as_str()) != Some("turn") {
            continue;
        }
        let prompt = item.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
        if prompt.is_empty() {
            continue;
        }
        messages.push(json!({
            "turn_id": item.get("turnId").cloned().unwrap_or(Value::Null),
            "ordinal": item.get("ordinal").cloned().unwrap_or(json!(0)),
            "state": item.get("state").cloned().unwrap_or(json!("completed")),
            "origin": item.get("origin").cloned().unwrap_or(json!({ "kind": "user" })),
            "prompt": prompt,
        }));
    }
    messages
}

const PLAN_SAVED_TO_MARKER: &str = "Plan saved to: ";
const PLAN_BODY_MARKERS: [&str; 2] = [
    "## Approved Plan:\n",
    "## Plan (auto-approved, not user-reviewed):\n",
];

pub fn project_plans(items: &[Value], tool_call_id: Option<&str>) -> Vec<Value> {
    let mut plans = Vec::new();
    for item in items {
        if item.get("kind").and_then(|v| v.as_str()) != Some("turn") {
            continue;
        }
        let turn_id = item.get("turnId").and_then(|v| v.as_str()).unwrap_or("");
        let Some(steps) = item.get("steps").and_then(|v| v.as_array()) else {
            continue;
        };
        for step in steps {
            let Some(frames) = step.get("frames").and_then(|v| v.as_array()) else {
                continue;
            };
            for frame in frames {
                if frame.get("kind").and_then(|v| v.as_str()) != Some("tool") {
                    continue;
                }
                if frame.get("name").and_then(|v| v.as_str()) != Some("ExitPlanMode") {
                    continue;
                }
                let frame_call_id = frame
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Some(only) = tool_call_id
                    && frame_call_id != only
                {
                    continue;
                }
                let output = frame.get("output").and_then(|v| v.as_str());
                if let Some((plan, path)) = parse_plan_from_output(output) {
                    let mut entry = json!({
                        "tool_call_id": frame_call_id,
                        "turn_id": turn_id,
                        "source": "output",
                        "plan": plan,
                    });
                    if let Some(path) = path {
                        entry["path"] = json!(path);
                    }
                    plans.push(entry);
                }
            }
        }
    }
    plans
}

fn parse_plan_from_output(output: Option<&str>) -> Option<(String, Option<String>)> {
    let output = output?;
    let mut path: Option<String> = None;
    for line in output.split('\n') {
        if let Some(rest) = line.strip_prefix(PLAN_SAVED_TO_MARKER) {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                path = Some(trimmed.to_string());
            }
            break;
        }
    }
    for marker in PLAN_BODY_MARKERS {
        if let Some(index) = output.find(marker) {
            let plan = &output[index + marker.len()..];
            if !plan.trim().is_empty() {
                return Some((plan.to_string(), path));
            }
        }
    }
    None
}

pub struct TurnPageQuery {
    pub before_turn: Option<String>,
    pub after_turn: Option<String>,
    pub page_size: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_loop::types::ToolCall;

    fn user(text: &str) -> LLMMessage {
        LLMMessage::new("user", text)
    }

    fn assistant(text: &str, calls: Vec<ToolCall>) -> LLMMessage {
        let mut message = LLMMessage::new("assistant", text);
        message.tool_calls = calls;
        message
    }

    fn tool(call_id: &str, output: &str) -> LLMMessage {
        let mut message = LLMMessage::new("tool", output);
        message.tool_call_id = Some(call_id.to_string());
        message
    }

    fn call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: json!({ "path": "a.txt" }),
            extras: None,
        }
    }

    #[test]
    fn groups_history_into_turns_steps_and_frames() {
        let history = vec![
            user("hello"),
            assistant("hi", vec![call("c1", "Read")]),
            tool("c1", "file contents"),
        ];
        let items = build_items(&history);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "turn");
        assert_eq!(items[0]["turnId"], "t0");
        assert_eq!(items[0]["prompt"], "hello");
        let steps = items[0]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1);
        let frames = steps[0]["frames"].as_array().unwrap();
        assert_eq!(frames[0]["kind"], "text");
        assert_eq!(frames[0]["text"], "hi");
        assert_eq!(frames[1]["kind"], "tool");
        assert_eq!(frames[1]["state"], "done");
        assert_eq!(frames[1]["output"], "file contents");
    }

    #[test]
    fn multiple_turns_keep_ordinals_and_paginate() {
        let mut history = Vec::new();
        for index in 0..5 {
            history.push(user(&format!("q{index}")));
            history.push(assistant(&format!("a{index}"), Vec::new()));
        }
        let items = build_items(&history);
        assert_eq!(items.len(), 5);

        let (page, has_more) = paginate_turns(
            &items,
            &TurnPageQuery {
                before_turn: None,
                after_turn: None,
                page_size: 2,
            },
        );
        assert!(has_more);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["turnId"], "t3");
        assert_eq!(page[1]["turnId"], "t4");

        let (older, older_more) = paginate_turns(
            &items,
            &TurnPageQuery {
                before_turn: Some("t3".to_string()),
                after_turn: None,
                page_size: 10,
            },
        );
        assert!(!older_more);
        assert_eq!(older.len(), 3);
        assert_eq!(older[0]["turnId"], "t0");
    }

    #[test]
    fn projects_user_messages_and_plans() {
        let plan_output = "Done\nPlan saved to: /tmp/plan.md\n## Approved Plan:\ndo the thing";
        let history = vec![
            user("start"),
            assistant("", vec![call("c1", "ExitPlanMode")]),
            tool("c1", plan_output),
        ];
        let items = build_items(&history);
        let messages = project_user_messages(&items);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["prompt"], "start");

        let plans = project_plans(&items, Some("c1"));
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0]["path"], "/tmp/plan.md");
        assert!(plans[0]["plan"].as_str().unwrap().contains("do the thing"));

        assert!(project_plans(&items, Some("missing")).is_empty());
    }
}
