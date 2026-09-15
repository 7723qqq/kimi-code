//! The v3 WebSocket endpoint, beside v1 (`/api/v1/ws`).
//!
//! v3 is not a revision of the v1 frames; it is a different transport contract,
//! so it gets its own connection loop and the two coexist. What they share is the
//! layer underneath: the frame codec, and the hub's per-session lanes with their
//! sequencing, replay buffer and backpressure. Building the v3 lane on top of
//! `EventHub` rather than beside it is what keeps ordering, replay and slow-
//! consumer handling in one place instead of two that can drift.
//!
//! A connection here is a sequence of subscriptions. It is greeted with `hello`
//! immediately, then each `subscribe` is answered with an `ack` followed by a
//! *recovery page* — the same entities the history route would serve — so a client
//! resumes from a page it could have fetched instead of from nothing. Live
//! entities follow the page for as long as the subscription lives.
//!
//! Two details make the hand-over correct rather than merely ordered:
//!
//! - the lane cursor is read *before* attaching. An event published in between
//!   lands in the subscription's replay buffer, and everything at or below that
//!   cursor is already inside the recovery page, so the lane drops it instead of
//!   appending it a second time.
//! - the recovery page is filtered by the subscription's own filter. A client that
//!   asked for one agent must not receive another agent's timeline in the page
//!   just because the store holds it.
//!
//! Deliberate gaps, all of them upstream features this fork has no producer for
//! yet: the global lane (`session`, `workspace`, `config`, `plugin`,
//! `model_catalog`, `capability`) is not broadcast here, `usage` on a live turn is
//! left empty, and `config.warning` has no source. They are recorded in the
//! roadmap with the rest of the endpoint work.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::server::envelope::error_codes;
use crate::session::sqlite_store::SqliteSessionStore;

use super::hub::{EventHub, SequencedEvent};
use super::router::HttpRequest;
use super::v3::entity::EntityAddressed;
use super::v3::history::{HistoryQuery, paginate_history};
use super::v3::live::LiveTranslator;
use super::v3::messages::{
    AckMessage, ClientMessage, ErrorMessage, HelloMessage, ServerMessage, SubscribeMessage,
    UnsubscribeMessage,
};
use super::v3::projection::project_history;
use super::ws::{
    self, Frame, FrameReader, MAX_MESSAGE_BYTES, OP_BINARY, OP_CLOSE, OP_CONTINUATION, OP_PING,
    OP_PONG, OP_TEXT, WsError,
};

/// The path the v3 transport answers on.
pub const V3_WS_PATH: &str = "/api/v3/ws";

const PROTOCOL_VERSION: &str = "3";
/// The one capability upstream's client reads to decide it may ask for a replay.
const CAP_STEP_REPLAY: &str = "step_replay_v1";
/// Upstream drops a peer that has missed this many consecutive pongs.
const HEARTBEAT_MISS_LIMIT: u64 = 2;
/// Frames waiting for the socket. Bounded, so a lane that outruns its client
/// waits instead of growing without limit.
const OUTBOUND_QUEUE_DEPTH: usize = 64;
const RECOVERY_PAGE_SIZE: usize = 50;
const ACK_SUCCESS: u32 = 0;
/// The timeline a subscription means when it names no agent.
const DEFAULT_AGENT: &str = "main";

/// What one v3 connection needs from the server.
pub struct WsV3Options {
    pub hub: Arc<EventHub>,
    pub store: Arc<SqliteSessionStore>,
    pub server_id: String,
    pub heartbeat: Duration,
}

/// Serve one upgraded `/api/v3/ws` connection to its close.
pub async fn serve_ws_v3(
    stream: TcpStream,
    request: &HttpRequest,
    leftover: Vec<u8>,
    options: WsV3Options,
) -> Result<(), WsError> {
    let WsV3Options {
        hub,
        store,
        server_id,
        heartbeat,
    } = options;
    let key = request
        .headers
        .get("sec-websocket-key")
        .ok_or(WsError::Proto("missing Sec-WebSocket-Key"))?;
    let (read_half, mut writer) = tokio::io::split(stream);
    // Attached before the 101 goes out: the hub hands over the lane history it
    // holds at attach time, so nothing published between the handshake and the
    // first subscribe can be lost.
    let mut subscription = hub.attach();
    writer.write_all(&ws::handshake_response(key, None)).await?;

    // Greeted before the client has said anything: a v3 client that never sees
    // this treats the socket as dead, and the greeting is written here so no
    // entity frame can overtake it.
    send_entity(
        &mut writer,
        &ServerMessage::Hello(HelloMessage {
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_id,
            capabilities: vec![CAP_STEP_REPLAY.to_string()],
        }),
    )
    .await?;

    let mut heartbeat_tick = tokio::time::interval_at(Instant::now() + heartbeat, heartbeat);
    let mut missed_pongs: u64 = 0;
    let mut fragment: Option<(u8, Vec<u8>)> = None;
    // Every producer writes here, so the socket has one writer and the ordering a
    // subscription was answered in survives to the wire.
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(OUTBOUND_QUEUE_DEPTH);
    let mut connection = Connection {
        hub: hub.clone(),
        store: store.as_ref(),
        outbound: outbound_tx,
        sessions: HashMap::new(),
    };

    // Decoding lives in its own task: `read_frame` is not cancel-safe, so losing
    // a half-read frame to a `select!` would desynchronize the socket.
    let (inbound_tx, mut inbound_rx) = mpsc::channel::<Result<Frame, WsError>>(32);
    let reader = tokio::spawn(async move {
        let mut reader = FrameReader::new(read_half, leftover);
        loop {
            let frame = ws::read_frame(&mut reader).await;
            let terminal = frame.is_err();
            if inbound_tx.send(frame).await.is_err() || terminal {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            biased;

            outbound = outbound_rx.recv() => {
                let Some(payload) = outbound else { break };
                ws::write_frame(&mut writer, OP_TEXT, payload.as_bytes()).await?;
            }

            event = subscription.recv() => {
                match event {
                    Ok(event) => connection.handle_event(&event).await,
                    // The hub is gone, so there is nothing left to deliver.
                    Err(_) => break,
                }
            }

            inbound = inbound_rx.recv() => {
                let Some(result) = inbound else { break };
                let frame = match result {
                    Ok(frame) => frame,
                    Err(error) => {
                        if let Some(code) = error.close_code() {
                            let _ = ws::send_close(&mut writer, code).await;
                        }
                        reader.abort();
                        return Err(error);
                    }
                };

                match frame.opcode {
                    OP_PING => ws::write_frame(&mut writer, OP_PONG, &frame.payload).await?,
                    OP_PONG => missed_pongs = 0,
                    OP_CLOSE => {
                        if let Some(payload) = frame.payload.get(..2) {
                            let code = u16::from_be_bytes([payload[0], payload[1]]);
                            if !ws::is_sendable_close(code) {
                                let _ = ws::send_close(&mut writer, 1002).await;
                                reader.abort();
                                return Err(WsError::Proto("invalid close code"));
                            }
                        } else if frame.payload.len() == 1 {
                            let _ = ws::send_close(&mut writer, 1002).await;
                            reader.abort();
                            return Err(WsError::Proto("close payload of one byte"));
                        }
                        let _ = ws::send_close(&mut writer, 1000).await;
                        break;
                    }
                    OP_TEXT | OP_BINARY => {
                        if fragment.is_some() {
                            let _ = ws::send_close(&mut writer, 1002).await;
                            reader.abort();
                            return Err(WsError::Proto("data frame while fragmented"));
                        }
                        if frame.is_final {
                            connection.handle_text(&frame.payload).await;
                        } else {
                            fragment = Some((frame.opcode, frame.payload));
                        }
                    }
                    OP_CONTINUATION => {
                        let Some((opcode, mut buffered)) = fragment.take() else {
                            let _ = ws::send_close(&mut writer, 1002).await;
                            reader.abort();
                            return Err(WsError::Proto("continuation without a start"));
                        };
                        if buffered.len() + frame.payload.len() > MAX_MESSAGE_BYTES {
                            let _ = ws::send_close(&mut writer, 1009).await;
                            reader.abort();
                            return Err(WsError::TooLarge);
                        }
                        buffered.extend_from_slice(&frame.payload);
                        if frame.is_final {
                            let _ = opcode;
                            connection.handle_text(&buffered).await;
                        } else {
                            fragment = Some((opcode, buffered));
                        }
                    }
                    _ => {}
                }
            }

            _ = heartbeat_tick.tick() => {
                if missed_pongs >= HEARTBEAT_MISS_LIMIT {
                    // A peer that stopped answering is gone; its lanes would
                    // otherwise keep buffering for it.
                    let _ = ws::send_close(&mut writer, 1008).await;
                    reader.abort();
                    return Ok(());
                }
                ws::write_frame(&mut writer, OP_PING, &[]).await?;
                missed_pongs += 1;
            }
        }
    }

    reader.abort();
    Ok(())
}

/// One connection's subscriptions, each with its own view of a session's stream.
struct Connection<'a> {
    hub: Arc<EventHub>,
    store: &'a SqliteSessionStore,
    outbound: mpsc::Sender<String>,
    sessions: HashMap<String, SessionStream>,
}

/// What one subscribed session needs kept between events.
struct SessionStream {
    translator: LiveTranslator,
    filter: SubscriptionFilter,
    /// Events at or below this cursor are already inside the recovery page.
    cutoff: Option<(u64, Arc<str>)>,
}

impl Connection<'_> {
    /// Fold one lane event into the sessions that asked for it.
    async fn handle_event(&mut self, event: &SequencedEvent) {
        let Some(stream) = self.sessions.get_mut(event.session_id.as_ref()) else {
            return;
        };
        if let Some((seq, epoch)) = &stream.cutoff
            && event.epoch == *epoch
            && event.seq <= *seq
        {
            return;
        }
        let payloads: Vec<String> = stream
            .translator
            .translate(&event.event, now_millis())
            .iter()
            .filter(|entity| stream.filter.allows(entity))
            .filter_map(|entity| serde_json::to_string(entity).ok())
            .collect();
        for payload in payloads {
            let _ = self.outbound.send(payload).await;
        }
    }

    async fn handle_text(&mut self, payload: &[u8]) {
        let Ok(text) = std::str::from_utf8(payload) else {
            self.send_error(error_codes::REQUEST_MALFORMED, "frame is not valid UTF-8")
                .await;
            return;
        };
        match classify(text) {
            Request::Subscribe(frame) => self.subscribe(frame).await,
            Request::Unsubscribe(frame) => self.unsubscribe(frame).await,
            Request::Rejected { code, msg } => self.send_error(code, &msg).await,
        }
    }

    async fn subscribe(&mut self, frame: SubscribeMessage) {
        let session_id = frame.session_id.clone();
        if self.store.get_session(&session_id).ok().flatten().is_none() {
            self.send_ack(
                frame.id,
                error_codes::SESSION_NOT_FOUND,
                Some("session not found"),
            )
            .await;
            return;
        }

        let agent_id = frame
            .agent_ids
            .as_ref()
            .and_then(|ids| ids.first())
            .cloned()
            .unwrap_or_else(|| DEFAULT_AGENT.to_string());
        // Cursor first, recovery second: an event published in between is in the
        // subscription's buffer, and the lane drops anything at or below this
        // cursor because the page below already carries it. A second subscribe to
        // the same session restarts from here rather than delivering twice.
        let cutoff = self.hub.session_cursor(&session_id);
        let recovery = recovery_page(self.store, &session_id, &agent_id);
        let filter = SubscriptionFilter::new(frame.agent_ids.clone(), frame.omit.clone());

        self.send_ack(frame.id, ACK_SUCCESS, None).await;
        for entity in &recovery {
            if filter.allows(entity) {
                self.send(entity).await;
            }
        }
        self.sessions.insert(
            session_id.clone(),
            SessionStream {
                translator: LiveTranslator::new(session_id, agent_id),
                filter,
                cutoff,
            },
        );
    }

    async fn unsubscribe(&mut self, frame: UnsubscribeMessage) {
        // Dropping the stream is the whole release: the connection keeps its one
        // hub subscription, and an unknown session simply has no stream to drop.
        self.sessions.remove(&frame.session_id);
        self.send_ack(frame.id, ACK_SUCCESS, None).await;
    }

    async fn send(&self, entity: &ServerMessage) {
        let Ok(payload) = serde_json::to_string(entity) else {
            return;
        };
        // A full queue means this client is behind: awaiting is the backpressure,
        // and a closed channel means the connection is gone and nothing is left
        // to deliver to.
        let _ = self.outbound.send(payload).await;
    }

    async fn send_ack(&self, id: i64, code: u32, msg: Option<&str>) {
        self.send(&ServerMessage::Ack(AckMessage {
            id,
            code: code as i64,
            msg: msg.map(str::to_string),
        }))
        .await;
    }

    async fn send_error(&self, code: u32, msg: &str) {
        self.send(&ServerMessage::Error(ErrorMessage {
            code: code as i64,
            msg: msg.to_string(),
        }))
        .await;
    }
}

/// What a client frame asks for, or the error that answers it.
enum Request {
    Subscribe(SubscribeMessage),
    Unsubscribe(UnsubscribeMessage),
    Rejected { code: u32, msg: String },
}

/// Parse one client frame.
///
/// JSON syntax and frame validity are different failures with different codes:
/// bytes that are not JSON at all are malformed, while a frame that parses but
/// asks for something unknown or impossible is a validation failure.
fn classify(text: &str) -> Request {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Request::Rejected {
            code: error_codes::REQUEST_MALFORMED,
            msg: "frame is not valid JSON".to_string(),
        };
    };
    match serde_json::from_value::<ClientMessage>(value) {
        Ok(ClientMessage::Subscribe(frame)) => Request::Subscribe(frame),
        Ok(ClientMessage::Unsubscribe(frame)) => Request::Unsubscribe(frame),
        Err(error) => {
            let frame_type = text_frame_type(text);
            Request::Rejected {
                code: error_codes::VALIDATION_FAILED,
                // A known type that failed validation is reported with the
                // validation detail, an unknown one by name.
                msg: if matches!(frame_type.as_deref(), Some("subscribe" | "unsubscribe")) {
                    error.to_string()
                } else {
                    format!(
                        "unknown or invalid frame type: {}",
                        frame_type.as_deref().unwrap_or("<missing>")
                    )
                },
            }
        }
    }
}

fn text_frame_type(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("type")?
        .as_str()
        .map(str::to_string)
}

/// The `omit` / `agent_ids` filter of one subscription.
#[derive(Debug, Clone, Default)]
struct SubscriptionFilter {
    agent_ids: Option<HashSet<String>>,
    omit: Option<HashSet<String>>,
}

impl SubscriptionFilter {
    fn new(agent_ids: Option<Vec<String>>, omit: Option<Vec<String>>) -> Self {
        Self {
            agent_ids: agent_ids.map(|ids| ids.into_iter().collect()),
            omit: omit.map(|types| types.into_iter().collect()),
        }
    }

    /// A frame passes when its type is not omitted and, if the subscription names
    /// agents, it belongs to one of them. An entity that belongs to no agent at
    /// all — a session, a workspace — is nobody's property, so naming agents does
    /// not exclude it.
    fn allows(&self, entity: &ServerMessage) -> bool {
        if self
            .omit
            .as_ref()
            .is_some_and(|omit| omit.contains(entity.message_type()))
        {
            return false;
        }
        let Some(agent_ids) = &self.agent_ids else {
            return true;
        };
        match entity.agent_id() {
            Some(agent_id) => agent_ids.contains(agent_id),
            None => true,
        }
    }
}

/// The page a new subscriber is handed before its live stream: the entities the
/// history route would serve, filtered by the same subscription.
fn recovery_page(
    store: &SqliteSessionStore,
    session_id: &str,
    agent_id: &str,
) -> Vec<ServerMessage> {
    let turns = store.list_turns(session_id).unwrap_or_default();
    let messages = store.load_session_messages(session_id).unwrap_or_default();
    let entities = project_history(session_id, agent_id, &turns, &messages);
    let query = HistoryQuery {
        page_size: Some(RECOVERY_PAGE_SIZE),
        ..HistoryQuery::default()
    };
    paginate_history(&entities, &query).messages.to_vec()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or_default()
}

async fn send_entity(
    writer: &mut tokio::io::WriteHalf<TcpStream>,
    entity: &ServerMessage,
) -> Result<(), WsError> {
    let payload = serde_json::to_vec(entity).map_err(|_| WsError::Proto("unserializable frame"))?;
    ws::write_frame(writer, OP_TEXT, &payload).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EngineEvent;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    fn entity(json: &str) -> ServerMessage {
        serde_json::from_str(json).expect("a frame the wire contract defines")
    }

    /// A client frame, which the protocol requires to be masked.
    fn masked_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mask = [0x11_u8, 0x22, 0x33, 0x44];
        let mut frame = vec![0x80 | opcode];
        match payload.len() {
            len if len < 126 => frame.push(0x80 | len as u8),
            len if len <= u16::MAX as usize => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            }
            len => {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
        }
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        frame
    }

    /// A v3 client: the handshake, then whole unmasked server frames.
    struct WsClient {
        stream: TcpStream,
        buffered: Vec<u8>,
    }

    impl WsClient {
        async fn connect(
            server: &Arc<crate::server::HttpServer>,
            path: &str,
        ) -> (Self, crate::server::http::ServerHandle) {
            let handle = crate::server::http::serve("127.0.0.1:0", server.clone())
                .await
                .unwrap();
            let mut stream = TcpStream::connect(handle.local_addr).await.unwrap();
            let request = format!(
                "GET {path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\
                 Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                 Sec-WebSocket-Version: 13\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();

            let mut handshake = Vec::new();
            let mut buffered = Vec::new();
            loop {
                let mut chunk = [0_u8; 512];
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0, "the server closed during the handshake");
                handshake.extend_from_slice(&chunk[..read]);
                if let Some(at) = handshake.windows(4).position(|w| w == b"\r\n\r\n") {
                    // The greeting can share the packet with the 101, so the
                    // surplus is carried into the frame reader, not dropped.
                    buffered.extend_from_slice(&handshake[at + 4..]);
                    break;
                }
            }
            let head = String::from_utf8_lossy(&handshake);
            assert!(head.starts_with("HTTP/1.1 101"), "{head}");
            (Self { stream, buffered }, handle)
        }

        async fn fill(&mut self, wanted: usize) {
            while self.buffered.len() < wanted {
                let mut chunk = [0_u8; 512];
                let read = self.stream.read(&mut chunk).await.unwrap();
                assert!(read > 0, "the server closed mid-frame");
                self.buffered.extend_from_slice(&chunk[..read]);
            }
        }

        async fn next_text(&mut self) -> String {
            loop {
                self.fill(2).await;
                let opcode = self.buffered[0] & 0x0f;
                let (header, length) = match self.buffered[1] & 0x7f {
                    126 => {
                        self.fill(4).await;
                        (
                            4,
                            u16::from_be_bytes([self.buffered[2], self.buffered[3]]) as usize,
                        )
                    }
                    127 => {
                        self.fill(10).await;
                        let mut eight = [0_u8; 8];
                        eight.copy_from_slice(&self.buffered[2..10]);
                        (10, u64::from_be_bytes(eight) as usize)
                    }
                    length => (2, length as usize),
                };
                self.fill(header + length).await;
                let payload = self.buffered[header..header + length].to_vec();
                self.buffered.drain(..header + length);
                match opcode {
                    OP_PING => {
                        // Answering keeps the peer alive, and skipping keeps a
                        // control frame from being read as an empty entity.
                        self.stream
                            .write_all(&masked_frame(OP_PONG, &payload))
                            .await
                            .unwrap();
                    }
                    OP_PONG => {}
                    _ => return String::from_utf8(payload).expect("a server frame is UTF-8 JSON"),
                }
            }
        }

        async fn next_json(&mut self) -> serde_json::Value {
            serde_json::from_str(&self.next_text().await).unwrap()
        }

        async fn send_json(&mut self, text: &str) {
            self.stream
                .write_all(&masked_frame(OP_TEXT, text.as_bytes()))
                .await
                .unwrap();
        }
    }

    #[test]
    fn classify_separates_malformed_bytes_from_an_invalid_frame() {
        let Request::Rejected { code, msg } = classify("not json") else {
            panic!("bytes that are not JSON cannot be answered");
        };
        assert_eq!(code, error_codes::REQUEST_MALFORMED);
        assert!(msg.contains("JSON"), "{msg}");

        let Request::Rejected { code, msg } = classify(r#"{"type":"nonsense"}"#) else {
            panic!("an unknown frame type is refused");
        };
        assert_eq!(code, error_codes::VALIDATION_FAILED);
        assert!(msg.contains("nonsense"), "the type is named: {msg}");

        // A known type whose body does not validate is reported with the
        // validation detail rather than as an unknown type.
        let Request::Rejected { code, msg } = classify(r#"{"type":"subscribe","session_id":"s1"}"#)
        else {
            panic!("a subscribe without an id is invalid");
        };
        assert_eq!(code, error_codes::VALIDATION_FAILED);
        assert!(!msg.contains("unknown or invalid frame type"), "{msg}");

        let Request::Subscribe(frame) =
            classify(r#"{"type":"subscribe","id":1,"session_id":"s1"}"#)
        else {
            panic!("a well-formed subscribe is one");
        };
        assert_eq!(frame.id, 1);
        assert_eq!(frame.session_id, "s1");

        let Request::Unsubscribe(frame) =
            classify(r#"{"type":"unsubscribe","id":2,"session_id":"s1"}"#)
        else {
            panic!("a well-formed unsubscribe is one");
        };
        assert_eq!(frame.session_id, "s1");
    }

    #[test]
    fn the_subscription_filter_drops_omitted_types_and_keeps_entities_without_an_agent() {
        let delta = entity(
            r#"{"type":"assistant.delta","session_id":"s1","agent_id":"a1","timestamp":5,"message_id":"m2","text":"x"}"#,
        );
        let other_agent = entity(
            r#"{"type":"assistant.delta","session_id":"s1","agent_id":"a2","timestamp":5,"message_id":"m2","text":"x"}"#,
        );
        let catalog = entity(r#"{"type":"model_catalog","timestamp":21}"#);

        assert!(SubscriptionFilter::default().allows(&delta));

        let by_agent = SubscriptionFilter::new(Some(vec!["a1".to_string()]), None);
        assert!(by_agent.allows(&delta));
        assert!(!by_agent.allows(&other_agent));
        assert!(
            by_agent.allows(&catalog),
            "an entity belonging to no agent cannot be excluded by naming agents"
        );

        let omitting = SubscriptionFilter::new(None, Some(vec!["assistant.delta".to_string()]));
        assert!(!omitting.allows(&delta));
        assert!(omitting.allows(&catalog));
    }

    #[tokio::test]
    async fn the_greeting_announces_the_v3_protocol() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let (mut client, handle) = WsClient::connect(&server, V3_WS_PATH).await;

        let hello = client.next_json().await;

        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["protocol_version"], "3");
        assert_eq!(hello["capabilities"][0], "step_replay_v1");
        let server_id = hello["server_id"].as_str().expect("a server id");
        assert!(server_id.starts_with("srv-"), "{server_id}");
        handle.shutdown();
    }

    #[tokio::test]
    async fn subscribing_to_an_unknown_session_is_refused_by_id() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let (mut client, handle) = WsClient::connect(&server, V3_WS_PATH).await;
        let _hello = client.next_text().await;

        client
            .send_json(r#"{"type":"subscribe","id":7,"session_id":"missing"}"#)
            .await;
        let ack = client.next_json().await;

        assert_eq!(ack["type"], "ack");
        assert_eq!(ack["id"], 7);
        assert_eq!(ack["code"], error_codes::SESSION_NOT_FOUND);
        handle.shutdown();
    }

    #[tokio::test]
    async fn a_frame_that_is_not_json_is_malformed_and_an_unknown_type_is_not() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let (mut client, handle) = WsClient::connect(&server, V3_WS_PATH).await;
        let _hello = client.next_text().await;

        client.send_json("not json").await;
        let error = client.next_json().await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], error_codes::REQUEST_MALFORMED);

        client.send_json(r#"{"type":"nonsense"}"#).await;
        let error = client.next_json().await;
        assert_eq!(error["code"], error_codes::VALIDATION_FAILED);
        assert!(
            error["msg"]
                .as_str()
                .unwrap_or_default()
                .contains("nonsense"),
            "{error}"
        );
        handle.shutdown();
    }

    #[tokio::test]
    async fn subscribing_hands_over_a_recovery_page_and_then_the_live_stream() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        // A turn is projected from its messages, so a turn record alone would be
        // a session with nothing to recover.
        server
            .store_arc()
            .save_turn(
                "sess-v3",
                "turn-1",
                1,
                &[crate::turn_loop::types::LLMMessage::user("hello")],
                None,
            )
            .unwrap();
        let hub = server.hub();
        let (mut client, handle) = WsClient::connect(&server, V3_WS_PATH).await;
        let _hello = client.next_text().await;

        client
            .send_json(r#"{"type":"subscribe","id":1,"session_id":"sess-v3"}"#)
            .await;
        let ack = client.next_json().await;
        assert_eq!(ack["type"], "ack");
        assert_eq!(ack["code"], 0, "{ack}");

        // The page: what the history route would have served for this session.
        let turn = client.next_json().await;
        assert_eq!(turn["type"], "turn");
        assert_eq!(turn["turn_id"], "1");
        assert_eq!(turn["session_id"], "sess-v3");
        assert_eq!(turn["user_message_id"], "1.user");
        let stored_user = client.next_json().await;
        assert_eq!(stored_user["type"], "user");
        assert_eq!(stored_user["message_id"], "1.user");
        assert_eq!(stored_user["text"][0]["text"], "hello");

        // Then the live stream, in the same entity vocabulary and the same ids.
        hub.bus_for("sess-v3").publish(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 2,
            prompt: Some("go".into()),
        });
        let live_turn = client.next_json().await;
        assert_eq!(live_turn["type"], "turn");
        assert_eq!(live_turn["turn_id"], "2");
        assert_eq!(live_turn["status"], "running");
        let user = client.next_json().await;
        assert_eq!(user["type"], "user");
        assert_eq!(user["message_id"], "2.user");
        assert_eq!(user["text"][0]["text"], "go");
        handle.shutdown();
    }

    #[tokio::test]
    async fn a_subscription_that_omits_a_type_does_not_receive_it() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        server
            .store_arc()
            .save_turn(
                "sess-omit",
                "turn-1",
                1,
                &[crate::turn_loop::types::LLMMessage::user("kept")],
                None,
            )
            .unwrap();
        let hub = server.hub();
        let (mut client, handle) = WsClient::connect(&server, V3_WS_PATH).await;
        let _hello = client.next_text().await;

        client
            .send_json(r#"{"type":"subscribe","id":1,"session_id":"sess-omit","omit":["turn"]}"#)
            .await;
        let ack = client.next_json().await;
        assert_eq!(ack["code"], 0, "{ack}");

        // The recovery page is filtered too: this one projects a turn and a user
        // message, and only the user message may arrive.
        let from_page = client.next_json().await;
        assert_eq!(from_page["type"], "user", "{from_page}");
        assert_eq!(from_page["message_id"], "1.user");

        // A live turn is omitted as well, so its user message is what arrives.
        hub.bus_for("sess-omit").publish(&EngineEvent::TurnStarted {
            agent_id: "main".into(),
            turn_id: 3,
            prompt: Some("hi".into()),
        });
        let entity = client.next_json().await;
        assert_eq!(entity["type"], "user", "{entity}");
        assert_eq!(entity["message_id"], "3.user");
        handle.shutdown();
    }
}
