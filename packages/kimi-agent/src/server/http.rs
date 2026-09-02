//! HTTP/1.1 transport for the native REST surface: TCP accept loop, strict
//! request parsing, response serialization.
//!
//! Zero new crates — `httparse` and tokio's `net` feature are already in the
//! build graph (the latter via reqwest, now declared explicitly so a reqwest
//! feature change cannot silently break this file).
//!
//! Deliberately minimal, in the direction of refusing work rather than guessing
//! at it:
//!
//! - **One request per connection.** Every REST response carries
//!   `Connection: close`, so there is no keep-alive state machine, no
//!   pipelining, and no framing ambiguity between two requests on one socket.
//!   The sole exception is a WebSocket upgrade, which keeps the socket and
//!   hands its framing to [`ws`].
//! - **`Content-Length` only.** Any `Transfer-Encoding` is rejected, which
//!   closes the CL.TE / TE.CL request-smuggling family outright instead of
//!   implementing both framings and deciding which one wins.
//! - **CRLF required.** A bare LF anywhere in the header block is refused —
//!   mixed line endings are how two parsers disagree about where a request ends.
//! - **Origin-form targets only.** Absolute-URI targets (`GET http://…`) are
//!   rejected: this is an origin server, not a proxy.
//! - **Bounded reads.** Header block and body each have a hard cap, and a
//!   connection that stops talking is dropped on a timeout.
//!
//! The query string is stripped before dispatch so a route cannot be reached by
//! appending `?x=1`; nothing downstream sees it yet, because `HttpRequest` has no
//! query field.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Duration, timeout};

use crate::server::HttpServer;
use crate::server::router::{HttpRequest, HttpResponse};
use crate::server::ws;

/// Hard cap on the request header block, including the request line.
const MAX_HEADER_BYTES: usize = 16 * 1024;
/// Hard cap on a request body.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// How long a connection may take to send a complete request.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Read granularity while filling in a body.
const CHUNK_BYTES: usize = 8 * 1024;

/// Why a request was refused. Rendered as a `400` with no engine involvement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RejectReason {
    Malformed(&'static str),
    HeaderTooLarge,
    TransferEncoding,
    ContentLengthInvalid,
    BodyTooLarge,
    OriginFormRequired,
}

impl RejectReason {
    fn message(&self) -> &'static str {
        match self {
            Self::Malformed(what) => what,
            Self::HeaderTooLarge => "header block exceeds the 16 KiB limit",
            Self::TransferEncoding => "Transfer-Encoding is not supported",
            Self::ContentLengthInvalid => "Content-Length is not a valid integer",
            Self::BodyTooLarge => "body exceeds the 4 MiB limit",
            Self::OriginFormRequired => "origin-form request target is required",
        }
    }
}

/// A running accept loop. Shutting it down stops new connections; in-flight
/// connections finish on their own.
pub struct ServerHandle {
    pub local_addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub fn shutdown(self) {
        self.task.abort();
    }
}

/// Bind `addr` and serve the REST surface until the handle is shut down.
///
/// Binding to port `0` works: the OS-assigned port comes back in
/// [`ServerHandle::local_addr`], which is how the tests drive a real socket.
pub async fn serve(addr: &str, server: Arc<HttpServer>) -> io::Result<ServerHandle> {
    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;

    let task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    let server = server.clone();
                    tokio::spawn(async move {
                        let _ = serve_connection(stream, server).await;
                    });
                }
                Err(error) => {
                    // A failed accept (descriptor limit, peer gone mid-handshake)
                    // is not fatal: keep listening.
                    tracing::warn!(%error, "accept failed");
                }
            }
        }
    });

    Ok(ServerHandle { local_addr, task })
}

async fn serve_connection(mut stream: TcpStream, server: Arc<HttpServer>) -> io::Result<()> {
    let received = match timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(Some(received))) => received,
        Ok(Ok(None)) => return Ok(()),
        Ok(Err(reason)) => {
            return write_response(&mut stream, &HttpResponse::bad_request(reason.message())).await;
        }
        Err(_elapsed) => {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "read timeout"));
        }
    };

    if ws::is_upgrade(&received.request) {
        let Received { request, leftover } = received;
        return match ws::serve_ws(stream, &request, leftover, server.hub()).await {
            Ok(()) => Ok(()),
            Err(ws::WsError::Io(error)) => Err(error),
            Err(error) => {
                // The ws layer already answered a framing violation with a
                // Close frame; there is nothing left for the caller to do.
                tracing::debug!(?error, "websocket connection closed");
                Ok(())
            }
        };
    }

    let response = server.handle_request(&received.request).await;
    write_response(&mut stream, &response).await
}

/// One parsed request plus the bytes that arrived in the same packet after it.
struct Received {
    request: HttpRequest,
    leftover: Vec<u8>,
}

/// Read exactly one request off the socket. `None` means the peer closed the
/// connection before sending anything.
async fn read_request(stream: &mut TcpStream) -> Result<Option<Received>, RejectReason> {
    let mut buffered: Vec<u8> = Vec::with_capacity(CHUNK_BYTES);
    let mut chunk = vec![0_u8; CHUNK_BYTES];

    let header_end = loop {
        if let Some(position) = find_header_end(&buffered) {
            break position;
        }
        if buffered.len() >= MAX_HEADER_BYTES {
            return Err(RejectReason::HeaderTooLarge);
        }
        let read = stream.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            return if buffered.is_empty() {
                Ok(None)
            } else {
                Err(RejectReason::Malformed("connection closed mid-request"))
            };
        }
        buffered.extend_from_slice(&chunk[..read]);
    };

    let (head, remainder) = buffered.split_at(header_end + 4);
    let mut request = parse_head(head)?;
    let expected = declared_body_len(&request.headers)?;
    if expected > MAX_BODY_BYTES {
        return Err(RejectReason::BodyTooLarge);
    }

    let mut body = remainder.to_vec();
    while body.len() < expected {
        let read = stream.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            return Err(RejectReason::Malformed("connection closed mid-body"));
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > MAX_BODY_BYTES {
            return Err(RejectReason::BodyTooLarge);
        }
    }

    // Bytes past `expected` are either a WebSocket frame that shared the
    // handshake packet or a pipelined request; hand them on rather than drop
    // them, since the ws path reads frames from this same socket.
    let leftover = if body.len() > expected {
        body.split_off(expected)
    } else {
        Vec::new()
    };
    request.body = body;
    Ok(Some(Received { request, leftover }))
}

/// Locate the blank line that ends the header block.
fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// True when a LF is not preceded by CR, or a CR is not followed by LF.
fn has_bare_line_feed(buffer: &[u8]) -> bool {
    buffer.iter().enumerate().any(|(index, byte)| match byte {
        b'\n' => index == 0 || buffer[index - 1] != b'\r',
        b'\r' => buffer.get(index + 1) != Some(&b'\n'),
        _ => false,
    })
}

fn parse_head(head: &[u8]) -> Result<HttpRequest, RejectReason> {
    if has_bare_line_feed(head) {
        return Err(RejectReason::Malformed(
            "bare LF or lone CR in header block",
        ));
    }

    let mut header_slots = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut header_slots);

    match parsed.parse(head) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => {
            return Err(RejectReason::Malformed("incomplete request head"));
        }
        Err(_) => return Err(RejectReason::Malformed("malformed request line or headers")),
    }

    let target = parsed
        .path
        .ok_or(RejectReason::Malformed("missing request target"))?;
    let path = match target.split_once(['?', '#']) {
        Some((path, _)) => path,
        None => target,
    };
    if !path.starts_with('/') {
        return Err(RejectReason::OriginFormRequired);
    }

    let method = parsed.method.unwrap_or("GET").to_ascii_uppercase();
    let mut headers = HashMap::new();
    for header in parsed.headers {
        headers.insert(
            header.name.to_ascii_lowercase(),
            String::from_utf8_lossy(header.value).into_owned(),
        );
    }

    Ok(HttpRequest {
        method,
        path: path.to_string(),
        headers,
        body: Vec::new(),
    })
}

fn declared_body_len(headers: &HashMap<String, String>) -> Result<usize, RejectReason> {
    if headers.contains_key("transfer-encoding") {
        return Err(RejectReason::TransferEncoding);
    }
    match headers.get("content-length") {
        None => Ok(0),
        Some(value) => value
            .trim()
            .parse::<usize>()
            .map_err(|_| RejectReason::ContentLengthInvalid),
    }
}

/// Serialize a response and close the connection.
async fn write_response(stream: &mut TcpStream, response: &HttpResponse) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        reason_phrase(response.status),
        response.body.len(),
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");

    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&response.body).await?;
    stream.flush().await?;
    stream.shutdown().await
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "Unknown Status",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(head: &[u8]) -> Result<HttpRequest, RejectReason> {
        parse_head(head)
    }

    #[test]
    fn accepts_a_plain_origin_form_get() {
        let request = parse(b"GET /api/v1/health HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/api/v1/health");
        assert_eq!(request.headers.get("host").map(String::as_str), Some("x"));
    }

    #[test]
    fn lowercases_and_uppercases_for_case_insensitive_matching() {
        let request = parse(b"get /a HTTP/1.1\r\nCONTENT-LENGTH: 0\r\n\r\n").unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.headers.get("content-length").map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn strips_the_query_string_from_the_dispatched_path() {
        let request = parse(b"GET /api/v1/sessions?limit=1 HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(request.path, "/api/v1/sessions");
    }

    #[test]
    fn rejects_a_bare_lf_line_ending() {
        // Two parsers disagreeing about where a request ends is how smuggling
        // happens, so a mixed line ending must never reach the dispatcher.
        let error = parse(b"GET /a HTTP/1.1\nHost: x\r\n\r\n").unwrap_err();
        assert!(matches!(error, RejectReason::Malformed(_)), "{error:?}");
    }

    #[test]
    fn rejects_an_absolute_form_target() {
        let error = parse(b"GET http://example.test/a HTTP/1.1\r\n\r\n").unwrap_err();
        assert_eq!(error, RejectReason::OriginFormRequired);
    }

    #[test]
    fn more_than_64_headers_is_malformed_not_silently_truncated() {
        let mut head = b"GET /a HTTP/1.1\r\n".to_vec();
        for index in 0..70 {
            head.extend_from_slice(format!("X-T{index}: v\r\n").as_bytes());
        }
        head.extend_from_slice(b"\r\n");
        assert!(matches!(
            parse(&head).unwrap_err(),
            RejectReason::Malformed(_)
        ));
    }

    #[test]
    fn transfer_encoding_is_refused_rather_than_interpreted() {
        let mut headers = HashMap::new();
        headers.insert("transfer-encoding".into(), "chunked".into());
        assert_eq!(
            declared_body_len(&headers).unwrap_err(),
            RejectReason::TransferEncoding
        );
    }

    #[test]
    fn content_length_must_be_a_number() {
        let mut headers = HashMap::new();
        headers.insert("content-length".into(), "abc".into());
        assert_eq!(
            declared_body_len(&headers).unwrap_err(),
            RejectReason::ContentLengthInvalid
        );
        headers.insert("content-length".into(), "12".into());
        assert_eq!(declared_body_len(&headers).unwrap(), 12);
        assert_eq!(declared_body_len(&HashMap::new()).unwrap(), 0);
    }

    #[tokio::test]
    async fn serves_a_real_request_over_a_real_socket() {
        let server = Arc::new(HttpServer::in_memory().unwrap());
        let handle = serve("127.0.0.1:0", server).await.unwrap();

        let mut stream = TcpStream::connect(handle.local_addr).await.unwrap();
        stream
            .write_all(b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response).into_owned();

        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
        assert!(text.contains("Connection: close"), "{text}");
        assert!(text.contains("kimi-agent-rust"), "{text}");

        handle.shutdown();
    }

    #[tokio::test]
    async fn posts_a_session_over_a_real_socket() {
        let server = Arc::new(HttpServer::in_memory().unwrap());
        let handle = serve("127.0.0.1:0", server).await.unwrap();

        let body = br#"{"title":"over TCP"}"#;
        let mut request = format!(
            "POST /api/v1/sessions HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        request.extend_from_slice(body);

        let mut stream = TcpStream::connect(handle.local_addr).await.unwrap();
        stream.write_all(&request).await.unwrap();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response).into_owned();

        assert!(text.starts_with("HTTP/1.1 201 Created\r\n"), "{text}");
        assert!(text.contains("over TCP"), "{text}");

        // The session persisted, so the list route sees it.
        let mut second = TcpStream::connect(handle.local_addr).await.unwrap();
        second
            .write_all(b"GET /api/v1/sessions HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut listed = Vec::new();
        second.read_to_end(&mut listed).await.unwrap();
        assert!(
            String::from_utf8_lossy(&listed).contains("over TCP"),
            "session did not survive the request"
        );

        handle.shutdown();
    }

    #[tokio::test]
    async fn refuses_chunked_before_touching_any_route() {
        let server = Arc::new(HttpServer::in_memory().unwrap());
        let handle = serve("127.0.0.1:0", server).await.unwrap();

        let mut stream = TcpStream::connect(handle.local_addr).await.unwrap();
        stream
            .write_all(
                b"POST /api/v1/sessions HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{}\r\n0\r\n\r\n",
            )
            .await
            .unwrap();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response).into_owned();

        assert!(text.starts_with("HTTP/1.1 400 Bad Request\r\n"), "{text}");
        assert!(text.contains("Transfer-Encoding"), "{text}");

        handle.shutdown();
    }
}
