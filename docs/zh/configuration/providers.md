# 平台与模型

Kimi Code CLI 支持同时接入多家模型供应商服务，模型在供应商之上声明自己的名称、上下文长度和能力。本页介绍如何在 `config.toml` 里配置各种供应商。

## 支持的供应商类型

`providers` 表里的 `type` 字段决定使用哪种协议实现：

| 类型 | 协议 | 典型用途 |
| --- | --- | --- |
| [`kimi`](#kimi) | OpenAI 兼容 | Kimi Code 托管服务、Kimi Platform API 密钥 |
| [`anthropic`](#anthropic) | Anthropic Messages | Claude 系列模型 |
| [`openai`](#openai) | OpenAI Chat Completions | OpenAI 及兼容服务、DeepSeek、Qwen 等 |
| [`openai_responses`](#openai-responses) | OpenAI Responses API | OpenAI 较新的 Responses 接口 |
| [`google-genai`](#google-genai) | Google GenAI | Gemini API |
| [`vertexai`](#vertexai) | Google GenAI on Vertex | Google Cloud Vertex AI |

所有供应商默认以流式方式与模型交互。thinking、视觉、工具调用等能力按模型名前缀自动匹配，通常不需要手动声明。

**凭证优先级**：`api_key` 或 `api_key_env`（互斥替代项，只能设置其中一个）> `[providers.<name>.env]` 子表键（两者都不存在时才读）> 全部缺失时启动报错。除显式声明的 `api_key_env` 外，CLI 不会从 shell 环境变量自动取凭证，详见[配置覆盖：供应商凭证](./overrides.md#供应商凭证)。

## `/provider` — 交互式供应商管理

不想手动编辑 TOML？在 TUI 里输入 `/provider` 打开**供应商管理器**，可以以交互方式添加、编辑或删除供应商。

![/provider 供应商管理器](../../media/provider-manager.jpg)

管理器按来源把供应商显示为一行行条目。操作方式：

- ↑/↓ 移动光标，←/→ 翻页
- `E` 键编辑当前供应商，改名也在表单里完成
- `d` 键删除当前供应商（有 `[y/N]` 确认）
- 在 `[ Add New Platform ]` 行按 Enter 添加新供应商

添加时有两条导入路径（第三条是手动填写，见下一节）：

- **Known third-party provider**：从 [models.dev](https://models.dev/) 拉取模型目录，选供应商 → 输入 API 密钥 → 选默认模型。目录未声明协议类型的供应商（如 xai、openrouter 这类厂商专用 SDK）会按 OpenAI 兼容协议导入并显示 "guessed" 提示；目录没有可用端点时会先弹出 base URL 输入框；Amazon Bedrock / Cohere 等专有协议和无法识别的显式协议会被拒绝导入。已下线（deprecated）和 alpha 状态的模型不会出现在导入列表中。如果公共目录不可达，CLI 会回退到内置目录快照，离线或网络受限环境下也能完成导入
- **Custom registry (api.json)**：粘贴自定义 registry 地址，私有 registry 再附上 Bearer token，CLI 自动创建 `providers` / `models` 条目。当 registry 条目声明了 `env` 字段（存放 API 密钥的环境变量名）时，CLI 会把它作为提示打印出来——想用就在 `config.toml` 里自己设置 `api_key_env`。绑定永远不会自动发生：registry 既决定变量名、又决定凭证发往的端点，不能由它来选择读取你的哪份密钥。对私有 registry，Bearer token 本身仍会存为 `source.apiKey`，供刷新时重新拉取。后续启动时，同一个 registry 地址下的供应商会一起刷新，因此上游新增、删除供应商以及模型元数据变化都会同步。

::: warning
通过 `/login` 登录的 Kimi Code OAuth 托管账号不会在 `/provider` 里显示，请用 `/login` 和 `/logout` 管理。
:::

非交互环境下也可以用 shell 命令完成同样操作：[`kimi provider`](../reference/kimi-command.md#kimi-provider)。

## 用 `/provider` 手动添加 / 编辑供应商

上面两条导入路径都依赖目录或 registry。第三条路是在表单里直接填字段：内网网关、自建推理服务这类不在 [models.dev](https://models.dev/) 目录里的端点，用这条路径最省事，也不依赖网络。

在 `/provider` 管理器里把光标移到 `[ 添加新平台 ]` 行按 Enter，选「手动填写供应商信息」。表单字段与官方 Web 端一致：

| 字段 | 说明 |
| --- | --- |
| 供应商 ID | 写入 `[providers.<id>]` 的键名。必须以字母或数字开头，只能包含字母、数字、空格、连字符和下划线 |
| API 协议 | 六种类型之一：`kimi`、`openai`、`openai_responses`、`anthropic`、`google-genai`、`vertexai`，取值见[支持的供应商类型](#支持的供应商类型) |
| API 密钥 | 添加时必填，写入 `api_key`。编辑已有供应商时该字段预填已存密钥，清空它表示删除已存凭据（落盘为 `api_key = ""`） |
| 基础 URL | 写入 `base_url`，不能为空；协议切到 `anthropic` 时会自动去掉结尾的 `/v1` |
| 模型 | 至少一行。每行三个字段：模型 ID（即 `[models."<id>/<model>"]` 的别名）、上下文长度（正整数，写入 `max_context_size`）、显示名称（可选，写入 `display_name`） |

表单的键位与交互：

- `Tab` / `Shift-Tab` / `↑` / `↓` 在 供应商 ID → API 协议 → API 密钥 → 基础 URL → 模型 → 保存 之间移动焦点，`Enter` 进入下一项（在模型区表示编辑选中的行，在「保存」上表示提交）
- 在「API 协议」上按 `←` / `→` 或空格，在六种类型之间循环
- 在模型区按 `A` 追加一行、`D` 删除选中的行（只剩一行时不可删）、`E` 或 `Enter` 进入行编辑（模型 ID → 上下文长度 → 显示名称，最后一个字段按 `Enter` 写回，按 `Esc` 放弃本行修改）
- API 密钥默认掩码显示，`Ctrl-R` 切换明文
- `Esc` 取消表单，不写盘

校验与 CLI 共用同一套规则：供应商 ID 非法、添加时缺少密钥、基础 URL 为空、没有任何模型行、上下文长度不是正整数、两行模型 ID 重复，都会在表单内显示提示、保留已填内容，并且不写入配置文件。

保存后一次写入 `[providers.<id>]` 与该供应商的每个模型别名，随后刷新运行环境，并弹出与目录导入同一个默认模型选择器（按 `Esc` 跳过则供应商已保存、默认模型不变）。新建的模型别名带 `capabilities = [ "tool_use", "thinking" ]` 和 `adaptive_thinking = true`；显示名称留空时不写 `display_name`。

**编辑与改名**：在管理器列表里把光标移到目标供应商行、按 `E`，表单以上一次保存的配置预填（含 API 密钥）。保存时**先删除旧记录、再写入新记录**——这正是改名与删行不留残渣的原因：旧模型别名、悬空的 `default_model` / `default_provider` 在删除时被级联清理，而指向该供应商的默认指针在写入时迁移到新 id。表单之外的字段（`env`、`custom_headers`、`source`，以及模型行上的 `max_output_size`、`capabilities`、`support_efforts` 等）保持原值；改名不会重写 [`[secondary_model]`](./config-files.md#secondary_model) 里的引用。

新的供应商 ID 已被别的供应商占用，或新别名会覆盖别的供应商的模型时，写入会被拒绝并给出提示，配置文件保持不变。表单只认六种协议：存储类型不在这六种之内的供应商（例如引擎内部的 `astron`）会提示协议不受支持，无法在这里编辑。

`oauth` 非空的供应商（Kimi Code 托管账号）表单整体只读，页脚提示「该供应商由 Kimi Code 托管，无法在此编辑」，请改用 `/login` 与 `/logout` 管理。

## 用 `kimi provider create/update` 添加与修改供应商

同一条路径的 shell 版本：`kimi provider create` 手填新增，`kimi provider update` 修改已有供应商。两者与上面的表单共用同一套字段规则、校验和写盘逻辑，因此报错与退出码一致：任何一项校验失败（或 id、别名冲突）都以退出码 1 结束，配置文件不变。

`create` 的全部选项：

| 选项 | 说明 |
| --- | --- |
| `--id <id>` | 供应商 ID，规则与表单相同 |
| `--type <wire>` | API 协议，六种取值之一：`kimi`、`openai`、`openai_responses`、`anthropic`、`google-genai`、`vertexai` |
| `--api-key <key>` | 凭据，写入 `api_key` |
| `--base-url <url>` | 端点地址，写入 `base_url` |
| `--model <model>` | 模型 ID，别名写成 `<id>/<model>` |
| `--max-context-size <tokens>` | 该模型的上下文窗口，正整数，写入 `max_context_size` |
| `--display-name <name>` | 可选，模型的显示名称 |
| `--default` | 可选，同时把 `default_model` 设为 `<id>/<model>` |
| `--json` | 可选，以 JSON 输出写入后的 `providers` 与 `models`，其中已去掉 API 密钥明文 |

这里没有「留空就用默认值」的选项：`--api-key`、`--base-url`、`--model`、`--max-context-size` 都必须显式给出，缺任何一项都会报错退出——不会替你猜一个端点或上下文预算。

```sh
kimi provider create \
  --id demo \
  --type openai \
  --api-key YOUR_API_KEY \
  --base-url https://api.example.com/v1 \
  --model gpt-4.1 \
  --max-context-size 128000
```

成功时打印 `已添加供应商"demo"。`，并列出该供应商的模型别名。`create` 默认不设置默认模型，需要时加 `--default`，或之后在 TUI 里用 `/model` 选择。

`update <providerId>` 的选项：

| 选项 | 说明 |
| --- | --- |
| `<providerId>` | 位置参数，要修改的供应商 id |
| `--new-id <id>` | 改名 |
| `--type <wire>` | 换协议；不给时沿用当前值 |
| `--api-key <key>` | 换密钥；不给时沿用已存密钥（没有清空密钥的选项） |
| `--base-url <url>` | 换端点；不给时沿用当前值 |
| `--model <model>` | 新增或覆盖一行模型：同名行沿用未给的上下文长度与显示名称，新模型 ID 则需要 `--max-context-size` |
| `--max-context-size <tokens>` | 配合 `--model` 使用 |
| `--display-name <name>` | 配合 `--model` 使用；不给时沿用该行原值 |
| `--default` | 把 `default_model` 指向本次的模型（未给 `--model` 时是第一条） |
| `--json` | 以 JSON 输出写入后的配置，其中已去掉 API 密钥明文 |

**没给的字段保持原值**，只有 `--model` 会改动模型集合。改名与删行走同一条写盘路径：先删除旧 id（级联清掉旧模型别名与悬空的默认指针），再写入新记录；`default_model` / `default_provider` 指向该供应商时迁移到新 id，表单之外的字段（`env`、`custom_headers`、`source`、`max_output_size` 等）原样保留。

```sh
# 改名并换端点，其余字段保持原值
kimi provider update demo --new-id demo2 --base-url https://api2.example.com/v1

# 追加（或更新）一行模型，并设为默认模型
kimi provider update demo2 --model gpt-4.1-mini --max-context-size 128000 --default
```

> `--type` 只接受上面六种取值；不给 `--type` 时，已存储的类型原样保留，包括引擎独有的 `astron`。

## `kimi`

用于对接 Moonshot AI 的 OpenAI 兼容接口，包括 Kimi Code 托管服务和 Kimi Platform API 密钥。

- 默认 `base_url`：`https://api.moonshot.ai/v1`
- 凭证键名：`KIMI_API_KEY`、`KIMI_BASE_URL`
- 额外能力：支持视频上传

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

> 使用 Kimi Code 托管服务时，`/login` 登录后会自动配置 `base_url` 和凭证，无需手动填写。

## `anthropic`

用于对接 Claude API。标准 Claude 模型自动启用视觉、工具调用及 Thinking（如支持）；自定义或未覆盖的模型需在 `[models.<alias>]` 里显式声明 `capabilities`。

- 默认 `base_url`：跟随 Anthropic SDK 默认值
- 凭证键名：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 默认 `max_tokens`：按模型自动推断。如需覆盖，在模型别名上设 `max_output_size`

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # 可选，省略时使用模型推断的默认值
```

## `openai`

用于对接 OpenAI Chat Completions 协议，也可连接任何兼容该协议的第三方服务（覆盖 `base_url` 即可）。

第三方推理模型（DeepSeek、Qwen、One API 等）开箱即用：CLI 自动处理 `reasoning_content` 字段和 `reasoning_effort` 注入。如果你的网关用非标准字段名返回推理内容，在模型别名上设 `reasoning_key` 覆盖。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

对应 OpenAI 较新的 Responses API，始终以流式方式工作。配置方式与 `openai` 相同。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

用于直连 Google Gemini API。thinking、视觉及多模态能力按模型名自动识别。

- 凭证键名：`GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

如需经由兼容 Gemini 协议的代理/网关访问，可设置 `base_url`（或 `GOOGLE_GEMINI_BASE_URL` 环境变量）；不填时使用 SDK 默认地址 `https://generativelanguage.googleapis.com`。

> 只填**主机根地址**。Google GenAI SDK 会自行追加 API 版本与路径（如 `/v1beta/models/<model>:generateContent`），所以结尾带 `/v1beta` 会导致路径重复成 `/v1beta/v1beta/…`。

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
base_url = "https://your-gateway.example"
```

## `vertexai`

与 `google-genai` 共用实现，`type = "vertexai"` 时切换到 Vertex AI 访问路径。

认证走 Google Cloud 标准 ADC 流程（`gcloud auth application-default login` 或 `GOOGLE_APPLICATION_CREDENTIALS` 服务账号 JSON），这部分与 Kimi Code 无关。**项目 ID 和区域必须写在 `[providers.vertexai.env]` 子表里**。直接在 shell 里 `export GOOGLE_CLOUD_PROJECT` 不会被 CLI 读取。

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # 一次性完成认证
kimi
```

如需让 Vertex 请求走自定义（如代理）端点，可设置 `base_url`（或 `GOOGLE_VERTEX_BASE_URL` 环境变量）；不填时使用 SDK 默认的区域化 `*-aiplatform.googleapis.com` 地址。与 `google-genai` 一样，只填主机根地址。SDK 会自行追加 `/v1beta1/publishers/google/models/…`。


## OAuth 与凭证注入

Kimi Code 托管服务使用 OAuth 而非静态 API 密钥。运行 `/login` 后，内置的认证工具链会自动写入并刷新凭证，因此无需在 `config.toml` 中手动配置。

## 下一步

- [配置文件](./config-files.md) — `providers` 和 `models` 表的完整字段参考
- [配置覆盖](./overrides.md) — 供应商凭证的解析优先级规则
- [环境变量](./env-vars.md) — 各供应商对应的凭证键名列表
