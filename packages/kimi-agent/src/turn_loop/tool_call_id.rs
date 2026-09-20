//! Turn-scoped tool-call-id normalization (v2 `ToolCallIdNormalizer`,
//! `human/llm/toolCallIdNormalizer.ts`).
//!
//! Providers are free to reuse a tool-call id: a resumed session can replay an
//! id that is still in the restored history, a retried request can return the
//! same id it streamed before it disconnected, and one response can legitimately
//! carry the same id twice. A repeated id makes the follow-up tool result
//! ambiguous — the provider rejects it ("tool id not found") or the transcript
//! folds two distinct calls into one.
//!
//! The normalizer keeps one id ledger for the whole turn, seeded once from the
//! restored history, and hands out an attempt-scoped
//! [`ToolCallIdResponseNormalizer`] per response. Ids are claimed in first-seen
//! order; a repeat is rewritten as `<raw>__<n>`.
//!
//! Attempts are discardable: a step that fails and is retried hands its claims
//! back with [`ToolCallIdResponseNormalizer::rollback`], so the retry reuses the
//! provider's raw ids instead of minting `__2` variants of a response the turn
//! never kept (v2 #3734).
//!
//! Provenance note: v2 also stamps the provider's original id onto the
//! rewritten call (`ToolCall.rawId`) so a provider-specific id policy can map
//! history ids back on the next request. This engine has no such policy — the
//! assigned id is what history and the provider both carry — so the raw→assigned
//! mapping lives here ([`ToolCallIdResponseNormalizer::remapped`]) instead of on
//! the call.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::types::LLMMessage;

/// The provider's slot for a streamed tool call: its position in the chunk, or
/// a provider-supplied key. Every delta of one call shares a slot, and every
/// delta of one slot shares the id assigned when the slot was first seen — which
/// is what keeps the streamed deltas of a call consistent with its finalized
/// form.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum StreamSlot {
    Index(usize),
    Key(String),
}

impl From<usize> for StreamSlot {
    fn from(index: usize) -> Self {
        StreamSlot::Index(index)
    }
}

impl From<&str> for StreamSlot {
    fn from(key: &str) -> Self {
        StreamSlot::Key(key.to_string())
    }
}

/// One id the normalizer had to rewrite (v2's public `remapped` array).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemappedId {
    pub raw: String,
    pub assigned: String,
}

#[derive(Default)]
struct Ledger {
    seen: HashSet<String>,
    seeded: bool,
}

/// The turn-scoped ledger of ids already claimed, by history or by a committed
/// response. Share one per turn; [`Self::begin_response`] opens a response.
pub struct ToolCallIdNormalizer {
    ledger: Mutex<Ledger>,
}

impl Default for ToolCallIdNormalizer {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolCallIdNormalizer {
    pub fn new() -> Self {
        Self {
            ledger: Mutex::new(Ledger::default()),
        }
    }

    /// Claim every id the restored history already carries: ids of assistant
    /// tool calls and of tool results. One-shot — a second call is ignored, so
    /// a turn that appends to its own history does not re-seed (v2
    /// `seedFrom`, toolCallIdNormalizer.ts:13-22).
    pub fn seed_from(&self, messages: &[LLMMessage]) {
        let mut ledger = self.ledger.lock().unwrap_or_else(|e| e.into_inner());
        if ledger.seeded {
            return;
        }
        ledger.seeded = true;
        for message in messages {
            for call in &message.tool_calls {
                ledger.seen.insert(call.id.clone());
            }
            if let Some(id) = &message.tool_call_id {
                ledger.seen.insert(id.clone());
            }
        }
    }

    /// Open the ledger for one response attempt (v2 `beginResponse`).
    pub fn begin_response(self: &Arc<Self>) -> ToolCallIdResponseNormalizer {
        ToolCallIdResponseNormalizer {
            parent: Arc::clone(self),
            state: Mutex::new(ResponseState::default()),
        }
    }

    /// Whether the given id would be rewritten if claimed right now. Read-only;
    /// used by tests and diagnostics.
    pub fn is_taken(&self, id: &str) -> bool {
        self.ledger
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .seen
            .contains(id)
    }
}

#[derive(Default)]
struct ResponseState {
    assigned_by_slot: HashMap<StreamSlot, String>,
    occurrences: HashMap<String, Vec<String>>,
    claimed: Vec<String>,
    remapped: Vec<RemappedId>,
}

/// One response's view of the turn ledger. Deltas and the finalized calls of
/// the same response share it, so a streamed id and the id that enters history
/// are the same string.
pub struct ToolCallIdResponseNormalizer {
    parent: Arc<ToolCallIdNormalizer>,
    state: Mutex<ResponseState>,
}

impl ToolCallIdResponseNormalizer {
    /// The id for a streamed tool-call part. Repeat calls for the same slot
    /// return the id assigned when the slot was first seen; a new slot claims
    /// the next free id for this occurrence of `raw_id` (v2
    /// `remapStreamedId`, toolCallIdNormalizer.ts:35-47).
    pub fn remap_streamed_id(&self, raw_id: &str, slot: Option<&StreamSlot>) -> String {
        if let Some(slot) = slot {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(assigned) = state.assigned_by_slot.get(slot) {
                return assigned.clone();
            }
        }
        let occurrence = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.occurrences.get(raw_id).map_or(0, Vec::len)
        };
        let assigned = self.claim(raw_id, occurrence);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .occurrences
            .entry(raw_id.to_string())
            .or_default()
            .push(assigned.clone());
        if let Some(slot) = slot {
            state
                .assigned_by_slot
                .insert(slot.clone(), assigned.clone());
        }
        assigned
    }

    /// The id for each finalized call of this response. Tool calls that never
    /// streamed a part are claimed here (v2 `remapFinalizedCalls`,
    /// toolCallIdNormalizer.ts:49-65).
    pub fn remap_finalized_ids(&self, raw_ids: &[String]) -> Vec<String> {
        if raw_ids.is_empty() {
            return Vec::new();
        }
        let mut counts: HashMap<&str, usize> = HashMap::new();
        let mut assigned_ids = Vec::with_capacity(raw_ids.len());
        for raw_id in raw_ids {
            let occurrence = {
                let count = counts.entry(raw_id.as_str()).or_insert(0);
                let occurrence = *count;
                *count += 1;
                occurrence
            };
            let streamed = {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state
                    .occurrences
                    .get(raw_id)
                    .and_then(|assigned| assigned.get(occurrence))
                    .cloned()
            };
            assigned_ids.push(streamed.unwrap_or_else(|| self.claim(raw_id, occurrence)));
        }
        assigned_ids
    }

    /// Hand this response's claims back, so a retry reuses the raw ids (v2
    /// `rollback`, toolCallIdNormalizer.ts:67-69). Committed responses keep
    /// theirs — only this attempt's claims are released, and the attempt's own
    /// bookkeeping is dropped with them.
    pub fn rollback(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        {
            let mut ledger = self.parent.ledger.lock().unwrap_or_else(|e| e.into_inner());
            for id in state.claimed.drain(..) {
                ledger.seen.remove(&id);
            }
        }
        state.assigned_by_slot.clear();
        state.occurrences.clear();
        state.remapped.clear();
    }

    /// Every id this response rewrote, in claim order (v2's `remapped`).
    pub fn remapped(&self) -> Vec<RemappedId> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remapped
            .clone()
    }

    /// Claim the `occurrence`-th id for `raw_id`: the raw id itself when it is
    /// the first occurrence and the ledger has never seen it, otherwise the
    /// first free `<raw>__<n>` (v2 `claim`, toolCallIdNormalizer.ts:71-87).
    fn claim(&self, raw_id: &str, occurrence: usize) -> String {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut ledger = self.parent.ledger.lock().unwrap_or_else(|e| e.into_inner());
        if occurrence == 0 && !ledger.seen.contains(raw_id) {
            ledger.seen.insert(raw_id.to_string());
            state.claimed.push(raw_id.to_string());
            return raw_id.to_string();
        }
        let mut n = usize::max(occurrence + 1, 2);
        let mut candidate = format!("{raw_id}__{n}");
        while ledger.seen.contains(&candidate) {
            n += 1;
            candidate = format!("{raw_id}__{n}");
        }
        ledger.seen.insert(candidate.clone());
        state.claimed.push(candidate.clone());
        state.remapped.push(RemappedId {
            raw: raw_id.to_string(),
            assigned: candidate.clone(),
        });
        candidate
    }
}

/// Remap the tool-call ids of one completed response against an open response
/// ledger.
///
/// A transport that streams its own deltas runs this inside the request, so a
/// fragment and the call it belongs to leave under one id. A transport that
/// hands the request to the host (the host proxy, the racing multi transport)
/// never saw the fragments, so it runs this on the response the host returned —
/// the turn still gets unique ids, it just cannot promise the host's streamed
/// frames used them.
pub fn remap_response_tool_calls(
    response: &mut crate::turn_loop::types::LLMChatResponse,
    ids: &ToolCallIdResponseNormalizer,
) {
    if response.tool_calls.is_empty() {
        return;
    }
    let raw_ids: Vec<String> = response
        .tool_calls
        .iter()
        .map(|call| call.id.clone())
        .collect();
    for (call, assigned) in response
        .tool_calls
        .iter_mut()
        .zip(ids.remap_finalized_ids(&raw_ids))
    {
        // An id the provider left empty is the step's to mint (P61); claiming
        // "" here would only take the slot.
        if !call.id.trim().is_empty() {
            call.id = assigned;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_loop::types::ToolCall;

    fn call(id: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            name: "Bash".into(),
            arguments: serde_json::json!({}),
            extras: None,
        }
    }

    fn history_with(ids: &[&str]) -> Vec<LLMMessage> {
        vec![LLMMessage {
            role: "assistant".into(),
            content: String::new(),
            blocks: Vec::new(),
            tool_calls: ids.iter().map(|id| call(id)).collect(),
            tool_call_id: None,
            prompt_id: None,
        }]
    }

    fn normalizer() -> Arc<ToolCallIdNormalizer> {
        Arc::new(ToolCallIdNormalizer::new())
    }

    /// v2 test: `passes first-seen ids through unchanged`.
    #[test]
    fn test_first_seen_ids_pass_through() {
        let normalizer = normalizer();
        let response = normalizer.begin_response();

        assert_eq!(
            response.remap_streamed_id("call_1", Some(&StreamSlot::Index(0))),
            "call_1"
        );
        assert_eq!(
            response.remap_streamed_id("call_2", Some(&StreamSlot::Index(1))),
            "call_2"
        );
        assert!(response.remapped().is_empty());
    }

    /// v2 test: `rewrites an id already claimed by an earlier response`.
    #[test]
    fn test_rewrites_ids_claimed_by_a_committed_response() {
        let normalizer = normalizer();
        normalizer
            .begin_response()
            .remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0)));

        let next = normalizer.begin_response();
        assert_eq!(
            next.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0))),
            "Bash_0__2"
        );
        assert_eq!(
            next.remapped(),
            vec![RemappedId {
                raw: "Bash_0".into(),
                assigned: "Bash_0__2".into()
            }]
        );

        let third = normalizer.begin_response();
        assert_eq!(
            third.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0))),
            "Bash_0__3"
        );
    }

    /// v2 test: `rewrites duplicates within one response and keeps
    /// stream/finalized assignment consistent`.
    #[test]
    fn test_duplicates_within_one_response_agree_with_finalized_ids() {
        let normalizer = normalizer();
        let response = normalizer.begin_response();

        assert_eq!(
            response.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0))),
            "Bash_0"
        );
        assert_eq!(
            response.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(1))),
            "Bash_0__2"
        );
        // The same slot resolves to the id it was first assigned.
        assert_eq!(
            response.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(1))),
            "Bash_0__2"
        );

        assert_eq!(
            response.remap_finalized_ids(&["Bash_0".into(), "Bash_0".into()]),
            vec!["Bash_0".to_string(), "Bash_0__2".to_string()]
        );
    }

    /// v2 test: `seeds the seen set from restored context so a replayed id is
    /// rewritten on first sight` — and seeding is one-shot.
    #[test]
    fn test_seed_from_history_is_one_shot() {
        let normalizer = normalizer();
        normalizer.seed_from(&history_with(&["Bash_0"]));
        normalizer.seed_from(&history_with(&["ignored"]));

        let response = normalizer.begin_response();
        assert_eq!(
            response.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0))),
            "Bash_0__2"
        );
        assert_eq!(
            response.remap_streamed_id("ignored", Some(&StreamSlot::Index(1))),
            "ignored"
        );
    }

    /// v2 test: `claims tool result ids from history as well`.
    #[test]
    fn test_seed_claims_tool_result_ids() {
        let normalizer = normalizer();
        let mut history = history_with(&[]);
        history[0].tool_calls.clear();
        history.push(LLMMessage {
            role: "tool".into(),
            content: String::new(),
            blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: Some("Bash_1".into()),
            prompt_id: None,
        });
        normalizer.seed_from(&history);

        assert_eq!(
            normalizer
                .begin_response()
                .remap_streamed_id("Bash_1", Some(&StreamSlot::Index(0))),
            "Bash_1__2"
        );
    }

    /// v2 test: `rollback reverts the attempt claims so a retry reuses the raw
    /// ids`.
    #[test]
    fn test_rollback_lets_a_retry_reuse_raw_ids() {
        let normalizer = normalizer();
        let failed = normalizer.begin_response();
        failed.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0)));
        failed.remap_streamed_id("Bash_1", Some(&StreamSlot::Index(1)));
        failed.rollback();

        let retry = normalizer.begin_response();
        assert_eq!(
            retry.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0))),
            "Bash_0"
        );
        assert_eq!(
            retry.remap_streamed_id("Bash_1", Some(&StreamSlot::Index(1))),
            "Bash_1"
        );
    }

    /// v2 test: `rollback does not remove ids claimed by committed earlier
    /// responses`.
    #[test]
    fn test_rollback_keeps_committed_claims() {
        let normalizer = normalizer();
        normalizer
            .begin_response()
            .remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0)));

        let failed = normalizer.begin_response();
        assert_eq!(
            failed.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0))),
            "Bash_0__2"
        );
        failed.rollback();

        let next = normalizer.begin_response();
        assert_eq!(
            next.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0))),
            "Bash_0__2"
        );
    }

    /// v2 test: `mints on the spot for finalized calls that never streamed a
    /// part`.
    #[test]
    fn test_finalized_calls_mint_without_a_streamed_part() {
        let normalizer = normalizer();
        let response = normalizer.begin_response();
        response.remap_streamed_id("Bash_0", Some(&StreamSlot::Index(0)));

        assert_eq!(
            response.remap_finalized_ids(&["Bash_0".into(), "late_1".into(), "late_1".into()]),
            vec![
                "Bash_0".to_string(),
                "late_1".to_string(),
                "late_1__2".to_string()
            ]
        );
    }

    /// v2 test: `returns the original array reference when nothing changed` —
    /// in Rust the observable half is that no id is rewritten and nothing is
    /// recorded as remapped.
    #[test]
    fn test_untouched_ids_are_not_remapped() {
        let normalizer = normalizer();
        let response = normalizer.begin_response();
        let ids = vec!["call_1".to_string()];

        assert_eq!(response.remap_finalized_ids(&ids), ids);
        assert!(response.remapped().is_empty());
    }

    /// A provider key (`StreamSlot::Key`) behaves like a numeric slot: every
    /// delta of one key shares the assigned id.
    #[test]
    fn test_keyed_slots_share_one_assignment() {
        let normalizer = normalizer();
        let response = normalizer.begin_response();
        let slot = StreamSlot::Key("fc_1".into());

        assert_eq!(response.remap_streamed_id("call_1", Some(&slot)), "call_1");
        assert_eq!(response.remap_streamed_id("call_1", Some(&slot)), "call_1");
        assert_eq!(
            response.remap_streamed_id("call_1", Some(&StreamSlot::Key("fc_2".into()))),
            "call_1__2"
        );
    }

    /// The host-proxied transports normalize a whole response at once: the
    /// helper rewrites only the ids the ledger already holds, and leaves a
    /// provider's empty id for the step to mint.
    #[test]
    fn test_remap_response_tool_calls_rewrites_only_colliding_ids() {
        let normalizer = normalizer();
        normalizer.seed_from(&history_with(&["Bash_0"]));

        let mut response = crate::turn_loop::types::LLMChatResponse {
            content: String::new(),
            thinking: Vec::new(),
            tool_calls: vec![call("Bash_0"), call("fresh_1"), call("")],
            finish_reason: Some("tool_calls".into()),
            usage: crate::rpc::types::TokenUsage::default(),
        };
        remap_response_tool_calls(&mut response, &normalizer.begin_response());

        assert_eq!(response.tool_calls[0].id, "Bash_0__2");
        assert_eq!(response.tool_calls[1].id, "fresh_1");
        assert_eq!(
            response.tool_calls[2].id, "",
            "an empty id is the step's to mint, not the ledger's"
        );
    }

    /// An id seeded from history is taken even before anything claims it.
    #[test]
    fn test_seeded_ids_are_taken() {
        let normalizer = normalizer();
        assert!(!normalizer.is_taken("Bash_0"));
        normalizer.seed_from(&history_with(&["Bash_0"]));
        assert!(normalizer.is_taken("Bash_0"));
        // A claim releases nothing until rollback.
        let response = normalizer.begin_response();
        response.remap_streamed_id("taken_1", None);
        assert!(normalizer.is_taken("taken_1"));
        response.rollback();
        assert!(!normalizer.is_taken("taken_1"));
    }
}
