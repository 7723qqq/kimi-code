//! Per-session prompt queue: one active prompt per session, submitted prompts
//! that arrive while a turn runs wait behind it, and `steer` moves queued
//! prompts into the running turn. Mirrors the kap-server prompt-queue state
//! machine (`running` / `queued` / `blocked`) that the REST contract exposes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::events::EngineEvent;
use crate::rpc::types::ContentBlock;
use crate::server::engine::ServerEngine;
use crate::server::hub::EventHub;
use crate::session::sqlite_store::SqliteSessionStore;

/// A queued or active prompt: the wire `PromptItem` plus the model input needed
/// to run or steer it.
#[derive(Clone)]
struct Entry {
    item: Value,
    prompt: String,
    blocks: Vec<ContentBlock>,
}

/// The model input handed back to the turn loop when a prompt is admitted or
/// promoted.
pub struct RunInput {
    pub prompt_id: String,
    pub prompt: String,
    pub blocks: Vec<ContentBlock>,
}

#[derive(Default)]
struct State {
    active: HashMap<String, Entry>,
    queued: HashMap<String, Vec<Entry>>,
}

/// One active prompt plus a FIFO of queued prompts, keyed by session.
#[derive(Default)]
pub struct PromptQueue {
    state: Mutex<State>,
}

impl PromptQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a submitted prompt and stamp its wire `status`. Returns the
    /// wire item, and the run input when this prompt becomes active (the caller
    /// must start a turn); `None` means it was queued behind the active one.
    pub fn admit(
        &self,
        session_id: &str,
        item: Value,
        prompt: String,
        blocks: Vec<ContentBlock>,
    ) -> (Value, Option<RunInput>) {
        let mut state = self.lock();
        let mut item = item;
        if state.active.contains_key(session_id) {
            item["status"] = json!("queued");
            state
                .queued
                .entry(session_id.to_string())
                .or_default()
                .push(Entry {
                    item: item.clone(),
                    prompt,
                    blocks,
                });
            (item, None)
        } else {
            item["status"] = json!("running");
            let run = RunInput {
                prompt_id: item_id(&item),
                prompt: prompt.clone(),
                blocks: blocks.clone(),
            };
            state.active.insert(
                session_id.to_string(),
                Entry {
                    item: item.clone(),
                    prompt,
                    blocks,
                },
            );
            (item, Some(run))
        }
    }

    /// `(active, queued)` wire items for the list route.
    pub fn snapshot(&self, session_id: &str) -> (Option<Value>, Vec<Value>) {
        let state = self.lock();
        let active = state.active.get(session_id).map(|entry| entry.item.clone());
        let queued = state
            .queued
            .get(session_id)
            .map(|entries| entries.iter().map(|entry| entry.item.clone()).collect())
            .unwrap_or_default();
        (active, queued)
    }

    /// The active prompt's wire item, when one is running.
    pub fn active_item(&self, session_id: &str) -> Option<Value> {
        self.lock()
            .active
            .get(session_id)
            .map(|entry| entry.item.clone())
    }

    /// Promote the next queued prompt to active and return its run input, or
    /// `None` when the queue is drained (the active slot is cleared by the
    /// caller via [`PromptQueue::clear_active`]).
    pub fn advance(&self, session_id: &str) -> Option<RunInput> {
        let mut state = self.lock();
        let next = match state.queued.get_mut(session_id) {
            Some(queue) if !queue.is_empty() => queue.remove(0),
            _ => return None,
        };
        let run = RunInput {
            prompt_id: item_id(&next.item),
            prompt: next.prompt.clone(),
            blocks: next.blocks.clone(),
        };
        let mut next = next;
        next.item["status"] = json!("running");
        state.active.insert(session_id.to_string(), next);
        Some(run)
    }

    /// Overwrite the active prompt's status (used to surface `blocked`).
    pub fn set_active_status(&self, session_id: &str, status: &str) {
        if let Some(entry) = self.lock().active.get_mut(session_id) {
            entry.item["status"] = json!(status);
        }
    }

    /// Drop the active slot once a session has no more prompts to run.
    pub fn clear_active(&self, session_id: &str) {
        self.lock().active.remove(session_id);
    }

    /// Remove queued prompts by id, returning them for steering. Ids that are
    /// not queued are absent from the result.
    pub fn take_queued(
        &self,
        session_id: &str,
        ids: &[String],
    ) -> Vec<(Value, String, Vec<ContentBlock>)> {
        let mut state = self.lock();
        let mut taken = Vec::new();
        if let Some(queue) = state.queued.get_mut(session_id) {
            let mut remaining = Vec::new();
            for entry in queue.drain(..) {
                if ids.iter().any(|wanted| wanted == &item_id(&entry.item)) {
                    taken.push((entry.item, entry.prompt, entry.blocks));
                } else {
                    remaining.push(entry);
                }
            }
            *queue = remaining;
        }
        taken
    }

    /// Whether a prompt id is active or queued.
    pub fn contains(&self, session_id: &str, prompt_id: &str) -> bool {
        let state = self.lock();
        state
            .active
            .get(session_id)
            .is_some_and(|entry| item_id(&entry.item) == prompt_id)
            || state
                .queued
                .get(session_id)
                .is_some_and(|queue| queue.iter().any(|entry| item_id(&entry.item) == prompt_id))
    }

    /// Whether the active prompt has this id.
    pub fn active_is(&self, session_id: &str, prompt_id: &str) -> bool {
        self.lock()
            .active
            .get(session_id)
            .is_some_and(|entry| item_id(&entry.item) == prompt_id)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn item_id(item: &Value) -> String {
    item.get("prompt_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Publish one prompt-lifecycle event on the session's lane.
pub fn publish_prompt_event(hub: &EventHub, session_id: &str, event: Value) {
    hub.bus_for(session_id).publish(&EngineEvent::Custom(event));
}

/// Drive a session's prompts to completion: run the admitted prompt, then
/// promote and run each queued one in turn until the queue drains. Emits
/// `prompt.completed` per prompt (reason `failed` when the turn errored, the
/// prompt then surfaces as `blocked`).
pub async fn run_prompt_loop(
    engine: Option<Arc<ServerEngine>>,
    store: Arc<SqliteSessionStore>,
    queue: Arc<PromptQueue>,
    hub: Arc<EventHub>,
    session_id: String,
    run: RunInput,
) {
    let Some(engine) = engine else {
        queue.clear_active(&session_id);
        return;
    };
    let mut run = run;
    loop {
        let history = store.load_session_history(&session_id).unwrap_or_default();
        let turn_number = store.next_turn_number(&session_id).unwrap_or(1);
        let outcome = engine
            .run_turn_with_media(
                &session_id,
                turn_number,
                history,
                &run.prompt,
                run.blocks.clone(),
            )
            .await;
        if outcome.is_err() {
            queue.set_active_status(&session_id, "blocked");
        }
        publish_prompt_event(
            &hub,
            &session_id,
            json!({
                "type": "prompt.completed",
                "agentId": "main",
                "sessionId": session_id,
                "promptId": run.prompt_id,
                "finishedAt": chrono::Utc::now().to_rfc3339(),
                "reason": if outcome.is_ok() { "completed" } else { "failed" },
            }),
        );
        match queue.advance(&session_id) {
            Some(next) => run = next,
            None => {
                queue.clear_active(&session_id);
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> Value {
        json!({
            "prompt_id": id,
            "user_message_id": format!("msg-{id}"),
            "content": [{ "type": "text", "text": id }],
            "created_at": "2026-01-01T00:00:00Z",
        })
    }

    #[test]
    fn first_prompt_runs_second_queues() {
        let queue = PromptQueue::new();
        let (first, run) = queue.admit("s1", item("p1"), "p1".into(), Vec::new());
        assert_eq!(first["status"], "running");
        assert_eq!(run.unwrap().prompt_id, "p1");

        let (second, run) = queue.admit("s1", item("p2"), "p2".into(), Vec::new());
        assert_eq!(second["status"], "queued");
        assert!(run.is_none());

        let (active, queued) = queue.snapshot("s1");
        assert_eq!(active.unwrap()["prompt_id"], "p1");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["prompt_id"], "p2");
    }

    #[test]
    fn advancing_promotes_then_idles() {
        let queue = PromptQueue::new();
        queue.admit("s1", item("p1"), "p1".into(), Vec::new());
        queue.admit("s1", item("p2"), "p2".into(), Vec::new());

        let next = queue.advance("s1").expect("p2 promoted");
        assert_eq!(next.prompt, "p2");
        assert!(queue.active_is("s1", "p2"));
        assert_eq!(queue.snapshot("s1").0.unwrap()["status"], "running");
        assert!(queue.advance("s1").is_none());

        queue.clear_active("s1");
        assert!(queue.snapshot("s1").0.is_none());
    }

    #[test]
    fn take_queued_moves_only_requested_ids() {
        let queue = PromptQueue::new();
        queue.admit("s1", item("p1"), "p1".into(), Vec::new());
        queue.admit("s1", item("p2"), "p2".into(), Vec::new());
        queue.admit("s1", item("p3"), "p3".into(), Vec::new());

        let taken = queue.take_queued("s1", &["p2".to_string()]);
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].0["prompt_id"], "p2");
        assert!(!queue.contains("s1", "p2"));
        assert!(queue.contains("s1", "p3"));
        assert!(queue.active_is("s1", "p1"));
    }

    #[test]
    fn set_active_status_marks_blocked() {
        let queue = PromptQueue::new();
        queue.admit("s1", item("p1"), "p1".into(), Vec::new());
        queue.set_active_status("s1", "blocked");
        assert_eq!(queue.active_item("s1").unwrap()["status"], "blocked");
    }
}
