//! opencode 免费档的请求体适配。
//!
//! `https://opencode.ai/zen/*` 的免费模型在服务端有一道形状检查，会让引擎的默认
//! 请求体被拒：
//!
//! **形状关卡**：请求必须流式，且 `tools` 里要有小写的 `bash` 和 `read`。
//! 引擎的工具名是首字母大写的（`Bash` / `Read`），直接发会被拒：
//!
//! ```text
//! 403 {"type":"error","error":{"type":"FreeTierError",
//!     "message":"OpenCode's free tier can only be used from within OpenCode"}}
//! ```
//!
//! 引擎的工具派发（`tools::NativeToolset::execute`）和权限匹配
//! （`permission::Rule::matches`）都是大小写不敏感的，所以工具名只改出站方向，
//! 回程不需要任何映射。
//!
//! **思考等级不在这里改写。** 这里曾经有一张别名表，把 `max` / `xhigh` /
//! `minimal` 收敛成 `high` / `low`，理由是上游当时只认 `low` / `medium` /
//! `high` / `none`。上游的校验集合已经变了 —— 它自己会把合法集合报出来：
//!
//! ```text
//! 400 ... reasoning_effort: Invalid option: expected one of
//!     "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"
//! ```
//!
//! 实测（`mimo-v2.6-flash-free`）七个值全部 200，`max` 也 200，于是别名表变成
//! 了一次静默降级：用户配的 `max` 被改写成 `high` 发出去。所以 effort 一律按
//! 配置原样出站，唯一的出站过滤在 [`crate::llm::effort`] —— 它拦的是 `on` 这种
//! 主机侧记号，不是这里曾经收敛过的档位。

use serde_json::Value;

/// 需要改写的工具名。只列关卡实际检查的两个 —— 其余工具保持引擎的规范名，
/// 模型看到的列表与别处一致。关卡将来要求更多名字时在这里加一行。
pub const TOOL_NAME_ALIASES: &[(&str, &str)] = &[("Bash", "bash"), ("Read", "read")];

/// `base_url` 是否指向 opencode 的 zen 端点（`/zen/v1`、`/zen/go/v1` 都命中）。
pub fn is_opencode_endpoint(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return false;
    };
    url.host_str() == Some("opencode.ai") && url.path().starts_with("/zen/")
}

/// 就地改写请求体。工具名覆盖三种线上结构：OpenAI Chat Completions 把定义嵌在
/// `function` 下，Anthropic 与 OpenAI Responses 把 `name` 放在顶层，Google 把列表
/// 包在 `functionDeclarations` 里。没有对应字段、或值不在别名表里时原样保留。
pub fn apply(body: &mut Value) {
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        if let Some(function) = tool.get_mut("function") {
            rewrite_field(function, "name", TOOL_NAME_ALIASES);
        }
        rewrite_field(tool, "name", TOOL_NAME_ALIASES);
        if let Some(declarations) = tool
            .get_mut("functionDeclarations")
            .and_then(Value::as_array_mut)
        {
            for declaration in declarations {
                rewrite_field(declaration, "name", TOOL_NAME_ALIASES);
            }
        }
    }
}

/// 把 `container[field]` 按别名表换成别名。
fn rewrite_field(container: &mut Value, field: &str, aliases: &[(&str, &str)]) {
    let Some(current) = container.get(field).and_then(Value::as_str) else {
        return;
    };
    let Some((_, alias)) = aliases.iter().find(|(from, _)| *from == current) else {
        return;
    };
    if let Some(slot) = container.get_mut(field) {
        *slot = Value::String((*alias).to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(name: &str) -> Value {
        json!({
            "type": "function",
            "function": { "name": name, "description": "d", "parameters": { "type": "object" } }
        })
    }

    fn names(body: &Value) -> Vec<String> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn rewrites_only_the_aliased_names() {
        let mut body = json!({
            "model": "mimo-v2.6-flash-free",
            "tools": [
                tool("Bash"),
                tool("Read"),
                tool("Grep"),
                tool("Glob"),
                tool("Write"),
                tool("Edit"),
                tool("FetchURL"),
            ],
        });
        apply(&mut body);
        assert_eq!(
            names(&body),
            vec!["bash", "read", "Grep", "Glob", "Write", "Edit", "FetchURL"]
        );
    }

    #[test]
    fn rewrites_the_anthropic_and_responses_shapes() {
        let mut body = json!({
            "tools": [
                { "name": "Bash", "description": "d", "input_schema": { "type": "object" } },
                { "name": "Read", "description": "d", "input_schema": { "type": "object" } },
                { "name": "Grep", "description": "d", "input_schema": { "type": "object" } },
            ],
        });
        apply(&mut body);
        let got: Vec<&str> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(got, vec!["bash", "read", "Grep"]);
    }

    #[test]
    fn rewrites_the_google_shape() {
        let mut body = json!({
            "tools": [{
                "functionDeclarations": [
                    { "name": "Bash", "description": "d" },
                    { "name": "Read", "description": "d" },
                    { "name": "Glob", "description": "d" },
                ]
            }],
        });
        apply(&mut body);
        let got: Vec<&str> = body["tools"][0]["functionDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(got, vec!["bash", "read", "Glob"]);
    }

    #[test]
    fn leaves_the_reasoning_effort_alone() {
        // The upstream accepts the full enum now, so the adapter must not
        // rewrite a declared effort into a weaker one — a silent downgrade is
        // worse than a loud 400.
        for effort in ["low", "medium", "high", "xhigh", "max", "minimal", "none"] {
            let mut body = json!({ "reasoning_effort": effort });
            apply(&mut body);
            assert_eq!(body["reasoning_effort"], effort, "{effort} must survive");
        }
    }

    #[test]
    fn leaves_a_body_without_tools_untouched() {
        let mut body = json!({ "model": "m", "messages": [] });
        let before = body.clone();
        apply(&mut body);
        assert_eq!(body, before);
    }

    #[test]
    fn tolerates_malformed_tool_entries() {
        let mut body = json!({
            "tools": [
                { "type": "function" },
                { "function": {} },
                { "function": { "name": 7 } },
                tool("Bash"),
            ],
        });
        apply(&mut body);
        assert_eq!(body["tools"][3]["function"]["name"], "bash");
    }

    #[test]
    fn recognises_the_zen_endpoints() {
        assert!(is_opencode_endpoint("https://opencode.ai/zen/v1"));
        assert!(is_opencode_endpoint("https://opencode.ai/zen/go/v1"));
        assert!(is_opencode_endpoint("https://opencode.ai/zen/v1/"));
        assert!(is_opencode_endpoint("  https://opencode.ai/zen/v1  "));
    }

    #[test]
    fn rejects_other_endpoints() {
        assert!(!is_opencode_endpoint("https://api.deepseek.com"));
        assert!(!is_opencode_endpoint("https://opencode.ai/theme"));
        assert!(!is_opencode_endpoint("https://opencode.ai/"));
        assert!(!is_opencode_endpoint("http://127.0.0.1:18992/v1"));
        assert!(!is_opencode_endpoint("not a url"));
        assert!(!is_opencode_endpoint(""));
    }
}
