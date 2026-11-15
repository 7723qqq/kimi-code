<script setup>
import { onMounted } from 'vue'
import { redirectLegacyServerApiAnchor } from '../../.vitepress/theme/serverApiLegacyAnchors'

onMounted(() => redirectLegacyServerApiAnchor('zh'))
</script>

# 服务 API【测试版】

`kimi web` 启动的本地服务暴露两组程序化接口：REST API（`/api/v1`，另有 `/api/v2/sessions` 和 `/api/v2/mcp`）和 WebSocket 事件流（`/api/v1/ws`）。本页说明所有接口共用的约定，并用一个最小例子走通完整流程。如何启动服务及其命令行选项见 [kimi 命令](./kimi-command.md#kimi-web) 参考；端到端的上手流程见下文「[用 API 驱动一个会话](#用-api-驱动一个会话)」。各类接口的细节分在以下几页：

- [会话与对话](./server-api-conversation.md)：WebSocket 协议，以及客户端如何建立连接、订阅会话、接收对话事件、断线后恢复。
- [会话接口](./server-api-sessions.md)：创建、列出、修改会话，会话动作（分叉、压缩、撤销等），消息与转录，提示词与交互。
- [服务与配置接口](./server-api-service.md)：服务信息、登录与用量、远程控制、配置、模型与供应商、技能与 MCP、能力与插件、工作区、文件上传、GUI 存储、全局搜索与 MCP 管理。
- [文件接口](./server-api-files.md)：读写会话目录、工作区和本机文件，以及下载与流式端点的 HTTP 行为。

本页是一份经过整理、面向人阅读的参考：下文逐一记录每个端点的参数、请求体与响应结构。每个端点精确的机器可读 schema 以服务的在线规范文档为准：`GET /openapi.json`（OpenAPI）与 `GET /asyncapi.json`（AsyncAPI），两者都由服务运行时实际执行的校验 schema 生成。两者都需要鉴权；当本页与在线规范不一致时，以在线规范为准。

::: warning 注意
本页描述的 REST 与 WebSocket API 为实验性特性：不保证接口稳定性，端点、字段与事件类型可能随任何版本更改。集成时请以你所用版本服务的 `/openapi.json` 与 `/asyncapi.json` 文档为准。
:::

## 基础约定

### 地址

默认地址为 `http://127.0.0.1:58627`。端口被占用时，服务会用下一个端口重试（至多 100 次）；可用 `--port` / `--host` 修改绑定。同一 home 目录下可并存多个实例，运行中的实例登记在 `~/.kimi-code/server/instances/`。

### 鉴权

除以下例外，所有 `/api/*` 路径（含 `/openapi.json` 与 `/asyncapi.json`）都要求 bearer token：

- `OPTIONS` 预检请求
- `GET /api/v1/healthz`（探活）
- 静态 web 资源（非 `/api/` 路径）

携带方式：REST 用 `Authorization: Bearer <token>` 请求头；WebSocket 升级请求接受同一请求头，或子协议 `kimi-code.bearer.<token>`。token 的生成与轮换见 [在网页中使用：开始使用](../guides/web.md#开始使用)。

鉴权失败返回 HTTP 401，信封 `code` 为 `40101`。在非 loopback 绑定上，同一来源 60 秒内鉴权失败 10 次会被封禁 60 秒，期间每个请求都返回 HTTP 429（`code` 为 `42901`）。

### 响应信封

所有 JSON 响应统一包在信封里：

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

- `code`：业务结果，`0` 表示成功；错误码分段见下文。
- `data`：成功时的业务数据。部分错误信封也携带非空 `data`，客户端应先判 `code` 再看 `data`。
- `request_id`：本次请求的 ULID；客户端可用 `X-Request-Id` 请求头指定，非法值会被服务端重新生成。

HTTP 状态码几乎总是 200，业务结果以 `code` 为准。例外情况：

| 场景 | HTTP 状态 |
| --- | --- |
| 鉴权失败 / 触发限流 | 401 / 429 |
| 创建供应商、导入供应商目录成功 | 201 |
| 删除供应商成功 | 204 |
| 二进制与流式端点 | 支持时返回 206（Range 分段）/ 304（ETag 未变），各端点能力不同，详见「[二进制与流式端点](./server-api-files.md#二进制与流式端点)」 |
| `GET /api/v1/files/{file_id}`、`/api/v1/fs:content` 与会话 `:download` 错误 | 真实 4xx / 500（响应体仍为信封） |

其中 201 的响应体仍是标准信封（`code` 为 `0`），只是状态行遵循 REST 的资源创建惯例；204 按定义没有响应体，删除成功以状态码本身为准。

### 错误码

错误码按段位分组：

| 段位 | 含义 | 示例 |
| --- | --- | --- |
| `0` | 成功 | |
| `400xx` | 请求参数错误 | `40001` 校验失败（`details` 逐字段说明）、`40003` 供应商由 OAuth 托管 |
| `401xx` | 鉴权与就绪状态 | `40101` 未授权、`40110` 未配置供应商、`40113` 模型未解析 |
| `404xx` | 资源不存在 | `40401` 会话、`40408` MCP 服务、`40409` 文件路径 |
| `409xx` | 状态冲突 | `40901` 会话忙、`40902` 交互已结束、`40922` 分页条件与 `page_token` 不符、`40931` 会话正被其他客户端使用、`40932` 会话已被其他客户端更新、`40935` 无法进入 Tower 模式 |
| `410xx` | 资源已过期 | `41001` 审批超时、`41002` 提问超时、`41003` 临时文件过期 |
| `413xx` | 体积或边界超限 | `41302` 读取文件超 10 MB、`41304` 路径越出会话目录 |
| `429xx` | 限流 | `42901` 鉴权失败封禁 |
| `500xx` | 服务端内部错误 | `50001` 未捕获异常、`50003` 持久化失败 |
| `6xxxx` / `7xxxx` / `8xxxx` | 工具运行时 / LLM 供应商 / MCP 透传错误，`msg` 保留上游原文 | |

`40931` 和 `40932` 只在同一会话被多个客户端打开时出现。`40931` 表示另一个 Kimi Code 进程正在写入该会话，等它空闲后重试即可。如果确认该进程已退出、只是留下了锁，可以调用 `POST /api/v1/sessions/{session_id}:takeover` 后再重试。会话已被其他客户端更新时，提交 prompt、激活 skill 和压缩会在服务端重新载入会话、向订阅者推送最新的 transcript，然后重新执行请求，调用方不会从这些接口收到 `40932`。只有撤销会返回 `40932`：服务端已重新载入会话，本次没有撤销任何内容；请让用户先查看刷新后的历史，再决定是否撤销。

### 分页

列表端点有两种分页风格：

- **游标式**：`before_id` / `after_id`（互斥）加 `page_size`（1–100），响应为 `{ items, has_more }`。用于会话列表、消息列表、转录等。
- **`page_token`**：不透明令牌（绑定了查询条件的指纹），用于 `POST /api/v1/search` 与 `GET /api/v2/sessions`。翻页途中改变任何查询条件会使令牌失效：v2 返回 `40922`，search 返回 `40001`。`GET /api/v2/sessions` 另提供无状态的 `page` 页码模式作为替代。

## 用 API 驱动一个会话

下面用 curl 走一遍最小流程：确认服务状态 → 创建会话 → 订阅事件 → 提交提示词 → 回读历史。示例假设服务跑在默认地址，token 已存入 shell 变量 `TOKEN`。

1. 确认服务状态：

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/v1/meta
```

所有 JSON 响应都包在统一信封里——`{ "code": 0, "msg": "success", "data": ..., "request_id": "..." }`，业务结果以 `code` 为准（`0` 表示成功），HTTP 状态码只表达传输层结果。

2. 创建会话，`metadata.cwd` 指定工作目录：

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"cwd": "/path/to/project"}}'
```

返回的 `data.id`（形如 `session_...`）就是后续所有请求要用的会话 id。

3. 连接 WebSocket 并订阅会话事件。任何 WebSocket 客户端都可以；下面是一个零依赖的 Bun 脚本（Bun 内置 `WebSocket` 客户端）：

```js
// subscribe.mjs —— 用法：TOKEN=... bun subscribe.mjs session_...
const ws = new WebSocket('ws://127.0.0.1:58627/api/v1/ws', [
  `kimi-code.bearer.${process.env.TOKEN}`,
]);
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () =>
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      id: '1',
      payload: { session_ids: [process.argv[2]] },
    }),
  );
```

4. 提交提示词：

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": [{"type": "text", "text": "用一句话介绍这个仓库"}]}'
```

订阅端会依次看到 `turn.started`（轮次开始）→ `assistant.delta`（流式文本增量）→ 发生工具调用时的 `tool.call.started` / `tool.result` → `turn.ended`（轮次结束）。

5. 随时可以用 REST 回读历史消息：

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:58627/api/v1/sessions/<session_id>/messages?page_size=20"
```

## 动作路径

对单个资源的非创建、读取、修改、删除操作使用以 `:action` 结尾的路径并以 POST 调用，例如 `POST /api/v1/sessions/{session_id}:fork` 和 `POST /api/v1/sessions/{session_id}:archive`。各类接口的动作路径在各自页面中说明。

## 下一步

- [会话与对话](./server-api-conversation.md) — WebSocket 协议与客户端流程
- [在网页中使用](../guides/web.md) — 启动服务并在浏览器中使用 Kimi Code
- [kimi 命令](./kimi-command.md#kimi-web) — `kimi web` 的全部命令行选项
