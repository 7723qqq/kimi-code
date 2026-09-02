//! The kap-server `/api/v1/ws` control frames: what the server sends on its own
//! initiative, and how an inbound frame is read.
//!
//! Field names, key order and the numeric codes mirror
//! `packages/kap-server/src/transport/ws/v1/protocol.ts` and `wsConnectionV1.ts`
//! so a client written against one server speaks to the other without a branch:
//!
//! - `server_hello` goes out immediately after the 101, before the client has
//!   said anything;
//! - `ping` carries a `nonce` and is a JSON text frame, not an RFC 6455 Ping;
//! - `ack` answers a request by `id` with `code: 0` for success;
//! - a refused `client_hello` credential is `code: 40112` (`AUTH_TOKEN_UNAUTHORIZED`)
//!   followed by a close — kap-server's own `wsConnectionV1.authorize`.
//!
//! Not implemented yet, because the server has no per-session event authority to
//! back them: `subscribe` / `subscribe_v2` / `unsubscribe*` / `watch_fs_*` (an
//! unknown `type` is ignored, which is also what kap-server does) and
//! `resync_required` (there is no `seq` to fall behind).

use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;

/// `WS_PROTOCOL_VERSION` in kap-server's `protocol/ws-control.ts`.
pub const WS_PROTOCOL_VERSION: u32 = 2;

/// kap-server's `DEFAULT_HEARTBEAT_INTERVAL_MS`.
pub const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(10);

/// The ack code kap-server answers a refused `client_hello` credential with.
/// Distinct from the HTTP 401's `40101`: this one travels in a WS frame.
pub const WS_AUTH_ERROR_CODE: u32 = 40112;

/// Success, as kap-server spells it in every accepted ack.
pub const ACK_OK: u32 = 0;

/// An ISO-8601 UTC timestamp with millisecond precision and a trailing `Z`,
/// byte-for-byte the shape JavaScript's `Date#toISOString()` produces.
pub fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Serialize)]
struct ControlFrame<T> {
    #[serde(rename = "type")]
    kind: &'static str,
    timestamp: String,
    payload: T,
}

#[derive(Serialize)]
struct Capabilities {
    event_batching: bool,
    compression: bool,
}

#[derive(Serialize)]
struct HelloPayload {
    ws_connection_id: String,
    protocol_version: u32,
    heartbeat_ms: u64,
    max_event_buffer_size: usize,
    capabilities: Capabilities,
}

#[derive(Serialize)]
struct AckFrame<T> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    code: u32,
    msg: String,
    payload: T,
}

#[derive(Serialize)]
struct PingPayload {
    nonce: String,
}

fn control<T: Serialize>(kind: &'static str, payload: T) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&ControlFrame {
        kind,
        timestamp: timestamp(),
        payload,
    })
}

/// The greeting every kap-server connection receives before it has said
/// anything. `capabilities` reports the truth: neither batching nor compression
/// is offered by either server today.
pub fn server_hello(
    connection_id: &str,
    heartbeat: Duration,
    max_event_buffer_size: usize,
) -> Result<Vec<u8>, serde_json::Error> {
    control(
        "server_hello",
        HelloPayload {
            ws_connection_id: connection_id.to_string(),
            protocol_version: WS_PROTOCOL_VERSION,
            heartbeat_ms: heartbeat.as_millis() as u64,
            max_event_buffer_size,
            capabilities: Capabilities {
                event_batching: false,
                compression: false,
            },
        },
    )
}

pub fn ping(nonce: &str) -> Result<Vec<u8>, serde_json::Error> {
    control(
        "ping",
        PingPayload {
            nonce: nonce.to_string(),
        },
    )
}

pub fn ack(id: &str, code: u32, msg: &str, payload: Value) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&AckFrame {
        kind: "ack",
        id: id.to_string(),
        code,
        msg: msg.to_string(),
        payload,
    })
}

/// The `client_hello` ack body. kap-server lists what it attached and where each
/// session's cursor stands; this server has no per-session subscription to
/// attach, so it honestly reports having accepted nothing rather than pretending
/// the subscription landed.
pub fn client_hello_ack() -> Value {
    serde_json::json!({
        "accepted_subscriptions": [],
        "resync_required": [],
        "cursors": {},
    })
}

/// What an inbound data frame asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    /// kap-server's `authorize()` reads a credential from `payload.token`. The
    /// `id` echoes back into the ack.
    ClientHello { id: String, token: Option<String> },
    /// The reply to our `ping`. Liveness is already proved by any inbound frame,
    /// so there is nothing to record.
    Pong,
    /// Anything else — an unparseable frame, a frame with no `type`, a
    /// subscription frame whose layer does not exist yet. kap-server's
    /// `onMessage` returns without a word for the first two, so silence here is
    /// parity rather than a gap.
    Unknown,
}

pub fn parse_inbound(raw: &[u8]) -> Inbound {
    let Ok(Value::Object(frame)) = serde_json::from_slice::<Value>(raw) else {
        return Inbound::Unknown;
    };
    match frame.get("type").and_then(Value::as_str) {
        Some("pong") => Inbound::Pong,
        Some("client_hello") => Inbound::ClientHello {
            id: request_id(&frame),
            // kap-server only treats a *string* `token` as a credential; any
            // other JSON type is as absent as if the field were missing.
            token: frame
                .get("payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("token"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        Some(_) => Inbound::Unknown,
        None => Inbound::Unknown,
    }
}

fn request_id(frame: &serde_json::Map<String, Value>) -> String {
    frame
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_hello_carries_kap_server_field_names_and_honest_values() {
        let frame: Value =
            serde_json::from_slice(&server_hello("ws-1", DEFAULT_HEARTBEAT, 256).unwrap()).unwrap();

        assert_eq!(frame["type"], "server_hello");
        assert_eq!(frame["payload"]["ws_connection_id"], "ws-1");
        assert_eq!(frame["payload"]["protocol_version"], 2);
        assert_eq!(frame["payload"]["heartbeat_ms"], 10_000);
        assert_eq!(frame["payload"]["max_event_buffer_size"], 256);
        assert_eq!(frame["payload"]["capabilities"]["event_batching"], false);
        assert_eq!(frame["payload"]["capabilities"]["compression"], false);
    }

    #[test]
    fn an_ack_has_the_same_field_order_as_kap_server_builds_it() {
        let bytes = ack("req-9", WS_AUTH_ERROR_CODE, "unauthorized", Value::Null).unwrap();

        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"type":"ack","id":"req-9","code":40112,"msg":"unauthorized","payload":null}"#
        );
    }

    #[test]
    fn timestamps_match_the_shape_of_date_toisostring() {
        let stamp = timestamp();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(stamp.ends_with('Z'), "{stamp}");
        assert_eq!(stamp.matches(':').count(), 2, "{stamp}");
        assert_eq!(&stamp[19..20], ".", "{stamp}");
    }

    #[test]
    fn a_ping_carries_a_nonce() {
        let frame: Value = serde_json::from_slice(&ping("n-1").unwrap()).unwrap();
        assert_eq!(frame["type"], "ping");
        assert_eq!(frame["payload"]["nonce"], "n-1");
    }

    #[test]
    fn only_pong_and_client_hello_are_understood() {
        assert_eq!(parse_inbound(br#"{"type":"pong"}"#), Inbound::Pong);
        assert_eq!(parse_inbound(br#"{"type":"subscribe"}"#), Inbound::Unknown);
        assert_eq!(parse_inbound(b"not json at all"), Inbound::Unknown);
        assert_eq!(parse_inbound(br#"{"payload":{}}"#), Inbound::Unknown);
        assert_eq!(parse_inbound(b"[1,2,3]"), Inbound::Unknown);
    }

    #[test]
    fn client_hello_reads_the_credential_where_kap_server_does() {
        let hello = br#"{"type":"client_hello","id":"c1","payload":{"token":"tok3n"}}"#;
        assert_eq!(
            parse_inbound(hello),
            Inbound::ClientHello {
                id: "c1".into(),
                token: Some("tok3n".into()),
            }
        );

        // No credential at all, and a non-string one, both mean "nothing was
        // presented": kap-server's authorize() returns early on both.
        let empty = br#"{"type":"client_hello","id":"c2","payload":{}}"#;
        assert_eq!(
            parse_inbound(empty),
            Inbound::ClientHello {
                id: "c2".into(),
                token: None,
            }
        );
        let wrong_type = br#"{"type":"client_hello","payload":{"token":42}}"#;
        assert_eq!(
            parse_inbound(wrong_type),
            Inbound::ClientHello {
                id: String::new(),
                token: None,
            }
        );
    }
}
