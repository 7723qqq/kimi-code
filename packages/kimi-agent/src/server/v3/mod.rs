//! v3 flat entity message protocol (upstream kap-server `#3532`).
//!
//! The fork's `/api/v1` surface emits per-occurrence events; v3 emits
//! *entities* instead, addressed by `agent_id : type : entity_id`, and serves
//! the same message shapes from both the live WS stream and the history API so
//! a client folds history and live traffic through one code path.
//!
//! Upstream introduced the protocol in `64505e36e3` ("flat entity message
//! protocol (v3 WS + history API)", design revision 1094) while this fork still
//! carried `packages/kap-server`; the package was retired three days later, so
//! the protocol has to be re-expressed on the Rust engine.
//!
//! Module map:
//!
//! - [`entity`] — identity of one flat entity (probe order and key format).
//! - [`messages`] — the server message variants and the two client frames.
//! - `projection` — folds persisted `wire_events` rows into entity messages.
//! - `history` — the paged cold/live rebuild behind the history route.

pub mod entity;
pub mod messages;
