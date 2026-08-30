//! In-process broadcast EventBus for kimi-agent.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use super::types::EngineEvent;

pub type EventHandler = Arc<dyn Fn(&EngineEvent) + Send + Sync + 'static>;

/// Subscription token used to unsubscribe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Subscription(u64);

struct SubscriberEntry {
    id: Subscription,
    handler: EventHandler,
    filter: Option<String>,
}

/// Thread-safe in-process event bus allowing decoupled publishing and subscription.
#[derive(Default)]
pub struct EventBus {
    next_id: AtomicU64,
    subscribers: RwLock<Vec<SubscriberEntry>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            subscribers: RwLock::new(Vec::new()),
        }
    }

    /// Subscribe to all events published to the bus.
    pub fn subscribe<F>(&self, handler: F) -> Subscription
    where
        F: Fn(&EngineEvent) + Send + Sync + 'static,
    {
        let id = Subscription(self.next_id.fetch_add(1, Ordering::Relaxed));
        let mut subs = self.subscribers.write().unwrap();
        subs.push(SubscriberEntry {
            id,
            handler: Arc::new(handler),
            filter: None,
        });
        id
    }

    /// Subscribe only to events matching a specific event type name (e.g. `"tool.native"`).
    pub fn subscribe_filtered<F>(&self, event_type: impl Into<String>, handler: F) -> Subscription
    where
        F: Fn(&EngineEvent) + Send + Sync + 'static,
    {
        let id = Subscription(self.next_id.fetch_add(1, Ordering::Relaxed));
        let mut subs = self.subscribers.write().unwrap();
        subs.push(SubscriberEntry {
            id,
            handler: Arc::new(handler),
            filter: Some(event_type.into()),
        });
        id
    }

    /// Remove a subscriber by subscription token.
    pub fn unsubscribe(&self, sub: Subscription) -> bool {
        let mut subs = self.subscribers.write().unwrap();
        if let Some(pos) = subs.iter().position(|s| s.id == sub) {
            subs.swap_remove(pos);
            true
        } else {
            false
        }
    }

    /// Publish an event to all matching subscribers.
    pub fn publish(&self, event: &EngineEvent) {
        let subs = self.subscribers.read().unwrap();
        let ev_type = event.event_type();
        for sub in subs.iter() {
            if let Some(ref filter) = sub.filter
                && filter != ev_type
            {
                continue;
            }
            (sub.handler)(event);
        }
    }

    /// Publish a raw JSON value (automatically parsed into [`EngineEvent`]).
    pub fn publish_json(&self, value: serde_json::Value) {
        let event = EngineEvent::from_json(value);
        self.publish(&event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn test_event_bus_broadcast() {
        let bus = EventBus::new();
        let count = Arc::new(AtomicUsize::new(0));

        let count_clone = count.clone();
        let sub = bus.subscribe(move |_| {
            count_clone.fetch_add(1, Ordering::Relaxed);
        });

        bus.publish(&EngineEvent::LlmStepBegin {
            turn_id: "turn-1".into(),
            step: 1,
        });
        bus.publish(&EngineEvent::LlmStepBegin {
            turn_id: "turn-1".into(),
            step: 2,
        });

        assert_eq!(count.load(Ordering::Relaxed), 2);

        assert!(bus.unsubscribe(sub));
        bus.publish(&EngineEvent::LlmStepBegin {
            turn_id: "turn-1".into(),
            step: 3,
        });
        assert_eq!(count.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn test_filtered_subscription() {
        let bus = EventBus::new();
        let tool_events = Arc::new(AtomicUsize::new(0));

        let c = tool_events.clone();
        bus.subscribe_filtered("tool.native", move |_| {
            c.fetch_add(1, Ordering::Relaxed);
        });

        bus.publish(&EngineEvent::LlmStepBegin {
            turn_id: "turn-1".into(),
            step: 1,
        });
        assert_eq!(tool_events.load(Ordering::Relaxed), 0);

        bus.publish(&EngineEvent::ToolNative {
            turn_id: "turn-1".into(),
            tool_call_id: "tc-1".into(),
            tool_name: "Read".into(),
            arguments: serde_json::json!({}),
            content: "ok".into(),
            is_error: false,
            note: None,
        });
        assert_eq!(tool_events.load(Ordering::Relaxed), 1);
    }
}
