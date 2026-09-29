//! The value source the injection providers read from.
//!
//! An injection provider needs exactly one thing from the rest of the
//! engine: the durable value of a domain (`"goal"`, `"plan"`). That is a
//! narrow, read-only contract, and several very different things satisfy
//! it — the local state store the REPL and stdio entries run on, a
//! host-backed snapshot on the napi path, a fixture in a test.
//!
//! It lives here, next to the registry that consumes it, rather than
//! being borrowed from `crate::storage`. Naming it after what it provides
//! rather than after one implementation keeps the two apart: there is also
//! a `storage::StateStore`, with the same `read_domain` method and a
//! different meaning (a concrete store with lifecycle and migration, not
//! this contract).

use serde_json::Value;

/// A read-only source of durable domain values.
pub trait DomainValueSource {
    /// Read the durable value of a domain, or `None` when the domain has
    /// no state.
    fn read_domain(&self, domain: &str) -> Option<Value>;
}
