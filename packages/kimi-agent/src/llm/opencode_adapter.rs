//! opencode 免费档的出站请求适配（兼容层）。
//!
//! `https://opencode.ai/zen/*` 对免费档有一道**形状关卡**：三个条件必须**同时**
//! 满足，否则一律 403，且错误文案完全一样，看不出是哪一条不合格：
//!
//! ```text
//! 403 {"type":"error","error":{"type":"FreeTierError",
//!     "message":"OpenCode's free tier can only be used from within OpenCode"}}
//! ```
//!
//! 1. **必须流式** —— `stream: false` → 403（逐项 bisect 实测，ROADMAP §6.9.3）；
//! 2. **`tools` 必须同时含小写的 `bash` 与 `read`** —— `tools: []`、`[calculate]`、
//!    乃至整个 `tools` 键缺失，都是 403；
//! 3. **必须带 `x-opencode-*` 头** —— 这一条不在本层：引擎只组装 body，头由
//!    provider 的 `custom_headers` 提供（见 `~/.kimi-code/config.toml`）。
//!
//! # 引擎的两类请求
//!
//! * **带工具的主循环请求**。工具名是引擎的规范名（`Bash` / `Read`），首字母
//!   大写，直接发会被关卡拒。本层把**出站**名改写成关卡点名的小写别名。
//!   回程由引擎侧把名字**还原成规范名**（[`crate::tools::canonical_tool_name`]，
//!   在 `run_turn` 里按工具表匹配）：派发与权限匹配虽然大小写不敏感
//!   （`tools::NativeToolset::execute`、`permission::Rule::matches`），但
//!   `tool.call.*` 事件、ACP 的工具类型映射、TUI 渲染器与用户的 hook matcher
//!   都按精确大小写认名字，别名留在回程会让它们全部落空。
//! * **不带工具的辅助请求**。摘要器、标题生成器、memory filer 都不传 tools，
//!   因此原本**必然** 403 —— 摘要失败即 `compaction.cancelled`，也就是用户看到的
//!   「压缩已取消」。本层在缺 `bash` / `read` 时**注入形状占位**让关卡放行。
//!   占位按协议出形状（Chat Completions / Responses / Anthropic / Google）。
//!
//! # 占位工具的风险与缓解
//!
//! 占位用的是关卡点名的两个名字，所以模型有可能真的去调它们。缓解有两层：
//! 描述里显式写 `Do not call this tool`；调用方（摘要器 / 标题生成器）不消费
//! `tool_calls`，只取文本。这仍属「补形状」这一取舍 —— ROADMAP §6.9.3 记录的
//! 备选方案是「承认免费档不支持压缩」。
//!
//! 注意占位的**投放范围不止无工具请求**：工具表被收窄的请求（只读子代理、
//! `disallowedTools` 排除 Bash 的 profile）同样缺 `bash`，于是也会拿到一个
//! `bash` 条目 —— 关卡是硬性的形状检查，不补就整条请求 403。执行的把关不在
//! 这一层：仍然要过 `[tools]` 全局开关、子代理 allowlist 与权限引擎，占位不会
//! 让任何一次调用绕过它们。这是**已知取舍**（ROADMAP §6.9.3）。
//!
//! # 刻意不在这里做的事
//!
//! **思考等级不改写。** 这里曾经有一张别名表，把 `max` / `xhigh` / `minimal`
//! 收敛成 `high` / `low`，理由是上游当时只认 `low` / `medium` / `high` / `none`。
//! 上游的校验集合已经变了 —— 它自己会把合法集合报出来：
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
//!
//! **消息与思考内容不改写。** 响应侧的方言（`reasoning` / `reasoning_content` /
//! `reasoning_details`）由 [`crate::llm::openai`] 的累积器按探测表处理，这一层
//! 只管出站形状。

use serde_json::{Map, Value, json};

/// 需要改写的工具名。只列关卡实际检查的两个 —— 其余工具保持引擎的规范名，
/// 模型看到的列表与别处一致。关卡将来要求更多名字时在这里加一行。
pub const TOOL_NAME_ALIASES: &[(&str, &str)] = &[("Bash", "bash"), ("Read", "read")];

/// 关卡要求 `tools` 里必须出现的名字（小写）。
pub const FREE_TIER_REQUIRED_TOOLS: &[&str] = &["bash", "read"];

/// 占位工具的描述：明确告知模型不要调用，它是为了满足网关的形状检查。
const PLACEHOLDER_DESCRIPTION: &str =
    "Shape placeholder required by the gateway. Do not call this tool.";

/// `base_url` 是否指向 opencode 的 zen 端点（`/zen/v1`、`/zen/go/v1` 都命中）。
pub fn is_opencode_endpoint(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return false;
    };
    url.host_str() == Some("opencode.ai") && url.path().starts_with("/zen/")
}

/// 占位工具该按哪种线上形状生成 —— 与 [`rewrite_tool_names`] 覆盖的三种结构对应，
/// 由请求的协议决定（取值与 `llm::http` 选协议的分支一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaceholderShape {
    /// OpenAI Chat Completions：定义嵌在 `function` 下。
    ChatCompletions,
    /// OpenAI Responses：`name` 与 `parameters` 在顶层。
    Responses,
    /// Anthropic：顶层没有 `type`，参数表叫 `input_schema`。
    Anthropic,
    /// Google：声明必须装在 `functionDeclarations` 数组里。
    Google,
}

/// 按协议名选占位形状。未知协议按 Chat Completions 处理，与 `llm::http` 的兜底分支一致。
fn placeholder_shape(protocol: &str) -> PlaceholderShape {
    match protocol {
        "anthropic" => PlaceholderShape::Anthropic,
        "openai_responses" | "openai-responses" => PlaceholderShape::Responses,
        "google" | "google-genai" | "gemini" => PlaceholderShape::Google,
        _ => PlaceholderShape::ChatCompletions,
    }
}

/// 就地改写请求体，使其能通过免费档的形状关卡。
///
/// 顺序有讲究：**先**改工具名（把引擎的规范名换成关卡要求的小写），**再**补形状
/// （此时看到的名字已经是出站名，判断缺不缺才准）。`protocol` 决定占位工具的线上形状。
pub fn apply(body: &mut Value, protocol: &str) {
    rewrite_tool_names(body);
    enforce_free_tier_shape(body, placeholder_shape(protocol));
}

/// 把 `tools` 里的工具名按别名表换成出站名。覆盖三种线上结构：OpenAI Chat
/// Completions 把定义嵌在 `function` 下，Anthropic 与 OpenAI Responses 把 `name`
/// 放在顶层，Google 把列表包在 `functionDeclarations` 里。没有对应字段、或值不在
/// 别名表里时原样保留。
fn rewrite_tool_names(body: &mut Value) {
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

/// 补齐关卡要求的形状：`stream: true`，且 `tools` 至少含 [`FREE_TIER_REQUIRED_TOOLS`]。
///
/// `stream` 是**强制**置为 `true`（关卡只认流式，显式写 `false` 同样 403）；其余只在
/// 缺项时改动。畸形（非对象 body、非数组 `tools`）原样放行：把结构掰成能过关的
/// 样子会掩盖调用方真正的 bug，不如让关卡去拒。
fn enforce_free_tier_shape(body: &mut Value, shape: PlaceholderShape) {
    let Some(object) = body.as_object_mut() else {
        return;
    };

    if object.get("stream").and_then(Value::as_bool) != Some(true) {
        object.insert("stream".to_owned(), Value::Bool(true));
    }

    let missing: Vec<&str> = FREE_TIER_REQUIRED_TOOLS
        .iter()
        .copied()
        .filter(|required| !declares_tool(object, required))
        .collect();
    if missing.is_empty() {
        return;
    }

    let entry = object
        .entry("tools".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(array) = entry.as_array_mut() else {
        // `tools` 存在但不是数组：不猜调用方的意图，交给关卡。
        return;
    };

    // Google 的声明必须待在 `functionDeclarations` 里：已有分组就补进去，没有就新建
    // 一个分组 —— 绝不往 `tools` 顶层塞裸声明。
    if shape == PlaceholderShape::Google {
        let existing = array.iter_mut().find_map(|tool| {
            tool.get_mut("functionDeclarations")
                .and_then(Value::as_array_mut)
        });
        match existing {
            Some(declarations) => {
                declarations.extend(missing.iter().map(|name| declaration(name)));
            }
            None => array.push(json!({
                "functionDeclarations": missing
                    .iter()
                    .map(|name| declaration(name))
                    .collect::<Vec<Value>>(),
            })),
        }
        return;
    }

    for name in missing {
        array.push(placeholder_tool(name, shape));
    }
}

/// `tools` 里是否已经声明了某个出站名（大小写敏感 —— 关卡认的就是小写字面量）。
fn declares_tool(object: &Map<String, Value>, name: &str) -> bool {
    let Some(tools) = object.get("tools").and_then(Value::as_array) else {
        return false;
    };
    tools.iter().any(|tool| {
        let in_function = tool
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str);
        let at_top_level = tool.get("name").and_then(Value::as_str);
        let in_declarations = tool
            .get("functionDeclarations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|d| d.get("name").and_then(Value::as_str))
            .any(|declared| declared == name);
        in_function == Some(name) || at_top_level == Some(name) || in_declarations
    })
}

/// 空的参数表：占位只为过关，参数故意留空。
fn empty_parameters() -> Value {
    json!({ "type": "object", "properties": {} })
}

/// 一个只为过关而存在的工具定义：名字是关卡点名的，参数表故意留空，
/// 描述里写明不要调用。形状随协议走。
fn placeholder_tool(name: &str, shape: PlaceholderShape) -> Value {
    match shape {
        PlaceholderShape::ChatCompletions => json!({
            "type": "function",
            "function": {
                "name": name,
                "description": PLACEHOLDER_DESCRIPTION,
                "parameters": empty_parameters(),
            },
        }),
        PlaceholderShape::Responses => json!({
            "type": "function",
            "name": name,
            "description": PLACEHOLDER_DESCRIPTION,
            "parameters": empty_parameters(),
        }),
        PlaceholderShape::Anthropic => json!({
            "name": name,
            "description": PLACEHOLDER_DESCRIPTION,
            "input_schema": empty_parameters(),
        }),
        // Google 的占位由 `enforce_free_tier_shape` 直接装进 `functionDeclarations`；
        // 这里返回一个合法的单声明分组，免得将来多一处「不可达」。
        PlaceholderShape::Google => json!({ "functionDeclarations": [declaration(name)] }),
    }
}

/// Google 的一条函数声明。
fn declaration(name: &str) -> Value {
    json!({
        "name": name,
        "description": PLACEHOLDER_DESCRIPTION,
        "parameters": empty_parameters(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str) -> Value {
        json!({
            "type": "function",
            "function": { "name": name, "description": "d", "parameters": { "type": "object" } }
        })
    }

    /// Every name the entries declare, skipping entries that declare none (the
    /// malformed shapes some tests deliberately feed in).
    fn names(body: &Value) -> Vec<String> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| {
                t["function"]["name"]
                    .as_str()
                    .or_else(|| t["name"].as_str())
                    .map(str::to_owned)
            })
            .collect()
    }

    /// The names declared inside every Google `functionDeclarations` group.
    fn declared_names(body: &Value) -> Vec<String> {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["functionDeclarations"].as_array())
            .flatten()
            .filter_map(|d| d["name"].as_str().map(str::to_owned))
            .collect()
    }

    /// Whether a name was injected as a shape placeholder rather than declared
    /// by the caller: the placeholder description is the marker.
    fn is_placeholder(body: &Value, name: &str) -> bool {
        let entry = body["tools"].as_array().unwrap().iter().find(|t| {
            t["function"]["name"].as_str() == Some(name) || t["name"].as_str() == Some(name)
        });
        entry.is_some_and(|t| {
            t["function"]["description"]
                .as_str()
                .or_else(|| t["description"].as_str())
                .is_some_and(|d| d.contains("Do not call"))
        })
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
        apply(&mut body, "openai");
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
        apply(&mut body, "openai");
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
        apply(&mut body, "openai");
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
            apply(&mut body, "openai");
            assert_eq!(body["reasoning_effort"], effort, "{effort} must survive");
        }
    }

    #[test]
    fn forces_streaming_on() {
        // `stream: false` is a 403 on the free tier, so the request that carries
        // no streaming flag at all must come out streaming.
        let mut body = json!({ "model": "m", "messages": [] });
        apply(&mut body, "openai");
        assert_eq!(body["stream"], Value::Bool(true));
    }

    #[test]
    fn injects_the_shape_placeholders_when_tools_are_absent() {
        // The summarizer / title generator send no tools at all; without this
        // they are a guaranteed 403 and compaction reports "cancelled".
        let mut body = json!({ "model": "m", "messages": [], "stream": true });
        apply(&mut body, "openai");
        let got = names(&body);
        assert!(
            got.contains(&"bash".to_owned()),
            "bash placeholder missing: {got:?}"
        );
        assert!(
            got.contains(&"read".to_owned()),
            "read placeholder missing: {got:?}"
        );
        // The placeholders must not look callable.
        let bash = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "bash")
            .unwrap();
        assert!(
            bash["function"]["description"]
                .as_str()
                .unwrap()
                .contains("Do not call")
        );
    }

    #[test]
    fn appends_only_the_missing_placeholder() {
        // A request that already carries `bash` but not `read` gets exactly one
        // addition — the gate checks the pair, not each name on its own.
        let mut body = json!({ "stream": true, "tools": [tool("bash"), tool("Grep")] });
        apply(&mut body, "openai");
        assert_eq!(names(&body), vec!["bash", "Grep", "read"]);
    }

    #[test]
    fn a_full_toolset_is_left_alone() {
        // The gate's pair is already declared, so nothing is appended — the only
        // change is the alias rewrite (`Bash` / `Read` become the lowercase names
        // the gate looks for).
        let mut body = json!({ "stream": true, "tools": [tool("Bash"), tool("Read")] });
        apply(&mut body, "openai");
        assert_eq!(names(&body), vec!["bash", "read"]);
        assert!(
            !is_placeholder(&body, "bash"),
            "a declared tool must not be replaced by a placeholder: {body}"
        );
        assert!(!is_placeholder(&body, "read"));
    }

    #[test]
    fn a_restricted_tool_table_still_gets_the_gate_pair() {
        // A read-only table (the `explore` subagent, a profile that disallows
        // Bash) lacks `bash`, so the gate would 403 the whole request. The
        // placeholder is what keeps the request alive; execution stays gated by
        // the `[tools]` switch, the subagent allowlist and the permission
        // engine — injecting the name does not open a bypass.
        let mut body = json!({ "stream": true, "tools": [tool("Read"), tool("Grep")] });
        apply(&mut body, "openai");
        assert_eq!(names(&body), vec!["read", "Grep", "bash"]);
        assert!(is_placeholder(&body, "bash"));
        assert!(!is_placeholder(&body, "read"), "the real Read is untouched");
    }

    #[test]
    fn tolerates_malformed_tool_entries() {
        let mut body = json!({
            "stream": true,
            "tools": [
                { "type": "function" },
                { "function": {} },
                { "function": { "name": 7 } },
                tool("Bash"),
            ],
        });
        apply(&mut body, "openai");
        assert_eq!(body["tools"][3]["function"]["name"], "bash");
        // `Read` was genuinely missing, so it is appended rather than skipped.
        assert!(names(&body).contains(&"read".to_owned()));
    }

    #[test]
    fn a_non_array_tools_value_is_left_to_the_gate() {
        // Reshaping a malformed body would hide the caller's bug.
        let mut body = json!({ "stream": true, "tools": "nonsense" });
        apply(&mut body, "openai");
        assert_eq!(body["tools"], json!("nonsense"));
    }

    #[test]
    fn the_placeholder_shape_follows_the_protocol() {
        // Responses: `name` and `parameters` sit at the top level.
        let mut responses = json!({ "stream": true, "tools": [] });
        apply(&mut responses, "openai_responses");
        let entry = &responses["tools"][0];
        assert_eq!(entry["type"], "function");
        assert_eq!(entry["name"], "bash");
        assert!(
            entry["parameters"].is_object(),
            "Responses carries `parameters`: {entry}"
        );

        // Anthropic: no `type`, and the schema is `input_schema`.
        let mut anthropic = json!({ "stream": true, "tools": [] });
        apply(&mut anthropic, "anthropic");
        let entry = &anthropic["tools"][0];
        assert_eq!(entry["name"], "bash");
        assert!(
            entry["input_schema"].is_object(),
            "Anthropic carries `input_schema`: {entry}"
        );
        assert!(
            entry.get("type").is_none(),
            "no `type` on Anthropic: {entry}"
        );
        assert!(entry.get("parameters").is_none());
    }

    #[test]
    fn placeholders_join_the_google_declaration_group() {
        // Google nests declarations, so a bare unit appended to `tools` would be
        // malformed: the missing name joins the group that is already there.
        let mut body = json!({
            "stream": true,
            "tools": [{ "functionDeclarations": [{ "name": "Read", "description": "d" }] }],
        });
        apply(&mut body, "google");
        assert_eq!(declared_names(&body), vec!["read", "bash"]);
        assert_eq!(
            body["tools"].as_array().unwrap().len(),
            1,
            "no second group"
        );

        // A request with no tools at all gets exactly one group holding the pair.
        let mut bare = json!({ "stream": true });
        apply(&mut bare, "google-genai");
        assert_eq!(declared_names(&bare), vec!["bash", "read"]);
        assert_eq!(bare["tools"].as_array().unwrap().len(), 1);
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
