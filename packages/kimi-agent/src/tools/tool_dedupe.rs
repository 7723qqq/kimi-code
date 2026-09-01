//! Tool-call dedup guard — native mirror of v2 `toolDedupeService` (G-6 #2).
//!
//! Two responsibilities, both driven from `run_turn`'s step flow:
//! - **same-step dedup**: a call whose key (tool name + canonical args) was
//!   already issued in the same step never executes — it shares the
//!   original's result, which the caller copies over after the step.
//! - **cross-step repeat protection**: consecutive identical calls across
//!   steps accumulate a streak; at 3 / 5 / 8 repeats escalating reminders
//!   are appended to the original's result, and at 12 the turn is
//!   force-stopped (v2 `stopTurn` → the turn ends as `completed`).
//!
//! State is per-turn: v2 resets its consecutive streak whenever the turn id
//! changes (`beginStep`), and the engine runs one turn per `run_turn` call,
//! so the guard is constructed locally and never persists across turns.
//!
//! Known boundary (recorded in the ROADMAP): v2's dedup telemetry
//! (`tool_call_repeat` / `tool_call_dedup_detected` / `tool_call_turn_repeat`)
//! is not emitted here — the `host/telemetry` seam is deliberately not
//! activated in the product yet (double reporting until the M1d ownership
//! flip), and its wire schema only carries the three turn-lifecycle events.

use crate::turn_loop::types::{ExecutableToolResult, ToolCall};

const REPEAT_REMINDER_1_START: u32 = 3;
const REPEAT_REMINDER_2_START: u32 = 5;
const REPEAT_REMINDER_3_START: u32 = 8;
const REPEAT_FORCE_STOP_STREAK: u32 = 12;

const REMINDER_TEXT_1: &str = "\n\n<system-reminder>\n\
The same tool call has been repeated several times in a row. \
Before making your next call, write one sentence stating what new information you expect it to produce. \
Then act on that sentence: if it names something this result does not already give you, \
choose the action that best provides it; otherwise, continue with the evidence you already have.\
\n</system-reminder>";

const REMINDER_TEXT_3: &str = "\n\n<system-reminder>\n\
Write your final response now, without any further tool calls. \
Cover: the current blocker, each approach you have tried and what it established, \
and the specific information or decision you need from the user to unblock progress. \
Text only.\
\n</system-reminder>";

fn reminder_text_2(repeat_count: u32) -> String {
    format!(
        "\n\n<system-reminder>\n\
The same tool call has now been issued {repeat_count} times in a row. \
Choose exactly one of the following and state your choice before acting:\n\
(1) Falsification check: run the cheapest test that could conclusively disprove your current approach, if such a test exists.\n\
(2) Missing input: tell the user precisely what information or decision you need to proceed, and ask for it.\n\
(3) Conclude: deliver your best result based on the evidence already gathered, listing anything that remains uncertain.\
\n</system-reminder>"
    )
}

/// Canonical serialization of tool-call arguments for identity comparison.
///
/// Mirrors v2 `canonicalTelemetryArgs` (sorted-key compact JSON): serde_json
/// maps are B-Tree ordered by default, so `to_string` already sorts object
/// keys recursively. Scalar formatting can differ from `JSON.stringify`
/// (e.g. float rendering), which only affects identity, never correctness.
pub fn canonical_args(arguments: &serde_json::Value) -> String {
    serde_json::to_string(arguments).unwrap_or_else(|_| arguments.to_string())
}

/// The dedup identity of a call (v2 `makeKey`: `"<tool> <canonical args>"`).
pub fn make_key(tool_name: &str, arguments: &serde_json::Value) -> String {
    format!("{tool_name} {}", canonical_args(arguments))
}

/// One step's dedup plan, computed before execution.
#[derive(Debug, Clone)]
pub struct StepPlan {
    /// The dedup key of each call, in call order.
    pub keys: Vec<String>,
    /// For each call, the index of the first same-key occurrence within the
    /// step. `original_of[i] == i` means the call is the step's original;
    /// anything else is a same-step duplicate that must not execute.
    pub original_of: Vec<usize>,
}

/// The per-turn dedup guard. See the module docs for the v2 mapping.
#[derive(Default)]
pub struct DedupeGuard {
    consecutive_key: Option<String>,
    consecutive_count: u32,
    /// Monotonic source of exempt sentinel ids: an exempt call must never
    /// streak against another call (including an exempt call in a later
    /// step at the same in-step position), so every one gets a fresh key.
    exempt_seq: u64,
}

impl DedupeGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Plan a step: key every call and mark same-step duplicates (the
    /// same-step half of v2 `checkToolCall`). The guard's exempt-id source
    /// advances, so planning is `&mut`.
    pub fn plan_step(&mut self, calls: &[ToolCall]) -> StepPlan {
        self.plan_step_by(calls, |call| {
            Some(make_key(&call.name, &call.arguments))
        })
    }

    /// Like [`Self::plan_step`], with a per-call keying function. Calls
    /// keyed `None` are exempt from dedup (each gets a fresh unique
    /// sentinel key — never matching anything, across steps included):
    /// the engine uses this to keep host-forwarded calls under the host's
    /// own dedup service, so no call is ever deduped twice.
    pub fn plan_step_by<F>(&mut self, calls: &[ToolCall], mut key_of: F) -> StepPlan
    where
        F: FnMut(&ToolCall) -> Option<String>,
    {
        let mut keys = Vec::with_capacity(calls.len());
        let mut original_of = Vec::with_capacity(calls.len());
        for call in calls.iter() {
            let key = key_of(call).unwrap_or_else(|| {
                let id = self.exempt_seq;
                self.exempt_seq += 1;
                format!("\x00exempt-{id}")
            });
            let original = keys
                .iter()
                .position(|k| *k == key)
                .unwrap_or(keys.len());
            original_of.push(original);
            keys.push(key);
        }
        StepPlan { keys, original_of }
    }

    /// Finalize a step's results after execution.
    ///
    /// Mirrors v2 `finalizeResult` + `endStep`: each original's result gets
    /// the reminder its streak earns (computed against the streak state as
    /// of the step's start), same-step duplicates receive the original's
    /// final result verbatim, and the consecutive streak advances over the
    /// step's keys. Returns `true` when any streak reached the force-stop
    /// threshold — the caller must end the turn after appending results.
    pub fn finalize_step(
        &mut self,
        plan: &StepPlan,
        results: &mut [ExecutableToolResult],
    ) -> bool {
        let pre_key = self.consecutive_key.clone();
        let pre_count = self.consecutive_count;
        let mut force_stop = false;

        for (i, result) in results.iter_mut().enumerate() {
            if plan.original_of[i] != i {
                continue;
            }
            let streak = streak_at(&plan.keys, i, pre_key.as_deref(), pre_count);
            if streak >= REPEAT_FORCE_STOP_STREAK {
                result.content.push_str(REMINDER_TEXT_3);
                force_stop = true;
            } else if streak >= REPEAT_REMINDER_3_START {
                result.content.push_str(REMINDER_TEXT_3);
            } else if streak >= REPEAT_REMINDER_2_START {
                result.content.push_str(&reminder_text_2(streak));
            } else if streak >= REPEAT_REMINDER_1_START {
                result.content.push_str(REMINDER_TEXT_1);
            }
        }
        // Same-step duplicates share the original's final result (v2's
        // deferred resolves to the reminder-appended result, not the raw).
        for (i, original) in plan.original_of.iter().enumerate() {
            if *original != i {
                results[i] = results[*original].clone();
            }
        }

        // v2 `endStep`: advance the cross-step streak over this step's keys.
        for key in &plan.keys {
            if self.consecutive_key.as_deref() == Some(key.as_str()) {
                self.consecutive_count += 1;
            } else {
                self.consecutive_key = Some(key.clone());
                self.consecutive_count = 1;
            }
        }
        force_stop
    }
}

/// The streak a call at `index` completes, extending the pre-step streak
/// when the key chain continues (v2 `finalizeResult`'s walk over
/// `stepCalls[0..=index]` starting from the step-head consecutive state).
fn streak_at(keys: &[String], index: usize, pre_key: Option<&str>, pre_count: u32) -> u32 {
    let mut last_key = pre_key;
    let mut streak = pre_count;
    for key in keys.iter().take(index + 1) {
        if last_key == Some(key.as_str()) {
            streak += 1;
        } else {
            last_key = Some(key.as_str());
            streak = 1;
        }
    }
    streak
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str, name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args,
        }
    }

    fn read_call(id: &str, path: &str) -> ToolCall {
        call(id, "Read", serde_json::json!({ "path": path }))
    }

    fn result(content: &str) -> ExecutableToolResult {
        ExecutableToolResult {
            content: content.into(),
            is_error: false,
            note: None,
        }
    }

    #[test]
    fn canonical_args_sorts_object_keys() {
        let a = serde_json::json!({ "b": 1, "a": { "d": 2, "c": 3 } });
        let b = serde_json::json!({ "a": { "c": 3, "d": 2 }, "b": 1 });
        assert_eq!(canonical_args(&a), canonical_args(&b));
        assert_eq!(canonical_args(&a), r#"{"a":{"c":3,"d":2},"b":1}"#);
    }

    #[test]
    fn make_key_combines_name_and_args() {
        let key = make_key("Read", &serde_json::json!({ "path": "a.rs" }));
        assert_eq!(key, r#"Read {"path":"a.rs"}"#);
    }

    #[test]
    fn plan_step_marks_same_step_duplicates() {
        let mut guard = DedupeGuard::new();
        let plan = guard.plan_step(&[
            read_call("c1", "a.rs"),
            read_call("c2", "b.rs"),
            read_call("c3", "a.rs"),
        ]);
        assert_eq!(plan.original_of, vec![0, 1, 0]);
        assert_eq!(plan.keys[0], plan.keys[2]);
    }

    #[test]
    fn plan_step_by_exempts_none_keyed_calls() {
        let mut guard = DedupeGuard::new();
        // Both calls share arguments, but the keyer exempts the second
        // family — no dedup between them.
        let plan = guard.plan_step_by(
            &[read_call("c1", "a.rs"), read_call("c2", "a.rs")],
            |call| (call.id == "c1").then(|| make_key(&call.name, &call.arguments)),
        );
        assert_eq!(plan.original_of, vec![0, 1]);
    }

    #[test]
    fn exempt_calls_never_streak_across_steps() {
        let mut guard = DedupeGuard::new();
        // The same exempt call repeated once per step for well past the
        // force-stop threshold must never earn a reminder or a stop:
        // exempt sentinels are unique per call, not per in-step position.
        for _ in 0..15 {
            let plan = guard.plan_step_by(&[read_call("c1", "a.rs")], |_| None);
            let mut results = vec![result("ok")];
            assert!(!guard.finalize_step(&plan, &mut results));
            assert_eq!(results[0].content, "ok");
        }
    }

    #[test]
    fn no_reminder_below_threshold() {
        let mut guard = DedupeGuard::new();
        for _ in 0..2 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            assert!(!guard.finalize_step(&plan, &mut results));
            assert_eq!(results[0].content, "ok");
        }
    }

    #[test]
    fn reminder_1_at_streak_3_across_steps() {
        let mut guard = DedupeGuard::new();
        let mut last = String::new();
        for _ in 0..3 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            assert!(!guard.finalize_step(&plan, &mut results));
            last = results[0].content.clone();
        }
        assert!(last.starts_with("ok\n\n<system-reminder>"));
        assert!(last.contains("repeated several times in a row"));
    }

    #[test]
    fn reminder_2_embeds_streak_count_at_5() {
        let mut guard = DedupeGuard::new();
        let mut last = String::new();
        for _ in 0..5 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            guard.finalize_step(&plan, &mut results);
            last = results[0].content.clone();
        }
        assert!(last.contains("issued 5 times in a row"));
    }

    #[test]
    fn reminder_3_at_8_and_force_stop_at_12() {
        let mut guard = DedupeGuard::new();
        let mut stopped = false;
        for round in 0..12 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            stopped = guard.finalize_step(&plan, &mut results);
            if round == 7 {
                assert!(results[0].content.contains("Write your final response now"));
                assert!(!stopped);
            }
        }
        assert!(stopped, "streak 12 must force-stop the turn");
    }

    #[test]
    fn different_call_resets_the_streak() {
        let mut guard = DedupeGuard::new();
        for _ in 0..2 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            guard.finalize_step(&plan, &mut results);
        }
        // A different key breaks the streak.
        let plan = guard.plan_step(&[read_call("c1", "b.rs")]);
        let mut results = vec![result("ok")];
        guard.finalize_step(&plan, &mut results);
        // Two more of the original key: streak restarts at 2 — no reminder.
        for _ in 0..2 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            guard.finalize_step(&plan, &mut results);
            assert_eq!(results[0].content, "ok");
        }
    }

    #[test]
    fn streak_extends_within_a_multi_call_step() {
        let mut guard = DedupeGuard::new();
        // One call in step 1 starts the streak.
        let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
        let mut results = vec![result("ok")];
        guard.finalize_step(&plan, &mut results);
        // Step 2 issues the same key twice: the second call is a same-step
        // duplicate (vetoed in v2), so the original's earned streak stays 2
        // — no reminder — and the duplicate shares the bare result. endStep
        // still counts both keys, extending the streak to 3.
        let plan = guard.plan_step(&[read_call("c2", "a.rs"), read_call("c3", "a.rs")]);
        let mut results = vec![result("raw-1"), result("raw-2")];
        assert!(!guard.finalize_step(&plan, &mut results));
        assert_eq!(results[0].content, "raw-1");
        assert_eq!(results[0].content, results[1].content);
        // Step 3's first call completes streak 4 and earns reminder 1.
        let plan = guard.plan_step(&[read_call("c4", "a.rs")]);
        let mut results = vec![result("raw-3")];
        assert!(!guard.finalize_step(&plan, &mut results));
        assert!(results[0].content.contains("repeated several times in a row"));
    }

    #[test]
    fn duplicate_gets_original_final_result() {
        let mut guard = DedupeGuard::new();
        // Streak 2 pre-step so the original earns a reminder-less result.
        for _ in 0..2 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            guard.finalize_step(&plan, &mut results);
        }
        let plan = guard.plan_step(&[read_call("c2", "a.rs"), read_call("c3", "a.rs")]);
        let mut results = vec![result("original-output"), result("never-ran")];
        guard.finalize_step(&plan, &mut results);
        assert_eq!(results[1].content, results[0].content);
        assert!(results[1].content.starts_with("original-output"));
    }

    #[test]
    fn force_stop_preserves_error_flag() {
        let mut guard = DedupeGuard::new();
        for _ in 0..11 {
            let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
            let mut results = vec![result("ok")];
            guard.finalize_step(&plan, &mut results);
        }
        let plan = guard.plan_step(&[read_call("c1", "a.rs")]);
        let mut results = vec![ExecutableToolResult {
            content: "boom".into(),
            is_error: true,
            note: None,
        }];
        assert!(guard.finalize_step(&plan, &mut results));
        assert!(results[0].is_error);
        assert!(results[0].content.starts_with("boom\n\n<system-reminder>"));
    }
}
