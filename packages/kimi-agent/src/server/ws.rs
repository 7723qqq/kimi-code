//! RFC 6455 WebSocket endpoint for the native REST surface.
//!
//! Scope of this module is the **transport**: handshake, framing, control
//! frames, and fragmentation. On top of it it speaks the kap-server `/api/v1/ws`
//! **control** vocabulary — [`ws_protocol`] for the frame shapes, sent and read
//! here: the `server_hello` greeting, the `ping` heartbeat, the `ack` that
//! answers a `client_hello`, and the `40112` refusal of a bad credential in one.
//! The subscription layer (`subscribe` / per-session `seq` / `resync_required`)
//! is still absent, so an inbound frame asking for it is ignored; that needs a
//! per-session event authority, which the server does not have yet.
//!
//! Zero new crates. SHA-1 is implemented here rather than pulled in: the
//! handshake digest is a non-secret anti-caching value fixed by RFC 6455 §1.3,
//! its correct output is pinned by a known-answer test, and collision
//! resistance is not part of what it protects. Base64 comes from the crate
//! reqwest already resolves.
//!
//! Spec rules this implementation enforces, each because skipping it lets a
//! peer desynchronize the parser:
//!
//! - client frames **must** be masked, server frames **never** are (§5.1);
//! - RSV bits must be zero — no extension is negotiated (§5.2);
//! - control frames must not be fragmented and must carry ≤ 125 bytes (§5.5);
//! - a 64-bit length must fit the configured cap, and only after a `FIN` may a
//!   new data frame start (§5.4);
//! - `Close` payloads are empty or ≥ 2 bytes with a code sendable by a peer.

use std::io;
use std::time::Duration;

use crate::server::auth::ServerAuth;
use crate::server::hub::{EventHub, HubClosed, SUBSCRIBER_QUEUE_DEPTH};
use crate::server::router::HttpRequest;
use crate::server::ws_protocol::{self, Inbound};
use base64::prelude::*;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Instant;

/// The magic value RFC 6455 §1.3 concatenates with the client key before SHA-1.
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// Cap on a single frame payload and on an assembled message.
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Why the connection is being torn down, and the close code to send back.
#[derive(Debug)]
pub enum WsError {
    /// Protocol violation: code 1002 (protocol error).
    Proto(&'static str),
    /// Unsupported data: code 1003.
    Unsupported(u8),
    /// Message over the cap: code 1009.
    TooLarge,
    /// The peer could not keep up with the event stream: code 1013.
    SlowSubscriber,
    Io(io::Error),
    Serde(serde_json::Error),
}

impl From<io::Error> for WsError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for WsError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serde(error)
    }
}

impl WsError {
    /// The close code this failure maps to, or `None` when the peer broke the
    /// contract so early no frame can be sent.
    pub fn close_code(&self) -> Option<u16> {
        match self {
            Self::Proto(_) => Some(1002),
            Self::Unsupported(_) => Some(1003),
            Self::TooLarge => Some(1009),
            Self::SlowSubscriber => Some(1013),
            Self::Io(_) => None,
            Self::Serde(_) => None,
        }
    }
}

pub struct Frame {
    pub is_final: bool,
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// True when this request asks for a WebSocket upgrade we can honour.
///
/// A `Content-Length` on an upgrade is rejected outright: an upgrade request
/// carries no body, and accepting one would make us consume the first frame's
/// bytes as body data.
pub fn is_upgrade(request: &HttpRequest) -> bool {
    let wants_upgrade = request.headers.get("upgrade").is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("websocket"))
    });
    let connection_ok = request.headers.get("connection").is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
    });
    let version_ok = request
        .headers
        .get("sec-websocket-version")
        .map(String::as_str)
        == Some("13");

    request.headers.contains_key("sec-websocket-key")
        && wants_upgrade
        && connection_ok
        && version_ok
        && !request.headers.contains_key("content-length")
}

/// The `Sec-WebSocket-Accept` value for a client key.
pub fn accept_value(client_key: &str) -> String {
    let digest = sha1(format!("{client_key}{WS_GUID}").as_bytes());
    BASE64_STANDARD.encode(digest)
}

/// The 101 response completing the handshake.
///
/// `protocol` is the subprotocol the server selects. It must be echoed when the
/// client offered one, or a browser client aborts the negotiation.
pub fn handshake_response(client_key: &str, protocol: Option<&str>) -> Vec<u8> {
    let selected = protocol
        .map(|name| format!("Sec-WebSocket-Protocol: {name}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {}\r\n\
         {selected}\r\n",
        accept_value(client_key)
    )
    .into_bytes()
}

/// How an upgraded connection should treat its peer.
pub struct WsOptions<'a> {
    pub hub: EventHub,
    /// The credential a `client_hello` payload token is checked against. The
    /// HTTP layer already checked the bearer header or the subprotocol;
    /// kap-server checks again at the frame layer, and a non-browser client that
    /// only ever sends `client_hello` depends on this one.
    pub auth: &'a ServerAuth,
    /// Period of the JSON `ping` heartbeat; kap-server uses
    /// [`ws_protocol::DEFAULT_HEARTBEAT`].
    pub heartbeat: Duration,
    pub selected_protocol: Option<String>,
}

/// Serve the upgraded connection as an event stream until the peer closes it or
/// the hub ends.
///
/// `leftover` holds bytes the HTTP reader already pulled off the socket past the
/// handshake — a client may coalesce the handshake and its first frame into one
/// packet, and dropping them would desynchronize the framing parser.
///
/// Inbound data frames are read as [`ws_protocol`] control frames. Subscription
/// frames still go unanswered, but their bytes are *accounted* for either way,
/// because an endless run of continuation frames is otherwise a free way to grow
/// server memory.
pub async fn serve_ws(
    stream: TcpStream,
    request: &HttpRequest,
    leftover: Vec<u8>,
    options: WsOptions<'_>,
) -> Result<(), WsError> {
    let WsOptions {
        hub,
        auth,
        heartbeat,
        selected_protocol,
    } = options;
    let key = request
        .headers
        .get("sec-websocket-key")
        .ok_or(WsError::Proto("missing Sec-WebSocket-Key"))?;
    let (read_half, mut writer) = tokio::io::split(stream);
    // Attach before the 101 goes out: once the client sees the handshake it may
    // legitimately expect every event from that moment on, and attaching after
    // the write opens a window where a published event reaches nobody.
    let mut subscription = hub.attach();
    writer
        .write_all(&handshake_response(key, selected_protocol.as_deref()))
        .await?;

    // kap-server greets a connection before it has said anything, and a client
    // that never sees this treats the socket as dead. It is written here rather
    // than in the loop below, so it cannot be overtaken by an event frame.
    let connection_id = format!("ws-{:016x}", fastrand::u64(..));
    let hello = ws_protocol::server_hello(&connection_id, heartbeat, SUBSCRIBER_QUEUE_DEPTH)?;
    write_frame(&mut writer, OP_TEXT, &hello).await?;

    // Frame decoding lives in its own task so the main loop can await events and
    // inbound frames without cancelling a half-read frame — `read_frame` is not
    // cancel-safe, and losing its partial state would desynchronize the socket.
    let (inbound_tx, mut inbound_rx) = mpsc::channel::<Result<Frame, WsError>>(32);
    let reader = tokio::spawn(async move {
        let mut reader = FrameReader::new(read_half, leftover);
        loop {
            let frame = read_frame(&mut reader).await;
            let terminal = frame.is_err();
            if inbound_tx.send(frame).await.is_err() || terminal {
                break;
            }
        }
    });

    // `interval_at`, not `interval`: the first tick of `interval` is immediate,
    // and a ping landing right behind the greeting is noise kap-server does not
    // send (its `setInterval` only starts counting after the hello).
    let mut heartbeat_tick = tokio::time::interval_at(Instant::now() + heartbeat, heartbeat);
    let mut pings_sent: u64 = 0;

    // A partially received inbound message: (opcode, bytes so far).
    let mut fragment: Option<(u8, Vec<u8>)> = None;

    loop {
        tokio::select! {
            biased;

            inbound = inbound_rx.recv() => {
                let Some(result) = inbound else { break };
                let frame = match result {
                    Ok(frame) => frame,
                    Err(error) => {
                        if let Some(code) = error.close_code() {
                            let _ = send_close(&mut writer, code).await;
                        }
                        reader.abort();
                        return Err(error);
                    }
                };

                match frame.opcode {
                    OP_PING => write_frame(&mut writer, OP_PONG, &frame.payload).await?,
                    OP_PONG => {}
                    OP_CLOSE => {
                        if let Some(payload) = frame.payload.get(..2) {
                            let code = u16::from_be_bytes([payload[0], payload[1]]);
                            if !is_sendable_close(code) {
                                let _ = send_close(&mut writer, 1002).await;
                                reader.abort();
                                return Err(WsError::Proto("invalid close code"));
                            }
                        } else if frame.payload.len() == 1 {
                            let _ = send_close(&mut writer, 1002).await;
                            reader.abort();
                            return Err(WsError::Proto("close payload of one byte"));
                        }
                        let _ = send_close(&mut writer, 1000).await;
                        break;
                    }
                    OP_TEXT | OP_BINARY => {
                        if fragment.is_some() {
                            let _ = send_close(&mut writer, 1002).await;
                            reader.abort();
                            return Err(WsError::Proto("data frame while fragmented"));
                        }
                        if frame.is_final {
                            if handle_inbound(frame.opcode, &frame.payload, auth, &mut writer)
                                .await?
                            {
                                reader.abort();
                                return Ok(());
                            }
                        } else {
                            fragment = Some((frame.opcode, frame.payload));
                        }
                    }
                    OP_CONTINUATION => {
                        let Some((opcode, mut buffered)) = fragment.take() else {
                            let _ = send_close(&mut writer, 1002).await;
                            reader.abort();
                            return Err(WsError::Proto("continuation without a start"));
                        };
                        if buffered.len() + frame.payload.len() > MAX_MESSAGE_BYTES {
                            let _ = send_close(&mut writer, 1009).await;
                            reader.abort();
                            return Err(WsError::TooLarge);
                        }
                        buffered.extend_from_slice(&frame.payload);
                        if frame.is_final {
                            if handle_inbound(opcode, &buffered, auth, &mut writer).await? {
                                reader.abort();
                                return Ok(());
                            }
                        } else {
                            fragment = Some((opcode, buffered));
                        }
                    }
                    other => {
                        let _ = send_close(&mut writer, 1003).await;
                        reader.abort();
                        return Err(WsError::Unsupported(other));
                    }
                }
            }

            _ = heartbeat_tick.tick() => {
                // kap-server's heartbeat is a JSON `ping` frame the client
                // answers with `pong`; an RFC 6455 Ping is a separate thing this
                // codec already answers.
                pings_sent += 1;
                let nonce = format!("{connection_id}-{pings_sent}");
                write_frame(&mut writer, OP_TEXT, &ws_protocol::ping(&nonce)?).await?;
            }

            event = subscription.recv() => {
                match event {
                    Ok(event) => {
                        let payload = serde_json::to_vec(&event)?;
                        write_frame(&mut writer, OP_TEXT, &payload).await?;
                    }
                    // The hub released us (server teardown): a plain close.
                    Err(HubClosed::Detached) => break,
                    // A connection that cannot keep up is closed rather than
                    // silently truncated; see the policy note in server::hub.
                    Err(HubClosed::Overflow) => {
                        let _ = send_close(&mut writer, 1013).await;
                        reader.abort();
                        return Err(WsError::SlowSubscriber);
                    }
                }
            }
        }
    }

    reader.abort();
    Ok(())
}

/// Read one completed inbound message as a kap-server control frame.
///
/// A result of `true` means the connection must close now: the frame layer
/// refused the credential. That is a different outcome from a transport error
/// because the peer was told why, in an ack, first.
async fn handle_inbound(
    opcode: u8,
    payload: &[u8],
    auth: &ServerAuth,
    writer: &mut WriteHalf<TcpStream>,
) -> Result<bool, WsError> {
    // kap-server parses every inbound message as JSON, so a binary frame that
    // will not parse is dropped without a word.
    if opcode != OP_TEXT {
        return Ok(false);
    }
    let Inbound::ClientHello { id, token } = ws_protocol::parse_inbound(payload) else {
        // `pong` proves liveness, which no bookkeeping here depends on; anything
        // else is a frame this layer does not answer yet.
        return Ok(false);
    };

    // A `client_hello` that presents no credential is not a refusal: kap-server's
    // `authorize()` returns early when nothing was sent, which is how a browser
    // that already cleared the subprotocol gate gets through.
    if let Some(presented) = token
        && !auth.check_token(Some(presented.as_str())).is_allowed()
    {
        let refusal =
            ws_protocol::ack(&id, ws_protocol::WS_AUTH_ERROR_CODE, "unauthorized", json!({}))?;
        write_frame(writer, OP_TEXT, &refusal).await?;
        send_close(writer, 1000).await?;
        return Ok(true);
    }

    let acceptance =
        ws_protocol::ack(&id, ws_protocol::ACK_OK, "success", ws_protocol::client_hello_ack())?;
    write_frame(writer, OP_TEXT, &acceptance).await?;
    Ok(false)
}

async fn send_close(writer: &mut WriteHalf<TcpStream>, code: u16) -> Result<(), WsError> {
    write_frame(writer, OP_CLOSE, &code.to_be_bytes()).await
}

/// True for codes a peer is allowed to put in a Close frame (§7.4).
fn is_sendable_close(code: u16) -> bool {
    (1000..=4999).contains(&code) && !matches!(code, 1004 | 1005 | 1006 | 1015 | (1016..=2999))
}

async fn read_frame(reader: &mut FrameReader) -> Result<Frame, WsError> {
    let mut head = [0_u8; 2];
    reader.read_exact(&mut head).await?;

    let (first, second) = (head[0], head[1]);
    if first & 0x70 != 0 {
        return Err(WsError::Proto("non-zero RSV bits"));
    }
    let is_final = first & 0x80 != 0;
    let opcode = first & 0x0f;
    if second & 0x80 == 0 {
        return Err(WsError::Proto("client frame not masked"));
    }
    let masked_len = (second & 0x7f) as usize;

    let length = match masked_len {
        126 => {
            let mut two = [0_u8; 2];
            reader.read_exact(&mut two).await?;
            u16::from_be_bytes(two) as usize
        }
        127 => {
            let mut eight = [0_u8; 8];
            reader.read_exact(&mut eight).await?;
            let wide = u64::from_be_bytes(eight);
            if wide > MAX_MESSAGE_BYTES as u64 {
                return Err(WsError::TooLarge);
            }
            wide as usize
        }
        short => short,
    };

    if length > MAX_MESSAGE_BYTES {
        return Err(WsError::TooLarge);
    }
    let is_control = opcode & 0x8 != 0;
    if is_control {
        if !is_final {
            return Err(WsError::Proto("fragmented control frame"));
        }
        if length > 125 {
            return Err(WsError::Proto("oversized control frame"));
        }
    }

    let mut mask = [0_u8; 4];
    reader.read_exact(&mut mask).await?;
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload).await?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index & 3];
    }

    Ok(Frame {
        is_final,
        opcode,
        payload,
    })
}

async fn write_frame(
    writer: &mut WriteHalf<TcpStream>,
    opcode: u8,
    payload: &[u8],
) -> Result<(), WsError> {
    let len = payload.len();
    let mut head = vec![0x80 | opcode];
    if len <= 125 {
        head.push(len as u8);
    } else if len <= u16::MAX as usize {
        head.push(126);
        head.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        head.push(127);
        head.extend_from_slice(&(len as u64).to_be_bytes());
    }
    // Server-to-client frames must be unmasked: no mask bit, no mask key.
    writer.write_all(&head).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

/// A buffered reader over the split socket, seeded with the bytes the HTTP
/// layer already consumed from the packet but did not use.
struct FrameReader {
    reader: ReadHalf<TcpStream>,
    buffer: Vec<u8>,
    position: usize,
}

impl FrameReader {
    fn new(reader: ReadHalf<TcpStream>, seed: Vec<u8>) -> Self {
        Self {
            reader,
            buffer: seed,
            position: 0,
        }
    }

    async fn read_exact(&mut self, out: &mut [u8]) -> Result<(), WsError> {
        while self.buffer.len() - self.position < out.len() {
            let mut chunk = [0_u8; 4096];
            let read = self.reader.read(&mut chunk).await?;
            if read == 0 {
                return Err(WsError::Io(io::Error::from(io::ErrorKind::UnexpectedEof)));
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
        out.copy_from_slice(&self.buffer[self.position..self.position + out.len()]);
        self.position += out.len();
        if self.position == self.buffer.len() {
            self.buffer.clear();
            self.position = 0;
        }
        Ok(())
    }
}

/// SHA-1 (RFC 3174), used only for the WebSocket handshake digest.
fn sha1(input: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BADCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];

    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut message = Vec::with_capacity(input.len() + 72);
    message.extend_from_slice(input);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for block in message.chunks(64) {
        let mut words = [0_u32; 80];
        for index in 0..16 {
            words[index] =
                u32::from_be_bytes(block[index * 4..index * 4 + 4].try_into().unwrap_or([0; 4]));
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }

        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (index, &word) in words.iter().enumerate() {
            let (function, constant) = match index {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(function)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        state = [
            state[0].wrapping_add(a),
            state[1].wrapping_add(b),
            state[2].wrapping_add(c),
            state[3].wrapping_add(d),
            state[4].wrapping_add(e),
        ];
    }

    let mut out = [0_u8; 20];
    for (index, word) in state.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EngineEvent;
    use std::sync::Arc;
    use tokio::net::TcpStream;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn sha1_matches_rfc3174_known_answers() {
        assert_eq!(
            hex(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&sha1(b"The quick brown fox jumps over the lazy dog")),
            "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"
        );
        // 64 bytes exactly: the padding must spill into a second block.
        assert_eq!(
            hex(&sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn accept_value_matches_the_rfc6455_section_13_example() {
        assert_eq!(
            accept_value("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn handshake_response_carries_the_negotiation_headers() {
        let response = String::from_utf8(handshake_response("dGhlIHNhbXBsZSBub25jZQ==", None)).unwrap();
        assert!(response.starts_with("HTTP/1.1 101 Switching Protocols\r\n"));
        assert!(response.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"));
        assert!(response.ends_with("\r\n\r\n"));
    }

    fn upgrade_request(extra: &[(&str, &str)]) -> HttpRequest {
        let mut headers = std::collections::HashMap::new();
        headers.insert("upgrade".into(), "websocket".into());
        headers.insert("connection".into(), "Upgrade".into());
        headers.insert("sec-websocket-version".into(), "13".into());
        headers.insert(
            "sec-websocket-key".into(),
            "dGhlIHNhbXBsZSBub25jZQ==".into(),
        );
        for (name, value) in extra {
            headers.insert((*name).into(), (*value).into());
        }
        HttpRequest {
            method: "GET".into(),
            path: "/api/v1/ws".into(),
            headers,
            body: Vec::new(),
        }
    }

    #[test]
    fn accepts_a_well_formed_upgrade_and_refuses_an_incomplete_one() {
        assert!(is_upgrade(&upgrade_request(&[])));
        // case-insensitive, and a multi-token Connection header is normal
        assert!(is_upgrade(&upgrade_request(&[(
            "connection",
            "keep-alive, Upgrade"
        )])));
        assert!(!is_upgrade(&upgrade_request(&[(
            "sec-websocket-version",
            "8"
        )])));
        assert!(!is_upgrade(&upgrade_request(&[("content-length", "0")])));
    }

    async fn connect_client(
        addr: std::net::SocketAddr,
        key: &str,
        extra: &[(&str, &str)],
    ) -> (TcpStream, Vec<u8>) {
        let mut request = format!(
            "GET /api/v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n\
             Sec-WebSocket-Version: 13\r\n"
        );
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");

        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();

        let mut handshake = Vec::new();
        while !handshake.ends_with(b"\r\n\r\n") {
            let mut byte = [0_u8; 1];
            if client.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            handshake.push(byte[0]);
        }
        (client, handshake)
    }

    /// Upgrade through the real listener, so the handshake bytes are consumed
    /// by the HTTP layer exactly as they would be in product. Returns the client
    /// socket, the raw 101 response, and the listener handle.
    async fn connect_upgraded(
        server: &Arc<crate::server::HttpServer>,
        key: &str,
    ) -> (TcpStream, Vec<u8>, crate::server::http::ServerHandle) {
        let handle = crate::server::http::serve("127.0.0.1:0", server.clone())
            .await
            .unwrap();
        let (client, handshake) = connect_client(handle.local_addr, key, &[]).await;
        (client, handshake, handle)
    }

    fn step_event(step: u32) -> EngineEvent {
        EngineEvent::LlmStepBegin {
            turn_id: "turn-1".into(),
            step,
        }
    }

    /// Read one unmasked server text frame the way a client would, returning its
    /// payload. Handles both length forms a server frame can use.
    async fn read_text_frame(client: &mut TcpStream) -> String {
        let mut head = [0_u8; 2];
        client.read_exact(&mut head).await.unwrap();
        assert_eq!(head[0], 0x81, "expected a final text frame");
        assert_eq!(head[1] & 0x80, 0, "server frames must not be masked");
        let len = match head[1] & 0x7f {
            126 => {
                let mut wide = [0_u8; 2];
                client.read_exact(&mut wide).await.unwrap();
                u16::from_be_bytes(wide) as usize
            }
            127 => panic!("a 64-bit length frame is beyond what these tests produce"),
            short => short as usize,
        };
        let mut payload = vec![0_u8; len];
        client.read_exact(&mut payload).await.unwrap();
        String::from_utf8(payload).unwrap()
    }

    /// Read the greeting every connection receives before it says anything.
    async fn read_server_hello(client: &mut TcpStream) -> serde_json::Value {
        let frame: serde_json::Value =
            serde_json::from_str(&read_text_frame(client).await).unwrap();
        assert_eq!(frame["type"], "server_hello", "{frame}");
        frame
    }

    #[tokio::test]
    async fn handshakes_then_streams_events_published_after_it_connects() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let hub = server.hub();
        let (mut client, handshake, handle) =
            connect_upgraded(&server, "dGhlIHNhbXBsZSBub25jZQ==").await;
        let text = String::from_utf8_lossy(&handshake).into_owned();

        // The 101 must carry the RFC's own accept value for this key.
        assert!(text.starts_with("HTTP/1.1 101"), "{text}");
        assert!(text.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "{text}");
        assert_eq!(read_server_hello(&mut client).await["payload"]["protocol_version"], 2);
        for _ in 0..50 {
            if hub.subscriber_count() == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(hub.subscriber_count(), 1, "connection did not attach");

        hub.bus().publish(&step_event(7));
        let payload = read_text_frame(&mut client).await;
        assert!(payload.contains("\"type\":\"llm.step.begin\""), "{payload}");
        assert!(payload.contains("\"step\":7"), "{payload}");
        assert!(payload.contains("\"turn_id\":\"turn-1\""), "{payload}");

        client
            .write_all(&masked_frame(OP_CLOSE, &1000_u16.to_be_bytes()))
            .await
            .unwrap();
        // Give the server a turn to process the close and release the slot.
        for _ in 0..50 {
            if hub.subscriber_count() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(hub.subscriber_count(), 0, "closed connection leaked a slot");
        handle.shutdown();
    }

    #[tokio::test]
    async fn two_connections_each_receive_the_same_event() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let hub = server.hub();
        let (mut first, _, handle) = connect_upgraded(&server, "key-a").await;
        let (mut second, _) = connect_client(handle.local_addr, "key-b", &[]).await;

        for _ in 0..50 {
            if hub.subscriber_count() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(hub.subscriber_count(), 2);

        // Both were greeted; what must be identical is the event that follows.
        read_server_hello(&mut first).await;
        read_server_hello(&mut second).await;
        hub.bus().publish(&step_event(1));

        let a = read_text_frame(&mut first).await;
        let b = read_text_frame(&mut second).await;
        assert_eq!(a, b, "subscribers saw different payloads");
        assert!(a.contains("\"step\":1"), "{a}");

        handle.shutdown();
    }

    #[tokio::test]
    async fn an_unmasked_client_frame_is_refused_with_1002() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let (mut client, _, handle) = connect_upgraded(&server, "abc").await;

        // 0x81 with the mask bit clear — a conforming server must not read it.
        read_server_hello(&mut client).await;
        client.write_all(&[0x81, 0x00]).await.unwrap();
        let mut reply = [0_u8; 8];
        let read = client.read(&mut reply).await.unwrap();
        assert!(read >= 4, "expected a close frame, got {read} bytes");
        assert_eq!(reply[0], 0x88, "not a Close frame");
        assert_eq!(&reply[2..4], &1002_u16.to_be_bytes());
        handle.shutdown();
    }

    #[tokio::test]
    async fn a_control_frame_coalesced_with_the_handshake_is_not_lost() {
        // A client may put its first frame in the same packet as the upgrade
        // request. The HTTP reader buffers those surplus bytes; if they were
        // dropped the server would never answer the Ping.
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let handle = crate::server::http::serve("127.0.0.1:0", server)
            .await
            .unwrap();

        let mut packet = b"GET /api/v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Key: key\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
            .to_vec();
        // A masked Ping with no payload, sent alongside the handshake.
        packet.extend_from_slice(&masked_frame(OP_PING, b""));

        let mut client = TcpStream::connect(handle.local_addr).await.unwrap();
        client.write_all(&packet).await.unwrap();

        // The 101 and the Pong may arrive together or apart; keep reading until
        // a Pong frame (opcode 0xA) shows up.
        let mut seen = Vec::new();
        let mut got_pong = false;
        for _ in 0..40 {
            let mut chunk = [0_u8; 512];
            let read = client.read(&mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            seen.extend_from_slice(&chunk[..read]);
            if seen.windows(2).any(|w| w[0] == 0x8A && w[1] == 0x00) {
                got_pong = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let text = String::from_utf8_lossy(&seen).into_owned();
        assert!(text.contains("101 Switching Protocols"), "{text}");
        assert!(got_pong, "no Pong for the coalesced Ping: {seen:?}");
        handle.shutdown();
    }

    #[tokio::test]
    async fn the_greeting_reports_the_limits_a_client_writes_code_against() {
        let server = Arc::new(crate::server::HttpServer::in_memory().unwrap());
        let (mut client, _, handle) = connect_upgraded(&server, "key-hello").await;
        let hello = read_server_hello(&mut client).await;

        let id = hello["payload"]["ws_connection_id"]
            .as_str()
            .expect("an id to correlate logs by");
        assert!(!id.is_empty(), "{hello}");
        assert_eq!(
            hello["payload"]["heartbeat_ms"], 10_000,
            "kap-server's default period is what a client is told"
        );
        assert_eq!(
            hello["payload"]["max_event_buffer_size"],
            serde_json::json!(SUBSCRIBER_QUEUE_DEPTH),
            "the advertised buffer must be the real one"
        );

        handle.shutdown();
    }

    #[tokio::test]
    async fn a_client_hello_is_acknowledged_and_a_bad_credential_refused_in_frame() {
        let server = Arc::new(
            crate::server::HttpServer::in_memory()
                .unwrap()
                .with_auth(crate::server::auth::ServerAuth::Token(Arc::from("tok3n"))),
        );
        let handle = crate::server::http::serve("127.0.0.1:0", server)
            .await
            .unwrap();

        // A bearer header clears the handshake gate, so the frame-layer check is
        // the only thing left to answer the hello.
        let (mut client, _) =
            connect_client(handle.local_addr, "key-ok", &[("authorization", "Bearer tok3n")]).await;
        read_server_hello(&mut client).await;
        client
            .write_all(&masked_frame(
                OP_TEXT,
                br#"{"type":"client_hello","id":"c-1","payload":{}}"#,
            ))
            .await
            .unwrap();
        let ack: serde_json::Value =
            serde_json::from_str(&read_text_frame(&mut client).await).unwrap();
        assert_eq!(ack["type"], "ack", "{ack}");
        assert_eq!(ack["id"], "c-1", "the ack must echo the request id");
        assert_eq!(ack["code"], 0, "{ack}");
        assert_eq!(ack["msg"], "success", "{ack}");
        // No session authority yet, so nothing is claimed as attached.
        assert_eq!(ack["payload"]["accepted_subscriptions"], json!([]), "{ack}");

        // Presenting a *different* credential than the handshake did is what
        // kap-server's authorize() refuses: the ack says why, then the socket
        // closes.
        let (mut liar, _) = connect_client(
            handle.local_addr,
            "key-liar",
            &[("authorization", "Bearer tok3n")],
        )
        .await;
        read_server_hello(&mut liar).await;
        liar.write_all(&masked_frame(
                OP_TEXT,
                br#"{"type":"client_hello","id":"c-2","payload":{"token":"someone-elses"}}"#,
            ))
            .await
            .unwrap();
        let refusal: serde_json::Value =
            serde_json::from_str(&read_text_frame(&mut liar).await).unwrap();
        assert_eq!(refusal["code"], 40112, "{refusal}");
        assert_eq!(refusal["msg"], "unauthorized", "{refusal}");
        assert_eq!(refusal["id"], "c-2", "{refusal}");

        let mut tail = [0_u8; 4];
        liar.read_exact(&mut tail).await.unwrap();
        assert_eq!(tail[0], 0x88, "expected a Close after the refusal, got {tail:?}");
        assert_eq!(&tail[2..], &1000_u16.to_be_bytes());

        handle.shutdown();
    }

    #[tokio::test]
    async fn the_heartbeat_pings_on_its_own_schedule() {
        let server = Arc::new(
            crate::server::HttpServer::in_memory()
                .unwrap()
                .with_heartbeat(std::time::Duration::from_millis(50)),
        );
        let (mut client, _, handle) = connect_upgraded(&server, "key-beat").await;
        read_server_hello(&mut client).await;

        let first: serde_json::Value =
            serde_json::from_str(&read_text_frame(&mut client).await).unwrap();
        assert_eq!(first["type"], "ping", "{first}");
        let nonce = first["payload"]["nonce"].as_str().expect("a nonce");
        let second: serde_json::Value =
            serde_json::from_str(&read_text_frame(&mut client).await).unwrap();
        assert_eq!(second["type"], "ping", "{second}");
        assert_ne!(
            second["payload"]["nonce"], nonce,
            "a client correlates pings by nonce"
        );

        handle.shutdown();
    }

    #[test]
    fn close_codes_a_peer_must_not_send_are_rejected() {
        assert!(is_sendable_close(1000) && is_sendable_close(1001) && is_sendable_close(4000));
        // 1005/1006 are status-only, 1015 is reserved, and 1016..2999 is
        // reserved by the spec for future use.
        for code in [1004_u16, 1005, 1006, 1015, 1016, 2999, 999, 5000] {
            assert!(!is_sendable_close(code), "{code} must not be sendable");
        }
    }

    /// Build a masked client frame (the mask key is all zeros so the payload
    /// survives unchanged and the test stays readable).
    fn masked_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0x80 | opcode, 0x80 | payload.len() as u8];
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(payload);
        out
    }
}
