//! 原生 Language Server 进程管理。

use std::path::Path;
use std::process::Stdio;
use tokio::process::{Child, Command};
use which::which;

/// 语言服务器管理工具
pub struct LanguageServerManager;

impl LanguageServerManager {
    /// 查找系统中对应的语言服务器可执行文件
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

    /// 启动指定的语言服务器进程
    pub fn start_server(binary_path: &str) -> Result<Child, std::io::Error> {
        Command::new(binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    }

    /// 优雅关闭语言服务器子进程
    pub async fn stop_server(child: &mut Child) -> Result<(), std::io::Error> {
        let _ = child.kill().await;
        let _ = child.wait().await?;
        Ok(())
    }
}

/// LSP 协议消息帧编码与解码器
pub struct LspFraming;

impl LspFraming {
    /// 将 JSON 负载编码为包含 Content-Length 头部的标准 LSP 协议字节流
    pub fn encode(payload: &serde_json::Value) -> Result<Vec<u8>, serde_json::Error> {
        let body = serde_json::to_vec(payload)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut msg = Vec::with_capacity(header.len() + body.len());
        msg.extend_from_slice(header.as_bytes());
        msg.extend_from_slice(&body);
        Ok(msg)
    }

    /// 从字节流缓冲区中尝试解码一个完整的 LSP JSON 消息（处理粘包与分包）
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

/// LSP 客户端会话句柄（封装子进程与双向管道交互）
pub struct LspClientSession {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    buffer: Vec<u8>,
    next_id: i64,
    pending_notifications: Vec<serde_json::Value>,
}

impl LspClientSession {
    /// 从已启动的语言服务器子进程中接管标准输入输出构建会话
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

    /// 发送单向通知（如 initialized, textDocument/didOpen 等，不带 id）
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

    /// 发送带自增 ID 的请求并返回分配的请求 ID
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

    /// 尝试从缓冲区解析或从管道中异步读取一个数据块
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

    /// 循环等待特定请求 ID 的响应，超时抛出错误
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

    /// 获取累积的服务器通知列表
    pub fn take_pending_notifications(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.pending_notifications)
    }

    /// 发送 initialize 请求握手并回送 initialized 通知
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

        // 收到 initialize 响应后，按照规范必须立即发送 initialized 通知完成握手
        self.send_notification("initialized", serde_json::json!({}))
            .await
            .map_err(|e| format!("Failed to send initialized notification: {e}"))?;

        Ok(response)
    }

    /// 通知服务器打开文档（同步文档内容与语言类型）
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

    /// 向服务器发起定义跳转请求
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

    /// 向服务器发起查找引用（Find References）请求
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

    /// 向服务器发起悬停信息（Hover）请求
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

    /// 向服务器发起获取文档符号树（Document Symbols）请求
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

    /// 关闭并等待子进程退出
    pub async fn shutdown(mut self) -> Result<(), std::io::Error> {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await?;
        Ok(())
    }
}

/// 将本地文件路径规范化为 LSP 标准 `file:///` URI
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
        // 传入前 10 个字节（分包未完成）
        buffer.extend_from_slice(&encoded[..10]);
        let res1 = LspFraming::decode(&mut buffer).unwrap();
        assert!(res1.is_none());

        // 补全剩余字节
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
        // 第一次读取解析第一包
        let res1 = LspFraming::decode(&mut buffer).unwrap();
        assert_eq!(res1, Some(msg1));

        // 第二次读取解析第二包
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
