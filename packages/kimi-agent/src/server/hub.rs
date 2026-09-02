//! Fan-out bridge from the in-process [`EventBus`] to per-connection
//! subscribers, which is how an engine turn's events reach a WebSocket client.
//!
//! The bus delivers synchronously (`publish` calls each handler while holding
//! the subscriber read lock), so a handler that blocks would stall the turn
//! loop, and one that unsubscribed would deadlock on the write lock. Each
//! therefore owns a bounded `mpsc` queue and the handler only ever does a
//! non-blocking `try_send`.
//!
//! Backpressure policy: **a slow connection is closed, not silently truncated.**
//! The TS broadcaster (`kap-server`'s `sessionEventBroadcaster`) serializes per
//! connection behind an await chain and so absorbs bursts by growing that chain;
//! mirroring it here would mean unbounded memory per connection. Once a queue is
//! full the subscription records the reason and the connection is closed with
//! 1013 — a client that reconnects and replays from the transcript sees a gap
//! it can detect, where dropped-into-the-socket events would not be visible at
//! all. This is a deliberate divergence from the TS behaviour, not parity with
//! it; see ROADMAP P77.

use std::sync::Arc;

use tokio::sync::{mpsc, watch};

use crate::events::{EngineEvent, EventBus, Subscription};

/// Events buffered for one connection before it counts as slow.
pub const SUBSCRIBER_QUEUE_DEPTH: usize = 256;

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

/// Handle to the engine event bus, cheap to clone into a connection task.
#[derive(Clone)]
pub struct EventHub {
    bus: Arc<EventBus>,
}

impl EventHub {
    pub fn new(bus: Arc<EventBus>) -> Self {
        Self { bus }
    }

    /// The bus a pipeline's counting wrapper should be given, so engine events
    /// and this fan-out share one source.
    pub fn bus(&self) -> &Arc<EventBus> {
        &self.bus
    }

    /// Live subscription count, for observability and for proving a closed
    /// connection released its slot.
    pub fn subscriber_count(&self) -> usize {
        self.bus.subscriber_count()
    }

    /// Attach a connection to the bus. The subscription ends when the returned
    /// [`WsSubscription`] is dropped.
    pub fn attach(&self) -> WsSubscription {
        let (sender, receiver) = mpsc::channel(SUBSCRIBER_QUEUE_DEPTH);
        let (state_sender, state) = watch::channel(STATE_OPEN);

        let id = self.bus.subscribe(move |event| {
            if sender.try_send(event.clone()).is_err() {
                // Distinguish a full queue (peer too slow) from a dropped
                // receiver (our own connection already gone). The handler only
                // touches its own channel and watch — never the bus — because
                // publish() holds the subscriber read lock, and unsubscribing
                // from in here would deadlock on the write lock.
                let reason = if sender.is_closed() {
                    STATE_DETACHED
                } else {
                    STATE_OVERFLOW
                };
                let _ = state_sender.send(reason);
            }
        });

        WsSubscription {
            bus: self.bus.clone(),
            id,
            receiver,
            state,
        }
    }
}

/// One connection's view of the event stream.
pub struct WsSubscription {
    bus: Arc<EventBus>,
    id: Subscription,
    receiver: mpsc::Receiver<EngineEvent>,
    state: watch::Receiver<u8>,
}

impl WsSubscription {
    /// Next event, or why the stream ended.
    ///
    /// Events already buffered are handed over first, so a connection that kept
    /// up until the burst receives a contiguous prefix and then the close —
    /// rather than losing a prefix it could have used. Cancel-safe: waiting is
    /// all it does, so it can sit in a `select!` arm alongside socket reads.
    pub async fn recv(&mut self) -> Result<EngineEvent, HubClosed> {
        loop {
            if let Ok(event) = self.receiver.try_recv() {
                return Ok(event);
            }
            if *self.state.borrow() != STATE_OPEN {
                return Err(closed_reason(*self.state.borrow()));
            }

            tokio::select! {
                biased;
                next = self.receiver.recv() => {
                    match next {
                        Some(event) => return Ok(event),
                        // The sender lives in the bus handler, so a closed
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

impl Drop for WsSubscription {
    fn drop(&mut self) {
        // Runs on the connection task, never inside a bus handler, so taking
        // the write lock here is safe.
        self.bus.unsubscribe(self.id);
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
        let hub = EventHub::new(Arc::new(EventBus::new()));
        let mut sub = hub.attach();

        hub.bus().publish(&step_event(1));
        assert_eq!(sub.recv().await.unwrap().event_type(), "llm.step.begin");

        // Anything published before attach is not replayed — the transcript is
        // the replay source, not this hub.
        drop(sub);
        assert_eq!(hub.subscriber_count(), 0, "dropping leaked a slot");
    }

    #[tokio::test]
    async fn each_subscriber_sees_the_same_events_in_order() {
        let hub = EventHub::new(Arc::new(EventBus::new()));
        let mut first = hub.attach();
        let mut second = hub.attach();
        assert_eq!(hub.subscriber_count(), 2);

        for step in 1..=3 {
            hub.bus().publish(&step_event(step));
        }
        for expected in 1..=3 {
            let EngineEvent::LlmStepBegin { step, .. } = first.recv().await.unwrap() else {
                panic!("wrong variant on first subscriber");
            };
            assert_eq!(step, expected);
            let EngineEvent::LlmStepBegin { step, .. } = second.recv().await.unwrap() else {
                panic!("wrong variant on second subscriber");
            };
            assert_eq!(step, expected);
        }
    }

    #[tokio::test]
    async fn a_subscriber_that_stops_reading_reports_overflow_not_silent_loss() {
        let hub = EventHub::new(Arc::new(EventBus::new()));
        let mut sub = hub.attach();

        // Fill the queue and push past it without ever calling recv().
        for step in 0..SUBSCRIBER_QUEUE_DEPTH as u32 {
            hub.bus().publish(&step_event(step));
        }
        hub.bus().publish(&step_event(u32::MAX));

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
    async fn publishing_does_not_run_a_handler_that_can_reenter_the_bus() {
        // Guards the design constraint the bounded queue exists for: a handler
        // that unsubscribes from inside publish() would deadlock on the write
        // lock, so teardown must happen on the connection side only.
        let bus = Arc::new(EventBus::new());
        let hub = EventHub::new(bus.clone());
        let sub = hub.attach();
        assert_eq!(hub.subscriber_count(), 1);

        hub.bus().publish(&step_event(1));
        drop(sub);
        hub.bus().publish(&step_event(2));
        assert_eq!(hub.subscriber_count(), 0);
    }
}
