# TUI 迁移 KAP 协议调研报告

> 目的：在保持 TUI（`apps/kimi-code`）仍然使用 SDK（`@moonshot-ai/kimi-code-sdk`）的前提下，把 SDK 的网络层从「进程内 RPC」替换为「新协议 KAP（HTTP + WebSocket）」。本文深度对齐「现 SDK/RPC 功能」与「KAP 新版 API」，给出哪些一一对齐、哪些有差异、哪些 KAP 缺失，作为后续 SDK 封装与迁移的依据。

---

## 1. 一句话结论

- **好消息**：KAP 的 `packages/server` 已经在 `services/` 这一层把同一个 `KimiCore`（agent-core）包装成了 REST + WS，wire schema 都在 `packages/protocol`。TUI 又几乎完全只通过 SDK 的公开抽象消费功能，**不直接依赖 RPC 内部**。所以迁移可以基本封装在 SDK 内部完成，大量功能是**一一对齐**的。
- **核心三类工作**：
  1. **流与反向通道**：把 `session.onEvent`（推送事件流）和 `setApprovalHandler`/`setQuestionHandler`（核心→客户端的反向调用）落到 WebSocket 上（服务器已具备，SDK 侧需新实现）。
  2. **补齐 KAP 缺口**：**Plugins、配置诊断、导出 session、reload、AGENTS.md 生成、取消压缩、托管用量/反馈、实验特性注册表元数据** 等在 KAP 上没有等价端点（详见 §9）。
  3. **本地化假设**：TUI 直接写 `<sessionDir>/upcoming-goals.json`、把 `homeDir`/`sessionDir` 当本地路径，这些在「核心在远端」时会失效，需要决策。

---

## 2. 现状架构（TUI / SDK / Core）

```
apps/kimi-code (TUI)
   │  只用 SDK 公开 API（createKimiHarness / KimiHarness / Session / events / 反向 handler）
   ▼
packages/node-sdk (@moonshot-ai/kimi-code-sdk)
   │  SDKRpcClient extends SDKRpcClientBase
   │  进程内 createRPC<CoreAPI, SDKAPI>()（JSON-clone + setTimeout(0) 模拟网络边界）
   ▼
packages/agent-core
   │  KimiCore implements CoreAPI ──► SessionAPIImpl ──► Agent.rpcMethods
```

**关键事实**（`packages/node-sdk/src/rpc.ts`、`packages/agent-core/src/rpc/client.ts`）：

- 当前 SDK↔Core 是**纯进程内**的：没有 socket / stdio / 子进程 / message port。`createRPC` 用 `JSON.stringify→parse` 在 `setTimeout(0)` 上克隆载荷，模拟了一次网络边界。因此所有跨边界载荷必须是 JSON 安全的（所以 `Kaos` 这类对象通过 `createSessionWithKaos`/`resumeSessionWithKaos` 绕过 RPC 直接调用 `KimiCore`）。
- RPC 方法目录就是 agent-core 的 **`CoreAPI`** 接口（`packages/agent-core/src/rpc/core-api.ts`）。错误通过 `toKimiErrorPayload`/`fromKimiErrorPayload` 以 `{ok:false, error: KimiErrorPayload}` 形式跨边界传递（错误码是 `KimiErrorCode` 字符串联合，如 `auth.login_required`）。
- 反向 RPC：核心通过 `SDKAPI`（`emitEvent` / `requestApproval` / `requestQuestion` / `toolCall`）回调 SDK，由 `ClientAPI` → `SDKRpcClientBase` 落到本地事件监听器和 approval/question handler。

---

## 3. 新版 KAP 架构（server / protocol / services）

```
apps/kimi-web (Web)                         apps/kimi-code (TUI, 迁移目标)
   │  REST + WS (/api/v1)                         │  SDK（替换网络层）
   ▼                                               ▼
packages/server (@moonshot-ai/server, Fastify)  ◀─── HTTP + WebSocket
   │  routes/* + ws/*  ──  通过 services/ 访问核心
   ▼
packages/agent-core/src/services/*  (DI facade, VSCode 风格 createDecorator)
   │  ICoreProcessService.rpc  ──► 同一个 KimiCore (CoreAPI)
   ▼
packages/protocol (@moonshot-ai/protocol)  ◀─── REST/WS 的 wire schema（zod）
```

**关键事实**：

- server 不依赖 node-sdk，是一条独立的「反腐败层」：路由通过 `ix.invokeFunction(a => a.get(IX))` 解析 `ISessionService`/`IPromptService`/...，这些 service 大多把 `ICoreProcessService.rpc`（即 `CoreAPI` 代理）的结果翻译成 `@moonshot-ai/protocol` 的 wire 形状（`packages/server/src/start.ts`、`services/serviceCollection.ts`）。
- 所有 REST 响应统一包成 envelope `{ code, msg, data, request_id, details? }`，HTTP 状态几乎恒为 200，业务结果看 `code`（`0` 成功）。错误码是**整数命名空间**（`4xxxx`/`5xxxx`/...，见 §4.3），与 SDK 的字符串 `KimiErrorCode` **不是同一套**。
- **没有 SSE**：所有实时推送走 WebSocket；HTTP 仅两个二进制下载（文件 / fs download）是流式。
- **当前 REST/WS 都没有请求鉴权**（保留 `40101/40102/40103` 守护 token 码位但未实现），server 设计为 loopback-only（`127.0.0.1`）。

---

## 4. 新版 API 总览

### 4.1 REST 端点全景（统一前缀 `/api/v1`）

> 信封：`{ code, msg, data, request_id, details? }`。路由通过 `defineRoute` 声明 zod schema，校验失败 → `40001`。`:action` 后缀通过 `parseActionSuffix` 解析。

| 域 | 方法 | 路径 | 用途 | 流式 |
|---|---|---|---|---|
| health | GET | `/healthz` | 存活探测 | 否 |
| meta | GET | `/meta` | 版本、能力、`server_id`、`started_at` | 否 |
| connections | GET | `/connections` | 列出当前 WS 连接 | 否 |
| shutdown | POST | `/shutdown` | 优雅关闭 | 否 |
| auth | GET | `/auth` | 鉴权/Provider 就绪快照（非登录门控） | 否 |
| oauth | POST | `/oauth/login` | 启动 device-code 登录 | 否 |
| oauth | GET | `/oauth/login` | 轮询登录流程 | 否 |
| oauth | DELETE | `/oauth/login` | 取消登录 | 否 |
| oauth | POST | `/oauth/logout` | 登出 | 否 |
| config | GET | `/config` | 全局配置（脱敏） | 否 |
| config | POST | `/config` | 合并补丁全局配置 | 否 |
| models | GET | `/models` | 模型别名列表 | 否 |
| models | POST | `/models/{model_id}:set_default` | 设全局默认模型 | 否 |
| providers | GET | `/providers` | Provider 列表 | 否 |
| providers | GET | `/providers/{provider_id}` | 单个 Provider | 否 |
| providers | POST | `/providers:refresh_oauth` | 刷新 OAuth provider 模型元数据 | 否 |
| sessions | POST | `/sessions` | 创建 session | 否 |
| sessions | GET | `/sessions` | 列表（游标分页） | 否 |
| sessions | GET | `/sessions/{session_id}` | 详情 | 否 |
| sessions | GET | `/sessions/{session_id}/profile` | profile | 否 |
| sessions | POST | `/sessions/{session_id}/profile` | 更新 profile（标题/元数据/agent_config） | 否 |
| sessions | POST | `/sessions/{tail}` | **action 分发**：`:fork` / `:compact` / `:undo` / `:abort` / `:btw` / `:archive` | 否 |
| sessions | GET | `/sessions/{session_id}/children` | 子 session 列表 | 否 |
| sessions | POST | `/sessions/{session_id}/children` | 创建子 session | 否 |
| sessions | GET | `/sessions/{session_id}/status` | 实时状态（model/thinking/permission/plan/swarm/context usage） | 否 |
| snapshot | GET | `/sessions/{session_id}/snapshot` | 原子重建视图：`as_of_seq`/`epoch` + session + messages + `in_flight_turn` + pending approvals/questions | 否 |
| messages | GET | `/sessions/{session_id}/messages` | 消息列表（游标 + role 过滤） | 否 |
| messages | GET | `/sessions/{session_id}/messages/{message_id}` | 单条消息 | 否 |
| prompts | GET | `/sessions/{session_id}/prompts` | 活跃 + 排队 prompt | 否 |
| prompts | POST | `/sessions/{session_id}/prompts` | 提交 prompt（image/video 解析为 base64） | 否 |
| prompts | POST | `/sessions/{session_id}/prompts::steer` | 把排队 prompt steer 进当前 turn | 否 |
| prompts | POST | `/sessions/{session_id}/prompts/{tail}` | 单 prompt 动作：`:abort` / `:steer` | 否 |
| approvals | GET | `/sessions/{session_id}/approvals` | pending approvals | 否 |
| approvals | POST | `/sessions/{session_id}/approvals/{approval_id}` | 决议 approval | 否 |
| questions | GET | `/sessions/{session_id}/questions` | pending questions | 否 |
| questions | POST | `/sessions/{session_id}/questions/{tail}` | 决议（裸 id）或 `:dismiss` | 否 |
| tools | GET | `/tools` | 工具列表（`?session_id=`） | 否 |
| mcp | GET | `/mcp/servers` | MCP server 列表 | 否 |
| mcp | POST | `/mcp/servers/{mcp_server_id}:restart` | 重启 MCP server | 否 |
| skills | GET | `/sessions/{session_id}/skills` | session 可用 skills | 否 |
| skills | POST | `/sessions/{session_id}/skills/{skill_name}:activate` | 激活 skill | 否 |
| tasks | GET | `/sessions/{session_id}/tasks` | 后台任务列表 | 否 |
| tasks | GET | `/sessions/{session_id}/tasks/{task_id}` | 任务详情（`?with_output`/`?output_bytes`） | 否 |
| tasks | POST | `/sessions/{session_id}/tasks/{task_id}:cancel` | 取消任务 | 否 |
| terminals | GET | `/sessions/{session_id}/terminals` | PTY 列表 | 否 |
| terminals | POST | `/sessions/{session_id}/terminals` | 创建 PTY | 否 |
| terminals | GET | `/sessions/{session_id}/terminals/{terminal_id}` | PTY 详情 | 否 |
| terminals | POST | `/sessions/{session_id}/terminals/{terminal_id}:close` | 关闭 PTY | 否 |
| fs | POST | `/sessions/{session_id}/{tail}` | **FS action 分发**：`fs:list/read/list_many/stat/stat_many/mkdir/search/grep/git_status/diff/open/open-in/reveal` | 否 |
| fs | GET | `/sessions/{session_id}/fs/*` | 下载工作区文件（路径以 `:download` 结尾；支持 Range/ETag） | **二进制流** |
| files | POST | `/files` | multipart 上传（50MB 上限） | 否 |
| files | GET | `/files/{file_id}` | 下载 blob | **二进制流** |
| files | DELETE | `/files/{file_id}` | 删除 blob | 否 |
| workspaces | GET | `/workspaces` | workspace 列表 | 否 |
| workspaces | POST | `/workspaces` | 注册/触碰 workspace | 否 |
| workspaces | PATCH | `/workspaces/{workspace_id}` | 改名 | 否 |
| workspaces | DELETE | `/workspaces/{workspace_id}` | 注销（不删磁盘） | 否 |
| workspaces | GET | `/fs::browse` | 浏览本地目录 | 否 |
| workspaces | GET | `/fs::home` | 文件夹选择器入口 | 否 |
| debug | GET | `/debug/prompts/{session_id}/state` | 测试用 agent 状态快照（仅 `debugEndpoints`） | 否 |
| debug | GET | `/debug/prompts/{session_id}/dispatch-log` | prompt 派发环形缓冲 | 否 |
| debug | POST | `/debug/prompts/{session_id}/active` | 注入活跃 prompt（测试脚手架） | 否 |

根级（不在 `/api/v1`）：`GET /openapi.json`、`GET /asyncapi.json`、`GET /documentation`（Swagger UI）、以及可选的静态 web 资源。

> 备注：`/tools`、`/mcp/*` 等是**全局**（不挂在 session 路径下），但支持 `?session_id=`。
>
> 备注（重要）：**运行时控制与 Goal 没有独立路由**，统一走 `agent_config`：
> - session 级：`POST /sessions/{sid}/profile`，body 带 `agent_config`（`sessionAgentConfigSchema`，含 `model`/`thinking`/`permission_mode`/`plan_mode`/`swarm_mode`/`goal_objective`/`goal_control`）。
> - per-turn：`POST /sessions/{sid}/prompts`，body 直接带同名字段。
> 两者都经 `IPromptService.applyAgentState` 派发到 `core.rpc.*`（详见 §6.4、§6.9）。

### 4.2 WebSocket 协议

- **端点**：`WS_PATH = '/api/v1/ws'`，`WS_PROTOCOL_VERSION = 2`（`packages/protocol/src/ws-control.ts`）。`ws` 库 `noServer:true`，挂到 Fastify 的 Node `http.Server`。
- **握手**：连接后服务端立即推 `server_hello`（`ws_connection_id`、protocol_version、heartbeat_ms、capabilities）；客户端回 `client_hello{ client_id, subscriptions[], cursors? }`，服务端 `ack` 带回 `accepted_subscriptions`/`resync_required`/每 session 的 `cursors`。
- **心跳**：服务端每 `pingIntervalMs`（默认 30s）推 `ping{nonce}`，客户端须 `pong{nonce}`，超时（默认 10s）断开。
- **客户端→服务端 控制帧**：`client_hello`、`subscribe`、`unsubscribe`、`watch_fs_add/remove`、`abort{session_id,prompt_id}`、`terminal_attach/detach/input/resize/close`、`pong`。
- **服务端→客户端 系统帧**：`server_hello`、`ping`、`resync_required{session_id, reason, current_seq, epoch?}`、`error`。
- **服务端→客户端 事件帧**：
  - 业务事件：envelope 的 `type` 等于 payload event 的 `type`（如 `assistant.delta`、`turn.started`），事件 payload 是 **camelCase**（来自 agent-core），外层 envelope 是 snake_case。
  - PTY：`terminal_output`、`terminal_exit`。
- **多路复用与重连**：
  - 一个连接订阅多个 `session_id`；`SessionClientsService` 维护 `sessionId → Set<WsConnection>`。
  - **持久事件**带单调 `seq`（每 session，持久化到 `<home>/server/events/<sid>.jsonl` 日志 + 内存尾部缓冲，默认 1000）。**volatile 事件**（`assistant.delta`、`thinking.delta`、`tool.call.delta`、`tool.progress`、`agent.status.updated`）不入日志、不重放，带 `volatile:true` 与 `offset`。
  - 重连：客户端带 `{seq,epoch}` 游标 `subscribe`；服务端能增量就增量，否则 `resync_required`（`buffer_overflow` / `epoch_changed` / `session_recreated`），客户端 `GET /snapshot` 后重新 `subscribe`。
  - **全局事件**（`event.session.created`、`event.session.status_changed`、`event.config.changed`、`event.workspace.*`）广播给所有连接。

> ⚠️ 协议层已知瑕疵：`event.approval.requested/resolved/expired`、`event.question.requested/answered/dismissed/expired` 这些 approval/question 事件**没有收录进 `events.ts` 的 `AgentEvent` 联合**（`eventSchema`/`sessionEventMessageSchema` 不含）。它们仍能经 WS 流出（出站不重新做 zod 校验），但用 `eventSchema` 校验或生成的 TS 类型看不到这些事件。迁移时 SDK 需要把 approval/question 事件纳入事件类型。

### 4.3 错误码体系（`packages/protocol/src/error-codes.ts`）

整数命名空间：`0` 成功 · `4xxxx` 客户端 · `5xxxx` 守护内部 · `6xxxx` 工具运行时 · `7xxxx` LLM provider 透传 · `8xxxx` MCP 透传 · `9xxxx` 保留。

常见：`40001 validation.failed`、`40401 session.not_found`、`40402 prompt.not_found`、`40404 approval.not_found`、`40405 question.not_found`、`40406 task.not_found`、`40407 file.not_found`、`40901 session.busy`、`40902 approval.already_resolved`（question 复用）、`40903 prompt.already_completed`、`40904 task.already_finished`、`40909 question.dismissed`、`40910 compaction.unable`、`40911 session.undo_unavailable`、`40913–40919 goal.*`、`41001 approval.expired`、`41304 fs.path_escapes_session`、`50001 internal.error`、`60001 tool.execution_failed` 等。

> 重点：KAP 用**整数 code + reason 字符串**；现 SDK 用**字符串 `KimiErrorCode`**（如 `auth.login_required`、`goal.already_exists`）。SDK 迁移需要在网络层做一次「整数 code → `KimiError`/`ErrorCodes`」的映射，否则 TUI 里大量 `isKimiError`/`ErrorCodes.*`/`error.details` 的分支会失效。

### 4.4 protocol 包模块索引（`packages/protocol/src`）

- 基础：`envelope.ts`（统一信封）、`error-codes.ts`、`pagination.ts`（游标）、`request-id.ts`、`time.ts`、`index.ts`。
- 事件：`events.ts`（≈40 个 `AgentEvent` 联合、`Event = AgentEvent & {agentId, sessionId}`、`VOLATILE_EVENT_TYPES`、`KimiErrorCode`/`KimiErrorPayload` 等）、`ws-control.ts`（整套 WS wire）、`asyncapi.ts`（生成 AsyncAPI 文档）。
- 资源 schema：`session.ts`、`message.ts`、`prompt`（在 `rest/`）、`approval.ts`、`question.ts`、`tool.ts`、`modelCatalog.ts`、`skill.ts`、`task.ts`、`file.ts`、`fs.ts`、`workspace.ts`、`display.ts`（工具 I/O 展示）。
- `rest/` 子目录：按域的 request/response schema（`session/message/prompt/approval/question/config/auth/oauth/modelCatalog/skill/task/terminal/tool/file/fs/fsBrowse/snapshot/meta/connection/workspace`）。

---

## 5. 现 SDK / RPC 功能全景

### 5.1 SDK 公开 API（`packages/node-sdk/src`，仅 `.` 出口）

- **入口**：`createKimiHarness(options): KimiHarness`（主工厂）；`class SDKRpcClient extends SDKRpcClientBase`（具体客户端，进程内 RPC）。
- **`KimiHarness`**（`kimi-harness.ts`）：会话管理 + 配置 + 遥测 + auth facade。
  - 会话：`createSession` / `resumeSession` / `reloadSession` / `forkSession` / `getSession` / `closeSession` / `renameSession` / `exportSession` / `listSessions`。
  - 配置/特性：`getConfig` / `getConfigDiagnostics` / `getExperimentalFeatures` / `ensureConfigFile` / `setConfig` / `removeProvider`。
  - 其它：`withInteractiveAgent`、`track`/`setTelemetryContext`、`auth`、`homeDir`、`close`。
- **`Session`**（`session.ts`）：每个方法基本 1:1 映射到 RPC。
  - 生命周期/元数据：`getResumeState` / `reloadSession` / `onEvent` / `close`。
  - 反向 handler：`setApprovalHandler` / `setQuestionHandler`。
  - turn：`prompt` / `steer` / `swarm` / `init`（→`generateAgentsMd`）/ `startBtw` / `cancel`。
  - 运行时控制：`setModel` / `setThinking` / `setPermission` / `setPlanMode` / `setSwarmMode`。
  - plan：`getPlan` / `clearPlan`。
  - 压缩/历史：`compact` / `cancelCompaction` / `undoHistory`。
  - 内省：`getContext` / `getUsage` / `getStatus`（`getStatus` 是客户端组合 6 个 RPC）。
  - skills：`listSkills` / `activateSkill`。
  - 后台任务：`listBackgroundTasks` / `getBackgroundTaskOutput` / `stopBackgroundTask` / `detachBackgroundTask`。
  - goals：`createGoal` / `getGoal` / `pauseGoal` / `resumeGoal` / `cancelGoal`。
  - MCP：`listMcpServers` / `getMcpStartupMetrics` / `reconnectMcpServer`。
  - plugins：`listPlugins` / `installPlugin` / `setPluginEnabled` / `setPluginMcpServerEnabled` / `removePlugin` / `reloadPlugins` / `getPluginInfo`。
- **`KimiAuthFacade`**（`auth.ts`）：`status` / `login` / `logout` / `getManagedUsage` / `submitFeedback` / `getCachedAccessToken` / `resolveOAuthTokenProvider`。`cli/telemetry.ts` 会**直接 `new KimiAuthFacade(...)`**，迁移后需保留可构造。
- **catalog / provider**（`catalog.ts`、`kimi-code-model-provider.ts`）：纯客户端 HTTP 工具（`fetchCatalog`/`catalogProviderModels`/`applyCatalogProvider`/`inferWireType`/`catalogModelToAlias`/`DEFAULT_CATALOG_URL`）+ `KimiForCodingProvider`。这些**不走 RPC**，KAP 后仍可保留为客户端工具。
- **config RPC**（`config-rpc.ts`）：独立 `createRPC` 对，`createKimiConfigRpc()` → `resolveConfigPath` / `validateConfigToml`，被 `doctor` 命令使用（不启动 `KimiCore`）。
- **events/types**：`Event`、`KimiErrorPayload`、各事件子类型、`ApprovalHandler`/`QuestionHandler`、大量 agent-core 类型重导出。

### 5.2 RPC 方法目录（`CoreAPI`）

```
AgentAPI   （每 agent；载荷自动 +agentId，再 +sessionId）
SessionAPI = AgentAPI + 8 个 session 级方法
CoreAPI    = SessionAPI + 21 个全局方法
```

**全局方法**：`getCoreInfo`、`getExperimentalFeatures`、`getKimiConfig`、`getConfigDiagnostics`、`setKimiConfig`、`removeKimiProvider`、`createSession`、`closeSession`、`archiveSession`、`resumeSession`、`reloadSession`、`forkSession`、`listSessions`、`exportSession`、`listPlugins`、`installPlugin`、`setPluginEnabled`、`setPluginMcpServerEnabled`、`removePlugin`、`reloadPlugins`、`getPluginInfo`。

**Session 级方法**：`renameSession`、`updateSessionMetadata`、`getSessionMetadata`、`listSkills`、`listMcpServers`、`getMcpStartupMetrics`、`reconnectMcpServer`、`generateAgentsMd`。

**Agent 级方法**（默认 `agentId='main'`）：`prompt`、`steer`、`cancel`、`undoHistory`、`setThinking`、`setPermission`、`setModel`、`getModel`、`enterPlan`、`cancelPlan`、`clearPlan`、`enterSwarm`、`exitSwarm`、`getSwarmMode`、`beginCompaction`、`cancelCompaction`、`registerTool`、`unregisterTool`、`setActiveTools`、`stopBackground`、`detachBackground`、`clearContext`、`activateSkill`、`startBtw`、`createGoal`、`getGoal`、`pauseGoal`、`resumeGoal`、`cancelGoal`、`getBackgroundOutput`、`getContext`、`getConfig`、`getPermission`、`getPlan`、`getUsage`、`getTools`、`getBackground`。

**反向 RPC（核心→SDK，`SDKAPI`）**：`emitEvent`、`requestApproval`、`requestQuestion`、`toolCall`。

### 5.3 事件流

`Event` 联合在 `packages/protocol/src/events.ts` 单一定义（40 个 `AgentEvent` 变体）。现 SDK 路径：Agent → `SDKAPI.emitEvent` → 进程内边界 → `ClientAPI.emitEvent` → `SDKRpcClientBase.receiveEvent` → 所有 `onEvent` 监听器；`Session.onEvent` 按 `event.sessionId === this.id` 过滤。KAP 路径：同一个 `emitEvent` → `BridgeClientAPI` → `IEventService.publish` → `WSBroadcastService` 加序号/入日志/扇出到 WS。

---

## 6. 功能对齐矩阵（核心）

图例：✅ 一一对齐 · ⚠️ 有差异/需在 SDK 适配 · ❌ KAP 缺失

### 6.1 Harness / 配置 / 生命周期

| TUI 需求（SDK） | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| 创建客户端/工厂 | `createKimiHarness` | （SDK 侧新建 KAP client） | ✅ | 在 SDK 内实现 |
| `getConfig` | `getKimiConfig` | `GET /config` | ✅ | 注意字段命名差异（snake_case） |
| `setConfig(patch)` | `setKimiConfig` | `POST /config` | ✅ | 合并补丁 |
| `getConfigDiagnostics` | `getConfigDiagnostics` | — | ❌ | `/config` 与 `/meta` 均无 `warnings`；CoreAPI `getConfigDiagnostics` 未接线 |
| `getExperimentalFeatures` | `getExperimentalFeatures` | `GET/POST /config` 的 `experimental` 字段（`record<string,bool>`） | ⚠️ | **flag 值**已暴露（`configService.ts:70`/`rest/config.ts:29`）；但**注册表元数据**（`explainAll()` 的 title/description/default/source）无 KAP 接线，`/experiments` 列表拿不到 |
| `removeProvider` | `removeKimiProvider` | — | ❌ | 无 `DELETE /providers/{id}`；`POST /config` 是 deep-merge 不能删 key（web 的 `deleteProvider` 调的是个未实现端点，会 404） |
| `ensureConfigFile` | （本地 `config/toml.ts`） | `POST /config`（副作用会写文件） | ⚠️ | 纯本地工具，非 RPC；远端可借 `POST /config` 间接触发写文件，但无显式 ensure 语义 |
| `track/setTelemetryContext` | （本地遥测） | — | ✅ | 客户端行为，不涉及协议 |
| `homeDir` | （本地） | — | ⚠️ | 本地化假设，见 §9 |
| `KimiAuthFacade` 直接构造 | （本地） | `IOAuthService`/`IAuthSummaryService` | ⚠️ | auth 被拆到服务端，telemetry bootstrap 需重新设计 |

### 6.2 Session 管理

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `createSession` | `createSession` | `POST /sessions` | ✅ | 需 `workspace_id` 或 `metadata.cwd` |
| `resumeSession` | `resumeSession` | `GET /sessions/{id}` + `GET /snapshot` | ⚠️ | KAP session 持久在服务端，GET 即「加载」；但富 replay payload 见下行 |
| `getResumeState`（富 replay） | `resumeSession` 返回 `ResumedAgentState{replay,toolStore,background,...}` | `GET /snapshot` + `GET /messages` | ⚠️ | **数据模型不同**：snapshot = `messages` + `in_flight_turn` + pending approvals/questions。`messages` 由 wire.jsonl 还原（`IMessageService`），可重建消息流；但 `AgentReplayRecord` 的 `compaction` token 统计、`goal_updated`/`plan_updated`/`permission_updated`/`approval_result` 历史标记**丢失**（仅保留当前值，见 §8） |
| `reloadSession` | `reloadSession` | — | ❌ | 不在 action 列表（仅 fork/compact/undo/abort/btw/archive）；会重读磁盘配置+reload 插件，**不能**用 `POST /profile` 近似 |
| `forkSession` | `forkSession` | `POST /sessions/{id}:fork` | ✅ | |
| `listSessions` | `listSessions` | `GET /sessions` | ✅ | 游标分页，字段命名差异 |
| `renameSession` | `renameSession` | `POST /sessions/{id}/profile` | ✅ | 更新 title |
| `exportSession`（zip） | `exportSession` | — | ❌ | 无 zip 导出；注意 `:archive` 只是「归档/隐藏」（`{archived:true}`），**不是** zip |
| `closeSession` | `closeSession` | `POST /sessions/{id}:archive`（部分） | ⚠️ | 只有 `:archive`（= close + 磁盘归档）；无「仅卸载不归档」的 close。若 TUI 切会话可接受归档则可复用 |
| 同步读 `session.id/workDir/summary` | 构造时填充 | 创建/GET 返回时填充 | ⚠️ | SDK 需在创建后同步填充这些字段 |

### 6.3 消息 / Turn

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `prompt(input)` | `prompt` | `POST /sessions/{id}/prompts` | ✅ | image/video 由服务端解析为 base64 |
| `steer(input)` | `steer` | `POST /sessions/{id}/prompts::steer` 或 `/prompts/{pid}:steer` | ✅ | |
| `activateSkill` | `activateSkill` | `POST /sessions/{id}/skills/{name}:activate` | ✅ | |
| `startBtw` | `startBtw` | `POST /sessions/{id}:btw` | ✅ | |
| `init()`（生成 AGENTS.md） | `generateAgentsMd` | — | ❌ | KAP 无等价端点 |
| `interactiveAgentId`/`withInteractiveAgent` | 客户端 `AsyncLocalStorage` 给载荷加 `agentId` | `PromptSubmission.agent_id`（per-prompt）+ `POST :btw`（返回 forked agent id） | ✅ | KAP 用 per-request `agent_id` 表达「同 session 多 agent」，web 的 side-chat 就是这么做的。SDK 把 scope 内的 `agent_id` 附到 prompt/cancel/setter 上即可。**注意**：child sessions 是另一概念（web 未用）；副作用道 transcript 仅经 WS，不进 snapshot/messages |

### 6.4 运行时控制（model / thinking / permission / plan / swarm）

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `setModel` | `setModel` | `POST /sessions/{id}/profile`（`agent_config.model`）或 `POST /sessions/{id}/prompts`（body `model`） | ✅ | session 级 + per-turn 两条路径 |
| `setThinking` | `setThinking` | `agent_config.thinking` / prompt body `thinking` | ✅ | 同上 |
| `setPermission` | `setPermission` | `agent_config.permission_mode` / prompt body `permission_mode` | ✅ | 同上 |
| `setPlanMode` | `enterPlan`/`cancelPlan` | `agent_config.plan_mode` / prompt body `plan_mode` | ✅ | `true`→enterPlan、`false`→cancelPlan |
| `setSwarmMode` | `enterSwarm`/`exitSwarm` | `agent_config.swarm_mode` / prompt body `swarm_mode` | ✅ | 同上 |
| `getStatus` | 客户端组合 6 个 RPC | `GET /sessions/{id}/status` | ✅ | KAP 直接给 model/thinking_level/permission/plan_mode/swarm_mode/context usage |
| `getUsage` | `getUsage` | `status` / session `usage` | ✅ | |

> 机制：运行时控制在 KAP 里统一走 `AgentStatePatch`（`packages/agent-core/src/services/prompt/prompt.ts`）。两条入口都会落到 `IPromptService.applyAgentState` → `core.rpc.*`：
> 1. **session 级**：`POST /sessions/{sid}/profile`，body 带 `agent_config`（`sessionAgentConfigSchema`，含 `model/thinking/permission_mode/plan_mode/swarm_mode`）。`SessionService.update`（`sessionService.ts:326-346`）把 `agent_config` 转成 `AgentStatePatch` 并以 `source='meta'` 派发。
> 2. **per-turn**：`POST /sessions/{sid}/prompts`，body 直接带同名字段（`promptSubmissionSchema`），以 `source='prompt'` 派发。
>
> `applyAgentState` 内部有 per-session shadow 做 diff，冗余 setter 不会重复下发。所以对 TUI 来说 `setModel/setThinking/...` 的 session 级语义**完全保留**，SDK 只需把 `Session.setX()` 翻译成一次 `POST /profile`（或在下次 `prompt` 时合并）。

### 6.5 上下文 / 历史 / 压缩 / Undo

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `getContext` | `getContext`（`{history, tokenCount}`） | `GET /sessions/{id}/messages` + `GET /status.context_tokens` | ⚠️ | history 是 wire 还原的**完整 transcript**（非压缩后折叠视图）；token 只有 session 级，无 per-message。`/undo` 应改调 `:undo` 而非本地算 |
| `compact` | `beginCompaction` | `POST /sessions/{id}:compact` | ✅ | |
| `cancelCompaction` | `cancelCompaction` | — | ❌ | 无取消端点；`:abort` 只 `cancel` turn（`agent/index.ts:273`），`cancelCompaction` 是独立 RPC（`agent/index.ts:337`）。`compaction.cancelled` 事件存在但无法触发 |
| `undoHistory` | `undoHistory` | `POST /sessions/{id}:undo` | ✅ | 服务端跑正确的 `canUndoHistory`，返回 `{messages, status}` |

### 6.6 流式事件（推送）

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `onEvent`（按 sessionId 过滤，带 agentId） | 反向 `emitEvent` | WS `subscribe` + 事件帧 | ✅ | envelope 有 `session_id`；agentId 在 payload 内 |
| turn/step：`turn.started/ended`、`turn.step.*` | `emitEvent` | WS 事件 | ✅ | |
| 内容：`assistant.delta`、`thinking.delta`、`hook.result` | `emitEvent` | WS 事件（delta 为 volatile，带 offset） | ✅ | 注意 volatile 不重放 |
| 工具：`tool.call.started/delta`、`tool.progress`、`tool.result` | `emitEvent` | WS 事件 | ✅ | `tool.progress` 携带 stdout/stderr/自定义（含 MCP OAuth URL） |
| 状态：`agent.status.updated` | `emitEvent` | WS 事件（volatile） | ✅ | |
| session/meta：`session.meta.updated`、`error`、`warning` | `emitEvent` | WS 事件 | ✅ | |
| goal/compaction/subagent/background/cron/mcp/skill | `emitEvent` | WS 事件 | ✅ | |
| **approval/question 事件** | `requestApproval/requestQuestion`（反向 RPC） | `event.approval.*`/`event.question.*`（WS） | ⚠️ | **事件类型未进 `AgentEvent` 联合**（§4.2）；SDK 需纳入并转成对 handler 的调用 |

### 6.7 Approvals / Questions（反向通道）

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| 注册 approval handler | `setApprovalHandler` | SDK 监听 `event.approval.requested` | ⚠️ | 服务器推送事件，SDK 需把它转成对本地 handler 的调用 |
| 接收 `ApprovalRequest` | `requestApproval` | WS 事件 payload（`approvalRequestSchema`） | ✅ | 字段等价（toolCallId/toolName/action/display） |
| 回 `ApprovalResponse` | handler 返回 | `POST /sessions/{id}/approvals/{approval_id}` | ✅ | decision/scope/feedback/selectedLabel |
| 注册 question handler | `setQuestionHandler` | SDK 监听 `event.question.requested` | ⚠️ | 同上 |
| 接收 `QuestionRequest` | `requestQuestion` | WS 事件 payload | ✅ | |
| 回 `QuestionResult`（含 dismiss） | handler 返回 | `POST /sessions/{id}/questions/{id}` 或 `:dismiss` | ✅ | |

> 这是迁移的**核心设计点**：现 SDK 是「核心反向调用本地回调」，KAP 是「服务器推事件 + 客户端 POST 决议」。SDK 需要在 WS 收到 approval/question 事件后，调用 TUI 注册的 handler，拿到结果再 POST 回 server，并处理超时/取消/重复（server 端 approval/question broker 有 60s 默认超时和「最近已决议」台账，重复 POST 会得 `40902`）。

### 6.8 后台任务

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `listBackgroundTasks` | `getBackground` | `GET /sessions/{id}/tasks` | ✅ | |
| `getBackgroundTaskOutput` | `getBackgroundOutput` | `GET /sessions/{id}/tasks/{task_id}?with_output` | ✅ | |
| `stopBackgroundTask` | `stopBackground` | `POST /sessions/{id}/tasks/{task_id}:cancel` | ✅ | |
| `detachBackgroundTask` | `detachBackground` | — | ❌ | KAP 无；但 TUI 当前未使用 |

### 6.9 Goals

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `createGoal` | `createGoal` | `POST /sessions/{id}/profile`（`agent_config.goal_objective`）或 `POST /sessions/{id}/prompts`（body `goal_objective`） | ✅ | `PromptService` 调 `core.rpc.createGoal({objective})` |
| `pauseGoal` | `pauseGoal` | `goal_control: 'pause'`（同上两条入口） | ✅ | → `core.rpc.pauseGoal` |
| `resumeGoal` | `resumeGoal` | `goal_control: 'resume'` | ✅ | → `core.rpc.resumeGoal` |
| `cancelGoal` | `cancelGoal` | `goal_control: 'cancel'` | ✅ | → `core.rpc.cancelGoal` |
| `getGoal` | `getGoal` | `goal.updated` 事件（`GoalSnapshot \| null`）+ `session.agent_config.goal_objective` | ⚠️ | 无独立 GET；SDK 可缓存最近一次 `goal.updated` 提供同步读取 |
| `goal.updated` 事件 | `emitEvent` | WS 事件（**durable**，不在 `VOLATILE_EVENT_TYPES` 内） | ✅ | 重连时随 seq 游标重放，可恢复当前 goal |
| Goal queue 持久化 | TUI 写 `<sessionDir>/upcoming-goals.json` | — | ❌ | 远端核心时 `sessionDir` 不是本地路径，需服务端 API 或本地映射 |

> 机制：Goal 与运行时控制共用 `AgentStatePatch`（`packages/protocol/src/session.ts:71-72` 的 `goal_objective`/`goal_control`）。`PromptService._applyAgentStateInternal`（`promptService.ts:706-741`）把 `goal_objective` 转成 `core.rpc.createGoal`、`goal_control` 转成 `pauseGoal/resumeGoal/cancelGoal`，两者都是「一次性触发器」（不写入 shadow）。错误经 `sessions.ts` 的 `GOAL_ERROR_CODE_MAP`（`sessions.ts:617-624`）从 agent-core 字符串 code 映射到 protocol 整数码（`40913–40919`）。所以 Goal **不是缺口**，只是控制面从「4 个独立方法」变成「`agent_config` 上的两个字段」，SDK 适配层做映射即可。唯一遗留点是 **`getGoal` 的同步读取**：KAP 把当前 goal 快照放在 `goal.updated` 事件里推送（且该事件 durable、可重放），SDK 维护一份本地缓存即可还原 `getGoal()`。

### 6.10 Skills / MCP / Plugins

| TUI 需求 | 现 RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `listSkills` | `listSkills` | `GET /sessions/{id}/skills` | ✅ | |
| `listMcpServers` | `listMcpServers` | `GET /mcp/servers` | ✅ | |
| `getMcpStartupMetrics` | `getMcpStartupMetrics` | — | ❌ | CoreAPI 有但未接线；`McpServer` schema 无 duration 字段，也未嵌入任何事件（web 连 MCP 列表都没用） |
| `reconnectMcpServer` | `reconnectMcpServer` | `POST /mcp/servers/{id}:restart` | ✅ | |
| `listPlugins` | `listPlugins` | — | ❌ | **KAP 无任何 plugin 路由** |
| `installPlugin` | `installPlugin` | — | ❌ | |
| `setPluginEnabled`/`setPluginMcpServerEnabled` | 同名 | — | ❌ | |
| `removePlugin`/`reloadPlugins`/`getPluginInfo` | 同名 | — | ❌ | |

### 6.11 Auth / OAuth

| TUI 需求 | 现 SDK/RPC | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `auth.status` | `KimiAuthFacade.status` | `GET /auth` | ✅ | |
| `auth.login`（device code） | `KimiAuthFacade.login` | `POST /oauth/login` + `GET /oauth/login`（轮询） | ✅ | SDK 需把「start + poll」封装成单次 `login` |
| `auth.logout` | `KimiAuthFacade.logout` | `POST /oauth/logout` | ✅ | |
| `auth.getManagedUsage` | `KimiAuthFacade.getManagedUsage` | — | ❌ | **不是 daemon RPC**：SDK 直接调外部 Kimi platform `/usages`（`oauth/src/managed-usage.ts`）。KAP 无代理端点，需新增（如 `GET /auth/usage`）用缓存 token 转发 |
| `auth.submitFeedback` | `KimiAuthFacade.submitFeedback` | — | ❌ | 同上：外部 platform API，KAP 无代理（`ServicesAuthFacade` 未实现） |
| `getCachedAccessToken`/`resolveOAuthTokenProvider` | 本地 token provider | 服务端持有 token | ⚠️ | token 在服务端；telemetry/refresh 需改为经服务端或保留本地 |

### 6.12 Catalog / Providers（客户端 HTTP）

| TUI 需求 | 现 SDK | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `fetchCatalog`/`applyCatalogProvider` 等 | 纯客户端 HTTP | 保留为客户端工具 | ✅ | 不走 RPC，不受 KAP 影响 |
| 刷新 OAuth provider 模型 | 本地 | `POST /providers:refresh_oauth` | ✅ | 可走 KAP |
| 设默认模型 | `setConfig({defaultModel})` | `POST /models/{id}:set_default` | ✅ | |

### 6.13 错误 / 日志 / 进程 / Config RPC

| TUI 需求 | 现 SDK | KAP | 状态 | 备注 |
|---|---|---|---|---|
| `KimiError`/`ErrorCodes`/`isKimiError`/`error.details` | 字符串 code | 整数 code + reason | ⚠️ | SDK 网络层需做 code 映射并保留 `details` |
| `log`/`flushDiagnosticLogs`/`resolveGlobalLogPath` 等 | 本地 | 本地 | ✅ | 客户端行为 |
| `createKimiConfigRpc`（doctor） | 独立 RPC | — | ⚠️ | KAP 无 config validate；可保留本地或改走 `POST /config` |
| 重连 / 断线恢复 | 无（进程内不掉线） | `resync_required` + `snapshot` | ⚠️ | **SDK 需新增**：自动重连、按游标 resubscribe、向 TUI 暴露连接状态 |

---

## 7. 一一对齐的部分（✅）

以下能力 KAP 已有等价端点/事件，SDK 主要做「方法→HTTP/WS」的转发与字段命名适配：

- 配置读/写（`getConfig`/`setConfig`）
- Session 创建/列表/详情/fork/rename/children
- 消息提交/steer/skill 激活/btw
- 中断（`cancel` → `POST /sessions/{id}:abort` / `/prompts/{pid}:abort` / WS `abort`，session 级 + prompt 级都支持）
- 多 agent（`withInteractiveAgent` → per-request `agent_id` + `POST :btw`；child sessions 是另一概念、web 未用）
- 实验特性 **flag 值**（`GET/POST /config` 的 `experimental` 字段；注册表元数据见 §9）
- 状态读取（`getStatus`/`getUsage`）
- 运行时控制（`setModel`/`setThinking`/`setPermission`/`setPlanMode`/`setSwarmMode`，经 `POST /profile` 的 `agent_config` 或 per-prompt body）
- Goals（`createGoal`/`pauseGoal`/`resumeGoal`/`cancelGoal`，经 `agent_config.goal_objective`/`goal_control`）+ `goal.updated` 事件
- 压缩/undo
- **完整事件流**（40 种 `AgentEvent` 经 WS 推送，含 delta/工具/状态/subagent/background/cron/mcp）
- Approval / Question 的「接收 + 决议」数据通路（server 端 broker 已就绪）
- 后台任务 list/output/cancel
- Skills 列表、MCP 列表/重启
- OAuth device-code 登录（start + poll）/logout、auth 就绪
- 模型/Provider 列表、设默认模型、刷新 OAuth provider
- 文件上传/下载、session 级 fs 操作、workspace 与文件夹选择器、PTY（terminal）
- 客户端 HTTP 工具（catalog/provider）保持不变

---

## 8. 存在差异 / 需在 SDK 适配（⚠️）

1. **富 replay 数据模型**：`getResumeState()` 返回 `ResumedAgentState{replay:AgentReplayRecord[], toolStore, background, sessionMetadata}`，TUI 的 `session-replay.ts`/`message-replay.ts` 深度遍历这些记录。KAP 的 `snapshot` + `messages` 是「消息 + in_flight_turn」模型，**不直接提供 `AgentReplayRecord[]`**。已确认：
   - `message` 记录可从 `GET /messages` 重建（`IMessageService` 由 wire.jsonl 还原，content 含 `tool_use`/`tool_result`/`thinking` 等）。
   - `compaction` 记录只能还原成 `origin.kind==='compaction_summary'` 的消息，**token 统计（tokensBefore/After）丢失**（web 注释 `apps/kimi-web/src/api/types.ts:180-182` 明确这点）。
   - `goal_updated`/`plan_updated`/`permission_updated`/`approval_result`/`config_updated` 这些**历史标记在重载后丢失**（只有当前值：goal 来自 `agent_config.goal_objective`+`goal.updated` 事件，plan/permission 来自 `agent_config`/`GET /status`）。
   - SDK 适配：用 messages + in_flight_turn 合成 replay，标记类历史按 web 行为丢弃（TUI 的状态标记在 resume 后不显示，与 web 一致）。
2. **`getContext` 语义**：SDK 返回「压缩后折叠的 history + tokenCount」；KAP `GET /messages` 给的是 wire 还原的**完整 transcript**（含被压缩掉的旧消息），token 只在 session 级（`GET /status.context_tokens`）。导出会更多；`/undo` 应改调服务端 `:undo`（已跑正确的 `canUndoHistory`）而非本地算。
3. **错误码映射**：整数 code → `KimiError`/`ErrorCodes`，并保留 `details`（如 `undo_limit` 的 `undoableCount`、`content_filter` 等）。Goal 错误的映射在 server 端 `GOAL_ERROR_CODE_MAP` 已做，SDK 仍需把整数码翻回 `KimiError`。
4. **Approval/Question 事件类型**：把 `event.approval.*`/`event.question.*` 纳入 SDK 事件类型并桥接到 `setApprovalHandler`/`setQuestionHandler`。
5. **重连 / 断线恢复**：现 TUI 假设连接永不断。SDK 需在 WS 上实现：自动重连、带 `{seq,epoch}` 重新 `subscribe`、处理 `resync_required`（拉 `snapshot`）、去重/保序、并向 TUI 暴露「连接中/已断开」状态（可复用现有 `error`/`warning` 事件通道渲染）。
6. **同步字段读取**：TUI 同步读 `session.id/workDir/summary`。SDK 在 create/resume 返回时就要填充这些字段（不能懒加载）。同理，`getGoal()` 需 SDK 缓存 `goal.updated` 才能同步返回。
7. **`closeSession` vs `archive`**：KAP 只有 `:archive`（= close + 磁盘归档），无「仅卸载不归档」。若 TUI 切会话可接受归档副作用则复用；否则需新增 close 端点。
8. **本地化**：`homeDir`/`sessionDir` 不暴露（`sessionSchema` 只有 `metadata.cwd`，无绝对路径；`GET /meta` 无 home dir）。`ensureConfigFile` 是纯本地工具（`POST /config` 副作用会写文件）。详见 §10。
9. **实验特性「值 vs 注册表」**：flag 的**当前值**经 `GET/POST /config` 的 `experimental` 字段暴露；但 `getExperimentalFeatures` 返回的**注册表元数据**（title/description/default/source）无 KAP 接线。`/experiments` 若要展示「有哪些 flag 可配」会拿不到。

---

## 9. KAP 缺失的功能（❌ Gap）

按对 TUI 的影响排序：

### 9.1 高影响（TUI 重度依赖）

- **Plugins 全套**：`listPlugins`/`installPlugin`/`setPluginEnabled`/`setPluginMcpServerEnabled`/`removePlugin`/`reloadPlugins`/`getPluginInfo`（`core-api.ts:394-400`）无任何 KAP 接线——无路由、无 service 目录、无 protocol schema（server 里的 `plugin` 只是 Fastify 的 `register(plugin,opts)`）。TUI 的 `/plugins` 命令与插件面板依赖。
- **导出 session（zip）**：`exportSession`（`core-api.ts:393`）无 KAP 端点。注意 `:archive` 只是「归档/隐藏」（`{archived:true}`），**不是** zip。TUI 的 `/export-debug-zip` 依赖。
- **`getConfigDiagnostics`**：配置警告，TUI 启动时显示在状态栏。`/config` 与 `/meta` 均无 `warnings` 字段，CoreAPI 未接线。
- **`removeProvider`**：删除 provider，TUI 的 `/provider` 依赖。无 `DELETE /providers/{id}`；`POST /config` 是 deep-merge 不能删 key（web 的 `deleteProvider` 调的是未实现端点，会 404）。
- **`cancelCompaction`**：TUI 在压缩中按 Esc 调用。KAP 有 `:compact`（开始）但**无取消**；`:abort` 只 `cancel` turn，`cancelCompaction` 是独立 RPC。`compaction.cancelled` 事件存在但无法经 KAP 触发。
- **实验特性注册表元数据**：`getExperimentalFeatures`（flag 的 title/description/default/source）无 KAP 接线。flag 的**当前值**已走 `config.experimental`（见 §8），但 `/experiments` 若要列出「有哪些 flag 可配」会拿不到。

### 9.2 中影响

- **`reloadSession`**：重新加载磁盘配置/插件并恢复。不在 action 列表，且**不能**用 `POST /profile` 近似（`reloadSession` 重读磁盘、reload provider manager、清缓存、reload 插件、`applyAgentState` 只更新 `agent_config`）。TUI 的 `/reload`、`/experiments` 切换后依赖。
- **`init()`（生成 AGENTS.md，`generateAgentsMd`）**：TUI 的 `/init` 依赖，无 KAP 端点。
- **`auth.getManagedUsage` / `auth.submitFeedback`**：TUI 的 `/usage`、`/feedback` 依赖。**不是 daemon RPC**——SDK 直接调外部 Kimi platform API（`oauth/src/managed-usage.ts`）。KAP 无代理端点，需新增（如 `GET /auth/usage`、`POST /auth/feedback`）用缓存 token 转发。
- **Goal queue 持久化**：当前 TUI 直接写 `<sessionDir>/upcoming-goals.json`。KAP 无「upcoming goals」概念（只有单一活跃 goal），且 `sessionDir` 不暴露。需保留为客户端状态（按 sessionId 本地存储）。

### 9.3 低影响（TUI 用得少或未用）

- `detachBackgroundTask`（CoreAPI `detachBackground` 无 KAP 接线；TUI 未用）
- `getMcpStartupMetrics`（CoreAPI 有但未接线；值未嵌入 `McpServer` 或任何事件）
- 纯 `closeSession`（仅卸载不归档）：KAP 只有 `:archive`；若 TUI 必须「卸载不归档」则需新增端点（否则复用 `:archive`）
- `createKimiConfigRpc` 的 `validateConfigToml`（doctor 用，可保留本地）

### 9.4 协议层瑕疵（需在 SDK/protocol 侧处理）

- approval/question 事件未进 `AgentEvent` 联合（§4.2、§6.6）。
- `McpServerStatusPayload.transport`（`stdio|http`）比 `mcpServerTransportSchema`（`stdio|http|sse`）窄，存在轻微 schema drift。
- 错误码命名空间 `7xxxx`/`8xxxx` 已声明但未分配具体码，透传错误当前泛化为 `50001`。
- `GET /meta` 的 capabilities、`server_hello.capabilities` 当前是硬编码字面量（event batching/compression 未实现）。

---

## 10. 本地化假设与迁移风险

TUI 里有几处「核心是本地进程」的隐式假设，迁移到「核心是远端 server」时会失效：

1. **直接写 sessionDir**：`goal-queue-store.ts` 用 `node:fs/promises` 直接读写 `join(session.summary.sessionDir, 'upcoming-goals.json')`。远端时 `sessionDir` 不是本地路径。**需要**：服务端提供 goal-queue API，或 SDK 把 sessionDir 映射为本地可写目录。
2. **`homeDir` 本地写**：迁移标记（`kimi-tui.ts` 写 `~/.skip-migration-from-kimi-cli`）、telemetry 等把 `harness.homeDir` 当本地目录。如果 host 仍有自己的本地 home 则 OK，但需明确「host home」与「core home」的边界。
3. **导出写本地**：`/export-md`、`/export-debug-zip` 把字节写到本地磁盘；字节来自 `exportSession`/`getContext`。KAP 后需服务端能返回这些字节（文件下载流），目前 zip 导出是缺口。
4. **无断线处理**：TUI 假设 `onEvent` 永不掉线、每个 RPC 必 resolve。SDK 需补重连/状态暴露（§8.5）。
5. **可取消的长调用**：`auth.login({signal})`、`fetchCatalog(url, signal)` 被 TUI 接到 Ctrl-C。KAP 后 `login`（start+poll）仍需支持 `AbortSignal` 透传到网络请求/server turn。
6. **同步字段读取**（§8.6）。

---

## 11. 建议的 SDK 封装方案（高层）

> 仅给方向，待用户确认后再细化设计/实现。

1. **保持 SDK 公开 API 不变**：`KimiHarness`/`Session` 的方法签名、事件类型、`ApprovalHandler`/`QuestionHandler`、`KimiError` 等都对 TUI 保持不变；只替换 `SDKRpcClientBase` 的实现。
2. **新增 KAP transport**：在 SDK 内实现一个 HTTP client（REST，统一 envelope 解包 + 整数 code→`KimiError` 映射）和一个 WS client（握手/心跳/订阅/事件分发/重连 resync），并把它们组合成 `CoreAPI` 语义的适配层。
3. **事件桥**：WS 事件 → `receiveEvent` → `onEvent` 监听器；`event.approval.*`/`event.question.*` → 调用本地 handler → POST 决议。
4. **运行时控制 / Goal 适配**：`Session.setModel/setThinking/setPermission/setPlanMode/setSwarmMode` 翻译成 `POST /sessions/{id}/profile` 的 `agent_config`（或合并进下一次 `prompt` body）；`createGoal/pauseGoal/resumeGoal/cancelGoal` 翻译成 `agent_config.goal_objective`/`goal_control`；`getGoal()` 用 `goal.updated` 事件维护的本地缓存实现同步读取。
5. **Replay 适配**：用 `messages` + `in_flight_turn` 重建 `ResumedAgentState` 形状的 replay，供 TUI 现有 replay renderer 消费。
6. **缺口处理**：对 §9 的 ❌ 项，要么（a）在 server/protocol 补齐端点，要么（b）在 SDK 侧做降级/保留本地实现，要么（c）TUI 暂时禁用相关命令。需逐条决策。

---

## 12. 附录：关键文件路径

- 现 SDK：`packages/node-sdk/src/{index,session,kimi-harness,rpc,sdk-rpc-client,config-rpc,auth,catalog,events,types}.ts`
- 现 RPC（核心侧）：`packages/agent-core/src/rpc/{core-api,core-impl,client,sdk-api}.ts`、`packages/agent-core/src/session/rpc.ts`
- KAP server：`packages/server/src/{start,routes/*,ws/*,services/*,envelope,error-handler,request-id,version}.ts`
- KAP protocol：`packages/protocol/src/{events,ws-control,envelope,error-codes,session,message,approval,question,...}.ts` + `rest/*`
- agent-core services facade：`packages/agent-core/src/services/*`
- TUI 入口与 SDK 使用：`apps/kimi-code/src/{main,cli/*,tui/kimi-tui.ts,tui/controllers/*,tui/reverse-rpc/*,tui/commands/*}`

---

## 13. 速查：对齐统计

| 状态 | 数量（约） | 说明 |
|---|---|---|
| ✅ 一一对齐 | ~40 | session/消息/事件流/approval/question/task/skill/mcp/oauth/model/file/fs/terminal/workspace，**以及运行时控制（5）、Goals（4）、多 agent（agent_id）、abort、实验特性 flag 值** |
| ⚠️ 需适配 | ~10 | replay 模型、`getContext` 语义、错误码映射、approval/question 事件类型、重连、`getGoal` 缓存、close/archive、本地化、实验特性「值 vs 注册表」 |
| ❌ KAP 缺失 | ~12 个功能（含 Plugins 7 方法） | plugins(7)、export、diagnostics、removeProvider、cancelCompaction、实验特性注册表、reload、init、managedUsage、feedback、goal-queue、detach、mcpMetrics |

> 结论：主流会话/消息/事件/审批通路**以及运行时控制、Goals、多 agent、abort** 都对齐（经逐条核验，含「非独立路由」的暴露方式如 `agent_config`、`agent_id`）。迁移的实质工作量集中在 **(a) WS 流 + 反向通道的 SDK 实现**、**(b) Plugins/导出/诊断/取消压缩 等 KAP 真缺口的补齐策略**、**(c) replay/错误码/重连的适配**。
