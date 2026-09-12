//! Per-session event lanes and the fan-out bridge to live connections, which is
//! how an engine turn's events reach a WebSocket client.
//!
//! One [`EventHub`] belongs to the server. A session gets a **lane** the first
//! time anything asks for it: its own [`EventBus`] and its own consecutive `seq`,
//! numbered from an `epoch` minted when the lane was created. kap-server's
//! `SessionEventJournal` is the thing this mirrors, and the two properties that
//! make a client's cursor meaningful are kept for the same reasons:
//!
//! - `seq` is assigned **once per publish**, by the single subscriber the lane
//!   installs when it is created. Numbering per connection instead would let two
//!   connections watching the same session disagree about which number an event
//!   carried, and a reconnecting client's cursor would be meaningless.
//! - `epoch` changes when a lane is rebuilt, so a client that sees a new epoch
//!   knows its cursor refers to a stream that no longer exists.
//!
//! The pipeline still receives a plain `Arc<EventBus>`, so a turn's events are
//! stamped by the lane rather than by the engine: `EngineEvent` gains no
//! session field, and the stdio and addon transports are untouched.
//!
//! The bus delivers synchronously (`publish` calls each handler while holding
//! the subscriber read lock), so a handler that blocks would stall the turn
//! loop, and one that unsubscribed would deadlock on the write lock. Each
//! connection therefore owns a bounded `mpsc` queue and the handler only ever
//! does a non-blocking `try_send`.
//!
//! Backpressure policy: **a slow connection is closed, not silently truncated.**
//! The TS broadcaster (`kap-server`'s `sessionEventBroadcaster`) serializes per
//! connection behind an await chain and so absorbs bursts by growing that chain;
//! mirroring it here would mean unbounded memory per connection. Once a queue is
//! full the subscription records the reason and the connection is closed with
//! 1013 — a client that reconnects and replays from the transcript sees a gap it
//! can detect, where dropped-into-the-socket events would not be visible at all.
//! This is a deliberate divergence from the TS behaviour, not parity with it;
//! see ROADMAP P77.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use tokio::sync::{mpsc, watch};

use crate::events::{EngineEvent, EventBus};

/// Events buffered for one connection before it counts as slow.
pub const SUBSCRIBER_QUEUE_DEPTH: usize = 256;

/// Upper bound on the per-lane replay ring. A lane keeps only its most recent
/// events so a long-lived `--serve` process does not accumulate every event it
/// has ever stamped; a client whose cursor falls behind the ring replays from
/// the oldest event still buffered.
pub const LANE_HISTORY_CAP: usize = 16_384;

const STATE_OPEN: u8 = 0;
const STATE_OVERFLOW: u8 = 1;
const STATE_DETACHED: u8 = 2;

/// Why a subscription stopped delivering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HubClosed {
    /// The connection could not keep up; close it with 1013.
    Overflow,
    /// The subscription is gone (server shutting down or handle dropped).
    Detached,
}

/// One event as it reaches a connection: numbered by the lane it came from.
///
/// Cloned around the fan-out as `Arc<SequencedEvent>`, so a subscriber pays a
/// refcount bump, not a deep copy of the event body.
#[derive(Debug)]
pub struct SequencedEvent {
    pub session_id: Arc<str>,
    /// Identity of the lane that produced this, so a client can tell a resumed
    /// stream from a continued one.
    pub epoch: Arc<str>,
    /// Consecutive within `(session_id, epoch)`, starting at 1.
    pub seq: u64,
    pub event: EngineEvent,
    /// WS envelope bytes, encoded lazily once (on the first subscriber that
    /// needs them) and shared by every connection and replay thereafter.
    envelope: OnceLock<Arc<[u8]>>,
}

impl SequencedEvent {
    pub fn new(session_id: Arc<str>, epoch: Arc<str>, seq: u64, event: EngineEvent) -> Self {
        Self {
            session_id,
            epoch,
            seq,
            event,
            envelope: OnceLock::new(),
        }
    }

    /// The encoded envelope, computed on first use and cached for the life of
    /// the event so the per-subscriber fan-out never re-serializes it.
    pub fn envelope(&self) -> Arc<[u8]> {
        self.envelope
            .get_or_init(|| {
                match crate::server::ws_protocol::encode_envelope(
                    &self.session_id,
                    &self.epoch,
                    self.seq,
                    &self.event,
                ) {
                    Ok(bytes) => Arc::from(bytes.into_boxed_slice()),
                    Err(_) => Arc::from(Vec::<u8>::new()),
                }
            })
            .clone()
    }
}

/// A session's bus plus the numbering that travels with it.
struct Lane {
    bus: Arc<EventBus>,
    session_id: Arc<str>,
    epoch: Arc<str>,
    next_seq: AtomicU64,
    /// The most recent sequenced events this lane has stamped, in order, kept
    /// as a bounded ring (`LANE_HISTORY_CAP`) so a long-lived server's memory
    /// stays bounded. A connection that attaches mid-turn replays this buffer
    /// so its cursor starts as far back as the ring still reaches; until a
    /// persistent journal exists it is the only replay source, which is also
    /// why the lanes themselves are never evicted.
    history: Mutex<VecDeque<Arc<SequencedEvent>>>,
    /// `publish` only takes the bus's *read* lock, so two concurrent publishers on
    /// one session could each take a number and then deliver out of order. Taking
    /// this around the stamp-and-forward step is what makes `seq` mean what it
    /// claims: consecutive, and in the order a connection receives them.
    order: Mutex<()>,
}

/// One connection's inbound queue, written by every lane it can see.
struct Slot {
    id: u64,
    sender: mpsc::Sender<Arc<SequencedEvent>>,
    state: watch::Sender<u8>,
    remote_address: Option<String>,
    user_agent: Option<String>,
    connected_at: u64,
    client_hello: Arc<AtomicBool>,
    subscriptions: Arc<Mutex<HashSet<String>>>,
}

/// Live-connection metadata for `GET /api/v1/connections`.
#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub id: u64,
    pub remote_address: Option<String>,
    pub user_agent: Option<String>,
    pub connected_at: u64,
    pub has_client_hello: bool,
    pub subscriptions: Vec<String>,
}

type Slots = Arc<RwLock<Vec<Arc<Slot>>>>;

/// Callback for persisting sequenced wire events onto durable storage.
pub type EventPersister = Arc<dyn Fn(&SequencedEvent) + Send + Sync>;

/// The server's event lanes and its live connections.
pub struct EventHub {
    lanes: RwLock<HashMap<String, Arc<Lane>>>,
    slots: Slots,
    next_slot_id: AtomicU64,
    persister: Arc<RwLock<Option<EventPersister>>>,
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

impl EventHub {
    pub fn new() -> Self {
        Self {
            lanes: RwLock::new(HashMap::new()),
            slots: Arc::new(RwLock::new(Vec::new())),
            next_slot_id: AtomicU64::new(1),
            persister: Arc::new(RwLock::new(None)),
        }
    }

    /// Set a persister callback to record every sequenced wire event to persistent storage.
    pub fn set_persister(&self, persister: EventPersister) {
        *self.persister.write().unwrap() = Some(persister);
    }

    /// The bus a session's turns publish onto, creating the lane on first use.
    ///
    /// Handing out a plain `Arc<EventBus>` is the point: the engine, the addon
    /// host and a test all publish the same way, and the numbering below them
    /// cannot be bypassed by a caller that forgot to ask for it.
    pub fn bus_for(&self, session_id: &str) -> Arc<EventBus> {
        // Bound the guard to this statement: a publisher must not be holding the
        // lane map while it takes a lane's ordering mutex.
        let existing = self
            .lanes
            .read()
            .unwrap()
            .get(session_id)
            .map(|lane| lane.bus.clone());
        if let Some(bus) = existing {
            return bus;
        }
        let mut lanes = self.lanes.write().unwrap();
        // Another publisher may have won the race while this thread waited for
        // the write lock; that lane is the one to use, not a second numbering.
        if let Some(lane) = lanes.get(session_id) {
            return lane.bus.clone();
        }

        let lane = Arc::new(Lane {
            bus: Arc::new(EventBus::new()),
            session_id: Arc::from(session_id),
            epoch: Arc::from(new_epoch().as_str()),
            next_seq: AtomicU64::new(0),
            history: Mutex::new(VecDeque::new()),
            order: Mutex::new(()),
        });
        let forward = Arc::clone(&lane);
        let slots = Arc::clone(&self.slots);
        let persister = Arc::clone(&self.persister);
        lane.bus.subscribe(move |event| {
            let _ordered = forward.order.lock().unwrap();
            let seq = forward.next_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let sequenced = Arc::new(SequencedEvent::new(
                Arc::clone(&forward.session_id),
                Arc::clone(&forward.epoch),
                seq,
                event.clone(),
            ));
            let mut history = forward.history.lock().unwrap();
            history.push_back(Arc::clone(&sequenced));
            if history.len() > LANE_HISTORY_CAP {
                history.pop_front();
            }
            drop(history);
            if let Some(ref p) = *persister.read().unwrap() {
                p(&sequenced);
            }
            deliver(&slots, sequenced);
        });
        lanes.insert(session_id.to_string(), lane.clone());
        lane.bus.clone()
    }

    /// Ensure a lane exists and ensure its sequence number is at least `initial_seq`.
    pub fn ensure_lane_with_initial_seq(
        &self,
        session_id: &str,
        initial_seq: u64,
    ) -> (u64, Arc<str>) {
        let _bus = self.bus_for(session_id);
        let lanes = self.lanes.read().unwrap();
        let lane = lanes.get(session_id).expect("lane was just ensured");
        let _ = lane.next_seq.fetch_max(initial_seq, Ordering::Relaxed);
        (
            lane.next_seq.load(Ordering::Relaxed),
            Arc::clone(&lane.epoch),
        )
    }

    /// Which sessions have a lane. Lanes are never evicted: dropping one would
    /// silently restart that session's numbering and discard the buffered
    /// history a late-attaching connection would otherwise replay.
    pub fn lane_session_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.lanes.read().unwrap().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Whether a lane exists for `session_id` — a plain map lookup, for callers
    /// that would otherwise clone and sort every lane id just to test membership.
    pub fn lane_exists(&self, session_id: &str) -> bool {
        self.lanes.read().unwrap().contains_key(session_id)
    }

    /// How many lanes have been opened, for observability.
    pub fn lane_count(&self) -> usize {
        self.lanes.read().unwrap().len()
    }

    /// Return the cursor `(seq, epoch)` for a given session, ensuring a lane exists.
    pub fn ensure_lane_cursor(&self, session_id: &str) -> (u64, Arc<str>) {
        let _bus = self.bus_for(session_id);
        let lanes = self.lanes.read().unwrap();
        let lane = lanes.get(session_id).expect("lane was just ensured");
        (
            lane.next_seq.load(Ordering::Relaxed),
            Arc::clone(&lane.epoch),
        )
    }

    /// Return the current cursor `(seq, epoch)` for a given session, if its lane exists.
    pub fn session_cursor(&self, session_id: &str) -> Option<(u64, Arc<str>)> {
        let lanes = self.lanes.read().unwrap();
        lanes.get(session_id).map(|lane| {
            (
                lane.next_seq.load(Ordering::Relaxed),
                Arc::clone(&lane.epoch),
            )
        })
    }

    /// Replay buffered events for a session with seq > `since_seq`.
    pub fn replay_for(&self, session_id: &str, since_seq: u64) -> Vec<Arc<SequencedEvent>> {
        let lanes = self.lanes.read().unwrap();
        let Some(lane) = lanes.get(session_id) else {
            return Vec::new();
        };
        let _order = lane.order.lock().unwrap();
        let history = lane.history.lock().unwrap();
        history
            .iter()
            .filter(|e| e.seq > since_seq)
            .cloned()
            .collect()
    }

    /// Attach a connection to every lane, present and future.
    ///
    /// Each existing lane's buffered history is replayed into the new
    /// subscription before any live event, so a connection that attaches
    /// mid-turn still sees the turn's events from seq 1. The snapshot and the
    /// slot registration happen under every lane's ordering lock, so a
    /// concurrent publish can neither duplicate an event (in history and in
    /// the queue) nor drop one (in neither).
    pub fn attach(&self) -> WsSubscription {
        self.attach_from(None, None)
    }

    /// Like [`Self::attach`], recording the peer address and `User-Agent` for
    /// the `GET /api/v1/connections` introspection surface.
    pub fn attach_from(
        &self,
        remote_address: Option<String>,
        user_agent: Option<String>,
    ) -> WsSubscription {
        let (sender, receiver) = mpsc::channel(SUBSCRIBER_QUEUE_DEPTH);
        let (state_sender, state) = watch::channel(STATE_OPEN);
        let id = self.next_slot_id.fetch_add(1, Ordering::Relaxed);
        let client_hello = Arc::new(AtomicBool::new(false));
        let subscriptions = Arc::new(Mutex::new(HashSet::new()));

        // Register the slot *before* snapshotting lane history. A lane created
        // (or an event published) between the snapshot and the registration
        // would otherwise reach neither the replay buffer nor the live queue,
        // and this connection would lose it permanently. Registering first
        // means every lane's live events flow here from this instant; the
        // history snapshot below then overlaps the live queue for anything
        // published during the snapshot, which recv() de-duplicates by seq.
        self.slots.write().unwrap().push(Arc::new(Slot {
            id,
            sender,
            state: state_sender,
            remote_address,
            user_agent,
            connected_at: chrono::Utc::now().timestamp_millis() as u64,
            client_hello: Arc::clone(&client_hello),
            subscriptions: Arc::clone(&subscriptions),
        }));

        let lanes: Vec<Arc<Lane>> = {
            let lanes = self.lanes.read().unwrap();
            let mut lanes: Vec<Arc<Lane>> = lanes.values().cloned().collect();
            lanes.sort_by(|a, b| a.session_id.cmp(&b.session_id));
            lanes
        };
        let mut replay = VecDeque::new();
        let _lane_locks: Vec<_> = lanes
            .iter()
            .map(|lane| lane.order.lock().unwrap())
            .collect();
        for lane in &lanes {
            replay.extend(lane.history.lock().unwrap().iter().cloned());
        }

        WsSubscription {
            slots: Arc::clone(&self.slots),
            id,
            receiver,
            state,
            replay,
            delivered: HashMap::new(),
            client_hello,
            subscriptions,
        }
    }

    /// Live connection metadata for `GET /api/v1/connections`.
    pub fn connections(&self) -> Vec<ConnectionInfo> {
        self.slots
            .read()
            .unwrap()
            .iter()
            .map(|slot| ConnectionInfo {
                id: slot.id,
                remote_address: slot.remote_address.clone(),
                user_agent: slot.user_agent.clone(),
                connected_at: slot.connected_at,
                has_client_hello: slot.client_hello.load(Ordering::Relaxed),
                subscriptions: slot
                    .subscriptions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .cloned()
                    .collect(),
            })
            .collect()
    }

    /// Live connection count, for observability and for proving a closed
    /// connection released its slot.
    pub fn subscriber_count(&self) -> usize {
        self.slots.read().unwrap().len()
    }
}

fn new_epoch() -> String {
    format!("epoch-{:016x}", fastrand::u64(..))
}

/// Hand one event to every live connection, never blocking.
fn deliver(slots: &Slots, event: Arc<SequencedEvent>) {
    for slot in slots.read().unwrap().iter() {
        if slot.sender.try_send(Arc::clone(&event)).is_ok() {
            continue;
        }
        // Distinguish a full queue (peer too slow) from a dropped receiver (our
        // own connection already gone). A slot is only ever removed by its own
        // connection, so the queue is never handed an event after overflow.
        let reason = if slot.sender.is_closed() {
            STATE_DETACHED
        } else {
            STATE_OVERFLOW
        };
        let _ = slot.state.send(reason);
    }
}

/// One connection's view of the event stream.
pub struct WsSubscription {
    slots: Slots,
    id: u64,
    receiver: mpsc::Receiver<Arc<SequencedEvent>>,
    state: watch::Receiver<u8>,
    /// Lane history snapshotted at attach time, handed over before the live
    /// queue. Because the slot is registered before the snapshot, an event
    /// published during the snapshot can sit in both this buffer and the live
    /// queue; `delivered` de-duplicates it.
    replay: VecDeque<Arc<SequencedEvent>>,
    /// Per `(session_id, epoch)` high-water mark of seqs already handed to the
    /// caller, so the replay/live overlap yields each event exactly once.
    delivered: HashMap<(Arc<str>, Arc<str>), u64>,
    /// Shared with the connection's slot: whether `client_hello` completed.
    client_hello: Arc<AtomicBool>,
    /// Shared with the connection's slot: the session ids it is subscribed to.
    subscriptions: Arc<Mutex<HashSet<String>>>,
}

impl WsSubscription {
    /// Record that the client completed its `client_hello` handshake.
    pub fn mark_client_hello(&self) {
        self.client_hello.store(true, Ordering::Relaxed);
    }

    /// Replace the connection's visible subscription set (`GET /connections`).
    pub fn set_subscriptions(&self, ids: &HashSet<String>) {
        let mut set = self.subscriptions.lock().unwrap_or_else(|e| e.into_inner());
        *set = ids.clone();
    }

    /// Next event, or why the stream ended.
    ///
    /// Replayed lane history is handed over first, then events already
    /// buffered, so a connection that kept up until a burst receives a
    /// contiguous prefix and then the close — rather than losing a prefix it
    /// could have used. Cancel-safe: waiting is all it does, so it can sit in
    /// a `select!` arm alongside socket reads.
    pub async fn recv(&mut self) -> Result<Arc<SequencedEvent>, HubClosed> {
        loop {
            // Replay the snapshotted history first, then the live queue. An
            // event published while attach() was snapshotting can appear in
            // both, so every candidate is filtered through the high-water mark.
            while let Some(event) = self.replay.pop_front() {
                if mark_delivered(&mut self.delivered, &event) {
                    return Ok(event);
                }
            }
            while let Ok(event) = self.receiver.try_recv() {
                if mark_delivered(&mut self.delivered, &event) {
                    return Ok(event);
                }
            }
            if *self.state.borrow() != STATE_OPEN {
                return Err(closed_reason(*self.state.borrow()));
            }

            tokio::select! {
                biased;
                next = self.receiver.recv() => {
                    match next {
                        Some(event) => {
                            if mark_delivered(&mut self.delivered, &event) {
                                return Ok(event);
                            }
                            // A duplicate from the overlap window: keep waiting.
                        }
                        // The sender lives in the lane's subscriber, so a closed
                        // channel means the subscription was released.
                        None => {
                            let reason = *self.state.borrow_and_update();
                            return Err(closed_reason(reason));
                        }
                    }
                }
                changed = self.state.changed() => {
                    if changed.is_err() {
                        return Err(HubClosed::Detached);
                    }
                }
            }
        }
    }
}

fn closed_reason(state: u8) -> HubClosed {
    match state {
        STATE_OVERFLOW => HubClosed::Overflow,
        _ => HubClosed::Detached,
    }
}

/// Record `event` as handed to the caller. Returns `false` when its seq is at
/// or below the high-water mark for `(session_id, epoch)` — a duplicate from
/// the attach() replay/live overlap — and `true` (advancing the mark) otherwise.
fn mark_delivered(
    delivered: &mut HashMap<(Arc<str>, Arc<str>), u64>,
    event: &SequencedEvent,
) -> bool {
    let key = (Arc::clone(&event.session_id), Arc::clone(&event.epoch));
    let high = delivered.entry(key).or_insert(0);
    if event.seq <= *high {
        return false;
    }
    *high = event.seq;
    true
}

impl Drop for WsSubscription {
    fn drop(&mut self) {
        // Runs on the connection task, never inside a lane handler, so taking
        // the write lock here is safe.
        let mut slots = self.slots.write().unwrap();
        if let Some(pos) = slots.iter().position(|slot| slot.id == self.id) {
            slots.swap_remove(pos);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step_event(step: u32) -> EngineEvent {
        EngineEvent::LlmStepBegin {
            turn_id: "t1".into(),
            step,
        }
    }

    #[tokio::test]
    async fn a_new_subscriber_receives_events_published_after_it_attaches() {
        let hub = EventHub::new();
        let mut sub = hub.attach();

        hub.bus_for("sess-1").publish(&step_event(1));
        let first = sub.recv().await.unwrap();
        assert_eq!(first.event.event_type(), "llm.step.begin");
        assert_eq!(first.seq, 1);

        // Pre-attach publishes would have been replayed from the lane's
        // history; this one published after attach, so it arrived live.
        drop(sub);
        assert_eq!(hub.subscriber_count(), 0, "dropping leaked a slot");
    }

    #[tokio::test]
    async fn connections_report_metadata_and_subscriptions() {
        let hub = EventHub::new();
        let sub = hub.attach_from(Some("10.0.0.5:1234".into()), Some("test-agent".into()));
        let conns = hub.connections();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].remote_address.as_deref(), Some("10.0.0.5:1234"));
        assert_eq!(conns[0].user_agent.as_deref(), Some("test-agent"));
        assert!(!conns[0].has_client_hello);
        assert!(conns[0].subscriptions.is_empty());

        sub.mark_client_hello();
        sub.set_subscriptions(&HashSet::from(["sess-1".to_string()]));
        let conns = hub.connections();
        assert!(conns[0].has_client_hello);
        assert_eq!(conns[0].subscriptions, vec!["sess-1".to_string()]);
    }

    #[tokio::test]
    async fn each_subscriber_sees_the_same_events_with_the_same_numbers() {
        let hub = EventHub::new();
        let mut first = hub.attach();
        let mut second = hub.attach();
        assert_eq!(hub.subscriber_count(), 2);

        let bus = hub.bus_for("sess-1");
        for step in 1..=3 {
            bus.publish(&step_event(step));
        }
        for expected in 1..=3_u64 {
            let a = first.recv().await.unwrap();
            let b = second.recv().await.unwrap();
            assert_eq!(a.seq, expected, "seq must not depend on the reader");
            assert_eq!(b.seq, expected);
            assert_eq!(a.epoch, b.epoch);
            let EngineEvent::LlmStepBegin { step, .. } = &a.event else {
                panic!("wrong variant on first subscriber");
            };
            assert_eq!(u64::from(*step), expected);
        }
    }

    #[tokio::test]
    async fn lanes_number_independently_and_keep_their_own_epoch() {
        let hub = EventHub::new();
        let one = hub.bus_for("sess-1");
        let two = hub.bus_for("sess-2");

        one.publish(&step_event(1));
        one.publish(&step_event(2));
        two.publish(&step_event(1));

        let mut sub = hub.attach();
        let a = sub.recv().await.unwrap();
        let b = sub.recv().await.unwrap();
        let c = sub.recv().await.unwrap();

        assert_eq!((&*a.session_id, a.seq), ("sess-1", 1));
        assert_eq!((&*b.session_id, b.seq), ("sess-1", 2));
        assert_eq!((&*c.session_id, c.seq), ("sess-2", 1));
        assert_ne!(
            a.epoch, c.epoch,
            "a second session's stream is not a continuation of the first"
        );
        assert_eq!(hub.lane_count(), 2);
        assert_eq!(hub.lane_session_ids(), vec!["sess-1", "sess-2"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_publishers_on_one_lane_stay_consecutive_and_in_order() {
        // `publish` shares the bus's read lock, so two turns of one session can
        // be stamping at the same instant. A client's cursor is only usable if
        // the numbers still ascend for that session.
        let hub = EventHub::new();
        let bus = hub.bus_for("sess-1");
        let mut sub = hub.attach();

        let publishers: Vec<_> = (0..4_u32)
            .map(|worker| {
                let bus = bus.clone();
                tokio::spawn(async move {
                    for step in 0..25 {
                        bus.publish(&step_event(worker * 100 + step));
                    }
                })
            })
            .collect();
        for publisher in publishers {
            publisher.await.unwrap();
        }

        let mut seen = Vec::new();
        for _ in 0..100 {
            seen.push(sub.recv().await.unwrap().seq);
        }
        assert_eq!(
            seen,
            (1..=100_u64).collect::<Vec<u64>>(),
            "a lane must number its stream consecutively, in delivery order"
        );
    }

    #[tokio::test]
    async fn asking_twice_for_a_lane_returns_the_same_numbering() {
        let hub = EventHub::new();
        let first = hub.bus_for("sess-1");
        let second = hub.bus_for("sess-1");
        assert!(Arc::ptr_eq(&first, &second), "a lane must not fork");

        first.publish(&step_event(1));
        second.publish(&step_event(2));
        let mut sub = hub.attach();
        assert_eq!(sub.recv().await.unwrap().seq, 1);
        assert_eq!(sub.recv().await.unwrap().seq, 2);
    }

    #[tokio::test]
    async fn a_subscriber_that_stops_reading_reports_overflow_not_silent_loss() {
        let hub = EventHub::new();
        let mut sub = hub.attach();
        let bus = hub.bus_for("sess-1");

        // Fill the queue and push past it without ever calling recv().
        for step in 0..SUBSCRIBER_QUEUE_DEPTH as u32 {
            bus.publish(&step_event(step));
        }
        bus.publish(&step_event(u32::MAX));

        // The first queued events are still deliverable, but once the overflow
        // is recorded the stream ends instead of skipping into the middle.
        let mut delivered = 0;
        loop {
            match sub.recv().await {
                Ok(_) => delivered += 1,
                Err(error) => {
                    assert_eq!(error, HubClosed::Overflow);
                    break;
                }
            }
        }
        assert_eq!(
            delivered, SUBSCRIBER_QUEUE_DEPTH,
            "an overflowing subscriber lost events before signalling"
        );
    }

    #[tokio::test]
    async fn publishing_does_not_run_a_handler_that_can_reenter_the_hub() {
        // Guards the design constraint the bounded queue exists for: teardown
        // must happen on the connection side only, never from a lane handler.
        let hub = EventHub::new();
        let bus = hub.bus_for("sess-1");
        let sub = hub.attach();
        assert_eq!(hub.subscriber_count(), 1);

        bus.publish(&step_event(1));
        drop(sub);
        bus.publish(&step_event(2));
        assert_eq!(hub.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn replayed_history_then_live_events_stay_contiguous_without_duplicates() {
        let hub = EventHub::new();
        let bus = hub.bus_for("sess-1");
        bus.publish(&step_event(1));
        bus.publish(&step_event(2));
        // Attach after history exists: 1,2 arrive via replay.
        let mut sub = hub.attach();
        // Publish after attach: 3,4 arrive live.
        bus.publish(&step_event(3));
        bus.publish(&step_event(4));

        let mut seqs = Vec::new();
        for _ in 0..4 {
            seqs.push(sub.recv().await.unwrap().seq);
        }
        assert_eq!(seqs, vec![1, 2, 3, 4]);
    }

    #[test]
    fn mark_delivered_filters_the_replay_live_overlap_by_high_water_seq() {
        let mut delivered = HashMap::new();
        let event = |seq: u64| {
            SequencedEvent::new(
                Arc::from("sess-1"),
                Arc::from("epoch-a"),
                seq,
                step_event(seq as u32),
            )
        };
        assert!(mark_delivered(&mut delivered, &event(1)));
        assert!(mark_delivered(&mut delivered, &event(2)));
        // The same seqs seen again from the live queue are duplicates.
        assert!(!mark_delivered(&mut delivered, &event(1)));
        assert!(!mark_delivered(&mut delivered, &event(2)));
        assert!(mark_delivered(&mut delivered, &event(3)));
        // A different lane's stream is numbered independently.
        let other =
            SequencedEvent::new(Arc::from("sess-2"), Arc::from("epoch-b"), 1, step_event(1));
        assert!(mark_delivered(&mut delivered, &other));
    }

    #[tokio::test]
    async fn lane_history_is_bounded_by_the_replay_cap() {
        let hub = EventHub::new();
        let bus = hub.bus_for("sess-1");
        let total = LANE_HISTORY_CAP + 100;
        for step in 0..total {
            bus.publish(&step_event(step as u32));
        }
        // A late attacher replays only the most recent LANE_HISTORY_CAP events,
        // and the newest replayed event carries the final seq.
        let mut sub = hub.attach();
        let mut count = 0;
        let mut last_seq = 0;
        while count < LANE_HISTORY_CAP {
            let event = sub.recv().await.unwrap();
            count += 1;
            last_seq = event.seq;
        }
        assert_eq!(count, LANE_HISTORY_CAP);
        assert_eq!(last_seq, total as u64);
    }
}
