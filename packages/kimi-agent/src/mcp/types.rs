//! Protocol types for Model Context Protocol (MCP) wire communication.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallResult {
    pub content: Vec<McpContent>,
    #[serde(rename = "isError", default)]
    pub is_error: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_mcp_tool_deserialization_and_serialization() {
        let raw = json!({
            "name": "read_file",
            "description": "Read content of a file",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }
        });

        let tool: McpTool = serde_json::from_value(raw).expect("deserialization failed");
        assert_eq!(tool.name, "read_file");
        assert_eq!(tool.description.as_deref(), Some("Read content of a file"));
        assert_eq!(tool.input_schema["type"], "object");
        assert_eq!(tool.input_schema["properties"]["path"]["type"], "string");
        assert_eq!(tool.input_schema["required"][0], "path");

        // Re-serialize and verify wire key names match MCP protocol specification
        let serialized = serde_json::to_value(&tool).expect("serialization failed");
        assert_eq!(serialized["name"], "read_file");
        assert_eq!(serialized["description"], "Read content of a file");
        assert_eq!(serialized["inputSchema"]["type"], "object");
        assert!(serialized.get("input_schema").is_none());

        // Default inputSchema and optional description when omitted
        let minimal = json!({ "name": "minimal_tool" });
        let min_tool: McpTool = serde_json::from_value(minimal).expect("minimal tool failed");
        assert_eq!(min_tool.name, "minimal_tool");
        assert_eq!(min_tool.description, None);
        assert_eq!(min_tool.input_schema, Value::Null);
    }

    #[test]
    fn test_mcp_content_wire_mapping() {
        let raw_text = json!({
            "type": "text",
            "text": "File content here"
        });
        let content: McpContent = serde_json::from_value(raw_text).expect("deserialization failed");
        assert_eq!(content.content_type, "text");
        assert_eq!(content.text.as_deref(), Some("File content here"));

        let serialized = serde_json::to_value(&content).expect("serialization failed");
        assert_eq!(serialized["type"], "text");
        assert!(serialized.get("content_type").is_none());
        assert_eq!(serialized["text"], "File content here");

        // Non-text content without text field
        let raw_binary = json!({ "type": "image" });
        let bin_content: McpContent = serde_json::from_value(raw_binary).expect("deserialization failed");
        assert_eq!(bin_content.content_type, "image");
        assert_eq!(bin_content.text, None);
    }

    #[test]
    fn test_mcp_tool_call_result_defaults_and_roundtrip() {
        let raw = json!({
            "content": [
                { "type": "text", "text": "Execution successful" }
            ],
            "isError": false
        });
        let result: McpToolCallResult = serde_json::from_value(raw).expect("deserialization failed");
        assert!(!result.is_error);
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.content[0].content_type, "text");
        assert_eq!(result.content[0].text.as_deref(), Some("Execution successful"));

        // When isError is omitted, default to false per MCP spec
        let raw_default = json!({
            "content": []
        });
        let default_res: McpToolCallResult = serde_json::from_value(raw_default).expect("default failed");
        assert!(!default_res.is_error);
        assert!(default_res.content.is_empty());

        // Error result with isError = true
        let raw_err = json!({
            "content": [
                { "type": "text", "text": "File not found" }
            ],
            "isError": true
        });
        let err_res: McpToolCallResult = serde_json::from_value(raw_err).expect("error result failed");
        assert!(err_res.is_error);
        assert_eq!(err_res.content[0].text.as_deref(), Some("File not found"));

        let serialized = serde_json::to_value(&err_res).expect("serialization failed");
        assert_eq!(serialized["isError"], true);
        assert!(serialized.get("is_error").is_none());
    }
}
