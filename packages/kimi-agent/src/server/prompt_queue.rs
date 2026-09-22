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

/// The model input handed back to the turn loop when a prompt is admitted or
/// promoted.
pub struct RunInput {
    pub prompt_id: String,
    pub prompt: String,
    pub blocks: Vec<ContentBlock>,
    /// The request's `metadata` as `[metadata]` (v2 `clientMetadata`), `None`
    /// when the client sent none. Persisted as the turn's origin payload.
    pub origin: Option<Value>,
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

/// What [`PromptQueue::cancel`] found.
pub enum CancelOutcome {
    /// The prompt was active: the caller cancels its turn through the engine.
    Active,
    /// The prompt was queued and has been removed; it will never run.
    Queued,
}

struct Entry {
    item: Value,
    prompt: String,
    blocks: Vec<ContentBlock>,
    origin: Option<Value>,
    /// The turn number the live `event.message.created` id names
    /// (`msg-u{turn}`), stamped by the driver when the turn starts. `None`
    /// until then: a queued prompt has no turn yet.
    turn_number: Option<u32>,
    /// The abort route settled this prompt: the turn driver must not publish
    /// a second terminal event (`prompt.completed`) on top of the
    /// `prompt.aborted` the route already published — v2's `cancelWaiter`
    /// settles the item exactly once (loopService.ts:735-750).
    cancelled: bool,
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
        origin: Option<Value>,
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
                    origin,
                    turn_number: None,
                    cancelled: false,
                });
            (item, None)
        } else {
            item["status"] = json!("running");
            let run = RunInput {
                prompt_id: item_id(&item),
                prompt: prompt.clone(),
                blocks: blocks.clone(),
                origin: origin.clone(),
            };
            state.active.insert(
                session_id.to_string(),
                Entry {
                    item: item.clone(),
                    prompt,
                    blocks,
                    origin,
                    turn_number: None,
                    cancelled: false,
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
            origin: next.origin.clone(),
        };
        let mut next = next;
        next.item["status"] = json!("running");
        state.active.insert(session_id.to_string(), next);
        Some(run)
    }

    /// Settle a prompt by id (v2 `cancelWaiter`, loopService.ts:735-750): a
    /// queued prompt is removed from the queue so the driver never promotes
    /// it, and the active prompt is flagged so the driver publishes no second
    /// terminal event on top of the `prompt.aborted` the route published.
    /// `None` means no active or queued prompt carries the id.
    pub fn cancel(&self, session_id: &str, prompt_id: &str) -> Option<CancelOutcome> {
        Self::cancel_locked(&mut self.lock(), session_id, prompt_id)
    }

    fn cancel_locked(
        state: &mut State,
        session_id: &str,
        prompt_id: &str,
    ) -> Option<CancelOutcome> {
        if let Some(entry) = state.active.get_mut(session_id)
            && item_id(&entry.item) == prompt_id
        {
            entry.cancelled = true;
            entry.item["status"] = json!("aborted");
            return Some(CancelOutcome::Active);
        }
        if let Some(queue) = state.queued.get_mut(session_id) {
            let before = queue.len();
            queue.retain(|entry| item_id(&entry.item) != prompt_id);
            if queue.len() != before {
                return Some(CancelOutcome::Queued);
            }
        }
        None
    }

    /// Record the turn number the driver is about to run for the active
    /// prompt, so the live message id (`msg-u{turn}`) can be resolved back to
    /// it. Called by `run_prompt_loop` once per turn.
    pub fn stamp_active_turn(&self, session_id: &str, turn_number: u32) {
        if let Some(entry) = self.lock().active.get_mut(session_id) {
            entry.turn_number = Some(turn_number);
        }
    }

    /// The turn number stamped for the active prompt, when the driver has
    /// started it — the `turnId` a `turn.steer` payload carries so the fold
    /// can pair the steer with its turn (v2 `turnSteerSchema`).
    pub fn active_turn_number(&self, session_id: &str) -> Option<u32> {
        self.lock()
            .active
            .get(session_id)
            .and_then(|entry| entry.turn_number)
    }

    /// Settle a prompt by the *user message id* a client holds, returning the
    /// resolved prompt id alongside the outcome. Two schemes name the same
    /// message and neither is the prompt id:
    ///
    /// - `msg-u{turn}` — the live `event.message.created` id
    ///   (`message_events.rs`), resolved through the active prompt's stamped
    ///   turn. This is what the web UI's abort button sends (ROADMAP §7.6:
    ///   the raw prompt-id lookup missed it and the route answered 404).
    /// - `msg-{prompt_id}` — the prompt item's own `user_message_id`.
    ///
    /// A turn scheme that names a turn the active prompt is not running falls
    /// through to the prompt-id scheme, so a client-chosen prompt id that
    /// happens to start with `u` still resolves.
    pub fn cancel_by_user_message_id(
        &self,
        session_id: &str,
        user_message_id: &str,
    ) -> Option<(String, CancelOutcome)> {
        let mut state = self.lock();
        if let Some(turn) = user_message_id
            .strip_prefix("msg-u")
            .and_then(|rest| rest.parse::<u32>().ok())
            && let Some(entry) = state.active.get(session_id)
            && entry.turn_number == Some(turn)
        {
            let prompt_id = item_id(&entry.item);
            let outcome = Self::cancel_locked(&mut state, session_id, &prompt_id)?;
            return Some((prompt_id, outcome));
        }
        let prompt_id = user_message_id.strip_prefix("msg-")?;
        let outcome = Self::cancel_locked(&mut state, session_id, prompt_id)?;
        Some((prompt_id.to_string(), outcome))
    }

    /// Whether the abort route settled the active prompt.
    pub fn active_is_cancelled(&self, session_id: &str) -> bool {
        self.lock()
            .active
            .get(session_id)
            .is_some_and(|entry| entry.cancelled)
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
    ) -> Vec<(Value, String, Vec<ContentBlock>, Option<Value>)> {
        let mut state = self.lock();
        let mut taken = Vec::new();
        if let Some(queue) = state.queued.get_mut(session_id) {
            let mut remaining = Vec::new();
            for entry in queue.drain(..) {
                if ids.iter().any(|wanted| wanted == &item_id(&entry.item)) {
                    taken.push((entry.item, entry.prompt, entry.blocks, entry.origin));
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
        // The live `event.message.created` id names this turn (`msg-u{turn}`);
        // stamping it lets the abort route resolve that id back to the prompt
        // (ROADMAP §7.6).
        queue.stamp_active_turn(&session_id, turn_number);
        let outcome = engine
            .run_turn_with_media(
                &session_id,
                turn_number,
                history,
                &run.prompt,
                run.blocks.clone(),
                run.origin.clone(),
            )
            .await;
        if outcome.is_err() {
            queue.set_active_status(&session_id, "blocked");
        }
        // A prompt the abort route already settled has its terminal event
        // (`prompt.aborted`); publishing `prompt.completed` as well would
        // settle it twice — v2's `cancelWaiter` settles exactly once.
        if !queue.active_is_cancelled(&session_id) {
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
        }
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
        let (first, run) = queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        assert_eq!(first["status"], "running");
        assert_eq!(run.unwrap().prompt_id, "p1");

        let (second, run) = queue.admit("s1", item("p2"), "p2".into(), Vec::new(), None);
        assert_eq!(second["status"], "queued");
        assert!(run.is_none());

        let (active, queued) = queue.snapshot("s1");
        assert_eq!(active.unwrap()["prompt_id"], "p1");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["prompt_id"], "p2");
    }

    /// ROADMAP §7.6: the web UI's abort button sends the live
    /// `event.message.created` id (`msg-u{turn}`, `message_events.rs`), which
    /// names the turn's user message — not the prompt. The raw prompt-id
    /// lookup misses it and the route answered 404; resolving the message id
    /// to the prompt whose turn it names is what keeps the button working.
    #[test]
    fn abort_resolves_the_live_user_message_id_to_the_active_prompt() {
        let queue = PromptQueue::new();
        let (_item, run) = queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        run.unwrap();
        queue.stamp_active_turn("s1", 2);

        assert!(
            queue.cancel("s1", "msg-u2").is_none(),
            "the live message id is not a prompt id — the raw lookup misses"
        );

        let (resolved, outcome) = queue
            .cancel_by_user_message_id("s1", "msg-u2")
            .expect("the live message id resolves to the active prompt");
        assert_eq!(resolved, "p1");
        assert!(matches!(outcome, CancelOutcome::Active));
        assert!(queue.active_is_cancelled("s1"));
    }

    /// The prompt item's own `user_message_id` (`msg-{prompt_id}`) is the
    /// other scheme a client can hold; it resolves active and queued prompts
    /// alike. An id that names neither is still a miss.
    #[test]
    fn abort_resolves_the_prompt_items_own_user_message_id() {
        let queue = PromptQueue::new();
        let (_first, run) = queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        run.unwrap();
        let (_second, none) = queue.admit("s1", item("p2"), "p2".into(), Vec::new(), None);
        assert!(none.is_none(), "p2 queues behind the active prompt");

        let (resolved, outcome) = queue
            .cancel_by_user_message_id("s1", "msg-p2")
            .expect("the item's own scheme resolves a queued prompt");
        assert_eq!(resolved, "p2");
        assert!(matches!(outcome, CancelOutcome::Queued));

        let (resolved, outcome) = queue
            .cancel_by_user_message_id("s1", "msg-p1")
            .expect("the item's own scheme resolves the active prompt");
        assert_eq!(resolved, "p1");
        assert!(matches!(outcome, CancelOutcome::Active));

        assert!(queue.cancel_by_user_message_id("s1", "msg-nope").is_none());
        assert!(
            queue.cancel_by_user_message_id("s1", "p1").is_none(),
            "a bare prompt id is not a message id"
        );
        assert!(
            queue.cancel_by_user_message_id("s1", "msg-u9").is_none(),
            "a turn the active prompt is not running does not resolve"
        );
    }

    #[test]
    fn client_metadata_rides_the_item_and_the_run() {
        // #3764: the route wraps the request's `metadata` as a one-element
        // `clientMetadata` array inside the origin; the item echoes it for the
        // REST response and the run carries the origin to persistence.
        let queue = PromptQueue::new();
        let mut base = item("p1");
        base["metadata"] = json!({ "surface": "web", "threadId": "abc" });
        let origin = json!({
            "kind": "user",
            "clientMetadata": [{ "surface": "web", "threadId": "abc" }],
        });
        let (admitted, run) = queue.admit("s1", base, "p1".into(), Vec::new(), Some(origin));
        assert_eq!(admitted["metadata"]["threadId"], "abc");
        let run = run.unwrap();
        let origin = run.origin.unwrap();
        assert_eq!(origin["kind"], "user");
        assert_eq!(origin["clientMetadata"][0]["surface"], "web");

        // A queued prompt keeps its origin until it is promoted.
        let mut queued_base = item("p2");
        queued_base["metadata"] = json!({ "surface": "web" });
        let origin2 = json!({ "kind": "user", "clientMetadata": [{ "surface": "web" }] });
        let (_queued, none) =
            queue.admit("s1", queued_base, "p2".into(), Vec::new(), Some(origin2));
        assert!(none.is_none());

        let next = queue.advance("s1").expect("p2 promoted");
        let origin = next.origin.unwrap();
        assert_eq!(origin["clientMetadata"][0]["surface"], "web");
    }

    #[test]
    fn advancing_promotes_then_idles() {
        let queue = PromptQueue::new();
        queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        queue.admit("s1", item("p2"), "p2".into(), Vec::new(), None);

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
        queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        queue.admit("s1", item("p2"), "p2".into(), Vec::new(), None);
        queue.admit("s1", item("p3"), "p3".into(), Vec::new(), None);

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
        queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        queue.set_active_status("s1", "blocked");
        assert_eq!(queue.active_item("s1").unwrap()["status"], "blocked");
    }

    /// v2's `cancelWaiter` (loopService.ts:735-750): a queued prompt is
    /// removed so the driver never promotes it — an aborted prompt must not
    /// run after the abort.
    #[test]
    fn cancel_removes_a_queued_prompt_so_it_never_runs() {
        let queue = PromptQueue::new();
        queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        queue.admit("s1", item("p2"), "p2".into(), Vec::new(), None);

        assert!(matches!(
            queue.cancel("s1", "p2"),
            Some(CancelOutcome::Queued)
        ));
        assert!(!queue.contains("s1", "p2"));
        // The active prompt is untouched and still runs.
        assert!(queue.active_is("s1", "p1"));
        assert!(!queue.active_is_cancelled("s1"));
        // Promotion skips the removed entry entirely.
        assert!(queue.advance("s1").is_none());
    }

    /// The active prompt is flagged, not removed: its turn is still running
    /// and must be cancelled through the engine, and the driver must publish
    /// no second terminal event on top of the route's `prompt.aborted`.
    #[test]
    fn cancel_flags_the_active_prompt() {
        let queue = PromptQueue::new();
        queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);

        assert!(matches!(
            queue.cancel("s1", "p1"),
            Some(CancelOutcome::Active)
        ));
        assert!(queue.active_is_cancelled("s1"));
        assert_eq!(queue.active_item("s1").unwrap()["status"], "aborted");
        // Still present: the driver settles it after the turn returns.
        assert!(queue.contains("s1", "p1"));
    }

    #[test]
    fn cancel_reports_an_unknown_prompt() {
        let queue = PromptQueue::new();
        queue.admit("s1", item("p1"), "p1".into(), Vec::new(), None);
        assert!(queue.cancel("s1", "nope").is_none());
        assert!(queue.cancel("nope", "p1").is_none());
    }
}
