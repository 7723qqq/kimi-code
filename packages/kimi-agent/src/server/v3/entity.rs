//! Flat entity model of the v3 message stream (upstream kap-server `#3532`).
//!
//! The v3 protocol stops shipping per-occurrence events and ships *entities*
//! instead: every server message upserts one entity, and a later message with
//! the same identity carries the next state (or a delta) of that same entity.
//! Identity is the tuple `agent_id : type : entity_id`, where `entity_id` is
//! the first non-empty id field the message carries — the order below is
//! upstream's `entityId()` probe order and is part of the wire contract, not an
//! implementation detail.
//!
//! Keeping the probe order in one place lets the projection layer and the
//! transcript store agree on identity without either one re-deriving it.

/// Field names probed for an entity id, in the order upstream probes them.
///
/// First non-empty wins. `agent_id` comes last: it only ever identifies a
/// message when the message carries no id of its own.
pub const ENTITY_ID_FIELDS: &[&str] = &[
    "message_id",
    "tool_call_id",
    "interaction_id",
    "task_id",
    "todo_id",
    "system_id",
    "step_id",
    "turn_id",
    "agent_id",
];

/// A message that addresses one flat entity.
///
/// Implemented by the message union, so the projection layer never has to
/// serialize a message just to learn which entity it belongs to.
pub trait EntityAddressed {
    /// The message's own id fields, probed in [`ENTITY_ID_FIELDS`] order;
    /// return the first **non-empty** one. `None` means the message carries no
    /// id of its own, in which case [`entity_id`] falls back to the agent id.
    fn entity_id(&self) -> Option<&str>;

    /// The agent timeline the entity belongs to. Absent for session- and
    /// global-scoped messages, which is why [`entity_key`] keeps it empty.
    fn agent_id(&self) -> Option<&str> {
        None
    }
}

/// Upstream `entityId()`: the first non-empty id field, and — since `agent_id`
/// is the last member of upstream's probe chain rather than a separate
/// namespace — the agent id when the message carries no id of its own.
///
/// Empty strings are treated as absent: the schemas declare every id as
/// `z.string().min(1)`, so an empty id can only come from a producer that
/// disagrees with them, and falling through is strictly safer than handing the
/// projection layer an identity no message can be keyed by.
pub fn entity_id(message: &impl EntityAddressed) -> &str {
    message
        .entity_id()
        .filter(|id| !id.is_empty())
        .or_else(|| message.agent_id().filter(|id| !id.is_empty()))
        .unwrap_or("")
}

/// Upstream `entityKey()`: the upsert identity of one flat entity.
///
/// A missing agent id stays empty rather than being dropped, so the key keeps
/// its three segments and a session- or global-scoped entity can never collide
/// with an agent-scoped one that happens to share a type and id.
pub fn entity_key(agent_id: Option<&str>, message_type: &str, entity_id: &str) -> String {
    format!("{}:{}:{}", agent_id.unwrap_or(""), message_type, entity_id)
}

/// The key of an addressed message, using its own agent id and type name.
pub fn key_of(message: &impl EntityAddressed, message_type: &str) -> String {
    entity_key(message.agent_id(), message_type, entity_id(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Probe {
        fields: Vec<(&'static str, &'static str)>,
        agent: Option<&'static str>,
    }

    impl Probe {
        fn new(fields: &[(&'static str, &'static str)], agent: Option<&'static str>) -> Self {
            Self {
                fields: fields.to_vec(),
                agent,
            }
        }
    }

    impl EntityAddressed for Probe {
        fn entity_id(&self) -> Option<&str> {
            ENTITY_ID_FIELDS.iter().find_map(|name| {
                self.fields
                    .iter()
                    .find(|(k, v)| k == name && !v.is_empty())
                    .map(|(_, v)| *v)
            })
        }

        fn agent_id(&self) -> Option<&str> {
            self.agent
        }
    }

    #[test]
    fn test_entity_id_follows_upstream_probe_order() {
        // A message carrying several ids resolves to the earliest one in the
        // probe order, not the one that happens to be serialized first.
        let probe = Probe::new(
            &[("turn_id", "t3"), ("message_id", "m1"), ("step_id", "s9")],
            Some("a1"),
        );
        assert_eq!(entity_id(&probe), "m1");

        let probe = Probe::new(&[("step_id", "s9"), ("tool_call_id", "c7")], Some("a1"));
        assert_eq!(entity_id(&probe), "c7");
    }

    #[test]
    fn test_entity_id_falls_back_to_agent_id_then_empty() {
        let probe = Probe::new(&[], Some("a1"));
        assert_eq!(entity_id(&probe), "a1");
        let probe = Probe::new(&[], None);
        assert_eq!(entity_id(&probe), "");
    }

    #[test]
    fn test_entity_id_skips_empty_fields() {
        // The host emits `""` for ids it does not have; an empty id must not
        // shadow the next candidate.
        let probe = Probe::new(&[("message_id", ""), ("turn_id", "t3")], Some("a1"));
        assert_eq!(entity_id(&probe), "t3");
    }

    #[test]
    fn test_entity_key_keeps_three_segments() {
        assert_eq!(entity_key(Some("a1"), "tool_call", "c7"), "a1:tool_call:c7");
        // Session- and global-scoped entities keep their empty agent segment.
        assert_eq!(entity_key(None, "session", "s1"), ":session:s1");
        assert_eq!(entity_key(None, "config", ""), ":config:");
        assert_ne!(
            entity_key(None, "session", "s1"),
            entity_key(Some("a1"), "session", "s1")
        );
    }

    #[test]
    fn test_key_of_uses_the_messages_own_identity() {
        let probe = Probe::new(&[("interaction_id", "i2")], Some("a1"));
        assert_eq!(key_of(&probe, "interaction"), "a1:interaction:i2");
    }
}
