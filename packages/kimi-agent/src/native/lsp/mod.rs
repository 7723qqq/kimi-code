//! Native Language Server process management.

use std::path::Path;
use std::process::Stdio;
use tokio::process::{Child, Command};
use which::which;

/// Language server management tool
pub struct LanguageServerManager;

impl LanguageServerManager {
    /// Look up the language server executable for a language on this system
    pub fn locate_server(language: &str) -> Option<String> {
        let binary_name = match language {
            "typescript" | "javascript" => "typescript-language-server",
            "rust" => "rust-analyzer",
            "python" => "pyright",
            _ => return None,
        };
        which(binary_name)
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    }

    /// Start the given language server process
    pub fn start_server(binary_path: &str) -> Result<Child, std::io::Error> {
        Command::new(binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    }

    /// Shut the language server child process down gracefully
    pub async fn stop_server(child: &mut Child) -> Result<(), std::io::Error> {
        let _ = child.kill().await;
        let _ = child.wait().await?;
        Ok(())
    }
}

/// LSP protocol message frame encoder and decoder
pub struct LspFraming;

impl LspFraming {
    /// Encode a JSON payload into a standard LSP protocol byte stream with a
    /// Content-Length header
    pub fn encode(payload: &serde_json::Value) -> Result<Vec<u8>, serde_json::Error> {
        let body = serde_json::to_vec(payload)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut msg = Vec::with_capacity(header.len() + body.len());
        msg.extend_from_slice(header.as_bytes());
        msg.extend_from_slice(&body);
        Ok(msg)
    }

    /// Try to decode one complete LSP JSON message out of the byte-stream buffer
    /// (handling both a coalesced batch and a split frame)
    pub fn decode(buffer: &mut Vec<u8>) -> Result<Option<serde_json::Value>, String> {
        let header_end_marker = b"\r\n\r\n";
        let marker_pos = match buffer.windows(4).position(|w| w == header_end_marker) {
            Some(pos) => pos,
            None => return Ok(None),
        };

        let header_bytes = &buffer[..marker_pos];
        let header_str = std::str::from_utf8(header_bytes)
            .map_err(|e| format!("Invalid UTF-8 in LSP headers: {e}"))?;

        let mut content_length: Option<usize> = None;
        for line in header_str.split("\r\n") {
            if let Some(val_str) = line.strip_prefix("Content-Length: ") {
                content_length = val_str.trim().parse::<usize>().ok();
            }
        }

        let length = match content_length {
            Some(len) => len,
            None => return Err("Missing or invalid Content-Length header in LSP frame".into()),
        };

        let body_start = marker_pos + 4;
        let body_end = body_start + length;

        if buffer.len() < body_end {
            return Ok(None);
        }

        let body_bytes = &buffer[body_start..body_end];
        let json_val: serde_json::Value = serde_json::from_slice(body_bytes)
            .map_err(|e| format!("Failed to parse LSP JSON payload: {e}"))?;

        buffer.drain(..body_end);
        Ok(Some(json_val))
    }
}

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// LSP client session handle (wrapping the child process and its two-way pipes)
pub struct LspClientSession {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    buffer: Vec<u8>,
    next_id: i64,
    pending_notifications: Vec<serde_json::Value>,
}

impl LspClientSession {
    /// Take over the stdin/stdout of an already-started language server child
    /// process to build a session
    pub fn from_child(mut child: Child) -> Result<Self, std::io::Error> {
        let stdin = child.stdin.take().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "Failed to capture child stdin",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "Failed to capture child stdout",
            )
        })?;

        Ok(Self {
            child,
            stdin,
            stdout,
            buffer: Vec::new(),
            next_id: 1,
            pending_notifications: Vec::new(),
        })
    }

    /// Send a one-way notification (e.g. initialized, textDocument/didOpen — no id)
    pub async fn send_notification(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), std::io::Error> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let frame = LspFraming::encode(&payload)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        self.stdin.write_all(&frame).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Send a request with an auto-incrementing id and return the id assigned
    pub async fn send_request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<i64, std::io::Error> {
        let id = self.next_id;
        self.next_id += 1;

        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let frame = LspFraming::encode(&payload)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        self.stdin.write_all(&frame).await?;
        self.stdin.flush().await?;
        Ok(id)
    }

    /// Try to parse a chunk out of the buffer, or read one asynchronously from
    /// the pipe
    pub async fn read_message(&mut self) -> Result<Option<serde_json::Value>, String> {
        if let Some(msg) = LspFraming::decode(&mut self.buffer)? {
            return Ok(Some(msg));
        }

        let mut temp_buf = [0u8; 4096];
        let bytes_read = self
            .stdout
            .read(&mut temp_buf)
            .await
            .map_err(|e| format!("Failed to read from child stdout: {e}"))?;

        if bytes_read == 0 {
            return Ok(None);
        }

        self.buffer.extend_from_slice(&temp_buf[..bytes_read]);
        LspFraming::decode(&mut self.buffer)
    }

    /// Loop until the response for a given request id arrives, erroring on
    /// timeout
    pub async fn wait_response(
        &mut self,
        target_id: i64,
        timeout_dur: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        let deadline = tokio::time::Instant::now() + timeout_dur;

        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());

            match tokio::time::timeout(remaining, self.read_message()).await {
                Ok(Ok(Some(msg))) => {
                    if msg.get("id").and_then(|id| id.as_i64()) == Some(target_id) {
                        return Ok(msg);
                    } else {
                        self.pending_notifications.push(msg);
                    }
                }
                Ok(Ok(None)) => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => return Err(format!("Timeout waiting for LSP response ID {target_id}")),
            }
        }

        Err(format!("Timeout waiting for LSP response ID {target_id}"))
    }

    /// Take the accumulated list of server notifications
    pub fn take_pending_notifications(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.pending_notifications)
    }

    /// Perform the handshake: send the initialize request, then the initialized
    /// notification
    pub async fn initialize(
        &mut self,
        root_path: &Path,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        let root_uri = path_to_uri(root_path);
        let params = serde_json::json!({
            "processId": null,
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "definition": { "dynamicRegistration": true },
                    "references": { "dynamicRegistration": true },
                    "hover": { "dynamicRegistration": true },
                    "documentSymbol": { "dynamicRegistration": true },
                    "synchronization": { "dynamicRegistration": true }
                }
            }
        });

        let req_id = self
            .send_request("initialize", params)
            .await
            .map_err(|e| format!("Failed to send initialize request: {e}"))?;

        let response = self.wait_response(req_id, timeout).await?;

        // Once the initialize response arrives, the spec requires sending the
        // initialized notification immediately to complete the handshake
        self.send_notification("initialized", serde_json::json!({}))
            .await
            .map_err(|e| format!("Failed to send initialized notification: {e}"))?;

        Ok(response)
    }

    /// Tell the server a document is open (syncing its content and language)
    pub async fn notify_did_open(
        &mut self,
        file_path: &Path,
        language_id: &str,
        text: &str,
    ) -> Result<(), std::io::Error> {
        let uri = path_to_uri(file_path);
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": 1,
                "text": text,
            }
        });
        self.send_notification("textDocument/didOpen", params).await
    }

    /// Issue a go-to-definition request to the server
    pub async fn goto_definition(
        &mut self,
        file_path: &Path,
        line: u32,
        character: u32,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        let uri = path_to_uri(file_path);
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
            },
            "position": {
                "line": line,
                "character": character,
            }
        });

        let req_id = self
            .send_request("textDocument/definition", params)
            .await
            .map_err(|e| format!("Failed to send definition request: {e}"))?;

        self.wait_response(req_id, timeout).await
    }

    /// Issue a find-references request to the server
    pub async fn find_references(
        &mut self,
        file_path: &Path,
        line: u32,
        character: u32,
        include_declaration: bool,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        let uri = path_to_uri(file_path);
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
            },
            "position": {
                "line": line,
                "character": character,
            },
            "context": {
                "includeDeclaration": include_declaration,
            }
        });

        let req_id = self
            .send_request("textDocument/references", params)
            .await
            .map_err(|e| format!("Failed to send references request: {e}"))?;

        self.wait_response(req_id, timeout).await
    }

    /// Issue a hover-info request to the server
    pub async fn get_hover(
        &mut self,
        file_path: &Path,
        line: u32,
        character: u32,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        let uri = path_to_uri(file_path);
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
            },
            "position": {
                "line": line,
                "character": character,
            }
        });

        let req_id = self
            .send_request("textDocument/hover", params)
            .await
            .map_err(|e| format!("Failed to send hover request: {e}"))?;

        self.wait_response(req_id, timeout).await
    }

    /// Issue a document-symbols request to the server
    pub async fn get_document_symbols(
        &mut self,
        file_path: &Path,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        let uri = path_to_uri(file_path);
        let params = serde_json::json!({
            "textDocument": {
                "uri": uri,
            }
        });

        let req_id = self
            .send_request("textDocument/documentSymbol", params)
            .await
            .map_err(|e| format!("Failed to send documentSymbol request: {e}"))?;

        self.wait_response(req_id, timeout).await
    }

    /// Close the session and wait for the child process to exit
    pub async fn shutdown(mut self) -> Result<(), std::io::Error> {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await?;
        Ok(())
    }
}

/// Normalize a local file path into a standard LSP `file:///` URI
pub fn path_to_uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    if raw.starts_with('/') {
        format!("file://{raw}")
    } else {
        format!("file:///{raw}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_locate_server_unsupported() {
        assert!(LanguageServerManager::locate_server("brainfuck").is_none());
    }

    #[test]
    fn test_lsp_framing_encode_and_decode_roundtrip() {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": "file:///workspace"
            }
        });

        let encoded = LspFraming::encode(&payload).unwrap();
        assert!(encoded.starts_with(b"Content-Length: "));

        let mut buffer = encoded.clone();
        let decoded = LspFraming::decode(&mut buffer).unwrap();
        assert!(decoded.is_some());
        assert_eq!(decoded.unwrap(), payload);
        assert!(buffer.is_empty());
    }

    #[test]
    fn test_lsp_framing_packet_fragmentation() {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": { "text": "fn main() {}" }
        });
        let encoded = LspFraming::encode(&payload).unwrap();

        let mut buffer = Vec::new();
        // Feed the first 10 bytes (the frame is not complete yet)
        buffer.extend_from_slice(&encoded[..10]);
        let res1 = LspFraming::decode(&mut buffer).unwrap();
        assert!(res1.is_none());

        // Complete the remaining bytes
        buffer.extend_from_slice(&encoded[10..]);
        let res2 = LspFraming::decode(&mut buffer).unwrap();
        assert_eq!(res2, Some(payload));
        assert!(buffer.is_empty());
    }

    #[test]
    fn test_lsp_framing_sticky_packets() {
        let msg1 = json!({ "id": 1, "result": "ok" });
        let msg2 = json!({ "id": 2, "result": "pong" });

        let mut combined = LspFraming::encode(&msg1).unwrap();
        combined.extend_from_slice(&LspFraming::encode(&msg2).unwrap());

        let mut buffer = combined;
        // The first read parses the first frame
        let res1 = LspFraming::decode(&mut buffer).unwrap();
        assert_eq!(res1, Some(msg1));

        // The second read parses the second frame
        let res2 = LspFraming::decode(&mut buffer).unwrap();
        assert_eq!(res2, Some(msg2));

        assert!(buffer.is_empty());
    }

    #[test]
    fn test_path_to_uri_conversion() {
        let p1 = Path::new("/workspace/src/lib.rs");
        assert_eq!(path_to_uri(p1), "file:///workspace/src/lib.rs");

        let p2 = Path::new("C:\\Users\\dev\\project\\main.rs");
        let uri2 = path_to_uri(p2);
        assert!(uri2.starts_with("file:///C:/Users/dev/project/main.rs"));
    }

    #[test]
    fn test_lsp_request_framing_extended() {
        let uri = path_to_uri(Path::new("src/main.rs"));
        let ref_params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": 10, "character": 4 },
            "context": { "includeDeclaration": true }
        });
        let req = json!({
            "jsonrpc": "2.0",
            "id": 101,
            "method": "textDocument/references",
            "params": ref_params
        });
        let encoded = LspFraming::encode(&req).expect("should encode references request");
        let mut buf = encoded;
        let decoded = LspFraming::decode(&mut buf)
            .expect("should decode")
            .expect("some");
        assert_eq!(decoded["method"], "textDocument/references");
        assert_eq!(decoded["id"], 101);
        assert_eq!(decoded["params"]["context"]["includeDeclaration"], true);

        let hover_params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": 5, "character": 2 }
        });
        let hover_req = json!({
            "jsonrpc": "2.0",
            "id": 102,
            "method": "textDocument/hover",
            "params": hover_params
        });
        let encoded_hover = LspFraming::encode(&hover_req).expect("should encode hover request");
        let mut buf_hover = encoded_hover;
        let decoded_hover = LspFraming::decode(&mut buf_hover)
            .expect("should decode")
            .expect("some");
        assert_eq!(decoded_hover["method"], "textDocument/hover");
        assert_eq!(decoded_hover["id"], 102);
    }
}
