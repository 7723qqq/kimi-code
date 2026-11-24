# 服务与配置接口

本页列出服务信息、登录与用量、远程控制、配置、模型与供应商、技能与 MCP、能力与插件、工作区、文件上传、GUI 存储、全局搜索和 MCP 管理接口。通用约定见[服务 API](./server-api.md)。

## 服务与元信息

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/healthz` | 探活，免鉴权 |
| `GET /api/v1/meta` | 服务版本、能力集、`server_id`、实验开关 |
| `POST /api/v1/shutdown` | 优雅退出（先回 200 再关闭）；仅 loopback 绑定时挂载 |

### `GET /api/v1/healthz`

供脚本与进程管理器使用的探活端点。它是唯一豁免 bearer token 的 `/api` 端点（见 [鉴权](./server-api.md#鉴权)），应答时不触碰配置与引擎。

成功时 `data` 为 `{ "ok": true }`。

### `GET /api/v1/meta`

返回本实例的身份信息与能力集。大多数字段在启动时即固定；`experimental_flags` 与 `features` 按请求实时解析，因此开关翻转或某个 feature 失败会体现在下一次响应中。

成功时 `data` 携带：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `server_version` | string | 服务版本 |
| `product` | string? | 宿主产品名（宿主身份声明时返回） |
| `capabilities` | object | 能力集——`websocket`、`file_upload`、`fs_query`、`mcp`，均恒为 `true` |
| `server_id` | string | 本服务实例的唯一 id |
| `started_at` | string | 启动时间，ISO 8601 格式 |
| `open_in_apps` | array | 可作为 `open-in` 目标的宿主应用（`finder` / `cursor` / `vscode` / `iterm` / `terminal`）；目前恒为空 |
| `dangerous_bypass_auth` | boolean | 服务是否以 `--dangerous-bypass-auth` 启动（客户端可跳过 token 提示） |
| `backend` | string | 引擎后端，`v1` 或 `v2`；本服务恒为 `v2` |
| `web_title` | string | 来自 `--web-title` 的自定义浏览器标签页标题；未设置时省略 |
| `experimental_flags` | object | 实验开关 id → 是否启用，按请求时解析 |
| `features` | array | 引擎 feature，形如 `{ name, state, meta }`；`state` 为 `Pending` / `Activating` / `Active` / `Unloading` / `Failed` |

### `POST /api/v1/shutdown`

请求服务优雅退出。响应先发出，随后立即执行关闭，因此调用方可以信任收到的响应。该路由仅在 loopback 绑定时挂载——非 loopback 绑定时它根本不会被注册（请求得到 404），除非服务以 `--allow-remote-shutdown` 启动。

成功时 `data` 为 `{ "ok": true }`。

## 登录与用量

这组端点驱动托管 Kimi OAuth 登录的生命周期，并暴露账号级信息。托管供应商名为 `managed:kimi-code`；下面每个端点上可选的 `provider` 参数都默认取它。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/auth` | 鉴权状态快照 |
| `POST /api/v1/oauth/login` | 发起 OAuth device-code 登录流程 |
| `GET /api/v1/oauth/login` | 轮询登录流程状态 |
| `DELETE /api/v1/oauth/login` | 取消进行中的登录流程 |
| `POST /api/v1/oauth/logout` | 登出托管供应商 |
| `GET /api/v1/oauth/usage` | 套餐额度与加油包 |
| `GET /api/v1/oauth/userinfo` | 账号资料 |
| `GET /api/v1/oauth/region` | 解析客户端所属区域（`mainland-cn` / `global`） |

### `GET /api/v1/auth`

鉴权状态快照：默认模型能否解析到可用的供应商配置，以及托管供应商的登录状态。当全局 `default_model` 别名存在于模型表中且能解析到已配置的供应商时，`models_ready` 为 `true`——包括自带 `base_url` 的平铺（providerless）模型，以及通过 `KIMI_MODEL_*` 环境变量注入的模型。它不做凭据校验，因此此后的对话请求仍可能以 `40111` / `40112` 失败。

成功时 `data` 携带 `models_ready`（布尔值）、`providers_count`（已配置供应商数量）与 `managed_provider`（`null`，或 `{ name, status }`，其中 `status` 为 `authenticated` / `expired` / `revoked` / `unauthenticated` 之一）。全局默认模型别名本身改从 `GET /api/v1/config` 的 `default_model` 读取，本端点不再携带。

### `POST /api/v1/oauth/login`

为托管供应商发起 OAuth device-code 登录流程；发起新流程会中止同一供应商进行中的流程。账号已登录时无需用户交互，响应会立即报告 `authenticated`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | body | string | 托管供应商名称。默认 `managed:kimi-code` |
| `region` | body | string | `mainland-cn` 或 `global`；覆盖 `GET /api/v1/oauth/region` 一节描述的区域解析结果，仅对本次流程生效 |

成功时 `data` 有两种形态。进行中的流程——`{ flow_id, provider, status: "pending", verification_uri, verification_uri_complete, user_code, expires_in, interval, expires_at }`：打开 `verification_uri_complete`（或打开 `verification_uri` 并输入 `user_code`），然后每隔 `interval` 秒轮询 `GET /api/v1/oauth/login`，直到流程完结或超过 `expires_at`（`expires_in` 是以秒表示的同一时限）。已登录的快速路径——`{ flow_id, provider, status: "authenticated" }`。

### `GET /api/v1/oauth/login`

轮询某供应商的登录流程状态。尚未发起过流程时返回 `null`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `null` 或流程快照：`{ flow_id, provider, status, verification_uri, verification_uri_complete, user_code, expires_in, expires_at, interval }`，其中 `status` 为 `pending` / `authenticated` / `denied` / `expired` / `cancelled`。流程离开 `pending` 后，`resolved_at` 记录其到达终态的时间，`error_message` 描述失败的流程。

### `DELETE /api/v1/oauth/login`

取消某供应商进行中的登录流程。没有进行中的流程时，该调用为空操作，返回最近一次已知状态。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ cancelled, status }`：只有确实中止了一个 `pending` 流程时 `cancelled` 才为 `true`，`status` 为调用后的流程状态。

### `POST /api/v1/oauth/logout`

登出托管供应商：丢弃已存储的 OAuth 凭据、中止进行中的登录流程，并把托管供应商从配置中移除。OAuth 托管的供应商拒绝手动编辑与删除（见下文 `PUT` / `DELETE /api/v1/providers/{provider_id}`），因此要移除它需先登出。

对默认 Kimi 供应商（`managed:kimi-code`），登出还会拆除本机的远程控制并清除缓存的远程控制云端会话。当没有隧道运行或隧道由本机其他进程持有时，登出会先把本机设备下线并持有本机锁，确保凭据被丢弃之前本机任何进程都无法再次开启远程控制；清理失败会中止登出。当隧道由本服务持有时，先丢弃凭据，隧道在响应发出后随即拆除，因此通过远程控制链接发起的登出仍能收到响应。登出其他供应商不影响远程控制。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | body | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ logged_out: true, provider }`。

### `GET /api/v1/oauth/usage`

托管账号的套餐额度与加油包，实时取自账号服务。上游失败不会让信封失败——它以 `kind: "error"` 的形式带内返回。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ kind: "ok", quota }` 或 `{ kind: "error", message, status? }`，其中 `status` 为上游 HTTP 状态码（如存在）。在 `ok` 形态中，`quota` 为 `{ usages, extraUsage }`：`usages` 按窗口携带 `{ usedRatio, resetAt? }` 条目——`limit5h`、`limit7d`、`monthTotal`、`monthCode`——其中 `usedRatio` 为 0–1 浮点数，`resetAt` 为 RFC3339 重置时间，客户端按实际下发的条目渲染；`extraUsage`（可空）是按量付费钱包：`{ balanceCents, totalCents, monthlyChargeLimitEnabled, monthlyChargeLimitCents, monthlyUsedCents, currency }`。

### `GET /api/v1/oauth/userinfo`

托管账号的资料，带内 `kind: "error"` 约定与 `GET /api/v1/oauth/usage` 相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ kind: "ok", userInfo }` 或 `{ kind: "error", message, status? }`。`userInfo` 始终携带 `userId`、`nickname`、`status`、`region`、`userLevel`、`userLevelName`、`domain`、`domainName`，并可能附加 `globalId`、`bio`、`avatar`、`username`、`email`、`phone`（`{ countryCode, number }`）、`createdTime` 与 `lastLoginTime`。

### `GET /api/v1/oauth/region`

解析该客户端所属的 Kimi 区域，结果在本地推导，不经网络探测。优先取环境变量或配置固定的 OAuth host，其次是已配置的 OAuth key，再次是 `<home>/region` 中的安装渠道标记。

客户端未登录且上述输入都无法决定区域时，会根据设备时区和语言环境进行推断。成功结果缓存到 `<home>/region.json`，登录状态变化时失效；原始时区和语言环境值不会上传。信号缺失或冲突时，本次进程回退到 `mainland-cn`，但不持久化该结果，下次启动会重新判断。设置 `KIMI_CODE_REGION_MARKER=off` 可同时禁用安装渠道标记和本地推断。

成功时 `data` 为 `{ region }`，`region` 为 `mainland-cn` / `global` 之一。

## 远程控制

这组端点管理机器级的远程控制隧道（见 [远程控制指南](../guides/remote-control.md)）和账号的设备注册表。隧道状态按机器区分；设备注册表按账号区分、保存在云端，因此设备端点需要 Kimi 登录，并由服务端持会话代理到 relay——OAuth 凭据不会暴露给调用方。

### `GET /api/v1/remote-control`

返回当前隧道状态。当隧道处于关闭状态、但本机另一个存活进程持有单实例锁时，`data.conflict` 携带该持有者信息；每次读取都会重新检查锁，持有者进程退出后 `conflict` 与已存的 `error` 会一并清除。

成功时 `data` 为 `{ enabled, state, url?, device_id?, device_name?, error?, conflict? }`，其中 `state` 为 `off` / `starting` / `on` / `stopping` 之一，`conflict` 为 `{ pid, local_origin, device_id, url, started_at }`。

### `POST /api/v1/remote-control`

开启或关闭隧道。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `enabled` | body | boolean | `true` 开启隧道，`false` 关闭隧道 |

成功时 `data` 与 `GET /api/v1/remote-control` 的状态对象相同。当本机另一个存活进程持有单实例锁时，开启会失败并返回 `REMOTE_CONTROL_ALREADY_RUNNING`（40928），`details` 中携带与 `conflict` 相同结构的锁持有者信息。

### `GET /api/v1/remote-control/devices`

从云端注册表列出账号的远程控制设备。

成功时 `data` 为 `{ devices, max_devices? }`。每个设备为 `{ device_id, alias, status, platform, client_version, local_base_url, created_at, updated_at, last_remote_access_at }`，其中 `status` 为 `online` / `offline` 之一。

### `PATCH /api/v1/remote-control/devices/{id}`

重命名设备。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | path | string | 设备标识 |
| `alias` | body | string | 新的显示名称，去除首尾空白；1–50 个字符 |

名称为空或超长时，在到达云端之前即返回 `VALIDATION_FAILED`。成功时 `data` 为 `{ ok: true }`。

### `POST /api/v1/remote-control/devices/{id}/deactivate`

在云端注册表把设备置为离线。离线设备保留在列表中，且不占用套餐的设备额度；该设备下次开启远程控制时恢复在线。当目标设备是本机时，先停止本地隧道（启动中的开启会被取消）；随后请求持有本机锁完成下线，确保并发的开启无法在成功响应背后重新注册设备。持有者未在限定时间内停止时，请求以 `INTERNAL_ERROR` 失败，而不是报告成功。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | path | string | 设备标识 |

成功时 `data` 为 `{ ok: true }`。

### `DELETE /api/v1/remote-control/devices/{id}`

把设备从云端注册表移除：设备从列表中消失，仍在连接的隧道会被断开。下线只是把设备置为离线并保留在列表中；删除则把它整个移除。当目标设备是本机时，先停止本地隧道并持有本机锁完成删除，确保设备无法在成功响应背后重新注册。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | path | string | 设备标识 |

成功时 `data` 为 `{ ok: true }`。

## 配置

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/config` | 读取全局配置（密钥字段脱敏） |
| `POST /api/v1/config` | 合并式更新配置，并广播 `event.config.changed` |
| `POST /api/v1/client_configs` | 读取由 Kimi Code 服务下发的命名客户端配置 |

### `GET /api/v1/config`

返回解析后的全局配置——`config.toml` 叠加覆盖层后的生效结果。密钥已脱敏：每个供应商只报告 `has_api_key`，绝不返回存储的密钥。

成功时 `data` 为配置对象；其字段与 [顶层字段](../configuration/config-files.md#top-level-fields) 记录的顶层域一一对应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `providers` | object | 供应商 id → `{ type, base_url?, default_model?, api_key_env?, has_api_key }` 的映射 |
| `default_provider` | string | 全局默认供应商 id |
| `default_model` | string | 全局默认模型别名 |
| `models` | object | 模型别名 → 模型记录的映射 |
| `thinking` | object | Thinking 模式的默认参数 |
| `plan_mode` | boolean | Plan 模式开关 |
| `yolo` | boolean | 派生值：`default_permission_mode` 为 `yolo` 时为 `true` |
| `default_permission_mode` | string | 新会话的默认权限模式 |
| `default_plan_mode` | boolean | 新会话是否以 Plan 模式启动 |
| `permission` | object | 初始权限规则 |
| `hooks` | array | 生命周期钩子 |
| `services` | object | 内置外部服务配置 |
| `merge_all_available_skills` | boolean | 是否合并所有可用目录中的 Agent Skills |
| `extra_skill_dirs` | array | 额外的 Skill 搜索目录 |
| `loop_control` | object | Agent 循环控制参数 |
| `background` | object | 后台任务运行参数 |
| `subagent` | object | subagent 配置 |
| `secondary_model` | object | subagent 的次级模型池 |
| `experimental` | object | 实验开关 id → 是否启用 |
| `telemetry` | boolean | 是否启用匿名遥测 |
| `auto_session_title` | boolean | 是否允许客户端自动生成会话标题 |
| `mcp` | object | MCP 服务器配置 |
| `image` | object | 图像处理参数 |
| `model_catalog` | object | 模型目录来源配置 |
| `builtin_product_skills` | object | 内置产品技能开关 |
| `extra_agent_dirs` | array | 额外的 agent 配置搜索目录 |
| `read` | object | `Read` 工具的默认参数 |
| `model_overrides` | object | 按模型覆盖的配置 |
| `identity` | object | Agent 身份配置 |
| `github` | object | GitHub 集成配置 |
| `swarm` | object | Swarm 模式配置 |
| `cron` | object | 定时任务配置 |
| `token_counting` | object | Token 计算策略 |
| `operation_log` | object | Operation Log 保留上限 |
| `llm_requester` | object | LLM 请求器配置 |
| `task` | object | 任务运行时配置 |
| `database` | object | 持久化后端配置 |
| `watch` | object | 文件监听 / 热加载配置 |
| `disable_feedback_survey` | boolean | 是否关闭会话评分提示 |
| `raw` | object | 原始解析的 `config.toml` 内容，包含未建模字段 |

### `POST /api/v1/config`

合并式更新全局配置：请求体中的每个顶层域被深合并进对应域，未出现在请求体中的域保持不动。把 `yolo` 设为 `true` 是 `default_permission_mode: "yolo"` 的简写；被拒绝的补丁（值非法或持久化失败）返回 `40001` 与底层错误信息。`secondary_model` 域还接受 `null`：删除整个 `[secondary_model]` 节，使之后派生的 subagent 继承调用方当前的模型与思考强度。

每一次配置变更——经本端点成功更新、在进程外编辑 `config.toml`，或服务端内部写入（如 OAuth 登录刷新）——都会广播全局 `event.config.changed` 事件。短时间窗内的多次变更会合并为一个事件，其 `changedFields` 携带受影响的域名（camelCase 配置域，例如 `defaultModel`），`config` 携带当前完整的配置投影（与 `GET /api/v1/config` 响应同形状）。

请求体是部分配置对象。可选的 `raw` 对象可携带相同的可写 snake_case 配置域；后端校验后将其合并至对应域，不保存包装层。显式顶层字段优先于 `raw`。以下字段均为可选：

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `providers` | body | object | 供应商 id → 供应商表的映射 |
| `default_provider` | body | string | 全局默认供应商 id |
| `default_model` | body | string | 全局默认模型别名 |
| `models` | body | object | 模型别名 → 模型记录的映射 |
| `thinking` | body | object | Thinking 模式的默认参数 |
| `plan_mode` | body | boolean | Plan 模式开关 |
| `yolo` | body | boolean | `true` 映射为 `default_permission_mode: "yolo"`；`false` 被忽略 |
| `default_permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `default_plan_mode` | body | boolean | 新会话是否以 Plan 模式启动 |
| `permission` | body | object | 初始权限规则 |
| `hooks` | body | array | 生命周期钩子 |
| `services` | body | object | 内置外部服务配置 |
| `merge_all_available_skills` | body | boolean | 是否合并所有可用目录中的 Agent Skills |
| `extra_skill_dirs` | body | array | 额外的 Skill 搜索目录 |
| `loop_control` | body | object | Agent 循环控制参数 |
| `background` | body | object | 后台任务运行参数 |
| `subagent` | body | object | subagent 配置 |
| `secondary_model` | body | object 或 null | subagent 的次级模型池；`null` 删除该配置节并恢复继承调用方模型 |
| `experimental` | body | object | 实验开关 id → 是否启用 |
| `telemetry` | body | boolean | 是否启用匿名遥测 |
| `mcp` | body | object | MCP 服务器配置 |
| `image` | body | object | 图像处理参数 |
| `model_catalog` | body | object | 模型目录来源配置 |
| `builtin_product_skills` | body | object | 内置产品技能开关 |
| `extra_agent_dirs` | body | array | 额外的 agent 配置搜索目录 |
| `read` | body | object | `Read` 工具的默认参数 |
| `model_overrides` | body | object | 按模型覆盖的配置 |
| `identity` | body | object | Agent 身份配置 |
| `github` | body | object | GitHub 集成配置 |
| `swarm` | body | object | Swarm 模式配置 |
| `cron` | body | object | 定时任务配置 |
| `token_counting` | body | object | Token 计算策略 |
| `operation_log` | body | object | Operation Log 保留上限 |
| `llm_requester` | body | object | LLM 请求器配置 |
| `task` | body | object | 任务运行时配置 |
| `database` | body | object | 持久化后端配置 |
| `watch` | body | object | 文件监听 / 热加载配置 |
| `auto_session_title` | body | boolean | 是否允许客户端自动生成会话标题 |
| `disable_feedback_survey` | body | boolean | 是否关闭会话评分提示 |

上表的每个键都会被逐一枚举：未知的顶层键会以 `40001` 拒绝，而不是被静默丢弃，因此拼错的域名会被报出来，而不是返回成功。`raw` 包装层使用相同的配置域校验，不允许未知键。

成功时 `data` 为完整的更新后配置，形态与 `GET /api/v1/config` 相同。

### `POST /api/v1/client_configs`

读取由 Kimi Code 服务远程控制的命名客户端配置，例如切换模型时是否要求用户确认。服务端会从账号所在区域的 Kimi Code 服务读取，设置了 `KIMI_CODE_BASE_URL` 时则从该地址读取，并把结果规范化为该名称对应的结构。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | body | string | **必填。** 目前只注册了 `model_switch_confirm` |

成功时 `data` 为 `{ name, config }`。名称未注册或读取失败时 `config` 为 `null`，客户端回退到内置行为。读取到的值不会变成 `null`：缺失或格式错误的字段会取其关闭状态默认值，例如格式错误的 `model_switch_confirm` 会返回 `{ enable: false, rules: [] }`，而不是报错。

## 模型与供应商

这组端点管理模型配置的两半——`config.toml` 的 [供应商](../configuration/providers.md) 表与模型别名表——外加一个由服务端代理的 models.dev 目录，用于一次性导入。模型别名 id 就是配置中的别名键：通过供应商管理端点创建的别名形如 `provider_id/model`（例如 `my-provider/kimi-for-coding`），而模型别名表中的裸键（如 `turbo`）原样使用；API 中任何接收 `model_id` 的地方（包括全局 `default_model`）指的都是这个别名 id。`:{action}` 路由上不支持的动作返回 `40001`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/models` | 列出已配置的模型别名 |
| `POST /api/v1/models/{model_id}:set_default` | 设置全局默认模型 |
| `GET /api/v1/providers` | 列出供应商 |
| `POST /api/v1/providers` | 创建供应商（201） |
| `GET /api/v1/providers/{provider_id}` | 读取供应商（含已存密钥） |
| `PUT /api/v1/providers/{provider_id}` | 整体替换供应商配置 |
| `DELETE /api/v1/providers/{provider_id}` | 删除供应商（204） |
| `POST /api/v1/providers/{provider_id}:refresh` | 刷新该供应商的模型元数据 |
| `POST /api/v1/providers:{action}` | 集合级动作：`refresh` / `refresh_oauth` / `import_catalog` / `import_registry` |
| `GET /api/v1/catalog/providers` | 浏览 models.dev 目录（服务端代理） |
| `GET /api/v1/catalog/providers/{catalog_id}` | 读取目录中单个条目 |

### `GET /api/v1/models`

列出所有供应商下已配置的模型别名。

成功时 `data.items` 为 `{ provider, model, display_name?, max_context_size, capabilities?, support_efforts?, default_effort?, upgrade? }` 数组：`model` 是别名 id（供应商管理的别名为 `provider_id/model`，否则为裸键），`provider` 是所属供应商 id，`max_context_size` 是以 token 计的上下文窗口，`capabilities` / `support_efforts` / `default_effort` 描述能力标志与 Thinking 模式的 effort 支持。对于自定义 registry 模型，`upgrade` 可以包含 `{ model, migration_markdown, retirement_at? }`，用于引导用户切换到替代模型；`migration_markdown` 中的占位符已替换为模型 ID。

### `POST /api/v1/models/{model_id}:set_default`

把全局 `default_model` 设为一个已存在的别名。`model_id` 是配置中的别名键原样——裸键如 `POST /api/v1/models/turbo:set_default`；当 id 含 `/` 时需做 URL 编码，如 `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `model_id` | path | string | **必填。** 配置中的模型别名键原样；含 `/` 时需 URL 编码 |

成功时 `data` 为 `{ default_model, model }`——当前生效的别名及其目录项（形态与 `GET /api/v1/models` 的单项相同）。

- `40001`：路径中的动作后缀非法或不支持
- `40413`：不存在该 id 的模型别名

### `GET /api/v1/providers`

列出每个已配置供应商及其凭据与模型发现状态，不泄露任何密钥。这也是其他供应商端点引用的供应商条目形态。

成功时 `data.items` 为如下结构的数组：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 供应商 id |
| `type` | string | 通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `base_url` | string | API 基础 URL，如已设置 |
| `default_model` | string | 该供应商的默认模型别名，如已设置 |
| `has_api_key` | boolean | 是否已存储凭据 |
| `status` | string | 存在 API 密钥或缓存的 OAuth token 时为 `connected`，否则为 `unconfigured`（`error` 在 schema 中保留） |
| `models` | array | 该供应商的模型别名 id |

### `POST /api/v1/providers`

一次保存创建供应商及其模型别名；响应为 HTTP 201 加标准信封。当全局 `default_model` 完全未配置时（全新安装），会以新供应商的 `default_model`（或第一个模型）播种；已有默认值绝不被修改。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | body | string | **必填。** 供应商 id——字母、数字、`-`、`_` 与空格；必须以字母或数字开头 |
| `type` | body | string | **必填。** 通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | API 密钥，存储于 `config.toml` |
| `base_url` | body | string | API 基础 URL；不得包含环境变量占位符（`${...}`） |
| `default_model` | body | string | 该供应商的默认模型；必须是 `models[].model` 之一 |
| `models` | body | array | **必填。** 至少一条，不允许重复的 `model` 值；条目结构见下文 |

每个 `models[]` 条目声明一个别名，其 id 为 `id/model`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | **必填。** 上游模型名 |
| `max_context_size` | integer | **必填。** 以 token 计的上下文窗口，≥ 1 |
| `display_name` | string | 显示名 |
| `capabilities` | array | 能力标志，如 `thinking` 或 `image_in` |
| `protocol` | string | 线路协议覆盖：`anthropic`、`openai` 或 `openai_responses`；省略时按模型 ID 推断 |
| `max_output_size` | integer | 最大输出 token 数，≥ 1 |
| `support_efforts` | array | 支持的 Thinking 模式 effort 档位 |
| `adaptive_thinking` | boolean | 自适应 thinking 开关 |

成功时 `data` 为创建好的供应商条目（形态与 `GET /api/v1/providers` 的单项相同）。

- `40921`：已存在该 `id` 的供应商

### `GET /api/v1/providers/{provider_id}`

读取单个供应商。与列表路由不同，设置了密钥时响应会暴露存储的 `api_key`，以便本地编辑表单预填——暴露端口时请牢记这一点。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 供应商 id |

成功时 `data` 为供应商条目，存有密钥时附带 `api_key`。

- `40412`：供应商不存在

### `PUT /api/v1/providers/{provider_id}`

一次保存更新供应商：`type` 与模型列表被重写；省略的 `base_url` 和 `default_model` 保持不变，显式 `null` 清除对应字段，该供应商的别名按 `models` 重建——不再列出的别名从 `config.toml` 中消失，其他供应商的别名不受影响。`api_key` 是三态的：省略表示保留已存密钥，`""` 表示清除，其他值表示替换。除 `new_id` 重命名迁移外，全局默认指针绝不被修改。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 当前供应商 id |
| `new_id` | body | string | 重命名供应商；providers 键、模型别名、`default_provider`、指向旧别名的 `default_model` 以及 subagent 次级模型池都会随之迁移。id 规则与 `POST /api/v1/providers` 相同 |
| `type` | body | string | **必填。** 通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | 三态，见上文 |
| `base_url` | body | string | API 基础 URL；不得包含环境变量占位符（`${...}`） |
| `default_model` | body | string | 该供应商的默认模型；必须是 `models[].model` 之一 |
| `models` | body | array | **必填。** 至少一条，不允许重复的 `model` 值；条目结构与 `POST /api/v1/providers` 相同 |

成功时 `data` 为 `{ provider }`，即保存后的供应商条目。

- `40001`：重命名后的别名 id 会与其他供应商的别名冲突
- `40003`：供应商由 OAuth 托管——请改用 `POST /api/v1/oauth/logout` 登出
- `40412`：供应商不存在
- `40921`：`new_id` 已被占用

### `DELETE /api/v1/providers/{provider_id}`

删除供应商及其全部模型别名；subagent 次级模型池会级联清理。全局 `default_provider` / `default_model` 指针保持不动，即使它们指向被删的供应商——那是用户的设置，不由本端点代为回收。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 供应商 id |

成功时服务应答 204 且无响应体——状态行本身即表示删除成功（见 [响应信封](./server-api.md#响应信封)）。

- `40003`：供应商由 OAuth 托管——请改用 `POST /api/v1/oauth/logout` 登出
- `40412`：供应商不存在

### `POST /api/v1/providers/{provider_id}:refresh`

从上游来源重新发现单个供应商的模型元数据，并重写该供应商的别名。模型来源为静态的供应商不经任何网络调用直接报告 `unchanged`。至少一个供应商的别名或托管模型元数据发生变化时，服务会广播全局 `event.model_catalog.changed` 事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 供应商 id |

成功时 `data` 为刷新报告：`changed` 是 `{ provider_id, provider_name, added, removed }`（新增 / 移除的别名数）的数组，`unchanged` 是无差异的供应商 id 数组，`failed` 是 `{ provider, reason }` 的数组。当刷新发现 registry 移除了当前默认模型、且该模型此前声明过 `upgrade` 替代模型时，`data` 还带可选的 `retired_default`：`{ from, to, from_display_name }`——默认模型已被重定向为 `to`，仍绑定 `from` 的已打开会话也已切换到 `to`，`from_display_name` 是被移除模型的显示名，供提示使用。同一字段也会出现在 `event.model_catalog.changed` 事件中。

- `40001`：路径中的动作后缀非法或不支持
- `40412`：供应商不存在

### `POST /api/v1/providers:refresh`

刷新每个供应商的模型元数据。请求体可选且被忽略。

成功时 `data` 为与 `POST /api/v1/providers/{provider_id}:refresh` 相同的刷新报告（`changed` / `unchanged` / `failed`）。

### `POST /api/v1/providers:refresh_oauth`

与 `POST /api/v1/providers:refresh` 相同的刷新，仅限 OAuth 凭据的供应商。请求体可选且被忽略。

成功时 `data` 为刷新报告（`changed` / `unchanged` / `failed`）。

### `POST /api/v1/providers:import_catalog`

把一个 models.dev 目录条目导入为已配置供应商；响应为 HTTP 201 加标准信封。通信协议与端点来自目录解析，目录中的每个模型都写为一个别名。导入已存在的 id 等同于刷新——供应商条目及其别名按目录重写，省略 `api_key` 表示保留已存密钥。全局默认指针绝不被修改，仅在完全未配置默认模型时，以第一个导入的模型播种 `default_model`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `catalog_id` | body | string | **必填。** 来自 `GET /api/v1/catalog/providers` 的目录条目 id |
| `id` | body | string | 覆盖目录 id 作为本地供应商 id。id 规则与 `POST /api/v1/providers` 相同 |
| `api_key` | body | string | 导入供应商的 API 密钥 |
| `base_url` | body | string | 覆盖目录解析出的端点；条目的 `needs_base_url` 为 `true` 时必填 |

成功时 `data` 为 `{ provider, models_imported }`——供应商条目与写入的别名数量。

- `40001`：缺少 `catalog_id` 或其他请求体校验失败
- `40003`：目标供应商已存在且由 OAuth 托管
- `40004`：条目无法导入（被拒绝、要求 `base_url`、没有可导入的模型，或其 id 不能用作供应商 id）
- `40417`：不存在该 `catalog_id` 的目录条目
- `50004`：models.dev 目录不可用

### `POST /api/v1/providers:import_registry`

把一个 models.dev 形态的私有注册表——一个 `api.json` URL 加可选的 Bearer key——导入为已配置供应商；响应为 HTTP 201 加标准信封。每个列出的供应商都带 `source` 记录写入，以便定时刷新重新发现。重复导入同一 URL 会移除上游已消失的供应商——URL 是注册表的稳定身份，因此轮换 key 是安全的。全局默认指针遵循与 `:import_catalog` 相同的规则。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `url` | body | string | **必填。** 注册表 `api.json` 的 URL |
| `api_key` | body | string | 注册表的 Bearer key；省略时复用上一次导入同一 URL 所用的 key |

成功时 `data` 为 `{ providers, models_imported }`——供应商条目数组与写入的别名总数。

- `40001`：缺少 `url` 或其他请求体校验失败
- `40003`：某个列出的供应商已存在且由 OAuth 托管
- `40005`：注册表无法获取或解析，或未列出可导入的供应商

### `GET /api/v1/catalog/providers`

浏览 models.dev 目录，由服务端代理，带 10 分钟内存缓存与内置快照兜底。条目保持上游目录顺序。服务无法导入的条目携带 `rejected: true` 与机器可读的 `reject_reason`；`needs_base_url: true` 的条目在导入时要求提供 base URL。

成功时 `data.items` 为 `{ id, name, wire_type, base_url, guessed, needs_base_url, rejected, reject_reason, env_key, models }` 数组：`wire_type` 是解析出的协议（可空，枚举与供应商 `type` 相同），`base_url` 是解析出的端点（可空；`needs_base_url` 或被拒绝的条目为 null），`guessed` 标记启发式解析，`env_key` 是上游约定的 API 密钥环境变量（可空），`models` 是 `{ id, name?, max_context_size, capabilities?, reasoning }` 的数组。

- `50004`：目录不可用（在线拉取与内置快照均失败）

### `GET /api/v1/catalog/providers/{catalog_id}`

按 catalog id 读取单个 models.dev 目录条目——条目形态与 `GET /api/v1/catalog/providers` 相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `catalog_id` | path | string | **必填。** 目录条目 id |

成功时 `data` 为该目录条目（形态与 `GET /api/v1/catalog/providers` 的单项相同）。

- `40417`：不存在该 `catalog_id` 的目录条目
- `50004`：目录不可用

## 技能、工具与 MCP

这组端点暴露会话或工作区可见的技能目录、当前生效 agent 的工具列表及其 MCP 服务。技能激活与 MCP 重启使用 `:{action}` 约定；激活即斜杠命令 `/<skill>` 的 REST 等价形式。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | 会话级技能目录 |
| `GET /api/v1/workspaces/{workspace_id}/skills` | 无会话的工作区技能目录 |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | 激活技能（开启一个轮次） |
| `GET /api/v1/tools` | 列出当前生效 agent 的工具 |
| `GET /api/v1/mcp/servers` | 列出 MCP 服务 |
| `POST /api/v1/mcp/servers/{mcp_server_id}:restart` | 重启 MCP 服务 |

### `GET /api/v1/sessions/{session_id}/skills`

列出单个会话可用的技能，按会话的优先级合并所有来源（内置、插件、extra、用户、项目）。会话处于冷态时，读取目录会恢复该会话。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时 `data` 为 `{ skills }`，每项是一个技能描述符 `{ name, description, path, source, workspace_dir?, type?, disable_model_invocation? }`：`source` 为 `project` / `user` / `extra` / `builtin`；`type` 标识技能类别（只有用户可激活的类型才能被激活）；`disable_model_invocation` 会让技能对模型不可见。`workspace_dir` 是项目级技能的根目录，其他来源省略该字段。同名技能可以以不同 `path` 作为多个变体返回。

- `40401`：会话不存在（或未激活）

### `GET /api/v1/workspaces/{workspace_id}/skills`

列出该工作区中的会话将看到的技能目录，但不创建或恢复会话——即针对工作区根目录计算出的同一套内置、插件、extra、用户、项目来源合并结果。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 已注册工作区 id |

成功时 `data` 为 `{ skills }`，技能描述符见上文 `GET /api/v1/sessions/{session_id}/skills` 的说明。

- `40410`：工作区不存在

### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

在会话中激活技能——即斜杠命令 `/<skill>` 的 REST 等价形式——以技能内容加上 `args` 与附件在 main agent 上开启一个轮次。该端点经单一路由 `POST /api/v1/sessions/{session_id}/skills/{tail}` 分发：尾部按 `{skill_name}:{action}` 解析，`activate` 是唯一动作；只给名称或动作未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `skill_name` | path | string | **必填。** 要激活的技能名 |
| `path` | body | string | 可选。会话技能目录中某个 `SKILL.md` 的精确路径，用于选择同名变体；必须与目录返回的条目匹配 |
| `args` | body | string | 传给技能的自由文本参数，相当于斜杠命令后的文本 |
| `attachments` | body | array | 随激活携带的媒体块。`image` / `video` 块带 `source` 对象（`kind` 为 `url` / `base64` / `file` / `session_media`，与提示词内容块同形）；`file` 块带顶层 `file_id`、`name`、`media_type`、`size` |

成功时 `data` 为 `{ activated: true, skill_name }`。

- `40001`：校验失败或动作后缀不支持
- `40401`：会话不存在（或未激活）
- `40407`：引用的附件文件不存在
- `40415`：没有该名称的技能
- `40912`：技能存在，但其类型不允许用户激活

### `GET /api/v1/tools`

列出当前生效 agent 的工具——即 `session_id` 指定会话的 main agent；省略参数时取最近创建的会话。若该会话不在本服务进程中存活，列表为空。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | query | string | 要查看其 main agent 的会话。默认最近创建的会话 |

成功时 `data` 为 `{ tools }`，每项为 `{ name, description, input_schema, source, mcp_server_id?, active? }`：`source` 为 `builtin` / `skill` / `mcp`；`mcp_server_id` 仅 MCP 工具携带（从 `mcp__<server>__<tool>` 名称解析）；`active` 报告工具策略的判定结果。`input_schema` 目前恒为 `null`。

### `GET /api/v1/mcp/servers`

列出当前生效 agent 配置的 MCP 服务（与 `GET /api/v1/tools` 相同，取最近创建的存活会话的 main agent）。没有存活会话时列表为空。

成功时 `data` 为 `{ servers }`，每项为 `{ id, name, transport, status, last_error?, tool_count }`：`transport` 为 `stdio` / `http` / `sse`；`status` 为 `connected` / `connecting` / `disconnected` / `error`；服务处于 `error` 时 `last_error` 携带失败信息。

### `POST /api/v1/mcp/servers/{mcp_server_id}:restart`

重新连接当前生效 agent 的某个 MCP 服务。该端点经 `POST /api/v1/mcp/servers/{tail}` 分发，`restart` 是唯一动作——只给服务 id 或动作未知时返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `mcp_server_id` | path | string | **必填。** MCP 服务 id（即其配置名称） |

成功时 `data` 为 `{ restarting: true }`。

- `40001`：缺少动作后缀或动作未知
- `40408`：没有该 id 的 MCP 服务（无存活会话时同样返回此错误）

## 能力与插件

能力是带有分层就绪状态的内置特性——由检测步骤加后台安装组成；当前版本注册了 `kimi-cu`（Kimi Computer Use）与 `kimi-webbridge`（Kimi Browser Extension）。插件是已安装的技能、MCP 服务、hook 与命令的打包集合。这组端点报告能力状态、驱动能力安装，并管理插件从市场列表到移除的整个生命周期。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/capabilities` | 列出内置能力及其就绪状态 |
| `GET /api/v1/capabilities/{capability_id}` | 读取单个能力的状态 |
| `POST /api/v1/capabilities/{capability_id}:install` | 开始安装能力（后台进行，轮询 GET 查看进度） |
| `GET /api/v1/plugins` | 列出已安装插件 |
| `POST /api/v1/plugins` | 从本地路径、zip URL 或 GitHub 仓库安装插件 |
| `GET /api/v1/plugins/marketplace` | 插件市场目录，合并实时安装状态 |
| `POST /api/v1/plugins/{plugin_id}:{action}` | 插件动作：`enable` / `disable` / `remove` |

### `GET /api/v1/capabilities`

列出所有已注册能力及其就绪状态。

成功时 `data` 为 `{ capabilities }`，每项是一个能力状态对象 `{ id, pluginId?, displayName, description, supported, state, version?, steps, install }`。`state` 为 `ready`（所有必需检测步骤均为 `ok`）/ `partial`（部分步骤 `ok`）/ `not_installed` / `unsupported`（当前平台/架构不可用）；`steps` 以 `{ id, state, detail?, optional? }` 列出各检测步骤，其 `state` 为 `ok` / `missing` / `failed` 之一；`install` 为安装进度 `{ running, step?, percent?, error?, note? }`，其中 `percent` 取值 0 到 100。

### `GET /api/v1/capabilities/{capability_id}`

读取单个能力的就绪状态——即 `:install` 动作的轮询对应端点。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `capability_id` | path | string | **必填。** 能力 id |

成功时 `data` 为上文 `GET /api/v1/capabilities` 说明的能力状态对象。

- `40418`：没有该 id 的能力

### `POST /api/v1/capabilities/{capability_id}:install`

在后台开始安装能力并立即返回当前状态（`install.running` 为 `true`）；轮询 `GET /api/v1/capabilities/{capability_id}` 查看进度。该端点经 `POST /api/v1/capabilities/{tail}` 分发，`install` 是唯一动作——只给 id 或动作未知时返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `capability_id` | path | string | **必填。** 能力 id |

成功时 `data` 为上文 `GET /api/v1/capabilities` 说明的能力状态对象。

- `40001`：缺少动作后缀或动作未知
- `40418`：没有该 id 的能力
- `40924`：该能力的安装已在进行中
- `40925`：当前平台/架构不支持该能力

### `GET /api/v1/plugins`

列出已安装插件。

成功时 `data` 为 `{ plugins }`，每项为 `{ id, displayName, version?, enabled, state, skillCount, mcpServerCount, enabledMcpServerCount, hookCount, commandCount, hasErrors, source, originalSource?, github? }`：`state` 为 `ok` / `error`（加载失败也会置 `hasErrors`）；`source` 为 `local-path` / `zip-url` / `github`；GitHub 来源的插件由 `github` 携带来源信息 `{ owner, repo, ref, installedSha? }`，其中 `ref` 为 `{ kind: branch|tag|sha, value }`。

### `POST /api/v1/plugins`

安装插件并返回其摘要。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `source` | body | string | **必填。** 安装来源：本地绝对路径、指向 zip 压缩包的 `http(s)` URL，或 GitHub URL——`https://github.com/<owner>/<repo>`，可选地用 `/tree/<branch-or-sha>`、`/releases/tag/<tag>` 或 `/commit/<sha>` 锁定版本 |

成功时 `data` 为上文 `GET /api/v1/plugins` 说明的插件摘要。

- `40001`：校验失败——例如 `source` 既不是 URL 也不是绝对路径，或插件加载失败
- `40409`：本地路径不存在

### `GET /api/v1/plugins/marketplace`

列出插件市场目录并合并实时安装状态。目录按请求从配置的市场 URL 拉取（超时 10 秒）；使用默认目录时，目录中缺少的内置能力会作为条目合并进来（带 `capabilityId`），而当前平台不支持的能力对应条目会被剔除。

成功时 `data` 为 `{ entries }`，每项为 `{ id, tier, classification?, displayName, description?, cliDescription?, homepage?, keywords?, version?, source, iconUrl?, sha256sum?, filename?, platforms?, defaultLocale?, locale?, billing?, installed?, updateAvailable?, capabilityId? }`：`tier` 为 `official` / `curated` / `third-party`，`classification` 为 `official` / `third_party`；插件已安装时 `installed` 为 `{ version?, enabled }`；`updateAvailable` 标记目录版本新于已安装版本的条目。条目的 `source` 即 `POST /api/v1/plugins` 的 `source` 字段取值；`defaultLocale` 声明 `description`/`cliDescription` 的语言，`locale` 存放各语言文案。

返回前会按宿主过滤：条目的 `clients` 必须包含 `cli`（或省略），`platforms` 必须包含本守护进程的平台（或只含 `cloud`），否则该行不会出现。同一次目录读取会写入 `$KIMI_CODE_HOME/plugins/availability.json`，已安装列表据此隐藏那些目录条目已不再面向本机的插件。

本页其它位置的插件摘要同样带有 `origin`（`marketplace` / `custom` / `unknown`）与可选的 `catalogId`。

- `50001`：市场不可达或返回了非法目录

### `POST /api/v1/plugins/{plugin_id}:enable`

启用一个已安装插件。插件动作经单一路由 `POST /api/v1/plugins/{tail}` 分发：尾部按 `{plugin_id}:{action}` 解析，动作为 `enable` / `disable` / `remove`；只给 id 或动作未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **必填。** 已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

### `POST /api/v1/plugins/{plugin_id}:disable`

停用一个已安装插件但不移除它；分发约定同上文 `:enable`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **必填。** 已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

### `POST /api/v1/plugins/{plugin_id}:remove`

移除一个已安装插件；分发约定同上文 `:enable`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **必填。** 已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

## 工作区

工作区是已注册的项目目录，会话都落在其中。这组端点管理注册表——列出、注册、重命名、注销——以及控制项目级 MCP 配置是否加载的每工作区信任状态。所有返回工作区的端点都使用 [workspace 对象](#workspace-对象) 中统一说明的传输结构。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/workspaces` | 列出已注册工作区 |
| `POST /api/v1/workspaces` | 注册工作区（按根路径幂等） |
| `PATCH /api/v1/workspaces/{workspace_id}` | 重命名 |
| `DELETE /api/v1/workspaces/{workspace_id}` | 注销（保留磁盘内容） |
| `GET /api/v1/workspaces/{workspace_id}/trust` | 读取信任状态 |
| `POST /api/v1/workspaces/{workspace_id}/trust` | 授予信任 |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | 撤销信任 |
| `POST /api/v1/workspaces/{workspace_id}/add-dir` | 添加附加目录 |

### workspace 对象

所有返回工作区的端点都使用此传输结构。注册与重命名会广播全局事件 `event.workspace.created` / `event.workspace.updated`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 工作区 id：由根路径派生的 `wd_<slug>_<hash12>` 字符串，或托管工作区的 `wm_<uuid>` 字符串 |
| `root` | string | 项目目录的绝对路径 |
| `name` | string | 显示名，1–100 个字符；默认取根目录的基名 |
| `kind` | string | `managed` 表示显式创建的工作区，`implicit` 表示在其中有会话时自动注册的工作区 |
| `additional_dirs` | string[] | 与根目录并列注册的源文件夹 |
| `created_at` | string | 注册时间，ISO 8601 |
| `last_opened_at` | string | 最近一次打开或重新注册工作区的时间，ISO 8601 |
| `session_count` | integer | 工作区内的会话数 |

### `GET /api/v1/workspaces`

列出所有已注册工作区。

成功时 `data` 为 `{ items }`，每项是一个 [workspace 对象](#workspace-对象)。

### `POST /api/v1/workspaces`

注册工作区并返回它。注册按根路径幂等：重复注册同一根路径会返回已存在的工作区，仅刷新 `last_opened_at`（保留已存名称），并广播 `event.workspace.updated` 而非 `event.workspace.created`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `root` | body | string | **必填。** 已存在目录的绝对路径 |
| `name` | body | string | 显示名，1–100 个字符。默认根目录的基名 |
| `additional_dirs` | body | string[] | 与根目录并列注册的源文件夹，最多 64 项。相对路径从 `root` 解析 |
| `idempotency_key` | body | string | 重试键，1–200 个字符。相同键的重复请求返回同一个工作区，重启后依然如此 |

提供 `additional_dirs` 或 `idempotency_key` 时创建的是托管工作区（`wm_<uuid>` id，`kind: managed`），而不是隐式注册根目录，因此调用方可以让多个工作区共用同一个目录作为根。

成功时 `data` 为 [workspace 对象](#workspace-对象)。

- `40001`：`root` 缺失或不是绝对路径（`details` 会列出该字段）
- `40006`：`additional_dirs` 自身重复或指向根目录；`msg` 为 `Duplicate source folder: <实际路径>`，`details` 为 `[{ "path": "additional_dirs.N", "directory": "<解析后的绝对路径>" }]`
- `40409`：`root` 不存在或不是目录

### `PATCH /api/v1/workspaces/{workspace_id}`

重命名工作区——仅修改显示名，根路径不变。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |
| `name` | body | string | **必填。** 新的显示名，1–100 个字符 |

成功时 `data` 为 [workspace 对象](#workspace-对象)。

- `40001`：校验失败（`details` 逐字段说明）
- `40410`：工作区不存在

### `DELETE /api/v1/workspaces/{workspace_id}`

注销工作区。只移除注册表条目——磁盘上的目录不受影响。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ deleted: true }`。

- `40410`：工作区不存在

### `GET /api/v1/workspaces/{workspace_id}/trust`

读取工作区信任状态。信任状态决定是否为该工作区加载项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ trusted }`。

- `40410`：工作区不存在

### `POST /api/v1/workspaces/{workspace_id}/trust`

将工作区标记为信任，并加载其项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ trusted: true }`。

- `40410`：工作区不存在

### `POST /api/v1/workspaces/{workspace_id}/untrust`

撤销与当前目录集关联的持久化工作区信任记录。如果进程或配置覆盖没有使工作区保持受信任，则同时卸载其项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ trusted }`，表示撤销后的有效信任状态。通常为 `{ trusted: false }`；如果 `KIMI_CODE_TRUST_WORKSPACE` 或 [`[workspace] require_trust = false`](../configuration/config-files.md#workspace-trust) 生效，则仍为 `true`。

- `40410`：工作区不存在

### `POST /api/v1/workspaces/{workspace_id}/add-dir`

为工作区添加附加目录，语义与 CLI `--add-dir` 及 TUI `/add-dir` 一致。路径支持绝对路径、相对路径（相对工作区根目录解析）与 `~` 展开。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |
| `path` | body | string | **必填。** 要添加的目录 |
| `persist` | body | boolean | 缺省 `true`：将目录写入工作区 registry，后续会话会自动复用，并同步写入 `<项目根>/.kimi-code/local.toml` 的 `workspace.additional_dir`；为 `false` 时仅加入内存中的临时集合（同一工作区所有会话共享），不写盘 |

成功时 `data` 为 `{ project_root, config_path, additional_dirs, persisted }`，其中 `additional_dirs` 是全部附加目录（含既有目录），`persisted` 表示本次是否写盘。

- `40001`：校验失败（`details` 逐字段说明），或项目本地配置损坏等引擎校验错误
- `40409`：`path` 不存在或不是目录
- `40410`：工作区不存在

## 文件上传

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/files` | multipart 上传（字段 `file`，可选 `name`、`expires_in_sec`），返回文件元信息 |
| `GET /api/v1/files/{file_id}` | 下载（二进制，错误用真实 HTTP 状态码） |
| `DELETE /api/v1/files/{file_id}` | 删除 |

### `POST /api/v1/files`

以 `multipart/form-data` 上传文件，供后续引用（例如作为提示词附件）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file` | body | binary | **必填。** multipart 的文件部分 |
| `name` | body | string | 存储的显示名。默认上传文件名 |
| `expires_in_sec` | body | number | 文件过期前的秒数（非负）。默认永不过期 |

成功时 `data` 为文件元信息 `{ id, name, media_type, size, created_at, expires_at? }`，其中 `media_type` 取自上传的内容类型。

- `40001`：multipart 请求体缺少 `file` 字段

### `GET /api/v1/files/{file_id}`

下载已上传的文件。响应为二进制流，支持 Range 请求但不处理 `If-None-Match`；失败使用真实 HTTP 状态码——见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file_id` | path | string | **必填。** 上传响应返回的文件 id |

- `40407`（HTTP 404）：没有该 id 的文件（包括已过期的文件）

### `DELETE /api/v1/files/{file_id}`

删除已上传的文件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file_id` | path | string | **必填。** 上传响应返回的文件 id |

成功时 `data` 为 `{ deleted: true }`。

- `40407`（HTTP 404）：没有该 id 的文件

## GUI 存储

由服务端支撑的键值存储，接口对齐浏览器的 `localStorage`，持久化在服务的 home 目录下；web UI 用它保存跨客户端的 UI 状态。值是不透明字符串——序列化由调用方负责。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/gui/store/length` | 已存键的数量 |
| `GET /api/v1/gui/store/getItem` | 按键读取值 |
| `POST /api/v1/gui/store/setItem` | 按键写入值 |
| `POST /api/v1/gui/store/removeItem` | 按键删除值 |
| `POST /api/v1/gui/store/clear` | 删除所有值 |

### `GET /api/v1/gui/store/length`

返回已存键的数量（对齐 `localStorage.length`）。无参数。

成功时 `data` 为 `{ length }`。

### `GET /api/v1/gui/store/getItem`

读取一个值（对齐 `localStorage.getItem`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | query | string | **必填。** 要读取的键，1–256 个字符 |

成功时 `data` 为 `{ value }`——已存字符串，键不存在时为 `null`。

### `POST /api/v1/gui/store/setItem`

写入一个值（对齐 `localStorage.setItem`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | body | string | **必填。** 要写入的键，1–256 个字符 |
| `value` | body | string | **必填。** 要存储的值 |

成功时 `data` 为 `null`。

### `POST /api/v1/gui/store/removeItem`

删除一个值（对齐 `localStorage.removeItem`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | body | string | **必填。** 要删除的键，1–256 个字符 |

成功时 `data` 为 `null`。

### `POST /api/v1/gui/store/clear`

删除所有已存值（对齐 `localStorage.clear`）。无参数。

成功时 `data` 为 `null`。

## 全局搜索与其他

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/search` | 跨会话全文搜索，`mode` 为 `terms`（默认）或 `literal`（精确子串），`page_token` 分页 |
| `GET /api/v1/connections` | 列出当前在线的 WebSocket 连接 |
| `GET /api/v1/sessions` | 按工作区分组的会话列表，见下文 |
| `POST /api/v1/sessions:archive` | 批量归档会话，见下文 |
| `POST /api/v1/sessions:restore` | 批量恢复已归档会话，见下文 |
| `/api/v1/mcp/*` | 统一的 MCP 管理面，见下文 |
| `/api/v1/debug/*` | 反射式调试 RPC，仅 `--debug-endpoints` 且 loopback 时挂载，不属于稳定协议 |

### `POST /api/v1/search`

跨会话全文搜索，覆盖 User 消息、Assistant 回复与会话标题，由服务端的持久搜索索引支撑。当 `container.session_id` 指向本服务进程中存活的会话时，搜索改为直接扫描该会话的内存转录，响应的 `source` 字段（`index` 或 `live`）会报告本页结果由哪条路径提供。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `query` | body | string | **必填。** 搜索文本 |
| `mode` | body | string | `terms`（默认）/ `literal` |
| `op` | body | string | `terms` 模式下的词项组合符：`AND`（默认）/ `OR` |
| `container` | body | object | 将搜索限定在 `{ session_id?, agent_id? }` |
| `role` | body | string | 限定 `user` / `assistant` / `title` 命中 |
| `start_time` | body | integer | 只看不早于该时间的命中（epoch 毫秒） |
| `end_time` | body | integer | 只看不晚于该时间的命中（epoch 毫秒） |
| `sort` | body | string | `score`（默认）/ `time_desc` / `time_asc`；`literal` 模式忽略此参数，始终最新在前 |
| `page_size` | body | integer | 每页命中数，1–50。默认 `20` |
| `page_token` | body | string | 上一页响应返回的令牌 |

`terms` 模式下查询会被分词（ASCII 词加 CJK n-gram）、去重，并以至多 32 个词项匹配倒排索引；`literal` 模式是零误报的精确子串搜索。成功时 `data` 为 `{ items, has_more, page_token?, index_state, source }`，每项为 `{ session_id, workspace_id, session_title, agent_id, role, snippet, time, turn?, step_id?, score }`。`index_state` 为 `{ state, indexed_sessions, total_sessions, documents, stale?, degraded? }`，其中 `state` 为 `building` / `ready` / `readonly` 之一；`stale` 标记仍在追赶的落后视图，`degraded` 携带最近一次刷新失败的信息。超出预算的页会额外携带 `incomplete`，取值为 `candidate_cap` / `postings_budget` / `deadline` 之一。分页令牌锁定索引代际与查询条件——索引重建或查询变更会使其失效。

- `40001`：请求体校验失败、查询不可用（为空或超过 32 个词项），或分页令牌非法

### `GET /api/v1/connections`

列出当前连接到本服务的 WebSocket 客户端，按连接时间最早在前。无参数。

成功时 `data` 为 `{ connections }`，每项为 `{ id, connected_at, remote_address, user_agent, has_client_hello, subscriptions }`：`connected_at` 为 ISO 8601 时间戳；`remote_address` 与 `user_agent` 未知时为 `null`；`has_client_hello` 报告客户端是否已发送握手帧；`subscriptions` 列出该连接订阅的会话 id。

## `GET /api/v1/sessions`

## `GET /api/v1/sessions`

会话列表，支持过滤、排序、按工作区分组、git 元数据和 id 投影。精确的请求与响应 schema 见 `/openapi.json`。

| 参数 | 说明 |
| --- | --- |
| `workspace_id` | 按工作区 id 过滤，可重复（OR） |
| `archived` | `false`（默认）/ `true` / `all` |
| `has_prompt` | `true` 只保留有用户 prompt 的会话，`false` 只保留空会话 |
| `busy` | `true` / `false`；按实时 busy 标记过滤 |
| `activity` | `idle` / `turn` / `background`，可重复（OR） |
| `updated_after` / `updated_before` | ISO 8601 时间戳；两端均为闭区间 |
| `sort` | `updated_at_desc`（默认）/ `updated_at_asc` / `created_at_desc` |
| `view` | `flat`（默认）/ `by_workspace` |
| `group_page_size` | `view=by_workspace` 时每组返回的会话数：1–10000，默认 5 |
| `include` | 逗号分隔的附加字段组；目前仅 `git`（分支与 PR，按环境与 cwd 缓存） |
| `fields` | 逗号分隔的投影；仅 `id,archived`；把 page_size 上限放宽到 10000；不可与 `include=git` 同传 |
| `page_size` | 1–100（默认 50）；`fields=id,archived` 时 10000；`view=by_workspace` 时按组计数 |
| `page_token` / `page` / `before_id` / `after_id` | 翻页；同一时间只能用一种（否则 `40001`）；分组视图下拒绝 `before_id`/`after_id` |
| `include_archive` / `archived_only` / `exclude_empty` | 兼容别名：`archived=all` / `archived=true` / `has_prompt=true` |
| `hosts` | `include` 合并所有 SSH 主机上应用创建的会话；不可用主机会列在 `unavailable_hosts` |

扁平页为 `{ items, total, has_more, next_page_token? }`。每项是完整的会话记录：`id`、`workspace_id`、`cwd`、`title`、`created_at`/`updated_at`（ISO 8601）、`busy`、`activity`、`pending_interaction`、`last_turn_reason`/`last_turn_outcome`、`archived`/`archived_at`、`last_prompt`、`metadata`（含 `cwd` 与自定义键）、`agent_config`、`usage`、`permission_rules`、`message_count`，请求 `include=git` 时再加 `git`。`fields=id,archived` 时每项为 `{ id, archived, host_id? }`。

`view=by_workspace` 返回 `{ groups: [{ workspace_id, sessions, total, host_id? }], total, has_more, next_page_token? }`；每组的 `total` 是该工作区匹配过滤条件的完整会话数。翻页令牌绑定查询指纹，包含 `view` 与分组参数；中途修改返回 `40922`。`page` 是无状态替代，每次返回独立快照，不签发令牌。

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "groups": [
      {
        "workspace_id": "wd_my-app_a1b2c3d4e5f6",
        "sessions": [
          {
            "id": "session_...",
            "workspace_id": "wd_my-app_a1b2c3d4e5f6",
            "cwd": "/Users/dev/my-app",
            "title": "Fix the login page",
            "created_at": "2026-11-20T08:00:00.000Z",
            "updated_at": "2026-11-20T08:05:00.000Z",
            "busy": false,
            "activity": "idle",
            "pending_interaction": "none",
            "archived": false,
            "last_prompt": "adjust the button spacing",
            "metadata": { "cwd": "/Users/dev/my-app" },
            "agent_config": { "model": "kimi-for-coding" },
            "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_creation_tokens": 0, "context_tokens": 0 },
            "permission_rules": [],
            "message_count": 3
          }
        ],
        "total": 42
      }
    ],
    "total": 1,
    "has_more": false
  },
  "request_id": "req_..."
}
```

已删除工作区的会话会被隐藏；不可见的 workspace id 会让整个请求以 `40410` 拒绝。

## `POST /api/v1/sessions:archive` 与 `POST /api/v1/sessions:restore`

面向会话管理页的批量归档/恢复。请求体为 `{ "ids": ["session_..."] }`——非空、去重后不超过 5000 条。仍在线的会话走完整生命周期；未加载的冷会话直接改写磁盘上的元数据，不会被加载。

只有请求体校验失败才会让整个请求失败（`40001`）；其余情况按条返回：`data.results` 保持输入顺序，每项为 `{ id, ok }` 或 `{ id, ok: false, error }`（不存在的 id 在自身条目里报 `40401`），并附 `succeeded` / `failed` 计数。

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "results": [
      { "id": "session_a", "ok": true },
      { "id": "session_b", "ok": false, "error": { "code": 40401, "message": "session session_b does not exist" } }
    ],
    "succeeded": 1,
    "failed": 1
  },
  "request_id": "req_..."
}
```

## MCP 管理（`/api/v1/mcp`）

`/api/v1/mcp/*` 路由是服务的统一 MCP 管理面：独立于任何会话，直接管理 MCP server 注册表本身——全局（用户级）CRUD 与逐条校验、连接测试探测、locator 寻址的检查目录、按 server 的授权状态列表，以及完整的 OAuth 流程生命周期。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/mcp/servers` | 列出所有已知 MCP server |
| `GET /api/v1/mcp/servers/{name}` | 按运行时名称获取单个 server |
| `POST /api/v1/mcp/servers` | 向用户级 `mcp.json` 添加 server |
| `PUT /api/v1/mcp/servers/{name}` | 替换一个用户级条目 |
| `DELETE /api/v1/mcp/servers/{name}` | 删除一个用户级条目 |
| `POST /api/v1/mcp/servers:test` | 对单个 server 发起真实连接探测 |
| `POST /api/v1/mcp/servers:inspect` | locator 寻址的目录及批量连接探测 |
| `GET /api/v1/mcp/auth-statuses` | 目录中各 server 的 OAuth 状态 |
| `POST /api/v1/mcp/auth:begin` | 开始一次交互式 OAuth 流程 |
| `POST /api/v1/mcp/auth:complete` | 等待浏览器回调并完成 code 交换 |
| `POST /api/v1/mcp/auth:cancel` | 终止已开始的 OAuth 流程 |
| `POST /api/v1/mcp/auth:reset` | 清除某个 server 已存储的凭据 |

该管理面有两种寻址方式。CRUD 路由与 `servers:test` 使用普通的运行时 `name`；检查与 OAuth 路由使用 **locator**——文件层条目用 `{ "source": "global", "name" }`，插件清单条目用 `{ "source": "plugin", "pluginId", "serverName" }`——因为插件条目和文件条目可能共用同一个运行时名称。检查条目还带有一个稳定的 `serverId` 线上标识：`global:<name>` 或 `plugin:<pluginId>:<serverName>`（URL 编码）。

大多数路由接受可选的 `cwd`（查询参数，`:`-action 路由则为请求体字段）。不传时目录只覆盖用户级文件与插件清单；传入后，该目录的项目根层与项目本地层会并入——但仅当工作区受信任时，否则项目层会被跳过。对 stdio server 执行 `servers:test` 时，`cwd` 同时是子进程的工作目录。连接探测与 OAuth 调用会等待服务配置加载完成后再执行。

### `GET /api/v1/mcp/servers` 与 `GET /api/v1/mcp/servers/{name}`

列出管理面已知的全部 MCP server；第二个路由返回该运行时名称对应的单个条目。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | path | string | **必填（仅 get）。** server 的运行时名称 |
| `cwd` | query | string | 并入该（受信任）目录的项目层 |

成功时 `data` 是受管 server 数组（get 路由为单个对象），每项为 `{ name, config, source, origin, mutable, plugin? }`：

- `source`：`global`（配置文件层）或 `plugin`（插件清单）
- `origin`：条目的定义位置——文件路径或插件 id
- `mutable`：只有用户级条目可变；插件与项目层条目均为只读
- `config`：可变条目携带完整配置，便于编辑界面预填；只读条目被脱敏为排序后的键名列表（`envKeys` / `headerKeys`），绝不泄露密钥值
- `plugin`：`{ id, name }`，仅插件条目携带

- `40001`：校验失败
- `40408`：不存在该名称的 server

### `POST` / `PUT` / `DELETE /api/v1/mcp/servers`

针对用户级 `mcp.json` 的全局 CRUD。新增请求体是包含 `name` 的完整 server 配置——`transport`（`stdio` / `http` / `sse`）决定配置形状，每条配置写入前都会校验。更新请求体携带同样的配置但不含 `name`（由路径指定条目）；删除无请求体。三者都在 `data` 中返回刷新后的 server 列表。若写入与项目层的同名条目冲突，会因只读被拒绝——请改为编辑定义它的文件；与同名的插件条目冲突并不阻止写入，新的文件条目会将其遮蔽。

- `40001`：校验失败，或目标条目为只读
- `40408`：（更新/删除）不存在该名称的 server

### `POST /api/v1/mcp/servers:test`

对单个 server 发起真实连接探测，不持久化任何内容。传 `name` 探测注册表条目（含插件与受信任的项目层），或传 `server`（包含 `name` 的完整内联配置）按原样探测；两者都传或都不传会报 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | body | string | 注册表条目的运行时名称 |
| `server` | body | object | 按原样探测的内联 server 配置 |
| `cwd` | body | string | 项目层并入解析；同时是 stdio 的工作目录 |

成功时 `data` 为 `{ success, output }`：连接成功时 `output` 列出该 server 的可用工具，否则携带失败信息。

- `40001`：两种目标形式都传或都不传、内联配置无效，或运行时名称被多个启用的 server 共用
- `40408`：不存在该名称的 server

### `POST /api/v1/mcp/servers:inspect`

locator 寻址的目录（脱敏配置），外加对每个 OAuth 候选的批量真实连接探测。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `targets` | body | array | 缩小目录范围的 locator 数组；不传则检查全部 server |
| `cwd` | body | string | 并入该（受信任）目录的项目层 |

成功时 `data` 是检查结果数组，每项为 `{ serverId, locator, runtimeName, canonicalUrl?, origin, config, enabled, editable, authStatus, checkedAt?, error? }`：`canonicalUrl` 是远程 server 的凭据 URL，`config` 为脱敏视图，`authStatus` 取值为 `not-applicable` / `bearer-token` / `oauth-required` / `oauth-authorized` / `oauth-expired` / `unavailable` 之一。运行时名称被多个启用的 server 共用时无法无歧义地探测，会报告 `unavailable` 并在 `error` 中给出说明。探测遇到过期授权时，可能刷新或作废已存储的凭据。

- `40001`：校验失败
- `40408`：`targets` 中有 locator 未匹配到任何条目

### `GET /api/v1/mcp/auth-statuses`

注册表目录中各 server 的 OAuth 状态——只需要授权维度时，这是比 `servers:inspect` 更轻量的选择。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `cwd` | query | string | 并入该（受信任）目录的项目层 |
| `verify` | query | string | `true` 对每个 OAuth 候选发起真实连接验证；`false` 完全离线（仅凭配置与已存储 token 分类）；缺省保留隐式 OAuth 探测，只探测未固定且没有已存储凭据的远程 server |

成功时 `data` 是 `{ name, authStatus }` 数组，`authStatus` 取值与 `servers:inspect` 相同。验证探测可能刷新或作废已存储的凭据。

### `POST /api/v1/mcp/auth:begin` / `:complete` / `:cancel` / `:reset`

远程 server 的 OAuth 流程生命周期。`auth:begin` 接受 locator 请求体（外加可选的 `cwd` 查询参数），返回 `data` 为 `{ status: "authorization-required", flowId, authorizationUrl }`——在浏览器中打开该 URL 完成授权——或当授权已存在时返回 `{ status: "already-authorized" }`。目标 server 必须使用远程传输（`http` / `sse`）且不含静态 bearer token；静态请求头仅当配置显式设置 `auth: "oauth"` 时允许。

`auth:complete` 等待已开始流程的浏览器回调并完成 code 交换。请求体为 `{ flowId, timeoutMs? }`：等待默认 15 分钟（`timeoutMs` 可覆盖），空闲流程无论如何都会在 15 分钟后过期，关闭 HTTP 连接会中止等待。成功时 `data` 为 `null`。

`auth:cancel` 在未完成的情况下终止已开始的流程（`{ flowId }`）；未知流程会被忽略。`auth:reset` 接受 locator 请求体，清除该 server 已存储的凭据——失效事件会送达存活的会话。

- `40001`：校验失败——包括 `:complete` 的 `flowId` 未知，或 `:begin` 的 server 无法使用 OAuth（stdio 传输、静态 bearer token，或未设置 `auth: "oauth"` 的静态请求头）
- `40408`：（`:begin` / `:reset`）locator 未匹配到任何条目
- `40929`：OAuth 流程本身失败
