//! 原生 LSP 工具执行器。
//!
//! 允许模型通过标准协议向语言服务器查询定义位置（Definition）、引用等。

use std::path::{Path, PathBuf};
use std::time::Duration;
use serde_json::Value;

use crate::native::lsp::{LanguageServerManager, LspClientSession};
use crate::turn_loop::types::ExecutableToolResult;

/// 推断文件扩展名对应的编程语言标识符
pub fn detect_language_id(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("rs") => Some("rust"),
        Some("ts") | Some("tsx") | Some("js") | Some("jsx") | Some("mjs") | Some("cjs") => Some("typescript"),
        Some("py") => Some("python"),
        _ => None,
    }
}

/// 执行 LSP 原生工具调用
pub async fn execute_lsp_tool(workspace_root: &Path, args: &Value) -> Option<ExecutableToolResult> {
    let action = match args.get("action").and_then(|v| v.as_str()) {
        Some(a) => a,
        None => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: "Missing required parameter 'action' (e.g. 'definition')".into(),
                is_error: true,
                note: None,
            });
        }
    };

    let raw_path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: "Missing required parameter 'path'".into(),
                is_error: true,
                note: None,
            });
        }
    };

    let target_path = if Path::new(raw_path).is_absolute() {
        PathBuf::from(raw_path)
    } else {
        workspace_root.join(raw_path)
    };

    if !target_path.exists() {
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: format!("Target file does not exist: {}", target_path.display()),
            is_error: true,
            note: None,
        });
    }

    let language_id = match detect_language_id(&target_path) {
        Some(lang) => lang,
        None => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Unsupported file type for LSP: {}", target_path.display()),
                is_error: true,
                note: None,
            });
        }
    };

    let server_bin = match LanguageServerManager::locate_server(language_id) {
        Some(bin) => bin,
        None => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Language server for language '{language_id}' is not installed or not in PATH."),
                is_error: true,
                note: None,
            });
        }
    };

    let file_text = match std::fs::read_to_string(&target_path) {
        Ok(t) => t,
        Err(e) => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Failed to read target file {}: {e}", target_path.display()),
                is_error: true,
                note: None,
            });
        }
    };

    let child = match LanguageServerManager::start_server(&server_bin) {
        Ok(c) => c,
        Err(e) => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Failed to start language server '{server_bin}': {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    let mut session = match LspClientSession::from_child(child) {
        Ok(s) => s,
        Err(e) => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Failed to initialize LSP stdio pipes: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    // 1. 初始化握手
    if let Err(e) = session.initialize(workspace_root, Duration::from_secs(5)).await {
        let _ = session.shutdown().await;
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: format!("LSP initialize failed: {e}"),
            is_error: true,
            note: None,
        });
    }

    // 2. 同步打开文档
    let _ = session.notify_did_open(&target_path, language_id, &file_text).await;

    // 3. 根据具体 action 发起 LSP 请求
    let action_res = match action {
        "definition" => {
            let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let character = args.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            session.goto_definition(&target_path, line, character, Duration::from_secs(5)).await
        }
        "references" => {
            let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let character = args.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let include_decl = args.get("include_declaration").and_then(|v| v.as_bool()).unwrap_or(true);
            session.find_references(&target_path, line, character, include_decl, Duration::from_secs(5)).await
        }
        "hover" => {
            let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let character = args.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            session.get_hover(&target_path, line, character, Duration::from_secs(5)).await
        }
        "symbols" | "document_symbols" => {
            session.get_document_symbols(&target_path, Duration::from_secs(5)).await
        }
        other => {
            let _ = session.shutdown().await;
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Unsupported LSP action: '{other}'. Currently supported: 'definition', 'references', 'hover', 'symbols'."),
                is_error: true,
                note: None,
            });
        }
    };

    let _ = session.shutdown().await;

    match action_res {
        Ok(val) => {
            Some(ExecutableToolResult {
                stop_turn: false,
                content: serde_json::to_string_pretty(&val).unwrap_or_else(|_| val.to_string()),
                is_error: false,
                note: None,
            })
        }
        Err(e) => {
            Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("LSP {action} failed: {e}"),
                is_error: true,
                note: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_language_id() {
        assert_eq!(detect_language_id(Path::new("src/main.rs")), Some("rust"));
        assert_eq!(detect_language_id(Path::new("src/index.ts")), Some("typescript"));
        assert_eq!(detect_language_id(Path::new("test.py")), Some("python"));
        assert_eq!(detect_language_id(Path::new("README.md")), None);
    }

    #[tokio::test]
    async fn test_lsp_tool_missing_params() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let res1 = execute_lsp_tool(&root, &serde_json::json!({})).await.unwrap();
        assert!(res1.is_error);
        assert!(res1.content.contains("Missing required parameter 'action'"));

        let res2 = execute_lsp_tool(&root, &serde_json::json!({ "action": "definition" })).await.unwrap();
        assert!(res2.is_error);
        assert!(res2.content.contains("Missing required parameter 'path'"));
    }

    #[tokio::test]
    async fn test_lsp_tool_nonexistent_file() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let res = execute_lsp_tool(&root, &serde_json::json!({
            "action": "definition",
            "path": "non_existent_file.rs"
        })).await.unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("Target file does not exist"));
    }

    #[tokio::test]
    async fn test_lsp_tool_unsupported_file_type() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let res = execute_lsp_tool(&root, &serde_json::json!({
            "action": "definition",
            "path": "README.md"
        })).await.unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("Unsupported file type for LSP"));
    }

    #[tokio::test]
    async fn test_lsp_tool_unsupported_action() {
        let root = PathBuf::from("G:/kimi/kimi-code");
        let res = execute_lsp_tool(&root, &serde_json::json!({
            "action": "unknown_action_xyz",
            "path": "packages/kimi-agent/src/lib.rs"
        })).await.unwrap();
        assert!(res.is_error);
        assert!(res.content.contains("Unsupported LSP action") || res.content.contains("not installed"));
    }
}
